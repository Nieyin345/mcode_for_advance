/**
 * 把一个**工作流节点会话**的事件流折成一份可读的过程 —— 那段"这一步到底干了什么"。
 *
 * ## 为什么需要它
 *
 * 节点是隐藏会话,它的流水刻意不发往客户端(推过去会变成幻影消息和点不掉的未读,
 * 见 `RuntimeManager.emit`)。于是用户看到的只有卡片上那一句结论,过程全丢。用户要的
 * 是「能看见子代理在干嘛」(见 `WorkflowNodeTranscriptEvent`)。
 *
 * ## 为什么是纯函数、为什么在这里
 *
 * 子代理那份转录是**各家适配器自己折的**(`providers/<某家>/…MessageAdapter.ts`)——
 * 因为子代理的消息是混在父会话流里转发的,只有适配器看得见 `parent_tool_use_id`。
 * 节点不一样:它是一个**独立的会话**,宿主这边收到的就是普通会话事件,所以折的地方
 * 在宿主(`RuntimeManager`),而且**与引擎无关** —— Claude / Pi / Codex 的节点都走这一份。
 *
 * 写成纯函数是为了能喂进无头脚本(`scripts/node-transcript-smoke`):这里有十来个分支
 * (流式文本要合并、工具结果要配回它那次调用、乱序或缺调用时要安静丢掉),而每一条走
 * 错的表现都是"看着像对、细看不对",没有任何报错。
 *
 * ## 两条从渲染端抄来的规矩
 *
 * 1. **同种的连续片段要合并。** 文本和思考都是**逐字**发过来的(`text.delta` /
 *    `thinking`),不合并的话一段话会变成几千个块。判据就是"上一个块是不是同种" ——
 *    与 `sessionStore` 的 `appendDelta` 逐字相同。
 * 2. **工具结果配回它那次调用**,按 `toolCallId`。配不上就丢掉:没有工具名的块渲染不
 *    出来,而"凭空多一个块"比"少一个块"更让人困惑。
 */
import type { RuntimeEvent, TranscriptBlock } from "@contracts/runtime";

/** 折一次的结果。 */
export interface FoldResult {
  /** 折完的完整过程(替换语义,不是追加)。 */
  blocks: TranscriptBlock[];
  /**
   * 这一次**该不该往界面推**。
   *
   * 不推不等于没变:文本和思考是逐字来的,每来一个字都推一次的话,总字节数是
   * O(n²)(每条都带全量),而这个通道的用途是"看它干了什么",不是"看它正在打哪个字"。
   * 所以逐字的那两种只改不推,等到 `message.complete` / `turn.done` 这些**边界**上
   * 一次性推出去 —— 与 `SubagentTranscriptEvent` 的"消息粒度"是同一个取舍。
   */
  broadcast: boolean;
}

/** 一有变化就值得推的事件 —— 工具调用是用户最想实时看见的那部分。 */
const PUSH_NOW = new Set<string>(["tool.use", "tool.result"]);
/** 攒着的变化在这里一次性冲出去(段落边界 / 这一步结束)。 */
const FLUSH_AT = new Set<string>(["message.complete", "turn.done", "turn.incomplete"]);

/**
 * 折一个事件进去。**不是这个过程该管的事件返回 `null`**(调用方据此完全不动)。
 *
 * 入参 `prev` 不会被改 —— 变了就返回新数组,没变就原样返回同一个引用,调用方可以靠
 * 引用相等跳过工作(与 `sessionStore` 里那些 reducer 同一个约定)。
 */
export function foldTranscript(
  prev: readonly TranscriptBlock[],
  e: RuntimeEvent,
): FoldResult | null {
  switch (e.type) {
    case "text.delta":
      return { blocks: appendChunk(prev, "text", e.text), broadcast: false };

    case "thinking":
      return { blocks: appendChunk(prev, "thinking", e.text), broadcast: false };

    case "tool.use": {
      // 同一个 toolCallId 重复出现(重放 / 重试)时不叠一个 —— 认第一次的那个。
      if (prev.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId)) {
        return { blocks: prev as TranscriptBlock[], broadcast: false };
      }
      const block: TranscriptBlock = {
        kind: "tool_use",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        input: e.input,
        status: "running",
      };
      return { blocks: [...prev, block], broadcast: PUSH_NOW.has(e.type) };
    }

    case "tool.result": {
      const at = prev.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
      // 配不上就丢掉,见文件头第 2 条。
      if (at < 0) return null;
      const target = prev[at];
      if (target.kind !== "tool_use") return null;
      // 已经到了结果还再来一条(重放)也丢掉 —— 替换语义下重复推没有意义。
      if (target.status !== "running") return null;
      const blocks = [...prev];
      blocks[at] = {
        ...target,
        status: e.isError ? "error" : "done",
        result: e.content,
      };
      return { blocks, broadcast: PUSH_NOW.has(e.type) };
    }

    case "error":
      // 隐藏节点的普通流水不会发给客户端(会制造幻影消息)。配置失效
      // 没有 provider turn.done,必须马上通过父对话的过程卡片显示原因。
      if (e.code !== "custom_model_unavailable") return null;
      return {
        blocks: [...prev, { kind: "text", text: `模型配置失败：${e.message}` }],
        broadcast: true,
      };

    default:
      // 边界事件:块没变,但**攒着的文本该冲出去了**。
      if (FLUSH_AT.has(e.type)) return { blocks: prev as TranscriptBlock[], broadcast: true };
      return null;

    case "turn.notice":
      // 宿主侧的提示卡(预算到顶/回退/结构化校验失败),纯 UI 事件 —— 工作流节点的
      // 过程块不收它。放在 default 后面是为了让"它是被显式忽略的"一眼可见。
      return null;
  }
}

/**
 * 把折好的过程渲染成一段**给主对话那个助手读的散文**。
 *
 * ## 只取两样
 *
 * **它说过的话**和**它调了哪些工具**(工具名 + 一句参数摘要)。工具的结果**不取** ——
 * 那多半是整篇文件或一整页检索结果,是这一段里最贵的部分,而"它读了什么"从工具名和
 * 参数已经看得出大半。思考块也不取:那是它的草稿,不是结论。
 *
 * ## 为什么必须有上限
 *
 * 这段文字要**并进主对话**(见 `NODE_RETURN_PARAM_KEY` 的 `full` 档),而并进去的东西
 * **每一轮都要重发一遍**。不设上限,等于让某一次节点运行永久抬高之后每一次对话的成本。
 * 超了明说截断 —— 悄悄截掉会让主对话的助手以为"它就做了这些"。
 */
export function transcriptText(blocks: readonly TranscriptBlock[], limit = 3000): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "thinking") continue;
    if (b.kind === "text") {
      const text = b.text.trim();
      if (text.length > 0) parts.push(text);
      continue;
    }
    const args = oneLine(JSON.stringify(b.input ?? ""));
    parts.push(`- 用了 \`${b.toolName}\`${args.length > 0 ? `:${args}` : ""}`);
  }
  const text = parts.join("\n\n");
  return text.length > limit ? `${text.slice(0, limit)}\n\n(过程太长,后面截掉了)` : text;
}

/** 压成一行并截断 —— 工具参数里常有整个文件路径或一大段正文。 */
function oneLine(raw: string, limit = 120): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 追加一段流式文本。上一个是同种块就并进去,否则另起一块。
 *
 * 并进去时返回的是**新对象**(而不是原地改):渲染端拿引用做相等判断,原地改会让它
 * 以为"没变"从而不重渲染。
 */
function appendChunk(
  prev: readonly TranscriptBlock[],
  kind: "text" | "thinking",
  text: string,
): TranscriptBlock[] {
  if (text.length === 0) return prev as TranscriptBlock[];
  const last = prev[prev.length - 1];
  if (last && last.kind === kind) {
    const blocks = [...prev];
    blocks[blocks.length - 1] = { kind, text: last.text + text };
    return blocks;
  }
  return [...prev, { kind, text }];
}
