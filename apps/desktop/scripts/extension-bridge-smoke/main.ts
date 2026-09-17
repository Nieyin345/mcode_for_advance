/**
 * Headless smoke for the browser-extension bridge
 * (`main/providers/bridge/extensionBridge.ts`) — the local HTTP channel a browser
 * extension uses to drive a web chat page on behalf of a `protocol: "web"` custom
 * model.
 *
 * No electron and no browser here: this file **plays the role of the extension**
 * against the real server (real `listen(0)` on 127.0.0.1, real HTTP). It opens the
 * SSE connection, receives `prompt`/`abort`, and posts back the events a real
 * extension would send. That is the entire contract — the layers above it
 * (webUpstream → OpenAiToAnthropicSse) are driven directly here for the one thing
 * they own on their own (streaming vs non-streaming replies); the rest of that
 * translation and the extension itself are covered elsewhere / by hand.
 *
 * The scenarios that matter are the failure modes nobody sees until a user hits
 * them: a token that doesn't match, a *web page* trying to reach the port, a
 * prompt sent while nothing is paired, an extension that dies mid-turn, and a
 * regenerated token that must invalidate the old one.
 *
 * Run: scripts/extension-bridge-smoke/run.sh
 */
import {
  BRIDGE_TOKEN_SETTING_KEY,
  bridgeStatus,
  configureExtensionBridgeTokenStore,
  ensureStarted,
  regenerateToken,
  runPrompt,
  stopExtensionBridge,
  abortTurn,
} from "@main/providers/bridge/extensionBridge.js";
import { handleWebMessages } from "@main/providers/bridge/webUpstream.js";
import type { AnthropicRequest, UpstreamConfig } from "@main/providers/bridge/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* ────────────────────────── helpers ────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate — the bridge has no "paired" event to await. */
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

/** Reject a promise after `ms` so a regression hangs the suite loudly (as a
 *  failed assertion) instead of silently eating the 240s harness timeout. */
async function withDeadline<T>(label: string, p: Promise<T>, ms = 3000): Promise<T | string> {
  return Promise.race([
    p.catch((err: unknown) => `threw:${(err as Error).message}`),
    sleep(ms).then(() => `timeout:${label}`),
  ]);
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** 一个足够像 `node:http` 的收发对，用来直接调 `handleWebMessages` —— 那边只用到
 *  `req.on` 和 `res.writeHead/write/end`。 */
function makeReqRes() {
  const chunks: string[] = [];
  const state = { status: 0, headers: {} as Record<string, string> };
  const req = { on: () => undefined };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      Object.assign(state.headers, headers);
      return res;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      return res;
    },
  };
  return {
    req: req as unknown as Parameters<typeof handleWebMessages>[0],
    res: res as unknown as Parameters<typeof handleWebMessages>[1],
    body: () => chunks.join(""),
    state,
  };
}

const WEB_UPSTREAM: UpstreamConfig = {
  baseUrl: "",
  authToken: "",
  authMode: "auth_token",
  protocol: "web",
  webSiteId: "deepseek",
};

/** Split an SSE byte stream into events, skipping comment (heartbeat) frames. */
function parseFrames(text: string): Frame[] {
  const out: Frame[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      out.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    } catch {
      // a fragment that isn't valid JSON is not something the extension could act
      // on either — drop it rather than fail the whole stream.
    }
  }
  return out;
}

/** One open `GET /v1/bridge/stream` — the extension's side of the wire. */
interface Stream {
  status: number;
  contentType: string;
  /** Resolves once the response HEADERS are in — i.e. the connection is either
   *  established or refused. Never waits for the body: a healthy SSE stream does
   *  not end until we close it. */
  ready: Promise<void>;
  next(ms?: number): Promise<Frame | null>;
  close(): void;
}

function openStream(
  url: string,
  opts: { token?: string; header?: boolean; origin?: string } = {},
): Stream {
  const ac = new AbortController();
  const frames: Frame[] = [];
  const state = { status: 0, contentType: "" };
  const query = opts.token !== undefined && !opts.header ? `?token=${encodeURIComponent(opts.token)}` : "";
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.header && opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.Origin = opts.origin;

  let announce!: () => void;
  const ready = new Promise<void>((resolve) => {
    announce = resolve;
  });

  void (async () => {
    try {
      const res = await fetch(`${url}/v1/bridge/stream${query}`, {
        headers,
        signal: ac.signal,
      });
      state.status = res.status;
      state.contentType = res.headers.get("content-type") ?? "";
      announce();
      if (!res.ok || !res.body) {
        await res.text().catch(() => "");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const cut = buffer.lastIndexOf("\n\n");
        if (cut < 0) continue;
        frames.push(...parseFrames(buffer.slice(0, cut + 2)));
        buffer = buffer.slice(cut + 2);
      }
    } catch {
      // refused / aborted — the caller inspects `status` and the assertions fail
      // with a readable number instead of an unhandled rejection.
      announce();
    }
  })();

  return {
    get status() {
      return state.status;
    },
    get contentType() {
      return state.contentType;
    },
    ready,
    async next(ms = 3000) {
      const deadline = Date.now() + ms;
      while (frames.length === 0) {
        if (Date.now() > deadline) return null;
        await sleep(10);
      }
      return frames.shift() ?? null;
    },
    close() {
      ac.abort();
    },
  };
}

/** Status of a request whose response we never want to read as a stream. */
async function statusOf(url: string, init: RequestInit = {}): Promise<number> {
  const res = await fetch(url, init);
  await res.text().catch(() => "");
  return res.status;
}

/** Post one up-event, the way the extension reports progress. */
async function postEvent(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/v1/bridge/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body: parsed };
}

/* ─────────────────────── token lifecycle (pre-start) ─────────────────────── */

const beforeStart = bridgeStatus();
check("token exists before the server starts", beforeStart.token.length >= 32, beforeStart.token);
check("url is empty before the server starts", beforeStart.url === "", beforeStart.url);
check("not paired before the server starts", beforeStart.paired === false);
eq("token store key is the documented one", BRIDGE_TOKEN_SETTING_KEY, "web.bridgeToken");

await ensureStarted();
const started = bridgeStatus();
const url = started.url;
const token = started.token;
check("url is a loopback http endpoint", /^http:\/\/127\.0\.0\.1:\d+$/.test(url), url);
eq("still unpaired with no extension connected", started.paired, false);
eq("pairedAt is null while unpaired", started.pairedAt, null);

/* ─────────────────────────────── auth & CORS ─────────────────────────────── */

eq(
  "wrong token is rejected",
  await statusOf(`${url}/v1/bridge/stream?token=deadbeefdeadbeef`),
  401,
);
eq("missing token is rejected", await statusOf(`${url}/v1/bridge/stream`), 401);
eq(
  "wrong token on the up-channel is rejected",
  await statusOf(`${url}/v1/bridge/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
    body: JSON.stringify({ type: "delta", turnId: "x" }),
  }),
  401,
);
eq(
  "a web origin is refused (only extensions may reach the port)",
  await statusOf(`${url}/v1/bridge/stream?token=${token}`, {
    headers: { Origin: "https://evil.example" },
  }),
  403,
);
eq(
  "preflight is answered",
  await statusOf(`${url}/v1/bridge/events`, { method: "OPTIONS" }),
  204,
);
eq("unknown path is 404", await statusOf(`${url}/v1/nope?token=${token}`), 404);

// Both auth channels must work: a real extension uses the header, but an
// EventSource (the only way to hold a stream open in a service worker) can only
// pass `?token=`.
for (const [label, opts] of [
  ["query token", { token }],
  ["Authorization header", { token, header: true }],
  ["chrome-extension origin", { token, header: true, origin: "chrome-extension://abcdef" }],
] as const) {
  const probe = openStream(url, opts);
  await probe.ready;
  eq(`stream opens with ${label}`, probe.status, 200);
  eq(`stream is served as SSE with ${label}`, probe.contentType, "text/event-stream");
  probe.close();
}

/* ───────────────────────────── pairing handshake ───────────────────────────── */

const ext = openStream(url, { token });
await ext.ready;
eq("extension connects", ext.status, 200);
const hello = await ext.next();
eq("first frame is hello", hello?.event, "hello");
eq("hello declares the protocol version", hello?.data.protocol, 1);
eq("hello carries the bridge url", hello?.data.bridgeUrl, url);
check("status reports paired once the stream is held", await waitFor(() => bridgeStatus().paired));
check("pairedAt is stamped", typeof bridgeStatus().pairedAt === "number");

/* ─────────────────────────── a full conversation turn ─────────────────────────── */

const deltas: string[] = [];
const thoughts: string[] = [];
const statuses: string[] = [];
const conversations: string[] = [];

const turn = runPrompt({
  sessionKey: "session-1",
  siteId: "deepseek",
  text: "你好，帮我看看这个方案",
  handlers: {
    onDelta: (t) => deltas.push(t),
    onThinking: (t) => thoughts.push(t),
    onStatus: (t) => statuses.push(t),
    onConversation: (c) => conversations.push(c),
  },
});

const prompt = await ext.next();
eq("down-channel sends prompt", prompt?.event, "prompt");
eq("prompt carries the site", prompt?.data.siteId, "deepseek");
eq("prompt carries the session key", prompt?.data.sessionKey, "session-1");
eq("prompt carries the text", prompt?.data.text, "你好，帮我看看这个方案");
const turnId = String(prompt?.data.turnId ?? "");
check("prompt carries a turn id", /^[0-9a-f-]{36}$/.test(turnId), turnId);

eq("delta is accepted", (await postEvent(url, token, { type: "delta", turnId, text: "你" })).status, 200);
eq("thinking is accepted", (await postEvent(url, token, { type: "thinking", turnId, text: "想" })).status, 200);
eq("status is accepted", (await postEvent(url, token, { type: "status", turnId, text: "正在思考" })).status, 200);
eq(
  "conversation id is accepted",
  (await postEvent(url, token, { type: "conversation", turnId, conversationId: "web-42" })).status,
  200,
);
eq("second delta is accepted", (await postEvent(url, token, { type: "delta", turnId, text: "好" })).status, 200);

const doneResponse = await postEvent(url, token, { type: "done", turnId });
eq("done is accepted", doneResponse.status, 200);
const settled = await withDeadline("turn resolution", turn);
eq("done resolves the turn", settled, undefined);
eq("streamed deltas are concatenated in order", deltas.join(""), "你好");
eq("thinking is routed separately", thoughts.join(""), "想");
eq("status hints are routed", statuses.join(""), "正在思考");
eq("conversation id is routed", conversations.join(""), "web-42");

/* ───────────────────────── events for turns that are gone ───────────────────────── */

const late = await postEvent(url, token, { type: "delta", turnId: "not-a-real-turn", text: "x" });
eq("late event for an unknown turn is 200", late.status, 200);
eq("late event is ignored, not an error", late.body, { ok: true, ignored: true });

/* ───────────── non-streaming requests get JSON, not a stream ───────────── */

// claude 在流式那一轮失败后会补一次**非流式重试**。过去这条路一律回 SSE，于是它报
// "the non-streaming request was answered with a stream" —— 一句把真正原因（扩展没连
// 上）整个盖掉的错。这里钉住非流式的两条出口：成功回 Message、失败回非 2xx + error。

const nsOk = makeReqRes();
const nsOkRun = handleWebMessages(
  nsOk.req,
  nsOk.res,
  {
    model: "deepseek-web",
    max_tokens: 16,
    stream: false,
    messages: [{ role: "user", content: "非流式" }],
  } as AnthropicRequest,
  WEB_UPSTREAM,
  null,
);
const nsPrompt = await ext.next();
eq("a non-streaming request still drives the page", nsPrompt?.event, "prompt");
await postEvent(url, token, { type: "delta", turnId: nsPrompt?.data.turnId, text: "答案" });
await postEvent(url, token, { type: "done", turnId: nsPrompt?.data.turnId });
await withDeadline("non-streaming turn", nsOkRun);
eq("a non-streaming success answers 200", nsOk.state.status, 200);
eq("a non-streaming success is JSON", nsOk.state.headers["Content-Type"], "application/json");
check("the answer is a message body, not an event stream", !nsOk.body().includes("event:"), nsOk.body());
const nsMessage = JSON.parse(nsOk.body()) as {
  type: string;
  content: { type: string; text: string }[];
};
eq("the message is typed as a message", nsMessage.type, "message");
eq("the message carries the streamed text", nsMessage.content[0]?.text, "答案");

const nsFail = makeReqRes();
// 没有 user 消息 → 这一轮直接失败，正是"扩展没连上"那类错误的同一条出口。
await handleWebMessages(
  nsFail.req,
  nsFail.res,
  { model: "deepseek-web", max_tokens: 16, stream: false, messages: [] } as AnthropicRequest,
  WEB_UPSTREAM,
  null,
);
eq("a non-streaming failure answers with an HTTP error status", nsFail.state.status, 502);
check("the failure body is an error payload, not an event stream", !nsFail.body().includes("event:"), nsFail.body());
check(
  "the failure body carries the real reason",
  (JSON.parse(nsFail.body()) as { error?: { message?: string } }).error?.message?.length ? true : false,
  nsFail.body(),
);

/* ─────────────── error events, aborts, and a mid-turn disconnect ─────────────── */

const failTurn = runPrompt({ sessionKey: "session-2", siteId: "deepseek", text: "会失败的" });
const failTurnResult = failTurn.then(() => null, (err: Error) => err);
const failPrompt = await ext.next();
eq(
  "unknown event type is a 400 for a live turn",
  (await postEvent(url, token, { type: "wat", turnId: failPrompt?.data.turnId })).status,
  400,
);
await postEvent(url, token, {
  type: "error",
  turnId: failPrompt?.data.turnId,
  message: "网页侧执行失败：找不到输入框",
});
const failErr = await failTurnResult;
check(
  "an error event fails the turn with the site's message",
  failErr instanceof Error && failErr.message === "网页侧执行失败：找不到输入框",
  String(failErr),
);

const abortTurnReq = runPrompt({ sessionKey: "session-3", siteId: "deepseek", text: "会被中断" });
const abortTurnResult = abortTurnReq.then(() => null, (err: Error) => err);
const abortPrompt = await ext.next();
abortTurn(String(abortPrompt?.data.turnId ?? ""));
const abortFrame = await ext.next();
eq("abortTurn sends an abort down-channel", abortFrame?.event, "abort");
eq("abort carries the turn id", abortFrame?.data.turnId, abortPrompt?.data.turnId);
const abortErr = await abortTurnResult;
check("abortTurn fails the turn", abortErr instanceof Error, String(abortErr));

const ac = new AbortController();
const signalTurn = runPrompt({
  sessionKey: "session-4",
  siteId: "deepseek",
  text: "用 signal 中断",
  signal: ac.signal,
});
const signalTurnResult = signalTurn.then(() => null, (err: Error) => err);
const signalPrompt = await ext.next();
ac.abort();
const signalAbortFrame = await ext.next();
eq("signal abort sends an abort down-channel", signalAbortFrame?.event, "abort");
eq("signal abort carries the turn id", signalAbortFrame?.data.turnId, signalPrompt?.data.turnId);
const signalErr = await signalTurnResult;
check("signal abort fails the turn", signalErr instanceof Error, String(signalErr));
check(
  "an already-aborted signal fails before prompting",
  (await runPrompt({
    sessionKey: "session-5",
    siteId: "deepseek",
    text: "已经中断了",
    signal: ac.signal,
  }).then(
    () => null,
    (err: Error) => err,
  )) instanceof Error,
);

const dropTurn = runPrompt({ sessionKey: "session-6", siteId: "deepseek", text: "扩展会掉线" });
const dropTurnResult = dropTurn.then(() => null, (err: Error) => err);
await ext.next();
ext.close();
const dropErr = await dropTurnResult;
check(
  "a mid-turn disconnect fails the in-flight turn",
  dropErr instanceof Error && /断开/.test(dropErr.message),
  String(dropErr),
);
check("disconnect clears the paired flag", await waitFor(() => !bridgeStatus().paired));
eq("pairedAt is cleared on disconnect", bridgeStatus().pairedAt, null);

/* ─────────── reconnecting: the grace period absorbs the gap ──────────── */

// MV3 会把扩展的 service worker 回收，重连要等它被叫醒（实测空窗 20~30 秒）。所以
// "此刻没连上"不该立刻判失败：宽限期内连回来，这一轮照常走完。
const waiting = runPrompt({ sessionKey: "session-7", siteId: "deepseek", text: "重连之后再说" });
const waitingResult = waiting.then(() => "resolved", (err: Error) => `threw:${err.message}`);
await sleep(150);
const reconnected = openStream(url, { token });
await reconnected.ready;
check("the grace period holds until the extension is back", await waitFor(() => bridgeStatus().paired));

eq("the reconnected stream opens with hello", (await reconnected.next())?.event, "hello");
const resumed = await reconnected.next();
eq("the held turn is delivered to the reconnected extension", resumed?.data.sessionKey, "session-7");
const resumedId = String(resumed?.data.turnId ?? "");
await postEvent(url, token, { type: "delta", turnId: resumedId, text: "接着说" });
await postEvent(url, token, { type: "done", turnId: resumedId });
eq("the held turn completes instead of failing", await withDeadline("held turn", waitingResult), "resolved");
reconnected.close();
await waitFor(() => !bridgeStatus().paired);

const ext2 = openStream(url, { token });
await ext2.ready;
await waitFor(() => bridgeStatus().paired);
const rotated = regenerateToken();
check("regenerate mints a new token", rotated.token !== token);
eq("regenerate drops the current extension", rotated.paired, false);
eq("the old token stops working", await statusOf(`${url}/v1/bridge/stream?token=${token}`), 401);
eq("the new token works", await statusOf(`${url}/v1/bridge/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${rotated.token}` },
  body: JSON.stringify({ type: "delta", turnId: "gone" }),
}), 200);
ext2.close();

/* ──────────────────── the token survives an app restart ───────────────────── */

const persisted = new Map<string, string>();
const settingsStore = {
  get: () => persisted.get(BRIDGE_TOKEN_SETTING_KEY) ?? null,
  set: (value: string) => {
    persisted.set(BRIDGE_TOKEN_SETTING_KEY, value);
  },
};
configureExtensionBridgeTokenStore(settingsStore);
const mintedForFreshInstall = bridgeStatus().token;
eq("a fresh install writes its token to settings", persisted.get(BRIDGE_TOKEN_SETTING_KEY), mintedForFreshInstall);

// Simulate the next launch: same settings row, new process.
configureExtensionBridgeTokenStore(settingsStore);
eq("the token is reused after a restart", bridgeStatus().token, mintedForFreshInstall);

/* ─────────── unpaired for good: the wait is bounded, then it fails ─────────── */

// 宽限期不是无限挂起 —— 一直没人连上来，就按原来的措辞报错（只是晚了 35 秒）。
// 这条要真等到宽限期用完，所以放在最后：前面的断言先给反馈。
const abandoned = await withDeadline(
  "unpaired prompt",
  runPrompt({ sessionKey: "session-8", siteId: "deepseek", text: "没人在听" }),
  40_000,
);
check(
  "an unpaired prompt still fails with the unconnected message once the grace period ends",
  typeof abandoned === "string" && abandoned.startsWith("threw:") && /未连接/.test(abandoned),
  String(abandoned),
);

/* ─────────────────────────────── shutdown ─────────────────────────────── */

stopExtensionBridge();
eq("stop clears the advertised url", bridgeStatus().url, "");

/* ─────────────────────────────── report ─────────────────────────────── */

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ extension-bridge smoke: ${passed} assertions passed`);
process.exit(0);