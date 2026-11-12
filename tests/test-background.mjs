import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const commands = [];
const events = [];
const nativeMessages = [];
const states = [];
let runtimeMessageListener;
let commandListener;
let nativeMessageListener;
let nativeDisconnectListener;
let currentDpr = 2;
let savedResolution = "8k";
let highGeometryMismatch = false;
let geometryReadCount = 0;
let captureCount = 0;
let browserCaptureModeReady = true;
let postRenderVisualMismatch = false;
let highRasterCaptured = false;
let replaceDocumentBeforeDebugger = false;
let preparationCount = 0;
let visibleQuotaFailures = 0;
let browserZoom = 1;

const SOURCE = Object.freeze({
  url: "https://app.frame.io/projects/abc",
  width: 1000,
  height: 700,
  scrollX: 15,
  scrollY: 240,
  devicePixelRatio: 2,
  screenWidth: 1512,
  screenHeight: 982,
  readyState: "complete",
  visibilityState: "visible"
});
const SELECTION = Object.freeze({ left: 0, top: 0, width: 1000, height: 700 });

function pngHeader(width, height, serial = 0) {
  const header = Buffer.alloc(40);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  header[29] = serial;
  return header;
}

globalThis.createImageBitmap = async (blob) => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return {
    width: bytes.length >= 24 ? bytes.readUInt32BE(16) : 2000,
    height: bytes.length >= 24 ? bytes.readUInt32BE(20) : 1400,
    visualValue: bytes[29] || 0,
    close() {}
  };
};

globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; this.visualValue = 0; }
  getContext() {
    return {
      clearRect: () => { this.visualValue = 0; },
      drawImage: bitmap => { this.visualValue = bitmap.visualValue || 0; },
      getImageData: () => {
        const data = new Uint8ClampedArray(this.width * this.height * 4);
        for (let index = 0; index < data.length; index += 4) {
          data[index] = this.visualValue;
          data[index + 1] = this.visualValue;
          data[index + 2] = this.visualValue;
          data[index + 3] = 255;
        }
        return { data };
      }
    };
  }
  async convertToBlob() {
    return new Blob([pngHeader(this.width, this.height, this.visualValue)], { type: "image/png" });
  }
};

const nativePort = {
  onMessage: { addListener: listener => { nativeMessageListener = listener; } },
  onDisconnect: { addListener: listener => { nativeDisconnectListener = listener; } },
  postMessage(message) {
    nativeMessages.push(message);
    if (message.type === "ping") {
      queueMicrotask(() => nativeMessageListener({
        type: "settings", resolution: savedResolution,
        outputDirectory: "/tmp/Capture8K", copyToClipboard: false,
        browserCaptureModeReady, browserName: "Google Chrome"
      }));
    }
    if (message.type === "set-settings") savedResolution = message.resolution;
    if (message.type === "choose-folder") {
      queueMicrotask(() => nativeMessageListener({ type: "folder-picker-opened", ok: true }));
    }
    if (message.type === "save-begin") {
      queueMicrotask(() => nativeMessageListener({ type: "save-ready", jobId: message.jobId, ok: true }));
    }
    if (message.type === "save-end") {
      queueMicrotask(() => nativeMessageListener({
        type: "save-complete", jobId: message.jobId, ok: true,
        path: `/tmp/Capture8K/test-${captureCount}.png`,
        mirrorMeanDifference: 0.004, renderMeanDifference: 0.008
      }));
    }
  }
};

globalThis.chrome = {
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  debugger: {
    attach: async target => { assert.deepEqual(target, { tabId: 42 }); events.push("debugger-attached"); },
    detach: async () => { events.push("debugger-detached"); },
    sendCommand: async (target, method, params = {}) => {
      commands.push({ target, method, params });
      if (method === "Runtime.evaluate") {
        if (params.expression.startsWith("({ready:document.readyState")) {
          return { result: { value: { ready: "complete", url: SOURCE.url, width: SOURCE.width, height: SOURCE.height } } };
        }
        if (params.expression.includes("const state =") && params.expression.includes("capture8k-hidden-freeze")) {
          return { result: { value: { ready: "complete", url: SOURCE.url, width: SOURCE.width, height: SOURCE.height,
            scrollX: SOURCE.scrollX, scrollY: SOURCE.scrollY, dpr: currentDpr, selection: SELECTION } } };
        }
        if (params.expression.includes("__capture8kGeometrySnapshot_v112") || params.expression.includes("const quantize =")) {
          geometryReadCount += 1;
          if (replaceDocumentBeforeDebugger && preparationCount < 2) {
            return { result: { value: null } };
          }
          const changed = highGeometryMismatch && geometryReadCount > 3;
          return { result: { value: {
            signature: changed ? "changed-layout" : "stable-layout",
            visibleCount: 84, width: SOURCE.width, height: SOURCE.height,
            scrollX: SOURCE.scrollX, scrollY: SOURCE.scrollY, url: SOURCE.url, dpr: currentDpr
          } } };
        }
        if (params.expression.includes("__capture8kRestorePage_v112")) events.push("visible-page-restored");
        return { result: { value: true } };
      }
      if (method === "Page.captureScreenshot") {
        captureCount += 1;
        const scale = params.clip.scale ?? 1;
        if (scale !== 1) highRasterCaptured = true;
        const visualValue = postRenderVisualMismatch && highRasterCaptured && scale === 1 ? 80 : 0;
        return { data: pngHeader(
          Math.round(params.clip.width * (SOURCE.devicePixelRatio / browserZoom) * scale),
          Math.round(params.clip.height * (SOURCE.devicePixelRatio / browserZoom) * scale),
          visualValue
        ).toString("base64") };
      }
      return {};
    }
  },
  commands: {
    onCommand: { addListener: listener => { commandListener = listener; } }
  },
  runtime: {
    lastError: null,
    connectNative: name => { assert.equal(name, "com.capture8k.native"); return nativePort; },
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: listener => { runtimeMessageListener = listener; } },
    sendMessage: async () => {}
  },
  scripting: {
    executeScript: async ({ func }) => {
      if (func.name === "prepareVisiblePageForCapture" || func.name === "prepareDirectVisiblePageForCapture") {
        preparationCount += 1;
        events.push("visible-page-prepared-and-frozen");
        return [{ result: {
          cancelled: false, selectedAt: Date.now(), source: { ...SOURCE }, selection: { ...SELECTION },
          geometry: { signature: "stable-layout", visibleCount: 84, ...SOURCE, dpr: 2 },
          mirrorState: { sessionStorageEntries: [], controls: [], details: [], scrollables: [], media: [] },
          frozen: { animationsPaused: 2, mediaPaused: 1, visibleImages: 4 }
        } }];
      }
      events.push("visible-page-restored");
      return [{ result: true }];
    }
  },
  storage: {
    local: {
      get: async () => ({ captureResolution: savedResolution }),
      set: async values => { if (values.captureResolution) savedResolution = values.captureResolution; }
    },
    session: { set: async ({ capture8kState }) => { states.push(capture8kState); } }
  },
  tabs: {
    getZoom: async tabId => { assert.equal(tabId, 42); return browserZoom; },
    query: async () => [{ id: 42, windowId: 9, title: "Frame.io — Projet privé", url: SOURCE.url }],
    create: async () => { throw new Error("Un onglet secondaire ne doit jamais être créé."); },
    remove: async () => { throw new Error("Aucun onglet secondaire ne doit être supprimé."); },
    captureVisibleTab: async (windowId, options) => {
      assert.equal(windowId, 9);
      assert.deepEqual(options, { format: "png" });
      if (visibleQuotaFailures > 0) {
        visibleQuotaFailures -= 1;
        throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
      }
      events.push("reference-captured");
      return `data:image/png;base64,${pngHeader(2000, 1400).toString("base64")}`;
    }
  }
};

await import(pathToFileURL(new URL("../Capture8K-Chrome/background.js", import.meta.url).pathname));
assert.equal(typeof runtimeMessageListener, "function");
assert.equal(typeof commandListener, "function");
assert.equal(typeof nativeDisconnectListener, "function");

function startCapture(formatId) {
  return new Promise(resolve => {
    const keepOpen = runtimeMessageListener({ type: "capture8k-start", formatId }, {}, resolve);
    assert.equal(keepOpen, true);
  });
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    const keepOpen = runtimeMessageListener(message, {}, resolve);
    assert.equal(keepOpen, true);
  });
}

nativeMessages.length = 0;
const folderPicker = await sendRuntimeMessage({ type: "capture8k-choose-folder" });
assert.equal(folderPicker.ok, true);
assert(nativeMessages.some(message => message.type === "choose-folder"));

for (const format of [
  { id: "4k", longEdge: 3840, width: 3840, height: 2688 },
  { id: "8k", longEdge: 7680, width: 7680, height: 5376 }
]) {
  commands.length = 0;
  events.length = 0;
  nativeMessages.length = 0;
  highGeometryMismatch = false;
  geometryReadCount = 0;
  currentDpr = 2;
  highRasterCaptured = false;
  preparationCount = 0;
  const response = await startCapture(format.id);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.width, format.width);
  assert.equal(response.height, format.height);
  assert.equal(response.hiddenRenderer, false);
  assert.equal(response.backgroundRendererTab, false);
  assert.equal(response.directVisibleRenderer, true);
  assert.equal(response.sameDocument, true);
  assert.equal(response.visibleTabDprUntouched, true);
  assert.equal(response.selectedArea, false);
  assert.equal(response.automaticVisibleViewport, true);
  assert.equal(response.fullVisibleViewport, true);
  assert.equal(response.aspectRatioPreserved, true);
  assert.equal(response.targetLongEdge, format.longEdge);
  assert.equal(response.sourceViewportWidth, SOURCE.width);
  assert.equal(response.sourceViewportHeight, SOURCE.height);
  assert.equal(response.upscale, false);
  assert.equal(response.renderMethod, "chrome-visible-tab-page-scale-native");
  assert(events.indexOf("debugger-attached") < events.indexOf("reference-captured"));
  assert(events.indexOf("reference-captured") < events.indexOf("visible-page-restored"));
  assert(events.includes("debugger-detached"));
  const metricCommands = commands.filter(command => command.method === "Emulation.setDeviceMetricsOverride");
  assert.equal(metricCommands.length, 0);
  assert.equal(response.deviceMetricsOverrideApplied, false);
  assert.equal(response.browserZoomPreserved, true);
  const screenshots = commands.filter(command => command.method === "Page.captureScreenshot");
  assert.equal(screenshots.length, 4);
  assert(screenshots.every(command => command.target.tabId === 42));
  assert.equal(screenshots[0].params.clip.scale, 1);
  assert.equal(screenshots[1].params.clip.scale, 1);
  assert.equal(screenshots[2].params.clip.scale, format.longEdge / (SELECTION.width * SOURCE.devicePixelRatio));
  assert.equal(screenshots[3].params.clip.scale, 1);
  assert.equal(events.filter(event => event === "reference-captured").length, 2);
  assert(nativeMessages.some(message => message.type === "save-begin"));
  assert(nativeMessages.some(message => message.type === "save-end"));
  assert(nativeMessages.filter(message => message.type === "save-chunk").length >= 3);
}

browserZoom = 1.1;
preparationCount = 0;
geometryReadCount = 0;
highRasterCaptured = false;
const zoomedPage = await startCapture("4k");
assert.equal(zoomedPage.ok, true);
assert.equal(zoomedPage.browserZoom, 1.1);
const zoomCapture = commands.filter(command => command.method === "Page.captureScreenshot" && command.params.clip.scale !== 1).at(-1);
assert(Math.abs(zoomCapture.params.clip.width - 1100) < 0.01);
assert(Math.abs(zoomCapture.params.clip.height - 770) < 0.01);
browserZoom = 1;

replaceDocumentBeforeDebugger = true;
preparationCount = 0;
geometryReadCount = 0;
highRasterCaptured = false;
const replacedDocument = await startCapture("4k");
assert.equal(replacedDocument.ok, true);
assert.equal(preparationCount, 2);
replaceDocumentBeforeDebugger = false;

visibleQuotaFailures = 1;
preparationCount = 0;
geometryReadCount = 0;
highRasterCaptured = false;
const quotaRecovered = await startCapture("4k");
assert.equal(quotaRecovered.ok, true);
assert.equal(visibleQuotaFailures, 0);

highGeometryMismatch = true;
geometryReadCount = 0;
currentDpr = 2;
highRasterCaptured = false;
const invisibleStructureChange = await startCapture("4k");
assert.equal(invisibleStructureChange.ok, true);
assert.equal(invisibleStructureChange.geometrySignatureStable, false);

highGeometryMismatch = false;
postRenderVisualMismatch = true;
geometryReadCount = 0;
highRasterCaptured = false;
const refused = await startCapture("4k");
assert.equal(refused.ok, false);
assert.match(refused.error, /document a changé/);
postRenderVisualMismatch = false;

const completedBeforeShortcut = states.filter(state => state.state === "done").length;
commandListener("capture-visible");
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (states.filter(state => state.state === "done").length > completedBeforeShortcut) break;
  await new Promise(resolve => setTimeout(resolve, 20));
}
assert.equal(states.filter(state => state.state === "done").length, completedBeforeShortcut + 1);
await new Promise(resolve => setTimeout(resolve, 50));

browserCaptureModeReady = false;
events.length = 0;
nativeMessages.length = 0;
const protectedPage = await startCapture("8k");
assert.equal(protectedPage.ok, false);
assert.match(protectedPage.error, /Capture bloquée/);
assert.equal(events.includes("debugger-attached"), false);
assert(nativeMessages.some(message => message.type === "prepare-browser"));
browserCaptureModeReady = true;

console.log("Capture8K 2.6.5 : zoom, plein cadre, dossier d’export et pont natif validés.");
