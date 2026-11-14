import type {
  AgentAction,
  ActionExecutionLog,
  DistilledElement,
  PageSnapshot,
} from '../types/agent';

const AGENT_ATTR = 'data-any-agent-id';

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    parseFloat(style.opacity) === 0
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

function cleanText(str: string | null | undefined, maxLen = 110): string {
  if (!str) return '';
  const cleaned = str.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
}

function extractReadablePageContent(maxChars = 4200): string {
  // Prefer semantic main/article containers if present
  const root =
    document.querySelector('main, article, [role="main"], #content, .content') ||
    document.body;

  if (!root) return '';

  const blocks: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      if (
        ['script', 'style', 'noscript', 'svg', 'path', 'nav', 'footer'].includes(
          tag
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!isVisible(el)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (
        ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'pre', 'td', 'th', 'section', 'article'].includes(
          tag
        )
      ) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });

  const seen = new Set<string>();
  let totalLen = 0;

  let current = walker.nextNode() as HTMLElement | null;
  while (current && totalLen < maxChars) {
    const tag = current.tagName.toLowerCase();
    // Skip large container tags if they have many block children to avoid duplicate text
    if (
      (tag === 'section' || tag === 'article' || tag === 'li') &&
      current.querySelectorAll('p, h1, h2, h3, li').length > 2
    ) {
      current = walker.nextNode() as HTMLElement | null;
      continue;
    }

    const raw = (current.innerText || '').replace(/\s+/g, ' ').trim();
    if (raw.length >= 15 && !seen.has(raw)) {
      seen.add(raw);
      const prefix = /^h[1-4]$/.test(tag) ? `# ` : tag === 'li' ? `• ` : '';
      const line = `${prefix}${raw}`;
      blocks.push(line);
      totalLen += line.length + 1;
    }
    current = walker.nextNode() as HTMLElement | null;
  }

  // Fallback to body.innerText if structured walk found very little (e.g. SPA div soup)
  if (totalLen < 200 && document.body?.innerText) {
    return document.body.innerText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2)
      .join('\n')
      .slice(0, maxChars);
  }

  return blocks.join('\n').slice(0, maxChars);
}

function humanizeIdentifier(raw: string | null | undefined): string {
  if (!raw) return '';
  // Turn "user[twitter_username]" or "social_links_twitter" into "twitter username" / "social links twitter"
  return raw
    .replace(/^user\[|\]$/g, ' ')
    .replace(/[\[\]_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveLabel(el: HTMLElement): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && cleanText(ariaLabel)) return cleanText(ariaLabel);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || '')
      .join(' ');
    if (cleanText(labelText)) return cleanText(labelText);
  }

  if (el.id) {
    try {
      const explicitLabel = document.querySelector(
        `label[for="${CSS.escape(el.id)}"]`
      ) as HTMLElement | null;
      if (explicitLabel && cleanText(explicitLabel.innerText)) {
        return cleanText(explicitLabel.innerText);
      }
    } catch {
      // ignore selector escape error
    }
  }

  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    if (cleanText(clone.innerText)) return cleanText(clone.innerText);
  }

  // Walk up 1 to 3 ancestor levels to find a nearby <label> or field title (handles input-group wrappers like Devpost's @ prefix)
  let ancestor: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 3 && ancestor; depth++) {
    const directLabel = ancestor.querySelector('label, legend, .field-label, .form-label') as HTMLElement | null;
    if (directLabel && !directLabel.contains(el) && cleanText(directLabel.innerText)) {
      const txt = cleanText(directLabel.innerText);
      if (txt.length > 1 && txt !== '@') return txt;
    }
    const prev = ancestor.previousElementSibling as HTMLElement | null;
    if (prev && cleanText(prev.innerText)) {
      const txt = cleanText(prev.innerText);
      if (txt.length > 1 && txt.length < 70 && txt !== '@') return txt;
    }
    ancestor = ancestor.parentElement;
  }

  const container = el.closest(
    '[role="listitem"], [role="group"], fieldset, .form-group, .field, [data-params]'
  ) as HTMLElement | null;
  if (container) {
    const headingOrLabel = container.querySelector(
      'legend, label, [role="heading"], h1, h2, h3, h4, .question-title'
    ) as HTMLElement | null;
    if (headingOrLabel && cleanText(headingOrLabel.innerText)) {
      return cleanText(headingOrLabel.innerText);
    }
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && cleanText(placeholder)) return cleanText(placeholder);

  const name = humanizeIdentifier(el.getAttribute('name'));
  if (name && cleanText(name)) return cleanText(name);

  const humanizedId = humanizeIdentifier(el.id);
  if (humanizedId && cleanText(humanizedId)) return cleanText(humanizedId);

  const title = el.getAttribute('title');
  if (title && cleanText(title)) return cleanText(title);

  return cleanText(el.innerText);
}

export function distillPage(): PageSnapshot {
  document.querySelectorAll(`[${AGENT_ATTR}]`).forEach((el) => {
    el.removeAttribute(AGENT_ATTR);
  });

  const formFieldSelectors = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"])',
    'textarea',
    'select',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[contenteditable="true"]',
  ].join(', ');

  const actionSelectors = [
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    '[role="button"]',
    'a[href]',
  ].join(', ');

  // Prioritize form fields FIRST so they get low IDs ([1], [2], ...) and are never crowded out by nav links!
  const formNodes = Array.from(document.querySelectorAll<HTMLElement>(formFieldSelectors));
  const actionNodes = Array.from(document.querySelectorAll<HTMLElement>(actionSelectors));
  const seenNodes = new Set<HTMLElement>();
  const rawNodes: HTMLElement[] = [];

  for (const n of [...formNodes, ...actionNodes]) {
    if (!seenNodes.has(n)) {
      seenNodes.add(n);
      rawNodes.push(n);
    }
  }

  const elements: DistilledElement[] = [];
  let nextId = 1;

  for (const el of rawNodes) {
    if (elements.length >= 90) break;
    if (!isVisible(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || undefined;

    if (tag === 'a' && role !== 'button') {
      const text = cleanText(el.innerText, 60);
      if (!text || text.length < 2) continue;
      // Skip noisy header/footer links if we already have form fields on the page
      if (formNodes.length > 2 && el.closest('nav, footer, header')) continue;
      if (elements.length > 55) continue;
    }

    const label = resolveLabel(el);
    const attrHint = humanizeIdentifier(el.getAttribute('name') || el.id);
    const combinedLabel =
      label && attrHint && !label.toLowerCase().includes(attrHint.toLowerCase()) && label.length < 25
        ? `${label} (${attrHint})`
        : label || attrHint;
    const placeholder = cleanText(el.getAttribute('placeholder'), 60) || undefined;
    const text = cleanText(el.innerText || (el as HTMLInputElement).value, 65) || undefined;

    if ((tag === 'button' || tag === 'a' || role === 'button') && !combinedLabel && !text) {
      continue;
    }

    const id = nextId++;
    el.setAttribute(AGENT_ATTR, String(id));

    const item: DistilledElement = {
      id,
      tag,
      label: combinedLabel || text || `${tag}`,
    };

    if (type) item.type = type;
    if (role) item.role = role;
    if (placeholder && placeholder !== item.label) item.placeholder = placeholder;
    if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') {
      item.required = true;
    }
    if (tag === 'a') {
      const href = (el as HTMLAnchorElement).href;
      if (href && !href.startsWith('javascript:')) {
        item.href = cleanText(href, 90);
      }
    }

    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement;
      if (type === 'checkbox' || type === 'radio') {
        item.checked = inputEl.checked;
        if (inputEl.value && inputEl.value !== 'on') {
          item.value = cleanText(inputEl.value, 40);
        }
      } else {
        item.value = cleanText(inputEl.value, 80);
      }
    } else if (tag === 'select') {
      const selectEl = el as HTMLSelectElement;
      item.value = cleanText(selectEl.options[selectEl.selectedIndex]?.text || selectEl.value, 60);
      item.options = Array.from(selectEl.options)
        .map((o) => cleanText(o.text, 45))
        .filter(Boolean)
        .slice(0, 15);
    } else if (el.getAttribute('contenteditable') === 'true' || role === 'textbox') {
      item.value = cleanText(el.innerText, 80);
    } else if (role === 'checkbox' || role === 'radio') {
      item.checked = el.getAttribute('aria-checked') === 'true';
    } else if (text && text !== item.label) {
      item.text = text;
    }

    elements.push(item);
  }

  const lines = elements.map((el) => {
    const tagDesc = el.type ? `${el.tag}:${el.type}` : el.role ? `${el.tag}[role=${el.role}]` : el.tag;
    const parts: string[] = [`[${el.id}] <${tagDesc}>`];
    if (el.label) parts.push(`label="${el.label}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.required) parts.push(`REQUIRED`);
    if (typeof el.checked === 'boolean') parts.push(`checked=${el.checked}`);
    if (el.value !== undefined && el.value !== '') parts.push(`current="${el.value}"`);
    if (el.href) parts.push(`href="${el.href}"`);
    if (el.options && el.options.length > 0) {
      parts.push(`options=[${el.options.map((o) => `"${o}"`).join(', ')}]`);
    }
    return parts.join(' | ');
  });

  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((h) => cleanText((h as HTMLElement).innerText, 90))
    .filter(Boolean)
    .slice(0, 10);

  const metaDescription =
    document
      .querySelector<HTMLMetaElement>('meta[name="description"], meta[property="og:description"]')
      ?.content?.trim() || '';

  const selectedText = window.getSelection()?.toString()?.trim().slice(0, 1500) || '';
  const readableText = extractReadablePageContent(4200);

  return {
    url: window.location.href,
    title: document.title,
    metaDescription,
    selectedText,
    headings,
    readableText,
    elements,
    compactText: lines.join('\n'),
  };
}

function highlightElement(el: HTMLElement, color = '#D97757') {
  const prevOutline = el.style.outline;
  const prevTransition = el.style.transition;
  const prevBoxShadow = el.style.boxShadow;

  el.style.transition = 'all 0.25s ease';
  el.style.outline = `2px solid ${color}`;
  el.style.boxShadow = `0 0 0 4px rgba(217, 119, 87, 0.25)`;

  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.boxShadow = prevBoxShadow;
    el.style.transition = prevTransition;
  }, 2200);
}

function isFillableElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(type);
  }
  return (
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('role') === 'textbox'
  );
}

function findBestFillableFieldByHint(hint: string): HTMLElement | null {
  const tokens = hint
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .match(/[a-z0-9]{2,}/g)
    ?.filter((w) => !['fill', 'the', 'in', 'my', 'with', 'field', 'input', 'box', 'section', 'social', 'please'].includes(w)) || [];

  if (tokens.length === 0) return null;

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, [contenteditable="true"], [role="textbox"]'
    )
  ).filter(isVisible);

  let bestEl: HTMLElement | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const haystack = [
      resolveLabel(c),
      humanizeIdentifier(c.getAttribute('name')),
      humanizeIdentifier(c.id),
      c.getAttribute('placeholder') || '',
    ]
      .join(' ')
      .toLowerCase();

    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEl = c;
    }
  }

  return bestScore > 0 ? bestEl : null;
}

function normalizeValueForField(el: HTMLElement, rawVal: string, label: string): string {
  const trimmed = rawVal.trim();
  const fieldContext = `${label} ${el.getAttribute('name') || ''} ${el.id || ''}`.toLowerCase();
  const inputType = (el.getAttribute('type') || 'text').toLowerCase();

  // Check if the field has an "@" prefix right next to it (like Devpost's GitHub & Twitter fields)
  const parentText = (el.parentElement?.innerText || '') + ' ' + (el.previousElementSibling?.textContent || '');
  const hasAtPrefix = parentText.includes('@');

  // If this is a username/handle field (not a URL field) and the model passed a full URL, extract the handle!
  if (
    inputType !== 'url' &&
    (hasAtPrefix || /\b(twitter|github|username|handle)\b/.test(fieldContext)) &&
    !/\b(linkedin|website|portfolio|url)\b/.test(fieldContext)
  ) {
    const urlMatch = trimmed.match(/(?:x\.com|twitter\.com|github\.com)\/(@?[A-Za-z0-9_.-]+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].replace(/^@/, '');
    }
    if (hasAtPrefix && trimmed.startsWith('@')) {
      return trimmed.slice(1);
    }
  }

  return trimmed;
}

function setNativeValue(el: HTMLElement, value: string) {
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const prototype =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) {
      valueSetter.call(el, value);
    } else {
      el.value = value;
    }
  } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
    el.innerText = value;
  }

  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  el.blur();
}

export async function executeActions(
  actions: AgentAction[],
  options: { highlight: boolean; safeSubmitMode: boolean }
): Promise<{ logs: ActionExecutionLog[]; pausedForSubmit: boolean }> {
  const logs: ActionExecutionLog[] = [];
  let pausedForSubmit = false;

  for (const act of actions) {
    if (act.action === 'done') {
      logs.push({
        action: act,
        success: true,
        message: act.reason || 'Task completed.',
      });
      continue;
    }

    if (act.action === 'navigate') {
      const targetUrl = String(act.value || '').trim();
      if (targetUrl) {
        window.location.href = targetUrl;
        logs.push({
          action: act,
          success: true,
          message: `Navigated to ${targetUrl}`,
        });
      }
      continue;
    }

    if (act.action === 'scroll') {
      const dir = String(act.value || 'down').toLowerCase();
      window.scrollBy({
        top: dir === 'up' ? -550 : 550,
        behavior: 'smooth',
      });
      logs.push({
        action: act,
        success: true,
        message: `Scrolled ${dir}`,
      });
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    let el =
      act.id !== undefined && act.id !== null
        ? document.querySelector<HTMLElement>(`[${AGENT_ATTR}="${act.id}"]`)
        : null;

    // Smart self-healing for "fill": if the model picked a link/button ID (or wrong ID) instead of an input field,
    // automatically resolve the intended input field using the action's label/reason/value hint!
    if (act.action === 'fill' && !isFillableElement(el)) {
      const hint = [act.label, act.reason, String(act.value || '')].filter(Boolean).join(' ');
      const fallbackInput = findBestFillableFieldByHint(hint);
      if (fallbackInput) {
        el = fallbackInput;
      }
    }

    if (!el) {
      logs.push({
        action: act,
        success: false,
        message: `Element [${act.id ?? '?'}] not found on page.`,
      });
      continue;
    }

    const label = resolveLabel(el) || el.tagName.toLowerCase();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (options.highlight) {
      highlightElement(el);
    }

    try {
      if (act.action === 'fill') {
        if (!isFillableElement(el)) {
          logs.push({
            action: act,
            label,
            success: false,
            message: `Skipped filling "${label}" because it is a <${el.tagName.toLowerCase()}> (not a text input).`,
          });
          continue;
        }
        const rawVal = String(act.value ?? '');
        const val = normalizeValueForField(el, rawVal, label);
        setNativeValue(el, val);
        logs.push({
          action: act,
          label,
          success: true,
          message: `Filled "${label}" with "${val}"`,
        });
      } else if (act.action === 'select') {
        const targetVal = String(act.value ?? '').toLowerCase().trim();
        if (el instanceof HTMLSelectElement) {
          const matchedOption = Array.from(el.options).find(
            (opt) =>
              opt.text.toLowerCase().trim() === targetVal ||
              opt.value.toLowerCase().trim() === targetVal ||
              opt.text.toLowerCase().includes(targetVal)
          );
          if (matchedOption) {
            el.value = matchedOption.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            logs.push({
              action: act,
              label,
              success: true,
              message: `Selected "${matchedOption.text}" in "${label}"`,
            });
          } else {
            logs.push({
              action: act,
              label,
              success: false,
              message: `Option "${act.value}" not found in "${label}"`,
            });
          }
        } else {
          el.click();
          logs.push({
            action: act,
            label,
            success: true,
            message: `Opened custom dropdown "${label}"`,
          });
        }
      } else if (act.action === 'check') {
        const desired =
          act.value === undefined
            ? true
            : String(act.value).toLowerCase() !== 'false';
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          if (el.checked !== desired) {
            el.click();
          }
        } else {
          el.click();
        }
        logs.push({
          action: act,
          label,
          success: true,
          message: `Checked "${label}"`,
        });
      } else if (act.action === 'click') {
        const isSubmitButton =
          (el as HTMLButtonElement).type === 'submit' ||
          /\b(submit|apply now|send application|finish|complete registration)\b/i.test(
            `${label} ${el.innerText}`
          );

        if (options.safeSubmitMode && isSubmitButton) {
          highlightElement(el, '#10B981');
          pausedForSubmit = true;
          logs.push({
            action: act,
            label,
            success: true,
            message: `Paused before clicking final submit button "${label}" (Safe Submit Mode ON).`,
          });
          continue;
        }

        el.click();
        logs.push({
          action: act,
          label,
          success: true,
          message: `Clicked "${label}"`,
        });
      }
    } catch (err: any) {
      logs.push({
        action: act,
        label,
        success: false,
        message: `Error on "${label}": ${err?.message || String(err)}`,
      });
    }

    await new Promise((r) => setTimeout(r, 180));
  }

  return { logs, pausedForSubmit };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ pong: true });
    return false;
  }

  if (message?.type === 'GET_SCROLL_METRICS') {
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const scrollHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      viewportHeight
    );
    sendResponse({
      ok: true,
      scrollTop,
      viewportHeight,
      scrollHeight,
    });
    return false;
  }

  if (message?.type === 'SCROLL_TO_Y') {
    window.scrollTo({ top: Number(message.y || 0), behavior: 'instant' as ScrollBehavior });
    sendResponse({
      ok: true,
      scrollTop: window.scrollY || document.documentElement.scrollTop || 0,
    });
    return false;
  }

  if (message?.type === 'DISTILL_DOM') {
    try {
      const snapshot = distillPage();
      sendResponse({ ok: true, snapshot });
    } catch (err: any) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  }

  if (message?.type === 'EXECUTE_ACTIONS') {
    executeActions(message.actions || [], {
      highlight: message.highlight ?? true,
      safeSubmitMode: message.safeSubmitMode ?? true,
    })
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err: any) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
});
