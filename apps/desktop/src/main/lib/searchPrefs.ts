/**
 * 主对话节点的**固定条件** —— 从设置表读出选中值,拼成一段提示词。
 *
 * ## 为什么要单独一段
 *
 * 用户的原话:「不止是 2-4 个问题,需要比较详细的 …… **但是一般这些都是固定的习惯**,
 * 之后就是方向问题」。所以一次对话的条件被切成两层:不变的习惯在**输入框上方的筛选条**
 * 上选(渲染端写进设置表),每轮真正要问的只剩这次要做什么。这一段就是把那几条习惯
 * 转成模型能执行的指令。**必须由主进程读** —— 只有它和设置表在一起;而且这样"界面上
 * 显示的条件"和"模型执行的条件"永远是同一份。
 *
 * 这是一个**通用**机制:任何工作流的主节点都可以声明自己的条件表(文件名里的
 * `search` 是历史遗留 —— 它最早是给文献检索图写的;2026-09-27 学术那一套搬出核心之后,
 * 期刊分区那段专属告诫也一起拿掉了,剩下的与任何领域无关)。
 *
 * ## 条件的**定义**长在主对话节点上
 *
 * 条件表是**主对话节点的「固定条件」参数**(`@contracts/nodeType` 的
 * `NODE_CRITERIA_PARAM_KEY`),用户可以改候选、加条件、删条件;选中的值存在设置表
 * (`WORKFLOW_NODE_PREFS_SETTING_PREFIX` + workflowId)。节点上有什么条件,这里就注
 * 什么条件 —— 曾经那条写死四下拉、只认 `search.*` 旧设置键的老路径已经拆掉,统一走这一条。
 *
 * ## 注入时机:随**那次对话第一轮**的运行提示词进主节点,一次
 *
 * 调用方是 `orchestration/runner.ts` 的 `startWorkflowRun`:条件拼进运行最初的提示词,
 * 交给入口(主)节点 —— **只在对话还没有任何消息的那一轮注入**;之后它已经在上下文
 * 里,不再重复(下游步骤从上游产出里拿条件)。节点会话的系统提示词**不**再携带这段
 * (那是过去"每个节点都注一遍"的老做法)。
 *
 * ## 一条硬规矩:查不了就说查不了
 *
 * 现读来源的 id 翻不出名字时(分类被删了、项目被移走了)注"已删除的分类(id)",
 * 不编一个名字 —— 编出来的东西看起来同样可信,但那是错的。
 */
import { CollectionRepo, ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { WORKFLOW_NODE_PREFS_SETTING_PREFIX } from "@contracts/ipc";

/** 固定条件表在节点参数里的形状(见 `@contracts/nodeType` 的 `NODE_CRITERIA_PARAM_KEY`)。
 *  `note` 是这个条件的解释(它是什么意思、按哪个口径执行),可选 —— 老存档没有。
 *  `source` 是候选**现读**的来源(见下面 `sourceLabelsOf`),可选 —— 有它时 `choices` 是空的。 */
export interface CriteriaCondition {
  name: string;
  choices: string[];
  note?: string;
  source?: string;
}

/**
 * 读某张工作流的条件选中值(`WORKFLOW_NODE_PREFS_SETTING_PREFIX` + workflowId)。
 * 值是一张 `{ 条件名: 选中值 }` 的小地图;坏 JSON / 非对象 / 非字符串值都当"没设"。
 */
export function readCriteriaValues(workflowId: string): Record<string, string> {
  const raw = SettingRepo.get(WORKFLOW_NODE_PREFS_SETTING_PREFIX + workflowId);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * **现读来源**的选中值 → 可读名。
 *
 * ## 为什么非翻不可
 *
 * 候选现读的那些条件(见 `NODE_CRITERIA_PARAM_KEY` 的 `source`),界面上存进设置表的
 * 是**不透明的 id**(`lc_xxx` / `proj_xxx`)。原样注进提示词的话,模型读到的是
 * `- 导入到:lc_mufvfytr_d8q0s4` —— 它没法知道那是哪个分类,而这条条件的全部意义就是
 * 告诉它"东西放哪儿"。所以注入前必须换成用户看得懂的那个名字。
 *
 * ## 查不到时**说查不到**
 *
 * 分类被删了、项目被移走了:那句 id 就是死引用。这时注**它是什么**("已删除的分类
 * (lc_xxx)")而不是编一个名字 —— 同这个文件头上那条"查不了就说查不了"的规矩。
 */
function sourceLabelsOf(): {
  collections: Map<string, string>;
  projects: Map<string, string>;
} {
  const collections = new Map<string, string>();
  try {
    for (const c of CollectionRepo.list()) collections.set(c.id, c.name);
  } catch {
    // 库还没起来 / 数据不可用 —— 留空表,下面会按"查不到"报出去。
  }
  const projects = new Map<string, string>();
  try {
    for (const p of ProjectRepo.list()) projects.set(p.id, p.name);
  } catch {
    /* 同上 */
  }
  return { collections, projects };
}

/** 一个来源里的 id → 可读名。认不出来按"已删除"报,不猜。 */
function labelForSource(source: string | undefined, id: string): string {
  if (source === undefined) return id;
  const { collections, projects } = sourceLabelsOf();
  const table = source === "collections" ? collections : source === "projects" ? projects : null;
  if (table === null) return id;
  return table.get(id) ?? `已删除的${source === "collections" ? "分类" : "项目"}(${id})`;
}

/**
 * 主对话节点那套**动态条件**的提示词片段。
 *
 * 遍历**节点上声明的条件**(不是设置表里的键 —— 用户改过名/删过条件之后,设置表里的
 * 旧键是孤儿,跟着条件遍历才不会把没人认识的东西注进去),值为「不限」/空的跳过。
 * 相对说法「近 N 年」就地换算成绝对年份 —— 相对词看起来明确,模型算错一年的事出过。
 */
export function nodeCriteriaPrompt(workflowId: string, conditions: CriteriaCondition[]): string {
  const values = readCriteriaValues(workflowId);
  const lines: string[] = [];
  for (const cond of conditions) {
    if (!cond.name) continue;
    const raw = (values[cond.name] ?? "").trim();
    if (raw === "" || raw === "不限") continue;
    // 现读来源的存的是 id —— 换成名字再进提示词(见 `labelForSource`)。
    const value = labelForSource(cond.source, raw);
    // 有解释的条件把解释挂在**行尾**,不能挤在值后面 —— 值那一格是 `withYearNote`
    // 的地盘(它要整串恰好是「近N年」才换得出绝对年份),挤进去换算就静默失效了。
    const note = (cond.note ?? "").trim();
    // 「近 N 年」那套换算**只对手写候选**做:现读来源的值是分类名/项目名,把它喂给
    // `withYearNote` 只是白走一趟(它认不出就原样返回),但语义上不该沾 —— 那是一条
    // 给"时间范围"这类人类写法的规则。
    const shown = cond.source === undefined ? withYearNote(value) : value;
    const line = `- ${cond.name}:${shown}`;
    lines.push(note === "" ? line : `${line} —— ${note}`);
  }
  if (lines.length === 0) return "";

  const parts = [
    `## 这次的固定条件`,
    `用户在输入框上方设好了下面这几条(是他一贯的习惯,**不要再问他**):`,
    lines.join("\n"),
  ];

  return parts.join("\n");
}

/** 「近 N 年」→ 追加绝对年份。别的说法原样返回。
 *
 *  **两种数字写法都要认。** 用户手写的候选值常是**汉字数字**(`近三年` / `近五年` /
 * `近十年`),而这里原先只认 ASCII 数字 —— 于是换算对那些候选**从来没生效过**(相对词
 * 看起来明确,模型算错一年的事出过,这条注释写的就是它)。认不出来就原样返回,不猜。 */
function withYearNote(value: string): string {
  const m = /^近(.+)年$/.exec(value);
  const raw = m?.[1];
  if (raw === undefined) return value;
  const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : chineseNumber(raw);
  if (n === null || !Number.isFinite(n) || n <= 0) return value;
  return `${value}(即 ${new Date().getFullYear() - n} 年以后)`;
}

/**
 * 把 `三` / `十` / `十五` / `二十` / `二十三` 这类中文数字读成一个整数。
 * **认不出来返回 `null`** —— 调用方原样返回,不猜(「近些年」不该被当成某个数字)。
 */
function chineseNumber(raw: string): number | null {
  const DIGITS: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (raw === "十") return 10;
  const at = raw.indexOf("十");
  if (at < 0) return DIGITS[raw] ?? null;
  const head = raw.slice(0, at);
  const tail = raw.slice(at + 1);
  const tens = head === "" ? 1 : (DIGITS[head] ?? null);
  if (tens === null) return null;
  if (tail === "") return tens * 10;
  const ones = DIGITS[tail];
  return ones === undefined ? null : tens * 10 + ones;
}
