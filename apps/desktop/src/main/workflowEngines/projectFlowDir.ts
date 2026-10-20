/**
 * 【ARC-006 MERGE-1 / P1-7】**按项目隔离的引擎数据目录判据**。
 *
 * ## 它解决什么
 *
 * `registry.ts` 的 `dataDirOf(engineId)` 是**按引擎单例**的：所有项目共用同一个
 * `<dataRoot>/workflow-engines/node-red/`，于是：
 *   - 所有项目的 `flows.json` / `flows_cred.json` / `engine-trust.json` 都落在同一处，
 *     项目 A 的图与项目 B 的图互相可见；
 *   - 没有 `flowId` / `projectId` / `graphRevision` 与 `workflowTrust` 的可信关联，
 *     也没有同时编辑时的 CAS（台账 2026-10-18 复审 P1-6/P1-7）。
 *
 * 本模块只做**第一条**：把「一个 projectId 对应哪个目录」变成纯判据。存储合一、
 * revision/CAS、trust 关联仍是后续切片（见文件尾的未做清单）。
 *
 * ## 判据（三条）
 *
 *  1. **同 projectId 稳定**：纯函数，只依赖 projectId 与引擎根目录；不读盘、不缓存。
 *  2. **不同 projectId 隔离**：`<engineDir>/projects/<safe>/`，`safe` 由 projectId
 *     经**白名单折叠**得来（只留 `[A-Za-z0-9_-]`，其余折 `-`），并附 `projectId`
 *     的 8 位十六进制哈希后缀。它只能降低常规折叠碰撞概率，不能证明不同
 *     projectId 必然有不同目录：确有不同合法 ID 产生相同 32-bit SHA 后缀。
 *     生产读写必须调用 bindProjectDirectoryIdentity，对盘上完整 projectId 做精确
 *     校验；即使两个 ID 纯路径算出同一地址，后一个也必须拒绝访问第一份资料。
 *  3. **非法 id 拒绝**：空串、纯空白、`.`/`..`、含路径分隔符或盘符、含控制字符、
 *     超长（> 200）一律拒绝（`{ ok: false, reason }`），**绝不**回退成默认目录
 *     （那会让一条坏 id 悄悄写进共享目录）。
 *
 * ## 迁移兼容（默认项目 = 旧目录）
 *
 * 现有单例目录 `<engineDir>/` **就是** "默认项目" 的目录：不迁移、不改内容，只读兼容。
 * `resolveProjectFlowDir(engineDir, null | DEFAULT_PROJECT_ID)` 返回旧目录本身；
 * 新项目走 `<engineDir>/projects/<safe>/`。默认项目的 id 用 {@link DEFAULT_PROJECT_ID}
 * （与 Mcode 的 `SYSTEM_AUTOMATION_PROJECT_ID` 不同——那是自动化会话的隐藏项目，
 * 这里是"没有项目"的归一值；调用方显式传 null/undefined 时也走旧目录）。
 *
 * ## 为什么不直接拼 path.join
 *
 * `path.join(engineDir, "projects", projectId)` 在 projectId 为绝对路径时会**丢掉**
 * engineDir（`path.join("C:/a", "D:/b")` → `C:/a/D:/b` 视平台而定，Windows 上甚至
 * 可能逃逸）；含 `..` 时会跳出引擎根。所以：先**校验**，再**折叠**，最后才 join，
 * 并在返回前用 `path.resolve` 复核仍在引擎根之内（纵深防御）。
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { resolve, join } from "node:path";

/** 「没有项目」的归一 id。传 null/undefined 与此值都落到旧目录（兼容）。 */
export const DEFAULT_PROJECT_ID = "default";

/** 旧单例目录（默认项目的目录）—— 相对引擎根。 */
export const LEGACY_FLOW_DIR = ".";

/** 新项目目录的父目录名（相对引擎根）。 */
export const PROJECTS_DIR = "projects";

/** projectId 的长度上限（防御超长文件名/路径）。 */
const MAX_PROJECT_ID_LENGTH = 200;

export type ProjectFlowDirResult =
  | { ok: true; dir: string; projectId: string; legacy: boolean }
  | { ok: false; reason: string };

/** 校验 projectId。拒绝空、空白、`.`/`..`、分隔符、盘符、控制字符、超长。 */
export function validateProjectId(projectId: unknown): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof projectId !== "string") {
    return { ok: false, reason: `projectId 必须是字符串（收到 ${typeof projectId}）` };
  }
  // projectId 是身份标识，不是显示名称：静默 trim 会把「p」和「 p 」
  // 合并到同一个 flows/credentials 目录，破坏跨项目隔离。
  const id = projectId;
  if (id.trim().length === 0) return { ok: false, reason: "projectId 不能为空" };
  if (id !== id.trim()) {
    return { ok: false, reason: "projectId 首尾不能包含空白字符（必须精确匹配项目身份）" };
  }
  if (id.length > MAX_PROJECT_ID_LENGTH) {
    return { ok: false, reason: `projectId 过长（${id.length} > ${MAX_PROJECT_ID_LENGTH}）` };
  }
  if (id === "." || id === "..") return { ok: false, reason: `projectId 不能是 ${JSON.stringify(id)}` };
  // 路径分隔符（两种）与盘符/UNC 前缀：一律拒绝 —— 它们能逃出引擎根。
  if (/[\\/]/.test(id)) return { ok: false, reason: "projectId 不能含路径分隔符（/ 或 \\）" };
  if (/^[A-Za-z]:/.test(id)) return { ok: false, reason: "projectId 不能是盘符路径" };
  // 控制字符（含 NUL）：文件名层面不可控。
  if (/[\u0000-\u001f\u007f]/.test(id)) return { ok: false, reason: "projectId 不能含控制字符" };
  // Node UTF-8 replaces *different* unpaired UTF-16 surrogates with the same
  // U+FFFD bytes. Since safeProjectDirName hashes UTF-8, those distinct IDs
  // would otherwise resolve to the exact same project/credentials directory.
  if (/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(id)) {
    return { ok: false, reason: "projectId 不能包含孤立的 UTF-16 代理项" };
  }
  return { ok: true, id };
}

/** projectId → 目录名片段：白名单折叠 + 稳定哈希后缀（防折叠碰撞）。 */
export function safeProjectDirName(projectId: string): string {
  const folded = projectId.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const base = folded.length > 0 ? folded.slice(0, 40) : "project";
  const hash = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * 存储层可直接被调，不能假定所有调用都先走生产 registry 的目录围栏。
 * 检查可信 engineDir 自身和项目相对目录每一层；先 lstat 再创建，创建后
 * 再 lstat，拒绝已有 junction/symlink/非目录，绝不 mkdir 跟到外部去。
 * OS stat/mkdir 之间的恶意并发替换仍需 handle-relative NOFOLLOW 才能彻底挡住。
 */
export function ensureProjectDirectoryNoLinks(engineDir: string, projectDir: string, legacy: boolean): void {
  const root = resolve(engineDir);
  const segments = legacy ? [root] : [root, join(root, PROJECTS_DIR), projectDir];
  for (const candidate of segments) {
    const check = (): void => {
      try {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`受管 Node-RED 项目目录不是独立目录：${candidate}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    };
    check();
    mkdirSync(candidate, { recursive: true });
    check();
  }
}

/** 项目目录的精确归属（不是哈希前缀），只供宿主自己管理。 */
export const PROJECT_IDENTITY_FILE = ".mcode-project-id.json";

/**
 * 旧目录名只含 32-bit SHA：不同 projectId 可以碰撞，不能把旧 hash
 * 无条件当成项目身份。保留旧目录名以免原 flows/credentials 突然不可见，
 * 但任何生产存储入口在读/写前必须先查磁盘上的完整 projectId。
 *
 * 只能为真正的空目录首次绑定；历史有内容但没有身份的目录要显式拒绝，
 * 留给受控迁移。绝不能盲目将它认作眼前 projectId（会跨项目读错凭据）。
 * 同路径同时绑定由 O_EXCL 保障只有一个胜者。拒绝特殊文件/硬链接。
 */
export function bindProjectDirectoryIdentity(dir: string, projectId: string): void {
  const marker = join(dir, PROJECT_IDENTITY_FILE);
  let present = false;
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("工作流项目身份标记必须是独立普通文件");
    }
    present = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!present) {
    // 只允许空的新建目录绑定；有旧 flow/credential 即使合法也不猜归属。
    if (readdirSync(dir).length > 0) {
      throw new Error("工作流项目旧目录已有内容但缺少完整项目身份，拒绝自动接管；须先受控迁移");
    }
    let fd: number | undefined;
    try {
      fd = openSync(marker, "wx", 0o600);
      writeSync(fd, JSON.stringify({ projectId, version: 1 }));
      fsyncSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 另一个并发请求已经绑定；稍后通过下面的完整内容比较判归属。
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("工作流项目身份标记不是独立普通文件，拒绝加载");
  }
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(marker, "utf8")); }
  catch { throw new Error("工作流项目身份标记损坏，拒绝加载"); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)
      || (saved as {version?: unknown}).version !== 1
      || (saved as {projectId?: unknown}).projectId !== projectId) {
    throw new Error("工作流项目身份与目录上已有的完整 projectId 不符（哈希碰撞），拒绝跨项目读写");
  }
}

/**
 * **纯判据**：给定引擎根目录与 projectId，返回该项目的 flow 数据目录。
 *
 * - `null` / `undefined` / {@link DEFAULT_PROJECT_ID} → **旧单例目录**（兼容，只读）；
 * - 合法 projectId → `<engineDir>/projects/<safe>/`；
 * - 非法 projectId → `{ ok: false, reason }`（**不**回退默认目录）。
 *
 * 不创建目录、不读盘。返回的 `dir` 已 `resolve` 过，并用 `resolve` 复核仍在引擎根内。
 */
export function resolveProjectFlowDir(engineDir: string, projectId?: string | null): ProjectFlowDirResult {
  if (projectId === null || projectId === undefined || projectId === DEFAULT_PROJECT_ID) {
    return { ok: true, dir: resolve(engineDir), projectId: DEFAULT_PROJECT_ID, legacy: true };
  }
  const valid = validateProjectId(projectId);
  if (!valid.ok) return valid;
  const root = resolve(engineDir);
  const dir = resolve(join(root, PROJECTS_DIR, safeProjectDirName(valid.id)));
  // 纵深防御：折叠后的名字不可能含分隔符，但这条复核把"将来有人改折叠规则"也挡住。
  const rootWithSep = root.endsWith("\\") || root.endsWith("/") ? root : `${root}${process.platform === "win32" ? "\\" : "/"}`;
  if (!dir.startsWith(rootWithSep)) {
    return { ok: false, reason: `解析出的目录不在引擎根之内：${dir}` };
  }
  return { ok: true, dir, projectId: valid.id, legacy: false };
}

/** 便捷形式：非法 id 直接抛（调用方要求"要么给目录，要么炸"，不静默落默认）。 */
export function projectFlowDir(engineDir: string, projectId?: string | null): string {
  const result = resolveProjectFlowDir(engineDir, projectId);
  if (!result.ok) throw new Error(`非法 projectId：${result.reason}`);
  return result.dir;
}
