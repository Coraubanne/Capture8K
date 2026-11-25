import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../build/Capture8K.app", import.meta.url));
const hostPath = join(appRoot, "Contents/MacOS/Capture8KNativeHost");
const imagePath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../../tests/fixtures/native-8k.png", import.meta.url));
const image = await readFile(imagePath);
const baselinePathArgument = process.argv.find(argument => argument.startsWith("--baseline="));
const baselineImage = baselinePathArgument ? await readFile(resolve(baselinePathArgument.slice(11))) : image;
const expectRefusal = process.argv.includes("--expect-refusal");
const useSurfaceMask = process.argv.includes("--surface-mask");
const expectedWidth = image.readUInt32BE(16);
const expectedHeight = image.readUInt32BE(20);
const temporaryRoot = await mkdtemp(join(tmpdir(), "capture8k-host-test-"));
const outputDirectory = join(temporaryRoot, "output");
const settingsPath = join(temporaryRoot, "settings.json");
await writeFile(settingsPath, JSON.stringify({ resolution: "8k", outputDirectory, copyToClipboard: false }));
const premiereBridge = join(temporaryRoot, "CreatorBridge");
const premiereProjectDirectory = join(temporaryRoot, "PremiereProject");
const premiereProject = join(premiereProjectDirectory, "Test.prproj");
await mkdir(premiereBridge, { recursive: true });
await mkdir(premiereProjectDirectory, { recursive: true });
await writeFile(premiereProject, "");
await writeFile(join(premiereBridge, "active-project.json"), JSON.stringify({
  projectPath: premiereProject,
  projectName: "Test",
  updatedAt: Date.now()
}));

const child = spawn(hostPath, ["chrome-extension://test/"], {
  env: {
    ...process.env,
    CAPTURE8K_SETTINGS_PATH: settingsPath,
    CAPTURE8K_PREMIERE_BRIDGE_PATH: premiereBridge
  },
  stdio: ["pipe", "pipe", "pipe"]
});

let incoming = Buffer.alloc(0);
const messages = [];
const waiters = [];

function consume() {
  while (incoming.length >= 4) {
    const length = incoming.readUInt32LE(0);
    if (incoming.length < length + 4) return;
    const message = JSON.parse(incoming.subarray(4, length + 4).toString("utf8"));
    incoming = incoming.subarray(length + 4);
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }
}

child.stdout.on("data", chunk => { incoming = Buffer.concat([incoming, chunk]); consume(); });

function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  child.stdin.write(Buffer.concat([header, payload]));
}

function waitFor(predicate, timeout = 15000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolvePromise, rejectPromise) => {
    const waiter = { predicate, resolve: resolvePromise };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      rejectPromise(new Error(`Réponse native absente : ${JSON.stringify(messages)}`));
    }, timeout).unref();
  });
}

try {
  send({ type: "ping" });
  const settings = await waitFor(message => message.type === "settings");
  assert.equal(settings.resolution, "8k");
  assert.equal(settings.outputMode, "custom");
  assert.equal(settings.completionSound, true);
  send({ type: "set-completion-sound", enabled: false });
  const soundSetting = await waitFor(message => message.type === "completion-sound-status");
  assert.equal(soundSetting.ok, true);
  assert.equal(soundSetting.enabled, false);
  const updatedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(updatedSettings.completionSound, false);
  assert.equal(settings.outputDirectory, outputDirectory);
  assert.equal(typeof settings.browserCaptureModeReady, "boolean");
  assert.equal(typeof settings.browserName, "string");

  const jobId = "native-host-test";
  send({
    type: "save-begin", jobId, filename: "test-certifie.png", expectedWidth, expectedHeight,
    certificate: useSurfaceMask ? {
      compositedSurfaceFallback: true,
      compositedRegions: [{ x: 0, y: 0, width: 0.5, height: 0.5, kind: "video" }]
    } : {}
  });
  const ready = await waitFor(message => message.type === "save-ready" && message.jobId === jobId);
  assert.equal(ready.ok, true);

  const chunkSize = 1024 * 1024;
  for (const [kind, bytes] of [["reference", image], ["baseline", baselineImage], ["render", image]]) {
    const encoded = bytes.toString("base64");
    for (let offset = 0; offset < encoded.length; offset += chunkSize) {
      send({ type: "save-chunk", jobId, kind, data: encoded.slice(offset, offset + chunkSize) });
    }
  }
  send({ type: "save-end", jobId });
  const completed = await waitFor(message => message.type === "save-complete" && message.jobId === jobId, 30000);
  if (expectRefusal) {
    assert.equal(completed.ok, false, JSON.stringify(completed));
    assert.match(completed.error, /capture de contrôle diffère/);
    console.log(JSON.stringify({ nativeHost: "REFUS_OK", error: completed.error }));
  } else {
    assert.equal(completed.ok, true, JSON.stringify(completed));
    assert.equal(completed.width, expectedWidth);
    assert.equal(completed.height, expectedHeight);
    if (useSurfaceMask) assert.ok(completed.mirrorMeanDifference < 0.01);
    else assert.equal(completed.mirrorMeanDifference, 0);
    assert.equal(completed.renderMeanDifference, 0);
    assert.equal(completed.compositedSurfaceCount, useSurfaceMask ? 1 : 0);
    const outputFiles = await readdir(outputDirectory);
    assert.equal(outputFiles.length, 1);
    assert.equal(outputFiles[0], "test-certifie.png");
    send({ type: "set-settings", outputMode: "premiere" });
    const premiereSettings = await waitFor(message => message.type === "settings-changed" && message.outputMode === "premiere");
    assert.equal(premiereSettings.outputMode, "premiere");

    const premiereJobId = "premiere-import-test";
    send({ type: "save-begin", jobId: premiereJobId, filename: "premiere.png", expectedWidth, expectedHeight });
    await waitFor(message => message.type === "save-ready" && message.jobId === premiereJobId);
    for (const kind of ["reference", "baseline", "render"]) {
      const encoded = image.toString("base64");
      for (let offset = 0; offset < encoded.length; offset += chunkSize) {
        send({ type: "save-chunk", jobId: premiereJobId, kind, data: encoded.slice(offset, offset + chunkSize) });
      }
    }
    send({ type: "save-end", jobId: premiereJobId });
    const premiereCompleted = await waitFor(
      message => message.type === "save-complete" && message.jobId === premiereJobId,
      30000
    );
    assert.equal(premiereCompleted.ok, true, JSON.stringify(premiereCompleted));
    assert.equal(premiereCompleted.premiereImportQueued, true);
    assert.equal(premiereCompleted.path, join(premiereProjectDirectory, "Captures Capture8K", "premiere.png"));
    const importJob = JSON.parse(await readFile(
      join(premiereBridge, "Imports", `${premiereJobId}.json`), "utf8"
    ));
    assert.equal(importJob.producer, "capture8k");
    assert.equal(importJob.projectPath, premiereProject);
    console.log(JSON.stringify({ nativeHost: "OK", width: expectedWidth, height: expectedHeight, output: completed.path }));
  }
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}
