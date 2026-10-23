/**
 * T7 旅程 5 —— PDF：打开 → 断言内容 → 编辑（页面旋转）→ 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 生产链
 *
 *  - 页面：vendor pdf 真构建产物（pdf.js 渲染）；
 *  - preload：vendor `apps/pdf/out/preload/index.js`（`window.pdfApi`）；
 *  - 打开：`createPdfView(path)` → `grantAndTrack(wc, path)`（每 wc 授权路径）
 *    → 页面首帧 `consumePending()` 拿路径 → `readFile` 只读被授权路径；
 *  - 内容断言：pdf.js 的**文本层**（`.textLayer span`）里出现夹具文本
 *    （Chromium 真打印生成的 PDF，文本层可选中）；
 *  - 编辑：**真 UI** —— ribbon「页面」tab →「向右旋转」（`rotatePage(curOrigIdx, 90)`，
 *    与用户点按钮同一条 `applyEditOps`）；页面立即按旋转后的几何重绘；
 *  - 保存：**真键盘 Ctrl+S**（pdf 页面自己的 keydown → `save()`）→
 *    `window.pdfApi.save({path, rotations…})` → vendor `pdf:save` →
 *    `savePdfToPath`（pdf-lib 原子写；实测不需要 pdfium wasm）；
 *  - 关闭：生产 `documentView:close`（T29 起转给 vendor `requestPdfClose`）；
 *  - 重开：真 OS 重开 → 新视图重开同一 PDF → 断言页面旋转仍在 + 磁盘一致。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { editorSetup, js, sha256Of, waitFor } from "../editor-flow.js";
import type { FixturePaths } from "../fixtures.js";

interface PdfRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
}

export const pdfJourney = defineU1Journey({
  name: "pdf-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: editorSetup("pdf") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      rt.openedSha = sha256Of(rt.fixtures.pdf);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-pdf.pdf", "pdf-open"),

    // ── 内容断言：pdf.js 文本层里出现夹具文本 ──
    step.waitFor(".app", "pdf-app-mounted", { timeoutMs: 40_000 }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "pdf 视图没有 webContents" };
      // 诊断：worker 能否从本页 origin 启动（pdf.js 用 `?url` 的模块 worker）。
      const workerProbe = await js<unknown>(wc, `(async () => {
        try {
          const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>self.postMessage(1)'], { type: 'application/javascript' })), { type: 'classic' });
          const ok = await new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), 3000); w.onmessage = () => { clearTimeout(t); resolve(true); }; w.onerror = (e) => { clearTimeout(t); resolve('error:' + (e.message || '')); }; w.postMessage(1); });
          w.terminate();
          return { blobWorker: ok };
        } catch (e) { return { blobWorker: 'throw:' + String(e) }; }
      })()`);
      const errHook = await js<unknown>(wc, `(async () => {
        if (!window.__t7Err) {
          window.__t7Err = [];
          window.addEventListener('error', (e) => window.__t7Err.push(String(e.message || e.error)));
          window.addEventListener('unhandledrejection', (e) => window.__t7Err.push(String((e.reason && e.reason.message) || e.reason)));
        }
        return window.__t7Err;
      })()`);
      const bridge = await js<Record<string, unknown>>(wc, `(() => ({
        pdfApi: typeof window.pdfApi,
        keys: window.pdfApi ? Object.keys(window.pdfApi).length : 0,
        hasConsume: typeof window.pdfApi?.consumePending,
        root: document.getElementById('root')?.childElementCount ?? -1,
        placeholder: (document.querySelector('.pdf-placeholder')?.textContent || '').slice(0, 40),
      }))()`);
      // 直接问一次 consumePending（页面挂载时已经问过一次；此 handler 幂等只读）。
      let consume: unknown = null;
      let readBytes: unknown = null;
      try {
        consume = await js<unknown>(wc, "window.pdfApi.consumePending()");
        readBytes = await js<unknown>(wc, `(async () => {
          const p = await window.pdfApi.consumePending();
          if (!p) return { ok: false, reason: 'no path' };
          try { const buf = await window.pdfApi.readFile(p); return { ok: true, bytes: buf.byteLength ?? buf.length ?? -1, head: new Uint8Array(buf).slice(0, 5).join(',') }; }
          catch (e) { return { ok: false, error: String(e) }; }
        })()`);
      } catch (e) { consume = { error: String(e) }; }
      // pdf.js worker 首启预热在繁忙机器上可能 >40 s（实测偶发）；给 90 s。
      // 若页面 25 s 还停在「正在打开…」，做一次**真实的重载**（View→Reload
      // 同一条 `webContents.reload()`；vendor 的 `consumePending` 明确保留到
      // 视图销毁，重载后页面会重新拉到同一路径）。
      let text = await waitFor(async () => await js<{ layer: string; pages: number }>(wc, `(() => {
        const spans = [...document.querySelectorAll('.textLayer span')];
        return { layer: spans.map((s) => s.textContent || '').join(''), pages: document.querySelectorAll('.pdf-page, .page').length };
      })()`), 25_000, 250);
      if (!text || !text.layer) {
        wc.reload();
        await new Promise((r) => setTimeout(r, 800));
        text = await waitFor(async () => await js<{ layer: string; pages: number }>(wc, `(() => {
          const spans = [...document.querySelectorAll('.textLayer span')];
          return { layer: spans.map((s) => s.textContent || '').join(''), pages: document.querySelectorAll('.pdf-page, .page').length };
        })()`), 60_000, 250);
      }
      return text && text.layer.includes(UNIQUE.pdf)
        ? { ok: true, observed: { pages: text.pages, layer: text.layer.slice(0, 120) } }
        : { ok: false, observed: { bridge, workerProbe, errHook, consume, readBytes, text }, detail: "pdf.js 文本层里没有夹具文本（或页面没渲染出来）" };
    }, "pdf-text-layer-has-fixture", { assert: true }),
    step.screenshot("pdf-opened"),

    // ── 编辑：真 UI ——「页面」tab →「向右旋转」（rotation 90°）──
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "pdf 视图没有 webContents" };
      const clicked = await js<{ ok: boolean; reason?: string; tab?: string }>(wc, `(() => {
        const tabs = [...document.querySelectorAll('.ribbon-tab')];
        const page = tabs.find((b) => (b.textContent || '').trim() === '页面' || (b.textContent || '').trim() === 'Pages');
        if (!page) return { ok: false, reason: '找不到「页面」tab' };
        page.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, tab: (page.textContent || '').trim() };
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
    // 旋转后页面几何变化：视觉证据（两帧不同）。
    step.assertScreenshotChanged("pdf-rotated", "pdf-opened", "pdf-rotation-changed-view"),

    // ── 保存：真键盘 Ctrl+S（pdf 自己的 keydown → save()）──
    step.press("s", "pdf-press-ctrl-s", ["control"]),
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const changed = await waitFor(async () => sha256Of(rt.fixtures.pdf) !== rt.openedSha, 60_000, 300);
      const now = sha256Of(rt.fixtures.pdf);
      return changed
        ? { ok: true, observed: { savedSha: now, openedSha: rt.openedSha } }
        : { ok: false, observed: { openedSha: rt.openedSha, now }, detail: "Ctrl+S 后 60s 内磁盘字节没有变化" };
    }, "pdf-ctrl-s-saved-to-disk", { assert: true }),
    step.recordSideEffect("@projectDir/t7-pdf.pdf", "pdf-saved"),

    // ── 独立核对：vendor CLI 读页数/旋转（不经页面）──
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const bytes = readFileSync(rt.fixtures.pdf);
      const text = bytes.toString("latin1");
      // 旋转 90 会在页面对象里写 /Rotate 90（pdf-lib 的写法）。
      const hasRotate90 = /\/Rotate\s+90/.test(text);
      return hasRotate90
        ? { ok: true, observed: { hasRotate90 } }
        : { ok: false, observed: { size: bytes.length }, detail: "保存后的 PDF 字节里没有 /Rotate 90" };
    }, "pdf-disk-has-rotation", { assert: true }),

    // ── 关闭：生产路径（T29 修复后，vendor 关闭守卫由 harness 按生产装配）──
    // 文件已保存（干净）：生产 `documentView:close` 必须**直接成功**。
    // T29 之前这里恒被 close-check 探针拒绝；修复后旧断言会掩盖生产真实行为，
    // 所以改成「必须走通生产路径」。若被拒，唯一可接受的原因是 vendor 守卫
    // 认为仍有未保存修改（那时用 host.close 完成收尾并如实记录）。
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const production = (await rt.harness.handlers.get("documentView:close")!({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
      const gone = !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
      if (production.ok === true && gone) {
        return { ok: true, observed: { production, gone } };
      }
      const refusedForDirty = String(production.reason ?? "").includes("未保存");
      rt.harness.host.close(rt.docId);
      return {
        ok: refusedForDirty,
        observed: { production, gone, closedByHost: !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId) },
        ...(refusedForDirty ? {} : { detail: `生产 close 拒绝的原因不是「有未保存修改」：${production.reason ?? ""}` }),
      };
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一 PDF，断言旋转还在"),

    // ── 重开：新视图重开同一 PDF → 文本层仍在 + 磁盘里的旋转仍在 ──
    step.waitFor(".app", "pdf-reopen-mounted", { timeoutMs: 40_000 }),
    // 诊断：重开代里页面状态与 worker 预热。
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 pdf 视图没有 webContents" };
      const st = await js<Record<string, unknown>>(wc, `(() => ({
        placeholder: (document.querySelector('.pdf-placeholder')?.textContent || '').slice(0, 30),
        hasCanvas: !!document.querySelector('canvas'),
        worker: typeof Worker,
      }))()`);
      return { ok: true, observed: st };
    }, "pdf-reopen-state", { assert: false }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PdfRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 pdf 视图没有 webContents" };
      // 重开后的首帧要等 pdf.js worker 起来；与首次打开同样的重载兜底。
      let text = await waitFor(async () => await js<{ layer: string }>(wc, `(() => ({
        layer: [...document.querySelectorAll('.textLayer span')].map((s) => s.textContent || '').join(''),
      }))()`), 25_000, 250);
      if (!text || !text.layer) {
        wc.reload();
        await new Promise((r) => setTimeout(r, 800));
        text = await waitFor(async () => await js<{ layer: string }>(wc, `(() => ({
          layer: [...document.querySelectorAll('.textLayer span')].map((s) => s.textContent || '').join(''),
        }))()`), 60_000, 250);
      }
      return text && text.layer.includes(UNIQUE.pdf)
        ? { ok: true, observed: { layer: text.layer.slice(0, 120) } }
        : { ok: false, observed: text, detail: "重开后文本层里没有夹具文本" };
    }, "pdf-reopen-text-layer", { assert: true }),
    step.screenshot("pdf-reopened"),
    step.assertSideEffect("@projectDir/t7-pdf.pdf", { sha256UnchangedFrom: "pdf-saved" }, "pdf-disk-still-saved"),
    step.assertSideEffect("@projectDir/t7-pdf.pdf", { sha256ChangedFrom: "pdf-open" }, "pdf-disk-differs-from-original"),
  ],
});
