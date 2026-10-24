/**
 * O0 旅程 4 —— XLSX 保真：在表格下方空白格写一句话，公式（含跨 sheet 引用）/
 * 条件格式 / 合并单元格 / 图表必须逐项保留。
 *
 * ## 编辑入口：名称框 + 真键入（与 t7 sheets 旅程同一条）
 *
 * 名称框（Univer 的 defined-name 控件）把选区放到 `A6`（数据区下方空白格），
 * 再向画布派真键盘字符 —— Univer 自己的「选中即开始编辑」路径，与用户键入
 * 同一条命令栈。保存点 Quick Access 的保存按钮（页面 `onSave`），走
 * `window.desktopApi.saveWorkbookEdits` → 真 Rust sidecar 写盘。
 *
 * ## 判据
 *
 * 基线指纹只含**公式视图**（`sheet read --where formula`）、条件格式规则、
 * 合并单元格、图表部件与图表锚点 —— 被编辑的空白格不在其中任何一项。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, waitFor, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

const EDITED = "O0-XL-EDIT-MARK";

export const xlsxFidelityJourney = defineU1Journey({
  name: "xlsx-fidelity",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 40_000,
    setup: o0Setup("xlsx") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor("#univer-container", "xl-workbook-container", { timeoutMs: 40_000 }),
    step.assertDom('[data-u-comp="defined-name"] input', { exists: true }, "xl-name-box-present"),

    // ── 基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "xlsx", rt.fixtures.xlsx, repoRoot);
    }, "xlsx-baseline-fingerprint", { assert: true }),

    // ── 选空白格 A6（名称框 + Enter，真实控件）──
    step.type('[data-u-comp="defined-name"] input', "A6", "xl-select-a6", { clear: true }),
    step.press("Return", "xl-commit-range"),
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "sheets 视图没有 webContents" };
      const box = await waitFor(async () => await js<{ value: string } | null>(wc,
        `(() => { const el = document.querySelector('[data-u-comp="defined-name"] input'); return el ? { value: el.value } : null; })()`), 10_000, 150);
      return box && /^A6$/i.test(box.value)
        ? { ok: true, observed: box }
        : { ok: false, observed: box, detail: `名称框没有停在 A6（实际 ${JSON.stringify(box)}）` };
    }, "xl-range-selected", { assert: true }),

    // ── 真键入（与 t7 sheets 相同的「点画布 → 分段键入」）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "sheets 视图没有 webContents" };
      const box = await js<{ x: number; y: number }>(wc, `(() => {
        const el = document.getElementById('univer-container');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + 120), y: Math.round(r.top + 60) };
      })()`);
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
      // 点击落下的那一帧，Univer 可能把「下一个字符」当成进入编辑的首击（实测坑，
      // 见 t7 sheets 旅程同一段注释）。先等编辑会话稳定，再逐字符发。
      await new Promise((r) => setTimeout(r, 400));
      for (const ch of EDITED) {
        wc.sendInputEvent({ type: "char", keyCode: ch });
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, observed: { clicked: box, typed: EDITED } };
    }, "xl-type-into-cell", { assert: true }),
    step.press("Return", "xl-commit-cell-edit"),

    // ── 保存：Quick Access 保存按钮（页面 onSave → saveWorkbookEdits → sidecar）──
    step.click('.qa-btn[aria-label^="保存"], .qa-btn[aria-label^="Save"]', "click-save-button"),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "xlsx", rt.fixtures.xlsx, 60_000);
    }, "saved-to-disk", { assert: true }),

    // 独立读取：新格的值真的落盘（不经页面）
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const { spawnSync } = await import("node:child_process");
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      const cli = `${repoRoot}/genoffice/packages/cli/dist/genoffice.cjs`;
      // ELECTRON_RUN_AS_NODE=1：探针主进程的 process.execPath 是 Electron 二进制
      // （生产 genofficeCli.ts 的 invoke() 给同一组最小环境）。
      const r = spawnSync(process.execPath, [cli, "sheet", "read", rt.fixtures.xlsx, "--sheet", O0.xlsx.sheetData, "--range", "A6:A6", "--json"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
      });
      if (r.status !== 0) return { ok: false, observed: r.stdout, detail: "独立 CLI 读取失败" };
      const detail = (JSON.parse(r.stdout) as { detail?: { rows?: Array<Array<unknown>> } }).detail;
      const value = String(detail?.rows?.[0]?.[0] ?? "");
      return value === EDITED
        ? { ok: true, observed: { value } }
        : { ok: false, observed: { value }, detail: `A6 期望 ${EDITED}，独立读取得到 ${JSON.stringify(value)}` };
    }, "xl-disk-a6-edited-independent", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一工作簿，逐项比对复杂部件"),

    step.waitFor("#univer-container", "reopen-workbook-container", { timeoutMs: 40_000 }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "xlsx", rt.fixtures.xlsx, repoRoot);
    }, "xlsx-fidelity-compare", { assert: true }),
  ],
});
