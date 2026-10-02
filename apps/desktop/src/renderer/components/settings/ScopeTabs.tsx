/**
 * 「总库 / 项目 / 节点」—— 技能、MCP、插件三个面板共用的作用域段控 + 项目选择器。
 *
 * 三个面板的管理模型是同一个(2026-10-03 用户要求「都做成现在 skill 那样」):
 *  - **总库**:装一次、全局可用,每项有 Claude / Codex / Pi 开关;
 *  - **项目**:跟着项目目录走(技能 / MCP 写进项目目录;插件按项目开关);
 *  - **节点**:工作流节点 / 代理档案挂了哪些 —— 只读反查,点一行跳去改。
 * 样子照技能页那条段控(SkillsPanel 自己那份保持不动,形状一致)。
 */
import { useEffect, useState } from "react";
import type { Project } from "@contracts/session";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Select } from "@renderer/components/ui/index.js";
import { IconFolderOpen } from "@renderer/lib/icons.js";

export interface ScopeTabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  );
  if (tabs.length === 0) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(event.currentTarget));
  const next = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}

export function ScopeTabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: ReadonlyArray<ScopeTabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1", className)} role="tablist">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={moveTabFocus}
            onClick={() => onChange(item.id)}
            className={cn(
              "rounded border px-2.5 py-1 text-[0.8571em] transition-colors",
              active
                ? "border-accent bg-accent/10 font-medium text-accent"
                : "border-edge bg-surface text-content-muted hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="ml-1.5 tabular-nums text-content-subtle">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The project a management tab works on — local to the panel, so picking
 *  another project never switches the user's active chat. */
export function useManagedProject(): {
  project: Project | undefined;
  projects: Project[];
  setManagedProjectId: (id: string) => void;
} {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const [managedProjectId, setManagedProjectId] = useState<string | null>(activeProjectId);
  const project = projects.find((p) => p.id === managedProjectId)
    ?? projects.find((p) => p.id === activeProjectId)
    ?? projects[0];
  useEffect(() => {
    if (project && managedProjectId !== project.id) setManagedProjectId(project.id);
  }, [managedProjectId, project?.id]);
  return { project, projects, setManagedProjectId };
}

/** Project picker (name + path), same look as the skills project tab. */
export function ProjectPicker({
  project,
  projects,
  onSelect,
  disabled,
}: {
  project: Project;
  projects: Project[];
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <IconFolderOpen size={14} className="shrink-0 text-content-subtle" />
      <div className="min-w-0">
        <Select.Root
          value={project.id}
          disabled={disabled}
          onValueChange={(value) => { if (typeof value === "string") onSelect(value); }}
        >
          <Select.Trigger aria-label={t("settings.skills.selectProject")} className="max-w-[min(320px,70vw)]">
            <Select.Value>{project.name}</Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner sideOffset={4} align="start">
              <Select.Popup className="max-h-[320px] max-w-[90vw] overflow-auto">
                <Select.List>
                  {projects.map((item) => (
                    <Select.Item key={item.id} value={item.id}>
                      <Select.ItemText className="flex min-w-0 flex-col">
                        <span>{item.name}</span>
                        <span className="max-w-[440px] truncate font-mono text-[10px] text-content-subtle" title={item.path}>
                          {item.path}
                        </span>
                      </Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle" title={project.path}>
          {project.path}
        </div>
      </div>
    </div>
  );
}
