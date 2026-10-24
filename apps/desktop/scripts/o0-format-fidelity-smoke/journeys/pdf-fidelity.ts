/**
 * O0 旅程 6 —— PDF 保真：把第 1 页向右旋转（与文本/书签/批注无关的操作），
 * 文本层 / 书签 / 批注必须逐项保留。
 *
 * ## 编辑入口：真 UI（「页面」tab →「向右旋转」；与 t7 pdf 旅程同一条）
 *
 * 旋转走页面的 `rotatePage` → `applyEditOps`，保存是真键盘 Ctrl+S →
 * `window.pdfApi.save` → vendor `savePdfToPath`（pdf-lib 原子写）。旋转只改
 * 页面对象的 `/Rotate`，不重写文本层、`/Outlines`、`/Annots` —— 那正是要证明的。
 *
 * ## 判据
 *
 * 基线指纹用产品自己的读取器 pdf.js（与 `genoffice/apps/pdf` 的依赖同一版本）：
 * 文本层 / 书签标题与层级 / 批注（Subtype + Contents + Rect）。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, waitFor, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

export const pdfFidelityJourney = defineU1Journey({
  name: "pdf-fidelity",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: o0Setup("pdf") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor(".app", "pdf-app-mounted", { timeoutMs: 40_000 }),

    // ── 内容就绪：pdf.js 文本层里出现夹具第 1 页文本 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "pdf 视图没有 webContents" };
      const text = await waitFor(async () => await js<string>(wc,
        `([...document.querySelectorAll('.textLayer span')].map((s) => s.textContent || '').join(''))`), 90_000, 250);
      return text && text.includes(O0.pdf.page1)
        ? { ok: true, observed: { layer: text.slice(0, 120) } }
        : { ok: false, observed: { text }, detail: "pdf.js 文本层里没有夹具第 1 页文本" };
    }, "pdf-text-layer-has-fixture", { assert: true }),

    // ── 基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "pdf", rt.fixtures.pdf, repoRoot);
    }, "pdf-baseline-fingerprint", { assert: true }),

    // ── 编辑：真 UI ——「页面」tab →「向右旋转」（rotation 90°，与内容无关）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "pdf 视图没有 webContents" };
      const clicked = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const tabs = [...document.querySelectorAll('.ribbon-tab')];
        const page = tabs.find((b) => (b.textContent || '').trim() === '页面' || (b.textContent || '').trim() === 'Pages');
        if (!page) return { ok: false, reason: '找不到「页面」tab' };
        page.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      })()`);
      if (!clicked.ok) return clicked;
      await new Promise((r) => setTimeout(r, 400));
      const rotated = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const bs = [...document.querySelectorAll('button.rb-big')];
        const right = bs.find((b) => /向右旋转|Rotate right/.test(b.textContent || ''));
        if (!right) return { ok: false, reason: '找不到「向右旋转」按钮' };
        if (right.hasAttribute('disabled')) return { ok: false, reason: '「向右旋转」按钮 disabled' };
        right.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      })()`);
      return rotated;
    }, "pdf-rotate-page-ui", { assert: true }),

    // ── 保存：真键盘 Ctrl+S ──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "pdf", rt.fixtures.pdf, 60_000);
    }, "saved-to-disk", { assert: true }),

    // 独立核对：保存后的字节里真有 /Rotate（旋转真的写了，不是只改了页面状态）
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(rt.fixtures.pdf).toString("latin1");
      return /\/Rotate\s+90/.test(text)
        ? { ok: true, observed: { hasRotate90: true } }
        : { ok: false, detail: "保存后的 PDF 字节里没有 /Rotate 90（旋转没有写出）" };
    }, "pdf-disk-has-rotation", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一 PDF，逐项比对复杂部件"),

    step.waitFor(".app", "pdf-reopen-mounted", { timeoutMs: 40_000 }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "pdf", rt.fixtures.pdf, repoRoot);
    }, "pdf-fidelity-compare", { assert: true }),
  ],
});
