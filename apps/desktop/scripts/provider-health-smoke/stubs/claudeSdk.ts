/**
 * 【MC-076】`@anthropic-ai/claude-agent-sdk` 的桩 —— 换掉
 * `ClaudeAgentSdkProvider.ts` 里 `await import("@anthropic-ai/claude-agent-sdk")`
 * 的**包名**(`--alias:` 认包名)。真那一份会真的 spawn claude 二进制、打上游。
 *
 * 本桩把 `query()` 造出的**异步迭代器**暴露给 `globalThis.__claudeFake`,让脚本能断言:
 * 健康探测超时(宿主 abort)时,provider **确实调了** `iterator.return()`(主动终止查询流),
 * 而不是只让外层 `Promise.race` 停止等待。
 *
 * 迭代器的 `next()` 默认**永不 resolve**(模拟挂死的 SDK);provider 调 `return()`
 * 时才把挂起的 `next()` 收敛成 `{done:true}`(模拟一个守规矩的 SDK 被关时结束流)。
 */
interface ClaudeIterator {
  returned: number;
  args: unknown;
  [Symbol.asyncIterator](): ClaudeIterator;
  next(): Promise<{ value: unknown; done: boolean }>;
  return(value?: unknown): Promise<{ value: unknown; done: boolean }>;
}

interface ClaudeFakeState {
  iterators: ClaudeIterator[];
  returns: number;
  reset(): void;
}

function state(): ClaudeFakeState {
  const g = globalThis as unknown as { __claudeFake?: ClaudeFakeState };
  if (!g.__claudeFake) {
    g.__claudeFake = {
      iterators: [],
      returns: 0,
      reset() {
        this.iterators = [];
        this.returns = 0;
      },
    };
  }
  return g.__claudeFake;
}

export function query(args: unknown): ClaudeIterator {
  const f = state();
  let resolveNext: ((v: { value: unknown; done: boolean }) => void) | null = null;
  const it: ClaudeIterator = {
    returned: 0,
    args,
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return new Promise((resolve) => { resolveNext = resolve; });
    },
    return(value?: unknown) {
      this.returned += 1;
      f.returns += 1;
      // 已挂起的 next() 收敛成 done —— 模拟"关流即结束"。
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value, done: true });
      }
      return Promise.resolve({ value, done: true });
    },
  };
  f.iterators.push(it);
  return it;
}

/* 模块加载即安装到 globalThis,让 main.ts 在跑任何用例前就能 reset()。 */
state();
