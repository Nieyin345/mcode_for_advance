/**
 * 「引用到上下文」的**目标选择列表** —— 从选中文字那座浮动条里长出来的第二层。
 *
 * ## 它解决的是哪件事
 *
 * 选中一段正文,想让它进**某一条**对话的上下文。目标不止"当前会话"这一个:一场
 * 对话底下还挂着一串**节点会话**(工作流的每一步各跑在自己的会话里,`kind: "node"`,
 * `parentSessionId` 指向这场对话)。用户嘴里的"引用给谁"就是这一串。
 *
 * ## 数据从哪来
 *
 * `api.session.listNodes({ sessionId })` —— 这是**唯一**会返回节点会话的查询
 * (别的列表一律写死 `kind = 'chat'`,见主进程 `listNodesByParent` 的头注)。
 * 节点会话之间不会互相嵌套:建它的地方只有 `runner.ts` 一处,`parentSessionId`
 * 永远指向那场对话 —— 所以**一趟平铺就够了**,不用递归,「含子节点」这句在这个
 * 数据形状下就是那个平铺列表。
 *
 * ⚠️ 这条 RPC 是共用组件里的调用,手机端的 web shim 上必须有对应项(`webApi.ts`
 * 里早有 `listNodes`,所以这里**不新增** RPC —— 新增一条而漏补 shim 会同步抛错、
 * React 19 整棵卸载)。取数仍然包在 try/catch 里,拿不到就退化成"只有当前会话"。
 *
 * ## 落点:草稿,不是发送
 *
 * 选完之后的落点在**调用方**(`ChatPane`),不在这里 —— 这里只管"选了谁"。调用方
 * 写的是目标会话的**输入框草稿**(`composerDraftBySession`),不替用户发,与看板
 * 那个「跟主对话说」逐字同一个做法(见 `WorkflowBoardPanel.talkToParent`)。
 *
 * ## 浮层的写法照抄 `SelectionToolbar`
 *
 * portal 挂到 body + `position: fixed` —— 消息流是 LegendList,它的每一项带
 * `contain: paint`,在流里就地绝对定位会被裁掉。这里**不在 mousedown 上
 * preventDefault**(那座工具条要,是因为它的关闭条件之一是"选区塌了";这一层开着
 * 的时候选区长什么样已经不重要了,捕获的 `text` 是快照),所以搜索框点得进去。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@contracts/session";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconGitFork,
  IconLoader2,
  IconMessages,
  IconSearch,
} from "@renderer/lib/icons.js";
import type { SelectionToolbarState } from "./SelectionToolbar.js";

/** 一条可选的落点。`kind` 决定行首那个图标和那枚小标签怎么画。 */
export interface QuoteTarget {
  id: string;
  title: string;
  /** `"chat"` = 这场对话自己;`"node"` = 它名下的一个节点会话。 */
  kind: "chat" | "node";
}

/** 面板宽度 —— 与工具条不同,这里要放标题,给个定宽好让截断有个依据。 */
const PANEL_WIDTH = 320;
/** 列表最长多高(像素)。超了内部滚,不把浮层拉成一整屏。 */
const PANEL_MAX_H = 300;

export function SelectionQuoteMenu({
  state,
  sessionId,
  currentTitle,
  onPick,
  onClose,
}: {
  /** 打开这一层时那份**选中快照**(坐标 + 文字)。 */
  state: SelectionToolbarState;
  /** 当前这场对话的 id —— 列表第一行就是它。 */
  sessionId: string;
  /** 当前这场对话的显示名。 */
  currentTitle: string;
  onPick: (target: QuoteTarget, text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** `null` = 还在取;拿不到是空数组(`failed` 为真时列表头会说一句)。 */
  const [nodes, setNodes] = useState<Session[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  // 取节点会话。async IIFE + try/catch:手机端的 web shim 对没映射的命名空间是
  // **同步抛错**的,直接挂 .then 会把异常甩出 effect,React 19 会因此整棵卸载。
  useEffect(() => {
    // ⚠️ **`sessionId` 可以是空串**（2026-09-21）—— 文件预览那一侧没有"当前会话"
    // 这个概念（见 `FileViewer` 的调用）。空串去发那条 RPC 只会白跑一趟，
    // 而且拿不到任何东西。直接给空列表。
    if (!sessionId) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.session.listNodes({ sessionId });
        if (!cancelled) setNodes(res.sessions);
      } catch {
        if (!cancelled) {
          setNodes([]);
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    // 与工具条同一条:消息流滚在 LegendList 里,scroll 不冒到 document。
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  /**
   * 右栏**此刻展开的那条**（2026-09-21）。
   *
   * ★ 用户的要求：「主页面展示的文件可以鼠标选择，然后**引用到当前展开对话的上下文**
   * 里面」。而在这之前，这个列表只列"当前对话 + 它的节点会话" —— **右栏正展开的那一条
   * 不在里面**（它可能是子对话、也可能就是主对话），用户选了段文字想递给它，找不到。
   *
   * 它排**最前面**：那是用户此刻正在看的那条，"引用给谁"的第一顺位就是它。
   */
  const openChatId = useSessionStore((s) => s.activeSideChatId);
  /**
   * 右栏那条的标题。**三种都得认** —— 它可能指
   *
   *   1. **主对话**（`MainSessionRow` 展开时）→ 在 `streamSessions` 里；
   *   2. **子对话** → 在 `sideChatsByParent` 里；
   *   3. **图上某一格的节点会话**（点流程图节点时）→ 在 `kind: "node"` 那张表里，
   *      **上面两个列表都没有它**。
   *
   * ⚠️ 从前这里只查了 (1)(2)。漏掉 (3) 之后的症状不是报错，是**那句 toast 里的名字
   * 是空的**（"已放进「」的输入框"）—— 用户截图报的就是这个。
   */
  const openChatTitle = useSessionStore((s) => {
    const id = s.activeSideChatId;
    if (!id) return null;
    const fromStream = s.streamSessions.find((x) => x.id === id)?.title;
    if (fromStream) return fromStream;
    const fromSide = s.sideChatsByParent[s.activeSessionId ?? ""]?.find((x) => x.id === id)?.title;
    if (fromSide) return fromSide;
    // 节点会话那一档在上面那个 effect 里查过了（`nodes`），这里不重复查 —— 见
    // 下面 `targets` 里对它的兜底。
    return null;
  });

  /** 当前会话永远排第一 —— 它不靠 RPC 来,所以取不到节点也照样能用。 */
  const targets = useMemo<QuoteTarget[]>(
    () => [
      // **右栏正展开的那条排最前**（跳过与"当前对话"重复的那一种）。
      ...(openChatId && openChatId !== sessionId
        ? [
            {
              id: openChatId,
              // 标题三级退：上面查到的 → 节点会话那份（`nodes`，节点会话没进 store，
              // 只有这个 effect 拿得到）→ 空串（界面会显示成一条没有名字的行，
              // 但至少**能选**）。
              title:
                openChatTitle ??
                nodes?.find((x) => x.id === openChatId)?.title ??
                "",
              kind: "chat" as const,
            },
          ]
        : []),
      // 空串 = 从文件预览进来的，没有"当前会话"这一条（见上面 effect 那段）。
      ...(sessionId ? [{ id: sessionId, title: currentTitle, kind: "chat" as const }] : []),
      ...(nodes ?? []).map(
        (s): QuoteTarget => ({ id: s.id, title: s.title, kind: "node" }),
      ),
    ],
    [sessionId, currentTitle, nodes, openChatId, openChatTitle],
  );

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? targets.filter((x) => x.title.toLowerCase().includes(q)) : targets),
    [targets, q],
  );

  // 过滤之后下标可能越界(用户改了搜索词),夹回来而不是让回车落空。
  const active = shown.length === 0 ? -1 : Math.min(index, shown.length - 1);

  const pick = (target: QuoteTarget) => onPick(target, state.text);

  const centerX = (state.rect.left + state.rect.right) / 2;
  const left = Math.min(
    Math.max(centerX - PANEL_WIDTH / 2, 8),
    Math.max(window.innerWidth - PANEL_WIDTH - 8, 8),
  );
  const belowTop = state.rect.bottom + 8;
  // 下方放不下就翻到上方 —— 与工具条的 `above` 同一个意思,只是这里量的是面板高度。
  const flipUp =
    belowTop + PANEL_MAX_H > window.innerHeight - 8 && state.rect.top > PANEL_MAX_H + 8;
  const style: React.CSSProperties = {
    position: "fixed",
    left,
    width: PANEL_WIDTH,
    ...(flipUp ? { bottom: window.innerHeight - state.rect.top + 8 } : { top: belowTop }),
  };

  return createPortal(
    <div
      ref={panelRef}
      style={style}
      // ⚠️ 行内元素上的宽高是零宽的:这个容器是 `position: fixed` 的块级盒子,
      // 量出来才是真尺寸(与 SelectionToolbar 同款)。
      className={cn(
        "z-50 flex flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl",
        "animate-[bookmark-bar-in_120ms_ease-out]",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-1.5 py-1.5">
        <span className="shrink-0 px-0.5 text-[10px] text-content-subtle">
          {t("chatStream.quote.title")}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5">
          <IconSearch size={11} className="shrink-0 text-content-subtle" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && active >= 0) {
                e.preventDefault();
                pick(shown[active]);
              }
            }}
            placeholder={t("chatStream.quote.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-content outline-none placeholder:text-content-subtle"
          />
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto py-1" style={{ maxHeight: PANEL_MAX_H }}>
        {nodes === null ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : shown.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] leading-relaxed text-content-subtle">
            {t("chatStream.quote.empty")}
          </div>
        ) : (
          shown.map((target, i) => (
            <button
              key={target.id}
              type="button"
              data-quote-target={target.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(target)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors",
                i === active ? "bg-surface-hover text-content" : "text-content-muted",
              )}
            >
              {target.kind === "chat" ? (
                <IconMessages size={13} className="shrink-0 text-accent" />
              ) : (
                <IconGitFork size={13} className="shrink-0 text-content-subtle" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {target.title || t("chatStream.quote.untitled")}
              </span>
              {target.kind === "chat" && (
                <span className="shrink-0 rounded bg-accent/10 px-1 py-px text-[10px] text-accent">
                  {t("chatStream.quote.current")}
                </span>
              )}
            </button>
          ))
        )}
        {/* 取不到节点时说一句。**不静默**:列表看起来"本来就只有一个目标",
            用户会以为这个会话没有节点,而不是"没读到"。 */}
        {failed && (
          <div className="px-2.5 py-1 text-[10px] text-content-subtle">
            {t("chatStream.quote.loadFailed")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
