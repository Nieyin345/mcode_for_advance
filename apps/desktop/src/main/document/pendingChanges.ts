/**
 * 【Office 深度集成】**统一的"待审改动"模型** —— 左栏能混排六种来源的前提。
 *
 * ## 为什么需要统一抽象
 *
 * 六种编辑器表达"一处改动"的方式完全不同（全部实测自源码）：
 *
 * | 编辑器 | 改动怎么表达 | 证据 |
 * |---|---|---|
 * | docs | ProseMirror 的 `ins`/`del` Mark，带 `author`/`date` | `editor/marks.ts:179-236` |
 * | sheets | 一批 `propose_operations`（单元格 DSL） | `ai/tools.ts:1273` |
 * | slides | 一批 `apply_ops`（元素级） | `ai/slides-skill.ts:736` |
 * | pdf | pending edits 队列（待写回 PDF） | `App.tsx:8920-8934` |
 * | markdown | `apply_ops` + `target:"selection"`，**没有修订** | `editor/ops.ts:18,525` |
 * | html | `apply_ops` + `sid`，**没有修订** | `ai/tools.ts:283-300` |
 *
 * 如果左栏直接认这六种形状，它会退化成六个 `if` 分支，而且每加一种编辑器就要改 UI。
 *
 * ## 抽象成什么
 *
 * 一条 {@link PendingChange} 只回答左栏需要的四件事：
 *
 *   1. **在哪** —— 一个可跳转的定位（块号 / 单元格 / 元素 id / 页码）；
 *   2. **原来是什么、变成什么** —— 用于显示 diff 与执行"拒绝 = 还原"；
 *   3. **谁改的** —— 只用来上色（`author`），**不用来分流处理逻辑**。
 *      产品决定：人和 AI 走同一套机制，只是颜色不同；
 *   4. **这是什么类型的改动** —— 插入 / 删除 / 替换 / 结构性变更（调整格式、移动等）。
 *
 * ## 它刻意不做什么
 *
 * - **不存改动内容**：`before`/`after` 是**给人看的摘要**（可能被截断），
 *   真正应用/回滚由各编辑器自己的实现负责 —— 本模块不重新实现一遍 diff 应用。
 * - **不判断能不能接受**：有的改动（例如依赖实时公式求值的）可能只读。
 *   那由产生它的适配器在 `capabilities` 里声明。
 * - **不管顺序**：条目按 {@link PendingChange.location} 排序是 UI 的事，不是模型的事。
 */

/** 六种编辑器。与 `GenofficeApp` 同集，但这里单独列，避免依赖路由模块。 */
export type RevisionEditor = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

/**
 * 一处改动在文档里的位置。
 *
 * 每种编辑器用自己最自然的寻址方式，**左栏只认 `label`**（给人看的那一行）
 * 和 `order`（用来按文档顺序排列）。`anchor` 是给"点击条目跳到正文"用的，
 * 结构由各适配器定义 —— 左栏原样转交给对应编辑器，不解释它。
 */
export interface RevisionLocation {
  /**
   * 文档顺序的排序键：小的在前。
   *
   * 不同编辑器量纲不同（块号 / 行号 / 页码 / 元素序号），**只在同一编辑器内可比**。
   * 左栏按 `editor` 分组时不需要跨量纲比较；若将来要混排，由调用方给定统一标尺。
   */
  order: number;
  /** 给人看的定位描述，例如「第 3 段」「Sheet1!B4」「第 5 页」「元素 e_12」。 */
  label: string;
  /** 跳转锚点（结构由各编辑器定义，宿主不解释）。 */
  anchor?: RevisionAnchor;
}

/** 各编辑器自定义的跳转锚点。 */
export type RevisionAnchor =
  | { kind: "block"; block: number }
  | { kind: "cell"; sheet: string; address: string }
  | { kind: "element"; slide: number; elementId: string }
  | { kind: "page"; page: number; text?: string }
  | { kind: "range"; from: number; to: number }
  | { kind: "unknown" };

/** 改动类型。左栏据此选图标，也据此决定"拒绝"时怎么描述。 */
export type RevisionKind = "insert" | "delete" | "replace" | "format" | "move" | "structural";

/** 改动来自谁 —— **只用于上色**，不用于分流。 */
export interface RevisionAuthor {
  /** 稳定标识：`"ai"` / `"user"` / 未来的协作方 id。 */
  id: string;
  /** 显示名（"AI 助手" / "我"）。 */
  label: string;
}

/** 一条待审改动。 */
export interface PendingChange {
  /** 全局唯一 id（同一编辑器内不重复即可；跨编辑器拼 `editor:id`）。 */
  id: string;
  editor: RevisionEditor;
  /** 这次改动属于哪个文档（物理路径，供宿主校验归属）。 */
  filePath: string;
  location: RevisionLocation;
  kind: RevisionKind;
  /**
   * 改动前后的**摘要文本**，给左栏显示与给人核对。
   *
   * ⚠️ 可能被截断（保持条目可读）。真正应用/回滚不读这两个字段 ——
   * 那是产生这条改动的适配器的职责。
   */
  before?: string;
  after?: string;
  author: RevisionAuthor;
  /** 产生时间（`Date.now()`），用于稳定排序与"最近改动"提示。 */
  at: number;
  /**
   * 这条改动能不能被接受/拒绝。
   *
   * 默认能。某些改动（例如依赖实时公式求值的表格改动）可能只读 ——
   * 那种情况下左栏显示条目但按钮禁用，并给出 `readOnlyReason`。
   */
  capabilities?: { accept?: boolean; reject?: boolean; readOnlyReason?: string };
}

/** 一次改动批次 —— 一条 AI 指令往往产生多条改动，左栏要把它们归在一起看。 */
export interface PendingChangeBatch {
  /** 批次 id（与产生它的那次工具调用同源）。 */
  batchId: string;
  editor: RevisionEditor;
  filePath: string;
  changes: PendingChange[];
  at: number;
}

/** 左栏要显示的一条评论。 */
export interface RevisionComment {
  id: string;
  filePath: string;
  location: RevisionLocation;
  author: RevisionAuthor;
  text: string;
  at: number;
  /** 回复（按时间顺序）。 */
  replies: Array<{ id: string; author: RevisionAuthor; text: string; at: number }>;
  /**
   * 已 resolve 的评论**不删除**，只是移出主列表（Overleaf 的行为）。
   * 理由：复核场景里"这条当初为什么提"经常有用。
   */
  resolved: boolean;
}

/** 一个编辑器当前的复核状态 —— 左栏据此决定显示什么。 */
export interface RevisionState {
  editor: RevisionEditor;
  filePath: string;
  /** 编辑模式 or 复核模式。AI 默认复核；人可切换。 */
  mode: "edit" | "review";
  changes: PendingChange[];
  comments: RevisionComment[];
}

/**
 * 按文档顺序排序一组改动。
 *
 * **只在同一编辑器内调用**：不同编辑器的 `order` 量纲不同，跨编辑器比较没有意义。
 */
export function sortChanges(changes: readonly PendingChange[]): PendingChange[] {
  return [...changes].sort((a, b) => {
    if (a.location.order !== b.location.order) return a.location.order - b.location.order;
    // 同位置时按时间稳定排序（同一处的多处改动按产生的先后）。
    return a.at - b.at;
  });
}

/** 把条目按编辑器分组（左栏混排多文件时用）。 */
export function groupByEditor(changes: readonly PendingChange[]): Map<RevisionEditor, PendingChange[]> {
  const out = new Map<RevisionEditor, PendingChange[]>();
  for (const change of changes) {
    const list = out.get(change.editor) ?? [];
    list.push(change);
    out.set(change.editor, list);
  }
  for (const [key, list] of out) out.set(key, sortChanges(list));
  return out;
}

/** 未 resolve 的评论（主列表要显示的那些）。 */
export function openComments(comments: readonly RevisionComment[]): RevisionComment[] {
  return comments.filter((comment) => !comment.resolved);
}

/** 已 resolve 的评论（放在左上角入口里，不是删除）。 */
export function resolvedComments(comments: readonly RevisionComment[]): RevisionComment[] {
  return comments.filter((comment) => comment.resolved);
}

/** 一条改动能不能接受。缺省 `capabilities` = 可以。 */
export function canAccept(change: PendingChange): boolean {
  return change.capabilities?.accept !== false;
}

/** 一条改动能不能拒绝。缺省 `capabilities` = 可以。 */
export function canReject(change: PendingChange): boolean {
  return change.capabilities?.reject !== false;
}
