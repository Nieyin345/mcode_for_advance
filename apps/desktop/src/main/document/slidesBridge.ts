/**
 * 【ARC-007】**slides 编辑桥** —— A 方案（宿主重接）的第一步。
 *
 * ## 它是什么
 *
 * slides 渲染端的所有编辑操作都经 vendor 主进程的 session 表执行
 * （`genoffice/apps/slides/src/main/session-state.ts:50`）。Mcode 的最小桥
 * 不照搬 vendor 全量 `slidesApi`（198 个方法、42 个危险 channel，见
 * `docs/planning/genoffice-ai-interaction.md` 第 9 节），只为两个编辑操作开
 * typed 通道：
 *
 *   - `documentView.slidesAddSlide({})` → `{ ok, slideCount, slides, index }`
 *   - `documentView.slidesEditText({ slideIndex, elementId, text })` → `{ ok, text, ...RenderSlide }`
 *
 * 两者都**转发到 vendor 主进程的同一份 handler**（`slides:add-blank-slide` /
 * `slides:edit-text`），不复制任何 vendor 逻辑。
 *
 * ## 为什么用可注入的 `SlidesEditExecutor`
 *
 * 生产里 vendor 主进程是否装配好，是**装配期**的事实，不是每次调用都重新探测的
 * 事。`DocumentViewHost` 与 `documentViewHost` 单例同一形状：调用方注入执行器；
 * **没有注入 = 显式 fail-closed**（`ok:false` 且原因点名「vendor 主进程未装配」），
 * 绝不假装成功。无头套件注入假执行器即可验证「参数原样转发 + docId 身份」。
 *
 * ## 身份与围栏
 *
 * docId 由宿主从 `event.sender` 反查（若旧页面声明则强制一致性核对，
 * 见 `ipc/documentView.ts` 的 handler）。本模块**不**再做第二套身份判断 ——
 * 它只接收已经核对过的 docId 与参数，把调用转给执行器。
 *
 * ## 本模块不做什么（如实）
 *
 *   - 不注册 IPC、不碰 preload：接线在 `ipc/documentView.ts` 与
 *     `documentViewPreload.ts`；
 *   - 不持有 vendor 会话：执行器（将来是 `slides-main.ts` 的 `registerSlidesIpc`
 *     包装）负责；
 *   - 不做路径围栏：操作本身不带"页面给的路径" —— `openDeck`/`saveDeck` 的路径
 *     由**宿主**从待打开/已打开记录里给，围栏在 `DocumentViewHost` 里做
 *     （与 docs 的 `openPath`/`saveOpenedFile` 同一条判据）。
 */

import { safeErrorMessage } from "@main/lib/ipcError.js";

/** 执行器注入面 —— 生产由 vendor 主进程包装，套件注入假实现。 */
export interface SlidesEditExecutor {
  /** vendor `slides:add-blank-slide`（`slides-main.ts:2770`）语义：
   *  在当前页之后加一张空白页，返回新的页数与新页 index。 */
  addBlankSlide(webContentsId: number, docId: string): Promise<{ slideCount: number; slides: unknown[]; index: number } | null>;
  /** vendor `slides:edit-text`（`slides-main.ts:1507`）语义：把某页某元素的文本
   *  替换为 `text`，返回该元素替换后的纯文本（vendor 可能把它折成多个 run）。 */
  editText(
    webContentsId: number,
    docId: string,
    slideIndex: number,
    elementId: string,
    text: string,
  ): Promise<{ text: string; renderedSlide: Record<string, unknown> } | null>;
  /** 【ARC-007 P1/GA1】vendor `slides:open-path`（`slides-main.ts:1458`）语义：
   *  用 vendor 的解析器打开**宿主已过围栏的路径**，返回 vendor `OpenResult`
   *  （`shared/ipc.ts:91-98`：`{ path, slides[], size, defaultFont? }`）。
   *  路径参数由宿主传入；页面拿不到任意路径。返回 null = 解析失败/坏档。 */
  openDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<{ openResult: unknown } | null>;
  /** 【ARC-007 P1/GA1】vendor `slides:save`（`slides-main.ts:4574`）语义的子集：
   *  把**该视图会话里当前 deck** 写到宿主给定的路径（宿主只传它自己打开过的那份）。
   *  返回 false/null = 没有会话或写盘失败。页面永远拿不到路径参数。 */
  saveDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
  ): Promise<{ bytes: number } | { reason: string } | null>;
}

export type SlidesEditResult =
  | { ok: true; slideCount: number; slides: unknown[]; index: number }
  | ({ ok: true; text: string } & Record<string, unknown>)
  | { ok: false; reason: string };

/** 【ARC-007 P1/GA1】打开结果：vendor `OpenResult` 原样透传（形状由 vendor 契约
 *  `shared/ipc.ts:91-98` 定义，本层不重写）。 */
export type SlidesOpenResult =
  | { ok: true; openResult: unknown }
  | { ok: false; reason: string };

/** 【ARC-007 P1/GA1】保存结果：`bytes` 是实际写盘的字节数（页面据此显示"已保存"）。 */
export type SlidesSaveResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: string };

/** 「vendor 主进程未装配」的唯一文案 —— 套件按它断言 fail-closed。 */
export const SLIDES_BRIDGE_UNAVAILABLE = "slides 编辑通道不可用：vendor 主进程未装配";

export class SlidesBridge {
  /** 装配期写入一次（`attach`）；不暴露 setter —— 换执行器会留下不一致的会话绑定。 */
  protected executor: SlidesEditExecutor | null;

  constructor(executor: SlidesEditExecutor | null) {
    this.executor = executor;
  }

  /** 是否装配了执行器（诊断用；不暴露给渲染端）。 */
  get available(): boolean {
    return this.executor !== null;
  }

  async addSlide(webContentsId: number, docId: string): Promise<SlidesEditResult> {
    if (this.executor === null) return { ok: false, reason: SLIDES_BRIDGE_UNAVAILABLE };
    try {
      const result = await this.executor.addBlankSlide(webContentsId, docId);
      if (result === null) {
        return { ok: false, reason: "slides 视图会话不存在（vendor 主进程没有这个 webContents 的打开会话）" };
      }
      // A malformed vendor result is NOT a completed page insertion. The
      // native canvas requires a full slide list and an in-range new index.
      if (!Number.isSafeInteger(result.slideCount) || result.slideCount <= 0 ||
          !Array.isArray(result.slides) || result.slides.length !== result.slideCount ||
          !Number.isSafeInteger(result.index) || result.index < 0 || result.index >= result.slideCount) {
        return { ok: false, reason: "加页失败：原厂未返回完整的幻灯片列表与页码" };
      }
      return { ok: true, slideCount: result.slideCount, slides: result.slides, index: result.index };
    } catch (err) {
      return { ok: false, reason: `加页失败：${safeErrorMessage(err)}` };
    }
  }

  /** 【ARC-007 P1/GA1】把宿主已过围栏的 `.pptx` 路径交给 vendor 解析器打开。 */
  async openDeck(
    webContentsId: number,
    docId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<SlidesOpenResult> {
    if (this.executor === null) return { ok: false, reason: SLIDES_BRIDGE_UNAVAILABLE };
    try {
      const result = await this.executor.openDeck(webContentsId, docId, filePath, fitWidthPx);
      if (result === null) {
        return { ok: false, reason: "打开失败：vendor 解析器拒绝了该文件（坏档、旧版 .ppt 或不受支持的格式）" };
      }
      if (!result.openResult || typeof result.openResult !== "object" ||
          !Array.isArray((result.openResult as { slides?: unknown }).slides)) {
        return { ok: false, reason: "打开失败：原厂未返回可渲染的幻灯片树" };
      }
      return { ok: true, openResult: result.openResult };
    } catch (err) {
      return { ok: false, reason: `打开失败：${safeErrorMessage(err)}` };
    }
  }

  /** 【ARC-007 P1/GA1】把该视图会话里的 deck 写回**宿主打开的路径**。
   *  路径由宿主从自己的打开会话取（`DocumentViewHost.openedFilePath`），
   *  页面没有传路径的能力。 */
  async saveDeck(webContentsId: number, docId: string, filePath: string): Promise<SlidesSaveResult> {
    if (this.executor === null) return { ok: false, reason: SLIDES_BRIDGE_UNAVAILABLE };
    try {
      const result = await this.executor.saveDeck(webContentsId, docId, filePath);
      if (result === null) {
        return { ok: false, reason: "保存失败：vendor 主进程没有这个 webContents 的打开会话（或写盘失败）" };
      }
      // An executor-side file version CAS may fail after the Host preflight
      // (while the native vendor serializer was awaiting). Keep the precise
      // conflict visible to the original Slides UI rather than presenting an
      // undefined byte count as if the save succeeded.
      if ("reason" in result) return { ok: false, reason: result.reason };
      if (!Number.isSafeInteger(result.bytes) || result.bytes <= 0) {
        return { ok: false, reason: "保存失败：原厂未返回有效的 PPTX 文件字节数" };
      }
      return { ok: true, bytes: result.bytes };
    } catch (err) {
      return { ok: false, reason: `保存失败：${safeErrorMessage(err)}` };
    }
  }

  async editText(
    webContentsId: number,
    docId: string,
    slideIndex: number,
    elementId: string,
    text: string,
  ): Promise<SlidesEditResult> {
    if (this.executor === null) return { ok: false, reason: SLIDES_BRIDGE_UNAVAILABLE };
    try {
      const result = await this.executor.editText(webContentsId, docId, slideIndex, elementId, text);
      if (result === null) {
        return {
          ok: false,
          reason: "改文字失败：元素不存在或 vendor 执行器拒绝了该操作（slideIndex/elementId 可能已失效）",
        };
      }
      // A text-only acknowledgement does not update the real native canvas.
      // Reject absent render nodes rather than reporting a phantom edit.
      if (!result.renderedSlide || !Array.isArray(result.renderedSlide.nodes)) {
        return { ok: false, reason: "改文字失败：原厂未返回可渲染的幻灯片节点" };
      }
      return { ...result.renderedSlide, ok: true, text: result.text };
    } catch (err) {
      return { ok: false, reason: `改文字失败：${safeErrorMessage(err)}` };
    }
  }
}

/** 生产单例：默认**未装配**（fail-closed）。装配期由 slides 宿主接线调用
 *  `slidesBridge.attach(executor)` —— 在那之前所有调用都回
 *  `SLIDES_BRIDGE_UNAVAILABLE`，而不是假装成功。 */
class AttachableSlidesBridge extends SlidesBridge {
  constructor() {
    super(null);
  }

  /** 装配期调用一次；之后不可更换（换执行器会留下不一致的会话绑定）。 */
  attach(executor: SlidesEditExecutor): void {
    // The bridge is the single authoritative vendor session binding. Swapping
    // an executor after an open would strand its deck in the old instance.
    // Repeated bootstrap with the SAME executor remains idempotent.
    if (this.executor !== null && this.executor !== executor) {
      throw new Error("slides 编辑通道已装配，禁止替换正在使用的 vendor 执行器");
    }
    this.executor = executor;
  }
}

export const slidesBridge = new AttachableSlidesBridge();
