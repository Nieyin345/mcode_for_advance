/**
 * 假的 `CodexAppServerClient` —— 换掉 `CodexAgentSdkProvider` 的相对 import
 * `./CodexAppServerClient.js`(`--external:` + 铺同名文件,同 resume-fault-smoke)。
 * 本文件因此**不得有任何 import**。
 *
 * ## 它记的是**引擎真正收到的 `skills/extraRoots/set`**
 *
 * provider 在 `thread/start` 与 `turn/start` 之间调
 * `client.request("skills/extraRoots/set", { extraRoots })`。本桩把那份 `extraRoots`
 * 原样记进 `globalThis.__codexDelivery`,于是「矩阵 / 项目技能过滤之后,Codex 引擎
 * **最终**拿到的技能根列表是什么」变成可断言的**真实交付**。
 *
 * 复刻 provider 用到的接口:`start` / `request` / `handleRequest` / `onNotification`
 * / `dispose`;`turn/start` 后经通知派发一次 `turn/completed`,让回合收尾。
 */
interface CodexDelivery {
  /** 最近一次 skills/extraRoots/set 收到的 extraRoots(未收到过则 null)。 */
  extraRoots: string[] | null;
  /** 【MC-100/101】最近一次 thread/start 或 thread/resume 收到的 dynamicTools 名字列表。 */
  dynamicToolNames: string[] | null;
  /** 收到的所有 request method(顺序)。 */
  calls: string[];
}

function delivery(): CodexDelivery {
  const g = globalThis as unknown as { __codexDelivery?: CodexDelivery };
  if (!g.__codexDelivery) {
    g.__codexDelivery = { extraRoots: null, dynamicToolNames: null, calls: [] };
  }
  return g.__codexDelivery;
}

interface ServerFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** 从 thread/start 或 thread/resume 的 params 里抽 dynamicTools 的 name 列表(MC-100/101)。 */
function captureDynamicTools(params?: Record<string, unknown>): void {
  const tools = params?.["dynamicTools"];
  if (!Array.isArray(tools)) return;
  delivery().dynamicToolNames = tools
    .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

export class CodexAppServerClient {
  private requestHandler: ((frame: ServerFrame) => Promise<unknown> | unknown) | null = null;
  private readonly notificationListeners = new Set<(frame: unknown) => void>();
  private mainThreadId = "smoke-thread";

  constructor(_opts: unknown) {
    delivery();
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
    const d = delivery();
    d.calls.push(method);
    if (method === "initialize") return Promise.resolve({});
    if (method === "thread/resume") {
      this.mainThreadId = "resumed-thread";
      captureDynamicTools(params);
      return Promise.resolve({ thread: { id: "resumed-thread" } });
    }
    if (method === "thread/start") {
      this.mainThreadId = "smoke-thread";
      captureDynamicTools(params);
      return Promise.resolve({ thread: { id: "smoke-thread" } });
    }
    if (method === "skills/extraRoots/set") {
      d.extraRoots = [...((params?.["extraRoots"] as string[] | undefined) ?? [])];
      return Promise.resolve({});
    }
    if (method === "turn/start") {
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

  async dispose(): Promise<void> {}
}

delivery();
