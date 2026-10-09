/**
 * 「会话真的被删了」的**主进程侧收尾钩子** —— 一个**零依赖的叶子注册表**。
 *
 * ## 为什么要有它(而不是直接 import)
 *
 * 删会话/删项目的唯一收尾顺序在 `lib/rowDeletion.ts`。有些收尾动作属于**带 electron
 * 依赖的模块** —— 比如 `NotificationManager`(它 `import { Notification } from "electron"`)
 * 按会话留了一张子代理花名册。若 `rowDeletion.ts` 直接 `import` 那个模块,electron 就被
 * 拖进**每一套** bundle 了 `rowDeletion` 的 smoke 的打包图 —— 那些 smoke 的 electron 桩
 * 只桩了它们各自需要的东西(不含 `Notification`),于是十几套会在 **esbuild 阶段**就红,
 * 看起来像"桩不全",其实是"一个不该有的 import"。
 *
 * 所以让**带依赖的那一方在模块加载时把自己登记进来**,`rowDeletion` 只依赖这个零 import
 * 的叶子(与 `mcp/agentSessionCleanup.ts` 的 `registerAgentSessionDisposer` 同一个套路:
 * 那边解决的是同一类问题 —— 让收尾顺序不必 import 每个资源的实现)。
 *
 * ## 顺序 / 幂等
 *
 * 钩子的调用顺序**不保证**,所以每个钩子只该动自己那份状态、不要互相依赖;`rowDeletion`
 * 保证"行删掉之前"全跑一遍。钩子必须**幂等**(同一 id 调两次不得报错),因为删项目那条
 * 路会为项目下每个会话各调一次。
 *
 * ## 一个钩子抛错不能带垮收尾
 *
 * `rowDeletion` 调 `runSessionCleanupHooks(id)` 是在 `SessionRepo.delete(id)` **之前**
 * (见那里的顺序注释)。所以某个钩子抛出来 = 删会话整个半途而废:行还在,后面每一条
 * (`dispose` / `disposeAgentSession` / `forgetSession` / 广播)一步都不做 —— 用户点了
 * 删除却没删掉。这与本模块**自己指名的**那个兄弟 `mcp/agentSessionCleanup.ts` 是同一个
 * 处境(那边 `disposeAgentSession` / `disposeAllAgentResources` 逐个 try/catch,理由写的
 * 就是"调用方正走在删除流程里,不能因为清理失败半途而废")。所以这里也逐个兜住:坏的那个
 * 记一行,其余照跑。用 `console.warn`(不是 `@main/lib/logger`)是为了保住这个叶子的
 * **零依赖** —— 那个 logger 会 `import { app } from "electron"`(见文件头那条理由)。
 */
export type SessionCleanupHook = (sessionId: string) => void;

/** 「项目真的被删了」的收尾钩子。第二个参数是**删之前**读到的项目根路径 ——
 *  行删掉之后就问不到了,而有些资源是按**路径**(不是项目 id)留的(如 LSP 的
 *  workspace 键)。 */
export type ProjectCleanupHook = (projectId: string, projectPath: string) => void;

const hooks = new Set<SessionCleanupHook>();
const projectHooks = new Set<ProjectCleanupHook>();

/** 登记一个"会话被删时"的收尾。返回注销函数(组件/测试用得上)。 */
export function registerSessionCleanupHook(fn: SessionCleanupHook): () => void {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

/** 跑一遍全部收尾钩子。空表是合法的(没有谁登记时什么都不做)。
 *  单个钩子抛错不影响其余几个,也不抛给调用方(调用方正走在删除流程里)。 */
export function runSessionCleanupHooks(sessionId: string): void {
  for (const fn of hooks) {
    try {
      fn(sessionId);
    } catch (err) {
      console.warn(`runSessionCleanupHooks(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 登记一个"项目被删时"的收尾(与 {@link registerSessionCleanupHook} 同一套路)。 */
export function registerProjectCleanupHook(fn: ProjectCleanupHook): () => void {
  projectHooks.add(fn);
  return () => projectHooks.delete(fn);
}

/** 跑一遍全部项目收尾钩子。`projectPath` 是**删之前**读到的根路径。
 *  同 {@link runSessionCleanupHooks}:单个钩子抛错不拖垮其余几个,也不抛给调用方。 */
export function runProjectCleanupHooks(projectId: string, projectPath: string): void {
  for (const fn of projectHooks) {
    try {
      fn(projectId, projectPath);
    } catch (err) {
      console.warn(
        `runProjectCleanupHooks(${projectId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 只给 smoke 用:当前登记了几个。 */
export function __sessionCleanupHookCount(): number {
  return hooks.size;
}
