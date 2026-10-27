/**
 * Headless smoke for `PaneTabSwitcher` —— the right-pane tab entry point.
 *
 * ## 它守的东西
 *
 * 2026-10-28 换壳之后，`rightPanelTab` 有 13 个值，而用户只能点到 5 个
 * （顶栏那排）。其余页签（`extensions` / `canvas` / `browser` / `tasks` …）
 * **能写进 store、能渲染，但界面上没有入口**。三条并行线的症状
 * （装完扩展找不到、画布没停靠位、artifact 无页签）根都在这一条。
 *
 * `claude-shell-smoke` 守**接线形状**（源码里那几行在不在）。本套件守
 * **清单从哪来**：切换器列出的页签必须与 `rightPanel.tab` 那份配置一致 ——
 * 漏一个的后果是那个页签**从切换器里消失，且不报错**。
 *
 * ## 为什么只验纯函数、不渲染组件
 *
 * 实测过一次：`useCustomUiStore` 是 zustand v5，hooks 走 `useSyncExternalStore`，
 * 在 `renderToStaticMarkup` 下 React 取的是 **server snapshot** —— 测试里
 * `setState` 之后渲染结果**不会变**。于是所有「先改 store 再看渲染」的断言
 * 都会红，而红的原因与产品无关；留着它，下一个人会以为切换器不读配置。
 *
 * 能验且值得验的是**清单本身**：`resolveSlotEntries` 是切换器取清单的唯一
 * 入口（`PaneTabSwitcher` 的 `useMemo`），它是纯的。下面断言的是它在这份
 * 真实配置下的输出 —— 也就是用户会看到的那一排。
 *
 * ## 不测什么（如实写，读日志的人需要知道）
 *
 * - 组件是否真的调了 `resolveSlotEntries` → `claude-shell-smoke` 的源码断言；
 * - 点击后的 store 变化 → 同上（那一条钉在 `PaneTabSwitcher` 的 run 上）；
 * - 像素布局 / 横向滚动条 → `arc005-visual-baseline`；
 * - 真实 Electron 里的鼠标点击 → `arc005-pane-electron-smoke`。
 */
import "./prelude.js";

import assert from "node:assert/strict";
import { resolveSlotEntries } from "@renderer/components/customUi/CustomUiMenuItems.js";
import { BUILTINS } from "@renderer/components/customUi/registry.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import type { CustomUiSlot } from "@contracts/customUi";

const SLOT: CustomUiSlot = "rightPanel.tab";
const TARGET = { kind: "workspace" as const, today: "2026-10-28" };

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

/** 按切换器的算法取清单（每个内置页签都给它一个 runtime —— 那是切换器做的）。 */
const entriesFor = (hidden: readonly string[] = [], extraItems: readonly unknown[] = []) => {
  const config = useCustomUiStore.getState().config;
  const builtins: Record<string, { run: () => void }> = {};
  for (const meta of BUILTINS[SLOT]) builtins[meta.id] = { run: () => {} };
  const slotLayout = config.layout[SLOT];
  const layout = {
    order: slotLayout?.order ?? [],
    hidden: [...(slotLayout?.hidden ?? []), ...hidden],
  };
  return resolveSlotEntries(
    SLOT,
    TARGET,
    [...config.items, ...(extraItems as typeof config.items)],
    layout,
    builtins,
    [],
  ).map((e) => e.key);
};

// ── §A 清单：每个内置页签都在清单里 ─────────────────────────────────
check("★ rightPanel.tab 的每个内置页签都进得了清单", () => {
  const shown = new Set(entriesFor());
  const missing = BUILTINS[SLOT].filter((m) => !shown.has(`builtin:${m.id}`)).map((m) => m.id);
  assert.deepEqual(
    missing,
    [],
    `这些内置页签不会出现在切换器里（用户点不到）：${missing.join(", ")}`,
  );
});

check("★ 三条线各自的页签都在清单里（扩展 / 画布 / 浏览器）", () => {
  const shown = new Set(entriesFor());
  for (const id of ["extensions", "canvas", "browser"]) {
    assert.ok(shown.has(`builtin:${id}`), `页签 ${id} 不在清单里 —— 那条线在新外壳里点不到`);
  }
});

// ── §B 配置真的被消费：隐藏一个，它就消失 ───────────────────────────
check("★ 隐藏的页签不会进入清单（配置不是摆设）", () => {
  const shown = new Set(entriesFor(["builtin:canvas"]));
  assert.ok(!shown.has("builtin:canvas"), "被隐藏的 canvas 仍进入了清单");
  /* 正控：隐藏一个不该影响别的 —— 否则「隐藏生效」可能是整排都没了。 */
  assert.ok(shown.has("builtin:extensions"), "隐藏 canvas 不该连带把 extensions 弄没了");
});

// ── §C 自定义页签进得去，且键的形状对 ───────────────────────────────
check("★ 自定义页签进入清单，键是 custom:<id>", () => {
  const item = {
    id: "smoke-custom",
    slot: SLOT,
    label: { zh: "冒烟页", en: "Smoke" },
    action: { type: "file" as const, path: "README.md" },
  };
  const shown = new Set(entriesFor([], [item]));
  assert.ok(shown.has("custom:smoke-custom"), `自定义页签没进清单，实际有：${[...shown].join(", ")}`);
});

// ── §D 清单里没有重复（重复 = 同一个页签画两次）──────────────────────
check("★ 清单里没有重复项", () => {
  const keys = entriesFor();
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `重复的页签：${[...new Set(dup)].join(", ")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
