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
import { NodePackHost } from "./nodePackHost.js";
import { productionNodePackServices } from "@main/workflowEngines/nodePackProductionPorts.js";
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

/** Production runtime owns each native tab from before spawn to child exit. */
export class OwnedNodeRedRuntime extends EngineRuntime {
  private ownedFlowIds: string[] = [];
  private pendingDeploy: { id: string; flowIds: string[]; added: string[] } | null = null;
  private nodePackHost: NodePackHost | null = null;
  constructor(engineId: string, ports: EngineRuntimePorts, private readonly ownership: ExecutorOwnershipRegistry) {
    super(engineId, ports);
    this.onTerminated(() => this.releaseOwned());
  }

  private releaseOwned(): void {
    this.nodePackHost?.dispose();
    this.nodePackHost = null;
    const ids = [...this.ownedFlowIds, ...(this.pendingDeploy?.added ?? [])];
    this.ownedFlowIds = [];
    this.pendingDeploy = null;
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
        for (const oldId of this.ownedFlowIds) {
          if (!pending.flowIds.includes(oldId)) {
            const result = this.ownership.release(oldId, "node-red");
            if (!result.ok) log.warn(`Native owner release failed: ${result.reason}`);
          }
        }
        this.ownedFlowIds = pending.flowIds;
      } else if (msg["uncertain"] === true) {
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
    try { nextIds = nativeFlowIdsOfNodes(msg["flows"]); }
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
    this.pendingDeploy = { id, flowIds: nextIds, added };
    send({ kind: "mcode-deploy-reply", id, ok: true });
  }

  override async start(options: EngineStartOptions): Promise<EngineRuntimeStatus> {
    const state = this.status().state;
    if (state === "running" || state === "starting") return super.start(options);
    if (this.ownedFlowIds.length > 0) throw new Error("旧引擎租约未释放，拒绝再次启动");
    this.ownedFlowIds = claimNativeFlows(this.ownership, nativeFlowIds(options.dataDir));
    this.nodePackHost = new NodePackHost(productionNodePackServices(
      () => this.status(), options.probeIdentity?.adminToken,
    ));
    try {
      const status = await super.start({
        ...options,
        onMessage: (message, respond) => {
          if (this.nodePackHost?.handle(message, respond)) return;
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
      runtime = new OwnedNodeRedRuntime(engineId, this.runtimePorts, this.ownership);
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
