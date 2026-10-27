/**
 * 【2026-10-28 退役】原 `ARC-007` 的 slides preload ABI 套件。
 *
 * ## 为什么它不再测原来那些东西
 *
 * 它原本测 `documentViewPreload.ts` 里一份**手写的 `window.slidesApi` 最小桥**
 * （约 220 行），断言失败信封必须映射成 vendor 认的 `null` / `.error` 形状
 * —— 否则 Slides 会把 `{ok:false}` 这个 **truthy** 当成功的渲染结果。
 *
 * 那份桥在 **2026-10-26 被删除了**，理由记在 `documentViewPreload.ts:389`：
 *
 * > 它已经删掉了，因为它从来没被用过：六种 GenOffice 编辑器走的是
 * > `kind !== null` 的 vendor 工厂，由 vendor 自己的 `out/preload/index.js`
 * > 建立 `window.slidesApi`。本文件只在 `kind === null`（非 GenOffice 的普通
 * > 文档视图）才被挂载。
 * >
 * > 那份桥里 `getTransition`/`getAnimations`/… 全部返回硬编码空值，
 * > 看起来像"功能缺失"，实际是**永远走不到的代码**。
 *
 * 于是这套件整套在测一段不存在的代码 —— 它红着（`not exposed: slidesApi`），
 * 而红因看起来像「preload 少暴露了一个全局」。
 *
 * ## 那它的保护去哪了
 *
 * 「失败不能被当成成功」这条语义**没有丢**，只是换了被测对象：
 * 现在由 `slides-bridge-result-contract-smoke`（21 条，测现役的
 * `slidesBridge.ts`）与 `slides-bridge-error-integrity-smoke` 守着，
 * 它们断言的是宿主侧真正的映射点，而不是一段死代码里的副本。
 *
 * ⚠️ **本仓 preload 已不再暴露 `slidesApi`，这是对的**：六种编辑器走 vendor
 * 工厂，vendor 自己的 preload 负责那半边。主进程侧的
 * `mcode:document-view:slides-*` 通道仍在（`ipc/documentView.ts` 注册），
 * 由 vendor preload 发起 —— 这条不变。
 *
 * ## 这个文件现在守什么
 *
 * 只守一件事：**退役本身是成立的**（那段桥确实不在本仓 preload 里了）。
 * 如果有人把它加回来，这条会红 —— 提醒他先想清楚「哪条路会走到它」，
 * 因为上一版加回来的结果是一份永远走不到的空实现。
 */
import { peekExposed } from "./stubs/electron.js";
import "../../src/main/document/documentViewPreload.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + label);
  else {
    failed++;
    console.error("  FAIL " + label + " " + JSON.stringify(detail));
  }
}

/* 本仓最小 preload **不该**再暴露 slidesApi（见文件头）。 */
const exposed = peekExposed("slidesApi");
check(
  "★ 本仓 documentViewPreload 不再暴露 window.slidesApi（那份手写桥已删）",
  exposed === undefined,
  { exposed },
);

/* 正控：这条 preload 确实装了东西 —— 否则上一条在「文件根本没跑」时也会绿。 */
const desktop = peekExposed("desktop");
check(
  "★ 正控：同一份 preload 仍然暴露 window.desktop（证明它真的执行了）",
  desktop !== undefined && typeof desktop === "object",
  { desktopType: typeof desktop },
);

console.log(`\nslides-preload-abi(retired): ${total - failed}/${total} 通过`);
if (failed > 0) process.exitCode = 1;
