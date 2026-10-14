/**
 * 扩展专用数据区的**磁盘侧** —— `<数据根>/extensions/<扩展 id>/.mcode-store.json`。
 *
 * 【MC-096】键值文件用**点前缀保留名** `.mcode-store.json`(见 `EXTENSION_STORE_FILE`),
 * 不再是与用户文件同层的裸 `store.json` —— 物理上就分进一个不可能与用户文件重名的保留
 * 命名空间。旧数据仍落在裸 `store.json`(`LEGACY_EXTENSION_STORE_FILE`):**读得到、认作
 * 有效**(不是当成 MISSING 静默丢),读到或写到时迁进新名并清掉旧文件。
 *
 * 纯函数(读 / 写 / 删 / 路径拼装)只收一个 `root`(数据根),**不 import electron**;
 * 无头 smoke 直接 bundle 本文件、传一个临时目录当数据根。真正的 IPC handler 在
 * `main/ipc/extensions.ts`,它把 `dataRoot()` 注进来。
 *
 * 契约(形状 / 校验 / 配额 / 通道名)在 `@contracts/extensionStore`。
 *
 * ## 与 `db.export()` 那一类"整库重写"的区别
 *
 * 这里**不是**数据库:每个扩展一份独立的小 JSON,写它只动它自己那份 —— 撞不见聊天
 * 记录、也撞不见别的扩展。落盘走 `atomicWrite`(tmp + rename),写到一半崩了不会留下
 * 半份 JSON。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  emptyStore,
  getStoreValue,
  isReservedExtensionRelPath,
  isSafeExtensionRelPath,
  isValidExtensionId,
  parseStoreFile,
  readStoreFileDetailed,
  type ExtensionStoreRead,
  serializeStore,
  storeBytes,
  withStoreValue,
  withoutStoreValue,
  EXTENSION_STORE_FILE,
  LEGACY_EXTENSION_STORE_FILE,
  EXTENSION_STORE_MAX,
  EXTENSION_TOTAL_MAX,
  type ExtensionStoreFile,
  type ExtensionStoreListEntry,
  type ExtensionStoreListFilesResult,
  type ExtensionStoreReadFileResult,
  type ExtensionStoreWriteFileResult,
} from "@contracts/extensionStore";
import { atomicWrite } from "@main/lib/appContext.js";
import { physicalTargetInRoot } from "@main/lib/realPathWithin.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";

/** `<数据根>/extensions`。 */
export function extensionsDir(root: string): string {
  return join(root, "extensions");
}

/** `<数据根>/extensions/<扩展 id>`。**调用方必须先校验 id** —— 这里只拼。 */
export function extensionDir(root: string, extensionId: string): string {
  return join(extensionsDir(root), extensionId);
}

/**
 * 该扩展的存储文件:`<数据根>/extensions/<扩展 id>/.mcode-store.json`(**保留命名空间**)。
 *
 * 【MC-096】点前缀的保留名 —— 一个正常书写、不引用内部命名约定的扩展不可能产出它,于是
 * 物理上就跟用户自己在扩展目录里放的文件分开了(不是只靠通道拒绝)。
 */
export function extensionStorePath(root: string, extensionId: string): string {
  return join(extensionDir(root, extensionId), EXTENSION_STORE_FILE);
}

/**
 * 【MC-096】**旧**存储文件:`<数据根>/extensions/<扩展 id>/store.json`(迁移前的裸名)。
 *
 * 只用于**读**(向后兼容老数据)与**迁移收尾清理**。新写一律走 {@link extensionStorePath}。
 */
export function legacyExtensionStorePath(root: string, extensionId: string): string {
  return join(extensionDir(root, extensionId), LEGACY_EXTENSION_STORE_FILE);
}

/**
 * 扩展 ID 根目录的真实目的地是否仍在 `extensions/` 的物理目录内 —— **MC-095 的物理包含闸**。
 *
 * 文件通道(`physicalExtensionDir`)与键值通道(`readStore` / `persist`)共用**这一道**:
 * 根级 Junction / symlink 逃逸两处都会露馅。判据本身复用 `realPathWithin` 的**唯一一份**
 * 实现(`physicalTargetInRoot`,与 pathGuard / files / library 同源),不另写第二套
 * (仓库硬规矩:共享实现只有一份)。目录尚未创建时,物理目的地就是 `<真实的 extensions>/<id>`,
 * 仍在其内 → 放行(创建路径不受影响)。
 */
function extensionRootWithinExtensions(root: string, extensionId: string): boolean {
  return physicalTargetInRoot(extensionsDir(root), extensionDir(root, extensionId));
}

/**
 * 读一份存储。文件不存在 / 坏了 → 空存储(不是抛)。
 *
 * id 非法直接当空 —— 上层 handler 已经用 zod 挡过,这里再兜一道,免得拼出越界路径。
 * **根目录不是物理上真正的子目录**(Junction 逃逸)→ 也当空,不跟随到库外去读。
 */
export function readStore(root: string, extensionId: string): ExtensionStoreFile {
  // 【MC-096】走**三态读** —— 主文件坏时能试 last-good 恢复(纯 `parseStoreFile` 会把坏数据
  // 当空,读不到备份里那份仍有效的键值)。
  return readStoreRaw(root, extensionId).file;
}

/** 读一条。 */
export function readValue(root: string, extensionId: string, key: string): unknown | null {
  return getStoreValue(readStore(root, extensionId), key);
}

/**
 * 【MC-096】读一份存储并**区分三态** —— 写侧据此对「坏数据」fail-closed(不覆盖)。
 * 根目录逃逸 / id 非法一律当 `MISSING`(读不到那份文件,写也被包含闸挡住)。
 *
 * **坏数据先试 last-good**:主文件坏掉时,若存在一份确认过的 `<file>.last-good`,就用它
 * (status 标 `VALID`),不让用户的键值因为一次写坏全丢。last-good 也坏/没有 → 才 `CORRUPT`。
 *
 * 【MC-096】读**新命名空间**(`.mcode-store.json`);新名不在时**回退读旧名**
 * (`store.json`,向后兼容)—— 老数据读得到、认作有效,不是当成 MISSING 静默丢。
 */
function readStoreRaw(root: string, extensionId: string): ExtensionStoreRead {
  return locateStore(root, extensionId);
}

/**
 * 【MC-096】定位并读取一份存储(新命名空间优先,旧名回退)。
 *
 * 优先级:新名(`.mcode-store.json`)存在就用它;不存在时回退旧名(`store.json`)。
 * 两者都读不出 → `MISSING`。新名存在但坏 → **不**去看旧名(那是坏数据,fail-closed,
 * 不能拿旧名把它当"不存在"盖掉)。写侧 `persist` 无条件落新名并清旧名 —— 迁移因此
 * 在**任何一次写**上都会发生,读侧的 `legacy` 分派无需带出去。
 */
function locateStore(root: string, extensionId: string): ExtensionStoreRead {
  if (!isValidExtensionId(extensionId)) return { status: "MISSING", file: emptyStore() };
  if (!extensionRootWithinExtensions(root, extensionId)) return { status: "MISSING", file: emptyStore() };
  const mainPath = extensionStorePath(root, extensionId);
  try {
    // ① 新命名空间优先。
    if (existsSync(mainPath)) {
      const main = readStoreFileDetailed(readFileSync(mainPath, "utf8"));
      if (main.status !== "CORRUPT") return main;
      // 主文件坏 → 试 last-good 恢复(不让坏数据把用户键值全丢)。
      return readLastGood(mainPath) ?? main;
    }
    // ② 新名不在 → 回退旧名(迁移前的老数据):读得到、认作有效。
    const legacyPath = legacyExtensionStorePath(root, extensionId);
    if (existsSync(legacyPath)) {
      const legacy = readStoreFileDetailed(readFileSync(legacyPath, "utf8"));
      if (legacy.status !== "CORRUPT") return legacy;
      // 旧名主文件也坏 → 试它的 last-good(同样不让一次写坏全丢)。
      return readLastGood(legacyPath) ?? legacy;
    }
    return { status: "MISSING", file: emptyStore() };
  } catch {
    return { status: "CORRUPT", file: emptyStore() };
  }
}

/** 【MC-096】确认过的上一份存储的备份路径(`<store 文件>.last-good`)。 */
function lastGoodStorePath(storePath: string): string {
  return `${storePath}.last-good`;
}

/** 从 `<storePath>.last-good` 备份读出一份**有效**存储;读不出 / 坏 → null。 */
function readLastGood(storePath: string): ExtensionStoreRead | null {
  try {
    const raw = readFileSync(lastGoodStorePath(storePath), "utf8");
    const parsed = readStoreFileDetailed(raw);
    return parsed.status === "VALID" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写一份(整份落盘)。**根目录逃逸时不落盘** —— 返回 `false`(MC-095 物理包含闸)。
 *
 * 【MC-096】落盘进**新命名空间**(`.mcode-store.json`)。写成功后**清掉旧名**
 * (`store.json` + 它的 `.last-good`)—— 迁移收尾:新文件已是权威,旧名留着只会让下次
 * 读又回退到它。旧名不存在时 `rmSync(force)` 是 no-op,不报错。
 */
function persist(root: string, extensionId: string, file: ExtensionStoreFile): boolean {
  if (!extensionRootWithinExtensions(root, extensionId)) return false;
  const serialized = serializeStore(file);
  const storePath = extensionStorePath(root, extensionId);
  // 【MC-096】先刷新 last-good(确认过的这一份),再写主文件 —— 主文件下次写坏时能恢复。
  try { atomicWrite(lastGoodStorePath(storePath), serialized); } catch { /* 备份失败不阻断主写 */ }
  atomicWrite(storePath, serialized);
  // 迁移收尾:新命名空间已是权威,把旧名的两份(主文件 + 备份)清掉,免得下次读又回退过去。
  const legacyPath = legacyExtensionStorePath(root, extensionId);
  try { rmSync(legacyPath, { force: true }); } catch { /* 清不掉不影响新文件已落盘的事实 */ }
  try { rmSync(lastGoodStorePath(legacyPath), { force: true }); } catch { /* 同上 */ }
  return true;
}

/**
 * 写一条。**超过 {@link EXTENSION_STORE_MAX} 时整次拒绝、不落盘** —— 返回 `false`,
 * 由调用方回一句"存储已满"。写成功返回 `true`。
 *
 * id 非法也返回 `false`(不落盘):上层 zod 已经挡过,这里是**第二道** —— 少了它,
 * 一个 `..` 开头的 id 会被 `join` 拼成数据根外的路径(`extensions/../evil`)。
 */
export function writeValue(root: string, extensionId: string, key: string, value: unknown): boolean {
  if (!isValidExtensionId(extensionId)) return false;
  const read = readStoreRaw(root, extensionId);
  // 【MC-096】坏数据**拒写** —— 不能把 readStore 的"坏当空"再整份覆盖,那会丢掉用户原有那份键值。
  if (read.status === "CORRUPT") return false;
  const next = withStoreValue(read.file, key, value);
  if (next === null) return false;
  return persist(root, extensionId, next);
}

/** 删一条。没有这个键就不写(不无谓地重排文件)。id 非法直接不动。 */
export function removeValue(root: string, extensionId: string, key: string): void {
  if (!isValidExtensionId(extensionId)) return;
  const read = readStoreRaw(root, extensionId);
  // 【MC-096】坏数据不动(同 writeValue 的理由)。
  if (read.status === "CORRUPT") return;
  const next = withoutStoreValue(read.file, key);
  if (next === read.file) return;
  persist(root, extensionId, next);
}

/** 当前用掉的字节数(配额判据;给未来的"看用了多少"入口留一个出口)。 */
export function usedBytes(root: string, extensionId: string): number {
  return storeBytes(readStore(root, extensionId));
}

/* ═══════════════════════ 文件通道:该扩展自己目录下的任意文件(报告附录 P)═══════════════════════
 *
 * 键值(`.mcode-store.json`)只能装小东西;面板要落一份 Markdown / 导出 JSON / 截图时,得在一个
 * **该扩展自己的**目录下读写任意文件 —— 而面板唯一的文件接口 `mcode.files.read` 受项目根
 * 闸门,库外静默返回空串(真机实测:项目内读到 2417 字符、数据根里那份读回 0)。这三条补上。
 *
 * ## 为什么这里还带 `sep` 与 `..` 检查(契约层已经查过一遍)
 *
 * 契约的 {@link isSafeExtensionRelPath} 是**纯词法**第一道闸,但它**挡不住符号链接** ——
 * 一个指向目录外的 symlink 词法上完全合法。所以这里第二条:按段切、拒 `..`(第二道),
 * 再对**物理路径**做包含检查(`isWithinExtensionDir` 用 `realpathSync`,挡 symlink/UNC
 * 逃逸)。三道都过才落盘。 */

/**
 * `<数据根>/extensions/<扩展 id>` 的**物理**路径(解析符号链接);目录不存在时返回 null。
 *
 * ★ **物理包含闸(MC-095)**:扩展 ID 根目录的 realpath **不能盲信**。若
 * `<extensions>/<id>` 本身是一个指向 `extensions/` **之外**的 Junction / symlink
 * (Windows 上普通用户即可建 Junction),它的 realpath 就落在库外 —— 从前只把这个
 * realpath 当可信 `dir`,之后的所有相对检查都相对一个**已越界的 dir**,于是真实外部
 * 文件被读写。这里在解析 realpath **之前**先过 {@link extensionRootWithinExtensions}
 * 的**唯一一道**物理包含判据(与键值通道共用,复用 `realPathWithin` 不另写)。根过不了
 * 这道闸 → 整个扩展目录视为不存在。
 */
function physicalExtensionDir(root: string, extensionId: string): string | null {
  try {
    const candidate = extensionDir(root, extensionId);
    if (!existsSync(candidate)) return null;
    // 真实目的地必须仍在 `extensions/` 的物理目录内(挡根级 Junction/symlink 逃逸)。
    if (!extensionRootWithinExtensions(root, extensionId)) return null;
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

type ResolveResult = { ok: true; abs: string; dir: string } | { ok: false; reason: "invalidPath" | "reserved" | "notFound" };

/**
 * 把 `relPath` 拼成该扩展目录下的**物理**绝对路径,并确认它**没有逃出**那个目录。
 *
 * - `createDir=true`(写):扩展目录不存在时**先建**(与 `writeValue` 的 atomicWrite 建目录
 *   同一姿势);`false`(读/列):目录不存在 → `notFound`(不是 invalidPath —— 那不是"路径
 *   不合法",是"这个扩展还没有任何文件")。
 *
 * 逃逸判据:`target` 必须等于扩展目录,或以其 + `sep` 开头(与 `pathGuard.contained` 同一
 * 姿势);两端都过 `realpath`,一个中间段是 symlink 的路径在这里露馅。
 *
 * ★ **内部保留文件闸(MC-096)**:解析出来的 `target` 若落在该扩展目录**根**、且文件名是
 * 内部保留名(新 `.mcode-store.json` 或旧 `store.json`,及其临时/备份变体),一律拒
 * (`reserved`)—— 公共文件通道不许覆盖扩展自己的键值存储。**新旧两种写法都要挡** —— 否则
 * 迁移期的旧名又能被写穿。词法判据是契约层的 {@link isReservedExtensionRelPath}(唯一一份),
 * 这里对它解析出的真实路径再拦一道。判据挂在 `relPath` 上(而非 `target`):扩展目录根就是
 * store 文件的所在目录,根级文件名与 `relPath` 是段级对应的。
 */
function resolveInExtension(
  root: string,
  extensionId: string,
  relPath: string,
  createDir: boolean,
): ResolveResult {
  if (!isValidExtensionId(extensionId)) return { ok: false, reason: "invalidPath" };
  if (!isSafeExtensionRelPath(relPath)) return { ok: false, reason: "invalidPath" };
  // ★ 内部保留文件(store.json 及其 .mcode-tmp / 备份变体)—— 公共文件通道不许寻址。
  if (isReservedExtensionRelPath(relPath)) return { ok: false, reason: "reserved" };
  let dir = physicalExtensionDir(root, extensionId);
  if (dir === null) {
    if (!createDir) return { ok: false, reason: "notFound" };
    const rawDir = extensionDir(root, extensionId);
    try {
      mkdirSync(rawDir, { recursive: true });
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    // 建完之后物理目录要是**目录**(万一被一个同名文件/符号链接占着)。
    try {
      if (!lstatSync(rawDir).isDirectory()) return { ok: false, reason: "invalidPath" };
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    dir = physicalExtensionDir(root, extensionId);
    if (dir === null) return { ok: false, reason: "invalidPath" };
  }
  // 拼接:按 `/` 与 `\` 切段后逐段 join —— 段里已无 `..`(上面查过),所以 join 不会上跳。
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  const target = resolve(dir, ...segments);
  // 词法:target 必须在 dir 之内。
  if (target !== dir && !target.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return { ok: false, reason: "invalidPath" };
  // 物理:对**最近的已存在祖先**做 realpath,确认它也在 dir 之内(挡 symlink 逃逸)。
  const nearest = nearestExistingAncestor(target);
  if (nearest !== null) {
    let physicalNearest: string;
    try {
      physicalNearest = realpathSync.native(nearest);
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    if (physicalNearest !== dir && !physicalNearest.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
      return { ok: false, reason: "invalidPath" };
    }
  }
  return { ok: true, abs: target, dir };
}

/** 从 `target` 往上找第一个已存在的祖先(含自己)。找不到(整棵树都不在)返回 null。 */
function nearestExistingAncestor(target: string): string | null {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 读该扩展目录下的一份文件。**空文件 = `{ ok: true, content: "" }`**;
 * 文件不存在 = `{ ok: false, reason: "notFound" }`(与空文件分得开 —— 那正是项目根闸门
 * 那条老路的病:两种情况都回空串)。
 */
export function readFileInExtension(root: string, extensionId: string, relPath: string): ExtensionStoreReadFileResult {
  const res = resolveInExtension(root, extensionId, relPath, false);
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    const st = lstatSync(res.abs);
    if (st.isDirectory()) return { ok: false, reason: "notAFile" };
    return { ok: true, content: readFileSync(res.abs, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "notFound" };
    return { ok: false, reason: "notFound" };
  }
}

/**
 * 写该扩展目录下的一份文件(建父目录)。**超过 {@link EXTENSION_STORE_MAX} 字节整次拒绝、
 * 不落盘** —— 返回 `{ ok: false, reason: "tooLarge", limit }`。写成功返回 `{ ok: true, bytes }`。
 *
 * ★ **【MC-096】总量检查与写入之间的并发竞态**:单文件上限那道闸在解析路径**之前**做(便宜),
 * 但{@link EXTENSION_TOTAL_MAX} 那道**必须**在{@link withOsFileLease 宿主级按目录租约}
 * **之内**复查 —— 否则两个并发写各自读到"还差一点"就都放行,合起来超总量。检查与落盘之间
 * 只有这一把锁能消掉竞态(进程内 Map 挡不住两个 OS 进程,见 `lib/osFileLease.ts`)。
 * 锁的对象是**扩展目录**(总量按目录算 —— 两个写不同文件的调用也必须串行),不是单个文件;
 * 锁文件落在 `<真实扩展目录>.mcode-lock`(扩展目录的**兄弟**,不在目录内,既不进 listFiles
 * 也不计入 directoryBytes)。本函数因此是**异步**的(租约原语本身异步);`ipcMain.handle`
 * 返回值天然可 await,调用端无需改形状。
 */
export async function writeFileInExtension(
  root: string,
  extensionId: string,
  relPath: string,
  content: string,
): Promise<ExtensionStoreWriteFileResult> {
  const bytes = utf8Length(content);
  if (bytes > EXTENSION_STORE_MAX) return { ok: false, reason: "tooLarge", limit: EXTENSION_STORE_MAX };
  const res = resolveInExtension(root, extensionId, relPath, true);
  if (!res.ok) return { ok: false, reason: res.reason === "notFound" ? "invalidPath" : res.reason };
  // 目标要么不存在、要么是普通文件;是目录则拒。
  if (existsSync(res.abs)) {
    try {
      if (lstatSync(res.abs).isDirectory()) return { ok: false, reason: "notAFile" };
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
  }
  // ★ 累计配额在**租约内**复查(单文件那道已在上面做过)。覆盖写时先扣掉旧文件的大小。
  return withOsFileLease<ExtensionStoreWriteFileResult>(res.dir, async () => {
    const existing = existsSync(res.abs) ? safeFileSize(res.abs) : 0;
    const used = directoryBytes(extensionDir(root, extensionId)) - existing;
    if (used + bytes > EXTENSION_TOTAL_MAX) {
      return { ok: false, reason: "tooLarge", limit: EXTENSION_TOTAL_MAX };
    }
    mkdirSync(dirname(res.abs), { recursive: true });
    atomicWrite(res.abs, content);
    return { ok: true, bytes };
  });
}

/** 一个文件的字节数;读不到 / 是目录 → 0(只用于配额估算,不参与安全判定)。 */
function safeFileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** 一个目录(含子目录)下所有普通文件的字节数之和。符号链接不跟随(避免把库外算进来)。 */
function directoryBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) total += safeFileSize(p);
    }
  };
  walk(dir);
  return total;
}

/**
 * 列该扩展目录下某个子目录的内容。省略 `relPath` = 该扩展目录根。
 * 只列**自己目录**;不递归。目录不存在 / 目标是文件 → 结构化失败。
 */
export function listFilesInExtension(
  root: string,
  extensionId: string,
  relPath?: string,
): ExtensionStoreListFilesResult {
  // 纯词法先拒绝对路径 / `..`(不依赖目录是否存在 —— 越界无论目录在不在都算 invalidPath)。
  if (!isValidExtensionId(extensionId)) return { ok: false, reason: "invalidPath" };
  const rel = (relPath ?? "").trim();
  if (rel.length > 0 && !isSafeExtensionRelPath(rel)) return { ok: false, reason: "invalidPath" };
  const dir = physicalExtensionDir(root, extensionId);
  if (dir === null) return { ok: false, reason: "notFound" };
  let target = dir;
  if (rel.length > 0) {
    const res = resolveInExtension(root, extensionId, rel, false);
    if (!res.ok) return { ok: false, reason: res.reason };
    target = res.abs;
  }
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return { ok: false, reason: "notFound" };
  }
  if (!st.isDirectory()) return { ok: false, reason: "notADir" };
  const prefix = rel.length > 0 ? `${rel.replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return { ok: false, reason: "notFound" };
  }
  const entries: ExtensionStoreListEntry[] = [];
  for (const name of names) {
    const entryRel = `${prefix}${name}`;
    // ★ 内部保留文件(MC-096):根级 store.json 及其临时/备份变体不列 —— 与读/写闸同一判据。
    if (isReservedExtensionRelPath(entryRel)) continue;
    const childAbs = join(target, name);
    let childStat;
    try {
      childStat = lstatSync(childAbs);
    } catch {
      continue; // 列到一半被删了 —— 跳过,不抛
    }
    if (childStat.isDirectory()) {
      entries.push({ name, relPath: entryRel, isDir: true });
    } else if (childStat.isFile()) {
      entries.push({ name, relPath: entryRel, isDir: false, size: childStat.size });
    }
    // 符号链接等其它类型不列(它们正是逃逸的载体)。
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, entries };
}

/** UTF-8 字节数(与契约层同一算法;主进程这层有 `node:fs`,但保持一致免得两处漂移)。 */
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x7f) n += 1;
    else if (c <= 0x7ff) n += 2;
    else if (c <= 0xffff) n += 3;
    else n += 4;
  }
  return n;
}

export { EXTENSION_STORE_MAX };
