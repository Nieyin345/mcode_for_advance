/**
 * 主对话节点的**固定条件** —— 从设置表读出选中值,拼成一段提示词。
 *
 * ## 为什么要单独一段
 *
 * 用户的原话:「不止是 2-4 个问题,需要比较详细的,包括时间范围,影响因子,论文层次
 * 等等这些,**但是一般这些都是固定的习惯**,之后就是方向问题」。所以检索条件被切成
 * 两层:不变的习惯在**输入框上方的筛选条**上选(渲染端写进设置表),每轮真正要问的
 * 只剩研究方向。这一段就是把那几条习惯转成模型能执行的指令。**必须由主进程读** ——
 * 只有它和设置表在一起;而且这样"界面上显示的条件"和"模型执行的条件"永远是同一份。
 *
 * ## 条件的**定义**长在主对话节点上
 *
 * 条件表是**主对话节点的「固定条件」参数**(`@contracts/nodeType` 的
 * `NODE_CRITERIA_PARAM_KEY`),内置检索图的主节点预填了那四条,用户可以改候选、加条件、
 * 删条件;选中的值存在设置表(`WORKFLOW_NODE_PREFS_SETTING_PREFIX` + workflowId)。
 * 节点上有什么条件,这里就注什么条件 —— 曾经那条写死四下拉、只认 `search.*` 旧设置键
 * 的老路径已经拆掉,统一走这一条。
 *
 * ## 注入时机:随**那次对话第一轮**的运行提示词进主节点,一次
 *
 * 调用方是 `orchestration/runner.ts` 的 `startWorkflowRun`:条件拼进运行最初的提示词,
 * 交给入口(主)节点 —— **只在对话还没有任何消息的那一轮注入**;之后它已经在上下文
 * 里,不再重复(下游步骤从上游产出里拿条件,内置检索图的主节点被要求把这几条原样
 * 写进产出,见 `builtins.ts` 的指令)。节点会话的系统提示词**不**再携带这段(那是过去
 * "每个节点都注一遍"的老做法)。
 *
 * ## 一条硬规矩:查不了就说查不了
 *
 * 期刊层次与影响因子要靠 `jcr.db`(用户自己维护的商业数据)。**没这个库的时候,宁可
 * 明说"我查不了",也不能让模型凭印象报一个影响因子** —— 编出来的数字比没有数字更糟,
 * 而它看起来同样可信。所以数据不可用时这一段会明确写上去,并要求模型转告用户。
 */
import { journalDbPath } from "@main/library/journalRank.js";
import { SettingRepo } from "@main/store/repositories.js";
import { WORKFLOW_NODE_PREFS_SETTING_PREFIX } from "@contracts/ipc";

/** 固定条件表在节点参数里的形状(见 `@contracts/nodeType` 的 `NODE_CRITERIA_PARAM_KEY`)。
 *  `note` 是这个条件的解释(它是什么意思、按哪个口径执行),可选 —— 老存档没有。 */
export interface CriteriaCondition {
  name: string;
  choices: string[];
  note?: string;
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
    const value = (values[cond.name] ?? "").trim();
    if (value === "" || value === "不限") continue;
    // 有解释的条件把解释挂在**行尾**,不能挤在值后面 —— 值那一格是 `withYearNote`
    // 的地盘(它要整串恰好是「近N年」才换得出绝对年份),挤进去换算就静默失效了。
    const note = (cond.note ?? "").trim();
    const line = `- ${cond.name}:${withYearNote(value)}`;
    lines.push(note === "" ? line : `${line} —— ${note}`);
  }
  if (lines.length === 0) return "";

  const parts = [
    `## 这次的固定条件`,
    `用户在输入框上方设好了下面这几条(是他一贯的习惯,**不要再问他**):`,
    lines.join("\n"),
  ];

  // 期刊档次/影响因子那段告诫只属于检索流程 —— `library_journal_rank` 这个工具只在
  // 那张图里出现。别的流程配了自定义条件,注的就是条件本身,不捎带检索工具的规矩。
  if (workflowId === "search") {
    const hasJournalFilter = lines.some((line) => /^(期刊|影响因子)/.test(line.slice(2)));
    if (hasJournalFilter) {
      const dbPath = journalDbPath();
      parts.push(
        dbPath
          ? `\n筛选时必须用 **library_journal_rank** 去查每一篇的期刊档次(数据在 \`${dbPath}\`),` +
              `按上面的条件筛。**绝不要凭印象说某个刊影响因子多少、几区** —— 查不到就说查不到。`
          : `\n⚠️ **期刊数据(jcr.db)不在,查不了期刊档次和影响因子。** 所以上面那两条期刊条件` +
              `这次**无法执行** —— 开场就如实告诉用户这件事,并且**不要**凭印象给影响因子或分区` +
              `(编出来的数字看起来一样可信,但那是错的)。其余条件照常执行。`,
      );
    }
    parts.push(
      `\n条件太严导致某档一篇都没有时,**如实说明"按这个条件只有 N 条"并问用户要不要放宽**,` +
        `不要悄悄放宽了再报结果。`,
    );
  }

  return parts.join("\n");
}

/** 「近 N 年」→ 追加绝对年份。别的说法原样返回。
 *
 *  **两种数字写法都要认。** 内置检索图预填的候选值是**汉字数字**(`近三年` / `近五年` /
 * `近十年`,见 `builtins.ts`),而这里原先只认 ASCII 数字 —— 于是换算对随应用发布的那
 * 张图**从来没生效过**(相对词看起来明确,模型算错一年的事出过,这条注释写的就是它)。
 * 认不出来就原样返回,不猜。 */
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
