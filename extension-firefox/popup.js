const api = globalThis.browser;
const captureButton = document.querySelector("#capture");
const captureLabel = document.querySelector("#capture-label");
const status = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const progressBar = document.querySelector("#progress-bar");
const formatMark = document.querySelector("#format-mark");
const companion = document.querySelector(".companion");
const nativeLabel = document.querySelector("#native-label");
const folderButton = document.querySelector("#open-app");
const extensionVersion = document.querySelector("#extension-version");
const resolutionInputs = [...document.querySelectorAll('input[name="resolution"]')];

const FORMATS = {
  "4k": { id: "4k", label: "4K" },
  "8k": { id: "8k", label: "8K" }
};

let selectedFormatId = "8k";
let currentState = "ready";
let nativeConnected = false;

extensionVersion.textContent = `Capture8K ${api.runtime.getManifest().version}`;

function renderPrimaryAction() {
  captureLabel.textContent = `Capturer en ${FORMATS[selectedFormatId].label}`;
}

function selectFormat(formatId, persist = false) {
  const format = FORMATS[formatId] || FORMATS["8k"];
  selectedFormatId = format.id;
  for (const input of resolutionInputs) input.checked = input.value === format.id;
  formatMark.textContent = format.label;
  renderPrimaryAction();
  if (persist) api.runtime.sendMessage({ type: "capture8k-set-format", formatId: format.id }).catch(() => undefined);
}

function renderNativeStatus(payload = {}) {
  nativeConnected = payload.connected === true;
  companion.className = `companion ${nativeConnected ? "connected" : "error"}`;
  nativeLabel.textContent = nativeConnected ? "Prêt" : "App indisponible";
  companion.title = payload.outputDirectory || payload.error || "";
  captureButton.disabled = currentState === "working" || !nativeConnected;
}

function renderState(payload = {}) {
  currentState = payload.state || "ready";
  if (payload.formatId && FORMATS[payload.formatId]) selectFormat(payload.formatId);
  status.className = `status ${currentState}`;
  statusText.textContent = currentState === "done" && payload.width && payload.height
    ? `Enregistré · ${payload.width} × ${payload.height}`
    : (payload.message || (currentState === "ready" ? "Prêt" : "Capture impossible"));
  progressBar.style.width = `${Math.max(0, Math.min(1, payload.progress || 0)) * 100}%`;
  const busy = currentState === "working";
  captureButton.disabled = busy || !nativeConnected;
  for (const input of resolutionInputs) input.disabled = busy;
}

const sessionStore = api.storage.session || api.storage.local;
Promise.all([
  api.storage.local.get("captureResolution"),
  sessionStore.get("capture8kState")
]).then(([{ captureResolution }, { capture8kState }]) => {
  selectFormat(captureResolution);
  if (capture8kState) renderState(capture8kState);
});

api.runtime.sendMessage({ type: "capture8k-native-status" })
  .then(renderNativeStatus)
  .catch(() => renderNativeStatus({ connected: false }));

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture8k-status") renderState(message);
});

folderButton.addEventListener("click", () => {
  api.runtime.sendMessage({ type: "capture8k-choose-folder" })
    .then((result) => {
      if (!result?.ok) renderState({ state: "error", message: result?.error || "Impossible d’ouvrir le dossier.", progress: 0 });
    })
    .catch((error) => renderState({ state: "error", message: error?.message || "Impossible d’ouvrir le dossier.", progress: 0 }));
});

for (const input of resolutionInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || currentState === "working") return;
    selectFormat(input.value, true);
    renderState({
      state: "ready",
      formatId: input.value,
      message: `Prêt à capturer la page visible en ${FORMATS[input.value].label}.`,
      progress: 0
    });
  });
}

captureButton.addEventListener("click", async () => {
  const format = FORMATS[selectedFormatId];
  renderState({
    state: "working",
    formatId: format.id,
    message: `Rendu Firefox natif ${format.label}…`,
    progress: 0.04
  });
  try {
    const result = await api.runtime.sendMessage({ type: "capture8k-start", formatId: format.id });
    if (!result?.ok) renderState({ state: "error", message: result?.error || "La capture a échoué.", progress: 0 });
  } catch (error) {
    renderState({ state: "error", message: error?.message || "La capture a échoué.", progress: 0 });
  }
});
