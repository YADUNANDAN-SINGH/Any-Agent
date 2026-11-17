import type {
  AgentStepResult,
  PageSnapshot,
  PersonalProfile,
} from '../types/agent';
import { formatProfileForPrompt } from './storage';
import { PROFILE_FIELDS } from './knowledge';

/**
 * Uses the local model to turn free-form text pasted from another AI into
 * structured profile fields + short personalization facts.
 */
export async function extractProfileFromText(params: {
  host: string;
  model: string;
  text: string;
  signal?: AbortSignal;
}): Promise<{ profile: Partial<PersonalProfile>; facts: string[] }> {
  const cleanHost = params.host.replace(/\/+$/, '');
  const fieldList = PROFILE_FIELDS.map((f) => f.key).join(', ');

  const system = `You extract structured profile data about a person from text. Return ONLY a JSON object:
{"profile": {"<field>": "<value>"}, "facts": ["short standalone fact", "..."]}
Allowed profile fields: ${fieldList}.
Rules:
- Only include fields clearly stated in the text. Never guess.
- Keep values concise. For shortBio, projectsSummary and workExperience write 1-4 sentences.
- "facts": up to 30 short, self-contained facts useful for personalizing answers (achievements, goals, preferences, writing style, opinions) that don't fit the fields.`;

  const resp = await fetch(`${cleanHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `TEXT:\n"""\n${params.text.slice(0, 12000)}\n"""\nReturn the JSON object now.`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Ollama API error (${resp.status}): ${errText || resp.statusText}`);
  }

  const data = await resp.json();
  const raw = String(data?.message?.content || '');
  const { cleanContent } = extractThinkingAndJson(raw);
  const src = cleanContent || raw;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('The model did not return JSON. Try a different model (e.g. gemma4).');
  }

  const parsed = JSON.parse(src.slice(start, end + 1));
  const rawProfile =
    parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : parsed;

  const profile: Partial<PersonalProfile> = {};
  for (const { key } of PROFILE_FIELDS) {
    const v = rawProfile?.[key];
    if (v === undefined || v === null) continue;
    const str = (Array.isArray(v) ? v.join(', ') : String(v)).trim();
    if (str && !/^(n\/a|unknown|none|null|not specified)$/i.test(str)) {
      profile[key] = str;
    }
  }

  const facts: string[] = Array.isArray(parsed.facts)
    ? parsed.facts.map((f: unknown) => String(f).trim()).filter(Boolean).slice(0, 40)
    : [];

  return { profile, facts };
}

/**
 * After a chat turn, asks the local model whether the user revealed anything new and durable
 * about themselves. Returns profile updates, new facts, and ids of known facts to forget.
 */
export async function extractMemoryUpdatesFromChat(params: {
  host: string;
  model: string;
  userMessage: string;
  assistantContext?: string;
  profile: PersonalProfile;
  knownFacts: string[];
  signal?: AbortSignal;
}): Promise<{
  profileUpdates: Partial<PersonalProfile>;
  newFacts: string[];
  removeFactIds: number[];
}> {
  const cleanHost = params.host.replace(/\/+$/, '');
  const fieldList = PROFILE_FIELDS.map((f) => f.key).join(', ');

  // Only show the most recent facts (with their real 1-based ids) to keep the prompt small for 8B models
  const startIdx = Math.max(0, params.knownFacts.length - 60);
  const factsBlock =
    params.knownFacts
      .slice(startIdx)
      .map((f, i) => `${startIdx + i + 1}. ${f}`)
      .join('\n') || '(none)';

  const system = `You maintain long-term memory about the USER of a personal browser assistant.
Read the USER MESSAGE and extract ONLY new, durable facts the user states about THEMSELVES
(identity, contact, education, work, projects, skills, achievements, goals, preferences, writing style, opinions, sizes, dietary needs, availability).
Ignore: questions, instructions for the current task, temporary moods, facts about other people or the webpage, and anything already in KNOWN PROFILE / KNOWN FACTS.
Return ONLY JSON:
{"profile_updates": {"<field>": "<value>"}, "new_facts": ["..."], "remove_fact_ids": []}
- profile_updates: only when the user explicitly gives a value for a field. Allowed fields: ${fieldList}.
- new_facts: short third-person facts, e.g. "Prefers TypeScript over JavaScript".
- remove_fact_ids: ids from KNOWN FACTS the user says are wrong, outdated, or asks you to forget.
If there is nothing new, return {"profile_updates": {}, "new_facts": [], "remove_fact_ids": []}.`;

  const user = `KNOWN PROFILE:
${formatProfileForPrompt(params.profile) || '(empty)'}

KNOWN FACTS:
${factsBlock}
${
  params.assistantContext
    ? `\nPREVIOUS ASSISTANT MESSAGE (context only, do NOT extract facts from it):\n${params.assistantContext.slice(0, 600)}\n`
    : ''
}
USER MESSAGE:
"""${params.userMessage.slice(0, 3000)}"""

Return the JSON object now.`;

  const resp = await fetch(`${cleanHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama API error (${resp.status})`);
  }

  const data = await resp.json();
  const raw = String(data?.message?.content || '');
  const { cleanContent } = extractThinkingAndJson(raw);
  const src = cleanContent || raw;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { profileUpdates: {}, newFacts: [], removeFactIds: [] };
  }
  const parsed = JSON.parse(src.slice(start, end + 1));

  const profileUpdates: Partial<PersonalProfile> = {};
  const rawUpdates = parsed.profile_updates || {};
  for (const { key } of PROFILE_FIELDS) {
    const v = rawUpdates?.[key];
    if (v === undefined || v === null) continue;
    const str = (Array.isArray(v) ? v.join(', ') : String(v)).trim();
    if (str && !/^(n\/a|unknown|none|null|not specified)$/i.test(str)) {
      profileUpdates[key] = str;
    }
  }

  const newFacts: string[] = Array.isArray(parsed.new_facts)
    ? parsed.new_facts.map((f: unknown) => String(f).trim()).filter(Boolean).slice(0, 10)
    : [];

  const removeFactIds: number[] = Array.isArray(parsed.remove_fact_ids)
    ? parsed.remove_fact_ids
        .map((n: unknown) => Number(n))
        .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= params.knownFacts.length)
    : [];

  return { profileUpdates, newFacts, removeFactIds };
}

export interface OllamaModelTag {
  name: string;
  size: number;
  modified_at: string;
}

export async function fetchOllamaModels(host: string): Promise<OllamaModelTag[]> {
  const cleanHost = host.replace(/\/+$/, '');
  const resp = await fetch(`${cleanHost}/api/tags`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Ollama returned HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.models || [];
}

/** Words that only describe the PDF deliverable; they don't by themselves need the browser. */
const PDF_DELIVERABLE_WORDS = /\b(pdf|export|download|report|document|save\s+(it|this)\s+as)\b/gi;

export function isActionOrientedPrompt(prompt: string): boolean {
  const text = prompt.replace(PDF_DELIVERABLE_WORDS, ' ');
  return /\b(fill|click|select|tick|submit|type|enter|scroll|open|navigate|surf|browse|search|google|look\s+up|go\s+to|visit|find\s+on|apply|register|sign\s+up|save.*memory|extract.*memory|form|put|set|update|write.*in|paste.*in|add.*to|change.*to|research\s+(online|on\s+the\s+web)|on\s+the\s+(web|internet)|online|latest|news|current|today'?s|www\.|https?:\/\/|[a-z0-9-]+\.(com|org|net|io|dev|ai|in|co|edu|gov)\b)/i.test(
    text
  );
}

/**
 * True when the user wants a PDF file built ("make a PDF of this", "export as pdf", "pdf report").
 * Questions about an uploaded PDF ("summarize this pdf") are NOT PDF-build requests.
 */
export function isPdfRequestedPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const notAboutExistingPdf = String.raw`(?<!\b(?:this|the|that|attached|uploaded|my|your|above)\s)`;
  const patterns = [
    /\b(?:as|into|to|in)\s+(?:a\s+|an\s+)?pdf\b/,
    new RegExp(
      String.raw`\b(?:build|create|generate|make|produce|prepare|compile|export|download|turn|convert|give\s+me)\b[^.?!\n]{0,60}?\b(?:a|an|new|me\s+a)\s+(?:[\w-]+\s+){0,3}` +
        notAboutExistingPdf +
        String.raw`pdf\b`
    ),
    new RegExp(
      notAboutExistingPdf +
        String.raw`\bpdf\s+(?:report|version|file|copy|export|summary|resume|résumé|cv|guide|handout|brochure|notes)\b`
    ),
    /\b(?:export|download|save)\s+(?:it|this|that|the\s+\w+)\s+(?:as\s+)?(?:a\s+)?pdf\b/,
  ];
  return patterns.some((re) => re.test(p));
}

export function isScreenshotRequestedPrompt(prompt: string): boolean {
  return /\b(screenshot|screenshots|screen shot|visual|visually|capture screen|look at the screen|image of the page)\b/i.test(
    prompt
  );
}

export function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf('base64,');
  return idx !== -1 ? dataUrl.slice(idx + 7) : dataUrl;
}

export interface AgentPromptParams {
  userInstruction: string;
  profile: PersonalProfile;
  snapshot: PageSnapshot;
  stepNumber: number;
  maxSteps: number;
  previousStepSummaries: string[];
  knowledgeBlock?: string;
  replyQuote?: string;
  uploadedDocsBlock?: string;
  conversationBlock?: string;
  notes?: string[];
  pdfRequested?: boolean;
  /** Force the action/JSON loop even if the prompt doesn't look like a browser task */
  forceActionMode?: boolean;
}

function formatSearchResults(snapshot: PageSnapshot): string {
  if (!snapshot.searchResults?.length) return '';
  return snapshot.searchResults
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n');
}

export function buildAgentPrompt(params: AgentPromptParams): {
  system: string;
  user: string;
  isActionPrompt: boolean;
} {
  const profileBlock = formatProfileForPrompt(params.profile);
  // Classify on the user's own words only (not the quoted excerpt)
  const isActionPrompt =
    Boolean(params.forceActionMode) ||
    params.stepNumber > 1 ||
    isActionOrientedPrompt(params.userInstruction);
  const quoteSection = params.replyQuote
    ? `\nTHE USER IS REPLYING TO THIS HIGHLIGHTED EXCERPT FROM THE CONVERSATION:\n"""${params.replyQuote.slice(0, 1500)}"""\nFocus your response on this excerpt and the user's message about it.\n`
    : '';
  const docsSection = params.uploadedDocsBlock
    ? `\nUSER UPLOADED DOCUMENTS (the user attached these; treat them as the primary source when the request is about them):\n${params.uploadedDocsBlock}\n`
    : '';
  const conversationSection = params.conversationBlock
    ? `\nRECENT CONVERSATION (for context; "it"/"that" in the request may refer to this):\n${params.conversationBlock}\n`
    : '';
  const screenshotCount = params.snapshot.screenshots?.length || 0;
  const knowledgeSection = params.knowledgeBlock
    ? `\nPERSONAL KNOWLEDGE (imported by the user from their other AI assistants; most relevant excerpts):\n${params.knowledgeBlock}\n`
    : '';
  const personalizationRule = params.knowledgeBlock
    ? `\nPersonalize your answers using USER PERSONAL MEMORY and PERSONAL KNOWLEDGE (their background, projects, goals, tone and preferences). Speak to the user as someone who knows them, but never invent facts that aren't there.`
    : '';
  const pageState = params.snapshot.restricted
    ? `\nNOTE: The current tab (${params.snapshot.url || 'new tab'}) is a browser-internal or unreadable page with no content. Use "navigate" or "search_web" to get information from the web.\n`
    : '';

  if (!isActionPrompt) {
    const selectedBlock = params.snapshot.selectedText
      ? `\nUSER SELECTED TEXT ON PAGE:\n"${params.snapshot.selectedText}"\n`
      : '';

    const screenshotNote =
      screenshotCount > 0
        ? `\nNOTE: ${screenshotCount} screenshot(s) of the webpage have been attached because the DOM text was unavailable/sparse or visual inspection was requested. Carefully read all text, UI elements, charts, and details visible in the attached screenshot image(s) to answer the user's request.\n`
        : '';

    const taskRule = params.pdfRequested
      ? `The user wants a PDF document. Write the COMPLETE document in Markdown: start with "# <Title>", then well-organized "##" sections, bullet points, and tables where useful. Be thorough and specific, using the uploaded documents, webpage and memory below. Output ONLY the document itself — no preamble like "Here is", no closing remarks. The app converts your Markdown into the PDF.`
      : `Answer the user's request clearly and concisely using Markdown (bullet points, bold headings, key takeaways) based on the uploaded documents, the active webpage content and/or attached screenshots.`;

    const system = `You are "Any Agent", a helpful, fast local browser assistant running inside Chrome.
${taskRule}
Keep your <think> reasoning brief and focused so you can respond quickly.${personalizationRule}`;

    const webpageBlock = params.snapshot.restricted
      ? `ACTIVE WEBPAGE: (none — the current tab is a new tab / browser page)`
      : `ACTIVE WEBPAGE:
Title: ${params.snapshot.title}
URL: ${params.snapshot.url}
Meta Description: ${params.snapshot.metaDescription || 'None'}
Headings: ${params.snapshot.headings.join(' | ') || 'None'}
${selectedBlock}
WEBPAGE DOM TEXT:
${
  params.snapshot.readableText.slice(0, params.uploadedDocsBlock ? 3000 : 9000) ||
  (screenshotCount > 0
    ? `(DOM text could not be extracted; rely on the ${screenshotCount} attached screenshot(s) of the page.)`
    : '(No main text extracted)')
}`;

    const user = `USER REQUEST:
"${params.userInstruction}"
${quoteSection}${conversationSection}${docsSection}${screenshotNote}
${webpageBlock}

USER PERSONAL MEMORY (if relevant):
${profileBlock || '(None)'}
${knowledgeSection}`;

    return { system, user, isActionPrompt: false };
  }

  const historyBlock =
    params.previousStepSummaries.length > 0
      ? params.previousStepSummaries.map((s, idx) => `Step ${idx + 1}: ${s}`).join('\n')
      : 'None (this is Step 1)';
  const notesBlock = params.notes?.length ? params.notes.map((n) => `- ${n}`).join('\n') : '(none yet)';
  const isFinalStep = params.stepNumber >= params.maxSteps;
  const searchResultsBlock = formatSearchResults(params.snapshot);

  const system = `You are "Any Agent", a local Chrome browser automation agent. You control the user's current tab: you can fill forms, click, and SURF THE WEB (search, open results, follow links, go back) step by step. After each step you'll see the new page.
Keep your <think> reasoning short and direct.${personalizationRule}
Output valid JSON at the end of your response matching this schema:
\`\`\`json
{
  "answer": "Markdown answer for the user (the full final answer when status is complete; a short progress note otherwise).",
  "summary": "Short 1-line status of this step",
  "notes": "Key facts/data from THIS page that help answer the request (names, numbers, prices, dates + source URL). Empty string if none.",
  "status": "continue",
  "actions": [
    { "action": "search_web", "value": "best budget laptops 2026" }
  ]
}
\`\`\`

ALLOWED ACTIONS:
- { "id": 5, "label": "Field Label", "action": "fill", "value": "text" }
- { "id": 6, "label": "Field Label", "action": "select", "value": "option text" }
- { "id": 7, "label": "Field Label", "action": "check", "value": true }
- { "id": 8, "label": "Button/Link Label", "action": "click" }
- { "id": 9, "label": "Search Input", "action": "press_enter", "value": "optional text to type first" }
- { "action": "scroll", "value": "down" } (or "up")
- { "action": "navigate", "value": "https://example.com" } (open any URL or domain in the current tab)
- { "action": "search_web", "value": "search query" } (run a web search in the current tab)
- { "action": "open_result", "value": 2 } (open search result number 2 from SEARCH RESULTS)
- { "action": "go_back" }
- { "action": "screenshot" } (capture the page visually on the next step)
- { "action": "generate_pdf", "title": "Document Title", "filename": "document-title.pdf" } (build a downloadable PDF; the full document is written from your notes afterwards, so content is optional)
- { "action": "extract_to_memory", "field": "projectsSummary", "value": "Extracted details..." } (Allowed fields: fullName, email, phone, location, linkedin, github, portfolio, twitter, university, degree, major, graduationYear, gpa, currentRole, company, skills, shortBio, projectsSummary, workExperience, customNotes)

WEB SURFING RULES:
1. If the user asks to look something up, research, find, compare, or visit a site, use the browser; don't answer from memory.
2. Typical flow: search_web -> open_result N (most relevant result) -> read the page -> (optionally go_back / open another) -> answer.
3. Use at most ONE navigation action (navigate, search_web, open_result, go_back, or a link click) per step, and put it LAST in "actions". You'll see the new page in the next step.
4. Record what you learn on each page in "notes" — earlier pages are not shown again, only your notes.
5. Set "status": "continue" while you still need to visit or interact with pages. Set "status": "complete" with the full final "answer" once you have enough information.

FORM RULES:
1. Use the exact [id] number of the target element from INTERACTIVE ELEMENTS ON PAGE. Never invent ids.
2. Always include "label" in fill/select actions with the field's name.
3. Don't click random navigation links unless it helps the user's request.
4. If a social field expects a username/handle (like @username), provide just the username without https://.${
    params.pdfRequested
      ? `\n\nTHE USER WANTS A PDF: first gather what's needed (browse if the request requires it). When you have enough, include a "generate_pdf" action with a good title and set "status": "complete".`
      : ''
  }${
    isFinalStep
      ? `\n\nTHIS IS THE FINAL STEP: do NOT navigate anymore. Set "status": "complete" and write the best complete "answer" you can from NOTES GATHERED SO FAR and the current page.`
      : ''
  }`;

  const pageContent = searchResultsBlock
    ? `SEARCH RESULTS (open one with {"action":"open_result","value":N}):\n${searchResultsBlock}`
    : `READABLE PAGE CONTENT:\n${
        params.snapshot.readableText.slice(0, params.uploadedDocsBlock ? 3000 : 5500) ||
        (screenshotCount > 0
          ? '(See attached screenshots)'
          : '(None - emit a "screenshot" action if the page is visual, or navigate elsewhere)')
      }`;

  const user = `USER REQUEST:
"${params.userInstruction}"
${quoteSection}${conversationSection}
USER PERSONAL MEMORY:
${profileBlock || '(No profile fields set yet)'}
${knowledgeSection}${docsSection}
PREVIOUS STEPS (now on step ${params.stepNumber} of ${params.maxSteps}):
${historyBlock}

NOTES GATHERED SO FAR:
${notesBlock}
${pageState}
CURRENT WEBPAGE:
Title: ${params.snapshot.title}
URL: ${params.snapshot.url}
Headings: ${params.snapshot.headings.slice(0, 15).join(' | ') || 'None'}
Attached Screenshots: ${screenshotCount}

${pageContent}

INTERACTIVE ELEMENTS ON PAGE:
${params.snapshot.compactText.slice(0, 6000) || '(No interactive elements detected)'}

Return your JSON response now:`;

  return { system, user, isActionPrompt: true };
}

/**
 * Prompt for the dedicated "write the PDF document" pass. Plain Markdown output (no JSON),
 * which small local models handle far more reliably than a huge JSON string.
 */
export function buildDocumentWriterPrompt(params: {
  userInstruction: string;
  title?: string;
  notes: string[];
  draftAnswer?: string;
  snapshot?: PageSnapshot | null;
  uploadedDocsBlock?: string;
  conversationBlock?: string;
  profile: PersonalProfile;
  knowledgeBlock?: string;
}): { system: string; user: string } {
  const profileBlock = formatProfileForPrompt(params.profile);
  const system = `You are "Any Agent", writing a document that will be converted directly into a PDF.
Write the COMPLETE document in Markdown:
- Start with "# ${params.title || '<Title>'}"
- Use "##" sections, short paragraphs, bullet points, and Markdown tables where useful
- Be specific: include the concrete facts, numbers, names and sources from the material below
- Never invent facts that are not in the material or the user's memory
Output ONLY the document — no preamble ("Here is..."), no closing remarks, no JSON.`;

  const page =
    params.snapshot && !params.snapshot.restricted && params.snapshot.readableText
      ? `\nCURRENT WEBPAGE: ${params.snapshot.title} (${params.snapshot.url})\n${params.snapshot.readableText.slice(0, 6000)}\n`
      : '';

  const user = `USER REQUEST:
"${params.userInstruction}"
${params.conversationBlock ? `\nRECENT CONVERSATION:\n${params.conversationBlock}\n` : ''}${
    params.notes.length
      ? `\nRESEARCH NOTES GATHERED WHILE BROWSING:\n${params.notes.map((n) => `- ${n}`).join('\n')}\n`
      : ''
  }${params.draftAnswer ? `\nDRAFT ANSWER FROM THE BROWSING AGENT:\n${params.draftAnswer.slice(0, 4000)}\n` : ''}${
    params.uploadedDocsBlock ? `\nUSER UPLOADED DOCUMENTS:\n${params.uploadedDocsBlock}\n` : ''
  }${page}
USER PERSONAL MEMORY (use if relevant, e.g. for a resume or cover letter):
${profileBlock || '(None)'}
${params.knowledgeBlock ? `\nPERSONAL KNOWLEDGE:\n${params.knowledgeBlock}\n` : ''}
Write the full Markdown document now:`;

  return { system, user };
}

/** Repairs the most common JSON mistakes small models make (raw newlines in strings, trailing commas). */
function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to repair
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\t') {
        out += '\\t';
      } else if (ch !== '\r') {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

export function extractThinkingAndJson(rawText: string): {
  thinking: string;
  cleanContent: string;
} {
  let thinking = '';
  let cleanContent = rawText;

  const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    cleanContent = rawText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
  } else if (rawText.includes('<think>')) {
    const idx = rawText.indexOf('<think>');
    thinking = rawText.slice(idx + 7).trim();
    cleanContent = '';
  }

  return { thinking, cleanContent };
}

export function parseAgentStepJson(
  rawText: string,
  isActionPrompt = true
): AgentStepResult {
  const { thinking, cleanContent } = extractThinkingAndJson(rawText);

  if (!isActionPrompt && !cleanContent.includes('"actions"')) {
    const answerText = cleanContent.trim() || 'Completed.';
    return {
      thought: thinking,
      answer: answerText,
      summary: 'Generated page response.',
      actions: [],
      status: 'complete',
    };
  }

  const candidate = cleanContent || rawText;
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonSource = fenced ? fenced[1].trim() : candidate;

  const firstBrace = jsonSource.indexOf('{');
  const lastBrace = jsonSource.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = jsonSource.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = parseJsonLoose(slice);
      const rawActions = Array.isArray(parsed.actions) ? parsed.actions : parsed.action ? [parsed] : [];
      const actions = rawActions
        .filter((a: any) => a && typeof a === 'object' && typeof a.action === 'string')
        .map((a: any) => ({ ...a, action: String(a.action).toLowerCase().trim() }));
      const answer =
        parsed.answer ||
        parsed.response ||
        parsed.summary ||
        (actions.length > 0 ? `Executed ${actions.length} browser action(s).` : '');
      const notes = Array.isArray(parsed.notes)
        ? parsed.notes.map(String).join('; ')
        : typeof parsed.notes === 'string'
        ? parsed.notes
        : '';
      return {
        thought: thinking,
        answer: String(answer),
        notes: notes.trim() || undefined,
        summary: parsed.summary || 'Completed step.',
        actions,
        status: parsed.status === 'continue' ? 'continue' : 'complete',
      };
    } catch {
      // Fall through if the model wrote plain markdown instead of JSON
    }
  }

  const firstBracket = jsonSource.indexOf('[');
  const lastBracket = jsonSource.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const slice = jsonSource.slice(firstBracket, lastBracket + 1);
    try {
      const arr = parseJsonLoose(slice);
      if (Array.isArray(arr)) {
        return {
          thought: thinking,
          answer: `Executed ${arr.length} browser action(s).`,
          summary: `Prepared ${arr.length} browser action(s).`,
          actions: arr,
          status: 'complete',
        };
      }
    } catch {
      // ignore
    }
  }

  // Last resort: salvage the "answer" field from broken JSON instead of showing raw JSON to the user
  const answerMatch = candidate.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const fallbackText = answerMatch
    ? answerMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    : cleanContent.replace(/```(?:json)?[\s\S]*?```/g, '').trim() || 'Done.';
  return {
    thought: thinking,
    answer: fallbackText,
    summary: 'Completed.',
    actions: [],
    status: 'complete',
  };
}

export async function streamOllamaStep(params: {
  host: string;
  model: string;
  system: string;
  user: string;
  images?: string[]; // Raw base64 strings or data URLs
  isActionPrompt: boolean;
  signal?: AbortSignal;
  temperature?: number;
  numPredictReserve?: number;
  onProgress: (state: { thinking: string; rawContent: string }) => void;
}): Promise<AgentStepResult> {
  const cleanHost = params.host.replace(/\/+$/, '');
  const base64Images =
    params.images && params.images.length > 0
      ? params.images.map(stripDataUrlPrefix)
      : undefined;

  const userMessage: Record<string, any> = {
    role: 'user',
    content: params.user,
  };
  if (base64Images && base64Images.length > 0) {
    userMessage.images = base64Images;
  }

  // Size the context window to the prompt: Ollama silently truncates the START of the prompt
  // (the system rules!) when it doesn't fit, which breaks document Q&A and JSON actions.
  const promptTokens = Math.ceil((params.system.length + params.user.length) / 3.2);
  const imageTokens = (base64Images?.length || 0) * 1000;
  const wanted = promptTokens + imageTokens + (params.numPredictReserve ?? 3072);
  const numCtx = Math.min(32768, Math.max(8192, Math.ceil(wanted / 4096) * 4096));

  const response = await fetch(`${cleanHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      stream: true,
      options: {
        temperature: params.temperature ?? 0.25,
        num_ctx: numCtx,
      },
      messages: [
        { role: 'system', content: params.system },
        userMessage,
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Ollama API error (${response.status}): ${errText || response.statusText}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let reasoningAccumulated = '';
  let lineBuffer = '';
  let lastEmit = 0;

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 80) return; // throttle React re-renders
    lastEmit = now;
    const extracted = extractThinkingAndJson(accumulated);
    params.onProgress({
      thinking: reasoningAccumulated || extracted.thinking,
      rawContent: extracted.cleanContent,
    });
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const json = JSON.parse(line);
      if (json.error) {
        throw new Error(`Ollama: ${json.error}`);
      }
      if (json.message?.thinking) reasoningAccumulated += json.message.thinking;
      if (json.message?.content) accumulated += json.message.content;
    } catch (e: any) {
      if (e?.message?.startsWith('Ollama:')) throw e;
      // ignore malformed line
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep the trailing partial line for the next chunk
    for (const line of lines) handleLine(line);
    emitProgress();
  }
  lineBuffer += decoder.decode();
  handleLine(lineBuffer);
  emitProgress(true);

  const parsed = parseAgentStepJson(accumulated, params.isActionPrompt);
  if (reasoningAccumulated && !parsed.thought) {
    parsed.thought = reasoningAccumulated;
  }
  return parsed;
}
