/**
 * W26 —— **「用户在设置页看到 Node-RED 画布」的真 Electron 旅程**。
 *
 * 这条旅程回答的是用户 2026-10-25 的原话：「工作流都在验证什么呀，集成到设置页面了
 * 吗，现在的测试我看还是独立的页面」。已有的三套套件都答不了它：
 *
 * | 套件 | 它跑的是什么 | 缺的是什么 |
 * |---|---|---|
 * | `workflow-engine-view-owner-smoke` / `workflow-view-smoke` | SSR | effect 一行不跑 |
 * | `workflow-ui-smoke` | 真 Chromium + 假外壳（`render(<SettingsPage/>)`） | 没有真主进程 |
 * | `t8-node-red-u1` | 真 Electron，但走 `harness.openEngineEditor()` | **不走设置页** |
 *
 * 本旅程走的是**用户的那条路**：真 `App.tsx` → 点左栏「设置」→ 点「工作流」→
 * 默认页签 → 点「启动」→ `documentView` 里真的出现那块视图。
 *
 * ## 六步与判据（与卡面逐条对应）
 *
 *  1. `window.__mounted === true`（真 App 挂载）+ 工作区的左栏可见；
 *  2. **真鼠标点**设置按钮（`LeftBar.tsx` 的 `setSettingsOpen(true)`），覆盖层可见；
 *  3. **真鼠标点**「工作流」导航项（`SettingsPage` 的 `setActive("workflows")`）；
 *  4. 默认落在 engines 页签：`#workflows-tab-engines` 的 `aria-selected === "true"`
 *     且 `#workflows-panel-engines` 是 `flex`（不是 `hidden`）；
 *  5. **`documentView` 里存在 `workflow-engine-node-red` 且 `visible === true`**
 *     —— 这一条 SSR 做不到（`api` 不存在、effect 不跑），也是本卡核心；
 *  6. 编辑器 `webContents` 的 URL 端口 == 引擎 `status().port`（证明「是那个引擎的画布」）。
 *
 * ## 引擎怎么起：**点按钮**，不是 RPC
 *
 * 卡面要求走用户路径。`EngineRuntimePanel` 的启动按钮就是 `api.workflowEngine.start`
 * 的调用点，而本套件装配的是**生产** `registerWorkflowEngineHandlers` —— 点它 =
 * 走生产的整条起停链（含 `ensureEngineNodeReady` 闸门）。引擎起来要几秒：
 * 用轮询等 `data-engine-state="running"`，**不 sleep 固定时长**。
 *
 * ## 为什么所有断言都落在「宿主事实」而非「DOM 有块 div」
 *
 * `data-engine-view-stage` 那个 div 只是**占位**：原生 `WebContentsView` 不属于 DOM。
 * 「DOM 里有占位」在视图根本没开时同样成立（那正是 W15 之前的空白形态）。
 * 所以第 5 步读 `documentViewHost.list()` —— 生产宿主的诊断快照，含 `visible`。
 * 第 6 步读编辑器 `webContents` 的**真实 location**，与引擎 status 的端口比。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { assembleHarness, type W26Harness } from "../harness.js";

/** 编辑器视图的 docId —— 取自生产 `EngineRuntimePanel.engineDocId("node-red")`
 *  的同一形状（`workflow-engine-<id>`）。这里写死是因为旅程在**主进程**里读
 *  `documentViewHost`，那条链不跨渲染端边界；改产品命名时这里的断言会红，
 *  提醒同步（红的原因会写进 detail）。 */
const ENGINE_DOC_ID = "workflow-engine-node-red";

interface W26Runtime {
  harness: W26Harness;
  evidenceDir: string;
}

/** 页面里的 `window.api.documentView.list()` 结果形状（只读判据用）。 */
interface ViewListProbe {
  ok?: boolean;
  views?: Array<{ docId: string; url: string; visible: boolean }>;
  reason?: string;
}

export const settingsEntryJourney = defineU1Journey({
  name: "settings-workflow-canvas-visible",
  launch: {
    // **不用** `page: "bundle"`（`page.html` 会先加载 `api-stub.js`，把
    // `window.labApi` 变成内存桩 → `api` 永远打不到主进程）。`real-api-page.html`
    // 由 `prebuild.mjs` 生成：同一份 `bundle.js`（真 `App.tsx`），但先把
    // `window.labApi` 指到**产品真 preload** 的 `window.api`。
    page: { file: "real-api-page.html" },
    preload: "product",
    // 1920 宽：`EngineRuntimePanel` 的占位区太窄时 `measureBounds` 返回 null，
    // 视图永远不开（那不是本卡要验的东西）。生产用户窗口通常 ≥1280。
    size: { width: 1600, height: 1000 },
    defaultTimeoutMs: 30_000,
    assertions: { dom: true, visual: false, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("W26: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("W26: 探针窗口缺失（window 模式应建宿主窗口）");
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });
      const runtime: W26Runtime = { harness, evidenceDir: ctx.evidenceDir };
      return { runtime, dispose: () => harness.dispose() };
    },
  },
  steps: [
    /* ── 1. 真 Electron 起来，真 App 挂载 ── */
    step.waitFor("[data-testid=workspace-main]", "app-mounted", { timeoutMs: 60_000 }),
    step.assertEvaluated("window.__mounted === true", true, "window-mounted-flag"),
    // 左栏（设置入口所在的那一栏）真的渲染出来了。真 App 的 `init()` 是异步水合，
    // `workspace-main` 先出现、左栏随后；这一步等到的是「用户能看见左栏」那一刻。
    step.waitFor("[data-testid=workspace-sidebar]", "left-bar-visible", { timeoutMs: 30_000 }),

    /* ── 2. 真点击打开设置 ── */
    //
    // 入口在 `LeftBar.tsx:1019`：底部工具栏里文案为「设置」的那个 `<button>`。
    // 用 text 过滤（`layout.settings` = "设置"），因为它没有 data-testid；它所在的
    // 底部工具栏是**常驻**的（不依赖项目列表）。真鼠标事件由 runner 的
    // `sendInputEvent` 派发 —— 不是页内 `el.click()`。
    step.click("[data-testid=workspace-sidebar] button", "click-settings-entry", { text: "设置" }),
    // 设置覆盖层：`App.tsx` 的 `SettingsOverlay`（`settings-root`，`open` 为假时
    // 渲染 null）。它可见 = 用户点进去的那一屏真的在。
    step.waitFor(".settings-root", "settings-overlay-visible", { timeoutMs: 20_000 }),
    step.assertDom("[data-settings-nav]", { exists: true }, "settings-nav-rendered"),

    /* ── 3. 真点击「工作流」导航项 ── */
    //
    // ⚠️ **先滚进可视区再点**（实测踩过，W26 第一次跑）：设置导航是
    // `overflow-y-auto` 的可滚容器，「工作流」在第四组，1280 高以下的窗口里它在
    // 容器**可视区之外**。而 `probeElement` 判可见用的是 `getClientRects().length`
    // —— **滚出容器的元素照样有 client rects**，于是点击坐标落在窗口底部
    // （y=869）的另一个控件上：`aria-current` 仍停在「常规」，面板永远不换。
    // `scrollIntoView` 是用户会做的动作（滚轮），不是伪造点击。
    step.eval(
      `(() => {
        const nav = document.querySelector("[data-settings-nav]");
        if (!nav) return "no-nav";
        const btn = [...nav.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "工作流");
        if (!btn) return "no-button";
        btn.scrollIntoView({ block: "center" });
        return "scrolled";
      })()`,
      "scroll-workflows-nav-into-view",
    ),
    step.sleep(300, "let-scroll-settle"),
    step.click("[data-settings-nav] button", "click-workflows-nav", { text: "工作流" }),
    // 工作流面板的页签行（`role=tablist` 里的四个页签）。等到它出现说明
    // `WorkflowsPanel`（lazy chunk）已经挂载 —— 卡面关心的「lazy 面板真的挂载了」。
    step.waitFor("#workflows-tab-engines", "workflows-panel-mounted", { timeoutMs: 30_000 }),

    /* ── 4. 默认落在 engines 页签（W15 的行为） ── */
    step.assertDom("#workflows-tab-engines", {
      attribute: { name: "aria-selected", value: "true" },
    }, "default-tab-is-engines"),
    step.assertDom("#workflows-tab-library", {
      attribute: { name: "aria-selected", value: "false" },
    }, "library-tab-not-selected"),
    // 面板本身必须是 `flex`（可见），不是 `hidden`。`WorkflowsPanel` 用**类**切换
    // （见其注释：`hidden` 属性会输给 `.flex`）。
    step.assertEvaluated(
      `(() => {
        const el = document.getElementById("workflows-panel-engines");
        if (!el) return "missing";
        const cls = el.className;
        return cls.includes("flex") && !cls.includes("hidden") ? "flex" : cls;
      })()`,
      "flex",
      "engines-panel-flex",
    ),
    // engines 面板的容器确实在（`EngineRuntimePanel` 外层，按 engineId 标记）。
    step.assertDom("[data-engine-panel=node-red]", { exists: true }, "engine-panel-rendered"),

    /* ── 4.5 走用户路径起引擎：**真点「启动」按钮** ──
     *
     * `EngineRuntimePanel` 的引擎行在非 running 时渲染两个「启动」入口：
     * 顶部按钮行（`Button` + `IconPlayerPlay`，文案 `settings.workflows.engine.start`
     * = "启动"）与空态占位区里的按钮（同一文案）。两者都调 `run("start")` →
     * `api.workflowEngine.start({ engineId })` —— 点哪个都走生产链。用
     * `[data-engine-panel] button` + text 过滤定位第一个可见的「启动」。
     *
     * 起进程要几秒（vendor Node-RED 5.0.8 冷启动实测 ~1.8s，见 t8 证据），
     * 用轮询等状态徽标变 running，**不 sleep 固定时长**。
     */
    // 几何证据：容器链 + 每个候选按钮 + 覆盖元素的实际 rect。
    // 两个「启动」都被 `elementFromPoint` 判为被别的元素盖住（W26 第五次跑）——
    // 这条把「谁盖住了谁」量出来，交给回写判断是布局缺陷还是测量误差。
    step.eval(
      `(() => {
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
        const chain = [];
        let el = document.querySelector("[data-engine-panel]");
        const panel = el;
        while (el && chain.length < 8) {
          const cs = getComputedStyle(el);
          chain.push({ tag: el.tagName, id: el.id || null, cls: String(el.className || "").slice(0, 90), rect: rect(el), display: cs.display, position: cs.position, overflow: cs.overflow, flex: cs.flex, minH: cs.minHeight, height: cs.height });
          el = el.parentElement;
        }
        const zone = panel ? panel.querySelector("[data-engine-empty]") : null;
        const section = panel ? panel.querySelector("[data-engine-callback]") : null;
        const tops = panel ? [...panel.querySelectorAll("button")].map((b) => ({ text: (b.textContent || "").trim(), rect: rect(b) })) : [];
        return {
          panelRect: rect(panel),
          emptyZoneRect: rect(zone),
          callbackSectionRect: rect(section),
          callbackLabelRect: rect(panel ? panel.querySelector(".mt-2.text-content-subtle") : null),
          buttons: tops,
          chain,
          innerHeight: window.innerHeight,
        };
      })()`,
      "engine-panel-geometry",
    ),
    // ★ 命中测试（点击**之前**）：那个坐标上最顶层的元素是不是「启动」按钮本身。
    // W26 第三/四次跑实测：点击坐标正是顶部按钮中心、却没有触发 onClick ——
    // `elementFromPoint` 给出直接原因：命中了一个排版在它之上的 `section`
    // （「让引擎回调 Mcode」说明卡，`data-engine-callback`）。**这是产品的布局
    // 缺陷，不是本卡要修的东西**（本卡不改产品代码；它已记进回写）。
    //
    // 所以这里**换点那个没被盖住的「启动」**：空态占位区（`data-engine-empty`）
    // 里的按钮——同一个 `run("start")`、同一条 `api.workflowEngine.start` 链。
    // 它在下半屏，不被那张卡遮住（命中测试会证明：`hitInsideButton === true`）。
    step.eval(
      `(() => {
        const panel = document.querySelector("[data-engine-panel]");
        if (!panel) return { panel: false };
        const zone = panel.querySelector("[data-engine-empty]");
        if (!zone) return { panel: true, emptyZone: false };
        const btn = [...zone.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "启动");
        if (!btn) return { panel: true, emptyZone: true, button: false };
        const r = btn.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          panel: true, emptyZone: true, button: true, x, y,
          hitTag: hit ? hit.tagName : null,
          hitIsButton: hit === btn,
          hitInsideButton: !!(hit && btn.contains(hit)),
          hitClass: hit ? String(hit.className || "").slice(0, 160) : null,
          buttonDisabled: btn.disabled,
          buttonRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        };
      })()`,
      "hit-test-start-button",
    ),
    step.click("[data-engine-empty] button", "click-engine-start", { text: "启动" }),
    // ★ 对照诊断（不改判据）：点击是否落到「启动」上、点击后按钮是否进入 busy。
    // W26 第三次跑实测「点了但引擎没起、界面上也没有任何错误提示」—— 那有两种可能：
    // ① 点击没命中目标（坐标落在别处）；② 命中但 handler 抛了、状态回读把它抹平。
    // 这条 eval 把 ① 的证据（命中目标的标签/坐标 + 点击后 60ms 的 busy 态）落进
    // observed；② 由后面的 `engine-start-outcome` 证。
    step.eval(
      `(async () => {
        const panel = document.querySelector("[data-engine-panel]");
        if (!panel) return { panel: false };
        const buttons = [...panel.querySelectorAll("button")].map((b) => ({
          text: (b.textContent || "").trim(),
          disabled: b.disabled,
          rect: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
        }));
        await new Promise((r) => setTimeout(r, 60));
        const after = [...panel.querySelectorAll("button")].map((b) => ((b.textContent || "").trim()));
        return { panel: true, buttons, afterClick60ms: after };
      })()`,
      "engine-panel-buttons-after-click",
    ),
    step.sleep(400, "let-status-refetch-settle"),
    // ★ 起引擎的**结局**（判据本体）：等状态徽标变 running；超时则把主进程一侧
    // 的权威状态（`registry.statusOf`）与渲染端可见的错误文本一起落进 detail ——
    // 「点了但没起」必须说清卡在哪一步（启动参数 / 就绪探针 / 进程崩溃）。
    step.run(async ({ runtime }) => {
      const rt = runtime as W26Runtime;
      const deadline = Date.now() + 90_000;
      let state = rt.harness.engineState();
      let lastObserved: unknown = null;
      while (Date.now() < deadline) {
        state = rt.harness.engineState();
        if (state === "running") break;
        if (state === "failed") break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const status = rt.harness.registry.statusOf("node-red");
      // 渲染端当时看到的徽标状态（DOM 事实；用来区分「后端说 running、界面没刷新」）
      const badge = await (async () => {
        const wc = rt.harness.win?.webContents;
        if (!wc) return null;
        try {
          return await wc.executeJavaScript(
            `(() => {
              const el = document.querySelector("[data-engine-panel] [data-engine-state]");
              return el ? { state: el.getAttribute("data-engine-state"), text: (el.textContent || "").trim() } : null;
            })()`,
            true,
          );
        } catch { return null; }
      })();
      lastObserved = { state, status, badge };
      const ok = state === "running" && rt.harness.enginePort() !== null;
      return {
        ok,
        observed: lastObserved,
        ...(ok ? {} : {
          detail: `引擎没有起来：主进程状态=${state}${status?.reason ? `（reason=${status.reason}）` : ""}；界面徽标=${JSON.stringify(badge)}`,
        }),
      };
    }, "engine-running", { assert: true }),

    // 引擎起来之后 `EngineRuntimePanel` 的 effect 会调 `api.documentView.open`。
    // 给它一拍把原生视图挂上（视图创建是主进程同步动作，open 的 Promise 回来
    // 才开始渲染；给 5s 上限，超时由下一步的宿主事实断言如实红）。
    step.sleep(1_500, "let-document-view-open"),

    /* ── 5. 本卡核心：`documentView` 里那个视图真的存在且可见 ──
     *
     * 判据落在**主进程宿主**（`documentViewHost.list()`），不是 DOM：
     * `data-engine-view-stage` 只是占位 div，原生视图不在 DOM 里。这里顺便记录
     * 渲染端自己 `api.documentView.list()` 看到的东西 —— 两处如果对不上，说明
     * 有一个在说谎。
     */
    step.run(async ({ runtime }) => {
      const rt = runtime as W26Runtime;
      const snapshots = rt.harness.viewSnapshots();
      const engineId = "workflow-engine-node-red";
      const target = snapshots.find((s) => s.docId === ENGINE_DOC_ID) ?? null;
      const enginePort = rt.harness.enginePort();
      const engineState = rt.harness.engineState();
      writeFileSync(join(rt.evidenceDir, "document-views.json"), JSON.stringify({
        at: new Date().toISOString(),
        engineState,
        enginePort,
        snapshots,
      }, null, 2));
      const portOf = (url: string): number | null => {
        try { return Number(new URL(url).port) || null; } catch { return null; }
      };
      const urlPort = target === null ? null : portOf(target.url);
      const failures: string[] = [];
      if (target === null) failures.push(`documentView 里没有 ${ENGINE_DOC_ID}（现有：${snapshots.map((s) => s.docId).join(",") || "空"}）`);
      else {
        if (target.visible !== true) failures.push(`视图存在但 visible=false（bounds=${JSON.stringify(target.bounds)}）`);
        if (enginePort !== null && urlPort !== enginePort) failures.push(`视图 URL 端口 ${String(urlPort)} ≠ 引擎端口 ${enginePort}`);
      }
      return {
        ok: failures.length === 0,
        observed: {
          engineState,
          enginePort,
          docId: ENGINE_DOC_ID,
          snapshots,
          targetPresent: target !== null,
          targetVisible: target?.visible ?? null,
          targetUrl: target?.url ?? null,
          urlPort,
        },
        ...(failures.length === 0 ? {} : { detail: `画布没有真的显示：${failures.join("；")}` }),
      };
    }, "document-view-visible", { assert: true }),

    // 原生视图真的挂在宿主窗口上（`contentView` 的子视图）。宿主快照的
    // `visible` 是「逻辑上要求显示」，这一条补「物理上仍在窗口里」——
    // 宿主被窗口关闭清空时两者会分叉。
    step.run(async ({ runtime }) => {
      const rt = runtime as W26Runtime;
      const win = rt.harness.win;
      if (win === null || win.isDestroyed()) return { ok: false, detail: "宿主窗口不存在" };
      const children = win.contentView.children.length;
      return {
        ok: children >= 1,
        observed: { contentViewChildren: children, windowVisible: win.isVisible() },
        ...(children >= 1 ? {} : { detail: "宿主窗口的 contentView 里没有子视图 —— 原生画布没有挂上" }),
      };
    }, "native-view-attached-to-window", { assert: true }),

    /* ── 6. 这块画布是**那个引擎**的：URL 端口 == status().port ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W26Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图的 webContents 不存在" };
      // 页面可能还在导航中：轮询到 URL 带端口。
      const deadline = Date.now() + 30_000;
      let href = "";
      let port: number | null = null;
      for (;;) {
        try { href = wc.getURL(); } catch { href = ""; }
        try {
          const parsed = new URL(href);
          const n = Number(parsed.port);
          port = Number.isInteger(n) && n > 0 ? n : null;
        } catch { port = null; }
        if (port !== null) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const enginePort = rt.harness.enginePort();
      const status = rt.harness.registry.statusOf("node-red");
      const alive = wc.isDestroyed() ? "destroyed" : "alive";
      const ok = port !== null && enginePort !== null && port === enginePort && alive === "alive";
      return {
        ok,
        observed: {
          editorHref: href,
          editorPort: port,
          enginePort,
          engineState: status?.state ?? null,
          webContents: alive,
        },
        ...(ok ? {} : {
          detail: `画布不是那个引擎的：编辑器 URL 端口 ${String(port)} ≠ 引擎 status().port ${String(enginePort)}（href=${href || "(空)"}）`,
        }),
      };
    }, "editor-url-port-matches-engine", { assert: true }),

    // 页面里的 Node-RED 编辑器真的把画布渲染出来了（DOM 层的旁证：DOM 里有
    // `#red-ui-workspace-chart`）。**它不是第 5 步的判据** —— 它只说明「加载到
    // 编辑器的页面没有白屏」。用 `executeJavaScript` 在编辑器 webContents 里读。
    step.run(async ({ runtime }) => {
      const rt = runtime as W26Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图的 webContents 不存在" };
      const deadline = Date.now() + 45_000;
      let probe: { ready: boolean; chart: boolean; title: string } = { ready: false, chart: false, title: "" };
      for (;;) {
        try {
          probe = await wc.executeJavaScript(
            `(() => ({
              ready: !!document.getElementById('red-ui-editor'),
              chart: !!document.getElementById('red-ui-workspace-chart'),
              title: document.title,
            }))()`,
            true,
          ) as typeof probe;
        } catch { /* 导航中 executeJavaScript 可能抛 */ }
        if (probe.ready && probe.chart) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return {
        ok: probe.ready && probe.chart,
        observed: probe,
        ...(probe.ready && probe.chart ? {} : { detail: `编辑器页面没有渲染出画布（ready=${probe.ready}, chart=${probe.chart}, title=${probe.title}）` }),
      };
    }, "editor-page-rendered-canvas", { assert: true }),
  ],
});

export default settingsEntryJourney;
