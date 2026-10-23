/**
 * T29 U1 旅程 —— **原厂四编辑器（pdf / markdown / html / sheets）的标签真的能关**。
 *
 * ## 为什么必须真 Electron
 *
 * `documentView:close` 的脏判断与「保存 > 放弃 > 取消」流程长在 **vendor 主进程**
 * （`dirtyByWc` / `pendingEditCounts` + `request*Close`），页面侧的 `setDirty`
 * 上报只有真 preload + 真渲染进程才会发生。无头套件验证的是宿主的转发与
 * fail-closed 形态；**「用户点关闭，标签真的消失」**只有这里能验。
 *
 * ## 它钉什么（与 T29 卡判据逐条对应）
 *
 * 1. **四个编辑器逐个**：干净时生产 `documentView:close`（`closeWithDirtyProtection`）
 *    必须成功、视图真的从宿主表里消失；关闭前文件字节**不变**（干净关闭不重写）。
 * 2. **未保存状态确实被保护**：在页面里制造脏状态（markdown 走真 ProseMirror
 *    编辑事务；其它三家经页面自己的 preload 上报 —— 与用户编辑时页面做的事
 *    同一个通道），此时关闭必须**拒绝**（vendor 守卫返回 false），视图保留。
 * 3. **关闭走的是 vendor 的守卫**：拒绝原因来自 Mcode 宿主（「未保存」），
 *    且此时视图与会话都还在 —— 不静默丢改动。
 * 4. **修复前必红**：把 `closeWithDirtyProtection` 的 vendor 分支撤掉后，第 1 步
 *    会看到旧缺陷原文（「无法查询编辑器未保存状态」）。变异验证由
 *    `mutate-t29.mjs` 执行（改源码 → 跑本旅程 → cmp 还原）。
 *
 * ## 与 T7 六编辑器旅程的关系
 *
 * 复用 T7 的 `editorSetup(kind)` 装配（同一份 harness + 生产 `DocumentViewHost`
 * 单例 + 真 vendor 视图工厂）。T7 的旅程为了绕开本缺陷先断言拒绝、再用
 * `host.close` 后门关闭；本套件是**修复后**的生产路径，不再使用那个后门。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, js, sha256Of, waitFor } from "../../t7-genoffice-u1/editor-flow.js";
import type { GenofficeHarness } from "../../t7-genoffice-u1/harness.js";
import type { FixturePaths } from "../../t7-genoffice-u1/fixtures.js";

type Kind = "pdf" | "markdown" | "html" | "sheets";

interface CloseRun {
  harness: GenofficeHarness;
  fixtures: FixturePaths;
  docId: string;
  webContentsId: number;
  openedSha: string;
  /** T29 注册表注入的确定性消息框端口（记录 vendor 关闭守卫弹过哪些框）。 */
  dialog: import("../dialog-port.js").DialogPort;
}

const KINDS: readonly Kind[] = ["pdf", "markdown", "html", "sheets"] as const;

/** 每个编辑器「页面自己上报脏状态」的通道（vendor preload 与主进程之间的真实
 *  通道名；与用户编辑时页面调用的是同一个）。pages 的 dirty 报告都是单向 send。 */
const DIRTY_CHANNELS: Record<Kind, string> = {
  pdf: "pdf:dirty-changed",
  markdown: "markdown:dirty-changed",
  html: "html:dirty-changed",
  sheets: "workbook:pending-edits",
};

/**
 * 四条旅程共用的「关闭语义」步骤序列。每个 kind 单独一条 journey（T7 的注册表
 * 也是 per-editor），因为 `launch.setup` 必须绑定编辑器类型。
 */
function closeJourney(kind: Kind) {
  const name = `t29-close-${kind}-after-unsaved-guard`;
  return defineU1Journey({
    name,
    launch: {
      window: false,
      size: { width: 1280, height: 900 },
      defaultTimeoutMs: 40_000,
      setup: editorSetup(kind) as never,
      assertions: { dom: true, visual: true, sideEffect: true },
    },
    steps: [
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        rt.openedSha = sha256Of(rt.fixtures[kind]);
        return { ok: true, observed: { sha256: rt.openedSha, docId: rt.docId, wcId: rt.webContentsId } };
      }, `record-opened-${kind}`),
      step.recordSideEffect(`@projectDir/${fixtureName(kind)}`, `${kind}-open`),

      // ── 1. 干净视图：生产 close 必须成功（修复前：永远 2s 超时拒绝） ──
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        const wc = rt.harness.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
        const reply = (await rt.harness.handlers.get("documentView:close")!(
          { sender: wc }, { docId: rt.docId },
        )) as { ok?: boolean; reason?: string };
        const gone = !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
        // `webContents.close()` 的销毁是异步的：有界等它真的死掉（不是「从宿主表
        // 摘掉就算」—— 那可能留下没销毁的原生页面）。
        const destroyed = await waitFor(async () => (wc.isDestroyed() ? true : null), 5_000, 100);
        return reply.ok === true && gone && destroyed === true
          ? { ok: true, observed: { reply, gone, webContentsDestroyed: true } }
          : {
              ok: false,
              observed: { reply, gone, webContentsDestroyed: destroyed === true },
              detail: reply.reason ?? (gone ? "关闭后 webContents 未销毁" : "关闭后视图仍在宿主表里"),
            };
      }, "clean-close-succeeds", { assert: true }),
      step.recordSideEffect(`@projectDir/${fixtureName(kind)}`, `${kind}-after-clean-close`),
      // 干净关闭 = 不重写文档：字节必须与打开时完全一致。
      step.assertSideEffect(`@projectDir/${fixtureName(kind)}`, { sha256UnchangedFrom: `${kind}-open` }, "clean-close-does-not-rewrite"),

      // ── 2. 重开同一文件（新 docId 一代），制造未保存状态 ──
      //   relaunch 让新进程重新装视图；host 的会话表在 dispose 时清空，
      //   同一路径可以重新打开。
      step.relaunch(`reopen-${kind}-for-dirty`, "重开进程，回到同一文件并制造未保存修改"),
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        const wc = rt.harness.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "重开后视图没有 webContents" };
        // 等页面就绪：不同编辑器的就绪标记与 T7 editor-flow 相同。
        const ready = await waitFor(async () => {
          if (wc.isDestroyed()) return false;
          return await js<boolean>(wc, `(() => ({
            sheets: !!document.querySelector('#univer-container'),
            pdf: !!document.querySelector('.app, .pdf-placeholder'),
            markdown: !!document.querySelector('.doc-editor, .app'),
            html: !!document.querySelector('.cm-editor, .app'),
          })["${kind}"] ?? null)()`);
        }, 40_000, 250);
        return ready === true
          ? { ok: true, observed: { docId: rt.docId, wcId: wc.id } }
          : { ok: false, detail: `重开后 40s 内 ${kind} 编辑器页没有就绪` };
      }, "dirty-reopen-page-ready", { assert: true }),

      // ── 3. 在页面里制造未保存修改（每个编辑器走它自己的真实路径） ──
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        const wc = rt.harness.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "视图没有 webContents" };
        if (kind === "markdown") {
          // 真 ProseMirror 事务（与 T7 markdown 旅程同一条 `insertContent`）。
          const edited = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
            const pm = document.querySelector('.doc-editor.ProseMirror') ?? document.querySelector('.ProseMirror');
            const editor = pm && pm.editor;
            if (!editor) return { ok: false, reason: 'Tiptap editor handle 不可用' };
            pm.focus();
            editor.commands.insertContent('T29-UNSAVED-EDIT');
            return { ok: true };
          })()`);
          if (!edited.ok) return { ok: false, observed: edited, detail: edited.reason };
          // 页面自己的 dirty 上报（真实 UI 编辑后 React effect 会做同一件事；
          // 这里等它发生，等不到才补发 —— 补发用的是页面同一个 preload 通道）。
          const reported = await waitFor(async () => {
            const res = await js<{ dirty: boolean }>(wc, `(() => {
              const btns = [...document.querySelectorAll('button')];
              return { dirty: !!document.querySelector('[data-dirty="true"]') || btns.some((b) => /保存|Save/.test(b.textContent || '') && !b.hasAttribute('disabled')) };
            })()`);
            return res.dirty ? res : null;
          }, 3_000, 150);
          if (!reported) {
            // 页面没有可读的脏标记：经它自己的 preload 通道上报一次（与用户
            // 编辑时页面调用的是同一个 `setDirty`）。
            await js(wc, `window.markdownApi.setDirty(true)`);
          }
          return { ok: true, observed: { editorEdit: edited, uiDirtyObserved: reported !== null } };
        }
        if (kind === "pdf") {
          // 真 UI：页面 tab → 向右旋转（与 T7 pdf 旅程同一条 `applyEditOps`）。
          const rotated = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
            const tabs = [...document.querySelectorAll('.ribbon-tab')];
            const page = tabs.find((b) => (b.textContent || '').trim() === '页面' || (b.textContent || '').trim() === 'Pages');
            if (!page) return { ok: false, reason: '找不到「页面」tab' };
            page.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { ok: true };
          })()`);
          if (!rotated.ok) return { ok: false, observed: rotated, detail: rotated.reason };
          await new Promise((r) => setTimeout(r, 400));
          const applied = await js<{ ok: boolean; reason?: string; edited?: boolean }>(wc, `(() => {
            const bs = [...document.querySelectorAll('button.rb-big')];
            const right = bs.find((b) => /向右旋转|Rotate right/.test(b.textContent || ''));
            if (!right) return { ok: false, reason: '找不到「向右旋转」按钮' };
            if (right.hasAttribute('disabled')) return { ok: false, reason: '「向右旋转」按钮 disabled' };
            right.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { ok: true };
          })()`);
          return applied.ok
            ? { ok: true, observed: applied }
            : { ok: false, observed: applied, detail: applied.reason };
        }
        // html / sheets：页面自身的编辑入口需要复杂的 UI 手势（T7 里用真键鼠
        // 驱动）。关闭守卫判断的是 **vendor 主进程的 dirty 记录**，而页面上报
        // 它的通道与用户编辑后调用的是同一个（`htmlApi.setDirty` /
        // `desktopApi.notifyPendingEdits`）。这里直接经页面自己的 preload 上报，
        // 与「用户刚编辑过」在 vendor 侧的可见状态一致。
        if (kind === "html") {
          await js(wc, `window.htmlApi.setDirty(true)`);
          return { ok: true, observed: { reportedVia: "window.htmlApi.setDirty(true)" } };
        }
        await js(wc, `window.desktopApi.notifyPendingEdits(1)`);
        return { ok: true, observed: { reportedVia: "window.desktopApi.notifyPendingEdits(1)" } };
      }, "make-unsaved-edit", { assert: true }),

      // ── 4. 脏视图：生产 close 必须**拒绝**，且视图/会话保留（不静默丢改动） ──
      //   往返之前把消息框端口设成「取消」（2）—— 与产品默认取向一致：没人
      //   明确放弃，就不丢用户的修改。
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        const wc = rt.harness.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "关闭前视图已消失（脏状态没保住视图）" };
        rt.dialog.reset();
        rt.dialog.respondWith(2); // 「取消」
        const reply = (await rt.harness.handlers.get("documentView:close")!(
          { sender: wc }, { docId: rt.docId },
        )) as { ok?: boolean; reason?: string };
        const stillThere = rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
        const sessionStillHeld = rt.harness.host.sessionFor(rt.docId) !== null;
        // vendor 守卫必须先**弹过三选一**（保存 / 放弃 / 取消）再拒绝 ——
        // 没有弹窗的「拒绝」意味着用户根本不知道发生了什么。
        const prompts = [...rt.dialog.calls];
        const prompted = prompts.length === 1 && prompts[0]!.buttons.length === 3;
        return reply.ok === false && stillThere && sessionStillHeld && prompted
          ? { ok: true, observed: { reply, stillThere, sessionStillHeld, prompts } }
          : {
              ok: false,
              observed: { reply, stillThere, sessionStillHeld, prompts },
              detail: !prompted
                ? `未保存状态下的关闭没有弹出 保存/放弃/取消 确认（弹窗=${prompts.length} 次）`
                : "脏视图的关闭没有被拒绝，或视图/会话已被销毁（未保存修改会丢失）",
            };
      }, "dirty-close-refused", { assert: true }),
      // 磁盘字节没有被偷偷写回（拒绝关闭 = 没有静默保存）。
      step.assertSideEffect(`@projectDir/${fixtureName(kind)}`, { sha256UnchangedFrom: `${kind}-after-clean-close` }, "dirty-close-does-not-silently-save"),

      // ── 5. 脏视图 + 用户选「放弃修改」：vendor 返回 true → 宿主真的关闭 ──
      //   这是用户真实的第二条路（不保存、明确放弃）。比「先把 dirty 清掉再关」
      //   更贴近产品语义，也证明守卫的 true 分支真的走到销毁。
      step.run(async ({ runtime }) => {
        const rt = runtime as CloseRun;
        const wc = rt.harness.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "关闭前视图已消失（脏状态没保住视图）" };
        rt.dialog.reset();
        rt.dialog.respondWith(1); // 「不保存 / 放弃修改」
        const reply = (await rt.harness.handlers.get("documentView:close")!(
          { sender: wc }, { docId: rt.docId },
        )) as { ok?: boolean; reason?: string };
        const gone = !rt.harness.host.list().some((v: { docId: string }) => v.docId === rt.docId);
        const prompts = [...rt.dialog.calls];
        return reply.ok === true && gone && prompts.length === 1
          ? { ok: true, observed: { reply, gone, prompts } }
          : {
              ok: false,
              observed: { reply, gone, prompts },
              detail: reply.reason ?? "用户选择放弃修改后，视图仍未关闭",
            };
      }, "dirty-discard-close-succeeds", { assert: true }),
      step.recordSideEffect(`@projectDir/${fixtureName(kind)}`, `${kind}-after-all`),
      step.assertSideEffect(`@projectDir/${fixtureName(kind)}`, { sha256UnchangedFrom: `${kind}-open` }, "final-bytes-unchanged"),
    ],
  });
}

function fixtureName(kind: Kind): string {
  return { pdf: "t7-pdf.pdf", markdown: "t7-markdown.md", html: "t7-html.html", sheets: "t7-sheets.xlsx" }[kind];
}

export const t29Journeys = KINDS.map((kind) => closeJourney(kind));
