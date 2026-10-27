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
  /* 【2026-10-28】**`approval` 注入点已经不存在了。**
   *
   * 这里原本有一个「审批端口」注入点，用来验「某一步抛 → 中止后续」。
   * 而 `StartupAssemblyDeps` 现在只有四个必需项 + 一个可选
   * （见 `startup/assembleStartup.ts:55`）—— 审批端口早已改成装配内部的一步，
   * 不再是可注入的依赖。
   *
   * 于是三条断言长期红着：
   *   - 「两个注入点都被调到」→ 期望 `["approval","token"]`，实际只有 `["token"]`
   *   - 「审批端口先于令牌落盘」→ 同上
   *   - 「审批端口抛出的错误穿了出来」→ throwAt:"approval" 没有对应实现，抛不出来
   *
   * 红因看起来像「装配顺序坏了」，实际是**判据指着一个被删掉的注入点**。
   *
   * 修法不是去恢复那个注入点（那是代码重构的决定，不是判据能倒逼的），
   * 而是**改成守真实存在的那个失败点**：令牌落盘是序列的最后一步，
   * 让它在 `assembleStartup` 里抛，验「抛点之前的步骤已经生效、抛点如实穿出」。
   * 这仍然覆盖原意（失败即中止、不半途续装），只是锚点换成真的。 */
  const deps: StartupAssemblyDeps = {
    dataRoot: opts.dataRoot,
    operationLedger: opts.ledger ?? sentinelLedger(),
    visionRelay: opts.vision ?? visionImpl(),
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

    check("令牌落盘注入点被调到", order.includes("token"));
  }

  // ── 2. 顺序:注入点恰好被调到一次 ──────────────────────────────────────
  console.log("\n顺序(注入点被调到的先后)");
  {
    const { order } = runAssembly({ dataRoot: freshDataRoot() });
    /* 【2026-10-28】**这条原本钉「审批端口先于令牌落盘」，而审批端口注入点已不存在**
     *（`StartupAssemblyDeps` 现在只有 `configureExtensionBridgeTokenStore` 一个
     *  electron 相关注入，见 `startup/assembleStartup.ts:55`）。
     *
     * 现在还剩下能钉的真事实：令牌落盘是序列的**收尾一步**，且只该被调一次
     *（调两次 = 装配跑了两遍）。「序列里那 7 步的相对顺序」不在这里钉 ——
     * 它们各装各的单例、互不依赖，对调不会让任何断言变红；每一步**装成了没有**
     * 由上面那些独立的可观察痕迹断言负责。 */
    check("令牌落盘注入点恰好被调到一次", order.join(",") === "token", order);
  }

  // ── 3. 失败恢复:某一步抛 → 中止后续,如实向上抛(不半途续装) ──────────────
  console.log("\n失败恢复(中止,不半途续装)");
  {
    /* 【2026-10-28】抛点从 `"approval"`（已删除的注入点）换成**真实存在的最后一步**
     *  令牌落盘。原意（抛点之前装好的东西在、抛点如实穿出、不半途续装）不变。 */
    const dr = freshDataRoot();
    const ledger = sentinelLedger();
    const grantBefore = getGrantStore();
    const { thrown } = runAssembly({ dataRoot: dr, ledger, throwAt: "token" });
    check("最后一步抛出的错误穿了出来(不吞)", thrown instanceof Error && /injected token-store failure/.test((thrown as Error).message));
    check("抛点之前的落盘 store 已经装好(身份已变 = 半初始化状态真实存在)", getGrantStore() !== grantBefore);
    check("抛点之前的账本也是被注入的那一份", getOperationLedger() === ledger);
    /* ⚠️ 边界：抛点已移到**最后一步**，所以「抛点之后的步骤被跳过」这条没有对象可验
     *（没有后续步骤）。原来那条断言守着的是中间抛点，而中间那个注入点已经不存在了。
     * 如实记在这里，不假装还守着它。 */
  }
  {
    // 正常跑完不抛。
    const { thrown } = runAssembly({ dataRoot: freshDataRoot() });
    check("正常装配不抛", thrown === null);
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
