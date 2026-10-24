/**
 * O0 旅程 1 —— DOCX 保真：改正文第一段的一个词，嵌套表 / 编号列表 / 页眉页脚 /
 * 脚注 / 东亚字体必须逐项仍在且语义等价。
 *
 * 生产链、判据、排除项见 `setup.ts` 与 `fidelity/fingerprint.ts` 的文件头。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, openDocsPath, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

/** 编辑目标：把唯一正文文本换成一个带 EDITED 后缀的版本（不动任何复杂部件）。 */
const EDITED = `${O0.docx.body}-EDITED`;

export const docxFidelityJourney = defineU1Journey({
  name: "docx-fidelity",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: o0Setup("docx") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    // ── 打开：生产 openPath + 页面回执 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "docs 视图没有 webContents" };
      return openDocsPath(wc, rt.harness, rt.docId, rt.fixtures.docx);
    }, "open-production-path", { assert: true }),
    step.waitFor(".ProseMirror", "editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".ProseMirror", "shows-fixture-text", { text: O0.docx.body, timeoutMs: 30_000 }),

    // ── 三步里的第 1 步：基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "docx", rt.fixtures.docx, repoRoot);
    }, "docx-baseline-fingerprint", { assert: true }),

    // ── 三步里的第 2 步：只改正文第一段那个词（真 ProseMirror transaction）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "docs 视图没有 webContents" };
      return js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const pm = document.querySelector('.ProseMirror');
        const editor = pm && pm.editor;
        if (!editor) return { ok: false, reason: 'ProseMirror editor handle 不可用' };
        const doc = editor.state.doc;
        let from = -1, to = -1;
        doc.descendants((node, pos) => {
          if (from >= 0) return false;
          if (node.isText && node.text && node.text.includes(${JSON.stringify(O0.docx.body)})) {
            const idx = node.text.indexOf(${JSON.stringify(O0.docx.body)});
            from = pos + idx; to = from + ${O0.docx.body.length};
            return false;
          }
          return true;
        });
        if (from < 0) return { ok: false, reason: '文档模型里找不到正文唯一文本' };
        pm.focus();
        editor.commands.setTextSelection({ from, to });
        editor.commands.insertContent(${JSON.stringify(EDITED)});
        return { ok: true };
      })()`);
    }, "edit-unrelated-paragraph", { assert: true }),
    step.assertDom(".ProseMirror", { textContains: EDITED }, "dom-shows-edited-text"),

    // ── 保存：真键盘 Ctrl+S（页面自己的保存入口）──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "docx", rt.fixtures.docx, 45_000);
    }, "saved-to-disk", { assert: true }),

    // 独立核对（不经页面）：保存后的 docx 里，第一段是编辑后的文本。这条证明
    // 「这次编辑真的落盘了」—— 否则后面的保真比对只证明「两份没编辑过的文件互相
    // 一致」。用 vendor `docs read`（产品自己的读取器）而不是解 XML。
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const { spawnSync } = await import("node:child_process");
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      const cli = `${repoRoot}/genoffice/packages/cli/dist/genoffice.cjs`;
      const r = spawnSync(process.execPath, [cli, "docs", "read", rt.fixtures.docx, "--full", "--json"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
      });
      if (r.status !== 0) return { ok: false, observed: r.stdout.slice(0, 400), detail: "独立 CLI 读取失败" };
      const detail = (JSON.parse(r.stdout) as { detail?: { items?: Array<{ text?: string }> } }).detail;
      const texts = (detail?.items ?? []).map((b) => b.text ?? "").join(" | ");
      return texts.includes(EDITED)
        ? { ok: true, observed: { firstItems: texts.slice(0, 160) } }
        : { ok: false, observed: { items: texts.slice(0, 300) }, detail: "保存后的 docx 里没有编辑文本（编辑没有落盘）" };
    }, "docx-disk-has-edit", { assert: true }),

    // ── 关闭：生产 documentView:close ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    // ── 真重开进程 ──
    step.relaunch("relaunch-after-close", "重开进程后重新打开同一文件，逐项比对复杂部件"),

    // ── 重开：新进程重新打开（新 setup 已重建视图）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 docs 视图没有 webContents" };
      return openDocsPath(wc, rt.harness, rt.docId, rt.fixtures.docx);
    }, "reopen-production-path", { assert: true }),
    step.waitFor(".ProseMirror", "reopen-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".ProseMirror", "reopen-shows-edited-text", { text: EDITED, timeoutMs: 30_000 }),

    // ── 三步里的第 3 步：逐项比对 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "docx", rt.fixtures.docx, repoRoot);
    }, "docx-fidelity-compare", { assert: true }),
  ],
});
