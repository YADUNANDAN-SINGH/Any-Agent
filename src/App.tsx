import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Database,
  Eye,
  FileText,
  MessageSquare,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  BookmarkPlus,
  MousePointerClick,
} from 'lucide-react';
import type {
  AgentSettings,
  ChatMessage,
  PageSnapshot,
  PersonalProfile,
  StepTrace,
} from './types/agent';
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  loadProfile,
  loadSettings,
  loadKnowledge,
  saveKnowledge,
  saveProfile,
  saveSettings,
} from './lib/storage';
import {
  LONG_PROFILE_FIELDS,
  PROFILE_FIELDS,
  getLearnedFacts,
  mergeSkills,
  mightContainPersonalInfo,
  normalizeFact,
  retrieveRelevantKnowledge,
  withLearnedFacts,
} from './lib/knowledge';
import { extractMemoryUpdatesFromChat } from './lib/ollama';
import {
  Brain,
  Check,
  Copy,
  Download,
  FileDown,
  Globe,
  Loader2,
  Paperclip,
  Reply,
  Undo2,
  X,
} from 'lucide-react';
import { KnowledgePanel } from './components/KnowledgePanel';
import type {
  AgentAction,
  GeneratedPdfDoc,
  KnowledgeEntry,
  MemoryUpdateInfo,
  UploadedDocument,
} from './types/agent';
import {
  buildAgentPrompt,
  buildDocumentWriterPrompt,
  fetchOllamaModels,
  isPdfRequestedPrompt,
  isScreenshotRequestedPrompt,
  streamOllamaStep,
  type OllamaModelTag,
} from './lib/ollama';
import {
  UPLOAD_ACCEPT,
  downloadGeneratedPdf,
  parseUploadedFile,
  previewGeneratedPdf,
} from './lib/documentTools';
import {
  executeActionsOnActiveTab,
  getActivePageSnapshot,
} from './lib/browserBridge';
import { MemoryPanel } from './components/MemoryPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StepTraceCard } from './components/StepTraceCard';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { ErrorBoundary } from './components/ErrorBoundary';

type ActiveTab = 'chat' | 'memory' | 'settings';

const QUICK_PROMPTS = [
  {
    label: 'Summarize this webpage & key takeaways',
    prompt:
      'Summarize this webpage clearly with bullet points, key facts, and main takeaways.',
    icon: FileText,
  },
  {
    label: 'Build a downloadable PDF from this page',
    prompt:
      'Create a well-structured PDF report of this webpage with an overview, key points and takeaways.',
    icon: FileDown,
  },
  {
    label: 'Fill out form on this page using Memory',
    prompt: 'Fill out all relevant form fields on this page using my personal memory.',
    icon: Wand2,
  },
  {
    label: 'Save my details from this page into Memory',
    prompt:
      'Read this webpage and extract any relevant personal profile info (bio, projects, links, skills, role, education) into my Personal Memory using extract_to_memory actions, and summarize what you found.',
    icon: BookmarkPlus,
  },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat');
  const [profile, setProfile] = useState<PersonalProfile>(DEFAULT_PROFILE);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [availableModels, setAvailableModels] = useState<OllamaModelTag[]>([]);
  const [ollamaConnected, setOllamaConnected] = useState<boolean>(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<PageSnapshot | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [memoryView, setMemoryView] = useState<'profile' | 'knowledge'>('profile');

  const handleSaveKnowledge = async (entries: KnowledgeEntry[]) => {
    knowledgeRef.current = entries;
    setKnowledge(entries);
    await saveKnowledge(entries);
  };
  const [showDomPreview, setShowDomPreview] = useState(false);

  // Refs always hold the latest memory so background learning never works on stale state
  const profileRef = useRef<PersonalProfile>(profile);
  const knowledgeRef = useRef<KnowledgeEntry[]>(knowledge);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  useEffect(() => {
    knowledgeRef.current = knowledge;
  }, [knowledge]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // ----- Highlight-to-reply -----
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [selectionPopup, setSelectionPopup] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [copiedSelection, setCopiedSelection] = useState(false);

  // ----- Document Uploads in Chat -----
  const [attachedDocs, setAttachedDocs] = useState<UploadedDocument[]>([]);
  const [parsingFiles, setParsingFiles] = useState<string[]>([]);
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setAttachError('');
    setParsingFiles((prev) => [...prev, ...files.map((f) => f.name)]);
    const results = await Promise.allSettled(files.map(parseUploadedFile));
    const ok = results
      .filter((r): r is PromiseFulfilledResult<UploadedDocument> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? `${files[i].name}: ${r.reason?.message || r.reason}` : ''))
      .filter(Boolean);
    setAttachedDocs((prev) => [...prev, ...ok]);
    setParsingFiles((prev) => prev.filter((n) => !files.some((f) => f.name === n)));
    if (failed.length) setAttachError(`Couldn't read ${failed.join('; ')}`);
  };

  const handleAttachFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await attachFiles(files);
  };

  const removeAttachedDoc = (id: string) => {
    setAttachedDocs((prev) => prev.filter((d) => d.id !== id));
  };

  const handleChatSelection = () => {
    // Defer so the browser has finalized the selection
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (
        !sel ||
        sel.rangeCount === 0 ||
        text.length < 2 ||
        !chatScrollRef.current?.contains(sel.anchorNode)
      ) {
        setSelectionPopup(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70);
      const y = rect.top > 52 ? rect.top - 40 : rect.bottom + 8;
      setCopiedSelection(false);
      setSelectionPopup({ text: text.slice(0, 1500), x, y });
    }, 0);
  };

  useEffect(() => {
    const onSelectionChange = () => {
      if (!window.getSelection()?.toString().trim()) setSelectionPopup(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const startReplyToSelection = () => {
    if (!selectionPopup) return;
    setReplyQuote(selectionPopup.text);
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const copySelection = async () => {
    if (!selectionPopup) return;
    try {
      await navigator.clipboard.writeText(selectionPopup.text);
      setCopiedSelection(true);
      setTimeout(() => setSelectionPopup(null), 700);
    } catch {
      setSelectionPopup(null);
    }
  };

  const sendFromInput = () => {
    if ((!input.trim() && attachedDocs.length === 0) || isRunning || parsingFiles.length > 0) return;
    const quote = replyQuote || undefined;
    const docsToSend = attachedDocs.length > 0 ? [...attachedDocs] : undefined;
    const promptText =
      input.trim() ||
      `Analyze the attached document(s) (${attachedDocs.map((d) => d.name).join(', ')}) and summarize the key points.`;
    setReplyQuote(null);
    setAttachedDocs([]);
    runMultiStepAgent(promptText, quote, docsToSend);
  };

  useEffect(() => {
    (async () => {
      const [loadedProfile, loadedSettings] = await Promise.all([
        loadProfile(),
        loadSettings(),
      ]);
      setProfile(loadedProfile);
      setSettings(loadedSettings);
      setKnowledge(await loadKnowledge());
      await checkOllama(loadedSettings.ollamaHost, loadedSettings.selectedModel);
    })();
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const checkOllama = async (host: string, currentModel: string) => {
    try {
      const models = await fetchOllamaModels(host);
      setAvailableModels(models);
      setOllamaConnected(true);
      if (models.length > 0 && !models.some((m) => m.name === currentModel)) {
        const nextSettings = { ...settings, ollamaHost: host, selectedModel: models[0].name };
        setSettings(nextSettings);
        await saveSettings(nextSettings);
      }
    } catch {
      setOllamaConnected(false);
    }
  };

  const handleSaveProfile = async (updated: PersonalProfile) => {
    profileRef.current = updated;
    setProfile(updated);
    await saveProfile(updated);
  };

  const setMessageMemoryUpdate = (msgId: string, mu: MemoryUpdateInfo | undefined) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, memoryUpdate: mu } : m)));
  };

  /** Runs after a chat turn: learns new durable facts the user shared about themselves. */
  const learnFromChat = async (
    userMessage: string,
    assistantMsgId: string,
    prevAssistant: string
  ) => {
    if (settings.autoLearnFromChat === false) return;
    if (!mightContainPersonalInfo(userMessage)) return;
    if (QUICK_PROMPTS.some((q) => q.prompt === userMessage)) return;

    const empty: MemoryUpdateInfo = {
      status: 'pending',
      items: [],
      profileChanges: [],
      addedFacts: [],
      removedFacts: [],
    };
    setMessageMemoryUpdate(assistantMsgId, empty);

    try {
      const currentProfile = profileRef.current;
      const currentFacts = getLearnedFacts(knowledgeRef.current);

      const res = await extractMemoryUpdatesFromChat({
        host: settings.ollamaHost,
        model: settings.selectedModel,
        userMessage,
        assistantContext: prevAssistant,
        profile: currentProfile,
        knownFacts: currentFacts,
      });

      const items: string[] = [];
      const profileChanges: MemoryUpdateInfo['profileChanges'] = [];
      const factCandidates = [...res.newFacts];
      const nextProfile = { ...currentProfile };

      for (const [k, v] of Object.entries(res.profileUpdates)) {
        const key = k as keyof PersonalProfile;
        const prev = (currentProfile[key] || '').trim();
        let next = String(v).trim();

        // Never clobber long free-text fields from one chat line; remember it as a fact instead
        if (LONG_PROFILE_FIELDS.has(key) && prev) {
          factCandidates.push(next);
          continue;
        }
        if (key === 'skills' && prev) next = mergeSkills(prev, next);
        if (!next || next === prev) continue;

        nextProfile[key] = next;
        profileChanges.push({ key, prev, next });
        const label = PROFILE_FIELDS.find((f) => f.key === key)?.label || key;
        items.push(`${prev ? 'Updated' : 'Set'} ${label}: ${next.slice(0, 80)}`);
      }

      const known = new Set(currentFacts.map(normalizeFact));
      const addedFacts: string[] = [];
      for (const f of factCandidates) {
        const n = normalizeFact(f);
        if (n && !known.has(n)) {
          known.add(n);
          addedFacts.push(f);
          items.push(`Remembered: ${f}`);
        }
      }

      const removedFacts = res.removeFactIds
        .map((id) => currentFacts[id - 1])
        .filter((f): f is string => Boolean(f));
      removedFacts.forEach((f) => items.push(`Forgot: ${f}`));

      if (items.length === 0) {
        setMessageMemoryUpdate(assistantMsgId, undefined);
        return;
      }

      if (profileChanges.length > 0) await handleSaveProfile(nextProfile);
      if (addedFacts.length > 0 || removedFacts.length > 0) {
        const facts = [
          ...currentFacts.filter((f) => !removedFacts.includes(f)),
          ...addedFacts,
        ];
        await handleSaveKnowledge(withLearnedFacts(knowledgeRef.current, facts));
      }

      setMessageMemoryUpdate(assistantMsgId, {
        status: 'done',
        items,
        profileChanges,
        addedFacts,
        removedFacts,
      });
    } catch (err) {
      console.warn('[Any Agent] Memory learning skipped:', err);
      setMessageMemoryUpdate(assistantMsgId, undefined);
    }
  };

  /** Reverts exactly the changes a specific memory update made. */
  const undoMemoryUpdate = async (msgId: string) => {
    const mu = messages.find((m) => m.id === msgId)?.memoryUpdate;
    if (!mu || mu.status !== 'done') return;

    if (mu.profileChanges.length > 0) {
      const p = { ...profileRef.current };
      for (const c of mu.profileChanges) {
        if ((p[c.key] || '').trim() === c.next) p[c.key] = c.prev;
      }
      await handleSaveProfile(p);
    }

    if (mu.addedFacts.length > 0 || mu.removedFacts.length > 0) {
      let facts = getLearnedFacts(knowledgeRef.current).filter(
        (f) => !mu.addedFacts.includes(f)
      );
      facts = [...facts, ...mu.removedFacts.filter((f) => !facts.includes(f))];
      await handleSaveKnowledge(withLearnedFacts(knowledgeRef.current, facts));
    }

    setMessageMemoryUpdate(msgId, { ...mu, status: 'undone' });
  };

  const handleUpdateSettings = async (updated: AgentSettings) => {
    setSettings(updated);
    await saveSettings(updated);
    await checkOllama(updated.ollamaHost, updated.selectedModel);
  };

  const handleInspectDom = async () => {
    try {
      const snap = await getActivePageSnapshot();
      setLastSnapshot(snap);
      setShowDomPreview((prev) => !prev);
    } catch (err: any) {
      alert(err?.message || 'Could not inspect current tab.');
    }
  };

  const stopAgentLoop = () => {
    abortControllerRef.current?.abort();
    setIsRunning(false);
  };

  const runMultiStepAgent = async (
    userPrompt: string,
    quote?: string,
    attachments?: UploadedDocument[]
  ) => {
    if (!userPrompt.trim() || isRunning) return;

    const prevAssistant =
      [...messages].reverse().find((m) => m.role === 'assistant')?.content || '';

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userPrompt.trim(),
      quote,
      attachments,
      timestamp: Date.now(),
    };

    const assistantMsgId = `assistant-${Date.now() + 1}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: 'Reading active webpage...',
      timestamp: Date.now(),
      steps: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setInput('');
    setIsRunning(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const stepsTrace: StepTrace[] = [];
    const previousSummaries: string[] = [];
    const gatheredNotes: string[] = [];
    let workingProfile = { ...profile };
    let latestPdf: GeneratedPdfDoc | undefined;
    let lastSnapshotSeen: PageSnapshot | null = null;

    // Documents stay available for follow-ups ("now turn it into a PDF"): this prompt's
    // attachments plus the most recent ones from earlier in the conversation.
    const activeDocs: UploadedDocument[] = [];
    for (const d of [
      ...(attachments || []),
      ...[...messages].reverse().flatMap((m) => m.attachments || []),
    ]) {
      if (!activeDocs.some((x) => x.id === d.id) && activeDocs.length < 3) activeDocs.push(d);
    }

    const DOC_CHAR_BUDGET = 24000;
    const uploadedDocsBlock =
      activeDocs.length > 0
        ? activeDocs
            .map((d) => {
              const share = Math.floor(DOC_CHAR_BUDGET / activeDocs.length);
              const body = d.textContent.slice(0, share);
              const cut = d.textContent.length > share ? '\n[...document truncated...]' : '';
              const isNew = attachments?.some((a) => a.id === d.id);
              return `--- DOCUMENT: "${d.name}" (${Math.round(d.size / 1024)} KB${
                d.pageCount ? `, ${d.pageCount} pages` : ''
              }${isNew ? ', attached to this message' : ', attached earlier'}) ---\n${body}${cut}`;
            })
            .join('\n\n')
        : undefined;

    const uploadedImages = activeDocs
      .flatMap((d) => [d.imageDataUrl, ...(d.pageImages || [])])
      .filter((u): u is string => Boolean(u))
      .slice(0, 4);

    const conversationBlock =
      messages
        .slice(-4)
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`)
        .join('\n\n') || undefined;

    const syncAssistantMessage = (
      content: string,
      isStreaming: boolean,
      generatedPdf?: GeneratedPdfDoc
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content,
                steps: [...stepsTrace],
                isStreaming,
                generatedPdf: generatedPdf || m.generatedPdf,
              }
            : m
        )
      );
    };

    const savePdf = async (doc: GeneratedPdfDoc, step: StepTrace | undefined, action: AgentAction) => {
      latestPdf = doc;
      try {
        const filename = await downloadGeneratedPdf(doc);
        step?.actions.push({
          action,
          label: doc.title,
          success: true,
          message: `Built & downloaded PDF "${filename}"`,
        });
      } catch (err: any) {
        step?.actions.push({
          action,
          label: doc.title,
          success: false,
          message: `PDF built but download failed: ${err?.message || String(err)}. Use the Download button.`,
        });
      }
    };

    const titleFromMarkdown = (md: string) =>
      md.match(/^#\s+(.+)$/m)?.[1].replace(/[*_`]/g, '').trim();

    try {
      let finalAnswer = '';
      let forceScreenshotsNextStep = isScreenshotRequestedPrompt(userPrompt);
      const userAskedForPdf = isPdfRequestedPrompt(userPrompt);
      let pdfMeta: { title?: string; filename?: string } | null = userAskedForPdf ? {} : null;
      let usedActionMode = false;
      const knowledgeQuery = `${userPrompt} ${quote || ''}`;

      for (let stepNum = 1; stepNum <= settings.maxSteps; stepNum++) {
        if (abortController.signal.aborted) break;

        // 1. Observe: DOM text + interactive elements, with screenshot fallback
        syncAssistantMessage(
          forceScreenshotsNextStep ? 'Capturing page screenshots...' : 'Reading active webpage...',
          true
        );
        const snapshot = await getActivePageSnapshot({
          forceScreenshots: forceScreenshotsNextStep,
          // When the user is asking about their own documents, don't switch to page screenshots
          autoScreenshotFallback: activeDocs.length === 0 && (settings.autoScreenshotFallback ?? true),
          maxScreenshots: settings.maxScreenshots ?? 4,
        });
        forceScreenshotsNextStep = false;
        lastSnapshotSeen = snapshot;
        setLastSnapshot(snapshot);

        // Never try to get past CAPTCHAs / bot checks: hand control back to the user
        if (snapshot.blockedByVerification) {
          stepsTrace.push({
            stepNumber: stepNum,
            pageTitle: snapshot.title,
            thinking: '',
            summary: 'Page is asking for human verification.',
            actions: [],
            status: 'paused_for_submit',
          });
          finalAnswer =
            `**${snapshot.title || 'This page'}** is showing a human-verification check (CAPTCHA). ` +
            `Please complete it yourself in the tab, then send your request again and I'll continue from there.` +
            (gatheredNotes.length ? `\n\n**What I found so far:**\n${gatheredNotes.map((n) => `- ${n}`).join('\n')}` : '');
          syncAssistantMessage(finalAnswer, false, latestPdf);
          return;
        }

        const screenshots = snapshot.screenshots || [];
        const allImages = [...uploadedImages, ...screenshots];
        const modelForStep =
          allImages.length > 0
            ? settings.visionModel || settings.selectedModel
            : settings.selectedModel;

        const currentStep: StepTrace = {
          stepNumber: stepNum,
          pageTitle: snapshot.restricted ? 'New tab' : snapshot.title,
          thinking: '',
          summary:
            allImages.length > 0
              ? `Reading ${allImages.length} image(s)/screenshot(s) with ${modelForStep}...`
              : '',
          screenshots: screenshots.length > 0 ? screenshots : undefined,
          actions: [],
          status: 'running',
        };
        stepsTrace.push(currentStep);
        syncAssistantMessage(
          snapshot.restricted
            ? `Step ${stepNum}: Thinking...`
            : `Step ${stepNum}: Analyzing "${snapshot.title}"...`,
          true
        );

        // 2. Think: Stream from local Ollama model
        const { system, user, isActionPrompt } = buildAgentPrompt({
          userInstruction: userPrompt,
          replyQuote: quote,
          uploadedDocsBlock,
          conversationBlock,
          notes: gatheredNotes,
          pdfRequested: userAskedForPdf,
          profile: workingProfile,
          snapshot,
          stepNumber: stepNum,
          maxSteps: settings.maxSteps,
          previousStepSummaries: previousSummaries,
          knowledgeBlock: retrieveRelevantKnowledge(
            knowledge,
            `${knowledgeQuery} ${snapshot.title} ${snapshot.headings.join(' ')}`,
            allImages.length > 0 ? 1200 : 1800
          ),
        });
        usedActionMode = usedActionMode || isActionPrompt;

        const stepResult = await streamOllamaStep({
          host: settings.ollamaHost,
          model: modelForStep,
          system,
          user,
          images: allImages.length > 0 ? allImages : undefined,
          isActionPrompt,
          signal: abortController.signal,
          numPredictReserve: !isActionPrompt && userAskedForPdf ? 6144 : undefined,
          onProgress: ({ thinking, rawContent }) => {
            currentStep.thinking = thinking;
            if (rawContent) {
              currentStep.summary = isActionPrompt
                ? 'Preparing browser actions...'
                : userAskedForPdf
                ? 'Writing document...'
                : 'Streaming answer...';
            }
            syncAssistantMessage(
              rawContent && !isActionPrompt
                ? rawContent
                : rawContent
                ? 'Drafting response...'
                : `Thinking with ${modelForStep}...`,
              true
            );
          },
        });

        currentStep.thinking = stepResult.thought || currentStep.thinking;
        currentStep.summary = stepResult.summary;
        finalAnswer = stepResult.answer || stepResult.summary;
        if (stepResult.notes) {
          gatheredNotes.push(
            `${stepResult.notes.slice(0, 1200)}${snapshot.url && !snapshot.restricted ? ` (source: ${snapshot.url})` : ''}`
          );
        }

        // Only the first navigation in a step is meaningful: anything after it would target
        // element ids from a page that no longer exists.
        const NAV_ACTIONS = new Set(['navigate', 'search_web', 'open_result', 'go_back']);
        let stepActions = stepResult.actions;
        const firstNavIdx = stepActions.findIndex((a) => NAV_ACTIONS.has(a.action));
        if (firstNavIdx !== -1) stepActions = stepActions.slice(0, firstNavIdx + 1);

        const memoryActions = stepActions.filter(
          (a) => a.action === 'extract_to_memory' && a.field && a.value
        );
        const screenshotRequested = stepActions.some((a) => a.action === 'screenshot');
        const pdfActions = stepActions.filter((a) => a.action === 'generate_pdf');
        const domActions = stepActions.filter(
          (a) =>
            a.action !== 'extract_to_memory' &&
            a.action !== 'screenshot' &&
            a.action !== 'generate_pdf' &&
            a.action !== 'done'
        );

        if (screenshotRequested) {
          forceScreenshotsNextStep = true;
          currentStep.actions.push({
            action: { action: 'screenshot' },
            success: true,
            message: 'Model requested visual screenshots for the next step.',
          });
        }

        // A generate_pdf with a full document is used as-is; otherwise the document is written
        // in a dedicated Markdown pass once browsing is finished.
        for (const pdfAct of pdfActions) {
          pdfMeta = {
            title: String(pdfAct.title || pdfMeta?.title || '').trim() || undefined,
            filename: String(pdfAct.filename || pdfMeta?.filename || '').trim() || undefined,
          };
          const inlineContent = String(pdfAct.content || '').trim();
          if (inlineContent.length >= 400) {
            const title = pdfMeta.title || titleFromMarkdown(inlineContent) || 'Any Agent Document';
            await savePdf(
              {
                title,
                filename: pdfMeta.filename || `${title}.pdf`,
                markdownContent: inlineContent,
                createdAt: Date.now(),
              },
              currentStep,
              pdfAct
            );
            finalAnswer = inlineContent;
          }
        }

        for (const memAct of memoryActions) {
          const fieldKey = memAct.field as keyof PersonalProfile;
          if (fieldKey in workingProfile) {
            workingProfile = {
              ...workingProfile,
              [fieldKey]: String(memAct.value),
            };
            currentStep.actions.push({
              action: memAct,
              label: fieldKey,
              success: true,
              message: `Saved to Memory [${fieldKey}]: "${String(memAct.value).slice(0, 70)}"`,
            });
          }
        }

        if (memoryActions.length > 0) {
          profileRef.current = workingProfile;
          setProfile(workingProfile);
          await saveProfile(workingProfile);
        }

        // 3. Act: Execute any browser DOM / Web Surfing actions on the active tab
        let navigated = false;
        if (domActions.length > 0) {
          const enrichedDomActions = domActions.map((a) =>
            a.action === 'fill' && !a.label && !a.reason
              ? { ...a, reason: userPrompt }
              : a
          );
          syncAssistantMessage(
            `Step ${stepNum}: ${stepResult.summary || 'Running browser actions...'}`,
            true,
            latestPdf
          );
          const execResult = await executeActionsOnActiveTab(enrichedDomActions, {
            highlight: settings.highlightElements,
            safeSubmitMode: settings.safeSubmitMode,
            searchEngine: settings.searchEngine,
            searchResults: snapshot.searchResults,
          });

          currentStep.actions.push(...execResult.logs);
          navigated = execResult.logs.some((l) => l.success && NAV_ACTIONS.has(l.action.action));

          if (execResult.pausedForSubmit) {
            currentStep.status = 'paused_for_submit';
            syncAssistantMessage(
              `${finalAnswer}\n\n*(Paused before clicking final Submit button so you can review.)*`,
              false,
              latestPdf
            );
            break;
          }
        }

        currentStep.status = 'completed';
        const actionSummaryText =
          currentStep.actions.length > 0
            ? `${stepResult.summary} (${currentStep.actions.map((a) => a.message).join('; ')})`
            : stepResult.summary;
        previousSummaries.push(actionSummaryText);

        // Keep going after surfing to a new page (the model hasn't seen it yet), after
        // clicks/scrolls it asked to follow up on, or when it wants screenshots.
        const wantsAnotherStep =
          screenshotRequested ||
          navigated ||
          (stepResult.status === 'continue' && domActions.length > 0);
        const isFinishing = !wantsAnotherStep || stepNum >= settings.maxSteps;

        if (isFinishing) break;

        syncAssistantMessage(
          `Step ${stepNum} complete. Reading the updated page for step ${stepNum + 1}...`,
          true,
          latestPdf
        );
        await new Promise((r) => setTimeout(r, 400));
      }

      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // PDF requested but not built yet → write the document, then build it
      if (pdfMeta && !latestPdf) {
        let documentMd = finalAnswer;
        const lastStep = stepsTrace[stepsTrace.length - 1];

        // In plain (non-browsing) mode the model already wrote the full document as its answer
        if (usedActionMode || documentMd.trim().length < 200) {
          if (lastStep) lastStep.summary = 'Writing the PDF document...';
          syncAssistantMessage('Writing the document for your PDF...', true);
          const writer = buildDocumentWriterPrompt({
            userInstruction: userPrompt,
            title: pdfMeta.title,
            notes: gatheredNotes,
            draftAnswer: finalAnswer,
            snapshot: lastSnapshotSeen,
            uploadedDocsBlock,
            conversationBlock,
            profile: workingProfile,
            knowledgeBlock: retrieveRelevantKnowledge(knowledge, knowledgeQuery, 1500),
          });
          const written = await streamOllamaStep({
            host: settings.ollamaHost,
            model: settings.selectedModel,
            system: writer.system,
            user: writer.user,
            isActionPrompt: false,
            signal: abortController.signal,
            temperature: 0.4,
            numPredictReserve: 6144,
            onProgress: ({ rawContent }) => {
              if (rawContent) syncAssistantMessage(rawContent, true);
            },
          });
          documentMd = written.answer;
        }

        // Strip chatty wrappers some models add around the document
        documentMd = documentMd
          .replace(/^\s*(here(?:'s| is)[^\n]*\n+)/i, '')
          .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1')
          .trim();

        if (documentMd.length > 20) {
          const title =
            pdfMeta.title ||
            titleFromMarkdown(documentMd) ||
            (lastSnapshotSeen && !lastSnapshotSeen.restricted ? lastSnapshotSeen.title : '') ||
            'Any Agent Document';
          await savePdf(
            {
              title,
              filename: pdfMeta.filename || `${title}.pdf`,
              markdownContent: documentMd,
              createdAt: Date.now(),
            },
            lastStep,
            { action: 'generate_pdf', title }
          );
          finalAnswer = documentMd;
        }
      }

      syncAssistantMessage(
        finalAnswer || stepsTrace[stepsTrace.length - 1]?.summary || 'Done.',
        false,
        latestPdf
      );
    } catch (err: any) {
      const isAborted = err?.name === 'AbortError';
      if (stepsTrace.length > 0) {
        stepsTrace[stepsTrace.length - 1].status = isAborted ? 'completed' : 'error';
        if (isAborted && !stepsTrace[stepsTrace.length - 1].summary) {
          stepsTrace[stepsTrace.length - 1].summary = 'Stopped by user.';
        }
      }
      const rawMessage = String(err?.message || err);
      const friendly = /model .*not found|404/i.test(rawMessage)
        ? `Error: ${rawMessage}. Pull that model with \`ollama pull <model>\`, or pick an installed one in Settings${
            uploadedImages.length > 0 ? ' (images and scanned PDFs need a vision model such as gemma3 or llama3.2-vision)' : ''
          }.`
        : `Error: ${rawMessage}. Make sure Ollama is running locally (${settings.ollamaHost}).`;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const hasMeaningfulPartial =
            isAborted &&
            m.content &&
            !m.content.startsWith('Reading active webpage') &&
            !m.content.startsWith('Capturing page screenshots') &&
            !m.content.startsWith('Step ') &&
            !m.content.startsWith('Thinking with ') &&
            !m.content.startsWith('Drafting response') &&
            !m.content.startsWith('Writing the document');

          return {
            ...m,
            content: isAborted
              ? hasMeaningfulPartial
                ? `${m.content}\n\n*( Generation stopped by user )*\n`
                : '*( Generation stopped by user )*'
              : friendly,
            steps: [...stepsTrace],
            isStreaming: false,
            generatedPdf: latestPdf || m.generatedPdf,
          };
        })
      );
    } finally {
      setIsRunning(false);
    }

    // Learn in the background after the answer is shown (doesn't block the UI)
    if (!abortController.signal.aborted) {
      void learnFromChat(userPrompt.trim(), assistantMsgId, quote || prevAssistant);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#111114] text-[#F3F2EE] select-none font-sans">
      {/* Top Navigation Bar */}
      <header className="shrink-0 border-b border-[#24242B] bg-[#16161A]/95 backdrop-blur-md px-3.5 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#D97757]/25 to-[#D97757]/5 border border-[#D97757]/40 flex items-center justify-center shadow-inner shrink-0">
            <Bot className="w-4 h-4 text-[#E5886A]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold tracking-tight text-white">
                Any Agent
              </span>
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium border ${
                  ollamaConnected
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/25'
                }`}
                title={ollamaConnected ? 'Ollama Connected' : 'Ollama Offline'}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    ollamaConnected ? 'bg-emerald-400' : 'bg-rose-400'
                  }`}
                />
                {ollamaConnected ? 'Local' : 'Offline'}
              </span>
            </div>
            <div className="text-[10px] text-[#8E8D8A] font-mono truncate max-w-[140px]">
              {settings.selectedModel}
            </div>
          </div>
        </div>

        {/* Navigation Pills */}
        <div className="flex items-center bg-[#101013] p-1 rounded-xl border border-[#25252C]">
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              activeTab === 'chat'
                ? 'bg-[#26262E] text-white shadow-sm'
                : 'text-[#8E8D8A] hover:text-white'
            }`}
          >
            <MessageSquare className="w-3 h-3" />
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              activeTab === 'memory'
                ? 'bg-[#26262E] text-white shadow-sm'
                : 'text-[#8E8D8A] hover:text-white'
            }`}
          >
            <Database className="w-3 h-3" />
            Memory
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`flex items-center px-2 py-1 rounded-lg text-[11px] font-medium transition-all ${
              activeTab === 'settings'
                ? 'bg-[#26262E] text-white shadow-sm'
                : 'text-[#8E8D8A] hover:text-white'
            }`}
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'memory' && (
          <div className="flex flex-col h-full">
            <div className="shrink-0 px-4 pt-3">
              <div className="flex bg-[#141416] p-0.5 rounded-lg border border-[#2B2B30]">
                {(['profile', 'knowledge'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setMemoryView(view)}
                    className={`flex-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                      memoryView === view
                        ? 'bg-[#2A2A30] text-white shadow-sm'
                        : 'text-[#9A9893] hover:text-white'
                    }`}
                  >
                    {view === 'profile'
                      ? 'Profile'
                      : `Knowledge${knowledge.length ? ` (${knowledge.length})` : ''}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              {memoryView === 'profile' ? (
                <MemoryPanel profile={profile} onSave={handleSaveProfile} />
              ) : (
                <KnowledgePanel
                  settings={settings}
                  profile={profile}
                  entries={knowledge}
                  onSaveEntries={handleSaveKnowledge}
                  onApplyProfile={handleSaveProfile}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <SettingsPanel
            settings={settings}
            availableModels={availableModels}
            ollamaConnected={ollamaConnected}
            onUpdateSettings={handleUpdateSettings}
            onRefreshModels={() => checkOllama(settings.ollamaHost, settings.selectedModel)}
          />
        )}

        {activeTab === 'chat' && (
          <div className="flex flex-col h-full">
            {/* Sub-bar for inspecting distilled DOM & Page Text */}
            <div className="px-3.5 py-2 bg-[#141418] border-b border-[#222228] flex items-center justify-between text-[11px] text-[#8E8D8A]">
              <button
                type="button"
                onClick={handleInspectDom}
                className="flex items-center gap-1.5 hover:text-[#F3F2EE] transition-colors truncate"
              >
                <span className="w-4 h-4 rounded-md bg-[#D97757]/15 flex items-center justify-center shrink-0">
                  <Eye className="w-3 h-3 text-[#D97757]" />
                </span>
                <span className="truncate">
                  {lastSnapshot
                    ? `Context: ${lastSnapshot.title.slice(0, 30)}`
                    : 'Inspect Active Page Context'}
                </span>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                {isRunning && (
                  <button
                    type="button"
                    onClick={stopAgentLoop}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-[10px] font-medium transition-colors"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    Stop
                  </button>
                )}
                {messages.length > 0 && !isRunning && (
                  <button
                    type="button"
                    onClick={() => setMessages([])}
                    className="flex items-center gap-1 text-[#7E7D7A] hover:text-rose-400 transition-colors"
                    title="Clear conversation"
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Collapsible Distilled Page Context Inspector */}
            {showDomPreview && lastSnapshot && (
              <div className="bg-[#131316] border-b border-[#2C2C32] px-3.5 py-2.5 max-h-56 overflow-y-auto space-y-2">
                <div className="flex items-center justify-between text-[11px] text-[#A19F99]">
                  <span className="font-semibold text-[#D97757]">
                    Extracted Page Text ({lastSnapshot.readableText.length} chars)
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowDomPreview(false)}
                    className="text-[10px] underline hover:text-white"
                  >
                    Hide
                  </button>
                </div>
                <pre className="text-[10px] font-mono text-[#B0AFA9] whitespace-pre-wrap leading-relaxed bg-[#1A1A1E] p-2 rounded border border-[#28282E]">
                  {lastSnapshot.readableText || 'No readable text found.'}
                </pre>
                <div className="text-[11px] font-semibold text-[#D97757] pt-1">
                  Interactive Elements ({lastSnapshot.elements.length} items)
                </div>
                <pre className="text-[10px] font-mono text-[#B0AFA9] whitespace-pre-wrap leading-relaxed bg-[#1A1A1E] p-2 rounded border border-[#28282E]">
                  {lastSnapshot.compactText || 'No interactive elements found.'}
                </pre>
              </div>
            )}

            {/* Messages Feed */}
            <div
              ref={chatScrollRef}
              onMouseUp={handleChatSelection}
              onKeyUp={handleChatSelection}
              onScroll={() => selectionPopup && setSelectionPopup(null)}
              className="flex-1 overflow-y-auto px-3.5 py-4 space-y-4 select-text"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col justify-center items-center text-center px-3 space-y-5">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#D97757]/25 to-[#D97757]/5 border border-[#D97757]/35 flex items-center justify-center shadow-lg">
                      <Sparkles className="w-5 h-5 text-[#E5886A]" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-[15px] font-semibold tracking-tight text-white">
                      How can I help with this page?
                    </h2>
                    <p className="text-xs text-[#8E8D8A] max-w-[260px] leading-relaxed">
                      Summarize content, auto-fill forms from your Memory, or ask anything using your local Ollama model.
                    </p>
                  </div>

                  {/* Quick One-Click Actions */}
                  <div className="w-full space-y-2 pt-1">
                    <div className="text-[10px] uppercase tracking-widest text-[#6E6D6A] font-semibold text-left px-1">
                      Suggested Actions
                    </div>
                    {QUICK_PROMPTS.map((item) => {
                      const IconComponent = item.icon;
                      return (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => runMultiStepAgent(item.prompt)}
                          className="group w-full text-left px-3.5 py-2.5 rounded-xl bg-[#18181D] hover:bg-[#202027] border border-[#26262E] hover:border-[#D97757]/40 text-xs text-[#E5E4E0] flex items-center gap-3 transition-all shadow-sm"
                        >
                          <span className="w-6 h-6 rounded-lg bg-[#D97757]/10 group-hover:bg-[#D97757]/20 border border-[#D97757]/20 flex items-center justify-center shrink-0 transition-colors">
                            <IconComponent className="w-3.5 h-3.5 text-[#D97757]" />
                          </span>
                          <span className="truncate font-medium">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div
                      className={`rounded-2xl px-3.5 py-3 text-xs leading-relaxed shadow-sm ${
                        msg.role === 'user'
                          ? 'max-w-[88%] bg-gradient-to-br from-[#D97757] to-[#C46445] text-white'
                          : 'w-full bg-[#18181D] border border-[#272730] text-[#F3F2EE] space-y-2.5'
                      }`}
                    >
                      {msg.steps && msg.steps.length > 0 && (
                        <div className="space-y-2">
                          {msg.steps.map((st) => (
                            <StepTraceCard
                              key={st.stepNumber}
                              step={st}
                              onStop={isRunning && msg.isStreaming ? stopAgentLoop : undefined}
                            />
                          ))}
                        </div>
                      )}
                      {msg.role === 'assistant' ? (
                        <>
                          <ErrorBoundary fallbackText="Couldn't render this message as Markdown.">
                            <MarkdownRenderer content={msg.content} />
                          </ErrorBoundary>

                          {/* Generated PDF Card */}
                          {msg.generatedPdf && (
                            <div className="mt-2.5 flex items-center justify-between gap-2.5 rounded-xl bg-[#121216] border border-[#D97757]/40 px-3 py-2.5">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span className="w-8 h-8 rounded-lg bg-[#D97757]/15 border border-[#D97757]/30 flex items-center justify-center shrink-0">
                                  <FileDown className="w-4 h-4 text-[#E5886A]" />
                                </span>
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-white truncate">
                                    {msg.generatedPdf.title}
                                  </div>
                                  <div className="text-[10px] text-[#8E8D8A] truncate">
                                    PDF Ready · {msg.generatedPdf.filename}
                                  </div>
                                </div>
                              </div>
                              <div className="shrink-0 flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => previewGeneratedPdf(msg.generatedPdf!)}
                                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-[#3A3A44] hover:border-[#D97757]/60 text-[#CBCAC4] hover:text-white text-[11px] transition-colors"
                                  title="Open the PDF in a new tab"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  View
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void downloadGeneratedPdf(msg.generatedPdf!)}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#D97757] hover:bg-[#E5886A] text-white text-[11px] font-medium transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  Download
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Quick Export Any Response as PDF */}
                          {!msg.isStreaming && !msg.generatedPdf && msg.content.length > 140 && (
                            <div className="pt-1.5 flex justify-end border-t border-[#24242C]/80">
                              <button
                                type="button"
                                onClick={() => {
                                  const title =
                                    msg.content.match(/^#\s+(.+)$/m)?.[1].replace(/[*_`]/g, '').trim() ||
                                    (lastSnapshot && !lastSnapshot.restricted ? lastSnapshot.title : '') ||
                                    'Any Agent Document';
                                  void downloadGeneratedPdf({
                                    title,
                                    filename: `${title}.pdf`,
                                    markdownContent: msg.content,
                                    createdAt: Date.now(),
                                  });
                                }}
                                className="inline-flex items-center gap-1 text-[10px] text-[#8E8D8A] hover:text-[#E5886A] transition-colors"
                                title="Export this response as a PDF file"
                              >
                                <FileDown className="w-3 h-3" />
                                Export as PDF
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {msg.attachments.map((att) => (
                                <span
                                  key={att.id}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/25 border border-white/20 text-[10px] text-white"
                                >
                                  <Paperclip className="w-2.5 h-2.5" />
                                  <span className="truncate max-w-[140px]">{att.name}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {msg.quote && (
                            <div className="mb-1.5 pl-2 border-l-2 border-white/60 text-[11px] text-white/80 line-clamp-3 whitespace-pre-wrap break-words">
                              {msg.quote}
                            </div>
                          )}
                          <div className="whitespace-pre-wrap text-white leading-relaxed">
                            {msg.content}
                          </div>
                        </>
                      )}
                      {msg.memoryUpdate?.status === 'pending' && (
                        <div className="flex items-center gap-1.5 text-[10px] text-[#8E8D8A] pt-1 border-t border-[#2C2C32]">
                          <Loader2 className="w-3 h-3 animate-spin text-[#D97757]" />
                          Checking for anything new to remember...
                        </div>
                      )}
                      {msg.memoryUpdate?.status === 'done' && (
                        <div className="rounded-lg border border-[#D97757]/30 bg-[#D97757]/5 px-2.5 py-2 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[#F3F2EE]">
                              <Brain className="w-3 h-3 text-[#D97757]" />
                              Memory updated
                            </span>
                            <button
                              type="button"
                              onClick={() => undoMemoryUpdate(msg.id)}
                              className="flex items-center gap-1 text-[10px] text-[#A19F99] hover:text-white transition-colors"
                            >
                              <Undo2 className="w-3 h-3" />
                              Undo
                            </button>
                          </div>
                          <ul className="space-y-0.5">
                            {msg.memoryUpdate.items.map((item, idx) => (
                              <li key={idx} className="text-[10px] text-[#B8B7B2] break-words">
                                • {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {msg.memoryUpdate?.status === 'undone' && (
                        <div className="text-[10px] text-[#7E7D7A] pt-1 border-t border-[#2C2C32]">
                          Memory change undone.
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Floating "Reply / Copy" bubble over highlighted chat text */}
            {selectionPopup && (
              <div
                className="fixed z-50 flex items-center gap-0.5 bg-[#2A2A30] border border-[#3E3E46] rounded-lg shadow-lg p-0.5 -translate-x-1/2"
                style={{ left: selectionPopup.x, top: selectionPopup.y }}
                onMouseDown={(e) => e.preventDefault()} // keep the selection alive while clicking
              >
                <button
                  type="button"
                  onClick={startReplyToSelection}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-white hover:bg-[#D97757] transition-colors"
                >
                  <Reply className="w-3.5 h-3.5" />
                  Reply
                </button>
                <div className="w-px h-4 bg-[#3E3E46]" />
                <button
                  type="button"
                  onClick={copySelection}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[#CBCAC4] hover:text-white hover:bg-[#35353C] transition-colors"
                  title="Copy"
                >
                  {copiedSelection ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            )}

            {/* Bottom Prompt Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendFromInput();
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.files.length || isRunning) return;
                e.preventDefault();
                void attachFiles(Array.from(e.dataTransfer.files));
              }}
              className="p-3 border-t border-[#24242C] bg-[#151519]"
            >
              {/* Prominent Live Thinking / Writing Stop Bar */}
              {isRunning && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-[#1E1E25] border border-[#32323D] px-3 py-2 shadow-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#D97757] opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#D97757]" />
                    </span>
                    <span className="text-[11px] text-[#D8D7D2] truncate">
                      {settings.selectedModel} is thinking & writing...
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={stopAgentLoop}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-[11px] font-medium transition-colors"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    Stop Generating
                  </button>
                </div>
              )}

              {replyQuote && (
                <div className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-[#D97757] bg-[#1E1E24] px-3 py-2">
                  <Reply className="w-3.5 h-3.5 text-[#D97757] shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-semibold text-[#D97757]">Replying to selection</div>
                    <div className="text-[11px] text-[#CBCAC4] line-clamp-3 whitespace-pre-wrap break-words">
                      {replyQuote}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReplyQuote(null)}
                    className="text-[#8E8D8A] hover:text-white shrink-0"
                    title="Cancel reply"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {parsingFiles.length > 0 && (
                <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#A19F99]">
                  <Loader2 className="w-3 h-3 animate-spin text-[#D97757]" />
                  Reading {parsingFiles.join(', ')}...
                </div>
              )}
              {attachError && (
                <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">
                  <span className="break-words">{attachError}</span>
                  <button type="button" onClick={() => setAttachError('')} className="shrink-0 hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              {attachedDocs.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {attachedDocs.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1E1E24] border border-[#32323D] text-[11px] text-[#E5E4E0]"
                    >
                      <Paperclip className="w-3 h-3 text-[#D97757] shrink-0" />
                      <span className="truncate max-w-[150px]">{doc.name}</span>
                      <span className="text-[9px] text-[#7E7D7A] shrink-0">
                        {doc.imageDataUrl
                          ? 'image'
                          : doc.pageImages?.length
                          ? 'scanned'
                          : `${Math.max(1, Math.round(doc.textContent.length / 1000))}k chars`}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachedDoc(doc.id)}
                        className="text-[#8E8D8A] hover:text-rose-400"
                        title="Remove file"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="relative flex items-end gap-2 bg-[#101013] border border-[#2B2B34] focus-within:border-[#D97757]/80 rounded-2xl px-2.5 py-2 transition-all shadow-inner">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={UPLOAD_ACCEPT}
                  onChange={handleAttachFiles}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => fileInputRef.current?.click()}
                  className="shrink-0 p-2 rounded-xl text-[#8E8D8A] hover:text-white hover:bg-[#1E1E26] disabled:opacity-40 transition-colors"
                  title="Attach documents (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, code) or images"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <textarea
                  ref={inputRef}
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendFromInput();
                    } else if (e.key === 'Escape' && isRunning) {
                      stopAgentLoop();
                    } else if (e.key === 'Escape' && replyQuote) {
                      setReplyQuote(null);
                    }
                  }}
                  placeholder={
                    replyQuote
                      ? 'Ask about the highlighted part...'
                      : attachedDocs.length > 0
                      ? 'Ask about your attached document(s), fill a form from them, or build a PDF...'
                      : 'Surf a site, upload a doc, build a PDF, or auto-fill this page...'
                  }
                  disabled={isRunning}
                  className="flex-1 bg-transparent text-xs text-[#F3F2EE] placeholder-[#6E6D6A] resize-none focus:outline-none leading-relaxed"
                />
                {isRunning ? (
                  <button
                    type="button"
                    onClick={stopAgentLoop}
                    className="shrink-0 px-2.5 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                    title="Stop generation"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={(!input.trim() && attachedDocs.length === 0) || parsingFiles.length > 0}
                    className="shrink-0 p-2 rounded-xl bg-gradient-to-br from-[#D97757] to-[#C46445] hover:from-[#E5886A] hover:to-[#D97757] disabled:opacity-35 text-white transition-all shadow-sm"
                    title="Send prompt"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  );
};
