/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么要换它
 *
 * `ipc/library.ts` 注册时的 `ensureWorkflows()` 会拉进
 * `workflows/seed.ts` → `workflows/assets.ts`(TS 模板串,能打) 与
 * `workflows/searchScriptsAssets.ts`(二十几个 **Vite `?raw` 导入**的 `.py` / `LICENSE`)。
 * esbuild 不认 `.py` 那个后缀、`license` 连后缀都没有,配 loader 也盖不住 ——
 * 整条引擎链就从被测路径上消失了。
 *
 * 与 `library-import-smoke` / `attach-links-smoke` / `session-fork-smoke` 同款切法。
 *
 * ## 这里**不换** `workflows/seed.js`
 *
 * `run.sh` 那份桩把 `ensureWorkflows` 换成了 no-op。**那是对的**:本套测的是
 * `ipc/library.ts`,而 seed 只是"注册时把脚本写到数据根"的一步,与删除无关 ——
 * 桩里也顺带断言"它确实被调到了"。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 按顺序记下发出去的每条外部事件(下载完成/导入那一族)。 */
export const externals: RuntimeEvent[] = [];

export const runtimeManager = {
  emitExternal(event: RuntimeEvent): void {
    externals.push(event);
  },
  subscribe(): () => void {
    return () => {};
  },
};
