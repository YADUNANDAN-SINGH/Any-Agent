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

export function isActionOrientedPrompt(prompt: string): boolean {
  return /\b(fill|click|select|check|submit|type|enter|scroll|open|navigate|apply|register|save.*memory|extract.*memory|form|put|set|update|write.*in|paste.*in|add.*to|change.*to)\b/i.test(
    prompt
  );
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

export function buildAgentPrompt(params: {
  userInstruction: string;
  profile: PersonalProfile;
  snapshot: PageSnapshot;
  stepNumber: number;
  maxSteps: number;
  previousStepSummaries: string[];
  knowledgeBlock?: string;
  replyQuote?: string;
}): { system: string; user: string; isActionPrompt: boolean } {
  const profileBlock = formatProfileForPrompt(params.profile);
  // Classify on the user's own words only (not the quoted excerpt)
  const isActionPrompt = isActionOrientedPrompt(params.userInstruction);
  const quoteSection = params.replyQuote
    ? `\nTHE USER IS REPLYING TO THIS HIGHLIGHTED EXCERPT FROM THE CONVERSATION:\n"""${params.replyQuote.slice(0, 1500)}"""\nFocus your response on this excerpt and the user's message about it.\n`
    : '';
  const screenshotCount = params.snapshot.screenshots?.length || 0;
  const knowledgeSection = params.knowledgeBlock
    ? `\nPERSONAL KNOWLEDGE (imported by the user from their other AI assistants; most relevant excerpts):\n${params.knowledgeBlock}\n`
    : '';
  const personalizationRule = params.knowledgeBlock
    ? `\nPersonalize your answers using USER PERSONAL MEMORY and PERSONAL KNOWLEDGE (their background, projects, goals, tone and preferences). Speak to the user as someone who knows them, but never invent facts that aren't there.`
    : '';

  if (!isActionPrompt) {
    const selectedBlock = params.snapshot.selectedText
      ? `\nUSER SELECTED TEXT ON PAGE:\n"${params.snapshot.selectedText}"\n`
      : '';

    const screenshotNote =
      screenshotCount > 0
        ? `\nNOTE: ${screenshotCount} screenshot(s) of the webpage have been attached because the DOM text was unavailable/sparse or visual inspection was requested. Carefully read all text, UI elements, charts, and details visible in the attached screenshot image(s) to answer the user's request.\n`
        : '';

    const system = `You are "Any Agent", a helpful, fast local browser assistant running inside Chrome.
Answer the user's request clearly and concisely using Markdown (bullet points, bold headings, key takeaways) based on the active webpage content and/or attached page screenshots.
Keep your <think> reasoning brief and focused so you can respond quickly.${personalizationRule}`;

    const user = `USER REQUEST:
"${params.userInstruction}"
${quoteSection}${screenshotNote}
ACTIVE WEBPAGE:
Title: ${params.snapshot.title}
URL: ${params.snapshot.url}
Meta Description: ${params.snapshot.metaDescription || 'None'}
Headings: ${params.snapshot.headings.join(' | ') || 'None'}
${selectedBlock}
WEBPAGE DOM TEXT:
${
  params.snapshot.readableText ||
  (screenshotCount > 0
    ? `(DOM text could not be extracted; rely on the ${screenshotCount} attached screenshot(s) of the page.)`
    : '(No main text extracted)')
}

USER PERSONAL MEMORY (if relevant):
${profileBlock || '(None)'}
${knowledgeSection}`;

    return { system, user, isActionPrompt: false };
  }

  const historyBlock =
    params.previousStepSummaries.length > 0
      ? params.previousStepSummaries.map((s, idx) => `Step ${idx + 1}: ${s}`).join('\n')
      : 'None (this is Step 1)';

  const system = `You are "Any Agent", a local Chrome browser automation agent.
Keep your <think> reasoning short and direct.${personalizationRule}
Output valid JSON at the end of your response matching this schema:
\`\`\`json
{
  "answer": "Clear markdown summary of what you did or found on the page.",
  "summary": "Short 1-line status",
  "status": "complete",
  "actions": [
    { "id": 5, "label": "Twitter", "action": "fill", "value": "yadunandan077" }
  ]
}
\`\`\`

CRITICAL RULES FOR FORM FILLING:
1. Look carefully at the exact [id] number next to each <input:...>, <textarea>, or <select> in "INTERACTIVE ELEMENTS ON PAGE". Never use the example id (1) unless [1] is actually the target field!
2. Always include "label" in each fill/select action with the target field's name (e.g., "label": "Twitter").
3. Do NOT emit "click" actions on random navigation links unless the user explicitly asked to click a link or button.
4. If a social field expects a username/handle (like @username), provide just the username without https://.

ALLOWED ACTIONS:
- { "id": 5, "label": "Field Label", "action": "fill", "value": "text" }
- { "id": 6, "label": "Field Label", "action": "select", "value": "option text" }
- { "id": 7, "label": "Field Label", "action": "check", "value": true }
- { "id": 8, "label": "Button Label", "action": "click", "reason": "Clicking button/link" }
- { "action": "scroll", "value": "down" }
- { "action": "screenshot", "reason": "Capture visual screenshots of the page" }
- { "action": "navigate", "value": "https://..." }
- { "action": "extract_to_memory", "field": "projectsSummary", "value": "Extracted details..." } (Allowed fields: fullName, email, phone, location, linkedin, github, portfolio, twitter, university, degree, major, graduationYear, gpa, currentRole, company, skills, shortBio, projectsSummary, workExperience, customNotes)
- Set "status": "continue" ONLY if you clicked a button/link, requested a "screenshot", or scrolled and need another step to inspect the updated page. Otherwise set "status": "complete".`;

  const user = `USER REQUEST:
"${params.userInstruction}"
${quoteSection}
USER PERSONAL MEMORY:
${profileBlock || '(No profile fields set yet)'}
${knowledgeSection}
PREVIOUS STEPS (Step ${params.stepNumber} of ${params.maxSteps}):
${historyBlock}

CURRENT WEBPAGE:
Title: ${params.snapshot.title}
URL: ${params.snapshot.url}
Headings: ${params.snapshot.headings.join(' | ') || 'None'}
Attached Screenshots: ${screenshotCount}

READABLE PAGE CONTENT:
${params.snapshot.readableText.slice(0, 2200) || '(None - see attached screenshots if present, or emit a "screenshot" action)'}

INTERACTIVE ELEMENTS ON PAGE:
${params.snapshot.compactText || '(No interactive elements detected)'}

Return your JSON response now:`;

  return { system, user, isActionPrompt: true };
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
      const parsed = JSON.parse(slice);
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const answer =
        parsed.answer ||
        parsed.response ||
        parsed.summary ||
        (actions.length > 0 ? `Executed ${actions.length} browser action(s).` : '');
      return {
        thought: thinking,
        answer,
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
      const arr = JSON.parse(slice);
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

  const fallbackText = cleanContent.trim() || 'Done.';
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

  const response = await fetch(`${cleanHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      stream: true,
      options: {
        temperature: 0.25,
        num_ctx: 8192,
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
