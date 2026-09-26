/**
 * 文献库区域文案。键名遵循本区域的 `library.` 前缀约定。
 * zh 是 `MessageId` 的事实源 —— 新增键先加在这里。
 */
export const zh = {
  // 入口与标题
  "library.title": "文献库",
  "library.docs.title": "文档",
  "library.subtitle": "管理本地文献集合，供 AI 阅读与引用",
  "library.open": "文献库",

  // 左栏:智能视图与集合
  "library.view.all": "全部文献",
  "library.view.recent": "最近添加",
  "library.view.missingPdf": "未下载 PDF",
  "library.view.needsLogin": "需要登录",
  "library.collections": "分类",
  "library.collection.new": "新建分类",
  "library.collection.namePlaceholder": "分类名称",
  "library.collection.create": "创建",
  "library.collection.cancel": "取消",
  "library.collection.duplicateName": "已有同名分类",
  "library.collection.rename": "重命名",
  "library.collection.delete": "删除分类",
  /** ⚠️ 说的是**分类**不是库 —— 「文献库」在这个产品里指整个库（论文/教材/笔记），
   *  而这一条删的是树上的一个节点。原来写成「删除文献库」会让用户以为整个库要没了。 */
  "library.collection.deleteConfirm": "删除分类「{name}」？里面的文献不会被删除，只是不再属于这个分类。",
  "library.collection.empty": "这个分类还没有文献",

  // 左栏管理:大类(段落)与小类(tab)的新建/删除/重命名都在左栏右键完成
  "library.group.rename": "重命名大类",
  "library.group.new": "新建大类",
  "library.group.delete": "删除大类",
  "library.group.deleteConfirm": "删除大类「{name}」？里面的类型会变成未分组（左栏不再显示），数据不会删。",
  "library.group.namePlaceholder": "大类名称",
  "library.group.emptyHint": "所有大类都被删掉了 —— 输入名字新建一个，数据都还在。",
  "library.kind.new": "新建小类",
  "library.kind.rename": "重命名小类",
  "library.kind.delete": "删除小类",
  /** 「小类」= tab 那一层。
   *
   *  ⚠️ **必须点出"条目会从左栏消失"**（2026-09-21）。2026-09-21 起内置的那几个
   *  （论文/教材/笔记…）也能删了，而删掉之后**名下的条目没有入口能看见** ——
   *  数据还在库里，但左栏不再有它们的 tab。不说这句，用户删完会以为东西丢了。 */
  "library.kind.deleteConfirm": "删除小类「{name}」？它名下的条目**会从左栏消失**（数据还在库里，只是没有入口显示它们了）。",
  "library.kind.builtinLocked": "内置类型不能删除",
  "library.kind.namePlaceholder": "小类名称",
  "library.kind.showAll": "全部显示",
  "library.kind.showCollections": "只看分类",
  "library.kind.purpose.material": "查资料用",
  "library.kind.purpose.format": "照着写用",
  "library.collection.newSub": "新建子分类",
  "library.collection.createFailed": "创建失败",
  "library.collection.moveTo": "移动到",
  "library.collection.moveToTop": "移到最外层",
  "library.collection.moveFailed": "移动失败",
  "library.collection.linkCount": "{n} 条关联",

  // 中栏:列表
  "library.list.count": "{n} 篇",
  "library.list.searchPlaceholder": "搜索标题、作者、摘要",
  "library.list.selected": "已选中 {n} 篇",
  "library.list.empty": "文献库还是空的",
  "library.list.emptyHint": "导入本地的 PDF 文件（自动识别作者与期刊，并转成 Markdown），或用关键词检索、粘贴 DOI / arXiv ID / BibTeX。",
  "library.list.noMatch": "没有匹配的文献",
  "library.list.emptyInCollection": "分类只是视图 —— 东西还在库里，只是不属于这个分类。",
  /** 回收站**空**的时候说的话。
   *
   * ⚠️ 别拿 `library.list.emptyInCollection` 顶（"东西还在库里，只是不属于这个分类"）
   * —— 那句是给**分类**空时用的，在回收站场景下意思正好反了：回收站里的东西
   * 不是"还在库里"，它们就是被丢进来的。 */
  "library.trash.empty": "回收站是空的。",
  "library.list.showAll": "看全部",
  "library.list.filteredOut": "{n} 条被筛选条件挡住了（不在这个视图里显示）",
  "library.list.clearFilters": "清除筛选",
  "library.kind.paper": "文献",
  "library.kind.textbook": "教材",
  "library.kind.note": "笔记",
  "library.view.allInKind": "全部{kind}",

  /* ── 笔记库 ── */
  "library.import.pickNote": "选择 Markdown 文件…",
  "library.import.noteHint": "收进来的 md 会复制一份进笔记库，原文件留在原处。",
  "library.import.noteResult": "收进 {added} 篇 · 跳过 {skipped} 篇（同名）",
  "library.note.new": "新建笔记",
  "library.note.placeholder": "笔记标题",
  "library.note.untitled": "未命名笔记",
  "library.note.create": "新建",
  "library.note.edit": "编辑",
  "library.note.save": "保存",
  "library.note.saved": "已保存",
  "library.note.unsaved": "未保存",
  "library.note.saveHint": "Ctrl+S",
  "library.note.readFailed": "读不出这篇笔记",
  "library.note.saveFailed": "保存失败",
  "library.list.emptyNote": "笔记库还是空的",
  "library.list.emptyHintNote": "收 Markdown 文件进笔记库；同一个库里同名的笔记会自动跳过。",

  // 工具栏
  "library.action.search": "检索",
  "library.action.fullText": "全文检索",
  "library.action.import": "导入",
  "library.action.addToContext": "添加文献库到上下文",
  "library.action.deleteSelected": "移除选中的 {n} 篇",
  "library.action.removeFromLibrary": "彻底删除",
  "library.action.removeConfirm":
    "从库中彻底删除选中的 {n} 篇？数据库记录和磁盘上的 PDF / Markdown 都会被删掉，不能还原。（只是不想让它们待在当前分组里的话，用右键的「从当前文献库移除」——那会把它们收进回收站。）",
  "library.action.refresh": "刷新",

  // 检索
  "library.search.title": "检索外部数据库",
  "library.search.scopeHint": "这里是在 Crossref / arXiv 上找**还没入库**的新文献。要搜已经在库里的，用列表上方的搜索框（搜标题/作者/摘要），或右栏的全文检索（搜已转 Markdown 的正文）。",
  "library.search.placeholder": "关键词，如 graph neural network scheduling",
  "library.search.submit": "检索",
  "library.search.searching": "检索中…",
  "library.search.noResult": "没有找到结果",
  "library.search.addSelected": "加入文献库",
  "library.search.source": "来源",

  // 导入
  "library.import.title": "导入文献",
  "library.import.result": "导入 {added} 篇，跳过 {skipped} 篇重复",
  "library.import.pickPdf": "选择 PDF 文件",
  /** 通用导入（kind 退役后的入口文案）。 */
  "library.import.pickFile": "导入文件…",
  "library.import.pickFolder": "导入文件夹",
  "library.import.explodeFolder": "批量导入文件夹",
  "library.import.hint": "文件夹作为一个条目收进；批量则把里面文件拆开逐个导入",
  "library.import.autoConvert": "导入后自动转 Markdown",
  "library.import.autoConvertHint": "（已经有转录好的 md？取消勾选，节省一次 MinerU API 转录）",
  "library.import.pdfResult": "导入 {added} 份文档，跳过 {skipped} 份重复",
  "library.import.convertFailed": "{n} 篇转 Markdown 失败",
  "library.import.pdfErrors": "{n} 份文件导入或转录失败",
  "library.import.dropHint": "也可以直接把文档拖进来",
  "library.import.dropHere": "松手导入文档",

  // PDF 状态
  "library.pdf.ready": "已有 PDF",
  "library.pdf.none": "无 PDF",
  "library.pdf.openFile": "打开 PDF",
  "library.pdf.revealFile": "在文件夹中显示",
  "library.convert.ready": "已转 Markdown",
  "library.convert.none": "尚未转 Markdown",
  "library.convert.run": "转 Markdown",
  "library.convert.repair": "修复本小类转录并清理失联 Markdown…",
  "library.convert.redo": "重新转换",
  "library.convert.done": "已转换",
  "library.convert.failed": "转换失败",
  "library.convert.revealMd": "在文件夹中显示 Markdown",
  "library.convert.adopt": "用本地 Markdown…",
  "library.convert.adoptHint":
    "已经有转录好的 md？直接挂上，不用再花一次转录额度。同级目录里的 images/ 会一起收进来。",
  "library.convert.adoptDone": "已挂上（含 {n} 张配图）",

  // 左栏文献行的右键菜单
  "library.ctx.moveTo": "移动到",
  "library.ctx.copyTo": "复制到",
  "library.ctx.removeFrom": "从当前分类移除",
  // 回收站里的那个红色项 —— 与上面那句是**两件不同的事**:上面只是移出分组(能捞回来),
  // 这句是记录加磁盘文件一起没。所以文案里必须点出"磁盘上的文件也会被删"。
  "library.ctx.deleteForever": "彻底删除",
  "library.ctx.deleteForeverConfirm":
    "彻底删除《{title}》？数据库记录和磁盘上的 PDF / Markdown 都会被删掉，不能还原。",
  /** 删除确认框（接 `library.deletePreview`）。**这是库里唯一不可逆的操作**，
   *  所以它先把"会跟着一起没的东西"摆出来，让用户一件件勾。 */
  "library.del.title": "删除《{title}》",
  "library.del.ownLine": "这一条本身（记录 + 磁盘文件）一定会删。",
  "library.del.linksHead": "这些也会跟着没 —— 不想删的就把勾去掉：",
  "library.del.linksHeadNoTick": "这些也会跟着没：",
  "library.del.form.item": "库内条目",
  "library.del.form.path": "库外文件（只删关联记录，不动你的文件）",
  "library.del.form.transcript": "转录产物 + 图床（{n} 张图）",
  "library.del.noLinks": "它没有关联别的东西。",
  "library.del.confirm": "删除",
  "library.del.cancel": "取消",
  "library.ctx.openFolder": "在文件夹中打开",
  "library.ctx.openMd": "预览原文（应用内）",
  /**
   * 条目行右键 → **看这一条的转录文本**（2026-09-21）。
   *
   * ★ 用户：「我点击的是 PDF，一直要展示的是关联的 md 转录……现在我要的效果是点击和
   * 双击都显示这个 PDF 本身，**右键加一个功能是能够看这个文件链接的转录**」。
   *
   * 于是"看转录"从**默认行为**降成**一个显式入口** —— 它只在这里出现，不与 PDF 抢。
   */
  "library.ctx.viewTranscript": "查看转录文本",
  /** 「查看转录文本」在还没转过的时候长这样 —— 不给一个点了没反应的菜单项。 */
  "library.ctx.viewTranscriptMissing": "查看转录文本（还没转换）",
  /** 预览顶栏上那个"切回 PDF 本体"的按钮（正在看转录时才画）。 */
  "library.ctx.offerMd": "回到 PDF 原件",
  /** 右键 → 文献信息浮窗（元数据 + 引用 + 摘要）。
   *  与「关联」并列：两个都是"就这一条，看看它是什么/它跟谁一组"。 */
  "library.info.title": "文献信息",
  "library.ctx.openMdMissing": "预览原文（还没转换）",
  "library.ctx.openMdExternal": "用外部编辑器打开 Markdown",
  "library.ctx.newNote": "新建笔记",
  /** 在**分类行**上右键导入 —— 导进来的东西直接归这个分类（不用先导入再拖）。
   *  原来只有右栏那个「导入」条，而它跟着"当前选中的分类"走，用户得先点对地方。 */
  "library.ctx.importHere": "导入到这里",
  "library.ctx.noOtherCollection": "还没有别的分类",
  "library.ctx.attachToChat": "添加到当前对话",
  "library.ctx.attachNoSession": "还没有打开的对话 —— 先在会话列表里选一个",
  "library.ctx.attachFailed": "添加到当前对话失败",

  // 详情
  "library.detail.noSelection": "从左侧选一篇文献查看详情",
  "library.detail.meta": "元数据",
  "library.detail.url": "来源地址",
  "library.detail.language": "语言",

  // 关联（详情面板里的「关联」区）
  "library.links.title": "关联",
  "library.links.hint": "引用这一条时，关联的东西会一起挂进对话。",
  "library.links.add": "添加关联",
  "library.links.addFromDisk": "从磁盘添加",
  "library.links.addFromDiskHint": "挑库外的一个文件 —— 它会以「引用原路径」的方式进库，文件本身不动",
  "library.links.empty": "还没有关联。",
  "library.links.out": "关联到",
  "library.links.in": "被关联",
  "library.links.mdBundle": "转录 Markdown 与它的图床（{count} 张图）跟本条是一个整体 —— 引用一起挂，删除一起删。",
  "library.links.mdBundleNoImages": "转录 Markdown 跟本条是一个整体 —— 引用一起挂，删除一起删。",
  "library.links.remove": "解除",
  "library.links.removeConfirm": "解除这条关联？",
  "library.links.suppressed": "已被屏蔽：{reason}",
  "library.links.loadFailed": "读不出关联",
  "library.links.addFailed": "添加关联失败",
  "library.links.addOk": "已添加关联",
  "library.links.noneToAdd": "没有可关联的东西了",
  "library.detail.overview": "概览",
  "library.detail.abstract": "摘要",
  "library.detail.notes": "笔记",
  "library.itemNote.add": "添加笔记",
  "library.itemNote.placeholder": "记点什么？例如「第三章的卷积推导没跟上」",
  "library.itemNote.empty": "还没有笔记。读的时候随手记两句，对话时 AI 也能看到。",
  "library.itemNote.deleteConfirm": "删除这条笔记？",
  "library.itemNote.loadFailed": "读不出笔记",
  "library.detail.notesSoon": "笔记功能将在后续版本提供",
  "library.detail.collections": "所属分类",
  "library.detail.preview": "原文",
  "library.detail.pdf": "PDF",

  /* ── 应用内 PDF 阅读器 ── */
  "library.pdfViewer.prev": "上一页",
  "library.pdfViewer.next": "下一页",
  "library.pdfViewer.pageOf": "{n} / {total}",
  "library.pdfViewer.zoomIn": "放大",
  "library.pdfViewer.zoomOut": "缩小",
  "library.pdfViewer.fitWidth": "适应宽度",
  "library.pdfViewer.openExternal": "用外部程序打开",
  "library.pdfViewer.failed": "打不开这个 PDF",

  /* ── PDF 阅读 / 保存批注（EmbedPDF，2026-09-22）── */
  "library.pdfViewer.saveAnnotations": "保存批注",
  "library.pdfViewer.savedToast": "已保存",
  "library.pdfViewer.saveFailed": "保存失败",
  /** 关窗提醒里逐条列出的那句话。`name` 是文件名。 */
  "library.pdfViewer.unsavedLabel": "「{name}」上有没保存的批注",

  /* ── PDF 标注（2026-09-22 重做：六种工具 + 撤销 + 烤进文件）── */
  "library.pdfAnnot.toolText": "高亮",
  "library.pdfAnnot.toolArea": "框选区域",
  "library.pdfAnnot.toolFreeText": "页面上打字",
  "library.pdfAnnot.toolShape": "形状",
  "library.pdfAnnot.toolDrawing": "手绘",
  "library.pdfAnnot.toolImage": "贴图",
  "library.pdfAnnot.hint.text": "选中文字即可划高亮（跨行也行）",
  "library.pdfAnnot.hint.area": "拖一个框，圈住图、公式或表格",
  "library.pdfAnnot.hint.freetext": "点页面上任意位置，就地写批注",
  "library.pdfAnnot.hint.shape": "拖出一个矩形",
  "library.pdfAnnot.hint.drawing": "按住鼠标在页面上画",
  "library.pdfAnnot.hint.image": "点一下，然后选一张图片贴上去",
  "library.pdfAnnot.undo": "撤销",
  "library.pdfAnnot.redo": "重做",
  "library.pdfAnnot.bake": "烤进 PDF",
  "library.pdfAnnot.bakeHint": "把标注画进 PDF 文件本身（阅读器里看得见；不是 Acrobat 批注，改不了也擦不掉）",


  /* ── 引用格式 ── */

  /* ── 导出引用 ── */
  /**
   * **分类信息浮窗**（2026-09-21）。
   *
   * ★ 用户：「现在右键 collection 会有论文信息的导出，元信息已经放到文件的右键里面去了，
   * 可以查看，然后**这里的导出放进弹出的卡片里面**」。
   *
   * 于是分类行右键不再直接列三项导出（那一段把菜单撑得很长），改成打开这个卡片 ——
   * 导出在里面，顺便把"这个分类里有多少条"也摆出来。
   */
  "library.collection.info": "分类信息",
  "library.collection.itemCount": "共 {n} 条",

  /* ── 原文预览 ── */
  "library.preview.failed": "读不出 Markdown 正文",
  "library.preview.retry": "重试",
  "library.preview.more": "已显示 {shown}/{total} 段 —— 继续向下滚动会接着加载",
  "library.preview.noMarkdown": "这篇还没有 Markdown 转换产物，转换后才能预览。",
  "library.preview.needPdf": "先得有 PDF 才能转换。",
  "library.preview.imageCount": "{n} 张图",
  "library.preview.skipped": "{n} 张图片没能内联（文件缺失、过大或不在同一目录），正文里已就地标出",
  "library.preview.skippedMany": "文中另有 {n} 张图片未在此显示（数量超出预览上限）",
  // 就地插进正文的标记（少数几张没能内联时用）。**不要用方括号或半角括号** ——
  // 这段文字会交给 Markdown 渲染器，`[..](..)` 会被当成链接语法吃掉。
  "library.preview.imageNotInlined": "（图片未内联:{ref}）",


  // 设置页:文献库
  "settings.nav.library": "文献库",
  "settings.library.title": "文献库",
  "settings.library.layoutTitle": "目录结构",
  "settings.library.layoutDesc":
    "PDF 按内容哈希存放——同一篇文件导两次会落到同一个路径，天然去重。markdown/ 下同样结构放转换产物，AI 读的是它。collections/ 下是给 AI 读的文献清单。",

  // ── 设置:转换情况(文档管理)──
  // 原先长在「外部集成」那一页上(那一页随写死的 MinerU 一起删了)。搬到这里是因为
  // 它查的是**库里哪些文献还没转成 Markdown**,与「数据放在哪 / 怎么分」同属库本身
  // 的事。文案里去掉了"MinerU 额度"那套说法 —— 现在花的是用户自己那套工具的成本。
  "settings.convert.title": "转换情况",
  "settings.convert.desc":
    "统计库里有多少篇已经转成 Markdown。没有转换产物的文献，AI 读不到正文、全文检索也搜不到。",
  "settings.convert.total": "库里共 {n} 篇",
  "settings.convert.converted": "已转 {n} 篇",
  "settings.convert.pending": "未转 {n} 篇",
  "settings.convert.empty": "库里还没有文献",
  "settings.convert.localNote":
    "软件只导入、保存和显示文件。上传转录、DOI 下载与学术元数据提取由你配置的自动化完成；没有 PDF.js 本地兜底。已有 Markdown 可用「用本地 Markdown…」采纳。",
  "settings.convert.reasonNoMd": "还没转 Markdown",
  "settings.convert.reasonNoAssets": "有 {n} 张图没落盘",
  "settings.convert.runPending": "转换未转的 {n} 篇",
  "settings.convert.rerunAll": "全部重转",
  "settings.convert.rerunConfirm":
    "把库里所有文献都重新转换一遍？已有的 Markdown 会被覆盖（共 {n} 篇）。只想补没转的点「转换未转的」。",
  "settings.convert.running": "转换中…",
  "settings.convert.done": "已转换 {n} 篇",
  "settings.convert.failed": "{n} 篇失败",
  "settings.convert.nonePending": "没有待转换的文献",
  "settings.convert.rerunOne": "重转这篇",
  "settings.convert.rerunOneTitle": "这份 Markdown 不完整（缺图或没转过），重新转一次",

  // 全文检索
  "library.fulltext.placeholder": "在已转换的文献全文中搜索",
  "library.fulltext.hint": "只搜已转成 Markdown 的文献；中文与英文都支持",
  "library.fulltext.noMatch": "全文里没有匹配",
  "library.fulltext.line": "第 {n} 行",

  // 下载提示
  "library.notice.needsLoginTitle": "有下载需要重新登录",
  "library.notice.needsLoginBody": "这些文献拿回来的是网页而不是 PDF，通常是登录态过期了。请在内嵌浏览器里重新登录后重试。",

  // 模式的标签与说明都在 chat-composer 的 composer.mode.* ——
  // 输入框里不再有提示条，药丸上那个词就是全部指示。

  // 输入框:让 AI 读哪个库
  "library.chat.none": "不绑定文献库",
  "library.chat.pick": "让 AI 读哪个文献库",
  "library.chat.searchPlaceholder": "搜索文献库",
  "library.chat.addN": "添加 {n} 个",
  "library.chat.alreadyAdded": "已在上下文中",
  "library.chat.current": "当前：{name}",

  // 设置:机构认证
  "settings.nav.institution": "机构认证",
  "institution.title": "机构认证",
  "institution.desc":
    "在内嵌浏览器里登录一次（知网、学校图书馆代理、出版商等任意站点），登录态会被记住，下载文献时自动复用。这里不需要填写任何密码。",
  "institution.loginButton": "打开浏览器登录",
  "institution.profiles": "常用入口",
  "institution.profilesHint": "只是方便记录入口地址的组织性记录，删掉不会登出任何站点。",
  "institution.profile.new": "添加入口",
  "institution.profile.name": "名称",
  "institution.profile.namePlaceholder": "如：学校图书馆",
  "institution.profile.loginUrl": "登录地址",
  "institution.profile.domains": "适用域名",
  "institution.profile.domainsHint": "逗号分隔，用于把登录态归到这个入口名下",
  "institution.profile.proxyPrefix": "代理前缀（可选）",
  "institution.profile.proxyPrefixHint": "如 EZproxy 的登录前缀",
  "institution.profile.notes": "备注",
  "institution.profile.save": "保存",
  "institution.profile.delete": "删除",
  "institution.authStatus": "已登录站点",
  "institution.authStatusEmpty": "还没有登录任何站点",
  "institution.authStatusHint": "从浏览器 cookie 实时读取。登出后这里会同步消失。",
  "institution.cookieCount": "{n} 条 cookie",
  "institution.expiresAt": "有效期至 {date}",
  "institution.sessionCookie": "会话级（关闭浏览器即失效）",
  "institution.clearDomain": "清除该站点登录态",
  "institution.clearAll": "清除全部登录态",
  "institution.clearAllConfirm": "清除内置浏览器里所有站点的登录态？这将影响全部已登录的网站。",
  "institution.cleared": "已清除登录态",
  "institution.reload": "刷新状态",

  // ── 统一资料库:通用文件条目(linked / attached)──
  "library.detail.file": "文件",
  "library.action.importFiles": "导入文件",
  "library.action.importFolder": "导入文件夹",
  "library.import.genericResult": "导入 {added} 项,跳过 {skipped} 项",
  "library.import.genericErrors": "{n} 项没能导入",
  "library.file.back": "返回上级",
  "library.file.emptyDir": "空目录",
  "library.file.unknownMime": "暂无内置预览({mime})",
  /** 文件预览里选中文字后，「引用给谁」那个列表的表头（那个列表里没有"当前会话"）。 */
  "library.file.thisFile": "这个文件",
  "library.file.loadFailed": "读取失败",
  /* ── 库内全文检索(搜已转 Markdown 的正文)── */
  "library.fullText.title": "库内全文检索",
  "library.fullText.scopeHint":
    "搜的是**已转成 Markdown 的正文**(PDF 本身搜不了,没转换的条目搜不到)。找「哪篇里提过这个词」用它;找「库里有没有某一篇」用列表上方的搜索框。",
  "library.fullText.placeholder": "要搜的词,如 attention",
  "library.fullText.searching": "检索中…",
  "library.fullText.noResult": "正文里没有找到这个词(也可能那一篇还没转成 Markdown)",
  "library.fullText.count": "命中 {n} 处",
} as const;
