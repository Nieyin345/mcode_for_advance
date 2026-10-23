/**
 * T7 旅程 1 —— Docs（.docx）：打开 → 断言文本 → 编辑 → 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 验的是生产哪条链
 *
 *  - 页面：vendor docs 真构建产物（`genoffice/apps/docs/out/renderer`，按 pinned HEAD 重建）；
 *  - preload：**Mcode 的生产** `documentViewPreload.js`（`documentViewPreload.ts` →
 *    vendor `mcode-view.ts`），由 `DocumentViewHost.resolveViewPreload()` 挂载；
 *  - 打开：`documentView:openPath`（生产 handler）→ `menu:command("open-path")` →
 *    页面 `openRecent` → preload `read-opened` → 一次性 handoff 字节 → 页面回执
 *    `open-committed` → 宿主提交会话；
 *  - 编辑：真 ProseMirror transaction（与用户键入同一条 `insertContent`）；
 *  - 保存：**真键盘 Ctrl+S**（`sendInputEvent`）→ 页面 `save()` →
 *    `buildDocBytes`（vendor 自己的 docx 序列化）→ `window.desktop.saveDocx`
 *    → 宿主 `saveOpenedFile`（租约 + CAS + 原子写）；
 *  - 关闭：生产 `documentView:close`（`closeWithDirtyProtection`）；
 *  - 重开：**真 OS 重开**（`relaunch`），新进程新 Host/DB，重新打开同一文件，
 *    断言 DOM 里是编辑后的文本、磁盘 sha256 不变。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { editorSetup, invokeAs, js, sha256Of, waitFor } from "../editor-flow.js";

const EDITED = `${UNIQUE.docs}-EDITED`;
/** 旅程运行时状态（`setup` 返回的 `runtime`，这里只加字段）。 */
interface DocsRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: import("../fixtures.js").FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
  savedSha: string;
  openedText: string;
  saveWaitedMs: number;
}

export const docsJourney = defineU1Journey({
  name: "docs-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: editorSetup("docs") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      rt.openedSha = sha256Of(rt.fixtures.docs);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-docs.docx", "docs-open"),

    // ── 打开链：生产 openPath + 页面回执 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "docs 视图没有 webContents" };
      // 探针：页面挂载后的桥与状态（失败时这一行就是全部线索）。
      const probe = await js<Record<string, unknown>>(wc, `(() => {
        const d = window.desktop;
        return {
          readyState: document.readyState,
          hasDesktop: typeof d === 'object' && d !== null,
          hasOpenDocxPath: typeof d?.openDocxPath === 'function',
          hasConfirmReplace: typeof d?.confirmDocumentReplace === 'function',
          hasOnMenuCommand: typeof d?.onMenuCommand === 'function',
          hasGetRecentFiles: typeof d?.getRecentFiles === 'function',
          pm: !!document.querySelector('.ProseMirror'),
          bodyText: (document.body?.innerText ?? '').slice(0, 120),
        };
      })()`);
      if (probe.hasOpenDocxPath !== true || probe.hasOnMenuCommand !== true) {
        return { ok: false, observed: probe, detail: "docs 页面的 preload 桥不完整" };
      }
      const reply = (await invokeAs(wc, rt.harness, "documentView:openPath", {
        docId: rt.docId,
        filePath: rt.fixtures.docs,
      })) as { ok?: boolean; reason?: string };
      if (reply.ok !== true) return { ok: false, observed: { probe, reply }, detail: `openPath 被拒: ${reply.reason}` };
      const session = await waitFor(async () => rt.harness.host.sessionFor(rt.docId), 30_000, 200);
      if (session) {
        return { ok: true, observed: { probe, filePath: session.filePath, revision: await session.revision } };
      }
      // 诊断：pendingOpen 还在（页面没回执）？页面 DOM 状态？
      const pending = rt.harness.host.pendingOpenFor(rt.docId);
      const lateProbe = await js<Record<string, unknown>>(wc, `(() => ({
        pm: !!document.querySelector('.ProseMirror'),
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        bodySlice: (document.body?.innerText ?? '').slice(0, 200),
      }))()`).catch(() => null);
      return {
        ok: false,
        observed: { probe, pending, lateProbe },
        detail: "docs 页面 30s 内没有提交打开会话（open-committed 未到）",
      };
    }, "open-path-committed", { assert: true }),

    // ── 内容断言：真实编辑器页 DOM 里出现夹具的唯一文本 ──
    step.waitFor(".ProseMirror", "docs-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".ProseMirror", "docs-shows-unique-text", { text: UNIQUE.docs, timeoutMs: 30_000 }),
    step.assertDom(".ProseMirror", { textContains: UNIQUE.docs }, "docs-dom-has-unique-text"),
    step.screenshot("docs-opened"),

    // ── 编辑：真 ProseMirror transaction ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "docs 视图没有 webContents" };
      rt.openedText = await js<string>(wc, "document.querySelector('.ProseMirror').innerText");
      const result = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
        const pm = document.querySelector('.ProseMirror');
        const editor = pm && pm.editor;
        if (!editor) return { ok: false, reason: 'ProseMirror editor handle 不可用' };
        const doc = editor.state.doc;
        let from = -1, to = -1;
        doc.descendants((node, pos) => {
          if (from >= 0) return false;
          if (node.isText && node.text && node.text.includes(${JSON.stringify(UNIQUE.docs)})) {
            const idx = node.text.indexOf(${JSON.stringify(UNIQUE.docs)});
            from = pos + idx; to = from + ${UNIQUE.docs.length};
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
      return { ...result, observed: { result, before: rt.openedText.slice(0, 160) } };
    }, "edit-replace-text", { assert: true }),

    step.assertDom(".ProseMirror", { textContains: EDITED }, "docs-dom-has-edited-text"),
    step.screenshot("docs-edited"),

    // ── 保存：真键盘 Ctrl+S（页面自己的保存入口）──
    step.press("s", "press-ctrl-s", ["control"]),
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const started = Date.now();
      const changed = await waitFor(async () => sha256Of(rt.fixtures.docs) !== rt.openedSha, 45_000, 250);
      rt.saveWaitedMs = Date.now() - started;
      rt.savedSha = sha256Of(rt.fixtures.docs);
      return changed
        ? { ok: true, observed: { savedSha: rt.savedSha, openedSha: rt.openedSha, waitedMs: rt.saveWaitedMs } }
        : { ok: false, observed: { openedSha: rt.openedSha, now: rt.savedSha }, detail: "Ctrl+S 后 45s 内磁盘字节没有变化" };
    }, "ctrl-s-saved-to-disk", { assert: true }),
    // 框架级的持久记录：`recordSideEffect` 的快照跨重开保存在 state.json 里
    //（`step.run` 的本地 runtime 字段在新进程里是空的）。
    step.recordSideEffect("@projectDir/t7-docs.docx", "docs-saved"),

    // ── 关闭：生产 documentView:close（closeWithDirtyProtection） ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const reply = (await invokeAs(wc, rt.harness, "documentView:close", { docId: rt.docId })) as { ok?: boolean; reason?: string };
      const gone = !rt.harness.host.list().some((v) => v.docId === rt.docId);
      return reply.ok === true && gone
        ? { ok: true, observed: { reply, gone } }
        : { ok: false, observed: { reply, gone }, detail: reply.reason ?? "关闭后视图仍在宿主表里" };
    }, "close-production-path", { assert: true }),

    // ── 真重开进程 ──
    step.relaunch("relaunch-after-close", "重开进程后重新打开同一文件，断言改动还在"),

    // ── 重开：新进程重建视图；再走一次生产打开链 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 docs 视图没有 webContents" };
      const reply = (await invokeAs(wc, rt.harness, "documentView:openPath", {
        docId: rt.docId,
        filePath: rt.fixtures.docs,
      })) as { ok?: boolean; reason?: string };
      if (reply.ok !== true) return { ok: false, observed: reply, detail: reply.reason };
      const session = await waitFor(async () => rt.harness.host.sessionFor(rt.docId), 30_000, 200);
      return session
        ? { ok: true, observed: { diskSha: sha256Of(rt.fixtures.docs) } }
        : { ok: false, detail: "重开后 30s 内没有提交打开会话" };
    }, "reopen-after-relaunch", { assert: true }),

    step.waitFor(".ProseMirror", "reopen-editor-mounted", { timeoutMs: 30_000 }),
    step.waitFor(".ProseMirror", "reopen-shows-edited-text", { text: EDITED, timeoutMs: 30_000 }),
    step.assertDom(".ProseMirror", { textContains: EDITED }, "docs-reopen-edited-text-in-dom"),
    step.screenshot("docs-reopened"),

    // ── 磁盘事实：重开后文件 sha256 仍是保存后的那一版（跨进程快照对比） ──
    step.assertSideEffect("@projectDir/t7-docs.docx", { sha256UnchangedFrom: "docs-saved", exists: true }, "docs-disk-still-saved"),
    // 补充：与「打开时的原始字节」必须不同（防止「保存没发生、重开也没变」假绿）。
    step.assertSideEffect("@projectDir/t7-docs.docx", { sha256ChangedFrom: "docs-open" }, "docs-disk-differs-from-original"),
  ],
});
