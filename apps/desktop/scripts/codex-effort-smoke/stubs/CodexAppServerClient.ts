/**
 * 假的 `CodexAppServerClient` —— 换掉 `CodexAgentSdkProvider` 的相对 import
 * `./CodexAppServerClient.js`（`--external:` + 铺同名文件，同 resume-fault-smoke）。
 *
 * 本文件因此**不得有任何 import**。
 *
 * ## 它记的是**引擎真正收到的 `turn/start` 入参**
 *
 * provider 在 `thread/start` 之后调 `client.request("turn/start", { threadId, input,
 * ...turnOverrides })`。本桩把那份入参**原样**记进 `globalThis.__codexTurnCapture`，
 * 于是「思考强度映射翻译之后，发出去的 `effort` 到底是什么」变成可断言的**真实交付**，
 * 而不是读源码相信调用点接对了。
 *
 * 复刻 provider 用到的接口：`start` / `request` / `handleRequest` / `onNotification`
 * / `dispose`；`turn/start` 后经通知派发一次 `turn/completed`，让回合收尾。
 */
interface Capture {
  /** 历次 turn/start 收到的入参（顺序）。 */
  turnStarts: Array<Record<string, unknown>>;
  /** 收到的所有 request method（顺序）。 */
  calls: string[];
  reset(): void;
}

interface ServerFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function capture(): Capture {
  const g = globalThis as unknown as { __codexTurnCapture?: Capture };
  if (!g.__codexTurnCapture) {
    g.__codexTurnCapture = {
      turnStarts: [],
      calls: [],
      reset() {
        this.turnStarts = [];
        this.calls = [];
      },
    };
  }
  return g.__codexTurnCapture;
}

export class CodexAppServerClient {
  private requestHandler: ((frame: ServerFrame) => Promise<unknown> | unknown) | null = null;
  private readonly notificationListeners = new Set<(frame: unknown) => void>();
  private disposed = false;
  /** 本进程这一轮解析出的主线程 id（thread/start 得到的那个）—— turn/completed
   *  通知要带对 id，adapter 按主线程 id 路由，带错会让收尾永不到达。 */
  private mainThreadId = "effort-thread";

  constructor(_opts: unknown) {
    capture();
  }

  handleRequest(cb: (frame: ServerFrame) => Promise<unknown> | unknown): void {
    this.requestHandler = cb;
  }

  onNotification(cb: (frame: unknown) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  async start(): Promise<void> {}

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const c = capture();
    c.calls.push(method);
    if (method === "initialize") return Promise.resolve({});
    if (method === "thread/start") {
      this.mainThreadId = "effort-thread";
      return Promise.resolve({ thread: { id: "effort-thread" } });
    }
    if (method === "thread/resume") {
      this.mainThreadId = "resumed-thread";
      return Promise.resolve({ thread: { id: "resumed-thread" } });
    }
    if (method === "skills/extraRoots/set") return Promise.resolve({});
    if (method === "turn/start") {
      c.turnStarts.push({ ...(params ?? {}) });
      const threadId = this.mainThreadId;
      setTimeout(() => {
        for (const cb of this.notificationListeners) {
          cb({ method: "turn/completed", params: { threadId, turn: { id: "t1", status: "completed" } } });
        }
      }, 0);
      return Promise.resolve({ turn: { id: "t1" } });
    }
    if (method === "turn/interrupt") return Promise.resolve({});
    return Promise.resolve({});
  }

  notify(): void {}

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/* 模块加载即建立捕获区，让 main.ts 在跑任何用例前就能 reset()。 */
capture();
