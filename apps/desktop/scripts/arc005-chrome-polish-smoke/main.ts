/**
 * ARC-005 Titlebar + empty-workspace starter card regression.
 * Production source assertions (E2), followed by separate real Chromium and
 * real component smoke gates. No mocks write the real user data root.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let total = 0;
let failed = 0;
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const check = (label: string, ok: boolean): void => {
  total++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + " " + label);
};
const titlebar = read("src/renderer/components/layout/Titlebar.tsx");
const home = read("src/renderer/components/chat/EmptyThreadWelcome.tsx");
const css = read("src/renderer/styles.css");

console.log("ARC-005 / Titlebar narrow layout");
const titleStart = titlebar.indexOf("data-arc005-titlebar-context");
const actionStart = titlebar.indexOf("data-arc005-titlebar-actions");
const context = titleStart < 0 || actionStart < 0 ? "" : titlebar.slice(titleStart, actionStart);
check("★ 工作区信息有弹性、可剪裁的单个上下文条且主窗口不重建", titleStart > 0 &&
  /min-w-0/.test(context) && /flex-1/.test(context) && /overflow-hidden/.test(context) &&
  // Native titlebar height is platform-dependent: macOS traffic lights need 45px.
  titlebar.includes('className={cn("flex shrink-0 items-stretch", isMac ? "h-[45px]" : "h-10")}'));
check("★ 4 个共享上下文源都保留，未变为静态假标签",
  ["<ActiveThreadTitle />","<ActiveProjectChip />","<ToolbarBranchIndicator />","<ActiveWorktreeChip />"]
    .every((name) => context.includes(name)));
check("★ 编辑器/终端/右面板开关放在独立不压缩的动作区",
  actionStart > titleStart && /shrink-0/.test(titlebar.slice(actionStart,actionStart + 160)) &&
  titlebar.indexOf("<EditorColumnToggle />",actionStart) > actionStart &&
  titlebar.indexOf("<IconTerminal2 ",actionStart) > actionStart &&
  titlebar.indexOf("<IconLayoutSidebarRightExpand",actionStart) > actionStart);
check("★ 线程、项目与工作树标签都可收缩/省略，防止窄屏挤出动作区",
  titlebar.includes("max-w-[280px] flex-[2_1_60px]") &&
  titlebar.includes("max-w-[180px] flex-[1_1_45px]") &&
  titlebar.includes("max-w-[160px] flex-[1_1_50px]"));
check("★ 顶栏原生 drag 和交互 no-drag 未丢",
  titlebar.includes('WebkitAppRegion: "drag"') &&
  titlebar.includes('WebkitAppRegion: "no-drag"') &&
  titlebar.includes("findSession("));
check("★ 图标控制区的终端/侧栏按钮有可访问名称", 
  titlebar.includes("aria-label={bottomTerminalOpen") &&
  titlebar.includes("aria-label={rightOpen"));

console.log("ARC-005 / empty thread visual / original actions");
check("★ 空线程欢迎语与起点仍消费原 i18n / RPC / store，不换 Agent 流程",
  home.includes("chatStream.welcome.withProject") &&
  home.includes("api.workflow.list()") &&
  home.includes("api.library.list(") &&
  home.includes("api.automation.statusAll()") &&
  home.includes("selectSession(") &&
  home.includes("setWorkflowId("));
check("★ 启动卡有独立 CSS hook，仍保留每块 data-home-section",
  home.includes('data-home-section={id}') && home.includes('data-arc005-starter-card=""'));
check("★ 点击目标维持 button + 键盘/屏幕阅读器可访问",
  home.includes('data-home-row={id}') && home.includes('type="button"') &&
  home.includes("aria-pressed={pressed}") &&
  home.includes("onClick={onClick}") );
check("★ v2 悬停微光仅在 workspace 开启（不改变 classic / 设置 / Office）",
  css.includes('[data-ui-shell-variant="workspace"] [data-arc005-starter-card]::after') &&
  css.slice(css.indexOf('[data-arc005-starter-card]::after'), css.indexOf('[data-arc005-starter-card]::after') + 600).includes("pointer-events: none") &&
  css.slice(css.indexOf('[data-arc005-starter-card]::after'), css.indexOf('[data-arc005-starter-card]::after') + 600).includes("radial-gradient("));
const reducedMotionBlockStart = css.indexOf("/* ARC-005: Claude Desktop v2 starter-card motion reference.");
const reducedMotionBlockEnd = css.indexOf("/* 统一焦点可见态", reducedMotionBlockStart);
const starterCss = reducedMotionBlockStart < 0 ? "" : css.slice(reducedMotionBlockStart, reducedMotionBlockEnd);
check("★ Reduced motion 环境不执行 scale 动画",
  starterCss.includes("@media (prefers-reduced-motion: reduce)") &&
  starterCss.includes("transition: none;") && starterCss.includes("transform: none;"));
check("★ 键盘聚焦与鼠标 hover 都能感知卡片，微光不拦截按钮",
  css.includes('[data-arc005-starter-card]:focus-within') &&
  css.includes('[data-arc005-starter-card]:hover') &&
  css.includes("pointer-events: none"));

console.log("arc005-chrome-polish-smoke: " + (total-failed) + "/" + total + " PASS");
if (failed) process.exitCode = 1;
