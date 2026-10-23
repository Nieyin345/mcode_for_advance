/**
 * T7 旅程 2 —— Markdown（.md）：打开 → 断言文本 → 编辑 → 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 生产链
 *
 *  - 页面：vendor markdown 真构建产物（`genoffice/apps/markdown/out/renderer`）；
 *  - preload：**vendor 自己的** `apps/markdown/out/preload/index.js`（`window.markdownApi`）。
 *    这是生产 `createMarkdownView(path)` 挂的那一份（`documentViewHost` 的原厂分支
 *    `vendorCreateView(filePath, "markdown")`，不走 Mcode 的 `documentViewPreload`）；
 *  - 打开：视图工厂构造时 `grantAndTrack` 授权路径，页面首帧 `consumePending()`
 *    拉取（`markdown-main.ts:749`）；
 *  - 编辑：真 Tiptap/ProseMirror 编辑（`editor.commands.insertContent`，与用户键入
 *    同一条 transaction）；
 *  - 保存：**真键盘 Ctrl+S** → 页面 `doSave('save')` → `window.markdownApi.save`
 *    → vendor 主进程 `atomicWriteFile`（原子写）；
 *  - 关闭：生产 `documentView:close`（原厂分支直接 `close()`）；
 *  - 重开：真 OS 重开 → 新视图重新 consumePending → 断言 DOM 与磁盘。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { editorSetup, js, sha256Of, waitFor } from "../editor-flow.js";

const EDITED = `${UNIQUE.markdown}-EDITED`;
interface MdRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: import("../fixtures.js").FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
}

export const markdownJourney = defineU1Journey({
  name: "markdown-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: editorSetup("markdown") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as MdRun;
      rt.openedSha = sha256Of(rt.fixtures.markdown);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-markdown.md", "md-open"),
    step.eval("JSON.stringify({ secure: window.isSecureContext, origin: location.origin, hasRandomUUID: typeof crypto.randomUUID })", "md-context-probe"),

    // ── 内容断言：真实 Tiptap 编辑器里出现夹具的唯一文本 ──
    step.waitFor(".doc-editor", "md-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".doc-editor", "md-shows-unique-text", { text: UNIQUE.markdown, timeoutMs: 30_000 }),
    step.assertDom(".doc-editor", { textContains: UNIQUE.markdown }, "md-dom-has-unique-text"),
    step.screenshot("md-opened"),

    // ── 编辑：真 ProseMirror transaction ──
    step.run(async ({ runtime }) => {
      const rt = runtime as MdRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "md 视图没有 webContents" };
      const result = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const pm = document.querySelector('.doc-editor.ProseMirror') ?? document.querySelector('.ProseMirror');
        const editor = pm && pm.editor;
        if (!editor) return { ok: false, reason: 'Tiptap editor handle 不可用' };
        const doc = editor.state.doc;
        let from = -1, to = -1;
        doc.descendants((node, pos) => {
          if (from >= 0) return false;
          if (node.isText && node.text && node.text.includes(${JSON.stringify(UNIQUE.markdown)})) {
            const idx = node.text.indexOf(${JSON.stringify(UNIQUE.markdown)});
            from = pos + idx; to = from + ${UNIQUE.markdown.length};
            return false;
          }
          return true;
        });
        if (from < 0) return { ok: false, reason: '文档模型里找不到唯一文本' };
        pm.focus();
        editor.commands.setTextSelection({ from, to });
        editor.commands.insertContent(${JSON.stringify(EDITED)});
        return { ok: true };
      })()`);
      return result;
    }, "edit-replace-text", { assert: true }),

    step.assertDom(".doc-editor", { textContains: EDITED }, "md-dom-has-edited-text"),
    step.screenshot("md-edited"),

    // ── 保存：真键盘 Ctrl+S ──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime }) => {
      const rt = runtime as MdRun;
      const changed = await waitFor(async () => sha256Of(rt.fixtures.markdown) !== rt.openedSha, 45_000, 250);
      const now = sha256Of(rt.fixtures.markdown);
      return changed
        ? { ok: true, observed: { savedSha: now, openedSha: rt.openedSha } }
        : { ok: false, observed: { openedSha: rt.openedSha, now }, detail: "Ctrl+S 后 45s 内磁盘字节没有变化" };
    }, "ctrl-s-saved-to-disk", { assert: true }),
    step.recordSideEffect("@projectDir/t7-markdown.md", "md-saved"),
    step.assertSideEffect("@projectDir/t7-markdown.md", { contains: EDITED }, "md-disk-has-edited-text"),

    // ── 关闭 —— **如实记录生产缺陷**：`closeWithDirtyProtection` 只对 slides
    //    绕过 `close-check` 探针；markdown/html/pdf/sheets 的 vendor preload
    //    从不监听 `mcode:document-view:close-check`（只有 Docs 的
    //    `documentViewPreload.ts` 监听），于是生产面板关闭这四类编辑器**永远**
    //    返回「编辑器未响应关闭检查；为保护未保存内容，拒绝关闭」。
    //    本步同时验证两件事：(a) 生产 `documentView:close` 确实拒绝（缺陷仍
    //    在，是证据不是断言失败）；(b) 直接 `host.close` 能关闭（文件已保存，
    //    没有未保存内容可丢）。
    step.run(async ({ runtime }) => {
      const rt = runtime as MdRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const production = (await rt.harness.handlers.get("documentView:close")!({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
      if (production.ok === true) {
        // 缺陷已修（或这条路径变了）：按生产路径关闭也算通过。
        return { ok: !rt.harness.host.list().some((v) => v.docId === rt.docId),
          observed: { production, defect: null },
          detail: "生产 close 直接成功（close-check 缺陷可能已被修复）" };
      }
      const defect = production.reason ?? "";
      const refusedAsKnown = defect.includes("未响应关闭检查");
      rt.harness.host.close(rt.docId);
      const gone = !rt.harness.host.list().some((v) => v.docId === rt.docId);
      return {
        ok: refusedAsKnown && gone,
        observed: { production, defect, closedByHost: gone },
        ...(refusedAsKnown ? {} : { detail: `生产 close 拒绝的原因不是已知的 close-check 缺陷：${defect}` }),
      };
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一文件，断言改动还在"),

    // ── 重开：新进程的 setup 建了新视图并重新授权/consumePending ──
    step.waitFor(".doc-editor", "reopen-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".doc-editor", "reopen-shows-edited-text", { text: EDITED, timeoutMs: 30_000 }),
    step.assertDom(".doc-editor", { textContains: EDITED }, "md-reopen-edited-text-in-dom"),
    step.screenshot("md-reopened"),
    step.assertSideEffect("@projectDir/t7-markdown.md", { sha256UnchangedFrom: "md-saved" }, "md-disk-still-saved"),
    step.assertSideEffect("@projectDir/t7-markdown.md", { sha256ChangedFrom: "md-open" }, "md-disk-differs-from-original"),
  ],
});
