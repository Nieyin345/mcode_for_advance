/**
 * 输入框上方那条**固定条件**筛选条 —— 主对话节点参数的渲染端。
 *
 * ## 为什么要有它
 *
 * 用户的原话:「不止是 2-4 个问题,需要比较详细的,包括时间范围,影响因子,论文层次
 * 等等这些,**但是一般这些都是固定的习惯**,之后就是方向问题」。
 *
 * 也就是说检索条件分两种:
 *   - **不变的习惯**(时间跨度、期刊层次、影响因子下限、每源取多少条)—— 就是这一条;
 *   - **每轮都要问的方向** —— 由 AI 用 AskUserQuestion 在对话里问。
 *
 * 把不变的那些做成界面上的选择框,好处是双份的:用户不必每个会话重新交代一遍,AI 也
 * 不必浪费一轮对话去问已知的东西。
 *
 * ## 条件**定义**长在主对话节点上
 *
 * 条件表是**主对话节点的「固定条件」参数**(`NODE_CRITERIA_PARAM_KEY`,见
 * `@contracts/nodeType`):内置检索图的主节点预填了那四条,任何图型工作流的主节点都能
 * 配 —— 节点上有什么条件,这里就渲染什么下拉框;输入框上方**只有这一排东西**(曾经
 * 并排的「输入选项」下拉已删)。选中的值存设置表
 * (`WORKFLOW_NODE_PREFS_SETTING_PREFIX` + workflowId),主进程在**那次对话的第一轮**
 * 把选中的值拼进运行提示词、交给主节点(`main/lib/searchPrefs.ts`)—— 界面显示的与
 * 模型执行的是同一份。没有条件表的图,这条筛选条整个不渲染。
 *
 * ## 没选过的条件显示「—」,注入时跳过
 *
 * 显示与注入用同一条读法(值 = 设置表里存的那个,没有就是"未设"):未设的条件在
 * 界面上是「—」,在提示词里不存在 —— 不会出现"界面显示着 10 条、模型其实没被告知"
 * 的错位。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Tooltip } from "@renderer/components/ui/index.js";
import { WORKFLOW_NODE_PREFS_SETTING_PREFIX } from "@contracts/ipc";
import { MAIN_NODE_TYPE_ID, NODE_CRITERIA_PARAM_KEY, NodeParamRefSourceSchema } from "@contracts/nodeType";
import type { NodeParamRefSource } from "@contracts/nodeType";
import { useRefOptions } from "@renderer/components/settings/workflows/useRefOptions.js";
import type { WorkflowDoc } from "@contracts/workflow";
import { IconAdjustmentsHorizontal, IconInfoCircle } from "@renderer/lib/icons.js";

/** 主节点条件表在聊天侧的一行(候选值滤过空串;note 是给模型的解释,可空)。 */
interface CriteriaRow {
  name: string;
  choices: string[];
  note: string;
  /**
   * 候选**现读**的来源(见 `NODE_CRITERIA_PARAM_KEY` 那段)。有它时 `choices` 是空的,
   * 候选在渲染这一排时现拉 —— 用户的原话:「候选值是在用户用这个工作流的时候**现场当时
   * 获取**的」。
   */
  source?: NodeParamRefSource;
}

/** 从文档的主节点参数袋里读出条件表。与 `ParamField` 的 `critRows` 同一条读法。 */
function criteriaRowsOf(doc: WorkflowDoc | null): CriteriaRow[] {
  const main = doc?.nodes.find((node) => node.type === MAIN_NODE_TYPE_ID);
  const raw = main?.params[NODE_CRITERIA_PARAM_KEY];
  if (!Array.isArray(raw)) return [];
  const out: CriteriaRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, choices, note, source } = item as {
      name?: unknown;
      choices?: unknown;
      note?: unknown;
      source?: unknown;
    };
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(choices)) continue;
    // 来源认不出来就**当手写候选**处理(而不是丢掉这一行):契约那一层会拒掉不认识的
    // 来源,能走到这里的 source 要么合法、要么是别处写坏的存档 —— 丢掉的话用户会看到
    // 一个凭空少掉的条件,那比"回落成手写候选"难查得多。
    const src = NodeParamRefSourceSchema.safeParse(source);
    const from = src.success ? src.data : undefined;
    // **空白候选值在这里滤掉。** 盘上会留着它们 —— 编辑态那个多行框得能按下回车,
    // 空行才留得住(见 ParamField 的 `toCriteria`),所以过滤的责任落在显示这一头:
    // 不然编辑时按下的每个回车都会在下拉里变成一个看不见的空选项。
    const list = choices.filter((c): c is string => typeof c === "string" && c.trim() !== "");
    // 现读来源的行**允许空候选**(候选根本不写在盘上);手写的那些照旧要求至少一条,
    // 否则它是个摆不出来的空下拉。
    if (list.length === 0 && from === undefined) continue;
    out.push({
      name,
      choices: list,
      note: typeof note === "string" ? note : "",
      ...(from !== undefined ? { source: from } : {}),
    });
  }
  return out;
}

/** 设置表里的选中值:`{ 条件名: 选中值 }`。坏值当没设。 */
function parsePrefs(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

export function SearchFilterBar({ workflowId }: { workflowId: string }) {
  const { t } = useI18n();

  /** 主节点上的条件表;null = 还没读到。空表 = 这张图没配条件,整条不渲染。 */
  const [conditions, setConditions] = useState<CriteriaRow[] | null>(null);
  /** 各条件的选中值("" = 未设 → 显示「—」、注入时跳过)。 */
  const [values, setValues] = useState<Record<string, string>>({});

  // 条件表长在**这份文档**的主节点上,值存这份文档名下 —— workflowId 一换就得重读。
  useEffect(() => {
    let cancelled = false;
    setConditions(null);
    setValues({});
    void (async () => {
      try {
        const [docRes, prefsRes] = await Promise.all([
          api.workflow.get({ id: workflowId }),
          api.setting.get({ key: WORKFLOW_NODE_PREFS_SETTING_PREFIX + workflowId }),
        ]);
        if (cancelled) return;
        setConditions(criteriaRowsOf(docRes.workflow));
        setValues(parsePrefs(prefsRes.value) ?? {});
      } catch {
        // 手机端 web shim:没有这些命名空间,访问即同步抛(见 `lib/webApi.ts`)。当没有条件表。
        if (!cancelled) {
          setConditions([]);
          setValues({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  /** 选中一格:落设置表(整份覆盖 —— 值就是一张小地图)。web shim 存不了就算了。 */
  const pick = (name: string, value: string): void => {
    const next = { ...(values ?? {}), [name]: value };
    setValues(next);
    void api.setting
      .set({ key: WORKFLOW_NODE_PREFS_SETTING_PREFIX + workflowId, value: JSON.stringify(next) })
      .catch(() => {
        // 存不了:界面上的选择照常,只是这轮注入读不到(web shim 没有这条 RPC)。
      });
  };

  // 还没读到,或读到了但没有条件:整条不渲染。
  if (!conditions || conditions.length === 0) return null;

  return (
    /**
     * **一行，而且各条件均分整行**（2026-09-22 用户改的）。
     *
     * ## 从"按内容缩 + 挤不下横滑"改成均分
     *
     * 从前每个条件是 `shrink-0`（按自己的文字宽度），条件之间的宽度差能到三四倍
     * （「一年」vs「只要 T1(Q1 或中科院 1 区,或 Top)」），看着参差不齐；挤不下时靠
     * 横向滚。
     *
     * 用户的原话：「**不只是四个，用户定义几个就是几个均分，等宽，不管里面的选项的
     * 长度**」。所以：
     *
     *  - 每个条件 `flex-1 basis-0` —— **等宽**，条数由用户配几个决定；
     *  - **不管选项多长** —— 原生 `select` 会把长选项截断显示（悬停有 `title` 兜底）；
     *  - 既然等宽，就**不再横滑**了（`overflow-x-auto` 拿掉）—— 挤的时候是一起变窄，
     *    而不是把右边的条件推到看不见的地方。
     */
    <div className="flex flex-nowrap items-center gap-x-3 border-t border-edge px-2.5 pt-1.5 pb-0.5">
      <span className="flex shrink-0 items-center gap-1 text-[0.7857em] text-content-subtle">
        <IconAdjustmentsHorizontal size={12} />
        {t("chat.nodeCriteria.title")}
        {/* 这一排是**用户自己配的**,但配完就切回聊天了 —— 于是"这是什么、什么时候
            生效、要改去哪儿"全都没地方知道。挂在左边那个统称上,而不是每个条件名上
            (条件名那格的悬停留给它自己的解释,见下面那个 title)。 */}
        <Tooltip.Root>
          <Tooltip.Trigger
            delay={600}
            closeDelay={60}
            render={<span tabIndex={-1} />}
            aria-label={t("chat.nodeCriteria.title")}
            className="inline-flex cursor-help align-middle text-content-subtle hover:text-content-muted"
          >
            <IconInfoCircle size={11} />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner side="top" align="start" sideOffset={6}>
              <Tooltip.Popup className="max-w-[300px] leading-relaxed">
                {t("chat.nodeCriteria.hint")}
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </span>
      {conditions.map((cond) => (
        <CriteriaDropdown key={cond.name} cond={cond} current={values?.[cond.name] ?? ""} onPick={pick} />
      ))}
    </div>
  );
}

/**
 * 一个条件的下拉 —— **必须单独成组件**,因为候选现读要走 `useRefOptions` 那个 hook,
 * 而 hook 不能写在 `map` 的回调里(条件个数是运行期才知道的)。
 *
 * ## 候选从哪来,两种读法
 *
 * - **手写**(没有 `source`):`cond.choices` 就是盘上那份,原样摆出来;
 * - **现读**(有 `source`):候选在**这一刻**从 `useRefOptions(source)` 拉 —— 分类、
 *   项目这些是用户自己的数据,写清单的人不可能知道。
 *
 * ⚠️ **现读那一支要处理"还没拉到"**:`useRefOptions` 的第一帧必是空数组(异步的),
 * 而空下拉比输入框更糟(它看着像有选项)。所以空的时候摆一个**禁用的** `—`,并在
 * 拿不到候选时如实说"暂时没有可选的"。这正是固定条件一贯的取舍:宁可显示"没有",
 * 不要显示一个骗人的空列表。
 */
function CriteriaDropdown({
  cond,
  current,
  onPick,
}: {
  cond: CriteriaRow;
  current: string;
  onPick: (name: string, value: string) => void;
}) {
  const { t } = useI18n();
  // **无条件调用**(hooks 的规矩),`from` 缺席时 hook 内部会挑一个不会发请求的分支 ——
  // 它按 `from` 决定拉什么,而 `undefined` 不是合法的来源,所以这里只在有 source 时才
  // 需要它的结果。用一个哨兵来源(`"skills"` 是最便宜的:它读 store,不发 IPC)顶替,
  // 免得 hooks 数随条件变。
  const { options } = useRefOptions(cond.source ?? "skills");
  const live = cond.source !== undefined;
  const choices = live
    ? options.map((o) => o.id)
    : cond.choices;
  // 现读那一支:候选 id 是**不透明的**(`lc_xxx`),下拉里要显示可读名。
  const labelOf = (value: string): string => {
    if (!live) return value;
    return options.find((o) => o.id === value)?.label ?? value;
  };
  // 选过、但这一次拉回来的候选里没有它(分类被删了 / 换了工作流)—— 也要能显示出来,
  // 否则下拉会突然跳回「—」,看起来像"我的选择被清了"。
  const orphaned = live && current !== "" && !choices.includes(current);

  return (
    <label className="flex min-w-0 flex-1 basis-0 items-center gap-1.5">
      {/* 条件名上挂着解释(配置时写给模型的那句):悬停可见 —— 用户看得见
          "选它是什么口径",不必切回设置页翻。

          **名字可伸缩、能截断**（2026-09-22 改）：均分之后每格宽度固定，
          名字比那一格还长时必须让位给下拉 —— 下拉里的字才是用户要读的。

          ⚠️ `min-w-0` 是给 `truncate` 用的（flex 项默认 `min-width:auto`，
          不加的话截不断，长名字会把整格撑破）。 */}
      <span
        className="min-w-0 shrink truncate text-[0.7857em] text-content-subtle"
        title={cond.note !== "" ? `${cond.name} — ${cond.note}` : cond.name}
      >
        {cond.name}
      </span>
      {/* **下拉均分那一格的剩余宽度**（`flex-1 min-w-0`）。
          长选项由原生 `select` 截断显示，`title` 兜底让悬停能看全 ——
          用户明确说了"不管里面的选项的长度"。 */}
      <select
        value={current}
        onChange={(e) => onPick(cond.name, e.target.value)}
        title={current === "" ? undefined : labelOf(current)}
        // 现读的候选还没到 → 禁用。点开一个空下拉会让人以为软件坏了。
        disabled={live && choices.length === 0}
        // 原生的 select:它在这个位置比自绘弹层稳(输入框区域已经有一层
        // base-ui 的 portal),而这里要的就是"点开、选一个"这么简单的事。
        className="min-w-0 flex-1 rounded border border-edge bg-surface/40 px-1.5 py-0.5 text-[0.7857em] text-content-muted outline-none hover:text-content focus:border-accent disabled:opacity-50"
      >
        {/* 未设的显示「—」:诚实的空态 —— 它在提示词里也不存在,两头一致。 */}
        {current === "" && <option value="">—</option>}
        {/* 选过但这次拉不到的:留着它,别让下拉跳回「—」。 */}
        {orphaned && <option value={current}>{labelOf(current)}</option>}
        {live && choices.length === 0 && (
          <option value="">{t("chat.nodeCriteria.noOptions")}</option>
        )}
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {labelOf(choice)}
          </option>
        ))}
      </select>
    </label>
  );
}
