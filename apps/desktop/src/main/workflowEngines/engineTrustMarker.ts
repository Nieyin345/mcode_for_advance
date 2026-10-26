/**
 * 【Q8 / 批次 1】**引擎信任标记（`engine-trust.json`）的唯一写入路径。**
 *
 * ## 这个文件在决定什么
 *
 * Node-RED 子进程每次启动默认 `safeMode`：`flows.json` 会从磁盘加载（编辑器里
 * 看得到、能编辑），但**不会进入 runtime 执行** —— 定时器不跑、HTTP-in 404、
 * function 节点不执行。只有宿主数据目录下的 `engine-trust.json` 写着
 * `{"trusted":true}` 才放开（`registry.ts:110` 的 `MCODE_ENGINE_TRUSTED`）。
 *
 * 在本次改动之前，**生产代码里没有任何 writer** —— `registry.ts:416` 明确写着
 * 「这里刻意只读不写，写标记的入口将来接 `workflow.approve`」。本模块就是那个入口。
 *
 * ## ⚠️ 粒度：这是一个**进程级**开关，不是每份 flow 一个
 *
 * `safeMode` 传给 `RED.init`，作用于**整个引擎进程**。放开之后，磁盘上
 * `flows.json` 里的**每一张** tab 都会在启动时自动运行 —— 包括用户尚未审查的那些。
 *
 * 所以"用户批准了 A，就写 trust"是**错的**：那会顺带让同一目录里未审查的 B、C
 * 一起跑。本模块因此把条件定成**全库通过**，而不是"这份通过了"：
 *
 *   - 只有**库里所有** `engine === "node-red"` 的图都 `pending === false` 时才写；
 *   - 任何一张还在待审查 → **拒绝写**（`{ ok:false }`，带原因）；
 *   - 撤销 / 内容变化 → **立刻删掉标记**（fail-closed 的方向：宁可不跑）。
 *
 * 这不是保守，是唯一正确的语义：既然开关只有一档，条件就必须是"全部"。
 *
 * ## 为什么不用「引擎里实际有哪几张 tab」做判据
 *
 * `flows.json` 是原生编辑器的真相，用户可以在里面手工建**没有 docId 的纯原生 flow**
 * （`@node-red-native:<tabId>`）。那些 tab 不在 Mcode 库里，也就没有"审查"这个概念。
 * 用它们来判断"能不能整体放开"会让任何一个手工 flow 永久卡住信任。
 * 所以判据只看**库里的图**：原生编辑器里自己的 tab 由 `assertNativeEngineSelection`
 * 在执行入口处另行校验（伪造 `x-mcode.engine` 拿不到执行权）。
 *
 * ## 失败面
 *
 * 写盘失败（权限、磁盘满）**必须抛**给调用方 —— 静默失败会让用户以为批准生效了，
 * 而引擎下次启动仍然是 safeMode，自动化照样哑火，且没有任何线索。
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/** 标记文件名 —— 与 `registry.ts` 的 `isFlowTrusted` 读的必须是同一个名字。 */
export const ENGINE_TRUST_FILE = "engine-trust.json";

/** 写标记需要的事实 —— 注入以便无头验证判据。 */
export interface EngineTrustFacts {
  /** 库里的全部图：只关心 `engine === "node-red"` 的那些与它们的审查状态。 */
  nativeFlows(): ReadonlyArray<{ id: string; pending: boolean }>;
}

export type EngineTrustResult =
  | { ok: true; trusted: boolean }
  | { ok: false; reason: string };

/**
 * 重新计算并落盘信任标记。**幂等**，可以在每次保存/审批/删除之后调用。
 *
 * 三种结果：
 * - 库里没有 node-red 图 → 删标记（没有可执行的东西，别留着放开状态）
 * - 有 node-red 图且**全部**已审查 → 写 `{"trusted":true}`
 * - 有任何一张待审查 → 删标记 + 返回原因（调用方决定是否提示用户）
 */
export function refreshEngineTrustMarker(dataDir: string, facts: EngineTrustFacts): EngineTrustResult {
  const native = facts.nativeFlows();
  const pending = native.filter((flow) => flow.pending);
  if (native.length === 0) {
    removeMarker(dataDir);
    return { ok: true, trusted: false };
  }
  if (pending.length > 0) {
    // 先删再报：宁可让引擎回到 safeMode，也不留一个"部分批准却有执行权"的窗口。
    removeMarker(dataDir);
    return {
      ok: false,
      reason: `${pending.length} 份 Node-RED 工作流尚未审查（${pending.map((f) => f.id).join("、")}）；`
        + "全部审查通过后才会在重启后自动执行",
    };
  }
  writeMarker(dataDir);
  return { ok: true, trusted: true };
}

/**
 * 撤销信任 —— 任何"库里的图变了/被删了/审批被清了"的路径都要调它。
 *
 * 与 `refreshEngineTrustMarker` 的区别：这是**无条件**回到不信任，不做任何判据。
 * 用在拿不准的地方（例如审批账本损坏）。
 */
export function revokeEngineTrust(dataDir: string): void {
  removeMarker(dataDir);
}

function markerPath(dataDir: string): string {
  return join(dataDir, ENGINE_TRUST_FILE);
}

function removeMarker(dataDir: string): void {
  const path = markerPath(dataDir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    // 删不掉 = 引擎下次启动仍可能放开。这不安全，必须让调用方知道。
    throw new Error(`无法撤销引擎信任标记（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 不能让引擎读到半截 JSON —— `isFlowTrusted` 对坏 JSON 的处理是 **untrusted**
 * （fail-closed），所以半截文件不会造成越权，但会让用户明明批准了却不生效，
 * 而且看不出为什么。rename 在同一目录内是原子的。
 */
function writeMarker(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const path = markerPath(dataDir);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify({ trusted: true }), "utf8");
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* 临时文件清不掉不影响结果 */ }
    throw new Error(`无法写入引擎信任标记（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
}
