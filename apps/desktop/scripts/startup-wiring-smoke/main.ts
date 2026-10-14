/**
 * Headless smoke for **`main/startup/assembleStartup.ts`** —— `index.ts` 那段「数据库就绪
 * 之后、窗口装配之前」的启动装配序列(视觉中继 / 操作账本 / 三个落盘 store / 审批端口 /
 * 场景运行期 / 扩展桥令牌持久化)。
 *
 * ## 它补的是哪个洞
 *
 * 这段装配此前**整段内联在 `index.ts` 里**。`index.ts` 顶层就 `import { app } from
 * "electron"` 且跑真实 Electron 装配 —— 任何无头 smoke 引不动它,于是
 * `smokes-for.sh --uncovered` 把 `src/main/index.ts` 列为**零覆盖**:装配点按什么顺序装、
 * 装出来的到底是不是落盘版、某一步抛了会怎样,**没有任何回归网**。抽取成 electron-free 的
 * 纯函数 `assembleStartup(deps)` 之后,本套直接 bundle 它、真跑、断言**可观察的装配结果**。
 *
 * ## 判据立在「装成了没有」,不是「调了某个函数」
 *
 * 每一条断言都读一个**装配后才存在的可观察事实**:
 *   - `getOperationLedger()` 是不是那份被注入的账本(**不是**进程内默认的内存版);
 *   - `getVisionRelayImpl()` 是不是被注入的实现(不装就是 `null`);
 *   - 签发一份 grant 后 `<数据根>/appControl/grants.json` **真的出现**(内存版不落盘);
 *   - 计划正文 / 主机 hook 授权同理,各落各的独立文件;
 *   - `getGrantStore()` / `getSceneRegistry()` 的**身份在装配后变了**(重装 = 换了一份新单例);
 *   - 两个 electron 相关的注入点(审批端口 / 令牌落盘)**真的被调到**,而且顺序对。
 *
 * ## 失败恢复:如实断言「中止,不半途续装」
 *
 * 抽取**逐字保留**了原来那段的行为:扁平序列,**不逐条 try/catch**。某一步抛出会**中止
 * 余下装配并向上抛**。本套把这条语义**断言出来**:让注入的审批端口抛 → 后一步(令牌落盘)
 * **没被调到**;而它**之前**的落盘 store 已经装好(身份已变)—— 即「半初始化状态」是真实
 * 存在的、且**如实**(错误穿出去,不吞)。
 *
 * ## 它不碰用户的真东西,也不开数据库
 *
 * 数据根 = `mktemp -d`;所有落盘都写在这个临时目录里,跑完连目录一起删。本套**不 open 任何
 * 数据库**(装配的这几步只写 JSON 文件,不碰 sql.js),也不 import 会拉 electron 的模块
 * (如 `modules/service.ts` —— 它经 `db.ts` 拉 electron,故审批端口用注入的替身、不引真模块)。
 *
 * Run: scripts/startup-wiring-smoke/run.sh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleStartup, type StartupAssemblyDeps } from "@main/startup/assembleStartup.js";
import { getGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { MemoryOperationLedger, getOperationLedger, type OperationLedger } from "@main/appControl/operations.js";
import { getUnattendedPlanStore } from "@main/appServices/unattendedPlanStore.js";
import { getSceneRegistry } from "@main/orchestration/sceneTaskRuntime.js";
import { getVisionRelayImpl, type VisionRelayImpl } from "@main/mcp/visionRelayRegistry.js";
import { issueHostHookGrant, listHostHookGrants } from "@main/hooks/hostHookGrants.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const tempDirs: string[] = [];
function freshDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcode-startup-wiring-"));
  tempDirs.push(dir);
  return dir;
}

/** 一份被注入的账本哨兵 —— 身份可辨,证明「换上的正是这一份」。 */
function sentinelLedger(): OperationLedger {
  return { begin: () => ({ begin: "claimed", record: {} as never }) as never, settle: () => {}, get: () => undefined };
}

/** 一份被注入的视觉中继实现 —— 身份可辨。 */
function visionImpl(): VisionRelayImpl {
  return { describeImage: async () => ({ ok: false, error: "smoke 未配置" }), configured: () => false };
}

/** 跑一遍装配,记录两个注入点被调到的顺序。返回调用轨迹与传进去的令牌存取对象。 */
function runAssembly(opts: {
  dataRoot: string;
  throwAt?: "approval" | "token";
  tokenStore?: { get(): string | null; set(t: string): void };
  ledger?: OperationLedger;
  vision?: VisionRelayImpl;
}): { order: string[]; tokenStore: { get(): string | null; set(t: string): void }; thrown: unknown } {
  const order: string[] = [];
  const tokenStore = opts.tokenStore ?? { get: () => null, set: () => {} };
  const deps: StartupAssemblyDeps = {
    dataRoot: opts.dataRoot,
    operationLedger: opts.ledger ?? sentinelLedger(),
    visionRelay: opts.vision ?? visionImpl(),
    assembleModuleApprovalPort: () => {
      order.push("approval");
      if (opts.throwAt === "approval") throw new Error("injected approval-port failure");
    },
    configureExtensionBridgeTokenStore: (store) => {
      order.push("token");
      if (store !== tokenStore) throw new Error("传给令牌落盘的存取对象不是装配方给的那一个");
      if (opts.throwAt === "token") throw new Error("injected token-store failure");
    },
    bridgeTokenStore: tokenStore,
  };
  let thrown: unknown = null;
  try {
    assembleStartup(deps);
  } catch (err) {
    thrown = err;
  }
  return { order, tokenStore, thrown };
}

function main(): void {
  // ── 1. 装配效果:每一步都留下可观察的痕迹 ──────────────────────────────
  console.log("\n装配效果(装成了没有,不是「调了某个函数」)");
  {
    const dr = freshDataRoot();
    const ledger = sentinelLedger();
    const vision = visionImpl();
    const tokenStore = { get: () => "persisted-token" as string | null, set: () => {} };
    const grantBefore = getGrantStore();
    const sceneBefore = getSceneRegistry();

    const { order, thrown } = runAssembly({ dataRoot: dr, ledger, vision, tokenStore });

    check("装配过程无异常抛出", thrown === null, thrown);
    check("操作账本换成被注入的那一份", getOperationLedger() === ledger);
    check("操作账本不再是进程内默认的内存版", !(getOperationLedger() instanceof MemoryOperationLedger));
    check("视觉中继登记口装上了被注入的实现", getVisionRelayImpl() === vision);
    check("GrantStore 重装成一份新单例", getGrantStore() !== grantBefore);
    check("场景运行期注册表重装成一份新单例", getSceneRegistry() !== sceneBefore);

    // 落盘版的判据:签发真的写进了独立文件(内存版不落盘)。
    const grant = getGrantStore().issueGrant(
      {
        verdict: "allow",
        reason: "smoke",
        compatibilityLevel: "write",
        sceneId: "scene-1",
        allowedActions: ["session.create"],
        scopedCore: { projectPath: "/tmp/p" },
        configHash: "h",
        ttlMs: 60_000,
      },
      { kind: "user", id: "user-1" },
      1_000,
    );
    const grantFile = join(dr, "appControl", "grants.json");
    check("签发后 grants.json 真的落盘(证明是落盘版,不是内存版)", existsSync(grantFile));
    check(
      "落盘的正文里带着刚签发的 grantId",
      existsSync(grantFile) && readFileSync(grantFile, "utf8").includes(grant.grantId),
    );

    // 计划正文存档:同样看「无头可观察的落盘痕迹」。
    getUnattendedPlanStore().put({
      planId: "plan-1",
      sceneId: "scene-1",
      projectId: "proj-1",
      grantId: grant.grantId,
      operations: [{ operationId: "op-1", method: "session.create", prompt: "hi" }],
      maxCount: 1,
      createdAt: 1,
      status: "pending",
      completedOperationIds: [],
      lastStoppedAt: null,
      lastStopCode: null,
    });
    check("计划正文落盘到 unattended-plans.json", existsSync(join(dr, "appControl", "unattended-plans.json")));

    // 主机 hook 授权:签发即落盘。
    issueHostHookGrant({ pluginId: "plugin-1", ttlMs: 60_000, now: 1_000 });
    check("主机 hook 授权落盘到 hooks/host-hook-grants.json", existsSync(join(dr, "hooks", "host-hook-grants.json")));
    check("主机 hook 授权表里有一条(即装配真的把持久化接上了)", listHostHookGrants().length === 1);

    check("两个注入点都被调到", order.includes("approval") && order.includes("token"));
  }

  // ── 2. 顺序:注入的 electron 相关装配按声明的先后 ───────────────────────
  console.log("\n顺序(注入点被调到的先后)");
  {
    const { order } = runAssembly({ dataRoot: freshDataRoot() });
    // ⚠️ **这条钉的是两个注入点的相对先后,不是全部 8 步的顺序** —— 名字如实这么写。
    // 那 6 步直接调用彼此**没有依赖**(各装各的单例),把任意两步对调**不会**让任何断言变红
    // (我实测过:对调「审批端口」与「场景运行期」仍 19/19 全绿)。所以这里不假装钉了
    // 「整个序列的顺序」—— 那 6 步各自**装成了没有**由上面每步独立的可观察痕迹断言负责。
    // 这两个注入点之间确实是真先后语义(令牌落盘是这段序列的收尾一步)。
    check("两个注入点的相对先后:审批端口先于令牌落盘", order.join(",") === "approval,token", order);
  }

  // ── 3. 失败恢复:某一步抛 → 中止后续,如实向上抛(不半途续装) ──────────────
  console.log("\n失败恢复(中止,不半途续装)");
  {
    const dr = freshDataRoot();
    const ledger = sentinelLedger();
    const grantBefore = getGrantStore();
    const { order, thrown } = runAssembly({ dataRoot: dr, ledger, throwAt: "approval" });
    check("审批端口抛出的错误穿了出来(不吞)", thrown instanceof Error && /injected approval-port failure/.test((thrown as Error).message));
    check("抛点之后的步骤被跳过(令牌落盘没被调到)", !order.includes("token"));
    check("抛点之前的落盘 store 已经装好(身份已变 = 半初始化状态真实存在)", getGrantStore() !== grantBefore);
    check("抛点之前的账本也是被注入的那一份", getOperationLedger() === ledger);
  }
  {
    // 反向:让**最后一步**抛 —— 前面的注入点仍应已跑过。
    const dr = freshDataRoot();
    const { order, thrown } = runAssembly({ dataRoot: dr, throwAt: "token" });
    check("最后一步抛也如实穿出", thrown instanceof Error && /injected token-store failure/.test((thrown as Error).message));
    check("最后一步抛之前,审批端口已跑过(顺序不受中断回退)", order.join(",") === "approval,token", order);
  }
}

try {
  main();
} finally {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

console.log(`\nstartup-wiring: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
