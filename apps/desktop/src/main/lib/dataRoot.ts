/**
 * **统一数据根**:聊天记录(数据库)、文献库、模版库都放在一个用户可选的位置下。
 *
 * ```
 * <数据根>/
 *   ├── mcode.db      ← 聊天记录(sql.js 数据库)
 *   ├── library/      ← 文献库(PDF + 转换出的 Markdown + 清单)
 *   └── templates/    ← 模版库(PPT / LaTeX / Word / 代码 / 图片)
 * ```
 *
 * ## 为什么要有"根"这一层
 *
 * 之前三者各自为政:数据库在 `%APPDATA%\@mcode\desktop`,文献库也在那儿,模版在
 * `~/Mcode`。用户想备份、想搬到 D 盘、想知道"我的东西到底在哪",得记住三个地方 ——
 * 这正是用户提出这条需求的原因。统一之后只有一个位置,搬一次全搬走。
 *
 * ## 默认位置:用户主目录下的 `Mcode`
 *
 * 三个候选都试过,只有它合适:
 *   - `<userData>`(`%APPDATA%\@mcode\desktop`)—— 应用自己的数据目录,藏得深、
 *     用户的备份不会覆盖它。用户的内容不该放这儿。
 *   - **文档目录** —— 实测踩到:OneDrive 接管"文档"时,资源管理器点「文档」进的是
 *     `OneDrive\文档`,而 `app.getPath("documents")` 给的仍是本地 `C:\Users\<你>\Documents`。
 *     **两边不是同一个地方**,用户照着界面去找会找不到。
 *   - **主目录**(`~/Mcode`)—— 没有重定向,进资源管理器就看得见。
 *
 * ## 搬迁的两条路:先改名,不行就复制
 *
 * `renameSync` 最快(同盘是原子操作),但它会因为**有资源管理器窗口开在那个目录里**
 * 而 EPERM(Windows 会锁住目录链,连祖先一起不能改名 —— 实测过)。所以退一步整树
 * 复制:复制只是读,窗口开着也不挡。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import { log } from "@main/lib/logger.js";
import { atomicWrite } from "@main/lib/appContext.js";

/** 数据库文件名。 */
export const DATA_DB_FILENAME = "mcode.db";
/** 旧的数据库文件名(在 userData 下)。 */
const LEGACY_DB_FILENAME = "claude-gui.db";

/**
 * 「数据根在哪」记在一个**独立的小文件**里,而不是数据库的 settings 表。
 *
 * 为什么不能存数据库:**数据库住在数据根里**。把它存在数据库里就是鸡生蛋 —— 要读
 * 设置得先打开数据库,要打开数据库得先知道数据根。启动时就会卡死在一个不存在的
 * 路径上(或者更糟:在新位置建一个空库,看起来像"数据全丢了")。
 *
 * 所以指针文件放在 `userData`(那个位置是 Electron 按应用名定的,不会变),内容是
 * `{ "root": "<绝对路径>" }`。
 */
function pointerFile(): string {
  return join(app.getPath("userData"), "data-root.json");
}

function readPointer(): string | null {
  try {
    const raw = readFileSync(pointerFile(), "utf8");
    const parsed = JSON.parse(raw) as { root?: unknown };
    return typeof parsed.root === "string" && isAbsolute(parsed.root) ? parsed.root : null;
  } catch {
    // 文件不存在(从没搬过)或坏了 —— 两种情况都回落到默认位置
    return null;
  }
}

/**
 * 把数据根写到指针文件。**迁移时调**,写完下次启动就读它。
 *
 * 返回**是否写成功**。⚠️ **当前调用方(`ipc/app.ts` 的搬迁那一支)还没用这个返回值** ——
 * 它排在 `closeDb()` 之后,而"指针写失败之后怎么办"是个未决的设计取舍(见那个 handler
 * 的注释和 `docs/底层修复记录-2026-10-07.md` 的「搁置待议」)。先让这个函数**如实报告**
 * 成败,是那件事的前置条件:从前它只 `log.error` 就咽下去,调用方连"失败了"都不知道。
 */
export function setDataRoot(path: string): boolean {
  try {
    mkdirSync(dirname(pointerFile()), { recursive: true });
    // 原子写:写到一半崩溃/断电的话,坏掉的指针会让下次启动回落到默认位置、
    // 在那儿建一个空库 —— 看起来就是"数据全丢了"。
    atomicWrite(pointerFile(), JSON.stringify({ root: path }, null, 2));
    log.info(`dataRoot: pointer updated -> ${path}`);
    return true;
  } catch (err) {
    log.error(`dataRoot: could not write pointer: ${(err as Error).message}`);
    return false;
  }
}

/** 数据根。指针文件里有就用它,否则 `<主目录>/Mcode`。 */
export function dataRoot(): string {
  return readPointer() ?? join(app.getPath("home"), "Mcode");
}

/**
 * 数据库路径。**必须在 `initDb()` 里、读文件之前调用。**
 *
 * 这里有一道**安全网**:万一搬迁失败(老库还在 userData、新位置没有),就**继续用老库**。
 * 少了它会出最糟的一种事故 —— 应用在新位置建一个空库,用户打开发现聊天记录"全丢了",
 * 而其实都还在老地方。
 */
export function dbPath(): string {
  const legacy = join(app.getPath("userData"), LEGACY_DB_FILENAME);
  const preferred = join(dataRoot(), DATA_DB_FILENAME);
  if (existsSync(legacy) && !existsSync(preferred)) {
    log.warn(`dataRoot: legacy database still at ${legacy}; using it instead of ${preferred}`);
    return legacy;
  }
  return preferred;
}

/** 确保数据根本身存在。 */
export function ensureDataRoot(): string {
  const root = dataRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* 建不出来交给后续写入报错 */
  }
  return root;
}

/**
 * 把**老位置**里的东西搬进数据根。启动时调一次,幂等。
 *
 * 只处理"数据根还是默认位置、且老位置有东西"的情况 —— 用户一旦显式配过数据根,
 * 就说明他已经知道自己要什么,不该再自作主张搬。
 */
export function migrateLegacyIntoDataRoot(): void {
  const root = ensureDataRoot();
  const legacyLibrary = join(app.getPath("userData"), "library");
  const legacyDb = join(app.getPath("userData"), LEGACY_DB_FILENAME);

  moveIfNeeded(legacyLibrary, join(root, "library"), "library");
  moveIfNeeded(legacyDb, join(root, DATA_DB_FILENAME), "database");
}

/** 单项搬迁:目标是空的、源存在,才动手。 */
function moveIfNeeded(from: string, to: string, label: string): void {
  try {
    if (!existsSync(from) || existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
      log.info(`dataRoot: moved ${label} ${from} -> ${to}`);
    } catch (err) {
      // 见文件头:目录被资源管理器窗口锁住时 rename 会 EPERM,复制不受影响
      log.warn(`dataRoot: rename ${label} failed (${(err as Error).message}); copying instead`);
      cpSync(from, to, { recursive: true });
      try {
        rmSync(from, { recursive: true, force: true });
      } catch {
        log.warn(`dataRoot: old ${label} left behind at ${from}`);
      }
    }
  } catch (err) {
    // 搬不动就用老位置 —— 这个函数只是尽力而为,不能因为它让应用起不来
    log.error(`dataRoot: could not migrate ${label}: ${(err as Error).message}`);
  }
}

/**
 * 把整个数据根搬到新位置。**调用方负责在这之前把数据库落盘。**
 *
 * 返回错误信息;成功返回 null。搬完**不删旧根** —— 由调用方在重启后决定,这样万一
 * 新位置有问题,旧数据还在(多占一份空间,但比丢数据强)。
 */
export function copyDataRootTo(target: string): string | null {
  const root = dataRoot();
  if (!isAbsolute(target)) return "目标必须是绝对路径";
  const from = resolve(root);
  const to = resolve(target);
  if (from === to) return "新旧位置是同一个地方";
  // 互相嵌套会导致递归复制 —— 必须挡住。Windows/macOS 大小写不敏感,所以比较前先把
  // 大小写与尾分隔符归一(与 pathGuard 同一套规则);`resolve` 保留调用方的大小写,直接
  // startsWith 会被 `c:\users\x` 对 `C:\Users\X` 骗过。
  const fold = (p: string) =>
    (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
  const f = fold(from);
  const t = fold(to);
  if (t.startsWith(f + "\\") || t.startsWith(f + "/")) {
    return "目标不能在当前位置的内部";
  }
  if (f.startsWith(t + "\\") || f.startsWith(t + "/")) {
    return "目标不能是当前位置的上级目录";
  }
  if (existsSync(to) && statSync(to).isDirectory()) {
    try {
      if (readdirSync(to).length > 0) {
        return "目标目录不是空的 —— 选一个空目录或新建一个";
      }
    } catch {
      /* 读不了就按不可用处理,后面的复制会报错 */
    }
  }
  try {
    cpSync(from, to, { recursive: true });
    log.info(`dataRoot: copied ${from} -> ${to}`);
    return null;
  } catch (err) {
    return `复制失败:${(err as Error).message}`;
  }
}
