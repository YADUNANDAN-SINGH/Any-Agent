// Background Service Worker for Any Agent

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set sidePanel behavior:', error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('Any Agent local browser extension installed.');
});

/**
 * Waits for a tab navigation to finish.
 *
 * IMPORTANT: a naive "is tab.status === 'complete'?" check right after chrome.tabs.update()
 * races with the navigation start and happily returns the OLD page. Instead we listen for the
 * 'loading' event first and only resolve after the following 'complete'. If no navigation
 * starts within `startGraceMs` (e.g. a click that did nothing, or a same-page hash change),
 * we resolve early.
 */
function settleTab(
  tabId: number,
  opts: { startGraceMs: number; timeoutMs: number; afterMs?: number }
): Promise<void> {
  return new Promise((resolve) => {
    let sawLoading = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      // Give SPAs a moment to hydrate before the content script reads the DOM
      setTimeout(resolve, opts.afterMs ?? 700);
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') {
        sawLoading = true;
        if (graceTimer) clearTimeout(graceTimer);
      }
      if (info.status === 'complete' && sawLoading) finish();
    };

    chrome.tabs.onUpdated.addListener(listener);
    // A click inside the page may have started loading before we got here
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'loading') {
          sawLoading = true;
          if (graceTimer) clearTimeout(graceTimer);
        }
      })
      .catch(() => finish());
    graceTimer = setTimeout(() => {
      if (!sawLoading) finish();
    }, opts.startGraceMs);
    hardTimer = setTimeout(finish, opts.timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }
        const url = tab.url || tab.pendingUrl || '';
        if (
          !url ||
          url.startsWith('chrome://') ||
          url.startsWith('edge://') ||
          url.startsWith('about:') ||
          url.startsWith('chrome-extension://') ||
          url.startsWith('chrome-search://') ||
          url.startsWith('https://chrome.google.com/webstore') ||
          url.startsWith('https://chromewebstore.google.com')
        ) {
          sendResponse({
            ok: false,
            restricted: true,
            tabId: tab.id,
            title: tab.title || 'Browser Tab',
            url,
            error: 'DOM access restricted on this page.',
          });
          return;
        }

        try {
          const pingResp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
          if (pingResp?.pong) {
            sendResponse({ ok: true, tabId: tab.id, title: tab.title, url });
            return;
          }
        } catch {
          // Content script not yet loaded in this tab; inject it dynamically
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
          sendResponse({ ok: true, tabId: tab.id, title: tab.title, url });
        } catch (injectErr: any) {
          sendResponse({
            ok: false,
            tabId: tab.id,
            title: tab.title || '',
            url,
            error: injectErr?.message || 'Could not inject content script.',
          });
        }
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // Navigate the active tab to a URL and wait until the NEW page has finished loading
  if (message?.type === 'NAVIGATE_ACTIVE_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }
        const targetUrl = String(message.url || '').trim();
        // Register the listener BEFORE starting navigation so we never miss the 'loading' event
        const settled = settleTab(tab.id, { startGraceMs: 5000, timeoutMs: 20000 });
        await chrome.tabs.update(tab.id, { url: targetUrl });
        await settled;
        const updatedTab = await chrome.tabs.get(tab.id).catch(() => tab);
        sendResponse({
          ok: true,
          tabId: tab.id,
          url: updatedTab.url || targetUrl,
          title: updatedTab.title || '',
        });
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // Navigate back in browser history on the active tab
  if (message?.type === 'GO_BACK_ACTIVE_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }
        const settled = settleTab(tab.id, { startGraceMs: 2500, timeoutMs: 12000 });
        await chrome.tabs.goBack(tab.id);
        await settled;
        sendResponse({ ok: true, tabId: tab.id });
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // After a click / Enter: if it started a navigation, wait for it; otherwise return quickly
  if (message?.type === 'WAIT_FOR_TAB_SETTLE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id) {
          await settleTab(tab.id, {
            startGraceMs: Number(message.graceMs || 900),
            timeoutMs: Number(message.timeoutMs || 15000),
          });
        }
      } catch {
        // ignore
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Capture a screenshot of the currently visible viewport
  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.windowId) {
          sendResponse({ ok: false, error: 'No active browser window found.' });
          return;
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 75,
        });
        sendResponse({
          ok: true,
          dataUrl,
          title: tab.title || 'Captured Tab',
          url: tab.url || '',
        });
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
});
