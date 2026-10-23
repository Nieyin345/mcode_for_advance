/**
 * T30 旅程 3 —— Sheets：**有一条工具面链路**，并如实标出它的边界。
 *
 * ## 为什么 Sheets 不是「再来一遍 Docs」
 *
 * Sheets 的原厂主进程是 **standalone 完整应用**（`registerSheetsIpc` 全量注册，
 * 且是全局 `ipcMain.handle`），Mcode 的 `DocumentViewHost` 不会在 Mcode 进程里
 * 再注册一遍（那样会与全局通道冲突）。所以 Sheets **没有** T98 那种
 * 「宿主发 tool-call、渲染端执行、ACK 回同一请求」的受信通道。
 *
 * 它能走的是 `document.tool_call` 的 **CLI 路线**：`sheet read` / `sheet apply`
 * + 编辑后的 `sheet check` 门禁 —— 这条路线改的是**盘上的字节**，不经过页面。
 *
 * ## 本旅程断言什么（诚实版）
 *
 * 1. `document_apps` / `tools_list` / `tool_describe` 对 sheets 正确；
 * 2. `document.tool_call({tool:"propose_operations"})` 真的把 A1 写进 .xlsx，
 *    且**独立读取器**（直接用 CLI，不经过被测 handler）读到同一个值；
 * 3. 编辑后返回的 `qa` 带着 `detail.issues`（门禁没被跳过）；
 * 4. **负控**：sheets 的 renderer-only 工具（例如 `read_range` 之外的
 *    `web_search` / `image_search` / `generate_image`，它们不在 CLI 白名单里）
 *    必须被显式拒绝，不许静默降级。
 * 5. **UI 侧边界**（写进证据，不是脏断言）：工作表确实在真窗口里打开了
 *    （`#univer-container`），但本条旅程**没有**让渲染端执行工具 —— 因为
 *    Sheets 没有受信 ACK 通道。这不是缺陷，是当前产品面的事实；要它也有，
 *    需要为 sheets 接一条与 Docs 同形的请求级通道（另开卡）。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { join } from "node:path";
import { UNIQUE, readCellWithCli } from "../fixtures.js";

interface SheetsRun {
  harness: import("../../t7-genoffice-u1/harness.js").GenofficeHarness;
  fixtures: { docs: string; sheets: string };
  docId: string;
  repoRoot: string;
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>;
  openedA1: string;
}

const DOC_ID = "t30-sheets";

async function sheetsSetup(ctx: import("../../electron-u1/driver/index.js").U1SetupContext) {
  const repoRoot = process.env.MCODE_U1_REPO ?? "";
  if (!repoRoot) throw new Error("T30: MCODE_U1_REPO 未设置");
  if (ctx.win === null) throw new Error("T30: Sheets 视图需要宿主窗口");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assembleHarness } = require("../../t7-genoffice-u1/harness.js") as typeof import("../../t7-genoffice-u1/harness.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureFixtures } = require("../fixtures.js") as typeof import("../fixtures.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installDocumentSurface } = require("./lib.js") as typeof import("./lib.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { waitForPageReady, waitFor } = require("../../t7-genoffice-u1/editor-flow.js") as typeof import("../../t7-genoffice-u1/editor-flow.js");

  const fixtures = ensureFixtures(ctx.projectDir, repoRoot);
  const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir });
  const status = harness.nativeStatus;
  if (status.sheets !== true) {
    harness.dispose();
    throw new Error(`T30: sheets 的原厂视图未装配（preload/renderer/sidecar 缺失）: ${JSON.stringify(status)}`);
  }
  const handlers = installDocumentSurface(repoRoot);

  const opened = harness.host.open({
    docId: DOC_ID,
    url: "genoffice-app://sheets/index.html",
    bounds: { x: 0, y: 0, width: 1280, height: 900 },
    visible: true,
    mcodeSessionId: "t30-u1-session",
    editor: "sheets",
    filePath: fixtures.sheets,
  });
  if (!opened.ok) { harness.dispose(); throw new Error(`T30: sheets 视图打开失败：${opened.reason}`); }
  const wc = harness.webContentsOf(DOC_ID);
  if (wc === null) { harness.dispose(); throw new Error("T30: sheets 视图没有 webContents"); }
  await waitForPageReady(wc);
  const ready = await waitFor(
    () => wc.executeJavaScript("!!document.querySelector('#univer-container')").then((v: unknown) => v === true),
    45_000,
    250,
  );
  if (!ready) { harness.dispose(); throw new Error("T30: sheets 45s 内没有挂载 #univer-container"); }

  const initial = readCellWithCli(repoRoot, fixtures.sheets, "A1");
  const runtime: SheetsRun = { harness, fixtures, docId: DOC_ID, repoRoot, handlers, openedA1: initial.value };
  return { pageFromView: wc, dispose() { harness.dispose(); }, runtime };
}

export const sheetsJourney = defineU1Journey({
  name: "sheets-tool-call",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 40_000,
    setup: sheetsSetup as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.waitFor("#univer-container", "sheets-workbook-container", { timeoutMs: 45_000 }),
    step.screenshot("sheets-opened", "sheets-opened"),

    // ── 发现链路 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const apps = await callSurface<{ apps: Array<{ app: string; toolCount: number; cliTools: string[] }> }>(rt.handlers, "document:apps", {});
      const sheets = apps.apps.find((item) => item.app === "sheets");
      if (!sheets) return { ok: false, observed: apps, detail: "document_apps 没有返回 sheets" };
      return sheets.toolCount >= 18 && sheets.cliTools.includes("propose_operations")
        ? { ok: true, observed: { toolCount: sheets.toolCount, cliTools: sheets.cliTools.length } }
        : { ok: false, observed: sheets, detail: "sheets 目录或 CLI 白名单不对" };
    }, "sheets-apps", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const described = await callSurface<{ ok: boolean; route?: string; app?: string }>(rt.handlers, "document:toolDescribe", { tool: "read_range", app: "sheets" });
      return described.ok === true && described.app === "sheets"
        ? { ok: true, observed: described }
        : { ok: false, observed: described, detail: "sheets.read_range 描述失败" };
    }, "sheets-tool-describe", { assert: true }),

    // ── 调用链路：CLI 写入 A1，独立读取器复核 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const marker = `${UNIQUE.sheets}-A1`;
      const call = await callSurface<{
        ok: boolean; route?: string; kind?: string; reason?: string; mutated?: boolean;
        qa?: { gate: string; ok: boolean; issues: unknown[] };
      }>(rt.handlers, "document:toolCall", {
        tool: "propose_operations",
        app: "sheets",
        filePath: rt.fixtures.sheets,
        input: { ops: [{ op: "set_cell", address: "A1", value: marker }] },
      });
      if (call.ok !== true) return { ok: false, observed: call, detail: `sheet 写入失败：${call.reason}` };
      if (call.route !== "cli") return { ok: false, observed: call, detail: `sheets 的 toolCall 应走 CLI，实际 ${call.route}` };
      // ★ 独立读取（直接调 CLI，不经过被测 handler）
      const independent = readCellWithCli(rt.repoRoot, rt.fixtures.sheets, "A1");
      if (independent.value !== marker) {
        return { ok: false, observed: { independent, marker }, detail: `磁盘上的 A1 不是写入值（读到 ${JSON.stringify(independent.value)}）` };
      }
      return { ok: true, observed: { route: call.route, mutated: call.mutated, a1: independent.value, qaGate: call.qa?.gate } };
    }, "sheets-cli-write-and-independent-read", { assert: true }),

    // ── QA 门禁：编辑后必须回 detail.issues（空数组也算，但 gate 字段必须在）──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const call = await callSurface<{
        ok: boolean; route?: string; mutated?: boolean;
        qa?: { gate: string; ok: boolean; issues: unknown[]; counts?: Record<string, number> };
      }>(rt.handlers, "document:toolCall", {
        tool: "propose_operations",
        app: "sheets",
        filePath: rt.fixtures.sheets,
        input: { ops: [{ op: "set_cell", address: "B1", value: "t30-qa" }] },
      });
      if (call.ok !== true) return { ok: false, observed: call, detail: "第二次写入失败" };
      const qa = call.qa;
      if (!qa) return { ok: false, observed: call, detail: "编辑后没有 qa 字段 —— 门禁被跳过了" };
      if (qa.gate !== "check") return { ok: false, observed: qa, detail: `门禁不是 check：${qa.gate}` };
      if (!Array.isArray(qa.issues)) return { ok: false, observed: qa, detail: "qa.issues 不是数组" };
      return { ok: true, observed: { gate: qa.gate, issues: qa.issues.length, counts: qa.counts } };
    }, "sheets-qa-gate", { assert: true }),

    // ── 负控：sheets 的 renderer-only 工具必须显式拒绝 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const refused = await callSurface<{ ok: boolean; kind?: string; reason?: string }>(rt.handlers, "document:toolCall", {
        tool: "web_search", app: "sheets", filePath: rt.fixtures.sheets, input: { query: "t30" },
      });
      const ok = refused.ok === false && refused.kind === "refused" && /编辑器/.test(refused.reason ?? "");
      return ok
        ? { ok: true, observed: { kind: refused.kind, reason: (refused.reason ?? "").slice(0, 140) } }
        : { ok: false, observed: refused, detail: "renderer-only 工具没有按约定拒绝（可能静默降级了）" };
    }, "sheets-renderer-only-refused", { assert: true }),

    // ── 独立读取证明 A1 仍是写入值（后续调用没有把它改回去）──
    step.run(async ({ runtime }) => {
      const rt = runtime as SheetsRun;
      const current = readCellWithCli(rt.repoRoot, rt.fixtures.sheets, "A1");
      return current.value === `${UNIQUE.sheets}-A1`
        ? { ok: true, observed: current.value }
        : { ok: false, observed: current, detail: "A1 在后续调用后变了" };
    }, "sheets-a1-stable", { assert: true }),

    step.screenshot("sheets-after-tools", "sheets-after-tool-calls"),
    step.recordSideEffect("@projectDir/t30-sheets.xlsx", "sheets-after"),
  ],
});
