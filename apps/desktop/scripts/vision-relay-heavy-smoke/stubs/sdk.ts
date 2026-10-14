/**
 * `@anthropic-ai/claude-agent-sdk` 的替身 —— 只给 `vision-relay-smoke` 用（`--alias:` 认包名）。
 *
 * ## 为什么必须换掉
 *
 * `lib/visionRelay.ts` 里那句是 `await import("@anthropic-ai/claude-agent-sdk")`（包名，
 * 换得掉）。真那一份会 spawn 一个 claude 二进制、读用户级登录态、**打真上游** —— 既花钱，
 * 结果还取决于网络与额度，而这一套要验的是**宿主交给 SDK 的入参**与**失败是否如实**。
 *
 * ## 它记的是"引擎真正收到的 options"
 *
 * `describeImage` 最后调 `query({ prompt, options })`。本桩把那份 `options` 原样记进
 * `globalThis.__visionDelivery`，于是"转述请求真的带了空工具表 / 图真的进了消息流 /
 * 复用既有那条链路"变成**可断言的入参**，而不是靠读注释相信。
 *
 * 消息序列（吐什么）由 `MCODE_SMOKE_VISION_MESSAGES` 控制（JSON 数组），
 * `MCODE_SMOKE_VISION_THROW` 则让它直接抛 —— 模拟连不上 / 认证被拒 / 到点 abort。
 */
interface VisionDelivery {
  /** query() 被调用的次数。 */
  calls: number;
  /** 最近一次 query() 收到的完整 options。 */
  options: Record<string, unknown> | null;
  /** 最近一次 query() 收到的 prompt 是否是可迭代的消息流（带图的走这条）。 */
  promptIsIterable: boolean | null;
  /** 从一次性消息流里抽出的 content block 形状（验图有没有真进去）。 */
  contentBlocks: unknown[] | null;
}

function delivery(): VisionDelivery {
  const g = globalThis as unknown as { __visionDelivery?: VisionDelivery };
  if (!g.__visionDelivery) {
    g.__visionDelivery = { calls: 0, options: null, promptIsIterable: null, contentBlocks: null };
  }
  return g.__visionDelivery;
}

const DEFAULT_SEQUENCE: unknown[] = [
  { type: "assistant", message: { content: [{ type: "text", text: "一只猫坐在窗台上。" }] } },
  { type: "result", subtype: "success", is_error: false, result: "一只猫坐在窗台上。" },
];

function sequence(): unknown[] {
  const raw = process.env["MCODE_SMOKE_VISION_MESSAGES"];
  if (!raw) return DEFAULT_SEQUENCE;
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    return DEFAULT_SEQUENCE;
  }
}

async function* messages(): AsyncGenerator<unknown> {
  if (process.env["MCODE_SMOKE_VISION_THROW"]) {
    throw new Error(process.env["MCODE_SMOKE_VISION_THROW"]);
  }
  for (const item of sequence()) yield item;
}

export async function* query(args: {
  prompt?: unknown;
  options?: Record<string, unknown>;
}): AsyncGenerator<unknown> {
  const d = delivery();
  d.calls += 1;
  d.options = args.options ?? null;
  const prompt = args.prompt;
  // 纯文本那四个先例走 string；带图的是自己造的一次性消息流（AsyncIterable）。
  d.promptIsIterable = typeof prompt === "object" && prompt !== null && Symbol.asyncIterator in (prompt as object);
  if (d.promptIsIterable) {
    for await (const msg of prompt as AsyncIterable<{ message?: { content?: unknown[] } }>) {
      d.contentBlocks = (msg?.message?.content as unknown[]) ?? null;
      break; // 一次性流：只取第一条消息的 block。
    }
  }
  yield* messages();
}

export function createSdkMcpServer(opts: { name: string; version?: string; tools?: unknown[] }) {
  return { type: "sdk", name: opts.name, version: opts.version, instance: {} };
}
export function tool(name: string) {
  return { name };
}

export type Options = Record<string, unknown>;

delivery();
