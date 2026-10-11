/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么要换它
 *
 * `MobileHttpServer` 从它拿**一样**东西:`runningSessionIds()` —— SSE 连接建立时那帧
 * `session.runningSnapshot`("哪些会话正在跑")。真 RuntimeManager 一路拖到
 * `providers/registry.js` → 三个引擎实现 → `workflows/seed.js` 的二十几个 `?raw`
 * 的 `.py`/LICENSE(esbuild 认不出那些后缀),与 `library-import-smoke` /
 * `attach-links-smoke` 同一个切法。
 *
 * ## 为什么这里要**接住**而不是显式抛
 *
 * 与 frontend-smoke 的 electron 桩同一个理由:它是**被测路径的一部分**。SSE 的
 * 首帧就是那帧快照,而那一帧是"手机后台时漏掉 `turn.done`、界面永远转圈"那个
 * 已修 bug 的修复物 —— 桩里返回一个**指定的**集合,才能断言"帧里带的正是这些会话"。
 * 让它抛就等于在无头环境里把这个功能整条砍掉。
 */
const running = new Set<string>();

/** 脚本用这个摆出"当前有哪几个会话在跑"。 */
export function __setRunning(ids: string[]): void {
  running.clear();
  for (const id of ids) running.add(id);
}

export const runtimeManager = {
  runningSessionIds(): string[] {
    return [...running];
  },
  /** 本套只在 sentinel-回答那一段走到真 turn —— 把 cwd 记下来供断言核对。
   *  别的 `claude:*` RPC 本套不发;除了 sendTurn 的几个伴生调用,其余真被调到要立刻显形。 */
  sendTurn(session: { id: string; workflowId?: string }, input: { cwd?: string }): { done: Promise<void> } {
    turnCwds.push({ sessionId: session.id, cwd: input.cwd ?? "", workflowId: session.workflowId ?? "" });
    return { done: Promise.resolve() };
  },
  bindSession(): void {
    /* sentinel 回答那一路会重绑会话 —— 无头环境没有真运行时,接住即可。 */
  },
  notifyRequestResolved(): void {
    /* 同上:sentinel 路径会广播"这张卡已答"给别的端,本套不验。 */
  },
  resolveUserInput(): boolean {
    return false;
  },
  /** `session:updateSettings` 带 permissionMode 时会同步进运行时桥(见桌面同款)。
   *  ⚠️ 这个桩方法**非有不可**:没有它,MC-048 那条"改已删除会话必须 ok:false"的
   *  permissionMode 断言会在**更新成功**之后撞上 `setPermissionMode is not a function`
   *  的 TypeError → 400 → 也回 ok:false —— **为错误的理由变绿**。补上它,断言才真的
   *  在验「存在性检查有没有挡住这次更新」。 */
  setPermissionMode(): void {
    /* 无头环境没有真运行时桥,接住即可。 */
  },
  /** `claude:rewindTurn` 那一路 —— MC-047 要验的是**手机 RPC 返回的形状**:
   *  handler 必须把 `{restored, failed, conflicts}` 三个数组**平铺**交回来,而不是把
   *  整个对象塞进 `restored` 一个字段。桩返回一份三个数组各不相同的记号,脚本据
   *  HTTP 响应 JSON 断言它们的落点。 */
  rewindTurn(
    sessionId: string,
    files: unknown,
    targetFiles: unknown,
  ): { restored: string[]; failed: string[]; conflicts: string[] } {
    rewindCalls.push({ sessionId, files, targetFiles });
    return { restored: ["REW_A", "REW_B"], failed: ["REW_FAIL"], conflicts: ["REW_CONFLICT"] };
  },
  emitExternal(): void {
    /* 事件广播本套不验 —— MobileEventBus 由脚本自己直接驱(bus.broadcast) */
  },
};

/** 脚本读它来核对"那一轮被送进了哪个目录"(sentinel 断言用)。 */
export const turnCwds: Array<{ sessionId: string; cwd: string; workflowId: string }> = [];

/** 脚本读它来核对 `rewindTurn` 的实参。(MC-047 的正文断言看 HTTP 响应的形状。) */
export const rewindCalls: Array<{ sessionId: string; files: unknown; targetFiles: unknown }> = [];
