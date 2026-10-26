/**
 * `@main/orchestration/extensionCommandPort.js` 的替身 —— 只给 `mcode-node-pack-ports-smoke` 用。
 *
 * 真的那个在**执行时**才去取 Theia 的已安装扩展注册表（会拖进 fork / RPC / 协议一整片）。
 * 无头套件里没有 Theia，也不需要 —— 本套要验的是「生产端口把什么交给扩展端口、
 * 缺哪个字段必拒」，不是 Theia 能不能跑扩展。
 *
 * ⚠️ **必须替换，不能让真的那个跑到执行路径**：真身没装配时抛
 * 「扩展运行时还没有装配」，那句话会让 C 节的正控全都红，而红因和被测的
 * projectPath 授权完全无关（CLAUDE.md 第十六条：红了但红错地方）。
 */
export interface ExtensionExecuteCall {
  extensionId: string;
  commandId: string;
  path: string;
  signal: AbortSignal;
}

/** `execute` 收到的每一次调用。 */
export const extensionCalls: ExtensionExecuteCall[] = [];

let nextResult: unknown = { ok: true };
let nextError: string | null = null;

/** 摆下一次 `execute` 的返回值。 */
export function setNextExtensionResult(value: unknown): void {
  nextResult = value;
}

/** 摆下一次 `execute` 抛错。 */
export function failNextExtension(error: string): void {
  nextError = error;
}

/** 块级隔离。 */
export function resetExtensionPort(): void {
  extensionCalls.length = 0;
  nextResult = { ok: true };
  nextError = null;
}

export const extensionCommandPort = {
  async execute(input: ExtensionExecuteCall): Promise<unknown> {
    extensionCalls.push(input);
    if (nextError !== null) {
      const message = nextError;
      nextError = null;
      throw Error(message);
    }
    return nextResult;
  },
};
