const api = typeof browser !== "undefined" ? browser : chrome;

function sendMessageCompat(message, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") {
      resolve(false);
      return;
    }

    try {
      const maybePromise = api.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise
          .then((resp) => resolve(Boolean(resp && resp.ok === true)))
          .catch(() => resolve(false));
        return;
      }
    } catch {
      // Fall back to callback-style sendMessage.
    }

    const timer =
      typeof setTimeout === "function" ? setTimeout(() => resolve(false), timeoutMs) : null;

    try {
      api.runtime.sendMessage(message, (resp) => {
        if (timer) {
          clearTimeout(timer);
        }
        const runtimeError = api.runtime && "lastError" in api.runtime ? api.runtime.lastError : null;
        if (runtimeError || !resp || resp.ok !== true) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch {
      if (timer) {
        clearTimeout(timer);
      }
      resolve(false);
    }
  });
}

function openUrlsSafely(urls) {
  const list = Array.isArray(urls)
    ? [...new Set(urls.filter((u) => typeof u === "string" && u.trim()))]
    : [];

  if (!list.length) {
    return Promise.resolve(false);
  }

  return sendMessageCompat({ type: "open-urls", urls: list }).then((openedByBackground) => {
    if (openedByBackground) {
      return true;
    }

    // Local fallback for pages where messaging is unavailable.
    if (typeof window !== "undefined" && typeof window.open === "function") {
      list.forEach((url, index) => {
        setTimeout(() => {
          try {
            window.open(url, "_blank", "noopener");
          } catch {
            // Ignore fallback popup errors.
          }
        }, index * 120);
      });
    }

    return false;
  });
}

const MENU_ID = "extract-urls-from-selection";
const SETTINGS_KEY = "extractorSettings";

api.runtime.onInstalled.addListener(() => {
  createOrRefreshContextMenu();
});

api.runtime.onStartup.addListener(() => {
  createOrRefreshContextMenu();
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "open-urls") {
    const urls = Array.isArray(message.urls)
      ? [...new Set(message.urls.filter((u) => typeof u === "string" && u.trim()))]
      : [];

    let opened = 0;
    urls.forEach((url, index) => {
      api.tabs.create({ url, active: index === 0 }, () => {});
      opened += 1;
    });
    sendResponse({ ok: true, opened });
    return;
  }
});

function createOrRefreshContextMenu() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: MENU_ID,
      title: "Extract and Open URL(s) from Selection",
      contexts: ["selection", "editable", "page"]
    });
  });
}

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  const tabId = await resolveTabId(tab);

  let selectionText = info.selectionText || "";
  if (!selectionText.trim() && tabId !== null) {
    selectionText = await extractSelectionFromPage(tabId);
  }

  if (!selectionText.trim()) {
    return;
  }

  const settings = await getSettings();
  const urls = extractUrls(selectionText, settings);

  if (urls.length === 0) {
    return;
  }

  if (urls.length === 1) {
    api.tabs.create({ url: urls[0] });
    return;
  }

  if (tabId === null) return;

  try {
    await showUrlPickerOnPage(tabId, urls);
  } catch {
    // Some pages (e.g. browser internal pages) cannot be injected.
  }
});

async function getSettings() {
  const data = await api.storage.sync.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};

  return {
    startMarker: typeof saved.startMarker === "string" ? saved.startMarker : "",
    endMarker: typeof saved.endMarker === "string" ? saved.endMarker : ""
  };
}

async function resolveTabId(tab) {
  if (tab && typeof tab.id === "number") {
    return tab.id;
  }

  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (Array.isArray(tabs) && tabs[0] && typeof tabs[0].id === "number") {
      return tabs[0].id;
    }
  } catch {
    return null;
  }

  return null;
}

async function extractSelectionFromPage(tabId) {
  const pickSelection = () => {
    const getDeepActiveElement = (root) => {
      let current = root && root.activeElement ? root.activeElement : null;
      while (current && current.shadowRoot && current.shadowRoot.activeElement) {
        current = current.shadowRoot.activeElement;
      }
      return current;
    };

    const pickFromElement = (el) => {
      if (!el) return "";

      if (
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          /^(text|search|url|tel|password|email)$/i.test(el.type || "text"))
      ) {
        const start = typeof el.selectionStart === "number" ? el.selectionStart : 0;
        const end = typeof el.selectionEnd === "number" ? el.selectionEnd : 0;
        if (end > start) {
          return el.value.slice(start, end);
        }
      }

      if (el.isContentEditable) {
        const s = window.getSelection();
        return s ? String(s) : "";
      }

      return "";
    };

    const deepActive = getDeepActiveElement(document);
    const fromActive = pickFromElement(deepActive);
    if (fromActive) {
      return fromActive;
    }

    const s = window.getSelection();
    return s ? String(s) : "";
  };

  try {
    if (api.scripting && typeof api.scripting.executeScript === "function") {
      const results = await api.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: pickSelection
      });
      return Array.isArray(results) && results[0] && typeof results[0].result === "string"
        ? results[0].result
        : "";
    }

    if (api.tabs && typeof api.tabs.executeScript === "function") {
      const code = `(${pickSelection.toString()})();`;
      const results = await api.tabs.executeScript(tabId, { code });
      return Array.isArray(results) && typeof results[0] === "string" ? results[0] : "";
    }
  } catch {
    return "";
  }

  return "";
}

async function showUrlPickerOnPage(tabId, urls) {
  const renderOverlay = (pickedUrls) => {
    const extApi =
      typeof browser !== "undefined"
        ? browser
        : typeof chrome !== "undefined"
          ? chrome
          : null;

    const sendOpenRequest = (urlsToOpen) => {
      return new Promise((resolve) => {
        if (
          extApi &&
          extApi.runtime &&
          typeof extApi.runtime.sendMessage === "function"
        ) {
          const payload = { type: "open-urls", urls: urlsToOpen };

          // Firefox-style Promise API
          try {
            const maybePromise = extApi.runtime.sendMessage(payload);
            if (maybePromise && typeof maybePromise.then === "function") {
              maybePromise
                .then((resp) => resolve(Boolean(resp && resp.ok === true)))
                .catch(() => resolve(false));
              return;
            }
          } catch {
            // Fall back to callback-style API below.
          }

          // Chrome callback API
          const timeoutId = window.setTimeout(() => resolve(false), 800);
          extApi.runtime.sendMessage(payload, (resp) => {
            window.clearTimeout(timeoutId);
            const runtimeError =
              extApi.runtime && "lastError" in extApi.runtime ? extApi.runtime.lastError : null;
            if (runtimeError || !resp || resp.ok !== true) {
              resolve(false);
              return;
            }
            resolve(true);
          });
          return;
        }
        resolve(false);
      }).catch(() => false);
    };

    const fallbackOpen = (urlsToOpen) => {
      urlsToOpen.forEach((url, index) => {
        window.setTimeout(() => {
          window.open(url, "_blank", "noopener");
        }, index * 120);
      });
    };

    const safeOpen = async (urlsToOpen) => {
      try {
        const sent = await sendOpenRequest(urlsToOpen);
        if (!sent) {
          fallbackOpen(urlsToOpen);
        }
      } catch {
        // Ignore and fallback to window.open.
        fallbackOpen(urlsToOpen);
      }
    };

    const old = document.getElementById("__url_picker_overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "__url_picker_overlay";
    overlay.style.position = "fixed";
    overlay.style.top = "16px";
    overlay.style.right = "16px";
    overlay.style.zIndex = "2147483647";
    overlay.style.width = "360px";
    overlay.style.maxWidth = "calc(100vw - 24px)";
    overlay.style.background = "#ffffff";
    overlay.style.color = "#111111";
    overlay.style.border = "1px solid #dcdcdc";
    overlay.style.borderRadius = "12px";
    overlay.style.padding = "12px";
    overlay.style.boxShadow = "0 8px 26px rgba(0,0,0,0.12)";
    overlay.style.fontFamily = "SF Pro Text, PingFang SC, Helvetica Neue, sans-serif";

    const title = document.createElement("div");
    title.textContent = "Choose a URL to open";
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    title.style.marginBottom = "4px";
    overlay.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.textContent = `${pickedUrls.length} URL(s) found`;
    subtitle.style.fontSize = "11px";
    subtitle.style.color = "#6b6b6b";
    subtitle.style.marginBottom = "8px";
    overlay.appendChild(subtitle);

    const listWrap = document.createElement("div");
    listWrap.style.maxHeight = "280px";
    listWrap.style.overflowY = "auto";
    listWrap.style.marginBottom = "8px";

    pickedUrls.forEach((url) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = url;
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.style.marginBottom = "8px";
      btn.style.padding = "8px";
      btn.style.border = "1px solid #e3e3e3";
      btn.style.borderRadius = "10px";
      btn.style.background = "#ffffff";
      btn.style.color = "#111111";
      btn.style.fontSize = "12px";
      btn.style.lineHeight = "1.35";
      btn.style.wordBreak = "break-all";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", async () => {
        await safeOpen([url]);
        overlay.remove();
      });
      listWrap.appendChild(btn);
    });
    overlay.appendChild(listWrap);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";

    const openAllBtn = document.createElement("button");
    openAllBtn.type = "button";
    openAllBtn.textContent = "Open All";
    openAllBtn.style.flex = "1";
    openAllBtn.style.padding = "7px 8px";
    openAllBtn.style.border = "1px solid #111111";
    openAllBtn.style.borderRadius = "10px";
    openAllBtn.style.background = "#111111";
    openAllBtn.style.color = "#ffffff";
    openAllBtn.style.fontSize = "12px";
    openAllBtn.style.cursor = "pointer";
    openAllBtn.addEventListener("click", async () => {
      await safeOpen(pickedUrls);
      overlay.remove();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.style.flex = "1";
    closeBtn.style.padding = "7px 8px";
    closeBtn.style.border = "1px solid #d9d9d9";
    closeBtn.style.borderRadius = "10px";
    closeBtn.style.background = "#ffffff";
    closeBtn.style.color = "#111111";
    closeBtn.style.fontSize = "12px";
    closeBtn.style.cursor = "pointer";
    closeBtn.addEventListener("click", () => overlay.remove());

    row.appendChild(openAllBtn);
    row.appendChild(closeBtn);
    overlay.appendChild(row);

    document.documentElement.appendChild(overlay);
  };

  if (api.scripting && typeof api.scripting.executeScript === "function") {
    await api.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [urls],
      func: renderOverlay
    });
    return;
  }

  if (api.tabs && typeof api.tabs.executeScript === "function") {
    const code = `(${renderOverlay.toString()})(${JSON.stringify(urls)});`;
    await api.tabs.executeScript(tabId, { code });
    return;
  }

  throw new Error("No supported script injection API available.");
}

function extractUrls(text, settings) {
  const startMarker = settings.startMarker || "";
  const endMarker = settings.endMarker || "";

  let matches = [];

  if (!startMarker && !endMarker) {
    matches = extractByRegex(text);
  } else {
    matches = extractByMarkers(text, startMarker, endMarker);
  }

  const normalized = matches
    .map(normalizeUrl)
    .filter(Boolean);

  return [...new Set(normalized)];
}

function extractByRegex(text) {
  const pattern = /(https?:\/\/[^\s<>'"`]+|www\.[^\s<>'"`]+)/gi;
  const result = [];
  let m;

  while ((m = pattern.exec(text)) !== null) {
    result.push(m[0]);
  }

  return result;
}

function extractByMarkers(text, startMarker, endMarker) {
  const result = [];
  let cursor = 0;

  while (cursor < text.length) {
    let startIndex = cursor;

    if (startMarker) {
      startIndex = text.indexOf(startMarker, cursor);
      if (startIndex === -1) {
        break;
      }
      startIndex += startMarker.length;
    }

    if (startIndex >= text.length) {
      break;
    }

    let endIndex = -1;

    if (endMarker) {
      endIndex = text.indexOf(endMarker, startIndex);
      if (endIndex === -1) {
        break;
      }
    } else {
      const tail = text.slice(startIndex);
      const token = tail.match(/^\S+/);
      if (!token) {
        cursor = startIndex + 1;
        continue;
      }
      endIndex = startIndex + token[0].length;
    }

    const candidate = text.slice(startIndex, endIndex).trim();
    if (candidate) {
      result.push(candidate);
    }

    cursor = endMarker ? endIndex + endMarker.length : endIndex;
  }

  return result;
}

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!url) {
    return null;
  }

  url = url.replace(/^[\(\[<"'`]+/, "");
  url = url.replace(/[\)\]>"'`,;.!?]+$/, "");

  if (!url) {
    return null;
  }

  if (!/^https?:\/\//i.test(url)) {
    if (/^www\./i.test(url)) {
      url = `https://${url}`;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(url);
    return parsed.href;
  } catch {
    return null;
  }
}
