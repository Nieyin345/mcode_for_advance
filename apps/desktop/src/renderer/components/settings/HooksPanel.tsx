/**
 * 设置 → 钩子。
 *
 * ## 这一页面朝谁
 *
 * 面朝**想让自己这套环境按自己的规矩运转的人**:某个工具跑完自动格式化、一轮结束把
 * 结果追加到一个日志、出错时弹个提醒。钩子不属于任何一张图 —— 它对每一次对话、每一个
 * 工作流节点、将来的每一条自动化都生效(机制见 `@contracts/hook`)。
 *
 * ## 为什么是"显式保存"而不是像工作流那样自动保存
 *
 * 工作流那边打字即落盘,因为它改的是一份**数据**;这里改的是**要在这台机器上执行的
 * 命令**。边打字边存意味着你打到一半的那半条命令会先被保存下来、并且在下一个事件上
 * 真的跑起来 —— 这不是"保存得早",这是"跑了一条我没写完的命令"。所以:改动留在草稿里,
 * 按保存才落盘。
 *
 * ## 三块内容
 *
 * 1. **左边**:已有的钩子(名字、事件、开关)。**开关是立即生效的** —— 它是个开关,
 *    不是一个待保存的字段。
 * 2. **右边**:选中那条的编辑区,加「试跑」。
 * 3. **下边**:最近的执行记录。**它们不在对话里**(理由见 `@contracts/hook` 的
 *    `HookRun`),这一页是唯一能看到"我的钩子到底跑了没有"的地方,所以它常驻在下面,
 *    而不是藏进另一个页签。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, EmptyState, ErrorNote, Field, InfoHint, Input, Select, Switch } from "@renderer/components/ui/index.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  HookSpecSchema,
  hookActionOf,
  hookSubjectOf,
  type HookAuditEntry,
  type HookEvent,
  type HookRun,
  type HookSpec,
  type HookSubject,
} from "@contracts/hook";
import {
  IconActivity,
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { ListPane } from "./ListPane.js";
import {
  formatRunTime,
  hookDraftProblem,
  hookEventUnsupportedBy,
  HOOK_ENGINE_LABEL,
  isHookDirty,
  newHookDraft,
  type HookEngineId,
} from "./hooksView.js";
import { Textarea } from "@renderer/components/ui/textarea.js";

/**
 * 事件 → 词条。**两张表都标成 `MessageId` 而不是 `string`** —— 那样键名写错时 tsc
 * 会当场拦下。这一页有好几处 `t(某表[变量])`,而那种查表是**类型系统唯一能帮上忙的
 * 地方**:写成 `string` 再 `as MessageId`,拼错的键会一路走到运行时,界面上只留下一个
 * 原样的 key(`settings.hooks.event.toolUs`)。
 */
const EVENT_LABELS: Record<HookEvent, MessageId> = {
  "user.message": "settings.hooks.event.userMessage",
  "tool.use": "settings.hooks.event.toolUse",
  "tool.result": "settings.hooks.event.toolResult",
  "approval.request": "settings.hooks.event.approvalRequest",
  "request.resolved": "settings.hooks.event.requestResolved",
  "question.ask": "settings.hooks.event.questionAsk",
  "plan.approval_request": "settings.hooks.event.planApprovalRequest",
  "todo.update": "settings.hooks.event.todoUpdate",
  "subagent.update": "settings.hooks.event.subagentUpdate",
  "turn.files": "settings.hooks.event.turnFiles",
  "turn.incomplete": "settings.hooks.event.turnIncomplete",
  "turn.done": "settings.hooks.event.turnDone",
  "compact.result": "settings.hooks.event.compactResult",
  error: "settings.hooks.event.error",
  "upstream.issue": "settings.hooks.event.upstreamIssue",
  "workflow.node.result": "settings.hooks.event.workflowNodeResult",
  "library.item.imported": "settings.hooks.event.libraryItemImported",
  "library.item.downloaded": "settings.hooks.event.libraryItemDownloaded",
};

/** 每种事件那句"什么时候跑"的解释。见词条里为什么逐条写。 */
const EVENT_HINTS: Record<HookEvent, MessageId> = {
  "user.message": "settings.hooks.eventHint.userMessage",
  "tool.use": "settings.hooks.eventHint.toolUse",
  "tool.result": "settings.hooks.eventHint.toolResult",
  "approval.request": "settings.hooks.eventHint.approvalRequest",
  "request.resolved": "settings.hooks.eventHint.requestResolved",
  "question.ask": "settings.hooks.eventHint.questionAsk",
  "plan.approval_request": "settings.hooks.eventHint.planApprovalRequest",
  "todo.update": "settings.hooks.eventHint.todoUpdate",
  "subagent.update": "settings.hooks.eventHint.subagentUpdate",
  "turn.files": "settings.hooks.eventHint.turnFiles",
  "turn.incomplete": "settings.hooks.eventHint.turnIncomplete",
  "turn.done": "settings.hooks.eventHint.turnDone",
  "compact.result": "settings.hooks.eventHint.compactResult",
  error: "settings.hooks.eventHint.error",
  "upstream.issue": "settings.hooks.eventHint.upstreamIssue",
  "workflow.node.result": "settings.hooks.eventHint.workflowNodeResult",
  "library.item.imported": "settings.hooks.eventHint.libraryItemImported",
  "library.item.downloaded": "settings.hooks.eventHint.libraryItemDownloaded",
};

/**
 * 匹配规则那一栏的**标题、占位、说明**。
 *
 * ## 为什么还有一个 `path` 那一档(虽然现在没有事件用它)
 *
 * 三处的值都取自 `MATCHER_TEXT[主语]`,而主语是 `hookSubjectOf` 给的 —— 现在只有
 * `tool`(`hookSubjectOf` 里 `turn.files` 那一档没给主语,见那边的注)。**留着 `path`
 * 是对着那个类型写的**:`Record<HookSubject, …>` 少一档就编译不过,而哪天有事件真带上
 * 路径主语时,这里现成就能用 —— 那个输入框的标题写着"匹配哪些工具"、摆在比路径的钩子
 * 下面,是用户照着填错、钩子安静不响的最短路径。
 *
 * ⚠️ **`hint` 那一档现在没人读**(面板上没渲染它),但词条留着 —— 别以为它是死键删掉:
 * 删词条要连 zh/en 两份和 `MessageId` 那张表一起动,而它随时会被接回界面。
 */
const MATCHER_TEXT: Record<HookSubject, { label: MessageId; placeholder: MessageId; hint: MessageId }> = {
  tool: {
    label: "settings.hooks.matcherLabelTool",
    placeholder: "settings.hooks.matcherPlaceholderTool",
    hint: "settings.hooks.matcherHintTool",
  },
  path: {
    label: "settings.hooks.matcherLabelPath",
    placeholder: "settings.hooks.matcherPlaceholderPath",
    hint: "settings.hooks.matcherHintPath",
  },
};

/** 执行状态对应的颜色与词条。 */
const RUN_STATUS: Record<HookRun["status"], { cls: string; key: MessageId }> = {
  ok: { cls: "text-accent", key: "settings.hooks.runStatus.ok" },
  failed: { cls: "text-danger", key: "settings.hooks.runStatus.failed" },
  timeout: { cls: "text-warning", key: "settings.hooks.runStatus.timeout" },
  skipped: { cls: "text-content-subtle", key: "settings.hooks.runStatus.skipped" },
  running: { cls: "text-accent", key: "settings.hooks.runStatus.running" },
};

export function HooksPanel() {
  const { t } = useI18n();

  const [hooks, setHooks] = useState<HookSpec[] | null>(null);
  const [problems, setProblems] = useState<Array<{ where: string; error: string }>>([]);
  /** 【MC-051】`hooks.json` 的文件健康态 —— 整份损坏(corrupt/read_error)时普通保存
   *  会被拒,面板出「备份并重建」按钮;个别条目坏(problems 非空)不算整份损坏。 */
  const [fileHealth, setFileHealth] = useState<"missing" | "valid" | "corrupt" | "read_error">("valid");
  const [rebuilding, setRebuilding] = useState(false);
  /** 重建成功后的备份路径 —— 显式给用户看一眼(「你的原件在这里」)。 */
  const [rebuildBackup, setRebuildBackup] = useState<string | null>(null);
  const [runs, setRuns] = useState<HookRun[]>([]);
  /** 读「本次启动以来的执行」失败的原因。从前 catch 静默吞掉,runs 停在 `[]` ——
   *  一次读取失败与「一次都没跑过」在界面上长得一模一样(硬规矩 3)。 */
  const [runsError, setRunsError] = useState<string | null>(null);
  /** 【MC-061】落盘审计(跨重启活着;MC-010 起两种来源都落)—— 与 `runs` 那份内存环是两栏。 */
  const [audit, setAudit] = useState<HookAuditEntry[]>([]);
  /** 【MC-010 第四轮复审】审计读取失败的原因。「一次没执行」与「读不出来」必须**分开呈现**
   *  (从前 catch 成空数组,两种情形在界面上长得一模一样)。 */
  const [auditError, setAuditError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  /** 选中的那一条(磁盘上的)。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 编辑中的那一份。可能是**还没存过**的新钩子。 */
  const [draft, setDraft] = useState<HookSpec | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 存成功后闪一下 —— 显式保存必须有回执,否则用户会怀疑到底存没存。 */
  const [justSaved, setJustSaved] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testRun, setTestRun] = useState<HookRun | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const load = useCallback(async (): Promise<HookSpec[]> => {
    try {
      const res = await api.hooks.list();
      setHooks(res.hooks);
      setProblems(res.problems);
      setFileHealth(res.fileHealth ?? "valid"); // 旧 preload 没这个字段 → 当正常
      setListError(null);
      return res.hooks;
    } catch (err) {
      // 手机端的 web shim 里没有这个命名空间,而**访问未知命名空间是同步抛的**
      // (见 `lib/webApi.ts` 文件头)—— 必须是 try/catch,直接挂 `.then` 会让 React 19
      // 把整棵树卸载。钩子本来也只在桌面端有意义(它要在本机执行命令)。
      setListError((err as Error).message);
      setHooks([]);
      return [];
    }
  }, []);

  const loadRuns = useCallback(async (): Promise<void> => {
    try {
      const res = await api.hooks.runs();
      setRuns(res.runs);
      // 【MC-061】审计栏可能缺(旧 preload 没这一项时是 `undefined`)—— 退化成空,不炸。
      setAudit(res.audit ?? []);
      // 【MC-010】主进程读审计失败时把原因带出来(旧 preload 没有这个字段 → undefined → null)。
      setAuditError(res.auditError ?? null);
      setRunsError(null);
    } catch (err) {
      // 记录拉不到不影响编辑 —— 但**不能画成「还没有执行过」**:那是在替一次读取
      // 失败撒谎。原因显式报在记录栏里,「刷新记录」就是重试。
      setRunsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRuns();
  }, [load, loadRuns]);

  /** 【MC-051】显式「备份损坏原件 → 校验 → 重建」。默认把**当前读得出的条目**带进去
   *  (那些条目本来就读出来了,不必让用户重打);损坏原文先被备份成 `.bak` 才动。 */
  const rebuildCorrupt = useCallback(async (): Promise<void> => {
    setRebuilding(true);
    setSaveError(null);
    try {
      const res = await api.hooks.rebuildCorrupt({ hooks: hooks ?? [] });
      if (!res.ok) {
        setSaveError(res.error ?? t("settings.hooks.rebuildFailed"));
        return;
      }
      // 重建成功:重读一遍(健康态翻回 valid、按钮消失),并把备份路径显式告诉用户。
      await load();
      setSaveError(null);
      if (res.backupPath !== undefined) {
        setRebuildBackup(res.backupPath);
      }
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setRebuilding(false);
    }
  }, [hooks, load, t]);

  /** 选中一条:把草稿换成它。**不拦截未保存的改动** —— 钩子这一页没有自动保存,
   *  而"切走就丢"正是显式保存的语义(用户没按保存,就是不想要那些改动)。 */
  const select = (hook: HookSpec | null): void => {
    setSelectedId(hook?.id ?? null);
    setDraft(hook === null ? null : { ...hook });
    setSaveError(null);
    setTestRun(null);
    setJustSaved(false);
  };

  const create = (): void => {
    const next = newHookDraft();
    setSelectedId(next.id);
    setDraft(next);
    setSaveError(null);
    setTestRun(null);
    setJustSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.hooks.save({ hook: HookSpecSchema.parse(draft) });
      if (!res.ok) {
        setSaveError(res.error ?? t("settings.hooks.saveFailed"));
        return;
      }
      await load();
      setJustSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!draft) return;
    setSaveError(null);
    try {
      // `hooks.remove` 写盘失败时回 `{ok:false, error}`(见 `main/hooks/store.ts`
      // 的 `commitHooks` —— 临时文件写不进去 / 改名失败)。从前不看它:用户确认删除、
      // 编辑器被关掉、列表重拉后那条**还在**,而屏幕上没有任何一句话。
      const res = await api.hooks.remove({ id: draft.id });
      if (!res.ok) {
        setSaveError(t("settings.hooks.removeFailed", { error: res.error ?? "" }));
        return;
      }
      await load();
      select(null);
    } catch (err) {
      setSaveError((err as Error).message);
    }
  };

  /** 列表上那个开关:**立即落盘** —— 它是个开关,不是一个待保存的字段。
   *  正在编辑同一条时连草稿一起改,否则"未保存"会误报。 */
  const toggleEnabled = async (hook: HookSpec): Promise<void> => {
    const next = { ...hook, enabled: !hook.enabled };
    try {
      // `hooks.save` 写盘失败时回 `{ok:false, error}`。从前不看它:开关被乐观地拨过去、
      // 又 `load()` 重拉 → 开关**弹回原位**,用户以为"点了没反应";而正在编辑同一条时
      // 草稿的 `enabled` 也被改成了那个**从没落盘**的值。
      //
      // 走 toast 而不是 `setSaveError`:这个开关在**列表行**上,没选中任何一条时编辑器
      // 根本不渲染(`saveError` 也就没地方显示)—— 错误必须挂在一条**始终可见**的通道上。
      const res = await api.hooks.save({ hook: HookSpecSchema.parse(next) });
      if (!res.ok) {
        useToastStore.getState().push({
          kind: "error",
          title: t("settings.hooks.toggleFailed", { error: res.error ?? t("settings.hooks.saveFailed") }),
        });
        return;
      }
      await load();
      setDraft((cur) => (cur && cur.id === hook.id ? { ...cur, enabled: next.enabled } : cur));
    } catch (err) {
      useToastStore.getState().push({
        kind: "error",
        title: t("settings.hooks.toggleFailed", { error: (err as Error).message }),
      });
    }
  };

  const test = async (): Promise<void> => {
    if (!draft) return;
    setTesting(true);
    setTestRun(null);
    try {
      const res = await api.hooks.test({ hook: HookSpecSchema.parse(draft) });
      setTestRun(res.run);
      // 试跑不进记录环(它不是真事件),但**它可能触发别的钩子**——真事件才会。
      // 这里顺手刷一下记录,让"试跑把一个真钩子带起来了"也看得见。
      void loadRuns();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const authorize = async (): Promise<void> => {
    if (!draft) return;
    try {
      const res = await api.hooks.issueHostHookGrant({ hookId: draft.id });
      if (!res.ok) throw new Error(res.error ?? "授权失败");
      useToastStore.getState().push({ kind: "info", title: "代理/工作流动作已单独授权（24 小时）" });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const saved = hooks?.find((h) => h.id === selectedId);
  const dirty = draft !== null && isHookDirty(draft, saved);
  const draftProblem = draft ? hookDraftProblem(draft) : null;

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col", PANEL_MAX_W.form)}>
      <PanelHeader
        className="mb-3"
        icon={IconActivity}
        title={t("settings.nav.hooks")}
        action={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void loadRuns()} className="gap-1">
              <IconRefresh size={12} />
              {t("settings.hooks.refreshRuns")}
            </Button>
            <Button variant="secondary" size="sm" onClick={create} className="gap-1">
              <IconPlus size={12} />
              {t("settings.hooks.newHook")}
            </Button>
          </div>
        }
        hint={t("settings.hooks.intro")}
      />

      {/* H1/H2 的告知（**必须显式说出来**）：本页的钩子与引擎原生 hooks 是两套机制。
          用户在 Claude Code 的 ~/.claude/settings.json 里配过 hook，到 Mcode 里发现不跑，
          没有任何地方告诉他为什么（Mcode 把 CLAUDE_CONFIG_DIR 指到 ~/.mcode，原生 hook 读的
          是那一份）——这属于"坏东西不报出来"。隔离本身是刻意的，不改；缺的只是这句说明。
          同款左边框提示见 McpPanel 的 managedFileNote。 */}
      <p className="mb-3 border-l-2 border-warning/40 px-4 py-2 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("settings.hooks.nativeNote")}
      </p>

      {/* 文件里读得见、但用不了的条目。**必须说出来** —— 用户写的钩子不生效时,这一页
          是唯一能解释为什么的地方(同 `workflow.nodeTypes` 的 problems)。 */}
      {(problems.length > 0 || listError !== null || fileHealth === "corrupt" || fileHealth === "read_error" || rebuildBackup !== null) && (
        <ErrorNote tone={fileHealth === "corrupt" || fileHealth === "read_error" ? "danger" : "warning"} icon={IconAlertTriangle} className="mb-3">
          {listError !== null ? (
            /* 读失败必须有**重试**入口:从前只有一句横幅,想再读一次只能去保存/
               切换别的钩子,借那些操作间接重拉 —— 用户看不出"再试一次"这条路径。 */
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">{t("settings.hooks.loadFailed", { error: listError })}</div>
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => void load()}
                className="shrink-0 rounded border border-current px-2 py-0.5 hover:bg-surface-hover/60"
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
          {/* 【MC-051】整份文件损坏:普通保存会被拒(保住原字节),必须显式重建。 */}
          {(fileHealth === "corrupt" || fileHealth === "read_error") && (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                {t(fileHealth === "corrupt" ? "settings.hooks.fileCorrupt" : "settings.hooks.fileReadError")}
              </div>
              <Button variant="ghost" size={null}
                type="button"
                disabled={rebuilding}
                onClick={() => void rebuildCorrupt()}
                className="shrink-0 rounded border border-danger/40 px-2 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {rebuilding ? t("settings.hooks.rebuilding") : t("settings.hooks.rebuild")}
              </Button>
            </div>
          )}
          {rebuildBackup !== null && (
            <div className="text-content-subtle">{t("settings.hooks.rebuiltBackup", { path: rebuildBackup })}</div>
          )}
          {problems.map((p) => (
            <div key={`${p.where}:${p.error}`}>
              <span className="font-medium">{p.where}</span>:{p.error}
            </div>
          ))}
        </ErrorNote>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-4">
        {/* ───────── 左:钩子列表 ───────── */}
        {/* `hooks === null` = 还没回来。从前这一段是空白、计数写「…」，看起来像"没有钩子"。 */}
        <ListPane
          title={t("settings.hooks.listTitle")}
          count={hooks?.length}
          loading={hooks === null}
          // 读失败 ≠ 一条都没有(`catch` 里 hooks 落成 `[]`):横幅已经说了原因,
          // 下面再画「还没有钩子。」就是替一次读取失败撒谎(与记录栏同一判据)。
          isEmpty={(!hooks || hooks.length === 0) && listError === null}
          empty={t("settings.hooks.listEmpty")}
        >
          {hooks?.map((hook) => (
            <HookRow
              key={hook.id}
              hook={hook}
              active={hook.id === selectedId}
              onSelect={() => select(hook)}
              onToggle={() => void toggleEnabled(hook)}
            />
          ))}
        </ListPane>

        {/* ───────── 右:编辑 ───────── */}
        <div className="flex min-h-0 flex-col overflow-y-auto">
          {draft === null ? (
            <EmptyState className="flex-1" icon={IconActivity} title={t("settings.hooks.selectHint")} />
          ) : (
            <HookEditor
              draft={draft}
              onChange={(patch) => {
                setDraft((cur) => (cur ? { ...cur, ...patch } : cur));
                setJustSaved(false);
              }}
              dirty={dirty}
              problem={draftProblem}
              saving={saving}
              justSaved={justSaved}
              saveError={saveError}
              testing={testing}
              testRun={testRun}
              onSave={() => void save()}
              onAuthorize={() => void authorize()}
              canAuthorize={saved !== undefined && !dirty && hookActionOf(draft!).kind !== "command"}
              onTest={() => void test()}
              onRemove={() => setConfirmRemove(true)}
            />
          )}
        </div>
      </div>

      {/* ───────── 下:执行记录(两栏)─────────
          左边是**内存环**(本次启动以来,含用户手写钩子,会被顶掉);右边是【MC-061】**落盘
          审计**(跨重启活着;MC-010 起两种来源都落,来源作为一列展示)。两栏语义不同,
          故分开列,不混成一个表 —— "本次启动跑过什么"和"跨重启留下了什么账"是两个问题。 */}
      <div className="mt-3 grid h-[190px] shrink-0 grid-cols-2 gap-4">
        <ListPane
          title={t("settings.hooks.runsTitle")}
          count={runs.length}
          isEmpty={runs.length === 0 && runsError === null}
          empty={t("settings.hooks.runsEmpty")}
        >
          {/* 读不出来 ≠ 没执行过。原因与重试(「刷新记录」同一入口)都摆在这一栏里。 */}
          {runsError !== null && (
            <ErrorNote
              className="text-[0.7857em]"
              action={
                <Button variant="ghost" size="sm" type="button" onClick={() => void loadRuns()}>
                  {t("common.retry")}
                </Button>
              }
            >
              {t("settings.hooks.runsReadError", { message: runsError })}
            </ErrorNote>
          )}
          {runs.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              expanded={expandedRun === run.runId}
              onToggle={() => setExpandedRun(expandedRun === run.runId ? null : run.runId)}
            />
          ))}
        </ListPane>

        {/* 【MC-061】落盘审计(MC-010 起两种来源都进)。读盘失败时**显式报出来** ——
            「一次没执行」与「审计读不出来」不许长得一样。 */}
        <ListPane
          title={t("settings.hooks.auditTitle")}
          count={audit.length}
          isEmpty={audit.length === 0 && auditError === null && runsError === null}
          empty={t("settings.hooks.auditEmpty")}
        >
          {auditError !== null && (
            <ErrorNote className="text-[0.7857em]">{t("settings.hooks.auditReadError", { message: auditError })}</ErrorNote>
          )}
          {/* 整个 `hooks.runs` 都拒绝了:审计这一栏同样拿不到东西 —— 不许画成
              「还没有钩子被执行过」,与左边那一栏共用同一句错误。 */}
          {runsError !== null && auditError === null && (
            <ErrorNote className="text-[0.7857em]">{t("settings.hooks.auditReadError", { message: runsError })}</ErrorNote>
          )}
          {audit.map((entry) => (
            <AuditRow key={entry.runId} entry={entry} />
          ))}
        </ListPane>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={t("settings.hooks.removeTitle", { name: draft?.name ?? "" })}
        description={t("settings.hooks.removeDesc")}
        confirmText={t("settings.hooks.remove")}
        danger
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(false);
        }}
        onConfirm={() => {
          setConfirmRemove(false);
          void remove();
        }}
      />
    </div>
  );
}

/* ────────────────────────── 列表行 ────────────────────────── */

function HookRow({
  hook,
  active,
  onSelect,
  onToggle,
}: {
  hook: HookSpec;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors",
        active ? "bg-surface-muted" : "hover:bg-surface-hover/60",
      )}
    >
      <Button variant="ghost" size={null} type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block truncate text-[0.7857em]",
            hook.enabled ? "text-content" : "text-content-subtle",
          )}
        >
          {hook.name}
        </span>
        <span className="block truncate text-[0.7143em] text-content-subtle">
          {t(EVENT_LABELS[hook.event])}
          {hook.matcher && hookSubjectOf(hook.event) !== null ? ` · ${hook.matcher}` : ""}
        </span>
      </Button>
      <Switch
        checked={hook.enabled}
        onCheckedChange={onToggle}
        label={t("settings.hooks.fieldEnabled")}
      />
    </div>
  );
}

/* ────────────────────────── 编辑区 ────────────────────────── */

function HookEditor({
  draft,
  onChange,
  dirty,
  problem,
  saving,
  justSaved,
  saveError,
  testing,
  testRun,
  onSave,
  onAuthorize,
  canAuthorize,
  onTest,
  onRemove,
}: {
  draft: HookSpec;
  onChange: (patch: Partial<HookSpec>) => void;
  dirty: boolean;
  problem: string | null;
  saving: boolean;
  justSaved: boolean;
  saveError: string | null;
  testing: boolean;
  testRun: HookRun | null;
  onSave: () => void;
  onAuthorize: () => void;
  canAuthorize: boolean;
  onTest: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  // 事件决定这一栏比的是什么(工具名 / 文件路径),`null` = 这个事件没有可比的东西。
  const subject = hookSubjectOf(draft.event);
  // 这个事件有没有哪个引擎**根本不发**。有的话就说出来 —— 用户给那个引擎挂一条,
  // 命令写好了、保存成功、界面上一应俱全,而它永远不会响。
  const unsupportedBy = hookEventUnsupportedBy(draft.event);
  const canSave = problem === null && !saving;

  /** 几个引擎名拼成一串,用当前语言的顿号 / 逗号。 */
  const enginesText = (engines: readonly HookEngineId[]): string =>
    engines.map((e) => HOOK_ENGINE_LABEL[e]).join(t("settings.hooks.engineSeparator"));

  return (
    <div className="flex flex-col">
      <Field className="mb-2" label={t("settings.hooks.fieldName")}>
        <Input
          type="text"
          value={draft.name}
          maxLength={60}
          spellCheck={false}
          placeholder={t("settings.hooks.namePlaceholder")}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>

      <Field className="mb-2" label={t("settings.hooks.fieldEvent")} hint={t(EVENT_HINTS[draft.event])}>
        <Select.Root
          value={draft.event}
          onValueChange={(value) => onChange({ event: value as HookEvent })}
        >
          <Select.Trigger className="w-full">
            <Select.Value>
              {(value: string) => t(EVENT_LABELS[value as HookEvent])}
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  {HOOK_EVENTS.map((event) => {
                    // 下拉里也标一下:选之前就该看见"这个引擎不发这类",而不是选完再被
                    // 下面那行小字告知。**不灰掉、不禁用** —— 换个引擎它是能用的。
                    const missing = hookEventUnsupportedBy(event);
                    return (
                      <Select.Item key={event} value={event}>
                        <Select.ItemText>{t(EVENT_LABELS[event])}</Select.ItemText>
                        {missing.length > 0 && (
                          <span className="ml-auto shrink-0 pl-3 text-[0.9em] text-content-subtle">
                            {t("settings.hooks.eventItemUnsupported", {
                              engines: missing.map((e) => HOOK_ENGINE_LABEL[e]).join(t("settings.hooks.engineSeparator")),
                            })}
                          </span>
                        )}
                      </Select.Item>
                    );
                  })}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </Field>

      {/* 「这个引擎不发这类事件」——**选中时**必须说出来。理由见 `hooksView.ts` 那张表:
          能挂、能存、看着都对,就是不会响,而没有任何地方告诉他。
          用 warning 色而不是 subtle:它是一条"你现在这么配不会起作用"的警告,和上面那句
          "什么时候跑"不是一回事 —— 同款配色见这一页顶上的 problems 区。 */}
      {unsupportedBy.length > 0 && (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="-mt-1 mb-3">
          {t("settings.hooks.eventUnsupported", { engines: enginesText(unsupportedBy) })}
        </ErrorNote>
      )}

      {/* 匹配规则只对**有主语的事件**有意义。不适用时**藏起来而不是禁用**:
          一个灰着的输入框会让人以为"这里能填,只是现在不让",而它其实永远填不了。 */}
      {subject !== null && (
        <>
          <Field className="mb-2" label={t(MATCHER_TEXT[subject].label)} hint={t(MATCHER_TEXT[subject].hint)}>
            <Input
              type="text"
              value={draft.matcher ?? ""}
              maxLength={200}
              spellCheck={false}
              placeholder={t(MATCHER_TEXT[subject].placeholder)}
              onChange={(e) =>
                onChange({ matcher: e.target.value.length > 0 ? e.target.value : undefined })
              }
            />
          </Field>
        </>
      )}

      <Field className="mb-2" label="动作类型">
        <Select.Root value={hookActionOf(draft).kind} onValueChange={(kind) => {
          if (kind === "agent") onChange({ action: { kind: "agent", profileId: "" } });
          else if (kind === "workflow") onChange({ action: { kind: "workflow", workflowId: "" } });
          else onChange({ action: { kind: "command", command: draft.command } });
        }}>
          <Select.Trigger className="w-full"><Select.Value /></Select.Trigger>
          <Select.Portal><Select.Positioner className="z-50"><Select.Popup><Select.List>
            <Select.Item value="command"><Select.ItemText>Shell 命令</Select.ItemText></Select.Item>
            <Select.Item value="agent"><Select.ItemText>代理档案</Select.ItemText></Select.Item>
            <Select.Item value="workflow"><Select.ItemText>工作流</Select.ItemText></Select.Item>
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
      </Field>
      {hookActionOf(draft).kind === "command" ? (
        <Field className="mb-2" label={t("settings.hooks.fieldCommand")} hint={t("settings.hooks.commandHint")}>
          <Textarea
            value={(hookActionOf(draft) as { kind: "command"; command: string }).command}
            spellCheck={false}
            placeholder={t("settings.hooks.commandPlaceholder")}
            onChange={(e) => onChange({ command: e.target.value, action: { kind: "command", command: e.target.value } })}
            className="min-h-[80px] w-full resize-y rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] leading-relaxed text-content placeholder:font-sans placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
        </Field>
      ) : (
        <Field className="mb-2" label={hookActionOf(draft).kind === "agent" ? "代理档案 ID" : "工作流 ID"} hint="保存后还需要单独点击授权，命令授权不能启动代理">
          <Input type="text" value={hookActionOf(draft).kind === "agent"
            ? (hookActionOf(draft) as { kind: "agent"; profileId: string }).profileId
            : (hookActionOf(draft) as { kind: "workflow"; workflowId: string }).workflowId}
            onChange={(e) => onChange({ action: hookActionOf(draft).kind === "agent"
              ? { kind: "agent", profileId: e.target.value } : { kind: "workflow", workflowId: e.target.value } })} />
        </Field>
      )}

      <Field className="mb-2" label={t("settings.hooks.fieldTimeout")}>
        <Input
          type="number"
          value={String(draft.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange({ timeoutMs: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined });
          }}
        />
      </Field>

      <div className="mb-3 mt-1 flex items-center gap-2">
        <Switch
          checked={draft.enabled}
          onCheckedChange={(on) => onChange({ enabled: on })}
          label={t("settings.hooks.fieldEnabled")}
        />
        <span className="text-[0.7857em] text-content-muted">{t("settings.hooks.fieldEnabled")}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!canSave} onClick={onSave}>
          {saving ? t("settings.hooks.saving") : t("settings.hooks.save")}
        </Button>
        <Button variant="secondary" size="sm" disabled={problem !== null || testing} onClick={onTest} className="gap-1">
          <IconPlayerPlay size={12} />
          {testing ? t("settings.hooks.testing") : t("settings.hooks.test")}
        </Button>
        <InfoHint>{t("settings.hooks.testHint")}</InfoHint>
        {hookActionOf(draft).kind !== "command" && (
          <Button variant="secondary" size="sm" disabled={!canAuthorize} onClick={onAuthorize}>
            单独授权动作（24h）
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRemove} className="ml-auto gap-1 text-danger">
          <IconTrash size={12} />
          {t("settings.hooks.remove")}
        </Button>
      </div>

      {/* 状态行:未保存 / 已保存 / 存不下去。**三件事共用一个位置** —— 分开显示时,
          用户会同时看到"已保存"和一条旧的错误。 */}
      <div className="mt-1.5 min-h-[18px] text-[0.7143em] leading-relaxed">
        {saveError !== null ? (
          <span className="text-danger">{saveError}</span>
        ) : problem === "name" ? (
          <span className="text-warning">{t("settings.hooks.nameRequired")}</span>
        ) : problem === "profileId" || problem === "workflowId" ? (
          <span className="text-warning">请填写有效的代理档案或工作流 ID</span>
        ) : problem === "command" ? (
          <span className="text-warning">{t("settings.hooks.commandRequired")}</span>
        ) : justSaved && !dirty ? (
          <span className="text-accent">{t("settings.hooks.saved")}</span>
        ) : dirty ? (
          <span className="text-content-subtle">{t("settings.hooks.unsaved")}</span>
        ) : null}
      </div>

      {testRun && <TestResult run={testRun} />}
    </div>
  );
}

/** 试跑的结果。和下面的执行记录同一套字段,但**内联在编辑器里** —— 试跑是"我现在
 *  想知道这条命令行不行",它和"历史上发生过什么"是两个问题。 */
function TestResult({ run }: { run: HookRun }) {
  const { t } = useI18n();
  const meta = RUN_STATUS[run.status];
  return (
    <div className="mt-2 rounded border border-edge bg-surface p-2 text-[0.7143em] leading-relaxed">
      <div className="flex items-center gap-2">
        <span className={cn("font-medium", meta.cls)}>{t(meta.key)}</span>
        {run.durationMs !== undefined && (
          <span className="tabular-nums text-content-subtle">{run.durationMs}ms</span>
        )}
        {run.exitCode !== undefined && (
          <span className="tabular-nums text-content-subtle">exit {run.exitCode}</span>
        )}
      </div>
      {run.error && <ErrorNote className="mt-1">{run.error}</ErrorNote>}
      {run.stdout && (
        <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-all font-mono text-content-muted">
          {run.stdout}
        </pre>
      )}
      {run.stderr && (
        <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-all font-mono text-warning">
          {run.stderr}
        </pre>
      )}
    </div>
  );
}

/* ────────────────────────── 执行记录 ────────────────────────── */

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: HookRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const meta = RUN_STATUS[run.status];
  const hasDetail = Boolean(run.stdout || run.stderr || run.error);
  return (
    <div className="rounded">
      <Button variant="ghost" size={null}
        type="button"
        onClick={onToggle}
        disabled={!hasDetail}
        className={cn(
          "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[0.7857em] transition-colors",
          hasDetail ? "hover:bg-surface-hover/60" : "cursor-default",
        )}
      >
        <span className={cn("w-[52px] shrink-0 font-medium", meta.cls)}>{t(meta.key)}</span>
        <span className="tabular-nums text-content-subtle">{formatRunTime(run.startedAt)}</span>
        <span className="min-w-0 flex-1 truncate text-content">{run.hookName}</span>
        <span className="shrink-0 text-content-subtle">
          {t(EVENT_LABELS[run.event])}
        </span>
        {/* 工作流节点跑在隐藏会话里,它的钩子记录**只在这里看得见** —— 标出来,
            否则用户会奇怪"这个会话我在界面上从来没见过"。 */}
        {run.sessionKind === "node" && (
          <span className="shrink-0 rounded bg-surface-muted px-1 text-[0.9em] text-content-subtle">
            {t("settings.hooks.sessionNode")}
          </span>
        )}
        {run.durationMs !== undefined && (
          <span className="shrink-0 tabular-nums text-content-subtle">{run.durationMs}ms</span>
        )}
        {run.exitCode !== undefined && run.exitCode !== 0 && (
          <span className="shrink-0 tabular-nums text-danger">exit {run.exitCode}</span>
        )}
      </Button>
      {expanded && hasDetail && (
        <div className="px-1.5 pb-1.5">
          {run.error && <ErrorNote className="text-[0.7143em]">{run.error}</ErrorNote>}
          {run.stdout && (
            <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted/50 p-1.5 font-mono text-[0.7143em] text-content-muted">
              {run.stdout}
            </pre>
          )}
          {run.stderr && (
            <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted/50 p-1.5 font-mono text-[0.7143em] text-warning">
              {run.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 【MC-061】**落盘审计**的一行(插件 hook)。与 {@link RunRow} 不同:它没有 stdout/stderr
 * (审计要的是"跑没跑、为什么",不是完整输出),所以不展开 —— 一行里就把「状态 / 时间 /
 * 来源 / 事件 / 结局」摆出来。`status` 是落盘列,取值同 `HookRunStatus`,但类型上是 `string`,
 * 所以按 `Map` 查词条,查不到时退回原样(旧数据 / 将来新增状态不会崩)。
 */
function AuditRow({ entry }: { entry: HookAuditEntry }) {
  const { t } = useI18n();
  const meta = RUN_STATUS[entry.status as HookRun["status"]];
  const eventLabel = (EVENT_LABELS as Record<string, MessageId>)[entry.event];
  // 【MC-010】来源是一列事实:插件行照旧显示「插件名 @ 版本」,用户手写行显示
  // 那条钩子的名字(审计不再只服务插件,报告「你这条 hook 跑没跑」也要能读)。
  const label = entry.source === "user" ? t("settings.hooks.auditSourceUser") : `${entry.pluginId} @ ${entry.pluginVersion ?? "?"}`;
  return (
    <div className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-[0.7857em]">
      <span className={cn("w-[52px] shrink-0 font-medium", meta?.cls ?? "text-content-subtle")}>
        {meta ? t(meta.key) : entry.status}
      </span>
      <span className="shrink-0 tabular-nums text-content-subtle">{formatRunTime(entry.startedAt)}</span>
      {/* 来源身份是这一栏的**重点** —— 审计要回答"这条钩子跑没跑、哪来的"。 */}
      <span className="min-w-0 flex-1 truncate text-content" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-content-subtle">
        {eventLabel ? t(eventLabel) : entry.nativeEvent}
      </span>
      {entry.exitCode !== null && entry.exitCode !== 0 && (
        <span className="shrink-0 tabular-nums text-danger">exit {entry.exitCode}</span>
      )}
      {entry.error && (
        <span className="min-w-0 max-w-[40%] truncate text-content-subtle" title={entry.error}>
          {entry.error}
        </span>
      )}
    </div>
  );
}
