/**
 * 最原始的兜底策略：整条 data 就是正文。
 *
 * 适用于不带 JSON 信封的站点（服务端直接把正文增量当 data 推）。也用于
 * 适配器里 `parser: "plain-text"` 的临时抢救 —— 当某个站点改了载荷格式、
 * 而我们还没来得及写新 parser 时，切成这个至少还能看到裸流。
 */
import type { FrameParser, TapEvent } from "./types.js";

export const plainTextParser: FrameParser = {
  strategy: "plain-text",

  parse(payload: string): TapEvent[] {
    if (payload.length === 0) return [];
    return [{ kind: "text", text: payload }];
  },
};