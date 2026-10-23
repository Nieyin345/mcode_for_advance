/**
 * T7 旅程 6 —— HTML（.html）：打开 → 断言内容 → 编辑 → 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 生产链
 *
 *  - 页面：vendor html 真构建产物（CodeMirror 6 源码编辑 + 预览 iframe）；
 *  - preload：vendor `apps/html/out/preload/index.js`（`window.htmlApi`）；
 *  - 打开：`createHtmlView(path)` → `grantAndTrack(wc, path)` → 页面首帧
 *    `consumePending()` 拿路径 → `readFile` 只读被授权路径；
 *  - 内容断言：CodeMirror 的 `.cm-content` 里出现夹具的唯一文本（源码模式
 *    默认打开，`canvasMode === 'edit'`）；
 *  - 编辑：**真键入** —— 选中源码里的唯一文本并替换（CodeMirror 的
 *    `view.dispatch` 与用户键入同一条 transaction；页面把 CM view 暴露在
 *    `editorRef`，但没有全局句柄，所以用 DOM 的 `cm-content` + 原生 selection
 *    再 `insertText` 不太稳；这里用 `document.execCommand('insertText')`
 *    等价路径不可靠 —— 改用**页面内的 CM DOM 事件**：聚焦 `.cm-content`，
 *    `insertText` 真输入栈）。
 *  - 保存：**真键盘 Ctrl+S**（html 页面的 keydown → `doSave('save')`）→
 *    `window.htmlApi.save` → vendor `atomicWriteFile`；
 *  - 关闭：生产 `documentView:close`（html 属于 close-check 缺陷那一组）；
 *  - 重开：真 OS 重开 → 新视图重开同一文件 → CodeMirror 里文本与磁盘一致。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { editorSetup, js, sha256Of, waitFor } from "../editor-flow.js";
import type { FixturePaths } from "../fixtures.js";

const EDITED = `${UNIQUE.html}-EDITED`;
interface HtmlRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
}

export const htmlJourney = defineU1Journey({
  name: "html-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: editorSetup("html") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      rt.openedSha = sha256Of(rt.fixtures.html);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-html.html", "html-open"),

    // ── 内容断言：CodeMirror 源码里的夹具文本 ──
    // `.cm-content` 在 html 页里可能 `getClientRects()` 为 0（CodeMirror 的
    // contenteditable 在布局完成前没有 box），runner 的可见性探针会判「不存在」。
    // 用 `assertEvaluated` 直接读 textContent（DOM 事实，不依赖可见性）。
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const inDom = await waitFor(async () => await js<boolean>(wc, "!!document.querySelector('.cm-content')"), 40_000, 200);
      return inDom ? { ok: true } : { ok: false, detail: "40s 内 .cm-content 没有进入 DOM" };
    }, "html-editor-in-dom", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const seen = await waitFor(async () => {
        const t = await js<string>(wc, "document.querySelector('.cm-content')?.textContent ?? ''");
        return t && t.includes(UNIQUE.html) ? { text: t } : null;
      }, 30_000, 250);
      return seen
        ? { ok: true, observed: { text: seen.text.slice(0, 200) } }
        : { ok: false, detail: "30s 内 CodeMirror 源码里没有夹具文本" };
    }, "html-dom-has-unique-text", { assert: true }),
    step.screenshot("html-opened"),

    // ── 编辑：**真键入**（CodeMirror 编辑器聚焦后 `insertText` 走真输入栈）──
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      // 页面默认是「可视化预览」模式，源码面板隐藏（`.cm-content` 无矩形）。
      // 先点工具栏的**「源码」**按钮（真实 UI）切到源码模式；再点源码面板
      // 聚焦 CodeMirror（pointerdown 会把焦点交给 contentDOM）。
      const switched = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const bs = [...document.querySelectorAll('button')];
        const src = bs.find((b) => /^(源码|Source)$/.test((b.textContent || '').trim()));
        if (!src) return { ok: false, reason: '找不到「源码」按钮' };
        src.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      })()`);
      if (!switched.ok) return switched;
      await new Promise((r) => setTimeout(r, 400));
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
      if (!focused) return { ok: false, observed: { pt }, detail: "点击源码面板后 CodeMirror 没有获得焦点" };
      // 全选后替换：CM 的真键盘全选（Ctrl+A）+ insertText。
      wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: ["control"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: ["control"] });
      await new Promise((r) => setTimeout(r, 120));
      wc.insertText(`<!doctype html><html><head><meta charset="utf-8"><title>T7 HTML</title></head><body><h1>T7 HTML</h1><p>${EDITED}</p></body></html>`);
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, observed: { typed: EDITED } };
    }, "html-type-edit", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "html 视图没有 webContents" };
      const seen = await waitFor(async () => {
        const t = await js<string>(wc, "document.querySelector('.cm-content')?.textContent ?? ''");
        return t && t.includes(EDITED) ? { text: t } : null;
      }, 20_000, 250);
      return seen ? { ok: true, observed: { text: seen.text.slice(0, 200) } } : { ok: false, detail: "20s 内源码里没有编辑文本" };
    }, "html-shows-edited-text", { assert: true }),
    step.screenshot("html-edited"),

    // ── 保存：真键盘 Ctrl+S（页面自己的 keydown → doSave('save')）──
    step.press("s", "html-press-ctrl-s", ["control"]),
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const changed = await waitFor(async () => sha256Of(rt.fixtures.html) !== rt.openedSha, 45_000, 250);
      const now = sha256Of(rt.fixtures.html);
      return changed
        ? { ok: true, observed: { savedSha: now, openedSha: rt.openedSha } }
        : { ok: false, observed: { openedSha: rt.openedSha, now }, detail: "Ctrl+S 后 45s 内磁盘字节没有变化" };
    }, "html-ctrl-s-saved-to-disk", { assert: true }),
    step.recordSideEffect("@projectDir/t7-html.html", "html-saved"),
    step.assertSideEffect("@projectDir/t7-html.html", { contains: EDITED }, "html-disk-has-edited-text"),

    // ── 关闭（html 属于 close-check 缺陷那一组）──
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const production = (await rt.harness.handlers.get("documentView:close")!({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
      if (production.ok === true) {
        return { ok: !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId), observed: { production, defect: null } };
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

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一 HTML，断言改动还在"),

    // ── 重开：新视图重开同一文件 → CM 源码里是编辑后的文本 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 html 视图没有 webContents" };
      const inDom = await waitFor(async () => await js<boolean>(wc, "!!document.querySelector('.cm-content')"), 40_000, 200);
      return inDom ? { ok: true } : { ok: false, detail: "重开后 40s 内 .cm-content 没有进入 DOM" };
    }, "html-reopen-mounted", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as HtmlRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 html 视图没有 webContents" };
      const seen = await waitFor(async () => {
        const t = await js<string>(wc, "document.querySelector('.cm-content')?.textContent ?? ''");
        return t && t.includes(EDITED) ? { text: t } : null;
      }, 30_000, 250);
      return seen
        ? { ok: true, observed: { text: seen.text.slice(0, 200) } }
        : { ok: false, detail: "重开后源码里没有编辑文本" };
    }, "html-reopen-edited-text-in-dom", { assert: true }),
    step.screenshot("html-reopened"),
    step.assertSideEffect("@projectDir/t7-html.html", { sha256UnchangedFrom: "html-saved" }, "html-disk-still-saved"),
    step.assertSideEffect("@projectDir/t7-html.html", { sha256ChangedFrom: "html-open" }, "html-disk-differs-from-original"),
  ],
});
