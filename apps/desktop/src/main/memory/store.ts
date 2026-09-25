/**
 * 记忆库的存储层(MEM-01)—— `<数据根>/memory/<类目>/*.md`。
 *
 * ## 文件即事实源,markdown + frontmatter
 *
 * ```
 * ---
 * title: 引用规范
 * updatedAt: 1726699200000
 * ---
 * 引用一律用 APA。
 * ```
 *
 * **人可以直接用编辑器打开改** —— 这是硬要求。所以不发明二进制格式、不入数据库;
 * frontmatter 只有两行(title / updatedAt),`updatedAt` 丢了也有文件 mtime 兜底
 * (见 {@link parseFrontmatter})。主进程在每次 `save` 时重写 frontmatter 并盖章
 * `updatedAt = now`,人手改的正文不动。
 *
 * ## 路径是唯一寻址方式,也是唯一攻击面
 *
 * 外面传进来的 `path` 一律当**不可信输入**:`<类目>/<文件名>.md` 两段、类目必须在这
 * 六个白名单里、文件名不许带路径分隔符与点开头,先用 resolve 前缀比对做词法终审，
 * 再拒绝 memory 根 / 类目目录 / 目标文件上的 symlink 或 junction —— 防止路径字面上在库内、
 * 实际 I/O 却被重解析到库外。过不了就明确拒绝,不"尽量解释"。
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  MEMORY_CATEGORIES,
  type MemoryFileMeta,
  type MemoryListInput,
  type MemorySaveInput,
} from "@contracts/memory";
import { dataRoot } from "@main/lib/dataRoot.js";

/** 记忆库在数据根下的目录名。 */
const MEMORY_DIR = "memory";

/** 记忆库根:`<数据根>/memory`。 */
export function memoryRoot(): string {
  return join(dataRoot(), MEMORY_DIR);
}

/* ── 路径校验与解析 ── */

/** 文件名上限:frontmatter 里只有两行,名字本身超长只可能是构造出来的。 */
const MAX_FILE_NAME = 120;

/**
 * memory 根下的相对路径 → 绝对路径。**不合法返回 null,调用方负责拒绝。**
 *
 * 四道词法闸,按顺序:
 *  1. 不是绝对路径、不含反斜杠与 NUL(反斜杠是 Windows 分隔符,放进来就是另一种写法
 *     的目录穿越);
 *  2. 恰好两段 `类目/文件名`,类目在白名单里(目录即类目,多了子目录就是另一套布局);
 *  3. 文件名以 `.md` 结尾、不超长、不以点开头(`.hidden` 与 `..` 一起挡掉);
 *  4. resolve 后必须仍落在该类目目录内 —— 前三道是词法检查,这一道是词法终审(同
 *     `fileImport.ts` 的 `startsWith(root + sep)` 写法)。
 * 真正 I/O 前还会再走 `resolveSafeMemoryRelPath`，拒绝 symlink / junction 重解析。
 */
function resolveMemoryRelPath(relPath: string): string | null {
  if (isAbsolute(relPath) || relPath.includes("\\") || relPath.includes("\0")) return null;
  const parts = relPath.split("/");
  if (parts.length !== 2) return null;
  const [category, file] = parts as [string, string];
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) return null;
  if (!file.endsWith(".md") || file.length > MAX_FILE_NAME) return null;
  const name = file.slice(0, -3);
  if (name.length === 0 || name.startsWith(".")) return null;
  const dir = resolve(memoryRoot(), category);
  const target = resolve(dir, file);
  if (!target.startsWith(dir + sep)) return null;
  return target;
}

/** Reject symlink/junction hops so lexical containment cannot escape dataRoot. */
function resolveSafeMemoryRelPath(relPath: string): string | null {
  const target = resolveMemoryRelPath(relPath);
  if (target === null) return null;
  const category = relPath.split("/")[0] ?? "";
  for (const abs of [memoryRoot(), resolve(memoryRoot(), category), target]) {
    try {
      if (lstatSync(abs).isSymbolicLink()) return null;
    } catch {
      // Missing category/target is valid for first save.
    }
  }
  return target;
}

/* ── frontmatter ── */

interface MemoryFrontmatter {
  title: string;
  updatedAt: number;
  /** 去掉 frontmatter 之后的正文(原样,含换行)。 */
  body: string;
}

/** 解析文件头那段 `--- ... ---`。没有 frontmatter / 解不动 → title 空、updatedAt 0、全文当正文。 */
export function parseFrontmatter(raw: string): MemoryFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { title: "", updatedAt: 0, body: raw };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    title: unquote(meta.title ?? ""),
    updatedAt: Number(meta.updatedAt) || 0,
    body: raw.slice(match[0].length),
  };
}

/** title 值支持 JSON 双引号(写入侧用 `JSON.stringify` 保证单行);裸串原样。 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      /* 引号不成对就当字面量 */
    }
  }
  return value;
}

/** title 压成单行再 JSON 引起来 —— YAML 的双引号标量就是 JSON 字符串,解析侧通用。 */
function quoteTitle(title: string): string {
  return JSON.stringify(title.replace(/\r?\n/g, " ").trim());
}

/* ── CRUD ── */

/**
 * 列出全部记忆文件。类目按固定次序,类目内按 `updatedAt` 新的在前。
 * 空目录/不存在的目录返回空数组 —— "还没有记忆"是常态,不是错误。
 * 整理入口可传 onUnreadable：列目录阶段被跳过的异常 *.md / 非法链接也要明确告知人。
 */
export function listMemoryFiles(filter?: MemoryListInput & { onUnreadable?: (path: string) => void }): MemoryFileMeta[] {
  const root = memoryRoot();
  const want = filter?.category;
  const out: MemoryFileMeta[] = [];
  for (const category of MEMORY_CATEGORIES) {
    if (want !== undefined && want !== category) continue;
    const dir = join(root, category);
    let names: string[];
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        filter?.onUnreadable?.(`${category}/`);
        continue;
      }
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") filter?.onUnreadable?.(`${category}/`);
      continue; // 目录不存在是正常空库，权限错误等才给整理入口报告
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const abs = join(dir, name);
      let raw = "";
      let mtimeMs = 0;
      try {
        const lst = lstatSync(abs);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          filter?.onUnreadable?.(`${category}/${name}`);
          continue;
        }
        raw = readFileSync(abs, "utf8");
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        filter?.onUnreadable?.(`${category}/${name}`);
        continue; // 普通列表仍跳过坏文件，整理入口显示失败路径
      }
      const parsed = parseFrontmatter(raw);
      out.push({
        path: `${category}/${name}`,
        category,
        title: parsed.title || name.slice(0, -3),
        updatedAt: parsed.updatedAt || Math.round(mtimeMs),
      });
    }
  }
  return out.sort(
    (a, b) =>
      (MEMORY_CATEGORIES as readonly string[]).indexOf(a.category) -
        (MEMORY_CATEGORIES as readonly string[]).indexOf(b.category) || b.updatedAt - a.updatedAt,
  );
}

/** 读一条记忆的**正文**(不含 frontmatter)。路径不合法或读不到 → 抛(话直接给用户)。 */
export function readMemoryFile(relPath: string): { content: string } {
  return { content: readMemoryFileWithRaw(relPath).content };
}

/** 与 read 共用安全路径闸；整理校验要比对原始 markdown，连手写 frontmatter 也不能漏。 */
export function readMemoryFileWithRaw(relPath: string): { content: string; raw: string } {
  const target = resolveSafeMemoryRelPath(relPath);
  if (target === null) throw new Error(`不是合法的记忆路径:「${relPath}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  try {
    const raw = readFileSync(target, "utf8");
    return { content: parseFrontmatter(raw).body, raw };
  } catch (err) {
    throw new Error(`读不到记忆「${relPath}」:${(err as Error).message}`);
  }
}

/**
 * 写一条记忆(存在则覆盖)。`content` 是**正文**;frontmatter 由这里生成:
 * title 缺省沿用旧标题,没有旧标题就用文件名;`updatedAt` 每次盖章为现在。
 * 返回写完的时间戳(渲染端刷新行用)。
 */
export function saveMemoryFile(input: MemorySaveInput): { updatedAt: number } {
  const target = resolveSafeMemoryRelPath(input.path);
  if (target === null) throw new Error(`不是合法的记忆路径:「${input.path}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  const name = input.path.split("/")[1] ?? "";
  const fallbackTitle = name.slice(0, -3);
  const previous = parseFrontmatter(safeRead(target));
  const title = (input.title ?? "").trim() || previous.title || fallbackTitle;
  const updatedAt = Date.now();
  try {
    mkdirSync(resolve(memoryRoot(), input.path.split("/")[0] ?? ""), { recursive: true });
    writeFileSync(
      target,
      [`---`, `title: ${quoteTitle(title)}`, `updatedAt: ${updatedAt}`, `---`, "", input.content.replace(/\s+$/, ""), ""].join("\n"),
      "utf8",
    );
  } catch (err) {
    throw new Error(`写记忆「${input.path}」失败:${(err as Error).message}`);
  }
  return { updatedAt };
}

/** 删一条记忆。路径不合法 → 抛;文件本来就不在 → 照样成功(删除是幂等的)。 */
export function deleteMemoryFile(relPath: string): { ok: true } {
  const target = resolveSafeMemoryRelPath(relPath);
  if (target === null) throw new Error(`不是合法的记忆路径:「${relPath}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  try {
    rmSync(target, { force: true });
  } catch (err) {
    throw new Error(`删记忆「${relPath}」失败:${(err as Error).message}`);
  }
  return { ok: true };
}

/** 固定六类(界面建文件时的类目下拉、校验白名单同一份)。 */
export function memoryCategories(): string[] {
  return [...MEMORY_CATEGORIES];
}

/** 读文件但不许抛 —— save 用它取旧标题,读不到(首次保存)就当没有。 */
function safeRead(target: string): string {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return "";
  }
}
