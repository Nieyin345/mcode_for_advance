/**
 * 文献库附件在界面上的文案 —— kind 退役后只剩 chip 标签这一件事。
 *
 *   `c:<分类 id>` / `i:<条目 id>` / `g:<大类 id>` —— chip 显示名就是用户自己起的
 *   名字,主进程给的 `name` 正是它,直接用。（`k:<库>` 随 kind 退役删除。）
 *
 * 认不出来的键也退回主进程给的 `name`(总比显示一个空 chip 强)。
 */
export function libraryAttachChipLabel(_key: string, name: string): string {
  return name;
}
