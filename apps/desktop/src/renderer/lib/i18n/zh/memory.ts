/**
 * 设置 → 记忆库（components/memory/MemoryExplorerPanel）。
 * Keys: `memory.*`。左栏分类/文件列表 + 右侧编辑器的文案。
 */
export const zh = {
  // 六类目录（rules/project/preferences/experiences/failures/decisions）的名字是数据,
  // 原样显示 —— 这里只管界面动作的说法。
  "memory.pickHint": "左边选一个文件看看。",
  "memory.categoryEmpty": "这一类还没有文件。",
  "memory.newFile": "新建文件",
  "memory.fileNamePlaceholder": "文件名（不含扩展名）",
  "memory.fileNameInvalid": "文件名不能为空，也不能带斜杠。",
  // 右栏顶部的状态行:干净/未存/结果。
  "memory.dirty": "有改动还没保存",
  "memory.saved": "已保存",
  "memory.saveFailed": "存不下去：{error}",
  "memory.deleteFailed": "删不掉：{error}",
  "memory.readFailed": "读不出来：{error}",
  "memory.loadFailed": "记忆文件读不出来：{error}",
  // 删除确认(ConfirmDialog 的标题与说明)。
  "memory.deleteTitle": "删除「{name}」？",
  "memory.deleteDesc": "这个记忆文件会从磁盘上删掉，不可恢复。",
  // 新建出来的文件在保存之前只是草稿,列表里还没有它。
  "memory.draft": "（未保存）",
} as const;
