/** Real persistence-alert and data-root IPC modules with dependency stubs.
 * Quit tests execute the actual before-quit callback, extracted by TypeScript
 * AST, not a hand-copied implementation. No app startup or real data access. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { registerAppHandlers } from "@main/ipc/app.js";
import { installDbPersistenceAlerts, showDbPersistenceError } from "@main/store/persistenceAlerts.js";
import { calls, messages, observers, state, respond, reset } from "./stubs/callers.js";

const tick = () => new Promise<void>((done) => setTimeout(done, 0));
let checks = 0;
let failures = 0;
function check(label: string, condition: boolean): void {
  checks++;
  if (!condition) failures++;
  console.log(`  ${condition ? "ok" : "FAIL"} callers: ${label}`);
}

/** Isolate the real callback while avoiding main/index.ts startup side effects. */
function quitFixture(failAt: "flush" | "close" | null, options: {
  cookiesFlushed?: boolean; officeFailure?: boolean; officeWait?: Promise<void>;
} = {}) {
  const source = readFileSync(resolve("src/main/index.ts"), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const handlers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "app"
      && node.expression.name.text === "on" && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "before-quit") handlers.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(handlers.length, 1, "before-quit callback moved: update the smoke boundary");
  const code = ts.transpileModule(`const callback = ${handlers[0].getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const trace: string[] = [];
  const record = (name: string) => () => { trace.push(name); };
  const save = (name: "flush" | "close") => () => {
    trace.push(name);
    if (name === failAt) throw new Error(`injected ${name} failure`);
  };
  const deps = {
    flushDb: save("flush"), closeDb: save("close"), showDbPersistenceError: record("alert"),
    app: { quit: record("quit") }, BridgeRegistry: { disposeAll: record("bridges") },
    stopExtensionBridge: record("extension"), disposePublicMcp: record("mcp"),
    TerminalManager: { disposeAll: record("terminal") }, lspManager: { disposeAll: record("lsp") },
    BrowserManager: { disposeAll: record("browser"), saveCookieVault: async () => { trace.push("cookies"); } },
    relayManager: { disposeAll: record("relay") }, automationRunner: { dispose: record("automation") },
    stopMobileServer: record("mobile"),
    disposeAllAgentResources: record("agent-processes"),
    shutdownOnlyOfficeBridge: record("onlyoffice"),
    flushOnlyOfficeSessions: async () => {
      trace.push("office-save");
      await options.officeWait;
      if (options.officeFailure) throw new Error("injected Office save failure");
    },
    showOnlyOfficeSaveError: record("office-alert"),
    log: { warn: record("warn") },
    BrowserWindow: { getAllWindows: () => [{ isEnabled: () => true, isDestroyed: () => false,
      setEnabled: (enabled: boolean) => trace.push(enabled ? "enable-window" : "disable-window") }] },
  };
  const callback = new Function(...Object.keys(deps), `let sessionCookiesFlushed = ${options.cookiesFlushed ?? true}; let quitPreparationPending = false; ${code} return callback;`)(...Object.values(deps)) as (event: { preventDefault(): void }) => void;
  let prevented = false;
  return { trace, callback, event: { preventDefault() { prevented = true; } }, prevented: () => prevented };
}

async function main(): Promise<void> {
  installDbPersistenceAlerts();
  installDbPersistenceAlerts();
  check("alert observer is installed only once", observers.size === 1);
  for (const observer of observers) observer(new Error("simulated save failure"));
  showDbPersistenceError(new Error("duplicate failure"));
  await tick();
  check("one visible dialog while an error is already open", messages.length === 1);
  check("English title is selected from saved locale", messages[0]?.title === "Database save failed");
  respond(1);
  await tick();
  check("Keep app open does not force another save", !calls.includes("flush"));

  reset(); state.locale = "zh"; state.flushError = true;
  showDbPersistenceError(new Error("write failed"));
  await tick();
  check("Chinese title is available", messages[0]?.title === "数据库保存失败");
  respond(0);
  await tick();
  check("Retry invokes the synchronous save barrier", calls.includes("flush"));
  check("a failed manual retry reopens the error", messages.length === 2);
  state.flushError = false;
  respond(0);
  await tick();
  check("a successful retry dismisses the dialog", messages.length === 2 && calls.filter((s) => s === "flush").length === 2);

  for (const mode of ["dialogThrows", "dialogRejects"] as const) {
    reset(); state[mode] = true;
    let escaped = false;
    try { showDbPersistenceError(new Error("failure")); } catch { escaped = true; }
    await tick();
    check(`${mode}: dialog failure cannot escape to a quit/save caller`, !escaped);
    state[mode] = false;
    showDbPersistenceError(new Error("next failure"));
    await tick();
    check(`${mode}: next error can open a dialog again`, messages.length === 2);
    if (messages.length === 2) { respond(1); await tick(); }
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerAppHandlers({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as unknown as IpcMain);
  const move = handlers.get(IPC.APP_MOVE_DATA_ROOT);
  assert.ok(move, "real move-root handler is registered");
  reset(); state.officeActive = true;
  const officeBlocked = move({}, { path: "/isolated-target" }) as { ok: boolean };
  check("active/pending Office sessions block data-root migration before any writes", !officeBlocked.ok && calls.length === 0);
  for (const mode of ["flushError", "closeError"] as const) {
    reset(); state[mode] = true;
    let threw = false;
    try { move({}, { path: "/isolated-target" }); } catch { threw = true; }
    check(`${mode}: failed save rejects migration`, threw);
    check(`${mode}: pointer and restart are not published`, !calls.includes("publish-root") && !calls.includes("relaunch"));
    if (mode === "flushError") check("failed pre-copy flush never copies an old snapshot", !calls.includes("copy"));
  }
  reset(); state.copyError = true;
  const copyResult = move({}, { path: "/isolated-target" }) as { ok: boolean };
  check("failed copy leaves the old live database open", !copyResult.ok && !calls.includes("close"));
  reset();
  const moved = move({}, { path: "/isolated-target" }) as { ok: boolean };
  check("successful migration closes before publishing the pointer", moved.ok && calls.join(",") === "flush,copy,close,publish-root");
  await new Promise<void>((done) => setTimeout(done, 650));
  check("restart is deferred until after migration returned", calls.slice(-2).join(",") === "relaunch,exit");

  const blocked = quitFixture("flush");
  blocked.callback(blocked.event);
  check("failed quit preflight prevents exit", blocked.prevented());
  check("failed preflight leaves services alive", blocked.trace.join(",") === "flush,alert");
  blocked.callback(blocked.event);
  await tick();
  check("cancelled quit resets the cookie-flush latch", blocked.trace.includes("cookies"));
  const finalFailure = quitFixture("close");
  finalFailure.callback(finalFailure.event);
  check("a final-close failure also prevents data-losing exit", finalFailure.prevented() && finalFailure.trace.at(-1) === "alert");
  const success = quitFixture(null);
  success.callback(success.event);
  check("successful quit saves before teardown and closes last", !success.prevented() && success.trace[0] === "flush" && success.trace.at(-1) === "close");
  check("successful quit includes the current OnlyOffice cleanup", success.trace.includes("onlyoffice"));
  check("successful quit stops agent background processes", success.trace.includes("agent-processes"));
  const officeFailure = quitFixture(null, { cookiesFlushed: false, officeFailure: true });
  officeFailure.callback(officeFailure.event);
  await tick(); await tick();
  check("Office save failure cancels quit and leaves all services alive", officeFailure.prevented()
    && officeFailure.trace.includes("office-alert") && !officeFailure.trace.includes("quit")
    && !officeFailure.trace.includes("onlyoffice") && !officeFailure.trace.includes("close"));
  check("a failed quit restores window interaction", officeFailure.trace.includes("disable-window") && officeFailure.trace.at(-1) === "enable-window");
  officeFailure.callback(officeFailure.event);
  await tick(); await tick();
  check("a failed Office preflight can be retried", officeFailure.trace.filter((step) => step === "office-save").length === 2);
  let release!: () => void;
  const officeWait = new Promise<void>((resolve) => { release = resolve; });
  const waiting = quitFixture(null, { cookiesFlushed: false, officeWait });
  waiting.callback(waiting.event); waiting.callback(waiting.event);
  await tick();
  check("repeated quit shares one save preflight and cannot pass a pending write", waiting.prevented()
    && waiting.trace.filter((step) => step === "office-save").length === 1 && !waiting.trace.includes("quit"));
  release(); await tick(); await tick();
  check("successful Office preflight resumes quit exactly once", waiting.trace.filter((step) => step === "quit").length === 1
    && waiting.trace.indexOf("office-save") < waiting.trace.indexOf("quit"));
  console.log(`persistence-callers: ${checks} checks, ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
