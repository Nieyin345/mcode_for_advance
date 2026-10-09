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
  hookSubjectOf,
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
  const [runs, setRuns] = useState<HookRun[]>([]);
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
      setRuns((await api.hooks.runs()).runs);
    } catch {
      // 记录拉不到不影响编辑 —— 它只是排错用的窗口。
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRuns();
  }, [load, loadRuns]);

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
      const res = await api.hooks.save({ hook: draft });
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
      const res = await api.hooks.save({ hook: next });
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
      const res = await api.hooks.test({ hook: draft });
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

      {/* 文件里读得见、但用不了的条目。**必须说出来** —— 用户写的钩子不生效时,这一页
          是唯一能解释为什么的地方(同 `workflow.nodeTypes` 的 problems)。 */}
      {(problems.length > 0 || listError !== null) && (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-3">
          {listError !== null ? (
            <div>{t("settings.hooks.loadFailed", { error: listError })}</div>
          ) : null}
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
          isEmpty={!hooks || hooks.length === 0}
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
              onTest={() => void test()}
              onRemove={() => setConfirmRemove(true)}
            />
          )}
        </div>
      </div>

      {/* ───────── 下:最近的执行 ───────── */}
      <ListPane
        className="mt-3 h-[190px] shrink-0"
        title={t("settings.hooks.runsTitle")}
        count={runs.length}
        isEmpty={runs.length === 0}
        empty={t("settings.hooks.runsEmpty")}
      >
        {runs.map((run) => (
          <RunRow
            key={run.runId}
            run={run}
            expanded={expandedRun === run.runId}
            onToggle={() => setExpandedRun(expandedRun === run.runId ? null : run.runId)}
          />
        ))}
      </ListPane>

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
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
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
      </button>
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

      <Field className="mb-2" label={t("settings.hooks.fieldCommand")} hint={t("settings.hooks.commandHint")}>
        <textarea
          value={draft.command}
          spellCheck={false}
          placeholder={t("settings.hooks.commandPlaceholder")}
          onChange={(e) => onChange({ command: e.target.value })}
          className="min-h-[80px] w-full resize-y rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] leading-relaxed text-content placeholder:font-sans placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </Field>

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
      {run.error && <div className="mt-1 text-danger">{run.error}</div>}
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
      <button
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
      </button>
      {expanded && hasDetail && (
        <div className="px-1.5 pb-1.5">
          {run.error && (
            <div className="text-[0.7143em] leading-relaxed text-danger">{run.error}</div>
          )}
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
