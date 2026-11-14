import type { KnowledgeEntry, PersonalProfile } from '../types/agent';

/** Prompt the user pastes into ChatGPT / Claude / Gemini to export what that AI knows about them. */
export const IMPORT_PROMPT_FOR_OTHER_AI = `Based on everything you know about me from our past conversations and your memory, write a detailed profile of me for another AI assistant that will act on my behalf (filling forms, writing applications and bios, summarizing pages for me).

Use these Markdown sections with bullet points, and only include things you actually know:
## Identity & Contact
## Education
## Work Experience
## Projects (name, what it does, tech stack, results, links)
## Skills & Tools
## Achievements, Hackathons & Open Source
## Goals & What I'm Looking For
## Writing Style & Tone Preferences
## Preferences & Opinions (tools, workflows, likes/dislikes)
## Other Useful Facts

Be specific (names, numbers, dates, links). Do not invent anything.`;

export const PROFILE_FIELDS: { key: keyof PersonalProfile; label: string }[] = [
  { key: 'fullName', label: 'Full Name' },
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'location', label: 'Location' },
  { key: 'linkedin', label: 'LinkedIn URL' },
  { key: 'github', label: 'GitHub URL' },
  { key: 'portfolio', label: 'Portfolio / Website' },
  { key: 'twitter', label: 'X / Twitter' },
  { key: 'university', label: 'University' },
  { key: 'degree', label: 'Degree' },
  { key: 'major', label: 'Major' },
  { key: 'graduationYear', label: 'Graduation Year' },
  { key: 'gpa', label: 'GPA' },
  { key: 'currentRole', label: 'Current Role' },
  { key: 'company', label: 'Company' },
  { key: 'skills', label: 'Skills' },
  { key: 'shortBio', label: 'Short Bio' },
  { key: 'projectsSummary', label: 'Key Projects' },
  { key: 'workExperience', label: 'Work Experience' },
];

const STOP_WORDS = new Set(
  'the a an and or but of to in on for with at by from is are was were be been it this that these those my me i you your our we he she they them as do does did can could should would will what which who how why when where about into over than then so if not no yes please tell give write make page'.split(
    ' '
  )
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []).filter(
    (w) => !STOP_WORDS.has(w)
  );
}

/** Split long pasted text into small, self-contained chunks (by section/paragraph/line). */
export function chunkText(text: string, maxLen = 450): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks: string[] = [];
  let current = '';
  let currentHeading = '';

  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(currentHeading && !t.startsWith(currentHeading) ? `${currentHeading}\n${t}` : t);
    current = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current.length > maxLen * 0.6) flush();
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      flush();
      currentHeading = line;
      continue;
    }
    if ((current + '\n' + line).length > maxLen) flush();
    current += (current ? '\n' : '') + line;
  }
  flush();
  return chunks;
}

/**
 * Lightweight local retrieval (TF-IDF style keyword scoring) so small 8B models only
 * receive the knowledge chunks relevant to the current request + page, within a char budget.
 */
export function retrieveRelevantKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  maxChars = 1800
): string {
  if (!entries.length) return '';

  const chunks = entries.flatMap((e) =>
    chunkText(e.content).map((c, i) => ({
      text: c,
      source: e.source,
      createdAt: e.createdAt,
      order: i,
      tokens: new Set(tokenize(c)),
    }))
  );
  if (!chunks.length) return '';

  const df = new Map<string, number>();
  for (const ch of chunks) {
    for (const t of ch.tokens) df.set(t, (df.get(t) || 0) + 1);
  }

  const queryTokens = new Set(tokenize(query));
  const N = chunks.length;

  const scored = chunks.map((ch) => {
    let score = 0;
    for (const qt of queryTokens) {
      if (ch.tokens.has(qt)) score += Math.log(1 + N / (df.get(qt) || 1));
    }
    return { ...ch, score };
  });

  // Highest relevance first; ties broken by newest import, then original order
  scored.sort(
    (a, b) => b.score - a.score || b.createdAt - a.createdAt || a.order - b.order
  );

  const picked: string[] = [];
  let used = 0;
  for (const ch of scored) {
    const line = `[from ${ch.source}] ${ch.text}`;
    if (used + line.length > maxChars) {
      if (picked.length === 0) picked.push(line.slice(0, maxChars));
      continue;
    }
    picked.push(line);
    used += line.length + 2;
  }
  return picked.join('\n\n');
}


// ---------------------------------------------------------------------------
// Learned-from-chat memory
// ---------------------------------------------------------------------------

/** All facts learned from chat live in one Knowledge entry so they're visible/deletable in the UI and used by retrieval. */
export const LEARNED_ENTRY_ID = 'learned-from-chat';
const MAX_LEARNED_FACTS = 200;

/** Long free-text profile fields: never overwrite these from a single chat line — store as a fact instead. */
export const LONG_PROFILE_FIELDS = new Set<keyof PersonalProfile>([
  'shortBio',
  'projectsSummary',
  'workExperience',
  'customNotes',
]);

export function getLearnedFacts(entries: KnowledgeEntry[]): string[] {
  const entry = entries.find((e) => e.id === LEARNED_ENTRY_ID);
  if (!entry) return [];
  return entry.content
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
}

export function withLearnedFacts(entries: KnowledgeEntry[], facts: string[]): KnowledgeEntry[] {
  const others = entries.filter((e) => e.id !== LEARNED_ENTRY_ID);
  const trimmed = facts.slice(-MAX_LEARNED_FACTS);
  if (trimmed.length === 0) return others;
  return [
    {
      id: LEARNED_ENTRY_ID,
      title: 'Learned from chat',
      source: 'Chat',
      content: trimmed.map((f) => `- ${f}`).join('\n'),
      createdAt: Date.now(),
    },
    ...others,
  ];
}

export function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Merge comma-separated skill lists without duplicates (case-insensitive). */
export function mergeSkills(existing: string, incoming: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...existing.split(','), ...incoming.split(',')]) {
    const t = s.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.join(', ');
}

/** Cheap pre-filter so we only spend a local-model call when the user might be talking about themselves. */
export function mightContainPersonalInfo(message: string): boolean {
  return /\b(i|i'm|im|i've|i'd|i'll|my|me|mine|myself|call me|forget)\b/i.test(message);
}
