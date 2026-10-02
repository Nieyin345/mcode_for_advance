/**
 * 代理之间的信 —— 渲染层这一侧要认出来的两样东西(纯函数,没有状态)。
 *
 *  - **发出去的**:模型调 `agent_notify` / `agent_ask`。三家引擎都把 MCP 工具名
 *    拼成 `mcp__<server>__<tool>`(Codex 见 CodexMessageAdapter),所以按后缀认。
 *  - **收进来的**:主进程 `RuntimeManager.announceAgentMail` 落库并回声的那条
 *    「用户」消息,id 用 `u_mail_` 开头,正文由 `main/lib/agentMail.ts` 的
 *    `mailNoticeText` 拼成 ——「📨 来自代理「X」的提问/回信/消息[排队说明]\n\n正文」。
 *
 * 两边都要在对话里**直接看得见正文**:发出去的不折进「操作集合」、回合结束后也不
 * 收进折叠的过程面板;收进来的不画成用户自己的气泡。
 */

export type AgentMailToolKind = "notify" | "ask";

const TOOL_RE = /^mcp__.+__agent_(notify|ask)$/;

/** `mcp__mcode-workflow__agent_notify` → "notify";不是信件工具 → null。 */
export function agentMailToolKind(toolName: string): AgentMailToolKind | null {
  const m = TOOL_RE.exec(toolName);
  return m ? (m[1] as AgentMailToolKind) : null;
}

export function isAgentMailTool(toolName: string): boolean {
  return TOOL_RE.test(toolName);
}

/** 发出那一封的参数(模型给的,形状不保证)。 */
export interface OutgoingMail {
  kind: AgentMailToolKind;
  to: string;
  text: string;
  re?: string;
}

export function readOutgoingMail(toolName: string, input: unknown): OutgoingMail | null {
  const kind = agentMailToolKind(toolName);
  if (!kind) return null;
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const to = typeof obj.to === "string" ? obj.to : "";
  const text = typeof obj.text === "string" ? obj.text : "";
  const re = typeof obj.re === "string" && obj.re.trim() ? obj.re.trim() : undefined;
  return { kind, to, text, re };
}

export const AGENT_MAIL_MESSAGE_PREFIX = "u_mail_";

export function isAgentMailMessageId(id: string): boolean {
  return id.startsWith(AGENT_MAIL_MESSAGE_PREFIX);
}

/** 收进来那一封,拆回结构。拆不开(格式将来变了)就把整段当正文。 */
export interface IncomingMail {
  from: string;
  what: "ask" | "reply" | "notify" | null;
  queued: boolean;
  text: string;
}

const NOTICE_RE = /^📨 来自代理「([\s\S]*?)」的(提问|回信|消息)(\([^\n]*\))?\n\n([\s\S]*)$/;

export function parseIncomingMail(raw: string): IncomingMail {
  const m = NOTICE_RE.exec(raw);
  if (!m) return { from: "", what: null, queued: false, text: raw };
  const what = m[2] === "提问" ? "ask" : m[2] === "回信" ? "reply" : "notify";
  return { from: m[1], what, queued: m[3] !== undefined, text: m[4] };
}
