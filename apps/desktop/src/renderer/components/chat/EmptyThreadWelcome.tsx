/**
 * 空会话的首屏 —— **一个起点，不是一句欢迎语**（优化方向第 11 条）。
 *
 * 输入框仍是视觉焦点（它在这一块下面，贴底）。标题上方从前只有一句「在 xxx 中开始新的
 * 会话」加今日用量，用户每开一个新会话都要自己去左栏 / 设置 / 文献库里找"我刚才在干什么"。
 * 现在标题下面放四块，每块最多三条，**点一下就接上**：
 *
 * | 块 | 数据 | 点一下 |
 * |---|---|---|
 * | 接着聊 | store 里当前项目的会话（不走 RPC） | 切到那个对话 |
 * | 用工作流开始 | `workflow.list`，去掉「默认」和带触发器的 | 输入框改用这个工作流（与输入框上的下拉是同一个 `setWorkflowId`） |
 * | 最近加入的资料 | `library.list`（主进程按 added_at 倒序） | 右栏预览（`previewLibraryItem`，与文献库单击同语义） |
 * | 正在守着的自动化 | `automation.statusAll` 里 `armed` 的 | 打开设置里的工作流页 |
 *
 * ## 几条刻意的取舍
 *
 *  - **空的块不画**：新装机什么都没有时，画面和从前一样干净 —— 不摆四个"暂无"。
 *  - **失败不弹 toast**（`toastOnError: false`）：这是可有可无的陈设，一个读不到的块
 *    安静地不出现就好，不该在用户刚打开新会话时弹错。
 *  - **手机端只有「接着聊」**：另外三个 RPC 不在手机白名单里（`main/mobile/mobileRpc.ts`），
 *    调了会同步抛（见 `lib/webApi.ts` 文件头），所以 `enabled: isElectron` 直接不调。
 *    今日用量同理（从前就是这样）。
 *  - **矮窗口不画卡片**（高度 ≤ 640）：这一栏内容贴底、上面 `overflow-hidden`，四块摞高了
 *    会把标题顶出屏幕。卡片区自己也限高并可滚（窄栏一列时四块摞起来最高）。
 *  - **自动化上次失败要说出来**（`latestFailureOf`）：一条静悄悄坏掉的自动化，首屏是用户
 *    最可能顺眼看到的地方。
 *
 * `data-home-section` / `data-home-row` 是给 `.tmp/home-preview` 量的，不要删。
 *
 * 进场有一次轻微上浮（`home-fade-up`，styles.css），减少动态效果时关闭。
 */
import { useMemo, type ComponentType, type ReactNode } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { fmtTokens } from "@renderer/lib/contextWindow.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import { previewLibraryItem } from "@renderer/lib/libraryPreview.js";
import { workflowDisplayDescription, workflowDisplayName, workflowIcon } from "@renderer/lib/workflowLabels.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { latestFailureOf } from "@contracts/ipc";
import {
  IconArrowsSplit,
  IconBook,
  IconCheck,
  IconClock,
  IconFileText,
  IconFileTypePdf,
  IconMessages,
  type TablerIconProps,
} from "@renderer/lib/icons.js";

/** 每块最多几条。三条是"扫一眼就够"的量；再多就该去左栏 / 设置里看全的。 */
const PER_SECTION = 3;
/** 读 RPC 的共同选项：只在桌面端读；读不到就安静地不画这一块。 */
const DESKTOP_QUIET = { enabled: isElectron, toastOnError: false } as const;

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to the plain
   *  "start a new chat" wording. */
  projectName: string;
}

export function EmptyThreadWelcome({ projectName }: EmptyThreadWelcomeProps) {
  const { t } = useI18n();
  // 今日跨会话用量（`usage.stats` preset=today）。没有轮次或读不到时不显示。
  const { data: usage } = useRpc(() => api.usage.stats({ preset: "today" }), [], DESKTOP_QUIET);
  const today = usage?.summary;

  return (
    <div className="mb-4 flex animate-[home-fade-up_160ms_ease-out] flex-col items-center gap-1.5">
      <h2 className="text-2xl font-semibold tracking-tight text-content">
        {projectName
          ? t("chatStream.welcome.withProject", { name: projectName })
          : t("chatStream.welcome.title")}
      </h2>
      {today && today.turns > 0 && (
        <p className="text-xs text-content-subtle">
          {t("chatStream.welcome.todayUsage", {
            turns: today.turns,
            tokens: fmtTokens(today.totalTokens),
          })}
        </p>
      )}
      <StartPoints />
    </div>
  );
}

/* ────────────────────────── 四块起点 ────────────────────────── */

function StartPoints() {
  const { t, locale } = useI18n();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const workflowId = useSessionStore((s) => s.workflowId);
  const setWorkflowId = useSessionStore((s) => s.setWorkflowId);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const { data: wfRes } = useRpc(() => api.workflow.list(), [], DESKTOP_QUIET);
  const { data: libRes } = useRpc(() => api.library.list({ limit: PER_SECTION }), [], DESKTOP_QUIET);
  const { data: facts } = useRpc(() => api.automation.statusAll(), [], DESKTOP_QUIET);

  // 当前这个空会话本身不算"接着聊"；节点 / 自动化 / 侧问那些隐藏会话也不算。
  const recent = useMemo(
    () =>
      sessions
        .filter((s) => s.kind === "chat" && !s.archived && s.id !== activeSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, PER_SECTION),
    [sessions, activeSessionId],
  );
  // 「默认」就是不选工作流；带触发器的是自动化（它们不由输入框发起，输入框的下拉也滤掉了）。
  // 用户自己建的 / 改过的排前面，其次按最近修改。
  const workflows = useMemo(
    () =>
      (wfRes?.workflows ?? [])
        .filter((w) => w.id !== "default" && !w.trigger)
        .sort((a, b) => Number(a.builtin && !a.edited) - Number(b.builtin && !b.edited) || b.updatedAt - a.updatedAt)
        .slice(0, PER_SECTION),
    [wfRes],
  );
  const items = libRes?.items.slice(0, PER_SECTION) ?? [];
  const automations = useMemo(() => (facts ?? []).filter((f) => f.armed).slice(0, PER_SECTION), [facts]);

  if (recent.length + workflows.length + items.length + automations.length === 0) return null;

  return (
    <div
      className={cn(
        "mt-5 grid max-h-[min(440px,50vh)] w-full gap-3 overflow-y-auto text-left",
        // 两列装得下就两列（max-w-4xl 下正好两列），窄栏自动一列。
        "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]",
        "[@media(max-height:640px)]:hidden",
      )}
    >
      {recent.length > 0 && (
        <Section id="recent" icon={IconMessages} title={t("chatStream.welcome.recentTitle")}>
          {recent.map((s) => (
            <Row
              key={s.id}
              id={s.id}
              label={s.title || t("chatStream.quote.untitled")}
              meta={formatRelativeTime(s.updatedAt)}
              onClick={() => void selectSession(s.id)}
            />
          ))}
        </Section>
      )}
      {workflows.length > 0 && (
        <Section id="workflows" icon={IconArrowsSplit} title={t("chatStream.welcome.workflowsTitle")}>
          {workflows.map((w) => {
            const picked = w.id === workflowId;
            return (
              <Row
                key={w.id}
                id={w.id}
                lead={<span className="opacity-80">{workflowIcon(w.id, 14)}</span>}
                label={workflowDisplayName(w, locale)}
                meta={
                  picked ? (
                    <span className="flex items-center gap-1 text-accent">
                      <IconCheck size={12} />
                      {t("chatStream.welcome.workflowPicked")}
                    </span>
                  ) : (
                    workflowDisplayDescription(w, locale)
                  )
                }
                pressed={picked}
                onClick={() => setWorkflowId(picked ? "default" : w.id)}
              />
            );
          })}
        </Section>
      )}
      {items.length > 0 && (
        <Section id="library" icon={IconBook} title={t("chatStream.welcome.libraryTitle")}>
          {items.map((it) => (
            <Row
              key={it.id}
              id={it.id}
              lead={
                it.pdfPath ? (
                  <IconFileTypePdf size={14} className="text-content-subtle" />
                ) : (
                  <IconFileText size={14} className="text-content-subtle" />
                )
              }
              label={it.title}
              meta={
                [it.authors[0]?.family, it.year].filter(Boolean).join(" · ") || formatRelativeTime(it.addedAt)
              }
              onClick={() => previewLibraryItem(it)}
            />
          ))}
        </Section>
      )}
      {automations.length > 0 && (
        <Section id="automations" icon={IconClock} title={t("chatStream.welcome.automationsTitle")}>
          {automations.map((f) => {
            const failure = latestFailureOf(f);
            return (
              <Row
                key={f.key}
                id={f.key}
                lead={
                  <span
                    aria-hidden
                    className={cn("h-1.5 w-1.5 rounded-full", failure ? "bg-danger" : "bg-success")}
                  />
                }
                label={f.title}
                meta={
                  failure ? (
                    <span className="text-danger" title={failure}>
                      {t("chatStream.welcome.automationFailed")}
                    </span>
                  ) : f.lastFireAt !== undefined ? (
                    t("chatStream.welcome.automationLastFire", { when: formatRelativeTime(f.lastFireAt) })
                  ) : (
                    (f.detail ?? t("chatStream.welcome.automationNeverFired"))
                  )
                }
                onClick={() => setSettingsOpen(true, "workflows")}
              />
            );
          })}
        </Section>
      )}
    </div>
  );
}

function Section({
  id,
  icon: Icon,
  title,
  children,
}: {
  id: string;
  icon: ComponentType<TablerIconProps>;
  title: string;
  children: ReactNode;
}) {
  return (
    <section data-home-section={id} className="min-w-0 rounded-xl border border-edge bg-surface/60 p-1.5">
      <h3 className="flex items-center gap-1.5 px-2 pb-1 pt-0.5 text-[0.7857em] font-medium text-content-subtle">
        <Icon size={13} className="shrink-0" />
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({
  id,
  lead,
  label,
  meta,
  pressed,
  onClick,
}: {
  id: string;
  lead?: ReactNode;
  label: string;
  meta?: ReactNode;
  /** 只给"可选中"的行（工作流）；其余行是纯跳转，不带这个属性。 */
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-home-row={id}
      aria-pressed={pressed}
      onClick={onClick}
      title={label}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        pressed ? "bg-accent/10" : "hover:bg-surface-hover/70",
      )}
    >
      {lead && <span className="flex w-4 shrink-0 items-center justify-center">{lead}</span>}
      <span className="min-w-0 flex-1 truncate text-[0.8571em] text-content">{label}</span>
      {meta && (
        <span className="max-w-[45%] shrink-0 truncate text-[0.7143em] text-content-subtle">{meta}</span>
      )}
    </button>
  );
}
