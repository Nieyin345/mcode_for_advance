/**
 * TapEvent → RuntimeEvent 的翻译层。
 *
 * 比 Pi/Claude 的同类薄得多 —— 网页版引擎一期只有"正文 + 思考"两路数据，没有
 * 工具调用、没有用量结算、没有子代理。它独立成文件的价值在于：**把"怎么变成 UI
 * 认识的事件"从 provider 的编排逻辑里分出来**，将来加工具调用时只动这里。
 *
 * ## 一个 messageId 贯到底
 * 渲染端的增量缓冲按 `${sessionId}:${messageId}` 分桶，桶里是多个 seg
 * （`{k:"thinking"|"text", text}`）—— 也就是**同一条 assistant 消息里可以同时有
 * 思考块和正文块**，正是我们要的效果（与 Claude 的扩展思考一致）。所以思考与
 * 正文共用一个 messageId，而不是各开一条消息。
 */
import type { ProviderContext } from "@contracts/provider.js";
import type { TurnDoneReason } from "@contracts/runtime.js";
import type { TapEvent } from "./parsers/types.js";

export class WebMessageAdapter {
  /** 本轮 assistant 消息的 id（思考与正文共用）。 */
  private readonly messageId = `web_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  /** 是否已经吐过内容 —— 用来判定"空回答"（要解释，不能装作成功）。 */
  private produced = false;
  /** 未知帧的日志限流（真改版时会成百上千条，全打出来反而看不见起点）。 */
  private unknownCount = 0;
  private finished = false;

  constructor(
    private readonly sessionId: string,
    private readonly ctx: ProviderContext,
  ) {}

  /** 处理一批已解析的帧。 */
  handle(events: TapEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "thinking":
          this.produced = true;
          this.ctx.emit({
            type: "thinking",
            sessionId: this.sessionId,
            messageId: this.messageId,
            text: event.text,
          });
          break;
        case "text":
          this.produced = true;
          this.ctx.emit({
            type: "text.delta",
            sessionId: this.sessionId,
            messageId: this.messageId,
            text: event.text,
          });
          break;
        case "transport-error":
          // 抓流层的故障：不打断本轮（已收到的内容仍然有效），但必须留痕。
          this.ctx.log.warn(`web-agent: 抓流出错 — ${event.message}`);
          break;
        case "unknown":
          this.unknownCount += 1;
          if (this.unknownCount <= 3) {
            this.ctx.log.warn(
              `web-agent: 未知帧（站点可能已改版，需要更新 parser）— ${event.raw.slice(0, 200)}`,
            );
          } else if (this.unknownCount === 4) {
            this.ctx.log.warn("web-agent: 未知帧过多，后续同类日志已省略");
          }
          break;
        default:
          // status / message-id：一期不呈现（结束判定在 EngineSession 里用）
          break;
      }
    }
  }

  /** 本轮是否产出过内容。 */
  get hasContent(): boolean {
    return this.produced;
  }

  /**
   * 收尾：消息边界 + 回合结束。
   *
   * `turn.done` **必须最后发**（RuntimeManager 的终态清理以它为准）；没产出过
   * 内容就不发 `message.complete`（否则渲染端会多出一条空气泡）。
   */
  finish(reason: TurnDoneReason): void {
    if (this.finished) return;
    this.finished = true;
    if (this.produced) {
      this.ctx.emit({
        type: "message.complete",
        sessionId: this.sessionId,
        messageId: this.messageId,
      });
    }
    this.ctx.emit({ type: "turn.done", sessionId: this.sessionId, reason });
  }
}