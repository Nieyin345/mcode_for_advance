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

/* 【UI 重建 2026-10-28】**图标必须唯一。**
 *
 * 切换器改成「图标常驻、只给选中项展开文字」之后，**图标就是这个按钮的
 * 全部视觉身份**。两个页签共用一个图标 = 用户看到两个一模一样的按钮，
 * 只能靠悬停 tooltip 分辨。
 *
 * 这是那句改动的**新引入约束**：改之前每个按钮都有文字，图标重复无所谓；
 * 改之后重复就变成了「两个一样的按钮」。实测有 3 组撞了
 *（overview/turns、canvas/flow、terminal/tasks）。
 *
 * ⚠️ 断言比的是**图标组件的引用**，不是名字 —— `IconListDetails` 与
 * `IconListTree` 名字不同但语义都可能撞，这里只守「引用不重复」这个
 * 机器能判的部分（语义是否贴切仍要人看）。 */
check("★ 每个页签的图标互不重复（icon-only 下图标就是按钮的脸）", () => {
  const seen = new Map<unknown, string[]>();
  for (const m of BUILTINS[SLOT]) {
    if (!m.icon) continue;
    const arr = seen.get(m.icon) ?? [];
    arr.push(m.id);
    seen.set(m.icon, arr);
  }
  const dupes = [...seen.values()].filter((ids) => ids.length > 1);
  assert.deepEqual(
    dupes,
    [],
    `这些页签共用同一个图标，icon-only 下会显示成两个一样的按钮：${dupes
      .map((g) => g.join(" / "))
      .join("；")}`,
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

// ── §E 宽度账：13 个页签必须在一屏里排得开 ──────────────────────────
check("★ 全部页签在同一行里排得开（不许靠横向滚动藏掉后面的）", () => {
  /* 这条来自一次真实误读：另一个会话截图里只看到 8 个页签
   * （概览/文件/Git/浏览器/终端/侧聊/扩展/画布），而 registry 有 13 个。
   * 后 5 个（turns/flow/tasks/taskcenter/preview）被横向滚动条推到了不可见区。
   *
   * 为什么这对「扩展找不到」是致命的：`extensions` 排第 7，恰好卡在边界上 ——
   * 用户装完扩展，大概率还是点不到。那条诉求等于没解决。
   *
   * 判据是**几何估算**（不跑浏览器，所以是近似的），但它能抓住「加回文字标签」
   * 这类回退：加回去之后 13 个约 866px，远超右栏的半宽 ≈700px，这条立刻红。
   *
   * 估算口径：图标 13 + gap 4 + padding（选中 12 / 未选中 8）+ 项间 gap 2；
   * 选中项另加文字宽度。中文按 13px/字，英文按 7px/字。 */
  const entries = entriesFor();
  const all = BUILTINS[SLOT].map((m) => ({ id: m.id, active: false }));
  assert.ok(entries.length >= 12, `页签只有 ${entries.length} 个，可能被配置隐藏了`);

  const textWidth = (label: string): number =>
    [...label].reduce((w, c) => w + (/[一-鿿]/.test(c) ? 13 : 7), 0);

  /* 最坏情况：选中的是**最长那个**（工作流运行 = 5 个汉字）。
   * 用最坏情况而不是平均值 —— 用户随时可能选中它。 */
  const worstLabel = "工作流运行";
  let px = 0;
  for (let i = 0; i < all.length; i++) {
    const isActive = i === 7; // 占一个位置，宽度按选中算
    px += isActive ? 13 + 4 + 12 + textWidth(worstLabel) : 13 + 8;
    px += 2; // 项间 gap-0.5
  }
  /* 右栏半宽的下限：1440px 窗口下 tile 各占一半 ≈ 700px，再减标题行右侧
   * 三个按钮（换边/放大/关闭）约 90px 与内边距 24px。 */
  const budget = 700 - 90 - 24;
  assert.ok(
    px <= budget,
    `页签行最坏情况约 ${px}px，超过右栏可用宽约 ${budget}px —— ` +
      `后面的页签会被横向滚动藏掉（这正是 extensions 点不到的原因）。` +
      `若要加回文字标签，请改为只在选中项显示。`,
  );
});


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
