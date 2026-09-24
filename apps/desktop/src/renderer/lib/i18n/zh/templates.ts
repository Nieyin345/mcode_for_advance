/**
 * 五个类目名 + 预览那几条仍被引用的文案。
 *
 * ⚠️ **这个文件原来的大部分键已经删掉了**(2026-09-24)。模版库并进统一资料库之后,
 * 独立的模版入口(左栏模版段 / 聊天框「+」菜单的模版库 / 设置页模版面板 /
 * `templates/TemplatePanel`)全部撤掉,它们用的键跟着变成孤儿。
 *
 * **留着的是仍被引用的那几条**:
 *   - `settings.templates.kind.*` —— `templateLabels.ts` 的类目名映射(活的);
 *   - `templates.section.all` —— 挂「整个类目」时 chip 上的字(活的);
 *   - `templates.ctx.openExternal` —— `FileViewer` 顶栏那条出口;
 *   - `templates.preview.*Failed` / `rendering` / `emptyFile` —— office 预览组件
 *     (`DocxPreview` / `PptxPreview` / `XlsxPreview`)还在用,它们同时服务
 *     统一资料库里的条目。
 */
export const zh = {
  "settings.templates.kind.ppt": "PPT",
  "settings.templates.kind.latex": "论文 LaTeX",
  "settings.templates.kind.word": "Word",
  "settings.templates.kind.code": "代码",
  "settings.templates.kind.image": "图片",

  /** 「全部<类目>模版」那一行,也是挂整类目时 chip 上的字 —— 与文献库
   *  「全部文献 / 全部教材 / 全部笔记」逐字同款。 */
  "templates.section.all": "全部{kind}模版",

  /* ── 应用内预览一个 office 文件(中间栏 `FileViewer`)──
     文本 / 代码、图片、**Word / Excel / PPT(真渲染版式)**都在应用内看。 */
  "templates.ctx.openExternal": "用外部程序打开",
  "templates.preview.rendering": "正在排版…",
  "templates.preview.docxFailed":
    "这份 Word 在应用内排不出来(可能是加密的、或者用了还没支持的格式)。用「用外部程序打开」看原样。",
  "templates.preview.xlsxFailed":
    "这份表格在应用内排不出来(可能是加密的、或者用了还没支持的表格特性)。用「用外部程序打开」看原样。",
  "templates.preview.pptxFailed":
    "这份演示稿在应用内排不出来(可能是加密的,或者用了库里还没做的那几种图形)。用「用外部程序打开」看原样。",
  "templates.preview.emptyFile": "（这个文件是空的）",
} as const;
