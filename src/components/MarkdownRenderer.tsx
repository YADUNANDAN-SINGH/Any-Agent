import React from 'react';

interface MarkdownRendererProps {
  content: string;
}

function renderInline(text: string): React.ReactNode[] {
  // Clean up stray markdown bold wraps inside headings if needed, and parse **bold**, *italic*, `code`, and [links](url)
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, idx) => {
    if (!part) return null;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-[#151518] border border-[#2F2F36] text-[#F2A98E] font-mono text-[11px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="text-[#D97757] underline hover:text-[#E5886A] transition-colors"
        >
          {linkMatch[1]}
        </a>
      );
    }

    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={idx} className="italic text-[#E0DFDA]">
          {part.slice(1, -1)}
        </em>
      );
    }

    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  if (!content) return null;

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];

  let i = 0;
  let keyCounter = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Empty line
    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ``` (may be missing while streaming)
      blocks.push(
        <div
          key={keyCounter++}
          className="my-2.5 rounded-xl overflow-hidden border border-[#2E2E35] bg-[#141417]"
        >
          {lang && (
            <div className="px-3 py-1 bg-[#1C1C21] border-b border-[#2A2A30] text-[10px] font-mono uppercase tracking-wider text-[#9A9893]">
              {lang}
            </div>
          )}
          <pre className="p-3 text-[11px] font-mono text-[#E5E4E0] overflow-x-auto leading-relaxed">
            {codeLines.join('\n')}
          </pre>
        </div>
      );
      continue;
    }

    // Horizontal rule --- or ***
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(
        <hr key={keyCounter++} className="my-3 border-t border-[#2E2E35]" />
      );
      i++;
      continue;
    }

    // Headings #, ##, ###, ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // Strip redundant surrounding ** inside heading text if model outputs ### **Title**
      const cleanHeading = headingMatch[2].replace(/^\*\*(.*)\*\*$/, '$1').trim();
      const sizeClass =
        level === 1
          ? 'text-sm font-bold text-white mt-3 mb-1.5'
          : level === 2
          ? 'text-[13px] font-bold text-white mt-3 mb-1'
          : 'text-xs font-semibold text-[#F4F3EF] mt-2.5 mb-1';

      blocks.push(
        <div key={keyCounter++} className={`${sizeClass} tracking-tight`}>
          {renderInline(cleanHeading)}
        </div>
      );
      i++;
      continue;
    }

    // Blockquote >
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={keyCounter++}
          className="my-2 pl-3 border-l-2 border-[#D97757] text-[#CFCEC8] italic text-xs space-y-1"
        >
          {quoteLines.map((ql, idx) => (
            <p key={idx}>{renderInline(ql)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list (-, *, •)
    if (/^([-*•])\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^([-*•])\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*•])\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={keyCounter++} className="my-1.5 space-y-1.5 pl-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-xs text-[#DFDED9] leading-relaxed">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D97757] mt-1.5 shrink-0" />
              <div className="flex-1 min-w-0">{renderInline(item)}</div>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list (1., 2., etc.)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: { num: string; text: string }[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^(\d+)\.\s+(.*)$/);
        if (m) {
          items.push({ num: m[1], text: m[2] });
        }
        i++;
      }
      blocks.push(
        <ol key={keyCounter++} className="my-1.5 space-y-1.5 pl-0.5">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-xs text-[#DFDED9] leading-relaxed">
              <span className="text-[11px] font-semibold text-[#D97757] mt-0.5 shrink-0 min-w-[16px]">
                {item.num}.
              </span>
              <div className="flex-1 min-w-0">{renderInline(item.text)}</div>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Standard paragraph — ALWAYS consume the current line first so we can never get stuck
    // (e.g. a half-streamed "#" or "##" line that isn't yet a valid heading).
    const paraLines: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('>') &&
      !/^([-*•]|\d+\.)\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }

    blocks.push(
      <p key={keyCounter++} className="text-xs text-[#E2E1DC] leading-relaxed my-1.5">
        {renderInline(paraLines.join(' '))}
      </p>
    );
  }

  return <div className="space-y-1 break-words">{blocks}</div>;
};

