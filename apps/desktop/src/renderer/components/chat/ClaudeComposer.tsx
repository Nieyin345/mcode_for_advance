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
 *  来源：`ChatComposer.tsx:145`
 *  `text-[15px] leading-[1.4] ... pl-1.5`
 *
 *  ⚠️ 只取排版三项（字号 / 行高 / 左内边距）。上游那一行的
 *  `bg-transparent border-none outline-none resize-none` 是给 `<textarea>` 的，
 *  我们的编辑区是 Tiptap 的 contenteditable，**不适用** —— 照抄会清掉它自己的边框语义。 */
export const COMPOSER_TEXT = "text-[15px] leading-[1.4]";

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
