/**
 * 资料库的**类型注册表** —— 「这个库里有哪几类东西」从写死的枚举改成可配置的一份表。
 *
 * ## 为什么要有它
 *
 * 过去的库是三个写死的 kind(`paper` / `textbook` / `note`),模版是另一套写死的五个
 * 类目。用户要的是**一个**统一的资料库:pdf、md、ppt、照片、word、文件夹都在一处,
 * 分类叫什么、有几类,由用户自己定。所以 kind 从三值联合放宽成开放字符串,而
 * 「哪些字符串是合法的、每类叫什么名字、给 AI 什么说明」就落在这一份注册表上。
 *
 * ## 三个刻意的设计
 *
 * ### 1. 注册表存设置表,校验放这里(纯函数)
 *
 * 本文件**不碰 DB**:contracts 是三端共享的纯层,而注册表的真身在主进程的 settings
 * 表里(键 `library.types`)。这里只给「一份 JSON 是不是合法的注册表」的判定 ——
 * 主进程读写前后各过一遍,渲染端编辑时也能预检。
 *
 * ### 2. `purpose` 区分"资料"和"格式"
 *
 * 上下文继承(见 `contextInherit.ts`)有一判据:库条目是给 AI 读的**资料**
 * (`material`),模版是让 AI 照着写的**格式**(`format`)。自定义类型必须声明自己
 * 是哪一种,否则那条链就断了。内置 8 类:前三个沿用旧 kind(原 id 不动,老数据
 * 零迁移),后五个接住旧模版类目(M4 迁移用)。
 *
 * ### 3. `prompt` 是"给 AI 的说明",不是界面文案
 *
 * 每个类型一段说明(这类东西是什么、处理时注意什么),拼进清单与条目返回里;
 * 界面上的显示名走 `name`。`builtin` 标记哪些是出厂自带 —— 内置类型可以改名改
 * 说明,但**删不掉**(老数据的 kind 还指着它们)。
 */

/** 这一类东西在上下文继承里的角色:给 AI 读的资料,还是让 AI 照着写的格式。 */
export type LibraryTypePurpose = "material" | "format";

/** 类型注册表的一条。 */
export interface LibraryTypeMeta {
  /** 小写连字符,如 `paper` / `slides`。同时是 `library_items.kind` 的合法取值。 */
  id: string;
  /** 界面显示名(用户可改),如「论文」「幻灯」。 */
  name: string;
  /** 图标名,渲染端按名字挑图标;认不出就退回默认图标。 */
  icon?: string;
  /** 给 AI 的一段说明:这类东西是什么、引用/处理时注意什么。空 = 不注入。 */
  prompt?: string;
  purpose: LibraryTypePurpose;
  /** 出厂自带的那几类。可改名/改说明,不可删除。 */
  builtin: boolean;
}

/** 注册表存设置表的键(值 = JSON 数组的 `LibraryTypeMeta`)。 */
export const LIBRARY_TYPES_SETTING_KEY = "library.types";

/**
 * 左栏的**大类** —— 「文档」「模版」那种段落,用户可自定义。
 *
 * ## 它和类型注册表的关系
 *
 * 大类是**一级分区**(左栏一段),类型是**段内的一个 tab**。每类条目只在一个大类
 * 出现(`kinds` 里不许重复)—— 段是"东西放在哪"的唯一答案,一个类型出现在两段里
 * 用户就得猜"刚才那份在哪个下面"。设置页保存时强制这一点。
 *
 * 没被任何大类收编的类型**不显示 tab**,但条目还在库里(检索、AI 清单都到得了)
 * —— 新建类型忘分组的话,东西不会丢,只是左栏看不见。
 */
export interface LibraryGroupMeta {
  id: string;
  /** 左栏段落标题(如「文档」「模版」)。 */
  name: string;
  /** 这个大类包含哪些类型(引用 `LibraryTypeMeta.id`,按显示顺序)。 */
  kinds: string[];
  /**
   * 这个大类的**给 AI 的说明**。三层提示词的最外层(大类 → 类型 → 集合),拼进
   * 该组内所有清单的开头 —— 「这一段东西整体上是什么、处理时的大原则」。不写就没有。
   */
  prompt?: string;
}

/** 大类存设置表的键(值 = JSON 数组的 `LibraryGroupMeta`)。 */
export const LIBRARY_GROUPS_SETTING_KEY = "library.groups";

/**
 * 出厂的两个大类 —— 与旧左栏的观感一致:「文档」收资料(material 三个 + 通用文档),
 * 「模版」收照着写的(format 其余四个,含 word 模版迁移过来的 document 的老伙计们)。
 *
 * ⚠️ `document` 归**模版**组:旧模版段的 Word 模版迁移后 kind 就是它,放这儿新旧
 * 观感一致;当纯资料用的 word 文档也可以在设置里把它挪去「文档」—— 这正是大类
 * 可配置的意义。
 */
export const DEFAULT_LIBRARY_GROUPS: readonly LibraryGroupMeta[] = [
  // ⚠️ **「模版」排在「文档」上面**（2026-09-21）。用户的原话：「模版要在文档上面」。
  //
  // 早先是文档在前。顺序本身没有对错，但用户平时先看的是模版那一段（他要照着写），
  // 所以按他的用法把它提到最前。
  //
  // ⚠️ 改这里**只影响还没存过组表的库** —— 一旦用户在设置里动过（或新建过大类），
  // 存下来的那份就是准的，这份出厂表就不再生效。见 `kindRegistry.loadLibraryGroups`。
  { id: "templates", name: "模版", kinds: ["document", "slides", "latex", "code", "image"] },
  { id: "docs", name: "文档", kinds: ["paper", "textbook", "note"] },
];

/**
 * 校验一份大类表。**纯函数**(同 `parseLibraryTypesJson`):形状、id 唯一、
 * **一个类型只能属于一个大类**。类型 id 是否真在注册表里,这里查不了(注册表是
 * 另一份 JSON),由主进程保存时合并校验 —— 那里的错误口径是"过滤掉而不是拒绝",
 * 见 `kindRegistry.loadLibraryGroups`。
 */
export function parseLibraryGroupsJson(
  raw: unknown,
): { ok: true; groups: LibraryGroupMeta[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "大类表应该是一组条目" };
  const seenIds = new Set<string>();
  const seenKinds = new Map<string, string>();
  const out: LibraryGroupMeta[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, error: "大类条目应该是对象" };
    }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return { ok: false, error: `大类 id 不合法:${String(id)} —— 要小写字母开头的连字符串` };
    }
    if (seenIds.has(id)) return { ok: false, error: `大类 id 重复:${id}` };
    seenIds.add(id);
    const name = e.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: `大类 ${id} 缺名字` };
    }
    const kinds = e.kinds;
    if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string" || k.length === 0)) {
      return { ok: false, error: `大类 ${id} 的类型应该是一组类型 id` };
    }
    for (const k of kinds) {
      const owner = seenKinds.get(k);
      if (owner !== undefined) {
        return { ok: false, error: `类型「${k}」同时出现在「${owner}」和「${name.trim()}」—— 一个类型只能在一个大类里` };
      }
      seenKinds.set(k, name.trim());
    }
    const prompt = e.prompt;
    if (prompt !== undefined && typeof prompt !== "string") {
      return { ok: false, error: `大类 ${id} 的说明应该是文字` };
    }
    out.push({
      id,
      name: name.trim(),
      kinds: [...new Set(kinds as string[])],
      ...(prompt !== undefined && prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
    });
  }
  return { ok: true, groups: out };
}

/**
 * 出厂自带的 8 类。
 *
 * ⚠️ **前三个的 id 与旧 `LIBRARY_KINDS` 逐字一致** —— 老库里的行、老分类的 kind、
 * 用户存档里挂资料的类目全都指着它们,id 一变就是一次全库迁移。后五个是旧模版
 * 五类目的新家(ppt→slides、word→document,其余原名),M4 迁移按这个映射搬。
 */
export const BUILTIN_LIBRARY_TYPES: readonly LibraryTypeMeta[] = [
  { id: "paper", name: "论文", purpose: "material", builtin: true },
  { id: "textbook", name: "教材", purpose: "material", builtin: true },
  { id: "note", name: "笔记", purpose: "material", builtin: true },
  { id: "document", name: "文档", icon: "doc", purpose: "format", builtin: true },
  { id: "slides", name: "幻灯", icon: "slides", purpose: "format", builtin: true },
  { id: "latex", name: "LaTeX 模版", icon: "latex", purpose: "format", builtin: true },
  { id: "code", name: "代码模版", icon: "code", purpose: "format", builtin: true },
  { id: "image", name: "配图模版", icon: "image", purpose: "format", builtin: true },
];

/** 内置类型的 id 集合(旧代码里 `isLibraryKind` 的接替者之一:判"是不是出厂类")。 */
export const BUILTIN_LIBRARY_TYPE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_LIBRARY_TYPES.map((t) => t.id),
);

/** 自定义类型的 id 规则:小写字母开头,后面小写字母/数字/连字符。和节点类型 id 的
 *  约束同 spirit —— 它会出现在清单文件名、附件键、路径里,不能带空格和大小写二义。 */
const ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 校验一份注册表 JSON。**纯函数**,主进程存取前后、渲染端保存前都过它。
 *
 * 通过的数组会带上补全(缺省 icon/prompt 规整为 undefined),但不保证顺序 ——
 * 顺序由调用方决定(界面按数组序展示)。
 */
export function parseLibraryTypesJson(
  raw: unknown,
): { ok: true; types: LibraryTypeMeta[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "类型注册表应该是一组条目" };
  const seen = new Set<string>();
  const out: LibraryTypeMeta[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, error: "类型条目应该是对象" };
    }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return { ok: false, error: `类型 id 不合法:${String(id)} —— 要小写字母开头的连字符串` };
    }
    if (seen.has(id)) return { ok: false, error: `类型 id 重复:${id}` };
    seen.add(id);
    const name = e.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: `类型 ${id} 缺显示名` };
    }
    const purpose = e.purpose;
    if (purpose !== "material" && purpose !== "format") {
      return { ok: false, error: `类型 ${id} 的用途应该是 material 或 format` };
    }
    const prompt = e.prompt;
    if (prompt !== undefined && typeof prompt !== "string") {
      return { ok: false, error: `类型 ${id} 的说明应该是文字` };
    }
    const icon = e.icon;
    if (icon !== undefined && typeof icon !== "string") {
      return { ok: false, error: `类型 ${id} 的图标名应该是文字` };
    }
    const builtin = e.builtin;
    if (builtin !== undefined && typeof builtin !== "boolean") {
      return { ok: false, error: `类型 ${id} 的 builtin 标记应该是开关` };
    }
    out.push({
      id,
      name: name.trim(),
      ...(icon !== undefined && icon.length > 0 ? { icon } : {}),
      ...(prompt !== undefined && prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
      purpose,
      builtin: builtin === true,
    });
  }
  // **内置类必须还在**:用户可以改它们的名字和说明,但删掉的话,老数据里指着
  // `paper` 的那些行就变成了"注册表不认识的 kind" —— 界面、清单、过滤全线失语。
  const missing = BUILTIN_LIBRARY_TYPES.filter((b) => !seen.has(b.id)).map((b) => b.id);
  if (missing.length > 0) {
    return { ok: false, error: `内置类型不能删除:${missing.join("、")}` };
  }
  return { ok: true, types: out };
}

/* ─────────────────────────────── 屏蔽规则 ─────────────────────────────── */

/** 屏蔽规则存设置表的键(值 = JSON 的 `LibrarySuppressRule`)。 */
export const LIBRARY_SUPPRESS_SETTING_KEY = "library.suppress";

/**
 * 屏蔽规则 —— **哪些资料不进上下文**。
 *
 * 用户的原话:「设置页面的资料库类型页……还有屏蔽集合的,屏蔽是合集,选择任意分级,
 * 任意个数,同时选择文件类型」,以及「就算是我手动挂的一个文件,只要是屏蔽状态,
 * 也挂不上去」—— 所以它是**硬过滤**:入口与关联一视同仁,手动挂的也算。
 *
 * ## 为什么是一个扁平的 `nodes` 数组而不是三个字段
 *
 * 要屏蔽的节点在**任意层级**上:大类 / 类型 / 集合,而且**任意个数**。做成三个字段
 * (`groups` / `types` / `collections`)的话,"再加一个层级"就变成改契约 + 改界面 +
 * 改存储。扁平数组 + 前缀是同一件事的更小表达,而前缀的合法性校验在 `parseSuppressJson`
 * 里一处收敛。
 *
 * ## 向下继承
 *
 * 屏蔽一个节点 = 它自己**以及它下面的一切**都进不了上下文。屏蔽「文档」大类,它下面
 * 的 `paper` 条目同样挂不上。判定的算法在 `main/library/suppress.ts`(要查祖先链,
 * 那是它才做得了的事);契约这一层只负责形状与合法性。
 */
export interface LibrarySuppressRule {
  /**
   * 被屏蔽的节点,格式 `<层>:<id>`:
   *
   *   `group:docs`          大类
   *   `type:paper`          类型
   *   `collection:abc123`   集合
   *
   * 集合 id 是不透明的(不是 `ID_RE` 那种连字符串),所以**校验时只查前缀**,
   * 不查 id 的形状 —— id 存不存在是主进程的事(它拿得到 DB)。
   */
  nodes: string[];
  /**
   * 额外按**文件扩展名**屏蔽(小写含点,如 `.zip` / `.pdf`)。
   *
   * 与 `nodes` 正交:前者按"这东西归哪儿"挡,后者按"它是什么文件"挡。用户两个都要
   * (「同时选择文件类型」)。
   */
  extensions: string[];
}

/** 空规则 —— 什么都没屏蔽。用户没存过时读出来的就是它。 */
export const EMPTY_LIBRARY_SUPPRESS: LibrarySuppressRule = { nodes: [], extensions: [] };

/** 层前缀 —— 与 `LibrarySuppressRule.nodes` 里的三种取值一一对应。 */
export const SUPPRESS_NODE_LEVELS = ["group", "type", "collection"] as const;
export type SuppressNodeLevel = (typeof SUPPRESS_NODE_LEVELS)[number];

/** 拼一个节点键。三处(界面、主进程、测试)都该用它,免得手写前缀写岔。 */
export function suppressNodeKey(level: SuppressNodeLevel, id: string): string {
  return `${level}:${id}`;
}

/** 拆一个节点键。前缀不合法返回 `null`(调用方据此跳过,而不是抛)。 */
export function parseSuppressNodeKey(key: string): { level: SuppressNodeLevel; id: string } | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const level = key.slice(0, at) as SuppressNodeLevel;
  const id = key.slice(at + 1);
  if (!(SUPPRESS_NODE_LEVELS as readonly string[]).includes(level)) return null;
  if (id.length === 0) return null;
  return { level, id };
}

/**
 * 扩展名规范化:补上开头的点、转小写。`zip` / `.ZIP` / `.zip` 都变成 `.zip`。
 *
 * 存之前统一过这一道,是为了让判定那一侧可以拿 `extname(p).toLowerCase()` 直接比
 * —— 两边形状不一致的话,用户存了 `.ZIP` 而文件是 `.zip`,屏蔽会**静静地不生效**。
 */
export function normalizeSuppressExt(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.length === 0) return "";
  return t.startsWith(".") ? t : `.${t}`;
}

/**
 * 校验一份屏蔽规则 JSON。**纯函数**(同 `parseLibraryTypesJson` / `parseLibraryGroupsJson`)。
 *
 * 校验口径与前两个刻意不同:**前缀不合法就丢掉那一条,不拒绝整份**。
 *
 * 理由是这两份东西的性质不一样:类型注册表/大类表是**结构**(少一个内置类,老数据
 * 全线失语),所以宁可整个拒绝;屏蔽规则是一串**独立的勾选**,某一条失效(比如那个
 * 集合已经被删了、或前缀是旧版本写的)不该把用户其余的屏蔽一起作废 —— 那等于偷偷
 * 放开一批他明确要挡的东西,而这个模块的存在意义就是"别偷偷放开"。
 *
 * 去重后保持顺序(界面上的勾选顺序大体是用户的操作顺序,不重排)。
 */
export function parseSuppressJson(
  raw: unknown,
): { ok: true; rule: LibrarySuppressRule } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "屏蔽规则应该是一个对象" };
  }
  const e = raw as Record<string, unknown>;

  const nodesRaw = e.nodes ?? [];
  if (!Array.isArray(nodesRaw)) return { ok: false, error: "屏蔽的节点应该是一组键" };
  const seenNodes = new Set<string>();
  const nodes: string[] = [];
  for (const n of nodesRaw) {
    if (typeof n !== "string") continue;
    const parsed = parseSuppressNodeKey(n.trim());
    if (!parsed) continue; // 前缀认不出 —— 丢掉这一条,不废掉整份
    if (seenNodes.has(n.trim())) continue;
    seenNodes.add(n.trim());
    nodes.push(n.trim());
  }

  const extsRaw = e.extensions ?? [];
  if (!Array.isArray(extsRaw)) return { ok: false, error: "屏蔽的扩展名应该是一组字符串" };
  const seenExts = new Set<string>();
  const extensions: string[] = [];
  for (const x of extsRaw) {
    if (typeof x !== "string") continue;
    const norm = normalizeSuppressExt(x);
    if (norm.length === 0) continue;
    if (seenExts.has(norm)) continue;
    seenExts.add(norm);
    extensions.push(norm);
  }

  return { ok: true, rule: { nodes, extensions } };
}
