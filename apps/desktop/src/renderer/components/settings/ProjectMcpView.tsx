/**
 * **项目 MCP** —— MCP 面板的「项目」tab(对标技能页的「项目」tab)。
 *
 * 服务器写在 `<项目>/.mcp.json`(Claude Code 标准格式):跟着项目目录走、能分享给同事。
 * 这一页做三件事:
 *  1. 列出这个项目的服务器(新增 / 编辑 / 删除);
 *  2. **信任**:只有信任过的条目才会被引擎启动 —— 克隆来的仓库自带的 .mcp.json 不会
 *     自动跑命令。配置一改要重新信任;在这里新增 / 编辑 / 复制的条目自动信任;
 *  3. 从总库勾选复制过来(值原样复制,含环境变量 —— 有密钥的话建议改成 `${VAR}`)。
 *
 * Claude 与 Codex 每轮读这份文件;Pi 不支持 MCP。项目条目不进引擎开关矩阵(同项目技能)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@contracts/session";
import type { McpProjectListResult, McpProjectServer, McpServerEntry } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { IconCopy, IconPencil, IconPlus, IconServer, IconShieldCheck, IconTrash } from "@renderer/lib/icons.js";
import { Checkbox } from "@renderer/components/ui/native-controls.js";
import { ProjectPicker } from "./ScopeTabs.js";

export function ProjectMcpView({
  project,
  projects,
  onSelectProject,
  userServers,
  refreshKey,
  onAdd,
  onEdit,
}: {
  project: Project | undefined;
  projects: Project[];
  onSelectProject: (id: string) => void;
  /** 总库(用户级)服务器 —— 复制的源。 */
  userServers: McpServerEntry[];
  /** Bumped by the panel after its add/edit dialog saves into this project. */
  refreshKey: number;
  onAdd: (projectPath: string) => void;
  onEdit: (projectPath: string, server: McpProjectServer) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<McpProjectListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [pendingRemove, setPendingRemove] = useState<{ projectPath: string; name: string } | null>(null);
  const projectPath = project?.path;
  /** 请求序号:切项目(或 refreshKey 变)时同一个实例重跑 `load`,先发起的那次
   *  `projectList` 若后回来,会把上一个项目的 MCP 服务器列表画到**新项目**这一页 ——
   *  用户以为看的是新项目的 .mcp.json。 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectPath) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const res = await api.mcp.projectList({ projectPath });
      if (seq !== loadSeqRef.current) return; // superseded (project switched)
      setData(res);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError((err as Error).message);
      setData(null);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    setData(null);
    setError(null);
    setChecked(new Set());
    void load();
  }, [load, refreshKey]);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? t("settings.operationFailed"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!projectPath) return;
    if (checked.size === 0) {
      useToastStore.getState().push({ kind: "info", title: t("settings.mcp.projectCopyNone") });
      return;
    }
    setBusy("copy");
    setError(null);
    try {
      const res = await api.mcp.projectCopy({ projectPath, names: [...checked] });
      const parts: string[] = [];
      if (res.copied.length) parts.push(t("settings.skills.copyDone", { n: res.copied.length }));
      if (res.skipped.length) parts.push(t("settings.skills.copySkipped", { n: res.skipped.length }));
      if (res.failed.length) parts.push(t("settings.skills.copyFailed", { n: res.failed.length }));
      useToastStore.getState().push({ kind: res.failed.length ? "warning" : "info", title: parts.join(";") });
      if (res.failed.length) setError(res.failed.map((f) => `${f.name}: ${f.reason}`).join("; "));
      if (res.copied.length) setChecked(new Set());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!project || !projectPath) {
    return (
      <EmptyState title={t("settings.mcp.projectNoProject")} className="h-full" />
    );
  }

  const servers = data?.servers ?? [];
  const existing = new Set(servers.map((s) => s.name));
  const copyable = userServers.filter((s) => s.scope === "user");

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Card className="flex flex-wrap items-center justify-between gap-3 bg-surface/40 px-3 py-2">
        <ProjectPicker project={project} projects={projects} onSelect={onSelectProject} disabled={busy !== null} />
        <Button variant="secondary" size="sm" className="gap-1" onClick={() => onAdd(projectPath)} disabled={busy !== null || !!data?.error}>
          <IconPlus size={12} />
          {t("settings.mcp.addServer")}
        </Button>
      </Card>

      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.mcp.projectHint", { file: ".mcp.json" })}
      </p>

      {(error || data?.error) && <ErrorNote>{error ?? data?.error}</ErrorNote>}

      <Card className="bg-surface/40">
        {loading && !data ? (
          <LoadingNote label={t("common.loading")} className="py-6" />
        ) : servers.length === 0 ? (
          <EmptyState title={t("settings.mcp.projectEmpty")} className="py-6" />
        ) : (
          servers.map((s) => {
            const key = `p:${s.name}`;
            return (
              <div key={s.name} className="flex items-center gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0">
                <IconServer size={14} className="shrink-0 text-content-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[0.8571em] font-medium text-content">{s.name}</span>
                    <Badge variant="neutral" className="shrink-0 text-[9px] uppercase">{s.kind}</Badge>
                    {s.trusted ? (
                      <Badge variant="success" className="shrink-0 text-[9px]">{t("settings.mcp.projectTrusted")}</Badge>
                    ) : (
                      <Badge variant="warning" className="shrink-0 text-[9px]" title={t("settings.mcp.projectUntrustedHint")}>
                        {t("settings.mcp.projectUntrusted")}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-[0.7143em] text-content-subtle" title={s.detail}>{s.detail}</div>
                </div>
                <Button
                  variant={s.trusted ? "ghost" : "secondary"}
                  size="sm"
                  className="gap-1"
                  disabled={busy !== null}
                  onClick={() => void run(key, () => api.mcp.projectTrust({ projectPath, name: s.name, trusted: !s.trusted }))}
                >
                  {!s.trusted && <IconShieldCheck size={12} />}
                  {s.trusted ? t("settings.mcp.projectUntrust") : t("settings.mcp.projectTrust")}
                </Button>
                <Button variant="ghost" size="icon" title={t("settings.mcp.editServer")} disabled={busy !== null}
                  onClick={() => onEdit(projectPath, s)}>
                  <IconPencil size={13} className="text-content-subtle" />
                </Button>
                <Button variant="ghost" size="icon" title={t("settings.mcp.deleteServer")} disabled={busy !== null}
                  onClick={() => setPendingRemove({ projectPath, name: s.name })}>
                  <IconTrash size={13} className="text-content-subtle" />
                </Button>
              </div>
            );
          })
        )}
        {data && data.invalid.length > 0 && (
          <ErrorNote tone="warning" className="m-3">{t("settings.mcp.projectInvalid", { names: data.invalid.join(", ") })}</ErrorNote>
        )}
      </Card>

      {/* ── 从总库复制 ── */}
      <Card className="bg-surface/40">
        <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
          <span className="text-[0.7857em] font-medium text-content-muted">{t("settings.mcp.projectCopyTitle")}</span>
          <Button variant="primary" size="sm" className="gap-1" disabled={busy !== null || !!data?.error} onClick={() => void copy()}>
            <IconCopy size={12} />
            {checked.size > 0 ? t("settings.skills.copySelected", { n: checked.size }) : t("settings.skills.copyToProject")}
          </Button>
        </div>
        {copyable.length === 0 ? (
          <EmptyState title={t("settings.mcp.projectCopyEmpty")} className="py-4" />
        ) : (
          <div className="flex flex-wrap gap-1.5 px-3 py-2">
            {copyable.map((s) => {
              const inProject = existing.has(s.name);
              const on = checked.has(s.name);
              return (
                <label
                  key={s.name}
                  className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-[var(--radius-btn-xs)] border px-1.5 py-0.5 font-mono text-[0.7857em]",
                    on ? "border-edge/80 bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "border-edge text-content-muted",
                    inProject && "cursor-default opacity-50",
                  )}
                  title={inProject ? t("settings.mcp.projectCopyExists") : s.detail}
                >
                  <Checkbox
                    className="h-3 w-3"
                    checked={on}
                    disabled={inProject}
                    onChange={() =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.name)) next.delete(s.name);
                        else next.add(s.name);
                        return next;
                      })
                    }
                  />
                  {s.name}
                </label>
              );
            })}
          </div>
        )}
        <p className="px-3 pb-2 text-[0.7143em] leading-relaxed text-content-subtle">{t("settings.mcp.projectCopyWarn", { var: "${VAR}" })}</p>
      </Card>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t("settings.mcp.deleteTitle")}
        danger
        description={pendingRemove ? t("settings.mcp.projectDeleteDesc", { name: pendingRemove.name }) : ""}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        onConfirm={() => {
          const target = pendingRemove;
          setPendingRemove(null);
          if (target) void run(`rm:${target.name}`, () => api.mcp.projectRemove(target));
        }}
      />
    </div>
  );
}
