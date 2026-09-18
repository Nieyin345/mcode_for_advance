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
import { MAIN_NODE_TYPE_ID, NODE_CRITERIA_PARAM_KEY } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { IconAdjustmentsHorizontal, IconInfoCircle } from "@renderer/lib/icons.js";

/** 主节点条件表在聊天侧的一行(候选值滤过空串;note 是给模型的解释,可空)。 */
interface CriteriaRow {
  name: string;
  choices: string[];
  note: string;
}

/** 从文档的主节点参数袋里读出条件表。与 `ParamField` 的 `critRows` 同一条读法。 */
function criteriaRowsOf(doc: WorkflowDoc | null): CriteriaRow[] {
  const main = doc?.nodes.find((node) => node.type === MAIN_NODE_TYPE_ID);
  const raw = main?.params[NODE_CRITERIA_PARAM_KEY];
  if (!Array.isArray(raw)) return [];
  const out: CriteriaRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, choices, note } = item as { name?: unknown; choices?: unknown; note?: unknown };
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(choices)) continue;
    // **空白候选值在这里滤掉。** 盘上会留着它们 —— 编辑态那个多行框得能按下回车,
    // 空行才留得住(见 ParamField 的 `toCriteria`),所以过滤的责任落在显示这一头:
    // 不然编辑时按下的每个回车都会在下拉里变成一个看不见的空选项。
    const list = choices.filter((c): c is string => typeof c === "string" && c.trim() !== "");
    if (list.length === 0) continue;
    out.push({ name, choices: list, note: typeof note === "string" ? note : "" });
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
    // **一行,不折行。** 条件多的时候横向滚,而不是把这排控件挤成好几行 —— 它是输入框
    // 顶边上的一条,长高了就是把输入框往下推(`flex-nowrap` 是这里的关键)。
    //
    // 窄到装不下时(手机宽实测 430px)会露出半个条件,那就是"右边还有"的提示,所以
    // 用 `no-scrollbar` 藏掉那条 8px 的横条 —— 它会把这条的高度从 34 顶到 44,而这条
    // 高度是直接从输入框身上扣的。`overscroll-x-contain` 挡住横滑穿透到浏览器的
    // 前进/后退手势。
    <div className="no-scrollbar flex flex-nowrap items-center gap-x-3 overflow-x-auto overscroll-x-contain border-t border-edge px-2.5 pt-1.5 pb-0.5">
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
      {conditions.map((cond) => {
        const current = values?.[cond.name] ?? "";
        return (
          <label key={cond.name} className="flex shrink-0 items-center gap-1.5">
            {/* 条件名上挂着解释(配置时写给模型的那句):悬停可见 —— 用户看得见
                "选它是什么口径",不必切回设置页翻。 */}
            <span
              className="shrink-0 text-[0.7857em] text-content-subtle"
              title={cond.note !== "" ? `${cond.name} — ${cond.note}` : undefined}
            >
              {cond.name}
            </span>
            {/* **下拉的宽度跟着选中的那条走**(不给固定宽度)。候选值里长的是真长
                (内置检索图的「期刊层次」有一条是「只要 T1(Q1 或中科院 1 区,或 Top)」),
                定死 220px 的话选完根本读不出选了什么 —— 用户报的「显示得不合理」。
                `max-w-[420px]` 只是兜底,免得一条特别长的把整条挤得没地方放别的。
                **这一格上不写 `truncate`**:原生 select 的宽度本来就跟着选项文字走,
                写上去反而可能被压窄;真顶到 420 上限时靠 `title` 兜底(悬停能看全)。 */}
            <select
              value={current}
              onChange={(e) => pick(cond.name, e.target.value)}
              title={current === "" ? undefined : current}
              // 原生的 select:它在这个位置比自绘弹层稳(输入框区域已经有一层
              // base-ui 的 portal),而这里要的就是"点开、选一个"这么简单的事。
              className="max-w-[420px] rounded border border-edge bg-surface/40 px-1.5 py-0.5 text-[0.7857em] text-content-muted outline-none hover:text-content focus:border-accent"
            >
              {/* 未设的显示「—」:诚实的空态 —— 它在提示词里也不存在,两头一致。 */}
              {current === "" && <option value="">—</option>}
              {cond.choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
