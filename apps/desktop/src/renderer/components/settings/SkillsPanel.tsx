/**
 * 技能管理面板。设置页「技能」那一项，三个 tab：**总库 / 项目 / 节点**。
 *
 * ## 三个作用域
 *
 *  - **总库**（`~/.mcode/skills`）—— 三个引擎共用的那一份，唯一的事实源。
 *  - **项目**（`<项目>/.claude/skills/`）—— 从总库**复制**过来的一份。2026-09-20
 *    加回来的：用户要"技能跟着项目走、能改成本项目专用、能分享给同事"，那只有
 *    落在项目目录里才成立。复制之后**两边脱钩**（刻意）。
 *  - **节点** —— 那是**引用**，不是文件：每个节点/代理档案各自指名要哪几个技能。
 *    它**不在这一页配**（长在工作流图上和代理档案里），这一页只给**总览**：
 *    谁在用什么、点一行跳到那儿去改。
 *
 * ## Layout(总库那一栏)
 *
 *   ┌─ left (skill list) ────┬─ right (editor / empty) ─────────────────┐
 *   │ ☑ pdf       [全局]      │  - editing existing -                    │
 *   │ ☑ refs      [全局]      │  engine matrix (claude/codex/pi toggles) │
 *   │ + 新建 Skill            │  full SKILL.md source textarea           │
 *   │ + 导入 Skill            │  - or creating new -                     │
 *   └─────────────────────────┤  name / description / body · 保存/删除    │
 *                              └──────────────────────────────────────────┘
 *
 * 勾选框是**「复制到项目」的源**（只对通用库的技能出现）—— 勾完切到「项目」那一栏
 * 按按钮。两个动作分属两栏，因为复制的两端正好就是这两栏。
 *
 * The skill list is fetched locally (panelSkills state), NOT read from the
 * session store's `skills` cache - that cache feeds the composer `/` menu and
 * must not be coupled to this panel. After a mutation we also reload the
 * store cache so the `/` menu stays in sync.
 *
 * Mirrors CustomModelsPanel's two-column shape and ConfirmDialog-based delete.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, InfoHint, LoadingNote } from "@renderer/components/ui/index.js";
import { ListPane } from "./ListPane.js";
import { PanelHeader } from "./PanelHeader.js";
import { ProjectSkillsView } from "./ProjectSkillsView.js";
import { SkillNodesView } from "./SkillNodesView.js";
import { SkillPresetsView } from "./SkillPresetsView.js";
import { SkillProjectOverview } from "./SkillProjectOverview.js";
import {
  IconPlus,
  IconTrash,
  IconSparkles,
  IconLoader2,
  IconDownload,
  IconFolder,
  IconFileText,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import type {
  SkillInfo,
  SkillSource,
  ReadOnlySkillSource,
  ExternalSkillInfo,
  SkillTool,
  SkillEngineState,
  SkillBundle,
} from "@contracts/ipc";

/** Skill name charset — mirrored from the zod schema in the contract. The
 *  editor disables the name field for existing skills, so this only gates the
 *  "create new" form. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Stable empty array so the panel's skill list has a stable reference when
 *  empty (avoiding needless re-renders — same convention as sessionStore's
 *  EMPTY_SKILLS). */
const EMPTY_PANEL_SKILLS: SkillInfo[] = [];
const EMPTY_BUNDLES: SkillBundle[] = [];

/** All listed sources are readable. Contributed sources remain readonly;
 *  global and explicitly selected project copies are independently editable. */
type SkillTarget = { source: SkillSource; name: string; projectPath?: string };

/** True for skills the editor must not offer to save or delete — neither has a
 *  user-owned file root: a plugin skill lives in the plugin's install dir, a
 *  built-in one in the app's own resources (replaced wholesale on upgrade).
 *
 *  A type predicate rather than a plain boolean so the write call sites narrow
 *  `SkillSource` down to the two writable sources after the guard — the
 *  contract's write schemas accept only those, and this is what proves it to
 *  the compiler instead of casting. */
function isReadOnlySkill(source: SkillSource): source is ReadOnlySkillSource {
  return source === "plugin" || source === "builtin";
}

type Selection =
  | ({ kind: "skill" } & SkillTarget)
  | { kind: "new" }
  | null;

interface NewForm {
  name: string;
  description: string;
  body: string;
}

function emptyNewForm(): NewForm {
  return { name: "", description: "", body: "" };
}

/** Selection key for a SkillInfo — stable identity across reloads. */
function skillKey(s: { source: SkillSource; name: string }): string {
  return `${s.source}:${s.name}`;
}

const MATRIX_ENGINES = ["claude", "codex", "pi"] as const;
type MatrixEngine = (typeof MATRIX_ENGINES)[number];

function engineLabel(e: MatrixEngine): string {
  return e === "claude" ? "Claude" : e === "codex" ? "Codex" : "Pi";
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

/** 按引擎分组时的组序:通用 → 各引擎内部 → 部分引擎共享。
 *
 *  ⚠️ **没有"内置垫底"了**(2026-09-20):那四个文档技能已移除,`builtin` 这个来源
 *  没有任何东西会产生它。`groupRank` 的兜底仍留着 —— 将来若再加来源,它落在最后
 *  比落进某个已有档位更安全。 */
function groupRank(id: string): number {
  if (id === "universal") return 0;
  if (id === "internal:claude") return 1;
  if (id === "internal:codex") return 2;
  if (id === "internal:pi") return 3;
  if (id.startsWith("shared:")) return 4;
  return 5;
}

/** Group-title engine switches (bundle view): one key per engine that toggles
 *  the WHOLE group's visibility for that engine in a single click. The
 *  aggregate shows "on" only when every skill in the group has that engine
 *  enabled (missing = enabled, same rule as the matrix). */
function GroupEngineSwitches({
  skills,
  busy,
  onToggle,
}: {
  skills: SkillInfo[];
  busy: boolean;
  onToggle: (engine: MatrixEngine, want: boolean) => void;
}) {
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-0.5">
      {MATRIX_ENGINES.map((e) => {
        const allOn = skills.every((s) => s.perEngine?.[e] !== false);
        return (
          <button
            key={e}
            type="button"
            disabled={busy}
            title={engineLabel(e)}
            onClick={(ev) => {
              // The switches sit inside the collapsible group title — clicking
              // one must not toggle the group's fold state.
              ev.stopPropagation();
              onToggle(e, !allOn);
            }}
            className={cn(
              "rounded px-1 leading-4 text-[9px] font-semibold transition-colors",
              allOn ? "bg-accent/15 text-accent" : "text-content-subtle/50 line-through hover:text-content-subtle",
              busy && "opacity-50",
            )}
          >
            {e === "claude" ? "C" : e === "codex" ? "X" : "P"}
          </button>
        );
      })}
    </span>
  );
}

export function SkillsPanel() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const reloadSkills = useSessionStore((s) => s.reloadSkills);

  // Management scope is local to this panel. Selecting another project must
  // not change activeProjectId (and therefore the user's active chat).
  const [managedProjectId, setManagedProjectId] = useState<string | null>(activeProjectId);
  const project = projects.find((p) => p.id === managedProjectId)
    ?? projects.find((p) => p.id === activeProjectId)
    ?? projects[0];
  const projectPath = project?.path;
  const activeProjectPath = projects.find((item) => item.id === activeProjectId)?.path;
  useEffect(() => {
    if (project && managedProjectId !== project.id) setManagedProjectId(project.id);
  }, [managedProjectId, project?.id]);

  // ── 三个 tab ── 总库 / 项目 / 节点。形状照 `WorkflowsPanel` 那个段控。
  const [view, setView] = useState<"library" | "project" | "nodes">("library");
  /** 总库那一栏勾选的技能名 —— 「复制到项目」的源。跨 tab 保留（用户在总库勾完
   *  切到项目 tab 按按钮是**预期用法**，切一下就把勾清掉会让那条路走不通）。 */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  /** 复制完之后让跨项目总览重扫一次（那一行的数字要跟着变）。 */
  const [overviewKey, setOverviewKey] = useState(0);
  const toggleChecked = useCallback((name: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // The global inventory must not use composer precedence: a project copy
  // with the same name must never hide the independently editable global one.
  const library = useRpc(() => api.skills.list({}), [], { toastOnError: false });
  const bundleQuery = useRpc(() => api.skills.bundles({}), [], { toastOnError: false });
  const panelSkills = library.data?.skills ?? EMPTY_PANEL_SKILLS;
  const listLoading = library.loading;
  const bundles = bundleQuery.data?.bundles ?? EMPTY_BUNDLES;
  const projectQuery = useRpc(async () => {
    const result = await api.skills.list({ projectPath });
    return { projectPath, skills: result.skills.filter((skill) => skill.source === "project") };
  }, [projectPath], { enabled: !!projectPath, toastOnError: false });
  // useRpc intentionally retains old data while refetching. Do not expose
  // the previous project's rows under a newly selected project's action bar.
  const projectSkills = projectQuery.data?.projectPath === projectPath
    ? projectQuery.data?.skills ?? EMPTY_PANEL_SKILLS : EMPTY_PANEL_SKILLS;
  const projectLoading = !!projectPath && (projectQuery.loading ||
    (!projectQuery.error && projectQuery.data?.projectPath !== projectPath));
  // The readonly node overview keeps its original active-project inventory.
  // Choosing a different management target must not hide project-only usages.
  const nodeInventory = useRpc(async () => {
    const result = await api.skills.list({ projectPath: activeProjectPath });
    return { projectPath: activeProjectPath, skills: result.skills };
  }, [activeProjectPath], { enabled: view === "nodes", toastOnError: false });
  /** 全选 / 清空 —— 总库那一栏标题上的两个小按钮，给"整包复制过去"用。 */
  const selectAllCopyable = useCallback((): void => {
    setChecked(new Set(panelSkills.filter((s) => s.source === "global").map((s) => s.name)));
  }, [panelSkills]);
  // Bundle manifest (import groups) + which grouping the left list uses.
  // Bundle grouping is the DEFAULT: with hundreds of imported skills, the
  // engine-state groups flatten everything into one undifferentiated mass,
  // while the bundle groups answer "这是什么、从哪个包来的" at a glance and
  // carry the group-level engine switches.
  const [groupMode, setGroupMode] = useState<"bundle" | "engine">("bundle");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [engineBusyName, setEngineBusyName] = useState<string | null>(null);
  // Matrix writes replace the complete engine tuple, so serialize them.
  const matrixBusyRef = useRef(false);
  // ── Collapsible groups ── Groups start COLLAPSED: with 266 skills in five
  // bundles, an all-expanded list is exactly the wall the user complained
  // about. "expanded" is an allowlist (empty = all collapsed), persisted in
  // localStorage so the panel remembers which packages the user is working on.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("mcode.skills.expanded");
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const toggleGroupExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("mcode.skills.expanded", JSON.stringify([...next]));
      } catch {
        // storage unavailable (private mode etc.) — collapse state just
        // won't persist; not worth surfacing.
      }
      return next;
    });
  };
  // ── Resizable left column ── persisted width, dragged via the handle on
  // the aside's right edge.
  const [leftW, setLeftW] = useState<number>(() => {
    const v = Number(localStorage.getItem("mcode.skills.leftW"));
    return Number.isFinite(v) && v >= 160 && v <= 480 ? v : 220;
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragHandleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: leftW };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const w = Math.min(480, Math.max(160, dragRef.current.startW + (ev.clientX - dragRef.current.startX)));
      setLeftW(w);
    };
    const up = () => {
      dragRef.current = null;
      try {
        localStorage.setItem("mcode.skills.leftW", String(leftWRef.current));
      } catch {
        // non-fatal, see above
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // Latest width for the drag-end persistence (the mouseup closure captures
  // the handler-time value otherwise).
  const leftWRef = useRef(leftW);
  leftWRef.current = leftW;
  // ── Group-level delete ── whole-package removal from the universal
  // library. Plugin rows are excluded (owned by the Plugins panel), builtin
  // rows are never offered the button.
  const [pendingGroupDelete, setPendingGroupDelete] = useState<{
    id: string;
    label: string;
    skills: SkillInfo[];
  } | null>(null);

  const loadPanelSkills = useCallback(async () => {
    await Promise.all([library.refetch(), bundleQuery.refetch()]);
  }, [library.refetch, bundleQuery.refetch]);

  // Remove deleted skills from the copy selection, without clearing valid
  // selections on tab/project switches or during a refetch.
  useEffect(() => {
    if (!library.data) return;
    const names = new Set(panelSkills.filter((skill) => skill.source === "global").map((skill) => skill.name));
    setChecked((previous) => {
      const next = new Set([...previous].filter((name) => names.has(name)));
      return next.size === previous.size ? previous : next;
    });
  }, [library.data, panelSkills]);

  // skill name → its import bundle (from the manifest). Built once, shared by
  // the bundle grouping and the group switches.
  const bundleOf = useMemo(() => {
    const m = new Map<string, SkillBundle>();
    for (const b of bundles) for (const n of b.skills) m.set(n, b);
    return m;
  }, [bundles]);

  // 左栏分组,两种模式:
  // - bundle(默认):按「来源包」分组 —— 266 个导入技能平铺没有可读性,按包分组
  //   回答"这是什么、从哪来的";组标题上挂三个引擎的整组开关,批量禁用一键完成。
  // - engine(旧视图):矩阵全开 = 通用,只勾一个引擎 = 那个引擎的内部技能…归属随
  //   矩阵开关即时移动(文件不动,只是各引擎的可见性变了)。
  const groupedSkills = useMemo(() => {
    const groups: Array<{ id: string; label: string; skills: SkillInfo[] }> = [];
    const index = new Map<string, number>();
    const push = (id: string, label: string, skill: SkillInfo): void => {
      let i = index.get(id);
      if (i === undefined) {
        i = groups.length;
        index.set(id, i);
        groups.push({ id, label, skills: [] });
      }
      groups[i].skills.push(skill);
    };
    if (groupMode === "bundle") {
      for (const s of panelSkills) {
        // **项目技能单独一组，不按导入包分。** 它们不属于任何一次导入，混进
        // "未分组"会让那个名字骗人 —— 用户明明是从项目目录来的，却被说成
        // "没归类"。而且项目那一栏才是它们的归属地，这里要一眼看得出来。
        if (s.source === "project") {
          push("project", t("settings.skills.tabProject"), s);
          continue;
        }
        if (s.source === "plugin") {
          push("plugin", t("settings.skills.groupPlugin"), s);
          continue;
        }
        // `builtin` 那条分支删了（2026-09-20）：随应用发布的那四个文档技能已移除，
        // 没有东西再产生这个来源。留着的话是个永远不成立的 if。
        const b = bundleOf.get(s.name);
        if (b) push(`bundle:${b.id}`, b.label, s);
        else push("ungrouped", t("settings.skills.groupUngrouped"), s);
      }
      // 顺序:项目在最前（局部覆盖全局,最该被看见）→ 插件组 → manifest 里的包
      // （按 manifest 顺序）→ 未分组。
      const orderOf = (id: string): number => {
        if (id === "project") return -2;
        if (id === "plugin") return -1;
        if (id.startsWith("bundle:")) {
          const i = bundles.findIndex((b) => `bundle:${b.id}` === id);
          return i >= 0 ? i : bundles.length;
        }
        if (id === "ungrouped") return bundles.length + 1;
        return Number.MAX_SAFE_INTEGER;
      };
      return groups.sort((a, b) => orderOf(a.id) - orderOf(b.id));
    }
    for (const s of panelSkills) {
      // 按引擎分组这一档里，项目技能按自己的 `perEngine` 走（主进程不给它挂矩阵，
      // 所以 `pe` 缺席 → 视为三引擎全开），与通用库同一个规则。
      const pe = s.perEngine;
      const on = pe ? MATRIX_ENGINES.filter((e) => pe[e]) : [...MATRIX_ENGINES];
      if (on.length === MATRIX_ENGINES.length) {
        push("universal", t("settings.skills.groupUniversal"), s);
      } else if (on.length === 1) {
        push(`internal:${on[0]}`, t("settings.skills.groupInternal", { engine: engineLabel(on[0]) }), s);
      } else {
        push(`shared:${on.join(",")}`, on.map(engineLabel).join(" · "), s);
      }
    }
    return groups.sort((a, b) => groupRank(a.id) - groupRank(b.id));
  }, [panelSkills, t, groupMode, bundles, bundleOf]);

  const [selected, setSelected] = useState<Selection>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [readVersion, setReadVersion] = useState(0);
  const editorKey = selected?.kind === "skill"
    ? JSON.stringify([selected.source, selected.name, selected.projectPath ?? null, readVersion]) : null;
  const sourceQuery = useRpc(async () => {
    if (!selected || selected.kind !== "skill") throw new Error("No skill selected");
    const { kind: _kind, ...target } = selected;
    const result = await api.skills.read(target);
    return { key: editorKey, content: result.content };
  }, [editorKey], { enabled: editorKey !== null, toastOnError: false });
  const [editDraft, setEditDraft] = useState<{ key: string; content: string } | null>(null);
  const sourceReady = !sourceQuery.loading && !sourceQuery.error && sourceQuery.data?.key === editorKey;
  const editContent = sourceReady
    ? (editDraft?.key === editorKey ? editDraft.content : sourceQuery.data?.content ?? null) : null;
  const loading = sourceQuery.loading || (!sourceQuery.error && !sourceReady);
  const setEditContent = (content: string) => {
    if (editorKey) setEditDraft({ key: editorKey, content });
  };
  // Structured form for creating a new skill.
  const [newForm, setNewForm] = useState<NewForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mutationBusyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillTarget | null>(null);
  // Import dialog open state.
  const [importOpen, setImportOpen] = useState(false);

  // After any mutation: refresh this panel's list and the store cache so the
  // composer `/` menu sees the change too.
  const refreshAfterMutation = useCallback(async () => {
    await loadPanelSkills();
    void reloadSkills();
  }, [loadPanelSkills, reloadSkills]);

  const startEdit = (skill: SkillInfo, targetProjectPath?: string) => {
    if (mutationBusyRef.current) return;
    if (skill.source === "project" && !targetProjectPath) return;
    setSelected({ kind: "skill", source: skill.source, name: skill.name,
      ...(skill.source === "project" ? { projectPath: targetProjectPath } : {}) });
    setReadVersion((version) => version + 1);
    setNewForm(null);
    setEditDraft(null);
    setError(null);
  };

  const startAdd = () => {
    if (mutationBusyRef.current) return;
    setSelected({ kind: "new" });
    // New skills always land in the universal library, enabled for every
    // engine (the matrix only records restrictions; none exist yet).
    setNewForm(emptyNewForm());
    setEditDraft(null);
    setError(null);
  };

  const cancel = () => {
    if (mutationBusyRef.current) return;
    setSelected(null);
    setEditDraft(null);
    setNewForm(null);
    setError(null);
  };

  const saveEdit = async () => {
    const sel = selected;
    if (!sel || sel.kind !== "skill" || editContent === null || mutationBusyRef.current) return;
    // Read-only skills have no writable root. The save button is hidden for
    // them, but guard here too — a stale selection could otherwise reach the
    // write RPC (whose schema would reject it anyway).
    if (isReadOnlySkill(sel.source)) return;
    mutationBusyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        source: sel.source,
        name: sel.name,
        ...(sel.projectPath ? { projectPath: sel.projectPath } : {}),
        content: editContent,
      });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      await refreshAfterMutation();
      if (sel.source === "project") await projectQuery.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  };

  const saveNew = async () => {
    const sel = selected;
    if (!sel || sel.kind !== "new" || !newForm || mutationBusyRef.current) return;
    const name = newForm.name.trim();
    if (!SKILL_NAME_RE.test(name)) {
      setError(t("settings.nameCharsError"));
      return;
    }
    if (!newForm.description.trim()) {
      setError(t("settings.skills.errDesc"));
      return;
    }
    // Assemble a minimal, valid SKILL.md: frontmatter (name + description) +
    // body. Description may contain special chars, so quote it to be safe.
    const desc = newForm.description.trim().replace(/"/g, '\\"');
    const content = `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${newForm.body.trimEnd()}\n`;
    mutationBusyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        source: "global",
        name,
        content,
      });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      await refreshAfterMutation();
      // Land on the freshly created skill so the user sees it selected.
      setSelected({ kind: "skill", source: "global", name });
      setNewForm(null);
      setEditDraft(null);
      setReadVersion((version) => version + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  };

  /** Toggle one skill's per-engine availability (the matrix edit — 「移动到
   *  引擎内部 / 移回通用」). Applies to universal-library AND plugin rows
   *  (both are matrix-managed; plugin rows stay read-only apart from these
   *  switches). The engine's full desired state is sent; the resolved state
   *  comes back and updates the row so the toggles render exactly what's on
   *  disk. */
  const setSkillEngines = async (
    name: string,
    current: SkillEngineState,
    engine: keyof SkillEngineState,
  ) => {
    if (matrixBusyRef.current) return;
    matrixBusyRef.current = true;
    setEngineBusyName(name);
    setError(null);
    const wanted = { ...current, [engine]: !current[engine] };
    try {
      const res = await api.skills.enginesSet({ name, ...wanted });
      if (!res.ok || !res.perEngine) {
        setError(res.error ?? t("settings.operationFailed"));
        return;
      }
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      matrixBusyRef.current = false;
      setEngineBusyName(null);
    }
  };

  /** Group-level engine toggle: flip ONE engine for every editable skill in a
   *  group (bundle / plugin view), leaving each skill's OTHER engine flags
   *  untouched. The bulk RPC takes one uniform {claude,codex,pi} triple, so
   *  the group is partitioned by the resulting desired state and each
   *  partition is written with a single matrix read-modify-write. */
  const setGroupEngines = async (
    skills: SkillInfo[],
    engine: keyof SkillEngineState,
    want: boolean,
  ) => {
    if (matrixBusyRef.current) return;
    // **项目技能不进这一档。** 矩阵（`.mcode-engines.json`）管的是**通用库**给哪个
    // 引擎用;项目技能属于那个项目、跟着项目目录走,不参与全局矩阵 —— 主进程也不会给
    // 它挂 `perEngine`（见 `listSkillsForProject` 里那句）。放进来会让用户以为
    // "我在这里关掉 Pi,那个项目里也关了",而实际什么都没发生。
    const editable = skills.filter((s) => s.source === "global" || s.source === "plugin");
    if (!editable.length) return;
    matrixBusyRef.current = true;
    setBulkBusy(true);
    try {
      const byState = new Map<string, { names: string[]; state: SkillEngineState }>();
      for (const s of editable) {
        const state = {
          ...(s.perEngine ?? { claude: true, codex: true, pi: true }),
          [engine]: want,
        };
        const key = `${state.claude}|${state.codex}|${state.pi}`;
        const bucket = byState.get(key);
        if (bucket) bucket.names.push(s.name);
        else byState.set(key, { names: [s.name], state });
      }
      await Promise.all(
        [...byState.values()].map(async ({ names, state }) => {
          const res = await api.skills.enginesSetBulk({ names, ...state });
          if (!res.ok || !res.perEngine) throw new Error(res.error ?? "bulk toggle failed");
        }),
      );
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      matrixBusyRef.current = false;
      setBulkBusy(false);
    }
  };

  /** Group-level delete: remove every deletable skill of the group from the
   *  universal library. Plugin rows are skipped (owned by the Plugins panel,
   *  delete there); builtins are never offered this button. One IPC per
   *  skill is fine (a recursive dir remove, sub-ms each); failures are
   *  reported but do not abort the rest. */
  const confirmGroupDelete = async () => {
    const group = pendingGroupDelete;
    if (!group || mutationBusyRef.current) return;
    const deletable = group.skills.filter((skill) => skill.source === "global");
    if (!deletable.length) return;
    mutationBusyRef.current = true;
    setBulkBusy(true);
    setError(null);
    const failures: string[] = [];
    const removed = new Set<string>();
    try {
      for (const skill of deletable) {
        try {
          const res = await api.skills.delete({ source: "global", name: skill.name });
          if (res.ok) removed.add(skill.name);
          else failures.push(`${skill.name}: ${res.error ?? t("settings.deleteFailed")}`);
        } catch (err) {
          failures.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const current = selectedRef.current;
      if (current?.kind === "skill" && current.source === "global" && removed.has(current.name)) {
        setSelected(null);
        setEditDraft(null);
      }
      await refreshAfterMutation();
      if (failures.length) setError(failures.join("; "));
    } finally {
      mutationBusyRef.current = false;
      setBulkBusy(false);
      setPendingGroupDelete(null);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target || isReadOnlySkill(target.source) || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      const res = await api.skills.delete({ ...target, source: target.source });
      if (!res.ok) {
        setError(res.error ?? t("settings.deleteFailed"));
        return;
      }
      const current = selectedRef.current;
      if (current?.kind === "skill" && current.source === target.source &&
          current.name === target.name && current.projectPath === target.projectPath) {
        setSelected(null);
        setEditDraft(null);
      }
      await refreshAfterMutation();
      if (target.source === "project") {
        await projectQuery.refetch();
        setOverviewKey((key) => key + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      mutationBusyRef.current = false;
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const selectedInfo = selected?.kind === "skill"
    ? (selected.source === "project" ? projectSkills : panelSkills).find(
      (skill) => skill.source === selected.source && skill.name === selected.name,
    ) : undefined;
  const editor = selected?.kind === "skill" ? (
    <SkillSourceEditor
      skill={selected}
      perEngine={selectedInfo?.perEngine}
      onToggleEngine={(engine) => {
        if (selectedInfo?.perEngine) void setSkillEngines(selectedInfo.name, selectedInfo.perEngine, engine);
      }}
      engineBusy={bulkBusy || engineBusyName === selected.name}
      content={editContent}
      loading={loading}
      saving={saving}
      mutationBusy={saving || deleting || bulkBusy}
      error={error}
      readError={sourceQuery.error?.message ?? null}
      onRetry={() => void sourceQuery.refetch()}
      onChange={setEditContent}
      onSave={() => void saveEdit()}
      onCancel={cancel}
      onDelete={() => {
        const { kind: _kind, ...target } = selected;
        setPendingDelete(target);
      }}
    />
  ) : null;

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col", PANEL_MAX_W.form)}>
      <PanelHeader
        className="mb-3"
        title="Skills"
      />

      {library.error && (
        <ErrorNote className="mb-3" action={<Button variant="ghost" onClick={() => void library.refetch()}>{t("common.retry")}</Button>}>
          {library.error.message}
        </ErrorNote>
      )}
      {bundleQuery.error && (
        <ErrorNote className="mb-3" action={<Button variant="ghost" onClick={() => void bundleQuery.refetch()}>{t("common.retry")}</Button>}>
          {bundleQuery.error.message}
        </ErrorNote>
      )}
      {error && (selected === null || (view !== "library" && !(selected.kind === "skill" && selected.source === "project"))) && (
        <ErrorNote className="mb-3">{error}</ErrorNote>
      )}

      {/* 三个 tab,形状照 `WorkflowsPanel`:段控 + `role="tabpanel"`。
          ⚠️ 面板用 `hidden` **类**藏,不用 `hidden` **属性** —— 那个 div 同时带
          `flex`,而 preflight 的 `[hidden]{display:none}` 与 `.flex` 同特异性又排在
          utilities 之前,属性会输、两块一起显示(仓库既有做法见 `PluginsPanel`)。 */}
      <div className="mb-3 flex gap-1" role="tablist">
        {(["library", "project", "nodes"] as const).map((id) => {
          const active = view === id;
          const label =
            id === "library"
              ? t("settings.skills.tabLibrary")
              : id === "project"
                ? t("settings.skills.tabProject")
                : t("settings.skills.tabNodes");
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onKeyDown={moveTabFocus}
              onClick={() => setView(id)}
              className={cn(
                "rounded border px-2.5 py-1 text-[0.8571em] transition-colors",
                active
                  ? "border-accent bg-accent/10 font-medium text-accent"
                  : "border-edge bg-surface text-content-muted hover:bg-surface-hover/60 hover:text-content",
              )}
            >
              {label}
              {id === "project" && projectSkills.length > 0 && (
                <span className="ml-1.5 tabular-nums text-content-subtle">{projectSkills.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {view === "nodes" && nodeInventory.error && (
        <ErrorNote className="mb-3" action={<Button variant="ghost" onClick={() => void nodeInventory.refetch()}>{t("common.retry")}</Button>}>
          {nodeInventory.error.message}
        </ErrorNote>
      )}
      {/* ── 节点总览:整页,不掺左右栏(它本来就没有"选一个去编辑"这回事) ── */}
      {view === "nodes" && (
        <SkillNodesView
          skills={nodeInventory.data?.projectPath === activeProjectPath
            ? nodeInventory.data?.skills ?? panelSkills : panelSkills}
          onJumpToWorkflow={() => {
            // 跳到「工作流」那一页 —— 那边自己能选中这一份。这里不传 id:
            // `setSettingsOpen` 只认 section,选中态是那个页面自己的事。
            useSessionStore.getState().setSettingsOpen(true, "workflows");
          }}
          onJumpToProfile={() => useSessionStore.getState().setSettingsOpen(true, "workflows")}
        />
      )}

      {/* ── 项目:整页(复制按钮 + 项目自己的技能列表),也走单栏 ── */}
      {view === "project" && (
        // Select the managed project first. Presets and the read-only overview
        // remain available, but never choose or mutate the active chat project.
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          <ProjectSkillsView
            project={project}
            projects={projects}
            onSelectProject={setManagedProjectId}
            skills={projectSkills}
            loading={projectLoading}
            error={projectQuery.error}
            onRetry={() => void projectQuery.refetch()}
            selected={[...checked]}
            onClearSelection={() => setChecked(new Set())}
            onCopied={async () => {
              await projectQuery.refetch();
              void reloadSkills();
              setOverviewKey((key) => key + 1);
            }}
            onGoToLibrary={() => setView("library")}
            onEdit={(skill) => startEdit(skill, projectPath)}
          />
          <SkillPresetsView
            librarySkills={panelSkills}
            onCopyPreset={(skills) => setChecked(new Set(skills))}
          />
          <SkillProjectOverview refreshKey={overviewKey} />
        </div>
      )}

      {/* ── 总库:原有的左右两栏(勾选在这里做,复制按钮在项目那一栏) ── */}
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4",
          view === "library" ? "" : "hidden",
        )}
        style={{ gridTemplateColumns: `${leftW}px 1fr` }}
      >
        {/* ───────── Left: skill list (width is user-draggable, persisted) ───────── */}
        {/* 左栏是共享的 `ListPane`（和钩子页同一个件）：标题行、条数、加载骨架、空状态、底栏都在那里。 */}
        <ListPane
          handle={
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={onDragHandleMouseDown}
            className="absolute -right-2 top-0 z-10 h-full w-2 cursor-col-resize transition-colors hover:bg-accent/20"
          />
          }
          title={
            <>
              <span>Skills</span>
              {/* 全选 / 清空 —— 勾选是「复制到项目」的源，所以这两个按钮只在有东西
                  可勾时出现。放在这里而不是底部：勾选发生在列表里，操作也该在附近。 */}
              {checked.size > 0 ? (
                <button
                  type="button"
                  onClick={() => setChecked(new Set())}
                  className="rounded px-1.5 py-0.5 text-[0.9em] font-normal text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
                >
                  {t("settings.skills.clearSelection")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={selectAllCopyable}
                  className="rounded px-1.5 py-0.5 text-[0.9em] font-normal text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
                >
                  {t("settings.skills.selectAll")}
                </button>
              )}
            </>
          }
          actions={
            <>
              {/* Grouping mode: bundle (by source) is the default — it answers
                  "这是什么、从哪来的" and carries the group switches. */}
              <button
                type="button"
                onClick={() => setGroupMode("bundle")}
                className={cn(
                  "rounded px-1.5 py-0.5 normal-case tracking-normal transition-colors",
                  groupMode === "bundle" ? "bg-accent/15 text-accent" : "hover:text-content",
                )}
              >
                {t("settings.skills.modeBundle")}
              </button>
              <button
                type="button"
                onClick={() => setGroupMode("engine")}
                className={cn(
                  "rounded px-1.5 py-0.5 normal-case tracking-normal transition-colors",
                  groupMode === "engine" ? "bg-accent/15 text-accent" : "hover:text-content",
                )}
              >
                {t("settings.skills.modeEngine")}
              </button>
            </>
          }
          count={panelSkills.length}
          loading={listLoading}
          isEmpty={panelSkills.length === 0 && selected?.kind !== "new"}
          empty={
            <>
                {t("settings.skills.listEmpty1")}
                <br />
                {t("settings.skills.listEmpty2")}
            </>
          }
          footer={
            <>
            <Button
              variant="ghost"
              size="sm"
              onClick={startAdd}
              disabled={selected?.kind === "new"}
              className="w-full justify-center gap-1"
            >
              <IconPlus size={12} />
              {t("settings.skills.newSkill")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportOpen(true)}
              className="w-full justify-center gap-1"
            >
              <IconDownload size={12} />
              {t("settings.skills.importSkill")}
            </Button>
            </>
          }
        >
            {selected?.kind === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t("settings.skills.newSkill")}
              </div>
            )}
            {groupedSkills.map((g) => {
              const isCollapsed = !expanded.has(g.id);
              // Deletable = universal-library rows. Plugin rows are owned by
              // the Plugins panel; builtin rows are not deletable at all.
              const deletableCount = g.skills.filter((s) => s.source === "global").length;
              return (
              <div key={g.id} className="pt-1.5">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroupExpanded(g.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleGroupExpanded(g.id);
                    }
                  }}
                  className="flex cursor-pointer select-none items-center rounded px-2.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-content-subtle/80 hover:text-content-subtle"
                >
                  {isCollapsed ? (
                    <IconChevronRight size={10} className="shrink-0" />
                  ) : (
                    <IconChevronDown size={10} className="shrink-0" />
                  )}
                  <span className="ml-1 min-w-0 flex-1 truncate" title={g.label}>
                    {g.label}
                  </span>
                  <span className="ml-1 shrink-0 tabular-nums normal-case">{g.skills.length}</span>
                  {/* Group-level engine switches — shown on editable groups (not
                      built-in peers, which are always offered to every engine). */}
                  {groupMode === "bundle" && g.id !== "builtin" && (
                    <GroupEngineSwitches
                      skills={g.skills}
                      busy={bulkBusy}
                      onToggle={(engine, want) => void setGroupEngines(g.skills, engine, want)}
                    />
                  )}
                  {groupMode === "bundle" && deletableCount > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("settings.skills.groupDeleteTitle")}
                      aria-label={`${t("settings.skills.groupDeleteTitle")} · ${g.label}`}
                      disabled={bulkBusy || deleting || saving}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingGroupDelete({ id: g.id, label: g.label, skills: g.skills });
                      }}
                      className="ml-1 h-5 w-5 shrink-0 text-content-subtle hover:text-danger"
                    >
                      <IconTrash size={12} />
                    </Button>
                  )}
                </div>
                {!isCollapsed &&
                  g.skills.map((s) => {
                  const isActive =
                    selected?.kind === "skill" &&
                    selected.source === s.source &&
                    selected.name === s.name;
                  // **只有通用库的技能可以勾选复制** —— 项目里的已经在项目里了，
                  // 插件那份是别人管的、复制出去就成了孤儿拷贝。
                  const canCopy = s.source === "global";
                  const isChecked = canCopy && checked.has(s.name);
                  return (
                    <div
                      key={skillKey(s)}
                      className={cn(
                        "group relative flex w-full items-start gap-1.5 rounded px-2 py-1.5 transition-colors",
                        isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                      )}
                      {/* 勾选框：复制的源。占位一直留着（不可复制的那些画一个空位），
                          否则列表里名字的左边缘会参差不齐。 */}
                      {canCopy ? (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleChecked(s.name)}
                          // 点勾不能顺带打开编辑器 —— 两者是两件事。
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                          aria-label={s.name}
                        />
                      ) : (
                        <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      )}
                      <button
                        type="button"
                        onClick={() => startEdit(s)}
                        disabled={saving || deleting || bulkBusy}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <IconSparkles size={13} className="shrink-0 text-content-subtle" />
                          <span className="truncate text-[0.9286em] font-medium text-content">
                            {s.name}
                          </span>
                          <SourceBadge source={s.source} />
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="truncate text-[0.8571em] text-content-muted">
                            {s.description || t("settings.skills.noDesc")}
                          </span>
                        </div>
                      </button>
                      {!isReadOnlySkill(s.source) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid="skill-row-delete"
                          title={t("settings.skills.deleteSkillTitle")}
                          aria-label={`${t("settings.skills.deleteSkillTitle")} · ${s.name}`}
                          disabled={deleting || bulkBusy || saving}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete({ source: s.source, name: s.name });
                          }}
                          className="ml-auto h-5 w-5 shrink-0 text-content-subtle hover:text-danger"
                        >
                          <IconTrash size={12} />
                        </Button>
                      )}
                    </div>
                  );
                  })}
              </div>
              );
            })}
        </ListPane>

        {/* ───────── Right: editor / empty state ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {selected == null ? (
            <EmptyDetail />
          ) : selected.kind === "new" && newForm ? (
            <NewSkillForm
              form={newForm}
              setForm={setNewForm}
              saving={saving}
              error={error}
              onSave={() => void saveNew()}
              onCancel={cancel}
            />
          ) : selected.kind === "skill" && selected.source !== "project" ? editor : <EmptyDetail />}
        </div>
      </div>

      <Dialog.Root open={selected?.kind === "skill" && selected.source === "project"}
        onOpenChange={(open) => { if (!open) cancel(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="flex max-h-[90vh] w-[760px] max-w-[95vw] flex-col overflow-auto p-4">
            <Dialog.Title>{t("settings.skills.projectEditorTitle")}</Dialog.Title>
            <Dialog.Description className="mb-3 break-all font-mono text-xs">
              {selected?.kind === "skill" ? selected.projectPath : ""}
            </Dialog.Description>
            {selected?.kind === "skill" && selected.source === "project" && editor}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ───────── Delete confirmation ───────── */}
      <ConfirmDialog
        open={pendingDelete != null}
        title={t("settings.skills.deleteTitle")}
        danger
        description={
          <>
            {t("settings.skills.deleteDescPre")}
            {/* Reuse the badge rather than a third copy of the source→label
                ternary: the dialog names the same thing the list does. */}
            {pendingDelete && <SourceBadge source={pendingDelete.source} />}
            {t("settings.skills.deleteDescMid")}
            {pendingDelete?.name}
            {t("settings.skills.deleteDescPost")}
            {pendingDelete?.projectPath && (
              <span className="mt-2 block break-all font-mono">{pendingDelete.projectPath}</span>
            )}
          </>
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={pendingGroupDelete != null}
        title={t("settings.skills.groupDeleteTitle")}
        danger
        description={
          <>
            {t("settings.skills.groupDeleteDescPre")}
            {pendingGroupDelete && (
              <span className="font-medium text-content">{pendingGroupDelete.label}</span>
            )}
            {t("settings.skills.groupDeleteDescMid", {
              n: pendingGroupDelete?.skills.filter((s) => s.source === "global").length ?? 0,
            })}
            {t("settings.skills.groupDeleteDescPost")}
          </>
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingGroupDelete(null);
        }}
        onConfirm={() => void confirmGroupDelete()}
      />

      <ImportSkillsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void refreshAfterMutation()}
      />
    </div>
  );
}

/** Source badge for a skill row / editor header. Single implementation so the
 *  list and the editor can never disagree about what a source is called —
 *  they each used to carry their own copy of the same ternary. */
function SourceBadge({ source }: { source: SkillSource }) {
  const { t } = useI18n();
  const builtin = source === "builtin";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[9px] leading-tight",
        builtin ? "bg-info/12 text-info" : "bg-surface-hover text-content-subtle",
      )}
    >
      {builtin ? t("settings.skills.sourceBuiltin")
        : source === "project" ? t("settings.skills.sourceProject")
        : source === "plugin" ? t("settings.skills.groupPlugin") : t("settings.skills.sourceGlobal")}
    </span>
  );
}

/** Right-pane empty state — nothing selected. */
function EmptyDetail() {
  const { t } = useI18n();
  return <EmptyState className="h-full" icon={IconSparkles} title={t("settings.skills.emptyDetail")} />;
}

/** Editor for an existing skill — engine matrix (universal skills) + raw
 *  SKILL.md source in a single textarea. */
function SkillSourceEditor({
  skill,
  perEngine,
  onToggleEngine,
  engineBusy,
  content,
  loading,
  saving,
  mutationBusy,
  error,
  readError,
  onRetry,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  skill: { source: SkillSource; name: string };
  /** Resolved per-engine availability — present only for universal-library
   *  skills; absent (built-in) → the matrix is not rendered. */
  perEngine?: SkillEngineState;
  /** Toggle one engine's checkbox; the panel owns the RPC + state update. */
  onToggleEngine: (engine: keyof SkillEngineState) => void;
  engineBusy: boolean;
  content: string | null;
  loading: boolean;
  saving: boolean;
  mutationBusy: boolean;
  error: string | null;
  readError: string | null;
  onRetry: () => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  // Read-only skills (built-in, shipped in the app's resources) are shown but
  // not editable: the save/delete handlers reject them host-side, so offering
  // the buttons would only produce an error dialog. Computed from `skill`
  // rather than threaded in as a prop — there is exactly one reason to be
  // read-only and it's a property of the source.
  const readOnly = isReadOnlySkill(skill.source);
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <IconSparkles size={14} className="text-content-muted" />
          <span className="text-[0.8571em] font-medium text-content">/{skill.name}</span>
          <SourceBadge source={skill.source} />
        </div>
        <span className="text-[0.7143em] text-content-subtle">
          {readOnly ? t("settings.skills.builtinReadOnly") : t("settings.skills.rawSource")}
        </span>
      </div>
      {/* Per-engine matrix — universal-library AND plugin skills. Each toggle
          is an edit of .mcode-engines.json (files never move); all three
          enabled = 通用, exactly one = 引擎内部. Built-ins are app-shipped
          inventory and always offered, so they get no matrix. */}
      {perEngine && (
        <div className="mb-2 flex items-center gap-2 rounded border border-edge bg-surface/40 px-2.5 py-1.5">
          <span className="text-[0.7143em] font-medium text-content-muted">
            {t("settings.skills.engines")}
          </span>
          <div className="flex items-center gap-1" role="group" aria-label={t("settings.skills.engines")}>
            {(Object.keys(perEngine) as Array<keyof SkillEngineState>).map((engine) => {
              const on = perEngine[engine];
              return (
                <button
                  key={engine}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={engineBusy}
                  onClick={() => onToggleEngine(engine)}
                  title={
                    on
                      ? t("settings.skills.engineOnHint", { engine })
                      : t("settings.skills.engineOffHint", { engine })
                  }
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
                    on
                      ? "bg-accent/15 text-accent"
                      : "bg-surface-hover text-content-subtle line-through decoration-content-subtle/60",
                  )}
                >
                  {engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Pi"}
                </button>
              );
            })}
          </div>
          <span className="min-w-0 flex-1 truncate text-[10px] text-content-subtle">
            {t("settings.skills.enginesHint")}
          </span>
        </div>
      )}
      {readError ? (
        <ErrorNote action={<Button variant="ghost" onClick={onRetry}>{t("common.retry")}</Button>}>
          {readError}
        </ErrorNote>
      ) : loading ? (
        <LoadingNote label={t("common.loading")} />
      ) : (
        <textarea
          data-testid="skill-source-input"
          aria-label={t("settings.skills.rawSource")}
          value={content ?? ""}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          readOnly={readOnly || mutationBusy}
          className={cn(
            "min-h-[300px] flex-1 resize-y rounded border border-edge px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
            readOnly ? "cursor-default bg-surface-muted/40" : "bg-surface",
          )}
          placeholder={t("settings.skills.sourcePlaceholder")}
        />
      )}
      {!loading && !readError && content === "" && (
        <ErrorNote tone="warning" className="mt-2">{t("settings.skills.emptySource")}</ErrorNote>
      )}
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      <div className="mt-2 flex items-center gap-2">
        {!readOnly && (
          <Button variant="danger" size="sm" onClick={onDelete} disabled={mutationBusy} title={t("settings.skills.deleteSkillTitle")}>
            <IconTrash size={12} />
            {t("common.delete")}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={mutationBusy}>
          {readOnly ? t("common.close") : t("common.cancel")}
        </Button>
        {!readOnly && (
          <Button variant="primary" size="sm" onClick={onSave} disabled={mutationBusy || loading || !!readError || content === null}>
            {saving ? t("settings.saving") : t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Structured form for creating a new skill (name / description / body).
 *  New skills always land in the universal library ~/.mcode/skills, enabled
 *  for every engine until the editor's matrix says otherwise. */
function NewSkillForm({
  form,
  setForm,
  saving,
  error,
  onSave,
  onCancel,
}: {
  form: NewForm;
  setForm: React.Dispatch<React.SetStateAction<NewForm | null>>;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Functional updater - guards against null (the form is guaranteed non-null
  // while this component is mounted, but the setter type carries | null).
  const update = <K extends keyof NewForm>(key: K, value: NewForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const { t } = useI18n();
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <IconPlus size={14} className="text-accent" />
        <span className="text-[0.8571em] font-medium text-content">{t("settings.skills.newSkill")}</span>
        <InfoHint>
          {t("settings.skills.newSkillGlobalIntro1")}
          <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
          {t("settings.skills.newSkillGlobalIntro2")}
          <code className="rounded bg-surface-muted px-0.5">allowed-tools</code>
          {t("settings.skills.newSkillIntro3")}
        </InfoHint>
      </div>

      <Field
        className="mb-2"
        label={t("settings.skills.fieldName")}
        hint={
          <>
            {t("settings.skills.fieldNameHintPre")}
            <code className="rounded bg-surface-muted px-0.5">/name</code>
            {t("settings.skills.fieldNameHintPost")}
          </>
        }
      >
        <input
          type="text"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="my-skill"
          className={inputCls}
          spellCheck={false}
          autoFocus
        />
      </Field>

      <Field className="mb-2" label={t("settings.skills.fieldDesc")}>
        <input
          type="text"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder={t("settings.skills.descPlaceholder")}
          className={inputCls}
          spellCheck={false}
        />
      </Field>

      <Field className="mb-2" label={t("settings.skills.fieldBody")}>
        <textarea
          value={form.body}
          onChange={(e) => update("body", e.target.value)}
          spellCheck={false}
          // w-full (not flex-1): Field wraps this in a block <label>, not a flex
          // container, so flex-1 was a no-op and the textarea fell back to its
          // default cols=20 width. w-full makes it fill the row like the other
          // inputs (which use inputCls with w-full).
          className={cn(
            "min-h-[200px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder={t("settings.skills.bodyPlaceholder")}
        />
      </Field>

      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
          {saving ? t("settings.saving") : t("settings.skills.createBtn")}
        </Button>
      </div>
    </div>
  );
}

const inputCls =
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";


/* ───────── Import Skills Dialog ───────── */

/** Human-readable labels for each external tool. */
const TOOL_LABELS: Record<SkillTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  zcode: "Zcode",
  local: "",
};

/** Tool badge color classes - each tool gets a distinct tint. */
const TOOL_BADGE_CLS: Record<SkillTool, string> = {
  "claude-code": "bg-accent/12 text-accent",
  codex: "bg-purple-500/15 text-purple-500",
  zcode: "bg-blue-500/15 text-blue-500",
  local: "bg-surface-hover text-content-muted",
};

/** Fixed tab order: the three external agents by install-base, then the local
 *  folder pseudo-source last (it's the "additional source" tab). */
const TOOL_ORDER: SkillTool[] = ["claude-code", "codex", "zcode", "local"];

/** Modal dialog for importing skills from external tools (Claude Code, Codex,
 *  Zcode) into Mcode's own ~/.mcode/skills directory. On open, scans all
 *  external sources; presents a TAB-PER-AGENT, checkbox-selectable list; and
 *  copies the selected skill directories on confirm. Skills already present
 *  at the destination are marked and excluded from selection.
 *
 *  The selection Set is GLOBAL across tabs (keyed by sourcePath), so picks
 *  accumulate as the user flips between agents; each tab badge shows its own
 *  selected count, and the footer shows the total. The "本地" tab always
 *  exists and hosts the folder picker (plus its scanned skills). */
function ImportSkillsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<ExternalSkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);
  // User-picked local directory and/or single skill file (the "本地" tab's
  // "select folder" / "select file" flows). Both are independent scan sources
  // and may be combined; "清除" resets both.
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [localFile, setLocalFile] = useState<string | null>(null);
  // Which agent's tab is showing. Reset on open; falls back to the first tab
  // that actually has skills when the stored one has none (see `activeTool`).
  const [activeToolRaw, setActiveToolRaw] = useState<SkillTool>("claude-code");
  // GitHub package import ("贴链接进来,导出来就是一类"): the URL box sits above
  // the tab flow because it is an independent path — one repo, one bundle, no
  // per-skill picking. Result mirrors the local import's lists + bundle label.
  const [ghUrl, setGhUrl] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghResult, setGhResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
    bundleLabel?: string;
  } | null>(null);

  // Scan external sources whenever the dialog opens or the local folder changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setGhUrl("");
    setGhResult(null);
    if (localDir === null && localFile === null) setSelected(new Set());
    setExisting(new Set());
    setActiveToolRaw("claude-code");
    void (async () => {
      try {
        // Scan external tools (+ the picked local dir / file if any) and fetch
        // the current universal library to mark already-imported ones.
        const [scanRes, listRes] = await Promise.all([
          api.skills.scanSources({
            ...(localDir ? { localDir } : {}),
            ...(localFile ? { localFile } : {}),
          }),
          api.skills.list({}),
        ]);
        if (cancelled) return;
        setSources(scanRes.sources);
        const existingNames = new Set<string>();
        for (const s of listRes.skills) {
          if (s.source === "global") existingNames.add(s.name);
        }
        setExisting(existingNames);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // localDir/localFile are deps: picking a new folder/file re-scans with it.
  }, [open, localDir, localFile]);

  // Selection key is sourcePath (unique per skill per tool).
  const toggle = (sourcePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourcePath)) next.delete(sourcePath);
      else next.add(sourcePath);
      return next;
    });
  };

  // Group sources by tool for display.
  const grouped = sources.reduce<Record<SkillTool, ExternalSkillInfo[]>>(
    (acc, s) => {
      (acc[s.tool] ??= []).push(s);
      return acc;
    },
    {} as Record<SkillTool, ExternalSkillInfo[]>,
  );

  // Tabs: the three agents appear only when they have skills; "本地" is always
  // present (it hosts the folder picker). `activeTool` falls back to the first
  // non-empty tab when the stored one is empty, so the strip never lands on a
  // tab with nothing in it.
  const tabs = TOOL_ORDER.filter((tool) => tool === "local" || (grouped[tool]?.length ?? 0) > 0);
  const activeTool = tabs.includes(activeToolRaw) ? activeToolRaw : (tabs[0] ?? "local");
  const activeItems = grouped[activeTool] ?? [];

  // Select-all toggle for the active tab: adds every not-yet-present skill of
  // the tab, or clears them all when everything importable is already picked.
  const importableItems = activeItems.filter((s) => !existing.has(s.name));
  const allActiveSelected =
    importableItems.length > 0 && importableItems.every((s) => selected.has(s.sourcePath));
  const toggleSelectAllForActive = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allActiveSelected) {
        for (const s of importableItems) next.delete(s.sourcePath);
      } else {
        for (const s of importableItems) next.add(s.sourcePath);
      }
      return next;
    });
  };

  const selectedCount = selected.size;

  const doImport = async () => {
    if (selectedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = sources
        .filter((s) => selected.has(s.sourcePath))
        .map((s) => ({ sourcePath: s.sourcePath, name: s.name }));
      const res = await api.skills.import({ skills: items });
      setResult(res);
      setSelected(new Set());
      // Refresh the existing set so imported skills show as "already present".
      setExisting((prev) => {
        const next = new Set(prev);
        for (const name of res.imported) next.add(name);
        return next;
      });
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const close = () => {
    onOpenChange(false);
  };

  // Pick a local folder to scan for skills (in addition to the fixed external
  // tool dirs). Sets localDir → the open-effect re-scans with it, its skills
  // land in the "本地" tab, and we switch to that tab so the user immediately
  // sees what was found. Clearing selection first avoids stale picks pointing
  // at a folder that's no longer in the list.
  const pickLocalFolder = async () => {
    try {
      const { path: picked } = await api.pickFolder();
      if (!picked) return; // user cancelled
      setSelected(new Set());
      setLocalDir(picked);
      setActiveToolRaw("local");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Pick a single skill FILE (the "select file" flow): the markdown file IS
  // the SKILL.md body; importing materializes it as <name>/SKILL.md. Uses the
  // generic multi-file picker (first selection). Markdown-only is pre-checked
  // here so the user sees an error instead of a silent no-op from the scan
  // (main skips non-.md files defensively).
  const pickLocalFile = async () => {
    try {
      const { paths } = await api.pickFiles({ title: t("settings.skills.chooseFile") });
      const picked = paths[0];
      if (!picked) return; // user cancelled
      const dot = picked.lastIndexOf(".");
      const ext = dot >= 0 ? picked.slice(dot + 1).toLowerCase() : "";
      if (ext !== "md" && ext !== "markdown") {
        setError(t("settings.skills.fileTypeError"));
        return;
      }
      setSelected(new Set());
      setLocalFile(picked);
      setActiveToolRaw("local");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearLocalFolder = () => {
    setSelected(new Set());
    setLocalDir(null);
    setLocalFile(null);
  };

  // GitHub package import: one repo → one bundle. Success refreshes the
  // panel list via onImported (the parent reloads skills + bundles); the
  // result card stays visible until the dialog reopens.
  const doGithubImport = async () => {
    const url = ghUrl.trim();
    if (!url || ghBusy) return;
    setGhBusy(true);
    setError(null);
    setGhResult(null);
    try {
      const res = await api.skills.importGithub({ url });
      if (!res.ok) {
        setError(res.error ?? t("settings.skills.githubFailed"));
        return;
      }
      setGhResult({
        imported: res.imported,
        skipped: res.skipped,
        errors: res.errors,
        bundleLabel: res.bundleLabel,
      });
      setGhUrl("");
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGhBusy(false);
    }
  };

  // The local-folder picker card — rendered inside the "本地" tab when tabs are
  // showing, and above the empty state when no external skills were found at
  // all (so the local-import path stays discoverable in either case).
  const hasLocalPick = localDir != null || localFile != null;
  const localPicker = (
    <div className="rounded border border-edge bg-surface/40 p-2">
      <div className="flex items-center gap-2">
        <IconFolder size={14} className="shrink-0 text-content-subtle" />
        <span className="text-[0.7143em] font-medium text-content-muted">
          {t("settings.skills.localFolder")}
        </span>
        <div className="flex-1" />
        {hasLocalPick ? (
          <button
            type="button"
            onClick={clearLocalFolder}
            className="text-[0.7143em] text-content-subtle hover:text-content"
          >
            {t("settings.skills.clear")}
          </button>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {hasLocalPick ? (
          <div className="min-w-0 flex-1 space-y-1">
            {localDir && (
              <span
                className="block truncate rounded bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-subtle"
                title={localDir}
              >
                {localDir}
              </span>
            )}
            {localFile && (
              <span
                className="block truncate rounded bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-subtle"
                title={localFile}
              >
                {localFile}
              </span>
            )}
          </div>
        ) : (
          <span className="min-w-0 flex-1 text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.skills.localFolderHint")}
          </span>
        )}
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void pickLocalFolder()}
            disabled={loading}
            className="gap-1"
          >
            <IconFolder size={12} />
            {t("settings.skills.chooseFolder")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void pickLocalFile()}
            disabled={loading}
            className="gap-1"
          >
            <IconFileText size={12} />
            {t("settings.skills.chooseFile")}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">{t("settings.skills.importTitle")}</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.skills.importDesc1")}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
          </Dialog.Description>
          <Dialog.Close />

          {/* Body: GitHub package import + tab strip + scrollable skill list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* ── GitHub package import — independent of the tab flow below:
                one repo URL, one bundle, no per-skill picking. ── */}
            <div className="mb-3 rounded border border-edge bg-surface/40 p-2">
              <div className="text-[0.7143em] font-medium text-content-muted">
                {t("settings.skills.githubTitle")}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="text"
                  value={ghUrl}
                  onChange={(e) => setGhUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void doGithubImport();
                  }}
                  placeholder={t("settings.skills.githubPlaceholder")}
                  disabled={ghBusy}
                  className="h-7 min-w-0 flex-1 rounded border border-edge bg-surface px-2 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void doGithubImport()}
                  disabled={ghBusy || !ghUrl.trim()}
                  className="shrink-0 gap-1"
                >
                  {ghBusy && <IconLoader2 size={12} className="animate-spin" />}
                  {ghBusy ? t("settings.skills.githubImporting") : t("settings.skills.githubImportBtn")}
                </Button>
              </div>
              {ghResult && (
                <div className="mt-1.5 space-y-0.5 text-[0.7143em]">
                  {ghResult.imported.length > 0 && (
                    <p className="text-accent">
                      {t("settings.skills.githubDone", {
                        n: ghResult.imported.length,
                        bundle: ghResult.bundleLabel ?? "",
                      })}
                      {" "}
                      <span className="text-content-subtle">
                        ({ghResult.imported.join(", ")})
                      </span>
                    </p>
                  )}
                  {ghResult.skipped.length > 0 && (
                    <p className="text-content-subtle">
                      {t("settings.skills.githubSkip", { n: ghResult.skipped.length, list: ghResult.skipped.join(", ") })}
                    </p>
                  )}
                  {ghResult.errors.length > 0 && (
                    <p className="text-danger">
                      {t("settings.importResultFailed", {
                        n: ghResult.errors.length,
                        list: ghResult.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
            {loading ? (
              <LoadingNote label={t("settings.scanning")} />
            ) : sources.length === 0 ? (
              <div className="space-y-3">
                {localPicker}
                <EmptyState
                  className="py-8"
                  title={t("settings.skills.importEmpty1")}
                  desc={
                    <>
                      {t("settings.skills.importEmpty2a")}
                      {t("settings.skills.importEmpty2b")}
                    </>
                  }
                />
              </div>
            ) : (
              <div className="space-y-2">
                {/* ── Tab strip: one tab per agent, 本地 always present ──
                    Selection is global across tabs; each tab shows its total
                    count and (in accent) how many of them are picked. */}
                <div
                  role="tablist"
                  aria-label={t("settings.skills.importTitle")}
                  className="flex items-center gap-0.5 border-b border-edge"
                >
                  {tabs.map((tool) => {
                    const items = grouped[tool] ?? [];
                    const picked = items.filter((s) => selected.has(s.sourcePath)).length;
                    const isActive = tool === activeTool;
                    return (
                      <button
                        key={tool}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        tabIndex={isActive ? 0 : -1}
                        onKeyDown={moveTabFocus}
                        onClick={() => setActiveToolRaw(tool)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 transition-colors",
                          isActive
                            ? "border-accent bg-surface text-content"
                            : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
                        )}
                      >
                        <span
                          className={cn(
                            "rounded px-1 text-[10px] font-medium leading-tight",
                            TOOL_BADGE_CLS[tool],
                          )}
                        >
                          {tool === "local" ? t("settings.skills.toolLocal") : TOOL_LABELS[tool]}
                        </span>
                        <span className="tabular-nums text-[0.7143em] text-content-subtle">
                          {items.length}
                        </span>
                        {picked > 0 && (
                          <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-medium leading-tight text-accent tabular-nums">
                            {picked}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* The folder picker lives in the 本地 tab (it's that tab's
                    source selector), not above the whole list. */}
                {activeTool === "local" && localPicker}

                {activeItems.length > 0 ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-[0.7143em] text-content-subtle">
                        {t("settings.skills.skillCount", { n: activeItems.length })}
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={toggleSelectAllForActive}
                        disabled={importableItems.length === 0}
                        className="text-[0.7143em] text-accent hover:underline disabled:text-content-subtle disabled:no-underline"
                      >
                        {allActiveSelected
                          ? t("settings.skills.deselectAll")
                          : t("settings.skills.selectAll")}
                      </button>
                    </div>
                    <div className="space-y-0.5">
                      {activeItems.map((s) => {
                        const isExisting = existing.has(s.name);
                        const isChecked = selected.has(s.sourcePath);
                        return (
                          <label
                            key={s.sourcePath}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors",
                              isExisting
                                ? "opacity-50"
                                : isChecked
                                  ? "bg-accent/8"
                                  : "hover:bg-surface-hover/60",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isExisting}
                              onChange={() => toggle(s.sourcePath)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-[0.7857em] font-medium text-content">
                                  {s.name}
                                </span>
                                {isExisting && (
                                  <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] text-content-subtle">
                                    {t("settings.importExisting")}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-[0.7143em] text-content-subtle">
                                {s.description || t("settings.skills.noDesc")}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  // Only reachable on the 本地 tab before a folder is picked.
                  <EmptyState className="py-6" title={t("settings.skills.localTabEmpty")} />
                )}
              </div>
            )}

            {/* Import result summary */}
            {result && (
              <div className="mt-3 rounded border border-edge bg-surface/40 p-2 text-[0.7143em]">
                {result.imported.length > 0 && (
                  <p className="text-accent">
                    {t("settings.importResultImported", { n: result.imported.length, list: result.imported.join(", ") })}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-content-subtle">
                    {t("settings.importResultSkipped", { n: result.skipped.length, list: result.skipped.join(", ") })}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="text-danger">
                    {t("settings.importResultFailed", {
                      n: result.errors.length,
                      list: result.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                    })}
                  </p>
                )}
              </div>
            )}

            {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
          </div>

          {/* Footer: selected count + actions */}
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <span className="text-[0.7143em] text-content-subtle">
              {selectedCount > 0 ? t("settings.importSelectedCount", { n: selectedCount }) : ""}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={close} disabled={importing}>
              {result ? t("common.close") : t("common.cancel")}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void doImport()}
                disabled={importing || selectedCount === 0}
              >
                {importing
                  ? t("settings.importing")
                  : `${t("settings.importBtn")}${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
