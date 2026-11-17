import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { GeneratedPdfDoc, UploadedDocument } from '../types/agent';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_STORED_TEXT = 60000;
const MAX_PDF_PAGES_TEXT = 80;
const MAX_SCANNED_PAGES = 3;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log',
  'ini', 'toml', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'sql', 'css', 'tex', 'rtf',
]);

export const UPLOAD_ACCEPT =
  '.pdf,.docx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.go,.rs,.sql,.css,.tex,.png,.jpg,.jpeg,.webp,.gif';

/**
 * Extracts readable text from an uploaded File, 100% locally in the browser.
 * - PDF: pdf.js text layer; scanned/image-only PDFs are rendered to page images for the vision model
 * - DOCX / PPTX: proper ZIP central-directory reader + WordprocessingML / DrawingML text
 * - Images: downscaled JPEG data URL for the local vision model
 * - Everything else: UTF-8 text
 */
export async function parseUploadedFile(file: File): Promise<UploadedDocument> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`"${file.name}" is larger than 25 MB.`);
  }
  const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const mime = file.type || '';
  const base = { id, name: file.name, size: file.size, createdAt: Date.now() };

  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const dataUrl = await downscaleImageFile(file);
    return {
      ...base,
      mimeType: mime || `image/${ext}`,
      textContent: `[Image "${file.name}" is attached — inspect it visually.]`,
      imageDataUrl: dataUrl,
    };
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    const buffer = await file.arrayBuffer();
    const { text, pageCount, pageImages } = await extractPdf(buffer);
    return {
      ...base,
      mimeType: 'application/pdf',
      pageCount,
      pageImages: pageImages.length > 0 ? pageImages : undefined,
      textContent:
        text.trim() ||
        (pageImages.length > 0
          ? `[Scanned PDF "${file.name}" (${pageCount} pages) has no text layer. The first ${pageImages.length} page(s) are attached as images — read them visually.]`
          : `[Could not extract any text from "${file.name}". It may be encrypted or image-only.]`),
    };
  }

  if (ext === 'docx' || mime.includes('wordprocessingml')) {
    const text = await extractDocx(await file.arrayBuffer());
    return {
      ...base,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      textContent: text.trim() || `[Could not extract text from "${file.name}".]`,
    };
  }

  if (ext === 'pptx' || mime.includes('presentationml')) {
    const text = await extractPptx(await file.arrayBuffer());
    return {
      ...base,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      textContent: text.trim() || `[Could not extract text from "${file.name}".]`,
    };
  }

  if (['doc', 'ppt', 'xls', 'xlsx', 'pages', 'key', 'numbers', 'zip'].includes(ext)) {
    throw new Error(
      `"${file.name}" is not supported. Save it as PDF, DOCX, PPTX, TXT, Markdown or CSV and upload again.`
    );
  }

  const rawText = await file.text();
  const replacementChars = (rawText.slice(0, 4000).match(/�/g) || []).length;
  if (!TEXT_EXTENSIONS.has(ext) && !mime.startsWith('text/') && replacementChars > 20) {
    throw new Error(`"${file.name}" looks like a binary file and can't be read as text.`);
  }
  const clean =
    ext === 'html' || ext === 'htm'
      ? new DOMParser().parseFromString(rawText, 'text/html').body?.innerText || rawText
      : rawText;

  return {
    ...base,
    mimeType: mime || 'text/plain',
    textContent: clean.trim().slice(0, MAX_STORED_TEXT),
  };
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

/** Vision models choke on huge images; cap the long side at 1600px and re-encode as JPEG. */
async function downscaleImageFile(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return readFileAsDataUrl(file);
  }
}

// ---------------------------------------------------------------------------
// PDF reading (pdf.js)
// ---------------------------------------------------------------------------

async function extractPdf(
  buffer: ArrayBuffer
): Promise<{ text: string; pageCount: number; pageImages: string[] }> {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // extension CSP forbids eval
    useSystemFonts: true,
  }).promise;

  try {
    const pageCount = pdf.numPages;
    const pageTexts: string[] = [];
    for (let i = 1; i <= Math.min(pageCount, MAX_PDF_PAGES_TEXT); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        pageText += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pageText = pageText.replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (pageText) pageTexts.push(`--- Page ${i} ---\n${pageText}`);
      page.cleanup();
      if (pageTexts.join('\n').length > MAX_STORED_TEXT) break;
    }

    const text = pageTexts.join('\n\n').slice(0, MAX_STORED_TEXT);
    const pageImages: string[] = [];

    // Image-only (scanned) PDF: render the first pages so the vision model can read them
    const avgCharsPerPage = text.length / Math.max(1, Math.min(pageCount, MAX_PDF_PAGES_TEXT));
    if (avgCharsPerPage < 12) {
      for (let i = 1; i <= Math.min(pageCount, MAX_SCANNED_PAGES); i++) {
        const page = await pdf.getPage(i);
        const unscaled = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1400 / unscaled.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        pageImages.push(canvas.toDataURL('image/jpeg', 0.82));
        page.cleanup();
      }
    }

    return { text, pageCount, pageImages };
  } finally {
    void pdf.destroy();
  }
}

// ---------------------------------------------------------------------------
// ZIP reading (for DOCX / PPTX) via the central directory
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZipDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // End-of-central-directory record is within the last 64 KB + 22 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid Office file (ZIP directory missing).');

  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < entryCount && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipText(buffer: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const lh = entry.localHeaderOffset;
  const nameLen = view.getUint16(lh + 26, true);
  const extraLen = view.getUint16(lh + 28, true);
  const start = lh + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compressedSize);
  const raw = entry.method === 0 ? data : await inflateRaw(data);
  return new TextDecoder('utf-8').decode(raw);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractDocx(buffer: ArrayBuffer): Promise<string> {
  const entries = readZipDirectory(buffer);
  const main = entries.find((e) => e.name === 'word/document.xml');
  if (!main) throw new Error('This .docx has no word/document.xml.');
  const xml = await readZipText(buffer, main);

  const out: string[] = [];
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = paraRegex.exec(xml)) !== null) {
    const para = m[0];
    const runs = para
      .replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
      .replace(/<w:(br|cr)\/>/g, '<w:t>\n</w:t>');
    let text = '';
    const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRegex.exec(runs)) !== null) text += t[1];
    text = decodeXmlEntities(text).trim();
    if (!text) {
      out.push('');
      continue;
    }
    const heading = para.match(/<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/);
    const title = /<w:pStyle w:val="Title"/.test(para);
    if (title) text = `# ${text}`;
    else if (heading) text = `${'#'.repeat(Math.min(6, Number(heading[1]) + 1))} ${text}`;
    else if (/<w:numPr>/.test(para)) text = `- ${text}`;
    out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, MAX_STORED_TEXT);
}

async function extractPptx(buffer: ArrayBuffer): Promise<string> {
  const entries = readZipDirectory(buffer);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/(\d+)\.xml$/)![1]) - Number(b.name.match(/(\d+)\.xml$/)![1]));
  const out: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await readZipText(buffer, slides[i]);
    const paras: string[] = [];
    const pRegex = /<a:p>[\s\S]*?<\/a:p>/g;
    let m: RegExpExecArray | null;
    while ((m = pRegex.exec(xml)) !== null) {
      let line = '';
      const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRegex.exec(m[0])) !== null) line += t[1];
      line = decodeXmlEntities(line).trim();
      if (line) paras.push(line);
    }
    if (paras.length) out.push(`--- Slide ${i + 1} ---\n${paras.join('\n')}`);
  }
  return out.join('\n\n').slice(0, MAX_STORED_TEXT);
}

// ---------------------------------------------------------------------------
// PDF writing: Markdown -> multi-page PDF 1.4 (standard Helvetica/Courier fonts, WinAnsi encoding)
// ---------------------------------------------------------------------------

type FontKey = 'F1' | 'F2' | 'F3'; // Helvetica, Helvetica-Bold, Courier

// Glyph widths (1/1000 em) for ASCII 32..126 from the Adobe core-font AFM files
const HELVETICA_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_W = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
  '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
  '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const CHAR_FALLBACKS: Record<string, string> = {
  '→': '->', '←': '<-', '⇒': '=>', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '≥': '>=', '≤': '<=',
  '≠': '!=', '−': '-', '‐': '-', '‑': '-', ' ': ' ', ' ': ' ', '​': '', '·': '·',
  '▪': '•', '◦': '•', '●': '•', '○': 'o', '★': '*', '☆': '*',
};

/** Normalizes text to characters the standard PDF fonts can draw (WinAnsi). */
function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const mapped = CHAR_FALLBACKS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA[ch]) {
      out += ch;
    } else if (code === 0x09) {
      out += '    ';
    } else {
      // Strip accents where possible (e.g. ő -> o); otherwise drop emoji / unsupported scripts
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]$/.test(base) ? base : code > 0xffff ? '' : '?';
    }
  }
  return out;
}

function charWidth(ch: string, font: FontKey): number {
  if (font === 'F3') return 600;
  const code = ch.charCodeAt(0);
  const table = font === 'F2' ? HELVETICA_BOLD_W : HELVETICA_W;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (ch === '•') return 350;
  if (ch === '—' || ch === '…') return 1000;
  return 556;
}

function textWidth(text: string, font: FontKey, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, font);
  return (w * size) / 1000;
}

/** Encodes a WinAnsi-normalized string as a PDF literal string body (bytes as latin1 chars). */
function pdfLiteral(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = WIN_ANSI_EXTRA[ch] ?? ch.charCodeAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else out += String.fromCharCode(code & 0xff);
  }
  return out;
}

interface Run {
  text: string;
  font: FontKey;
}

interface LayoutLine {
  runs: Run[];
  size: number;
  leading: number;
  indent: number;
  extraBefore: number;
  gray?: boolean;
  rule?: boolean;
  /** Table row: each cell is drawn at its own x offset, possibly over several wrapped lines */
  cells?: { x: number; lines: Run[][] }[];
  lineGap?: number;
  ruleBelow?: boolean;
}

/** Splits inline Markdown into bold / code / plain runs. */
function parseInline(raw: string, baseFont: FontKey): Run[] {
  let text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[\s(])([*_])(?![*_\s])([^*_]+?)\2(?=[\s).,;:!?]|$)/g, '$1$3');
  text = toWinAnsi(text);

  const runs: Run[] = [];
  const regex = /(\*\*|__)(.+?)\1|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), font: baseFont });
    if (m[2] !== undefined) runs.push({ text: m[2], font: 'F2' });
    else runs.push({ text: m[3], font: 'F3' });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), font: baseFont });
  return runs.filter((r) => r.text.length > 0);
}

/** Greedy word-wrap of styled runs using real font metrics. */
function wrapRuns(runs: Run[], size: number, maxWidth: number): Run[][] {
  const tokens: Run[] = [];
  for (const r of runs) {
    for (const part of r.text.split(/(\s+)/)) {
      if (part) tokens.push({ text: /^\s+$/.test(part) ? ' ' : part, font: r.font });
    }
  }

  const lines: Run[][] = [];
  let current: Run[] = [];
  let width = 0;
  const pushToken = (tok: Run) => {
    const last = current[current.length - 1];
    if (last && last.font === tok.font) last.text += tok.text;
    else current.push({ ...tok });
    width += textWidth(tok.text, tok.font, size);
  };
  const breakLine = () => {
    const last = current[current.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, '');
    lines.push(current.filter((r) => r.text));
    current = [];
    width = 0;
  };

  for (const tok of tokens) {
    if (tok.text === ' ' && current.length === 0) continue;
    const w = textWidth(tok.text, tok.font, size);
    if (width + w <= maxWidth || tok.text === ' ') {
      pushToken(tok);
      continue;
    }
    if (current.length > 0) breakLine();
    // A single word wider than the line: hard-break it by characters
    if (w > maxWidth) {
      let chunk = '';
      for (const ch of tok.text) {
        if (textWidth(chunk + ch, tok.font, size) > maxWidth && chunk) {
          pushToken({ text: chunk, font: tok.font });
          breakLine();
          chunk = '';
        }
        chunk += ch;
      }
      if (chunk) pushToken({ text: chunk, font: tok.font });
    } else {
      pushToken(tok);
    }
  }
  if (current.length > 0) breakLine();
  return lines.length > 0 ? lines : [[]];
}

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN_X = 54;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

function layoutMarkdown(title: string, subtitle: string, markdown: string): LayoutLine[] {
  const out: LayoutLine[] = [];
  const addBlock = (
    runs: Run[],
    opts: { size: number; leading: number; indent?: number; extraBefore?: number; gray?: boolean; prefix?: Run }
  ) => {
    const indent = opts.indent || 0;
    const prefixW = opts.prefix ? textWidth(opts.prefix.text, opts.prefix.font, opts.size) : 0;
    const wrapped = wrapRuns(runs, opts.size, CONTENT_W - indent - prefixW);
    wrapped.forEach((lineRuns, idx) => {
      out.push({
        runs: idx === 0 && opts.prefix ? [opts.prefix, ...lineRuns] : lineRuns,
        size: opts.size,
        leading: opts.leading,
        indent: idx === 0 ? indent : indent + prefixW,
        extraBefore: idx === 0 ? opts.extraBefore || 0 : 0,
        gray: opts.gray,
      });
    });
  };

  let body = markdown.replace(/\r\n/g, '\n').trim();
  // Avoid printing the title twice when the document starts with the same H1
  const firstH1 = body.match(/^#\s+(.+)\n?/);
  if (firstH1 && title && firstH1[1].replace(/\*/g, '').trim().toLowerCase() === title.trim().toLowerCase()) {
    body = body.slice(firstH1[0].length);
  }

  if (title.trim()) {
    addBlock(parseInline(title.trim(), 'F2'), { size: 20, leading: 26 });
    if (subtitle) addBlock(parseInline(subtitle, 'F1'), { size: 9.5, leading: 14, gray: true });
    out.push({ runs: [], size: 10, leading: 14, indent: 0, extraBefore: 2, rule: true });
  }

  let inCode = false;
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const size = 9.5;
    const gap = 14;
    const colCount = Math.max(...tableRows.map((r) => r.length));
    const parsedRows = tableRows.map((r, ri) =>
      Array.from({ length: colCount }, (_, ci) => parseInline(r[ci] || '', ri === 0 ? 'F2' : 'F1'))
    );
    // Natural column widths, then shrink proportionally to fit the page
    const natural = Array.from({ length: colCount }, (_, ci) =>
      Math.max(
        24,
        ...parsedRows.map((cells) => cells[ci].reduce((w, run) => w + textWidth(run.text, run.font, size), 0))
      )
    );
    const available = CONTENT_W - 8 - gap * (colCount - 1);
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = total > available ? natural.map((w) => Math.max(36, (w / total) * available)) : natural;
    parsedRows.forEach((cells, ri) => {
      let x = 4;
      const laidOut = cells.map((runs, ci) => {
        const cell = { x, lines: runs.length ? wrapRuns(runs, size, widths[ci]) : [[]] };
        x += widths[ci] + gap;
        return cell;
      });
      out.push({
        runs: [],
        cells: laidOut,
        size,
        lineGap: 12.5,
        leading: 12.5 * Math.max(...laidOut.map((c) => c.lines.length)) + 4,
        indent: 0,
        extraBefore: ri === 0 ? 4 : 0,
        ruleBelow: ri === 0,
      });
    });
    out.push({ runs: [], size: 10, leading: 6, indent: 0, extraBefore: 0 });
    tableRows = [];
  };

  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (!/^\|.*\|$/.test(trimmed) || inCode) flushTable();

    if (/^(```|~~~)/.test(trimmed)) {
      inCode = !inCode;
      out.push({ runs: [], size: 9, leading: 6, indent: 0, extraBefore: 0 });
      continue;
    }
    if (inCode) {
      const codeRuns = [{ text: toWinAnsi(raw.replace(/\t/g, '    ')), font: 'F3' as FontKey }];
      for (const l of wrapRuns(codeRuns, 9, CONTENT_W - 12)) {
        out.push({ runs: l, size: 9, leading: 12, indent: 12, extraBefore: 0 });
      }
      continue;
    }

    if (!trimmed) {
      out.push({ runs: [], size: 10, leading: 7, indent: 0, extraBefore: 0 });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push({ runs: [], size: 10, leading: 14, indent: 0, extraBefore: 4, rule: true });
      continue;
    }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const size = level === 1 ? 16 : level === 2 ? 13.5 : level === 3 ? 12 : 11;
      addBlock(parseInline(h[2].replace(/\*\*/g, ''), 'F2'), {
        size,
        leading: size + 6,
        extraBefore: level <= 2 ? 10 : 6,
      });
      continue;
    }

    // Tables: collect rows, then lay them out in aligned columns (header row bold)
    if (/^\|.*\|$/.test(trimmed)) {
      if (!/^\|[\s:|-]+\|$/.test(trimmed)) {
        tableRows.push(trimmed.slice(1, -1).split('|').map((c) => c.trim()));
      }
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      addBlock(parseInline(quote[1], 'F1'), { size: 10.5, leading: 15, indent: 16, gray: true });
      continue;
    }

    const bullet = raw.match(/^(\s*)([-*+•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(4, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2));
      const isNumbered = /^\d/.test(bullet[2]);
      const checkbox = bullet[3].match(/^\[( |x|X)\]\s+(.*)$/);
      const itemText = checkbox ? checkbox[2] : bullet[3];
      const marker = checkbox
        ? checkbox[1] === ' ' ? '[ ]  ' : '[x]  '
        : isNumbered ? `${bullet[2].replace(')', '.')}  ` : depth % 2 === 0 ? '•  ' : '-  ';
      addBlock(parseInline(itemText, 'F1'), {
        size: 10.5,
        leading: 15,
        indent: 8 + depth * 14,
        extraBefore: 1,
        prefix: { text: marker, font: 'F1' },
      });
      continue;
    }

    addBlock(parseInline(trimmed, 'F1'), { size: 10.5, leading: 15.5 });
  }

  flushTable();
  return out;
}

/** Builds a valid multi-page PDF 1.4 file from a title + Markdown body. */
export function buildPdfBlob(doc: GeneratedPdfDoc): Blob {
  const subtitle =
    doc.subtitle ??
    `Generated by Any Agent · ${new Date(doc.createdAt || Date.now()).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })}`;
  const lines = layoutMarkdown(doc.title, subtitle, doc.markdownContent);

  const TOP_Y = PAGE_H - 60;
  const BOTTOM_Y = 60;
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = TOP_Y;

  for (const line of lines) {
    const needed = line.extraBefore + line.leading;
    if (y - needed < BOTTOM_Y && ops.length > 0) {
      pages.push(ops);
      ops = [];
      y = TOP_Y;
    }
    // Don't start a page with blank spacing
    if (y === TOP_Y && line.runs.length === 0 && !line.rule && !line.cells) continue;
    y -= line.extraBefore;

    if (line.rule) {
      const ry = y - line.leading / 2;
      ops.push(`0.8 G 0.6 w ${MARGIN_X} ${ry.toFixed(1)} m ${(PAGE_W - MARGIN_X).toFixed(1)} ${ry.toFixed(1)} l S 0 G`);
    } else if (line.cells) {
      for (const cell of line.cells) {
        cell.lines.forEach((runs, j) => {
          if (runs.length === 0) return;
          const baseline = y - line.size - j * (line.lineGap || line.leading);
          let op = `BT 1 0 0 1 ${(MARGIN_X + cell.x).toFixed(1)} ${baseline.toFixed(1)} Tm`;
          for (const r of runs) op += ` /${r.font} ${line.size} Tf (${pdfLiteral(r.text)}) Tj`;
          ops.push(op + ' ET');
        });
      }
      const ry = y - line.leading + 1;
      ops.push(
        `${line.ruleBelow ? '0.55' : '0.85'} G 0.5 w ${MARGIN_X} ${ry.toFixed(1)} m ${(PAGE_W - MARGIN_X).toFixed(1)} ${ry.toFixed(1)} l S 0 G`
      );
    } else if (line.runs.length > 0) {
      const baseline = y - line.size;
      let op = `BT ${line.gray ? '0.4 g ' : ''}1 0 0 1 ${(MARGIN_X + line.indent).toFixed(1)} ${baseline.toFixed(1)} Tm`;
      for (const r of line.runs) {
        op += ` /${r.font} ${line.size} Tf (${pdfLiteral(r.text)}) Tj`;
      }
      op += `${line.gray ? ' 0 g' : ''} ET`;
      ops.push(op);
    }
    y -= line.leading;
  }
  if (ops.length > 0 || pages.length === 0) pages.push(ops);

  const objects: string[] = [];
  const pageIds: number[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const infoTitle = pdfLiteral(toWinAnsi(doc.title || 'Document'));
  objects[6] = `<< /Title (${infoTitle}) /Producer (Any Agent) /Creator (Any Agent) >>`;

  let nextId = 7;
  pages.forEach((pageOps, idx) => {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const footer = `Page ${idx + 1} of ${pages.length}`;
    const footerX = (PAGE_W - textWidth(footer, 'F1', 8.5)) / 2;
    const stream = [...pageOps, `BT 0.5 g 1 0 0 1 ${footerX.toFixed(1)} 32 Tm /F1 8.5 Tf (${footer}) Tj 0 g ET`].join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  // Every character in the file is a single byte (latin1), so string length == byte offset
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

export function pdfFilenameFor(doc: Pick<GeneratedPdfDoc, 'filename' | 'title'>): string {
  const base = (doc.filename || doc.title || 'any-agent-document')
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'any-agent-document'}.pdf`;
}

/**
 * Builds the PDF and saves it. Uses chrome.downloads (reliable from the side panel, no user-gesture
 * requirement) and falls back to an <a download> click outside the extension.
 */
export async function downloadGeneratedPdf(doc: GeneratedPdfDoc): Promise<string> {
  const blob = buildPdfBlob(doc);
  const filename = pdfFilenameFor(doc);
  const url = URL.createObjectURL(blob);

  try {
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return filename;
    }
  } catch (err) {
    console.warn('[Any Agent] chrome.downloads failed, falling back to link download:', err);
  }

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return filename;
}

/** Opens the generated PDF in a new browser tab for preview. */
export function previewGeneratedPdf(doc: GeneratedPdfDoc): void {
  const url = URL.createObjectURL(buildPdfBlob(doc));
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    void chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank');
  }
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60000);
}
