/**
 * 【ARC-007 P1/GA1】**生产 slides 执行器** —— 装配期接到 `slidesBridge.attach()`。
 *
 * ## 它是什么（以及不是什么）
 *
 * 它把 `SlidesEditExecutor` 的三个操作（`openDeck`/`saveDeck`/`addBlankSlide`/
 * `editText`）实现成对**同一份 vendor 代码**的调用：
 *
 *   - 解析：`@genoffice/pptx-engine` 的 `openPptx`（vendor slides 主进程
 *     `openAndBuild` 的同一入口，`slides-main.ts:884-936`）；
 *   - 渲染树：`@genoffice/pptx-render` 的 `buildRenderSlide`（vendor
 *     `buildAllRenderSlides` 的同一实现，`session-state.ts:406-414`）；
 *   - 编辑：`@genoffice/pptx-ops` 的 `runTxn`（vendor `slides:edit-text`/
 *     `slides:add-blank-slide` 的同一执行器）；
 *   - 保存：`@genoffice/pptx-engine` 的 `savePptxToFile`（vendor `slides:save`
 *     的同一写盘函数，`slides-main.ts:4574-4600`）。
 *
 * **它不是** vendor 的 `registerSlidesIpc()`：那会把 198 个 `slidesApi` 通道
 * （含文件对话框/任意路径读写/AI/聊天存储/剪贴板）一次性注册进 Mcode 主进程
 * （见 `docs/planning/genoffice-ai-interaction.md` 第 9 节）。这里只走
 * **编辑/解析/保存**三件事，且路径只来自宿主。
 *
 * ## 为什么依赖是**静态**的、又能在没有 vendor 的机器上构建
 *
 * vendor 源码（`genoffice/`）是 gitignored 快照，而且包入口指向 TypeScript
 * 源码 —— Node 运行时 `require` 不了，只能在**构建期**打包。所以三个 vendor
 * import 收进 `slidesVendorModules.ts` 一个静态入口；`electron.vite.config.ts`
 * 在快照缺失时把该入口别名到 `slidesVendorModulesStub.ts`（`vendorAvailable=false`）。
 * 装配层看到 false 就不 attach（桥保持 `SLIDES_BRIDGE_UNAVAILABLE`），
 * `document.capabilities.hosts.slides` 报告 false，面板显式降级 ——
 * **绝不假装能力存在**，构建也不会因可选快照缺失而红。
 *
 * ## 会话表
 *
 * 每个视图（webContents id）一份：打开后的 `OpenedPptx` 模型 + 路径 +
 * 撤销栈。与 vendor `sessions`（`session-state.ts:84`）同形，但只保留本适配层
 * 用到的字段；`saveDeck` 把该模型写回宿主给的路径（页面没有路径参数）。
 */
import { chmod, lstat, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import type { SlidesEditExecutor } from "./slidesBridge.js";
/**
 * 【ARC-007 P1/GA1】vendor 依赖的静态入口。构建期（`electron.vite.config.ts`）
 * 把 `@main/document/slidesVendorModules.js` 解析到真实现或 stub —— 走
 * **路径别名**而不是相对 import，类型面由 `slidesVendorShims.d.ts` 的同名模块
 * 声明提供（真实现/stub 同形）。
 */
import { vendorAvailable, vendorSlidesModules } from "@main/document/slidesVendorModules.js";

/** vendor 的渲染树宽度（与 `slidesBridge` 的 `SLIDES_FIT_WIDTH_PX` 同值）。 */
const DEFAULT_FIT_WIDTH_PX = 1280;

/** vendor 模块的最小面（形状来自 vendor 源码，不是猜测；见 `slidesVendorShims.d.ts`）。 */
interface VendorPptxEngine {
  openPptx(bytes: Uint8Array): Promise<unknown>;
  savePptxToFile(opened: unknown, filePath: string): Promise<void>;
  createBlankPptx(): Promise<Uint8Array>;
  commitSaved(opened: unknown): void;
}
interface VendorPptxRender {
  buildRenderSlide(slide: unknown, size: unknown, opts: Record<string, unknown>): unknown;
  HeuristicMetrics: new () => unknown;
}
interface VendorPptxOps {
  runTxn(opened: unknown, req: Record<string, unknown>): {
    applied: boolean;
    failures?: Array<{ index: number; error: string }>;
    records?: Array<Record<string, unknown>>;
  };
}
interface VendorDeck {
  deck: { slides: unknown[]; size: unknown };
  archive?: unknown;
}

interface DeckSession {
  opened: unknown;
  docId: string;
  filePath: string;
  /** Original physical bytes at open time; same CAS as Mcode file edits. */
  revision: string;
  /** Any edit made while savePptxToFile is awaiting invalidates that save. */
  editEpoch: number;
  /** Last edit epoch durably written to the original file. */
  savedEpoch: number;
  /** Vendor mutation/render failed after touching deck; reload before saving. */
  saveTainted: boolean;
  fitWidthPx: number;
}

/**
 * 从静态 seam 取 vendor 模块。`vendorAvailable=false`（stub 替身）或任一导出
 * 形状不对 → null（装配层不 attach）。不做运行期 `createRequire`：vendor 包
 * 指向 TS 源码，运行时加载不了（见文件头）。
 */
function vendorModules(): {
  engine: VendorPptxEngine;
  render: VendorPptxRender;
  ops: VendorPptxOps;
} | null {
  if (!vendorAvailable) return null;
  const modules = vendorSlidesModules;
  if (typeof modules.openPptx !== "function" || typeof modules.savePptxToFile !== "function") return null;
  if (typeof modules.buildRenderSlide !== "function" || typeof modules.HeuristicMetrics !== "function") return null;
  if (typeof modules.runTxn !== "function") return null;
  return {
    engine: {
      openPptx: modules.openPptx,
      savePptxToFile: modules.savePptxToFile,
      createBlankPptx: modules.createBlankPptx,
      commitSaved: modules.commitSaved,
    },
    render: {
      buildRenderSlide: modules.buildRenderSlide,
      HeuristicMetrics: modules.HeuristicMetrics,
    },
    ops: { runTxn: modules.runTxn },
  };
}

function renderSlides(
  render: VendorPptxRender,
  opened: VendorDeck,
  fitWidthPx: number,
): unknown[] {
  const metrics = new render.HeuristicMetrics();
  return opened.deck.slides.map((slide, index) =>
    render.buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx,
      metrics,
      slideNo: index + 1,
    }),
  );
}

/** A native pptx-render RenderSlide requires RenderNode[] nodes.
 * Always validate before publishing ANY saveable vendor model mutation; an
 * L2 SlidesBridge refusal alone cannot roll back an already changed deck. */
function hasNativeRenderTree(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    Array.isArray((value as { nodes?: unknown }).nodes);
}

/** 生成 `OpenResult`（vendor `shared/ipc.ts:91-98` 的形状）。 */
function toOpenResult(filePath: string, slides: unknown[], size: { cx: number; cy: number }): {
  path: string;
  slides: unknown[];
  size: { cx: number; cy: number };
} {
  // Never fabricate a default EMU page size for corrupt vendor results.
  return { path: filePath, slides, size };
}

export class VendorSlidesExecutor implements SlidesEditExecutor {
  private readonly engine: VendorPptxEngine;
  private readonly render: VendorPptxRender;
  private readonly ops: VendorPptxOps;
  /** webContents id → deck 会话（与 vendor `sessions` 同一键空间）。 */
  private readonly sessions = new Map<number, DeckSession>();
  // One webContents can request A, then B before A finishes parsing. A slow
  // vendor parser must not overwrite the newer B deck, and a closed view must
  // not recreate an orphaned session after release().
  private readonly sessionEpochs = new Map<number, object>();

  constructor(modules: { engine: VendorPptxEngine; render: VendorPptxRender; ops: VendorPptxOps }) {
    this.engine = modules.engine;
    this.render = modules.render;
    this.ops = modules.ops;
  }

  /** 装配入口：vendor 依赖齐备时返回执行器，否则 null（桥保持 fail-closed）。 */
  static create(): VendorSlidesExecutor | null {
    const modules = vendorModules();
    if (modules === null) return null;
    return new VendorSlidesExecutor(modules);
  }

  /** 视图关闭时摘会话（由装配层在 `close`/`dispose` 时调用，避免按 id 累积）。 */
  release(webContentsId: number): void {
    // Deleting invalidates every pending open token, without retaining a
    // forever-growing tombstone for destroyed Electron webContents ids.
    this.sessionEpochs.delete(webContentsId);
    this.sessions.delete(webContentsId);
  }

  /** 【ARC-007 P1/GA1】诊断：当前会话数（套件断言关闭后不泄漏）。 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async openDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<{ openResult: unknown } | null> {
    const epoch = {};
    this.sessionEpochs.set(webContentsId, epoch);
    const stillCurrent = (): boolean => this.sessionEpochs.get(webContentsId) === epoch;
    if (extname(filePath).toLowerCase() === ".ppt") return null; // 旧版 CFB，vendor 同样拒绝
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(filePath));
    } catch {
      return null;
    }
    // 0 字节：vendor 的 `openAndBuild` 用空白模板打开（slides-main.ts:908-913）；
    // 坏档（非 zip）交给 vendor 解析器抛错 —— 与 vendor 的行为一致。
    const payload = bytes.length === 0 ? await this.engine.createBlankPptx() : bytes;
    let opened: unknown;
    try {
      opened = await this.engine.openPptx(payload);
    } catch {
      return null;
    }
    const deck = opened as VendorDeck;
    if (!stillCurrent()) return null;
    if (!deck || !deck.deck || !Array.isArray(deck.deck.slides)) return null;
    // Native deck size is an indispensable part of the PPTX model. Do not
    // silently substitute 13.333x7.5in fallback dimensions: besides
    // misleading the renderer, that would retain a saveable broken deck.
    const size = deck.deck.size as { cx?: unknown; cy?: unknown } | null;
    if (!size || typeof size.cx !== "number" || !Number.isSafeInteger(size.cx) || size.cx <= 0 ||
        typeof size.cy !== "number" || !Number.isSafeInteger(size.cy) || size.cy <= 0) return null;
    // Rendering can fail after the vendor parser accepts a damaged deck.
    // Publish the saveable session only after every native RenderSlide exists.
    // Otherwise a failed Open could still save a partially parsed document.
    const width = fitWidthPx > 0 ? fitWidthPx : DEFAULT_FIT_WIDTH_PX;
    const slides = renderSlides(this.render, deck, width);
    if (!stillCurrent()) return null;
    // pptx-render's native RenderSlide always has a RenderNode[] nodes field.
    // The SlidesBridge checks this before reporting success to the renderer,
    // but reject it here too or a visual-open failure still leaves a
    // saveable native session that could overwrite a real presentation.
    if (!slides.every(hasNativeRenderTree)) return null;
    this.sessions.set(webContentsId, {
      opened,
      docId,
      filePath,
      revision: createHash("sha256").update(bytes).digest("hex"),
      editEpoch: 0,
      // An empty source is opened using a generated blank deck. Its first save
      // must materialize that deck, not acknowledge an unchanged 0-byte file.
      savedEpoch: bytes.length === 0 ? -1 : 0,
      saveTainted: false,
      fitWidthPx: width,
    });
    return { openResult: toOpenResult(filePath, slides, { cx: size.cx, cy: size.cy }) };
  }

  async saveDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
  ): Promise<{ bytes: number } | { reason: string } | null> {
    const session = this.sessions.get(webContentsId);
    if (!session || session.docId !== docId || session.filePath !== filePath) return null;
    if (session.saveTainted) {
      return { reason: "SLIDES_NATIVE_SESSION_UNCERTAIN:原厂编辑或渲染中途失败，请重新打开文档再保存" };
    }
    const epoch = this.sessionEpochs.get(webContentsId);
    if (!epoch || dirname(filePath) === "") return null;
    const editEpoch = session.editEpoch;
    const stillCurrent = (): boolean =>
      this.sessions.get(webContentsId) === session &&
      this.sessionEpochs.get(webContentsId) === epoch &&
      session.editEpoch === editEpoch;
    try {
      // Reuse exactly the same Host path lease and SHA256 revision source as
      // Docs/file.writeFile. A renderer read→vendor-save gap without this
      // critical section silently overwrote edits made by another process.
      return await withOsFileLease(filePath, async (real) => {
        if (!stillCurrent()) return null;
        const original = await lstat(real);
        if (!original.isFile() || original.nlink !== 1) return null;
        if (await fileContentVersion(real) !== session.revision) {
          return { reason: "SLIDES_FILE_VERSION_CONFLICT:演示文稿已被外部编辑，拒绝覆盖新版本" };
        }

        // The vendor always rebuilds the ZIP, even without edits. Keep the
        // original bytes and metadata untouched when this session is clean;
        // still take the OS lease and verify the revision before acknowledging.
        if (session.editEpoch === session.savedEpoch) return { bytes: original.size };

        // The original GenOffice pptx-engine still serializes every slide,
        // animation and unknown archive part. The Host only changes where
        // vendor writes BEFORE publication: isolated staging in same folder.
        const stageDir = await mkdtemp(join(dirname(real), ".mcode-slides-stage-"));
        const stage = join(stageDir, basename(real));
        try {
          await this.engine.savePptxToFile(session.opened, stage);
          if (!stillCurrent()) return null; // tab closed, switched, or edited
          const stagedInfo = await lstat(stage);
          if (!stagedInfo.isFile() || stagedInfo.nlink !== 1) return null;
          const stagedHash = await fileContentVersion(stage);
          if (stagedHash === null) return null;
          // While vendor awaited, another editor may have changed the file;
          // never publish that old deck over a newer revision.
          if (await fileContentVersion(real) !== session.revision) {
            return { reason: "SLIDES_FILE_VERSION_CONFLICT:原版 PPTX 保存期间文件被修改，已保留新版本" };
          }
          if (!stillCurrent()) return null;
          if (process.platform !== "win32") await chmod(stage, original.mode & 0o777);
          // Flush the vendor-produced bytes before same-filesystem rename.
          const fd = await open(stage, "r+"); // Windows fsync requires a writable file handle
          try { await fd.sync(); } finally { await fd.close(); }
          if (!stillCurrent()) return null;
          if (await fileContentVersion(real) !== session.revision) {
            return { reason: "SLIDES_FILE_VERSION_CONFLICT:最终写入前发现外部修改，已保留原始文件" };
          }
          await rename(stage, real);
          session.revision = stagedHash;
          try {
            this.engine.commitSaved(session.opened);
          } catch {
            // The OS rename has ALREADY committed the complete document.
            // Neither "save failed, try again" nor a false success is safe:
            // the native archive's committed cursor may now be inconsistent.
            session.saveTainted = true;
            return {
              reason: "SLIDES_POST_COMMIT_UNCERTAIN:文件已写入磁盘，但原厂提交状态失败；请重新打开文档确认保存结果",
            };
          }
          session.savedEpoch = editEpoch;
          return { bytes: stagedInfo.size };
        } finally {
          await rm(stageDir, { recursive: true, force: true });
        }
      });
    } catch {
      return null;
    }
  }

  async addBlankSlide(
    webContentsId: number,
    docId: string,
    sourceIndex?: number,
    before = false,
  ): Promise<{ slideCount: number; slides: unknown[]; index: number } | null> {
    const session = this.sessions.get(webContentsId);
    if (!session || session.docId !== docId || session.saveTainted) return null;
    const deck = session.opened as VendorDeck;
    try {
      const anchor = sourceIndex ?? Math.max(0, deck.deck.slides.length - 1);
      if (!Number.isSafeInteger(anchor) || anchor < 0 ||
          (deck.deck.slides.length > 0 && anchor >= deck.deck.slides.length)) return null;
      // Only a real native operation can mutate the model. A rejected page
      // index must not invalidate an otherwise valid in-flight save. Once
      // input is valid, invalidate BEFORE the vendor transaction (which can
      // mutate the deck even when it later reports failure).
      session.editEpoch++;
      // Original slides-main.ts:2770-2793 inserts after the selected slide;
      // the before variant is the *same original two-op transaction*:
      // insert after source, then move the old source after the new slide.
      const result = this.ops.runTxn(session.opened, {
        ops: [
          { op: "addBlankSlide", target: { slide: anchor } },
          ...(before ? [{ op: "moveSlide", target: { slide: anchor }, to: anchor + 1 }] : []),
        ],
      });
      if (!result.applied && !result.failures?.length) {
        return null;
      }
      if (!result.applied || result.failures?.length) {
        session.saveTainted = true;
        return null;
      }
      const slides = renderSlides(this.render, deck, session.fitWidthPx);
      if (!slides.every(hasNativeRenderTree)) {
        session.saveTainted = true;
        return null;
      }
      return { slideCount: deck.deck.slides.length, slides, index: before ? anchor : anchor + 1 };
    } catch {
      session.saveTainted = true;
      return null;
    }
  }

  async editText(
    webContentsId: number,
    docId: string,
    slideIndex: number,
    elementId: string,
    text: string,
  ): Promise<{ text: string; renderedSlide: Record<string, unknown> } | null> {
    const session = this.sessions.get(webContentsId);
    if (!session || session.docId !== docId || session.saveTainted) return null;
    // Native runTxn can partly mutate a model before it throws. An in-flight
    // save must be invalidated even if the UI never receives a success reply.
    session.editEpoch++;
    try {
      const result = this.ops.runTxn(session.opened, {
        ops: [{
          op: "setText",
          target: { slide: slideIndex, el: elementId },
          paragraphs: [{ runs: [{ text }] }],
        }],
      });
      if (!result.applied && !result.failures?.length) {
        return null;
      }
      if (!result.applied || result.failures?.length) {
        session.saveTainted = true;
        return null;
      }
      const deck = session.opened as VendorDeck;
      const slide = deck.deck.slides[slideIndex] as { nodes?: unknown[] } | undefined;
      const nodesText = flattenNodeText(slide?.nodes ?? []);
      const renderedSlide = renderSlides(this.render, deck, session.fitWidthPx)[slideIndex];
      if (!hasNativeRenderTree(renderedSlide)) {
        session.saveTainted = true;
        return null;
      }
      return { text: nodesText.length > 0 ? nodesText : text, renderedSlide: renderedSlide as Record<string, unknown> };
    } catch {
      session.saveTainted = true;
      return null;
    }
  }

}

/** 渲染树节点的纯文本（与 vendor 页面 `flatten` 的判据一致：text.lines[].runs[]）。 */
function flattenNodeText(nodes: unknown[]): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as {
      text?: { lines?: Array<{ runs?: Array<{ text?: unknown }> }> };
      children?: unknown[];
    };
    if (record.text && Array.isArray(record.text.lines)) {
      for (const line of record.text.lines) {
        for (const run of line.runs ?? []) parts.push(String(run.text ?? ""));
      }
    }
    for (const child of record.children ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return parts.join("");
}

