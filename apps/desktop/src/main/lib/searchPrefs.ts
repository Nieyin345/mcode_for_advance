/**
 * 文献检索的**固定条件** —— 从设置表读出来,拼成一段系统提示词。
 *
 * ## 为什么要单独一段
 *
 * 用户的原话:「不止是 2-4 个问题,需要比较详细的,包括时间范围,影响因子,论文层次
 * 等等这些,**但是一般这些都是固定的习惯**,之后就是方向问题」。所以检索条件被切成
 * 两层:不变的习惯在**输入框下方的筛选条**上选(渲染端写进设置表),每轮真正要问的
 * 只剩研究方向。
 *
 * 这一段就是把那几条习惯转成模型能执行的指令。**必须由主进程读** —— 只有它和设置表
 * 在一起;而且这样"界面上显示的条件"和"模型执行的条件"永远是同一份,不存在界面改了
 * 模型不知道。
 *
 * ## 一条硬规矩:查不了就说查不了
 *
 * 期刊层次与影响因子要靠 `jcr.db`(用户自己维护的商业数据)。**没这个库的时候,宁可
 * 明说"我查不了",也不能让模型凭印象报一个影响因子** —— 编出来的数字比没有数字更糟,
 * 而它看起来同样可信。所以数据不可用时这一段会明确写上去,并要求模型转告用户。
 */
import {
  SEARCH_JOURNAL_DB_SETTING_KEY,
  SEARCH_LIMIT_SETTING_KEY,
  SEARCH_MIN_IF_LABELS,
  SEARCH_MIN_IF_SETTING_KEY,
  SEARCH_TIER_LABELS,
  SEARCH_TIER_SETTING_KEY,
  SEARCH_YEAR_SPAN_LABELS,
  SEARCH_YEAR_SPAN_SETTING_KEY,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { journalDbPath } from "@main/library/journalRank.js";

/**
 * 把固定条件拼成提示词片段。用户什么都没设(全"不限")时返回空串 —— 没有条件就不该
 * 往提示词里塞一段"条件是不限"的废话。
 */
export function searchCriteriaPrompt(): string {
  const yearSpan = SettingRepo.get(SEARCH_YEAR_SPAN_SETTING_KEY) ?? "any";
  const tier = SettingRepo.get(SEARCH_TIER_SETTING_KEY) ?? "any";
  const minIf = SettingRepo.get(SEARCH_MIN_IF_SETTING_KEY) ?? "any";
  const limit = SettingRepo.get(SEARCH_LIMIT_SETTING_KEY) ?? "20";

  const yearLabel = SEARCH_YEAR_SPAN_LABELS[yearSpan];
  const tierLabel = SEARCH_TIER_LABELS[tier];
  const ifLabel = SEARCH_MIN_IF_LABELS[minIf];
  // 认不出来的码当"不限"处理 —— 界面换了选项之后旧值仍然可读,不会让整段烂掉
  const wantsTier = tierLabel && tier !== "any" ? tierLabel : null;
  const wantsIf = ifLabel && minIf !== "any" ? ifLabel : null;

  const lines: string[] = [];
  if (yearLabel && yearSpan !== "any") lines.push(`- 时间范围:${yearLabel}(按发表年份)${yearNote(yearSpan)}`);
  if (wantsTier) lines.push(`- 期刊层次:${wantsTier}`);
  if (wantsIf) lines.push(`- 影响因子:${wantsIf}`);
  lines.push(`- 每个数据源取 ${limit} 条`);

  const hasFilter = Boolean(wantsTier || wantsIf);
  const dbPath = journalDbPath();

  const parts = [
    `## 这次检索的固定条件`,
    `用户在输入框下方设好了下面这几条(是他一贯的习惯,**不要再问他**):`,
    lines.join("\n"),
  ];

  if (hasFilter) {
    if (dbPath) {
      parts.push(
        `\n筛选时必须用 **library_journal_rank** 去查每一篇的期刊档次(数据在 \`${dbPath}\`),` +
          `按上面的条件筛。**绝不要凭印象说某个刊影响因子多少、几区** —— 查不到就说查不到。`,
      );
    } else {
      parts.push(
        `\n⚠️ **期刊数据(jcr.db)不在,查不了期刊档次和影响因子。** 所以上面那两条期刊条件` +
          `这次**无法执行** —— 开场就如实告诉用户这件事,并且**不要**凭印象给影响因子或分区` +
          `(编出来的数字看起来一样可信,但那是错的)。其余条件照常执行。`,
      );
    }
  }

  parts.push(
    `\n条件太严导致某档一篇都没有时,**如实说明"按这个条件只有 N 条"并问用户要不要放宽**,` +
      `不要悄悄放宽了再报结果。`,
  );

  // 全是"不限"并且条数还是默认值时,没什么好交代的 —— 别往提示词里塞一段
  // 「你的条件是:不限」的废话。
  const anyReal = yearSpan !== "any" || Boolean(wantsTier) || Boolean(wantsIf) || limit !== "20";
  if (!anyReal) return "";
  return parts.join("\n");
}

/** 时间跨度码 → 具体的年份下限。相对说法(近五年)必须换算成绝对年份才能去检索。 */
function yearNote(span: string): string {
  const n = Number.parseInt(span, 10);
  if (!Number.isFinite(n) || n <= 0) return "";
  const from = new Date().getFullYear() - n;
  return `,即 ${from} 年以后`;
}
