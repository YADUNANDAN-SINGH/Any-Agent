// Background Service Worker for Any Agent

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set sidePanel behavior:', error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('Any Agent local browser extension installed.');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
          sendResponse({ ok: false, error: 'No active tab found.' });
          return;
        }
        if (
          tab.url.startsWith('chrome://') ||
          tab.url.startsWith('edge://') ||
          tab.url.startsWith('about:') ||
          tab.url.startsWith('chrome-extension://')
        ) {
          sendResponse({
            ok: false,
            restricted: true,
            tabId: tab.id,
            title: tab.title || 'Browser Tab',
            url: tab.url,
            error: 'DOM access restricted on this page.',
          });
          return;
        }

        try {
          const pingResp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
          if (pingResp?.pong) {
            sendResponse({ ok: true, tabId: tab.id, title: tab.title, url: tab.url });
            return;
          }
        } catch {
          // Content script not yet loaded in this tab; inject it dynamically
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
          sendResponse({ ok: true, tabId: tab.id, title: tab.title, url: tab.url });
        }
      } catch (err: any) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // Capture a screenshot of the currently visible viewport
  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
