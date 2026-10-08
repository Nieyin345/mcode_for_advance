/**
 * 右栏**自定义页签**的显示区(挂载位 `rightPanel.tab`)。两种:
 *
 *   - `view`:一段 Markdown,`{{project.name}}` / `{{today}}` 这类变量按当前工作区填好。
 *   - `file`:项目里的一个文件(相对路径按当前项目根算;路径也能带变量,
 *     比如 `notes/{{today}}.md` —— 每天一篇的日志)。`.md` 按 Markdown 画,别的原样等宽显示。
 *     文件会被别处改(代理写、自动化写、用户在编辑器里写),所以这里**隔几秒读一次**、
 *     窗口回到前台时也读一次 —— 不去接文件监听,读一个文件很便宜。
 *
 *   - `panel`(R41):用户写的 HTML/JS 面板,沙箱 iframe 里常驻(见 `PanelFrame`);
 *     切项目 / 换天时面板收到 `context` 事件。
 *
 * 页签是常驻显示区:这里不跑动作。点页签只是显示,改显示什么去设置页。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  customUiLabel,
  localDateString,
  renderTemplate,
  resolveWorkspacePath,
  templateVarsOf,
  type CustomUiItem,
  type CustomUiTarget,
} from "@contracts/customUi";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAdjustmentsHorizontal, IconExternalLink, IconRefresh } from "@renderer/lib/icons.js";
import { openCustomUiSettings } from "@renderer/stores/customUiStore.js";
import { PanelFrame } from "./PanelFrame.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** 读进来的文本超过这么长就截断 —— 右栏不是看大文件的地方,整本书塞进 Markdown 会卡。 */
const MAX_CHARS = 200_000;
const POLL_MS = 4_000;

type WorkspaceTarget = Extract<CustomUiTarget, { kind: "workspace" }>;

export function CustomTabView({ item, target }: { item: CustomUiItem; target: WorkspaceTarget }) {
  const { t, locale } = useI18n();
  // **日期要自己会走。** 页签是常驻的:`notes/{{today}}.md` 这种路径开着过一夜之后,
  // 没有任何东西会让它重新渲染(轮询只是重读同一个绝对路径),于是它整个白天都盯着
  // 昨天那篇。这里每分钟对一次表,换天了才真的改状态(其余时候引用不变,不重渲染)。
  const today = useRollingDate(target.today);
  const vars = templateVarsOf(today === target.today ? target : { ...target, today });
  const title = customUiLabel(item.label, locale);

  if (item.action.type === "panel") {
    return <PanelTab item={item} title={title} target={today === target.today ? target : { ...target, today }} />;
  }

  if (item.action.type === "file") {
    const abs = resolveWorkspacePath(renderTemplate(item.action.path, vars), target.project?.path);
    return <FileTab title={title} abs={abs} projectPath={target.project?.path} />;
  }

  // view(以及设置页不会存出来、但旧数据里万一有的别的类型 —— 统一当视图兜底)
  const body = item.action.type === "view" ? renderTemplate(item.action.body, vars) : "";
  return (
    <div className="flex h-full flex-col" data-testid="custom-tab-view">
      <TabHeader title={title} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {body.trim() ? (
          <Markdown projectPath={target.project?.path ?? null}>{body}</Markdown>
        ) : (
          <Hint text={t("customUi.tab.emptyView")} />
        )}
      </div>
    </div>
  );
}

/** 导出仅供无头回归(custom-tab-race-smoke)直接驱动 —— 它是 `CustomTabView`
 *  的子组件,fake-react 只跑根组件,测不到里面的 effect。 */
export function FileTab({ title, abs, projectPath }: { title: string; abs: string | null; projectPath: string | undefined }) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  /** 读**失败**(不存在 / 在项目外 / 不是文本)与"文件确实是空的"是两回事,见下。 */
  const [unreadable, setUnreadable] = useState(false);
  /** 请求序号:只有最新一次 `load` 的响应能写 `content`。`abs` 变化(切到别的自定义
   *  页签 = 同一个组件实例换 prop)时,先发起的那次 `readFile` 若后回来,会把上一个
   *  文件的内容画到**新页签的标题**底下。 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (abs === null) return;
    const seq = ++loadSeqRef.current;
    try {
      const res = await api.file.readFile({ filePath: abs });
      if (seq !== loadSeqRef.current) return; // superseded (tab switched)
      setUnreadable(false);
      setContent(res.content);
    } catch {
      if (seq !== loadSeqRef.current) return;
      // 从前这里也 `setContent("")`,于是**路径写错**和**文件是空的**在界面上是同一句话,
      // 用户没有任何线索去查 —— 而路径写错才是这两者里更常见、也更需要说出来的那个。
      setUnreadable(true);
      setContent("");
    }
  }, [abs]);

  useEffect(() => {
    setContent(null);
    setUnreadable(false);
    if (abs === null) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [abs, load]);

  const isMarkdown = abs !== null && /\.(md|markdown)$/i.test(abs);
  const baseDir = abs === null ? undefined : abs.replace(/[\\/][^\\/]*$/, "");
  const truncated = content !== null && content.length > MAX_CHARS;
  const text = content === null ? "" : truncated ? content.slice(0, MAX_CHARS) : content;

  return (
    <div className="flex h-full flex-col" data-testid="custom-tab-view">
      <TabHeader
        title={title}
        subtitle={abs ?? undefined}
        actions={
          abs !== null && (
            <>
              <HeaderButton title={t("customUi.tab.refresh")} onClick={() => void load()}>
                <IconRefresh size={13} />
              </HeaderButton>
              <HeaderButton
                title={t("customUi.tab.openInEditor")}
                onClick={() => useSessionStore.getState().openFileInIde(abs)}
              >
                <IconExternalLink size={13} />
              </HeaderButton>
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {abs === null ? (
          <Hint text={t("customUi.tab.noProject")} />
        ) : content === null ? null : unreadable ? (
          <Hint text={t("customUi.tab.fileUnreadable", { path: abs })} />
        ) : content === "" ? (
          <Hint text={t("customUi.tab.fileEmpty")} />
        ) : isMarkdown ? (
          <Markdown projectPath={projectPath ?? null} baseDir={baseDir}>
            {text}
          </Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-content">{text}</pre>
        )}
        {truncated && <Hint text={t("customUi.tab.truncated")} />}
      </div>
    </div>
  );
}

function PanelTab({ item, title, target }: { item: CustomUiItem; title: string; target: WorkspaceTarget }) {
  const { t } = useI18n();
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="flex h-full flex-col" data-testid="custom-tab-view">
      <TabHeader
        title={title}
        actions={
          <HeaderButton title={t("customUi.panel.reload")} onClick={() => setReloadKey((k) => k + 1)}>
            <IconRefresh size={13} />
          </HeaderButton>
        }
      />
      <div className="min-h-0 flex-1">
        <PanelFrame item={item} target={target} reloadKey={reloadKey} />
      </div>
    </div>
  );
}

/** 每分钟对一次表的本地日期(`YYYY-MM-DD`)。换天了才换引用。 */
function useRollingDate(initial: string): string {
  const [today, setToday] = useState(initial);
  useEffect(() => {
    const tick = (): void => {
      const now = localDateString(new Date());
      setToday((prev) => (prev === now ? prev : now));
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

function TabHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3">
      <span className="shrink-0 text-xs font-medium text-content">{title}</span>
      {subtitle && (
        <span className="min-w-0 truncate text-[11px] text-content-subtle" title={subtitle}>
          {subtitle}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {actions}
        <HeaderButton title={t("customUi.tab.customize")} onClick={() => openCustomUiSettings("rightPanel.tab")}>
          <IconAdjustmentsHorizontal size={13} />
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-6 w-6 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
    >
      {children}
    </button>
  );
}

function Hint({ text }: { text: string }) {
  return <p className="py-6 text-center text-xs text-content-subtle">{text}</p>;
}
