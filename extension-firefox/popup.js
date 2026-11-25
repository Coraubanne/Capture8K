const api = globalThis.browser;
const captureButton = document.querySelector("#capture");
const captureLabel = document.querySelector("#capture-label");
const status = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const progressBar = document.querySelector("#progress-bar");
const formatMark = document.querySelector("#format-mark");
const companion = document.querySelector(".companion");
const nativeLabel = document.querySelector("#native-label");
const settingsToggle = document.querySelector("#settings-toggle");
const captureView = document.querySelector("#capture-view");
const settingsView = document.querySelector("#settings-view");
const destination = document.querySelector("#destination");
const destinationDetail = document.querySelector("#destination-detail");
const checkUpdate = document.querySelector("#check-update");
const updateStatus = document.querySelector("#update-status");
const extensionVersion = document.querySelector("#extension-version");
const resolutionInputs = [...document.querySelectorAll('input[name="resolution"]')];

const FORMATS = {
  "4k": { id: "4k", label: "4K" },
  "8k": { id: "8k", label: "8K" }
};

let selectedFormatId = "8k";
let currentState = "ready";
let nativeConnected = false;
let outputMode = "downloads";
let outputDirectory = "";
let settingsVisible = false;
let availableUpdate = null;

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
  outputMode = ["downloads", "custom", "premiere"].includes(payload.outputMode) ? payload.outputMode : "downloads";
  outputDirectory = payload.outputDirectory || "";
  destination.value = outputMode;
  destinationDetail.textContent = outputMode === "premiere"
    ? "Creator Bridge · ajout au projet Premiere Pro actif."
    : (outputMode === "custom" ? outputDirectory : "Dossier Capture8K dans Téléchargements");
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

settingsToggle.addEventListener("click", () => {
  settingsVisible = !settingsVisible;
  captureView.hidden = settingsVisible;
  settingsView.hidden = !settingsVisible;
  settingsToggle.classList.toggle("active", settingsVisible);
});

destination.addEventListener("change", async () => {
  const requestedMode = destination.value;
  destination.disabled = true;
  try {
    const result = await api.runtime.sendMessage({ type: "capture8k-set-destination", outputMode: requestedMode });
    if (!result?.ok) throw new Error(result?.error || "Impossible de modifier l’enregistrement.");
    renderNativeStatus({ ...result.settings, connected: true });
  } catch (error) {
    destination.value = outputMode;
    updateStatus.textContent = error.message;
  } finally { destination.disabled = false; }
});

checkUpdate.addEventListener("click", async () => {
  checkUpdate.disabled = true;
  updateStatus.textContent = availableUpdate
    ? "Téléchargement, vérification et installation…"
    : "Vérification sécurisée de la release GitHub…";
  try {
    const result = await api.runtime.sendMessage(availableUpdate ? {
      type: "capture8k-install-update",
      version: availableUpdate.latestVersion,
      archiveURL: availableUpdate.archiveURL,
      checksumURL: availableUpdate.checksumURL
    } : { type: "capture8k-check-update" });
    if (!result?.ok) throw new Error(result?.error || "La vérification a échoué.");
    if (result.installed) {
      availableUpdate = null;
      updateStatus.textContent = "Mise à jour installée · rechargez les extensions et Premiere Pro.";
      checkUpdate.textContent = "Mise à jour terminée";
    } else {
      availableUpdate = result.updateAvailable ? result : null;
      updateStatus.textContent = result.updateAvailable
        ? `Capture8K ${result.latestVersion} est disponible.`
        : `Capture8K ${result.currentVersion} est à jour.`;
      checkUpdate.textContent = result.updateAvailable ? "Installer la mise à jour" : "Chercher une mise à jour";
    }
  } catch (error) { updateStatus.textContent = error.message; }
  finally { checkUpdate.disabled = false; }
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
