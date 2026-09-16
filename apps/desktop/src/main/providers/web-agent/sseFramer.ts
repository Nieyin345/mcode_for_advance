/**
 * SSE 分帧器 —— 网页版引擎的**纯函数底座**。
 *
 * 旁听抓到的只是原始文本，而 SSE 的块边界（空行）与网络分片边界毫无关系：
 * 一次 read 可能只拿到半帧、也可能一次拿到三帧半。这里负责把不规则的 chunk
 * 流拼回一帧一帧的 `data:` 载荷。
 *
 * ## 为什么只做"分帧"不碰语义
 * 帧协议（`data:` 行 + 空行分隔）是 SSE 标准，**全网通用**；而载荷里装的是
 * 各站点自研的 JSON（DeepSeek 是 `{p,v}`，多数站点是 OpenAI 的 `choices`
 * 结构）。把语义留给 `parsers/`，意味着新增站点时这一层永远不用动，也意味着
 * 这一层能靠穷举边界条件在无头 smoke 里测干净 —— 而它恰恰是这类代码最容易
 * 出错的地方（跨 chunk 截断、CRLF 切半、多行 data、心跳注释）。
 *
 * 状态是纯数据（只有一段残留 buffer），所以抓流可以随时中断恢复，也能在
 * 测试里逐字符喂进去。
 */

/** 分帧器的全部状态：一段尚未凑成完整帧的残留文本。 */
export interface SseFrameState {
  buffer: string;
}

/** 空状态（可安全共享 —— 下面所有函数都不修改入参）。 */
export const EMPTY_FRAME_STATE: SseFrameState = { buffer: "" };

/** 一次 `frameSse` 调用的产出。 */
export interface SseFrameBatch {
  /** 本批提取出的 data 载荷（已去掉 `data:` 前缀、已按 SSE 规范合并多行）。 */
  payloads: string[];
  /** 本批是否出现 `data: [DONE]` —— SSE 层的通用结束标记。 */
  done: boolean;
  /** 要传给下一次调用的新状态。 */
  state: SseFrameState;
}

/**
 * 找最早的帧结束位置。SSE 规范允许 CRLF / LF / CR 三种行结束符，所以帧
 * 分隔可能是 `\r\n\r\n`、`\n\n` 或 `\r\r`。
 *
 * 取**最早**的一个（不是先试某个分隔符），否则 `a\r\n\r\n` 里的 `\n\n` 会被
 * 漏掉。同位置时取更长的那个，避免 `\r\n\r\n` 被 `\r\r` 抢先切出一个多余的 `\n`。
 */
function findFrameEnd(s: string): { at: number; len: number } | null {
  let best: { at: number; len: number } | null = null;
  for (const sep of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const at = s.indexOf(sep);
    if (at < 0) continue;
    if (best === null || at < best.at || (at === best.at && sep.length > best.len)) {
      best = { at, len: sep.length };
    }
  }
  return best;
}

/**
 * 解析一个完整帧，取出它的 data 载荷。
 *
 * 按 SSE 规范：`:` 开头的行是注释（很多服务端拿它当心跳，必须忽略，否则会被
 * 当成坏帧）；`data:` 后可选一个空格；**多个 data 行要用 `\n` 连接成一个载荷**
 * （服务端可以把一条 JSON 拆成多个 data 行，这是合法的）。
 */
function dataOfFrame(block: string): string | null {
  const lines: string[] = [];
  for (const rawLine of block.split(/\r\n|\n|\r/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    if (field !== "data") continue;
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    lines.push(value);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * 喂一段新文本，取回本批凑齐的载荷。
 *
 * 不修改 `state` —— 返回新的。`payloads` 里**不含** `[DONE]`（它在 `done`
 * 标记里），因为那不是一个载荷，而是协议层的结束信号。
 */
export function frameSse(state: SseFrameState, chunk: string): SseFrameBatch {
  let buffer = state.buffer + chunk;
  const payloads: string[] = [];
  let done = false;

  for (;;) {
    const end = findFrameEnd(buffer);
    if (end === null) break;
    const block = buffer.slice(0, end.at);
    buffer = buffer.slice(end.at + end.len);
    const data = dataOfFrame(block);
    if (data === null) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    payloads.push(data);
  }

  return { payloads, done, state: { buffer } };
}