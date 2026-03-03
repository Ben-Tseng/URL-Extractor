const api = typeof browser !== "undefined" ? browser : chrome;
const LIST_STORAGE_PREFIX = "urlList:";

const listEl = document.getElementById("list");
const metaEl = document.getElementById("meta");
const openAllBtn = document.getElementById("openAllBtn");
const closeBtn = document.getElementById("closeBtn");

init();

async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    metaEl.textContent = "Invalid parameter: URL list not found.";
    return;
  }

  const key = `${LIST_STORAGE_PREFIX}${id}`;
  const data = await api.storage.session.get(key);
  const urls = Array.isArray(data[key]) ? data[key] : [];

  if (!urls.length) {
    metaEl.textContent = "No URLs available.";
    return;
  }

  metaEl.textContent = `${urls.length} URL(s) found. Click one to open it.`;

  urls.forEach((url) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    li.appendChild(a);
    listEl.appendChild(li);
  });

  openAllBtn.addEventListener("click", () => {
    urls.forEach((url) => api.tabs.create({ url }));
  });

  closeBtn.addEventListener("click", () => {
    window.close();
  });

  api.storage.session.remove(key);
}
