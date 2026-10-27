/**
 * **启动装配序列** —— `main/index.ts` 在「数据库就绪之后、窗口装配之前」跑的那一段「装」。
 *
 * ## 为什么把这些步骤抽出来
 *
 * 这段装配此前**整段内联在 `index.ts` 的 `void initDb().then(...)` 里**。`index.ts`
 * 顶层就 `import { app } from "electron"` 且跑真实 Electron 装配,无头 smoke 引不动它 ——
 * 于是「这几个装配点按什么顺序装、装出来的到底是不是落盘版、某一步抛了会怎样」**没有任何
 * 回归网**(`smokes-for.sh --uncovered` 把 `index.ts` 列为零覆盖)。抽成**不 import electron**
 * 的纯函数后,加载点由调用方注入真实实现 / 数据根,无头 smoke 断言**可观察的装配结果**
 * 即可(与 `grantStoreRuntime.assembleGrantStore` 同一姿势)。
 *
 * ## 只抽「electron-free 的装配 + 两个注入口」,不抽运行时接线
 *
 * 这段里只有一部分能无头跑:`setOperationLedger` / `setVisionRelayImpl` / 三个落盘 store
 * 的装配 / `assembleSceneRuntime`。另外一步(`configureExtensionBridgeTokenStore` 读写设置表)
 * **碰 electron / db**,不能静态 import 进本模块(那会把 electron 拉进这个无头套件),
 * 所以它**经 deps 注入** —— 断言的「装上了没有 / 装在第几步」不变。其余接线(工具表 host、
 * run guard、公网 MCP、delegate)仍留在 `index.ts`,不在本函数的职责里。
 *
 * ## 顺序即语义 —— 抽出来时**逐字保留** `index.ts` 原顺序
 *
 * 1. `setVisionRelayImpl`(视觉中继真实实现)
 * 2. `setOperationLedger`(换 sql.js durable 账本)
 * 3. `assembleGrantStore(dataRoot)`
 * 4. `assembleUnattendedPlanStore(dataRoot)`
 * 5. `assembleHostHookGrantPersist(dataRoot)`
 * 6. `assembleSceneRuntime()`
 * 7. `configureExtensionBridgeTokenStore(store)`(注入)
 *
 * ⚠️ **序列里原本还有第 6 步 `assembleModuleApprovalPort()`（模块 action 的原生审批端口，
 * MC-060）。它随 ModuleHost 于 2026-10-27 整体删除**（`modules/moduleApproval.ts` 已不存在；
 * 现行扩展审批走 `modules/extensionApproval.ts`，走的是渲染端审批卡不是这个端口）。
 * 所以这里是 7 步不是 8 步。
 *
 * 删除当时**没同步改这段注释，也没改 `startup-wiring-smoke`** —— 于是那套断言
 * 「两个注入点都被调到」「审批端口先于令牌落盘」长期红着，红因写着「装配顺序坏了」，
 * 而实际是**判据指着一个已删除的注入点**。2026-10-28 一并修正。
 *
 * ## 失败即中止(如实穿透,不吞、不半途续装)
 *
 * 本函数是**扁平序列,不逐条 try/catch** —— 与抽取前 `index.ts` 那段的行为**逐字一致**:
 * 某一步抛出会**中止余下的装配并向上抛**。`index.ts` 那层是 `initDb().then(onFulfilled,
 * onRejected)` 的 `onFulfilled`,它抛出的 rejection **不被那个 `onRejected` 接**(那一个只接
 * `initDb()` 自己的失败),而是变成一条 `unhandledRejection` 记进日志。于是「同一步失败 →
 * 半初始化继续跑」这件事**如实保留**:本模块不替生产决定「要不要 fail-fast」,只保证
 * 抽取前后**行为不变**,并让 smoke 能把这条语义**断言出来**(见 startup-wiring-smoke)。
 */
import type { OperationLedger } from "@main/appControl/operations.js";
import { setOperationLedger } from "@main/appControl/operations.js";
import { assembleGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { assembleUnattendedPlanStore } from "@main/appServices/unattendedPlanStore.js";
import { assembleHostHookGrantPersist } from "@main/hooks/hostHookGrantFile.js";
import { isHostHookGrantArchiveCorrupt } from "@main/hooks/hostHookGrants.js";
import { assembleSceneRuntime } from "@main/orchestration/sceneTaskRuntime.js";
import { setVisionRelayImpl, type VisionRelayImpl } from "@main/mcp/visionRelayRegistry.js";
// 类型-only:extensionBridge.ts 会 `import electron`,但 `import type` 在编译期被抹掉,
// 不会把 electron 拉进本模块的运行时 import 图。
import type { BridgeTokenStore } from "@main/providers/bridge/extensionBridge.js";

/** 装配这段序列所需的全部依赖 —— electron-free 的**直接**装配,electron 相关的**注入**。 */
export interface StartupAssemblyDeps {
  /** 统一数据根(纯字符串)。生产传真实的 `dataRoot()`;无头 smoke 传临时目录。 */
  dataRoot: string;
  /** 操作账本:生产传 `store/operationLedger.ts` 的 sql.js durable 版。 */
  operationLedger: OperationLedger;
  /** 视觉中继的真实实现(读设置 + 发 SDK query)。 */
  visionRelay: VisionRelayImpl;
  /** Electron 相关:扩展桥令牌落盘装配(`providers/bridge/extensionBridge.ts` 的 `configureExtensionBridgeTokenStore`)。 */
  configureExtensionBridgeTokenStore: (store: BridgeTokenStore) => void;
  /** 令牌存取实现(生产由 `SettingRepo` 读写 `web.bridgeToken`)。 */
  bridgeTokenStore: BridgeTokenStore;
  /**
   * 装配期**上报**一条损坏告警(MC-029)。可选 —— 生产传 `log.error` 一类;无头 smoke 可省。
   * 本模块整体保持 electron-free,所以**注入**而不是直接 import `@main/lib/logger`(它依赖 electron)。
   */
  reportCorruption?: (message: string) => void;
}

/**
 * 跑一遍启动装配序列。**顺序即语义**(见文件头),失败即中止(不吞)。
 * `index.ts` 在 `initDb().then(...)` 里调它一次,位置与抽取前那段逐字一致。
 */
export function assembleStartup(deps: StartupAssemblyDeps): void {
  // 视觉中继:装配期把真实实现登进登记口,`agent_read_image` 才拿得到它(报告 D10 / Q1)。
  setVisionRelayImpl(deps.visionRelay);
  // 操作账本:换成 sql.js durable 版,让「同一个 operationId 不重复执行」跨进程成立(MC-067)。
  setOperationLedger(deps.operationLedger);
  // 计划级授权 GrantStore(ARC-004 步④):落盘到 `<数据根>/appControl/grants.json`。
  assembleGrantStore(deps.dataRoot);
  // 无人值守计划存档(MC-059 残余④):落盘到 `<数据根>/appControl/unattended-plans.json`。
  // ★ MC-029:装配后立刻查健康度 —— 存档读不懂时持有核会**拒绝写入**(保全原字节),这件事
  //   必须显式报出来(硬规矩 3),否则用户看到的是"从没有过计划"。
  if (assembleUnattendedPlanStore(deps.dataRoot).isArchiveCorrupt()) {
    deps.reportCorruption?.(
      "unattended-plans.json 读不懂(可能写入中断被截断)—— 已停用该存档的写入以免覆盖原字节;原文件保留在 <数据根>/appControl/ 下,修复或删除后重启即可。",
    );
  }
  // 主机 hook 授权(MC-061):落盘到 `<数据根>/hooks/host-hook-grants.json`。
  // ★ MC-029:同无人值守存档 —— 读不懂时拒绝写入并显式报出来(保全原字节)。
  assembleHostHookGrantPersist(deps.dataRoot);
  if (isHostHookGrantArchiveCorrupt()) {
    deps.reportCorruption?.(
      "host-hook-grants.json 读不懂(可能写入中断被截断)—— 已停用该存档的写入以免覆盖原字节;原文件保留在 <数据根>/hooks/ 下,修复或删除后重启即可。",
    );
  }
  // 场景任务注册表(ARC-013 步②):装配一份全新的进程内运行期(注册表 + 总账一起重置)。
  assembleSceneRuntime();
  // 扩展桥配对令牌持久化(必须跨重启稳定,否则浏览器扩展每次启动静默掉线)。
  deps.configureExtensionBridgeTokenStore(deps.bridgeTokenStore);
}
