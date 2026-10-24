/**
 * O0 —— 六条保真旅程共用的**装配与保存工具**（跑在探针主进程里）。
 *
 * ## 复用 t7 的生产装配，不复制它
 *
 * GenOffice 六编辑器的打开/保存/关闭由生产 `DocumentViewHost` + vendor 主进程
 * 协作完成。t7 的 `harness.ts` / `editor-flow.ts` 已经把这一整套装配好了
 *（生产单例、真 IPC handler、真 DB 项目行、真 vendor 视图工厂）。本模块
 *  **import 它们**（而不是拷一份），只把夹具换成 O0 的复杂样本。
 *
 * 所以这里**不碰** `t7-genoffice-u1/fixtures.ts`、也不改 t7 的任何旅程 ——
 * 卡 §5 的不变量。
 */
import type { WebContents } from "electron";

import type { U1SetupContext, U1SetupResult } from "../electron-u1/driver/index.js";
import { assembleHarness, type GenofficeHarness } from "../t7-genoffice-u1/harness.js";
import { editorUrl, invokeAs, js, sha256Of, waitFor } from "../t7-genoffice-u1/editor-flow.js";
import { ensureO0Fixtures, type O0FixturePaths } from "./fixtures/build.js";
import type { FormatKind } from "./fidelity/fingerprint.js";

/** 再导出：旅程一步就能拿到页面工具（同一份 t7 实现）。 */
export { invokeAs, js, sha256Of, waitFor };

export interface O0Runtime {
  harness: GenofficeHarness;
  fixtures: O0FixturePaths;
  kind: FormatKind;
  docId: string;
  webContentsId: number;
}

/**
 * 格式名（本套件的证据坐标，`docx`）→ vendor 编辑器 kind（宿主与 harness 的坐标，
 * `docs`）。两者只在 DOCX 上不同名，但**没有一个是「同义复用」可以有歧义的**：
 * `editorUrl` / `NativeHostStatus` / `host.open({editor})` 全部要 vendor 的 kind。
 */
type NativeEditorKind = "sheets" | "slides" | "pdf" | "markdown" | "html";
const EDITOR_KIND: Record<FormatKind, "docs" | NativeEditorKind> = {
  docx: "docs",
  xlsx: "sheets",
  pptx: "slides",
  pdf: "pdf",
  markdown: "markdown",
  html: "html",
};

const READY_MARKERS: Record<Exclude<FormatKind, "docx">, string> = {
  xlsx: "#univer-container",
  pptx: ".app, canvas, .konvajs-content",
  pdf: ".app, .pdf-placeholder",
  markdown: ".app, .doc-editor",
  html: ".app, .cm-editor",
};

/** 六条旅程共用的 `launch.setup`（与 t7 `editorSetup` 同形，只换夹具来源）。 */
export function o0Setup(kind: FormatKind): (ctx: U1SetupContext) => Promise<U1SetupResult> {
  return async (ctx: U1SetupContext): Promise<U1SetupResult> => {
    if (ctx.win === null) throw new Error("O0: GenOffice 视图需要宿主窗口（launch.window 不能为 false）");
    const repoRoot = process.env.MCODE_U1_REPO;
    if (!repoRoot) throw new Error("O0: MCODE_U1_REPO 未设置");
    const fixtures = await ensureO0Fixtures(ctx.projectDir, repoRoot);
    const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir });
    const status = harness.nativeStatus;
    const editorKind = EDITOR_KIND[kind];
    if (kind !== "docx" && status[editorKind as NativeEditorKind] !== true) {
      throw new Error(`O0: ${kind} 的原厂视图未装配（preload/renderer 缺失）: ${JSON.stringify(status)}`);
    }
    const docId = `o0-${kind}-g${ctx.generation}`;
    const target = fixtures[kind];
    const res = harness.host.open({
      docId,
      url: editorUrl(editorKind),
      bounds: { x: 0, y: 0, width: 1280, height: 900 },
      visible: true,
      mcodeSessionId: "o0-fidelity-session",
      ...(kind === "docx" ? {} : { editor: editorKind as NativeEditorKind, filePath: target }),
    });
    if (!res.ok) {
      harness.dispose();
      throw new Error(`${kind} host.open 失败: ${res.reason}`);
    }
    const wc = harness.webContentsOf(docId) as unknown as WebContents | null;
    if (wc === null) {
      harness.dispose();
      throw new Error(`${kind} 视图没有 webContents`);
    }
    wc.on("console-message", (_e, level, message) => {
      console.log(`VIEW[o0-${kind}:${level}] ${String(message).slice(0, 1500)}`);
    });
    await waitFor(() => js<boolean>(wc, "document.readyState === 'complete'"), 30_000, 200);
    if (kind === "docx") {
      const ready = await waitFor(() => js<boolean>(wc, "!!document.querySelector('.ProseMirror')"), 30_000, 200);
      if (!ready) throw new Error("O0: docs 起始屏 30s 内没有挂载 .ProseMirror");
    } else {
      await waitFor(() => js<boolean>(wc, `!!document.querySelector(${JSON.stringify(READY_MARKERS[kind])})`), 40_000, 250);
    }
    const runtime: O0Runtime = { harness, fixtures, kind, docId, webContentsId: wc.id };
    return {
      pageFromView: wc,
      dispose() { harness.dispose(); },
      runtime,
    };
  };
}

/** docs 的打开链（页面试图就绪后再走生产 openPath；与 t7 docs 旅程同一条）。 */
export async function openDocsPath(
  wc: WebContents,
  harness: GenofficeHarness,
  docId: string,
  filePath: string,
): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const reply = (await invokeAs(wc, harness, "documentView:openPath", { docId, filePath })) as { ok?: boolean; reason?: string };
  if (reply.ok !== true) return { ok: false, observed: reply, detail: `openPath 被拒: ${reply.reason}` };
  const session = await waitFor(async () => harness.host.sessionFor(docId), 30_000, 200);
  return session
    ? { ok: true, observed: { filePath: session.filePath } }
    : { ok: false, detail: "docs 页面 30s 内没有提交打开会话（open-committed 未到）" };
}

/** 关闭视图（生产 documentView:close；与 t7 各旅程同一条）。 */
export async function closeProduction(
  wc: WebContents,
  harness: GenofficeHarness,
  docId: string,
): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const reply = (await invokeAs(wc, harness, "documentView:close", { docId })) as { ok?: boolean; reason?: string };
  const gone = !harness.host.list().some((v: { docId: string }) => v.docId === docId);
  return reply.ok === true && gone
    ? { ok: true, observed: reply }
    : { ok: false, observed: { reply, gone }, detail: reply.reason ?? "关闭后视图仍在宿主表里" };
}

/**
 * 等保存落盘：磁盘字节相对**基线拷贝的 sha**变化。
 *
 * 为什么用基线拷贝而不是「打开时的 sha」：Docs 的打开/保存发生在同一代进程里，
 * 而基线拷贝在打开后、编辑前就写进了证据目录 —— 两者是同一个保存前状态，
 * 但基线拷贝在**重开代也能读**（openedSha 只活在 setup 的 runtime 里）。
 */
export async function waitForSaveToDisk(
  evidenceDir: string,
  kind: FormatKind,
  file: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const meta = JSON.parse(readFileSync(join(evidenceDir, "o0", `${kind}-baseline.json`), "utf8")) as {
    fingerprint: { sha256: string };
  };
  const before = meta.fingerprint.sha256;
  const changed = await waitFor(async () => sha256Of(file) !== before, timeoutMs, 300);
  return changed
    ? { ok: true, observed: { baselineSha: before, savedSha: sha256Of(file) } }
    : { ok: false, observed: { baselineSha: before, now: sha256Of(file) }, detail: `${file} 在 ${timeoutMs}ms 内字节没有变化（保存没有落盘）` };
}
