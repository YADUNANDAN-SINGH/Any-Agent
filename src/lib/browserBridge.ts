import type {
  ActionExecutionLog,
  AgentAction,
  AgentSettings,
  PageSnapshot,
  SearchResult,
} from '../types/agent';

type SearchEngine = AgentSettings['searchEngine'];

const MOCK_SNAPSHOT: PageSnapshot = {
  url: 'https://example.com',
  title: 'Example Webpage',
  metaDescription: 'Example page description',
  selectedText: '',
  headings: ['Welcome to Example'],
  readableText: '# Welcome to Example\nThis is a sample webpage preview.',
  elements: [
    { id: 1, tag: 'a', label: 'Learn more', href: 'https://example.com/about' },
  ],
  compactText: '[1] <a> | label="Learn more"',
};

export async function captureSingleViewportScreenshot(): Promise<{
  dataUrl: string;
  title: string;
  url: string;
}> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    throw new Error('Screenshot capture requires running inside Chrome Extension.');
  }
  const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
  if (!resp?.ok || !resp.dataUrl) {
    throw new Error(resp?.error || 'Failed to capture visible tab screenshot.');
  }
  return {
    dataUrl: resp.dataUrl,
    title: resp.title || 'Captured Tab',
    url: resp.url || '',
  };
}

/**
 * Captures as many scrolled viewport screenshots as needed (up to maxScreenshots)
 * to cover the page when DOM extraction is empty/blocked or when requested.
 */
export async function captureMultiPageScreenshots(
  tabId: number | null,
  maxScreenshots = 4
): Promise<{ screenshots: string[]; title: string; url: string }> {
  const screenshots: string[] = [];
  let pageTitle = 'Captured Page';
  let pageUrl = '';

  // If we have a valid content-script tabId, we can scroll down systematically to capture the full page
  if (tabId && tabId > 0) {
    try {
      const metrics = await chrome.tabs.sendMessage(tabId, {
        type: 'GET_SCROLL_METRICS',
      });

      if (metrics?.ok) {
        const originalScrollTop: number = metrics.scrollTop || 0;
        const viewportHeight: number = metrics.viewportHeight || 800;
        const scrollHeight: number = metrics.scrollHeight || viewportHeight;

        const totalRequired = Math.min(
          maxScreenshots,
          Math.max(1, Math.ceil(scrollHeight / (viewportHeight * 0.88)))
        );

        for (let i = 0; i < totalRequired; i++) {
          const targetY = i * Math.floor(viewportHeight * 0.88);
          await chrome.tabs.sendMessage(tabId, {
            type: 'SCROLL_TO_Y',
            y: targetY,
          });
          // Wait briefly for repaint and lazy-loaded visuals
          await new Promise((r) => setTimeout(r, 260));

          const shot = await captureSingleViewportScreenshot();
          pageTitle = shot.title;
          pageUrl = shot.url;
          screenshots.push(shot.dataUrl);
        }

        // Restore original scroll position
        await chrome.tabs.sendMessage(tabId, {
          type: 'SCROLL_TO_Y',
          y: originalScrollTop,
        });

        return { screenshots, title: pageTitle, url: pageUrl };
      }
    } catch {
      // Fall through to single viewport capture if scrolling script isn't available (e.g. PDF viewer)
    }
  }

  // Fallback: capture current visible viewport directly
  const singleShot = await captureSingleViewportScreenshot();
  return {
    screenshots: [singleShot.dataUrl],
    title: singleShot.title,
    url: singleShot.url,
  };
}

export async function getActivePageSnapshot(options?: {
  forceScreenshots?: boolean;
  autoScreenshotFallback?: boolean;
  maxScreenshots?: number;
}): Promise<PageSnapshot> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return MOCK_SNAPSHOT;
  }

  const maxScreenshots = options?.maxScreenshots ?? 4;
  const autoFallback = options?.autoScreenshotFallback ?? true;

  let tabId: number | null = null;
  let domSnapshot: PageSnapshot | null = null;

  try {
    const ensureResp = await chrome.runtime.sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
    });

    // New tab / chrome:// pages can't be read or screenshotted. That's fine: the agent can still
    // answer from uploaded documents, or navigate somewhere else.
    if (ensureResp?.restricted) {
      return emptySnapshot(ensureResp.url || '', ensureResp.title || 'New Tab', { restricted: true });
    }

    if (ensureResp?.ok && typeof ensureResp.tabId === 'number') {
      const okTabId: number = ensureResp.tabId;
      tabId = okTabId;
      const distResp = await chrome.tabs.sendMessage(okTabId, {
        type: 'DISTILL_DOM',
      });
      if (distResp?.ok && distResp.snapshot) {
        domSnapshot = distResp.snapshot as PageSnapshot;
      }
    }
  } catch {
    // DOM script failed (e.g., PDF viewer, canvas app, or restricted frame)
  }

  const isDomEmptyOrSparse =
    !domSnapshot ||
    (domSnapshot.readableText.trim().length < 80 &&
      domSnapshot.elements.length <= 2);

  if (options?.forceScreenshots || (autoFallback && isDomEmptyOrSparse)) {
    try {
      const captured = await captureMultiPageScreenshots(tabId, maxScreenshots);
      if (domSnapshot) {
        return {
          ...domSnapshot,
          screenshots: captured.screenshots,
          usedScreenshotFallback: true,
        };
      }
      return {
        url: captured.url,
        title: captured.title,
        metaDescription: '',
        selectedText: '',
        headings: [],
        readableText: '',
        elements: [],
        compactText: '',
        screenshots: captured.screenshots,
        usedScreenshotFallback: true,
      };
    } catch {
      if (domSnapshot) return domSnapshot;
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      return emptySnapshot(tab?.url || '', tab?.title || 'Unreadable page', { restricted: true });
    }
  }

  if (domSnapshot) return domSnapshot;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return emptySnapshot(tab?.url || '', tab?.title || 'Unreadable page', { restricted: true });
}

function emptySnapshot(url: string, title: string, extra: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    title,
    metaDescription: '',
    selectedText: '',
    headings: [],
    readableText: '',
    elements: [],
    compactText: '',
    ...extra,
  };
}

const SEARCH_URLS: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

export function buildSearchUrl(query: string, engine: SearchEngine = 'google'): string {
  return `${SEARCH_URLS[engine] || SEARCH_URLS.google}${encodeURIComponent(query.trim())}`;
}

/** Turns whatever the model wrote ("example.com", "https://..", "best laptops 2026") into a URL. */
export function resolveNavigationTarget(raw: string, engine: SearchEngine = 'google'): string {
  const value = raw.trim().replace(/^["'<]+|["'>.,;]+$/g, '');
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  // Looks like a bare domain: no spaces and a dot followed by a TLD
  if (!/\s/.test(value) && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value)) {
    return `https://${value}`;
  }
  return buildSearchUrl(value, engine);
}

export async function executeActionsOnActiveTab(
  actions: AgentAction[],
  options: {
    highlight: boolean;
    safeSubmitMode: boolean;
    searchEngine?: SearchEngine;
    searchResults?: SearchResult[];
  }
): Promise<{ logs: ActionExecutionLog[]; pausedForSubmit: boolean }> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return {
      pausedForSubmit: false,
      logs: actions.map((a) => ({
        action: a,
        success: true,
        message: `[Preview] ${a.action} on [${a.id ?? '-'}]: ${String(a.value ?? '')}`,
      })),
    };
  }

  const allLogs: ActionExecutionLog[] = [];
  let pausedForSubmit = false;
  const domBatch: AgentAction[] = [];

  const flushDomBatch = async () => {
    if (domBatch.length === 0) return;
    const toRun = [...domBatch];
    domBatch.length = 0;

    const ensureResp = await chrome.runtime.sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
    });
    if (!ensureResp?.ok || typeof ensureResp.tabId !== 'number') {
      allLogs.push({
        action: toRun[0],
        success: false,
        message: ensureResp?.error || 'Unable to connect to active browser tab.',
      });
      return;
    }

    try {
      const resp = await chrome.tabs.sendMessage(ensureResp.tabId, {
        type: 'EXECUTE_ACTIONS',
        actions: toRun,
        highlight: options.highlight,
        safeSubmitMode: options.safeSubmitMode,
      });

      if (resp?.ok) {
        allLogs.push(...(resp.logs || []));
        if (resp.pausedForSubmit) pausedForSubmit = true;
      } else {
        allLogs.push({
          action: toRun[0],
          success: false,
          message: resp?.error || 'Action execution failed.',
        });
      }
    } catch {
      // Content script context may have unloaded right as a link click navigated the tab!
      await chrome.runtime.sendMessage({ type: 'WAIT_FOR_TAB_SETTLE', graceMs: 1200, timeoutMs: 15000 });
      allLogs.push({
        action: toRun[toRun.length - 1],
        success: true,
        message: 'Clicked element and navigated to new page.',
      });
    }
  };

  const navigateTo = async (act: AgentAction, targetUrl: string, okMessage: string) => {
    const navResp = await chrome.runtime.sendMessage({
      type: 'NAVIGATE_ACTIVE_TAB',
      url: targetUrl,
    });
    allLogs.push({
      action: act,
      success: Boolean(navResp?.ok),
      message: navResp?.ok
        ? okMessage
        : `Failed to open ${targetUrl}: ${navResp?.error || 'unknown error'}`,
    });
  };

  for (const act of actions) {
    if (act.action === 'navigate' || act.action === 'search_web') {
      await flushDomBatch();
      const rawVal = String(act.url || act.value || '').trim();
      if (!rawVal) {
        allLogs.push({ action: act, success: false, message: `${act.action} needs a URL or query.` });
        continue;
      }
      const targetUrl =
        act.action === 'search_web'
          ? buildSearchUrl(rawVal, options.searchEngine)
          : resolveNavigationTarget(rawVal, options.searchEngine);
      await navigateTo(
        act,
        targetUrl,
        act.action === 'search_web' ? `Searched the web for "${rawVal}"` : `Opened ${targetUrl}`
      );
      continue;
    }

    if (act.action === 'open_result') {
      await flushDomBatch();
      const results = options.searchResults || [];
      const raw = String(act.url || (act.value ?? act.id ?? '')).trim();
      const n = Number(raw.replace(/[^\d]/g, ''));
      const byIndex = Number.isInteger(n) && n >= 1 && n <= results.length ? results[n - 1] : undefined;
      const byUrl = /^https?:\/\//i.test(raw) ? { title: raw, url: raw } : undefined;
      const target = byUrl || byIndex;
      if (!target) {
        allLogs.push({
          action: act,
          success: false,
          message: `Search result "${raw}" not found (${results.length} results on page).`,
        });
        continue;
      }
      await navigateTo(act, target.url, `Opened result: ${target.title.slice(0, 80)}`);
      continue;
    }

    if (act.action === 'go_back') {
      await flushDomBatch();
      const backResp = await chrome.runtime.sendMessage({
        type: 'GO_BACK_ACTIVE_TAB',
      });
      allLogs.push({
        action: act,
        success: Boolean(backResp?.ok),
        message: backResp?.ok ? 'Navigated back to previous page' : 'Could not go back',
      });
      continue;
    }

    domBatch.push(act);
  }

  await flushDomBatch();

  // If any click action was executed, wait briefly in case the click triggered a page load
  if (actions.some((a) => a.action === 'click' || a.action === 'press_enter')) {
    await chrome.runtime.sendMessage({ type: 'WAIT_FOR_TAB_SETTLE', graceMs: 1200, timeoutMs: 15000 });
  }

  return {
    logs: allLogs,
    pausedForSubmit,
  };
}
