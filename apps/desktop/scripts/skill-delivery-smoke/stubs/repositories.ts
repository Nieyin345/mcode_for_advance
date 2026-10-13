/**
 * `@main/store/repositories` 的替身 —— 只给 `skill-delivery-smoke` 用。
 *
 * 本套件**驱动真的 provider 类**(`ClaudeAgentSdkProvider` / `CodexAgentSdkProvider`,不做
 * 任何生产代码改动),只在 SDK 边界换桩;而两个 provider 的 import 图会一路拖到
 * `store/db` → `sql.js` → 真库初始化。那跟「技能按引擎交付」无关,却会让无头脚本在
 * import 期就建库、读盘。
 *
 * 这里给的是**内存 SettingRepo**(Map)+ 其余仓储的空只读桩。技能矩阵不走这里
 * (`skillEngines.ts` 读的是 `<skillsRoot>/.mcode-engines.json` 文件),所以本桩只承接
 * 「顺手读一下用户设置」这类旁路调用,返回空即忠实语义。
 *
 * ⚠️ 只声明**被 import 图真正具名引用到**的那些导出;少一个 esbuild 就当场报
 * `No matching export`(这是仓库里验证过的、比运行期 undefined 更早显形的失败)。
 */
const store = new Map<string, string>();

export const SYSTEM_AUTOMATION_PROJECT_ID = "proj_internal_automation";

export const SettingRepo = {
  get: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
  set: (k: string, v: string): void => {
    store.set(k, v);
  },
  getMany: (ks: string[]): Record<string, string | null> =>
    Object.fromEntries(ks.map((k) => [k, store.get(k) ?? null])),
  delete: (k: string): void => {
    store.delete(k);
  },
  keysWithPrefix: (p: string): string[] => [...store.keys()].filter((k) => k.startsWith(p)),
  __reset: (): void => store.clear(),
};

export const SessionRepo = {
  get: () => null,
  list: () => [],
  getMany: () => [],
  create: () => ({}),
  update: () => {},
  delete: () => {},
};
export const MessageRepo = { list: () => [], create: () => ({}), delete: () => {}, deleteBySession: () => {} };
export const ProjectRepo = { get: () => null, list: () => [], create: () => ({}), update: () => {}, delete: () => {} };
export const WorkflowRepo = { get: () => null, list: () => [], create: () => ({}), update: () => {}, delete: () => {} };
export const WorkflowRunRepo = { get: () => null, list: () => [], create: () => ({}), update: () => {}, delete: () => {} };
export const SceneDeploymentRepo = { get: () => null, list: () => [], create: () => ({}), update: () => {}, delete: () => {} };
export const HookRunRepo = { get: () => null, list: () => [], create: () => ({}), update: () => {}, delete: () => {} };
export const CollectionRepo = { list: () => [], get: () => null };
export const LibraryRepo = { list: () => [], get: () => null };
export const NoteRepo = { list: () => [], get: () => null };
export const LibraryLinkRepo = { list: () => [], get: () => null };
