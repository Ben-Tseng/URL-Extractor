const api = typeof browser !== "undefined" ? browser : chrome;
const SETTINGS_KEY = "extractorSettings";

const startMarkerInput = document.getElementById("startMarker");
const endMarkerInput = document.getElementById("endMarker");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

init();

async function init() {
  const data = await api.storage.sync.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};

  startMarkerInput.value = typeof saved.startMarker === "string" ? saved.startMarker : "";
  endMarkerInput.value = typeof saved.endMarker === "string" ? saved.endMarker : "";
}

saveBtn.addEventListener("click", async () => {
  const settings = {
    startMarker: startMarkerInput.value || "",
    endMarker: endMarkerInput.value || ""
  };

  await api.storage.sync.set({ [SETTINGS_KEY]: settings });
  statusEl.textContent = "Saved";

  window.setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
});
