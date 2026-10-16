/**
 * 【MC-009】回合截断检测 —— **引擎无关**的共享判据（Claude / Pi / Codex 三家用同一份）。
 *
 * ## 为什么抽到这里
 *
 * 第三方网关（OpenAI 协议桥 / Responses 网关）有一种失败模式：用**空补全**应答
 * 最后一次 tool_result，或把一切 finish_reason 抹平成 end_turn —— 模型跑到一半
 * 就"正常结束"了。Claude 侧从 2026-08-20 起有三种判据（dangling-tools /
 * empty-response / unfinished-text）挡着，而 Pi / Codex 侧**没有**：同一网关症状
 * 在那边静默报完成，用户以为任务做完了。同一份判据写三遍必漂（仓库硬规矩 2），
 * 所以抽成一个纯函数：入参是**中立事实**（本轮工具是否配对、发过什么文本、末条
 * 消息形态），三个适配器各自喂进来，输出同一个判定。
 *
 * 消费端零改动：发出去的还是 `TurnIncompleteEvent`（renderer 的琥珀警告卡与
 * 「发送"继续"可恢复」直接复用）。
 *
 * ## 判据刻意收窄（继承自 Claude 侧原实现，逐条对齐）
 *
 *  - 轮必须以**成功**收尾（错误已由 error 事件浮出，不重复报）；
 *  - 轮不能被用户中断（中断时悬空工具是预期行为）；
 *  - 判据按优先级三选一：悬空工具 > 跑了工具但一个字没说 > 末条文本像没写完。
 */

/** 悬空工具调用的展示/关联信息（与 `TurnIncompleteEvent.pendingToolCalls` 同形）。 */
export interface DanglingToolCall {
  toolCallId: string;
  toolName: string;
}

/**
 * 一轮的中立事实 —— 各适配器从自己的事件流里算出来喂进来。
 * 字段语义与 Claude 侧原判据逐字对应（见 SdkMessageAdapter 的历史注释）。
 */
export interface TurnIncompleteFacts {
  /** 轮以"成功"收尾。Claude: lastResultSubtype==="success"；
   *  Pi/Codex: 驱动 turn.done 的 reason==="end_turn"。 */
  endedSuccessfully: boolean;
  /** 用户中断过本轮（悬空工具是预期行为）。 */
  aborted: boolean;
  /** 发过 tool.use 但没等到 tool.result 的调用。调用方已做完各自的
   *  "背景子代理可合法悬空"过滤（如 Claude 的 Task），这里只看数量。 */
  danglingToolCalls: DanglingToolCall[];
  /** 本轮发过 assistant 文本。 */
  textEmitted: boolean;
  /** 本轮发过 tool.use 的总条数。 */
  toolUseCount: number;
  /** 用过交互工具（EnterPlanMode / ExitPlanMode / AskUserQuestion）——
   *  这类轮合法地没有收尾叙述。 */
  interactionToolSeen: boolean;
  /** 最后一条 assistant 消息的纯文本（"" = 该条无文本）。 */
  lastAssistantText: string;
  /** 最后一条 assistant 消息里带工具调用。 */
  lastAssistantHadToolUse: boolean;
}

export type TurnIncompleteKind = "dangling-tools" | "empty-response" | "unfinished-text";

export interface TurnIncompleteVerdict {
  kind: TurnIncompleteKind;
  /** 只有 dangling-tools 带；其余为空数组。 */
  pendingToolCalls: DanglingToolCall[];
}

/** 末条叙述以继续性标点收尾 = 宣告的下一步没到达（观测 2026-09-02，
 *  deepseek OpenAI 桥把 finish_reason 全抹成 end_turn）。 */
export const UNFINISHED_TRAILING_RE = /[：:，,、；;]$/;

/**
 * 全部判据。命中时返回判定（kind + 悬空清单），健康轮返回 null。
 * 纯函数：不记日志、不发事件 —— 那是适配器的事（各家的日志措辞可以不同，
 * 判据必须相同）。
 */
export function detectTurnIncomplete(facts: TurnIncompleteFacts): TurnIncompleteVerdict | null {
  if (!facts.endedSuccessfully) return null;
  if (facts.aborted) return null;

  if (facts.danglingToolCalls.length > 0) {
    return { kind: "dangling-tools", pendingToolCalls: facts.danglingToolCalls };
  }

  // 工具跑了但模型一个字没说 —— 健康轮总以最终文字回复收尾。只在跑过工具
  // 时查：完全空的轮（连内容都没有）通常意味着 SDK 即将抛出 / 已经浮出
  // error 卡；交互工具（计划模式 / AskUserQuestion）驱动的轮合法地无叙述。
  if (!facts.textEmitted && facts.toolUseCount > 0 && !facts.interactionToolSeen) {
    return { kind: "empty-response", pendingToolCalls: [] };
  }

  // 第三种：末条是纯文本且像没写完。守卫 —— 轮必须跑过工具（这是"干到一半"
  // 的网关症状；纯聊天轮结尾一个冒号可能是合法的向用户提问），且末条必须
  // 是纯文本（末尾还挂着一个工具派发[e.g. Task]时，前面叙述的标点不可推断）。
  if (facts.toolUseCount > 0 && facts.textEmitted && !facts.lastAssistantHadToolUse) {
    const text = facts.lastAssistantText.trimEnd();
    if (text.length > 0) {
      if (UNFINISHED_TRAILING_RE.test(text)) {
        return { kind: "unfinished-text", pendingToolCalls: [] };
      }
      // 奇数个 ``` = 代码围栏开了没关。
      if ((text.match(/```/g) ?? []).length % 2 === 1) {
        return { kind: "unfinished-text", pendingToolCalls: [] };
      }
    }
  }

  return null;
}
