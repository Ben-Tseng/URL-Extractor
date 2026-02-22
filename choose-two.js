const PICK_TWO_STORAGE_PREFIX = "pickTwo:";

const listEl = document.getElementById("list");
const openBothBtn = document.getElementById("openBothBtn");
const closeBtn = document.getElementById("closeBtn");

init();

async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    return;
  }

  const key = `${PICK_TWO_STORAGE_PREFIX}${id}`;
  const data = await chrome.storage.session.get(key);
  const urls = Array.isArray(data[key]) ? data[key] : [];

  if (urls.length !== 2) {
    return;
  }

  urls.forEach((url) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "url-btn";
    btn.textContent = url;
    btn.addEventListener("click", () => {
      chrome.tabs.create({ url });
      window.close();
    });
    listEl.appendChild(btn);
  });

  openBothBtn.addEventListener("click", () => {
    urls.forEach((url) => chrome.tabs.create({ url }));
    window.close();
  });

  closeBtn.addEventListener("click", () => {
    window.close();
  });

  chrome.storage.session.remove(key);
}
