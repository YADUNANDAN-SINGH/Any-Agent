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
  source: string; // e.g. ChatGPT, Claude, Gemini, Uploaded Doc, Other
  content: string;
  createdAt: number;
}

export interface UploadedDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  textContent: string;
  imageDataUrl?: string; // If user uploaded an image (PNG/JPG/WEBP), pass to vision model
  pageImages?: string[]; // Rendered pages of a scanned (image-only) PDF, for the vision model
  pageCount?: number;
  createdAt: number;
}

export interface GeneratedPdfDoc {
  title: string;
  filename: string;
  subtitle?: string;
  markdownContent: string;
  createdAt: number;
}

export interface AgentSettings {
  ollamaHost: string;
  selectedModel: string;
  visionModel: string; // Used when screenshots or image uploads are present
  maxSteps: number;
  searchEngine: 'google' | 'duckduckgo' | 'bing'; // Used by the search_web action
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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
  searchResults?: SearchResult[]; // Parsed search-engine results (full URLs) when the tab is a SERP
  blockedByVerification?: boolean; // Page is a human-verification / bot-check wall
  restricted?: boolean; // Browser-internal page (new tab, chrome://) that extensions cannot read
}

export type AgentActionType =
  | 'fill'
  | 'select'
  | 'check'
  | 'click'
  | 'press_enter'
  | 'scroll'
  | 'navigate'
  | 'search_web'
  | 'open_result'
  | 'go_back'
  | 'screenshot'
  | 'generate_pdf'
  | 'extract_to_memory'
  | 'done';

export interface AgentAction {
  id?: number;
  action: AgentActionType;
  value?: string | number | boolean;
  url?: string; // Used by navigate / open_result when the model puts the URL here
  label?: string; // Optional target field label/name from the model for smart fallback matching
  field?: keyof PersonalProfile;
  title?: string; // Used by generate_pdf
  filename?: string; // Used by generate_pdf
  content?: string; // Used by generate_pdf (markdown content)
  reason?: string;
}

export interface AgentStepResult {
  thought?: string;
  notes?: string; // Key facts the model learned from the current page (carried to later steps)
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
  attachments?: UploadedDocument[]; // documents attached to this user prompt
  generatedPdf?: GeneratedPdfDoc; // PDF document built by the assistant
}
