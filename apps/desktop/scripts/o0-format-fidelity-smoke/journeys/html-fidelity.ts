/**
 * O0 旅程 3 —— HTML 保真：改正文一句无关的话，`<style>` 样式表 / 内联 `<svg>` /
 * 内联 `<script>` 必须逐项保留。
 *
 * ## 编辑入口：源码模式的真 Ctrl+H（FindPanel → CodeMirror）
 *
 * html 页默认是可视化预览；工具栏「源码」按钮切到源码面板（页面自己的按钮）。
 * 在源码面板里 `Ctrl+H` 打开 FindPanel，它的 target 是 `cmFindTarget(view…)` ——
 * 与用户按键同一条 CodeMirror transaction。改的是正文第一段那句唯一文本，
 * 不碰 `<style>` / `<svg>` / `<script>` 里的任何字节。
 *
 * ## 判据
 *
 * 同其他格式：打开取基线指纹（文本级结构）→ 改一处无关文本 → 保存 → 重开 → 比对。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, waitFor, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

const EDITED = `${O0.html.tail}-EDITED`;

export const htmlFidelityJourney = defineU1Journey({
  name: "html-fidelity",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: o0Setup("html") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor(".app", "html-app-mounted", { timeoutMs: 40_000 }),

    // ── 基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "html", rt.fixtures.html, repoRoot);
    }, "html-baseline-fingerprint", { assert: true }),

    // ── 切到源码模式（页面工具栏的「源码」/「Source」按钮真实点击）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const switched = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const bs = [...document.querySelectorAll('button')];
        const src = bs.find((b) => /^(源码|Source)$/.test((b.textContent || '').trim()));
        if (!src) return { ok: false, reason: '找不到源码按钮' };
        src.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      })()`);
      if (!switched.ok) return switched;
      const mounted = await waitFor(async () => await js<boolean>(wc, "!!document.querySelector('.cm-content')"), 20_000, 200);
      return mounted ? { ok: true } : { ok: false, detail: "20s 内 .cm-content 没有进入 DOM" };
    }, "switch-to-source", { assert: true }),

    // 源码里能看到复杂部件（先证明编辑面就是完整文档，不是一段摘录）
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const text = await js<string>(wc, "document.querySelector('.cm-content')?.textContent ?? ''");
      const missing = [O0.html.styleMarker, O0.html.svgMarker, O0.html.scriptMarker, O0.html.tail]
        .filter((m) => !text.includes(m));
      return missing.length === 0
        ? { ok: true, observed: { chars: text.length } }
        : { ok: false, observed: { missing }, detail: `源码面板里看不到：${missing.join(", ")}` };
    }, "source-shows-complex-parts", { assert: true }),

    // ── 编辑：在源码面板聚焦后 Ctrl+H（页面 keydown 捕获 → FindPanel → CodeMirror）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const pt = await js<{ ok: boolean; x?: number; y?: number }>(wc, `(() => {
        const host = document.querySelector('.source-editor') ?? document.querySelector('.cm-editor');
        if (!host) return { ok: false };
        const r = host.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return { ok: false };
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 120)) };
      })()`);
      if (!pt.ok) return { ok: false, detail: "源码面板没有可用矩形" };
      wc.sendInputEvent({ type: "mouseMove", x: pt.x!, y: pt.y! });
      wc.sendInputEvent({ type: "mouseDown", x: pt.x!, y: pt.y!, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: pt.x!, y: pt.y!, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 200));
      const focused = await js<boolean>(wc, `(() => {
        const el = document.querySelector('.cm-content');
        return !!el && (document.activeElement === el || el.contains(document.activeElement));
      })()`);
      return focused ? { ok: true } : { ok: false, detail: "点击源码面板后 CodeMirror 没有获得焦点" };
    }, "focus-source-editor", { assert: true }),
    step.press("h", "open-find-replace", ["control"]),
    step.waitFor(".find-panel", "find-panel-open", { timeoutMs: 10_000 }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const filled = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const inputs = [...document.querySelectorAll('.find-panel .find-input')];
        if (inputs.length < 2) return { ok: false, reason: 'find-panel 输入框不足两个' };
        const set = (el, value) => {
          const proto = HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(inputs[0], ${JSON.stringify(O0.html.tail)});
        set(inputs[1], ${JSON.stringify(EDITED)});
        return { ok: true };
      })()`);
      if (!filled.ok) return filled;
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
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const seen = await waitFor(async () => {
        const t = await js<string>(wc, "document.querySelector('.cm-content')?.textContent ?? ''");
        return t.includes(EDITED) ? t : null;
      }, 15_000, 250);
      return seen ? { ok: true } : { ok: false, detail: "15s 内源码里没有编辑文本" };
    }, "source-shows-edited-text", { assert: true }),

    // ── 保存：真键盘 Ctrl+S ──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "html", rt.fixtures.html, 45_000);
    }, "saved-to-disk", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一文件，逐项比对复杂部件"),

    step.waitFor(".app", "reopen-app-mounted", { timeoutMs: 40_000 }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "html", rt.fixtures.html, repoRoot);
    }, "html-fidelity-compare", { assert: true }),
  ],
});
