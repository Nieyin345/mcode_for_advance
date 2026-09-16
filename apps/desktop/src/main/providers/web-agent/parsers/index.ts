/**
 * 解析策略库 —— 策略名到实现的查表。
 *
 * 站点适配器只声明一个策略名（`parser: "openai-delta"`），拿到实现是这里的事。
 * 新增站点时**只有当它的载荷不落在这三种里**才需要写新 parser 并在这里登记。
 */
import type { FrameParser, ParserStrategy } from "./types.js";
import { deepseekWebParser } from "./deepseekWeb.js";
import { openAiDeltaParser } from "./openaiDelta.js";
import { plainTextParser } from "./plainText.js";

export const PARSERS: Record<ParserStrategy, FrameParser> = {
  "openai-delta": openAiDeltaParser,
  "deepseek-web": deepseekWebParser,
  "plain-text": plainTextParser,
};

/** 取策略实现。策略名是联合类型，所以这里不需要兜底分支。 */
export function parserFor(strategy: ParserStrategy): FrameParser {
  return PARSERS[strategy];
}

export type { FrameParser, ParserStrategy, TapEvent } from "./types.js";