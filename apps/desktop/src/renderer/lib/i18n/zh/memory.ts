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
  // 整理只产生建议；勾选、确认、版本校验以后才逐条删除（没有自动合并）。
  "memory.reviewOpen": "整理记忆",
  "memory.reviewClose": "收起整理",
  "memory.reviewTitle": "人工整理 · 过期与疑似重复",
  "memory.reviewDesc": "过期仅按更新时间（超过 90 天）估算；同标题或相近正文仅为疑似重复。先逐条查看，必要时在编辑器手动合并，再决定删哪条。扫描不会删文件。",
  "memory.reviewRefresh": "重新扫描",
  "memory.reviewFailed": "扫描失败：{error}",
  "memory.reviewSummary": "共 {total} 条；过期 {shown}/{stale} 条；疑似重复 {pairs}/{pairTotal} 对（扫描 {scanned} 条）。",
  "memory.reviewStale": "可能已过期",
  "memory.reviewDuplicates": "疑似重复（两份正文可能不同）",
  "memory.reviewEmpty": "本次没有找到维护候选。",
  "memory.reviewStaleLimit": "过期候选只显示最旧的 100 条，请分批复核。",
  "memory.reviewDuplicateLimit": "重复检查只覆盖最近的 200 条；更早的文件尚未检查。",
  "memory.reviewPairLimit": "疑似重复对只显示评分靠前的 100 对，请先分批处理再重新扫描。",
  "memory.reviewLong": "{count} 条正文过长，未参与重复比较：{paths}",
  "memory.reviewUnreadable": "{count} 条读取失败，未给出删除候选：{paths}",
  "memory.reviewNoDate": "未知时间",
  "memory.reviewNoPreview": "（正文为空）",
  "memory.reviewOpenFile": "查看正文",
  "memory.reviewSelect": "勾选待删除：{path}",
  "memory.reviewDirty": "请先保存或取消编辑器中的改动／新建草稿，再查看或删除建议。",
  "memory.reviewOutdated": "记忆库在扫描后发生变动；请重新扫描、复核后再删除。",
  "memory.reviewBoth": "不能把同一疑似重复对的两份都勾选删除；至少留下一份。",
  "memory.reviewSelectHint": "默认不勾选。选中文件后须再次确认；这里只执行删除，不会自动合并。",
  "memory.reviewDelete": "删除所选（{count}）",
  "memory.reviewConfirmTitle": "确认删除所选 {count} 条记忆？",
  "memory.reviewConfirmDesc": "以下文件将从磁盘永久删除、不可恢复。请确认已查看差异，若要合并请先手动保存合并后的正文：",
  "memory.reviewDeleted": "已删除 {count} 条。请重新扫描以查看剩余建议。",
  "memory.reviewDeleteFailed": "已删除 {count} 条，其余未继续：{error}。请重新扫描后再操作。",
} as const;
