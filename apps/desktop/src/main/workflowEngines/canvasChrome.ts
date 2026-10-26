/**
 * 【Q9b】**Mcode 外壳：让原厂画布长在 Mcode 的 Pane 里，而不是嵌一块异质面板。**
 *
 * ## 只做布局，不做交互
 *
 * 这一层只调整**几何与视觉密度**（header 高度、palette 宽度、圆角、阴影、间距），
 * 让原厂编辑器与 Mcode 的其余面板看起来是一套东西。**不移动 DOM、不监听事件、
 * 不替换任何控件** —— 那属于 fork 编辑器，与「不重写画布」的边界冲突。
 *
 * ## 为什么用 CSS 而不是改模板
 *
 * 上游 `@node-red/editor-client` 的模板与 `view.js` 拥有整套 SVG 与交互。改模板要
 * 跟着 5.0.8 → 5.1 → 6.0 一路维护；CSS 只依赖**稳定得多的东西**：色板变量
 * （`--red-ui-*`，上游公开的定制面）与几个长期存在的容器类名。
 *
 * ## ⚠️ 选择器依赖上游 DOM，且会在升级时失效
 *
 * `.red-ui-header` / `.red-ui-palette` / `.red-ui-tab` 这些类名在 5.0.8 上实测存在，
 * 但它们**不是上游承诺的稳定 API**（`--red-ui-*` 变量才是）。
 *
 * 所以每一条规则都写成**渐进增强**：选择器不命中时页面完全正常，只是少一点壳层
 * 观感。**任何一条都不允许是"没它就不能用"**（例如不给 header 设 `display:none`）。
 *
 * 升级 5.0.8 时的检查：打开编辑器确认 header / palette / 画布三处仍能正常操作。
 * 若某个类名变了，症状是"样式没生效"，不是"功能坏了"——这正是这么写的理由。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 生成注入到编辑器页面的额外样式。
 *
 * 与主题变量分开：主题是 `mcode-theme-*.css`（`build-theme.mjs` 编译出来的，
 * 覆盖明暗两套色板），这里是**与色板无关**的几何调整，可以独立演进。
 */
export function canvasChromeCss(): string {  return [
    /* ── 与 Mcode 面板对齐的密度 ── */
    // 原厂 header 是 40px（`--red-ui-header-height`），Mcode 顶栏更高一点；
    // 让它们齐平，切换面板时不会看到一条跳动的边界。
    ":root{--red-ui-header-height:44px;}",
    // 画布容器去圆角：它现在是一个 Pane 的内容区，圆角由宿主 Pane 提供。
    ".red-ui-workspace{border-radius:0;}",
    // palette 稍宽一点：Mcode 的节点名较长（「模块能力调用 / Module capability」），
    // 原厂宽度下会截断成两行。
    ".red-ui-palette{min-width:210px;}",
    // 侧栏（信息/调试/配置）与 Mcode 右栏同宽，收起时不留一条突兀的缝。
    ".red-ui-sidebar{min-width:300px;}",
    // 节点状态行（`node.status`）在两行字时不要被节点边框裁掉 ——
    // WF-05 的执行中/耗时就是走这一行。
    ".red-ui-flow-node-status{line-height:1.35;}",

    /* ── 弹层与画布同一套圆角（与 build-theme.mjs 的 chrome 段同值） ── */
    ".red-ui-editor-dialog,.red-ui-dialog{border-radius:10px;}",
  ].join("\n");
}

/** 外壳样式在引擎数据目录里的文件名。 */
const CHROME_CSS_FILE = "mcode-canvas-chrome.css";

/**
 * 把外壳样式写到**引擎数据目录**，返回文件路径供 `editorTheme.page.css` 使用。
 *
 * 为什么写盘而不是随包分发：这层样式的内容由 `canvasChromeCss()` 决定，是**代码**
 * 的一部分；写进数据目录让"改了代码就生效"不需要重新打包 resources，也避免
 * resources 里出现一个必须手工同步的第二份真相。
 *
 * 每次启动重写（文件很小，内容确定）。写失败**不阻断启动** —— 外壳样式是观感增强，
 * 没有它画布照样能用；返回 `null` 让调用方不设这个变量。
 */
export function writeCanvasChromeCss(dataDir: string): string | null {
  try {
    const path = join(dataDir, CHROME_CSS_FILE);
    writeFileSync(path, canvasChromeCss(), "utf8");
    return path;
  } catch {
    return null;
  }
}
