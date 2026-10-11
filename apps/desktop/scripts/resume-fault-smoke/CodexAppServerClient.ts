/**
 * 假的 `CodexAppServerClient` —— 换掉 CodexAgentSdkProvider 的**相对 import**
 * `./CodexAppServerClient.js`(`--alias` 不收相对名,故走 `--external:./CodexAppServerClient.js`
 * + 把它 esbuild 成同名文件铺在 bundle 旁边)。本文件因此**不得有任何 import**。
 *
 * 复刻真 client 被 provider 用到的接口:`start` / `request` / `handleRequest` /
 * `onNotification` / `dispose`。行为由 `globalThis.__codexFake.reset(mode)` 驱动:
 *   - "reject":`thread/resume` 拒绝(模拟线程不可恢复);
 *   - "empty": `thread/resume` resolve 但**不带** thread.id(恢复拿不到线程);
 *   - "ok"(fresh):不进入 resume 分支,`thread/start` 记录调用并给新 threadId。
 *
 * 为让"**没有工具被派发**"这条断言可判别(不是空过),fresh 模式在 `turn/start` 之后
 * 经 `handleRequest` 派发一次动态工具调用并计数;失败模式永远走不到那里 → 计数为 0。
 */
type Mode = "ok" | "reject" | "empty";

interface CodexFakeState {
  mode: Mode;
  calls: string[];
  toolsDispatched: number;
  reset(mode: Mode): void;
}

interface ServerFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function state(): CodexFakeState {
  const g = globalThis as unknown as { __codexFake?: CodexFakeState };
  if (!g.__codexFake) {
    g.__codexFake = {
      mode: "ok",
      calls: [],
      toolsDispatched: 0,
      reset(mode: Mode) {
        this.mode = mode;
        this.calls = [];
        this.toolsDispatched = 0;
      },
    };
  }
  return g.__codexFake;
}

export class CodexAppServerClient {
  private requestHandler: ((frame: ServerFrame) => Promise<unknown> | unknown) | null = null;
  private readonly notificationListeners = new Set<(frame: unknown) => void>();
  private disposed = false;

  constructor(_opts: unknown) {}

  handleRequest(cb: (frame: ServerFrame) => Promise<unknown> | unknown): void {
    this.requestHandler = cb;
  }

  onNotification(cb: (frame: unknown) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  async start(): Promise<void> {
    /* protocol initialize — 真 client 会 spawn 进程并握一次手;这里空操作。 */
  }

  request(method: string, _params?: unknown): Promise<unknown> {
    const st = state();
    if (method === "initialize") return Promise.resolve({});
    if (method === "thread/resume") {
      st.calls.push("thread/resume");
      if (st.mode === "reject") return Promise.reject(new Error("FAKE resume boom"));
      // "empty":resolve 但不带 thread.id。
      return Promise.resolve({});
    }
    if (method === "thread/start") {
      st.calls.push("thread/start");
      return Promise.resolve({ thread: { id: "new-thread" } });
    }
    if (method === "skills/extraRoots/set") return Promise.resolve({});
    if (method === "turn/start") {
      st.calls.push("turn/start");
      setTimeout(() => void this.__driveTurn(), 0);
      return Promise.resolve({ turn: { id: "turn-1" } });
    }
    if (method === "turn/interrupt") return Promise.resolve({});
    return Promise.resolve({});
  }

  notify(): void {}

  private async __driveTurn(): Promise<void> {
    if (this.disposed) return;
    const st = state();
    if (this.requestHandler) {
      try {
        await this.requestHandler({
          id: 9001,
          method: "item/tool/call",
          params: { tool: "memory_search", callId: "c1", arguments: {} },
        });
        st.toolsDispatched++;
      } catch {
        /* provider 拒绝工具调用不算"未派发";计数只在成功投递时 +1 */
      }
    }
    for (const cb of this.notificationListeners) {
      cb({
        method: "turn/completed",
        params: { threadId: "new-thread", turn: { id: "turn-1", status: "completed" } },
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/* 模块加载即安装到 globalThis,让 main.ts 在跑任何用例前就能 reset()。 */
state();
