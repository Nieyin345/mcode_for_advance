/** Real adapter events and a fake pnpm store: no live model, database or user data. */
// @smoke-covers src/main/providers/pi-sdk/PiMessageAdapter.ts
// @smoke-covers src/main/providers/codex-sdk/codexBinaryResolve.ts
// @smoke-covers src/main/providers/pi-sdk/bashWriteGuard.ts
// @smoke-covers src/main/lib/fileSnapshot.ts
// @smoke-covers src/main/lib/msysPath.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { PiMessageAdapter } from "../../src/main/providers/pi-sdk/PiMessageAdapter.ts";

const here = dirname(fileURLToPath(import.meta.url));

function adapterWithEvents() {
  const events = [];
  const ctx = {
    emit: (event) => events.push(event),
    log: { info() {}, warn() {}, error() {} },
  };
  const adapter = new PiMessageAdapter(ctx, "smoke-session", () => undefined, {
    async freeze() { return []; },
  });
  return { adapter, events };
}

function agentEnd(stopReason, extras = {}) {
  return {
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "reply" }] }],
    ...extras,
  };
}

for (const [stop, expected] of [
  ["stop", "end_turn"],
  ["length", "max_tokens"],
  ["toolUse", "tool_use"],
  ["error", "error"],
]) {
  test(`Pi final stopReason ${stop} reports ${expected}`, () => {
    const { adapter, events } = adapterWithEvents();
    adapter.dispatch(agentEnd(stop));
    const done = events.filter((e) => e.type === "turn.done");
    assert.equal(done.length, 1);
    assert.equal(done[0].reason, expected);
    if (stop === "error") assert.ok(events.some((e) => e.type === "error"));
  });
}

test("Pi ignores intermediate retries and uses only the last assistant stop reason", () => {
  const { adapter, events } = adapterWithEvents();
  adapter.dispatch(agentEnd("length", { willRetry: true }));
  assert.equal(events.some((e) => e.type === "turn.done"), false);
  adapter.dispatch(agentEnd("stop", {
    messages: [
      { role: "assistant", stopReason: "length", content: [] },
      { role: "toolResult", content: [] },
      { role: "assistant", stopReason: "stop", content: [] },
    ],
  }));
  assert.deepEqual(events.filter((e) => e.type === "turn.done").map((e) => e.reason), ["end_turn"]);
});

test("Pi structured-output defer preserves the actual final reason", () => {
  const { adapter, events } = adapterWithEvents();
  adapter.setDeferTurnDone();
  adapter.dispatch(agentEnd("length"));
  assert.equal(events.some((e) => e.type === "turn.done"), false);
  assert.equal(adapter.getFinalDoneReason(), "max_tokens");
  adapter.flushDeferredTurnDone(adapter.getFinalDoneReason());
  assert.deepEqual(events.filter((e) => e.type === "turn.done").map((e) => e.reason), ["max_tokens"]);
  const provider = readFileSync(resolve(here, "../../src/main/providers/pi-sdk/PiAgentSdkProvider.ts"), "utf8");
  assert.match(provider, /adapter\.getFinalDoneReason\(\)/, "provider must forward the mapped reason");
});

test("Codex pnpm fallback finds this platform's binary (not the macOS package)", async () => {
  // Use the REAL resolver in an isolated pnpm-shaped node_modules tree. Only
  // replace its managed-runtime import: this test is about its bundled fallback.
  const source = readFileSync(resolve(here, "../../src/main/providers/codex-sdk/codexBinaryResolve.ts"), "utf8");
  const imported = 'import { getManagedRuntimeRoot, listManagedVersions } from "@main/runtimes/managedRuntimeRoots.js";';
  assert.ok(source.includes(imported), "managed-runtime import moved; update the smoke fixture");
  const isolated = source.replace(imported,
    "const getManagedRuntimeRoot = () => null; const listManagedVersions = () => [];",
  );
  const js = ts.transpileModule(isolated, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const tmp = mkdtempSync(join(tmpdir(), "mcode-codex-pnpm-smoke-"));
  try {
    const store = join(tmp, "node_modules", ".pnpm");
    const wrapper = join(store, "@openai+codex@0.153.4", "node_modules", "@openai", "codex");
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, "package.json"), '{"name":"@openai/codex","version":"0.153.4"}');
    const probeFile = join(wrapper, "resolve.mjs");
    writeFileSync(probeFile, js);
    const { resolveBundledCodexBinaryPath, codexVendorTriple } = await import(pathToFileURL(probeFile).href);
    const suffix = `${process.platform}-${process.arch}`;
    const triple = codexVendorTriple();
    assert.ok(triple, `unsupported test platform: ${suffix}`);
    const entry = join(store, `@openai+codex@0.153.4-${suffix}`, "node_modules", "@openai");
    const binary = process.platform === "win32" ? "codex.exe" : "codex";
    const expected = join(entry, `codex-${suffix}`, "vendor", triple, "bin", binary);
    const wrong = join(entry, "codex-darwin-arm64", "vendor", triple, "bin", binary);
    mkdirSync(dirname(expected), { recursive: true });
    mkdirSync(dirname(wrong), { recursive: true });
    writeFileSync(expected, "correct platform binary");
    writeFileSync(wrong, "decoy macOS package");
    assert.equal(resolveBundledCodexBinaryPath(), expected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("shared status bar never presents Claude health or model names as Pi/Codex status", async () => {
  const { describeStatusBar } = await import("../../src/renderer/components/layout/statusBarPresentation.ts");
  const labels = {
    "layout.status.claudeMissing": "Claude not found",
    "layout.status.claudeReady": "Claude ready",
    "layout.status.checkingClaude": "Checking Claude…",
    "layout.status.auto": "Auto",
    "layout.status.selectModel": "Select a model",
  };
  const t = (key) => labels[key];
  const pi = describeStatusBar({
    providerId: "pi-sdk", providerName: "Pi", claudeInstalled: false,
    model: "default", customModelName: "Stale Claude gateway", t,
  });
  assert.deepEqual(pi, {
    statusText: "Pi", statusColor: "text-content-subtle",
    statusMissing: false, modelLabel: "Select a model",
  });
  const codex = describeStatusBar({
    providerId: "codex-sdk", providerName: "Codex", claudeInstalled: false,
    model: "gpt-5-codex", t,
  });
  assert.equal(codex.statusText, "Codex");
  assert.equal(codex.modelLabel, "gpt-5-codex");
  const claude = describeStatusBar({
    providerId: "claude-sdk", providerName: "Claude", claudeInstalled: false,
    model: "sonnet", customModelName: "Custom gateway", t,
  });
  assert.equal(claude.statusText, "Claude not found");
  assert.equal(claude.statusColor, "text-danger");
  assert.equal(claude.statusMissing, true);
  assert.equal(claude.modelLabel, "Custom gateway · Sonnet");
  const component = readFileSync(resolve(here, "../../src/renderer/components/layout/StatusBar.tsx"), "utf8");
  assert.match(component, /describeStatusBar\(/, "the visible component must use the tested presenter");
});

test("Pi records literal bash write targets for the turn-files card and rewind", async () => {
  // Load the real guard and FileSnapshot with only their @main/* imports
  // rewritten to isolated local modules; the filesystem is always a temp dir.
  const temp = mkdtempSync(join(tmpdir(), "mcode-pi-bash-snapshot-smoke-"));
  try {
    const lib = resolve(here, "../../src/main/lib");
    const guardPath = resolve(here, "../../src/main/providers/pi-sdk/bashWriteGuard.ts");
    const compile = (source, substitutions = []) => {
      for (const [from, to] of substitutions) {
        assert.ok(source.includes(from), `fixture import moved: ${from}`);
        source = source.replace(from, to);
      }
      return ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
    };
    writeFileSync(join(temp, "msys.mjs"), compile(readFileSync(join(lib, "msysPath.ts"), "utf8")));
    writeFileSync(join(temp, "snapshot.mjs"), compile(
      readFileSync(join(lib, "fileSnapshot.ts"), "utf8"),
      [['"@main/lib/msysPath.js"', '"./msys.mjs"']],
    ));
    writeFileSync(join(temp, "bashGuard.mjs"), compile(
      readFileSync(guardPath, "utf8"),
      [['"@main/lib/fileSnapshot.js"', '"./snapshot.mjs"']],
    ));
    const { FileSnapshot, restoreFiles } = await import(pathToFileURL(join(temp, "snapshot.mjs")).href);
    const { guardBashCommand, resolveBashWriteTargets } = await import(pathToFileURL(join(temp, "bashGuard.mjs")).href);
    const cwd = join(temp, "project");
    mkdirSync(cwd);
    const file = join(cwd, "draft.md");
    writeFileSync(file, "before\n");
    assert.equal(guardBashCommand(cwd, "printf after > draft.md", true), null);
    assert.deepEqual(resolveBashWriteTargets(cwd, "printf after > draft.md"),
      [{ absPath: file, insideProject: true }]);
    for (const command of [
      "printf after >> ./draft.md",
      "printf after | tee -a draft.md",
      "dd if=/dev/null of=./draft.md",
      "sed -i 's/before/after/' draft.md",
    ]) {
      assert.deepEqual(resolveBashWriteTargets(cwd, command),
        [{ absPath: file, insideProject: true }], command);
    }
    const external = resolveBashWriteTargets(cwd, "printf oops > ../outside.md");
    assert.equal(external.length, 1);
    assert.equal(external[0].insideProject, false);
    assert.match(guardBashCommand(cwd, "printf oops > ../outside.md", true), /拒绝/);
    assert.deepEqual(resolveBashWriteTargets(cwd, "printf x > $DYNAMIC"), []);

    const snapshot = new FileSnapshot();
    for (const target of resolveBashWriteTargets(cwd, "printf after > draft.md")) {
      if (target.insideProject) await snapshot.recordPre(cwd, target.absPath);
    }
    writeFileSync(file, "after\n");
    const changes = await snapshot.freeze();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "before\n");
    assert.deepEqual(await restoreFiles(cwd, changes), [file]);
    assert.equal(readFileSync(file, "utf8"), "before\n");

    const created = join(cwd, "new.md");
    const createdSnapshot = new FileSnapshot();
    const [newTarget] = resolveBashWriteTargets(cwd, "printf hi > new.md");
    await createdSnapshot.recordPre(cwd, newTarget.absPath);
    writeFileSync(created, "hello\n");
    const createdChanges = await createdSnapshot.freeze();
    assert.equal(createdChanges.length, 1);
    assert.equal(createdChanges[0].kind, "created");
    assert.deepEqual(await restoreFiles(cwd, createdChanges), [created]);
    assert.equal(existsSync(created), false);

    const extension = readFileSync(resolve(here, "../../src/main/providers/pi-sdk/mcodeExtension.ts"), "utf8");
    const bashBranch = extension.split('if (toolName === "bash") {')[1]?.split("// ③ Plan tools")[0];
    assert.ok(bashBranch, "Pi bash tool_call guard moved; update the regression test");
    assert.match(bashBranch, /resolveBashWriteTargets\(cwd, normalized\)/);
    assert.match(bashBranch, /recordPre\(cwd, target\.absPath\)/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
