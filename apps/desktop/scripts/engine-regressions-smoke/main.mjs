/** Real adapter events and a fake pnpm store: no live model, database or user data. */
// @smoke-covers src/main/providers/pi-sdk/PiMessageAdapter.ts
// @smoke-covers src/main/providers/pi-sdk/piTokenUsage.ts
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
import { buildPiTokenSnapshot } from "../../src/main/providers/pi-sdk/piTokenUsage.ts";
import { codexMcpDisableArgs, codexTurnAllowsMcpServer } from "../../src/main/providers/codex-sdk/codexTurnScope.ts";
import { codexApprovalReply } from "../../src/main/providers/codex-sdk/codexApprovalReply.ts";
import { createProviderHealthProbe } from "../../src/main/providers/providerHealth.ts";
import { createProviderHealthRequestGate } from "../../src/renderer/lib/providerHealthRequestGate.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("Codex host-approved actions never receive an unrevocable app-server grant", () => {
  assert.deepEqual(codexApprovalReply({ allow: true, persist: true }), { decision: "accept" });
  assert.deepEqual(codexApprovalReply(null, true), { decision: "accept" });
  assert.deepEqual(codexApprovalReply({ allow: true }), { decision: "accept" });
  assert.deepEqual(codexApprovalReply({ allow: false, persist: true }), { decision: "decline" });
  const provider = readFileSync(resolve(here, "../../src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8");
  assert.match(provider, /codexApprovalReply\(/, "approval handler must call the tested reply policy");
});

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

test("Pi abort/error finalization never double-emits turn.done after agent_end", () => {
  // A user abort (or transport break) makes prompt() reject — but the agent
  // loop frequently emitted a terminal agent_end FIRST (the adapter already
  // fired turn.done). finalizeTurn must reuse the one-shot guard so the turn
  // ends exactly once with the interruption reason the user's stop implies.
  const { adapter, events } = adapterWithEvents();
  adapter.dispatch(agentEnd("stop")); // adapter emits turn.done{end_turn}
  adapter.finalizeTurn("interrupted"); // aborted catch branch
  const done = events.filter((e) => e.type === "turn.done");
  assert.equal(done.length, 1, "abort after a terminal agent_end must not resend turn.done");
  assert.equal(done[0].reason, "end_turn");
  // No terminal agent_end (SDK crash before the loop closed): finalizeTurn is
  // the single source of turn.done, carrying the error reason.
  const crashes = adapterWithEvents();
  crashes.adapter.finalizeTurn("error");
  assert.deepEqual(
    crashes.events.filter((e) => e.type === "turn.done").map((e) => e.reason),
    ["error"],
  );
});

test("Pi per-turn budget reads the turn delta, not the session-cumulative total", () => {
  // Regression: piTokenUsage filled totalProcessedTokens from the SESSION
  // total, and the budget (RuntimeManager reads turnProcessedTokens ??
  // totalProcessedTokens) therefore tripped on every turn once the
  // session total crossed maxTotalTokens. buildPiTokenSnapshot now reports a
  // per-turn delta when given the turn-start baseline, while KEEPING the
  // cumulative total for the usage panel's adjacent-difference math.
  const ctxUsage = { tokens: 3000, contextWindow: 200000, percent: 1.5 };
  const stats = { tokens: { total: 52000, output: 900, cacheRead: 400, cacheWrite: 100 }, cost: 0.42 };

  const withBaseline = buildPiTokenSnapshot(ctxUsage, stats, "openai/gpt-4o", 50000);
  assert.equal(withBaseline.turnProcessedTokens, 2000, "turn delta = total - turn-start baseline");
  assert.equal(withBaseline.totalProcessedTokens, 52000, "cumulative total stays for usageStats diffing");

  const noBaseline = buildPiTokenSnapshot(ctxUsage, stats, "openai/gpt-4o");
  assert.equal(noBaseline.turnProcessedTokens, undefined, "no baseline → omit; host falls back to cumulative");
  assert.equal(noBaseline.totalProcessedTokens, 52000);
});

test("Pi per-turn USD budget reads the cost delta, not the session-cumulative cost", () => {
  // Same class as the token fix above, for money: stats.cost is session-cumulative
  // and the usage panel diffs it, so the stored costUsd must stay cumulative — but
  // the budget needs the per-turn delta or every turn trips maxUsd once the
  // running total crosses it.
  const ctxUsage = { tokens: 3000, contextWindow: 200000, percent: 1.5 };
  const stats = { tokens: { total: 52000, output: 900 }, cost: 1.75 };

  const withBaseline = buildPiTokenSnapshot(ctxUsage, stats, "openai/gpt-4o", 50000, 1.5);
  assert.equal(withBaseline.turnCostUsd, 0.25, "turn cost = cumulative - turn-start baseline");
  assert.equal(withBaseline.costUsd, 1.75, "cumulative cost stays for usageStats diffing");

  const noBaseline = buildPiTokenSnapshot(ctxUsage, stats, "openai/gpt-4o");
  assert.equal(noBaseline.turnCostUsd, undefined, "no baseline → omit; host falls back to cumulative");
  assert.equal(noBaseline.costUsd, 1.75);
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

test("Codex turn scope narrows MCP and plugin servers with process-local overrides", () => {
  const inventory = [
    { name: "user-one" },
    { name: "paper.plugin__search", pluginName: "paper.plugin" },
    { name: "other__tool", pluginName: "other" },
  ];
  assert.deepEqual(codexMcpDisableArgs(inventory), []);
  assert.deepEqual(codexMcpDisableArgs(inventory, ["user-one", "paper.plugin__search"]), [
    "-c", "mcp_servers.other__tool.enabled=false",
  ]);
  assert.deepEqual(codexMcpDisableArgs(inventory, undefined, ["paper.plugin"]), [
    "-c", "mcp_servers.other__tool.enabled=false",
  ]);
  assert.deepEqual(codexMcpDisableArgs([{ name: "with.dot" }], ["other"]), [
    "-c", 'mcp_servers."with.dot".enabled=false',
  ]);
});

test("Codex MCP allowlist also narrows the built-in browser dynamic tools", () => {
  assert.equal(codexTurnAllowsMcpServer("mcode-browser"), true);
  assert.equal(codexTurnAllowsMcpServer("mcode-browser", []), true);
  assert.equal(codexTurnAllowsMcpServer("mcode-browser", ["user-one"]), false);
  assert.equal(codexTurnAllowsMcpServer("mcode-browser", ["user-one", "mcode-browser"]), true);
});

test("Codex MCP config segments preserve quotes, slashes and controls", () => {
  for (const name of ['server"quoted', "path\\server", "line\nserver", "tab\tserver"]) {
    const args = codexMcpDisableArgs([{ name }], ["keep"]);
    assert.deepEqual(args, ["-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`]);
    assert.equal(JSON.parse(args[1].slice("mcp_servers.".length, -".enabled=false".length)), name);
  }
});

test("shared approval/question UI uses the active provider name", () => {
  const chatPane = readFileSync(resolve(here, "../../src/renderer/components/chat/ChatPane.tsx"), "utf8");
  const approval = readFileSync(resolve(here, "../../src/renderer/components/chat/ApprovalPrompt.tsx"), "utf8");
  const question = readFileSync(resolve(here, "../../src/renderer/components/chat/QuestionPrompt.tsx"), "utf8");
  const slash = readFileSync(resolve(here, "../../src/renderer/components/chat/SlashCommandPicker.tsx"), "utf8");
  assert.doesNotMatch(chatPane, /Claude is working/);
  assert.match(chatPane, /providerName=\{activeProviderName\}/);
  assert.match(approval, /provider: providerName/);
  assert.match(question, /provider: providerName/);
  assert.match(chatPane, /engineName=\{activeProviderName\}/);
  assert.match(slash, /provider: engineName/);
});

test("shared status bar presents each provider's own checking/ready/error health", async () => {
  const { describeStatusBar } = await import("../../src/renderer/components/layout/statusBarPresentation.ts");
  const labels = {
    "layout.status.checkingProvider": "Checking…",
    "layout.status.providerUnavailable": "Unavailable",
    "layout.status.healthTimeout": "Check timed out",
    "layout.status.providerNotRegistered": "Not registered",
    "layout.status.healthUnsupported": "Check unsupported",
    "layout.status.ready": "Ready",
    "layout.status.auto": "Auto",
    "layout.status.selectModel": "Select a model",
  };
  const t = (key) => labels[key];
  const pi = describeStatusBar({
    providerId: "pi-sdk", providerName: "Pi",
    health: { loading: false, ok: true, version: "1.2.3" },
    model: "default", customModelName: "Stale Claude gateway", t,
  });
  assert.deepEqual(pi, {
    statusText: "Pi · Ready · 1.2.3", statusColor: "text-accent",
    statusMissing: false, statusTitle: undefined, modelLabel: "Select a model",
  });
  const codex = describeStatusBar({
    providerId: "codex-sdk", providerName: "Codex",
    health: { loading: true, ok: null },
    model: "gpt-5-codex", t,
  });
  assert.equal(codex.statusText, "Codex · Checking…");
  assert.equal(codex.modelLabel, "gpt-5-codex");
  const claude = describeStatusBar({
    providerId: "claude-sdk", providerName: "Claude",
    health: { loading: false, ok: false, error: "missing binary" },
    model: "sonnet", customModelName: "Custom gateway", t,
  });
  assert.equal(claude.statusText, "Claude · Unavailable");
  assert.equal(claude.statusColor, "text-danger");
  assert.equal(claude.statusMissing, true);
  assert.equal(claude.statusTitle, "missing binary");
  assert.equal(claude.modelLabel, "Custom gateway · Sonnet");
  const timeout = describeStatusBar({
    providerId: "codex-sdk", providerName: "Codex",
    health: { loading: false, ok: false, code: "timeout", error: "slow" },
    model: "default", t,
  });
  assert.equal(timeout.statusText, "Codex · Check timed out");
  const component = readFileSync(resolve(here, "../../src/renderer/components/layout/StatusBar.tsx"), "utf8");
  assert.match(component, /describeStatusBar\(/, "the visible component must use the tested presenter");
  assert.match(component, /force: true/, "failed status must offer a forced retry");
});

test("provider health check is wired across desktop, web/mobile and provider-scoped state", () => {
  const files = [
    "../../src/main/ipc/claude.ts",
    "../../src/preload/index.ts",
    "../../src/main/mobile/mobileRpc.ts",
    "../../src/renderer/lib/webApi.ts",
  ].map((path) => readFileSync(resolve(here, path), "utf8"));
  for (const source of files) assert.match(source, /provider(?::|\.)healthCheck|PROVIDER_HEALTH_CHECK/);
  for (const source of files) assert.doesNotMatch(source, /claude:healthCheck|claudeHealthCheck/);
  const store = readFileSync(resolve(here, "../../src/renderer/stores/sessionStore.ts"), "utf8");
  assert.match(store, /providerHealthById/);
  assert.match(store, /refreshProviderHealth\(id\)/);
  assert.match(store, /refreshProviderHealth\(get\(\)\.providerId\)/);
  assert.match(store, /providerHealthRequestGate/, "stale same-provider responses must be ignored");
  assert.match(store, /PROVIDER_HEALTH_STALE_MS/, "focus refresh must skip fresh probes");
  assert.doesNotMatch(store, /claudeInstalled|refreshClaudeHealth/);
  const chatPane = readFileSync(resolve(here, "../../src/renderer/components/chat/ChatPane.tsx"), "utf8");
  assert.match(chatPane, /providerId === "claude-sdk" && claudeUnavailable/);
});

test("provider health probe normalizes failures, coalesces in-flight work and caches briefly", async () => {
  let calls = 0;
  let finish;
  let now = 100;
  const provider = {
    id: "fake",
    healthCheck: () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  };
  const probe = createProviderHealthProbe(
    (id) => id === "fake" ? provider : undefined,
    { ttlMs: 50, now: () => now },
  );
  const first = probe("fake");
  const second = probe("fake");
  assert.equal(calls, 1, "concurrent desktop/mobile requests share one provider probe");
  finish({ ok: true, version: "1.0" });
  assert.deepEqual(await first, {
    providerId: "fake", ok: true, code: "ok", checkedAt: 100, version: "1.0",
  });
  assert.deepEqual(await second, {
    providerId: "fake", ok: true, code: "ok", checkedAt: 100, version: "1.0",
  });

  await probe("fake");
  assert.equal(calls, 1, "fresh completed result is cached");
  now = 151;
  const expired = probe("fake");
  assert.equal(calls, 2, "expired result starts a new probe");
  finish({ ok: false, error: "not logged in" });
  assert.equal((await expired).error, "not logged in");

  const missing = await probe("missing");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "not_registered");
  assert.match(missing.error, /未注册/);
  const unsupported = await createProviderHealthProbe(() => ({ id: "none" }))("none");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "unsupported");
  assert.match(unsupported.error, /未提供健康检查/);
  const thrown = await createProviderHealthProbe(() => ({
    id: "broken",
    healthCheck: async () => { throw new Error("boom"); },
  }))("broken");
  assert.equal(thrown.code, "probe_failed");
  assert.equal(thrown.error, "boom");

  const timeout = await createProviderHealthProbe(() => ({
    id: "slow", healthCheck: () => new Promise(() => {}),
  }), { timeoutMs: 5 })("slow");
  assert.equal(timeout.code, "timeout");

  const forced = probe("fake", { force: true });
  assert.equal(calls, 3, "forced retry bypasses a completed cache entry");
  finish({ ok: true });
  assert.equal((await forced).code, "ok");
});

test("provider health request gate rejects stale same-provider completions only", () => {
  const gate = createProviderHealthRequestGate();
  const oldPi = gate.begin("pi-sdk");
  const claude = gate.begin("claude-sdk");
  const newPi = gate.begin("pi-sdk");
  assert.equal(gate.isLatest("pi-sdk", oldPi), false);
  assert.equal(gate.isLatest("pi-sdk", newPi), true);
  assert.equal(gate.isLatest("claude-sdk", claude), true);
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

test("workflow provider overrides survive node-session reuse and drive provider-scoped UI", () => {
  const runner = readFileSync(resolve(here, "../../src/main/orchestration/runner.ts"), "utf8");
  assert.match(runner, /override\.length > 0 \? override : sameEngine \? conversation\.model : ""/);
  assert.match(runner, /SessionRepo\.updateSettings\(existing\.id/);
  assert.match(runner, /SessionRepo\.updateClaudeSessionId\(existing\.id, null\)/);
  assert.match(runner, /runtimeManager\.dispose\(nodeSession\.id\)/);

  const refs = readFileSync(resolve(here, "../../src/renderer/components/settings/workflows/useRefOptions.ts"), "utf8");
  assert.match(refs, /useSkillOptions\(providerId\)/);
  assert.match(refs, /useMcpOptions\(from === "mcp", providerId\)/);
  assert.match(refs, /capabilities\.supportsMcp !== false/);
  assert.match(refs, /`mcp:\$\{wanted\}:\$\{locale\}`/);
  assert.match(refs, /s\.perEngine\?\.\[engine\] !== false/);
  assert.match(refs, /compatibleProviderIds\.includes\(wanted\)/);
  assert.match(refs, /RefOptionsResult/);
  assert.match(refs, /failed: !stale && failed/);
  assert.match(refs, /s\.customModels\.find\(\(cfg\) => cfg\.id === s\.customModelId\)/);
  assert.doesNotMatch(refs, /for \(const cfg of s\.customModels\)/);
  const fields = readFileSync(resolve(here, "../../src/renderer/components/settings/workflows/ParamField.tsx"), "utf8");
  assert.match(fields, /unsupportedMcp/);
  assert.match(fields, /mcpUnsupportedProvider/);
  assert.match(fields, /paramRefLoadFailed/);
  assert.match(fields, /result\.retry/);
  assert.match(runner, /probeProviderHealth/);
  assert.match(runner, /工作流启动前引擎检查失败/);
  assert.match(runner, /providerId: executionSession\.providerId/);
  const resultCard = readFileSync(resolve(here, "../../src/renderer/components/chat/WorkflowStepCard.tsx"), "utf8");
  assert.match(resultCard, /chatStream\.workflowStep\.engine/);

  const automation = readFileSync(resolve(here, "../../src/main/orchestration/automationRunner.ts"), "utf8");
  assert.match(automation, /origin\?\.providerId \?\? configuredProviderId \?\? DEFAULT_PROVIDER_ID/);
  assert.match(automation, /origin\?\.model \?\? configuredModel \?\? "default"/);
  const nodeTypes = readFileSync(resolve(here, "../../src/main/orchestration/nodeTypes.ts"), "utf8");
  assert.match(nodeTypes, /label: "无人值守引擎"/);
  assert.match(nodeTypes, /label: "无人值守模型"/);

  const claudeProvider = readFileSync(resolve(here, "../../src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  assert.match(claudeProvider, /allowNames\.filter\(\(name\) => engineEnabled\(enginesMap, name, "claude"\)\)/);
  assert.match(claudeProvider, /if \(!claudeMaySee\(name\)\) return/);
  const piSkills = readFileSync(resolve(here, "../../src/main/providers/pi-sdk/piSkillBridge.ts"), "utf8");
  assert.match(piSkills, /allowNames\.filter\(\(name\) => engineEnabled\(enginesMap, name, "pi"\)\)/);
  const pluginPanel = readFileSync(resolve(here, "../../src/renderer/components/settings/PluginsPanel.tsx"), "utf8");
  assert.match(pluginPanel, /plugin\.compatibleProviderIds/);
  assert.match(pluginPanel, /settings\.plugins\.providerIncompatible/);
  const mcpPanel = readFileSync(resolve(here, "../../src/renderer/components/settings/McpPanel.tsx"), "utf8");
  assert.match(mcpPanel, /if \(!res\.ok \|\| !res\.perEngine\)/);
  assert.match(mcpPanel, /settings\.mcp\.builtinProviderHint/);
  const mcpIpc = readFileSync(resolve(here, "../../src/main/ipc/mcp.ts"), "utf8");
  assert.match(mcpIpc, /perEngine: \{ claude: true, codex: false \}/);
  const skillsPanel = readFileSync(resolve(here, "../../src/renderer/components/settings/SkillsPanel.tsx"), "utf8");
  assert.match(skillsPanel, /if \(!res\.ok \|\| !res\.perEngine\)/);
  assert.match(skillsPanel, /matrixBusyRef/);
  assert.match(skillsPanel, /disabled=\{engineBusy\}/);
  assert.match(pluginPanel, /ops\.setBusyKey\(null\);[\s\S]*ops\.setError\(msg\)/);
  const profilesView = readFileSync(resolve(here, "../../src/renderer/components/settings/workflows/AgentProfilesView.tsx"), "utf8");
  assert.match(profilesView, /if \(saved\) setDraft\(null\)/);
  const nodeInspector = readFileSync(resolve(here, "../../src/renderer/components/settings/workflows/NodeInspector.tsx"), "utf8");
  assert.match(nodeInspector, /if \(saved\) setNaming\(null\)/);
  const workflowsPanel = readFileSync(resolve(here, "../../src/renderer/components/settings/workflows/WorkflowsPanel.tsx"), "utf8");
  assert.match(workflowsPanel, /Promise<boolean>/);
  assert.match(workflowsPanel, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(fields, /paramRefMissingCount/);
  assert.match(fields, /aria-expanded=\{open\}/);
});


// D5: exercise the actual healthCheck method, not a reimplementation of its loop.
test("Claude health probe closes the async iterator on early system/init return", async () => {
  const path = resolve(here, "../../src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const provider = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "ClaudeAgentSdkProvider");
  assert.ok(provider);
  const method = provider.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "healthCheck");
  assert.ok(method);
  const js = ts.transpileModule(`class Probe { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let closed = 0;
  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: { type: "system", subtype: "init", claude_code_version: "fake" } }; },
    async return() { closed++; return { done: true }; },
  };
  const query = (args) => { assert.equal(args.options.maxTurns, 0); return iterator; };
  const probe = new Function("loadQuery", "resolveSdkBinaryPath", `${js}; return new Probe();`)(async () => query, () => undefined);
  assert.deepEqual(await probe.healthCheck(), { ok: true, version: "fake" });
  assert.equal(closed, 1, "AsyncIteratorClose calls return exactly once; no duplicate cleanup needed");
});

// G5: bind the actual provider's turn-start and interrupt closures to a fake
// app-server. No SDK process, network request, or model invocation is possible.
function codexTurnBoundary(client, adapter, ac, activeTurn, clock = { setTimeout, clearTimeout }) {
  const path = resolve(here, "../../src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let run, interrupt;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runTurnAndWait") run = node.initializer;
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "interrupt" && node.initializer.getText(source).includes("ac.abort()")) interrupt = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(run && interrupt, "actual provider lifecycle closures must exist");
  const js = ts.transpileModule(`let turnStartPending = false; const run = ${run.getText(source)}; const interrupt = ${interrupt.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function("client", "adapter", "ac", "activeTurn", "threadId", "turnOverrides", "setTimeout", "clearTimeout", `${js}; return { run, interrupt };`)(
    client, adapter, ac, activeTurn, "thread", {}, clock.setTimeout, clock.clearTimeout);
}
test("Codex stop during turn/start waits for the id and sends interrupt before disposal", async () => {
  let releaseStart, end;
  const started = new Promise(resolve => { releaseStart = resolve; });
  const ended = new Promise(resolve => { end = resolve; });
  const calls = [];
  const adapter = { hasTurnEnded: false, markAborted() {}, waitTurnDone: () => ended,
    finalizeAborted() { this.hasTurnEnded = true; end("interrupted"); } };
  const client = {
    request(method, args) {
      calls.push(method);
      if (method === "turn/start") return started;
      assert.equal(args.turnId, "new-turn");
      adapter.finalizeAborted();
      return Promise.resolve({});
    },
    async dispose() { calls.push("dispose"); },
  };
  const control = codexTurnBoundary(client, adapter, new AbortController(), { threadId: "thread", turnId: null });
  const done = control.run([]);
  control.interrupt();
  const disposedEarly = calls.includes("dispose");
  releaseStart({ turn: { id: "new-turn" } });
  assert.equal(await done, "interrupted");
  assert.equal(disposedEarly, false, "do not destroy the transport before the start reply can identify the turn");
  assert.deepEqual(calls, ["turn/start", "turn/interrupt"]);
});

test("Codex pending-start cancellation is bounded and clears a previous corrective turn id", async () => {
  let rejectStart;
  const pending = new Promise((_resolve, reject) => { rejectStart = reject; });
  const timers = new Map();
  let timerId = 0, disposed = 0;
  const clock = { setTimeout(fn, ms) { assert.equal(ms, 2000); timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  const client = { request: () => pending, async dispose() { disposed++; rejectStart(new Error("closed after bounded grace")); } };
  const activeTurn = { threadId: "thread", turnId: "old-corrective-turn" };
  const control = codexTurnBoundary(client, { markAborted() {} }, new AbortController(), activeTurn, clock);
  const done = control.run([]);
  assert.equal(activeTurn.turnId, null, "an old turn id must not mask a pending new turn");
  control.interrupt();
  assert.equal(disposed, 0);
  assert.equal(timers.size, 1, "a hung start must not block stop for the 120-second RPC timeout");
  timers.values().next().value();
  await assert.rejects(done, /bounded grace/);
  assert.equal(disposed, 1);
  assert.equal(timers.size, 0, "terminal paths clear the grace timer");
});
test("Codex cold-start stop still disposes immediately and cannot send a prompt", async () => {
  let disposed = 0, requests = 0;
  const client = { request() { requests++; throw new Error("must not send"); }, async dispose() { disposed++; } };
  const control = codexTurnBoundary(client, { markAborted() {} }, new AbortController(), { threadId: null, turnId: null });
  control.interrupt();
  await assert.rejects(control.run([]), /aborted before turn\/start/);
  assert.equal(disposed, 1);
  assert.equal(requests, 0);
});

// Codex browser dynamic tools had NO approval path (unlike Claude's canUseTool
// and Pi's tool_call guard): navigate/click/upload_file ran in read-only mode
// with no card. The policy is now a pure helper; exercise it directly and assert
// the dispatch actually calls it.
test("Codex browser tools gate side effects through the shared read-only set", () => {
  const path = resolve(here, "../../src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const decl = file.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "codexBrowserToolNeedsApproval",
  );
  assert.ok(decl, "policy helper must exist");
  // The one shared read-only set — not a second copy (硬规矩 2).
  const readonly = new Set([
    "browser_list", "browser_snapshot", "browser_screenshot", "browser_find",
    "browser_scroll", "browser_wait", "browser_switch_tab", "browser_save_pdf", "browser_downloads",
  ]);
  const js = ts.transpileModule(`${decl.getText(file)} module.exports.codexBrowserToolNeedsApproval = codexBrowserToolNeedsApproval;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function("BROWSER_READONLY_SUFFIXES", "module", "exports", js)(readonly, mod, mod.exports);
  const needs = mod.exports.codexBrowserToolNeedsApproval;

  // Read-only tools never prompt, in any mode.
  for (const tool of ["browser_snapshot", "browser_screenshot", "browser_wait"]) {
    assert.equal(needs(tool, "read-only", false, false), false, `${tool} is read-only`);
  }
  // Side effects prompt in every mode except full-access.
  for (const tool of ["browser_navigate", "browser_click", "browser_upload_file", "browser_type"]) {
    assert.equal(needs(tool, "read-only", false, false), true, `${tool} in read-only must prompt`);
    assert.equal(needs(tool, "default", false, false), true, `${tool} in default must prompt`);
    assert.equal(needs(tool, "full-access", false, false), false, `${tool} in full-access runs`);
    assert.equal(needs(tool, "full-access", true, false), true, `${tool} in plan mode must prompt`);
    assert.equal(needs(tool, "default", false, true), false, `${tool} with always-allow runs`);
  }
  // Wiring: the dispatch consults the helper and can deny when no channel exists.
  assert.match(source, /codexBrowserToolNeedsApproval\(/, "invokeDynamicTool must call the policy");
  assert.match(source, /浏览器工具「\$\{name\}」需要用户批准,但审批通道不可用/);
});
