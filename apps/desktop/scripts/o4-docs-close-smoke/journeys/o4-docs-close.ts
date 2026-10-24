/**
 * O4 —— 主判据旅程：**生产装配路径上，打开 docs → 关闭 → 必须成功**。
 *
 * ## 这条旅程为什么必须在真 Electron 里跑
 *
 * 缺陷的形态是「页面的回答落在无人监听的通道 → 宿主 2 秒超时 → fail-closed 拒绝」。
 * 只有真 preload（`documentViewPreload.ts` → vendor `mcode-view.ts` 的
 * `docs:close-check-result → mcode:document-view:close-check-result` 映射）、
 * 真 vendor 页面（`App.tsx:5337` 订阅 `onCloseCheck` 并回 `reportCloseCheck`）、
 * 真 `ipcRenderer.send` 三件东西同时在位时，这条链才存在。fake ipc 验不了它 ——
 * T7 就是因此漏掉的（它用裸 `ipcMain` 做 recordingIpc，自带 `.on`，缺陷被掩盖）。
 *
 * ## 判据（与卡 2.1 / §三 对应）
 *
 *  1. `open-path-committed`：经生产 `documentView:openPath` 打开夹具，页面回执，
 *     会话提交 —— 先证明「文档真的开在屏幕上了」，关闭判据才有意义。
 *  2. `close-succeeds-within-2s`：**生产 `documentView:close`**（与渲染端
 *     `window.api.documentView.close` 同一函数对象）在 **2 秒**内返回 `ok:true`，
 *     视图从宿主表消失、webContents 真的销毁。修复前这里必红：2 秒超时 +
 *     `编辑器未响应关闭检查；为保护未保存内容，拒绝关闭`。
 *  3. `page-answered-close-check`：页面确实回了（主进程侧诊断计数器 ≥ 1）。
 *     修复前它**也** ≥1（页面一直没错，错的是主进程没听）—— 这条用来把
 *     「页面没回」和「主进程没听」分开，红的时候一眼定位。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { waitFor } from "../../t7-genoffice-u1/editor-flow.js";
import { docsPageUrl, O4_UNIQUE } from "../constants.js";
import { o4LaunchSetup } from "../launch.js";
import type { O4Runtime } from "../setup.js";

/** 卡 2.1 的时限：2 秒超时是宿主自己的判据（`documentViewHost.ts` 的 2000ms），
 *  这里放宽到 2500ms 吸收 IPC 往返抖动，但**远小于**任何"正常关闭"会花的时间。 */
const CLOSE_DEADLINE_MS = 2500;

export const o4Journeys = [
  defineU1Journey({
    name: "o4-docs-close-production-path",
    launch: {
      window: false,
      size: { width: 1280, height: 900 },
      defaultTimeoutMs: 45_000,
      setup: o4LaunchSetup as never,
      // 真数据库：`findContainingWorkspaceRoot`（工作区围栏）读项目表；runner 的
      // `useRealDb` 会 initDb 并建 `proj_u1_fixture`（路径 = 本旅程的 projectDir）。
      // 没有它，openPath 的围栏会以 `getDb() called before initDb()` 失败 —— 那是
      // 装配缺项，不是被测缺陷。
      useRealDb: true,
      assertions: { dom: true, visual: false, sideEffect: true },
    },
    steps: [
      // ── 1. 生产 openPath：打开夹具，等页面回执提交会话 ──
      step.run(async ({ runtime }) => {
        const rt = runtime as O4Runtime;
        const wc = rt.host.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "docs 视图没有 webContents" };
        const { rpcHandlerFor } = await import("@main/appControl/registry.js");
        const { IPC } = await import("@contracts/ipc");
        const openPath = rpcHandlerFor(IPC.DOCUMENT_VIEW_OPEN_PATH);
        if (!openPath) return { ok: false, detail: "documentView:openPath 没有登记进 registry" };
        const reply = (await openPath({ sender: wc }, { docId: rt.docId, filePath: rt.fixturePath })) as {
          ok?: boolean;
          reason?: string;
        };
        if (reply.ok !== true) return { ok: false, observed: reply, detail: reply.reason ?? "openPath 被拒" };
        const session = await waitFor(async () => rt.host.sessionFor(rt.docId), 30_000, 200);
        return session
          ? { ok: true, observed: { docId: rt.docId, filePath: session.filePath, url: docsPageUrl() } }
          : { ok: false, detail: "30s 内没有提交打开会话（open-committed 未到）" };
      }, "open-path-committed", { assert: true }),

      step.waitFor(".ProseMirror", "editor-mounted", { timeoutMs: 30_000 }),
      step.waitFor(".ProseMirror", "shows-unique-text", { text: O4_UNIQUE, timeoutMs: 30_000 }),
      step.assertDom(".ProseMirror", { textContains: O4_UNIQUE }, "docs-dom-has-unique-text"),

      // ── 2. 主判据：生产 close，2.5s 内成功 ──
      step.run(async ({ runtime }) => {
        const rt = runtime as O4Runtime;
        const wc = rt.host.webContentsOf(rt.docId);
        if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
        const { rpcHandlerFor } = await import("@main/appControl/registry.js");
        const { IPC } = await import("@contracts/ipc");
        const close = rpcHandlerFor(IPC.DOCUMENT_VIEW_CLOSE);
        if (!close) return { ok: false, detail: "documentView:close 没有登记进 registry（装配断了）" };
        const started = Date.now();
        const reply = (await close({ sender: wc }, { docId: rt.docId })) as { ok?: boolean; reason?: string };
        const waitedMs = Date.now() - started;
        const gone = !rt.host.list().some((view) => view.docId === rt.docId);
        // webContents.close() 的销毁是异步的：有界等它真的死掉。
        const destroyed = await waitFor(
          async () => ((wc as unknown as { isDestroyed?: () => boolean }).isDestroyed?.() === true ? true : null),
          5_000,
          100,
        );
        const observed = {
          reply,
          waitedMs,
          gone,
          webContentsDestroyed: destroyed === true,
          wrappedHasOn: rt.wrappedHasOn,
          closeCheckResultEvents: rt.counts.closeCheckResult,
        };
        if (reply.ok !== true) {
          return {
            ok: false,
            observed,
            detail: `关闭被拒：${reply.reason ?? "(无原因)"}（耗时 ${waitedMs}ms；` +
              `页面回报 ${rt.counts.closeCheckResult} 次，包装层 on=${rt.wrappedHasOn}）`,
          };
        }
        if (waitedMs > CLOSE_DEADLINE_MS) {
          return { ok: false, observed, detail: `关闭成功但耗时 ${waitedMs}ms，超过 ${CLOSE_DEADLINE_MS}ms 判据` };
        }
        if (!gone || destroyed !== true) {
          return { ok: false, observed, detail: "关闭返回 ok 但视图未从宿主表消失 / webContents 未销毁" };
        }
        return { ok: true, observed };
      }, "close-succeeds-within-2s", { assert: true }),

      // ── 3. 页面确实回了（把「页面没回」与「主进程没听」分开） ──
      step.run(async ({ runtime }) => {
        const rt = runtime as O4Runtime;
        return rt.counts.closeCheckResult >= 1
          ? { ok: true, observed: { closeCheckResultEvents: rt.counts.closeCheckResult } }
          : {
              ok: false,
              observed: { closeCheckResultEvents: rt.counts.closeCheckResult },
              detail: "页面一次都没回 close-check-result —— 缺陷在页面侧（本卡范围外）",
            };
      }, "page-answered-close-check", { assert: true }),

      // ── 4. 收尾取证：宿主表必须归零（close 之后不应留下任何视图） ──
      step.run(async ({ runtime }) => {
        const rt = runtime as O4Runtime;
        const views = rt.host.list().map((view) => view.docId);
        return views.length === 0
          ? { ok: true, observed: { views } }
          : { ok: false, observed: { views }, detail: "关闭后宿主表里仍有视图" };
      }, "host-table-empty-after-close", { assert: true }),
    ],
  }),
];
