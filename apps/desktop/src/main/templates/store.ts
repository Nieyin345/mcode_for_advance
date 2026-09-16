/**
 * 模版库:文件系统即事实源。
 *
 * ## 为什么没有数据库表
 *
 * 见 `contracts/src/templates.ts` 顶部的说明:模版就是一包文件,而用户**一定会在
 * 资源管理器里直接动它们**。做成 DB 表必然漂移。所以这里直接扫目录:
 * `<库根>/<类目>/<条目名>/` 就是一条模版,**目录名就是显示名**。
 *
 * 代价是显示名不能带 `\ / : * ? " < > |`(在 Windows 上建不出来)—— 导入时用
 * `sanitizeTemplateName` 净化,并把净化后的结果当作真正的名字返回给界面。
 *
 * ## 清单(给 AI 读的那份)
 *
 * 与文献库同一套:生成一份 Markdown 列清楚文件与**绝对路径**,对话里只放
 * `@该路径`。小的文本/代码文件直接把内容也贴进去 —— 模版本身就是拿来照着做的,
 * 让 AI 立刻看到内容比让它再 Read 一次更省一轮。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { IPC } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import type { Dirent } from "node:fs";
import { log } from "@main/lib/logger.js";
import {
  TEMPLATE_KINDS,
  classifyTemplateFile,
  sanitizeTemplateName,
  templateAttachKey,
  type TemplateEntry,
  type TemplateFile,
  type TemplateKind,
} from "@contracts/templates";

/** 扫一条模版时最多走这么深 —— 防有人把整个项目目录当模版导进来。 */
const MAX_DEPTH = 4;
/** 单条模版最多记这么多文件。 */
const MAX_FILES = 500;
/** 清单里内联正文的总预算(字节)。超过就只列路径。 */
const MANIFEST_INLINE_BUDGET = 40 * 1024;

/**
 * 模版根目录 —— **统一数据根下的 `templates/`**(`<数据根>/templates`)。
 *
 * 早先这里自己算默认位置、还带一套搬迁逻辑(踩过 OneDrive 重定向"文档"的坑)。
 * 现在统一数据根把「放哪儿」这件事收到一处:这里只管拼路径,搬迁由
 * `main/lib/dataRoot.ts` 负责。
 */
export function templatesRoot(): string {
  return join(dataRoot(), "templates");
}

function kindDir(kind: TemplateKind): string {
  return join(templatesRoot(), kind);
}

/**
 * 确保库根与五个类目目录都在。**幂等**,面板一打开就调。
 *
 * 为什么必须主动建:
 *   1. 界面上显示的那个路径**一定得存在** —— 否则用户照着去资源管理器里找,
 *      发现根本没有,会以为坏了(实际发生过);
 *   2. 用户可以直接把文件 / 文件夹拖进对应类目 —— **文件系统即事实源**本来就是这个
 *      设计,把骨架先摆好才谈得上"往里丢"。
 */
export function ensureTemplateDirs(): string {
  const root = templatesRoot();
  for (const k of TEMPLATE_KINDS) {
    try {
      mkdirSync(join(root, k), { recursive: true });
    } catch {
      // 权限之类的问题留给后续写入去报错,这里不吞成致命错误
    }
  }
  return root;
}

export function templateDirPath(kind: TemplateKind, dirName: string): string {
  return join(kindDir(kind), dirName);
}

/** 递归收集文件。超过深度/条数就停 —— 模版不该是几万文件的树。 */
function walkFiles(base: string, dir: string, out: TemplateFile[], depth: number): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 读不动就跳过这一层,不让整次列表失败
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith(".")) continue; // .DS_Store / Thumbs.db 之类
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkFiles(base, full, out, depth + 1);
      continue;
    }
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    out.push({
      relPath: relative(base, full).split("\\").join("/"),
      size,
      role: classifyTemplateFile(e.name),
    });
  }
}

function readEntry(kind: TemplateKind, dirName: string): TemplateEntry | null {
  return readEntryAt(kind, dirName, templateDirPath(kind, dirName));
}

/**
 * 读一条模版 —— 目录由调用方给。
 *
 * 需要这一层是因为**回收站里的模版也要被列出来**(见 `listTrashedTemplates`):它们
 * 的 `kind` 还是原来的类目,但目录在 `<类目>/回收站/` 里。再写一份几乎相同的扫描
 * 代码只会让两边的字段慢慢分叉。
 */
function readEntryAt(kind: TemplateKind, dirName: string, dir: string): TemplateEntry | null {
  let mtime = 0;
  try {
    if (!statSync(dir).isDirectory()) return null;
    mtime = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  const files: TemplateFile[] = [];
  walkFiles(dir, dir, files, 0);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    kind,
    dirName,
    path: resolve(dir),
    files,
    imageCount: files.filter((f) => f.role === "image").length,
    codeFiles: files.filter((f) => f.role === "code").map((f) => f.relPath),
    updatedAt: mtime,
  };
}

/** 列模版。不传 kind 就是全部类目。最近动过的排前面。 */
export function listTemplates(kind?: TemplateKind): TemplateEntry[] {
  // 先保证骨架在 —— 这样"打开面板"或"切类目"都会把目录建出来,用户随时能往里丢文件
  ensureTemplateDirs();
  const kinds = kind ? [kind] : [...TEMPLATE_KINDS];
  const out: TemplateEntry[] = [];
  for (const k of kinds) {
    let names: string[] = [];
    try {
      names = readdirSync(kindDir(k), { withFileTypes: true })
        // 「回收站」是同类目下的一个特殊目录,它自己也符合"是个目录" —— 不排除的话
        // 它会作为一条模版列出来
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isTrashDir(e.name))
        .map((e) => e.name);
    } catch {
      // 目录还不存在 = 这个类目还没有模版,正常
    }
    for (const n of names) {
      const entry = readEntry(k, n);
      if (entry) out.push(entry);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export type AddResult =
  | { ok: true; entries: TemplateEntry[]; dirName: string }
  | { ok: false; error: string };

/**
 * 给一条模版改名 —— 改的是**磁盘上那个目录**(这个库的约定:目录名即显示名)。
 *
 * 与文献库那边改一个分类的名字是同一件事的两个形态:那边改数据库里一行,这边改
 * 磁盘上一个目录。所以用户看到的两个段落有同一套操作(左栏那两段的行尾按钮、右键
 * 菜单都是照着对齐的),而不是"文档能改名、模版不能"。
 *
 * 两条守卫与 `addTemplate` 一致:
 *   1. 净化后为空 → 拒绝(名字会被当目录名,非法字符在 Windows 上直接建不出来);
 *   2. 目标位置已经有一条 → **拒绝,不覆盖**。覆盖等于悄悄抹掉用户另做的那一套,
 *      而"文件系统即事实源"这条设计的立身之本就是不背着用户动东西。
 *
 * 改完那个旧名字的清单会留在 `.manifests/<类目>/` 下变成孤儿 —— 不管它:清单每次
 * 挂进对话时都重写,下一次挂新名字就写出新的那份,而留在那儿的只是一份几十 KB 的
 * Markdown,不影响任何判断。
 */
export function renameTemplate(
  kind: TemplateKind,
  dirName: string,
  name: string,
): { ok: boolean; error?: string; dirName?: string } {
  if (invalidEntryName(dirName)) return { ok: false, error: "目录名不合法" };
  const safe = sanitizeTemplateName(name);
  if (!safe) return { ok: false, error: "名字里没有可用字符" };
  // 净化完跟原来一样 = 用户只是点开又确认,不是错误(与文献库改分类名同一处理)
  if (safe === dirName) return { ok: true, dirName: safe };

  const from = templateDirPath(kind, dirName);
  if (!existsSync(from)) return { ok: false, error: `找不到模版「${dirName}」` };
  const to = templateDirPath(kind, safe);
  if (existsSync(to)) return { ok: false, error: `「${safe}」已存在` };

  try {
    renameSync(from, to);
    return { ok: true, dirName: safe };
  } catch (err) {
    return { ok: false, error: `改名失败:${(err as Error).message}` };
  }
}

/**
 * 新建一条模版:建目录 + 把 sourcePaths 里的文件/文件夹复制进去。
 *
 * **复制而不是引用** —— 与文献库一致:库是一个自洽的位置,原文件留在用户原处。
 * 文件夹会整包复制(LaTeX 模版常常是 .cls + .tex + 图片一整套)。
 */
export function addTemplate(kind: TemplateKind, name: string, sourcePaths: string[]): AddResult {
  const safe = sanitizeTemplateName(name);
  if (!safe) return { ok: false, error: "名字里没有可用字符" };

  const dir = templateDirPath(kind, safe);
  if (existsSync(dir)) {
    // 同名就报错而不是合并 —— 合并会让"我到底往里放了什么"变得不可知
    return { ok: false, error: `「${safe}」已存在` };
  }
  const sources = sourcePaths.filter((p) => existsSync(p));
  if (sources.length === 0) return { ok: false, error: "选中的文件都不存在" };

  try {
    mkdirSync(dir, { recursive: true });
    for (const src of sources) {
      const base = src.split(/[\\/]/).pop() ?? "file";
      // 覆盖同名项:用户明确选了它,意图就是放进来
      cpSync(src, join(dir, base), { recursive: true });
    }
  } catch (err) {
    // 半途失败就把刚建的目录清掉,别在库里留一条空壳
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
    return { ok: false, error: `复制失败:${(err as Error).message}` };
  }
  return { ok: true, entries: listTemplates(kind), dirName: safe };
}

/* ── 回收站 ── */

/**
 * 回收站目录名。
 *
 * ## 每个类目**各自**有一个
 *
 * 用户的要求是「文档部分的做法是每个部分都有自己独立的回收站,像文献,教材,笔记,
 * 模版也应该这么做」。文献库那边确实是三个库各一个回收站(见 `library/trash.ts`),
 * 所以模版这边也是**每个类目一个**:`<库根>/<类目>/回收站/`。
 *
 * 这么摆还有两个顺带的好处:
 *   1. 移进回收站 = **同一个类目目录内的改名**,一次 `rename` 就完了,不可能跨卷失败;
 *   2. 用户在资源管理器里翻 `<类目>/` 就能看见自己的回收站,与「文件系统即事实源」
 *      这条设计一脉相承 —— 和文献库「回收站只是一个叫回收站的 collection」是同一种
 *      思路:它不是一个藏起来的状态位,而是一个看得见、进得去的地方。
 *
 * ## 它必须在 `listTemplates` 里被排除
 *
 * 否则回收站自己会被当成一条模版列出来(它确实是一个目录)。排除的判据就是这个名字,
 * 而不是什么隐藏标记 —— 用户自己建一个叫「回收站」的模版目录,那它也是回收站,与
 * 文献库那边的判据一致。
 */
const TRASH_DIR_NAME = "回收站";

/** 某个类目的回收站目录。 */
function trashKindDir(kind: TemplateKind): string {
  return join(kindDir(kind), TRASH_DIR_NAME);
}

function trashedDirPath(kind: TemplateKind, dirName: string): string {
  return join(trashKindDir(kind), dirName);
}

/** 是不是回收站目录 —— 它不该出现在模版列表里(它也进不了回收站)。 */
function isTrashDir(name: string): boolean {
  return name === TRASH_DIR_NAME;
}

/**
 * 这个名字能不能当"一条模版"的目录名。
 *
 * 两条都得挡:
 *   1. **必须是单层** —— 否则 `..` 能一路爬出去,把库外面整个搬走或删掉;
 *   2. **不能是「回收站」** —— 它是容器,不是条目。不挡的话 `templateEntryDir` 会把
 *      它当成一条模版解析(于是"这一条模版"的文件列表变成整个回收站里的东西),
 *      而"把回收站移进它自己"这种调用也会走到 rename 那一层才报错,错误信息很难懂。
 */
function invalidEntryName(dirName: string): boolean {
  return (
    dirName.includes("/") ||
    dirName.includes("\\") ||
    dirName === ".." ||
    dirName === "." ||
    isTrashDir(dirName)
  );
}

export type TemplateOpResult = { ok: true } | { ok: false; error: string };

/**
 * 把一条模版**移进回收站** —— 界面上那个「删除」做的事,**可逆**。
 *
 * 与文献库的对应关系:那边的「从当前文献库移除」是把条目摘出分组、孤儿落进回收站;
 * 这边是把目录整个搬进 `回收站/<原类目>/`。两边都是"先留一条退路",真正的删除都
 * 只在回收站里做(见 `purgeTemplate`)。
 *
 * 同名撞车(删掉、又建了个同名的、又删)时**自动加序号**而不是报错:目录名即显示名,
 * 一个 `foo (2)` 用户看得懂;而"请先去清空回收站"是让用户为程序的内部约束跑腿。
 */
export function trashTemplate(kind: TemplateKind, dirName: string): TemplateOpResult {
  if (invalidEntryName(dirName)) return { ok: false, error: "目录名不合法" };
  const from = templateDirPath(kind, dirName);
  if (!existsSync(from)) return { ok: false, error: `找不到模版「${dirName}」` };
  let name = dirName;
  try {
    mkdirSync(trashKindDir(kind), { recursive: true });
    for (let i = 2; existsSync(trashedDirPath(kind, name)); i += 1) name = `${dirName} (${i})`;
    // 两端都在模版根下 → 同一个卷,rename 是原子的、瞬间的
    renameSync(from, trashedDirPath(kind, name));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `移到回收站失败:${(err as Error).message}` };
  }
}

/**
 * 从回收站**还原**回原来的类目。
 *
 * 放回的位置已经被占(用户在这期间又建了个同名的)时**如实报错、不覆盖** —— 覆盖
 * 等于悄悄删掉用户新做的那一条,而这一整个功能的立身之本就是"删了能捞回来"。
 */
export function restoreTemplate(kind: TemplateKind, dirName: string): TemplateOpResult {
  if (invalidEntryName(dirName)) return { ok: false, error: "目录名不合法" };
  const from = trashedDirPath(kind, dirName);
  if (!existsSync(from)) return { ok: false, error: `回收站里没有「${dirName}」` };
  const to = templateDirPath(kind, dirName);
  if (existsSync(to)) {
    return {
      ok: false,
      error: `这个类目里已经有一条「${dirName}」—— 先给它改名或删掉,再还原这一条`,
    };
  }
  try {
    mkdirSync(kindDir(kind), { recursive: true });
    renameSync(from, to);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `还原失败:${(err as Error).message}` };
  }
}

/**
 * 从回收站里**彻底删掉** —— 目录连同里面的文件一起从磁盘上消失,**不可还原**。
 *
 * 这是模版库唯一不可逆的操作,所以只在回收站里提供(见 TemplateContextMenu)。
 */
export function purgeTemplate(kind: TemplateKind, dirName: string): TemplateOpResult {
  if (invalidEntryName(dirName)) return { ok: false, error: "目录名不合法" };
  const dir = trashedDirPath(kind, dirName);
  if (!existsSync(dir)) return { ok: false, error: `回收站里没有「${dirName}」` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `彻底删除失败:${(err as Error).message}` };
  }
}

/**
 * 列回收站里的全部模版。最近丢进去的排前面。
 *
 * 类目从**目录结构**读(`回收站/<kind>/<名字>`)—— 那是"它原来属于哪个类目"唯一的
 * 记录,而还原要用它。认不出来的子目录直接跳过(用户可能自己在里面建了别的东西),
 * 不猜。
 */
export function listTrashedTemplates(): TemplateEntry[] {
  const out: TemplateEntry[] = [];
  for (const kind of TEMPLATE_KINDS) {
    let names: string[] = [];
    try {
      names = readdirSync(trashKindDir(kind), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      continue; // 这个类目还没丢过东西
    }
    for (const n of names) {
      // 类目从**调用点**给,不再从目录结构里读 —— 回收站就在类目自己下面了
      const entry = readEntryAt(kind, n, trashedDirPath(kind, n));
      if (entry) out.push(entry);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * 一条模版在磁盘上的位置 —— 先在类目目录里找,**再找回收站**。找不到返回 null。
 *
 * 凡是"按类目 + 目录名定位一条模版"的地方都该走它:「在文件夹中打开」如果只看类目
 * 目录,回收站里那一条会被判成"目录不在了(可能已在磁盘上被删)"—— 而它明明就在
 * 回收站里躺着。
 */
export function templateEntryDir(kind: TemplateKind, dirName: string): string | null {
  if (invalidEntryName(dirName)) return null;
  const own = templateDirPath(kind, dirName);
  if (existsSync(own)) return own;
  const trashed = trashedDirPath(kind, dirName);
  return existsSync(trashed) ? trashed : null;
}

/**
 * 找一条模版 —— 类目目录与回收站都认。
 *
 * 回收站里的模版**照样可以挂进对话、也可以预览**(与文献库一致:那边回收站只是一个
 * 普通分类,里面的条目照样能挂)。所以凡是"按类目+目录名找一条"的地方都走这里,而
 * 不是直接 `readEntry` —— 后者只认类目目录,会让回收站里的那一条报"不存在"。
 */
export function findTemplate(kind: TemplateKind, dirName: string): TemplateEntry | null {
  const dir = templateEntryDir(kind, dirName);
  return dir ? readEntryAt(kind, dirName, dir) : null;
}

/** 五个类目各自的中文名 —— 清单是给模型读的中文内容,不是界面文案,所以不走 i18n。 */
const KIND_LABEL_ZH: Record<TemplateKind, string> = {
  ppt: "PPT",
  latex: "论文 LaTeX",
  word: "Word",
  code: "代码",
  image: "图片",
};

/**
 * **整个类目的清单** —— 「全部 LaTeX 模版」那一行挂进对话时用的。
 *
 * 与一条模版的清单是两个粒度,内容也就不同:那个是"**这一套文件**是什么"(小文件
 * 正文都贴进去了),这个是**索引** —— 这个类目下有哪些模版、各自多少个文件、各自
 * 那份清单在哪。模型看完索引再决定读哪一份,几十条模版也不会一次把上下文吃光。
 *
 * 落点是 `.manifests/<类目>.md`,而单条的在 `.manifests/<类目>/<名字>.md` ——
 * 一文件一目录,不会撞名(`sanitizeTemplateName` 会剥掉开头的点,所以模版也不可能
 * 叫成 `<类目>` 那种名字)。
 */
export function writeTemplateKindManifest(kind: TemplateKind): {
  path: string;
  fileCount: number;
} {
  const entries = listTemplates(kind);
  const lines: string[] = [];
  lines.push(`# 模版类目:${KIND_LABEL_ZH[kind]}`);
  lines.push("");
  lines.push(`共 ${entries.length} 条模版。位置 \`${kindDir(kind)}\``);
  lines.push("");
  if (entries.length === 0) {
    lines.push("(这个类目还没有模版。)");
  } else {
    lines.push("| # | 模版 | 文件 | 位置 | 单条清单 |");
    lines.push("|---|------|------|------|----------|");
    entries.forEach((e, i) => {
      const manifest = join(templatesRoot(), ".manifests", kind, `${e.dirName}.md`);
      lines.push(
        `| ${i + 1} | ${e.dirName} | ${e.files.length} 个 | \`${e.path}\` | \`${manifest}\` |`,
      );
    });
    lines.push("");
    lines.push("要看某一条的细节(文件清单 + 小文件的正文),读它那一行的「单条清单」。");
  }

  const dir = join(templatesRoot(), ".manifests");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}.md`);
  writeFileSync(file, lines.join("\n"), "utf8");
  return { path: file, fileCount: entries.length };
}

/**
 * 生成给 AI 读的模版清单,返回它的绝对路径。
 *
 * 小文件(合计 40KB 以内)把正文也贴进去 —— 模版就是拿来照着做的,让 AI 一眼看到
 * 内容比让它再 Read 一次少一轮往返。超预算就只列路径(反正有绝对路径可以 Read)。
 */
export function writeTemplateManifest(
  kind: TemplateKind,
  dirName: string,
): { path: string; fileCount: number } {
  const entry = findTemplate(kind, dirName);
  if (!entry) throw new Error(`模版不存在:${kind}/${dirName}`);

  const lines: string[] = [];
  lines.push(`# 模版:${entry.dirName}`);
  lines.push("");
  lines.push(`类目:${kind} · 共 ${entry.files.length} 个文件 · 位置 \`${entry.path}\``);
  lines.push("");
  if (kind === "image" && (entry.imageCount > 0 || entry.codeFiles.length > 0)) {
    lines.push(`这是一组配图模版:**${entry.imageCount} 张图片对应下面这份代码**。`);
    lines.push("");
    if (entry.codeFiles.length > 0) {
      lines.push(`代码文件:${entry.codeFiles.map((f) => `\`${f}\``).join("、")}`);
      lines.push("");
    }
  }
  lines.push("## 文件清单");
  lines.push("");
  lines.push("| 文件 | 角色 | 大小 | 绝对路径 |");
  lines.push("|------|------|------|----------|");
  for (const f of entry.files) {
    const abs = join(entry.path, ...f.relPath.split("/"));
    lines.push(
      `| \`${f.relPath}\` | ${f.role === "image" ? "图片" : f.role === "code" ? "代码" : "其他"} | ${formatSize(f.size)} | \`${abs}\` |`,
    );
  }

  // 小文本文件内联正文
  let budget = MANIFEST_INLINE_BUDGET;
  const inlined: string[] = [];
  for (const f of entry.files) {
    if (f.role === "image" || budget <= 0) continue;
    if (f.size > budget) continue;
    const abs = join(entry.path, ...f.relPath.split("/"));
    try {
      const text = readFileSyncUtf8(abs);
      if (text === null) continue; // 二进制,跳过
      budget -= f.size;
      inlined.push(`### \`${f.relPath}\``);
      inlined.push("");
      inlined.push("```" + fenceLang(f.relPath));
      inlined.push(text.trimEnd());
      inlined.push("```");
      inlined.push("");
    } catch {
      /* 读不了就当它没内联 */
    }
  }
  if (entry.files.length === 0) {
    // 空模版是**可达状态**(用户在设置里建了名字却没往里放文件)。这时候说
    // "文件较大未内联"是错的 —— 会让人以为有内容只是没显示。如实说没有文件。
    lines.push("");
    lines.push("(这条模版目录是空的 —— 里面还没有任何文件。)");
  } else if (inlined.length > 0) {
    lines.push("");
    lines.push("## 文件内容");
    lines.push("");
    lines.push(...inlined);
  } else {
    lines.push("");
    // 这里曾经写的是「按上面的绝对路径用 Read 工具读」—— **对二进制是错的**。
    // Word / PPT / Excel / PDF 都是压缩包,Read 出来是乱码,模型会以为文件坏了
    // 或者空的。`readFileSyncUtf8` 对它们本来就返回 null(所以它们永远进不了
    // 内联那一支),也就是说这条提示最常触发的场景恰恰是它说错话的场景。
    lines.push(
      "(这些文件没有内联 —— 要么太大,要么是 Word / Excel / PPT / PDF 这类二进制。" +
        "二进制请用对应的文档技能读(见系统提示里的「二进制文档」一节),不要用 Read;" +
        "其余按上面的绝对路径 Read。)",
    );
  }

  const dir = join(templatesRoot(), ".manifests", kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${dirName}.md`);
  writeFileSync(file, lines.join("\n"), "utf8");
  return { path: file, fileCount: entry.files.length };
}

/**
 * 把一条模版挂到某个会话的**输入框**上 —— 左栏右键「添加到当前对话」。
 *
 * ## 与文献库那条路逐字同构
 *
 * 文献库的对应实现是 `library/manifest.ts` 的 `attachToChat`,两边做的是同一件事:
 * 先生成清单(每次重写,保证不过期),再用 `composer:attach` 广播回去;那个会话的
 * ChatPane 认领后往输入框里加一个 chip —— 与用户自己点「+ → 模版」落出来的 chip
 * 是同一种(同样的 `kind: "template"`、同样的去重键、同样随下一条消息发出去)。
 *
 * ## 为什么绕主进程
 *
 * 左栏和输入框不是同一棵组件树,而附件要发给**指定会话**的输入框。这与 AI 挂库走的
 * 是同一条路,所以"用户挂的"和"AI 挂的"必然长得一样。
 *
 * 返回 `ok: false` 时 `error` 一定有人话 —— 左栏会把它弹出来。清单生成会抛
 * (`writeTemplateManifest` 找不到目录就 throw),这里接住转成返回值。
 */
export function attachTemplateToChat(
  sessionId: string,
  kind: TemplateKind,
  /** 省略 = 挂**整个类目**(「全部 LaTeX 模版」那一行)。 */
  dirName?: string,
): { ok: boolean; name?: string; fileCount?: number; error?: string } {
  let manifest: { path: string; fileCount: number };
  let key: string;
  let name: string;
  try {
    if (dirName) {
      manifest = writeTemplateManifest(kind, dirName);
      key = templateAttachKey(kind, dirName);
      name = dirName;
    } else {
      manifest = writeTemplateKindManifest(kind);
      key = templateAttachKey(kind);
      name = KIND_LABEL_ZH[kind];
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    sendToRenderer(IPC.COMPOSER_ATTACH, {
      channel: IPC.COMPOSER_ATTACH,
      sessionId,
      kind: "template",
      key,
      name,
      manifestPath: manifest.path,
    });
  } catch {
    // sendToRenderer 自己会对"窗口已经没了"做好防护(见 window.ts),这里是纯兜底
    return { ok: false, error: "窗口没开着,挂不上去" };
  }
  return { ok: true, name, fileCount: manifest.fileCount };
}

/**
 * 模版库变了 → 告诉渲染端重扫。
 *
 * 与 `broadcastLibraryChanged` 同一个理由:模版有两个入口(左栏那一段、设置里的
 * 模版库面板),两边各有自己的缓存,而磁盘是事实源 —— 谁改了都得让另一边知道。
 */
export function notifyTemplatesChanged(reason: string): void {
  try {
    sendToRenderer(IPC.TEMPLATES_CHANGED, { channel: IPC.TEMPLATES_CHANGED, reason });
  } catch {
    /* 没有窗口在听 —— 不是错误 */
  }
}

/* ── 小工具 ── */

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 读成 UTF-8;看起来是二进制就返回 null(模版目录里可能有 pdf/zip)。 */
function readFileSyncUtf8(abs: string): string | null {
  const buf = readFileSync(abs);
  // NUL 字节 = 二进制。只看开头 4KB 就够判定了。
  for (let i = 0; i < Math.min(buf.length, 4096); i += 1) {
    if (buf[i] === 0) return null;
  }
  return buf.toString("utf8");
}

/** 代码块的语言标注,只影响高亮,标错无害。 */
function fenceLang(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", m: "matlab", tex: "latex", bib: "bibtex", r: "r", jl: "julia", sh: "bash", cpp: "cpp", c: "c", java: "java", sql: "sql", cls: "latex", sty: "latex" };
  return map[ext] ?? "";
}
