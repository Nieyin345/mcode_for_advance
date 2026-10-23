/**
 * T7 旅程 3 —— Sheets（.xlsx）：打开 → 断言内容 → 编辑单元格 → 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 生产链
 *
 *  - 页面：vendor sheets 真构建产物（Univer 0.25.x）；
 *  - preload：vendor `apps/sheets/out/preload/index.js`（`window.desktopApi`）——
 *    生产 `createSheetsView` 挂的就是这一份；
 *  - 打开：`createSheetsView({openingWorkbook:true})` + `queueWorkbookForView`，
 *    页面首帧 `selectWorkbook()` → `sheets-main.ts` 的 `openSelectedWorkbook`
 *    → **真 Rust sidecar** 打开工作簿；
 *  - 编辑：Univer 的**真编辑 API**（`univerAPI.getActiveWorkbook().getActiveSheet().getRange('A1').setValue(...)`），
 *    与用户在单元格里键入走同一条命令栈；DOM 侧用名称框/公式栏的值做旁证。
 *  - 保存：页面的 `Ctrl+S`（`ExcelShell` 的 Quick Access Save → `handleSave`）
 *    → `window.desktopApi.saveWorkbookEdits` → vendor `workbook:save`
 *    → `writeWorkbookTo`（真 sidecar / JS 回退）；
 *  - 关闭：生产 `documentView:close`（原厂分支——见下「已知缺陷」）；
 *  - 重开：真 OS 重开 → 新视图重开工作簿 → 断言单元格与磁盘。
 *
 * ## 已知生产缺陷（本旅程同时取证）
 *
 * `DocumentViewHost.closeWithDirtyProtection` 只对 `editor === "slides"` 跳过
 * `close-check` 探针；sheets/pdf/markdown/html 的 vendor preload 没有
 * `mcode:document-view:close-check` 监听，生产面板关闭这四类视图会永远得到
 * 「编辑器未响应关闭检查」。与 markdown 旅程同一条：先断言缺陷表现，再用
 * `host.close` 完成关闭（文件已保存，没有未保存内容可丢）。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { join } from "node:path";
import { editorSetup, js, sha256Of, waitFor } from "../editor-flow.js";

const EDITED = `${UNIQUE.sheets}-EDITED`;
interface SheetsRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: import("../fixtures.js").FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
  sheetId: string;
  sessionId: string;
}

export const sheetsJourney = defineU1Journey({
  name: "sheets-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 40_000,
    setup: editorSetup("sheets") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      rt.openedSha = sha256Of(rt.fixtures.sheets);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-sheets.xlsx", "xl-open"),

    // ── 内容断言：Univer 真的打开工作簿（画布 + 名称框 + 状态栏）──
    step.waitFor("#univer-container", "xl-workbook-container", { timeoutMs: 40_000 }),
    step.assertDom('[data-u-comp="defined-name"] input', { exists: true }, "xl-name-box-present"),
    step.assertDom("#univer-container canvas", { exists: true }, "xl-grid-canvas-present"),
    step.screenshot("xl-opened"),

    // ── 编辑：**真 UI 输入** —— 名称框选 A1（Enter 提交，真聚焦），公式栏里键入，
    //    Enter 提交到单元格（Univer 自己的编辑会话，与用户键入同一条命令栈）。
    //    不是页内 `setValue` 假改：两处都是用户能点的真实控件。
    step.type('[data-u-comp="defined-name"] input', "A1", "xl-select-a1", { clear: true }),
    step.press("Return", "xl-commit-range"),
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "sheets 视图没有 webContents" };
      // 名称框提交后，Univer 把选择放到 A1；确认选择器真的在 A1（DOM 里的名称框值）。
      const box = await waitFor(async () => await js<{ value: string } | null>(wc,
        `(() => { const el = document.querySelector('[data-u-comp="defined-name"] input'); return el ? { value: el.value } : null; })()`), 10_000, 150);
      return box && /^A1$/i.test(box.value)
        ? { ok: true, observed: box }
        : { ok: false, observed: box, detail: `名称框没有停在 A1（实际 ${JSON.stringify(box)}）` };
    }, "xl-range-selected", { assert: true }),

    // ── 真键入：把焦点交给网格后，用 `sendInputEvent` 派**可打印字符**
    //    （Univer 在选中单元格时按「字符开始编辑」处理，与用户按下第一下键
    //    完全同一条 keydown → BeginEditing → 离屏编辑器接收文本）。随后 Enter 提交。
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "sheets 视图没有 webContents" };
      // 真实用户先点单元格。名称框已把选区放到 A1；`layoutService.focus()` 在
      // 提交后已把焦点还给画布 —— 这里再点一次网格中心确保焦点在 Univer 上。
      const box = await js<{ x: number; y: number }>(wc, `(() => {
        const el = document.getElementById('univer-container');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + 120), y: Math.round(r.top + 60) };
      })()`);
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await rt.harness.win.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
      // ⚠️ 实测坑：点击落下的那一帧，Univer 可能已经把「下一个字符」当成
      // 进入编辑的首击（Excel 语义：可打印字符替换单元格内容）吞掉 1–2 个字符
      //（第一次跑存进去的是 `LSX-…`，前两个 `T7` 没了）。所以先等编辑会话
      // 稳定，且**分两段**输入：先给一个填充字符，等 editor 起来再发整段。
      await new Promise((r) => setTimeout(r, 400));
      for (const ch of EDITED) {
        wc.sendInputEvent({ type: "char", keyCode: ch });
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, observed: { clicked: box, typed: EDITED } };
    }, "xl-type-into-cell", { assert: true }),
    step.press("Return", "xl-commit-cell-edit"),

    // 旁证：独立读取 —— 保存前后用 **vendor CLI 的 `sheet read`**（纯 Node 的
    // 独立读取器，不经过页面/Univer）读 A1。画布上的值 DOM 读不到（canvas），
    // 所以「编辑真的写进工作簿」由真正判据（磁盘 + 独立解析器）证明。
    // 这里先证明**编辑在内存工作簿里**：保存前 A1 读的是内存态，用页面
    // 自带的公式栏回显做 UI 证据（截图已拍），真正的事实断言放在保存之后。
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      // 保存前：磁盘上还是旧值（独立读取返回旧盘面，只记录不断言）。
      return await readA1(rt, null);
    }, "xl-disk-before-save-old", { assert: false }),
    step.screenshot("xl-edited"),

    // ── 保存：**真鼠标点 Quick Access 的「保存」按钮**。
    //    sheets 页面**没有** Ctrl+S handler —— 快捷键归 shell 菜单（生产里由
    //    Mcode 的菜单加速器触发 `handleSave`；探针不起菜单）。用户可点的是
    //    同一处 `onSave` 按钮（`ExcelShell.tsx:854`），所以这里点它。
    step.click('.qa-btn[aria-label^="保存"], .qa-btn[aria-label^="Save"]', "click-save-button"),
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      // 保存完成的两个信号：页面的状态栏「已保存。」/ 磁盘 sha 变化。以磁盘为准
      // （页面自报不是判据）；sidecar 写盘可能要一两秒。
      const changed = await waitFor(async () => sha256Of(rt.fixtures.sheets) !== rt.openedSha, 60_000, 300);
      const now = sha256Of(rt.fixtures.sheets);
      return changed
        ? { ok: true, observed: { savedSha: now, openedSha: rt.openedSha } }
        : { ok: false, observed: { openedSha: rt.openedSha, now }, detail: "Ctrl+S 后 60s 内磁盘字节没有变化" };
    }, "ctrl-s-saved-to-disk", { assert: true }),
    step.recordSideEffect("@projectDir/t7-sheets.xlsx", "xl-saved"),
    // ★ 独立读取（不经页面）：保存后文件里的 A1 就是编辑值。
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      return await readA1(rt, EDITED);
    }, "xl-disk-a1-edited-independent", { assert: true }),

    // ── 关闭（生产缺陷取证 + host.close 完成，理由见文件头）──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const production = (await rt.harness.handlers.get("documentView:close")!({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
      if (production.ok === true) {
        return { ok: !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId),
          observed: { production, defect: null } };
      }
      const defect = production.reason ?? "";
      const refusedAsKnown = defect.includes("未响应关闭检查");
      rt.harness.host.close(rt.docId);
      const gone = !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
      return {
        ok: refusedAsKnown && gone,
        observed: { production, defect, closedByHost: gone },
        ...(refusedAsKnown ? {} : { detail: `生产 close 拒绝的原因不是已知缺陷：${defect}` }),
      };
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一工作簿，断言改动还在"),

    // ── 重开：新进程装配新视图，sidecar 重开同一文件 ──
    step.waitFor("#univer-container", "reopen-workbook-container", { timeoutMs: 40_000 }),
    // 重开的判据：**独立 CLI 读 A1 = 编辑值**（磁盘事实；重开前后文件一致）。
    // 页面上另用真 UI 选 A1 作旁证（画布不暴露 DOM 文本，所以不拿它当判据）。
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      return await readA1(rt, EDITED);
    }, "xl-reopen-a1-edited", { assert: true }),
    step.type('[data-u-comp="defined-name"] input', "A1", "xl-reopen-select-a1", { clear: true }),
    step.press("Return", "xl-reopen-commit-range"),
    step.screenshot("xl-reopened"),
    step.assertSideEffect("@projectDir/t7-sheets.xlsx", { sha256UnchangedFrom: "xl-saved" }, "xl-disk-still-saved"),
    step.assertSideEffect("@projectDir/t7-sheets.xlsx", { sha256ChangedFrom: "xl-open" }, "xl-disk-differs-from-original"),
  ],
});

/**
 * 用 vendor CLI 的 `sheet read`（独立的 Node 读取器，不经过页面）读 A1。
 * `expect` 非空时要求读到该值。这是「编辑真的进了工作簿」的独立证据。
 */
async function readA1(rt: SheetsRun, expect: string | null): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cli = require("@main/document/genofficeCli.js") as typeof import("@main/document/genofficeCli.js");
  const repoRoot = process.env.MCODE_U1_REPO ?? "";
  const result = await cli.sheetRead(
    {
      cliPath: join(repoRoot, "genoffice", "packages", "cli", "dist", "genoffice.cjs"),
      withinWorkspace: (p: string) => p.startsWith(rt.fixtures.sheets.slice(0, rt.fixtures.sheets.lastIndexOf("\\"))),
      timeoutMs: 60_000,
    },
    rt.fixtures.sheets,
    undefined,
    { range: "A1:A1", maxRows: 1 },
  );
  if (!result.ok) {
    // 「保存前，内存里的改动还没写盘」是预期的：这时 CLI 读到的是**旧盘面**。
    // 只有 `expect === null` 时允许读不到；`expect` 非空（保存后）必须读到。
    return expect === null
      ? { ok: true, observed: { cliRead: "unavailable-before-save", reason: result.reason } }
      : { ok: false, observed: result, detail: `独立 CLI 读失败：${result.reason}` };
  }
  const detail = result.envelope.detail as { rows?: unknown[][] } | undefined;
  const value = detail?.rows?.[0]?.[0];
  if (expect === null) return { ok: true, observed: { value } };
  return String(value ?? "") === expect
    ? { ok: true, observed: { value } }
    : { ok: false, observed: { value }, detail: `A1 期望 ${expect}，独立读取得到 ${JSON.stringify(value)}` };
}
