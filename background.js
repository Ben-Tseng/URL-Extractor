const MENU_ID = "extract-urls-from-selection";
const SETTINGS_KEY = "extractorSettings";
const LIST_STORAGE_PREFIX = "urlList:";
const PICK_TWO_STORAGE_PREFIX = "pickTwo:";

chrome.runtime.onInstalled.addListener(() => {
  createOrRefreshContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  createOrRefreshContextMenu();
});

function createOrRefreshContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Extract and Open URL(s) from Selection",
      contexts: ["selection"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  const selectionText = info.selectionText || "";
  if (!selectionText.trim()) {
    return;
  }

  const settings = await getSettings();
  const urls = extractUrls(selectionText, settings);

  if (urls.length === 0) {
    return;
  }

  if (urls.length === 1) {
    chrome.tabs.create({ url: urls[0] });
    return;
  }

  if (urls.length === 2) {
    const tabId = tab && typeof tab.id === "number" ? tab.id : null;
    if (tabId !== null) {
      try {
        await showTwoUrlPickerOnPage(tabId, urls);
        return;
      } catch {
        // Fall back to extension popup window if page injection is unavailable.
      }
    }

    const pickId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await chrome.storage.session.set({
      [`${PICK_TWO_STORAGE_PREFIX}${pickId}`]: urls
    });

    const pickUrl = chrome.runtime.getURL(`choose-two.html?id=${encodeURIComponent(pickId)}`);
    chrome.windows.create({
      url: pickUrl,
      type: "popup",
      width: 420,
      height: 260
    });
    return;
  }

  const listId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.session.set({
    [`${LIST_STORAGE_PREFIX}${listId}`]: urls
  });

  const popupUrl = chrome.runtime.getURL(`url-list.html?id=${encodeURIComponent(listId)}`);
  chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: 560,
    height: 640
  });
});

async function getSettings() {
  const data = await chrome.storage.sync.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};

  return {
    startMarker: typeof saved.startMarker === "string" ? saved.startMarker : "",
    endMarker: typeof saved.endMarker === "string" ? saved.endMarker : ""
  };
}

async function showTwoUrlPickerOnPage(tabId, urls) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [urls],
    func: (pickedUrls) => {
      const old = document.getElementById("__url_picker_two_overlay");
      if (old) {
        old.remove();
      }

      const overlay = document.createElement("div");
      overlay.id = "__url_picker_two_overlay";
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
      title.style.marginBottom = "8px";
      overlay.appendChild(title);

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
        btn.addEventListener("click", () => {
          window.open(url, "_blank", "noopener");
          overlay.remove();
        });
        overlay.appendChild(btn);
      });

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";

      const openBothBtn = document.createElement("button");
      openBothBtn.type = "button";
      openBothBtn.textContent = "Open Both";
      openBothBtn.style.flex = "1";
      openBothBtn.style.padding = "7px 8px";
      openBothBtn.style.border = "1px solid #111111";
      openBothBtn.style.borderRadius = "10px";
      openBothBtn.style.background = "#111111";
      openBothBtn.style.color = "#ffffff";
      openBothBtn.style.fontSize = "12px";
      openBothBtn.style.cursor = "pointer";
      openBothBtn.addEventListener("click", () => {
        pickedUrls.forEach((url) => window.open(url, "_blank", "noopener"));
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

      row.appendChild(openBothBtn);
      row.appendChild(closeBtn);
      overlay.appendChild(row);

      document.documentElement.appendChild(overlay);
    }
  });
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
