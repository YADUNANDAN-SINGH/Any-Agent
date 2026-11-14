import React, { useEffect, useRef, useState } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Square,
  XCircle,
} from 'lucide-react';
import type { StepTrace } from '../types/agent';

interface StepTraceCardProps {
  step: StepTrace;
  onStop?: () => void;
}

export const StepTraceCard: React.FC<StepTraceCardProps> = ({ step, onStop }) => {
  const [showThinking, setShowThinking] = useState(false);
  const thinkingBoxRef = useRef<HTMLPreElement | null>(null);

  // Auto-collapse once step completes so the final Markdown output stands out cleanly
  useEffect(() => {
    if (step.status === 'running') {
      setShowThinking(true);
    } else if (step.status === 'completed') {
      setShowThinking(false);
    }
  }, [step.status]);

  useEffect(() => {
    if (showThinking && step.status === 'running' && thinkingBoxRef.current) {
      thinkingBoxRef.current.scrollTop = thinkingBoxRef.current.scrollHeight;
    }
  }, [step.thinking, showThinking, step.status]);

  const statusBadge = () => {
    if (step.status === 'running') {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#D97757]/15 text-[#E5886A] border border-[#D97757]/30">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D97757] animate-pulse" />
            Running
          </span>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition-colors"
              title="Stop generation"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              Stop
            </button>
          )}
        </div>
      );
    }
    if (step.status === 'paused_for_submit') {
      return (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
          Review Ready
        </span>
      );
    }
    if (step.status === 'error') {
      return (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 shrink-0">
          Stopped
        </span>
      );
    }
    return (
      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
        Done
      </span>
    );
  };

  return (
    <div className="bg-[#18181C]/90 border border-[#2B2B33] rounded-xl p-3 space-y-2.5 text-xs shadow-sm">
      {/* Step Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-[#ECEBE6] min-w-0">
          {step.status === 'running' ? (
            <Loader2 className="w-3.5 h-3.5 text-[#D97757] animate-spin shrink-0" />
          ) : step.status === 'paused_for_submit' ? (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : step.status === 'error' ? (
            <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          )}
          <span className="shrink-0 text-[11px] font-semibold tracking-tight">
            Step {step.stepNumber}
          </span>
          {step.pageTitle && (
            <span className="text-[11px] text-[#8E8D8A] truncate">
              · {step.pageTitle}
            </span>
          )}
        </div>
        {statusBadge()}
      </div>

      {/* Live Streaming <think> Reasoning Block */}
      {step.thinking && (
        <div className="border border-[#26262E] rounded-lg bg-[#121215] overflow-hidden">
          <div className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] text-[#A19F99]">
            <button
              type="button"
              onClick={() => setShowThinking((v) => !v)}
              className="flex items-center gap-1.5 hover:text-[#F3F2EE] transition-colors flex-1 text-left"
            >
              <Brain className="w-3.5 h-3.5 text-[#D97757]" />
              <span className="font-medium">
                {step.status === 'running' ? 'Reasoning live...' : 'Thought Process'}
              </span>
              {showThinking ? (
                <ChevronDown className="w-3.5 h-3.5 ml-auto" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 ml-auto" />
              )}
            </button>
          </div>
          {showThinking && (
            <pre
              ref={thinkingBoxRef}
              className="px-3 pb-2.5 pt-2 text-[11px] text-[#9A9893] whitespace-pre-wrap font-mono max-h-40 overflow-y-auto border-t border-[#222228] leading-relaxed"
            >
              {step.thinking}
            </pre>
          )}
        </div>
      )}

      {/* Step Summary (only show if different from main answer or while running) */}
      {step.summary && (
        <p className="text-[#A8A7A2] text-[11px] leading-relaxed">{step.summary}</p>
      )}

      {/* Captured Screenshots Thumbnail Strip */}
      {step.screenshots && step.screenshots.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-medium text-[#D97757]">
            Captured {step.screenshots.length} Page Screenshot
            {step.screenshots.length > 1 ? 's' : ''}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {step.screenshots.map((src, idx) => (
              <img
                key={idx}
                src={src}
                alt={`Page capture ${idx + 1}`}
                className="h-20 w-auto rounded-lg border border-[#32323A] object-cover shrink-0"
              />
            ))}
          </div>
        </div>
      )}

      {/* Executed Actions List */}
      {step.actions.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {step.actions.map((log, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-[11px] bg-[#131316] border border-[#25252C] rounded-lg px-2.5 py-1.5"
            >
              <span
                className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                  log.success ? 'bg-emerald-400' : 'bg-rose-400'
                }`}
              />
              <div className="flex-1 min-w-0">
                <span className="font-mono text-[10px] font-semibold text-[#D97757] mr-1.5 uppercase">
                  {log.action.action}
                  {log.action.id !== undefined ? `[#${log.action.id}]` : ''}
                </span>
                <span className="text-[#D0CFC9] break-words">{log.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
