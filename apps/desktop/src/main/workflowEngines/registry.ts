/**
 * 【ARC-006 WF-INT】**生产装配：第三方工作流引擎注册表**。
 *
 * ## 它做什么
 *
 * 把「引擎 id → `EngineRuntime` 实例 + 启动参数」收成一份，供 IPC handler 使用。
 * 当前只注册 **node-red**（方案文档的首选），但注册表本身不绑定具体引擎：
 * 加第二个引擎只需要在这里多一条。
 *
 * ## 为什么启动命令是"懒解析"的
 *
 * Node-RED 不在 Mcode 的主依赖树里（它是可选能力，见方案文档的取舍 1）。它装没装
 * 是**运行时**才知道的事，所以 `launchSpec()` 每次现解析：
 *   - 首选固定 5.0.8 vendor（开发 repo checkout / 打包 resources/node-red）；
 *   - vendor 不可用时显式记录并回退到旧的 npm 包，均缺失才返回 null。
 *
 * ## 数据目录
 *
 * `<dataRoot>/workflow-engines/<engineId>/` —— 引擎自己的 flows.json / creds 都在这里，
 * 不碰用户项目。目录在首次启动时创建。
 *
 * ## 为什么用 node 跑一个引导脚本，而不是直接 spawn node-red
 *
 * Node-RED 的 CLI（`node-red`）会自己起 HTTP 服务并读 settings.js；但我们要：
 *   1. 端口由**宿主**分配（CLI 的 `PORT` env 也能做到，但 `--port` 的优先级在不同
 *      版本里变过，不值得赌）；
 *   2. 就绪判据由宿主控制（HTTP 探活）。
 * 所以写一个最小引导脚本，端口从 argv 拿。
 *
 * ## 挂载形状（ARC-006 Gate A，官方 embedding 形状）
 *
 * Node-RED 的 `RED.httpAdmin` / `RED.httpNode` 是**等着宿主挂载**的 Express app：
 * `RED.init(server, settings)` 只初始化运行时，**不会**把任何请求处理器接到 server 上。
 * 早先这里的引导脚本只 `http.createServer()` + `listen()` + `RED.init()`，结果端口在
 * 听、编辑器和 HTTP-in 却没有任何路由（台账 2026-10-18 专项复审 P0-1，真引擎实测
 * GET / 无响应）。现在的形状与官方 embedding 一致：
 *
 *   1. `express()` + `http.createServer((req,res) => app(req,res))`；
 *   2. `RED.init(server, settings)`；
 *   3. `app.use("/", RED.httpAdmin)`、`app.use("/api", RED.httpNode)`；
 *   4. `RED.start()`，**resolve 之后**才 `server.listen(...)`（先 listen 会让端口先通、
 *      runtime 未起，编辑器回 503，宿主探针误判就绪 —— 真引擎实测抓到）。
 *
 * ## 认证（同批修复的 P0-2）
 *
 * Node-RED 官方默认是「能连到端口的客户端就能改 flow、deploy、装节点」。这里给
 * `adminAuth` 配一个**宿主签发**的静态令牌（`.engine-admin-token`，随 env 注入，
 * 绝不进 status / 日志 / flows）：`tokens` 校验函数只认这一个值，`permissions: "*"`。
 * 没有 `default` 匿名用户 —— 未带 `Authorization: Bearer <token>` 的本机客户端访问
 * Admin API（/flows、/settings、/nodes…）一律 401，deploy 与装节点同样被拒。
 * HTTP-in 路由不受 adminAuth 影响（那是数据面，不是控制面）。
 *
 * ## 持久化 flow 的可信启动
 *
 * 引擎**每次启动默认 safeMode**：flows 会从磁盘加载（编辑器里看得到），但**不会
 * 进入 runtime 执行**（HTTP-in 404、定时器/function 节点不跑）。只有宿主写下
 * `engine-trust.json` = `{"trusted":true}` 才放开。标记缺失/损坏一律按 untrusted
 * 处理（fail-closed）。Gate A 只实现这个「默认不自动执行」的边界；把标记的写入接到
 * Mcode 的 `workflow.approve`（工作流审查 + 真人点头）属于 MERGE-1 的存储合并，
 * 这里不新造第二套授权入口 —— `launchSpec` 只**读**标记，不提供写 API。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { sharedExecutorOwnership, type ExecutorOwnershipRegistry } from "./executorOwnership.js";
import { nativeFlowIds, nativeFlowIdsOfNodes, claimNativeFlows } from "./nodeRedOwnership.js";
import { join, relative, sep } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { bindProjectDirectoryIdentity, resolveProjectFlowDir } from "./projectFlowDir.js";
import { log } from "@main/lib/logger.js";
import { ensureEngineBootstrap } from "./bootstrapManifest.js";
import { ensureNodePack } from "./nodePackManifest.js";
import { NodePackHost, type NodePackHostServices } from "./nodePackHost.js";
import { productionNodePackServices, emitNativeRunboardEvent } from "@main/workflowEngines/nodePackProductionPorts.js";
import { createConditionTriggerBridge, type ManualTicket } from "./conditionHostPorts.js";
import { assertNativeEngineSelection, effectiveWorkflowEngine } from "./workflowEngineSelection.js";
import { getWorkflow } from "@main/orchestration/library.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import {
  isNativeMirrorReport,
  readNativeDeployReconciliation,
  reconcileNativeLibraryMirror,
  describeNativeMirrorFailure,
  nativeMirrorEvents,
  runNativeDeployMirror,
  type NativeMirrorReport,
} from "./nativeLibrarySync.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { WorkflowDoc } from "@contracts/workflow";
import {
  EngineRuntime,
  createEngineLaunchSpec,
  defaultEngineRuntimePorts,
  NODE_RED_MIN_NODE,
  type EngineRuntime as EngineRuntimeType,
  type EngineRuntimeStatus,
  type EngineRuntimePorts,
  type EngineStartOptions,
} from "./runtimeSupervisor.js";
import type { WorkflowEngineLaunchSpec, WorkflowEngineRegistry } from "@main/ipc/workflowEngine.js";

/** 引导脚本：官方 embedding 形状 + 宿主令牌认证 + 默认 safeMode（见文件头）。 */
const BOOTSTRAP = `// 【ARC-006 Gate A】Node-RED 引导 —— 端口与数据目录由 Mcode 宿主给。
// 挂载形状与 Node-RED 官方 embedding 一致：RED.httpAdmin / RED.httpNode 是等待
// 宿主挂载的 Express app，RED.init 不会替宿主接路由。
const RED = require("node-red");
const express = require("express");
const http = require("node:http");
const port = Number(process.argv[2]);
const userDir = process.argv[3];
const adminToken = process.env.MCODE_ENGINE_ADMIN_TOKEN || "";
const safeMode = process.env.MCODE_ENGINE_TRUSTED !== "1";

const app = express();
const server = http.createServer((req, res) => app(req, res));

RED.init(server, {
  httpAdminRoot: "/",
  httpNodeRoot: "/api",
  userDir,
  nodesDir: [require("node:path").join(__dirname, "mcode-node-pack")],
  // 固定的 flow 文件名：不随机器 hostname 漂移，宿主才能确定性地管这一份流。
  flowFile: "flows.json",
  // 凭据密钥由宿主注入（见 launchSpec 的 NODE_RED_CREDENTIAL_SECRET）。
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || false,
  // 未审批的持久化 flow 不进入 runtime 执行；只有宿主写下的可信标记才放开。
  safeMode,
  // T47: single editor stylesheet. Chromium prefers-color-scheme switches the
  // light/dark variables immediately; never restart a running flow to retheme.
  editorTheme: { page: { css: process.env.MCODE_ENGINE_THEME_CSS || "" } },
  // 控制面认证：只认宿主签发的那一个令牌。没有 default 匿名用户 —— 未带
  // Authorization: Bearer <token> 的客户端访问 Admin API 一律 401。
  adminAuth: {
    type: "credentials",
    tokens: function (token) {
      return new Promise(function (resolve) {
        resolve(adminToken !== "" && token === adminToken
          ? { username: "mcode-host", permissions: "*" }
          : null);
      });
    },
  },
  logging: { console: { level: "warn" } },
});

// T60: Status is a *different* event from runtime-event in Node-RED 5.x.
// The native inject/debug nodes do not publish a status for every input, so
// observe the documented message lifecycle hooks too. No message body leaves
// the child: only identifiers, node type, stage, and bounded status text.
const nativeRuns = new Map();
const latestNativeRun = new Map();
function publishNativeNode(node, msg, stage, error) {
  if (!node || typeof node.id !== "string" || typeof node.z !== "string"
      || typeof node.type !== "string" || node.type.startsWith("mcode-")
      || typeof process.send !== "function") return;
  const id = msg && typeof msg._msgid === "string" && msg._msgid.length <= 128
    ? msg._msgid : null;
  if (!id) return;
  const key = node.id + ":" + id;
  if (stage === "running") {
    nativeRuns.set(key, { runId: id, failed: false });
    latestNativeRun.set(node.id, id);
  }
  const tracked = nativeRuns.get(key);
  const failed = !!error || !!(tracked && tracked.failed);
  try {
    process.send({
      kind: "mcode-native-node-stage", nodeId: node.id, tabId: node.z,
      nodeType: node.type, title: String(node.name || node.type).slice(0, 160),
      runId: id, stage, failed, at: Date.now(),
    });
  } catch (_) {}
  if (stage === "settled") {
    nativeRuns.delete(key);
    if (latestNativeRun.get(node.id) === id) latestNativeRun.delete(node.id);
  }
}
RED.hooks.add("onReceive.mcode-runboard", function (event) {
  publishNativeNode(event && event.destination && event.destination.node,
    event && event.msg, "running");
});
RED.hooks.add("onComplete.mcode-runboard", function (event) {
  publishNativeNode(event && event.node && event.node.node,
    event && event.msg, "settled", event && event.error);
});
RED.events.on("node-status", function (event) {
  if (!event || typeof event.id !== "string" || !event.status) return;
  const latest = latestNativeRun.get(event.id);
  const tracked = latest && nativeRuns.get(event.id + ":" + latest);
  if (!tracked) return;
  const fill = event.status.fill;
  // Red and yellow are failures (exec uses yellow for nonzero rc).
  if (fill === "red" || fill === "yellow") tracked.failed = true;
  if (typeof process.send !== "function") return;
  try {
    process.send({
      kind: "mcode-native-node-status", nodeId: event.id, runId: tracked.runId,
      fill, text: String(event.status.text || "").slice(0, 160), at: Date.now(),
    });
  } catch (_) {}
});
RED.events.on("runtime-event", function (event) {
  // runtime-event covers deploy/engine notifications, NOT node-status.
  if (event && event.id === "runtime-state" && event.payload
      && event.payload.state === "stop") {
    nativeRuns.clear();
    latestNativeRun.clear();
  }
});

// Gate D: a *real* Node-RED admin deploy must reserve owners in the parent
// process BEFORE RED.httpAdmin can apply a new flow. The child cannot edit the
// registry and the parent cannot trust a deploy until Node-RED reports 2xx.
const pendingDeploys = new Map();
let deploySequence = 0;
process.on("message", function (message) {
  if (!message || message.kind !== "mcode-deploy-reply") return;
  const pending = pendingDeploys.get(message.id);
  if (!pending) return;
  pendingDeploys.delete(message.id);
  pending(message);
});
const parseDeploy = express.json({ limit: "10mb" });
// Native single-flow admin endpoints and unhandled flow-changing verbs would
// bypass the parent reservation protocol. Fail closed, retaining the normal
// Node-RED 401 response for requests with no valid admin token.
app.use(function (req, res, next) {
  const write = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  const single = req.path === "/flow" || req.path.startsWith("/flow/");
  const unsupportedBulk = (req.path === "/flows" || req.path.startsWith("/flows/"))
    && !(req.path === "/flows" && req.method === "POST");
  if (write && (single || unsupportedBulk)
      && req.headers.authorization === "Bearer " + adminToken && adminToken !== "") {
    res.status(423).json({ error: "Use Host-mediated POST /flows to deploy" });
    return;
  }
  next();
});
app.use("/flows", function (req, res, next) {
  if (req.method !== "POST") return next();
  // The normal Node-RED adminAuth remains authoritative. Do not reserve
  // anything for an unauthenticated request; let Admin return its own 401.
  if (adminToken === "" || req.headers.authorization !== "Bearer " + adminToken) return next();
  if (typeof process.send !== "function") {
    res.status(423).json({ error: "Host ownership IPC unavailable" });
    return;
  }
  parseDeploy(req, res, function (parseError) {
    if (parseError) { next(parseError); return; }
    const parsed = req.body;
    const flows = Array.isArray(parsed) ? parsed : parsed && parsed.flows;
    if (!Array.isArray(flows)) {
      res.status(400).json({ error: "Expected Node-RED flows array" });
      return;
    }
    const id = String(++deploySequence);
    let finished = false;
    const final = function (success, uncertain) {
      if (finished) return;
      finished = true;
      try { process.send({ kind: "mcode-deploy-final", id, success, uncertain: !!uncertain }); } catch (_) {}
    };
    const timer = setTimeout(function () {
      const cb = pendingDeploys.get(id);
      if (!cb) return;
      pendingDeploys.delete(id);
      final(false);
      res.status(423).json({ error: "Host ownership response timed out" });
    }, 5000);
    pendingDeploys.set(id, function (answer) {
      clearTimeout(timer);
      if (!answer.ok) {
        final(false);
        res.status(423).json({ error: answer.reason || "Executor owner conflict" });
        return;
      }
      res.once("finish", function () {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        // 409 = Node-RED revision CAS rejection (no apply). Other error
        // statuses might follow a partially applied flow: retain reservations.
        final(success, !success && res.statusCode !== 409);
      });
      res.once("close", function () { final(false, true); });
      next();
    });
    try {
      process.send({ kind: "mcode-deploy-prepare", id, flows }, function (err) {
        if (err && pendingDeploys.has(id)) {
          clearTimeout(timer);
          pendingDeploys.delete(id);
          final(false);
          res.status(423).json({ error: "Host ownership IPC failed" });
        }
      });
    } catch (_) {
      clearTimeout(timer);
      pendingDeploys.delete(id);
      final(false);
      res.status(423).json({ error: "Host ownership IPC failed" });
    }
  });
});
// Single-flow Admin mutation endpoints bypass POST /flows; disallow them until
// they can use the same Host ownership handshake (no silent native redeploy).
app.use(function (req, res, next) {
  const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (mutation && (req.path === "/flow" || req.path.startsWith("/flow/") ||
      (req.path.startsWith("/flows/") && req.path !== "/flows"))) {
    res.status(423).json({ error: "Use owner-verified POST /flows for deployment" });
    return;
  }
  next();
});
process.on("disconnect", function () {
  // A killed/crashed Electron main process must not leave an orphan Node-RED
  // engine executing old cron, file or event triggers with no parent owner.
  process.exit(0);
});
app.use("/", RED.httpAdmin);
app.use("/api", RED.httpNode);

// 令牌与凭据密钥已被 init 读进闭包/内存；从 process.env 抹掉，避免部署后的
// Function 节点或第三方节点在 process.env 里捡到控制面令牌（进程内隔离不是
// Gate A 的威胁模型，但这一步没有代价）。
delete process.env.MCODE_ENGINE_ADMIN_TOKEN;
delete process.env.NODE_RED_CREDENTIAL_SECRET;

// 官方 embedding 的顺序：**先 RED.start()，再 listen**。反过来（先 listen 再 start）
// 会让「端口通了」不等于「runtime 已起」—— 编辑器页会在 ensureRuntimeStarted 上回
// 503，而宿主探针只看 HTTP status > 0，于是把未就绪误判成 running（真引擎实测抓到）。
RED.start().then(
  function () {
    server.listen(port, "127.0.0.1", function () {
      // 只用 stderr 打日志：stdout 留给将来可能的协议行。绝不打印令牌。
      console.error("[mcode-engine] node-red ready on " + port + (safeMode ? " (safeMode: flows not started)" : ""));
    });
  },
  function (err) {
    console.error("[mcode-engine] node-red start failed: " + (err && err.message));
    process.exit(2);
  },
);
`;

const ENGINE_IDS = ["node-red"] as const;

/** T47: resolve the Node-RED theme shipped as a real file (outside ASAR).
 * In development the same tracked CSS lives under apps/desktop/resources.
 * A missing stylesheet must not silently launch an unthemed editor. */
export function resolveMcodeNodeRedThemeCss(options?: { resourcesPath?: string; cwd?: string }): string {
  const base = options?.cwd ?? process.cwd();
  const resources = options?.resourcesPath ?? process.resourcesPath;
  const candidates = [
    ...(resources ? [join(resources, "node-red", "mcode-theme", "mcode-theme-auto.css")] : []),
    join(base, "resources", "node-red", "mcode-theme-auto.css"),
    join(base, "apps", "desktop", "resources", "node-red", "mcode-theme-auto.css"),
  ];
  const css = candidates.find((path) => existsSync(path));
  if (!css) throw new Error("Node-RED Mcode 主题资源缺失：" + candidates.join(" | "));
  return css;
}

/**
 * 【ARC-006 MERGE-1】受管 Node-RED 目录的单一创建围栏。
 *
 * 仅信任配置好的 dataRoot() 本身；从 workflow-engines 起，任何中间目录或
 * 项目叶子一旦被 Windows junction / POSIX symlink（或非目录实体）替代，
 * 就不得跟随 mkdirSync({recursive:true}) 写到外部。先检查再创建，创建后复核，
 * 缓存命中也必须重新经过这里，避免运行中替换目录后旁路。
 *
 * 这不是 OS 级原子沙箱：恶意进程在 lstat 与 mkdir 之间抢换仍有 TOCTOU；
 * 完整对抗需要 handle-relative NOFOLLOW / 受限 OS 账户，在 ARC-006 Gate E 跟踪。
 */
function makeManagedEngineDirectory(root: string, segments: readonly string[]): string {
  const checkExisting = (): void => {
    let cursor = root;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`受管工作流目录不允许链接或非目录路径：${cursor}`);
        }
      } catch (err) {
        // 仅真正不存在的路径可以由受控 mkdir 创建；权限错误、循环链接等不得放行。
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  };
  checkExisting();
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  checkExisting();
  return dir;
}

/**
 * 写入引导脚本。**【ARC-006 Gate B / P1-5】版本 + sha256 清单校验**（见
 * `bootstrapManifest.ts`）：内容一致则不动；旧版/被篡改/缺失清单时**先备份旧字节再
 * 原子替换**；替换失败 → 调用方**不得启动旧脚本**（返回 false）。同一目录下的
 * `flows.json` / `flows_cred.json` 是用户数据，本函数不碰。
 */
function writeEngineBootstrap(engineId: string, dataDir: string): boolean {
  const result = ensureEngineBootstrap({ engineId, dataDir, content: BOOTSTRAP });
  if (!result.ok) {
    log.error(
      `[workflow-engine:${engineId}] 引导脚本完整性校验失败，拒绝启动：${result.reason ?? "未知原因"}`,
    );
    return false;
  }
  return true;
}

/**
 * 持久化 flow 是否已被宿主标记为可信（Gate A 的「未审批 flow 重启后不得自动执行」）。
 *
 * 标记是宿主数据目录下的 `engine-trust.json`，**只有** `{"trusted":true}` 算数；
 * 缺失、坏 JSON、其它形状一律 untrusted（fail-closed）。这里刻意**只读不写**：
 * 写标记的入口将来接 Mcode 的 `workflow.approve`（工作流审查 + 真人点头），
 * 本层不新造第二套授权通道。
 */
export function isFlowTrusted(dataDir: string): boolean {
  try {
    const raw = readFileSync(join(dataDir, "engine-trust.json"), "utf8");
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && (value as { trusted?: unknown }).trusted === true;
  } catch {
    return false;
  }
}

/**
 * Old migration accidentally saved manual Mcode triggers as once=true.
 * Native Node-RED interprets this as "run at Deploy/start", not "click".
 * Gate both saved flows.json on start and pending native deploy input; leave
 * genuine Node-RED native inject nodes untouched.
 */
export function assertSafeMigratedManualInject(flows: unknown): void {
  if (!Array.isArray(flows)) return;
  for (const value of flows) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (node["type"] !== "inject" || !node["once"]) continue;
    const meta = node["x-mcode"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    const record = meta as Record<string, unknown>;
    const params = record["params"];
    if (record["type"] === "mcode.trigger" && params && typeof params === "object"
      && !Array.isArray(params) && (params as Record<string, unknown>)["triggerKind"] === "manual") {
      throw Error("旧版手动工作流启用了 once 自动运行：请移除 Inject 的「启动时注入」并重新部署，禁止自动执行");
    }
  }
}

/** Production runtime owns each native tab from before spawn to child exit. */
export class OwnedNodeRedRuntime extends EngineRuntime {
  private ownedFlowIds: string[] = [];
  private pendingDeploy: { id: string; flowIds: string[]; added: string[]; flows: unknown } | null = null;
  /** Acknowledged native POST /flows in THIS OS child, not persisted trust. */
  private deploymentState: "not-deployed" | "deployed" | "unknown" = "unknown";
  private untrustedAtStart = true;
  /** Uncertain deploy could have replaced the native graph without an ack. */
  private nativeDeployUncertain = false;
  private nodePackHost: NodePackHost | null = null;
  private manualTicketIssuer: ((docId: string, facts: Readonly<Record<string, unknown>>) => ManualTicket) | null = null;
  private adminToken: string | null = null;
  private nativeTabs = new Map<string, string>();
  private nativeNodes = new Map<string, { tabId: string; nodeId: string; type: string; title: string; manualDispatchReady: boolean }>();
  private nativeSettled = new Set<string>();
  /** Engine data directory of the current start (hosts flows.json and the
   * deploy↔library reconciliation ledger). */
  private engineDataDir: string | null = null;
  /** T2: last deploy↔library reconciliation state, kept for status/diagnostics.
   * It is a *middle state* (“native deploy committed, library mirror pending”),
   * never claimed to be one cross-store transaction. */
  private lastLibraryMirror: (NativeMirrorReport & { error: string | null }) | null = null;
  private indexNativeNodes(flows: unknown): void {
    const next = new Map<string, { tabId: string; nodeId: string; type: string; title: string; manualDispatchReady: boolean }>();
    const deployed = new Map<string, Record<string, unknown>>();
    if (Array.isArray(flows)) for (const value of flows) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const node = value as Record<string, unknown>;
        if (typeof node["id"] === "string") deployed.set(node["id"], node);
      }
    }
    if (Array.isArray(flows)) for (const item of flows) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const n = item as Record<string, unknown>;
      const id = n["id"], type = n["type"], z = n["z"];
      if (typeof id !== "string" || typeof type !== "string" || typeof z !== "string"
          || type.startsWith("mcode-") || !this.nativeTabs.has(z)) continue;
      const meta = n["x-mcode"];
      const originalId = meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)["nodeId"] : undefined;
      // Admin POST /inject/:id returning 200 means only that Inject received
      // a message, NOT that a workflow ran. Do not offer an unwired, disabled,
      // scheduled or sidecar-mismatched node as a manual Custom UI action.
      const cfg = meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? meta as Record<string, unknown> : null;
      const cfgParams = cfg?.["params"];
      const nativeWires = n["wires"];
      const manualDispatchReady = type === "inject" && n["d"] !== true
        && cfg?.["type"] === "mcode.trigger"
        && cfgParams !== null && typeof cfgParams === "object" && !Array.isArray(cfgParams)
        && (cfgParams as Record<string, unknown>)["triggerKind"] === "manual"
        && n["once"] !== true && !n["repeat"] && !n["crontab"]
        && Array.isArray(nativeWires)
        && nativeWires.some(w => Array.isArray(w) && w.some(target => {
          if (typeof target !== "string" || !target) return false;
          const downstream = deployed.get(target);
          return downstream?.["z"] === z && downstream["d"] !== true && downstream["type"] !== "tab";
        }));
      next.set(id, { tabId: z, nodeId: typeof originalId === "string" && originalId
        ? originalId : id, type, manualDispatchReady, title: typeof n["name"] === "string" && n["name"]
        ? n["name"] as string : type });
    }
    this.nativeNodes = next;
    this.nativeSettled.clear();
  }
  private onNativeNodeMessage(message: unknown): boolean {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const msg = message as Record<string, unknown>;
    if (msg["kind"] !== "mcode-native-node-stage" && msg["kind"] !== "mcode-native-node-status") return false;
    const rawId = msg["nodeId"], runId = msg["runId"];
    if (typeof rawId !== "string" || typeof runId !== "string" || !runId || runId.length > 128) return true;
    const node = this.nativeNodes.get(rawId);
    if (!node || (msg["tabId"] !== undefined && msg["tabId"] !== node.tabId)) return true;
    const workflowId = this.nativeTabs.get(node.tabId);
    if (!workflowId || !this.ownedFlowIds.includes(workflowId)
        || this.ownership.executorOwnerOf(workflowId) !== "node-red") return true;
    // Node-RED native triggers do not belong to a chat session. Use a separate
    // stable session namespace, never attribute them to an arbitrary conversation.
    const sessionId = "@node-red-runboard:" + workflowId;
    const key = runId + ":" + rawId;
    const base = { sessionId, workflowId, runId, nodeId: node.nodeId };
    const emit = (e: Record<string, unknown>) => {
      (this.nativeEventSink ?? emitNativeRunboardEvent)(e as unknown as RuntimeEvent);
    };
    if (msg["kind"] === "mcode-native-node-status") {
      const fill = msg["fill"];
      if (fill !== "red" && fill !== "yellow") return true;
      if (this.nativeSettled.has(key)) return true;
      this.nativeSettled.add(key);
      if (this.nativeSettled.size > 4096) this.nativeSettled.delete(this.nativeSettled.values().next().value!);
      emit({ ...base, type: "workflow.node.result", nodeType: node.type, title: node.title,
        status: "failed", summary: "", error: typeof msg["text"] === "string"
          ? msg["text"].slice(0, 160) : "Node-RED node failed" });
      return true;
    }
    if (msg["stage"] === "running") {
      this.nativeSettled.delete(key);
      emit({ ...base, type: "workflow.node.progress", nodeType: node.type, title: node.title,
        phase: "running", message: "Node-RED 节点执行中" });
    } else if (msg["stage"] === "settled" && !this.nativeSettled.has(key)) {
      this.nativeSettled.add(key);
      if (this.nativeSettled.size > 4096) this.nativeSettled.delete(this.nativeSettled.values().next().value!);
      const failed = msg["failed"] === true;
      emit({ ...base, type: "workflow.node.result", nodeType: node.type, title: node.title,
        status: failed ? "failed" : "success", summary: "",
        ...(failed ? { error: "Node-RED node failed" } : {}) });
    }
    return true;
  }
  private tabMap(nodes: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(nodes)) return map;
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      if (node["type"] !== "tab" || typeof node["id"] !== "string") continue;
      const meta = node["x-mcode"];
      const docId = meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)["docId"] : undefined;
      map.set(node["id"], typeof docId === "string" ? docId : "@node-red-native:" + node["id"]);
    }
    return map;
  }
  constructor(engineId: string, ports: EngineRuntimePorts, private readonly ownership: ExecutorOwnershipRegistry,
    private readonly nodeServices?: NodePackHostServices,
    /** T58/T2: production default (`null`) resolves the engine data directory
     * from the current start and runs the durable deploy↔library mirror. Tests
     * inject their own port; either way a failed mirror is never a deploy
     * rollback and never releases the executor owner. */
    private readonly syncLibrary: ((flows: unknown, dataDir: string | null) => Promise<unknown>) | null = null,
    private readonly lookupDoc?: (id: string) => WorkflowDoc | null,
    private readonly nativeEventSink?: (event: RuntimeEvent) => void) {
    super(engineId, ports);
    this.onTerminated(() => this.releaseOwned());
  }

  override status(): EngineRuntimeStatus {
    const state = super.status();
    return state.state === "running"
      ? { ...state, deploymentState: this.deploymentState }
      : state;
  }

  /** Deploy↔library reconciliation state of the last deploy / retry, and how
   * many documents are still waiting in the durable ledger. Read-only; `null`
   * before any deploy in this process. */
  libraryMirrorState(): { report: (NativeMirrorReport & { error: string | null }) | null; pending: number } {
    const dataDir = this.engineDataDir;
    const pending = dataDir === null ? 0 : readNativeDeployReconciliation(dataDir).pending.length;
    return { report: this.lastLibraryMirror, pending };
  }

  /** Replay every pending mirror against the current native canvas. Automatic
   * callers (start / next deploy) never overwrite a library document that
   * changed after the deploy; `acceptNativeRevision` is the explicit
   * user/agent decision to. */
  async retryLibraryMirror(options: { acceptNativeRevision?: boolean } = {}): Promise<NativeMirrorReport | null> {
    const dataDir = this.engineDataDir;
    if (dataDir === null) return null;
    const report = await reconcileNativeLibraryMirror(dataDir, options);
    this.recordLibraryMirror({ ...report, error: report.ok ? null : "仍有工作流未镜像" });
    return report;
  }

  /** Record the outcome and push it onto the existing host runboard channel
   * (workflow-scoped, no chat session) so the user sees pending/failed mirrors
   * without reading logs. The sink defaults to the production emitter. */
  private recordLibraryMirror(report: NativeMirrorReport & { error: string | null }): void {
    this.lastLibraryMirror = report;
    if (report.ok && report.deployId === "" && report.docs.length === 0) return;
    const emit = this.nativeEventSink ?? emitNativeRunboardEvent;
    for (const event of nativeMirrorEvents(report)) {
      try { emit(event); } catch (err) {
        log.warn(`[workflow-engine] Node-RED 库镜像状态事件发送失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Native custom-UI manual entry: only an explicitly selected Mcode-owned
   * inject node may receive a Host-issued input ticket. This is not Deploy,
   * does not grant persistent trust, and does not use the legacy runner. */
  nativeManualTarget(docId: string, triggerNodeId: string): { nodeId: string; port: number; token: string } {
    const state = this.status();
    if (state.state !== "running" || state.port === null || this.nodePackHost === null
      || this.manualTicketIssuer === null || !this.adminToken) {
      throw Error("Node-RED 引擎未就绪；请先启动并明确部署工作流");
    }
    if (this.pendingDeploy !== null || this.nativeDeployUncertain
      || (this.untrustedAtStart && this.deploymentState !== "deployed")) {
      throw Error("Node-RED 部署尚未确认或结果不确定，拒绝手动触发；请重新确认部署状态");
    }
    if (!this.ownedFlowIds.includes(docId) || this.ownership.executorOwnerOf(docId) !== "node-red") {
      throw Error("工作流当前不属于 Node-RED 执行器，拒绝跨引擎触发");
    }
    const doc = (this.lookupDoc ?? getWorkflow)(docId);
    if (!doc || effectiveWorkflowEngine(doc) !== "node-red") {
      throw Error("工作流已删除或引擎归属发生变化");
    }
    const source = doc.nodes.find(n => n.id === triggerNodeId);
    if (source?.type !== "mcode.trigger" || source.params["triggerKind"] !== "manual") {
      throw Error("所选节点不是已保存的手动触发器，拒绝执行");
    }
    const matches = [...this.nativeNodes.entries()].filter(([, n]) =>
      n.type === "inject" && n.nodeId === triggerNodeId
      && this.nativeTabs.get(n.tabId) === docId);
    if (matches.length !== 1) {
      throw Error("无法唯一定位已部署的原生手动触发节点；请重新部署后再试");
    }
    if (!matches[0]![1].manualDispatchReady) {
      throw Error("原生手动触发节点已禁用、未连线或配置已变更；请检查 Inject 后重新部署");
    }
    return { nodeId: matches[0]![0], port: state.port, token: this.adminToken };
  }

  async runNativeManual(
    docId: string, triggerNodeId: string, facts: Readonly<Record<string, unknown>>,
  ): Promise<{ ok: boolean; error?: string }> {
    let issued: ManualTicket | null = null;
    try {
      const target = this.nativeManualTarget(docId, triggerNodeId);
      const issue = this.manualTicketIssuer;
      if (!issue) throw Error("Native input Host not available");
      issued = issue(docId, facts);
      const response = await fetch(
        "http://127.0.0.1:" + target.port + "/inject/" + encodeURIComponent(target.nodeId), {
          method: "POST",
          headers: {
            Authorization: "Bearer " + target.token,
            "Content-Type": "application/json",
          },
          // The data never passes through an editable Node-RED message.
          // Only an opaque Host lookup key crosses the boundary.
          body: JSON.stringify({ __user_inject_props__: [{
            p: "mcode.triggerTicket", v: issued.ticket, vt: "str",
          }] }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw Error("Node-RED 原生手动入口返回 HTTP " + response.status);
      return { ok: true };
    } catch (error) {
      issued?.revoke();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private releaseOwned(): void {
    this.manualTicketIssuer = null;
    this.adminToken = null;
    this.nodePackHost?.dispose();
    this.nodePackHost = null;
    this.nativeTabs.clear();
    this.nativeNodes.clear();
    this.nativeSettled.clear();
    const ids = [...this.ownedFlowIds, ...(this.pendingDeploy?.added ?? [])];
    this.ownedFlowIds = [];
    this.pendingDeploy = null;
    this.deploymentState = "unknown";
    this.nativeDeployUncertain = false;
    for (const flowId of new Set(ids)) {
      const released = this.ownership.release(flowId, "node-red");
      if (!released.ok) log.warn(`[workflow-engine] Node-RED owner release failed: ${released.reason}`);
    }
  }

  /** Parent-side authorization for Node-RED's *real* POST /flows: claim the
   * candidate flow set BEFORE native deployment; only after 2xx commit may
   * abandoned native claims be released. A failed deploy rolls back new claims.
   * The child never chooses an owner; it only submits nodes for Host validation.
   */
  private onDeployMessage(message: unknown, send: (response: unknown) => void): void {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const msg = message as Record<string, unknown>;
    const id = msg["id"];
    if (typeof id !== "string" || id.length === 0 || id.length > 100) return;
    if (msg["kind"] === "mcode-deploy-final") {
      const pending = this.pendingDeploy;
      if (pending === null || pending.id !== id) return;
      this.pendingDeploy = null;
      if (msg["success"] === true) {
        this.nativeDeployUncertain = false;
        // A committed full deploy with at least one actual runtime node is
        // different from an empty-tab deploy. Never infer this from flows.json.
        this.deploymentState = Array.isArray(pending.flows) && pending.flows.some(value =>
          value !== null && typeof value === "object" && !Array.isArray(value)
          && typeof (value as Record<string, unknown>)["z"] === "string"
          && (value as Record<string, unknown>)["type"] !== "tab")
          ? (this.untrustedAtStart ? "deployed" : "unknown") : "not-deployed";
        for (const oldId of this.ownedFlowIds) {
          if (!pending.flowIds.includes(oldId)) {
            const result = this.ownership.release(oldId, "node-red");
            if (!result.ok) log.warn(`Native owner release failed: ${result.reason}`);
          }
        }
        this.ownedFlowIds = pending.flowIds;
        this.nativeTabs = this.tabMap(pending.flows);
        this.indexNativeNodes(pending.flows);
        // A real editor deploy has committed. Only now mirror the same native
        // nodes back to the existing workflow library, via its guarded save.
        // T2: the durable pending intent is written synchronously inside this
        // call (before its first await), and a failure is a visible, retryable
        // reconciliation state — never a deploy failure and never an ownership
        // rollback. The old “only log it” path is gone.
        this.startDeployMirror(pending.flows);
      } else if (msg["uncertain"] === true) {
        this.deploymentState = "unknown";
        this.nativeDeployUncertain = true;
        // The client may disconnect after native deployment has begun. It is
        // unsafe to give its flows to Mcode until this engine actually stops.
        this.ownedFlowIds = [...new Set([...this.ownedFlowIds, ...pending.flowIds])];
        log.warn("Native deploy result uncertain; retained all executor claims until engine stop");
      } else {
        for (const flowId of pending.added) {
          const result = this.ownership.release(flowId, "node-red");
          if (!result.ok) log.warn(`Native deploy rollback failed: ${result.reason}`);
        }
      }
      return;
    }
    if (msg["kind"] !== "mcode-deploy-prepare") return;
    const reject = (reason: string): void => send({ kind: "mcode-deploy-reply", id, ok: false, reason });
    if (this.status().state !== "running" || this.pendingDeploy !== null) {
      reject("Native deploy blocked: engine not running or another deploy is pending");
      return;
    }
    let nextIds: string[];
    try {
      if (this.lookupDoc) assertNativeEngineSelection(msg["flows"], this.lookupDoc);
      assertSafeMigratedManualInject(msg["flows"]);
      nextIds = nativeFlowIdsOfNodes(msg["flows"]);
    }
    catch (err) { reject(err instanceof Error ? err.message : String(err)); return; }
    const added: string[] = [];
    try {
      for (const flowId of nextIds) {
        if (this.ownedFlowIds.includes(flowId)) continue;
        const claim = this.ownership.claim(flowId, "node-red", { reason: "authenticated native Node-RED deploy" });
        if (!claim.ok || claim.alreadyOwned) throw new Error(!claim.ok ? claim.reason : `已有未签发租约：${flowId}`);
        added.push(flowId);
      }
    } catch (err) {
      for (const flowId of added) this.ownership.release(flowId, "node-red");
      reject(err instanceof Error ? err.message : String(err));
      return;
    }
    this.pendingDeploy = { id, flowIds: nextIds, added, flows: structuredClone(msg["flows"]) };
    send({ kind: "mcode-deploy-reply", id, ok: true });
  }

  /** Run the deploy↔library mirror off the deploy path. Failures are recorded
   * (status + runboard event) and logged as *pending reconciliation*, never as a
   * deploy failure or owner rollback. */
  private startDeployMirror(flows: unknown): void {
    const at = Date.now();
    let task: Promise<unknown>;
    try {
      task = this.syncLibrary !== null
        ? this.syncLibrary(flows, this.engineDataDir)
        : this.productionSyncLibrary(flows, this.engineDataDir);
    } catch (err) {
      // Invalid document identity in the receipt: the production ledger already
      // carries a lastError; the native deploy itself stays committed.
      this.recordLibraryMirror({ deployId: "", at, ok: false, docs: [], error: String(err) });
      log.error(`Native Node-RED deploy saved but library mirror could not start: ${String(err)}`);
      return;
    }
    void task.then(
      value => {
        // The production path records its own per-document report; an injected
        // port that returns one is recorded here so status/events stay truthful.
        if (isNativeMirrorReport(value)) {
          this.recordLibraryMirror({ ...value, error: value.ok ? null : "仍有工作流未镜像" });
        }
      },
      err => {
        // Keep the per-document report when productionSyncLibrary already
        // recorded one for this deploy.
        if (this.lastLibraryMirror === null || this.lastLibraryMirror.at !== at) {
          this.recordLibraryMirror({ deployId: "", at, ok: false, docs: [], error: String(err) });
        }
        log.error(`Native Node-RED deploy saved but library mirror pending reconciliation: ${String(err)}`);
      });
  }

  /** Production mirror: one durable record-and-mirror run for this deploy.
   * Records the per-document report before surfacing the failure sentence. */
  private productionSyncLibrary(flows: unknown, dataDir: string | null): Promise<unknown> {
    if (dataDir === null) return Promise.reject(new Error("Node-RED 引擎数据目录未知，无法登记库镜像对账"));
    const lookup = this.lookupDoc;
    const revisionOf = lookup === undefined ? undefined : (id: string): string | null => {
      const doc = lookup(id);
      return doc === null ? null : workflowSaveVersion(doc);
    };
    return runNativeDeployMirror(flows, { dataDir, ...(revisionOf !== undefined ? { revisionOf } : {}) })
      .then(report => {
        this.recordLibraryMirror({ ...report, error: report.ok ? null : "仍有工作流未镜像" });
        if (!report.ok) throw new Error(describeNativeMirrorFailure(report, dataDir));
        return report.docs.filter(doc => doc.status === "mirrored").map(doc => doc.docId);
      });
  }

  override async start(options: EngineStartOptions): Promise<EngineRuntimeStatus> {
    const state = this.status().state;
    if (state === "running" || state === "starting") return super.start(options);
    if (this.ownedFlowIds.length > 0) throw new Error("旧引擎租约未释放，拒绝再次启动");
    this.engineDataDir = options.dataDir;
    // A trusted startup may auto-run; do not claim a manual deploy occurred.
    this.untrustedAtStart = options.env?.MCODE_ENGINE_TRUSTED !== "1";
    this.nativeDeployUncertain = false;
    this.deploymentState = this.untrustedAtStart ? "not-deployed" : "unknown";
    this.ownedFlowIds = claimNativeFlows(this.ownership, nativeFlowIds(options.dataDir, (nodes) => {
      if (this.lookupDoc) assertNativeEngineSelection(nodes, this.lookupDoc);
      assertSafeMigratedManualInject(nodes);
      this.nativeTabs = this.tabMap(nodes);
      this.indexNativeNodes(nodes);
    }));
    // T2: a previous process may have committed a native deploy whose library
    // mirror never completed. Replay that durable intent before this start
    // returns; failures stay pending and visible, never block the engine.
    void this.retryLibraryMirror().catch(err =>
      log.error(`Node-RED 库镜像对账重试失败（保持待对账）：${err instanceof Error ? err.message : String(err)}`));
    const resolveWorkflow = (tabId: string): string | null => {
      const docId = this.nativeTabs.get(tabId);
      return docId && this.ownership.executorOwnerOf(docId) === "node-red" ? docId : null;
    };
    const nodeServices = this.nodeServices ?? productionNodePackServices(
      () => this.status(), options.probeIdentity?.adminToken, resolveWorkflow,
    );
    // W17：`condition.evaluate` 走旧的条件求值器（Host 侧，复用
    // `@contracts/condition`）；其它动作原样交给上面的生产服务 / 注入的测试服务。
    // 求值需要「宿主库里的那张文档」—— 注入服务（测试）拿不到库时，`getDoc`
    // 仍走生产 `getWorkflow`（测试夹具里的 docId 不在库里会显式失败，不猜）。
    const triggerBridge = createConditionTriggerBridge(nodeServices, {
      getDoc: (id) => (this.lookupDoc ?? getWorkflow)(id),
      resolveWorkflow,
    });
    this.nodePackHost = new NodePackHost(triggerBridge.services);
    this.manualTicketIssuer = triggerBridge.issueManual;
    this.adminToken = options.probeIdentity?.adminToken ?? null;
    try {
      const status = await super.start({
        ...options,
        onMessage: (message, respond) => {
          if (this.nodePackHost?.handle(message, respond)) return;
          if (this.onNativeNodeMessage(message)) return;
          this.onDeployMessage(message, respond);
        },
      });
      if (status.state !== "running" && status.state !== "starting" && !this.hasLiveChild()) this.releaseOwned();
      return status;
    } catch (err) {
      if (!this.hasLiveChild()) this.releaseOwned();
      throw err;
    }
  }
}

export class ProductionWorkflowEngineRegistry implements WorkflowEngineRegistry {
  private readonly runtimes = new Map<string, EngineRuntimeType>();
  constructor(
    private readonly runtimePorts: EngineRuntimePorts = defaultEngineRuntimePorts,
    private readonly ownership: ExecutorOwnershipRegistry = sharedExecutorOwnership,
    private readonly nativeLibrarySync?: (flows: unknown, dataDir: string | null) => Promise<unknown>,
  ) {}
  /** 每个引擎的数据目录（首次 launchSpec 时创建）。 */
  private readonly dataDirs = new Map<string, string>();

  ids(): string[] {
    return [...ENGINE_IDS];
  }

  get(engineId: string): EngineRuntimeType | null {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) return null;
    let runtime = this.runtimes.get(engineId);
    if (runtime === undefined) {
      runtime = new OwnedNodeRedRuntime(engineId, this.runtimePorts, this.ownership, undefined,
        this.nativeLibrarySync ?? null,
        this.runtimePorts === defaultEngineRuntimePorts ? (id) => getWorkflow(id) : undefined);
      this.runtimes.set(engineId, runtime);
    }
    return runtime;
  }

  /** 引擎此刻的状态（只读；未注册 / 从未取值时为 `null`）。
   *
   *  **不创建实例** —— 与 {@link get} 不同：这是给执行器注册表那条路用的
   *  （`executionEngine.ts` 的 `setWorkflowEngineStatusPort`），装配期只许问
   *  「装没装、跑没跑」，不许因为一句查询就记下一个运行时。 */
  statusOf(engineId: string): EngineRuntimeStatus | null {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) return null;
    return this.runtimes.get(engineId)?.status() ?? null;
  }

  /** 引擎自己的目录（也放引导脚本）。**默认项目 = 旧单例目录**（兼容，只读语义不变）。 */
  dataDirOf(engineId: string): string {
    // 公开的存储入口也必须遵守注册表白名单：不能让任意 engineId 在 dataRoot 下
    // 创建目录，更不能让带路径分隔符的输入参与 join。校验必须先于任何写盘。
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) {
      throw new Error(`未知工作流引擎：${engineId}`);
    }
    // 缓存只保留路径身份，不缓存“目录仍安全”这个瞬时结论：链接可运行中被替换。
    const dir = makeManagedEngineDirectory(dataRoot(), ["workflow-engines", engineId]);
    const cached = this.dataDirs.get(engineId);
    if (cached !== undefined && cached !== dir) {
      throw new Error(`工作流引擎数据目录在运行期间发生变化：${engineId}`);
    }
    this.dataDirs.set(engineId, dir);
    return dir;
  }

  /**
   * 【ARC-006 MERGE-1 / P1-7】**按项目隔离**的引擎数据目录。
   *
   * 纯判据在 `projectFlowDir.ts`（同 projectId 稳定、不同 projectId 隔离、非法 id
   * 拒绝）；这里只做"算出来 + 建目录"这一层。
   *
   * - `projectId` 省略 / null / `"default"` → **旧单例目录**（`dataDirOf`），内容
   *   与行为原样兼容，不迁移；
   * - 合法的新 projectId → `<engineDir>/projects/<safe>/`；
   * - **非法 id → 抛错**（绝不回退成默认目录，那会让坏 id 写进共享目录）。
   *
   * 与 `dataDirOf` 不同，本方法**不缓存**：项目目录的集合是开放的，缓存一张随时
   * 增长的 Map 只会把生命周期搞复杂；路径计算是纯字符串操作。
   */
  projectDataDirOf(engineId: string, projectId?: string | null): string {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) {
      throw new Error(`未知工作流引擎：${engineId}`);
    }
    // 先做纯身份判定、后建目录。旧写法提前调用 dataDirOf()，即使 projectId
    // 无效也会把默认单例目录创建出来，违反“非法输入无副作用”的资源边界。
    const root = dataRoot();
    const engineDir = join(root, "workflow-engines", engineId);
    const result = resolveProjectFlowDir(engineDir, projectId);
    if (!result.ok) throw new Error(`非法 projectId：${result.reason}`);
    // 默认项目保留 dataDirOf 的缓存和旧单例目录语义。
    if (result.legacy) return this.dataDirOf(engineId);
    const parts = relative(engineDir, result.dir).split(sep);
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("工作流项目目录不在受管引擎根内");
    }
    const dir = makeManagedEngineDirectory(root, ["workflow-engines", engineId, ...parts]);
    bindProjectDirectoryIdentity(dir, result.projectId);
    return dir;
  }

  launchSpec(engineId: string): WorkflowEngineLaunchSpec | null {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) return null;
    const dir = this.dataDirOf(engineId);
    // 实现包由唯一 launch spec 解析器选择；不能在这里提前要求 npm 存在。
    const bootstrapPath = join(dir, "bootstrap.cjs");
    // 【P1-5】完整性校验失败 → 返回 null（IPC 回"没有配置启动命令"并带原因），
    // **绝不**带着盘上的旧/被篡改脚本启动。
    if (!writeEngineBootstrap(engineId, dir)) {
      log.error(`[workflow-engine:${engineId}] 引导脚本未能升级/恢复，拒绝启动引擎（不会执行旧脚本）`);
      return null;
    }
    const nodePack = ensureNodePack(dir, engineId);
    if (!nodePack.ok) {
      log.error(`[workflow-engine:${engineId}] 节点包校验失败，拒绝启动：${nodePack.reason}`);
      return null;
    }
    // 【P1-4】启动参数由**唯一**的共享生成器收口（Electron-as-Node 模式、打包路径、
    // Node 版本要求、宿主身份）。此前这里自己拼 env、不给 ELECTRON_RUN_AS_NODE，
    // 而真 Electron 套件在自己的 launchSpec 里补 —— 生产与测试因此漂移。
    // 路径解析失败（拿不到 app 路径 / 版本不满足）→ 返回 null 并带原因，
    // 与"未安装"同一条失败面，不静默猜。
    try {
      return createEngineLaunchSpec({
        engineId,
        dataDir: dir,
        // 引导脚本由 P1-5 的清单校验写进数据目录；盘上已存在 → 生成器直接采用。
        entryFile: bootstrapPath,
        installPackage: "node-red",
        minNodeVersion: NODE_RED_MIN_NODE,
        onPackageResolution: (result) => {
          if (result.source === "vendor") log.info(`[workflow-engine:${engineId}] Node-RED vendor 5.0.8: ${result.directory}`);
          else log.warn(`[workflow-engine:${engineId}] Node-RED npm fallback: ${result.reason}; ${result.directory}`);
        },
        adminTokenFile: join(dir, ".engine-admin-token"),
        secretFile: dir,
        env: {
          // 只有宿主写下的可信标记才让持久化 flow 进入 runtime（见 isFlowTrusted）。
          MCODE_ENGINE_TRUSTED: isFlowTrusted(dir) ? "1" : "0",
          MCODE_ENGINE_THEME_CSS: resolveMcodeNodeRedThemeCss(),
        },
      });
    } catch (err) {
      log.error(
        `[workflow-engine:${engineId}] 启动参数生成失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** process 'exit' is synchronous: terminate children and release claims now. */
  terminateOnProcessExit(): void {
    for (const runtime of this.runtimes.values()) runtime.terminateOnProcessExit();
    this.runtimes.clear();
  }

  /** 退出路径：停掉所有引擎，不留孤儿进程。 */
  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      try {
        await runtime.stop();
      } catch {
        /* 已停 */
      }
    }
    this.runtimes.clear();
  }
}

/** 生产单例（与 `documentViewHost` 同一种装配方式）。 */
export const workflowEngineRegistry = new ProductionWorkflowEngineRegistry();
process.once("exit", () => workflowEngineRegistry.terminateOnProcessExit());
