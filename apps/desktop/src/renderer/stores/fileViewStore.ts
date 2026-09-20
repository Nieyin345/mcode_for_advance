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
 * 左右两边隔着好几层(左栏 `LibrarySection` / `TemplateSection`,中间
 * `UnifiedTabbedPane`),而且左栏在两套外壳里各挂一次(树 / 会话流),切一次整个
 * 重挂载。回调 prop 传不下去,只能靠 store —— 与 `templateStore.previewFile`
 * 当年那条理由逐字相同。
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
  /** 文献库条目。`ref` 是条目 id,可选 `relPath`(目录条目里往下翻)。 */
  | { kind: "library"; ref: string; relPath?: string }
  /** 模版库里的一个文件。 */
  | { kind: "template"; ref: { kind: string; dirName: string; relPath: string } }
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
  /** 在中间打开一个文件。 */
  open: (target: FileViewTarget) => void;
  /** 关掉。中间回到原来的会话标签。 */
  close: () => void;
}

export const useFileViewStore = create<FileViewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
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
