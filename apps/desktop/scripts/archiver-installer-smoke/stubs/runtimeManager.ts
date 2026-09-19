/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么这套要换它(2026-09-20)
 *
 * 上游 `4a02f35` 给 `session/AutoArchiver.ts` 加了一句
 * `runtimeManager.dispose(session.id)`,于是**整条 Claude provider 链**被拖进了本套的
 * import 图:`claude/RuntimeManager.ts` → `providers/registry.ts` → 三个引擎实现 →
 * `workflows/seed.ts` → `workflows/searchScriptsAssets.ts`(二十几个 **Vite `?raw`
 * 导入**的 `.py` / `LICENSE`)。esbuild 不认那些后缀,打包直接以
 * `No loader is configured for ".py" files` 挂掉 —— 报的是 seed 里那几行,看着和
 * 被测的归档/安装一个字都不沾。
 *
 * 建套件那次这个 import 还不存在,所以当时是绿的;而**坏的形状是"整套一句断言都
 * 不执行"**,很容易被当成"没跑而已"。切在 `RuntimeManager` 这一刀之后,
 * `BrowserManager` / `searchScriptsAssets` / 三个 provider 全都从图里消失 ——
 * 所以本套**不需要** seed 桩,也**不需要**动共享的 electron 桩(那有 6 套在用)。
 *
 * ## 换掉它没有削弱这套要验的东西
 *
 * 本套验的是**自动归档**:哪些会话该进归档箱、哪些不该、以及归档之后界面收到没有。
 * `RuntimeManager` 在这条路上只被用到一句 —— 归档完**放掉运行时**。这一句不是装饰:
 * 上游注释写明不放的话,那条会话的进程内状态(transcript、用量历史、上一轮的
 * 文件快照)会一直驻留到删除为止。
 *
 * 所以这里**不是空实现**:把它记下来,让甲.1 能断言"每一条被归档的都放了运行时,
 * 而且只有它们"。
 */
const disposed: string[] = [];

/** 被 `dispose()` 过的会话 id,按调用顺序。 */
export function disposedIds(): string[] {
  return [...disposed];
}

export function resetRuntimeStub(): void {
  disposed.length = 0;
}

export const runtimeManager = {
  /** `runAutoArchive` 每归档一条调一次 —— 本套要断言的就是它。 */
  dispose(sessionId: string): void {
    disposed.push(sessionId);
  },
  /** 本套一次都不调,真被调到要立刻显形。 */
  disposeProject(): never {
    throw new Error("archiver-installer-smoke 不该走到 runtimeManager.disposeProject —— 本套不删项目");
  },
  /** 同上:本套不中断回合(候选里已经排掉了 running/approving)。 */
  interrupt(): never {
    throw new Error("archiver-installer-smoke 不该走到 runtimeManager.interrupt —— 候选里没有在跑的会话");
  },
  /** 本套不发外部事件(窗口那一路由 stubs/window.ts 单独记)。 */
  emitExternal(): void {},
  subscribe(): () => void {
    return () => {};
  },
};
