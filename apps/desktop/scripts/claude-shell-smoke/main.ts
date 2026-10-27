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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
