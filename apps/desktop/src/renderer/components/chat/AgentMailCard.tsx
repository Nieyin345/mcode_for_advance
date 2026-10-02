/**
 * 代理之间的信,在对话里的样子。
 *
 *  - {@link AgentMailOutCard}:本会话调 `agent_notify` / `agent_ask` 发出去的那封
 *    (由 MessageBlocks 的 ToolCard 分流过来,替掉一张只显示工具名的通用卡)。
 *  - {@link AgentMailInCard}:别的代理发进来的那封(主进程回声的 `u_mail_` 消息,
 *    由 MessageRow 分流过来,不画成用户自己的气泡)。
 *
 * 两张卡同一个形状:一行抬头(谁 → 谁、提问/消息/回信)+ 正文全文。正文直接展开,
 * 不藏在折叠里 —— 用户要看的就是这段话。
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { Block } from "@renderer/stores/sessionStore.js";
import { readOutgoingMail, parseIncomingMail } from "@renderer/lib/agentMail.js";
import { Markdown } from "./Markdown.js";

/** 工具结果 → 一行可读文字(SDK 的 content 数组 / 字符串 / 其它)。 */
function resultLine(result: unknown): string {
  const pick = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return v
        .map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (v && typeof v === "object") {
      const o = v as { content?: unknown; text?: unknown };
      if (o.content !== undefined) return pick(o.content);
      if (typeof o.text === "string") return o.text;
    }
    return "";
  };
  return pick(result).trim();
}

function Shell({
  glyph,
  head,
  badge,
  tone = "normal",
  children,
  footer,
}: {
  glyph: string;
  head: string;
  badge?: string;
  tone?: "normal" | "error";
  children: React.ReactNode;
  footer?: string;
}) {
  return (
    <div
      className={cn(
        "my-1 rounded-lg border px-3 py-2 [font-size:var(--chat-fs-sm)]",
        tone === "error" ? "border-danger/50 bg-danger/5" : "border-edge bg-surface-muted/40",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-content-muted">
        <span aria-hidden>{glyph}</span>
        <span className="font-medium">{head}</span>
        {badge && (
          <span className="rounded bg-warning/15 px-1.5 py-px text-warning [font-size:var(--chat-fs-xxs)]">{badge}</span>
        )}
      </div>
      <div className="text-content [font-size:var(--chat-font-size)]">{children}</div>
      {footer && (
        <div
          className={cn(
            "mt-1.5 whitespace-pre-wrap break-words [font-size:var(--chat-fs-xs)]",
            tone === "error" ? "text-danger" : "text-content-subtle",
          )}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

export function AgentMailOutCard({
  block,
  projectPath,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  projectPath?: string | null;
}) {
  const { t } = useI18n();
  const mail = readOutgoingMail(block.toolName, block.input);
  if (!mail) return null;
  const name = mail.to || t("chatStream.agentMail.someone");
  const head =
    mail.kind === "ask"
      ? t("chatStream.agentMail.outAsk", { name })
      : mail.re
        ? t("chatStream.agentMail.outReply", { name })
        : t("chatStream.agentMail.outNotify", { name });
  const res = resultLine(block.result);
  // 结果只留第一行(「发给「X」:已插进它当前这一轮」之类);失败的整段给出来。
  const footer =
    block.status === "running"
      ? t("chatStream.agentMail.sending")
      : block.status === "error"
        ? res || t("chatStream.agentMail.failed")
        : res.split("\n")[0];
  return (
    <Shell glyph="📤" head={head} tone={block.status === "error" ? "error" : "normal"} footer={footer}>
      <Markdown projectPath={projectPath}>{mail.text}</Markdown>
    </Shell>
  );
}

export function AgentMailInCard({ raw, projectPath }: { raw: string; projectPath?: string | null }) {
  const { t } = useI18n();
  const mail = parseIncomingMail(raw);
  const name = mail.from || t("chatStream.agentMail.someone");
  const head =
    mail.what === "ask"
      ? t("chatStream.agentMail.inAsk", { name })
      : mail.what === "reply"
        ? t("chatStream.agentMail.inReply", { name })
        : t("chatStream.agentMail.inNotify", { name });
  return (
    <Shell glyph="📨" head={head} badge={mail.queued ? t("chatStream.agentMail.queued") : undefined}>
      <Markdown projectPath={projectPath}>{mail.text}</Markdown>
    </Shell>
  );
}
