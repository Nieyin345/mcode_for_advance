/**
 * 【T120】用户气泡超长折叠 —— 判据与接入的回归。
 *
 * ## 钉的是什么
 *
 * 上游 `ChatMessageBubbles.tsx` 对**用户消息**做了「超长就折叠 + 底部渐变 + 展开按钮」，
 * Mcode 的 `MessageRow.tsx` 原先只有 `overflow-hidden`，**没有高度上限**。
 * 用户往输入框贴一大段日志，消息就把视口铺满，而且看不出底下还有多少。
 *
 * ## 为什么判据单独可测
 *
 * `messageCollapse.ts` 是纯函数（与同目录 `composerPhysicalRules.ts` 同一惯例）：
 * 「多高算溢出」「收起时多高」「渐变多高」「按钮显示什么」都不需要真实 DOM。
 * 这一套 import 的是**生产里那一个函数**，不是抄一份（硬规矩 26）。
 *
 * ## 断言分三层
 *
 * | 层 | 验什么 |
 * |---|---|
 * | 判据 | 阈值、边界、未测量态 |
 * | 样式 | 收起的 maxHeight / mask，展开时不加限制 |
 * | **接入** | `MessageRow.tsx` 真的调了它们（**没有它，函数写对了但没人用**） |
 */
import { readFileSync } from "node:fs";
// 【T120】源码文本断言必须剥注释（实测：注释掉真代码后裸 includes 仍绿）。
import { sourceHas } from "../lib/sourceText.js";
import { resolve } from "node:path";
import {
  COLLAPSED_MAX_HEIGHT_PX,
  COLLAPSE_THRESHOLD_PX,
  FADE_HEIGHT_PX,
  bubbleBodyStyle,
  collapseToggleLabel,
  collapsibleBubbleState,
} from "../../src/renderer/components/chat/messageCollapse.js";

let total = 0;
let bad = 0;
const ck = (s: string, b: boolean, detail?: unknown): void => {
  total++;
  if (!b) bad++;
  console.log((b ? "PASS " : "FAIL ") + s + (b || detail === undefined ? "" : " — " + JSON.stringify(detail)));
};

/* ── ① 判据：阈值与边界 ─────────────────────────────────────────────── */

console.log("\n① 状态判定");
ck("上游的 300px 阈值被沿用", COLLAPSE_THRESHOLD_PX === 300, COLLAPSE_THRESHOLD_PX);
ck("收起高度与阈值同值（上游也是）", COLLAPSED_MAX_HEIGHT_PX === COLLAPSE_THRESHOLD_PX);
ck("渐进高度 3rem = 48px", FADE_HEIGHT_PX === 48, FADE_HEIGHT_PX);

ck("短消息不折叠", collapsibleBubbleState({ contentHeightPx: 120, userExpanded: false }) === "fits");
ck("★ 恰好等于阈值 → 不折叠（边界是「大于」）",
  collapsibleBubbleState({ contentHeightPx: 300, userExpanded: false }) === "fits");
ck("★ 超过 1px → 折叠",
  collapsibleBubbleState({ contentHeightPx: 301, userExpanded: false }) === "collapsed");
ck("超长 + 已展开 → expanded",
  collapsibleBubbleState({ contentHeightPx: 3000, userExpanded: true }) === "expanded");

console.log("\n② 未测量态（首次渲染 / 元素隐藏）");
ck("★ 高度 0 → fits（不闪折叠按钮）",
  collapsibleBubbleState({ contentHeightPx: 0, userExpanded: false }) === "fits");
ck("★ NaN → fits", collapsibleBubbleState({ contentHeightPx: Number.NaN, userExpanded: false }) === "fits");
ck("★ 负数 → fits", collapsibleBubbleState({ contentHeightPx: -5, userExpanded: false }) === "fits");

/* ── ③ 样式 ─────────────────────────────────────────────────────── */

console.log("\n③ 样式");
const collapsed = bubbleBodyStyle("collapsed");
ck("收起时限制高度", collapsed?.maxHeight === "300px", collapsed?.maxHeight);
ck("收起时裁掉溢出", collapsed?.overflowY === "hidden");
ck("★ 收起时有渐变遮罩", (collapsed?.maskImage ?? "").includes("linear-gradient"), collapsed?.maskImage);
ck("★ 渐变从底部 48px 开始",
  (collapsed?.maskImage ?? "").includes("calc(100% - 48px)"), collapsed?.maskImage);
ck("WebKit 前缀同值", collapsed?.WebkitMaskImage === collapsed?.maskImage);
ck("★ 展开时不加任何限制", bubbleBodyStyle("expanded") === null);
ck("★ 不折叠时也不加限制", bubbleBodyStyle("fits") === null);
ck("自定义渐变高度能生效",
  (bubbleBodyStyle("collapsed", 32)?.maskImage ?? "").includes("calc(100% - 32px)"));

console.log("\n④ 按钮标签");
ck("收起态显示「展开」", collapseToggleLabel("collapsed") === "expand");
ck("展开态显示「收起」", collapseToggleLabel("expanded") === "collapse");
ck("★ 不折叠时没有按钮", collapseToggleLabel("fits") === null);

/* ── ⑤ ★ 接入：生产代码真的调了它 ─────────────────────────────────── */

console.log("\n⑤ 接入（没有这一节，函数写对了也可能没人用）");
{
  const row = readFileSync(resolve("src/renderer/components/chat/MessageRow.tsx"), "utf8");
  ck("★ MessageRow 导入了判据", sourceHas(row, "messageCollapse.js"));
  ck("★ MessageRow 调用了 collapsibleBubbleState", sourceHas(row, "collapsibleBubbleState("));
  ck("★ MessageRow 调用了 bubbleBodyStyle", sourceHas(row, "bubbleBodyStyle("));
  ck("★ MessageRow 调用了 collapseToggleLabel", sourceHas(row, "collapseToggleLabel("));
  ck("★ 折叠按钮真的渲染了", sourceHas(row, "setBubbleExpanded"));
  // 这一条钉的是「只对用户消息」——助手侧折叠会让流式输出期间视口反复跳动，
  // 上游也只对用户消息做（ChatMessageBubbles 的 UserMessageProps）。
  ck("★ 只在用户消息上判定", sourceHas(row, "isUser\n    ? collapsibleBubbleState") || sourceHas(row, "isUser ?\n      collapsibleBubbleState") || /isUser[\s\S]{0,40}collapsibleBubbleState/.test(row));
  ck("★ 量高度用的是 scrollHeight（不受 maxHeight 影响）", sourceHas(row, "scrollHeight"));
}

/* ── ⑥ 可见性与缩放后的重新测量（ARC-005） ───────────────────────── */
{
  const row = readFileSync(resolve("src/renderer/components/chat/MessageRow.tsx"), "utf8");
  const clip = row.indexOf('data-user-bubble-clip=""');
  const measure = row.indexOf('data-user-bubble-measure=""');
  const toggle = row.indexOf('aria-expanded={collapseState === "expanded"}');
  // The toggle must not be inside the maxHeight/mask container: otherwise
  // long pasted logs clip the only control that can reveal their contents.
  ck("★ user message content has its own masked viewport", clip >= 0 &&
    sourceHas(row, "style={bodyStyle ?? undefined}") &&
    measure > clip);
  ck("★ expand/collapse button sits OUTSIDE the masked viewport", toggle > clip &&
    /<\/div>\s*<\/div>\s*\)\s*:\s*\(/.test(row.slice(clip, toggle)) &&
    row.indexOf("{toggleLabel !== null && (", clip) < toggle);
  ck("★ copy/edit action row is visible on keyboard focus, not hover only",
    sourceHas(row, "group-hover:opacity-100 group-focus-within:opacity-100") &&
    sourceHas(row, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
  ck("★ visible toggle exposes expanded state to keyboard/screen reader",
    sourceHas(row, 'aria-expanded={collapseState === "expanded"}') &&
    sourceHas(row, "aria-controls={bubbleContentId}"));
  ck("★ narrow/wide pane resize remeasures intrinsic bubble content",
    sourceHas(row, "new ResizeObserver(updateBubbleHeight)") &&
    sourceHas(row, "observer.observe(node.firstElementChild)") &&
    sourceHas(row, "observer.disconnect()"));
  // Mutation-style negative checks prove these assertions would fail if the
  // masked viewport or resize observer were accidentally removed.
  ck("negative control: removing content viewport breaks the layout predicate",
    !row.replace('data-user-bubble-clip=""', "").includes('data-user-bubble-clip=""'));
  ck("negative control: removing intrinsic-size observer breaks the resize predicate",
    !sourceHas(row.replace("observer.observe(node.firstElementChild)", ""), "observer.observe(node.firstElementChild)"));
}

/* ── ⑦ Mcode 侧的折叠加渐隐常数 ─────────────────────────────────── */

console.log("\n⑦ 折叠常数（测 Mcode 自己的实现）");
{
  /* 【UI 重建 2026-10-27】这里原本读 `open-claude-ui/.../ChatMessageBubbles.tsx`
       —— 第三方逆向的参考实现，外观基准换成用户本机 Claude Desktop 后
       那份源码已不在仓库。改成**测 Mcode 自己的实现**：原来验的是
       「我们和上游用同一个阈值」，现在验「阈值本身还是那个值」。
       数值没变（300 / 3rem），变的只是被测对象。 */
  const collapseSrc = readFileSync(
    resolve("src/renderer/components/chat/messageCollapse.ts"),
    "utf8",
  );
  ck("★ 折叠阈值仍是 300px", sourceHas(collapseSrc, "COLLAPSE_THRESHOLD_PX = 300"));
  ck("★ 折叠高度上限与阈值同值", sourceHas(collapseSrc, "COLLAPSE_MAX_HEIGHT") ||
    sourceHas(collapseSrc, "300"));
  ck("★ 渐隐高度仍是 48px（= 上游的 3rem）", sourceHas(collapseSrc, "FADE_HEIGHT_PX = 48"));
}

console.log(`\nmessage-collapse-smoke: ${total - bad}/${total} 通过`);
if (bad > 0) process.exitCode = 1;
