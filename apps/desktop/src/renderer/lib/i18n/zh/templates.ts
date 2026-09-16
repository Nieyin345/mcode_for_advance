/**
 * 模版库(设置 → 模版库)的文案。
 *
 * 一条模版 = 模版根目录下的一个**文件夹**,目录名就是显示名。所以这里的措辞刻意
 * 强调"文件夹"这件事 —— 用户需要知道自己在磁盘上动的东西就是这里列的东西。
 */
export const zh = {
  "settings.nav.templates": "模版库",
  "settings.templates.title": "模版库",
  "settings.templates.desc":
    "放常用的模版：PPT、论文 LaTeX、Word、代码、以及「一组图 + 一份代码」的配图模版。每一条就是一个文件夹——你也可以直接在资源管理器里往里面放文件，回到这里会自动显示出来。",
  "settings.templates.kind.ppt": "PPT",
  "settings.templates.kind.latex": "论文 LaTeX",
  "settings.templates.kind.word": "Word",
  "settings.templates.kind.code": "代码",
  "settings.templates.kind.image": "图片",

  "settings.templates.newName": "新建模版：先起个名字",
  "settings.templates.nameRequired": "先给模版起个名字——它会成为文件夹名。",
  "settings.templates.pickFiles": "选择文件…",
  "settings.templates.pickFolder": "选择文件夹…",
  "settings.templates.empty": "这个类目还没有模版",
  "settings.templates.fileCount": "{n} 个文件",
  "settings.templates.imagePair": "{img} 张图 · {code} 份代码",
  "settings.templates.reveal": "打开文件夹",
  "settings.templates.openFailed": "打开失败",
  "settings.templates.delete": "删除模版",
  // 删除**只是移进回收站**(可逆);真正不可逆的那一下在回收站里,见 templates.ctx.purgeConfirm
  "settings.templates.deleteConfirm":
    "把模版「{name}」移到回收站？里面的文件会一起搬过去。之后可以还原，也可以在回收站里彻底删掉。",

  /* ── 对话框里的模版选择器(composer 的「+」菜单 → 模版) ──
     与文献库那两个入口(`library.action.addToContext` / `library.chat.*`)
     刻意用同一套措辞,用户看到的是同一件事的两份拷贝。 */
  "templates.chat.addToContext": "添加模版到上下文",
  "templates.chat.searchPlaceholder": "搜索模版（名字或类目：latex、ppt…）",
  "templates.chat.addN": "添加 {n} 个",
  "templates.chat.alreadyAdded": "已在上下文中",
  "templates.chat.empty": "模版库还是空的",
  "templates.chat.emptyHint": "在 设置 → 数据位置 → 模版库 里添加，或直接往模版文件夹里放文件。",
  "templates.chat.noMatch": "没有匹配的模版",
  "templates.chat.loadFailed": "读取模版列表失败",

  /* ── 左栏的「模版」段 ──
     与它上面那一段「文档」(文献库)是同一套版式与手感:类目标签 + 可展开的行 +
     右键菜单。所以这组键的措辞刻意与 library.* 对齐,两段读起来是一个体系。 */
  "templates.section.title": "模版",
  "templates.section.new": "新建模版",
  "templates.section.namePlaceholder": "模版名字（会成为文件夹名）",
  "templates.section.loadFailed": "读不出模版列表",
  "templates.section.moreFiles": "还有 {n} 个文件未列出",
  /** 「全部<类目>」那一行 —— 与文献库里「全部文献 / 全部教材 / 全部笔记」逐字同款,
   *  永远在最上面。它也可挂进对话(`t:<类目>`),给的是索引而不是整套正文。 */
  "templates.section.all": "全部{kind}模版",
  /** 回收站 —— 每个类目各一个,**永远在最下面**。删除只是移进来,真正的删除在这里做。 */
  "templates.section.trash": "回收站",
  "templates.section.trashEmpty": "回收站是空的",
  "templates.ctx.attachToChat": "添加到当前对话",
  /** 改名 = 把那条模版在磁盘上的目录改名(目录名就是显示名)。与文献库那边
   *  分类行的「重命名」同一个位置、同一套手感。 */
  "templates.ctx.rename": "重命名",
  "templates.ctx.restore": "还原",
  "templates.ctx.purge": "彻底删除",
  "templates.ctx.purgeConfirm":
    "彻底删除「{name}」？这个文件夹会从磁盘上删掉，里面的文件一并消失，不能还原。",
  /** 还原 / 彻底删除失败时弹的那一条的标题(正文是主进程给的原因)。 */
  "templates.ctx.actionFailed": "操作失败",
  "templates.ctx.openExternal": "用外部程序打开",
  /** 文件行右键的第一项 —— 读正文显示在右栏(见 TemplatePanel)。 */
  "templates.ctx.preview": "应用内预览",

  /* ── 右栏的「模版」面板:应用内预览一个模版文件 ──
     文本 / 代码、图片、**Word / Excel / PPT(真渲染版式)**都在应用内看;PDF 没有
     应用内预览 —— 那一种如实说明并给「用外部程序打开」。 */
  "templates.preview.title": "模版文件",
  "templates.preview.empty": "在左栏的「模版」里点一个文件,内容显示在这里",
  "templates.preview.rendering": "正在排版…",
  "templates.preview.docxFailed":
    "这份 Word 在应用内排不出来(可能是加密的、或者用了还没支持的格式)。用「用外部程序打开」看原样。",
  "templates.preview.xlsxFailed":
    "这份表格在应用内排不出来(可能是加密的、或者用了还没支持的表格特性)。用「用外部程序打开」看原样。",
  "templates.preview.pptxFailed":
    "这份演示稿在应用内排不出来(可能是加密的,或者用了库里还没做的那几种图形)。用「用外部程序打开」看原样。",
  "templates.preview.truncated": "文件比较大,这里只显示了开头(共 {size})—— 用「用外部程序打开」看全",
  "templates.preview.binary":
    "这个文件在应用内看不了(不是文本,也不是能直接显示的图片)。用「用外部程序打开」看。",
  "templates.preview.tooLarge": "文件太大({size}),应用内不预览。用「用外部程序打开」看。",
  "templates.preview.actionFailed": "操作失败",
  "templates.preview.emptyFile": "（这个文件是空的）",
} as const;
