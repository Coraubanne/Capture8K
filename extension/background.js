const DEFAULT_FORMAT_ID = "8k";
const FORMATS = Object.freeze({
  "4k": Object.freeze({ id: "4k", label: "4K", longEdge: 3840, width: 3840, height: 2160, megapixels: "8,3" }),
  "8k": Object.freeze({ id: "8k", label: "8K", longEdge: 7680, width: 7680, height: 4320, megapixels: "33,2" })
});

const PREPARE_TIMEOUT_MS = 900;
const STABILITY_ATTEMPTS = 8;
const STABILITY_INTERVAL_MS = 90;
const CAPTURE_DEADLINE_MS = 26000;
const MIN_SELECTION_WIDTH = 160;
const CONTROL_RASTER_WIDTH = 640;
const CONTROL_RASTER_HEIGHT = 360;
const MAX_MEAN_PIXEL_DIFFERENCE = 0.0015;
const MAX_CHANGED_PIXEL_RATIO = 0.015;
const NATIVE_HOST_NAME = "com.capture8k.native";
const NATIVE_CHUNK_LENGTH = 512 * 1024;
const HIDDEN_LOAD_TIMEOUT_MS = 6500;
const VISIBLE_CAPTURE_MIN_INTERVAL_MS = 550;

let captureInProgress = false;
let activeSelectionTabId = null;
let nativePort = null;
let nativeConnected = false;
let nativeConnectionError = "L’app Capture8K n’est pas installée.";
const nativeWaiters = new Set();
let lastVisibleCaptureAt = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveFormat(formatId) {
  return FORMATS[formatId] || FORMATS[DEFAULT_FORMAT_ID];
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function withTimeout(promise, milliseconds, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), Math.max(1, milliseconds));
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function setState(state, message, extra = {}) {
  const payload = {
    type: "capture8k-status",
    state,
    message,
    updatedAt: Date.now(),
    ...extra
  };
  await chrome.storage.session.set({ capture8kState: payload });
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    // The popup closes as soon as the user clicks on the page.
  }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

function sendCommand(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

function dispatchNativeMessage(message) {
  if (message?.type === "settings" || message?.type === "settings-changed") {
    const formatId = resolveFormat(message.resolution).id;
    const browserCaptureModeReady = message.browserCaptureModeReady === true;
    chrome.storage.local.set({
      captureResolution: formatId,
      outputDirectory: message.outputDirectory || "Téléchargements/Capture8K",
      nativeConnected: true,
      browserCaptureModeReady
    });
    if (!captureInProgress) {
      setState(browserCaptureModeReady ? "ready" : "error", browserCaptureModeReady
        ? "Prêt à capturer la page visible en " + resolveFormat(formatId).label + "."
        : "Chrome doit être préparé une fois pour empêcher les déplacements sur les sites dynamiques.", {
        progress: 0,
        formatId,
        nativeConnected: true,
        outputDirectory: message.outputDirectory,
        browserCaptureModeReady,
        browserName: message.browserName || "Google Chrome"
      });
    }
  }
  if (message?.type === "capture-request") {
    captureActiveTab(resolveFormat(message.resolution).id).catch(() => undefined);
  }
  for (const waiter of [...nativeWaiters]) {
    if (!waiter.predicate(message)) continue;
    nativeWaiters.delete(waiter);
    clearTimeout(waiter.timeoutId);
    waiter.resolve(message);
  }
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    port.onMessage.addListener(dispatchNativeMessage);
    port.onDisconnect.addListener(() => {
      nativeConnectionError = chrome.runtime.lastError?.message || "La liaison avec l’app Capture8K a été interrompue.";
      if (nativePort === port) nativePort = null;
      nativeConnected = false;
      chrome.storage.local.set({ nativeConnected: false });
      for (const waiter of [...nativeWaiters]) {
        nativeWaiters.delete(waiter);
        clearTimeout(waiter.timeoutId);
        waiter.reject(new Error(nativeConnectionError));
      }
    });
    return port;
  } catch (error) {
    nativeConnectionError = error?.message || "Impossible de lancer l’app Capture8K.";
    nativePort = null;
    nativeConnected = false;
    return null;
  }
}

function waitForNativeMessage(predicate, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timeoutId: setTimeout(() => {
        nativeWaiters.delete(waiter);
        reject(new Error(timeoutMessage));
      }, timeoutMs)
    };
    nativeWaiters.add(waiter);
  });
}

async function ensureNativeHost() {
  const port = connectNativeHost();
  if (!port) throw new Error(nativeConnectionError);
  const reply = waitForNativeMessage(
    (message) => message?.type === "settings",
    1600,
    "L’app Capture8K ne répond pas. Ouvre-la puis réessaie."
  );
  port.postMessage({ type: "ping" });
  const settings = await reply;
  nativeConnected = true;
  return settings;
}

function decodePNGHeader(base64) {
  const header = atob(base64.slice(0, 64));
  const bytes = Uint8Array.from(header, (character) => character.charCodeAt(0));
  if (
    bytes.length < 29 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    throw new Error("Certification refusée : Chrome n’a pas retourné un fichier PNG valide.");
  }
  const view = new DataView(bytes.buffer);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlaced: bytes[28] === 1
  };
}

function safeFilenamePart(value) {
  const normalized = (value || "page-web")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return normalized || "page-web";
}

function timestamp() {
  const date = new Date();
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3)
  ].join(".");
}

function friendlyError(error) {
  const message = String(error?.message || error || "Erreur inconnue");
  if (/Another debugger is already attached|Cannot attach to this target/i.test(message)) {
    return "Impossible de contrôler cet onglet. Ferme les DevTools de Chrome sur cette page, puis réessaie.";
  }
  if (/Cannot access contents|Cannot access a chrome|Missing host permission|not allowed|restricted URL|chrome:\/\//i.test(message)) {
    return "Chrome interdit l’accès à cette page. Recharge une page web normale, puis ouvre Capture8K depuis son icône.";
  }
  if (/No tab with id|target_closed|The tab was closed/i.test(message)) {
    return "L’onglet a été fermé pendant la capture.";
  }
  return message;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Aucun onglet Chrome actif.");
  if (/^(chrome|chrome-extension|devtools|edge|brave):/i.test(tab.url || "")) {
    throw new Error("Chrome interdit la capture de ses pages internes.");
  }
  return tab;
}

async function prepareVisiblePageForCapture(
  key,
  formatLabel,
  outputWidth,
  outputHeight,
  prepareTimeoutMs,
  minimumSelectionWidth
) {
  // This function is serialized by chrome.scripting and therefore owns all its helpers.
  const ACTIVE_STATE_KEY = "__capture8kActiveState_v112";
  const ACTIVE_SELECTOR_KEY = "__capture8kActiveSelector_v112";

  if (typeof globalThis[ACTIVE_SELECTOR_KEY] === "function") {
    try { globalThis[ACTIVE_SELECTOR_KEY](); } catch {}
  }
  if (globalThis[ACTIVE_STATE_KEY]?.restore) {
    try { await globalThis[ACTIVE_STATE_KEY].restore(); } catch {}
  }

  const viewportWidth = Math.floor(window.innerWidth);
  const viewportHeight = Math.floor(window.innerHeight);
  const aspectRatio = outputWidth / outputHeight;
  if (viewportWidth < 320 || viewportHeight < 180) {
    throw new Error("La zone visible est trop petite pour une capture 16:9.");
  }

  const automaticWidth = Math.floor(
    Math.min(viewportWidth, viewportHeight * aspectRatio) / 16
  ) * 16;
  const automaticHeight = automaticWidth * 9 / 16;
  const selectionResult = {
    cancelled: false,
    selection: {
      left: Math.floor((viewportWidth - automaticWidth) / 2),
      top: Math.floor((viewportHeight - automaticHeight) / 2),
      width: automaticWidth,
      height: automaticHeight
    },
    selectedAt: Date.now()
  };

  // The old selector is kept unreachable for one rollback cycle.
  if (false) await new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = `capture8k-selector-${key}`;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";
    const shadow = host.attachShadow({ mode: "closed" });
    const selectorStyle = document.createElement("style");
    selectorStyle.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      #veil {
        position: fixed; inset: 0; overflow: hidden; cursor: crosshair;
        background: rgba(3, 7, 18, .48); touch-action: none; user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #panel {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
        padding: 11px 12px 11px 15px; border: 1px solid rgba(255,255,255,.25);
        border-radius: 13px; background: rgba(12, 18, 32, .92); color: white;
        box-shadow: 0 12px 34px rgba(0,0,0,.3); cursor: default;
        -webkit-font-smoothing: antialiased;
      }
      #copy { white-space: nowrap; }
      #title { display: block; font-size: 13px; font-weight: 750; line-height: 1.2; }
      #hint { display: block; margin-top: 3px; color: #b9c2d3; font-size: 10.5px; line-height: 1.2; }
      #cancel {
        appearance: none; border: 1px solid rgba(255,255,255,.22); border-radius: 8px;
        padding: 7px 9px; background: rgba(255,255,255,.09); color: white;
        cursor: pointer; font: 650 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #cancel:hover { background: rgba(255,255,255,.16); }
      #box {
        position: fixed; display: none; border: 2px solid #fff; border-radius: 3px;
        background: transparent; box-shadow: 0 0 0 100vmax rgba(3, 7, 18, .58),
          0 0 0 1px rgba(20, 85, 255, .85) inset;
      }
      #size {
        position: absolute; left: 50%; bottom: -31px; transform: translateX(-50%);
        padding: 5px 8px; border-radius: 7px; background: #155eef; color: white;
        box-shadow: 0 5px 14px rgba(0,0,0,.22); font: 750 10.5px ui-monospace, monospace;
        white-space: nowrap;
      }`;
    const veil = document.createElement("div");
    veil.id = "veil";
    veil.setAttribute("role", "dialog");
    veil.setAttribute("aria-label", "Sélection de la zone à capturer");
    const panel = document.createElement("div");
    panel.id = "panel";
    const copy = document.createElement("div");
    copy.id = "copy";
    const title = document.createElement("span");
    title.id = "title";
    title.textContent = `Glisse pour sélectionner la zone ${formatLabel}`;
    const hint = document.createElement("span");
    hint.id = "hint";
    hint.textContent = "Cadre 16:9 · relâche pour capturer · Échap pour annuler";
    const cancel = document.createElement("button");
    cancel.id = "cancel";
    cancel.type = "button";
    cancel.textContent = "Annuler";
    const box = document.createElement("div");
    box.id = "box";
    const size = document.createElement("span");
    size.id = "size";
    copy.append(title, hint);
    panel.append(copy, cancel);
    box.append(size);
    veil.append(panel, box);
    shadow.append(selectorStyle, veil);
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let current = null;
    let finished = false;

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      veil.removeEventListener("wheel", preventPageInteraction, true);
      host.remove();
      if (globalThis[ACTIVE_SELECTOR_KEY] === cancelSelection) {
        delete globalThis[ACTIVE_SELECTOR_KEY];
      }
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const cancelSelection = () => finish({ cancelled: true });
    const preventPageInteraction = (event) => event.preventDefault();
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelSelection();
    };

    const rectangleForPointer = (clientX, clientY) => {
      const x = Math.max(0, Math.min(viewportWidth, clientX));
      const y = Math.max(0, Math.min(viewportHeight, clientY));
      const deltaX = x - startX;
      const deltaY = y - startY;
      const horizontalDirection = deltaX === 0 ? (startX > viewportWidth / 2 ? -1 : 1) : Math.sign(deltaX);
      const verticalDirection = deltaY === 0 ? (startY > viewportHeight / 2 ? -1 : 1) : Math.sign(deltaY);
      const horizontalRoom = horizontalDirection > 0 ? viewportWidth - startX : startX;
      const verticalRoom = verticalDirection > 0 ? viewportHeight - startY : startY;
      const desiredWidth = Math.max(Math.abs(deltaX), Math.abs(deltaY) * aspectRatio);
      const availableWidth = Math.min(horizontalRoom, verticalRoom * aspectRatio);
      const unitCount = Math.max(0, Math.floor(Math.min(desiredWidth, availableWidth) / 16));
      const width = unitCount * 16;
      const height = unitCount * 9;
      return {
        left: Math.round(horizontalDirection > 0 ? startX : startX - width),
        top: Math.round(verticalDirection > 0 ? startY : startY - height),
        width,
        height
      };
    };

    const draw = (rectangle) => {
      current = rectangle;
      if (!rectangle.width || !rectangle.height) {
        box.style.display = "none";
        veil.style.background = "rgba(3, 7, 18, .48)";
        return;
      }
      veil.style.background = "transparent";
      box.style.display = "block";
      box.style.left = `${rectangle.left}px`;
      box.style.top = `${rectangle.top}px`;
      box.style.width = `${rectangle.width}px`;
      box.style.height = `${rectangle.height}px`;
      size.textContent = `${rectangle.width} × ${rectangle.height} CSS → ${outputWidth} × ${outputHeight}`;
    };

    veil.addEventListener("pointerdown", (event) => {
      if (panel.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragging = true;
      current = null;
      startX = Math.round(event.clientX);
      startY = Math.round(event.clientY);
      hint.textContent = "Cadre 16:9 · relâche pour capturer";
      try { veil.setPointerCapture(event.pointerId); } catch {}
      draw(rectangleForPointer(event.clientX, event.clientY));
    }, true);

    veil.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      draw(rectangleForPointer(event.clientX, event.clientY));
    }, true);

    veil.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragging = false;
      draw(rectangleForPointer(event.clientX, event.clientY));
      try { veil.releasePointerCapture(event.pointerId); } catch {}
      if (!current || current.width < minimumSelectionWidth) {
        current = null;
        box.style.display = "none";
        veil.style.background = "rgba(3, 7, 18, .48)";
        hint.textContent = `Zone trop petite : sélectionne au moins ${minimumSelectionWidth} × ${Math.round(minimumSelectionWidth * 9 / 16)} px CSS.`;
        return;
      }
      finish({ cancelled: false, selection: current, selectedAt: Date.now() });
    }, true);

    veil.addEventListener("pointercancel", () => {
      dragging = false;
      current = null;
      draw({ left: 0, top: 0, width: 0, height: 0 });
    }, true);
    veil.addEventListener("wheel", preventPageInteraction, { capture: true, passive: false });
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelSelection();
    });
    window.addEventListener("keydown", onKeyDown, true);
    globalThis[ACTIVE_SELECTOR_KEY] = cancelSelection;
    const overlayRoot = document.fullscreenElement || document.documentElement;
    overlayRoot.appendChild(host);
  });

  if (selectionResult.cancelled) return selectionResult;
  const selection = selectionResult.selection;
  await new Promise(requestAnimationFrame);

  const source = {
    url: location.href,
    width: Math.floor(window.innerWidth),
    height: Math.floor(window.innerHeight),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    readyState: document.readyState,
    visibilityState: document.visibilityState
  };

  if (
    selection.left < 0 || selection.top < 0 ||
    selection.left + selection.width > source.width ||
    selection.top + selection.height > source.height
  ) {
    throw new Error("La taille de la fenêtre a changé pendant la préparation. Recommence la capture.");
  }

  const pathForElement = (element) => {
    if (!(element instanceof Element)) return null;
    if (element.id && document.getElementById(element.id) === element) {
      return { id: element.id, path: null };
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 8) {
      const tag = current.localName;
      if (!tag) break;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((candidate) => candidate.localName === tag)
        : [];
      parts.unshift(`${tag}:nth-of-type(${Math.max(1, siblings.indexOf(current) + 1)})`);
      current = current.parentElement;
    }
    return { id: null, path: `html>${parts.join(">")}` };
  };

  const overlapsSelection = (element) => {
    const rect = element.getBoundingClientRect();
    return !(
      rect.right <= selection.left || rect.bottom <= selection.top ||
      rect.left >= selection.left + selection.width || rect.top >= selection.top + selection.height
    );
  };

  const snapshot = () => {
    const quantize = (value) => Math.round(Number(value || 0) * 4) / 4;
    const parts = [
      location.href, innerWidth, innerHeight, scrollX, scrollY,
      selection.left, selection.top, selection.width, selection.height
    ];
    let visibleCount = 0;
    const nodes = [document.documentElement, document.body, ...document.querySelectorAll("body *")];
    for (const element of nodes) {
      if (visibleCount >= 900) break;
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.right <= selection.left || rect.bottom <= selection.top ||
        rect.left >= selection.left + selection.width ||
        rect.top >= selection.top + selection.height
      ) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const leafText = element.childElementCount === 0
        ? String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 96)
        : "";
      parts.push([
        element.localName,
        quantize(rect.left), quantize(rect.top), quantize(rect.width), quantize(rect.height),
        style.position, style.display, style.visibility, style.opacity, style.transform,
        style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight,
        style.color, style.backgroundColor, style.objectFit, leafText
      ].join("~"));
      visibleCount += 1;
    }
    const serialized = parts.join("|");
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < serialized.length; index += 1) {
      const code = serialized.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second = ((second << 5) + second) ^ code;
    }
    return {
      signature: (first >>> 0).toString(16) + "-" + (second >>> 0).toString(16) + "-" + serialized.length,
      visibleCount,
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      url: location.href,
      dpr: devicePixelRatio
    };
  };

  const state = {
    source,
    selection,
    animations: [],
    media: [],
    style: null,
    scrollListener: null,
    snapshot,
    restore: null
  };
  state.restore = async () => {
    try { state.style?.remove(); } catch {}
    try { window.removeEventListener("scroll", state.scrollListener, true); } catch {}
    for (const item of state.animations) {
      try {
        item.animation.playbackRate = item.playbackRate;
        if (item.currentTime !== null) item.animation.currentTime = item.currentTime;
        if (item.playState === "running" || item.playState === "pending") item.animation.play();
        else if (item.playState === "paused") item.animation.pause();
        else if (item.playState === "finished") item.animation.finish();
      } catch {}
    }
    for (const item of state.media) {
      try {
        item.element.playbackRate = item.playbackRate;
        if (Number.isFinite(item.currentTime)) item.element.currentTime = item.currentTime;
        if (!item.paused) await item.element.play().catch(() => undefined);
      } catch {}
    }
    scrollTo(source.scrollX, source.scrollY);
    if (globalThis[key] === state) delete globalThis[key];
    if (globalThis[ACTIVE_STATE_KEY] === state) delete globalThis[ACTIVE_STATE_KEY];
    return true;
  };
  globalThis[key] = state;
  globalThis[ACTIVE_STATE_KEY] = state;

  const animations = typeof document.getAnimations === "function"
    ? document.getAnimations({ subtree: true })
    : [];
  for (const animation of animations) {
    state.animations.push({
      animation,
      currentTime: animation.currentTime,
      playbackRate: animation.playbackRate,
      playState: animation.playState
    });
    if (animation.playState === "running" || animation.playState === "pending") {
      try { animation.pause(); } catch {}
    }
  }

  const style = document.createElement("style");
  style.dataset.capture8kStability = key;
  style.textContent =
    "*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important}" +
    "html{scroll-behavior:auto!important}";
  (document.head || document.documentElement).appendChild(style);
  state.style = style;

  for (const element of document.querySelectorAll("video, audio")) {
    state.media.push({
      element,
      paused: element.paused,
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      playbackRate: element.playbackRate
    });
    if (!element.paused) {
      try { element.pause(); } catch {}
    }
  }

  let correctingScroll = false;
  state.scrollListener = () => {
    if (correctingScroll) return;
    if (Math.abs(scrollX - source.scrollX) < 0.5 && Math.abs(scrollY - source.scrollY) < 0.5) return;
    correctingScroll = true;
    scrollTo(source.scrollX, source.scrollY);
    correctingScroll = false;
  };
  window.addEventListener("scroll", state.scrollListener, { capture: true, passive: true });

  const visibleImages = [...document.images].filter((image) => {
    const rect = image.getBoundingClientRect();
    return !(
      rect.right <= selection.left || rect.bottom <= selection.top ||
      rect.left >= selection.left + selection.width ||
      rect.top >= selection.top + selection.height
    );
  }).slice(0, 120);
  await Promise.race([
    Promise.allSettled([
      document.fonts?.ready?.catch?.(() => undefined) || Promise.resolve(),
      ...visibleImages.map((image) => typeof image.decode === "function"
        ? image.decode().catch(() => undefined)
        : Promise.resolve())
    ]),
    new Promise((resolve) => setTimeout(resolve, prepareTimeoutMs))
  ]);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);

  const sessionStorageEntries = [];
  try {
    let serializedLength = 0;
    for (let index = 0; index < Math.min(sessionStorage.length, 160); index += 1) {
      const storageKey = sessionStorage.key(index);
      const storageValue = storageKey === null ? null : sessionStorage.getItem(storageKey);
      if (storageKey === null || storageValue === null || storageValue.length > 65536) continue;
      serializedLength += storageKey.length + storageValue.length;
      if (serializedLength > 512000) break;
      sessionStorageEntries.push([storageKey, storageValue]);
    }
  } catch {}

  const controls = [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")]
    .filter((element) => overlapsSelection(element) && element.type !== "password")
    .slice(0, 160)
    .map((element) => ({
      locator: pathForElement(element),
      value: "value" in element ? String(element.value ?? "") : null,
      checked: "checked" in element ? Boolean(element.checked) : null,
      selectedIndex: "selectedIndex" in element ? Number(element.selectedIndex) : null,
      html: element.matches?.("[contenteditable=true]") ? String(element.innerHTML || "").slice(0, 20000) : null
    }));

  const details = [...document.querySelectorAll("details")]
    .filter(overlapsSelection)
    .slice(0, 80)
    .map((element) => ({ locator: pathForElement(element), open: element.open }));

  const scrollables = [...document.querySelectorAll("body *")]
    .filter((element) => overlapsSelection(element) && (Math.abs(element.scrollLeft) > 0.5 || Math.abs(element.scrollTop) > 0.5))
    .slice(0, 120)
    .map((element) => ({
      locator: pathForElement(element),
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop
    }));

  const media = state.media.slice(0, 24).map((item) => ({
    locator: pathForElement(item.element),
    currentTime: item.currentTime,
    paused: item.paused,
    playbackRate: item.playbackRate,
    muted: item.element.muted,
    volume: item.element.volume
  }));

  return {
    cancelled: false,
    selectedAt: selectionResult.selectedAt,
    source,
    selection,
    geometry: snapshot(),
    mirrorState: {
      sessionStorageEntries,
      controls,
      details,
      scrollables,
      media,
      activeElement: pathForElement(document.activeElement)
    },
    frozen: {
      animationsPaused: state.animations.length,
      mediaPaused: state.media.filter((item) => !item.paused).length,
      visibleImages: visibleImages.length
    }
  };
}

function validateInitializedViewport(results) {
  const initialized = results?.find?.((entry) => entry.frameId === 0)?.result ?? results?.[0]?.result;
  if (initialized?.cancelled) return initialized;
  if (!initialized?.source || !initialized?.geometry || !initialized?.selection) {
    throw new Error(`Impossible de mesurer et stabiliser la page visible : ${JSON.stringify(results)}.`);
  }
  return initialized;
}

function prepareDirectVisiblePageForCapture(key) {
  const ACTIVE_STATE_KEY = "__capture8kDirectActiveState_v220";
  if (globalThis[ACTIVE_STATE_KEY]?.restore) {
    try { globalThis[ACTIVE_STATE_KEY].restore(); } catch {}
  }

  const source = {
    url: location.href,
    width: Math.floor(window.innerWidth),
    height: Math.floor(window.innerHeight),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    readyState: document.readyState,
    visibilityState: document.visibilityState
  };
  const isTopFrame = window === window.top;
  if (isTopFrame && (source.width < 320 || source.height < 180)) {
    throw new Error("La page visible est trop petite pour une capture haute définition.");
  }

  const selection = {
    left: 0,
    top: 0,
    width: Math.max(1, source.width),
    height: Math.max(1, source.height)
  };
  const compositedRegions = [...document.querySelectorAll("iframe,video,canvas,embed,object")]
    .flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" || computed.visibility === "hidden" ||
        Number(computed.opacity) === 0 || rect.width < 8 || rect.height < 8
      ) return [];
      const padding = 2;
      const left = Math.max(selection.left, rect.left - padding);
      const top = Math.max(selection.top, rect.top - padding);
      const right = Math.min(selection.left + selection.width, rect.right + padding);
      const bottom = Math.min(selection.top + selection.height, rect.bottom + padding);
      if (right <= left || bottom <= top) return [];
      const width = (right - left) / selection.width;
      const height = (bottom - top) / selection.height;
      if (width * height > 0.58) return [];
      return [{
        x: (left - selection.left) / selection.width,
        y: (top - selection.top) / selection.height,
        width,
        height,
        kind: element.localName
      }];
    })
    .sort((left, right) => right.width * right.height - left.width * left.height)
    .slice(0, 32);
  const media = [...document.querySelectorAll("video,audio")].slice(0, 128).map(element => ({
    element,
    paused: element.paused,
    currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
    playbackRate: element.playbackRate
  }));
  for (const item of media) {
    try { item.element.pause(); } catch {}
  }

  const style = document.createElement("style");
  style.dataset.capture8kDirectStability = key;
  style.textContent =
    "*,*::before,*::after{animation-play-state:paused!important;transition-property:none!important;caret-color:transparent!important}" +
    "html{scroll-behavior:auto!important}";
  (document.head || document.documentElement).appendChild(style);

  const animations = [];
  try {
    for (const animation of document.getAnimations({ subtree: true }).slice(0, 2048)) {
      animations.push({
        animation,
        playState: animation.playState,
        currentTime: animation.currentTime,
        playbackRate: animation.playbackRate
      });
      try { animation.pause(); } catch {}
    }
  } catch {}

  let correctingScroll = false;
  const scrollListener = () => {
    if (correctingScroll) return;
    if (Math.abs(scrollX - source.scrollX) < 0.5 && Math.abs(scrollY - source.scrollY) < 0.5) return;
    correctingScroll = true;
    scrollTo(source.scrollX, source.scrollY);
    correctingScroll = false;
  };
  window.addEventListener("scroll", scrollListener, { capture: true, passive: true });

  const snapshot = () => {
    const quantize = value => Math.round(Number(value || 0) * 4) / 4;
    const parts = [location.href, innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio];
    let visibleCount = 0;
    const candidates = document.body?.querySelectorAll("*") || [];
    const inspect = (element) => {
      if (!element || visibleCount >= 1200) return;
      const rect = element.getBoundingClientRect();
      if (
        rect.right <= selection.left || rect.bottom <= selection.top ||
        rect.left >= selection.left + selection.width ||
        rect.top >= selection.top + selection.height
      ) return;
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" || computed.visibility === "hidden" ||
        Number(computed.opacity) === 0 || rect.width <= 0 || rect.height <= 0
      ) return;
      const leafText = element.childElementCount === 0
        ? String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 96)
        : "";
      parts.push([
        element.localName, element.id || "", String(element.className || "").slice(0, 96),
        quantize(rect.left), quantize(rect.top), quantize(rect.width), quantize(rect.height),
        computed.position, computed.display, computed.visibility, computed.opacity,
        computed.fontFamily, computed.fontSize, computed.fontWeight, computed.lineHeight,
        computed.transform, computed.objectFit, leafText
      ].join("~"));
      visibleCount += 1;
    };
    inspect(document.documentElement);
    inspect(document.body);
    for (let index = 0; index < candidates.length && visibleCount < 1200; index += 1) {
      inspect(candidates[index]);
    }
    const serialized = parts.join("|");
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < serialized.length; index += 1) {
      const code = serialized.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second = ((second << 5) + second) ^ code;
    }
    return {
      signature: (first >>> 0).toString(16) + "-" + (second >>> 0).toString(16) + "-" + serialized.length,
      visibleCount,
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      url: location.href,
      dpr: devicePixelRatio
    };
  };

  const state = {
    snapshot,
    restore: () => {
      try { style.remove(); } catch {}
      try { window.removeEventListener("scroll", scrollListener, true); } catch {}
      for (const item of animations) {
        try {
          item.animation.playbackRate = item.playbackRate;
          if (item.currentTime !== null) item.animation.currentTime = item.currentTime;
          if (item.playState === "running") item.animation.play();
          else if (item.playState === "finished") item.animation.finish();
          else item.animation.pause();
        } catch {}
      }
      for (const item of media) {
        try {
          item.element.playbackRate = item.playbackRate;
          if (Number.isFinite(item.currentTime)) item.element.currentTime = item.currentTime;
          if (!item.paused) item.element.play().catch(() => undefined);
        } catch {}
      }
      scrollTo(source.scrollX, source.scrollY);
      if (globalThis[key] === state) delete globalThis[key];
      if (globalThis[ACTIVE_STATE_KEY] === state) delete globalThis[ACTIVE_STATE_KEY];
      return true;
    }
  };
  globalThis[key] = state;
  globalThis[ACTIVE_STATE_KEY] = state;
  return {
    cancelled: false,
    selectedAt: Date.now(),
    source,
    selection,
    geometry: snapshot(),
    mirrorState: {},
    compositedRegions,
    frozen: {
      mediaPaused: media.filter(item => !item.paused).length,
      animationsPaused: animations.filter(item => item.playState === "running").length
    }
  };
}

async function initializeDirectVisiblePage(tabId, stateKey, format) {
  const deadline = Date.now() + 12000;
  let initialized = null;
  for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt += 1) {
    try {
      const results = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          injectImmediately: true,
          func: prepareDirectVisiblePageForCapture,
          args: [stateKey]
        }),
        remainingTime(deadline),
        "La préparation de la page a expiré."
      );
      initialized = validateInitializedViewport(results);
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!initialized) {
    throw new Error(
      "Chrome n’a pas réussi à préparer le document principal dans le délai autorisé."
    );
  }

  let embeddedFrames = [];
  try {
    embeddedFrames = (await chrome.webNavigation.getAllFrames({ tabId }) || [])
      .map(frame => frame.frameId)
      .filter(frameId => Number.isInteger(frameId) && frameId !== 0)
      .slice(0, 96);
  } catch {}
  let embeddedFramesFrozen = 0;
  for (let offset = 0; offset < embeddedFrames.length && Date.now() < deadline; offset += 8) {
    const batch = embeddedFrames.slice(offset, offset + 8);
    const results = await Promise.allSettled(batch.map(frameId =>
      withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: "MAIN",
          injectImmediately: true,
          func: prepareDirectVisiblePageForCapture,
          args: [stateKey]
        }),
        Math.min(1800, remainingTime(deadline)),
        "Un cadre intégré n’a pas répondu."
      )
    ));
    embeddedFramesFrozen += results.filter(result => result.status === "fulfilled").length;
  }
  return {
    ...initialized,
    embeddedFrameCount: embeddedFrames.length,
    embeddedFramesFrozen
  };
}

async function pageSelectorIsVisible(tabId, stateKey) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: (key) => {
        const host = document.getElementById(`capture8k-selector-${key}`);
        if (!host?.isConnected) return false;
        const rectangle = host.getBoundingClientRect();
        const style = getComputedStyle(host);
        return rectangle.width > 0 && rectangle.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      },
      args: [stateKey]
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function cancelPageSelector(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: () => {
        const cancel = globalThis.__capture8kActiveSelector_v112;
        if (typeof cancel !== "function") return false;
        cancel();
        return true;
      }
    });
  } catch {
    // A navigation can already have destroyed the selector.
  }
}

async function initializeVisiblePage(tabId, stateKey, format) {
  const results = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: prepareVisiblePageForCapture,
      args: [
        stateKey,
        format.label,
        format.width,
        format.height,
        PREPARE_TIMEOUT_MS,
        MIN_SELECTION_WIDTH
      ]
    }),
    PREPARE_TIMEOUT_MS + 1800,
    "La page visible n’a pas pu être préparée à temps. Recharge l’onglet puis réessaie."
  );
  return validateInitializedViewport(results);
}

async function restorePageWithoutDebugger(tabId, stateKey) {
  let frameIds = [0];
  try {
    frameIds = (await chrome.webNavigation.getAllFrames({ tabId }) || [])
      .map(frame => frame.frameId)
      .filter(frameId => Number.isInteger(frameId))
      .slice(0, 97);
    if (!frameIds.includes(0)) frameIds.unshift(0);
  } catch {}
  await Promise.allSettled(frameIds.map(frameId => chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    injectImmediately: true,
    func: (key) => {
      const state = globalThis[key];
      return state?.restore ? state.restore() : false;
    },
    args: [stateKey]
  })));
}

function createCapturePlan(source, selection, format) {
  const values = [selection.left, selection.top, selection.width, selection.height];
  if (!values.every(Number.isInteger)) {
    throw new Error("Certification refusée : le cadrage automatique ne repose pas sur des pixels CSS entiers.");
  }
  if (
    selection.width < MIN_SELECTION_WIDTH || selection.height < 120 ||
    selection.left < 0 || selection.top < 0 ||
    selection.left + selection.width > source.width ||
    selection.top + selection.height > source.height
  ) {
    throw new Error("Certification refusée : le plein cadre visible n’est plus valide.");
  }
  const nativeDeviceScaleFactor = (format.longEdge || format.width) / Math.max(selection.width, selection.height);
  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    left: selection.left,
    top: selection.top,
    pageX: source.scrollX + selection.left,
    pageY: source.scrollY + selection.top,
    width: selection.width,
    height: selection.height,
    nativeDeviceScaleFactor,
    expectedWidth: Math.round(selection.width * nativeDeviceScaleFactor),
    expectedHeight: Math.round(selection.height * nativeDeviceScaleFactor)
  };
}

function renderedViewportFormat(format, baselineDimensions) {
  const targetLongEdge = format.longEdge || format.width;
  const baselineLongEdge = Math.max(baselineDimensions.width, baselineDimensions.height);
  const pageScaleFactor = targetLongEdge / baselineLongEdge;
  if (!Number.isFinite(pageScaleFactor) || pageScaleFactor <= 0 || pageScaleFactor > 16) {
    throw new Error("Chrome n’a pas pu calculer l’échelle de rendu haute définition.");
  }
  return {
    ...format,
    width: Math.round(baselineDimensions.width * pageScaleFactor),
    height: Math.round(baselineDimensions.height * pageScaleFactor),
    pageScaleFactor
  };
}

function alignPlanToVisibleReference(plan, reference, source, browserZoom) {
  const baseDeviceScaleFactor = source.devicePixelRatio / browserZoom;
  if (!Number.isFinite(baseDeviceScaleFactor) || baseDeviceScaleFactor <= 0) {
    throw new Error("Chrome n’a pas pu mesurer l’échelle physique de la fenêtre.");
  }
  return {
    ...plan,
    capturePageX: plan.pageX * browserZoom,
    capturePageY: plan.pageY * browserZoom,
    captureWidth: (reference.width + 0.01) / baseDeviceScaleFactor,
    captureHeight: (reference.height + 0.01) / baseDeviceScaleFactor,
    browserZoom,
    baseDeviceScaleFactor
  };
}

function viewportForPlan(plan) {
  return {
    x: plan.pageX,
    y: plan.pageY,
    width: plan.width,
    height: plan.height,
    scale: 1
  };
}

async function geometrySnapshot(target, stateKey) {
  const key = JSON.stringify(stateKey);
  const evaluated = await sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      // __capture8kGeometrySnapshot_v112
      const state = globalThis[${key}];
      return state?.snapshot ? state.snapshot() : null;
    })()`,
    returnByValue: true
  });
  const snapshot = evaluated?.result?.value;
  if (!snapshot?.signature) throw new Error("Impossible de vérifier la géométrie de la zone.");
  return snapshot;
}

async function waitForStableGeometry(target, stateKey, source, deadline) {
  let previous = null;
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS; attempt += 1) {
    const current = await withTimeout(
      geometrySnapshot(target, stateKey),
      Math.min(1600, remainingTime(deadline)),
      "La vérification de la structure a dépassé le délai autorisé."
    );
    assertCompatibleGeometry(current, source, source.devicePixelRatio);
    if (previous?.signature === current.signature) {
      return { geometry: current, attempts: attempt };
    }
    previous = current;
    await sleep(STABILITY_INTERVAL_MS);
  }
  throw new Error(
    "Certification refusée : la structure visible ne se stabilise pas après le gel de la page."
  );
}

function screenshotParameters(plan) {
  return {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
    clip: {
      x: plan.pageX,
      y: plan.pageY,
      width: plan.width,
      height: plan.height,
      scale: 1
    }
  };
}

function pngBlobFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/png" });
}

function normalizedSurfaceRegions(regions) {
  if (!Array.isArray(regions)) return [];
  return regions.slice(0, 32).flatMap((region) => {
    const x = Math.max(0, Math.min(1, Number(region?.x)));
    const y = Math.max(0, Math.min(1, Number(region?.y)));
    const right = Math.max(x, Math.min(1, x + Number(region?.width)));
    const bottom = Math.max(y, Math.min(1, y + Number(region?.height)));
    if (![x, y, right, bottom].every(Number.isFinite) || right - x < 0.002 || bottom - y < 0.002) {
      return [];
    }
    return [{ x, y, width: right - x, height: bottom - y, kind: String(region?.kind || "surface") }];
  });
}

async function compareControlRasters(firstBase64, secondBase64, excludedRegions = []) {
  if (firstBase64 === secondBase64) {
    return { stable: true, exact: true, meanDifference: 0, changedPixelRatio: 0 };
  }
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return { stable: false, exact: false, meanDifference: 1, changedPixelRatio: 1 };
  }

  let firstBitmap;
  let secondBitmap;
  try {
    [firstBitmap, secondBitmap] = await Promise.all([
      createImageBitmap(pngBlobFromBase64(firstBase64)),
      createImageBitmap(pngBlobFromBase64(secondBase64))
    ]);
    const canvas = new OffscreenCanvas(CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D indisponible");

    context.clearRect(0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT);
    context.drawImage(firstBitmap, 0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT);
    const firstPixels = context.getImageData(0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT).data;
    context.clearRect(0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT);
    context.drawImage(secondBitmap, 0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT);
    const secondPixels = context.getImageData(0, 0, CONTROL_RASTER_WIDTH, CONTROL_RASTER_HEIGHT).data;

    const regions = normalizedSurfaceRegions(excludedRegions);
    const excluded = new Uint8Array(CONTROL_RASTER_WIDTH * CONTROL_RASTER_HEIGHT);
    for (const region of regions) {
      const left = Math.max(0, Math.floor(region.x * CONTROL_RASTER_WIDTH));
      const top = Math.max(0, Math.floor(region.y * CONTROL_RASTER_HEIGHT));
      const right = Math.min(CONTROL_RASTER_WIDTH, Math.ceil((region.x + region.width) * CONTROL_RASTER_WIDTH));
      const bottom = Math.min(CONTROL_RASTER_HEIGHT, Math.ceil((region.y + region.height) * CONTROL_RASTER_HEIGHT));
      for (let y = top; y < bottom; y += 1) {
        excluded.fill(1, y * CONTROL_RASTER_WIDTH + left, y * CONTROL_RASTER_WIDTH + right);
      }
    }

    let absoluteDifference = 0;
    let changedPixels = 0;
    let pixelCount = 0;
    for (let index = 0; index < firstPixels.length; index += 4) {
      if (excluded[index / 4]) continue;
      pixelCount += 1;
      const red = Math.abs(firstPixels[index] - secondPixels[index]);
      const green = Math.abs(firstPixels[index + 1] - secondPixels[index + 1]);
      const blue = Math.abs(firstPixels[index + 2] - secondPixels[index + 2]);
      absoluteDifference += red + green + blue;
      if (Math.max(red, green, blue) > 10) changedPixels += 1;
    }
    if (pixelCount < CONTROL_RASTER_WIDTH * CONTROL_RASTER_HEIGHT * 0.4) {
      return { stable: false, exact: false, meanDifference: 1, changedPixelRatio: 1, excludedPixelRatio: 1 };
    }
    const meanDifference = absoluteDifference / (pixelCount * 3 * 255);
    const changedPixelRatio = changedPixels / pixelCount;
    return {
      stable: meanDifference <= MAX_MEAN_PIXEL_DIFFERENCE && changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO,
      exact: false,
      meanDifference,
      changedPixelRatio,
      excludedPixelRatio: 1 - pixelCount / (CONTROL_RASTER_WIDTH * CONTROL_RASTER_HEIGHT)
    };
  } catch {
    return { stable: false, exact: false, meanDifference: 1, changedPixelRatio: 1 };
  } finally {
    try { firstBitmap?.close(); } catch {}
    try { secondBitmap?.close(); } catch {}
  }
}

async function waitForStableRaster(target, plan, deadline, stableGeometry) {
  let previous = null;
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS; attempt += 1) {
    const screenshot = await withTimeout(
      sendCommand(target, "Page.captureScreenshot", screenshotParameters(plan)),
      Math.min(1600, remainingTime(deadline)),
      "La zone n’a pas pu être vérifiée assez rapidement."
    );
    if (!screenshot?.data) throw new Error("Chrome n’a retourné aucune image de contrôle.");
    const header = decodePNGHeader(screenshot.data);
    if (previous) {
      const comparison = await withTimeout(
        compareControlRasters(previous.data, screenshot.data),
        Math.min(900, remainingTime(deadline)),
        "Le contrôle visuel a pris trop de temps."
      );
      if (comparison.stable) {
      return {
        geometry: stableGeometry,
        attempts: attempt,
        baselineWidth: header.width,
        baselineHeight: header.height,
        exactRasterMatch: comparison.exact,
        meanPixelDifference: comparison.meanDifference,
        changedPixelRatio: comparison.changedPixelRatio
      };
      }
    }
    previous = { data: screenshot.data };
    await sleep(STABILITY_INTERVAL_MS);
  }
  throw new Error(
    "Certification refusée : la zone bouge encore. Mets la vidéo en pause ou ferme les menus animés, puis réessaie."
  );
}

function assertCompatibleGeometry(after, source, expectedDPR) {
  const sameViewport = after.width === source.width && after.height === source.height;
  const sameScroll = Math.abs(after.scrollX - source.scrollX) < 0.5 && Math.abs(after.scrollY - source.scrollY) < 0.5;
  const sameDPR = Math.abs(after.dpr - expectedDPR) < 0.02;
  if (
    after.url !== source.url ||
    !sameViewport ||
    !sameScroll ||
    !sameDPR
  ) {
    throw new Error(
      `Certification refusée : le viewport a changé. Attendu ${JSON.stringify({
        url: source.url, width: source.width, height: source.height,
        scrollX: source.scrollX, scrollY: source.scrollY, dpr: expectedDPR
      })}, obtenu ${JSON.stringify(after)}.`
    );
  }
}

function normalizedLayoutMetrics(metrics) {
  const layout = metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
  const visual = metrics?.cssVisualViewport || metrics?.visualViewport || {};
  const content = metrics?.cssContentSize || metrics?.contentSize || {};
  const quantize = (value) => Math.round(Number(value || 0) * 4) / 4;
  return {
    layoutX: quantize(layout.pageX),
    layoutY: quantize(layout.pageY),
    layoutWidth: quantize(layout.clientWidth),
    layoutHeight: quantize(layout.clientHeight),
    visualX: quantize(visual.pageX),
    visualY: quantize(visual.pageY),
    visualWidth: quantize(visual.clientWidth),
    visualHeight: quantize(visual.clientHeight),
    contentWidth: quantize(content.width),
    contentHeight: quantize(content.height)
  };
}

async function readLayoutMetrics(target) {
  return normalizedLayoutMetrics(await sendCommand(target, "Page.getLayoutMetrics"));
}

function sameLayoutMetrics(before, after) {
  const stableKeys = [
    "layoutX", "layoutY", "layoutWidth", "layoutHeight",
    "visualX", "visualY", "visualWidth", "visualHeight"
  ];
  return stableKeys.every((key) => Math.abs(before[key] - after[key]) <= 0.25);
}

function sameDocumentExtent(before, after) {
  return Math.abs(before.contentWidth - after.contentWidth) <= 1 &&
    Math.abs(before.contentHeight - after.contentHeight) <= 1;
}

function assertSameLayoutMetrics(before, after) {
  if (!sameLayoutMetrics(before, after)) {
    throw new Error(
      `Certification refusée : la mise en page visible a changé. Avant ${JSON.stringify(before)}, après ${JSON.stringify(after)}.`
    );
  }
}

async function restorePage(target, stateKey) {
  const key = JSON.stringify(stateKey);
  try {
    await sendCommand(target, "Runtime.evaluate", {
      expression: `(async () => {
        // __capture8kRestorePage_v112
        const state = globalThis[${key}];
        return state?.restore ? state.restore() : false;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
  } catch {
    // Navigation or tab closure can make restoration impossible.
  }
}

async function savePNG(tab, format, screenshotData, dimensions, certificate) {
  const filename = `Capture8K/${safeFilenamePart(tab.title)}-${timestamp()}-zone-${format.width}x${format.height}-certifie.png`;
  const downloadId = await chrome.downloads.download({
    url: `data:image/png;base64,${screenshotData}`,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  return { filename, downloadId, dimensions, certificate };
}

function selectionCancelledError() {
  const error = new Error("Sélection annulée.");
  error.cancelled = true;
  return error;
}

async function captureTabLegacy(tab, requestedFormatId) {
  const format = resolveFormat(requestedFormatId);
  if (captureInProgress) throw new Error("Une capture haute définition est déjà en cours.");
  captureInProgress = true;

  const stateKey = `__capture8k_${crypto.randomUUID().replace(/-/g, "")}`;
  const target = { tabId: tab.id };
  let startedAt = Date.now();
  let deadline = startedAt + CAPTURE_DEADLINE_MS;
  let initialized = null;
  let pageTouched = false;
  let attached = false;
  let metricsOverridden = false;
  let scriptExecutionDisabled = false;

  try {
    await setBadge("ZONE", "#1d4ed8");
    await setState("selecting", `Sélectionne la zone 16:9 à rendre en ${format.label}…`, {
      progress: 0,
      formatId: format.id
    });

    pageTouched = true;
    activeSelectionTabId = tab.id;
    initialized = await initializeVisiblePage(tab.id, stateKey, format);
    activeSelectionTabId = null;
    if (initialized.cancelled) throw selectionCancelledError();

    startedAt = Number.isFinite(initialized.selectedAt) ? initialized.selectedAt : Date.now();
    deadline = startedAt + CAPTURE_DEADLINE_MS;
    const source = initialized.source;
    const frozen = initialized.frozen;
    const plan = createCapturePlan(source, initialized.selection, format);

    await setBadge("…", "#1d4ed8");
    await setState("working", `Contrôle de la zone ${format.label}…`, {
      progress: 0.1,
      formatId: format.id
    });

    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await sendCommand(target, "Page.enable");
    await sendCommand(target, "Runtime.enable");

    const baseMetrics = {
      width: source.width,
      height: source.height,
      deviceScaleFactor: source.devicePixelRatio,
      mobile: false,
      screenWidth: source.screenWidth,
      screenHeight: source.screenHeight,
      positionX: 0,
      positionY: 0,
      viewport: viewportForPlan(plan)
    };
    await sendCommand(target, "Emulation.setDeviceMetricsOverride", baseMetrics);
    metricsOverridden = true;

    const attachedGeometry = await geometrySnapshot(target, stateKey);
    assertCompatibleGeometry(attachedGeometry, source, source.devicePixelRatio);

    await setState("working", "Double vérification visuelle de la zone…", {
      progress: 0.3,
      formatId: format.id
    });
    await sendCommand(target, "Emulation.setScriptExecutionDisabled", { value: true });
    scriptExecutionDisabled = true;
    const baseLayoutMetrics = await readLayoutMetrics(target);
    const stable = await waitForStableRaster(target, plan, deadline, attachedGeometry);

    await setState("working", `Peinture native des ${format.megapixels} millions de pixels…`, {
      progress: 0.52,
      formatId: format.id
    });
    await sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      ...baseMetrics,
      deviceScaleFactor: plan.nativeDeviceScaleFactor
    });
    await sleep(120);
    let highDensityLayoutMetrics = await readLayoutMetrics(target);
    if (!sameLayoutMetrics(baseLayoutMetrics, highDensityLayoutMetrics)) {
      await sleep(120);
      highDensityLayoutMetrics = await readLayoutMetrics(target);
    }
    assertSameLayoutMetrics(baseLayoutMetrics, highDensityLayoutMetrics);

    await setState("working", `Capture ${format.label} dans une surface unique…`, {
      progress: 0.74,
      formatId: format.id
    });
    const screenshot = await withTimeout(
      sendCommand(target, "Page.captureScreenshot", screenshotParameters(plan)),
      Math.max(1, remainingTime(deadline) - 500),
      "La capture a dépassé 9 secondes. Aucun fichier incomplet ne sera enregistré."
    );
    if (!screenshot?.data) throw new Error("Chrome n’a retourné aucune image.");

    const dimensions = decodePNGHeader(screenshot.data);
    if (dimensions.width !== format.width || dimensions.height !== format.height) {
      throw new Error(
        `Certification refusée : Chrome a produit ${dimensions.width} × ${dimensions.height} au lieu de ${format.width} × ${format.height}. Aucun PNG n’a été enregistré.`
      );
    }
    if (dimensions.bitDepth !== 8 || ![2, 6].includes(dimensions.colorType)) {
      throw new Error("Certification refusée : le PNG retourné par Chrome utilise un format de pixels inattendu.");
    }

    const elapsedBeforeSave = Date.now() - startedAt;
    if (elapsedBeforeSave >= CAPTURE_DEADLINE_MS) {
      throw new Error("La capture a dépassé 9,5 secondes. Aucun fichier tardif n’a été enregistré.");
    }

    const certificate = {
      certified: true,
      native: true,
      layoutStable: true,
      rasterStable: true,
      singleSurface: true,
      selectedArea: true,
      upscale: false,
      nativeDeviceScaleFactor: plan.nativeDeviceScaleFactor,
      geometrySignature: stable.geometry.signature,
      stabilityChecks: stable.attempts,
      exactRasterMatch: stable.exactRasterMatch,
      meanPixelDifference: stable.meanPixelDifference,
      changedPixelRatio: stable.changedPixelRatio,
      animationsPaused: frozen.animationsPaused,
      mediaPaused: frozen.mediaPaused,
      cropCSS: { left: plan.left, top: plan.top, width: plan.width, height: plan.height },
      elapsedMs: elapsedBeforeSave
    };

    await setState("working", "PNG conforme : enregistrement…", {
      progress: 0.92,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height
    });
    const saved = await savePNG(tab, format, screenshot.data, dimensions, certificate);
    const elapsedMs = Date.now() - startedAt;

    await setBadge("✓", "#0f9d68");
    await setState("done", `Zone enregistrée en ${format.width} × ${format.height} certifié (${(elapsedMs / 1000).toFixed(1)} s).`, {
      progress: 1,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height,
      filename: saved.filename,
      downloadId: saved.downloadId,
      certificate: { ...certificate, elapsedMs }
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
    return {
      ok: true,
      formatId: format.id,
      label: format.label,
      width: dimensions.width,
      height: dimensions.height,
      filename: saved.filename,
      downloadId: saved.downloadId,
      renderMethod: "native-dpr-viewport-surface",
      ...certificate,
      elapsedMs
    };
  } catch (error) {
    if (error?.cancelled) {
      await setBadge("");
      await setState("ready", `Sélection annulée. Prêt pour une capture ${format.label}.`, {
        progress: 0,
        formatId: format.id
      });
      throw error;
    }
    const message = friendlyError(error);
    await setBadge("!", "#dc2626");
    await setState("error", message, {
      progress: 0,
      formatId: format.id,
      technicalError: String(error?.message || error || "Erreur inconnue")
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 7000);
    throw new Error(message);
  } finally {
    if (attached) {
      if (scriptExecutionDisabled) {
        try { await sendCommand(target, "Emulation.setScriptExecutionDisabled", { value: false }); } catch {}
      }
      if (initialized?.source && metricsOverridden) {
        try {
          await sendCommand(target, "Emulation.setDeviceMetricsOverride", {
            width: initialized.source.width,
            height: initialized.source.height,
            deviceScaleFactor: initialized.source.devicePixelRatio,
            mobile: false,
            screenWidth: initialized.source.screenWidth,
            screenHeight: initialized.source.screenHeight,
            positionX: 0,
            positionY: 0
          });
        } catch {}
      }
      if (pageTouched) await restorePage(target, stateKey);
      if (metricsOverridden) {
        try { await sendCommand(target, "Emulation.clearDeviceMetricsOverride"); } catch {}
      }
      try { await chrome.debugger.detach(target); } catch {}
    } else if (pageTouched) {
      await restorePageWithoutDebugger(tab.id, stateKey);
    }
    if (activeSelectionTabId === tab.id) activeSelectionTabId = null;
    captureInProgress = false;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function cropVisibleReference(dataURL, source, selection) {
  const response = await fetch(dataURL);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scaleX = bitmap.width / source.width;
    const scaleY = bitmap.height / source.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      throw new Error("Impossible de mesurer la capture de référence.");
    }
    const outputWidth = Math.max(1, Math.round(selection.width * scaleX));
    const outputHeight = Math.max(1, Math.round(selection.height * scaleY));
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Impossible de préparer la capture de référence.");
    context.drawImage(
      bitmap,
      selection.left * scaleX,
      selection.top * scaleY,
      selection.width * scaleX,
      selection.height * scaleY,
      0,
      0,
      outputWidth,
      outputHeight
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      width: outputWidth,
      height: outputHeight,
      scaleX,
      scaleY
    };
  } finally {
    try { bitmap.close(); } catch {}
  }
}

async function captureVisibleReference(tab, source, selection) {
  const maximumAttempts = 6;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const waitMs = lastVisibleCaptureAt + VISIBLE_CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastVisibleCaptureAt = Date.now();
    try {
      const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return cropVisibleReference(dataURL, source, selection);
    } catch (error) {
      const retryable = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|image readback failed|readback|temporary|temporarily unavailable/i
        .test(String(error?.message || error));
      if (!retryable || attempt === maximumAttempts - 1) {
        throw error;
      }
      await sleep(VISIBLE_CAPTURE_MIN_INTERVAL_MS);
    }
  }
  throw new Error("Chrome n’a pas pu produire la référence visible.");
}

async function waitForStableVisibleReference(tab, source, selection, deadline) {
  let previous = null;
  let lastComparison = null;
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS; attempt += 1) {
    const current = await withTimeout(
      captureVisibleReference(tab, source, selection),
      Math.min(2500, remainingTime(deadline)),
      "La référence visible n’a pas pu être capturée à temps."
    );
    if (previous) {
      lastComparison = await withTimeout(
        compareControlRasters(previous.data, current.data),
        Math.min(1800, remainingTime(deadline)),
        "Le contrôle de la référence visible a dépassé le délai autorisé."
      );
      if (lastComparison.stable) {
        return { reference: current, attempts: attempt, comparison: lastComparison };
      }
    }
    previous = current;
    await sleep(STABILITY_INTERVAL_MS);
  }
  throw new Error(
    "Certification refusée : la page visible ne se stabilise pas après " +
    STABILITY_ATTEMPTS + " contrôles. Dernier écart moyen " +
    ((lastComparison?.meanDifference || 0) * 100).toFixed(3) + " %, pixels modifiés " +
    ((lastComparison?.changedPixelRatio || 0) * 100).toFixed(2) + " %."
  );
}

function hiddenFingerprintExpression(selection) {
  return `(() => {
    const selection = ${JSON.stringify(selection)};
    const quantize = (value) => Math.round(Number(value || 0) * 4) / 4;
    const parts = [location.href, innerWidth, innerHeight, scrollX, scrollY,
      selection.left, selection.top, selection.width, selection.height];
    let visibleCount = 0;
    const nodes = [document.documentElement, document.body, ...document.querySelectorAll("body *")];
    for (const element of nodes) {
      if (visibleCount >= 900) break;
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.right <= selection.left || rect.bottom <= selection.top ||
          rect.left >= selection.left + selection.width || rect.top >= selection.top + selection.height) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const leafText = element.childElementCount === 0
        ? String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 96) : "";
      parts.push([element.localName, quantize(rect.left), quantize(rect.top), quantize(rect.width),
        quantize(rect.height), style.position, style.display, style.visibility, style.opacity,
        style.transform, style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight,
        style.color, style.backgroundColor, style.objectFit, leafText].join("~"));
      visibleCount += 1;
    }
    const serialized = parts.join("|");
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < serialized.length; index += 1) {
      const code = serialized.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second = ((second << 5) + second) ^ code;
    }
    return { signature: (first >>> 0).toString(16) + "-" + (second >>> 0).toString(16) + "-" + serialized.length,
      visibleCount, width: innerWidth, height: innerHeight, scrollX, scrollY,
      url: location.href, dpr: devicePixelRatio };
  })()`;
}

function hiddenBootstrapScript(source, mirrorState) {
  const expectedOrigin = new URL(source.url).origin;
  return `(() => {
    if (location.origin !== ${JSON.stringify(expectedOrigin)}) return;
    const entries = ${JSON.stringify(mirrorState?.sessionStorageEntries || [])};
    try { for (const [key, value] of entries) sessionStorage.setItem(key, value); } catch {}
  })()`;
}

function restoreHiddenPageExpression(source, selection, mirrorState) {
  return `(async () => {
    const source = ${JSON.stringify(source)};
    const state = ${JSON.stringify(mirrorState || {})};
    const locate = (locator) => {
      if (!locator) return null;
      if (locator.id) {
        const byId = document.getElementById(locator.id);
        if (byId) return byId;
      }
      try { return locator.path ? document.querySelector(locator.path) : null; } catch { return null; }
    };
    for (const item of state.details || []) {
      const element = locate(item.locator);
      if (element instanceof HTMLDetailsElement) element.open = Boolean(item.open);
    }
    for (const item of state.controls || []) {
      const element = locate(item.locator);
      if (!element) continue;
      try { if (item.value !== null && "value" in element) element.value = item.value; } catch {}
      try { if (item.checked !== null && "checked" in element) element.checked = item.checked; } catch {}
      try { if (item.selectedIndex !== null && "selectedIndex" in element) element.selectedIndex = item.selectedIndex; } catch {}
      try { if (item.html !== null && element.matches("[contenteditable=true]")) element.innerHTML = item.html; } catch {}
    }
    for (const item of state.scrollables || []) {
      const element = locate(item.locator);
      if (!element) continue;
      try { element.scrollLeft = item.scrollLeft; element.scrollTop = item.scrollTop; } catch {}
    }
    for (const item of state.media || []) {
      const element = locate(item.locator);
      if (!(element instanceof HTMLMediaElement)) continue;
      try {
        element.muted = item.muted;
        element.volume = item.volume;
        element.playbackRate = item.playbackRate;
        if (Number.isFinite(item.currentTime)) element.currentTime = item.currentTime;
        element.pause();
      } catch {}
    }
    const style = document.createElement("style");
    style.id = "capture8k-hidden-freeze";
    style.textContent = "*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important}html{scroll-behavior:auto!important}";
    (document.head || document.documentElement).appendChild(style);
    try {
      for (const animation of document.getAnimations({ subtree: true })) animation.pause();
    } catch {}
    for (const media of document.querySelectorAll("video,audio")) {
      try { media.pause(); } catch {}
    }
    scrollTo(source.scrollX, source.scrollY);
    await Promise.race([
      Promise.allSettled([
        document.fonts?.ready || Promise.resolve(),
        ...[...document.images].slice(0, 160).map((image) => image.decode?.().catch(() => undefined))
      ]),
      new Promise((resolve) => setTimeout(resolve, 1100))
    ]);
    for (const item of state.scrollables || []) {
      const element = locate(item.locator);
      if (element) { element.scrollLeft = item.scrollLeft; element.scrollTop = item.scrollTop; }
    }
    scrollTo(source.scrollX, source.scrollY);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ready: document.readyState, url: location.href, width: innerWidth, height: innerHeight,
      scrollX, scrollY, dpr: devicePixelRatio, selection: ${JSON.stringify(selection)} };
  })()`;
}

async function waitForHiddenPageReady(target, expectedURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const evaluated = await sendCommand(target, "Runtime.evaluate", {
        expression: "({ready:document.readyState,url:location.href,width:innerWidth,height:innerHeight})",
        returnByValue: true
      });
      last = evaluated?.result?.value;
      if (last?.ready === "complete" && last.url === expectedURL) return last;
    } catch {}
    await sleep(120);
  }
  throw new Error(`La copie cachée n’a pas fini de charger : ${last?.url || expectedURL}`);
}

async function evaluateHidden(target, expression, awaitPromise = false) {
  const evaluated = await sendCommand(target, "Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (evaluated?.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.text || "Une étape du rendu caché a échoué.");
  }
  return evaluated?.result?.value;
}

function hiddenScreenshotParameters(plan) {
  return {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
    clip: {
      x: plan.pageX,
      y: plan.pageY,
      width: plan.width,
      height: plan.height,
      scale: 1
    }
  };
}

async function captureHiddenPNG(target, plan, timeoutMs, message) {
  const screenshot = await withTimeout(
    sendCommand(target, "Page.captureScreenshot", hiddenScreenshotParameters(plan)),
    timeoutMs,
    message
  );
  if (!screenshot?.data) throw new Error("Chrome n’a retourné aucune image depuis la cible cachée.");
  return screenshot.data;
}

async function saveCertifiedCaptureViaNative({ tab, format, reference, baseline, render, certificate }) {
  const port = connectNativeHost();
  if (!port || !nativeConnected) throw new Error(nativeConnectionError);
  const jobId = crypto.randomUUID();
  const filename = `${safeFilenamePart(tab.title)}-${timestamp()}-visible-${format.width}x${format.height}-certifie.png`;
  const readyPromise = waitForNativeMessage(
    (message) => message?.type === "save-ready" && message.jobId === jobId,
    2500,
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

  const completionPromise = waitForNativeMessage(
    (message) => message?.type === "save-complete" && message.jobId === jobId,
    30000,
    "La validation native a dépassé le délai autorisé."
  );
  try {
    for (const [kind, base64] of Object.entries({ reference, baseline, render })) {
      for (let offset = 0; offset < base64.length; offset += NATIVE_CHUNK_LENGTH) {
        port.postMessage({ type: "save-chunk", jobId, kind, data: base64.slice(offset, offset + NATIVE_CHUNK_LENGTH) });
      }
    }
    port.postMessage({ type: "save-end", jobId });
    const completed = await completionPromise;
    if (!completed.ok) throw new Error(completed.error || "Le contrôle de fidélité a refusé cette capture.");
    return completed;
  } catch (error) {
    try { port.postMessage({ type: "save-cancel", jobId }); } catch {}
    throw error;
  }
}

async function captureTabBackgroundLegacy(tab, requestedFormatId) {
  const format = resolveFormat(requestedFormatId);
  if (captureInProgress) throw new Error("Une capture haute définition est déjà en cours.");
  captureInProgress = true;

  const stateKey = `__capture8k_${crypto.randomUUID().replace(/-/g, "")}`;
  let initialized = null;
  let visiblePageFrozen = false;
  let rendererTabId = null;
  let rendererAttached = false;
  let hiddenTarget = null;
  const startedAt = Date.now();

  try {
    await setBadge("APP", "#1d4ed8");
    await setState("working", "Connexion à l’app Capture8K…", { progress: 0.02, formatId: format.id });
    const nativeSettings = await ensureNativeHost();
    if (nativeSettings.browserCaptureModeReady !== true) {
      nativePort.postMessage({ type: "prepare-browser" });
      throw new Error(
        "Capture bloquée pour protéger la page : relance Chrome avec le bouton « Préparer Chrome », puis réessaie."
      );
    }
    if (nativeSettings.resolution && nativeSettings.resolution !== format.id) {
      await chrome.storage.local.set({ captureResolution: format.id });
      nativePort.postMessage({ type: "set-settings", resolution: format.id });
    }

    await setBadge("…", "#1d4ed8");
    await setState("working", `Préparation de la page visible en ${format.label}…`, {
      progress: 0.05,
      formatId: format.id
    });
    activeSelectionTabId = tab.id;
    initialized = await initializeVisiblePage(tab.id, stateKey, format);
    activeSelectionTabId = null;
    visiblePageFrozen = true;

    await setState("working", "Capture de la référence exacte…", { progress: 0.14, formatId: format.id });
    const reference = await captureVisibleReference(tab, initialized.source, initialized.selection);
    await restorePageWithoutDebugger(tab.id, stateKey);
    visiblePageFrozen = false;

    const source = initialized.source;
    const plan = createCapturePlan(source, initialized.selection, format);
    const viewport = viewportForPlan(plan);

    await setState("working", "Création du moteur Chrome en arrière-plan…", { progress: 0.22, formatId: format.id });
    const rendererTab = await chrome.tabs.create({
      windowId: tab.windowId,
      url: "about:blank",
      active: false,
      pinned: false
    });
    rendererTabId = rendererTab?.id;
    if (!rendererTabId) throw new Error("Chrome n’a pas créé l’onglet de rendu en arrière-plan.");
    hiddenTarget = { tabId: rendererTab.id };
    await chrome.debugger.attach(hiddenTarget, "1.3");
    rendererAttached = true;

    await sendCommand(hiddenTarget, "Page.enable");
    await sendCommand(hiddenTarget, "Runtime.enable");
    try { await sendCommand(hiddenTarget, "Page.setWebLifecycleState", { state: "active" }); } catch {}
    try { await sendCommand(hiddenTarget, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}

    const baselineMetrics = {
      width: source.width,
      height: source.height,
      deviceScaleFactor: source.devicePixelRatio,
      mobile: false,
      screenWidth: source.screenWidth,
      screenHeight: source.screenHeight,
      positionX: 0,
      positionY: 0,
      viewport
    };
    await sendCommand(hiddenTarget, "Emulation.setDeviceMetricsOverride", baselineMetrics);
    await sendCommand(hiddenTarget, "Page.addScriptToEvaluateOnNewDocument", {
      source: hiddenBootstrapScript(source, initialized.mirrorState)
    });
    await sendCommand(hiddenTarget, "Page.navigate", { url: source.url });
    await waitForHiddenPageReady(hiddenTarget, source.url, HIDDEN_LOAD_TIMEOUT_MS);

    await setState("working", "Restauration de l’état de la page…", { progress: 0.38, formatId: format.id });
    const restored = await evaluateHidden(
      hiddenTarget,
      restoreHiddenPageExpression(source, initialized.selection, initialized.mirrorState),
      true
    );
    if (
      restored?.url !== source.url || restored?.width !== source.width || restored?.height !== source.height ||
      Math.abs(restored?.scrollX - source.scrollX) > 1 || Math.abs(restored?.scrollY - source.scrollY) > 1
    ) {
      throw new Error("La copie cachée n’a pas retrouvé le même viewport que l’onglet visible.");
    }

    const baselineGeometry = await evaluateHidden(hiddenTarget, hiddenFingerprintExpression(initialized.selection));
    const baselineCountRatio = baselineGeometry?.visibleCount / Math.max(1, initialized.geometry.visibleCount);
    if (
      baselineGeometry?.url !== source.url || baselineGeometry?.width !== source.width ||
      baselineGeometry?.height !== source.height || Math.abs(baselineGeometry?.scrollX - source.scrollX) > 1 ||
      Math.abs(baselineGeometry?.scrollY - source.scrollY) > 1 ||
      !Number.isFinite(baselineCountRatio) || baselineCountRatio < 0.65 || baselineCountRatio > 1.35
    ) {
      throw new Error("La copie cachée ne reproduit pas la page visible. Aucun faux rendu n’a été enregistré.");
    }

    await sendCommand(hiddenTarget, "Emulation.setScriptExecutionDisabled", { value: true });
    scriptExecutionDisabled = true;
    const baselineA = await captureHiddenPNG(hiddenTarget, plan, 2200, "La copie cachée n’a pas pu être contrôlée.");
    await sleep(80);
    const baseline = await captureHiddenPNG(hiddenTarget, plan, 2200, "La copie cachée n’est pas stable.");
    const baselineStability = await compareControlRasters(baselineA, baseline);
    if (!baselineStability.stable) {
      throw new Error("La copie cachée bouge encore. Mets la vidéo en pause ou ferme les menus animés, puis réessaie.");
    }

    await setState("working", `Rerastérisation native ${format.label} dans Chrome…`, {
      progress: 0.58,
      formatId: format.id
    });
    await sendCommand(hiddenTarget, "Emulation.setDeviceMetricsOverride", {
      ...baselineMetrics,
      deviceScaleFactor: plan.nativeDeviceScaleFactor
    });
    await sleep(150);
    const highGeometry = await evaluateHidden(hiddenTarget, hiddenFingerprintExpression(initialized.selection));
    const highCountRatio = highGeometry?.visibleCount / Math.max(1, baselineGeometry.visibleCount);
    if (
      highGeometry?.width !== baselineGeometry.width || highGeometry?.height !== baselineGeometry.height ||
      Math.abs(highGeometry?.scrollX - baselineGeometry.scrollX) > 1 ||
      Math.abs(highGeometry?.scrollY - baselineGeometry.scrollY) > 1 ||
      !Number.isFinite(highCountRatio) || highCountRatio < 0.9 || highCountRatio > 1.1
    ) {
      throw new Error("La densité haute résolution a modifié la mise en page. Le résultat a été refusé.");
    }
    if (Math.abs(highGeometry.dpr - plan.nativeDeviceScaleFactor) > 0.02) {
      throw new Error("Chrome n’a pas appliqué la densité native demandée.");
    }

    const render = await captureHiddenPNG(
      hiddenTarget,
      plan,
      Math.max(3500, CAPTURE_DEADLINE_MS - (Date.now() - startedAt)),
      `Chrome n’a pas terminé le rendu ${format.label}.`
    );
    const dimensions = decodePNGHeader(render);
    if (dimensions.width !== format.width || dimensions.height !== format.height) {
      throw new Error(`Chrome a produit ${dimensions.width} × ${dimensions.height} au lieu de ${format.width} × ${format.height}.`);
    }

    await setState("working", "Vérification indépendante et enregistrement…", {
      progress: 0.82,
      formatId: format.id
    });
    const certificate = {
      certified: true,
      native: true,
      hiddenRenderer: true,
      backgroundRendererTab: true,
      visibleTabDprUntouched: true,
      selectedArea: false,
      automaticVisibleViewport: true,
      upscale: false,
      nativeDeviceScaleFactor: plan.nativeDeviceScaleFactor,
      geometrySignature: highGeometry.signature,
      baselineStable: true,
      referenceWidth: reference.width,
      referenceHeight: reference.height
    };
    const saved = await saveCertifiedCaptureViaNative({
      tab,
      format,
      reference: reference.data,
      baseline,
      render,
      certificate
    });
    const elapsedMs = Date.now() - startedAt;

    await setBadge("✓", "#0f9d68");
    await setState("done", `Page visible ${format.label} certifiée et enregistrée (${(elapsedMs / 1000).toFixed(1)} s).`, {
      progress: 1,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height,
      path: saved.path,
      certificate: {
        ...certificate,
        mirrorMeanDifference: saved.mirrorMeanDifference,
        mirrorChangedPixelRatio: saved.mirrorChangedPixelRatio,
        mirrorEdgeMismatch: saved.mirrorEdgeMismatch,
        renderMeanDifference: saved.renderMeanDifference,
        renderChangedPixelRatio: saved.renderChangedPixelRatio,
        renderEdgeMismatch: saved.renderEdgeMismatch,
        elapsedMs
      }
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
    return {
      ok: true,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height,
      path: saved.path,
      renderMethod: "chrome-background-tab-native-dpr",
      ...certificate,
      elapsedMs
    };
  } catch (error) {
    if (error?.cancelled) {
      await setBadge("");
      await setState("ready", `Sélection annulée. Prêt pour une capture ${format.label}.`, {
        progress: 0,
        formatId: format.id
      });
      throw error;
    }
    const message = friendlyError(error);
    await setBadge("!", "#dc2626");
    await setState("error", message, {
      progress: 0,
      formatId: format.id,
      technicalError: String(error?.message || error || "Erreur inconnue")
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 7000);
    throw new Error(message);
  } finally {
    if (visiblePageFrozen) await restorePageWithoutDebugger(tab.id, stateKey);
    if (hiddenTarget && scriptExecutionDisabled) {
      try { await sendCommand(hiddenTarget, "Emulation.setScriptExecutionDisabled", { value: false }); } catch {}
    }
    if (rendererAttached && hiddenTarget) {
      try { await chrome.debugger.detach(hiddenTarget); } catch {}
    }
    if (rendererTabId !== null) {
      try { await chrome.tabs.remove(rendererTabId); } catch {}
    }
    if (activeSelectionTabId === tab.id) activeSelectionTabId = null;
    captureInProgress = false;
  }
}

function directScreenshotParameters(plan, scale = 1) {
  return {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
    clip: {
      x: plan.capturePageX ?? plan.pageX,
      y: plan.capturePageY ?? plan.pageY,
      width: plan.captureWidth ?? plan.width,
      height: plan.captureHeight ?? plan.height,
      scale
    }
  };
}

async function captureDirectPNG(target, plan, scale, timeoutMs, message) {
  const screenshot = await withTimeout(
    sendCommand(target, "Page.captureScreenshot", directScreenshotParameters(plan, scale)),
    timeoutMs,
    message
  );
  if (!screenshot?.data) throw new Error("Chrome n’a retourné aucune image de la page visible.");
  return screenshot.data;
}

async function assertStableRasterPair(first, second, deadline, message) {
  const comparison = await withTimeout(
    compareControlRasters(first, second),
    Math.min(1800, remainingTime(deadline)),
    "Le contrôle visuel a dépassé le délai autorisé."
  );
  if (!comparison.stable) {
    throw new Error(
      message + " Écart moyen " + (comparison.meanDifference * 100).toFixed(3) +
      " %, pixels modifiés " + (comparison.changedPixelRatio * 100).toFixed(2) + " %."
    );
  }
  return comparison;
}

async function assertEquivalentRasterPair(first, second, deadline, message, candidateRegions = []) {
  const comparison = await withTimeout(
    compareControlRasters(first, second),
    Math.min(1800, remainingTime(deadline)),
    "Le contrôle d’équivalence visuelle a dépassé le délai autorisé."
  );
  const equivalent =
    comparison.meanDifference <= 0.010 &&
    comparison.changedPixelRatio <= 0.10;
  if (equivalent) return { ...comparison, compositedRegions: [], maskedComparison: null };

  const regions = normalizedSurfaceRegions(candidateRegions);
  const maskedComparison = regions.length ? await withTimeout(
    compareControlRasters(first, second, regions),
    Math.min(1800, remainingTime(deadline)),
    "Le contrôle des surfaces intégrées a dépassé le délai autorisé."
  ) : null;
  // captureVisibleTab et Page.captureScreenshot n'emploient pas exactement le
  // même chemin d'anticrénelage avec un zoom navigateur non entier. La moyenne
  // reste très faible, mais de nombreux pixels de texte peuvent dépasser le
  // seuil binaire de 10 niveaux. Les contours et la géométrie sont revérifiés
  // indépendamment par l'hôte natif avant tout enregistrement.
  const maskedEquivalent = maskedComparison &&
    maskedComparison.meanDifference <= 0.010 &&
    maskedComparison.changedPixelRatio <= 0.10;
  if (!maskedEquivalent || maskedComparison.excludedPixelRatio > 0.6) {
    throw new Error(
      message + " Écart moyen " + (comparison.meanDifference * 100).toFixed(3) +
      " %, pixels modifiés " + (comparison.changedPixelRatio * 100).toFixed(2) + " %."
    );
  }
  return { ...comparison, compositedRegions: regions, maskedComparison };
}

async function waitForStableDirectBaseline(target, plan, deadline) {
  let previous = null;
  let lastComparison = null;
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS; attempt += 1) {
    const current = await captureDirectPNG(
      target,
      plan,
      1,
      Math.min(3000, remainingTime(deadline)),
      "La page visible n’est pas stable."
    );
    if (previous) {
      lastComparison = await withTimeout(
        compareControlRasters(previous, current),
        Math.min(1800, remainingTime(deadline)),
        "Le contrôle du témoin interne a dépassé le délai autorisé."
      );
      if (lastComparison.stable) {
        return { baseline: current, attempts: attempt, comparison: lastComparison };
      }
    }
    previous = current;
    await sleep(STABILITY_INTERVAL_MS);
  }
  throw new Error(
    "Certification refusée : le rendu interne ne se stabilise pas après " +
    STABILITY_ATTEMPTS + " contrôles. Dernier écart moyen " +
    ((lastComparison?.meanDifference || 0) * 100).toFixed(3) + " %, pixels modifiés " +
    ((lastComparison?.changedPixelRatio || 0) * 100).toFixed(2) + " %."
  );
}

async function captureTab(tab, requestedFormatId) {
  const format = resolveFormat(requestedFormatId);
  if (captureInProgress) throw new Error("Une capture haute définition est déjà en cours.");
  captureInProgress = true;

  const stateKey = `__capture8k_${crypto.randomUUID().replace(/-/g, "")}`;
  const target = { tabId: tab.id };
  let visiblePageFrozen = false;
  let attached = false;
  const startedAt = Date.now();
  const deadline = startedAt + CAPTURE_DEADLINE_MS;

  try {
    await setBadge("APP", "#1d4ed8");
    await setState("working", "Connexion à l’app Capture8K…", { progress: 0.03, formatId: format.id });
    const nativeSettings = await ensureNativeHost();
    if (nativeSettings.browserCaptureModeReady !== true) {
      nativePort.postMessage({ type: "prepare-browser" });
      throw new Error(
        "Capture bloquée pour protéger la page : relance Chrome avec le bouton « Préparer Chrome », puis réessaie."
      );
    }
    if (nativeSettings.resolution && nativeSettings.resolution !== format.id) {
      await chrome.storage.local.set({ captureResolution: format.id });
      nativePort.postMessage({ type: "set-settings", resolution: format.id });
    }

    await setBadge("…", "#1d4ed8");
    await setState("working", `Stabilisation de la page visible en ${format.label}…`, {
      progress: 0.1,
      formatId: format.id
    });
    let initialized = await initializeDirectVisiblePage(tab.id, stateKey, format);
    visiblePageFrozen = true;
    let source = initialized.source;
    let plan = createCapturePlan(source, initialized.selection, format);

    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await sendCommand(target, "Page.enable");
    await sendCommand(target, "Runtime.enable");

    // Les applications web peuvent remplacer leur document au moment où leur
    // route ou leur authentification se termine. Dans ce cas, l'état injecté
    // appartient à l'ancien contexte. On prépare automatiquement le nouveau
    // document au lieu de refuser une page pourtant capturable.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await geometrySnapshot(target, stateKey);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(350);
        initialized = await initializeDirectVisiblePage(tab.id, stateKey, format);
        source = initialized.source;
        plan = createCapturePlan(source, initialized.selection, format);
      }
    }
    let browserZoom = 1;
    try {
      const measuredZoom = await chrome.tabs.getZoom(tab.id);
      if (Number.isFinite(measuredZoom) && measuredZoom > 0) browserZoom = measuredZoom;
    } catch {}
    const stableGeometry = await waitForStableGeometry(target, stateKey, source, deadline);
    const geometryBefore = stableGeometry.geometry;
    const layoutBefore = await readLayoutMetrics(target);
    const stableReference = await waitForStableVisibleReference(
      tab, source, initialized.selection, deadline
    );
    const reference = stableReference.reference;
    const referenceStability = stableReference.comparison;
    plan = alignPlanToVisibleReference(plan, reference, source, browserZoom);

    await setState("working", "Contrôle du rendu exact déjà affiché…", {
      progress: 0.3,
      formatId: format.id
    });
    const stableBaseline = await waitForStableDirectBaseline(target, plan, deadline);
    const baseline = stableBaseline.baseline;
    const baselineStability = stableBaseline.comparison;
    const mirrorStability = await assertEquivalentRasterPair(
      reference.data,
      baseline,
      deadline,
      "Certification refusée : le témoin interne ne correspond pas à la page réellement visible.",
      initialized.compositedRegions
    );
    const compositedRegions = mirrorStability.compositedRegions;

    const baselineDimensions = decodePNGHeader(baseline);
    const outputFormat = renderedViewportFormat(format, baselineDimensions);
    const pageScaleFactor = outputFormat.pageScaleFactor;

    await setState("working", `Rerastérisation du plein cadre en ${outputFormat.width} × ${outputFormat.height}…`, {
      progress: 0.58,
      formatId: format.id
    });
    const render = await captureDirectPNG(
      target,
      plan,
      pageScaleFactor,
      remainingTime(deadline),
      `Chrome n’a pas terminé le rendu ${format.label}.`
    );
    const dimensions = decodePNGHeader(render);
    if (dimensions.width !== outputFormat.width || dimensions.height !== outputFormat.height) {
      throw new Error(`Chrome a produit ${dimensions.width} × ${dimensions.height} au lieu de ${outputFormat.width} × ${outputFormat.height}.`);
    }

    const baselineAfterRender = await captureDirectPNG(
      target, plan, 1, Math.min(3000, remainingTime(deadline)), "Le contrôle final n’a pas abouti."
    );
    const postRenderStability = await assertStableRasterPair(
      baseline,
      baselineAfterRender,
      deadline,
      "Certification refusée : le document a changé pendant le rendu haute définition."
    );
    const geometryAfter = await geometrySnapshot(target, stateKey);
    assertCompatibleGeometry(geometryAfter, source, source.devicePixelRatio);
    const geometrySignatureStable = geometryAfter.signature === geometryBefore.signature;
    const layoutAfter = await readLayoutMetrics(target);
    assertSameLayoutMetrics(layoutBefore, layoutAfter);
    const documentExtentStable = sameDocumentExtent(layoutBefore, layoutAfter);

    await chrome.debugger.detach(target);
    attached = false;
    await restorePageWithoutDebugger(tab.id, stateKey);
    visiblePageFrozen = false;

    await setState("working", "Vérification indépendante et enregistrement…", {
      progress: 0.82,
      formatId: format.id
    });
    const certificate = {
      certified: true,
      native: true,
      directVisibleRenderer: true,
      sameDocument: true,
      hiddenRenderer: false,
      backgroundRendererTab: false,
      visibleTabDprUntouched: true,
      deviceMetricsOverrideApplied: false,
      browserZoomPreserved: true,
      browserZoom,
      baseDeviceScaleFactor: plan.baseDeviceScaleFactor,
      selectedArea: false,
      automaticVisibleViewport: true,
      fullVisibleViewport: true,
      aspectRatioPreserved: true,
      targetLongEdge: format.longEdge,
      sourceViewportWidth: source.width,
      sourceViewportHeight: source.height,
      outputWidth: outputFormat.width,
      outputHeight: outputFormat.height,
      upscale: false,
      pageScaleFactor,
      geometrySignature: geometryAfter.signature,
      geometrySignatureStable,
      visibleViewportMetricsStable: true,
      documentExtentStable,
      geometryStabilityAttempts: stableGeometry.attempts,
      referenceStabilityAttempts: stableReference.attempts,
      baselineStabilityAttempts: stableBaseline.attempts,
      embeddedFrameCount: initialized.embeddedFrameCount,
      embeddedFramesFrozen: initialized.embeddedFramesFrozen,
      baselineStable: true,
      referenceRasterStable: true,
      preAndPostRenderStable: true,
      referenceMeanDifference: referenceStability.meanDifference,
      baselineMeanDifference: baselineStability.meanDifference,
      mirrorMeanDifference: mirrorStability.meanDifference,
      mirrorOutsideMeanDifference: mirrorStability.maskedComparison?.meanDifference ?? mirrorStability.meanDifference,
      mirrorOutsideChangedPixelRatio: mirrorStability.maskedComparison?.changedPixelRatio ?? mirrorStability.changedPixelRatio,
      compositedSurfaceFallback: compositedRegions.length > 0,
      compositedRegions,
      postRenderMeanDifference: postRenderStability.meanDifference,
      scriptSuspendedDuringRaster: false,
      scriptsLeftRunningForCompatibility: true,
      referenceWidth: reference.width,
      referenceHeight: reference.height
    };
    const saved = await saveCertifiedCaptureViaNative({
      tab,
      format: outputFormat,
      reference: reference.data,
      baseline,
      render,
      certificate
    });
    const elapsedMs = Date.now() - startedAt;

    await setBadge("✓", "#0f9d68");
    await setState("done", `Page visible ${format.label} certifiée et enregistrée (${(elapsedMs / 1000).toFixed(1)} s).`, {
      progress: 1,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height,
      path: saved.path,
      certificate: {
        ...certificate,
        mirrorMeanDifference: saved.mirrorMeanDifference,
        mirrorChangedPixelRatio: saved.mirrorChangedPixelRatio,
        mirrorEdgeMismatch: saved.mirrorEdgeMismatch,
        renderMeanDifference: saved.renderMeanDifference,
        renderChangedPixelRatio: saved.renderChangedPixelRatio,
        renderEdgeMismatch: saved.renderEdgeMismatch,
        elapsedMs
      }
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
    return {
      ok: true,
      formatId: format.id,
      width: dimensions.width,
      height: dimensions.height,
      path: saved.path,
      renderMethod: "chrome-visible-tab-page-scale-native",
      ...certificate,
      elapsedMs
    };
  } catch (error) {
    const message = friendlyError(error);
    await setBadge("!", "#dc2626");
    await setState("error", message, {
      progress: 0,
      formatId: format.id,
      technicalError: String(error?.message || error || "Erreur inconnue")
    });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 7000);
    throw new Error(message);
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch {}
    }
    if (visiblePageFrozen) await restorePageWithoutDebugger(tab.id, stateKey);
    captureInProgress = false;
  }
}

async function captureActiveTab(formatId) {
  if (captureInProgress && activeSelectionTabId !== null) {
    await cancelPageSelector(activeSelectionTabId);
    for (let attempt = 0; attempt < 20 && captureInProgress; attempt += 1) {
      await sleep(25);
    }
  }
  const tab = await activeTab();
  return captureTab(tab, formatId);
}

async function savedFormatId() {
  const { captureResolution } = await chrome.storage.local.get("captureResolution");
  return resolveFormat(captureResolution).id;
}

chrome.runtime.onInstalled.addListener(async () => {
  const formatId = await savedFormatId();
  await chrome.storage.local.set({ captureResolution: formatId });
  await chrome.storage.session.set({
    capture8kState: {
      type: "capture8k-status",
      state: "ready",
      message: `Prêt à capturer la page visible en ${resolveFormat(formatId).label}.`,
      progress: 0,
      formatId,
      updatedAt: Date.now()
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture-visible") return;
  savedFormatId()
    .then((formatId) => captureActiveTab(formatId))
    .catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture8k-start") {
    const formatId = resolveFormat(message.formatId).id;
    chrome.storage.local.set({ captureResolution: formatId });
    captureActiveTab(formatId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        cancelled: Boolean(error?.cancelled),
        error: friendlyError(error)
      }));
    return true;
  }
  if (message?.type === "capture8k-native-status") {
    ensureNativeHost()
      .then((settings) => sendResponse({
        connected: true,
        outputDirectory: settings.outputDirectory,
        formatId: resolveFormat(settings.resolution).id,
        browserCaptureModeReady: settings.browserCaptureModeReady === true,
        browserName: settings.browserName || "Google Chrome"
      }))
      .catch((error) => sendResponse({ connected: false, error: friendlyError(error) }));
    return true;
  }
  if (message?.type === "capture8k-open-app") {
    ensureNativeHost()
      .then((settings) => {
        nativePort.postMessage({
          type: settings.browserCaptureModeReady === true ? "open-app" : "prepare-browser"
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }
  if (message?.type === "capture8k-choose-folder") {
    ensureNativeHost()
      .then(() => {
        const reply = waitForNativeMessage(
          (nativeMessage) => nativeMessage?.type === "folder-picker-opened",
          1800,
          "L’app Capture8K n’a pas ouvert le sélecteur de dossier."
        );
        nativePort.postMessage({ type: "choose-folder" });
        return reply;
      })
      .then((nativeReply) => sendResponse({ ok: nativeReply?.ok === true }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }
  if (message?.type === "capture8k-set-format") {
    const formatId = resolveFormat(message.formatId).id;
    chrome.storage.local.set({ captureResolution: formatId });
    ensureNativeHost()
      .then(() => {
        nativePort.postMessage({ type: "set-settings", resolution: formatId });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }
  return false;
});

connectNativeHost();
