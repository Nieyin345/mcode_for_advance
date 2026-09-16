/**
 * OpenAI 兼容的流式格式 —— 覆盖面最广的一种策略，多数站点可直接复用。
 *
 * 典型载荷：
 *   {"choices":[{"delta":{"content":"你","reasoning_content":"想"},"finish_reason":null}]}
 *
 * 容忍的实现变体（都是这类网关里真实存在的分歧，不是臆想）：
 *  - 思考链字段名不统一：`reasoning_content`（DeepSeek/o1 系）、`reasoning`、
 *    `thinking` 三种都认。
 *  - 内容可能挂在 `message` 而不是 `delta` 上（非流式或网关降级）。
 *  - 有些网关直接推一个 delta 数组，或干脆没有 `choices` 外壳。
 */
import type { FrameParser, TapEvent } from "./types.js";
import { firstString, isRecord, tryParseJson } from "./jsonUtil.js";

/** 从 delta / message / 裸 delta 节点里收集事件。 */
function collectDelta(node: unknown, out: TapEvent[]): void {
  if (!isRecord(node)) return;
  const reasoning = firstString(node, ["reasoning_content", "reasoning", "thinking"]);
  if (reasoning !== undefined) out.push({ kind: "thinking", text: reasoning });
  const content = firstString(node, ["content"]);
  if (content !== undefined) out.push({ kind: "text", text: content });
}

export const openAiDeltaParser: FrameParser = {
  strategy: "openai-delta",

  parse(payload: string): TapEvent[] {
    const parsed = tryParseJson(payload);
    if (parsed === undefined) return [{ kind: "unknown", raw: payload }];

    const out: TapEvent[] = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed) collectDelta(item, out);
      return out.length > 0 ? out : [{ kind: "unknown", raw: payload }];
    }
    if (!isRecord(parsed)) return [{ kind: "unknown", raw: payload }];

    const choices = parsed["choices"];
    if (Array.isArray(choices)) {
      const id = firstString(parsed, ["id"]);
      if (id !== undefined) out.push({ kind: "message-id", id });
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        collectDelta(choice["delta"] ?? choice["message"], out);
      }
      // 有 `choices` 字段就是"认识的形状"：空 delta / 纯 finish_reason 帧返回
      // 空数组（正常），**不能记成 unknown** —— 否则每轮结尾都刷一条假告警。
      return out;
    }

    // 无 choices 外壳：直接把自身当 delta 节点试一次。
    collectDelta(parsed, out);
    return out.length > 0 ? out : [{ kind: "unknown", raw: payload }];
  },
};