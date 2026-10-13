/**
 * `@main/store/repositories.js` 的替身 —— 把 `SettingRepo` 换成**内存表**,其余仓库原样转发
 * 真实实现。只为 app-control-smoke 的 **MC-052 agent 路**断言存在。
 *
 * ## 为什么需要它
 *
 * 【MC-052】要证明「模型经 `app_api_call` **够不到** `agentSsh.approveHost`(approveHost 钉在
 * danger),且 `grantHostTrust` 的**唯一**铸造口只认 `approvalSource:"user"`」这条边界在
 * **真正的 agent 路径**上承重。这条路径要驱动**真** `agentRemoteSsh.ts` 的
 * `grantHostTrust` / `findHostTrustGrant`(它们经 `SettingRepo` 落盘授权表 + known-hosts),
 * 而无头里既没有 electron、也没有必要起 sql.js —— 换成内存表就够。
 *
 * ## 为什么不 `export * from` 真模块
 *
 * `--alias:@main/store/repositories.js=本文件` 会把**这个 specifier** 的每一处 import 都改写到
 * 本文件;若本文件再 `import ... from "@main/store/repositories.js"` 就会指回自己(循环)。
 * 所以转发真实模块时用**相对路径**(不走被别名的 specifier),绕开改写。
 *
 * 其余仓库(ProjectRepo / SessionRepo / MessageRepo / LibraryRepo / …)本套从不真调,原样
 * 转发真实对象即可 —— 与 app-control-smoke 现在的行为一致(它本来就把真 repositories 打进
 * bundle,只是不调用)。规则第 1 条:本套自己抄一份,不复用别的套件目录里的替身。
 */
import * as real from "../../../src/main/store/repositories.js";

const store = new Map<string, string>();

/** 仅供本套断言用:清空,给"全新用户"的场景用。 */
export function __clearSettings(): void {
  store.clear();
}

/** 仅供本套断言用:看设置表里到底写了什么。 */
export function __dumpSettings(): Record<string, string> {
  return Object.fromEntries(store);
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

// 其余导出原样转发真实模块 —— 本套不真调它们,只是让 import 图能成形。
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
