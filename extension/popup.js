const api = globalThis.browser ?? globalThis.chrome;
const isFirefox = typeof api.runtime.getBrowserInfo === "function";
const manifestVersion = api.runtime.getManifest().version;
const captureButton = document.querySelector("#capture");
const captureLabel = document.querySelector("#capture-label");
const status = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const progressBar = document.querySelector("#progress-bar");
const diagnostic = document.querySelector("#capture-diagnostic");
const diagnosticText = document.querySelector("#capture-diagnostic-text");
const companion = document.querySelector(".companion");
const nativeLabel = document.querySelector("#native-label");
const settingsToggle = document.querySelector("#settings-toggle");
const captureView = document.querySelector("#capture-view");
const settingsView = document.querySelector("#settings-view");
const languageSelect = document.querySelector("#language");
const destination = document.querySelector("#destination");
const destinationDetail = document.querySelector("#destination-detail");
const completionSound = document.querySelector("#completion-sound");
const soundStatus = document.querySelector("#sound-status");
const checkUpdate = document.querySelector("#check-update");
const updateStatus = document.querySelector("#update-status");
const bridgeUpdateStatus = document.querySelector("#bridge-update-status");
const installBridgeUpdate = document.querySelector("#install-bridge-update");
const extensionVersion = document.querySelector("#extension-version");
const resolutionInputs = [...document.querySelectorAll('input[name="resolution"]')];

const formats = { "4k": "4K", "8k": "8K" };
let selectedFormat = "8k";
let language = "fr";
let captureState = { state: "ready" };
let nativeStatus = null;
let availableUpdate = null;
let updateFeedback = {};
let bridgeUpdate = null;
let bridgeFeedback = "";
let bridgeRequest = 0;
let destinationError = "";
let soundSaving = false;
let soundError = false;

function copy(key, values = {}) {
  return popupCopy[language][key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

function setLanguage(preference) {
  const choice = ["fr", "en"].includes(preference) ? preference : "auto";
  languageSelect.value = choice;
  const browserLanguage = api.i18n.getUILanguage();
  language = choice === "auto" ? (/^fr(?:-|$)/i.test(browserLanguage) ? "fr" : "en") : choice;
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll("[data-copy]")) node.textContent = copy(node.dataset.copy);
  for (const node of document.querySelectorAll("[data-label]")) node.setAttribute("aria-label", copy(node.dataset.label));
  extensionVersion.textContent = copy("extensionVersion", { version: manifestVersion });
  setSettingsOpen(!settingsView.hidden);
  renderCapture();
  renderDestination();
  renderCompletionSound();
  renderUpdate();
}

function isBusy() {
  return ["working", "selecting"].includes(captureState.state);
}

function needsChromeRestart() {
  return !isFirefox && nativeStatus?.connected === true && nativeStatus.browserCaptureModeReady !== true;
}

function localizedCaptureMessage() {
  const { state, key, message, width, height } = captureState;
  const format = formats[selectedFormat];
  if (key) return copy(key, { format });
  if (state === "done" && width && height) return `${copy("saved")} · ${width} × ${height}`;
  if (language === "fr" && message) return message;
  if (state === "error") {
    if (/pages? internes?|impossible de capturer cet onglet|\bchrome:\/\//i.test(message || "")) return copy("restrictedPage");
    if (/a changé|a bougé|ne correspond plus/i.test(message || "")) return copy("pageChanged");
    if (/certification refusée|contrôle de fidélité/i.test(message || "")) return copy("denied");
    return copy("captureError");
  }
  if (state === "working" || state === "selecting") {
    if (/enregistrement/i.test(message || "")) return copy("saving");
    if (/rerastérisation|peinture native/i.test(message || "")) return copy("rendering");
    if (/référence|témoin|contrôle/i.test(message || "")) return copy("reference");
    if (/stabilisation/i.test(message || "")) return copy("settling");
    return copy("capturing", { format });
  }
  return copy("ready");
}

function renderCapture() {
  const restart = needsChromeRestart();
  const connected = nativeStatus?.connected === true;
  captureLabel.textContent = restart ? copy("prepareChrome") : copy("capture", { format: formats[selectedFormat] });
  captureButton.disabled = isBusy() || !connected;
  companion.classList.toggle("connected", connected && !restart);
  companion.classList.toggle("error", Boolean(nativeStatus) && (!connected || restart));
  nativeLabel.textContent = copy(!nativeStatus ? "connecting" : !connected ? "unavailable" : restart ? "restart" : "ready");
  companion.title = nativeStatus?.outputDirectory || nativeStatus?.error || "";

  for (const input of resolutionInputs) {
    input.checked = input.value === selectedFormat;
    input.disabled = isBusy();
  }
  status.className = `status ${captureState.state}`;
  statusText.textContent = localizedCaptureMessage();
  const technical = captureState.technicalError || captureState.message;
  const showDiagnostic = captureState.state === "error" && technical && technical !== statusText.textContent;
  diagnostic.hidden = !showDiagnostic;
  if (!showDiagnostic) diagnostic.open = false;
  diagnosticText.textContent = showDiagnostic ? technical : "";
  progressBar.style.width = `${Math.max(0, Math.min(1, captureState.progress || 0)) * 100}%`;
}

function setCaptureState(payload) {
  captureState = { state: "ready", ...payload };
  if (formats[payload.formatId]) selectedFormat = payload.formatId;
  renderCapture();
}

function renderDestination() {
  const mode = nativeStatus?.outputMode;
  destination.value = ["custom", "premiere"].includes(mode) ? mode : "downloads";
  destinationDetail.textContent = destinationError
    ? (language === "fr" ? destinationError : copy("destinationError"))
    : mode === "premiere" ? copy("premiere") : mode === "custom" ? (nativeStatus?.outputDirectory || "") : "";
  destinationDetail.title = destinationError;
}

function setNativeStatus(payload) {
  if (nativeStatus?.outputMode !== payload?.outputMode) {
    bridgeRequest += 1;
    bridgeUpdate = null;
    bridgeFeedback = "";
  }
  nativeStatus = payload;
  renderCapture();
  renderDestination();
  renderCompletionSound();
  renderBridgeUpdate();
}

function renderCompletionSound() {
  completionSound.disabled = soundSaving || typeof nativeStatus?.completionSound !== "boolean";
  if (!soundSaving) completionSound.checked = nativeStatus?.completionSound !== false;
  soundStatus.textContent = soundError ? copy("soundError") : "";
}

function setSettingsOpen(open) {
  captureView.hidden = open;
  settingsView.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.setAttribute("aria-label", copy(open ? "closeSettings" : "openSettings"));
  settingsToggle.title = copy("settings");
}

function renderUpdate() {
  const { key, version, error } = updateFeedback;
  const buttonKey = key === "updateInstalled" ? "updateDone" : availableUpdate ? "installUpdate" : "checkUpdate";
  checkUpdate.textContent = copy(buttonKey);
  updateStatus.textContent = error && language === "fr" ? error : key ? copy(key, { version }) : "";
  updateStatus.title = error || "";
  renderBridgeUpdate();
}

function renderBridgeUpdate() {
  const premiere = nativeStatus?.outputMode === "premiere";
  installBridgeUpdate.hidden = !premiere || !bridgeUpdate;
  if (bridgeUpdate) installBridgeUpdate.textContent = copy("installBridge", { version: bridgeUpdate });
  bridgeUpdateStatus.hidden = !premiere || !bridgeFeedback;
  bridgeUpdateStatus.textContent = bridgeFeedback ? copy(bridgeFeedback) : "";
}

async function updateCreatorBridge(install = false) {
  if (nativeStatus?.outputMode !== "premiere") return;
  const version = bridgeUpdate;
  const request = ++bridgeRequest;
  bridgeUpdate = null;
  bridgeFeedback = install ? "installingUpdate" : "checkingUpdate";
  renderBridgeUpdate();
  try {
    const result = await api.runtime.sendMessage({
      type: install ? "capture8k-install-bridge-update" : "capture8k-check-bridge-update", version,
    });
    if (!result?.ok) throw new Error("Creator Bridge");
    if (request !== bridgeRequest) return;
    bridgeUpdate = result.available ? result.latestVersion : null;
    bridgeFeedback = install ? "bridgeInstalled" : "";
  } catch {
    if (request !== bridgeRequest) return;
    bridgeFeedback = install ? "bridgeInstallFailed" : "bridgeCheckFailed";
  }
  renderBridgeUpdate();
}

const sessionStore = api.storage.session || api.storage.local;
setLanguage("auto");
Promise.all([
  api.storage.local.get(["captureResolution", "captureLanguage"]),
  sessionStore.get("capture8kState")
]).then(([{ captureResolution, captureLanguage }, { capture8kState }]) => {
  if (formats[captureResolution]) selectedFormat = captureResolution;
  if (capture8kState) setCaptureState(capture8kState);
  setLanguage(captureLanguage);
});

api.runtime.sendMessage({ type: "capture8k-native-status" })
  .then(setNativeStatus)
  .catch(() => setNativeStatus({ connected: false }));
api.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture8k-status") setCaptureState(message);
});

settingsToggle.addEventListener("click", () => setSettingsOpen(settingsView.hidden));
languageSelect.addEventListener("change", () => {
  const preference = languageSelect.value;
  setLanguage(preference);
  api.storage.local.set({ captureLanguage: preference }).catch(() => undefined);
});

destination.addEventListener("change", async () => {
  const outputMode = destination.value;
  destination.disabled = true;
  destinationError = "";
  try {
    const result = await api.runtime.sendMessage({ type: "capture8k-set-destination", outputMode });
    if (!result?.ok) throw new Error(result?.error || copy("destinationError"));
    setNativeStatus({ ...result.settings, connected: true });
  } catch (error) {
    destinationError = error.message;
    renderDestination();
  } finally {
    destination.disabled = false;
  }
});

completionSound.addEventListener("change", async () => {
  const enabled = completionSound.checked;
  soundSaving = true;
  soundError = false;
  renderCompletionSound();
  try {
    const result = await api.runtime.sendMessage({ type: "capture8k-set-completion-sound", enabled });
    if (!result?.ok || result.enabled !== enabled) {
      soundError = true;
    } else {
      nativeStatus = { ...nativeStatus, completionSound: result.enabled };
    }
  } catch {
    soundError = true;
  } finally {
    soundSaving = false;
    renderCompletionSound();
  }
});

checkUpdate.addEventListener("click", async () => {
  const checking = !availableUpdate;
  checkUpdate.disabled = true;
  updateFeedback = { key: availableUpdate ? "installingUpdate" : "checkingUpdate" };
  renderUpdate();
  try {
    const result = await api.runtime.sendMessage(availableUpdate ? {
      type: "capture8k-install-update",
      version: availableUpdate.latestVersion,
      archiveURL: availableUpdate.archiveURL,
      checksumURL: availableUpdate.checksumURL
    } : { type: "capture8k-check-update" });
    if (!result?.ok) throw new Error(result?.error || copy("updateError"));
    availableUpdate = result.updateAvailable ? result : null;
    updateFeedback = result.installed ? { key: "updateInstalled" } : {
      key: result.updateAvailable ? "updateAvailable" : "upToDate",
      version: result.updateAvailable ? result.latestVersion : result.currentVersion
    };
  } catch (error) {
    updateFeedback = { key: "updateError", error: error.message };
  } finally {
    checkUpdate.disabled = false;
    renderUpdate();
    if (checking) updateCreatorBridge();
  }
});

installBridgeUpdate.addEventListener("click", () => updateCreatorBridge(true));

for (const input of resolutionInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || isBusy()) return;
    setCaptureState({ formatId: input.value });
    api.runtime.sendMessage({ type: "capture8k-set-format", formatId: input.value }).catch(() => undefined);
  });
}

captureButton.addEventListener("click", async () => {
  const formatId = selectedFormat;
  if (needsChromeRestart()) {
    try {
      const result = await api.runtime.sendMessage({ type: "capture8k-open-app" });
      if (!result?.ok) throw new Error(result?.error || copy("prepareError"));
      setCaptureState({ state: "notice", key: "confirmRestart" });
    } catch (error) {
      setCaptureState({ state: "error", key: "prepareError", technicalError: error.message });
    }
    return;
  }
  setCaptureState({ state: "working", formatId, key: "capturing", progress: 0.04 });
  try {
    const result = await api.runtime.sendMessage({ type: "capture8k-start", formatId });
    if (!result?.ok && !result?.cancelled) setCaptureState({ state: "error", message: result?.error });
  } catch (error) {
    setCaptureState({ state: "error", message: error.message });
  }
});
