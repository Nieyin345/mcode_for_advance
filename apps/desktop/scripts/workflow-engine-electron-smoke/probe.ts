/**
 * 【ARC-006 NR2】真 Electron 下的「第三方工作流引擎编辑器宿主」U1 探针。
 *
 * ## 它验的是无头套件**证明不了**的那一半
 *
 * `workflow-engine-runtime-smoke` 用假进程验 `EngineRuntime` 状态机；
 * `document-view-host-smoke` 用假视图验宿主状态机。这一套起**真 Electron 二进制**、
 * 真 `BrowserWindow`、真 `WebContentsView`，并让 `EngineRuntime` 走**生产 spawn
 * 路径**起一个真子进程（`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑
 * `fake-engine.cjs`，真端口、真 HTTP），回答这些无头证明不了的问题：
 *
 *  1. running 时 `editorUrl` 真的是一个**拨得通、加载得上**的回环地址；
 *  2. URL 围栏在真 Electron 下仍然先拒后建（远程/伪装回环地址不创建 webContents）；
 *  3. 页签切走 → `hide`（不销毁、页面状态保留）；切回 → `show`（同一个 webContents）；
 *  4. 引擎 `stop` → 状态 stopped、端口不再应答；视图 close 后**不留孤儿 webContents**；
 *  5. `dispose()` 摘掉窗口 `closed` 监听，之后 open 被拒。
 *
 * ## 为什么假引擎不是「假进程」
 *
 * 真 Node-RED 需要 npm install（U1 不联网）。`fake-engine.cjs` 与生产引导脚本
 * （`workflowEngines/registry.ts` BOOTSTRAP）同形：argv 拿端口/userDir、只绑
 * 127.0.0.1、就绪后写 stderr。宿主侧用的是**生产** `defaultEngineRuntimePorts`
 * （真 spawn / 真探活 / 真端口分配），只把「引擎二进制」换成本地脚本。
 *
 * ## 责任划分（为什么 stop 之后由探针自己调 close）
 *
 * 「引擎离开 running → 关编辑器视图」这条责任在渲染端面板
 * （`EngineRuntimePanel.tsx` 的 `url === null` 分支）。探针不能跑 React effect，
 * 所以按面板同样的顺序执行同样的两条 IPC（stop → close），并**源码级钉住**
 * 面板里 hide/close 的分工（见 `面板源码` 那条断言）—— 少任何一半，这套就不算闭环。
 *
 * ## 安全边界
 *
 * - 不联网：引擎页面是本地 HTTP 服务返回的自限页（CSP `default-src 'none'`）；
 * - 不碰用户数据根：electron-host.cjs 把所有 app 路径重指到套件 mktemp 目录；
 * - 引擎进程 env 由 `EngineRuntime` 完整替换（只给 PATH/SystemRoot/白名单）。
 */
import { BrowserWindow, ipcMain, session, webContents } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DocumentViewHost } from "@main/document/documentViewHost.js";
import { DocumentViewCredentialBroker, readEngineAdminToken } from "@main/document/documentViewCredentialBroker.js";
import { isApprovedDocumentViewOpen, registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { registerWorkflowEngineHandlers } from "@main/ipc/workflowEngine.js";
import {
  EngineRuntime,
  createEngineLaunchSpec,
  defaultEngineRuntimePorts,
  NODE_RED_MIN_NODE,
  type EngineRuntimePorts,
} from "@main/workflowEngines/runtimeSupervisor.js";
import { rpcHandlerFor, registeredRpcChannels } from "@main/appControl/registry.js";
import { IPC, type DocViewListResult, type DocViewResult, type WorkflowEngineResult } from "@contracts/ipc";
import type { WebContents } from "electron";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

/** 面板的 docId 约定（`EngineRuntimePanel.tsx` 的 `engineDocId`）。探针不改面板，
 *  只按同一约定使用；源码级那条断言会钉住它没有漂。 */
const ENGINE_ID = "node-red";
const DOC_ID = `workflow-engine-${ENGINE_ID}`;

/** 引擎数据目录 + 编辑器页面的几何（与面板 stage 量的形状一致）。 */
const ENGINE_BOUNDS = { x: 20, y: 30, width: 500, height: 400 };

export async function runWorkflowEngineProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const engineDataDir = join(dir, "engine-data");
  const fakeEngine = join(dir, "fake-engine.cjs");
  await mkdir(engineDataDir, { recursive: true });

  const checks: Check[] = [];
  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS WF-ENGINE " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.log("FAIL WF-ENGINE " + name + " — " + String(error));
      throw error;
    } finally {
      await writeFile(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 20000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw new Error("Timed out: " + label);
      await delay(50);
    }
  }

  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL("data:text/html,<title>host</title>");

  // ── 生产同形的注册表：一个 node-red 引擎，入口指向套件的假引擎脚本。 ──
  // 【P1-4】启动参数（command/args/env/Electron-as-Node/宿主身份）由**生产**
  // `createEngineLaunchSpec` 生成，套件**不再自己补** ELECTRON_RUN_AS_NODE ——
  // 生产生成器漏了它，这一整条真 Electron 路径就会起不来（而不是测试替它兜底）。
  // 唯一被替换的是入口脚本（真 Node-RED 未装）；`<dataDir>/node_modules/node-red`
  // 放一个安装标记，让生成器的"已安装"检查与生产同形。
  await mkdir(join(engineDataDir, "node_modules", "node-red"), { recursive: true });
  await writeFile(
    join(engineDataDir, "node_modules", "node-red", "package.json"),
    JSON.stringify({ name: "node-red", version: "0.0.0-fake-engine" }),
    "utf8",
  );
  const launch = createEngineLaunchSpec({
    engineId: ENGINE_ID,
    dataDir: engineDataDir,
    entryFile: fakeEngine, // 绝对路径：生成器直接采用（不查 app 路径）
    installPackage: "node-red",
    minNodeVersion: NODE_RED_MIN_NODE,
    adminTokenFile: join(engineDataDir, ".engine-admin-token"),
    secretFile: engineDataDir,
  });
  assert(launch.env?.ELECTRON_RUN_AS_NODE === "1", "生产 launchSpec 没给 ELECTRON_RUN_AS_NODE —— 真 Electron 下引擎会起成 GUI 进程");
  assert(typeof launch.env?.MCODE_ENGINE_ADMIN_TOKEN === "string" && launch.probeIdentity?.adminToken === launch.env.MCODE_ENGINE_ADMIN_TOKEN,
    "生产 launchSpec 没有把宿主控制面令牌同时放进 env 与 probeIdentity");
  // The old probe used a local allocatePort override to mask a production
  // callback/signature bug. That runtime bug has since been fixed. Use the
  // production allocator directly so future regressions fail this true
  // Electron process+HTTP user-journey test instead of being hidden by a stub.
  const ports: EngineRuntimePorts = defaultEngineRuntimePorts;
  assert(ports.allocatePort === defaultEngineRuntimePorts.allocatePort,
    "真实 Electron U1 探针必须测试生产默认端口分配器，不可注入自实现掩盖回归");
  const runtime = new EngineRuntime(ENGINE_ID, ports);
  const registry = {
    get: (engineId: string): EngineRuntime | null => (engineId === ENGINE_ID ? runtime : null),
    ids: (): string[] => [ENGINE_ID],
    launchSpec: (engineId: string) =>
      engineId === ENGINE_ID
        ? {
            command: launch.command,
            args: launch.args,
            dataDir: launch.dataDir,
            ...(launch.env !== undefined ? { env: launch.env } : {}),
            ...(launch.probeIdentity !== undefined ? { probeIdentity: launch.probeIdentity } : {}),
          }
        : null,
  };

  const credentialBroker = new DocumentViewCredentialBroker({
    readToken: (engineId) => engineId === ENGINE_ID ? readEngineAdminToken(engineDataDir) : null,
    runningPort: (engineId) => engineId === ENGINE_ID && runtime.status().state === "running"
      ? runtime.status().port : null,
    getSession: () => session.defaultSession,
  });
  const host = new DocumentViewHost({
    getMainWindow: () => win as unknown as never,
    editorCredentials: credentialBroker,
  });
  registerDocumentViewHandlers(ipcMain, host, () => true,
    undefined, (input) => isApprovedDocumentViewOpen(input, null));
  registerWorkflowEngineHandlers(ipcMain, { registry, launchSpec: (id) => registry.launchSpec(id) });

  /** 调**真实注册的那个函数对象**（register* 同时交给真 ipcMain 与 recordRpcHandler）。 */
  async function invoke<T = unknown>(channel: string, raw?: unknown): Promise<T> {
    const fn = rpcHandlerFor(channel);
    if (!fn) throw new Error(`handler 没有登记：${channel}`);
    return (await fn(null, raw)) as T;
  }
  const viewOf = (docId: string): WebContents => {
    const wc = host.webContentsOf(docId);
    if (wc === null) throw new Error(`没有 docId=${docId} 的视图`);
    return wc as unknown as WebContents;
  };
  /** 原生视图上**实际**应用的矩形（hide 只把它移到屏幕外）。 */
  const appliedBounds = (docId: string): { x: number; y: number; width: number; height: number } =>
    (host as unknown as { views: Map<string, { view: { getBounds(): { x: number; y: number; width: number; height: number } } }> })
      .views.get(docId)!.view.getBounds();
  const liveWebContentsCount = (): number => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).length;
  /** 页面脚本求值，带期限。视图**没有导航过**时 `executeJavaScript` 会永远挂着
   *  （renderer 还没起），裸 await 会把整条断言拖到宿主 120s 超时、连一句 FAIL
   *  都不留 —— 变异验证实测踩到。5s 无响应就按「页面没加载」在**这条断言上**红。 */
  async function evaluate<T>(view: WebContents, expression: string): Promise<T> {
    return (await Promise.race([
      view.executeJavaScript(expression, true),
      delay(5000).then((): never => {
        throw new Error(`页面无响应（5s 内 executeJavaScript 未返回）：${expression.slice(0, 80)}`);
      }),
    ])) as T;
  }

  const listenerBaseline = win.listenerCount("closed");
  const wcBaseline = liveWebContentsCount();

  let editorUrl = "";
  let enginePort = 0;

  try {
    await check("真窗口 + 真宿主就绪，引擎/视图八条 RPC 都经 recordRpcHandler 登记", () => {
      assert(!win.isDestroyed(), "窗口不存在");
      const rpc = new Set(registeredRpcChannels());
      const missing = [
        IPC.WORKFLOW_ENGINE_START, IPC.WORKFLOW_ENGINE_STOP, IPC.WORKFLOW_ENGINE_STATUS, IPC.WORKFLOW_ENGINE_LIST,
        IPC.DOCUMENT_VIEW_OPEN, IPC.DOCUMENT_VIEW_HIDE, IPC.DOCUMENT_VIEW_SHOW, IPC.DOCUMENT_VIEW_CLOSE,
      ].filter((c) => !rpc.has(c));
      assert(missing.length === 0, `未登记：${missing.join(",")}`);
      // 不假设基线为 0：Electron 自己也可能挂 `closed` 监听。只记录基线，
      // 由 dispose 那条断言要求监听数回到它。
      assert(typeof listenerBaseline === "number", "窗口监听基线没取到");
    });

    await check("start 经真 handler 起真引擎进程 → running，editorUrl 是回环且端口一致", async () => {
      const result = await invoke<WorkflowEngineResult>(IPC.WORKFLOW_ENGINE_START, { engineId: ENGINE_ID });
      assert(result.ok, `start 失败：${JSON.stringify(result)}`);
      const status = result.status!;
      assert(status.state === "running", `状态不是 running：${status.state}`);
      assert(typeof status.port === "number" && status.port > 0, `端口无效：${status.port}`);
      enginePort = status.port as number;
      assert(status.editorUrl === `http://127.0.0.1:${enginePort}/`, `editorUrl 不是回环根：${status.editorUrl}`);
      editorUrl = status.editorUrl as string;
      const parsed = new URL(editorUrl);
      assert(parsed.hostname === "127.0.0.1", `hostname 不是回环：${parsed.hostname}`);
      assert(Number(parsed.port) === enginePort, `editorUrl 端口 ${parsed.port} != status.port ${enginePort}`);
    });

    await check("editorUrl 真的拨得通：HTTP 200 且是引擎编辑器页", async () => {
      const res = await fetch(editorUrl, { signal: AbortSignal.timeout(5000) });
      assert(res.status === 200, `HTTP ${res.status}`);
      const html = await res.text();
      assert(html.includes("<title>engine editor</title>"), "返回的不是引擎编辑器页");
    });

    await check("引擎进程落在宿主给的数据目录（spawn 的 cwd/args 真的传下去了）", async () => {
      const bootFile = join(engineDataDir, "engine-boot.txt");
      await until(async () => {
        try {
          return (await readFile(bootFile, "utf8")).includes(`127.0.0.1:${enginePort}`);
        } catch {
          return false;
        }
      }, "引擎把 boot 标记写进 dataDir", 10000);
      const text = await readFile(bootFile, "utf8");
      assert(text === `booted on 127.0.0.1:${enginePort}`, `boot 文件内容不符：${text}`);
    });

    await check("真 WebContentsView 经 documentView.open 加载编辑器地址成功（origin 是引擎端口）", async () => {
      const opened = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: DOC_ID, url: editorUrl, bounds: ENGINE_BOUNDS, visible: true, workflowEngineId: ENGINE_ID,
      });
      assert(opened.ok, `open 失败：${JSON.stringify(opened)}`);
      const snap = host.list();
      assert(snap.length === 1 && snap[0].docId === DOC_ID, `快照不符：${JSON.stringify(snap)}`);
      assert(snap[0].visible === true, "视图应可见");
      assert(JSON.stringify(snap[0].bounds) === JSON.stringify(ENGINE_BOUNDS), `bounds ${JSON.stringify(snap[0].bounds)}`);
      const view = viewOf(DOC_ID);
      await until(async () => (await evaluate(view, "document.readyState")) === "complete", "页面 DOM 完成");
      const title = await evaluate<string>(view, "document.title");
      assert(title === "engine editor", `页面标题不符：${title}`);
      const mark = await evaluate<string>(view, "document.body.dataset.engine");
      assert(mark === `loaded:http://127.0.0.1:${enginePort}`, `页面 origin 不符：${mark}`);
      assert(snap[0].lastFailure === undefined, `加载失败：${JSON.stringify(snap[0].lastFailure)}`);
      assert(appliedBounds(DOC_ID).x === ENGINE_BOUNDS.x, "原生视图几何没有应用");
    });

    await check("真实 Electron 编辑器视图获取宿主注入的控制面权限、外部调用仍 401", async () => {
      // The renderer never receives the raw token: Broker injects only the
      // bound webContentsId and exact engine origin on the main-process side.
      const token = readEngineAdminToken(engineDataDir);
      if (token === null || token.length === 0) {
        throw new Error("生产生成的 Host 控制面令牌不可用");
      }
      assert(!editorUrl.includes(token), "禁止将 Host 令牌拼到编辑器 URL");
      const credentialBinding = credentialBroker.debugState();
      assert(credentialBinding.length === 1 && credentialBinding[0]?.docId === DOC_ID
        && credentialBinding[0]?.engineId === ENGINE_ID
        && credentialBinding[0]?.webContentsId === viewOf(DOC_ID).id,
        "真实视图凭据未绑定到正确的 webContentsId + 引擎");
      assert(!JSON.stringify(host.list()).includes(token)
        && !JSON.stringify(credentialBinding).includes(token)
        && !JSON.stringify(runtime.status()).includes(token),
        "Host 令牌不得进入视图/引擎状态/凭据诊断快照");
      const unauthorized = await fetch(`http://127.0.0.1:${enginePort}/settings`,
        { signal: AbortSignal.timeout(5000) });
      assert(unauthorized.status === 401, "没有 webContents 身份的宿主直接请求应被拒");
      const authorizedStatus = await evaluate<number>(viewOf(DOC_ID),
        "fetch('/settings').then(r => r.status)");
      assert(authorizedStatus === 200,
        `真实 WebContentsView 发出的 Node-RED /settings 应获得宿主 Header，实际 ${authorizedStatus}`);
    });

    await check("编辑器页面里的请求真的到达引擎进程（deploy 端到端）", async () => {
      const view = viewOf(DOC_ID);
      const reply = await evaluate<string>(view, "window.__deploy()");
      assert(reply === "1", `页面拿到的 deploy 回包不符：${reply}`);
      const state = (await (await fetch(`http://127.0.0.1:${enginePort}/__state`)).json()) as { deploys: number; lastBody: string | null };
      assert(state.deploys === 1, `引擎侧收到的 deploy 次数：${state.deploys}`);
      assert((state.lastBody ?? "").includes('"flow":"u1"'), `引擎侧请求体不符：${state.lastBody}`);
    });

    await check("页签切走 → hide：不销毁、页面状态保留、视图移出屏幕", async () => {
      const view = viewOf(DOC_ID);
      const markerBefore = await evaluate<string>(view, "window.__marker");
      const hidden = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_HIDE, { docId: DOC_ID });
      assert(hidden.ok, `hide 失败：${JSON.stringify(hidden)}`);
      const snap = host.list()[0];
      assert(snap.visible === false, "快照应标为不可见");
      assert(snap.bounds.x === ENGINE_BOUNDS.x, `快照应保留逻辑几何：${JSON.stringify(snap.bounds)}`);
      const applied = appliedBounds(DOC_ID);
      assert(applied.x === -9999 && applied.y === -9999, `视图未移出屏幕：${JSON.stringify(applied)}`);
      assert(applied.width === ENGINE_BOUNDS.width, `隐藏应保留宽高：${JSON.stringify(applied)}`);
      assert(!view.isDestroyed(), "hide 不应销毁 webContents");
      const markerAfter = await evaluate<string>(view, "window.__marker");
      assert(markerAfter === markerBefore, "hide 后页面被重载（marker 变了）");
    });

    await check("切回 → show：恢复几何，仍是同一个 webContents（没有重新加载）", async () => {
      const viewBefore = viewOf(DOC_ID);
      const markerBefore = await evaluate<string>(viewBefore, "window.__marker");
      const shown = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_SHOW, { docId: DOC_ID });
      assert(shown.ok, `show 失败：${JSON.stringify(shown)}`);
      const snap = host.list()[0];
      assert(snap.visible === true, "show 后应可见");
      assert(appliedBounds(DOC_ID).x === ENGINE_BOUNDS.x, `show 后坐标未恢复：${JSON.stringify(appliedBounds(DOC_ID))}`);
      const viewAfter = viewOf(DOC_ID);
      assert(viewAfter === viewBefore, "show 重建了 webContents（应复用）");
      const markerAfter = await evaluate<string>(viewAfter, "window.__marker");
      assert(markerAfter === markerBefore, "show 触发了重新加载（marker 变了）");
    });

    await check("非回环 URL 被 URL 围栏拒，且不创建任何 webContents（先拒后建）", async () => {
      const wcBefore = liveWebContentsCount();
      const remote = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: "u1-remote", url: "https://example.com/editor", bounds: ENGINE_BOUNDS, visible: true,
        workflowEngineId: ENGINE_ID,
      });
      assert(remote.ok === false, "远程 URL 应被拒");
      const remoteReason = (remote as { reason?: string }).reason ?? "";
      assert(/example\.com/.test(remoteReason), `拒绝原因应点名主机：${remoteReason}`);
      const disguised = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: "u1-disguised", url: `http://localhost.evil.com:${enginePort}/`, bounds: ENGINE_BOUNDS, visible: true,
        workflowEngineId: ENGINE_ID,
      });
      assert(disguised.ok === false, "伪装回环后缀应被拒");
      // The new FULL-1 Host policy requires a declared workflow engine
      // identity for *any* loopback URL. A bare localhost address is not
      // authority, even when the URL itself is otherwise valid.
      const unnamed = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: "u1-no-engine-identity", url: editorUrl,
        bounds: ENGINE_BOUNDS, visible: true,
      });
      assert(unnamed.ok === false && /受信|引擎|匹配/.test(unnamed.reason ?? ""),
        "没有 workflowEngineId 不得打开真实引擎回环视图");
      const foreignPort = enginePort === 65535 ? enginePort - 1 : enginePort + 1;
      const mismatched = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: "u1-engine-wrong-port", url: `http://127.0.0.1:${foreignPort}/`,
        bounds: ENGINE_BOUNDS, visible: true, workflowEngineId: ENGINE_ID,
      });
      assert(mismatched.ok === false && /端口/.test(mismatched.reason ?? ""),
        "声明正确引擎但回环端口不匹配必须由凭据边界拒绝");
      await delay(150);
      assert(liveWebContentsCount() === wcBefore, `被拒后 webContents 数量变了：${wcBefore} → ${liveWebContentsCount()}`);
      assert(host.list().length === 1, `被拒后不应多出视图：${host.list().length}`);
    });

    await check("面板源码：url 变 null 才 close，页签切走只 hide（责任划分未漂）", async () => {
      const panelSrc = await readFile(
        join(process.cwd(), "src/renderer/components/settings/workflows/EngineRuntimePanel.tsx"), "utf8");
      assert(/return `workflow-engine-\$\{engineId\}`/.test(panelSrc), "engineDocId 约定变了（探针的 docId 会失配）");
      assert(/url === null[\s\S]{0,400}?closeQuietly\(docId\)/.test(panelSrc), "离开 running 时必须关闭视图");
      assert(/if \(!active\)[\s\S]{0,600}?documentView\.hide\(\{ docId \}\)/.test(panelSrc), "页签切走必须只 hide");
      const inactiveBranch = panelSrc.slice(panelSrc.indexOf("if (!active)"), panelSrc.indexOf("const stage = stageRef.current"));
      assert(!inactiveBranch.includes("closeQuietly"), "页签切走的分支里不得 close（会丢编辑状态）");
    });

    await check("引擎 stop：状态 stopped、editorUrl 变 null、端口不再应答", async () => {
      const stopped = await invoke<WorkflowEngineResult>(IPC.WORKFLOW_ENGINE_STOP, { engineId: ENGINE_ID });
      assert(stopped.ok, `stop 失败：${JSON.stringify(stopped)}`);
      assert(stopped.status?.state === "stopped", `状态不是 stopped：${stopped.status?.state}`);
      assert(stopped.status?.editorUrl === null, `stopped 时 editorUrl 应为 null：${stopped.status?.editorUrl}`);
      await until(async () => {
        try {
          await fetch(editorUrl, { signal: AbortSignal.timeout(800) });
          return false;
        } catch {
          return true;
        }
      }, "引擎端口停止应答", 8000);
    });

    await check("stop 后视图 close（照面板顺序）：快照清空、webContents 销毁、不留孤儿", async () => {
      const view = viewOf(DOC_ID);
      const closed = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_CLOSE, { docId: DOC_ID });
      assert(closed.ok, `close 失败：${JSON.stringify(closed)}`);
      await until(() => view.isDestroyed(), "webContents 销毁", 8000);
      assert(host.list().length === 0, `close 后快照应为空：${JSON.stringify(host.list())}`);
      assert(credentialBroker.debugState().length === 0,
        "视图 close 必须立即撤销 Host 编辑器令牌绑定，不能残留到租约自然过期");
      await until(() => liveWebContentsCount() === wcBaseline, `webContents 总数回到基线（当前 ${liveWebContentsCount()}，基线 ${wcBaseline}）`, 8000);
      const listed = await invoke<DocViewListResult>(IPC.DOCUMENT_VIEW_LIST);
      assert(listed.views.length === 0, `list 仍有视图：${JSON.stringify(listed.views)}`);
    });

    await check("dispose() 摘掉窗口 closed 监听（listenerCount 回到打开前的基线），之后 open 被拒", async () => {
      assert(win.listenerCount("closed") === listenerBaseline + 1, `open 后窗口 closed 监听应比基线多 1，实际 ${win.listenerCount("closed")}（基线 ${listenerBaseline}）`);
      host.dispose();
      assert(win.listenerCount("closed") === listenerBaseline, `dispose 后监听数 ${win.listenerCount("closed")} != 基线 ${listenerBaseline}`);
      // 用一个**合法回环** URL 再 open：围栏会放行，拒绝必须来自"宿主已释放"，
      // 否则这条断言会被 URL 围栏替宿主"挡"成假绿。
      const after = await invoke<DocViewResult>(IPC.DOCUMENT_VIEW_OPEN, {
        docId: "u1-after-dispose", url: `http://127.0.0.1:${enginePort}/`, bounds: ENGINE_BOUNDS, visible: true, workflowEngineId: ENGINE_ID,
      });
      // 围栏会放行（回环），所以拒绝只能来自"宿主已释放" —— 否则这条断言会被
      // URL 围栏替宿主"挡"成假绿。
      assert(after.ok === false, "dispose 后 open 应被拒");
      assert((after as { reason?: string }).reason?.includes("释放") === true, `拒绝原因应点名已释放：${(after as { reason?: string }).reason}`);
      assert(host.list().length === 0, "dispose 后不应有视图");
    });

    await check("引擎已停后再 stop 幂等，收尾没有任何残留视图/孤儿 webContents", async () => {
      await runtime.stop();
      assert(runtime.status().state === "stopped", `dispose 后引擎状态：${runtime.status().state}`);
      assert(liveWebContentsCount() === wcBaseline, `收尾 webContents ${liveWebContentsCount()} != 基线 ${wcBaseline}`);
      assert(host.list().length === 0, "收尾仍有视图");
    });
  } finally {
    try { host.dispose(); } catch { /* 已释放 */ }
    try { await runtime.stop(1000); } catch { /* 已停 */ }
    if (!win.isDestroyed()) win.destroy();
    await writeFile(evidence, JSON.stringify(checks, null, 2));
  }
}
