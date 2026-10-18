/**
 * `@main/store/repositories.js` 的替身 —— 把 `SettingRepo` 换成**内存表**,其余仓库原样
 * 转发真实实现。本套的 §4 活路径要真 DB(保存/读回工作流),而发布记录(SettingRepo)
 * 不需要真库。
 *
 * ## 为什么自己抄一份,不复用 app-control-smoke 里的
 *
 * smoke 的老规矩(见 app-control-smoke 同款文件头):每套自己持有一份替身,别的套改了
 * 它的夹具不会连带改变本套的语义。形状与 app-control-smoke 的那份一致。
 *
 * ## 为什么不 `export * from` 真模块
 *
 * `--alias:@main/store/repositories.js=本文件` 会把**这个 specifier** 的每一处 import 都
 * 改写到本文件;若本文件再 `import ... from "@main/store/repositories.js"` 就会指回自己
 * (循环)。所以转发真实模块时用**相对路径**(不走被别名的 specifier),绕开改写。
 * 相对 import 与 alias 都解析到**同一个绝对文件**时 esbuild 只实例化一份 —— 本套脚本
 * 从 `./stubs/repositories.js` 拿到的 `__clearSettings` 与被测代码经 alias 拿到的
 * `SettingRepo` 是同一份内存表(两份实例的坑见 mcode-smoke 技能文档)。
 */
import * as real from "../../../src/main/store/repositories.js";

const store = new Map<string, string>();

/** 仅供本套断言用:清空,给"全新用户"的场景用。 */
export function __clearSettings(): void {
  store.clear();
}

export const SettingRepo = {
  get(key: string): string | null {
    return store.get(key) ?? null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = store.get(k) ?? null;
    return out;
  },
  set(key: string, value: string): void {
    store.set(key, value);
  },
  delete(key: string): void {
    store.delete(key);
  },
};

// 其余仓库原样转发真实实现 —— 本套的 WorkflowRepo 走真库(数据根是 run.sh 的 mktemp)。
export const ProjectRepo = real.ProjectRepo;
export const SessionRepo = real.SessionRepo;
export const MessageRepo = real.MessageRepo;
export const LibraryRepo = real.LibraryRepo;
export const CollectionRepo = real.CollectionRepo;
export const LibraryLinkRepo = real.LibraryLinkRepo;
export const NoteRepo = real.NoteRepo;
export const WorkflowRepo = real.WorkflowRepo;
export const WorkflowRunRepo = real.WorkflowRunRepo;
export const HookRunRepo = real.HookRunRepo;
export const SceneDeploymentRepo = real.SceneDeploymentRepo;
export const SYSTEM_AUTOMATION_PROJECT_ID = real.SYSTEM_AUTOMATION_PROJECT_ID;
