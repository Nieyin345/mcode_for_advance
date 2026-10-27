/**
 * 【T119】**Claude 桌面端输入框的视觉外壳** —— 常量与 class 的唯一一份。
 *
 * ## 它是什么，不是什么
 *
 * **不是** `open-claude-ui/code-examples/ChatComposer.tsx` 的移植。那个文件是
 * `textarea` + 菜单的实现，**没有**内联 skill pill、**没有**引用 chip
 * （`AttachmentTile` / `ContentTagChip`）—— 而这两样是本产品明确要保留的能力
 * （`ChatPane` 有 8 处依赖 `editorRef.insertSkill` / `serialize`，`ime-enter-smoke`
 * 也在测）。整份移植会**换掉能力**，不是换外观。
 *
 * 它是**上游视觉规格的可核对副本**：下面每个常量都注明来源于
 * `open-claude-ui/code-examples/ChatComposer.tsx` 的哪一行。改这里之前先去那一行看一眼，
 * 别凭印象改。
 *
 * ## 为什么外框不在这里
 *
 * 20px 圆角与三态双环投影**已经**由 `gen-cds-tokens.mjs` 从上游
 * `open-claude-ui/code-examples/cds-theme.css` 提取进 `tokens.cds.css`：
 *
 * ```css
 * --m-radius-composer: 20px;                                    (tokens.cds.css:86)
 * --m-shadow-composer: 0 4px 20px rgba(0,0,0,0.035), inset ...; (tokens.cds.css:91)
 * --m-shadow-composer-focus: 0 4px 24px rgba(0,0,0,0.08), ...;  (tokens.cds.css:92)
 * ```
 *
 * `ChatPane` 的 `composer-card` 已经在用它们（`rounded-[var(--composer-radius)]`
 * `shadow-[var(--composer-shadow)]`）。所以这里**不重复定义**外框 —— 数值只有生成物
 * 一份，上游变了重跑生成器即全体跟随。重复一份就会漂。
 */

/* ─────────── 上游 ChatComposer.tsx 的视觉常量（逐条带行号） ─────────── */

/** 附件行：横向单行滚动，不放不行就换行。
 *  来源：`ChatComposer.tsx:109`
 *  `flex items-center gap-2 overflow-x-auto pb-1.5 pt-0.5`
 *
 *  为什么是横向而不是 `flex-wrap`：引用多时换行会把输入框整体顶高，
 *  而 Claude 桌面端保持输入框高度稳定、附件在一条可横滑的带里。 */
export const COMPOSER_ATTACHMENT_ROW =
  "flex items-center gap-2 overflow-x-auto px-2 pb-1.5 pt-2";

/** 输入区文字排版。
 *
 * 【UI 重建 2026-10-27】**改成读上游变量，不再写死 px。**
 *
 * 上一版是 `text-[15px] leading-[1.4]`，注释引的是第三方逆向仓
 * `ChatComposer.tsx:145`。从本机 Claude 3.6556.2.0 的产物直接读，输入框字号
 * 不是字面量，而是**一条联立的算式**（`c6a992d55-Che1orl5.css` 的 `--cmp-*` 组）：
 *
 *   --cmp-type-size = max(--cds-font-size-text-entry-floor, --cds-font-size-prose)
 *                   = max(16px, 16px) = **16px**
 *   --cmp-leading   = round(type-size × 1.4, 1px) = **22px**
 *
 * 所以字号是 **16px**，比旧的 15px 大一档 —— 而这**不是**随手调的：16px 是
 * `--cds-font-size-text-entry-floor`（防 iOS 聚焦自动缩放的下限）与 prose 取大者，
 * 小的那一半在任何档位都不生效。写 15px 等于绕开了这条地板。
 *
 * 行高也不是 `1.4` 的裸比值：`round(16 × 1.4, 1px)` = 22px，即 **1.375** 的等效
 * 高度。两个值都从 `--cmp-*` 算出来，改字号时行高自动跟着变（这是上游
 * 「文字变大气泡跟着长」的机制）。`--cmp-type-size` / `--cmp-leading`
 * 已在 styles.css 的 Composer 段定义好，这里直接引用。 */
export const COMPOSER_TEXT =
  "text-[length:var(--cmp-type-size)] leading-[var(--cmp-leading)]";

/** 输入区内边距。来源：`ChatComposer.tsx:102`
 *  外层容器 `p-[0.875rem]`（14px）。
 *
 *  注意：上游把它放在**外框**上，我们的外框已经由 `composer-card` + token 承担，
 *  所以 14px 落在这里由编辑区与底部操作行分摊（左右各 14px 的效果等价）。 */
export const COMPOSER_PADDING_X = "px-3.5"; // 0.875rem = 14px

/** 发送按钮。来源：`ChatComposer.tsx:258`
 *  `size-8 rounded-lg ... transition-all duration-150 ... shadow-xs active:scale-95`
 *
 *  ⚠️ **是 `rounded-lg`，不是 `rounded-full`** —— 这条我口头汇报时说过一次
 *  「改 rounded-full」，去核上游原文后发现说错了，以本行为准。 */
export const COMPOSER_SEND_BUTTON = [
  "size-8 shrink-0",
  "rounded-lg",
  "flex items-center justify-center",
  "transition-all duration-150",
  "active:scale-95",
].join(" ");

/** 发送按钮的禁用态。来源：`ChatComposer.tsx:258`
 *  `disabled:opacity-30 disabled:cursor-not-allowed`
 *
 *  上游用 `opacity-30`；我们用 `bg-surface-hover + text-content-subtle`（见 ChatPane 的
 *  既有 class）。**这里不覆盖**：两种都能表达"不可点"，而我们的主题变量在暗色下更稳。
 *  记录下来是为了让差异**可见**，而不是让下一个人以为漏了。 */
export const COMPOSER_SEND_DISABLED_UPSTREAM_NOTE =
  "上游用 disabled:opacity-30；我们保留 bg-surface-hover + text-content-subtle";
