/**
 * 「工作流刚被改了 → 让后台执行器重读这一份」的那一条**缝**。
 *
 * ## 它为什么不能是一句直接调用
 *
 * 写工作流的地方有两处(而且将来可能更多):用户走 IPC(`main/ipc/orchestration.ts`)、
 * AI 走 MCP(`main/mcp/mcodeServer.ts`)。两处都要在写成功之后让 `automationRunner`
 * 重读 —— 不然用户刚把触发方式从「定时」改成「文件变化」,后台却还在按老规矩起运行,
 * 而界面上看不到任何异常。
 *
 * 但 `mcodeServer.ts` **是可以无头 import 并且真被调用的**(见
 * `scripts/mcode-admin-smoke` —— 它真的调 `workflow_save` 的 handler),而
 * `automationRunner` 那条依赖链会一路拉到 electron(`RuntimeManager` → …)。直接
 * `import` 它,那套冒烟会在模块载入时炸掉(同 `providers/bridge/webUpstream` 那条教训)。
 * 「写的时候顺手调一下」本身没错,错的是那个动作带着一整条 electron 依赖。
 *
 * ## 所以:注册 + 请求,两个方向分开
 *
 * 这个文件**不 import 任何东西**(所以谁都能安全 import 它):
 *   - `automationRunner` 启动时把自己**登记**进来({@link setWorkflowReloader});
 *   - 写工作流的地方只管**喊一声**({@link requestWorkflowReload})。
 *
 * 没人在听(无头的冒烟、执行器还没启动、应用正在退出)时,**什么都不发生** —— 那正是
 * 该有的行为:这次写盘本身是成功的,不该因为"后台没在跑"而报错。这也是这套冒烟能继续
 * 拿这个模块当普通函数调的原因。
 */

/** 收到"某一份变了"之后该干什么。`workflowId` 是被改的那一份。 */
export type WorkflowReloader = (workflowId: string) => void;

let reloader: WorkflowReloader | null = null;

/**
 * 登记执行器。**同一时刻只会有一个** —— 它是个单例(`automationRunner`),重复登记是
 * 换一个(测试里重新 start 会走到这儿)。
 */
export function setWorkflowReloader(fn: WorkflowReloader | null): void {
  reloader = fn;
}

/**
 * 喊一声"这一份变了"。**不抛、不返回**:调用方是刚写完盘的写路径,那儿不该因为后台的
 * 事情失败而报错(见文件头)。
 *
 * 顺手把执行器里的异常吞掉:一次重读失败最多是**这一份**的触发器暂时还是旧的,下一次
 * 写、或者下次启动就对了 —— 而把异常抛回 IPC/MCP 那层,用户会看到"保存失败",可他明明
 * 保存成功了。
 */
export function requestWorkflowReload(workflowId: string): void {
  try {
    reloader?.(workflowId);
  } catch {
    /* 后台没接住 —— 与"没人在听"同一类,不影响这次写盘 */
  }
}