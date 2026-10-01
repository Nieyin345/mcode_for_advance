/**
 * 「在终端里跑一条命令」的请求通道(R39,给自定义 UI 的「运行终端命令」动作用)。
 *
 * 底部终端面板(`TerminalPanel`)一直挂着(收起时只是高度为 0),它挂载时订阅这里;
 * 订阅之前来的请求先排队,订阅时一次性交出去 —— 不会因为面板还没渲染就丢命令。
 */
type Listener = (command: string) => void;

let listener: Listener | null = null;
const pending: string[] = [];

export function requestTerminalRun(command: string): void {
  if (listener) listener(command);
  else pending.push(command);
}

export function subscribeTerminalRunRequests(fn: Listener): () => void {
  listener = fn;
  for (const cmd of pending.splice(0)) fn(cmd);
  return () => {
    if (listener === fn) listener = null;
  };
}
