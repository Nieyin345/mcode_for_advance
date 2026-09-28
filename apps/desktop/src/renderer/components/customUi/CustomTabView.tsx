/**
 * 右栏**自定义页签**的显示区(挂载位 `rightPanel.tab`)。两种:
 *
 *   - `view`:一段 Markdown,`{{project.name}}` / `{{today}}` 这类变量按当前工作区填好。
 *   - `file`:项目里的一个文件(相对路径按当前项目根算;路径也能带变量,
 *     比如 `notes/{{today}}.md` —— 每天一篇的日志)。`.md` 按 Markdown 画,别的原样等宽显示。
 *     文件会被别处改(代理写、自动化写、用户在编辑器里写),所以这里**隔几秒读一次**、
 *     窗口回到前台时也读一次 —— 不去接文件监听,读一个文件很便宜。
 *
 * 页签是常驻显示区:这里不跑动作。点页签只是显示,改显示什么去设置页。
 */
import { useCallback, useEffect, useState } from "react";
import {
  customUiLabel,
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
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** 读进来的文本超过这么长就截断 —— 右栏不是看大文件的地方,整本书塞进 Markdown 会卡。 */
const MAX_CHARS = 200_000;
const POLL_MS = 4_000;

type WorkspaceTarget = Extract<CustomUiTarget, { kind: "workspace" }>;

export function CustomTabView({ item, target }: { item: CustomUiItem; target: WorkspaceTarget }) {
  const { t, locale } = useI18n();
  const vars = templateVarsOf(target);
  const title = customUiLabel(item.label, locale);

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

function FileTab({ title, abs, projectPath }: { title: string; abs: string | null; projectPath: string | undefined }) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (abs === null) return;
    try {
      const res = await api.file.readFile({ filePath: abs });
      setContent(res.content);
    } catch {
      setContent("");
    }
  }, [abs]);

  useEffect(() => {
    setContent(null);
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
        ) : content === null ? null : content === "" ? (
          // 读失败(不存在 / 在项目外 / 不是文本)和空文件主进程都回空串,分不开 —— 一句话都说了
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
