/**
 * W15 无头套件：**工作流默认落在原厂画布；同一个 docId 的两个宿主不互相关视图。**
 *
 * ## 四组判据，分别对应卡的 A / B / C / D
 *
 * - **A 默认页签** —— 渲染 `WorkflowsPanel`（真组件、真 i18n、`react-dom/server`），
 *   断言 `purpose: "workflow"` 首帧 engines 面板是 `flex`、library 是 `hidden`；
 *   反向断言再钉一条**不同的**判据：初值来自导出的 `DEFAULT_WORKFLOWS_VIEW`，
 *   而不是组件里一个字符串字面量。`automation` 照卡上的判断保持 `library`。
 * - **B 共享 docId 的关闭纪律** —— 对导出的纯函数 `shouldCloseAfterRelease` +
 *   持有表入口（`acquireView` / `releaseView`）做三组断言（正控 + 负控），再对
 *   组件源码钉一条：两处关闭出口（卸载 / 离开 running）**只释放、不无条件 close**。
 * - **C 空白矩形** —— 在 `paneLayout.placements` 放一条 flow 内容，SSR 渲染
 *   `WorkflowsPanel` → engines 面板里必须出现解释文本 + 一个动作；没有停靠时
 *   那段解释**不许出现**（负控）。
 * - **D 源码结构** —— 在途 open 的落地处理不许无条件 `closeQuietly`；把
 *   「谁会关视图」这条纪律钉在它唯一的实现点上。
 *
 * ## 它不证明什么
 *
 * 真实 Electron 里「设置页关掉 → 右侧面板报『文档视图不存在或已关闭』」那条
 * 复现路径**不在这里**：它需要主进程 `documentViewHost` + 真的两个挂载点 +
 * 一次真实的卸载。这里证明的是**判据本身**（谁该关、谁不该关），不是那条链路。
 * 链路验证见卡的「结果回写」第 5 节。
 *
 * 运行：scripts/workflow-engine-view-owner-smoke/run.sh
 */
import "./prelude.js";

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  DEFAULT_PANE_LAYOUT,
  type PaneLayout,
} from "@renderer/components/layout/paneLayout.js";
import {
  DEFAULT_WORKFLOWS_VIEW,
  WorkflowsPanel,
  initialWorkflowsView,
} from "@renderer/components/settings/workflows/WorkflowsPanel.js";
import {
  __resetViewHolders,
  __viewHolderCount,
  acquireView,
  nextViewHolderId,
  releaseView,
  shouldCloseAfterRelease,
  shouldPollWorkflowEngineStatus,
} from "@renderer/components/settings/workflows/EngineRuntimePanel.js";

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 去掉行注释与块注释：源码级判据不许被注释里的旧写法骗成假绿。 */
function stripComments(src: string): string {
  let out = String();
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** `renderToStaticMarkup` reads zustand's **server snapshot**（store 创建时那份
 *  初始状态对象），`setState` 到不了它。所以直接写那个对象 —— 与
 *  `workflow-view-smoke/main.ts` 的 `withLocale` 同一手法。 */
function withLocale<T>(locale: "zh" | "en", render: () => T): T {
  (useSessionStore.getInitialState() as { locale: string }).locale = locale;
  return render();
}

/** 把初始状态的 `settingsFocusWorkflowId` / `paneLayout` 换掉再渲染，渲染完放回。
 *  两者都是 SSR 首次渲染会读的字段（`useSessionStore(...)` 在服务端读初始对象）。 */
function withStore<T>(
  patch: { settingsFocusWorkflowId?: string | null; paneLayout?: PaneLayout },
  render: () => T,
): T {
  const state = useSessionStore.getInitialState() as unknown as Record<string, unknown>;
  const prev: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) prev[key] = state[key];
  Object.assign(state, patch);
  try {
    return render();
  } finally {
    Object.assign(state, prev);
  }
}

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element);

/** 按 `id="..."` 取出那个元素的 class —— 页签面板可见性唯一可靠的判据。 */
function panelClass(markup: string, id: string): string {
  return new RegExp(`id="${id}"[^>]*class="([^"]*)"`).exec(markup)?.[1] ?? "";
}

/** 按文字找按钮（「文字紧挨着 `</button>`」—— 不会误命中正文里的同名字）。 */
function button(markup: string, label: string): { found: boolean; disabled: boolean } {
  const at = markup.indexOf(`>${label}</button>`);
  if (at < 0) return { found: false, disabled: false };
  const open = markup.lastIndexOf("<button", at);
  return { found: true, disabled: markup.slice(open, at).includes("disabled=") };
}

/** 一份「有流停靠在右侧」的 paneLayout（默认布局 + right 位挂 flow 内容）。 */
function dockedFlowLayout(flowId = "node-red"): PaneLayout {
  return {
    version: 1,
    placements: DEFAULT_PANE_LAYOUT.placements.map((p) =>
      p.id === "right" ? { ...p, content: { kind: "flow" as const, flowId } } : { ...p },
    ),
  };
}

const WORKFLOWS_PANEL_SRC = "src/renderer/components/settings/workflows/WorkflowsPanel.tsx";
const ENGINE_PANEL_SRC = "src/renderer/components/settings/workflows/EngineRuntimePanel.tsx";

console.log("\nA1. 默认页签：工作流 → 原厂画布（engines）");
{
  const markup = withLocale("zh", () =>
    html(createElement(WorkflowsPanel, { purpose: "workflow" })),
  );
  check(
    "★ 首帧：engines 面板是 flex",
    panelClass(markup, "workflows-panel-engines").split(" ").includes("flex"),
    panelClass(markup, "workflows-panel-engines"),
  );
  check(
    "★ 首帧：library 面板是 hidden",
    panelClass(markup, "workflows-panel-library").split(" ").includes("hidden"),
    panelClass(markup, "workflows-panel-library"),
  );
  check(
    "节点类型 / 代理档案也仍是 hidden（三个页签同时挂载）",
    panelClass(markup, "workflows-panel-nodeTypes").split(" ").includes("hidden") &&
      panelClass(markup, "workflows-panel-profiles").split(" ").includes("hidden"),
  );
  // 页签按钮的 aria-selected 跟着换（用户看得到"我在哪一页"）。
  const enginesTabSelected = new RegExp(
    `id="workflows-tab-engines"[^>]*aria-selected="true"`,
  ).test(markup);
  check("★ 引擎页签 aria-selected=true（视觉之外的判据）", enginesTabSelected);

  // ⚠️ 下面这条只守「同一时刻只有一个页签可见」这条**语义**（不守"哪一页"）。
  // `workflow-view-smoke/main.ts:2193` 用它守同一个形状，但那两条把"默认是库"写死
  // 了 —— 默认页签改成 engines 后它们红，而那是**假设过期**，不是回归。那份文件属于
  // W3 的独占写区，本卡不许改，所以等价判据放在这里。
  const visible = ["library", "nodeTypes", "profiles", "engines"].filter((id) =>
    panelClass(markup, `workflows-panel-${id}`).split(" ").includes("flex"),
  );
  eq("★ 同一时刻恰好一个页签面板可见", visible.join(","), "engines");
  check("没有用 hidden 属性（它压不过 .flex）", !markup.includes('hidden=""'));
}

console.log("\nA1b. Node-RED 后台运行不意味着隐藏页面继续轮询");
{
  eq("可见的运行中画布需要轮询", shouldPollWorkflowEngineStatus(true, true, true), true);
  eq("窗口最小化时停止状态轮询", shouldPollWorkflowEngineStatus(true, true, false), false);
  eq("页面切离工作流时停止状态轮询", shouldPollWorkflowEngineStatus(false, true, true), false);
  eq("引擎停止后不要轮询", shouldPollWorkflowEngineStatus(true, false, true), false);
  const code = stripComments(readFileSync(WORKFLOWS_PANEL_SRC.replace("WorkflowsPanel.tsx", "EngineRuntimePanel.tsx"), "utf8"));
  check("可见性改变时主动取消轮询 interval 并在恢复后同步状态",
    code.includes('document.addEventListener("visibilitychange", onVisibility)')
    && code.includes('document.removeEventListener("visibilitychange", onVisibility)')
    && code.includes("setPageVisible(visible)")
    && code.includes("if (visible && activeTab && running) void refreshDeployState()")
    && code.includes("window.clearInterval(timer)"));
}

console.log("\nA2. focusWorkflowId 的反查仍然优先（技能/插件页点「节点」进来）");
{
  eq(
    "initialWorkflowsView: 有 focus → library",
    initialWorkflowsView("workflow", "flow_abc"),
    "library",
  );
  eq(
    "initialWorkflowsView: automation + focus → library",
    initialWorkflowsView("automation", "flow_abc"),
    "library",
  );
  const markup = withStore({ settingsFocusWorkflowId: "flow_abc" }, () =>
    withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "workflow" }))),
  );
  check(
    "★ 传了 settingsFocusWorkflowId 时首帧落在 library",
    panelClass(markup, "workflows-panel-library").split(" ").includes("flex") &&
      panelClass(markup, "workflows-panel-engines").split(" ").includes("hidden"),
    {
      library: panelClass(markup, "workflows-panel-library"),
      engines: panelClass(markup, "workflows-panel-engines"),
    },
  );
}

console.log("\nA3. 反向断言：初值来自导出常量，不是组件里的字符串字面量");
{
  eq("★ DEFAULT_WORKFLOWS_VIEW 就是 engines", DEFAULT_WORKFLOWS_VIEW, "engines");
  check(
    "★ 组件用 initialWorkflowsView(...) 计算初值（不是 useState(\"library\")）",
    /useState<WorkflowsView>\(\(\)\s*=>\s*initialWorkflowsView\(purpose,\s*focusWorkflowId,\s*initialLibraryPurpose\)/.test(
      stripComments(readFileSync(WORKFLOWS_PANEL_SRC, "utf8")),
    ),
  );
  check(
    "★ 组件里不再有 useState<WorkflowsView>(\"library\") 这个字面量初值",
    !/useState<WorkflowsView>\(\s*"library"\s*\)/.test(
      stripComments(readFileSync(WORKFLOWS_PANEL_SRC, "utf8")),
    ),
  );
}

console.log("\nA4. automation 保持 library（卡上的判断：没有相反证据）");
{
  eq("initialWorkflowsView: automation → library", initialWorkflowsView("automation", null), "library");
  eq("initialWorkflowsView: automation + undefined → library", initialWorkflowsView("automation", undefined), "library");
  eq("initialWorkflowsView: workflow → engines", initialWorkflowsView("workflow", null), "engines");
  eq("旧自动化深链：首帧直接进入统一工作流库、不初始化画布",
    initialWorkflowsView("workflow", null, "automation"), "library");
  const auto = withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "automation" })));
  check(
    "★ 自动化面板首帧仍在 library",
    panelClass(auto, "automation-panel-library").split(" ").includes("flex") &&
      panelClass(auto, "automation-panel-engines").split(" ").includes("hidden"),
    {
      library: panelClass(auto, "automation-panel-library"),
      engines: panelClass(auto, "automation-panel-engines"),
    },
  );
}

/* ───────────────────────── B. 共享 docId 的关闭纪律 ───────────────────────── */

console.log("\nB. 同一个 docId 的持有者：谁该关、谁不该关（正控 + 负控）");
{
  const docId = "workflow-engine-node-red";

  // 组 1（正控）：只有一个持有者，它卸载 → **该关**。
  __resetViewHolders();
  const soloHolder = nextViewHolderId();
  acquireView(docId, soloHolder);
  eq("组1 正控：唯一持有者释放返回 true（该关）", releaseView(docId, soloHolder), true);
  eq("组1：释放后持有数为 0", __viewHolderCount(docId), 0);

  // 组 2（负控）：两个持有者，一个卸载 → **不该关**。
  __resetViewHolders();
  const settingsHolder = nextViewHolderId();
  const rightPanelHolder = nextViewHolderId();
  check("组2 前置：两个 id 不同（否则负控验的是同一份登记）", settingsHolder !== rightPanelHolder);
  acquireView(docId, settingsHolder);
  acquireView(docId, rightPanelHolder);
  eq("组2 负控：设置实例释放返回 false（不该关）", releaseView(docId, settingsHolder), false);
  eq("组2：另一个持有者仍在（1 个）", __viewHolderCount(docId), 1);
  eq(
    "组2：右侧面板实例此时释放才返回 true",
    releaseView(docId, rightPanelHolder),
    true,
  );
  eq("组2：都释放后为 0", __viewHolderCount(docId), 0);

  // 组 3（正控）：两个持有者，两个都卸载 → **该关**（第二个释放时）。
  __resetViewHolders();
  const a = nextViewHolderId();
  const b = nextViewHolderId();
  acquireView(docId, a);
  acquireView(docId, b);
  const first = releaseView(docId, a);
  const second = releaseView(docId, b);
  eq("组3 正控：第一个释放 false", first, false);
  eq("组3 正控：第二个释放 true（该关）", second, true);

  // 组 4（边界）：没登记过的调用方永远不该关别人的视图。
  __resetViewHolders();
  const owner = nextViewHolderId();
  acquireView(docId, owner);
  eq(
    "★ 组4 边界：未登记的调用方 release 返回 false（没资格关别人的视图）",
    releaseView(docId, nextViewHolderId()),
    false,
  );
  eq("组4：原持有者仍在", __viewHolderCount(docId), 1);

  // 组 5（纯函数直调）：判据本身与持有表入口是同一份。
  eq(
    "组5 纯判据：同 docId 两个持有者时不该关",
    shouldCloseAfterRelease(new Map([[docId, new Set(["x", "y"])]]), docId, "x"),
    false,
  );
  eq(
    "组5 纯判据：同 docId 唯一持有者时才关",
    shouldCloseAfterRelease(new Map([[docId, new Set(["x"])]]), docId, "x"),
    true,
  );
  eq(
    "组5 纯判据：docId 无关的登记不影响（另一个 docId 的持有者不算数）",
    shouldCloseAfterRelease(
      new Map([
        [docId, new Set(["x"])],
        ["genoffice-view-other", new Set(["y"])],
      ]),
      docId,
      "x",
    ),
    true,
  );

  // 组 6（正控）：不同 engineId 的 docId 互不影响 —— 这是"共享"的边界。
  __resetViewHolders();
  const h1 = nextViewHolderId();
  acquireView("workflow-engine-a", h1);
  acquireView("workflow-engine-b", h1);
  eq("组6：释放 a 不影响 b", releaseView("workflow-engine-a", h1), true);
  eq("组6：b 仍登记着", __viewHolderCount("workflow-engine-b"), 1);
  releaseView("workflow-engine-b", h1);
  __resetViewHolders();
}

console.log("\nB2. 组件的两处关闭出口：只释放，不无条件 close");
{
  const code = stripComments(readFileSync(ENGINE_PANEL_SRC, "utf8"));
  // ① 卸载清理里不许再出现裸 `closeQuietly(docIdAtMount)`。
  const unmount = /useEffect\(\(\)\s*=>\s*\{[\s\S]*?closeQuietly\(docIdAtMount\)[\s\S]*?\},\s*\[\]\);/.exec(code);
  check("★ 卸载清理不再无条件 close（改为 releaseView + 最后一个才关）", unmount === null, unmount?.[0]);
  check(
    "★ 卸载清理确实走 releaseView",
    /const last = releaseView\(docIdAtMount, holderId\);/.test(code),
  );
  // ② 在途 open 的 disposed 分支不许再出现 `closeQuietly(docId); return;`。
  check(
    "★ disposed 分支不再无条件 closeQuietly(docId)",
    !/if \(disposed\) \{\s*closeQuietly\(docId\);\s*return;\s*\}/.test(code),
  );
  // ③ 离开 running 的分支：释放持有，只有最后一个才关。
  check(
    "★ 离开 running 的分支走 releaseOwnership + 最后才关",
    /const last = releaseOwnership\(docId\);/.test(code) &&
      /if \(last\)/.test(code),
  );
  // ④ 在途 open 登记持有（另宿主不能替它关）。
  check(
    "★ sendOpen 在 open 之前登记持有",
    /acquireView\(docId, holderId\);[\s\S]{0,400}?api\.documentView\.open\(/.test(code),
  );
  // 防空过：上面任何一条正则因改名全部失配时，这两段结构必须仍在。
  check(
    "防空过：EngineRow 仍在、持有表入口仍导出",
    /export function EngineRow/.test(code) &&
      /export function acquireView/.test(code) &&
      /export function releaseView/.test(code) &&
      /export function shouldCloseAfterRelease/.test(code),
  );
}

/* ───────────────────────── C. 空白矩形 ───────────────────────── */

console.log("\nC. 有流停靠在右侧时，引擎页画出解释 + 动作（不是空白占位）");
{
  const docked = withStore({ paneLayout: dockedFlowLayout() }, () =>
    withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "workflow" }))),
  );
  check(
    "★ 停靠时 engines 面板里有解释文本",
    docked.includes("停靠在右侧面板"),
    docked.match(/data-engine-docked[\s\S]{0,600}/)?.[0],
  );
  check(
    "★ 停靠时有一个能把它调回来的按钮",
    button(docked, "收回到这里").found,
    button(docked, "收回到这里"),
  );
  check(
    "★ 停靠时内部引擎实例被隐藏（同一块画布不显示两处）",
    /data-engine-docked/.test(docked) &&
      new RegExp('class="min-h-0 flex-1 flex-col hidden"').test(docked),
    docked.match(/data-engine-docked[\s\S]{0,900}/)?.[0],
  );
  // 动作真的接在 store 上（清右栏停靠内容 = RightPanel 那个「×」同一 action）。
  const src = stripComments(readFileSync(WORKFLOWS_PANEL_SRC, "utf8"));
  check(
    "★ 「收回到这里」走 setLayoutPaneContent(\"right\", undefined)",
    /setLayoutPaneContent\("right", undefined\)/.test(src),
  );

  // 负控：没有停靠时，那段解释**不许出现**。
  const plain = withLocale("zh", () =>
    html(createElement(WorkflowsPanel, { purpose: "workflow" })),
  );
  check("★ 负控：没有停靠时没有解释块", !plain.includes("data-engine-docked"), plain.slice(0, 200));
  check("★ 负控：没有停靠时没有「收回到这里」按钮", !button(plain, "收回到这里").found);
  // 负控 2：停靠的是别的 flow（不是本引擎）时，仍然不画"停靠"解释 —— 那段解释
  // 只在 flowDocked 为真时出现，而 flowDocked 是"任意 flow 停靠"。这里如实钉住
  // 当前语义：任意 flow 都算（与 `active={view === "engines" && !flowDocked}` 一致）。
  const otherDock = withStore({ paneLayout: dockedFlowLayout("some-other-flow") }, () =>
    withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "workflow" }))),
  );
  check(
    "语义锚：任意 flow 停靠都让设置页实例让位（与 flowDocked 同判）",
    otherDock.includes("data-engine-docked"),
  );
}

console.log("\nC2. 没在跑时，空状态把「下一步」放在眼前");
{
  const panel = stripComments(readFileSync(ENGINE_PANEL_SRC, "utf8"));
  // 空态里有启动按钮（默认落到引擎页之后，这是用户看到的第一屏）。
  check(
    "★ 空态（非 starting）里直接有「启动」按钮",
    /data-engine-empty=""[\s\S]{0,900}?settings\.workflows\.engine\.start[\s\S]{0,300}?<\/Button>/.test(panel),
    panel.match(/data-engine-empty=""[\s\S]{0,900}/)?.[0],
  );
  check(
    "空态按钮走同一个 run(\"start\")（不是另起一条启动路径）",
    /status\.state !== "starting"[\s\S]{0,400}?onClick=\{\(\) => void run\("start"\)\}/.test(panel),
  );
}

console.log("\nD. 英文界面：新文案跟着换（i18n 两个词典都补齐）");
{
  const docked = withStore({ paneLayout: dockedFlowLayout() }, () =>
    withLocale("en", () => html(createElement(WorkflowsPanel, { purpose: "workflow" }))),
  );
  check("★ 英文停靠解释在", docked.includes("docked in the right panel"), docked.slice(0, 300));
  check("★ 英文动作按钮在", button(docked, "Bring it back here").found);
  check("★ 英文停靠块里没有中文残留", !/[一-鿿]/.test(docked.match(/data-engine-docked[\s\S]{0,900}/)?.[0] ?? ""));
}

console.log(`
${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
