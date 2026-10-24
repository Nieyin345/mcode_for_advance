/**
 * W28 —— U1 宿主窗口的位置判据（纯函数，无头，不起 Electron）。
 *
 * ## 为什么要有这套
 *
 * `electron-u1/driver/runner.ts` 的 `pickHostWindowPlacement` 在**无副屏**时把窗口
 * 摆到主屏 `workArea` 的右下角之外（`wa.x + wa.width + 80, wa.y + wa.height + 80`）。
 * 那不是任何显示器的坐标空间 —— `WebContentsView.capturePage()` 拿不到 display
 * surface，**所有 U1 套件在单屏机器上永远红**（W24 的对照矩阵：屏外永不成功，
 * 屏内 + opacity 0 → +122ms 成功，屏内 + opacity 1 → +93ms 成功）。
 *
 * 本套断言的对象是**真身**：直接 import `runner.ts` 导出的
 * `chooseHostWindowPlacement`（`pickHostWindowPlacement` 的纯算术内核，不读
 * `screen`）。不在这里抄一份逻辑 —— 抄一份验的是副本，全绿也证明不了源码。
 *
 * ## 判据与变异
 *
 * - 无副屏：坐标原点落在主屏 `workArea` 内；`note` 不再说 "offscreen"；
 *   `opacity` 为 0（「用户看不见」由它保证，不靠位置）。
 * - 有副屏：坐标在副屏 `workArea` 内；`opacity` 为 1（「副屏 + opacity 0」
 *   **没有测过**，不写进代码）。
 * - **变异**：把坐标改回 `wa.x + wa.width + 80` → 「落在 workArea 内」两条必须红。
 * - **判据自检（正控）**：`inside()` 必须同时认得屏内点和屏外点 —— 否则
 *   `return true` 的实现会让「落在 workArea 内」恒绿。
 */
import {
  chooseHostWindowPlacement,
  type PlacementDisplay,
} from "../electron-u1/driver/runner.js";

let total = 0;
let failures = 0;
function check(label: string, good: boolean, details?: unknown): void {
  total++;
  if (good) console.log("  ok   " + label);
  else {
    failures++;
    console.log("  FAIL " + label + " " + JSON.stringify(details ?? null));
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口左上角是否落在 workArea 内。`[x, x+width) × [y, y+height)` 半开区间。 */
function inside(point: { x: number; y: number }, wa: Rect): boolean {
  return point.x >= wa.x && point.x < wa.x + wa.width && point.y >= wa.y && point.y < wa.y + wa.height;
}

function display(id: number, workArea: Rect): PlacementDisplay {
  return { id, bounds: { width: workArea.width, height: workArea.height }, workArea };
}

/* ── 0. 判据自检：inside() 两个方向都认得 ──────────────────────────────── */

const SELF_WA: Rect = { x: 0, y: 0, width: 1463, height: 823 };
check("★ 正控：inside() 认得出屏内的点（wa.x+20, wa.y+20）", inside({ x: 20, y: 20 }, SELF_WA), SELF_WA);
check(
  "★ 正控：inside() 把旧的无副屏坐标（wa 右下再 +80）判为屏外",
  !inside({ x: SELF_WA.x + SELF_WA.width + 80, y: SELF_WA.y + SELF_WA.height + 80 }, SELF_WA),
  { x: SELF_WA.x + SELF_WA.width + 80, y: SELF_WA.y + SELF_WA.height + 80 },
);

/* ── 1. 无副屏：主屏工作区内（本机能跑的那条分支）──────────────────────── */

const PRIMARY = display(1, { x: 0, y: 0, width: 1463, height: 823 });
const noSecondary = chooseHostWindowPlacement(PRIMARY, []);

check(
  "无副屏：窗口原点落在主屏 workArea 内",
  inside(noSecondary, PRIMARY.workArea),
  { placement: { x: noSecondary.x, y: noSecondary.y }, workArea: PRIMARY.workArea },
);
check(
  "无副屏：note 不再说 offscreen，且说明没有副屏",
  !/offscreen/i.test(noSecondary.note) && noSecondary.note.includes("no secondary display"),
  { note: noSecondary.note },
);
check(
  "无副屏：opacity 为 0（隐身靠它，不靠屏外位置）",
  noSecondary.opacity === 0,
  { opacity: noSecondary.opacity },
);

/* ── 2. 无副屏 + workArea 原点非零（主屏不在 (0,0) 的布局）─────────────── */

// 主屏不在原点很常见：副屏摆在主屏左侧时，主屏 workArea 可能从 (1920,-200) 起。
// 这条防的是「把 20,20 当绝对坐标写死」的实现 —— 它在原点非零时又跑到屏外。
const OFFSET_PRIMARY = display(2, { x: 1920, y: -200, width: 1463, height: 823 });
const offsetPlacement = chooseHostWindowPlacement(OFFSET_PRIMARY, []);
check(
  "无副屏（workArea 原点非零 1920,-200）：坐标仍落在该 workArea 内",
  inside(offsetPlacement, OFFSET_PRIMARY.workArea),
  { placement: { x: offsetPlacement.x, y: offsetPlacement.y }, workArea: OFFSET_PRIMARY.workArea },
);

/* ── 3. 有副屏：副屏工作区内（本机没有这条分支，只有纯函数能验）─────────── */

const SECONDARY = display(7, { x: 1463, y: 0, width: 1920, height: 1040 });
const withSecondary = chooseHostWindowPlacement(PRIMARY, [SECONDARY]);
check(
  "有副屏：坐标落在副屏 workArea 内（原点内缩 60）",
  inside(withSecondary, SECONDARY.workArea) &&
    withSecondary.x === SECONDARY.workArea.x + 60 &&
    withSecondary.y === SECONDARY.workArea.y + 60,
  { placement: { x: withSecondary.x, y: withSecondary.y }, secondaryWorkArea: SECONDARY.workArea },
);
check(
  "有副屏：note 说明是 secondary display 且带 id",
  withSecondary.note.startsWith(`secondary display (id=${SECONDARY.id}`),
  { note: withSecondary.note },
);
check(
  "有副屏：opacity 为 1（「副屏 + opacity 0」没测过，不进代码）",
  withSecondary.opacity === 1,
  { opacity: withSecondary.opacity },
);

console.log(`u1-placement-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
