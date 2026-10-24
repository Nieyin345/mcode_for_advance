/**
 * `@main/modules/service.js` 的替身 —— 只给 `mcode-node-pack-ports-smoke` 用。
 *
 * 真模块经 `dataRoot()` → DB → 整条 ModuleHost 装配链,还要真审批端口、真模块目录。
 * 本套要验的不是 ModuleHost 内部(那有它自己的套件),而是**生产端口交给它什么**:
 *   - `resource.projectPath` 是不是用户绑定那个(缺了就不该走到这里);
 *   - `moduleId` / `contributionId` / `path` 有没有原样透传;
 *   - 每次 `invoke` 的 `requestId` 是不是各自新生成的(不复用)。
 *
 * 所以这里只记调用、按脚本返回或抛错。`invokeCalls` 就是断言的落点。
 */
export interface InvokeCall {
  moduleId: string;
  contributionId: string;
  resource: { path: string; projectPath: string };
  requestId: string;
}

export const invokeCalls: InvokeCall[] = [];

/** 摆下一次 invoke 的成败。默认成功返回一个可序列化的小对象。 */
let nextFailure: string | null = null;
let nextResult: unknown = { ok: true, rows: 2 };

export function resetModuleHost(): void {
  invokeCalls.length = 0;
  nextFailure = null;
  nextResult = { ok: true, rows: 2 };
}

export function failNextInvoke(message: string): void {
  nextFailure = message;
}

export function setNextInvokeResult(result: unknown): void {
  nextResult = result;
}

export async function getModuleHost(): Promise<{
  invoke(call: InvokeCall): Promise<unknown>;
}> {
  return {
    async invoke(call: InvokeCall): Promise<unknown> {
      invokeCalls.push({ ...call, resource: { ...call.resource } });
      if (nextFailure) {
        const message = nextFailure;
        nextFailure = null;
        throw new Error(message);
      }
      const result = nextResult;
      nextResult = { ok: true, rows: 2 };
      return result;
    },
  };
}
