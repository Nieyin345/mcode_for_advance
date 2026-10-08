import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain, session as electronSession } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IPC } from "@contracts/ipc";
import type { WorkflowDoc } from "@contracts/workflow";
import { ModuleCatalogSchema } from "@contracts/moduleCapability";
import { EXAMPLE_MODULE, ResourceSchema, ResultSchema } from "@contracts/modules";
import { initDb, flushDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, WorkflowRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { registerModuleHandlers } from "@main/ipc/modules.js";
import { registerWorkflowHandlers } from "@main/ipc/orchestration.js";
import { getWorkflow, saveWorkflow } from "@main/orchestration/library.js";
import { exportWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { workflowReviewOf, workflowRevision } from "@main/orchestration/workflowTrust.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { decodeSnapshot } from "@main/orchestration/runStore.js";
import { getModuleHost } from "@main/modules/service.js";
import { forbiddenCalls, observedEvents } from "./native-ports.js";

const id = "wf_p2_native";
const projectId = "p2-native-project";
const name = "P2 native capability";
const body = "P2 real Electron workflow file\n";
const digest = createHash("sha256").update(body).digest("hex");
const checks: Array<{ name: string; status: "PASS" | "FAIL"; error?: string }> = [];
export async function runNativeProbe(dir: string, phase: string): Promise<void> {
  let win: BrowserWindow | undefined;
  const evidence = join(dir, `${phase}-checks.json`);
  async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); checks.push({ name: label, status: "PASS" }); console.log("PASS NATIVE " + label); }
    catch (error) { checks.push({ name: label, status: "FAIL", error: String(error) }); throw error; }
    finally { await writeFile(evidence, JSON.stringify(checks, null, 2)); }
  }
  const js = async <T = unknown>(expression: string): Promise<T> => {
    assert.ok(win); return await win.webContents.executeJavaScript(expression, true) as T;
  };
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 12000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) { if (Date.now() - start > timeout) throw Error("Timed out: " + label); await delay(35); }
  }
  async function wait(expression: string): Promise<void> { await until(() => js<boolean>(`Boolean(${expression})`), expression); }
  async function click(selector: string, text?: string, button: "left" | "right" = "left", exact = false): Promise<void> {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0${text === undefined ? "" : ` && e.textContent${exact ? `.trim()===${JSON.stringify(text)}` : `.includes(${JSON.stringify(text)})`}`})`;
    await wait(find);
    const pos = await js<{ x: number; y: number }>(`(()=>{const e=${find};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win!.webContents.sendInputEvent({ type: "mouseDown", ...pos, button, clickCount: 1 });
    win!.webContents.sendInputEvent({ type: "mouseUp", ...pos, button, clickCount: 1 });
    await delay(75);
  }
  async function chooseWorkflow(): Promise<void> { await click("button", name); await wait("document.querySelector('[role=button][title=\"File inspection\"]')"); }
  async function openInspector(): Promise<void> { await click('[role=button][title="File inspection"]'); await wait("document.querySelector('[data-testid=module-capability-fields]') && !document.querySelector('[data-testid=module-target-loading]')"); }
  // capturePage is awaited explicitly; no image or API success reply is fabricated.
  async function screenshot(file: string): Promise<void> {
    // Hidden Electron windows may return their previous compositor frame even
    // after React committed the checked DOM. Warm capture, wait for two frames,
    // then save a settled image plus its exact DOM text (never a fabricated PNG).
    await win!.webContents.capturePage();
    await js(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No renderer paint frame')),4000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`);
    await delay(150);
    const image = await win!.webContents.capturePage();
    await writeFile(join(dir, file), image.toPNG());
    await writeFile(join(dir, file + ".txt"), await js<string>("document.body.innerText"));
  }
  try {
    await check("Electron profile and real sql.js data root are isolated", async () => {
      assert.equal(resolve(dataRoot()), resolve(dir, "data"));
      assert.equal(resolve(app.getPath("userData")), resolve(dir, "userData"));
      assert.equal(resolve(app.getPath("home")), resolve(dir, "home"));
      await initDb();
    });
    await writeFile(join(dir, `${phase}-environment.json`), JSON.stringify({ phase, platform: process.platform, arch: process.arch, versions: process.versions, dataRoot: dataRoot(), userData: app.getPath("userData"), home: app.getPath("home") }, null, 2));
    const root = join(dir, "workspace"); await mkdir(root, { recursive: true });
    if (phase === "create") {
      await writeFile(join(root, "manual.txt"), body);
      await writeFile(join(root, digest + ".txt"), "real downstream target");
      const now = Date.now();
      ProjectRepo.create({ id: projectId, name: "P2 isolated workspace", path: root, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now });
      const doc: WorkflowDoc = {
        id, name, trigger: "manual", schemaVersion: "1", builtin: false, updatedAt: 0,
        nodes: [
          { id: "start", type: "mcode.trigger", title: "Manual start", position: { x: 0, y: 0 }, params: { triggerKind: "manual", enabled: false, project: projectId, task: "Explicit isolated read-only file inspection" } },
          { id: "inspect", type: "mcode.module-capability", title: "File inspection", position: { x: 320, y: 0 }, params: { moduleId: "core.file-report", contributionId: "info", path: "before.txt" } },
          { id: "info", type: "mcode.module-capability", title: "Downstream info", position: { x: 640, y: 0 }, params: { moduleId: "core.file-report", contributionId: "info", path: "{{File inspection.sha256}}.txt" } },
        ],
        edges: [{ id: "e1", from: "start", to: "inspect" }, { id: "e2", from: "inspect", to: "info" }],
      };
      const seeded = await saveWorkflow(doc); assert.equal(seeded.ok, true, JSON.stringify(seeded));
    }
    registerModuleHandlers(ipcMain);
    registerWorkflowHandlers(ipcMain);
    // Non-feature bootstrap reader only. It still reads the real isolated DB.
    ipcMain.handle(IPC.PROJECT_LIST, () => ({ projects: ProjectRepo.list() }));
    await automationRunner.start();
    const host = await getModuleHost();
    // Observe real invocation identities without substituting host behavior.
    const workflowCalls: Array<Parameters<typeof host.invokeForWorkflow>[0]> = [];
    const invokeForWorkflow = host.invokeForWorkflow.bind(host);
    host.invokeForWorkflow = input => { workflowCalls.push(structuredClone(input)); return invokeForWorkflow(input); };
    const blockedRequests: string[] = [];
    electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const local = details.url.startsWith("file:") || details.url.startsWith("data:") || details.url.startsWith("devtools:");
      if (!local) blockedRequests.push(details.url);
      callback({ cancel: !local });
    });
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { preload: join(dir, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const consoleErrors: string[] = [];
    win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
    await win.loadFile(join(dir, "index.html"));
    await wait("window.p2Ready && window.p2");
    await check("real preload carries live catalog and exposes no workflow-only invocation", async () => {
      const catalog = ModuleCatalogSchema.parse(await js("window.api.modules.catalog()"));
      assert.ok(catalog.workflowTargets?.some(t => t.moduleId === "core.file-report" && t.contributionId === "inspect"));
      assert.ok(catalog.workflowTargets?.some(t => t.moduleId === "core.file-report" && t.contributionId === "info"));
      assert.equal(await js("typeof window.api.modules.invokeForWorkflow"), "undefined");
      assert.deepEqual(await js("Object.keys(window.api.modules).sort()"), ["cancel", "catalog", "install", "invoke", "remove", "task", "tasks"]);
      assert.equal(await js("typeof window.require"), "undefined");
    });
    if (phase === "create") {
      await check("real save/import IPC reject forged fields and invalid paths before persistence", async () => {
        const before = getWorkflow(id); assert.ok(before);
        for (const patch of [{ trusted: true, requestId: "forged" }, { path: "a\0b" }, { path: "x".repeat(4097) }]) {
          const bad: WorkflowDoc = structuredClone(before); bad.nodes[1].params = { ...bad.nodes[1].params, ...patch };
          const saved: { ok: boolean } = await js<{ ok: boolean }>(`window.api.workflow.save({workflow:${JSON.stringify(bad)}})`);
          const imported = await js<{ ok: boolean }>(`window.api.workflow.import({text:${JSON.stringify(exportWorkflowDoc(bad))}})`);
          assert.equal(saved.ok, false, "native save accepted forbidden parameters");
          assert.equal(imported.ok, false, "native import accepted forbidden parameters");
          assert.deepEqual(getWorkflow(id), before, "a rejected save changed the previous persisted version");
        }
      });
      await chooseWorkflow(); await openInspector();
      await check("production node inspector selects a host target and saves a path template through native IPC", async () => {
        await click('[data-testid="module-target-trigger"]');
        await click('[data-testid="module-target-option"]', 'SHA-256');
        await wait("document.querySelector('[data-testid=module-target-summary]')?.textContent.includes('core.file.inspect')");
        await js(`(()=>{const e=document.querySelector('[data-testid=module-capability-fields] input[type=text]');if(!e)throw Error('No path field');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,'{{trigger.kind}}.txt');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='保存'&&!b.disabled)");
        await click("button", "保存", "left", true);
        await until(() => getWorkflow(id)?.nodes[1].params.path === "{{trigger.kind}}.txt", "UI save persisted");
        assert.deepEqual(getWorkflow(id)?.nodes[1].params, { moduleId: "core.file-report", contributionId: "inspect", path: "{{trigger.kind}}.txt" });
        await flushDb();
        assert.equal((await readFile(join(dir, "data/mcode.db"))).subarray(0, 15).toString(), "SQLite format 3");
        await chooseWorkflow(); await openInspector();
        await wait("document.querySelector('[data-testid=module-capability-fields] input[type=text]')?.value==='{{trigger.kind}}.txt'");
        await screenshot("configured.png");
      });
    } else {
      await check("new Electron process reopens the real SQLite configuration and run outcomes", async () => {
        assert.deepEqual(getWorkflow(id)?.nodes[1].params, { moduleId: "core.file-report", contributionId: "inspect", path: "{{trigger.kind}}.txt" });
        const rows = WorkflowRunRepo.listForAutomationWorkflow(id, 20);
        assert.ok(rows.some(row => row.status === "success"));
        const snapshot = decodeSnapshot(rows.find(row => row.status === "success")!.payload); assert.ok(snapshot);
        assert.equal(new Map(snapshot.state.outcomes).get("inspect")?.outputs?.sha256, digest);
        await chooseWorkflow(); await openInspector();
        assert.equal(await js("document.querySelector('[data-testid=module-capability-fields] input[type=text]').value"), "{{trigger.kind}}.txt");
        await screenshot("reopened.png");
      });
    }
    await check("disabled manual workflow does not start merely by saving or opening UI", async () => {
      assert.equal(getWorkflow(id)?.nodes[0].params.enabled, false);
      assert.equal(observedEvents.filter(e => e.type === "workflow.node.result").length, 0);
      assert.equal(host.tasks({ projectPath: root }).length, 0);
    });
    await check("real AutomationRunSection button reaches actual automation runner, scheduler, host and downstream file", async () => {
      const before = WorkflowRunRepo.listForAutomationWorkflow(id, 20).length;
      // Selecting the whole graph exposes the real automation dashboard.
      await js("window.p2.setView('results')"); await wait("document.querySelector('[data-testid=native-results]')");
      await js("window.p2.setView('automation')");
      await chooseWorkflow();
      await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('立刻运行一次'))");
      await click("button", "立刻运行一次");
      await until(() => WorkflowRunRepo.listForAutomationWorkflow(id, 20).length > before && !WorkflowRunRepo.listForAutomationWorkflow(id, 20).some(row => row.status === "running"), "native workflow terminal", 15000);
      const row = WorkflowRunRepo.listForAutomationWorkflow(id, 20)[0]; assert.equal(row.status, "success", row.payload);
      const state = decodeSnapshot(row.payload); assert.ok(state);
      const outcomes = new Map(state.state.outcomes);
      assert.equal(outcomes.get("inspect")?.outputs?.sha256, digest);
      assert.equal(outcomes.get("inspect")?.outputs?.bytes, Buffer.byteLength(body));
      assert.equal(outcomes.get("info")?.outputs?.bytes, Buffer.byteLength("real downstream target"));
      assert.equal(typeof outcomes.get("info")?.outputs?.modifiedAt, "number");
      assert.deepEqual(state.inFlightNodeIds, []);
      assert.equal(host.tasks({ projectPath: root }).length, 1);
      assert.match(workflowCalls.find(call => call.contributionId === "inspect")!.requestId, /^wf:[a-f0-9]{64}$/);
      await js("window.p2.setView('results')");
      await wait(`document.querySelector('[data-testid=native-results]')?.textContent.includes(${JSON.stringify(digest)})`);
      await screenshot(`${phase}-results.png`);
    });
    if (phase === "create") {
      await check("explicit native rerun receives a fresh host identity, not the previous task", async () => {
        const first = workflowCalls.find(call => call.contributionId === "inspect")!.requestId;
        const result = await js<{ ok: boolean }>(`window.api.automation.run({workflowId:${JSON.stringify(id)},triggerNodeId:'start'})`);
        assert.equal(result.ok, true);
        await until(() => host.tasks({ projectPath: root }).length === 2 && host.tasks({ projectPath: root }).every(task => task.status === "completed"), "fresh explicit rerun");
        await until(() => !WorkflowRunRepo.listForAutomationWorkflow(id, 20).some(row => row.status === "running"), "second native run persisted");
        assert.notEqual(workflowCalls.filter(call => call.contributionId === "inspect").at(-1)!.requestId, first);
      });
      await check("real imported workflow retains review barrier and cannot self-approve or run", async () => {
        const doc = structuredClone(getWorkflow(id)!); doc.name = "Imported native fixture"; doc.nodes[0].params.enabled = true;
        const imported = await js<{ ok: boolean; id: string }>(`window.api.workflow.import({text:${JSON.stringify(exportWorkflowDoc(doc))}})`); assert.equal(imported.ok, true);
        const importedDoc = getWorkflow(imported.id); assert.ok(importedDoc);
        assert.equal(workflowReviewOf(importedDoc)?.pending, true);
        const before = host.tasks({ projectPath: root }).length;
        const denied = await js<{ ok: boolean }>(`window.api.automation.run({workflowId:${JSON.stringify(imported.id)},triggerNodeId:'start'})`); assert.equal(denied.ok, false);
        assert.equal(host.tasks({ projectPath: root }).length, before);
        const wrong = await js<{ ok: boolean }>(`window.api.workflow.approve({id:${JSON.stringify(imported.id)},revision:'${"0".repeat(64)}'})`); assert.equal(wrong.ok, false);
        assert.equal(workflowReviewOf(importedDoc)?.pending, true);
        // Consent uses the stored revision; changing executable params revokes it.
        const approved = await js<{ ok: boolean }>(`window.api.workflow.approve({id:${JSON.stringify(imported.id)},revision:${JSON.stringify(workflowRevision(importedDoc))}})`); assert.equal(approved.ok, true);
        const changed = structuredClone(importedDoc); changed.nodes[1].params.path = "manual.txt";
        assert.equal((await saveWorkflow(changed)).ok, true);
        assert.equal(workflowReviewOf(getWorkflow(imported.id)!)?.pending, true);
        await writeFile(join(dir, "imported-id.txt"), imported.id);
      });
      await check("user v1 module stays menu-callable but actual runner denies its workflow invocation", async () => {
        await js(`window.api.modules.install({manifest:${JSON.stringify(EXAMPLE_MODULE)},confirmReadAccess:true})`);
        const menu = await js<{ type: string }>(`window.api.modules.invoke({moduleId:${JSON.stringify(EXAMPLE_MODULE.id)},contributionId:'inspect',resource:{projectPath:${JSON.stringify(root)},path:${JSON.stringify(join(root, "manual.txt"))}},requestId:'native-user-menu'})`); assert.equal(menu.type, "task");
        const deniedDoc = structuredClone(getWorkflow(id)!); deniedDoc.id = "wf_p2_user_denied"; deniedDoc.name = "User module denied"; deniedDoc.nodes[1].params.moduleId = EXAMPLE_MODULE.id;
        assert.equal((await saveWorkflow(deniedDoc)).ok, true);
        const requested = await js<{ ok: boolean }>(`window.api.automation.run({workflowId:${JSON.stringify(deniedDoc.id)},triggerNodeId:'start'})`);
        assert.equal(requested.ok, true);
        await until(() => WorkflowRunRepo.listForAutomationWorkflow(deniedDoc.id, 10).some(row => row.status === "failed"), "user workflow denied by actual runner");
        const row = WorkflowRunRepo.listForAutomationWorkflow(deniedDoc.id, 10)[0];
        const failed = decodeSnapshot(row.payload); assert.ok(failed);
        assert.match(new Map(failed.state.outcomes).get("inspect")?.error ?? "", /工作流需要一个已注册的内置只读贡献/);
      });
      await check("real file menu uses the same service and renders real query results in Electron", async () => {
        await js("window.p2.setView('modules')");
        await click('[data-testid="native-file"]', undefined, "right");
        await click('[role="menuitem"]', "查看文件信息");
        await wait("document.querySelector('[role=dialog] dd')");
        const values = await js<string[]>("[...document.querySelectorAll('[role=dialog] dd')].map(e=>e.textContent)");
        assert.equal(values[0], String(Buffer.byteLength(body)));
        assert.ok(Number(values[1]) > 0);
        await screenshot("native-menu-result.png");
        await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await wait("!document.querySelector('[role=dialog]')");
      });
      await check("native cancel control cancels a real host-owned timing fixture without success outputs", async () => {
        // The extra contribution exists only in this isolated process. It is a
        // timing fixture for UI cancellation, not a claimed file capability.
        host.register({ id: "core.p2.cancel", kind: "task", input: ResourceSchema, output: ResultSchema, run: async (_input, context) => new Promise((_resolve, reject) => {
          context.progress(0.25);
          const cancel = (): void => reject(new Error("cancelled fixture"));
          if (context.signal.aborted) cancel(); else context.signal.addEventListener("abort", cancel, { once: true });
        }) });
        host.addBuiltin({ ...EXAMPLE_MODULE, id: "core.p2-cancel", contributions: [{ ...EXAMPLE_MODULE.contributions[0], capability: "core.p2.cancel" }] });
        await js(`window.api.modules.invoke({moduleId:'core.p2-cancel',contributionId:'inspect',resource:{projectPath:${JSON.stringify(root)},path:${JSON.stringify(join(root, "manual.txt"))}},requestId:'native-ui-cancel'}).then(reply=>window.p2.setReply(reply))`);
        await click("[role=dialog] button", "取消");
        await wait("document.querySelector('[role=dialog] [role=status]')?.textContent.includes('已取消')");
        const task = host.tasks({ projectPath: root }).find(t => t.moduleId === "core.p2-cancel"); assert.equal(task?.status, "cancelled"); assert.equal(task?.result, undefined);
        assert.equal(await js("document.querySelectorAll('[role=dialog] dd').length"), 0);
        await screenshot("native-cancelled.png");
      });
    } else {
      await check("review marker and installed user module survive real process restart", async () => {
        const importedId = await readFile(join(dir, "imported-id.txt"), "utf8");
        assert.equal(workflowReviewOf(getWorkflow(importedId)!)?.pending, true);
        assert.ok(host.catalog().modules.some(module => module.id === EXAMPLE_MODULE.id));
        assert.equal(WorkflowRepo.get(id)?.doc.nodes[0].params.enabled, false);
      });
    }
    await check("no real provider/model call, page exception or remote page request occurred", async () => {
      assert.deepEqual(forbiddenCalls, []);
      assert.deepEqual(await js("window.p2Errors"), []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(blockedRequests, []);
    });
    await writeFile(join(dir, `${phase}-workflow-calls.json`), JSON.stringify(workflowCalls, null, 2));
    await flushDb();
  } catch (error) {
    if (checks.at(-1)?.status !== "FAIL") checks.push({ name: "native feature harness completed", status: "FAIL", error: String(error) });
    console.error(error);
    if (win && !win.isDestroyed()) {
      await writeFile(join(dir, `${phase}-failure.html`), await js<string>("document.documentElement.outerHTML")).catch(() => {});
      await screenshot(`${phase}-failure.png`).catch(() => {});
    }
    throw error;
  } finally {
    automationRunner.dispose();
    if (win && !win.isDestroyed()) win.destroy();
    await flushDb(); closeDb();
    await writeFile(evidence, JSON.stringify(checks, null, 2));
  }
}
