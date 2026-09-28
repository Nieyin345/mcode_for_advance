/**
 * **自定义 UI** —— 主界面只放入口,点下去做什么、显示什么,全在设置页里定义。
 *
 * ## 这份契约管什么
 *
 * 主界面上有几个**挂载位**(slot):资料库四级右键(条目 / 分类 / 小类 / 大类)与
 * 右栏 Files 的文件右键。每个挂载位上的菜单由三种**条目**拼成:
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
 * 动作只有四种声明式的:打开视图(Markdown 模板)、发给对话(提示词模板)、复制文本、
 * 运行自动化。要写逻辑就去写自动化/工作流 —— 那边有审阅、有运行记录、有权限边界。
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
 *
 * 右栏自定义页签与最右侧竖向工具栏是下一期(P3),届时往这里加值 —— 旧配置里没有
 * 它们的布局,按默认处理,不需要迁移。
 */
export const CUSTOM_UI_SLOTS = [
  "library.item",
  "library.collection",
  "library.subcategory",
  "library.group",
  "files.context",
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
   * (条目 / 分类 / 大类 → 条目清单,文件 → 文件列表)。
   */
  z.object({
    type: z.literal("automation"),
    workflowId: z.string().min(1).max(200),
    triggerNodeId: z.string().min(1).max(200),
  }),
]);
export type CustomUiAction = z.infer<typeof CustomUiActionSchema>;
export type CustomUiActionType = CustomUiAction["type"];

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
      // id 重复只留第一条:布局键靠 id 区分,两条同 id 会让排序/隐藏同时作用在两条上
      if (r.success && !seen.has(r.data.id)) {
        seen.add(r.data.id);
        items.push(r.data);
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
  | { kind: "file"; projectPath: string; path: string };

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
  }
}

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
};

/**
 * 渲染 `{{ 变量 }}`。认不出的变量渲染成空串 —— 不留原样:原样留着的 `{{item.foo}}`
 * 被发给模型,它会以为那是要它填的东西。
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? "") : "",
  );
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
      target.kind === "group" ? target.group.id : target.kind === "file" ? undefined : target.groupId;
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
      target.kind === "file"
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
  return "file";
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
  /** 只数一下这次会带多少条,不真跑 —— 批量跑之前给用户确认用。 */
  dryRun: z.boolean().optional(),
});
export type CustomUiRunAutomationInput = z.infer<typeof CustomUiRunAutomationSchema>;

/** `ok: false` 时 `error` 是给人看的句子(同 `automation.run`)。`count` = 带进去的条目/文件数。 */
export type CustomUiRunAutomationResult = { ok: boolean; error?: string; count?: number };
