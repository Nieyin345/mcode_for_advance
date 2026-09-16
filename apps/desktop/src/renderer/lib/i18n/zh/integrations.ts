/**
 * 外部集成(设置 → 外部集成)的文案。
 *
 * 与 `library.ts` 里的机构认证分开一个文件:那一节是「登录态」,这一节是「第三方
 * 服务的 API Key」,两件事。用户的预期是「以后还会有更多集成进来」,所以每加一家
 * 只在这里补 `settings.integrations.<id>.name` / `.desc` 两条。
 */
export const zh = {
  "settings.nav.integrations": "外部集成",
  "settings.integrations.title": "外部集成",
  "settings.integrations.desc":
    "接入第三方的论文服务。密钥在这里输入一次,由主进程用系统凭据库加密后保存在本机(与自定义模型同一套机制),界面只显示打码串,明文不落盘。",
  "settings.integrations.servicesTitle": "已接入的服务",
  "settings.integrations.getKey": "去官网获取密钥",  "settings.integrations.configured": "已配置",
  "settings.integrations.keyPlaceholder": "粘贴 API 密钥",
  "settings.integrations.keyPlaceholderSet": "已保存 {masked} —— 重新粘贴可覆盖",
  "settings.integrations.save": "保存",
  "settings.integrations.saved": "已保存",
  "settings.integrations.clear": "清除",
  "settings.integrations.test": "测试连接",
  "settings.integrations.testing": "测试中…",

  "settings.integrations.mineru.name": "MinerU",
  "settings.integrations.mineru.desc":
    "把 PDF 转成 Markdown。导入的文献会自动转换;对话里加入文献库时 AI 读的就是转换后的 Markdown,排版、公式、表格都能保留。",

  // 文献转换情况的批量检测(放在集成页,因为它查的正是 MinerU 配没配对、生效没有)
  "settings.integrations.statsTitle": "文献转换情况",
  "settings.integrations.statsDesc":
    "统计库里有多少篇已经转成 Markdown。没有转换产物的文献,AI 读不到正文、全文检索也搜不到。",
  "settings.integrations.statsTotal": "库里共 {n} 篇",
  "settings.integrations.statsConverted": "已转 {n} 篇",
  "settings.integrations.statsPending": "未转 {n} 篇",
  "settings.integrations.statsEmpty": "库里还没有文献",
  "settings.integrations.convertPending": "转换未转的 {n} 篇",
  "settings.integrations.convertAll": "全部重转",
  "settings.integrations.convertAllConfirm":
    "把库里所有文献都重新转换一遍？这会重新上传 PDF 并消耗 MinerU 的额度（共 {n} 篇）。只想补没转的话点「转换未转的」。",
  "settings.integrations.convertRunning": "转换中…",
  "settings.integrations.convertDone": "已转换 {n} 篇",
  "settings.integrations.convertFailed": "{n} 篇失败",
  "settings.integrations.convertNonePending": "没有待转换的文献",
  "settings.integrations.convertOne": "重转这篇",
  "settings.integrations.reasonNoMd": "还没转 Markdown",
  "settings.integrations.reasonNoAssets": "有 {n} 张图没落盘",
} as const;
