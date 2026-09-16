/**
 * 网页版引擎的**帧语义类型** —— 抓流层与站点适配层之间的通用语言。
 *
 * 各站点的 SSE 载荷格式毫不相同（DeepSeek 是私有 `{p,v}`，多数站点是 OpenAI
 * 的 `choices[].delta`），但**我们能表达的东西就那么几种**：正文增量、思考链
 * 增量、状态宣告、消息 id、以及"看不懂"。把站点差异压在 parser 里换成这个
 * 统一词汇，上层的 adapter / provider 就不需要知道任何站点细节。
 */

/** 一帧解析出来的东西。 */
export type TapEvent =
  /** 正文增量。 */
  | { kind: "text"; text: string }
  /** 思考链增量（R1 类推理模型）。 */
  | { kind: "thinking"; text: string }
  /** 站点自报的状态帧（如 DeepSeek 的 `FINISHED`、检索状态）。 */
  | { kind: "status"; status: string }
  /** 服务端给出的消息 id（用于把增量归到同一张气泡上）。 */
  | { kind: "message-id"; id: string }
  /**
   * 看不懂的帧。
   *
   * **刻意不静默丢弃** —— 站点改版最典型的表现就是"突然开始出 unknown"，
   * 留一条计数与日志，比"界面莫名不输出了"好排查得多。
   */
  | { kind: "unknown"; raw: string }
  /** 传输层故障（读流时抛错），由抓流脚本上报。 */
  | { kind: "transport-error"; message: string };

/** 帧解析策略名。新增站点若不在其中，就要写一个新 parser 模块。 */
export type ParserStrategy = "openai-delta" | "deepseek-web" | "plain-text";

/** 一个帧解析策略。纯函数，可被无头 smoke 直测。 */
export interface FrameParser {
  readonly strategy: ParserStrategy;
  /**
   * 解析一条 data 载荷。返回空数组 = "这一帧没有可发的东西"（如 OpenAI 的
   * `finish_reason` 帧），这是正常情况，与 `unknown` 不同。
   */
  parse(payload: string): TapEvent[];
  /**
   * 该事件是否宣告了本轮生成结束。
   *
   * 只有站点会**明确自报**结束时才实现它（DeepSeek 的 `response/status` +
   * `FINISHED`）。多数站点不发这种帧，靠 SSE 的 `[DONE]` 或连接关闭来判定 ——
   * 那两条由分帧器与抓流层负责，不在这里。
   */
  isEnd?(event: TapEvent): boolean;
}