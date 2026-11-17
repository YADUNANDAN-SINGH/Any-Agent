import React, { useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AgentSettings, KnowledgeEntry, PersonalProfile } from '../types/agent';
import { IMPORT_PROMPT_FOR_OTHER_AI, PROFILE_FIELDS } from '../lib/knowledge';
import { extractProfileFromText } from '../lib/ollama';
import { parseUploadedFile } from '../lib/documentTools';
import { MarkdownRenderer } from './MarkdownRenderer';

interface KnowledgePanelProps {
  settings: AgentSettings;
  profile: PersonalProfile;
  entries: KnowledgeEntry[];
  onSaveEntries: (entries: KnowledgeEntry[]) => Promise<void>;
  onApplyProfile: (profile: PersonalProfile) => Promise<void>;
}

const SOURCES = ['ChatGPT', 'Claude', 'Gemini', 'Document', 'Other'];

const makeEntry = (content: string, title: string, source: string): KnowledgeEntry => ({
  id: `kn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  title,
  source,
  content,
  createdAt: Date.now(),
});

export const KnowledgePanel: React.FC<KnowledgePanelProps> = ({
  settings,
  profile,
  entries,
  onSaveEntries,
  onApplyProfile,
}) => {
  const [source, setSource] = useState('ChatGPT');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Partial<PersonalProfile> | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleUploadDocToKnowledge = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setError('');
    setNotice('');
    try {
      const parsedDocs = await Promise.all(files.map(parseUploadedFile));
      const combinedText = parsedDocs
        .map((d) => `# ${d.name}\n\n${d.textContent}`)
        .join('\n\n---\n\n');
      setSource('Document');
      setTitle(parsedDocs.map((d) => d.name).join(', '));
      setText((prev) => (prev ? `${prev}\n\n${combinedText}` : combinedText));
      setNotice(
        `Loaded ${parsedDocs.length} file(s). Click "Save + auto-fill profile" or "Save only" below.`
      );
    } catch (err: any) {
      setError(`Could not read document: ${err?.message || String(err)}`);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT_FOR_OTHER_AI);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = IMPORT_PROMPT_FOR_OTHER_AI;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = async (withExtract: boolean) => {
    const content = text.trim();
    if (!content || busy) return;
    setError('');
    setNotice('');

    const baseTitle =
      title.trim() || `${source} context · ${new Date().toLocaleDateString()}`;
    let next = [makeEntry(content, baseTitle, source), ...entries];

    if (!withExtract) {
      await onSaveEntries(next);
      setText('');
      setTitle('');
      setNotice('Saved. Any Agent will use this to personalize its answers.');
      return;
    }

    setBusy(true);
    try {
      const result = await extractProfileFromText({
        host: settings.ollamaHost,
        model: settings.selectedModel,
        text: content,
      });

      if (result.facts.length > 0) {
        next = [
          makeEntry(
            result.facts.map((f) => `- ${f}`).join('\n'),
            `Key facts · ${baseTitle}`,
            source
          ),
          ...next,
        ];
      }
      await onSaveEntries(next);

      const keys = Object.keys(result.profile);
      if (keys.length > 0) {
        setPending(result.profile);
        // Pre-check fields that are empty in the profile; don't overwrite existing values by default
        setSelected(
          Object.fromEntries(
            keys.map((k) => [k, !profile[k as keyof PersonalProfile]?.trim()])
          )
        );
      }
      setNotice(
        `Saved. Found ${keys.length} profile field(s) and ${result.facts.length} key fact(s).` +
          (keys.length > 0 ? ' Review the fields below.' : '')
      );
      setText('');
      setTitle('');
    } catch (err: any) {
      await onSaveEntries(next);
      setError(
        `The text was saved, but auto-fill failed: ${err?.message || String(err)}`
      );
    } finally {
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    const updates = Object.fromEntries(
      Object.entries(pending).filter(([k]) => selected[k])
    ) as Partial<PersonalProfile>;
    await onApplyProfile({ ...profile, ...updates });
    setNotice(`Updated ${Object.keys(updates).length} profile field(s).`);
    setPending(null);
  };

  const deleteEntry = async (id: string) => {
    await onSaveEntries(entries.filter((e) => e.id !== id));
  };

  const totalChars = entries.reduce((n, e) => n + e.content.length, 0);
  const inputClass =
    'w-full bg-[#1E1E21] border border-[#323236] rounded-lg px-3 py-2 text-xs text-[#F3F2EE] placeholder-[#787774] focus:outline-none focus:border-[#D97757] transition-colors';

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-3 space-y-4">
      {/* Intro + copy prompt */}
      <div className="bg-[#222226] border border-[#323236] rounded-xl p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#F3F2EE]">
          <Brain className="w-3.5 h-3.5 text-[#D97757]" />
          Bring your context from another AI
        </div>
        <ol className="text-[11px] text-[#A19F99] leading-relaxed list-decimal pl-4 space-y-0.5">
          <li>Copy the prompt below.</li>
          <li>Paste it into ChatGPT, Claude or Gemini (where your history lives).</li>
          <li>Paste its answer here. It is stored only in this browser.</li>
        </ol>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyPrompt}
            className="flex items-center gap-1.5 bg-[#2B2B30] hover:bg-[#35353B] border border-[#3E3E44] text-[11px] text-[#F3F2EE] px-2.5 py-1.5 rounded-lg transition-colors"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ClipboardCopy className="w-3.5 h-3.5" />
            )}
            {copied ? 'Prompt copied' : 'Copy export prompt'}
          </button>

          <label className="cursor-pointer flex items-center gap-1.5 bg-[#D97757]/15 hover:bg-[#D97757]/25 border border-[#D97757]/40 text-[11px] text-[#F3F2EE] px-2.5 py-1.5 rounded-lg transition-colors">
            <Upload className="w-3.5 h-3.5 text-[#D97757]" />
            <span>Upload Resume / Doc (.pdf, .docx, .txt, .md)</span>
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md,.csv,.json,.html"
              onChange={handleUploadDocToKnowledge}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Paste box */}
      <section className="space-y-2">
        <div className="flex gap-2">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="bg-[#1E1E21] border border-[#323236] rounded-lg px-2 py-2 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className={inputClass}
          />
        </div>
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste what the other AI knows about you: profile, projects, preferences, writing style, goals..."
          className={`${inputClass} font-mono text-[11px] leading-relaxed`}
        />
        <div className="flex items-center justify-between text-[10px] text-[#7E7D7A]">
          <span>{text.length.toLocaleString()} chars</span>
          {text.length > 12000 && (
            <span>Auto-fill reads the first 12k chars; the full text is still saved.</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!text.trim() || busy}
            onClick={() => handleSave(true)}
            className="flex-1 flex items-center justify-center gap-1.5 bg-[#D97757] hover:bg-[#E5886A] disabled:opacity-40 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {busy ? `Reading with ${settings.selectedModel}...` : 'Save + auto-fill profile'}
          </button>
          <button
            type="button"
            disabled={!text.trim() || busy}
            onClick={() => handleSave(false)}
            className="flex items-center gap-1.5 bg-[#2B2B30] hover:bg-[#35353B] disabled:opacity-40 border border-[#3E3E44] text-xs text-[#F3F2EE] px-3 py-2 rounded-lg transition-colors"
            title="Save without running the model"
          >
            <Save className="w-3.5 h-3.5" />
            Save only
          </button>
        </div>
        {notice && <div className="text-[11px] text-emerald-400">{notice}</div>}
        {error && <div className="text-[11px] text-rose-400 break-words">{error}</div>}
      </section>

      {/* Extracted profile review */}
      {pending && (
        <section className="bg-[#1E1E22] border border-[#D97757]/40 rounded-xl p-3 space-y-2">
          <div className="text-xs font-semibold text-[#F3F2EE]">
            Review fields to add to your profile
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {PROFILE_FIELDS.filter((f) => pending[f.key]).map((f) => {
              const current = profile[f.key]?.trim();
              return (
                <label
                  key={f.key}
                  className="flex items-start gap-2 text-[11px] bg-[#161619] border border-[#28282D] rounded-lg px-2.5 py-1.5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={!!selected[f.key]}
                    onChange={(e) =>
                      setSelected((s) => ({ ...s, [f.key]: e.target.checked }))
                    }
                    className="mt-0.5 accent-[#D97757]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[#D97757]">{f.label}</div>
                    <div className="text-[#E2E1DC] break-words">{pending[f.key]}</div>
                    {current && (
                      <div className="text-[10px] text-[#7E7D7A] break-words">
                        Current: {current}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={applyPending}
              className="flex-1 bg-[#D97757] hover:bg-[#E5886A] text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              Apply selected
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="bg-[#2B2B30] hover:bg-[#35353B] border border-[#3E3E44] text-xs text-[#F3F2EE] px-3 py-1.5 rounded-lg"
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      {/* Stored knowledge */}
      <section className="space-y-2 pb-4">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-[#E5E4E0]">
            Saved knowledge ({entries.length})
          </div>
          <div className="text-[10px] text-[#7E7D7A]">
            {totalChars.toLocaleString()} chars · relevant parts are sent with each prompt
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="text-[11px] text-[#7E7D7A] bg-[#1A1A1D] border border-dashed border-[#2E2E34] rounded-lg p-3 text-center">
            Nothing imported yet.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="bg-[#1E1E22] border border-[#303036] rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                >
                  {expandedId === e.id ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#9A9893] shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#9A9893] shrink-0" />
                  )}
                  <span className="text-[11px] text-[#E5E4E0] truncate">{e.title}</span>
                </button>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2A2A30] text-[#A19F99] shrink-0">
                  {e.source}
                </span>
                <button
                  type="button"
                  onClick={() => deleteEntry(e.id)}
                  className="text-[#7E7D7A] hover:text-rose-400 shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {expandedId === e.id && (
                <div className="px-3 pb-3 pt-1 border-t border-[#28282D] max-h-64 overflow-y-auto">
                  <MarkdownRenderer content={e.content} />
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
};

