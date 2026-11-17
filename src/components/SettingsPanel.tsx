import React from 'react';
import { RefreshCw, ShieldCheck, Cpu, Sliders, Eye, Camera, Brain } from 'lucide-react';
import type { AgentSettings } from '../types/agent';
import type { OllamaModelTag } from '../lib/ollama';

interface SettingsPanelProps {
  settings: AgentSettings;
  availableModels: OllamaModelTag[];
  ollamaConnected: boolean;
  onUpdateSettings: (next: AgentSettings) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  availableModels,
  ollamaConnected,
  onUpdateSettings,
  onRefreshModels,
}) => {
  const update = <K extends keyof AgentSettings>(key: K, val: AgentSettings[K]) => {
    onUpdateSettings({ ...settings, [key]: val });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-3 space-y-4">
      {/* Ollama Connection Card */}
      <div className="bg-[#222226] border border-[#323236] rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#D97757]" />
            <span className="text-xs font-semibold text-[#F3F2EE]">Local Ollama Connection</span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
              ollamaConnected
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                ollamaConnected ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
            {ollamaConnected ? 'Connected' : 'Offline'}
          </span>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-[#A19F99] mb-1">
            Ollama Endpoint URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.ollamaHost}
              onChange={(e) => update('ollamaHost', e.target.value)}
              placeholder="http://localhost:11434"
              className="flex-1 bg-[#18181B] border border-[#323236] rounded-lg px-3 py-1.5 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
            />
            <button
              type="button"
              onClick={onRefreshModels}
              className="px-2.5 py-1.5 bg-[#2B2B30] hover:bg-[#35353B] border border-[#3E3E44] rounded-lg text-xs text-[#F3F2EE] flex items-center gap-1 transition-colors"
              title="Refresh installed Ollama models"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Test
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-[#A19F99] mb-1">
            Primary Model (DOM & Reasoning — e.g. deepseek-r1:8b, gemma4)
          </label>
          <input
            type="text"
            value={settings.selectedModel}
            onChange={(e) => update('selectedModel', e.target.value)}
            placeholder="deepseek-r1:8b"
            className="w-full bg-[#18181B] border border-[#323236] rounded-lg px-3 py-1.5 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          />
          {availableModels.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] text-[#8E8D8A] mb-1">Detected Local Models (click to select):</div>
              <div className="flex flex-wrap gap-1.5">
                {availableModels.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => update('selectedModel', m.name)}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                      settings.selectedModel === m.name
                        ? 'bg-[#D97757]/20 border-[#D97757] text-[#F3F2EE]'
                        : 'bg-[#18181B] border-[#323236] text-[#A19F99] hover:text-white'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-[#2E2E32]">
          <label className="block text-[11px] font-medium text-[#A19F99] mb-1">
            Vision Model for Screenshots (e.g. gemma4, llava, llama3.2-vision, qwen2.5vl)
          </label>
          <input
            type="text"
            value={settings.visionModel || settings.selectedModel}
            onChange={(e) => update('visionModel', e.target.value)}
            placeholder="gemma4"
            className="w-full bg-[#18181B] border border-[#323236] rounded-lg px-3 py-1.5 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          />
          {availableModels.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {availableModels.map((m) => (
                <button
                  key={`vision-${m.name}`}
                  type="button"
                  onClick={() => update('visionModel', m.name)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    settings.visionModel === m.name
                      ? 'bg-[#D97757]/20 border-[#D97757] text-[#F3F2EE]'
                      : 'bg-[#18181B] border-[#323236] text-[#8E8D8A] hover:text-white'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Screenshot Fallback Settings */}
      <div className="bg-[#222226] border border-[#323236] rounded-xl p-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-[#D97757]" />
          <span className="text-xs font-semibold text-[#F3F2EE]">
            Multi-Screenshot Fallback (When DOM is Empty/Canvas/PDF)
          </span>
        </div>

        <label className="flex items-start justify-between gap-3 cursor-pointer">
          <div>
            <div className="text-xs font-medium text-[#E5E4E0]">
              Auto-Capture Screenshots When DOM is Unavailable
            </div>
            <div className="text-[11px] text-[#9A9893]">
              If a page has no accessible DOM text (PDFs, Canvas apps, restricted pages), automatically scroll and take screenshots to read the page visually.
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.autoScreenshotFallback}
            onChange={(e) => update('autoScreenshotFallback', e.target.checked)}
            className="mt-1 accent-[#D97757]"
          />
        </label>

        <div className="flex items-center justify-between pt-2 border-t border-[#2E2E32]">
          <div>
            <div className="text-xs font-medium text-[#E5E4E0]">Max Scrolled Screenshots</div>
            <div className="text-[11px] text-[#9A9893]">
              Maximum viewport captures stitched per page scan
            </div>
          </div>
          <select
            value={settings.maxScreenshots || 4}
            onChange={(e) => update('maxScreenshots', Number(e.target.value))}
            className="bg-[#18181B] border border-[#323236] rounded-lg px-2.5 py-1 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          >
            {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                Up to {n} {n === 1 ? 'shot' : 'shots'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Multi-Step Agent Loop Settings */}
      <div className="bg-[#222226] border border-[#323236] rounded-xl p-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-[#D97757]" />
          <span className="text-xs font-semibold text-[#F3F2EE]">Multi-Step Loop & Safety</span>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-[#E5E4E0]">Max Autonomous Steps</div>
            <div className="text-[11px] text-[#9A9893]">
              Maximum observe → think → act iterations per prompt
            </div>
          </div>
          <select
            value={settings.maxSteps}
            onChange={(e) => update('maxSteps', Number(e.target.value))}
            className="bg-[#18181B] border border-[#323236] rounded-lg px-2.5 py-1 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          >
            {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'step' : 'steps'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-[#2E2E32]">
          <div>
            <div className="text-xs font-medium text-[#E5E4E0]">Web Search Engine</div>
            <div className="text-[11px] text-[#9A9893]">
              Used when the agent searches the web while surfing
            </div>
          </div>
          <select
            value={settings.searchEngine || 'google'}
            onChange={(e) => update('searchEngine', e.target.value as AgentSettings['searchEngine'])}
            className="bg-[#18181B] border border-[#323236] rounded-lg px-2.5 py-1 text-xs text-[#F3F2EE] focus:outline-none focus:border-[#D97757]"
          >
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
          </select>
        </div>

        <label className="flex items-start justify-between gap-3 cursor-pointer pt-2 border-t border-[#2E2E32]">
          <div className="flex gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-medium text-[#E5E4E0]">Safe Submit Protection</div>
              <div className="text-[11px] text-[#9A9893]">
                Fill all fields automatically, but pause and highlight before clicking final "Submit" buttons so you can review.
              </div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.safeSubmitMode}
            onChange={(e) => update('safeSubmitMode', e.target.checked)}
            className="mt-1 accent-[#D97757]"
          />
        </label>

        <label className="flex items-start justify-between gap-3 cursor-pointer pt-2 border-t border-[#2E2E32]">
          <div className="flex gap-2">
            <Brain className="w-4 h-4 text-[#D97757] shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-medium text-[#E5E4E0]">Learn About Me From Chat</div>
              <div className="text-[11px] text-[#9A9893]">
                When you share something new about yourself in chat, Any Agent saves it to your Memory (with Undo). Runs locally after each reply.
              </div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.autoLearnFromChat !== false}
            onChange={(e) => update('autoLearnFromChat', e.target.checked)}
            className="mt-1 accent-[#D97757]"
          />
        </label>

        <label className="flex items-start justify-between gap-3 cursor-pointer pt-2 border-t border-[#2E2E32]">
          <div className="flex gap-2">
            <Eye className="w-4 h-4 text-[#D97757] shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-medium text-[#E5E4E0]">Visual Element Glow</div>
              <div className="text-[11px] text-[#9A9893]">
                Highlight inputs and buttons on the webpage as Any Agent interacts with them.
              </div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.highlightElements}
            onChange={(e) => update('highlightElements', e.target.checked)}
            className="mt-1 accent-[#D97757]"
          />
        </label>
      </div>
    </div>
  );
};
