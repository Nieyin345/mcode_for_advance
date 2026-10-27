/**
 * clickable-row-a11y-smoke — 【MC-049】可点击行/节点的键盘激活 + 静态规则。
 *
 * ## 盯的是什么
 *
 * 名单/历史/流程节点这类"整行可点"的地方从前用 `<div onClick={…}>`:鼠标能用、
 * 键盘不行(div 不可聚焦、没有 Enter/Space 语义、读屏不知道它是控件)。MC-049 把
 * 这些点收拢到共享组件 `ClickableRow`(role="button" + tabIndex + Enter/Space +
 * 嵌套子控件守卫),本套件把它钉住,分三层:
 *
 *   §1 组件行为 —— 真 `ClickableRow` 挂进极小 React 运行时,验角色/键位/禁用态/
 *      嵌套守卫。判据是"键真的触发/真的不触发",不是源码文本。
 *   §2 真调用点 —— 真 `BrowserToolbar`(真 i18n、真 store)挂进同一运行时:历史
 *      下拉行是 role=button、Enter 真的导航、行内删除按钮自己吞事件。这是
 *      "鼠标点的和键盘按的走同一条路"的端到端证据。
 *   §3 静态规则 —— 全渲染端 AST 扫描「div/span/label/li 带 onClick 但无
 *      role/tabIndex/onKeyDown」;豁免名单显式登记有意的 backdrop(含理由),
 *      新出现的裸可点击元素直接红。台账要求的"共享 UI 交互合同与静态规则治理"
 *      就是这一层:不是给 4 个组件手填三件套,而是**新代码再犯会红**。
 *
 * ## 变异证据(唯一被接受的证据)
 *
 * 把某个调用点从 ClickableRow 换回裸 div → §2 红(找不到 role=button 的历史行)
 * 且 §3 红(规则抓到新裸点)。撤掉组件里的 Enter 键处理 → §1/§2 红。
 * 详见各断言的 ★ 标记。
 *
 * Run: scripts/clickable-row-a11y-smoke/run.sh
 */
import "./prelude.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type * as TypeScript from "typescript";
import { __mount, __nodes, __render } from "./fakeReact.js";
import { ClickableRow } from "@renderer/components/ui/clickable-row.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { BrowserToolbar } from "@renderer/components/browser/BrowserToolbar.js";
import { ContextStatsPopover } from "@renderer/components/chat/ContextStatsPopover.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

type El = { type: unknown; props: Record<string, unknown> };

/** 从 fakeReact 的树里按组件函数名找一个节点。 */
function findByName(name: string): El[] {
  return (__nodes() as El[]).filter((n) => typeof n.type === "function" && (n.type as { name?: string }).name === name);
}

/** 对一个元素节点按 Enter(默认 target===currentTarget,即焦点在行本体上)。 */
function pressEnter(node: El): { prevented: boolean } {
  const e = {
    key: "Enter",
    target: node,
    currentTarget: node,
    preventDefault: () => {
      e.prevented = true;
    },
    prevented: false,
  };
  (node.props.onKeyDown as (ev: unknown) => void)(e);
  return { prevented: e.prevented };
}

/* ─────────────────────────── §1 组件行为 ─────────────────────────── */

console.log("\n【MC-049】ClickableRow:角色 / 键位 / 禁用态 / 嵌套守卫");
{
  // 挂一个"检验台":把 ClickableRow 的渲染结果原样摊到树上,拿它的真实元素节点
  // 做断言。ClickableRow 是纯函数(无 hooks),但仍在渲染上下文里调用以求一致。
  let clicks = 0;
  __mount(() => ClickableRow({ onClick: () => (clicks += 1), "aria-label": "打开条目", children: "行内容" }));
  const row = (__nodes() as El[]).find((n) => n.props.role === "button");
  check("★ 行是个 role=button 控件(detail 无)", !!row, __nodes().length);
  check("★ 行可聚焦(tabIndex=0)且带无障碍名", row?.props.tabIndex === 0 && row?.props["aria-label"] === "打开条目", row?.props.tabIndex);
  check("★ 行带 onKeyDown(键盘入口存在)", typeof row?.props.onKeyDown === "function", typeof row?.props.onKeyDown);

  // 鼠标路径仍然在:onClick 挂在节点上。
  (row!.props.onClick as () => void)();
  check("★ 鼠标点击(onClick)触发一次", clicks === 1, clicks);

  // 键盘路径:Enter 与 Space 都激活,且 Space 要吞默认滚动(preventDefault)。
  const enter = pressEnter(row!);
  check("★ Enter 触发激活(与鼠标同一条语义)", clicks === 2, clicks);
  check("★ Enter 的 preventDefault 被调用(不带出宿主默认行为)", enter.prevented, enter);
  const space = {
    key: " ",
    target: row,
    currentTarget: row,
    preventDefault: () => {},
  };
  (row!.props.onKeyDown as (ev: unknown) => void)(space);
  check("★ Space 也触发激活", clicks === 3, clicks);

  // 嵌套守卫:焦点在行内的子控件上时(事件 target ≠ currentTarget),外层不动 ——
  // 否则"Tab 到删除按钮按 Enter"会连带触发整行打开。
  const inner = { type: "button", props: {} } as El;
  let nested = 0;
  (row!.props.onKeyDown as (ev: unknown) => void)({
    key: "Enter",
    target: inner,
    currentTarget: row,
    preventDefault: () => (nested += 1),
  });
  check("★ 焦点在子控件上时外层行不激活(嵌套守卫)", clicks === 3, clicks);
  check("★ 子控件事件不被外层吞掉(preventDefault 未被调)", nested === 0, nested);
}

console.log("\n【MC-049】ClickableRow:disabled 不是控件、不进 Tab 序");
{
  let clicks = 0;
  __mount(() =>
    ClickableRow({ onClick: () => (clicks += 1), disabled: true, children: "禁用的行" }),
  );
  const row = (__nodes() as El[]).find((n) => n.props.role === "button");
  check("★ disabled 行 tabIndex=-1(不占 Tab 序)", row?.props.tabIndex === -1, row?.props.tabIndex);
  check("★ disabled 行 aria-disabled 暴露给辅助技术", row?.props["aria-disabled"] === true, row?.props["aria-disabled"]);
  check("★ disabled 行没有可调用的 onClick", row?.props.onClick === undefined, typeof row?.props.onClick);
  (row!.props.onKeyDown as (ev: unknown) => void)({ key: "Enter", target: row, currentTarget: row, preventDefault: () => {} });
  check("★ disabled 行按 Enter 不激活", clicks === 0, clicks);
}

console.log("\n【MC-049】ClickableRow:as='li' 保住列表结构");
{
  __mount(() => ClickableRow({ as: "li", onClick: () => {}, children: "列表行" }));
  const row = (__nodes() as El[]).find((n) => n.props.role === "button");
  check("★ as=li 渲染成 li(ul>li 结构不被 div 破坏)", row?.type === "li", row?.type);
}

/* ─────────────────────── §2 真调用点:浏览器历史行 ─────────────────────── */

console.log("\n【MC-049】真 BrowserToolbar:历史下拉行可键盘导航");
{
  useSessionStore.setState({ locale: "zh" });
  const navigated: string[] = [];
  const removed: string[] = [];
  const history = [
    { url: "https://a.test/one", title: "第一篇", at: 1 },
    { url: "https://b.test/two", title: "第二篇", at: 2 },
  ];
  __mount(() =>
    BrowserToolbar({
      mode: "overlay",
      url: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      deviceToolbarOpen: false,
      onUrlChange: () => {},
      onNavigate: (u: string) => navigated.push(u),
      onBack: () => {},
      onForward: () => {},
      onReload: () => {},
      onTogglePickMode: () => {},
      onToggleDeviceToolbar: () => {},
      onClose: () => {},
      onSwitchMode: () => {},
      history,
      onRemoveHistoryEntry: (u: string) => removed.push(u),
      onClearHistory: () => {},
      onHistoryMenuOpenChange: () => {},
      bookmarks: [],
      currentBookmarked: false,
      onToggleBookmark: () => {},
      onRemoveBookmark: () => {},
      onOpenUrl: () => {},
      onOpenUrlNewTab: () => {},
      downloads: [],
      onDownloadOpen: () => {},
      onDownloadReveal: () => {},
      onClearCache: () => {},
      onClearCookies: () => {},
      onMoreMenuOpenChange: () => {},
    } as never),
  );

  // 打开历史下拉:聚焦地址栏(真组件的真路径 —— onFocus 里 setDropdownOpen(true))。
  const input = (__nodes() as El[]).find((n) => n.type === "input");
  check("地址栏 input 在真组件里渲染出来了", !!input, __nodes().length);
  (input!.props.onFocus as () => void)();
  __render();

  // 历史行本体:ClickableRow 的渲染结果 —— role=button 且带无障碍名。
  const rows = findByName("ClickableRow");
  check("★ 历史条目走 ClickableRow(不用裸 div)", rows.length === 2, rows.length);
  const rendered = rows.map((r) => (r.type as (p: unknown) => El)(r.props));
  check(
    "★ 每个历史行是 role=button 且可聚焦",
    rendered.length === 2 && rendered.every((r) => r.props.role === "button" && r.props.tabIndex === 0),
    rendered.map((r) => r.props.tabIndex),
  );
  check(
    "★ 每个历史行带无障碍名(标题)",
    rendered.every((r) => typeof r.props["aria-label"] === "string" && String(r.props["aria-label"]).length > 0),
    rendered.map((r) => r.props["aria-label"]),
  );

  // 键盘 Enter 真的导航 —— 与鼠标点击同一条路。
  // 上面的注册型断言红了(如变异换回裸 div)时,这里不崩:拿不到第二行就跳过
  // 键位断言并如实标红,后面的静态层仍要跑到 —— 一次变异应看到"哪几层红",
  // 不该被中途抛错截断。
  if (rendered.length >= 2) {
    navigated.length = 0;
    pressEnter(rendered[1]!);
    check("★ 历史行按 Enter 真的导航到该条目", navigated.length === 1 && navigated[0] === "https://b.test/two", navigated);
  } else {
    check("★ 历史行按 Enter 真的导航到该条目", false, `历史行没渲染出来(${rendered.length} 行),键位无法验证`);
  }

  // 行内删除按钮:自己吞事件(stopPropagation),不会连带触发整行导航。
  const removeBtn = (__nodes() as El[]).find(
    (n) => n.type === "button" && n.props.onClick && String((n.type as { name?: string }).name ?? "") !== "ClickableRow",
  );
  // 历史上删除按钮在 ClickableRow 的子树里(fakeReact 惰性树会展开 ClickableRow 的渲染结果吗?
  // 不会 —— ClickableRow 节点是 {type, props},它的子树不在 __nodes() 的遍历里)。
  // 所以直接在渲染结果 rendered[i] 的 children 里找。
  const childNodes: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const e = n as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in e)) return;
    childNodes.push({ type: e.type, props: e.props ?? {} });
    walk(e.props?.children);
  };
  walk(rendered.map((r) => r.props.children));
  const removeInRow = childNodes.filter((n) => n.type === "button" && typeof n.props.onClick === "function");
  check("★ 历史行内有删除按钮(嵌套子操作)", removeInRow.length >= 1, removeInRow.length);
  if (removeInRow.length > 0) {
    let stopped = false;
    removed.length = 0;
    navigated.length = 0;
    (removeInRow[0]!.props.onClick as (e: unknown) => void)({ stopPropagation: () => (stopped = true) });
    check("★ 删除按钮自己吞事件(stopPropagation)", stopped, stopped);
    check("★ 删除按钮只删条目、不触发导航", removed.length === 1 && navigated.length === 0, { removed, navigated });
  } else {
    check("★ 删除按钮自己吞事件(stopPropagation)", false, "行内没找到删除按钮");
    check("★ 删除按钮只删条目、不触发导航", false, "行内没找到删除按钮");
  }
  void removeBtn;
}

/* ─────────────── §2b 同族:popover 的 Escape 出口(键盘可关闭) ─────────────── */

console.log("\n【MC-049】ContextStatsPopover:Escape 是键盘用户的关闭出口");
{
  // popover 是 portal 出来的浮层,鼠标出口是透明 backdrop(点外关闭)——
  // 键盘用户没有 backdrop 可点,必须有 Escape。WatchSegment 的同类 popover 早有
  // 这条;这里验 ContextStatsPopover 补齐后同样成立。
  const fire = (globalThis as unknown as { __fireWindowKey: (k: string) => void }).__fireWindowKey;
  const listenerCount = (globalThis as unknown as { __windowListenerCount: (t: string) => number }).__windowListenerCount;
  check("prelude 提供了 window keydown 触发路径(夹具没空过)", typeof fire === "function", typeof fire);

  let closed = 0;
  __mount(() =>
    ContextStatsPopover({
      snapshot: {
        usedTokens: 1000,
        totalProcessedTokens: 2000,
        maxTokens: 200000,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
      } as never,
      history: [],
      maxTokens: 200000,
      anchorRect: { top: 100, bottom: 120, left: 10, right: 40 } as DOMRect,
      onClose: () => (closed += 1),
    } as never),
  );
  check("popover 挂载时登记了 window keydown 监听", listenerCount("keydown") >= 1, listenerCount("keydown"));
  fire("Escape");
  check("★ Escape 触发 onClose(键盘能关掉浮层)", closed === 1, closed);
  fire("a");
  check("★ 其他键不误关(只有 Escape 是出口)", closed === 1, closed);
}

/* ─────────────────────── §3 静态规则:裸可点击元素 ─────────────────────── */

console.log("\n【MC-049】静态规则:渲染端不许出现裸可点击 div/span/label/li");
{
  // 有意豁免的 backdrop 类(台账原文:某些 backdrop/onClick 是有意的非交互背景)。
  // 匹配用「文件 + 归一化后的开标签源码前 60 字符」——行号会漂,源码形状不会。
  const ALLOWLIST: Array<{ file: string; snippet: string; why: string }> = [
    {
      file: "components/chat/ContextStatsPopover.tsx",
      snippet: '<div className="fixed inset-0 z-40" onClick={onClose} />',
      why: "全屏透明 backdrop:点外关闭,有意非交互背景(键盘出口是 Escape,已补)",
    },
    /* 【UI 重建 2026-10-27】删掉 `WatchSegment.tsx` 的两条 —— 那个文件
     * 已随「删除长任务守望」（`d3590637`）整体移除。留着它们会让
     * 「豁免名单没有过期项」这条恒红，而让人误以为组件坏了。
     *
     * 同时删掉 `ContextStatsPopover` 的**面板容器**那条：它现在有
     * `role="dialog"` + `aria-label`，本来就是合法的无障碍容器，不需要豁免了。
     * **豁免名单里的每一条都该是「确实无法按规则修」的，能修的就从名单里拿掉。** */
    {
      file: "components/shell/ClaudeTitlebar.tsx",
      snippet: '<div className="fixed inset-0 z-40" aria-hidden onClick={() => setMenuOpen(false)} />',
      why: "顶栏 ⋯ 菜单的透明 backdrop:点外关闭,有意非交互背景(键盘出口是 Escape,同 ContextStatsPopover)",
    },
  ];

  const DESKTOP = resolve(process.cwd());
  const RENDERER = join(DESKTOP, "src/renderer");
  check(
    "基准目录是 apps/desktop(扫错目录宁可红)",
    readdirSync(DESKTOP).includes("src") && readdirSync(RENDERER).includes("components"),
    DESKTOP,
  );
  const ts = createRequire(join(DESKTOP, "package.json"))("typescript") as typeof TypeScript;

  const files: string[] = [];
  const walkDir = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (p.endsWith(".tsx")) files.push(p);
    }
  };
  walkDir(RENDERER);

  const INTERACTIVE = new Set(["div", "span", "label", "li", "tr", "td", "section", "article"]);
  type Hit = { file: string; line: number; tag: string; snippet: string };
  const hits: Hit[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = f.slice(RENDERER.length + 1).replaceAll("\\", "/");
    const visit = (node: TypeScript.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (INTERACTIVE.has(tag)) {
          const attrs = new Map(
            node.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a]),
          );
          if (attrs.has("onClick") && !attrs.has("role") && !attrs.has("tabIndex") && !attrs.has("onKeyDown")) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const snippet = node.getText(sf).replace(/\s+/g, " ").slice(0, 60);
            hits.push({ file: rel, line, tag, snippet });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  check(
    `AST 扫描真的扫到了 tsx(${files.length} 个)`,
    files.length > 100,
    files.length,
  );

  const allowMatched = new Set<number>();
  const unmatched: Hit[] = [];
  for (const h of hits) {
    const idx = ALLOWLIST.findIndex(
      (a, i) => !allowMatched.has(i) && a.file === h.file && h.snippet.startsWith(a.snippet.slice(0, 50)),
    );
    if (idx >= 0) allowMatched.add(idx);
    else unmatched.push(h);
  }
  check(
    "★ 没有新的裸可点击元素(div/span/label/li 带 onClick 而无 role/tabIndex/onKeyDown)",
    unmatched.length === 0,
    unmatched.map((h) => `${h.file}:${h.line} <${h.tag}> ${h.snippet.slice(0, 40)}`),
  );
  check(
    "★ 豁免名单没有过期项(每条仍命中一个有意 backdrop)",
    allowMatched.size === ALLOWLIST.length,
    ALLOWLIST.filter((a, i) => !allowMatched.has(i)).map((a) => a.file),
  );
  check(
    "豁免名单每条都登记了理由(防随手加白)",
    ALLOWLIST.every((a) => a.why.length >= 10),
  );
}

console.log(`\nclickable-row-a11y-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
