export interface PersonalProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  portfolio: string;
  twitter: string;
  university: string;
  degree: string;
  major: string;
  graduationYear: string;
  gpa: string;
  currentRole: string;
  company: string;
  skills: string;
  shortBio: string;
  projectsSummary: string;
  workExperience: string;
  customNotes: string;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  source: string; // e.g. ChatGPT, Claude, Gemini, Other
  content: string;
  createdAt: number;
}

export interface AgentSettings {
  ollamaHost: string;
  selectedModel: string;
  visionModel: string; // Used when screenshots are captured (can be same as selectedModel e.g. gemma4 or llava)
  maxSteps: number;
  maxScreenshots: number; // Max scrolled screenshots to take when DOM is empty or user asks for visual scan
  autoScreenshotFallback: boolean; // Auto-capture screenshots when DOM text is sparse/unavailable
  safeSubmitMode: boolean; // Pause before clicking final "Submit" buttons
  highlightElements: boolean;
  autoLearnFromChat: boolean; // Learn new facts about the user from chat messages
}

export interface DistilledElement {
  id: number;
  tag: string;
  type?: string;
  role?: string;
  label: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
  options?: string[];
  text?: string;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  metaDescription: string;
  selectedText: string;
  headings: string[];
  readableText: string;
  elements: DistilledElement[];
  compactText: string;
  screenshots?: string[]; // Data URLs (data:image/jpeg;base64,...) captured when DOM is unavailable or visual scan requested
  usedScreenshotFallback?: boolean;
}

export type AgentActionType =
  | 'fill'
  | 'select'
  | 'check'
  | 'click'
  | 'scroll'
  | 'navigate'
  | 'screenshot'
  | 'extract_to_memory'
  | 'done';

export interface AgentAction {
  id?: number;
  action: AgentActionType;
  value?: string | boolean;
  label?: string; // Optional target field label/name from the model for smart fallback matching
  field?: keyof PersonalProfile;
  reason?: string;
}

export interface AgentStepResult {
  thought?: string;
  answer: string;
  summary: string;
  actions: AgentAction[];
  status: 'continue' | 'complete' | 'needs_user_review';
}

export interface ActionExecutionLog {
  action: AgentAction;
  label?: string;
  success: boolean;
  message: string;
}

export interface StepTrace {
  stepNumber: number;
  pageTitle: string;
  thinking: string;
  summary: string;
  screenshots?: string[];
  actions: ActionExecutionLog[];
  status: 'running' | 'completed' | 'error' | 'paused_for_submit';
}

export interface MemoryUpdateInfo {
  status: 'pending' | 'done' | 'undone';
  items: string[]; // human-readable list of what changed
  profileChanges: { key: keyof PersonalProfile; prev: string; next: string }[];
  addedFacts: string[];
  removedFacts: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  steps?: StepTrace[];
  isStreaming?: boolean;
  memoryUpdate?: MemoryUpdateInfo;
  quote?: string; // highlighted excerpt this user message replies to
}
