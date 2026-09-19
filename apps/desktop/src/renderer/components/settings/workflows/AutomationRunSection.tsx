/**
 * 自动化那一节:**立刻跑一次** + **它跑过什么**。
 *
 * ## 为什么摆在"工作流本体"那一栏里
 *
 * 自动化与工作流共用同一个库、同一张画布、同一套节点 —— 差别只有"谁把它跑起来"。所以
 * "跑一次看看"和"上一次跑成什么样"是**这条自动化本身**的两件事,和具体选中了哪个节点
 * 没关系:选了节点时右栏在编辑那一步,那时不该看见它。
 *
 * ## 手动跑一次 = 冒充一个 manual 触发器
 *
 * 按钮调的是 `automation:run`(见 `main/ipc/orchestration.ts`),它落到后台执行器的
 * `runNow` —— 和那条自动化自己响起来**走的是同一条路**(同一个项目、同一句话、同一条
 * 后台会话)。所以用户可以先按它试一遍,再把触发方式改成定时,看到的是同一件事。
 *
 * **一次一条自动化可以有好几个触发器**,它们的工作目录和请求都可能不一样,所以这里
 * 必须指名道姓 —— 取**文档顺序第一个**触发器节点(确定性),并在按钮下面把那一步的
 * 名字写出来,免得用户以为"运行"会跑全部触发器。
 *
 * ## 历史是从存档折出来的,所以不自动刷新
 *
 * `automation:runs` 读的是那条后台会话的 `workflow_runs`,不是另存的一份历史。一次运行
 * 可能好几分钟,而轮询换来的只是"跑完了"四个字 —— 想再看一眼就点那颗刷新按钮。刚刚
 * 按过"运行一次"之后会自动拉一次,那时列表里出现的那条是 `进行中`。
 *
 * ## 读不出来不是错误
 *
 * 这三个通道是**桌面专属**(手机端那个 RPC 表是手写白名单,不列即不暴露),那边
 * `api.automation` 是个一调就抛的代理。拉历史失败就**当没有历史**:右栏是常用面板,
 * 为一件"这个平台没有的功能"常驻一条红字没有意义。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationRunEntry, AutomationRunStatus, AutomationTriggerFacts } from "@contracts/ipc";
import { latestFailureOf } from "@contracts/ipc";
import {
  NODE_OUTCOME_STATUSES,
  type NodeOutcomeStatus,
  type NodeTypeCatalog,
} from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { formatFullTime, formatRelativeTime } from "@renderer/lib/time.js";
import { IconPlayerPlay, IconRefresh } from "@renderer/lib/icons.js";
import { findNodeType, nodeTitle } from "./workflowView.js";

/**
 * 这条自动化是**从哪一格起跑**的。
 *
 * 判据是**清单的 `runner.kind`** 而不是类型 id —— 第三方可以带自己的触发器类型进来
 * (同 `NodeInspector` 认分支那个做法)。找不到就是"它还不是一条自动化"。
 */
function triggerNodeIdOf(doc: WorkflowDoc, catalog: NodeTypeCatalog): string | null {
  for (const node of doc.nodes) {
    if (findNodeType(catalog.entries, node.type)?.manifest.runner.kind === "trigger") {
      return node.id;
    }
  }
  return null;
}

/** 这个值是**契约里那个闭合集合**,所以少写一个编译不过(见 `AUTOMATION_RUN_STATUSES`)。 */
const RUN_STATUS_LABELS: Record<AutomationRunStatus, MessageId> = {
  running: "settings.automation.runStatus.running",
  interrupted: "settings.automation.runStatus.interrupted",
  success: "settings.automation.runStatus.success",
  failed: "settings.automation.runStatus.failed",
  cancelled: "settings.automation.runStatus.cancelled",
};

const RUN_STATUS_TONE: Record<AutomationRunStatus, string> = {
  running: "text-accent",
  interrupted: "text-warning",
  success: "text-success",
  failed: "text-danger",
  cancelled: "text-content-muted",
};

/** 同上的哨兵。⚠️ 契约里 `AutomationRunStep.status` 是 `string`(存档可能是更老的版本
 *  写的),所以这张表**要有兜底** —— 认不出的值原样显示,不能显示成空白。 */
const STEP_STATUS_LABELS: Record<NodeOutcomeStatus, MessageId> = {
  success: "settings.automation.stepStatus.success",
  failed: "settings.automation.stepStatus.failed",
  cancelled: "settings.automation.stepStatus.cancelled",
  skipped: "settings.automation.stepStatus.skipped",
  unselected: "settings.automation.stepStatus.unselected",
};

/* ────────────────────────── 触发器事实 ────────────────────────── */

// 事实行用的 `AutomationTriggerFacts` 来自 `@contracts/ipc`(orchestration 域的
// 契约镜像),`api.automation.statusAll()` 直接给事实数组。

export function AutomationRunSection({
  doc,
  catalog,
}: {
  doc: WorkflowDoc;
  catalog: NodeTypeCatalog;
}) {
  const { t } = useI18n();
  const triggerNodeId = triggerNodeIdOf(doc, catalog);
  const [runs, setRuns] = useState<AutomationRunEntry[]>([]);
  /** 触发器事实(armed / lastFireAt / lastError)。**读不到就当没有** —— 和历史同一
   *  条降级纪律,见文件头最后一段。 */
  const [facts, setFacts] = useState<AutomationTriggerFacts[]>([]);
  const [busy, setBusy] = useState(false);
  /** 上一次"运行一次"没跑起来的原因。跑起来了就没有话说(历史里那条自己会说明)。 */
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api.automation.runs({ workflowId: doc.id });
      setRuns(res.runs);
    } catch {
      // 见文件头最后一段:这不是错误,只是"这里看不到历史"。
    }
    try {
      // 事实是**全量**的(主进程只有一张事实表),这里只留这条自动化自己的。
      const all = await api.automation.statusAll();
      setFacts(all.filter((f) => f.workflowId === doc.id));
    } catch {
      setFacts([]);
    }
  }, [doc.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 用户在触发器节点上拨了「启用」开关 → 重新拉一次事实。
   *
   * ## 为什么是这么个笨办法
   *
   * 事实是**主进程内存里**的一张表(`AutomationFacts`),只有 `reload` 会重建它 ——
   * 拨开关本身不推任何事件过来。不重拉的话,用户关掉一条自动化之后,这一栏会一直
   * 说着「已挂上」,而那正是这条改动要消灭的那种谎话。
   *
   * 取巧的做法(在渲染端自己按 `doc` 算一遍 `facts`)不写是有理由的:那个算法是
   * 「参数解不解得开 + 项目在不在 + 目录监听挂没挂上」,前两条要靠主进程的清单与项目表,
   * 渲染端算不全。宁可多问一次,也不要两处各算一个近似答案。
   *
   * 判据只看**参数袋的引用**:节点参数是不可变的,拨一下换一个对象(`NodeInspector`
   * 那条 `onChange` 就是整袋替换),所以对象没换就是没动过 —— 拖节点、改标题都不会
   * 白白多几次 IPC。
   *
   * `useRef` 用挂载那一刻的值起手,所以**第一次不重拉**(上面那条 effect 已经拉过了)。
   * 依赖里的 `refresh` 只用来认「换了一条自动化」:那种情况上面那条 effect 会接手,
   * 这里不必再抢一次。
   */
  const triggerParams = doc.nodes.find((n) => n.id === triggerNodeId)?.params;
  const prevParams = useRef(triggerParams);
  useEffect(() => {
    if (prevParams.current === triggerParams) return;
    prevParams.current = triggerParams;
    void refresh();
  }, [triggerParams, refresh]);

  const runNow = async (): Promise<void> => {
    if (triggerNodeId === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.automation.run({ workflowId: doc.id, triggerNodeId });
      // **原样显示主进程给的句子**(比如"上一次还在跑,这一次触发已跳过"):同一件事
      // 只该有一种说法,而那句话同时也是日志里那一行。
      if (!res.ok) setNotice(res.error ?? t("settings.automation.runFailed"));
    } catch (err) {
      setNotice((err as Error).message);
    }
    setBusy(false);
    // 刚起的那次是**异步**的(执行器不 await 那次运行),所以这一拉拿到的是"进行中"。
    await refresh();
  };

  const stepLabel = (status: string): string =>
    (NODE_OUTCOME_STATUSES as readonly string[]).includes(status)
      ? t(STEP_STATUS_LABELS[status as NodeOutcomeStatus])
      : status;

  // Dashboard facts come from persisted run history; there is no second status store.
  const latestRun = runs[0] ?? null;
  const lastError = latestRun?.steps.find((step) => step.error !== undefined)?.error ?? null;
  const automationStatus = latestRun?.status ?? null;

  const trigger =
    triggerNodeId === null ? null : (doc.nodes.find((n) => n.id === triggerNodeId) ?? null);

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[0.7857em] font-medium text-content-muted">
          {t("settings.automation.dashboard")}
        </span>
        {/* 不摆「已启用」徽标:它之前是恒真的字面量,而 per-trigger 启停这个功能并不
            存在 —— 每条触发器真挂没挂上,下面那排事实行(`facts.armed`)才是真话。
            现在启停真有了,但它仍然是**每一条各自**的事,一个标题级的徽标概括不了。 */}
        {automationStatus !== null && (
          <span className={cn("text-[0.7143em]", RUN_STATUS_TONE[automationStatus])}>
            {t(RUN_STATUS_LABELS[automationStatus])}
          </span>
        )}
        <button
          type="button"
          title={t("settings.automation.refresh")}
          onClick={() => void refresh()}
          className="rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconRefresh size={11} />
        </button>
      </div>

      <Button
        variant="secondary"
        size="sm"
        disabled={triggerNodeId === null || busy}
        onClick={() => void runNow()}
        className="gap-1"
      >
        <IconPlayerPlay size={11} />
        {t("settings.automation.runNow")}
      </Button>
      {trigger === null ? (
        // 没有触发器就**没有起点**:图跑不起来,而且它现在也不在自动化那一栏里
        // (见 `library.deriveTrigger`)。所以这里说的不是"按钮不好使",是"还缺一格"。
        <p className="mt-1 text-[0.7143em] leading-relaxed text-warning">
          {t("settings.automation.runNoTrigger")}
        </p>
      ) : (
        <p className="mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.automation.runNowHint", {
            name: nodeTitle(trigger, findNodeType(catalog.entries, trigger.type)),
          })}
        </p>
      )}
      {notice !== null && (
        <p className="mt-1 text-[0.7143em] leading-relaxed text-warning">{notice}</p>
      )}

      {lastError !== null && (
        <p className="mt-1 truncate text-[0.7143em] leading-relaxed text-danger" title={lastError}>
          {t("settings.automation.lastError")}: {lastError}
        </p>
      )}
      {latestRun !== null && (
        <p className="mt-1 text-[0.7143em] text-content-subtle" title={formatFullTime(latestRun.startedAt)}>
          {t("settings.automation.lastRun")}: {formatRelativeTime(latestRun.startedAt)}
        </p>
      )}

      {/* 触发器事实 —— 一条自动化可以有好几个触发器,事实**按条**说:挂上没有、最近
          一次什么时候真的响过、最近一次为什么没跑成。运行史答不出"配置写坏了所以永远
          不响"这种事,所以这里独立于上面的历史(见 `automationStatus.ts` 的文件头)。 */}
      {facts.map((fact) => (
        <div key={fact.key} className="mt-1 text-[0.7143em] leading-relaxed">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* 三种状态各自的颜色:响着是绿、你自己关的是灰、坏了才是黄。
                关掉的那条**不能**跟坏掉的一个色 —— 那会让人以为应用出问题了。 */}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                fact.armed ? "bg-success" : fact.enabled === false ? "bg-content-subtle" : "bg-warning",
              )}
            />
            <span className="min-w-0 truncate text-content-muted" title={fact.detail ?? fact.title}>
              {fact.title}
            </span>
            <span
              className={cn(
                "shrink-0",
                fact.armed ? "text-success" : fact.enabled === false ? "text-content-subtle" : "text-warning",
              )}
            >
              {t(
                fact.armed
                  ? "settings.automation.facts.armed"
                  : fact.enabled === false
                    ? "settings.automation.facts.off"
                    : "settings.automation.facts.disarmed",
              )}
            </span>
          </div>
          {fact.lastFireAt !== undefined && (
            <p
              className="ml-3 text-content-subtle"
              title={formatFullTime(fact.lastFireAt)}
            >
              {t("settings.automation.lastRun")}: {formatRelativeTime(fact.lastFireAt)}
            </p>
          )}
          {/* ⚠️ 用 `latestFailureOf` 而不是直接看 `lastError` —— 起跑之后那次失败就是
              旧账了,一直挂着会让这行红字变成背景噪音(理由见契约里那个函数的注解)。 */}
          {latestFailureOf(fact) !== undefined && (
            <p className="ml-3 truncate text-danger" title={fact.lastError}>
              {t("settings.automation.lastError")}: {fact.lastError}
            </p>
          )}
        </div>
      ))}

      {runs.length === 0 ? (
        <p className="mt-2 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.automation.runHistoryEmpty")}
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {runs.map((run) => (
            <div key={run.runId} className="rounded border border-edge bg-surface p-1.5">
              <div className="flex items-center gap-1.5 text-[0.7143em]">
                <span className={cn("font-medium", RUN_STATUS_TONE[run.status])}>
                  {t(RUN_STATUS_LABELS[run.status])}
                </span>
                {/* 相对时间读起来快,而准确时刻要有地方可查 —— 放 title 里(同 git 面板)。 */}
                <span className="text-content-subtle" title={formatFullTime(run.startedAt)}>
                  {formatRelativeTime(run.startedAt)}
                </span>
              </div>
              {run.steps.map((step) => (
                <div key={step.nodeId} className="mt-0.5 text-[0.7143em] leading-relaxed">
                  <span className="text-content-muted">{step.title}</span>
                  <span className="text-content-subtle"> · {stepLabel(step.status)}</span>
                  {/* 有错误就说错误(原因比摘要有用);否则说它做了什么。两样都没有
                      的步骤(比如被跳过的)到这里就完了 —— 不摆一个空的占位符。 */}
                  {step.error !== undefined ? (
                    <span className="text-danger"> · {step.error}</span>
                  ) : step.summary.length > 0 ? (
                    <span className="text-content-subtle"> · {step.summary}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}