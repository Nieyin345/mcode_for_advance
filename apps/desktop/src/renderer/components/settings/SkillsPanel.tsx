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
import { Button, ConfirmDialog, Dialog, ErrorNote } from "@renderer/components/ui/index.js";
import { ListPane } from "./ListPane.js";
import { PanelHeader } from "./PanelHeader.js";
import { ScopeTabs } from "./ScopeTabs.js";
import { SkillMarketView } from "./SkillMarketView.js";
import { ProjectSkillsView } from "./ProjectSkillsView.js";
import { SkillNodesView } from "./SkillNodesView.js";
import { SkillPresetsView } from "./SkillPresetsView.js";
import { SkillProjectOverview } from "./SkillProjectOverview.js";
import {
  IconPlus,
  IconTrash,
  IconSparkles,
  IconDownload,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import type {
  SkillInfo,
  SkillSource,
  ReadOnlySkillSource,
  SkillEngineState,
  SkillBundle,
} from "@contracts/ipc";
import { SKILL_NAME_RE } from "@contracts/ipc";
// 子组件从 `SkillsPanelParts.tsx` 拆出（纯搬迁，见那边文件头）。
import { SourceBadge, EmptyDetail, SkillSourceEditor, NewSkillForm, ImportSkillsDialog } from "@renderer/components/settings/SkillsPanelParts.js";

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
export function isReadOnlySkill(source: SkillSource): source is ReadOnlySkillSource {
  return source === "plugin" || source === "builtin";
}

type Selection =
  | ({ kind: "skill" } & SkillTarget)
  | { kind: "new" }
  | null;

export interface NewForm {
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

/** True when the skill's plugin is switched off for `e` at plugin level
 *  (Plugins panel) — the skill's own matrix flag can't override that. */
function pluginBlocks(s: { pluginEngines?: SkillEngineState }, e: MatrixEngine): boolean {
  return s.pluginEngines?.[e] === false;
}

export function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>): void {
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
  const { t } = useI18n();
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-0.5">
      {MATRIX_ENGINES.map((e) => {
        const allOn = skills.every((s) => s.perEngine?.[e] !== false);
        const blocked = skills.length > 0 && skills.every((s) => pluginBlocks(s, e));
        return (
          <Button variant="ghost" size={null}
            key={e}
            type="button"
            disabled={busy}
            title={blocked ? t("settings.skills.pluginEngineOff", { engine: engineLabel(e) }) : engineLabel(e)}
            onClick={(ev) => {
              // The switches sit inside the collapsible group title — clicking
              // one must not toggle the group's fold state.
              ev.stopPropagation();
              onToggle(e, !allOn);
            }}
            className={cn(
              "rounded px-1 leading-4 text-[9px] font-semibold transition-colors",
              allOn && !blocked ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "text-content-subtle/50 line-through hover:text-content-subtle",
              blocked && "border border-dashed border-warning/60",
              busy && "opacity-50",
            )}
          >
            {e === "claude" ? "C" : e === "codex" ? "X" : "P"}
          </Button>
        );
      })}
    </span>
  );
}

/** Per-ROW engine switches —— 和组级那排同一个形状(`C / X / P`),但只作用于这一条。
 *
 *  为什么行上也要有一份:引擎权限以前**只在右侧编辑区**出现 —— 而右侧要先选中一条
 *  才看得到,所以"这条技能给不给 Codex 用"这件事在列表上完全不可见,用户的原话是
 *  「不能单独控制一个 skill 的引擎权限」。行上这排是**看得见**的那一份;右侧那套
 *  保留不动(两处改同一份数据、走同一个 `setSkillEngines`)。
 *
 *  不可矩阵管理的行(项目技能、内置)不渲染 —— 与组级开关同一条判据。 */
function RowEngineSwitches({
  skill,
  busy,
  onToggle,
}: {
  skill: SkillInfo;
  busy: boolean;
  onToggle: (engine: MatrixEngine, want: boolean) => void;
}) {
  const { t } = useI18n();
  if (!skill.perEngine) return null;
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-0.5" data-testid="skill-row-engines">
      {MATRIX_ENGINES.map((e) => {
        const on = skill.perEngine?.[e] !== false;
        const blocked = pluginBlocks(skill, e);
        return (
          <Button variant="ghost" size={null}
            key={e}
            type="button"
            disabled={busy}
            // 点开关不能顺带打开右侧编辑器 —— 两者是两件事(和勾选框同一个道理)。
            onClick={(ev) => {
              ev.stopPropagation();
              onToggle(e, !on);
            }}
            title={blocked ? t("settings.skills.pluginEngineOff", { engine: engineLabel(e) }) : engineLabel(e)}
            aria-label={`${engineLabel(e)} · ${skill.name}`}
            aria-pressed={on && !blocked}
            className={cn(
              "rounded px-1 leading-4 text-[9px] font-semibold transition-colors",
              on && !blocked ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "text-content-subtle/50 line-through hover:text-content-subtle",
              blocked && "border border-dashed border-warning/60",
              busy && "opacity-50",
            )}
          >
            {e === "claude" ? "C" : e === "codex" ? "X" : "P"}
          </Button>
        );
      })}
    </span>
  );
}

/** 把一批技能**同一个引擎**的开关一起翻成 `want`，其余两个引擎保持各自现状。
 *
 *  批量 RPC（`enginesSetBulk`）只收一个统一的 `{claude,codex,pi}` 三元组，所以先把
 *  这批按"翻完之后的最终状态"分组，每组发一条 —— 这样每条技能另外两个引擎的现状
 *  不被误改。组级开关和勾选批量都走这一份实现（仓库硬规矩：共享实现只有一份）。 */
async function writeEnginesPartitioned(
  skills: SkillInfo[],
  engine: keyof SkillEngineState,
  want: boolean,
): Promise<void> {
  const byState = new Map<string, { names: string[]; state: SkillEngineState }>();
  for (const s of skills) {
    const state = { ...(s.perEngine ?? { claude: true, codex: true, pi: true }), [engine]: want };
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
  const [view, setView] = useState<"library" | "project" | "nodes" | "market">("library");
  // The market pane mounts on first visit and then stays (search text, the
  // fetched catalogs and the active source survive tab switches).
  const [marketSeen, setMarketSeen] = useState(false);
  const [marketCount, setMarketCount] = useState(0);
  useEffect(() => {
    if (view === "market") setMarketSeen(true);
  }, [view]);
  /** 总库那一栏勾选的技能名 —— 「复制到项目」的源。跨 tab 保留（用户在总库勾完
   *  切到项目 tab 按按钮是**预期用法**，切一下就把勾清掉会让那条路走不通）。 */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  /** 总库列表的搜索词(名字 / 描述 / 来源插件)。有词时所有组展开。 */
  const [query, setQuery] = useState("");
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
  /** 一个包里**能勾选**的那些技能的 name（只有通用库那份能勾选复制 —— 与行的判据同一份：
   *  项目里的已经在项目里、插件那份是别人管的）。整包勾选就是一次勾上这一组。 */
  const groupSelectable = useCallback((skills: SkillInfo[]): string[] => {
    return skills.filter((s) => s.source === "global").map((s) => s.name);
  }, []);
  const groupAllChecked = useCallback((skills: SkillInfo[]): boolean => {
    const names = groupSelectable(skills);
    return names.length > 0 && names.every((n) => checked.has(n));
  }, [groupSelectable, checked]);
  const groupSomeChecked = useCallback((skills: SkillInfo[]): boolean => {
    const names = groupSelectable(skills);
    return names.some((n) => checked.has(n)) && !names.every((n) => checked.has(n));
  }, [groupSelectable, checked]);
  /** 整包勾选开关：全选了就整包清空，否则整包勾上。 */
  const toggleGroupChecked = useCallback((skills: SkillInfo[]): void => {
    const names = groupSelectable(skills);
    if (names.length === 0) return;
    setChecked((prev) => {
      const next = new Set(prev);
      const all = names.every((n) => next.has(n));
      for (const n of names) {
        if (all) next.delete(n);
        else next.add(n);
      }
      return next;
    });
  }, [groupSelectable]);

  // The global inventory must not use composer precedence: a project copy
  // with the same name must never hide the independently editable global one.
  const library = useRpc(() => api.skills.list({}), [], { toastOnError: false });
  const bundleQuery = useRpc(() => api.skills.bundles({}), [], { toastOnError: false });
  const panelSkills = library.data?.skills ?? EMPTY_PANEL_SKILLS;
  const q = query.trim().toLowerCase();
  const visibleSkills = useMemo(
    () =>
      q
        ? panelSkills.filter((s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            (s.pluginName ?? "").toLowerCase().includes(q),
          )
        : panelSkills,
    [panelSkills, q],
  );
  const listLoading = library.loading;
  const bundles = bundleQuery.data?.bundles ?? EMPTY_BUNDLES;
  /** 【MC-053 同族】导入包清单读不懂(导入/市场安装会拒绝改写它)。 */
  const bundlesCorrupt = bundleQuery.data?.corrupt?.reason ?? null;
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
    // ⚠️ **与上面 `expanded` 那条同款守卫。** `localStorage` 在读时也可能抛
    // (`SecurityError`:存储被禁用 / 嵌入式上下文),而这里跑在 `useState` 初始化器里
    // —— 抛出去就是整块面板渲染不出来。缺守卫时,一个禁用了存储的环境打开「技能」页
    // 会白屏;上面那条早就 guard 了,这条漏了。
    try {
      const v = Number(localStorage.getItem("mcode.skills.leftW"));
      return Number.isFinite(v) && v >= 160 && v <= 480 ? v : 220;
    } catch {
      return 220;
    }
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
  // ── 勾选批量的删除确认。勾选本来是「复制到项目」的源，2026-10-11 起也用来
  //    批量切引擎 / 批量删除（用户：「每个集合没有批量管理，批量选择」）。
  const [pendingCheckedDelete, setPendingCheckedDelete] = useState(false);

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
      for (const s of visibleSkills) {
        // **项目技能单独一组，不按导入包分。** 它们不属于任何一次导入，混进
        // "未分组"会让那个名字骗人 —— 用户明明是从项目目录来的，却被说成
        // "没归类"。而且项目那一栏才是它们的归属地，这里要一眼看得出来。
        if (s.source === "project") {
          push("project", t("settings.skills.tabProject"), s);
          continue;
        }
        if (s.source === "plugin") {
          // 按插件分子组:插件一多,混成一组就看不出哪个技能是哪个插件带来的。
          push(
            s.pluginName ? `plugin:${s.pluginName}` : "plugin",
            s.pluginName ? `${t("settings.skills.groupPlugin")} · ${s.pluginName}` : t("settings.skills.groupPlugin"),
            s,
          );
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
        if (id === "plugin" || id.startsWith("plugin:")) return -1;
        if (id.startsWith("bundle:")) {
          const i = bundles.findIndex((b) => `bundle:${b.id}` === id);
          return i >= 0 ? i : bundles.length;
        }
        if (id === "ungrouped") return bundles.length + 1;
        return Number.MAX_SAFE_INTEGER;
      };
      return groups.sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.label.localeCompare(b.label));
    }
    for (const s of visibleSkills) {
      // 按引擎分组这一档里，项目技能按自己的 `perEngine` 走（主进程不给它挂矩阵，
      // 所以 `pe` 缺席 → 视为三引擎全开），与通用库同一个规则。
      const pe = s.perEngine;
      const on = (pe ? MATRIX_ENGINES.filter((e) => pe[e]) : [...MATRIX_ENGINES]).filter((e) => !pluginBlocks(s, e));
      if (on.length === MATRIX_ENGINES.length) {
        push("universal", t("settings.skills.groupUniversal"), s);
      } else if (on.length === 1) {
        push(`internal:${on[0]}`, t("settings.skills.groupInternal", { engine: engineLabel(on[0]) }), s);
      } else {
        push(`shared:${on.join(",")}`, on.map(engineLabel).join(" · "), s);
      }
    }
    return groups.sort((a, b) => groupRank(a.id) - groupRank(b.id));
  }, [visibleSkills, t, groupMode, bundles, bundleOf]);

  const [selected, setSelected] = useState<Selection>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [readVersion, setReadVersion] = useState(0);
  const editorKey = selected?.kind === "skill"
    ? JSON.stringify([selected.source, selected.name, selected.projectPath ?? null, readVersion]) : null;
  const sourceQuery = useRpc(async () => {
    if (!selected || selected.kind !== "skill") throw new Error("没有选中的技能");
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
      await writeEnginesPartitioned(editable, engine, want);
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      matrixBusyRef.current = false;
      setBulkBusy(false);
    }
  };

  /** 勾选的多条一起切一个引擎 —— 行上那排开关的批量版。用户原话：「每个集合没有
   *  批量管理，批量选择」。只有矩阵管得着的（通用库 + 插件）参与；项目技能不进矩阵。
   *  走的是和组级同一个 `writeEnginesPartitioned` —— 一份实现，「用户点的」和
   *  「组级按钮点的」不会分叉。 */
  const setCheckedEngines = async (engine: MatrixEngine, want: boolean) => {
    if (matrixBusyRef.current) return;
    const editable = panelSkills.filter(
      (s) => checked.has(s.name) && (s.source === "global" || s.source === "plugin"),
    );
    if (!editable.length) return;
    matrixBusyRef.current = true;
    setBulkBusy(true);
    setError(null);
    try {
      await writeEnginesPartitioned(editable, engine, want);
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      matrixBusyRef.current = false;
      setBulkBusy(false);
    }
  };

  /** 勾选的多条一起删。只删通用库那几条（项目/插件/内置不归这一页管，同组级删除的
   *  判据）；一个 IPC 一条，失败如实计数、不中断其余。 */
  const confirmCheckedDelete = async () => {
    if (mutationBusyRef.current) return;
    const deletable = panelSkills.filter((s) => checked.has(s.name) && s.source === "global");
    if (!deletable.length) return;
    mutationBusyRef.current = true;
    setBulkBusy(true);
    setError(null);
    setPendingCheckedDelete(false);
    const failures: string[] = [];
    const removed = new Set<string>();
    try {
      for (const skill of deletable) {
        try {
          const res = await api.skills.delete({ source: "global", name: skill.name });
          if (res.ok) removed.add(skill.name);
          else failures.push(`${skill.name}: ${res.error ?? t("settings.deleteFailed")}`);
        } catch (err) {
          failures.push(`${skill.name}: ${(err as Error).message}`);
        }
      }
      if (removed.size) setChecked((prev) => new Set([...prev].filter((n) => !removed.has(n))));
      if (failures.length) setError(failures.join("; "));
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      mutationBusyRef.current = false;
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
      pluginEngines={selectedInfo?.pluginEngines}
      pluginName={selectedInfo?.pluginName}
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
        title={t("settings.skills.pageTitle")}
        action={
          <ScopeTabs
            items={[
              { id: "library", label: t("settings.skills.tabLibrary"), count: panelSkills.length },
              { id: "project", label: t("settings.skills.tabProject"), count: projectSkills.length },
              { id: "nodes", label: t("settings.skills.tabNodes") },
              { id: "market", label: t("settings.market.tab"), count: marketCount },
            ]}
            value={view}
            onChange={setView}
          />
        }
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
      {bundlesCorrupt !== null && (
        <ErrorNote tone="warning" className="mb-3" title={t("settings.skills.bundlesCorrupt")}>
          {bundlesCorrupt}
        </ErrorNote>
      )}
      {error && (selected === null || (view !== "library" && !(selected.kind === "skill" && selected.source === "project"))) && (
        <ErrorNote className="mb-3">{error}</ErrorNote>
      )}

      {/* 四个 tab(总库 / 项目 / 节点 / 市场)在标题栏右侧,和 MCP、插件两页同一条
          `ScopeTabs`。⚠️ 面板用 `hidden` **类**藏,不用 `hidden` **属性** —— 那个 div
          同时带 `flex`,而 preflight 的 `[hidden]{display:none}` 与 `.flex` 同特异性又
          排在 utilities 之前,属性会输、两块一起显示(仓库既有做法见 `PluginsPanel`)。 */}
      {marketSeen && (
        <SkillMarketView
          className={cn("min-h-0 flex-1 overflow-auto pr-1", view === "market" ? "" : "hidden")}
          visible={view === "market"}
          onCountChange={setMarketCount}
          onInstalled={() => void refreshAfterMutation()}
        />
      )}

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
          onJumpToWorkflow={(workflowId) => {
            // 跳到「工作流」那一页,**并把要打开的那一份 id 带过去** ——
            // `WorkflowLibraryView` 挂载后选中它、用完即清。不传的话那边停在空编辑器,
            // 用户得自己在一长串列表里再找一遍(这正是反查点进来时最不想做的事)。
            useSessionStore.getState().setSettingsOpen(true, "workflows", workflowId);
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

      {/* ── 勾选批量条：勾了东西才出现。勾选本来只服务「复制到项目」，2026-10-11
          起也能**批量切引擎 / 批量删除**（用户：「每个集合没有批量管理，批量选择」）。
          放在左栏之上：勾选发生在列表里，操作就在旁边。 ── */}
      {view === "library" && checked.size > 0 && (
        <div
          data-testid="skills-bulk-bar"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-edge bg-surface/60 px-3 py-1.5"
        >
          <span className="text-[0.8571em] font-medium text-content-muted">
            {t("settings.skills.bulkSelected", { n: checked.size })}
          </span>
          <span className="ml-1 text-[0.7857em] text-content-subtle">
            {t("settings.skills.bulkEngines")}
          </span>
          <span className="inline-flex items-center gap-0.5">
            {MATRIX_ENGINES.map((e) => {
              // 「全开 / 全关」：这一批里只要有没开的就算"打开"，否则"关闭"。
              const anyOff = panelSkills.some(
                (s) => checked.has(s.name) && s.perEngine?.[e] === false,
              );
              return (
                <Button variant="ghost" size={null}
                  key={e}
                  type="button"
                  disabled={bulkBusy}
                  data-bulk-engine={e}
                  title={engineLabel(e)}
                  onClick={() => void setCheckedEngines(e, anyOff)}
                  className={cn(
                    "rounded border border-edge px-1.5 py-0.5 text-[0.7857em] transition-colors",
                    "hover:bg-surface-hover/60 disabled:opacity-50",
                  )}
                >
                  {engineLabel(e)}
                </Button>
              );
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="skills-bulk-delete"
            disabled={bulkBusy}
            onClick={() => setPendingCheckedDelete(true)}
            className="ml-auto gap-1 text-danger hover:bg-danger/10"
          >
            <IconTrash size={12} />
            {t("settings.skills.bulkDelete")}
          </Button>
          <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={() => setChecked(new Set())}>
            {t("settings.skills.clearSelection")}
          </Button>
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
            className="absolute -right-2 top-0 z-10 h-full w-2 cursor-col-resize transition-colors hover:bg-surface-hover"
          />
          }
          title={
            <>
              <span>Skills</span>
              {/* 全选 / 清空 —— 勾选是「复制到项目」的源，所以这两个按钮只在有东西
                  可勾时出现。放在这里而不是底部：勾选发生在列表里，操作也该在附近。 */}
              {checked.size > 0 ? (
                <Button variant="ghost" size={null}
                  type="button"
                  onClick={() => setChecked(new Set())}
                  className="rounded px-1.5 py-0.5 text-[0.9em] font-normal text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
                >
                  {t("settings.skills.clearSelection")}
                </Button>
              ) : (
                <Button variant="ghost" size={null}
                  type="button"
                  onClick={selectAllCopyable}
                  className="rounded px-1.5 py-0.5 text-[0.9em] font-normal text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
                >
                  {t("settings.skills.selectAll")}
                </Button>
              )}
            </>
          }
          actions={
            <>
              {/* Grouping mode: bundle (by source) is the default — it answers
                  "这是什么、从哪来的" and carries the group switches. */}
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => setGroupMode("bundle")}
                className={cn(
                  "rounded px-1.5 py-0.5 normal-case tracking-normal transition-colors",
                  groupMode === "bundle" ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "hover:text-content",
                )}
              >
                {t("settings.skills.modeBundle")}
              </Button>
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => setGroupMode("engine")}
                className={cn(
                  "rounded px-1.5 py-0.5 normal-case tracking-normal transition-colors",
                  groupMode === "engine" ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "hover:text-content",
                )}
              >
                {t("settings.skills.modeEngine")}
              </Button>
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
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.skills.searchPlaceholder")}
              aria-label={t("settings.skills.searchPlaceholder")}
              className="mb-1 mt-0.5 w-full rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
            />
            {q && visibleSkills.length === 0 && (
              <div className="px-2 py-4 text-center text-[0.7857em] text-content-subtle">
                {t("settings.skills.searchEmpty", { query: query.trim() })}
              </div>
            )}
            {selected?.kind === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t("settings.skills.newSkill")}
              </div>
            )}
            {groupedSkills.map((g) => {
              const isCollapsed = !q && !expanded.has(g.id);
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
                  {/* 整包勾选 —— 只对**可勾选**的（通用库）行有意义。用户原话：
                      「选择一个包里面的所有 skill 只能一个个点」。勾这个框 = 选中该包里
                      全部可勾选的技能（供批量复制 / 切引擎 / 删除用）；再点一次清空该包。
                      `indeterminate` 表示包内选中了一部分。放在组标题上、且在折叠状态下
                      也显示 —— 折着就能整包勾，不用先展开。 */}
                  {groupMode === "bundle" && groupSelectable(g.skills).length > 0 && (
                    <input
                      type="checkbox"
                      checked={groupAllChecked(g.skills)}
                      ref={(el) => {
                        if (el) el.indeterminate = groupSomeChecked(g.skills);
                      }}
                      onChange={() => toggleGroupChecked(g.skills)}
                      // 点勾不能顺带折叠/展开这个组（父 div 是 role=button）。
                      onClick={(e) => e.stopPropagation()}
                      className="ml-1 h-3.5 w-3.5 shrink-0 accent-accent"
                      title={t("settings.skills.groupSelectTitle")}
                      aria-label={`${t("settings.skills.groupSelectTitle")} · ${g.label}`}
                    />
                  )}
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
                      <Button variant="ghost" size={null}
                        type="button"
                        onClick={() => startEdit(s)}
                        disabled={saving || deleting || bulkBusy}
                        className="min-w-0 flex-1 flex-col items-stretch justify-start text-left"
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
                      </Button>
                      {/* 这一条的引擎权限,不用点开右侧编辑器就能看见、能改。
                          ⚠️ **必须在那个 `<button>` 外面**：button 不能套 button。 */}
                      <RowEngineSwitches
                        skill={s}
                        busy={bulkBusy || engineBusyName === s.name}
                        onToggle={(engine) => {
                          if (s.perEngine) void setSkillEngines(s.name, s.perEngine, engine);
                        }}
                      />
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

      <ConfirmDialog
        open={pendingCheckedDelete}
        title={t("settings.skills.bulkDelete")}
        danger
        description={t("settings.skills.bulkDeleteDesc", {
          n: panelSkills.filter((s) => checked.has(s.name) && s.source === "global").length,
        })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingCheckedDelete(false);
        }}
        onConfirm={() => void confirmCheckedDelete()}
      />
    </div>
  );
}
