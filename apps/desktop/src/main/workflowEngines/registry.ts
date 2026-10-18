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
 *   - 先看宿主的数据根下有没有用户安装的 `node-red`（`<dataRoot>/workflow-engines/node-red/`）；
 *   - 没有就返回 null，IPC 那边回"没有配置启动命令"，界面据此显示安装指引。
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
 * 所以写一个最小引导脚本：`RED.init(server)` + `RED.start()`，端口从 argv 拿。
 * 这与 NR0 的实测脚本是同一份形状（那份已在本机跑通过）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";
import { EngineRuntime, defaultEngineRuntimePorts, type EngineRuntime as EngineRuntimeType } from "./runtimeSupervisor.js";
import type { WorkflowEngineLaunchSpec, WorkflowEngineRegistry } from "@main/ipc/workflowEngine.js";

/** 引导脚本：与 NR0 实测的那份同形。 */
const BOOTSTRAP = `// 【ARC-006 WF-INT】Node-RED 引导 —— 端口与数据目录由 Mcode 宿主给。
const RED = require("node-red");
const http = require("node:http");
const port = Number(process.argv[2]);
const userDir = process.argv[3];
const server = http.createServer();
server.listen(port, "127.0.0.1", () => {
  RED.init(server, {
    httpAdminRoot: "/",
    httpNodeRoot: "/api",
    userDir,
    // 凭据密钥由宿主注入（见 launchSpec 的 NODE_RED_CREDENTIAL_SECRET）。
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || false,
    logging: { console: { level: "warn" } },
  });
  RED.start().then(
    () => {
      // 只用 stderr 打日志：stdout 留给将来可能的协议行。
      console.error("[mcode-engine] node-red ready on " + port);
    },
    (err) => {
      console.error("[mcode-engine] node-red start failed: " + (err && err.message));
      process.exit(2);
    },
  );
});
`;

const ENGINE_IDS = ["node-red"] as const;

export class ProductionWorkflowEngineRegistry implements WorkflowEngineRegistry {
  private readonly runtimes = new Map<string, EngineRuntimeType>();
  /** 每个引擎的数据目录（首次 launchSpec 时创建）。 */
  private readonly dataDirs = new Map<string, string>();

  ids(): string[] {
    return [...ENGINE_IDS];
  }

  get(engineId: string): EngineRuntimeType | null {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) return null;
    let runtime = this.runtimes.get(engineId);
    if (runtime === undefined) {
      runtime = new EngineRuntime(engineId, defaultEngineRuntimePorts);
      this.runtimes.set(engineId, runtime);
    }
    return runtime;
  }

  /** 引擎自己的目录（也放引导脚本）。 */
  dataDirOf(engineId: string): string {
    const cached = this.dataDirs.get(engineId);
    if (cached !== undefined) return cached;
    const dir = join(dataRoot(), "workflow-engines", engineId);
    mkdirSync(dir, { recursive: true });
    this.dataDirs.set(engineId, dir);
    return dir;
  }

  launchSpec(engineId: string): WorkflowEngineLaunchSpec | null {
    if (!(ENGINE_IDS as readonly string[]).includes(engineId)) return null;
    const dir = this.dataDirOf(engineId);
    // 用户/宿主安装的 node-red：<dataDir>/node_modules/node-red。
    const nodeRedMain = join(dir, "node_modules", "node-red", "package.json");
    if (!existsSync(nodeRedMain)) {
      log.warn(`[workflow-engine:${engineId}] 未安装：找不到 ${nodeRedMain}`);
      return null;
    }
    const bootstrapPath = join(dir, "bootstrap.cjs");
    if (!existsSync(bootstrapPath)) {
      writeFileSync(bootstrapPath, BOOTSTRAP, "utf8");
    }
    // 凭据密钥：每个数据目录一个，存在 dataDir 之外（engine-secret 文件），
    // 不写进 flows.json / creds，也不进日志。
    const secretPath = join(dir, ".engine-secret");
    let secret: string;
    if (existsSync(secretPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      secret = require("node:fs").readFileSync(secretPath, "utf8").trim();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      secret = require("node:crypto").randomBytes(32).toString("hex");
      writeFileSync(secretPath, secret, { encoding: "utf8", mode: 0o600 });
    }
    return {
      command: process.execPath,
      // argv: node bootstrap.cjs <port> <userDir>
      args: (port, userDir) => [bootstrapPath, String(port), userDir],
      dataDir: dir,
      env: {
        NODE_RED_CREDENTIAL_SECRET: secret,
      },
    };
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
