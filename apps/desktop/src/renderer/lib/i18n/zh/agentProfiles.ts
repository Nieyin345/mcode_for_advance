/**
 * 代理档案页（components/settings/workflows/AgentProfilesView 与 agentProfileGroups）。
 * Keys: `settings.agentProfiles.*`。
 *
 * ⚠️ 与 `settings.workflows.*` 里那几条 `profile*` 键**分开**是故意的:那些键长在画布
 * 与节点检查器上(「存为档案」「套用一份档案」),这一批只长在这一页上。合成一处的话,
 * 改这一页的文案要去动一个名字里带工作流的文件,而"哪些字是这一页的"就没法一眼看全。
 */
export const zh = {
  // ── 页签与左栏 ──
  // 页签名与设置导航的「代理档案」同一件事,所以用同一个词。
  "settings.workflows.tabProfiles": "代理档案",
  "settings.agentProfiles.byType": "按节点类型",
  "settings.agentProfiles.draftBadge": "未保存",
  // 左栏那一行是"哪个类型的档案"。类型名与分类名来自清单（数据），这里只管界面词。

  // ── 右栏 ──
  "settings.agentProfiles.emptyGroup": "这一类下还没有档案。",
  "settings.agentProfiles.newInGroup": "在这个类型下新建一份",
  // 有档案在磁盘上但读不出来的那一块。不去静默丢掉，是因为用户看到的现象会是
  // "我存的档案不见了"，而这一页是他唯一能知道为什么的地方。
  "settings.agentProfiles.brokenFiles": "有 {n} 个档案文件读不进来",
} as const;
