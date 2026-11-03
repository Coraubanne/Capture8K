const api = globalThis.browser;

const NATIVE_HOST_NAME = "com.capture8k.native";
const NATIVE_CHUNK_LENGTH = 640 * 1024;
const CAPTURE_TIMEOUT_MS = 30000;
const FORMATS = Object.freeze({
  "4k": Object.freeze({ id: "4k", label: "4K", longEdge: 3840 }),
  "8k": Object.freeze({ id: "8k", label: "8K", longEdge: 7680 })
});

let captureInProgress = false;
let nativePort = null;
let nativeConnected = false;
let nativeSettings = null;
let nativeConnectionError = "L’app Capture8K n’est pas disponible.";
const nativeWaiters = new Set();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]);
}

function resolveFormat(formatId) {
  return FORMATS[formatId] || FORMATS["8k"];
}

function decodePNGHeader(base64) {
  const binary = atob(base64.slice(0, 64));
  if (binary.length < 24 || binary.charCodeAt(0) !== 0x89 || binary.slice(1, 4) !== "PNG") {
    throw new Error("Firefox n’a pas retourné un PNG valide.");
  }
  const uint32 = (offset) => (
    ((binary.charCodeAt(offset) << 24) >>> 0) |
    (binary.charCodeAt(offset + 1) << 16) |
    (binary.charCodeAt(offset + 2) << 8) |
    binary.charCodeAt(offset + 3)
  ) >>> 0;
  return { width: uint32(16), height: uint32(20) };
}

function dataURLBase64(dataURL) {
  const comma = String(dataURL || "").indexOf(",");
  if (comma < 0) throw new Error("La capture Firefox est vide.");
  return dataURL.slice(comma + 1);
}

function safeFilenamePart(value) {
  return String(value || "Page web")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _.-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Page web";
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function sessionGet(key) {
  const store = api.storage.session || api.storage.local;
  return store.get(key);
}

async function sessionSet(value) {
  const store = api.storage.session || api.storage.local;
  return store.set(value);
}

async function setState(state, message, details = {}) {
  const payload = { type: "capture8k-status", state, message, ...details };
  await sessionSet({ capture8kState: payload });
  try { await api.runtime.sendMessage(payload); } catch {}
}

async function setBadge(text, color = "#4f46e5") {
  await api.action.setBadgeBackgroundColor({ color });
  await api.action.setBadgeText({ text });
}

function dispatchNativeMessage(message) {
  if (message?.type === "settings" || message?.type === "settings-changed") {
    nativeSettings = message;
  }
  if (message?.type === "capture-request") {
    captureActiveTab(message.resolution).catch(() => undefined);
  }
  for (const waiter of [...nativeWaiters]) {
    if (!waiter.predicate(message)) continue;
    nativeWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function waitForNativeMessage(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      nativeWaiters.delete(waiter);
      reject(new Error(message));
    }, timeoutMs);
    nativeWaiters.add(waiter);
  });
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  try {
    const port = api.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    nativeConnected = true;
    nativeConnectionError = "";
    port.onMessage.addListener(dispatchNativeMessage);
    port.onDisconnect.addListener(() => {
      const error = api.runtime.lastError?.message;
      nativePort = null;
      nativeConnected = false;
      nativeSettings = null;
      nativeConnectionError = error || "La liaison avec l’app Capture8K a été interrompue.";
      for (const waiter of [...nativeWaiters]) {
        nativeWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(nativeConnectionError));
      }
    });
    return port;
  } catch (error) {
    nativeConnectionError = error?.message || String(error);
    nativeConnected = false;
    nativePort = null;
    return null;
  }
}

async function ensureNativeHost() {
  const port = connectNativeHost();
  if (!port) throw new Error(nativeConnectionError);
  const responsePromise = waitForNativeMessage(
    (message) => message?.type === "settings",
    2500,
    "L’app Capture8K ne répond pas."
  );
  port.postMessage({ type: "ping" });
  const settings = await responsePromise;
  nativeConnected = true;
  nativeSettings = settings;
  return settings;
}

async function freezeFrame(stateKey) {
  const existing = globalThis[stateKey];
  if (existing) return existing.snapshot;

  const animationStates = [];
  try {
    for (const animation of document.getAnimations({ subtree: true })) {
      animationStates.push({ animation, playState: animation.playState, currentTime: animation.currentTime });
      try { animation.pause(); } catch {}
    }
  } catch {}

  const mediaStates = [];
  for (const media of document.querySelectorAll("video,audio")) {
    mediaStates.push({
      media,
      paused: media.paused,
      currentTime: media.currentTime,
      playbackRate: media.playbackRate,
      muted: media.muted,
      volume: media.volume
    });
    try { media.pause(); } catch {}
  }

  const style = document.createElement("style");
  style.dataset.capture8kFirefox = stateKey;
  style.textContent = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  try {
    await Promise.race([
      Promise.allSettled([
        document.fonts?.ready || Promise.resolve(),
        ...[...document.images].slice(0, 240).map((image) => image.decode?.().catch(() => undefined))
      ]),
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  } catch {}

  const signature = () => {
    const parts = [location.href, innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio];
    let count = 0;
    for (const element of document.querySelectorAll("body *")) {
      if (count >= 1200) break;
      const rect = element.getBoundingClientRect();
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
      const computed = getComputedStyle(element);
      if (computed.display === "none" || computed.visibility === "hidden") continue;
      parts.push([
        element.localName,
        Math.round(rect.left * 4) / 4,
        Math.round(rect.top * 4) / 4,
        Math.round(rect.width * 4) / 4,
        Math.round(rect.height * 4) / 4,
        computed.position,
        computed.transform,
        computed.fontSize,
        computed.fontWeight,
        computed.color,
        computed.backgroundColor,
        element.childElementCount === 0 ? String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : ""
      ].join("~"));
      count += 1;
    }
    const serialized = parts.join("|");
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(16)}-${serialized.length}-${count}`;
  };

  const snapshot = {
    top: window.top === window,
    url: location.href,
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    dpr: devicePixelRatio,
    signature: signature(),
    animationsPaused: animationStates.length,
    mediaPaused: mediaStates.length
  };
  globalThis[stateKey] = { style, animationStates, mediaStates, snapshot, signature };
  return snapshot;
}

function inspectFrozenFrame(stateKey) {
  const state = globalThis[stateKey];
  if (!state) return null;
  return {
    ...state.snapshot,
    url: location.href,
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    dpr: devicePixelRatio,
    signature: state.signature()
  };
}

function restoreFrame(stateKey) {
  const state = globalThis[stateKey];
  if (!state) return false;
  try { state.style?.remove(); } catch {}
  for (const item of state.animationStates || []) {
    try {
      if (item.currentTime !== null) item.animation.currentTime = item.currentTime;
      if (item.playState === "running") item.animation.play();
      else if (item.playState === "paused") item.animation.pause();
      else if (item.playState === "finished") item.animation.finish();
      else if (item.playState === "idle") item.animation.cancel();
    } catch {}
  }
  for (const item of state.mediaStates || []) {
    try {
      item.media.currentTime = item.currentTime;
      item.media.playbackRate = item.playbackRate;
      item.media.muted = item.muted;
      item.media.volume = item.volume;
      if (!item.paused) item.media.play().catch(() => undefined);
    } catch {}
  }
  delete globalThis[stateKey];
  return true;
}

async function executeAllFrames(tabId, func, args) {
  try {
    return await api.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  } catch {
    return api.scripting.executeScript({ target: { tabId }, func, args });
  }
}

async function freezeVisiblePage(tabId, stateKey) {
  const results = await executeAllFrames(tabId, freezeFrame, [stateKey]);
  const main = results.find((result) => result.frameId === 0)?.result || results[0]?.result;
  if (!main || main.width < 1 || main.height < 1) throw new Error("La page visible n’a pas de surface capturable.");
  return { source: main, frozenFrames: results.filter((result) => result.result).length };
}

async function inspectVisiblePage(tabId, stateKey) {
  const results = await api.scripting.executeScript({ target: { tabId }, func: inspectFrozenFrame, args: [stateKey] });
  return results[0]?.result;
}

async function restoreVisiblePage(tabId, stateKey) {
  try { await executeAllFrames(tabId, restoreFrame, [stateKey]); } catch {}
}

async function captureAtScale(windowId, scale) {
  const options = { format: "png", scale };
  const dataURL = await withTimeout(
    api.tabs.captureVisibleTab(windowId, options),
    CAPTURE_TIMEOUT_MS,
    "Firefox n’a pas terminé le rendu dans le délai autorisé."
  );
  const data = dataURLBase64(dataURL);
  return { data, ...decodePNGHeader(data), scale };
}

function expectedDimensions(baseline, targetLongEdge) {
  if (baseline.width >= baseline.height) {
    return {
      width: targetLongEdge,
      height: Math.max(1, Math.round(baseline.height * targetLongEdge / baseline.width))
    };
  }
  return {
    width: Math.max(1, Math.round(baseline.width * targetLongEdge / baseline.height)),
    height: targetLongEdge
  };
}

async function captureExactHighResolution(windowId, baseline, format) {
  const expected = expectedDimensions(baseline, format.longEdge);
  const baselineLongEdge = Math.max(baseline.width, baseline.height);
  let scale = format.longEdge / baselineLongEdge;
  let capture = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    capture = await captureAtScale(windowId, scale);
    const actualLongEdge = Math.max(capture.width, capture.height);
    if (capture.width === expected.width && capture.height === expected.height) return { ...capture, ...expected };
    scale *= format.longEdge / actualLongEdge;
  }
  throw new Error(
    `Firefox a produit ${capture.width} × ${capture.height} au lieu de ${expected.width} × ${expected.height}. Aucun fichier incomplet n’a été enregistré.`
  );
}

async function saveCertifiedCapture({ tab, format, reference, baseline, render, certificate }) {
  const port = connectNativeHost();
  if (!port || !nativeConnected) throw new Error(nativeConnectionError);
  const jobId = crypto.randomUUID();
  const filename = `${safeFilenamePart(tab.title)}-${timestamp()}-firefox-${format.width}x${format.height}-certifie.png`;
  const readyPromise = waitForNativeMessage(
    (message) => message?.type === "save-ready" && message.jobId === jobId,
    3000,
    "L’app n’a pas préparé l’enregistrement à temps."
  );
  port.postMessage({
    type: "save-begin",
    jobId,
    filename,
    expectedWidth: format.width,
    expectedHeight: format.height,
    certificate
  });
  const ready = await readyPromise;
  if (!ready.ok) throw new Error(ready.error || "L’app a refusé l’enregistrement.");

  const completedPromise = waitForNativeMessage(
    (message) => message?.type === "save-complete" && message.jobId === jobId,
    CAPTURE_TIMEOUT_MS,
    "La validation native a dépassé le délai autorisé."
  );
  try {
    for (const [kind, base64] of Object.entries({ reference, baseline, render })) {
      for (let offset = 0; offset < base64.length; offset += NATIVE_CHUNK_LENGTH) {
        port.postMessage({ type: "save-chunk", jobId, kind, data: base64.slice(offset, offset + NATIVE_CHUNK_LENGTH) });
      }
    }
    port.postMessage({ type: "save-end", jobId });
    const completed = await completedPromise;
    if (!completed.ok) throw new Error(completed.error || "Le contrôle de fidélité a refusé cette capture.");
    return completed;
  } catch (error) {
    try { port.postMessage({ type: "save-cancel", jobId }); } catch {}
    throw error;
  }
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab?.windowId) throw new Error("Aucun onglet actif n’est capturable.");
  if (!/^https?:/i.test(tab.url || "")) throw new Error("Cette page interne de Firefox ne peut pas être capturée.");
  return tab;
}

async function captureTab(tab, requestedFormatId) {
  const format = resolveFormat(requestedFormatId);
  if (captureInProgress) throw new Error("Une capture haute définition est déjà en cours.");
  captureInProgress = true;
  const startedAt = Date.now();
  const stateKey = `__capture8k_firefox_${crypto.randomUUID().replace(/-/g, "")}`;
  let frozen = false;

  try {
    await setBadge("…");
    await setState("working", `Connexion à l’app et stabilisation de la page en ${format.label}…`, {
      progress: 0.05,
      formatId: format.id
    });
    const settings = await ensureNativeHost();
    if (settings.resolution !== format.id) {
      nativePort.postMessage({ type: "set-settings", resolution: format.id });
      await api.storage.local.set({ captureResolution: format.id });
    }

    const prepared = await freezeVisiblePage(tab.id, stateKey);
    frozen = true;
    await sleep(160);

    await setState("working", "Création du témoin visible…", { progress: 0.2, formatId: format.id });
    const reference = await captureAtScale(tab.windowId, 1);

    await setState("working", `Rerastérisation native ${format.label} par Firefox…`, {
      progress: 0.43,
      formatId: format.id
    });
    const render = await captureExactHighResolution(tab.windowId, reference, format);

    await setState("working", "Contrôle final de la page visible…", { progress: 0.7, formatId: format.id });
    const baseline = await captureAtScale(tab.windowId, 1);
    const after = await inspectVisiblePage(tab.id, stateKey);
    if (!after || after.url !== prepared.source.url || after.width !== prepared.source.width ||
        after.height !== prepared.source.height || after.scrollX !== prepared.source.scrollX ||
        after.scrollY !== prepared.source.scrollY) {
      throw new Error("Certification refusée : le viewport a changé pendant le rendu.");
    }
    const geometryStable = after.signature === prepared.source.signature;

    await setState("working", "Vérification indépendante et enregistrement…", {
      progress: 0.82,
      formatId: format.id
    });
    const certificate = {
      certified: true,
      native: true,
      browser: "Firefox",
      renderer: "Gecko drawSnapshot",
      nativeScale: render.scale,
      targetLongEdge: format.longEdge,
      outputWidth: render.width,
      outputHeight: render.height,
      sourceWidth: prepared.source.width,
      sourceHeight: prepared.source.height,
      fullVisibleViewport: true,
      viewportUntouched: true,
      aspectRatioPreserved: true,
      upscale: false,
      frozenFrames: prepared.frozenFrames,
      animationsPaused: prepared.source.animationsPaused,
      mediaPaused: prepared.source.mediaPaused,
      geometryStable
    };
    const saved = await saveCertifiedCapture({
      tab,
      format: { ...format, width: render.width, height: render.height },
      reference: reference.data,
      baseline: baseline.data,
      render: render.data,
      certificate
    });
    const elapsedMs = Date.now() - startedAt;
    await setBadge("✓", "#0f9d68");
    await setState("done", `Page visible ${format.label} certifiée et enregistrée (${(elapsedMs / 1000).toFixed(1)} s).`, {
      progress: 1,
      formatId: format.id,
      width: render.width,
      height: render.height,
      path: saved.path,
      certificate: { ...certificate, elapsedMs }
    });
    setTimeout(() => api.action.setBadgeText({ text: "" }), 5000);
    return { ok: true, width: render.width, height: render.height, path: saved.path, elapsedMs };
  } catch (error) {
    const message = error?.message || String(error);
    await setBadge("!", "#dc2626");
    await setState("error", message, { progress: 0, formatId: format.id, technicalError: message });
    setTimeout(() => api.action.setBadgeText({ text: "" }), 7000);
    throw new Error(message);
  } finally {
    if (frozen) await restoreVisiblePage(tab.id, stateKey);
    captureInProgress = false;
  }
}

async function captureActiveTab(formatId) {
  return captureTab(await activeTab(), formatId || await savedFormatId());
}

async function savedFormatId() {
  const { captureResolution } = await api.storage.local.get("captureResolution");
  return resolveFormat(captureResolution).id;
}

api.runtime.onInstalled.addListener(async () => {
  const formatId = await savedFormatId();
  await api.storage.local.set({ captureResolution: formatId });
  await setState("ready", `Prêt à capturer la page visible en ${resolveFormat(formatId).label}.`, {
    progress: 0,
    formatId
  });
});

api.commands.onCommand.addListener((command) => {
  if (command === "capture-visible") captureActiveTab().catch(() => undefined);
});

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture8k-start") {
    return captureActiveTab(message.formatId)
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }
  if (message?.type === "capture8k-native-status") {
    return ensureNativeHost()
      .then((settings) => ({ connected: true, browserCaptureModeReady: true, ...settings }))
      .catch(() => ({ connected: false, browserCaptureModeReady: false, error: nativeConnectionError }));
  }
  if (message?.type === "capture8k-set-format") {
    const format = resolveFormat(message.formatId);
    return api.storage.local.set({ captureResolution: format.id }).then(() => {
      const port = connectNativeHost();
      if (port && nativeConnected) port.postMessage({ type: "set-settings", resolution: format.id });
      return { ok: true, formatId: format.id };
    });
  }
  if (message?.type === "capture8k-choose-folder") {
    return ensureNativeHost().then(() => {
      nativePort.postMessage({ type: "choose-folder" });
      return { ok: true };
    }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }
  return undefined;
});

connectNativeHost();
