/**
 * 只读转录(`TranscriptBlock`)→ 渲染端的 `Block`,好让 `MessageBlocks` 直接吃。
 *
 * ## 为什么要显式映射,而不是 `as`
 *
 * 两个类型是**逐字段对齐**的(contracts 那边刻意这么设计),所以一个 `as` 能过。但那样
 * 一来"对齐"就成了一句没人核对的承诺:哪天 `Block` 给 `tool_use` 加一个必填字段,`as`
 * 照旧编译通过,而运行时的表现是渲染出空白块。写成映射之后,漂移会在**这里**报出来。
 *
 * ## 谁会用到
 *
 * 三处读同一份形状:**子代理**(Claude 的 Task / Codex 的 thread,侧栏那个查看器)和
 * **工作流节点**(对话里那张步骤卡片的「过程」)。之前只有前者,映射函数是 `SideChatPanel`
 * 的私有函数;节点那个也要用,就搬到这里 —— 同一份契约有第二个消费者是它该被共享的信号。
 */
import type { TranscriptBlock } from "@contracts/runtime";
import type { Block } from "@renderer/stores/sessionStore.js";

export function mapTranscriptBlock(b: TranscriptBlock): Block {
  if (b.kind === "text") return { kind: "text", text: b.text };
  if (b.kind === "thinking") return { kind: "thinking", text: b.text };
  return {
    kind: "tool_use",
    toolCallId: b.toolCallId,
    toolName: b.toolName,
    input: b.input,
    status: b.status,
    ...(b.result !== undefined ? { result: b.result } : {}),
  };
}
