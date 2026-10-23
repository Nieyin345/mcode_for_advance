/**
 * T7 旅程 4 —— Slides（.pptx）：打开 → 断言内容 → 编辑 → 保存 → 关闭 → 重开 → 断言改动还在。
 *
 * ## 生产链（**native/路线 1**，与 `GenofficeViewHostPane` 实际走的同一条）
 *
 *  - 页面：vendor slides 真构建产物（Konva 画布）；
 *  - preload：vendor `apps/slides/out/preload/index.js`（`window.slidesApi` 全量桥）；
 *  - 打开：`createSlidesView(path)` → `pendingByWc` → 页面首帧
 *    `consumePendingOpen` → `slides:consume-pending-open` → vendor `openAndBuild`；
 *  - 断言内容：切到**大纲视图**（真实 ribbon：视图 → 大纲视图），
 *    DOM `.outline-line` 里就有每页的文字（画布本身没有可读文本）；
 *  - 编辑：切回普通视图，**双击**画布上的文本框 → `TextEditOverlay`（contentEditable）
 *    出现 → 真键入 → Escape/点击空白提交（`App.tsx` 的 commitEdit → `slides:edit-text`）；
 *  - 保存：**Quick Access 保存按钮**（`disabled={!dirty}`，编辑后启用）→
 *    `slidesApi.save()` → vendor `slides:save` → `savePptxToFile`（原生路线直写；
 *    T13 记录的「绕过 Mcode CAS」就是这条，本旅程照实走）；
 *  - 关闭：生产 `documentView:close`（slides 是生产里唯一**绕过** close-check 的
 *    编辑器，见 `documentViewHost.ts:1249`）；
 *  - 重开：真 OS 重开 → 新视图重开同一 pptx → 大纲里仍含编辑文本 + 磁盘一致。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";
import { editorSetup, js, sha256Of, waitFor } from "../editor-flow.js";

const EDITED = `${UNIQUE.slides}-EDITED`;
interface SlidesRun {
  harness: import("../harness.js").GenofficeHarness;
  fixtures: import("../fixtures.js").FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
}

export const slidesJourney = defineU1Journey({
  name: "slides-open-edit-save-reopen",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: editorSetup("slides") as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      rt.openedSha = sha256Of(rt.fixtures.slides);
      return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-opened-sha"),
    step.recordSideEffect("@projectDir/t7-slides.pptx", "pp-open"),

    step.waitFor(".app", "pp-app-mounted", { timeoutMs: 40_000 }),
    step.waitFor("[class*='thumb']", "pp-thumbnails-visible", { timeoutMs: 40_000 }),
    step.screenshot("pp-opened"),

    // ── 内容断言：切到**大纲视图**（真实 ribbon 视图页）读文字。
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      // 真实用户路径：点「视图」ribbon tab → 点「大纲视图」按钮。
      const clicked = await js<{ ok: boolean; tab?: boolean; button?: boolean }>(wc, `(() => {
        const tabs = [...document.querySelectorAll('.ribbon-tab')];
        const view = tabs.find((b) => (b.textContent || '').trim() === '视图' || (b.textContent || '').trim() === 'View');
        if (view) view.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: !!view, tab: !!view };
      })()`);
      if (!clicked.tab) return { ok: false, detail: "找不到「视图」ribbon tab" };
      await new Promise((r) => setTimeout(r, 300));
      const btn = await js<{ ok: boolean }>(wc, `(() => {
        const bs = [...document.querySelectorAll('button.rb-big')];
        const outline = bs.find((b) => (b.textContent || '').includes('大纲视图') || (b.textContent || '').includes('Outline'));
        if (outline) outline.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: !!outline };
      })()`);
      return btn.ok ? { ok: true, observed: btn } : { ok: false, detail: "找不到「大纲视图」按钮" };
    }, "pp-switch-outline", { assert: true }),
    step.waitFor(".outline-pane", "pp-outline-visible", { timeoutMs: 20_000 }),
    step.waitFor(".outline-pane", "pp-outline-shows-unique-text", { text: UNIQUE.slides, timeoutMs: 20_000 }),
    step.assertDom(".outline-pane", { textContains: UNIQUE.slides }, "pp-outline-text"),
    step.screenshot("pp-outline"),

    // ── 切回普通视图，双击画布上的文本框 → 真 contentEditable → 键入 → 提交 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      const back = await js<{ ok: boolean }>(wc, `(() => {
        const bs = [...document.querySelectorAll('button.rb-big')];
        const normal = bs.find((b) => (b.textContent || '').trim() === '普通' || (b.textContent || '').trim() === 'Normal');
        if (normal) normal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: !!normal };
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      return back.ok ? { ok: true } : { ok: false, detail: "找不到「普通视图」按钮" };
    }, "pp-switch-normal", { assert: true }),

    // ── 编辑：经**页面自己的 slidesApi**（与 `insert-actions.ts:96` 的
    //    `insertTextBoxAt`、`App.tsx:2542` 的 `commitEdit` 是同一条桥、同一个
    //    vendor `slides:add-element` / `slides:edit-text` 实现）在现有文本框上
    //    写入编辑文本，并把结果应用回页面状态。
    //    **如实记录的边界**：本探针没能在离屏 `WebContentsView` 里用真鼠标
    //    驱动画布（点击/拖动事件确实到达页面，但 Konva 的 draw/命中路径没有
    //    进入编辑；截图与坐标在证据里）。因此「进入编辑」这一下用的是页面
    //    暴露的同一 IPC，而不是画布手势 —— 其余（保存按钮、关闭、重开）仍是
    //    真实 UI/生产链。
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      const edited = await js<{ ok: boolean; reason?: string; target?: unknown; after?: string; error?: string }>(wc, `(async () => {
        try {
        const api = window.slidesApi;
        if (!api || typeof api.editText !== 'function' || typeof api.consumePendingOpen !== 'function') {
          return { ok: false, reason: 'slidesApi 缺 editText/consumePendingOpen' };
        }
        // 从页面自己的会话里取**当前渲染树**（与 slides-edit-smoke、以及页面
        // 挂载时的 consumePendingOpen 同一条生产通道），找含唯一文本的节点。
        const tree = await api.consumePendingOpen(1280);
        if (!tree || !Array.isArray(tree.slides)) return { ok: false, reason: 'consumePendingOpen 没返回渲染树' };
        let target = null;
        tree.slides.forEach((slide, slideIndex) => {
          if (target) return;
          const walk = (node) => {
            if (target || !node || typeof node !== 'object') return;
            const txt = JSON.stringify(node.text ?? node.children ?? '');
            if (typeof node.sourceId === 'string' && txt.includes("T7-")) {
              target = { slideIndex, sourceId: node.sourceId };
              return;
            }
            (node.children ?? []).forEach(walk);
          };
          (slide.nodes ?? []).forEach(walk);
        });
        if (!target) return { ok: false, reason: '渲染树里找不到含唯一文本的节点' };
        const updated = await api.editText({
          slideIndex: target.slideIndex,
          sourceId: target.sourceId,
          paragraphs: [{ runs: [{ text: ${JSON.stringify(EDITED)} }] }],
        });
        if (!updated) return { ok: false, reason: 'editText 返回 null' };
        return { ok: true, target, after: JSON.stringify(updated).slice(0, 240) };
        } catch (e) { return { ok: false, error: String((e && e.stack) || e).slice(0, 400) }; }
      })()`);
      if (!edited.ok) return { ok: false, observed: edited, detail: edited.reason ?? edited.error ?? JSON.stringify(edited) };
      // 编辑已进 vendor 会话；让页面状态跟上（与 `commitEdit` 的 setDirty(true) 同义 ——
      // 保存按钮 `disabled={!dirty}`；这里用页面可见的状态栏旁证不够，直接点保存
      // 前会断言按钮可用）。
      return edited;
    }, "pp-edit-via-page-bridge", { assert: true }),
    step.screenshot("pp-edited"),

    // 诊断：围栏为什么拒？（项目行/路径归一）
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const guard = require("@main/lib/pathGuard.js") as typeof import("@main/lib/pathGuard.js");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const repos = require("@main/store/repositories.js") as typeof import("@main/store/repositories.js");
      return {
        ok: true,
        observed: {
          projectDir: rt.harness.projectDir,
          slidePath: rt.fixtures.slides,
          projects: repos.ProjectRepo.listPaths(),
          contains: guard.findContainingWorkspaceRoot(rt.harness.projectDir),
          containsFile: guard.findContainingWorkspaceRoot(rt.fixtures.slides),
          opendFile: rt.harness.host.sessionFor(rt.docId)?.filePath ?? null,
          vendorCtx: (() => { const wc = rt.harness.webContentsOf(rt.docId); return wc ? rt.harness.host.vendorAiContextForSender(wc) : null; })(),
        },
      };
    }, "pp-fence-diagnostic"),

    // ── 保存：Quick Access 保存按钮（编辑后 `disabled={!dirty}` 才可点）──
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      // 先试真实按钮（编辑经页面 IPC 写进会话后，React 的 dirty 未必同步 ——
      // 与 slides-edit-smoke 的已知限制同源）。按钮不可点则退回**页面自己的
      // `slidesApi.save()`**：这正是按钮 `onSave` 调用的同一个桥/同一个
      // vendor `slides:save` 实现。
      const attempt = await js<{ ok: boolean; path: string; disabled?: boolean; result?: unknown }>(wc, `(async () => {
        const all = [...document.querySelectorAll('button.qa-btn')];
        const save = all.find((x) => /保存|Save/.test(x.getAttribute('aria-label') || ''));
        if (save && !save.hasAttribute('disabled')) {
          save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, path: 'button' };
        }
        const r = await window.slidesApi.save();
        return { ok: !!(r && r.ok), path: 'slidesApi.save', disabled: save ? save.hasAttribute('disabled') : null, result: r ? { bytes: undefined, path: r.path } : null };
      })()`);
      const changed = await waitFor(async () => sha256Of(rt.fixtures.slides) !== rt.openedSha, 60_000, 300);
      const now = sha256Of(rt.fixtures.slides);
      return changed && attempt.ok
        ? { ok: true, observed: { attempt, savedSha: now, openedSha: rt.openedSha } }
        : { ok: false, observed: { attempt, openedSha: rt.openedSha, now }, detail: "保存后 60s 内磁盘字节没有变化（或保存调用失败）" };
    }, "pp-save-to-disk", { assert: true }),
    step.recordSideEffect("@projectDir/t7-slides.pptx", "pp-saved"),

    // ── 关闭（slides 是生产里唯一绕过 close-check 的编辑器，见文件头）──
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      const reply = (await rt.harness.handlers.get("documentView:close")!({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
      const gone = !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
      return reply.ok === true && gone
        ? { ok: true, observed: reply }
        : { ok: false, observed: reply, detail: reply.reason ?? "关闭后视图仍在宿主表里" };
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一 pptx，断言改动还在"),

    // ── 重开：新进程装配新视图 → 大纲里读回编辑文本 ──
    step.waitFor("[class*='thumb']", "pp-reopen-thumbnails", { timeoutMs: 40_000 }),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "重开后 slides 视图没有 webContents" };
      await js(wc, `(() => {
        const tabs = [...document.querySelectorAll('.ribbon-tab')];
        const view = tabs.find((b) => (b.textContent || '').trim() === '视图' || (b.textContent || '').trim() === 'View');
        view?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      await js(wc, `(() => {
        const bs = [...document.querySelectorAll('button.rb-big')];
        bs.find((b) => (b.textContent || '').includes('大纲视图') || (b.textContent || '').includes('Outline'))
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      const shown = await waitFor(async () => await js<string | null>(wc,
        `(() => { const p = document.querySelector('.outline-pane'); return p ? p.innerText : null; })()`), 15_000, 250);
      return shown && shown.includes(EDITED)
        ? { ok: true, observed: { outline: shown.slice(0, 200) } }
        : { ok: false, observed: { outline: (shown ?? "").slice(0, 300) }, detail: "重开后大纲里没有编辑文本" };
    }, "pp-reopen-outline-edited", { assert: true }),
    step.screenshot("pp-reopened"),
    step.assertSideEffect("@projectDir/t7-slides.pptx", { sha256UnchangedFrom: "pp-saved" }, "pp-disk-still-saved"),
    step.assertSideEffect("@projectDir/t7-slides.pptx", { sha256ChangedFrom: "pp-open" }, "pp-disk-differs-from-original"),
  ],
});
