/**
 * 【UI 重建】新外壳的纯逻辑回归网。
 *
 * 测 `chatColumn.ts` 与 `paneTiles.ts` 的纯函数 —— 它们是 Claude Code 页
 * 列覆盖与 pane tile 树的全部规则，也是新外壳里**唯一能脱离 DOM 验的部分**。
 *
 * 为什么先测这两个：
 *  - `chatColumnOf` / `isCovered` 决定「哪一列被盖住」，错了会让主区空白；
 *  - `openTile` / `closeTile` / `resizeStack` 决定 tile 树的结构，
 *    错了会让右栏消失或分栏比例错乱。
 *
 * **不测什么**（如实写）：不测渲染（那是真 Electron 截图的事）、
 * 不测样式（那是 CSS 的事）、不测 store 接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatColumnOf, isCovered, sidebarCollapsedIn } from "../../src/renderer/components/shell/chatColumn.js";
import {
  DEFAULT_TILE_LAYOUT, parseTileLayout, openTile, closeTile,
  hasTile, findParentStack, openNonChatTileCount, resizeStack, isNonChatTile,
} from "../../src/renderer/components/shell/paneTiles.js";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log("PASS", name);
    passed++;
  } catch (error) {
    console.error("FAIL", name, error);
    failed++;
  }
};

// ── chatColumn ────────────────────────────────────────────────────────
check("无会话 → project 列", () => {
  assert.equal(chatColumnOf({ hasActiveSession: false, isLoadingThread: false }), "project");
});

check("★ 有会话且加载中 → loading（加载态优先于 thread）", () => {
  assert.equal(chatColumnOf({ hasActiveSession: true, isLoadingThread: true }), "loading");
});

check("有会话且加载完 → thread", () => {
  assert.equal(chatColumnOf({ hasActiveSession: true, isLoadingThread: false }), "thread");
});

check("project 在 thread 之下（被盖住）", () => {
  assert.equal(isCovered("project", "thread"), true);
});

check("thread 不被 project 盖住", () => {
  assert.equal(isCovered("thread", "project"), false);
});

check("同列不算被盖住", () => {
  assert.equal(isCovered("thread", "thread"), false);
});

check("loading 盖住 project，但被 thread 盖住", () => {
  assert.equal(isCovered("project", "loading"), true);
  assert.equal(isCovered("loading", "thread"), true);
});

check("侧栏在任何列都不收起（Claude 的并行会话列表常驻）", () => {
  for (const c of ["project", "loading", "thread"] as const) {
    assert.equal(sidebarCollapsedIn(c), false, `${c} 不该收起侧栏`);
  }
});

// ── paneTiles：默认布局 ───────────────────────────────────────────────
check("默认布局只有 chat", () => {
  assert.equal(DEFAULT_TILE_LAYOUT.root.children.length, 1);
  assert.equal(hasTile(DEFAULT_TILE_LAYOUT.root, "chat"), true);
  assert.equal(openNonChatTileCount(DEFAULT_TILE_LAYOUT.root), 0);
});

check("chat 不算非 chat tile，其余都算", () => {
  assert.equal(isNonChatTile("chat"), false);
  const nonChat = ["diff", "preview", "artifact", "file", "pr", "cr", "terminal", "watercolor", "mcpapp", "turns"] as const;
  for (const k of nonChat) {
    assert.equal(isNonChatTile(k), true, `${k} 应算非 chat tile`);
  }
});

// ── paneTiles：开 / 关 ────────────────────────────────────────────────
check("★ 打开 diff → 与 chat 并排，各占一半", () => {
  const l = openTile(DEFAULT_TILE_LAYOUT, "diff");
  assert.equal(l.root.direction, "row");
  assert.equal(l.root.children.length, 2);
  const [a, b] = l.root.children;
  assert.equal(a.kind === "tile" && a.tileId, "chat");
  assert.equal(b.kind === "tile" && b.tileId, "diff");
  // flex 相等 = 各占一半
  assert.equal(a.kind === "tile" && a.flex, b.kind === "tile" && b.flex);
});

check("重复打开同一个 tile 幂等（不加第二个）", () => {
  const once = openTile(DEFAULT_TILE_LAYOUT, "diff");
  const twice = openTile(once, "diff");
  assert.equal(twice.root.children.length, 2);
});

check("关闭 diff → 回到只有 chat", () => {
  const l = closeTile(openTile(DEFAULT_TILE_LAYOUT, "diff"), "diff");
  assert.equal(hasTile(l.root, "diff"), false);
  assert.equal(hasTile(l.root, "chat"), true);
});

check("★ 关 chat 无效（它就是主区本身，布局原样返回）", () => {
  // ⚠️ 断言**必须比 `hasTile(chat)` 更严**：去掉 closeTile 的守卫后，
  // prune 会删掉 chat → root 变 null → 回落 DEFAULT_TILE_LAYOUT，
  // 而默认布局里也有 chat —— 只断言「chat 还在」的话，那条守卫删掉也是绿的。
  // 所以这里断言**整棵布局逐字段不变**（包括保留用户拖出来的 flex）。
  const customized: typeof DEFAULT_TILE_LAYOUT = {
    version: 2,
    root: {
      kind: "stack",
      direction: "row",
      children: [
        { kind: "tile", tileId: "chat", flex: 1.7 },
        { kind: "tile", tileId: "diff", flex: 0.3 },
      ],
    },
  };
  assert.deepEqual(closeTile(customized, "chat"), customized);
  // 默认布局同样不变。
  assert.deepEqual(closeTile(DEFAULT_TILE_LAYOUT, "chat"), DEFAULT_TILE_LAYOUT);
});

check("关闭不存在的 tile 幂等", () => {
  const l = closeTile(DEFAULT_TILE_LAYOUT, "terminal");
  assert.deepEqual(l, DEFAULT_TILE_LAYOUT);
});

check("关掉唯一一格后塌缩成单节点（不留空 stack）", () => {
  const l = closeTile(openTile(DEFAULT_TILE_LAYOUT, "file"), "file");
  assert.equal(l.root.kind, "stack");
  assert.equal(l.root.children.length, 1);
});

// ── paneTiles：查树 ───────────────────────────────────────────────────
check("findParentStack 找到 chat 的父 stack", () => {
  const l = openTile(DEFAULT_TILE_LAYOUT, "diff");
  const parent = findParentStack(l.root, "diff");
  assert.notEqual(parent, null);
  assert.equal(parent?.children.length, 2);
});

check("findParentStack 对不在树里的 tile 返回 null", () => {
  assert.equal(findParentStack(DEFAULT_TILE_LAYOUT.root, "diff"), null);
});

// ── paneTiles：解析（坏数据回默认）───────────────────────────────────
for (const [name, value] of [
  ["null", null],
  ["空对象", {}],
  ["版本不对", { version: 1, root: { kind: "stack", direction: "row", children: [] } }],
  ["root 不是 stack", { version: 2, root: { kind: "tile", tileId: "chat", flex: 1 } }],
  ["坏方向", { version: 2, root: { kind: "stack", direction: "diagonal", children: [] } }],
  ["坏子节点", { version: 2, root: { kind: "stack", direction: "row", children: [{ kind: "nope" }] } }],
  ["负 flex", { version: 2, root: { kind: "stack", direction: "row", children: [{ kind: "tile", tileId: "chat", flex: -1 }] } }],
] as const) {
  check(`解析坏数据回默认布局：${name}`, () => {
    assert.deepEqual(parseTileLayout(value), DEFAULT_TILE_LAYOUT);
  });
}

check("解析合法布局原样返回", () => {
  const ok = openTile(DEFAULT_TILE_LAYOUT, "diff");
  assert.deepEqual(parseTileLayout(ok), ok);
});

// ── resizeStack：拖拽分栏 ─────────────────────────────────────────────
check("★ 拖动分栏改变两侧 flex，总数守恒", () => {
  const l = openTile(DEFAULT_TILE_LAYOUT, "diff");
  const a = l.root.children[0];
  const b = l.root.children[1];
  const before = (a.kind === "tile" ? a.flex : 0) + (b.kind === "tile" ? b.flex : 0);
  const after = resizeStack(l, l.root, a, 1.6, b, 0.4);
  const [na, nb] = after.root.children;
  assert.equal(na.kind === "tile" && na.flex, 1.6);
  assert.equal(nb.kind === "tile" && nb.flex, 0.4);
  assert.ok(Math.abs((1.6 + 0.4) - before) < 1e-9, "两侧之和应守恒");
});

check("resizeStack 对不存在的 stack 不改布局", () => {
  const l = openTile(DEFAULT_TILE_LAYOUT, "diff");
  const bogus = { kind: "stack" as const, direction: "column" as const, children: [] };
  const a = { kind: "tile" as const, tileId: "chat" as const, flex: 1 };
  const b = { kind: "tile" as const, tileId: "file" as const, flex: 1 };
  assert.deepEqual(resizeStack(l, bogus, a, 2, b, 0), l);
});

// ── 源码一致性：确保新壳真的被 App 使用 ──────────────────────────────
check("★ App.tsx 渲染 ClaudeShellMount（新壳真的在用）", () => {
  // run.sh 把 cwd 设成 apps/desktop（其它套件同样约定），所以这里用相对路径。
  // **不能用 import.meta.dirname** —— esbuild 打包到临时目录后，它指向 /tmp。
  const app = readFileSync(resolve(process.cwd(), "src/renderer/App.tsx"), "utf8");
  assert.ok(app.includes("ClaudeShellMount"), "App 应引用 ClaudeShellMount");
  assert.ok(!/<ClassicShell\b/.test(app), "App 不应再渲染 ClassicShell");
});

/* ─────────── § 右栏页签的完整链路：能切到 → 切到后看得见 ───────────
 *
 * 【UI 重建 2026-10-27】加这一段的原因是一个**真实的缺陷**：
 * `browser` 页签经 `tileForTab` 映射到 `mcpapp`，而 `mcpapp` 分支
 * `return null` —— 用户点「浏览器」得到一个**空壳**。同时 `terminal` 与
 * `sidechat` 两个 tile 能渲染，却**没有任何页签指向它们**（终端只在底部
 * 横条，`SideChatPanel` 自称「right panel's quick ask tab」却没人挂）。
 *
 * 三处都没抛异常、没红、没日志 —— 「能切到」和「切到后看得见」是两件事，
 * 而此前**没有任何东西同时守这两件事**。
 *
 * 判据分三段，缺一不可：
 *   A. 契约枚举 ⊇ registry 里的每个页签 id（否则切换会被 schema 拒绝）；
 *   B. 每个页签经 `tileForTab` 得到的 tile **有对应的渲染物**，且不是 null；
 *   C. 每个渲染分支里的组件**真的被 import 了**（防「写了 return <X /> 但
 *      X 没导入」——那会 tsc 报错，但防的是有人把它改成字符串/null 绕过）。
 *
 * ⚠️ 这是**源码级**判据，不证明画面对；画面对由 `arc005-visual-baseline`
 * 的 overview-pane 等格负责。两道分开，各守一层。 */
check("★ 右栏每个页签都能切到、且切到后有东西渲染", () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const registry = read("src/renderer/components/customUi/registry.ts");
  const mount = read("src/renderer/components/shell/ClaudeShellMount.tsx");
  const pane = read("src/renderer/components/shell/paneContent.tsx");
  const contracts = read("../../packages/contracts/src/ipc/settings.ts");

  // ── A. 契约枚举覆盖 registry 的每个页签 ──
  const schema = /RightPanelTabSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(contracts)?.[1] ?? "";
  const declared = new Set([...schema.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(declared.size > 0, "抽不到 RightPanelTabSchema 的枚举值");

  const tabBlock = registry.slice(registry.indexOf('"rightPanel.tab": ['));
  const tabBlockEnd = tabBlock.indexOf("],");
  const tabIds = [...tabBlock.slice(0, tabBlockEnd).matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(tabIds.length >= 10, `registry 的右栏页签太少（${tabIds.length}）`);

  const notInSchema = tabIds.filter((t) => !declared.has(t));
  assert.deepEqual(
    notInSchema, [],
    `这些页签不在 RightPanelTabSchema 里，切换会被 zod 拒绝：${notInSchema.join(", ")}`,
  );

  // ── B. 每个页签映射到的 tile 都有非 null 的渲染分支 ──
  const mapSeg = mount.slice(mount.indexOf("const tileForTab"), mount.indexOf("};", mount.indexOf("const tileForTab")));
  const tabToTile: Record<string, string> = {};
  for (const m of mapSeg.matchAll(/case\s+"([^"]+)":\s*return\s+"([^"]+)"/g)) tabToTile[m[1]] = m[2];
  const fallback = /default:\s*return\s+"([^"]+)"/.exec(mapSeg)?.[1];
  assert.ok(fallback, "tileForTab 应有 default 兜底");

  const paneBody = pane.slice(pane.indexOf("export function renderPaneContent"));
  /** 取出某个 case 分支的源码（到下一个 case/default 为止）。
   *  ⚠️ 必须按 `case "x":` 精确切 —— 上一版探针用「找下一个 case」时，
   *  最后一个 case 会吞进后面的代码，把 sidechat 误判成 BrowserPane。 */
  const branchOf = (tile: string): string | null => {
    const key = `case "${tile}":`;
    const at = paneBody.indexOf(key);
    if (at < 0) return null;
    const rest = paneBody.slice(at + key.length);
    const next = rest.search(/\n\s*case\s+"|\n\s*default\s*:/);
    return next < 0 ? rest : rest.slice(0, next);
  };

  const emptyShells: string[] = [];
  const missingBranches: string[] = [];
  for (const tab of tabIds) {
    const tile = tabToTile[tab] ?? fallback;
    const branch = branchOf(tile);
    if (!branch) {
      missingBranches.push(`${tab} → ${tile}`);
      continue;
    }
    // 「看得见」= 分支里 return 了一个 JSX 元素（return null 是空壳）。
    if (!/return\s*<[A-Z]/.test(branch)) emptyShells.push(`${tab} → ${tile}`);
  }
  assert.deepEqual(missingBranches, [], `这些页签映射到的 tile 在 renderPaneContent 里没有分支：${missingBranches.join(", ")}`);
  assert.deepEqual(
    emptyShells, [],
    `这些页签切过去是空壳（分支 return null 或非 JSX）：${emptyShells.join(", ")}`,
  );

  // ── C. 每个 tab 都能真的落到一个 tile（不许静默落进 default）──
  /* 只查「有没有 case」不够 —— `default: return "file"` 会让任何漏写的页签
   * **静默变成文件树**，看起来完全正常。这正是 overview 当初踩过的形态
   *（改了 store 默认值却没生效）。所以对 Claude 那六项能力逐个要求
   * **显式** case。 */
  const claudeCapabilities = ["files", "git", "preview", "browser", "terminal", "sidechat"];
  const implicit = claudeCapabilities.filter((t) => !(t in tabToTile));
  assert.deepEqual(
    implicit, [],
    `这些 Claude 能力页签没有显式映射，会静默落进 default（文件树）：${implicit.join(", ")}`,
  );
});

/* ─────────── 侧栏 `⑂`：按钮必须真的传 worktree 意图 ───────────
 *
 * 【UI 重建 2026-10-28】分组标题的 `⑂` 是「在此项目下开分支工作树」。
 * 最容易的失效形态不是崩溃，而是**按钮画了但不生效**：
 *   - 忘了把 `envMode` / `wtStyle` 传给 `startSession` → 建出来的是本地会话；
 *   - 传了但没传 `projectId` → 建在**当前激活**的项目下，而不是用户点的那个；
 *   - `wtStyle` 没透传 → 跟着 composer 的 envChoice 芯片走，可能是 local。
 *
 * 三种都不抛异常、不报错，用户只看到「点了一下，好像建了，但不是我要的」。
 * 这条断言钉住三个参数都在。
 */
check("★ 侧栏 ⑂ 建会话时显式传了 worktree 意图与项目 id", () => {
  const mount = readFileSync(resolve(process.cwd(), "src/renderer/components/shell/ClaudeShellMount.tsx"), "utf8");
  const at = mount.indexOf("onNewSessionInWorktree=");
  assert.ok(at >= 0, "ClaudeShellMount 应把 onNewSessionInWorktree 接到侧栏");
  const seg = mount.slice(at, at + 400);
  assert.ok(
    /startSession\(\s*projectId/.test(seg),
    "必须把点中分组的 projectId 显式传给 startSession（否则会建在当前激活项目下）",
  );
  assert.ok(
    /envMode:\s*"worktree"/.test(seg),
    '必须显式传 envMode:"worktree"（否则建成本地会话）',
  );
  assert.ok(
    /wtStyle:\s*"branch"/.test(seg),
    '必须显式传 wtStyle:"branch"（否则跟随 envChoice 芯片，可能是 detached 或 local）',
  );
});

/* ─────────── § 三条线的「可达性」：加了映射 ≠ 点得到 ───────────
 *
 * 【UI 重建 2026-10-28】这一段的由来是一整类**同一个形状**的缺陷：
 *
 *   `paneContent` 里写好了分支 → `tileForTab` 映射到了 → **用户点不到**。
 *
 * 三条并行线各自撞了一次，症状不同，根是同一条：
 *   - **Office**：`artifact` 分支能渲染，没有任何页签映射过去；
 *   - **扩展**：`mcpapp` 被 `browser` 借走后，装了扩展在右栏找不到它；
 *   - **工作流**：WF-01 写明「画布右栏也可停靠」，停靠入口随旧右栏下线。
 *
 * 「映射存在」和「用户点得到」是两件事，而**只有前者会被源码正则看见**。
 * 所以下面这几条断言各自钉住链条上的不同一环，缺一环就有一条会红：
 *
 *   A. 页签在契约枚举里（zod 不会拒）
 *   B. 页签在 registry 里（设置页能编辑、切换器能列出）
 *   C. 页签经 `tileForTab` 落到一个**显式** case（不静默落进 default）
 *   D. 那个 tile 在 `renderPaneContent` 里有分支、且分支**返回 JSX**
 *   E. **有一个用户真能点的控件**把页签写进 store ← 这一环此前完全没有
 */
check("★ 三条线的 tile 都有页签能抵达（Office / 扩展 / 工作流画布）", () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const mount = read("src/renderer/components/shell/ClaudeShellMount.tsx");
  const pane = read("src/renderer/components/shell/paneContent.tsx");
  const registry = read("src/renderer/components/customUi/registry.ts");
  const contracts = read("../../packages/contracts/src/ipc/settings.ts");

  /* 三条线各自的「页签 → tile → 面板」应当是什么。
   * 这张表是**规格**（改动它等于改产品决定），不是从代码抄的现状。 */
  const expected: Record<string, { tile: string; component: string }> = {
    // Office：文档产物 → 原厂编辑器宿主
    files: { tile: "file", component: "FilesPanel" },
    // 扩展：`mcpapp` 归还扩展视图（此前被 browser 占用，导致扩展无入口）
    extensions: { tile: "mcpapp", component: "ExtensionViewsPane" },
    // 工作流：看板（跑到哪）与画布（怎么连）是两个面板，各有页签
    flow: { tile: "watercolor", component: "WorkflowBoardPanel" },
    canvas: { tile: "canvas", component: "EngineRuntimePanel" },
    // 浏览器：自己的 tile，不再借 mcpapp
    browser: { tile: "browser", component: "BrowserPane" },
  };

  const schema = /RightPanelTabSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(contracts)?.[1] ?? "";
  const declared = new Set([...schema.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const tabBlock = registry.slice(registry.indexOf('"rightPanel.tab": ['));
  const registered = new Set(
    [...tabBlock.slice(0, tabBlock.indexOf("],")).matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]),
  );

  const mapSeg = mount.slice(
    mount.indexOf("const tileForTab"),
    mount.indexOf("};", mount.indexOf("const tileForTab")),
  );
  const tabToTile: Record<string, string> = {};
  for (const m of mapSeg.matchAll(/case\s+"([^"]+)":\s*return\s+"([^"]+)"/g)) tabToTile[m[1]] = m[2];

  const missing: string[] = [];
  for (const [tab, want] of Object.entries(expected)) {
    // A. 契约枚举
    if (!declared.has(tab)) missing.push(`${tab}: 不在 RightPanelTabSchema（切换会被 zod 拒绝）`);
    // B. registry（设置页/切换器都读它）
    if (!registered.has(tab)) missing.push(`${tab}: 不在 registry 的 rightPanel.tab（切换器列不出）`);
    // C. 显式映射 —— 不能靠 default 兜底
    if (!(tab in tabToTile)) missing.push(`${tab}: tileForTab 没有显式 case（会静默落进 default）`);
    else if (tabToTile[tab] !== want.tile) {
      missing.push(`${tab}: 映射到 ${tabToTile[tab]}，应为 ${want.tile}`);
    }
  }
  assert.deepEqual(missing, [], `这些页签在链条上断了：\n  ${missing.join("\n  ")}`);

  // D. tile → 有一个返回 JSX 的分支，且**指向预期的那个面板**
  const paneBody = pane.slice(pane.indexOf("export function renderPaneContent"));
  const branchOf = (tile: string): string | null => {
    const key = `case "${tile}":`;
    const at = paneBody.indexOf(key);
    if (at < 0) return null;
    const rest = paneBody.slice(at + key.length);
    const next = rest.search(/\n\s*case\s+"|\n\s*default\s*:/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  /* 从分支里取它 return 的标签名，再顺着 `const XxxLazy = lazy(() => import(...))`
   * 找回真正被渲染的组件。
   *
   * ⚠️ **必须走这一步**：原生视图面板都是 lazy 包装（它们是渲染端最重的那批），
   * 分支里写的是 `<CanvasPaneLazy />`。只断言「分支提到 EngineRuntimePanel」
   * 会逼着人往分支里塞一句提到该名字的**注释**——那是拿注释骗断言，
   * 判据就不再指向被测对象了。 */
  const resolveLazyTarget = (body: string, tag: string): string => {
    // ① 分支直接用组件名（非 lazy，如 BrowserPane）
    const direct = new RegExp(`function\\s+${tag}\\b`).test(body) ? null : tag;
    // ② `const X = lazy(() => import(...).then((m) => ({ default: m.Y })))`
    const lazyDecl = new RegExp(
      `const\\s+${tag}\\s*=\\s*lazy\\([\\s\\S]{0,300}?default:\\s*m\\.([A-Za-z0-9_]+)`,
    ).exec(body);
    if (lazyDecl) return lazyDecl[1]!;
    /* ③ `function XxxPaneLazy() { return <Suspense><YYY …/></Suspense> }`
     *    —— 常见写法：包装函数自己不是 lazy，里面套一个 lazy 组件。
     *    顺着它内部渲染的标签再解一层（只解一层，够用且不会无限递归）。 */
    const wrapper = new RegExp(`function\\s+${tag}\\s*\\([^)]*\\)?[\\s\\S]{0,400}?`).exec(body);
    if (wrapper) {
      /* 跳过 `<Suspense fallback=…>` 这类**纯包裹**标签 —— 它们不是面板，
       * 面板是它里面那个。逐个看包装函数体里的 JSX 标签，取第一个不是
       * 包裹层的（Suspense / Fragment / div 都不算）。 */
      const WRAPPERS = new Set(["Suspense", "Fragment", "div", "span", "section"]);
      const bodySeg = new RegExp(
        `function\\s+${tag}[\\s\\S]{0,600}?return\\s*\\(([\\s\\S]{0,400}?)\\);?\\s*\\}`,
      ).exec(body)?.[1] ?? "";
      const tags = [...bodySeg.matchAll(/<([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
      const inner = tags.find((t) => !WRAPPERS.has(t) && t !== tag);
      if (inner) {
        const innerLazy = new RegExp(
          `const\\s+${inner}\\s*=\\s*lazy\\([\\s\\S]{0,300}?default:\\s*m\\.([A-Za-z0-9_]+)`,
        ).exec(body);
        if (innerLazy) return innerLazy[1]!;
        return inner;
      }
    }
    return direct ?? tag;
  };

  for (const [tab, want] of Object.entries(expected)) {
    const tile = want.tile;
    const branch = branchOf(tile);
    assert.ok(branch, `${tab} → tile "${tile}" 在 renderPaneContent 里没有分支`);
    const returned = /return\s*<([A-Za-z0-9_]+)/.exec(branch!)?.[1];
    assert.ok(returned, `${tab} → tile "${tile}" 的分支是空壳（没有返回 JSX）`);
    const actual = resolveLazyTarget(paneBody, returned!);
    /* 这一条是「接了但接错东西」那一类：`mcpapp` 曾接成 `BrowserPane`，
     * 断言只看「有没有 JSX」是全绿的，而扩展视图已经没了。 */
    assert.equal(
      actual,
      want.component,
      `${tab} → tile "${tile}" 应渲染 ${want.component}，实际是 ${actual}（经 ${returned}）`,
    );
  }
});

check("★ 右栏页签有一个用户点得到的入口（切换器真的挂在壳上）", () => {
  /* 这一条守的是**链条的最后一环**，也是三条线共同断掉的那一环：
   * 页签能写进 store、tile 能渲染 —— 但界面上没有任何东西让用户去点。
   *
   * 判据不是「切换器文件存在」（那只能证明代码写了），而是
   * **壳把切换器传给了 tile 渲染器**。传错位（比如给了 `titlebar`）
   * 视觉上也不会报错，所以断言钉在 `<ClaudeShell` 的那一行上。 */
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const mount = read("src/renderer/components/shell/ClaudeShellMount.tsx");
  const shell = read("src/renderer/components/shell/ClaudeShell.tsx");
  const pane = read("src/renderer/components/shell/TilePane.tsx");

  assert.match(mount, /asideHeader=\{<PaneTabSwitcher\s*\/>\}/, "ClaudeShellMount 应把 PaneTabSwitcher 作为 asideHeader 传给 ClaudeShell");
  assert.match(shell, /asideHeader=\{asideHeader\}/, "ClaudeShell 应把 asideHeader 透传给 TilePane");
  assert.match(shell, /asideHeader/, "TilePane 的 asideHeader 必须来自 ClaudeShell 的 props");
  const switcher = read("src/renderer/components/shell/PaneTabSwitcher.tsx");
  assert.match(switcher, /data-pane-tab=/, "切换器的按钮应有 data-pane-tab 标记（探针按它定位）");
  /* 切换器的清单必须**派生自 registry**，不许在切换器里再抄一份 ——
   * 抄一份的后果是加页签时只改一处，另一处静默少一项。 */
  assert.match(switcher, /resolveSlotEntries\(SLOT,/, "切换器应经 resolveSlotEntries 取清单（派生自自定义 UI 配置）");
  assert.match(switcher, /BUILTINS\[SLOT\]/, "切换器应为每个内置页签提供 runtime（否则它们不显示）");
});

check("★ 停靠的文档/画布在新壳里可见（两条路都接住）", () => {
  /* 【Office 线 + 工作流线】旧壳里 `pinnedDoc` / `pinnedFlow` 非空时，
   * 内置页签整块被盖住。新壳换壳时只接了页签那一半，于是：
   *
   *   - 「交给 Mcode AI」→ 写 `paneLayout` 的 document → **文档从界面消失**；
   *   - 设置页「停靠到右侧」→ 写 flow → 同理。
   *
   * 两条都要能显示，且**用的是旧壳同一个纯函数**（`hostedPaneContent`），
   * 不在这里手写「找 id=right 的 placement」—— 面板停左侧时内容挂在
   * 另一条 placement 上，手写版会静默读空。 */
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const mount = read("src/renderer/components/shell/ClaudeShellMount.tsx");
  const pane = read("src/renderer/components/shell/paneContent.tsx");

  // 壳：停靠内容决定 aside 格显示哪个 tile
  assert.match(mount, /hostedPaneContent\(/, "ClaudeShellMount 应经 hostedPaneContent 读停靠内容");
  assert.match(mount, /content\?\.kind === "document"\)\s*return "artifact"/, "停靠的文档应落到 artifact tile");
  assert.match(mount, /content\?\.kind === "flow"\)\s*return "canvas"/, "停靠的画布应落到 canvas tile");
  assert.match(mount, /dockedTile \?\? tileForTab\(/, "停靠内容优先于页签");

  // 面板：artifact 读停靠文档，且停靠优先于「活动文件」
  assert.match(pane, /hostedPaneContent\(/, "paneContent 的 Office 分支应读停靠的文档（不只读活动文件）");
  assert.match(pane, /const filePath = dockedDoc \?\? activeFile/, "停靠的文档优先于活动文件");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

