/**
 * document-view-renderer-smoke —— 【ARC-007】**把 `documentView.*` IPC 接到
 * GenOffice 文档面板**的渲染端回归网。
 *
 * ## 被测对象
 *
 *  - `renderer/components/ide/GenofficeViewHostPane.tsx`（新面板，**真源码**）；
 *  - `renderer/components/ide/FileEditor.tsx` 的 `FileEditor` 路由与 `EditorToolbar`
 *    切换项（**真源码**，重子件换桩）；
 *  - `renderer/lib/webApi.ts` 的 `documentView` 显式 unsupported（**真源码**，
 *    运行时构造一次 `createWebApi` 探针）。
 *
 * ## 它钉什么（与任务书逐条对应）
 *
 *  1. **挂载 → open**：bounds 来自占位 div 的 `getBoundingClientRect()`（整数、
 *     非负、尺寸 ≥1），`docId` 稳定（同路径两次挂载同一个），`visible:true`；
 *  2. **bounds 走 ResizeObserver**：尺寸变化后把**新几何**发给 `documentView.bounds`；
 *     同样的几何不重复发（去重）；
 *  3. **卸载 → close**：原生 `WebContentsView` 不随 DOM 卸载，少这一句视图会
 *     漂浮在窗口最上层盖住别的面板。**这是本套最重要的一条**（变异验证对象）；
 *  4. **编辑器页未构建**：CLI 缺失时**不创建视图**（零 open 调用），且界面上是
 *     真词典里的「GenOffice 编辑器页未构建」+ 原因 + 重试；
 *  5. **open 失败**：显示宿主给的原因 + 重试；点重试真的再 open 一次；
 *  6. **FileEditor 默认档不变**：office 文件在没有任何偏好时仍是 OnlyOffice（wysiwyg），
 *     **不**默认落到任何 GenOffice 档；
 *  7. **切换项**：能力就绪时工具栏有「编辑视图」按钮；点击真的把偏好写成
 *     `"genoffice-view"`，再点一次回到 `"wysiwyg"`；偏好为 `genoffice-view` 时
 *     渲染的是新面板；
 *  8. **webApi**：七个 `documentView.*` 方法在 web 传输上全部抛
 *     `mcode.webUnsupported`（不是 `undefined is not a function`）。
 *
 * ## 已知边界（如实说明）
 *
 *  - 极小 React 运行时不跑子组件：`FileEditor` 渲染出的 pane 以 `{type, props}` 留在
 *    树里，pane **本体**是在第 1 段单独挂载组件函数测的（同一份源码）。
 *  - 编辑器页 URL 推导按 CLI 快照的固定位置（`<repo>/genoffice/packages/cli/…`）
 *    做纯函数断言；页面文件是否存在由主进程导航失败暴露（渲染端没有 stat IPC）。
 *
 * Run: bash scripts/document-view-renderer-smoke/run.sh
 */
import "./prelude.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __mount, __unmount, __nodes, __tree, __text, __flush, __setRefResolver } from "./fakeReact.js";
import { __triggerResize, __observedCount, __flushRaf } from "./prelude.js";
import {
  api,
  documentViewCalls,
  __plan,
  __resetCalls,
  __setCapabilities,
  capabilityCalls,
} from "./api-stub.js";
import { state as storeState } from "./sessionStore-stub.js";
import {
  GenofficeViewHostPane,
  editorHostForPath,
  editorPageUrl,
  stableDocId,
} from "@renderer/components/ide/GenofficeViewHostPane.js";
import { FileEditor } from "@renderer/components/ide/FileEditor.js";
import { createWebApi, WEB_UNSUPPORTED_MARKER } from "@renderer/lib/webApi.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function section(t: string): void {
  console.log("\n" + t);
}

/* ────────────────────── 假 DOM 占位 ────────────────────── */

/** `stageRect` 是下一次 `getBoundingClientRect()` 的返回值（测试可改）。 */
let stageRect = { left: 120.4, top: 80.6, width: 700.2, height: 500.8 };
/** 同一个 DOM 桩要在多次渲染之间保持**同一身份**：ResizeObserver 记录的是
 *  "effect 那次渲染里 ref.current 的那个对象"，换一个新对象观察就断了。
 *  本套同一时刻只挂一个面板，所以一个单例足够。 */
const stageEl: Record<string, unknown> = {
  getBoundingClientRect: () => ({ ...stageRect }),
};

/** fakeReact 的 `__mount` 不模拟 ref —— 真 React 会在 effect 之前把
 *  `ref.current` 填成 DOM。这里借助 `__setRefResolver` 在同样的时机把树里带
 *  `data-genoffice-view-stage` 的元素 props 的 `ref.current` 指到 DOM 桩上
 *  （组件 effect 里读 `stageRef.current`）。 */
const refResolver = (): void => {
  for (const node of __nodes()) {
    const props = node.props as Record<string, unknown> | undefined;
    if (props === undefined || !("data-genoffice-view-stage" in props)) continue;
    const ref = props.ref as { current: unknown } | undefined;
    if (ref !== undefined && typeof ref === "object") ref.current = stageEl;
  }
};
__setRefResolver(refResolver);

/** 兼容旧调用点（resize / mount 里显式再指一次也无害）。 */
function attachStageRef(): void {
  refResolver();
}

/** 挂载组件并在首轮渲染后补上 ref、跑到静止。rAF 队列按轮 flush（首轮测量最多
 *  要几帧才能看到非 0 尺寸的占位区）。 */
async function mountPane(filePath: string): Promise<void> {
  __mount(() => GenofficeViewHostPane({ filePath }));
  for (let i = 0; i < 8; i++) {
    attachStageRef();
    __flushRaf();
    await __flush();
    attachStageRef();
    __flushRaf();
    await __flush();
  }
}

/** 触发一次"尺寸变了"：ResizeObserver 回调 → 下一帧 rAF 里 sync 读新 rect。 */
async function resizeStage(next: typeof stageRect): Promise<void> {
  stageRect = next;
  for (const node of __nodes()) {
    const props = node.props as Record<string, unknown> | undefined;
    if (props !== undefined && "data-genoffice-view-stage" in props) {
      const ref = props.ref as { current: unknown } | undefined;
      if (ref?.current !== undefined) __triggerResize(ref.current);
    }
  }
  __flushRaf();
  await __flush();
  attachStageRef();
  __flushRaf();
  await __flush();
}

/** 卸载当前树（跑 effect cleanup —— 真 React 卸载时同样会做）。 */
async function unmountPane(): Promise<void> {
  __unmount();
  await __flush();
}

function ops(method: "open" | "bounds" | "show" | "hide" | "focus" | "close" | "list"): Array<{ input: unknown }> {
  return documentViewCalls.filter((c) => c.method === method);
}
/** 树里**用户看得见的文本**：`__text()` 走 children；`ErrorNote` 的标题与
 *  `Button` 的文案是 props（组件在本运行时里不被调用），一并收进来。 */
function uiText(): string {
  const parts: string[] = [__text()];
  for (const node of deepNodes()) {
    const props = node.props as Record<string, unknown>;
    for (const key of ["title", "children"] as const) {
      const v = props[key];
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === "string").join(" "));
    }
  }
  return parts.join(" ");
}

/** 深度收集树里所有元素节点 —— **包括非 children 的 props 值**（`ErrorNote` 的
 *  `action` 插槽里放的是重试按钮，`__nodes()` 只走 children 会漏掉它）。 */
function deepNodes(root?: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  const out: Array<{ type: unknown; props: Record<string, unknown> }> = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in el)) return;
    out.push({ type: el.type, props: el.props ?? {} });
    for (const v of Object.values(el.props ?? {})) walk(v);
  };
  walk(root ?? __tree());
  return out;
}
/** 可点的按钮：本运行时里 Button 是函数组件、原样留在树里（带 onClick）。 */
function clickables() {
  return deepNodes().filter((n) => typeof n.props.onClick === "function");
}
function clickableByText(fragment: string) {
  return clickables().find((b) => String((b.props as { children?: unknown }).children ?? "").includes(fragment));
}

const CLI_PATH = "D:\\destop\\work_space\\work_for_reseach\\mcode\\genoffice\\packages\\cli\\dist\\genoffice.cjs";
const OFFICE_FILE = "/workspace/report.docx";

function resetWorld(cli: { available: boolean; path: string | null }): void {
  __resetCalls();
  __setCapabilities({ kind: "ok", cli });
  storeState.activeProjectId = "project-a";
  storeState.ideFileViewModeByProject = { "project-a": {}, "project-b": {} };
  stageRect = { left: 120.4, top: 80.6, width: 700.2, height: 500.8 };
}

/* ══════════════════ 1. URL 推导与 docId 纯函数 ══════════════════ */

section("1. 编辑器页 URL 与 docId（纯函数）");
{
  eq("docx 路由到 docs", editorHostForPath("/w/a.docx"), "docs");
  eq("xlsx 路由到 sheets", editorHostForPath("/w/a.xlsx"), "sheets");
  eq("pptx 路由到 slides", editorHostForPath("/w/a.pptx"), "slides");

  const url = editorPageUrl(CLI_PATH, "docs");
  eq(
    "★ Windows CLI 路径推出仓库根 + docs 编辑器页（file:// 三斜杠）",
    url,
    "file:///D:/destop/work_space/work_for_reseach/mcode/genoffice/apps/docs/out/renderer/index.html?mode=tab",
  );
  eq(
    "POSIX CLI 路径推出同样的形状",
    editorPageUrl("/home/u/mcode/genoffice/packages/cli/dist/genoffice.cjs", "sheets"),
    "file:///home/u/mcode/genoffice/apps/sheets/out/renderer/index.html?mode=tab",
  );
  eq("形状不认识的 CLI 路径 → null（不猜 URL）", editorPageUrl("/opt/elsewhere/cli.cjs", "docs"), null);

  const id1 = stableDocId("/workspace/report.docx");
  const id2 = stableDocId("/workspace/report.docx");
  check("★ 同路径两次得到同一个 docId（宿主复用语义）", id1 === id2, { id1, id2 });
  check("不同路径得到不同 docId", stableDocId("/workspace/other.docx") !== id1);
  check("docId 长度在契约上限内（≤200）", id1.length <= 200, id1.length);

  // 两个套件类型：契约把 docId 限在 200 字符内，深路径要靠散列压短。
  const deepPath = "/workspace/" + "a/".repeat(180) + "deep.docx";
  check("超长深路径的 docId 仍 ≤ 200", stableDocId(deepPath).length <= 200, stableDocId(deepPath).length);
}

/* ══════════════════ 2. 挂载 → open；ResizeObserver → bounds；卸载 → close ══════════════════ */

section("2. 组件生命周期：open / bounds / close");
{
  resetWorld({ available: true, path: CLI_PATH });
  await mountPane(OFFICE_FILE);

  const opens = ops("open");
  eq("★ 挂载后恰好 open 一次", opens.length, 1);
  const openInput = opens[0]?.input as {
    docId?: string;
    url?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    visible?: boolean;
  };
  eq("open 的 docId 是稳定散列", openInput.docId, stableDocId(OFFICE_FILE));
  eq(
    "★ open 的 URL 是仓库内 docs 编辑器页",
    openInput.url,
    "file:///D:/destop/work_space/work_for_reseach/mcode/genoffice/apps/docs/out/renderer/index.html?mode=tab",
  );
  eq("★ open 携带占位区的整数 bounds", openInput.bounds, { x: 120, y: 81, width: 700, height: 501 });
  eq("open 以可见态创建（visible:true）", openInput.visible, true);
  check(
    "bounds 各字段都是整数（契约要求 int）",
    [
      openInput.bounds?.x,
      openInput.bounds?.y,
      openInput.bounds?.width,
      openInput.bounds?.height,
    ].every((v) => typeof v === "number" && Number.isInteger(v)),
    openInput.bounds,
  );

  // —— ResizeObserver 驱动 bounds ——
  const beforeBounds = ops("bounds").length;
  await resizeStage({ left: 200, top: 90, width: 640, height: 480 });
  const boundsCalls = ops("bounds");
  check("★ 尺寸变化后发出新的 bounds", boundsCalls.length > beforeBounds, boundsCalls.length);
  eq(
    "★ 新 bounds 是测到的新几何",
    (boundsCalls.at(-1)?.input as { bounds?: unknown } | undefined)?.bounds,
    { x: 200, y: 90, width: 640, height: 480 },
  );
  const dedupeCount = boundsCalls.length;
  await resizeStage({ left: 200, top: 90, width: 640, height: 480 });
  eq("同一几何不重复发 bounds（去重）", ops("bounds").length, dedupeCount);

  // 负坐标要夹到 0（契约 x/y 下限），0 尺寸不能发。
  await resizeStage({ left: -40, top: -10, width: 300, height: 200 });
  eq(
    "越界负坐标夹到 0（契约下限）",
    (ops("bounds").at(-1)?.input as { bounds?: unknown } | undefined)?.bounds,
    { x: 0, y: 0, width: 300, height: 200 },
  );

  // —— 卸载 → close ——
  const closesBefore = ops("close").length;
  await unmountPane();
  const closes = ops("close");
  eq("★ 卸载时必须 close（原生视图不随 DOM 卸载）", closes.length, closesBefore + 1);
  eq("close 携带同一个 docId", (closes.at(-1)?.input as { docId?: string } | undefined)?.docId, stableDocId(OFFICE_FILE));
  eq("卸载后 ResizeObserver 已断开（无残留观察）", __observedCount(), 0);
}

/* ══════════════════ 3. 编辑器页未构建 / CLI 缺失 ══════════════════ */

section("3. 编辑器页未构建：显式说明，不装空白");
{
  resetWorld({ available: false, path: null });
  await mountPane(OFFICE_FILE);
  eq("★ CLI 缺失时一个视图都不创建（零 open）", ops("open").length, 0);
  const text = uiText();
  check("★ 界面出现「GenOffice 编辑器页未构建」", text.includes("GenOffice 编辑器页未构建"), text);
  check("给出构建指引（genoffice/packages/cli）", text.includes("genoffice/packages/cli"), text);
  check("不带「加载中」残留", !text.includes("加载中…"), text);
  check("提供重试按钮", clickableByText("重试") !== undefined, clickables().length);
  await unmountPane();

  // CLI 报告本身失败：仍不创建视图（url === null 的分支），且不炸整棵树。
  resetWorld({ available: false, path: null });
  __setCapabilities({ kind: "error", message: "capabilities IPC down" });
  await mountPane(OFFICE_FILE);
  eq("能力读取失败时不创建视图", ops("open").length, 0);
  check("能力读取失败时仍画「未构建」而不是空白", uiText().includes("GenOffice 编辑器页未构建"), uiText());
  await unmountPane();
}

/* ══════════════════ 4. open 失败：显式错误 + 重试 ══════════════════ */

section("4. open 失败：显示原因，重试真的再 open");
{
  resetWorld({ available: true, path: CLI_PATH });
  __plan("open", { ok: false, reason: "主窗口尚未就绪，无法创建文档视图" });
  await mountPane(OFFICE_FILE);
  const text = uiText();
  check("★ 失败时显示「GenOffice 编辑视图打开失败」", text.includes("GenOffice 编辑视图打开失败"), text);
  check("★ 显示宿主给的原因原文", text.includes("主窗口尚未就绪"), text);
  const retry = clickableByText("重试");
  check("失败态里有重试按钮", retry !== undefined, clickables().length);

  // 点重试：这次成功 → 再 open 一次，错误消失。
  __plan("open", { ok: true });
  const opensBefore = ops("open").length;
  if (retry !== undefined) {
    (retry.props as { onClick?: () => void }).onClick?.();
    for (let i = 0; i < 4; i++) {
      attachStageRef();
      __flushRaf();
      await __flush();
    }
  }
  eq("★ 重试真的重新 open 了一次", ops("open").length, opensBefore + 1);
  check("重试成功后错误条消失", !uiText().includes("GenOffice 编辑视图打开失败"), uiText());
  await unmountPane();
}

/* ══════════════════ 5. FileEditor 默认档不变 + 工具栏切换 ══════════════════ */

/** 真 `FileEditor` 调 hooks —— 必须经 fakeReact 挂载，不能直接函数调用。 */
async function renderEditor(filePath: string): Promise<{ pane: { type?: { name?: string }; props: Record<string, unknown> } | undefined; toolbar: Record<string, unknown> | undefined }> {
  __mount(() => FileEditor({ filePath, projectPath: "/workspace" }));
  for (let i = 0; i < 4; i++) {
    __flushRaf();
    await __flush();
  }
  const nodes = deepNodes();
  // 子 pane 在本运行时里以**函数组件**形式留在树里（构造时只看不调用），
  // 所以按函数名认 pane，而不是按字符串标签。
  const panes = nodes.filter((n) => {
    const fn = n.type as { name?: string } | null;
    return typeof n.type === "function" && typeof fn?.name === "string" && fn.name.endsWith("Pane");
  });
  const toolbar = nodes.find(
    (n) => typeof n.type === "function" && (n.type as { name?: string }).name === "EditorToolbar",
  );
  check(`前提：${filePath} 渲染出恰好一个 pane`, panes.length === 1, panes.map((p) => p.type));
  return {
    pane: panes[0] as { type?: { name?: string }; props: Record<string, unknown> } | undefined,
    toolbar: toolbar?.props,
  };
}

section("5. FileEditor：默认档不变、切换项可进入可视化视图");
{
  resetWorld({ available: true, path: CLI_PATH });
  __setCapabilities({ kind: "ok", cli: { available: true, path: CLI_PATH } });

  // 默认（无偏好）→ OnlyOffice，**不**进任何 GenOffice 档。
  const first = await renderEditor(OFFICE_FILE);
  eq("★ office 文件默认仍是 OnlyOffice（默认档不变）", first.pane?.type?.name, "OnlyOfficeEditorPane");
  eq(
    "★ 默认不下发任何 genoffice 偏好（store 未被写）",
    storeState.ideFileViewModeByProject["project-a"],
    {},
  );

  // 工具栏：能力就绪 → 有「编辑视图」按钮；点击 = 写偏好 "genoffice-view"。
  check("工具栏拿到 canUseGenofficeView", first.toolbar?.canUseGenofficeView === true, first.toolbar?.canUseGenofficeView);
  eq("工具栏初始 genofficeViewActive=false", first.toolbar?.genofficeViewActive, false);
  (first.toolbar?.onToggleGenofficeView as (() => void) | undefined)?.();
  eq(
    "★ 点「编辑视图」写入偏好 genoffice-view",
    storeState.ideFileViewModeByProject["project-a"]?.[OFFICE_FILE],
    "genoffice-view",
  );
  const second = await renderEditor(OFFICE_FILE);
  eq("★ 偏好 genoffice-view 时渲染 GenofficeViewHostPane", second.pane?.type?.name, "GenofficeViewHostPane");
  eq("该面板拿到 filePath prop", second.pane?.props.filePath, OFFICE_FILE);

  // 再点一次 → 回到 OnlyOffice 的 wysiwyg。
  eq("偏好生效后 genofficeViewActive=true", second.toolbar?.genofficeViewActive, true);
  (second.toolbar?.onToggleGenofficeView as (() => void) | undefined)?.();
  eq(
    "再点一次回到 wysiwyg",
    storeState.ideFileViewModeByProject["project-a"]?.[OFFICE_FILE],
    "wysiwyg",
  );

  // 结构化视图与可视化视图互斥：偏好为 genoffice 时仍是旧面板。
  storeState.ideFileViewModeByProject["project-a"] = { [OFFICE_FILE]: "genoffice" };
  const structured = await renderEditor(OFFICE_FILE);
  check(
    "偏好 genoffice 时仍渲染结构化面板",
    structured.pane?.type?.name === "GenofficeDocumentPane",
    { actual: structured.pane?.type?.name, expected: "GenofficeDocumentPane" },
  );

  // 能力不可用时按钮不出现（不画死按钮）。
  storeState.ideFileViewModeByProject["project-a"] = {};
  __setCapabilities({ kind: "ok", cli: { available: false, path: null } });
  eq("★ 能力不可用时 canUseGenofficeView=false", (await renderEditor(OFFICE_FILE)).toolbar?.canUseGenofficeView, false);

  // 非 office 文件（如 markdown）没有这个切换项的门。
  __setCapabilities({ kind: "ok", cli: { available: true, path: CLI_PATH } });
  eq("markdown 文件没有 GenOffice 视图门", (await renderEditor("/workspace/notes.md")).toolbar?.canUseGenofficeView, false);
  await unmountPane();
}

/* ══════════════════ 6. webApi：documentView 显式 unsupported ══════════════════ */

section("6. webApi：手机端 documentView 显式不可用（不是 undefined 调用）");
{
  const web = createWebApi();
  const names = ["open", "bounds", "show", "hide", "focus", "close", "list"] as const;
  for (const name of names) {
    let code: unknown = null;
    let message = "";
    try {
      await (web.documentView[name] as (input?: unknown) => Promise<unknown>)({});
    } catch (err) {
      code = (err as { code?: unknown }).code;
      message = err instanceof Error ? err.message : String(err);
    }
    check(
      `★ web 上 documentView.${name} 抛 webUnsupported（带标记）`,
      code === WEB_UNSUPPORTED_MARKER,
      { code },
    );
    check(
      `web 上 documentView.${name} 的错误点名方法`,
      message.includes(`documentView.${name}`),
      message,
    );
  }
}

/* ══════════════════ 7. 源码级：读走 useRpc、close 在 cleanup、FileEditor 接入 ══════════════════ */

section("7. 源码断言：接线与错误分支没有旁路");
{
  const appDir = process.cwd();
  if (!/apps[\\/]desktop$/.test(appDir)) {
    check(`基准目录是 apps/desktop（run.sh 应先 cd）`, false, appDir);
  } else {
    const paneSrc = readFileSync(join(appDir, "src/renderer/components/ide/GenofficeViewHostPane.tsx"), "utf8");
    const editorSrc = readFileSync(join(appDir, "src/renderer/components/ide/FileEditor.tsx"), "utf8");
    const webApiSrc = readFileSync(join(appDir, "src/renderer/lib/webApi.ts"), "utf8");

    check("面板的能力读取走 useRpc（硬规矩 7）", /useRpc\(\(\) => api\.document\.capabilities\(\)/.test(paneSrc));
    check("面板使用 ResizeObserver", paneSrc.includes("new ResizeObserver("));
    check("面板卸载 cleanup 里 close", /return \(\) => \{[\s\S]*?closeQuietly\(docId\)/.test(paneSrc));
    check(
      "closeQuietly 同时兜住异步拒绝与同步抛错（手机端 webUnsupported 是同步抛）",
      /try \{[\s\S]*?\.catch\(\(\) => \{\}\)[\s\S]*?\} catch \{/.test(paneSrc),
    );
    check("面板用 ErrorNote 画失败", paneSrc.includes("<ErrorNote"));
    check("面板用中文说明为什么卸载必须 close", paneSrc.includes("原生视图不随 DOM 卸载"));

    check("FileEditor import 了 GenofficeViewHostPane", editorSrc.includes('from "./GenofficeViewHostPane.js"'));
    check("FileEditor 有 genoffice-view 渲染分支", editorSrc.includes('effectiveMode === "genoffice-view"'));
    check(
      "FileEditor 默认档表达式逐字未变（wysiwyg / preview / edit）",
      /const defaultMode: FileViewMode = markdown \|\| office\s*\? "wysiwyg"\s*: isPdfFile\(filePath\)\s*\? "preview"\s*: "edit";/.test(editorSrc),
    );
    check("工具栏按钮接的是 onToggleGenofficeView", editorSrc.includes("onClick={onToggleGenofficeView}"));

    check("webApi 显式列出 documentView 命名空间", /const documentView: Api\["documentView"\] = \{/.test(webApiSrc));
    check("webApi 的 documentView 进了 base 装配", /^\s{4}documentView,$/m.test(webApiSrc));
  }
}

/* ────────────────────── 收尾 ────────────────────── */

console.log(`\ndocument-view-renderer-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
