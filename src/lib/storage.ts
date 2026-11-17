import type { AgentSettings, KnowledgeEntry, PersonalProfile } from '../types/agent';

const PROFILE_KEY = 'any_agent_personal_profile_v1';
const SETTINGS_KEY = 'any_agent_settings_v1';
const KNOWLEDGE_KEY = 'any_agent_knowledge_v1';

export async function loadKnowledge(): Promise<KnowledgeEntry[]> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get(KNOWLEDGE_KEY);
    return Array.isArray(res[KNOWLEDGE_KEY]) ? res[KNOWLEDGE_KEY] : [];
  }
  const raw = localStorage.getItem(KNOWLEDGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function saveKnowledge(entries: KnowledgeEntry[]): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [KNOWLEDGE_KEY]: entries });
    return;
  }
  localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(entries));
}

export const DEFAULT_PROFILE: PersonalProfile = {
  fullName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',
  linkedin: '',
  github: '',
  portfolio: '',
  twitter: '',
  university: '',
  degree: '',
  major: '',
  graduationYear: '',
  gpa: '',
  currentRole: '',
  company: '',
  skills: '',
  shortBio: '',
  projectsSummary: '',
  workExperience: '',
  customNotes: '',
};

export const DEFAULT_SETTINGS: AgentSettings = {
  ollamaHost: 'http://localhost:11434',
  selectedModel: 'deepseek-r1:8b',
  visionModel: 'gemma4',
  maxSteps: 6,
  searchEngine: 'google',
  maxScreenshots: 4,
  autoScreenshotFallback: true,
  safeSubmitMode: true,
  highlightElements: true,
  autoLearnFromChat: true,
};

export async function loadProfile(): Promise<PersonalProfile> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get(PROFILE_KEY);
    return { ...DEFAULT_PROFILE, ...(res[PROFILE_KEY] || {}) };
  }
  const raw = localStorage.getItem(PROFILE_KEY);
  return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : DEFAULT_PROFILE;
}

export async function saveProfile(profile: PersonalProfile): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    return;
  }
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export async function loadSettings(): Promise<AgentSettings> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  }
  const raw = localStorage.getItem(SETTINGS_KEY);
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function formatProfileForPrompt(profile: PersonalProfile): string {
  const entries: [string, string][] = [
    ['Full Name', profile.fullName],
    ['First Name', profile.firstName],
    ['Last Name', profile.lastName],
    ['Email', profile.email],
    ['Phone', profile.phone],
    ['Location / City / Country', profile.location],
    ['LinkedIn URL', profile.linkedin],
    ['GitHub URL', profile.github],
    ['Portfolio / Website', profile.portfolio],
    ['X / Twitter', profile.twitter],
    ['University / College', profile.university],
    ['Degree', profile.degree],
    ['Major / Branch', profile.major],
    ['Graduation Year', profile.graduationYear],
    ['GPA / CGPA', profile.gpa],
    ['Current Role / Title', profile.currentRole],
    ['Current Company / Org', profile.company],
    ['Skills', profile.skills],
    ['Short Bio', profile.shortBio],
    ['Key Projects', profile.projectsSummary],
    ['Work Experience', profile.workExperience],
    ['Extra Instructions & Notes', profile.customNotes],
  ];

  return entries
    .filter(([_, val]) => val && val.trim().length > 0)
    .map(([key, val]) => `- ${key}: ${val.trim()}`)
    .join('\n');
}

