/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么这套要换它(2026-09-20)
 *
 * 上游 `4a02f35` 给 `ipc/projects.ts` 加了
 * `import { runtimeManager } from "@main/claude/RuntimeManager.js"`,于是**整条
 * Claude provider 链**被拖进了本套的 import 图,打包挂在
 * `No loader is configured for ".py" files`(`providers/claude-sdk/` →
 * `workflows/seed.ts` → `searchScriptsAssets.ts` 那二十几个 Vite `?raw` 导入)。
 *
 * 建套件那次(`f9eeacd`)这个 import 还不存在,所以当时 98/98 绿 —— 是这次合并
 * 把它弄坏的,而**坏的形状是"整套一句断言都不执行"**,很容易被当成"没跑而已"。
 *
 * 切在这里是有讲究的:`RuntimeManager` 是本套唯一需要"真进程"的依赖,把它换成桩
 * 之后,`BrowserManager` / `searchScriptsAssets` / `ClaudeAgentSdkProvider` 全都
 * 从图里消失了 —— 所以本套**不需要** seed 桩,也**不需要**动共享的 electron 桩。
 *
 * ## 换掉它没有削弱这套要验的东西
 *
 * 本套验的是"删会话/删项目时**该清的都清了**"。而清理分两半:
 *
 *   - `cancelWorkflowRun` / `dropBackflow` —— 本套自己有桩,逐条断言;
 *   - `runtimeManager.dispose()` / `disposeProject()` —— **就是这个桩**。
 *
 * 后一半以前没有任何断言在看(那时代码里也还没有这句话),所以这里不只是空实现,
 * **它把调用记下来**,让 §8 能钉住"删的时候真的去放了运行时"。上游那句注释写的
 * 后果是:不放的话运行时会**驻留到应用退出**,而且删掉的会话上还在跑的回合会继续
 * 往死会话里写事件、把孤儿消息行插回去 —— 那是用户看得见的脏数据。
 */
import { traceCall } from "./callTrace.js";

const disposed: string[] = [];
const disposedProjects: string[] = [];

/** 被 `dispose()` 过的会话 id,按调用顺序。 */
export function disposedIds(): string[] {
  return [...disposed];
}

/** 被 `disposeProject()` 过的项目 id。 */
export function disposedProjectIds(): string[] {
  return [...disposedProjects];
}

export function resetRuntimeStub(): void {
  disposed.length = 0;
  disposedProjects.length = 0;
}

export const runtimeManager = {
  /** 删会话时逐个调用。 */
  dispose(sessionId: string): void {
    disposed.push(sessionId);
    traceCall("dispose", sessionId);
  },
  /** 删项目时一次调用,内部自己去列这个项目下的会话。 */
  disposeProject(projectId: string): void {
    disposedProjects.push(projectId);
    traceCall("disposeProject", projectId);
  },
  /** 归档也走这一句(本套不测归档,但注册路径上会被引用)。 */
  interrupt(sessionId: string): void {
    void sessionId;
  },
  /** 本套用不到,但 `ipc/library.ts` 那条链上会引用。 */
  emitExternal(): void {},
  subscribe(): () => void {
    return () => {};
  },
};
