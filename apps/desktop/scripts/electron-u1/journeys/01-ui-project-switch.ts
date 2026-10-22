/**
 * T16 示例旅程 1 —— 纯 UI：启动 → 主窗口出现 → 点左栏 → 断言中间面板切换。
 *
 * 真 App（App.tsx + 真 Zustand store）渲染，只有 `window.labApi` 的数据是虚构的
 * （api-stub.js）。所有点击都是 `webContents.sendInputEvent` 真鼠标事件，
 * 不是页内 `el.click()`。
 *
 * 按真实交互走（与 LeftBarParts.tsx 的接线一致）：
 *  - 点项目名 = 展开/折叠该项目（项目行没有"选中"语义）；
 *  - 点会话行 = `openTab` → activeProjectId 同步 → 中间面板换 ChatPane。
 *
 * 断言分档：dom 开、visual 开（截图记录 + 两帧不同），sideEffect 关（本旅程无磁盘）。
 */
import { defineU1Journey, step } from "../driver/index.js";

export const uiProjectSwitch = defineU1Journey({
  name: "ui-project-switch",
  launch: { page: "bundle", assertions: { dom: true, visual: true, sideEffect: false } },
  steps: [
    // 主窗口出现：真 App 挂载 + 工作区外壳渲染。
    step.waitFor("[data-testid=workspace-main]", "main-window-visible", { timeoutMs: 30_000 }),
    step.assertDom("[data-testid=workspace-sidebar]", { textContains: "U1 项目 A" }, "sidebar-shows-project-a"),
    step.assertDom("[data-testid=workspace-sidebar]", { textContains: "U1 项目 B" }, "sidebar-shows-project-b"),

    // 初始落点是项目 A 的会话；中央标签 + 消息余证明这一点。
    step.waitFor("[data-message-id=m-a]", "project-a-message-visible", { timeoutMs: 20_000 }),
    step.assertDom("[data-message-id=m-a]", { textContains: "这是项目 A 的消息正文" }, "center-shows-project-a"),
    step.assertDom("[role=tab][aria-selected=true][aria-keyshortcuts]", { textContains: "U1-A 会话" }, "active-tab-is-a"),
    step.screenshot("initial"),

    // 项目 B 初始是折叠的，其会话行不在可见 DOM 里。
    step.assertDom("[data-tree-session-row]", { count: 0, textContains: "U1-B 会话" }, "b-row-hidden-while-collapsed"),

    // 用户点左栏的**项目 B** 行 —— 真实鼠标事件，展开该项目。
    step.click("[data-testid=workspace-sidebar] button", "click-project-b", { text: "U1 项目 B" }),
    step.waitFor("[data-tree-session-row]", "b-session-row-appears", { text: "U1-B 会话", timeoutMs: 15_000 }),

    // 点项目 B 的会话行 → openTab → 中间面板切换。
    step.click("[data-tree-session-row]", "click-session-b", { text: "U1-B 会话" }),
    step.waitFor("[data-message-id=m-b]", "project-b-message-visible", { timeoutMs: 20_000 }),
    step.assertDom("[data-message-id=m-b]", { textContains: "这是项目 B 的消息正文" }, "center-switched-to-project-b"),
    step.assertDom("[data-message-id=m-a]", { count: 0 }, "project-a-message-gone"),
    step.assertDom("[role=tab][aria-selected=true][aria-keyshortcuts]", { textContains: "U1-B 会话" }, "active-tab-is-b"),
    step.screenshot("after-project-switch"),
    step.assertScreenshotChanged("after-project-switch", "initial"),
  ],
});
