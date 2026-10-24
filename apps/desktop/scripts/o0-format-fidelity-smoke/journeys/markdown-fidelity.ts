/**
 * O0 旅程 2 —— Markdown 保真：改正文一句无关的话，表格 / 代码块 / 图片引用 /
 * 嵌套列表必须逐项保留。
 *
 * ## 编辑入口：真 Ctrl+H（页面的查找替换面板）
 *
 * markdown 页的 `Ctrl+H` 打开 FindPanel（`@genoffice/ui/find-panel`），它的
 * `replaceAll` 走 Tiptap 的 `tiptapFindTarget` —— 与用户按键是同一条命令栈。
 * 面板是页面自己的 React 组件，不是探针代造的。
 *
 * ## 判据
 *
 * 同 docx：打开取基线指纹（文本级结构识别）→ 改一处无关文本 → 保存 → 重开 → 比对。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

const EDITED = `${O0.markdown.tail}-EDITED`;

export const markdownFidelityJourney = defineU1Journey({
  name: "markdown-fidelity",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: o0Setup("markdown") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor(".doc-editor", "md-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".doc-editor", "md-shows-fixture-text", { text: O0.markdown.tail, timeoutMs: 30_000 }),

    // ── 基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "markdown", rt.fixtures.markdown, repoRoot);
    }, "markdown-baseline-fingerprint", { assert: true }),

    // ── 编辑：真 Ctrl+H → FindPanel 里 replace all（改正文那句无关的话）──
    step.press("h", "open-find-replace", ["control"]),
    step.waitFor(".find-panel", "find-panel-open", { timeoutMs: 10_000 }),
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "md 视图没有 webContents" };
      // 用页面自己的两个输入框：find = 原句，replace = 改后句，然后点 replaceAll。
      const filled = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const inputs = [...document.querySelectorAll('.find-panel .find-input')];
        if (inputs.length < 2) return { ok: false, reason: 'find-panel 输入框不足两个' };
        const set = (el, value) => {
          const proto = HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(inputs[0], ${JSON.stringify(O0.markdown.tail)});
        set(inputs[1], ${JSON.stringify(EDITED)});
        return { ok: true };
      })()`);
      if (!filled.ok) return filled;
      // 等面板的防抖扫描出结果（replaceAll 按钮在 count=0 时是 disabled）。
      // ⚠️ 按**结构**选按钮，不按文案选：文案走 i18n（zh/en/… 随界面语言），
      // 按「第二个 .find-action」定位在两种语言下都成立。
      const { waitFor } = await import("../setup.js");
      const enabled = await waitFor(async () => await js<boolean>(wc,
        `(() => { const bs = [...document.querySelectorAll('.find-panel .find-action')]; return bs.length === 2 && !bs[1].disabled; })()`), 10_000, 150);
      if (!enabled) return { ok: false, detail: "10s 内 replaceAll 按钮没有启用（面板没扫到匹配）" };
      const clicked = await js<{ ok: boolean; text?: string }>(wc, `(() => {
        const bs = [...document.querySelectorAll('.find-panel .find-action')];
        const b = bs[1];
        if (!b) return { ok: false };
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, text: (b.textContent || '').trim() };
      })()`);
      return clicked;
    }, "replace-all-unrelated-text", { assert: true }),
    step.assertDom(".doc-editor", { textContains: EDITED }, "dom-shows-edited-text"),

    // ── 保存：真键盘 Ctrl+S ──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "markdown", rt.fixtures.markdown, 45_000);
    }, "saved-to-disk", { assert: true }),

    // 独立核对（直接读盘）：保存后的 .md 文件里是编辑后的句子。
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(rt.fixtures.markdown, "utf8");
      return text.includes(EDITED)
        ? { ok: true, observed: { tail: text.slice(-120) } }
        : { ok: false, observed: { head: text.slice(0, 300) }, detail: "保存后的 .md 里没有编辑文本（编辑没有落盘）" };
    }, "md-disk-has-edit", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一文件，逐项比对复杂部件"),

    step.waitFor(".doc-editor", "reopen-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".doc-editor", "reopen-shows-edited-text", { text: EDITED, timeoutMs: 30_000 }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "markdown", rt.fixtures.markdown, repoRoot);
    }, "markdown-fidelity-compare", { assert: true }),
  ],
});
