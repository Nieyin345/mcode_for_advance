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
import { readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
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
  filePath: string;
  fitWidthPx: number;
  undo: unknown[];
  redo: unknown[];
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

/** 生成 `OpenResult`（vendor `shared/ipc.ts:91-98` 的形状）。 */
function toOpenResult(opened: VendorDeck, filePath: string, slides: unknown[]): {
  path: string;
  slides: unknown[];
  size: { cx: number; cy: number };
} {
  const size = opened.deck.size as { cx?: unknown; cy?: unknown };
  return {
    path: filePath,
    slides,
    size: {
      cx: typeof size.cx === "number" ? size.cx : 12192000,
      cy: typeof size.cy === "number" ? size.cy : 6858000,
    },
  };
}

export class VendorSlidesExecutor implements SlidesEditExecutor {
  private readonly engine: VendorPptxEngine;
  private readonly render: VendorPptxRender;
  private readonly ops: VendorPptxOps;
  /** webContents id → deck 会话（与 vendor `sessions` 同一键空间）。 */
  private readonly sessions = new Map<number, DeckSession>();

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
    void docId;
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
    if (!deck || !deck.deck || !Array.isArray(deck.deck.slides)) return null;
    this.sessions.set(webContentsId, {
      opened,
      filePath,
      fitWidthPx: fitWidthPx > 0 ? fitWidthPx : DEFAULT_FIT_WIDTH_PX,
      undo: [],
      redo: [],
    });
    const slides = renderSlides(this.render, deck, fitWidthPx > 0 ? fitWidthPx : DEFAULT_FIT_WIDTH_PX);
    return { openResult: toOpenResult(deck, filePath, slides) };
  }

  async saveDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
  ): Promise<{ bytes: number } | null> {
    void docId;
    const session = this.sessions.get(webContentsId);
    if (!session) return null;
    // 宿主给的路径必须与打开时那份一致：页面没有路径参数，但装配层若被误用，
    // 这一句保证"保存只会写回它打开过的那份"（与宿主会话表是两道独立的判断）。
    if (session.filePath !== filePath) return null;
    if (dirname(filePath) === "") return null;
    try {
      await this.engine.savePptxToFile(session.opened, filePath);
      this.engine.commitSaved(session.opened);
      const info = await stat(filePath);
      return { bytes: info.size };
    } catch {
      return null;
    }
  }

  async addBlankSlide(
    webContentsId: number,
    docId: string,
  ): Promise<{ slideCount: number; slides: unknown[]; index: number } | null> {
    void docId;
    const session = this.sessions.get(webContentsId);
    if (!session) return null;
    const deck = session.opened as VendorDeck;
    // vendor `slides:add-blank-slide`（slides-main.ts:2770）的同一事务：插在当前页
    // 之后。宿主没有"当前页"概念 → 固定插在最后一页之后（页面后续以返回的
    // slides 树重绘，index 与 vendor 语义一致）。
    const sourceIndex = Math.max(0, deck.deck.slides.length - 1);
    session.undo.push(this.snapshot(deck));
    const result = this.ops.runTxn(session.opened, {
      ops: [{ op: "addBlankSlide", target: { slide: sourceIndex } }],
    });
    if (!result.applied) {
      session.undo.pop();
      return null;
    }
    // The original Slides UI's addBlankSlide() consumes the full updated
    // RenderSlide[] and the inserted index, not merely the new slide count.
    const slides = renderSlides(this.render, deck, session.fitWidthPx);
    return { slideCount: deck.deck.slides.length, slides, index: deck.deck.slides.length - 1 };
  }

  async editText(
    webContentsId: number,
    docId: string,
    slideIndex: number,
    elementId: string,
    text: string,
  ): Promise<{ text: string; renderedSlide: Record<string, unknown> } | null> {
    void docId;
    const session = this.sessions.get(webContentsId);
    if (!session) return null;
    session.undo.push(this.snapshot(session.opened as VendorDeck));
    const result = this.ops.runTxn(session.opened, {
      ops: [
        {
          op: "setText",
          target: { slide: slideIndex, el: elementId },
          paragraphs: [{ runs: [{ text }] }],
        },
      ],
    });
    if (!result.applied) {
      session.undo.pop();
      return null;
    }
    // 回读：用渲染树里该元素的文本作为"替换后的纯文本"（与 vendor 的返回同一语义）。
    const deck = session.opened as VendorDeck;
    const slide = deck.deck.slides[slideIndex] as { nodes?: unknown[] } | undefined;
    const nodesText = flattenNodeText(slide?.nodes ?? []);
    // The vendor editor uses the returned RenderSlide's `nodes` to replace
    // its on-screen slide. A text-only acknowledgement would silently leave
    // the canvas stale even though the deck mutation succeeded.
    const renderedSlide = renderSlides(this.render, deck, session.fitWidthPx)[slideIndex];
    if (!renderedSlide || typeof renderedSlide !== "object") return null;
    return { text: nodesText.length > 0 ? nodesText : text, renderedSlide: renderedSlide as Record<string, unknown> };
  }

  /** 浅快照（vendor `takeSnapshot` 的简化版）：undo 只在失败回滚时用。 */
  private snapshot(deck: VendorDeck): unknown {
    return { slides: deck.deck.slides.map((slide) => slide) };
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

