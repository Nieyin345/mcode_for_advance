/**
 * 文献检索模式下,输入框上方那条**固定条件**筛选条。
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
 * 不必浪费一轮对话去问已知的东西。用户后来的原话就是这个意思:「你可以在文献检索模式
 * 下面在 ui 上面加一个选择框……用户自己选择」。
 *
 * ## 只在检索模式出现
 *
 * 挂着它的时候其余四个模式完全看不到 —— 那些条件下一次也不会用到,常驻只会占地方。
 *
 * ## 值怎么变成提示词
 *
 * 这里只负责**存**(写进 settings 表)。主进程每轮把这几项读出来拼进系统提示词
 * (见 `main/lib/searchPrefs.ts`),所以 AI 拿到的一定是界面上显示的那一份 —— 不存在
 * "界面改了 AI 不知道"。
 */
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { useLibraryStore, type SearchPrefs } from "@renderer/stores/libraryStore.js";
import { IconAdjustmentsHorizontal } from "@renderer/lib/icons.js";

/** 一组可选项:码 → 显示名。 */
interface Option {
  value: string;
  labelKey: MessageId;
}

const YEAR_OPTIONS: Option[] = [
  { value: "any", labelKey: "chat.searchFilter.yearAny" },
  { value: "3", labelKey: "chat.searchFilter.year3" },
  { value: "5", labelKey: "chat.searchFilter.year5" },
  { value: "10", labelKey: "chat.searchFilter.year10" },
];

const TIER_OPTIONS: Option[] = [
  { value: "any", labelKey: "chat.searchFilter.tierAny" },
  { value: "t1", labelKey: "chat.searchFilter.tierT1" },
  { value: "t1t2", labelKey: "chat.searchFilter.tierT1T2" },
];

const IF_OPTIONS: Option[] = [
  { value: "any", labelKey: "chat.searchFilter.ifAny" },
  { value: "3", labelKey: "chat.searchFilter.if3" },
  { value: "5", labelKey: "chat.searchFilter.if5" },
  { value: "10", labelKey: "chat.searchFilter.if10" },
];

const LIMIT_OPTIONS: Option[] = [
  { value: "10", labelKey: "chat.searchFilter.limit10" },
  { value: "20", labelKey: "chat.searchFilter.limit20" },
  { value: "50", labelKey: "chat.searchFilter.limit50" },
];

export function SearchFilterBar() {
  const { t } = useI18n();
  const prefs = useLibraryStore((s) => s.searchPrefs);
  const setSearchPref = useLibraryStore((s) => s.setSearchPref);

  const groups: Array<{ key: keyof SearchPrefs; labelKey: MessageId; options: Option[] }> = [
    { key: "yearSpan", labelKey: "chat.searchFilter.year", options: YEAR_OPTIONS },
    { key: "tier", labelKey: "chat.searchFilter.tier", options: TIER_OPTIONS },
    { key: "minImpactFactor", labelKey: "chat.searchFilter.if", options: IF_OPTIONS },
    { key: "perSourceLimit", labelKey: "chat.searchFilter.limit", options: LIMIT_OPTIONS },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-edge px-2.5 pt-1.5">
      <span className="flex shrink-0 items-center gap-1 text-[0.7857em] text-content-subtle">
        <IconAdjustmentsHorizontal size={12} />
        {t("chat.searchFilter.title")}
      </span>
      {groups.map((g) => (
        <label key={g.key} className="flex shrink-0 items-center gap-1.5">
          <span className="text-[0.7857em] text-content-subtle">{t(g.labelKey)}</span>
          <select
            value={prefs[g.key]}
            onChange={(e) => setSearchPref(g.key, e.target.value)}
            // 原生的 select:它在这个位置比自绘弹层稳(输入框区域已经有一层
            // base-ui 的 portal),而这里要的就是"点开、选一个"这么简单的事。
            className="rounded border border-edge bg-surface/40 px-1.5 py-0.5 text-[0.7857em] text-content-muted outline-none hover:text-content focus:border-accent"
          >
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
