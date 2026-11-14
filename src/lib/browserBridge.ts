import type {
  ActionExecutionLog,
  AgentAction,
  PageSnapshot,
} from '../types/agent';

const MOCK_SNAPSHOT: PageSnapshot = {
  url: 'https://yadunandan-singh.pages.dev',
  title: 'Yadunandan Singh — AI / Machine-Learning Engineer',
  metaDescription: 'Portfolio and open-source work of Yadunandan Singh',
  selectedText: '',
  headings: ['Yadunandan Singh', 'AI / Machine-Learning Engineer'],
  readableText:
    '# Yadunandan Singh\n# AI / Machine-Learning Engineer\nI contribute to c2siorg DataLoom, mostly backend performance and data-layer work in pandas and FastAPI, and build ML systems from first principles to understand them.\n• 22 merged pull requests in c2siorg since June 2026',
  elements: [
    { id: 1, tag: 'a', label: 'Open-source record', href: 'https://github.com/...' },
    { id: 2, tag: 'a', label: 'Résumé' },
  ],
  compactText: [
    '[1] <a> | label="Open-source record"',
    '[2] <a> | label="Résumé"',
  ].join('\n'),
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
    } catch (shotErr: any) {
      if (domSnapshot) return domSnapshot;
      throw new Error(
        shotErr?.message ||
          'Could not read DOM or capture screenshots from this tab.'
      );
    }
  }

  return domSnapshot!;
}

export async function executeActionsOnActiveTab(
  actions: AgentAction[],
  options: { highlight: boolean; safeSubmitMode: boolean }
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

  const ensureResp = await chrome.runtime.sendMessage({
    type: 'ENSURE_CONTENT_SCRIPT',
  });
  if (!ensureResp?.ok || typeof ensureResp.tabId !== 'number') {
    throw new Error(ensureResp?.error || 'Unable to connect to active browser tab.');
  }

  const resp = await chrome.tabs.sendMessage(ensureResp.tabId, {
    type: 'EXECUTE_ACTIONS',
    actions,
    highlight: options.highlight,
    safeSubmitMode: options.safeSubmitMode,
  });

  if (!resp?.ok) {
    throw new Error(resp?.error || 'Failed to execute actions on page.');
  }

  return {
    logs: resp.logs || [],
    pausedForSubmit: Boolean(resp.pausedForSubmit),
  };
}
