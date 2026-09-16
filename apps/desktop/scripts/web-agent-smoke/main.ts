/**
 * Headless smoke for the web-agent engine's pure-function layer.
 *
 * 这套引擎的绝大部分（CDP 注入、DOM 填字、真实流旁听）只能真机验证，但**分帧
 * 与解析**是纯函数，而且恰好是最容易写错、又最难在真机上定位的一层：分帧错了
 * 表现为"回答偶尔缺字/串行"，解析错了表现为"某天突然不出内容"。所以这里把
 * 它们钉死。
 *
 * 三个 parser 的断言里有相当一部分是**按第三方逆向观察写的**（DeepSeek 的
 * `{p,v}` 尤其如此）—— 真机样本若与预期不符（W4），先改 parser，再回来改这里。
 * 那些断言同时也是"改版后应该长什么样"的规格说明。
 *
 * Run: scripts/web-agent-smoke/run.sh
 */
import { EMPTY_FRAME_STATE, frameSse, type SseFrameState } from "@main/providers/web-agent/sseFramer.js";
import { parserFor } from "@main/providers/web-agent/parsers/index.js";
import type { TapEvent } from "@main/providers/web-agent/parsers/types.js";
import {
  adapterById,
  defaultAdapter,
  listAdapters,
} from "@main/providers/web-agent/adapters/index.js";
import { deepseekAdapter } from "@main/providers/web-agent/adapters/deepseek.js";
import { buildProbeScript, parseProbeResult } from "@main/providers/web-agent/elementResolver.js";
import { buildTapScript, parseTapPayload } from "@main/providers/web-agent/tapScript.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 把若干 chunk 依次喂进分帧器，收集全部载荷与 done。 */
function feed(chunks: string[]): { payloads: string[]; done: boolean } {
  let state: SseFrameState = EMPTY_FRAME_STATE;
  const payloads: string[] = [];
  let done = false;
  for (const chunk of chunks) {
    const batch = frameSse(state, chunk);
    payloads.push(...batch.payloads);
    done = done || batch.done;
    state = batch.state;
  }
  return { payloads, done };
}

/* ───────────────────── 1. SSE 分帧 ───────────────────── */

console.log("\nframeSse(分帧：块边界与网络分片边界无关)");

eq("单帧", feed(["data: hello\n\n"]).payloads, ["hello"]);
eq("一次到达两帧", feed(["data: a\n\ndata: b\n\n"]).payloads, ["a", "b"]);
eq("帧被切成两半（最常见）", feed(["data: he", "llo\n\n"]).payloads, ["hello"]);
eq("三片才凑齐一帧", feed(["da", "ta: x", "\n\n"]).payloads, ["x"]);

// 最刁的一处：CRLF 恰好被切在 \r 与 \n 之间。天真的实现会在这里少一帧。
eq(
  "CRLF 被切在 \\r 与 \\n 之间",
  feed(["data: a\r", "\n\r\ndata: b\r\n\r\n"]).payloads,
  ["a", "b"],
);
eq("CRLF 分帧", feed(["data: a\r\n\r\n"]).payloads, ["a"]);
eq("CR 单独作行结束符", feed(["data: a\r\r"]).payloads, ["a"]);

// 半帧必须留在 buffer 里，绝不能当完整帧吐出去。
{
  const batch = frameSse(EMPTY_FRAME_STATE, "data: partial");
  eq("半帧不产出载荷", batch.payloads, []);
  eq("半帧留在 buffer", batch.state.buffer, "data: partial");
}

// SSE 规范允许服务端把一条载荷拆成多个 data 行，用 \n 连接。
eq("多行 data 合并", feed(["data: {\"a\":\ndata: 1}\n\n"]).payloads, ['{"a":\n1}']);

// 心跳：很多服务端定期推 `: ping` 防超时。忽略不掉的话会被当坏帧。
eq("注释行（心跳）被忽略", feed([": ping\n\ndata: a\n\n"]).payloads, ["a"]);
eq("只含注释的一批不产出", feed([": ping\n\n"]).payloads, []);

eq("data: 后有空格与无空格都认", feed(["data: a\n\ndata:b\n\n"]).payloads, ["a", "b"]);
eq("data: 无值 → 空载荷", feed(["data:\n\n"]).payloads, [""]);

// [DONE] 是协议层信号，不是载荷 —— 混进 payloads 会让 parser 收到一个假的
// "未知帧"，每轮结尾都刷一条告警。
{
  const r = feed(["data: a\n\ndata: [DONE]\n\n"]);
  eq("[DONE] 不出现在载荷里", r.payloads, ["a"]);
  eq("[DONE] 置 done 标记", r.done, true);
}
eq("没有 [DONE] 时 done 为假", feed(["data: a\n\n"]).done, false);

eq("无关字段被忽略", feed(["event: message\ndata: a\n\n"]).payloads, ["a"]);
eq("空块不产出", feed(["\n\n", "data: a\n\n"]).payloads, ["a"]);

// 逐字符喂：模拟最坏的分片。能把这条测过，说明没有任何"依赖 chunk 形状"的假设。
{
  const whole = "data: a\n\ndata: {\"x\":1}\n\ndata: [DONE]\n\n";
  const r = feed([...whole]);
  eq("逐字符喂入结果一致", r.payloads, ["a", '{"x":1}']);
  eq("逐字符喂入仍识别 [DONE]", r.done, true);
}

// 不修改入参（分帧状态在多个调用点之间传递，就地改会出隐性 bug）。
{
  const state: SseFrameState = { buffer: "data: x" };
  frameSse(state, "\n\n");
  eq("不修改传入的 state", state.buffer, "data: x");
}

/* ────────────────────── 2. deepseek-web parser ────────────────────── */

console.log("\ndeepseek-web parser（{p,v} 私有信封）");

const ds = parserFor("deepseek-web");
const dsFrame = (p: string, v: unknown): string => JSON.stringify({ p, v });

eq("正文增量", ds.parse(dsFrame("response/content", "你")), [{ kind: "text", text: "你" }]);
eq("思考链增量", ds.parse(dsFrame("response/thinking_content", "想")), [
  { kind: "thinking", text: "想" },
]);
eq("状态帧", ds.parse(dsFrame("response/status", "FINISHED")), [
  { kind: "status", status: "FINISHED" },
]);

// 空串是"这一帧没内容"，不是"未知帧" —— 否则每轮都会刷假告警。
eq("正文空串 → 无事件", ds.parse(dsFrame("response/content", "")), []);
eq("v 非字符串 → 无事件", ds.parse(dsFrame("response/content", 42)), []);

// 检索类是我们认识的形状，只是不呈现（一期不做联网检索 UI）。记成 unknown
// 会让用户每搜一次网就刷一片日志，把真正的改版信号淹掉。
check(
  "检索状态不算 unknown",
  ds.parse(dsFrame("response/search_status", "searching")).every((e) => e.kind !== "unknown"),
);
check(
  "检索结果不算 unknown",
  ds.parse(JSON.stringify({ p: "response/search_results", v: [{ title: "x" }] })).every(
    (e) => e.kind !== "unknown",
  ),
);

// 消息 id 与正文可能同帧到达，两个都要吐出来。
eq("同帧携带 response_message_id", ds.parse(JSON.stringify({ p: "response/content", v: "a", response_message_id: "m1" })), [
  { kind: "message-id", id: "m1" },
  { kind: "text", text: "a" },
]);

eq("未知 p → unknown（不静默）", ds.parse(dsFrame("response/something_new", "x")), [
  { kind: "unknown", raw: dsFrame("response/something_new", "x") },
]);
eq("缺 p → unknown", ds.parse(JSON.stringify({ v: "x" })), [
  { kind: "unknown", raw: JSON.stringify({ v: "x" }) },
]);
check("非 JSON → unknown", ds.parse("plain words").every((e) => e.kind === "unknown"));
check("JSON 数组 → unknown", ds.parse("[1,2]").every((e) => e.kind === "unknown"));

check(
  "FINISHED 判定为结束",
  ds.isEnd?.({ kind: "status", status: "FINISHED" }) === true,
);
check(
  "大小写宽容",
  ds.isEnd?.({ kind: "status", status: "finished" }) === true,
);
check(
  "其它状态不算结束",
  ds.isEnd?.({ kind: "status", status: "IN_PROGRESS" }) === false,
);
check("正文不算结束", ds.isEnd?.({ kind: "text", text: "x" }) === false);

/* ────────────────────── 3. openai-delta parser ────────────────────── */

console.log("\nopenai-delta parser（覆盖多数站点的通用策略）");

const oa = parserFor("openai-delta");
const oaFrame = (delta: Record<string, unknown>): string =>
  JSON.stringify({ choices: [{ delta, finish_reason: null }] });

eq("正文增量", oa.parse(oaFrame({ content: "你" })), [{ kind: "text", text: "你" }]);

// 思考链字段名在实际网关里摇摆过 —— 三种都得认，否则换个站点就看不到思考过程。
eq("reasoning_content", oa.parse(oaFrame({ reasoning_content: "想" })), [
  { kind: "thinking", text: "想" },
]);
eq("reasoning 别名", oa.parse(oaFrame({ reasoning: "想" })), [{ kind: "thinking", text: "想" }]);
eq("thinking 别名", oa.parse(oaFrame({ thinking: "想" })), [{ kind: "thinking", text: "想" }]);

// 思考与正文同帧：思考先出（推理模型总是先想后说）。
eq("同帧思考 + 正文", oa.parse(oaFrame({ reasoning_content: "想", content: "说" })), [
  { kind: "thinking", text: "想" },
  { kind: "text", text: "说" },
]);

// 结尾帧（空 delta + finish_reason）必须是"空"，不是"未知" —— 否则每轮结束都
// 报一次假告警。
eq("空 delta 结尾帧 → 无事件", oa.parse(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })), []);
eq("choices 空数组 → 无事件", oa.parse(JSON.stringify({ choices: [] })), []);

// 有些网关把内容挂在 message 上（非流式或降级流）。
eq("message 而非 delta", oa.parse(JSON.stringify({ choices: [{ message: { content: "答" } }] })), [
  { kind: "text", text: "答" },
]);

// 无 choices 外壳的裸 delta。
eq("裸 delta（无 choices 外壳）", oa.parse(JSON.stringify({ content: "裸" })), [
  { kind: "text", text: "裸" },
]);

// 顶层 id 用于把增量归到同一张气泡。
eq("提取顶层 id", oa.parse(JSON.stringify({ id: "c1", choices: [{ delta: { content: "a" } }] })), [
  { kind: "message-id", id: "c1" },
  { kind: "text", text: "a" },
]);

check("非 JSON → unknown", oa.parse("<html>").every((e) => e.kind === "unknown"));
check(
  "不认识的对象 → unknown",
  oa.parse(JSON.stringify({ foo: "bar" })).every((e) => e.kind === "unknown"),
);

/* ────────────────────── 4. plain-text parser ────────────────────── */

console.log("\nplain-text parser（兜底策略）");

const pt = parserFor("plain-text");
eq("整条 data 即正文", pt.parse("你好"), [{ kind: "text", text: "你好" }]);
eq("空载荷 → 无事件", pt.parse(""), []);
eq("不做 JSON 解析", pt.parse('{"a":1}'), [{ kind: "text", text: '{"a":1}' }]);

/* ────────────────────── 5. 适配器注册表 ────────────────────── */

console.log("\nadapters（新增站点的落点）");

check("至少注册了一个站点", listAdapters().length > 0);
check("含 deepseek", adapterById("deepseek") !== undefined);
eq("未知 id → undefined", adapterById("nope"), undefined);
eq("默认站点是表里的第一项", defaultAdapter().id, listAdapters()[0]?.id);

eq("适配器的 id 即 builtinModels 的模型 id", deepseekAdapter.id, "deepseek");
check("homeUrl 是 https 站点", deepseekAdapter.homeUrl.startsWith("https://"));
check(
  "声明的 parser 策略存在实现",
  typeof parserFor(deepseekAdapter.parser).parse === "function",
);
check("流 URL 匹配规则非空", deepseekAdapter.streamUrlPatterns.length > 0);
// 每个已注册站点都要能查到一个真实存在的 parser —— 这条能挡住"加了站点但策略名
// 拼错"这种会在运行时才炸的错误。
check(
  "所有站点的 parser 策略都可解析",
  listAdapters().every((a) => typeof parserFor(a.parser).parse === "function"),
);
// 每个站点的 id 必须唯一，否则 UI 里会出现两个同 id 的"模型"。
check(
  "站点 id 唯一",
  new Set(listAdapters().map((a) => a.id)).size === listAdapters().length,
);

/* ────────────────────── 6. 端到端组合 ────────────────────── */

console.log("\n端到端（分帧 + 解析，模拟真实字节流分片）");

// 模拟一轮真实回答：思考链两段 → 正文两段 → 状态结束。故意切在 JSON 中间。
const wire = [
  `data: ${dsFrame("response/thinking_content", "先想")}\n\n`,
  `data: ${dsFrame("response/thinking_content", "再想")}\n\ndata: ${dsFrame("response/content", "答案是")}\n`,
  `\ndata: ${dsFrame("response/content", "42")}\n\n`,
  `data: ${dsFrame("response/status", "FINISHED")}\n\n`,
];
const { payloads } = feed(wire);
const events: TapEvent[] = payloads.flatMap((p) => ds.parse(p));

eq(
  "事件序列（思考 → 正文 → 状态）",
  events,
  [
    { kind: "thinking", text: "先想" },
    { kind: "thinking", text: "再想" },
    { kind: "text", text: "答案是" },
    { kind: "text", text: "42" },
    { kind: "status", status: "FINISHED" },
  ] satisfies TapEvent[],
);
check("其中一帧被宣告结束", events.some((e) => ds.isEnd?.(e) === true));
check("全程没有 unknown（改版会立刻在这里暴露）", events.every((e) => e.kind !== "unknown"));

/* ────────── 7. 注入脚本与回传校验（语法 + 防重入 + 参数注入） ────────── */

console.log("\n注入脚本（生成源码）");

{
  const src = buildTapScript(["a", "b"]);
  // 这是本次最有价值的一条断言：注入源码是**手写的长模板字符串**，少一个括号
  // 的症状是"运行时一条流都抓不到"（而且看起来像站点改版），一条 new Function
  // 就能在几毫秒内拦住它。
  let tapCompiles = true;
  try {
    new Function(src);
  } catch {
    tapCompiles = false;
  }
  check("tap 脚本语法合法", tapCompiles);
  check("模式列表已注入", src.includes('["a","b"]'));
  check("版本标记已注入", src.includes('var VERSION = "1"'));
  // 防重入：重复注入会让每个 chunk 上报两次（界面里每个字都重复），标记必须在。
  check(
    "带防重入检查",
    src.includes("window.__mcodeTap && window.__mcodeTap.version === VERSION"),
  );
  check(
    "两条路都堵（fetch 与 XHR）",
    src.includes("originalFetch") && src.includes("XMLHttpRequest"),
  );
  check("fetch 响应做了 clone（否则页面自己读不到流）", src.includes(".clone()"));
  // 页面里绝不该出现 Node 能力 —— 这是 preload 那侧承诺过的隔离性质。
  check("源码不含 require(", !/\brequire\s*\(/.test(src));
}

{
  const src = buildProbeScript(deepseekAdapter);
  let probeCompiles = true;
  try {
    new Function(src);
  } catch {
    probeCompiles = false;
  }
  check("探测脚本语法合法", probeCompiles);
  // evaluate 走的是 new Function(code)，所以必须是函数体（末尾 return），不是 IIFE。
  check("是函数体形式", src.trimStart().startsWith("return (function"));
  check("适配器选择器已注入", src.includes(JSON.stringify(deepseekAdapter.selectors?.input)));
}

console.log("\nparseTapPayload(回传数据形状校验)");

eq("chunk", parseTapPayload({ t: "chunk", label: "fetch", text: "x" }), {
  t: "chunk",
  label: "fetch",
  text: "x",
});
eq("chunk 缺 text → null", parseTapPayload({ t: "chunk", label: "fetch" }), null);
eq("open", parseTapPayload({ t: "open", label: "fetch", url: "u" }), {
  t: "open",
  label: "fetch",
  url: "u",
});
eq("open 缺 url → 空串兜底", parseTapPayload({ t: "open", label: "fetch" }), {
  t: "open",
  label: "fetch",
  url: "",
});
eq("close", parseTapPayload({ t: "close", label: "xhr" }), { t: "close", label: "xhr" });
eq("error 缺 message → 兜底文案", parseTapPayload({ t: "error", label: "fetch" }), {
  t: "error",
  label: "fetch",
  message: "未知抓流错误",
});
eq("ready", parseTapPayload({ t: "ready", version: "1" }), { t: "ready", version: "1" });
// 页面回传的形状不受我们控制 —— 校验漏了，一个 `undefined.text` 就能把 provider
// 打崩，比丢一条数据严重得多。
eq("未知类型 → null", parseTapPayload({ t: "whatever" }), null);
eq("非对象 → null", parseTapPayload("nope"), null);
eq("null → null", parseTapPayload(null), null);
eq("数字 → null", parseTapPayload(42), null);

console.log("\nparseProbeResult(探测结果形状校验)");

const goodProbe = {
  url: "https://x/",
  title: "t",
  input: "#a",
  inputKind: "textarea",
  send: "#b",
  stop: null,
  loggedOut: false,
  diagnostics: { textareas: 1, contentEditables: 0, buttons: 3, hasBridge: true, tapHits: 2 },
};
eq("正常结果原样通过", parseProbeResult(goodProbe), goodProbe);
eq("缺 diagnostics → null", parseProbeResult({ url: "x" }), null);
eq("非对象 → null", parseProbeResult(null), null);
{
  const r = parseProbeResult({ diagnostics: {}, inputKind: "weird", input: 5 });
  check("非法 inputKind 归一化为 null", r !== null && r.inputKind === null, r);
  check("非字符串 input 归一化为 null", r !== null && r.input === null, r);
  check("缺失的计数补 0", r !== null && r.diagnostics.textareas === 0, r);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);