/** M20 red/green regressions. Runs actual models/controller/hook code with safe fakes. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MODEL_CATALOG } from "@contracts/ipc";
import {
  cancelDownload, downloadModel, getModelDirInfo, isDownloading,
  listModels, requireModelDir, setCustomModelRoot,
} from "../../src/main/voice/models.js";
import { onVoiceActiveChange, setVoiceActive } from "../../src/renderer/lib/voiceController.js";
import { useVoiceInput } from "../../src/renderer/hooks/useVoiceInput.js";
import { mountHook } from "./stubs/react.js";
import { cancelled, configureVoice, started } from "./stubs/api.js";

const data = mkdtempSync(join(tmpdir(), "mcode-m20-data-"));
const other = mkdtempSync(join(tmpdir(), "mcode-m20-other-"));
process.env.MCODE_M20_USER_DATA = data;
const realFetch = globalThis.fetch;
const modelA = VOICE_MODEL_CATALOG[0]!.id;
const modelB = VOICE_MODEL_CATALOG[1]!.id;
const origin = (url: unknown): string => {
  const s = String(url);
  assert.match(s, /^https:\/\/(huggingface\.co|hf-mirror\.com)\//,
    "test must intercept every catalog network request");
  return s;
};
const head = () => new Response(null, { status: 200, headers: { "content-length": "4" } });
const body = () => new Response(Uint8Array.of(1, 2, 3, 4), {
  status: 200, headers: { "content-length": "4" },
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), "the fake download reached the expected async boundary");
}
let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.error(`FAIL ${name}:`, e); }
}

try {
  await test("model root cannot switch while a download writes into the old root", async () => {
    let firstGet = false;
    let release: (() => void) | undefined;
    globalThis.fetch = async (url, init) => {
      origin(url);
      if (init?.method === "HEAD") return head();
      if (!firstGet) {
        firstGet = true;
        return new Promise<Response>((resolve) => { release = () => resolve(body()); });
      }
      return body();
    };
    const pending = downloadModel(modelA);
    try {
      await until(() => firstGet);
      assert.equal(isDownloading(modelA), true);
      let error = "";
      try { setCustomModelRoot(other); }
      catch (e) { error = String((e as Error).message); }
      assert.match(error, /下载/, "switch should be rejected, not strand the in-flight files");
      assert.equal(getModelDirInfo().isCustom, false);
    } finally {
      release?.();
      await pending.catch(() => {});
      setCustomModelRoot("");
    }
    assert.ok(listModels().downloaded.includes(modelA));
    assert.ok(requireModelDir(modelA));
  });

  await test("cancel aborts in-flight HEAD probes without waiting for probe timeout", async () => {
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    globalThis.fetch = async (url, init) => {
      origin(url);
      if (init?.method !== "HEAD") throw new Error("unexpected GET after cancel");
      const signal = init.signal!;
      signals.push(signal);
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("HEAD aborted")), { once: true });
        releases.push(() => resolve(head()));
      });
    };
    const pending = downloadModel(modelB);
    try {
      await until(() => signals.length === VOICE_MODEL_CATALOG[1]!.files.length);
      cancelDownload(modelB);
      assert.ok(signals.every((signal) => signal.aborted),
        "cancel must abort the HEAD requests rather than only the later GET");
    } finally {
      releases.forEach((release) => release());
      await pending.catch(() => {});
    }
    assert.equal(isDownloading(modelB), false);
  });

  // Set's owner scope is intentional: multiple composer panes remain mounted.
  const setOwnedActive = setVoiceActive as (active: boolean, owner: symbol) => void;
  await test("another pane going idle cannot hide this pane's active overlay", () => {
    const a = Symbol("A"), b = Symbol("B");
    const seen: boolean[] = [];
    const off = onVoiceActiveChange((active) => seen.push(active));
    try {
      setOwnedActive(true, a);
      setOwnedActive(false, b);
      assert.equal(seen.at(-1), true);
      setOwnedActive(false, a);
      assert.equal(seen.at(-1), false);
    } finally { setOwnedActive(false, a); setOwnedActive(false, b); off(); }
  });
  await test("overlay mounted after capture sees current active state", () => {
    const a = Symbol("A");
    setOwnedActive(true, a);
    const seen: boolean[] = [];
    const off = onVoiceActiveChange((active) => seen.push(active));
    try { assert.equal(seen[0], true); }
    finally { off(); setOwnedActive(false, a); }
  });

  class FakeAudioContext {
    sampleRate = 48000;
    destination = {};
    resume(): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { return { onaudioprocess: null, connect() {} }; }
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext });
  let stopped = 0;
  const fakeStream = () => ({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await test("permission denial releases engine session and exposes a mic error", async () => {
    configureVoice();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error("NotAllowedError: permission denied")) },
    } });
    const hook = mountHook(() => useVoiceInput());
    try {
      await hook.value.start();
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0], started[0]);
      assert.match(hook.rerender().micError ?? "", /NotAllowedError/);
    } finally { hook.unmount(); }
  });
  await test("cancel before getUserMedia resolves stops a late-acquired stream", async () => {
    configureVoice();
    let open: ((stream: unknown) => void) | undefined;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { getUserMedia: () => new Promise((resolve) => { open = resolve; }) },
    } });
    const hook = mountHook(() => useVoiceInput());
    try {
      const starting = hook.value.start();
      await until(() => !!open);
      await hook.value.cancel();
      open!(fakeStream());
      await starting;
      assert.equal(stopped, 1);
      assert.ok(cancelled.includes(started[0]!));
    } finally { hook.unmount(); }
  });
  await test("late stop result after session switch/unmount never enters a different composer", async () => {
    let resolveStop: ((result: { text: string }) => void) | undefined;
    configureVoice({ stop: () => new Promise((resolve) => { resolveStop = resolve; }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream()) },
    } });
    const finals: string[] = [];
    const hook = mountHook(() => useVoiceInput({ onFinal: (text) => finals.push(text) }));
    await hook.value.start();
    const stopping = hook.value.stop();
    assert.ok(resolveStop, "stop RPC is still in flight");
    hook.unmount(); // ChatPane now displays another session/editor.
    resolveStop!({ text: "old session speech" });
    await stopping;
    assert.deepEqual(finals, [], "the old stop must not call a now-stale onFinal");
  });
} finally {
  globalThis.fetch = realFetch;
  rmSync(data, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}
console.log(`M20 smoke: ${7 - failures}/7 pass`);
if (failures) process.exitCode = 1;
