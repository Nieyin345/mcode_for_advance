/**
 * **自定义 UI** —— 主界面只放入口,点下去做什么、显示什么,全在设置页里定义。
 *
 * ## 这份契约管什么
 *
 * 主界面上有几个**挂载位**(slot):资料库四级右键(条目 / 分类 / 小类 / 大类)、
 * 右栏 Files 的文件右键、右栏顶上那排页签、主页面与右栏之间的竖向工具栏。每个挂载位上的
 * 入口由三种**条目**拼成:
 *
 *   - **内置项**(`builtin:<id>`):软件自带的功能项(文献信息、发到对话、采纳 MD……),
 *     实现写在渲染端,这里只管它们**显不显示、排第几**。
 *   - **自定义项**(`custom:<id>`):用户在设置页里建的 —— 名字 + 图标 + 条件 + 动作。
 *   - **模块项**(`module:<模块 id>:<贡献 id>`):v1 JSON 模块清单声明的文件右键贡献,
 *     只出现在 `files.context`。
 *
 * **管理项**(重命名 / 移动复制 / 移除删除 / 打开文件夹 / 新建分类 / 新建笔记)不在这里:
 * 它们是固定的,不可隐藏也不可排序 —— 用户定的规矩(管理是软件自己的事,功能才交给
 * 用户摆)。
 *
 * ## 为什么没有脚本、没有 HTML
 *
 * 动作全是声明式的:打开视图(Markdown 模板)、发给对话(提示词模板)、复制文本、
 * 运行自动化、打开文件、切到右栏某个页签(哪个挂载位能用哪几种见 {@link ACTIONS_BY_SLOT})。要写逻辑就去写自动化/工作流 —— 那边有审阅、有运行记录、有权限边界。
 * 在菜单项里塞可执行代码等于给每一次右键开了一个没人审的口子。
 *
 * ## 存哪
 *
 * 设置表的一个键({@link CUSTOM_UI_SETTING_KEY}),值是 JSON。读的时候过
 * {@link parseCustomUiConfig}:**坏了当默认**(用户数据可能被手改坏,菜单不能因此白屏),
 * 坏掉的那几条逐条丢,好的留着。
 *
 * 纯函数、只依赖 zod,冒烟可以直接把渲染/条件/排序钉住(见 `scripts/custom-ui-smoke`)。
 */
import { z } from "zod";
import { PANEL_HTML_MAX } from "./customUiPanel.js";

/** 设置表里存配置的键。版本号写进键名:将来格式大改就换一个键,旧值原地不动可回退。 */
export const CUSTOM_UI_SETTING_KEY = "customUi.config.v1";

/**
 * 挂载位。
 *
 *   - `library.item`        条目行右键
 *   - `library.collection`  **分类**(第三级:有父分类的那种)右键
 *   - `library.subcategory` **小类**(第二级:大类下直挂的根分类)右键
 *   - `library.group`       **大类**标题行右键
 *   - `files.context`       右栏 Files 里的文件右键
 *   - `rightPanel.tab`      右栏顶上那排页签(内置的文件 / Git / 浏览器……也在这里排)
 *   - `toolbar`             主页面与右栏之间的竖向工具栏(右栏收起时它就在最右边)
 *   - `chat.message`        聊天里一条消息的「⋯」菜单(悬停时出现,和复制按钮在一起)(R39)
 *   - `text.selection`      选中文字:聊天里的选中浮条 + 代码编辑器的右键菜单(R39)
 *   - `composer.toolbar`    输入框下面那排工具按钮(R39)
 *   - `session.context`     左栏对话右键(R39)
 *   - `project.context`     左栏项目右键(R39)
 *
 * 后两个没有「右键的目标」,模板变量是当前工作区(项目 / 对话 / 日期),见
 * {@link CustomUiTarget} 的 `workspace`。
 */
export const CUSTOM_UI_SLOTS = [
  "library.item",
  "library.collection",
  "library.subcategory",
  "library.group",
  "files.context",
  "rightPanel.tab",
  "toolbar",
  "chat.message",
  "text.selection",
  "composer.toolbar",
  "session.context",
  "project.context",
] as const;
export type CustomUiSlot = (typeof CUSTOM_UI_SLOTS)[number];

/** 资料库那四个挂载位 —— 它们的目标能交给自动化当「条目清单」。 */
export const LIBRARY_SLOTS: readonly CustomUiSlot[] = [
  "library.item",
  "library.collection",
  "library.subcategory",
  "library.group",
];

/**
 * 自定义项可选的图标 —— **白名单**,不是任意组件名:配置是用户数据,渲染端拿它去查
 * 一张固定表,查不到就用默认图标。
 */
export const CUSTOM_UI_ICONS = [
  "sparkles",
  "bolt",
  "message",
  "file-text",
  "copy",
  "book",
  "robot",
  "world",
  "code",
  "quote",
  "tag",
  "star",
  "flask",
  "eye",
  "template",
  "download",
  // 工具栏 / 页签常用的几个(2026-09-28 加;只能往后加,不能改名 —— 名字存在用户配置里)
  "list-check",
  "calendar",
  "chart",
  "folder",
  "terminal",
  "notebook",
  "bulb",
] as const;
export type CustomUiIcon = (typeof CUSTOM_UI_ICONS)[number];

/** 一次运行最多带多少条条目(分类 / 大类批量跑自动化)。再多就该用自动化自己去查库。 */
export const CUSTOM_UI_MAX_BATCH = 200;

const LocalizedTextSchema = z.object({
  /** 中文必填 —— 中文是 i18n 的源语言(同 `MessageId` 从 zh 推出来的约定)。 */
  zh: z.string().trim().min(1).max(60),
  /** 英文可选,缺了显示中文。 */
  en: z.string().trim().max(60).optional(),
});
export type CustomUiText = z.infer<typeof LocalizedTextSchema>;

/**
 * 显示条件。**全部满足**才出现在菜单里;没写的那一项不限制。
 *
 * `extensions` 看的是目标的文件名(条目取 file/pdf/md 路径里有的那个,文件右键取路径);
 * `requires` 只对条目有意义;`groupIds` 只对资料库那四个挂载位有意义(按所属大类筛)。
 */
export const CustomUiWhenSchema = z
  .object({
    extensions: z.array(z.string().trim().min(1).max(20)).max(50).optional(),
    requires: z.enum(["file", "pdf", "markdown"]).optional(),
    groupIds: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .strict();
export type CustomUiWhen = z.infer<typeof CustomUiWhenSchema>;

const TemplateSchema = z.string().max(20_000);

/** 运行前输入项的变量名:小写字母开头,进 `{{trigger.input.<key>}}`。 */
const INPUT_KEY = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * automation 动作的**运行前输入**(通用原语,2026-09-28)。点击后弹一个原生小表单,
 * 值以 `input.<key>` 拍平进触发载荷 ⟹ 自动化里写 `{{trigger.input.<key>}}` 取
 * (触发器变量本来就按字面查键、键名允许点)。
 *
 *   - `text`:一个文本框(DOI、检索词、备注……);
 *   - `files`:系统文件选择器,值是绝对路径数组(用户显式选的,不受项目根约束
 *     —— 与 `file` 目标"必须在项目里"是两回事,后者是自动化替你去读的)。
 *
 * 没有脚本、没有校验表达式:要校验去自动化里做(那边有审阅和运行记录)。
 * 典型用法:「文献导入」= files(选 PDF)+ text(DOI),自动化自己判断哪个有值。
 */
export const CustomUiInputSchema = z
  .object({
    key: z.string().regex(INPUT_KEY),
    kind: z.enum(["text", "files"]),
    /** 表单里显示的名字;缺了显示 key。 */
    label: LocalizedTextSchema.optional(),
    /** 必填:没值不许提交(files = 至少选一个)。 */
    required: z.boolean().optional(),
  })
  .strict();
export type CustomUiInput = z.infer<typeof CustomUiInputSchema>;

/** 动作。判别联合,`type` 决定剩下的字段。 */
export const CustomUiActionSchema = z.discriminatedUnion("type", [
  /** 打开一个视图:标题 + Markdown 正文(都可以写 `{{变量}}`)。 */
  z.object({
    type: z.literal("view"),
    title: z.string().max(200).optional(),
    body: TemplateSchema,
  }),
  /**
   * 发给当前对话:把渲染好的提示词**放进输入框**(不替用户发送 —— 同「跟主对话说」的
   * 规矩,先看一眼再发更稳)。`attach` = 同时把右键的那个目标挂进对话上下文。
   */
  z.object({
    type: z.literal("prompt"),
    template: TemplateSchema,
    attach: z.boolean().optional(),
  }),
  /** 复制渲染好的文本到剪贴板。 */
  z.object({
    type: z.literal("copy"),
    template: TemplateSchema,
  }),
  /**
   * 运行一条自动化:用**指定的那个触发器**手动起一次,右键的目标作为载荷带进去
   * (条目 / 分类 / 大类 → 条目清单,文件 → 文件列表;工具栏没有目标 → 同「立刻跑一次」)。
   *
   * `skipWhen`(通用原语,2026-09-28):展开时**满足条件的条目被跳过**,检测只在主进程
   * 展开处做一次(`targets.shouldSkipItem`,复用 {@link matchesWhen})。典型用法:手动/
   * 批量转录配 `{ requires: "markdown" }` —— 已有转录的不重复转录。载荷形状不变,
   * 自动化侧零改动;确认框与结果如实报「带 N 条、跳过 M 条」,不静默少带。
   */
  z.object({
    type: z.literal("automation"),
    workflowId: z.string().min(1).max(200),
    triggerNodeId: z.string().min(1).max(200),
    skipWhen: CustomUiWhenSchema.optional(),
    /** 运行前输入(见 {@link CustomUiInputSchema})。v1 只在有目标的挂载位可用。 */
    inputs: z.array(CustomUiInputSchema).max(4).optional(),
    /**
     * 右键那个目标**怎么用**(2026-09-28)。
     *
     *   - `scope`(默认):目标是**这次要办的那一批** —— 分类/大类展开成里面的条目,
     *     批量转录就是这一种(先数一遍、让用户确认、超 200 条拒绝)。
     *   - `context`:目标只是**上下文**(办事的地方),**不展开条目**。文献导入是这一种:
     *     用户右键一个分类,意思是"把表单里选的 PDF 收进这个分类",而不是"对分类里
     *     现有的条目办事"。
     *
     * ⚠️ 这一格不是可有可无的修饰:`scope` 那条路上**空分类一律被拒**
     * (「这个范围里没有条目」),而"往空分类里导东西"恰恰是 `context` 的典型用法。
     * 两种语义压在一条展开路径上时,导入入口在最常见的情形下 100% 失败。
     */
    targetMode: z.enum(["scope", "context"]).optional(),
  }),
  /**
   * 一个文件(路径可以写 `{{变量}}`;相对路径按当前项目目录解析)。工具栏上 = 在中间
   * 打开它;右栏页签 = **实时显示**它的内容(Markdown 渲染,改了自动刷新)——
   * 「自动化把结果写进一个文件,页签一直显示它」就是这么搭出来的。
   * 只能是项目目录里的文件(读文件那条 RPC 本来就只放行项目根下的路径)。
   *
   * ⚠ 两条路的边界**不同**,别互相假设:页签那条路读内容走「读文件 RPC」,项目根
   * 白名单在主进程里兜底;工具栏那条路是「在 IDE 里打开」,绝对路径不经过该白名单
   * —— 等价于用户自己在本机打开一个文件(配置只有本机用户写得了,不是远程可达面),
   * 但若未来把配置做成可分享/可导入,这条路要先补校验。
   */
  z.object({
    type: z.literal("file"),
    path: z.string().trim().min(1).max(1000),
  }),
  /**
   * 切到右栏的某个页签(条目键:`builtin:files` / `custom:<id>`),右栏收着就先展开。
   * 再点一次、而右栏正显示着它 → 收起右栏(同 IDE 活动栏的手感)。
   */
  z.object({
    type: z.literal("openTab"),
    tab: z.string().min(1).max(300),
  }),
  /**
   * 打开链接(R39)。模板渲染后只放行 http / https / mailto —— 渲染结果可能来自消息
   * 正文、文件名这些不受控的文字,`file:` / `javascript:` 一律拒。变量值会做 URL 编码
   * (见 {@link renderUrlTemplate}),所以 `https://www.google.com/search?q={{selection.text}}`
   * 这种写法是对的。
   */
  z.object({
    type: z.literal("url"),
    url: z.string().trim().min(1).max(2000),
  }),
  /**
   * 运行终端命令(R39):在底部终端**新开一个页签**跑,cwd = 当前项目。
   *
   * 变量值会**自动加引号**并把换行压成空格(见 {@link renderShellTemplate})—— 消息正文、
   * 选中文字都可能带 `;` `&&` `$(...)`,原样拼进命令就是注入。模板里自己写的部分原样保留。
   *
   * `confirm`:运行前弹框显示完整命令让用户确认。**缺省 = 确认**;导入别人的设置时一律
   * 抹掉这一格(回到确认),防止导入的按钮静默执行命令。
   */
  z.object({
    type: z.literal("shell"),
    command: z.string().trim().min(1).max(4000),
    confirm: z.boolean().optional(),
  }),
  /**
   * 自定义面板(R41):一段 HTML / CSS / JS,跑在隔离的 iframe 里,通过 `window.mcode`
   * 读上下文、问模型、发到输入框、跑自动化、读写项目文件、读资料库……(见
   * `@contracts/customUiPanel`)。右栏页签上常驻显示;其余挂载位点一下弹一个浮窗。
   *
   *   - `network`:允许面板自己联网(fetch、外链脚本 / 样式 / 图片)。**缺省 = 不允许**;
   *     导入别人的设置时一律抹掉。
   *   - `confirm`:面板要跑自动化 / 写文件 / 跑命令时每次弹确认。**缺省 = 确认**;导入时
   *     同样抹掉(回到确认)。
   */
  z.object({
    type: z.literal("panel"),
    title: z.string().max(200).optional(),
    html: z.string().min(1).max(PANEL_HTML_MAX),
    network: z.boolean().optional(),
    confirm: z.boolean().optional(),
  }),
]);
export type CustomUiAction = z.infer<typeof CustomUiActionSchema>;
export type CustomUiActionType = CustomUiAction["type"];

/**
 * 每个挂载位能用哪几种动作。右键菜单有「目标」,所以能把目标带进自动化;页签是一块
 * **常驻的显示区**,只有「显示什么」(Markdown / 文件)有意义;工具栏是按钮,什么都能点,
 * 另外能切页签、开文件。不在表里的组合在读配置时整条丢掉(同坏条目)。
 */
// R39:所有菜单 / 按钮类挂载位都能「打开链接」「运行终端命令」。新挂载位(消息 / 选中文字 /
// 对话 / 项目)没有能交给自动化的「条目」,自动化在那里按「立刻跑一次」处理。
// R41:「自定义面板」所有挂载位都能用(页签上常驻,别处弹浮窗)。
const MENU_ACTIONS = ["view", "prompt", "copy", "automation", "url", "shell", "panel"] as const;
const BUTTON_ACTIONS = ["view", "prompt", "copy", "automation", "file", "openTab", "url", "shell", "panel"] as const;
export const ACTIONS_BY_SLOT: Record<CustomUiSlot, readonly CustomUiActionType[]> = {
  "library.item": MENU_ACTIONS,
  "library.collection": MENU_ACTIONS,
  "library.subcategory": MENU_ACTIONS,
  "library.group": MENU_ACTIONS,
  "files.context": MENU_ACTIONS,
  "rightPanel.tab": ["view", "file", "panel"],
  toolbar: BUTTON_ACTIONS,
  "chat.message": MENU_ACTIONS,
  "text.selection": MENU_ACTIONS,
  "composer.toolbar": BUTTON_ACTIONS,
  "session.context": MENU_ACTIONS,
  "project.context": MENU_ACTIONS,
};

export function isActionAllowed(slot: CustomUiSlot, type: CustomUiActionType): boolean {
  return ACTIONS_BY_SLOT[slot].includes(type);
}

/** 自定义项 id:短、URL 安全 —— 它会拼进 `custom:<id>` 这种布局键里。 */
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const CustomUiItemSchema = z.object({
  id: z.string().regex(ITEM_ID),
  slot: z.enum(CUSTOM_UI_SLOTS),
  label: LocalizedTextSchema,
  icon: z.enum(CUSTOM_UI_ICONS).optional(),
  when: CustomUiWhenSchema.optional(),
  action: CustomUiActionSchema,
});

/**
 * 这个挂载位上,条件里的哪几项**说得通**。
 *
 * 从前这张表不存在,于是有两种"配了却永远不生效"的写法能一路存下去:
 *
 *  - 工具栏 / 右栏页签上写 `requires` 或 `extensions` —— 它们的目标是 `workspace`,
 *    而 {@link matchesWhen} 对这两项在 workspace 上一律返回 false:**这一项从此永远
 *    不显示**,用户看到的是"我建的按钮不见了"。
 *  - 文件右键上写 `requires` / `groupIds` —— 同理恒为 false。
 *
 * 判据放在契约里,{@link sanitizeWhen} 在读配置时按它裁掉,设置页也拿它决定显示哪几格。
 * **裁掉而不是整条丢掉**:用户要的是那一项本身,条件只是他填错的一格。
 */
export function whenKeysForSlot(slot: CustomUiSlot): readonly (keyof CustomUiWhen)[] {
  switch (targetKindOfSlot(slot)) {
    case "item":
      return ["extensions", "requires", "groupIds"];
    case "collection":
    case "group":
      return ["groupIds"];
    case "file":
    case "selection":
      return ["extensions"];
    default:
      return [];
  }
}

/** 按 {@link whenKeysForSlot} 裁一份条件;裁完什么都不剩就返回 undefined。 */
export function sanitizeWhen(when: CustomUiWhen | undefined, slot: CustomUiSlot): CustomUiWhen | undefined {
  if (!when) return undefined;
  const allowed = new Set<string>(whenKeysForSlot(slot));
  const out: CustomUiWhen = {};
  if (allowed.has("extensions") && when.extensions?.length) out.extensions = when.extensions;
  if (allowed.has("requires") && when.requires) out.requires = when.requires;
  if (allowed.has("groupIds") && when.groupIds?.length) out.groupIds = when.groupIds;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `automation` 动作的 `skipWhen` 里说得通的那几项。
 *
 * **`groupIds` 不在内**:批量展开在主进程做(`customUi/targets.ts` 的 `shouldSkipItem`),
 * 那里手上只有一条 `LibraryItem`,拼出来的目标不带 `groupId` —— 于是 `matchesWhen` 恒为
 * false,**一条都不会被跳过**。契约允许写、实现永不命中,是最难查的那种坏法:用户会以为
 * "这个分类里已经处理过的都被跳过了",而其实每一条都重跑了一遍。
 */
export function sanitizeSkipWhen(when: CustomUiWhen | undefined): CustomUiWhen | undefined {
  if (!when) return undefined;
  const out: CustomUiWhen = {};
  if (when.extensions?.length) out.extensions = when.extensions;
  if (when.requires) out.requires = when.requires;
  return Object.keys(out).length > 0 ? out : undefined;
}
export type CustomUiItem = z.infer<typeof CustomUiItemSchema>;

/**
 * 一个挂载位的布局:`order` 是条目键的先后(没列到的按默认顺序排在后面),
 * `hidden` 是隐藏掉的条目键。键的形状见文件头(`builtin:` / `custom:` / `module:`)。
 */
export const CustomUiSlotLayoutSchema = z.object({
  order: z.array(z.string().min(1).max(300)).max(500).default([]),
  hidden: z.array(z.string().min(1).max(300)).max(500).default([]),
});
export type CustomUiSlotLayout = z.infer<typeof CustomUiSlotLayoutSchema>;

export const CustomUiConfigSchema = z.object({
  version: z.literal(1),
  items: z.array(CustomUiItemSchema).max(200),
  layout: z.record(z.enum(CUSTOM_UI_SLOTS), CustomUiSlotLayoutSchema),
});
export type CustomUiConfig = z.infer<typeof CustomUiConfigSchema>;

export const DEFAULT_CUSTOM_UI_CONFIG: CustomUiConfig = { version: 1, items: [], layout: {} };

/**
 * 读配置。**永远返回一份能用的**:
 *
 *   - 空 / 不是 JSON / 顶层形状不对 → 默认配置
 *   - 某一条自定义项坏了 → 只丢那一条(其余照常)
 *   - 某个挂载位的布局坏了 → 只丢那个挂载位的布局
 *
 * 逐条宽容是因为这份数据是用户手里的:JSON 导入、手改设置表都可能引入一条坏的,
 * 为一条坏数据把整份配置作废,用户辛苦摆好的菜单就全没了。
 */
export function parseCustomUiConfig(raw: string | null | undefined): CustomUiConfig {
  if (raw === null || raw === undefined || raw.trim().length === 0) return DEFAULT_CUSTOM_UI_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CUSTOM_UI_CONFIG;
  }
  return coerceCustomUiConfig(parsed);
}

/** {@link parseCustomUiConfig} 的对象版(JSON 导入那一路已经 parse 过)。 */
export function coerceCustomUiConfig(parsed: unknown): CustomUiConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_CUSTOM_UI_CONFIG;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return DEFAULT_CUSTOM_UI_CONFIG;
  const items: CustomUiItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.items)) {
    for (const rawItem of obj.items.slice(0, 200)) {
      const r = CustomUiItemSchema.safeParse(rawItem);
      // id 重复只留第一条:布局键靠 id 区分,两条同 id 会让排序/隐藏同时作用在两条上。
      // 动作不适用于这个挂载位(手改 JSON 把一个「运行自动化」挪进了页签)也当坏条目丢
      if (r.success && !seen.has(r.data.id) && isActionAllowed(r.data.slot, r.data.action.type)) {
        seen.add(r.data.id);
        // 这个挂载位上说不通的条件**裁掉,不整条丢**(见 `sanitizeWhen` / `sanitizeSkipWhen`):
        // 留着它们等于让这一项永远不显示、或让 skipWhen 永远不命中,而两者都是静默的。
        const when = sanitizeWhen(r.data.when, r.data.slot);
        const action =
          r.data.action.type === "automation"
            ? (() => {
                const skipWhen = sanitizeSkipWhen(r.data.action.skipWhen);
                const { skipWhen: _drop, ...rest } = r.data.action;
                return skipWhen ? { ...rest, skipWhen } : rest;
              })()
            : r.data.action;
        const { when: _dropWhen, ...restItem } = r.data;
        items.push(when ? { ...restItem, when, action } : { ...restItem, action });
      }
    }
  }
  const layout: CustomUiConfig["layout"] = {};
  if (typeof obj.layout === "object" && obj.layout !== null && !Array.isArray(obj.layout)) {
    for (const slot of CUSTOM_UI_SLOTS) {
      const r = CustomUiSlotLayoutSchema.safeParse((obj.layout as Record<string, unknown>)[slot]);
      if (r.success) layout[slot] = r.data;
    }
  }
  return { version: 1, items, layout };
}

/* ── 条目键 ── */

export const builtinKey = (id: string): string => `builtin:${id}`;
export const customKey = (id: string): string => `custom:${id}`;
export const moduleKey = (moduleId: string, contributionId: string): string =>
  `module:${moduleId}:${contributionId}`;

/**
 * 按布局把一个挂载位上**可用的条目键**排好、去掉隐藏的。
 *
 * `available` 是这一刻真实存在的条目(内置项按默认顺序在前,然后是模块项、自定义项)。
 * 规则:
 *
 *   1. `order` 里列到、且此刻可用的,按 `order` 的先后;
 *   2. 没列到的(新加的内置项、新建的自定义项、新装的模块)按 `available` 的原顺序接在后面
 *      —— 新东西默认**出现**,而不是默默藏起来让用户找不到;
 *   3. 最后去掉 `hidden` 里的。
 *
 * `order` 里有、但此刻不可用的键(模块被卸了、自定义项删了)直接跳过,不报错。
 */
export function arrangeSlotEntries(
  available: readonly string[],
  layout: CustomUiSlotLayout | undefined,
  opts: { includeHidden?: boolean } = {},
): string[] {
  const avail = new Set(available);
  const out: string[] = [];
  const placed = new Set<string>();
  for (const key of layout?.order ?? []) {
    if (avail.has(key) && !placed.has(key)) {
      out.push(key);
      placed.add(key);
    }
  }
  for (const key of available) {
    if (!placed.has(key)) {
      out.push(key);
      placed.add(key);
    }
  }
  if (opts.includeHidden) return out;
  const hidden = new Set(layout?.hidden ?? []);
  return out.filter((k) => !hidden.has(k));
}

/* ── 目标 & 条件 ── */

/**
 * 右键的那个目标 —— 渲染模板与判断条件用的**平面事实**。
 *
 * 只放能给用户看的东西(标题、库内相对路径、名字),不放整条记录:模板变量是用户
 * 写进配置里的,暴露的字段就是一份对外承诺。
 */
export type CustomUiTarget =
  | {
      kind: "item";
      groupId?: string;
      item: {
        id: string;
        title: string;
        abstract?: string;
        url?: string;
        language?: string;
        pdfPath?: string;
        mdPath?: string;
        filePath?: string;
      };
    }
  | { kind: "collection"; level: "collection" | "subcategory"; groupId?: string; collection: { id: string; name: string } }
  | { kind: "group"; group: { id: string; name: string } }
  | { kind: "file"; projectPath: string; path: string }
  /**
   * 页签与工具栏:没有「右键的那个」,只有当前工作区。`today` 由调用方给(`YYYY-MM-DD`,
   * 本地日期)—— 这里保持纯函数,不自己读时钟。
   */
  | {
      kind: "workspace";
      project?: { path: string; name: string };
      session?: { id: string; title: string };
      today: string;
    }
  /** R39:聊天里的一条消息(`chat.message`)。 */
  | {
      kind: "message";
      message: { id: string; role: "user" | "assistant"; text: string };
      project?: { path: string; name: string };
      session?: { id: string; title: string };
      today: string;
    }
  /** R39:选中的文字(`text.selection`)—— 聊天里选的,或代码编辑器里选的(带文件)。 */
  | {
      kind: "selection";
      text: string;
      source: "chat" | "editor";
      path?: string;
      project?: { path: string; name: string };
      session?: { id: string; title: string };
      today: string;
    }
  /** R39:左栏右键的那条对话(`session.context`)。 */
  | {
      kind: "session";
      session: { id: string; title: string };
      project?: { path: string; name: string };
      today: string;
    }
  /** R39:左栏右键的那个项目(`project.context`)。 */
  | {
      kind: "project";
      project: { id: string; path: string; name: string };
      today: string;
    };

/** 路径的最后一段(兼容 `\` 与 `/`)。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** `.pdf` 这种小写扩展名;没有就空串。 */
export function extensionOf(p: string | undefined): string {
  if (!p) return "";
  const name = baseName(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/** 模板变量表。键是 `{{item.title}}` 里花括号中间那一段。 */
export function templateVarsOf(target: CustomUiTarget): Record<string, string> {
  switch (target.kind) {
    case "item": {
      const i = target.item;
      return {
        "item.id": i.id,
        "item.title": i.title,
        "item.abstract": i.abstract ?? "",
        "item.url": i.url ?? "",
        "item.language": i.language ?? "",
        "item.pdfPath": i.pdfPath ?? "",
        "item.mdPath": i.mdPath ?? "",
        "item.filePath": i.filePath ?? "",
      };
    }
    case "collection":
      return { "collection.id": target.collection.id, "collection.name": target.collection.name };
    case "group":
      return { "group.id": target.group.id, "group.name": target.group.name };
    case "file":
      return {
        "file.path": target.path,
        "file.name": baseName(target.path),
        "file.ext": extensionOf(target.path),
        "file.dir": dirName(target.path),
        "project.path": target.projectPath,
      };
    case "workspace":
      return {
        "project.path": target.project?.path ?? "",
        "project.name": target.project?.name ?? "",
        "session.id": target.session?.id ?? "",
        "session.title": target.session?.title ?? "",
        today: target.today,
      };
    case "message":
      return {
        "message.text": target.message.text,
        "message.role": target.message.role,
        "message.id": target.message.id,
        "project.path": target.project?.path ?? "",
        "project.name": target.project?.name ?? "",
        "session.id": target.session?.id ?? "",
        "session.title": target.session?.title ?? "",
        today: target.today,
      };
    case "selection":
      return {
        "selection.text": target.text,
        "file.path": target.path ?? "",
        "file.name": target.path ? baseName(target.path) : "",
        "file.ext": extensionOf(target.path),
        "project.path": target.project?.path ?? "",
        "project.name": target.project?.name ?? "",
        "session.id": target.session?.id ?? "",
        "session.title": target.session?.title ?? "",
        today: target.today,
      };
    case "session":
      return {
        "session.id": target.session.id,
        "session.title": target.session.title,
        "project.path": target.project?.path ?? "",
        "project.name": target.project?.name ?? "",
        today: target.today,
      };
    case "project":
      return {
        "project.id": target.project.id,
        "project.path": target.project.path,
        "project.name": target.project.name,
        today: target.today,
      };
  }
}

const WORKSPACE_VARS = ["project.path", "project.name", "session.id", "session.title", "today"] as const;

/** 每个挂载位能用的变量名(设置页的「可用变量」提示照这张表列)。 */
export const TEMPLATE_VARS_BY_SLOT: Record<CustomUiSlot, readonly string[]> = {
  "library.item": [
    "item.title",
    "item.id",
    "item.abstract",
    "item.url",
    "item.language",
    "item.pdfPath",
    "item.mdPath",
    "item.filePath",
  ],
  "library.collection": ["collection.name", "collection.id"],
  "library.subcategory": ["collection.name", "collection.id"],
  "library.group": ["group.name", "group.id"],
  "files.context": ["file.path", "file.name", "file.ext", "file.dir", "project.path"],
  "rightPanel.tab": WORKSPACE_VARS,
  toolbar: WORKSPACE_VARS,
  "chat.message": ["message.text", "message.role", "message.id", ...WORKSPACE_VARS],
  "text.selection": ["selection.text", "file.path", "file.name", "file.ext", ...WORKSPACE_VARS],
  "composer.toolbar": WORKSPACE_VARS,
  "session.context": ["session.id", "session.title", "project.path", "project.name", "today"],
  "project.context": ["project.id", "project.path", "project.name", "today"],
};

/**
 * 渲染 `{{ 变量 }}`。认不出的变量渲染成空串 —— 不留原样:原样留着的 `{{item.foo}}`
 * 被发给模型,它会以为那是要它填的东西。
 */
const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(TEMPLATE_VAR_RE, (_m, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? "") : "",
  );
}

/** 模板里出现过的变量名(按出现顺序,去重)。 */
/**
 * 「打开链接」用的渲染:变量值做 `encodeURIComponent`(选中的文字、标题里有空格 / `&` /
 * `#` 是常态),模板里自己写的部分原样。结果不是 http(s) / mailto 就返回 null。
 * 例外:模板**整个就是一个变量**(如 `{{item.url}}`)时值原样用 —— 那个变量本身就是链接。
 */
export function renderUrlTemplate(template: string, vars: Readonly<Record<string, string>>): string | null {
  const whole = /^\s*\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}\s*$/.exec(template);
  const out = whole
    ? (Object.hasOwn(vars, whole[1] as string) ? (vars[whole[1] as string] ?? "") : "").trim()
    : template
        .replace(TEMPLATE_VAR_RE, (_m, key: string) =>
          encodeURIComponent(Object.hasOwn(vars, key) ? (vars[key] ?? "") : ""),
        )
        .trim();
  return /^(https?:\/\/|mailto:)/i.test(out) ? out : null;
}

export type ShellFlavor = "powershell" | "posix" | "cmd";

/** 把一个值包成单个 shell 参数。`powershell`:单引号,内部 `'` 写两遍;`posix`:单引号,
 *  内部 `'` 写成 `'\''`;`cmd`:双引号(引号里 `& | < > ^` 都是字面量),值里的 `"` 和 `%`
 *  去掉(cmd 交互模式下没法转义它们)。换行一律压成空格(命令是一行一行提交给 shell 的)。 */
export function shellQuote(value: string, flavor: ShellFlavor): string {
  const v = value.replace(/[\r\n]+/g, " ");
  if (flavor === "powershell") return `'${v.replace(/'/g, "''")}'`;
  if (flavor === "cmd") return `"${v.replace(/["%]/g, "")}"`;
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * 「运行终端命令」用的渲染:每个变量值都**自动加引号**成一个参数(见 {@link shellQuote}),
 * 模板里自己写的部分原样。用户若已经在模板里给变量加了引号(`"{{file.path}}"` /
 * `'{{file.path}}'`),那一层引号会被去掉,避免双重引号。
 * ⚠ 变量请单独作为参数用,别塞进更长的双引号字符串中间(PowerShell / bash 的双引号里
 * `$(...)` 仍会展开)。
 */
export function renderShellTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
  flavor: ShellFlavor,
): string {
  const quoted = template.replace(
    /(["']?)\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}\1/g,
    (_m, _q: string, key: string) => shellQuote(Object.hasOwn(vars, key) ? (vars[key] ?? "") : "", flavor),
  );
  return quoted.replace(/[\r\n]+/g, " ").trim();
}

export function extractTemplateVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TEMPLATE_VAR_RE)) {
    const key = m[1] as string;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 模板里**这个挂载位认不出**的变量 —— 设置页保存前的提示用。
 *
 * 运行时的规矩不变:认不出的渲染成空串({@link renderTemplate} 的理由)。这里只是把
 * 「打错了」在保存前点名:`{{item.titel}}` 静默变空串,用户在菜单上看到的只是一个
 * 莫名其妙的空,没处排查。**宽容运行、严格提示**:提示不拦保存。
 */
export function unknownTemplateVars(template: string, slot: CustomUiSlot): string[] {
  const known = new Set<string>(TEMPLATE_VARS_BY_SLOT[slot]);
  return extractTemplateVars(template).filter((v) => !known.has(v));
}

/** 规范化扩展名写法:`pdf` / `.PDF` / `*.pdf` 都当 `.pdf`。 */
export function normalizeExtension(ext: string): string {
  const e = ext.trim().toLowerCase().replace(/^\*/, "");
  return e.startsWith(".") ? e : `.${e}`;
}

/** 这个目标满足不满足条件。没写条件 = 满足。 */
export function matchesWhen(when: CustomUiWhen | undefined, target: CustomUiTarget): boolean {
  if (!when) return true;
  if (when.groupIds && when.groupIds.length > 0) {
    const gid =
      target.kind === "group"
        ? target.group.id
        : target.kind === "item" || target.kind === "collection"
          ? target.groupId
          : undefined;
    if (gid === undefined || !when.groupIds.includes(gid)) return false;
  }
  if (when.requires) {
    if (target.kind !== "item") return false;
    const i = target.item;
    if (when.requires === "pdf" && !i.pdfPath) return false;
    if (when.requires === "markdown" && !i.mdPath) return false;
    if (when.requires === "file" && !(i.filePath || i.pdfPath || i.mdPath)) return false;
  }
  if (when.extensions && when.extensions.length > 0) {
    const wanted = new Set(when.extensions.map(normalizeExtension));
    const paths =
      target.kind === "file" || target.kind === "selection"
        ? [target.path]
        : target.kind === "item"
          ? [target.item.filePath, target.item.pdfPath, target.item.mdPath]
          : [];
    if (!paths.some((p) => wanted.has(extensionOf(p)))) return false;
  }
  return true;
}

/** 某个挂载位的目标种类(建自定义项时决定哪些动作 / 条件有意义)。 */
export function targetKindOfSlot(slot: CustomUiSlot): CustomUiTarget["kind"] {
  if (slot === "library.item") return "item";
  if (slot === "library.collection" || slot === "library.subcategory") return "collection";
  if (slot === "library.group") return "group";
  if (slot === "files.context") return "file";
  if (slot === "chat.message") return "message";
  if (slot === "text.selection") return "selection";
  if (slot === "session.context") return "session";
  if (slot === "project.context") return "project";
  return "workspace";
}

/**
 * 「文件」动作的路径 → 绝对路径。相对路径按项目目录接上;没有项目又是相对路径 → `null`
 * (调用方提示「先打开一个项目」)。
 *
 * ## `..` 现在拦在这里(2026-09-28)
 *
 * 从前的理由是"读文件的 RPC 只放行项目根下的路径",可那只覆盖**页签**那条路;工具栏的
 * 「文件」动作走的是 `openFileInIde(abs)`,**不过那道白名单** —— `../../.ssh/id_rsa`
 * 会被原样交给编辑器打开。而"配置只有本机用户写得了"这个前提也已经不成立:设置页有 JSON
 * 导入(`coerceCustomUiConfig`),一份别人给的配置就能带着这样一条进来。
 *
 * 绝对路径仍然放行(等价于用户自己在本机打开一个文件,而且页签那条路上读文件的 RPC 照旧
 * 会拦);拦的是**看起来在项目里、实际越界**的那种写法 —— 那一种没有任何正当用途。
 */
export function resolveWorkspacePath(path: string, projectPath: string | undefined): string | null {
  const p = path.trim();
  if (p.length === 0) return null;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)) return p;
  if (!projectPath) return null;
  // 相对路径里出现 `..` 一律拒(拆成段比,`..foo` 这种正常文件名不误伤)。
  if (p.split(/[\\/]+/).some((seg) => seg === "..")) return null;
  const sep = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const root = projectPath.replace(/[\\/]+$/, "");
  return `${root}${sep}${p.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

/** 本地日期 `YYYY-MM-DD`(`{{today}}`)。 */
export function localDateString(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 自定义项显示的名字(英文缺了回落中文)。 */
export function customUiLabel(text: CustomUiText, locale: "zh" | "en"): string {
  return locale === "en" && text.en ? text.en : text.zh;
}

/* ── 运行自动化(IPC)── */

/**
 * 自定义项「运行自动化」动作送给主进程的目标。
 *
 * 条目 / 分类 / 大类只给 id —— 展开成条目清单是主进程的事(它手上有库和回收站,
 * 渲染端的列表可能只是分页的一截)。
 */
export const CustomUiRunTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: z.string().min(1) }),
  z.object({ kind: z.literal("collection"), collectionId: z.string().min(1) }),
  z.object({ kind: z.literal("group"), groupId: z.string().min(1) }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(4096) }),
]);
export type CustomUiRunTarget = z.infer<typeof CustomUiRunTargetSchema>;

export const CustomUiRunAutomationSchema = z.object({
  workflowId: z.string().min(1),
  triggerNodeId: z.string().min(1),
  target: CustomUiRunTargetSchema,
  /** 展开时的条目跳过条件(见 automation 动作的 skipWhen;主进程逐条目复核)。 */
  skipWhen: CustomUiWhenSchema.optional(),
  /** 目标怎么用(见 automation 动作的 targetMode)。缺省 = `scope`,与老行为一致。 */
  targetMode: z.enum(["scope", "context"]).optional(),
  /** 运行前输入的值(键 = `inputs[].key`;files 是绝对路径数组)。 */
  input: z
    .record(
      z.string().regex(INPUT_KEY),
      z.union([z.string().max(4000), z.array(z.string().max(4096)).max(50)]),
    )
    .optional(),
  /** 只数一下这次会带多少条,不真跑 —— 批量跑之前给用户确认用。 */
  dryRun: z.boolean().optional(),
  /**
   * 用户在确认框上**看到并点头的那个条数**(只有走过 `dryRun` 的批量那条路会带)。
   *
   * 展开做两遍(数一遍、跑一遍),两遍之间库可能变了:确认框上写着 12 条,真跑时变成
   * 87 条 —— 用户点的头不是给这 87 条点的。对不上就整次拒绝,让他重新点一次右键。
   */
  expectCount: z.number().int().min(0).max(100_000).optional(),
});
export type CustomUiRunAutomationInput = z.infer<typeof CustomUiRunAutomationSchema>;

/** `ok: false` 时 `error` 是给人看的句子(同 `automation.run`)。`count` = 带进去的条目/文件数;
 * `skipped` = 被 `skipWhen` 跳过的条目数(没写条件时恒为 0/缺省)。 */
export type CustomUiRunAutomationResult = { ok: boolean; error?: string; count?: number; skipped?: number };
