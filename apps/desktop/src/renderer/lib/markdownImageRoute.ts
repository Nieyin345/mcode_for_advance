/**
 * 【MC-087 / 第 50.3 章】Markdown 本地图片的**读取路由**决策 —— 纯函数(不碰 DOM / store /
 * React),既是 `components/chat/Markdown.tsx` 的唯一实现,也供回归套件直接驱动。
 *
 * 为什么抽出来:第 50.3 章的独立 E1 证明,「库条目上下文里越界的图片」会**回退到通用**
 * `file.readBinary`(`MC087_RENDER_E1: within=false, routedTo=file.readBinary`)—— 库预览
 * 因此借用了别的项目级读取范围。这条判定此前写死在组件 `useEffect` 里,既不好测,也容易在
 * 改动中被绕过。抽成三态纯函数后,路由是**一处**的、可被行为断言钉住。
 *
 * 三态准入(第 50.3 章要求):
 *   - **project**:无库条目上下文(纯项目 md)→ 通用 `file.readBinary`;
 *   - **library**:有库条目上下文且路径**确在条目可信根之内** → `library.readAsset`
 *     (主进程按可信条目 id + 根校验决定真正授权);
 *   - **denied**:有库条目上下文但路径**不在根之内**(跨项目绝对路径、另一个 linked 条目、
 *     `../`、symlink/junction 逃逸)→ **明确拒绝**,**绝不**回退通用 `file.readBinary`。
 *     renderer 的路径换算只用于**用户体验**,不是授权判据。
 */
import { relativePath } from "./path.js";

export type MarkdownImageRoute =
  | { kind: "project" }
  | { kind: "library"; relPath: string }
  | { kind: "denied" };

/**
 * ⚠️ `relativePath` 在"不在 root 之下"时**原样返回绝对路径**(防御性),所以判据不能只看
 * `!startsWith("..")` —— 那样绝对路径(含盘符/前导 `/`)会被误当 relPath。要求结果**既非空、
 * 也不含盘符/前导分隔、也不以 `..` 开头**,才算合法子路径。
 */
export function resolveMarkdownImageRoute(
  filePath: string,
  library: { id: string; rootAbs: string } | null | undefined,
): MarkdownImageRoute {
  if (library == null) return { kind: "project" };
  const rel = relativePath(filePath, library.rootAbs);
  const relIsSub =
    rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith("/");
  if (!relIsSub) return { kind: "denied" };
  return { kind: "library", relPath: rel };
}
