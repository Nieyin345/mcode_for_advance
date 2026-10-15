/**
 * 生成带前缀的本地 id —— 文献库三个单元（条目/集合/笔记/链接）共用。
 *
 * 与 `customModel` 的 `cm_...` 同构：前缀区分实体类型，便于在日志与错误信息里
 * 一眼看出这是什么。**从前它住在 `repositories.ts` 里、只被下面几行引用**，
 * 拆分后单独成一个文件 —— 它是**唯一**被多个单元引用的辅助函数（其余单元各自自足）。
 */
export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
