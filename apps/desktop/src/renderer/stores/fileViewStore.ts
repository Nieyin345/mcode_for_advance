/**
 * 「中间看哪个文件」这件事的**唯一**落点。
 *
 * ## 它替掉了什么
 *
 * 从前预览分在两处:`library.readFile` + `FilePreview`(文献/通用文件那一套,右栏)
 * 和 `templates.readFile`(模版那一套,也右栏)。两条路各有一份取数逻辑、各有一套
 * 文件类型判断,而且**形状不一样** —— 前者二进制走 base64,后者主进程已经把 office
 * 解成了 `Uint8Array`。同一张 pptx 从文献库点开和从模版库点开,走的是两份代码。
 *
 * 2026-09-20 起:文件预览**统一搬到中间**,右栏留给对话;而这两条取数路合并成
 * 一个 `FileViewer`,它按**来源**选一条去读,读回来的都归一到一种形状。
 *
 * ## 为什么要 store,而不是回调 prop
 *
 * 左右两边隔着好几层(左栏 `LibrarySection`,中间 `UnifiedTabbedPane`),
 * 而且左栏在两套外壳里各挂一次(树 / 会话流),切一次整个重挂载。
 * 回调 prop 传不下去,只能靠 store。
 *
 * ## 一次只看一个
 *
 * `target` 是单数,不是列表:中间栏同一时刻只显示一个文件(会话标签与文件标签共用
 * 一条标签条,见 `UnifiedTabsBar`)。这**不是**打开标签的历史 —— 那是
 * `sessionStore.openTabs` / `ideActiveFileByProject` 那一套,这里只是"现在这一眼
 * 看的是哪个"。
 */
import { create } from "zustand";

/** 预览的来源。决定 `FileViewer` 走哪条 RPC 去取字节。 */
export type FileSource =
  /**
   * 文献库条目。`ref` 是条目 id,可选 `relPath`(目录条目里往下翻)。
   *
   * `which` 同 `library.readFile` 的那一格（2026-09-21）:省略 = 看本体（通用条目给
   * 文件本身、论文给 **PDF**），`"md"` 才是"我要看转录"。它**必须能传下来** ——
   * 中间栏从前没有这一格，而主进程那边会回退到转录，于是用户点的明明是 PDF、看见的
   * 却是 md。
   */
  | { kind: "library"; ref: string; relPath?: string; which?: "pdf" | "md" }
  /**
   * **项目里的一棵树上的文件**(右栏文件管理 / 中间编辑器那一侧的)。
   *
   * 用户 2026-09-20 要的是「点右键菜单的**预览**看它一眼、**双击**才进编辑器改」——
   * 而项目文件从前**只有一条路**：点一下就进 IDE 编辑器(`openFileInIde`)。所以
   * "只想看一眼"没有落点,只能改。
   *
   * `ref` 是绝对路径;取字节走 `file.readFile` / `file.readBinary`,两条都带
   * **项目根防逃逸**(见 `@contracts/ipc` 的 `FileReadSchema` 说明)。
   */
  | { kind: "project"; ref: string };

/** 现在中间在预览什么。 */
export interface FileViewTarget {
  source: FileSource;
  /** 顶栏显示的名字(路径的最后一段)。 */
  name: string;
  /**
   * 打开它的时候右栏切到哪一格。
   *
   * 用户要的是"点开一个文件,在中间看,同时**还能跟子代理说话**" —— 所以点开文件
   * 不该把对话挤掉,而是把右栏切到它该在的那一格(`chat` = 主对话那一格)。
   * 具体切到哪一格由 `FileViewer` 的开点决定,这里只记一个**意图**。
   */
  focus?: "chat";
}

interface FileViewState {
  target: FileViewTarget | null;
  /**
   * 【UI-012】当前预览里的文件**有未保存的改动**(目前只有 PDF 批注会置位)。
   *
   * 从前这是一份**私有 ref**,只在 `PdfPreviewImpl` 内部记「用户改过批注」,
   * 而**离开预览的每条路**(切文件 / 关预览 / 关窗)都不看它 —— 于是用户加/改/删了
   * 批注没点「保存批注」就切走,内存里那份改动**无声消失**,没有任何恢复路径。
   *
   * 现在把它抬到 store:谁要"离开当前文件",先问一句 {@link hasUnsavedChanges},
   * 有就弹确认(保存 / 放弃 / 取消),不再静默丢弃。
   */
  dirty: boolean;
  /** 谁在预览里改了什么 → 由预览组件(如 PDF 批注)登记/清除。 */
  setDirty: (dirty: boolean) => void;
  /**
   * **在中间打开一个文件。** 有未保存改动的确认由调用方(UI 层)先做 —— store 层
   * 不该自己弹窗(它拿不到渲染上下文)。见 {@link openGuarded}。
   */
  open: (target: FileViewTarget) => void;
  /** 关掉。中间回到原来的会话标签。 */
  close: () => void;
}

/** 有未保存改动吗(供 UI 离开前询问)。 */
export function hasUnsavedChanges(): boolean {
  return useFileViewStore.getState().dirty;
}

/**
 * 【UI-012】"离开当前文件前询问"的**登记点**。`FileViewer`(只要中间在看文件就一直挂着)
 * 在挂载时把它的确认实现登记进来;`open()` 检测到有未保存改动就先交给它,由它弹
 * 「保存 / 放弃 / 取消」,而不是静默切走。
 *
 * `next` 是用户想切去的目标,`proceed` 是"确认可以走后"真正执行切换的回调。
 *
 * `saveCurrent` 由**当前预览组件**(如 PDF 的 `save`)登记 —— 用户选「保存」时调用它，
 * 返回是否成功；失败则**不**切换(让用户回到编辑器处理错误，而不是把改动丢掉)。
 */
let openGuard: ((next: FileViewTarget | null, proceed: () => void) => void) | null = null;
let saveCurrent: (() => Promise<boolean>) | null = null;
// A delayed leave dialog can outlive its source file or be superseded by
// another navigation request. Only the latest request can commit a transition.
let leaveRequestSeq = 0;

/** 登记/注销离开确认(FileViewer 挂载时登记、卸载时传 null)。 */
export function setFileOpenGuard(guard: ((next: FileViewTarget | null, proceed: () => void) => void) | null): () => void {
  openGuard = guard;
  // React can mount B's FileViewer before A's old effect cleanup runs.
  // Only that old registration may be disposed; never unlink the new dialog.
  return () => {
    if (openGuard === guard) openGuard = null;
  };
}

/** Register the active preview save handler. The returned disposer is identity-guarded:
 * an older PDF instance unmounting after a newer mount may not clear the new handler.
 * Explicit null registration remains supported by existing callers/tests. */
export function setFileSaveHandler(save: (() => Promise<boolean>) | null): () => void {
  saveCurrent = save;
  return () => {
    if (saveCurrent === save) saveCurrent = null;
  };
}

/** 用户选了「保存」时调用 —— 返回是否成功(失败则不切换)。 */
export async function saveCurrentPreview(): Promise<boolean> {
  if (saveCurrent === null) return false;
  return saveCurrent();
}

export const useFileViewStore = create<FileViewState>((set) => ({
  target: null,
  dirty: false,
  setDirty: (dirty) => set({ dirty }),
  /**
   * **打开一个文件 = 中间显示它 + 右栏切到流程图页 + 把主对话展开。**
   *
   * 用户 2026-09-21：「双击在中间显示的话，侧边是**自动切换到流程图页面**，并且把
   * **主对话展开**」，「项目文件打开的话，也是同样的逻辑，**主对话自动在侧边展开**」。
   *
   * ## 为什么收在这一处
   *
   * `open()` 是"中间开始看一个文件"的**唯一入口**（左栏单击/双击、文件树、模版库都
   * 走它）。把这三件事放这里，那些调用点一行都不用改，也不会各自漂移 —— 这个仓库
   * 反复踩过"同一个动作几份实现"的坑（硬规矩第 2 条）。
   *
   * ## 为什么是"展开主对话"而不是"切到某个 tab"
   *
   * 中间被文件占住之后，主对话就没地方站了 —— 而用户这时候多半还想跟它说话（"帮我看看
   * 这段"）。所以把它放到右栏那个列表的最上面并**展开**，是让"文件占着中间"这件事不至于
   * 把对话挤没。
   *
   * ⚠️ **延迟 import 是有意的**：`sessionStore` 那边也不小，而这两个 store 之间
   * 目前没有依赖（`sessionStore` 不 import 本文件）。用动态 `import()` 保持这一点，
   * 免得将来某次改动把它变成循环依赖 —— 那种问题在启动时才炸，很难查。
   */
  open: (target) => {
    // 在写入之前先看一眼中间是不是已经在显示文档 —— set 之后这个判据永远为真。
    const prevTarget = useFileViewStore.getState().target;
    const request = ++leaveRequestSeq;
    // Reopening the current file is a true no-op: changing target identity
    // would rerun FileViewer's [target] fetch and reload PDFium over edits.
    // Still invalidate any older pending leave confirmation above.
    const sameFile = prevTarget !== null && sameTarget(prevTarget, target);
    if (sameFile) return;
    // 【UI-012】真正执行切换这一下。有未保存改动时，先由登记进来的离开确认
    //(`setFileOpenGuard`，FileViewer 挂载时登记)**问过用户**再走到这里 ——
    // 从前无论如何都静默 `set({ target })`，于是没点「保存批注」就切文件时，
    // 内存里的批注无声消失。确认通过(或本就没有未保存改动)才真正切。
    const proceed = (): void => {
      if (request !== leaveRequestSeq || useFileViewStore.getState().target !== prevTarget) return;
      set({ target, dirty: false });
      void import("./sessionStore.js").then(({ useSessionStore, isCenterShowingDocument }) => {
        const st = useSessionStore.getState();
        // **例外（2026-09-27）**：主页面本来就是文档页（上一份预览还在，或正开着可编辑
        // 文件）→ 右栏保持现状，不再展开主对话。判据与 `openFileInIde` 共用一份。
        if (prevTarget != null || isCenterShowingDocument(st)) return;
        st.setRightOpen(true);
        st.setRightPanelTab("flow");
        // 展开主对话（它和子对话共用 `activeSideChatId`，见 `MainSessionRow`）。
        const main = st.activeSessionId;
        if (main) void st.selectSideChat(main);
      });
    };
    // 有未保存改动 + 有人在看当前预览 → 交给它弹确认(保存/放弃/取消);
    // 切到**同一个**目标不必问(没有任何东西会丢)。
    if (useFileViewStore.getState().dirty && prevTarget !== null && !sameFile) {
      // A missing/dialog-unmounted guard is NOT permission to discard edits.
      // Keep the current file intact until an actual confirmation is available.
      if (openGuard !== null) openGuard(target, proceed);
      return;
    }
    proceed();
  },
  close: () => {
    // 【UI-012】关预览也是"离开当前文件" —— 有未保存改动时同样先问，别静默丢掉。
    const previous = useFileViewStore.getState().target;
    const request = ++leaveRequestSeq;
    const proceed = (): void => {
      if (request !== leaveRequestSeq || useFileViewStore.getState().target !== previous) return;
      set({ target: null, dirty: false });
    };
    if (useFileViewStore.getState().dirty && previous !== null) {
      if (openGuard !== null) openGuard(null, proceed);
      return; // Missing confirmation UI must never erase unsaved annotations.
    }
    proceed();
  },
}));

/** 路径的最后一段 —— 顶栏显示名。两条来源都有路径,统一在这里取。 */
export function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 取扩展名(小写,不含点)。无扩展名给空串。 */
export function extOf(p: string): string {
  const base = basenameOf(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 两个预览目标是不是同一个文件(同来源、同 ref、同 relPath/which)。 */
function sameTarget(a: FileViewTarget, b: FileViewTarget): boolean {
  if (a.source.kind !== b.source.kind) return false;
  if (a.source.kind === "library" && b.source.kind === "library") {
    return a.source.ref === b.source.ref && a.source.relPath === b.source.relPath && a.source.which === b.source.which;
  }
  if (a.source.kind === "project" && b.source.kind === "project") {
    return a.source.ref === b.source.ref;
  }
  return false;
}
