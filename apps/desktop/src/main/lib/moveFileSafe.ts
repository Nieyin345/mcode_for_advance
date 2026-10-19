/**
 * 「安全移动文件/目录」的**唯一一份**执行服务 —— 先把源和目标的关系判清楚,再动任何
 * 东西,覆盖时**永远先给旧目标留一份同卷备份**。它接的是 {@link MoveResult} 这套结构化
 * 结果,不是「抛个 ENOENT 了事」。
 *
 * ## 为什么单独成为一份(而不是写在 `agent_move_file` 的 handler 里)
 *
 * 从前那段是「`lstat` 目标 → `rm -rf` 目标 → `rename` 源」——**先删后搬**。只要
 * `rename` 失败(源==目标的自覆盖、把目录搬进它自己的子目录、权限、EBUSY、跨卷复制
 * 出错……),原本存在的目标就已经没了,数据静默丢失。这不是某一条通路的问题,是
 * 「移动」这个动作本身缺一份协议(见台账 MC-068)。所以协议落在这个叶子模块里,谁要
 * 移动文件都调它 —— 仓库硬规矩:共享实现只有一份。它只 import `node:fs` / `node:path`
 * / `node:os` / `node:crypto`(外加同样是叶子模块的 `realPathWithin` 与**只作类型**的
 * `@contracts/commit`),不拉 electron/db,无头 smoke 打得出、也测得到。
 *
 * ## 协议(顺序即不变量)
 *
 *  1. **副作用前预检** —— 在任何 `mkdir` / `rm` / `rename` **之前**,把源和目标规范化
 *     (realpath + Windows/macOS 大小写折叠)后判三类关系:
 *       - 源 == 目标(逐字相同)→ no-op 成功,源字节**逐字节不变**;
 *       - 仅大小写不同 → 走同卷 `rename`(原子、不删目标),支持「只改大小写」的重命名;
 *       - 源与目标解析到同一实体(符号链接别名等)→ `SAME_SOURCE_DESTINATION` 拒绝;
 *       - 目标在源目录树内部 → `DESTINATION_INSIDE_SOURCE` 拒绝;
 *       - 源在目标目录树内部 → `SOURCE_CONTAINED_IN_DESTINATION` 拒绝。
 *  2. **覆盖分支保全旧目标** —— 先把旧目标 `rename` 到**同目录**(同卷才原子)的唯一
 *     备份(pid + 随机),**只有新目标确认提交成功才清理旧备份**。
 *  3. **跨卷两阶段** —— `EXDEV` 时先 `cp` 到目标卷的独立临时位置并校验,再切换目标;
 *     **目标稳定提交之前不删源**。
 *  4. **`overwrite=false` 不制造 TOCTOU** —— 不删任何东西;平台原生的 no-clobber
 *     (Windows 上 `rename` 到已存在目标会抛 `EEXIST`)直接用来拒绝,而不是偷偷覆盖
 *     并发期间别人新建的文件。
 *
 * ## 生命周期(台账 MC-068 §33.4 —— 「已产生可见副作用」绝不报成「什么都没发生」)
 *
 * 每一处返回都带 {@link FileMovePhase},如实回答现在停在哪一阶段:
 *
 *   PREPARED → DEST_CREATED → SOURCE_REMOVED → COMMITTED 是**成功流水线**;
 *   DEST_CREATED(回退态)是「目标内容已就位、但删源失败」的部分完成;
 *   PARTIALLY_APPLIED / UNCERTAIN 是**需要人工介入**的终态。
 *
 * 两根具体的红线(复审 33.2 / 33.3):
 *   - **link/copy 成功后删源失败** —— 目标已经真的出现(硬链接或整份拷贝),操作已产生
 *     可见副作用,绝不能以 `committed:false / destinationPreserved:true / recoverable:false`
 *     回报成「未提交且无需恢复」,否则调用者会当它没发生而重跑。这里统一走
 *     {@link DEST_CREATED} + `reason=PARTIALLY_APPLIED`,并给出「确认目标无误后删源」的提示。
 *   - **覆盖失败后的恢复** —— 恢复旧目标**不得无条件覆盖**此刻目标槽位里冒出的第三方
 *     内容(Windows 上 `rename` 对已存在普通文件是**替换语义**,实测会把别人刚写的
 *     文件无声换掉)。恢复改用**可靠 no-clobber**:文件走 `link`(目标已存在即 `EEXIST`,
 *     原子、不覆盖);目录在无原子原语的平台上先 `mkdir` **原子占位**再搬内容。一旦槽位
 *     已被占,就**保留备份 + 保留第三方内容**,返回 `UNCERTAIN` + `backupRef`,绝不强替。
 *
 * ## 与 ARC-005 对齐
 *
 * `MoveResult.commitOutcome` 直接复用 `@contracts/commit` 的三态,判据只经
 * {@link isMoveDurable} 一处收口 —— 领域层「移动成功」事件只在 `DURABLE` 之后发,
 * 绝不把「目标已就位但未收尾」当成 `DURABLE`。
 */
import { constants as FS_CONSTANTS, promises as fs, type Stats } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { platform } from "node:os";
import type { CommitOutcome } from "@contracts/commit";
import { physicalPath } from "./realPathWithin.js";

/** 大小写不敏感的文件系统(Windows、macOS)上比较要折叠大小写。 */
const CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";

/**
 * 一次移动所处的**生命周期阶段**(台账 MC-068 §33.4)。`MoveResult.phase` 如实反映
 * 当前停在哪一步 —— 调用者据此判断「能不能当没发生」「要不要人工介入」。
 */
export type FileMovePhase =
  /** 预检通过,尚未落任何副作用(拒绝、纯失败都停在这里,原状未动)。 */
  | "PREPARED"
  /** 目标内容已就位(硬链接已建 / 拷贝已完整落盘),但源尚未删除 —— 删源这一步失败即部分完成。 */
  | "DEST_CREATED"
  /** 源已删除,尚在收尾(清备份)。 */
  | "SOURCE_REMOVED"
  /** 完全成功:目标就位、源已删、备份已清。 */
  | "COMMITTED"
  /** 部分完成:目标已就位、源仍在(或备份需人工收拾)——**有可见副作用**。 */
  | "PARTIALLY_APPLIED"
  /** 无法证明目标槽位所有权(第三方内容占了位 / 恢复中断)—— 备份与第三方内容都留着待人工。 */
  | "UNCERTAIN";

/**
 * 生命周期阶段 → ARC-005 三态。**唯一收口**:`COMMITTED` 才是 `DURABLE`;一旦目标
 * 已就位却未收尾(`DEST_CREATED` / `SOURCE_REMOVED` / `PARTIALLY_APPLIED`)一律
 * `APPLIED_NOT_DURABLE` —— 有可见副作用,但**不得对外报成功**;什么都没落则 `FAILED`。
 */
export function outcomeForPhase(phase: FileMovePhase): CommitOutcome {
  switch (phase) {
    case "COMMITTED":
      return "DURABLE";
    case "DEST_CREATED":
    case "SOURCE_REMOVED":
    case "PARTIALLY_APPLIED":
      return "APPLIED_NOT_DURABLE";
    default:
      // PREPARED / UNCERTAIN —— 本次移动没有落成一个可对外宣布的持久成果。
      return "FAILED";
  }
}

/**
 * 一次移动的**结构化结果**。失败时**不许**只回一个 `ENOENT` 而把「刚删了目标」这件事
 * 瞒下去 —— 每个字段都如实回答「东西还在不在」。
 */
export interface MoveResult {
  /** 内容是否已稳定提交到 destination(部分完成也算 true —— 目标确实有内容)。 */
  committed: boolean;
  /** 操作结束后 source 是否仍在原路径(整次移动成功后才为 false)。 */
  sourcePreserved: boolean;
  /** destination 路径是否仍有有效内容(旧目标已恢复,或新内容已就位);false 表示此处丢了东西。 */
  destinationPreserved: boolean;
  /** 是否留下需要**人工介入**才能收拾的备份/残留(见 `backupRef`)。 */
  recoverable: boolean;
  /** 当前所处的生命周期阶段(见 {@link FileMovePhase})。 */
  phase: FileMovePhase;
  /** 与 ARC-005 对齐的三态(见 {@link outcomeForPhase});「移动成功」只在 `DURABLE` 时成立。 */
  commitOutcome: CommitOutcome;
  /** 需要人工恢复时的备份路径。 */
  backupRef?: string;
  /** 稳定原因码(`SAME_SOURCE_DESTINATION` / `DESTINATION_INSIDE_SOURCE` / `UNCERTAIN` …)。成功且无异常时省略。 */
  reason?: string;
  /** 本次操作的唯一 id(与日志/审计对得上)。 */
  operationId: string;
  /** 直接给模型/用户读的一行说明。 */
  message: string;
}

/** 「移动成功」的**唯一判据**(与 `@contracts/commit` 的 `isDurable` 同义)。调用点别再各写一遍。 */
export function isMoveDurable(result: MoveResult): boolean {
  return result.commitOutcome === "DURABLE";
}

export interface MoveFileOptions {
  /** 目标已存在时是否允许覆盖。默认 false。 */
  overwrite?: boolean;
}

/** 去掉要由各分支补的字段后的中间结果 —— 阶段与三态由 {@link mk} 一处填。 */
type BaseResult = Omit<MoveResult, "message" | "phase" | "commitOutcome" | "committed" | "sourcePreserved" | "destinationPreserved" | "recoverable">;

/** 规范化物理路径:已有的祖先照实解析(跟 junction/symlink),不存在的尾部原样拼回,
 *  大小写不敏感平台上折叠大小写。解析不了时退到字面 `resolve` + 折叠。 */
function canon(p: string): string {
  const phys = physicalPath(p);
  if (phys !== null) return phys;
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** 字面折叠(不跟符号链接)—— 用于判「仅大小写不同」。 */
function foldCase(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** child 是否严格位于 parent 目录树内部。两边都应是规范化后的路径。 */
function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function uniqueSuffix(): string {
  return `${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * 构造结果 —— **阶段与三态只在这里一处填**(保证 `phase` 与 `commitOutcome` 永不打架)。
 */
function mk(
  base: BaseResult,
  phase: FileMovePhase,
  patch: Partial<Pick<MoveResult, "committed" | "sourcePreserved" | "destinationPreserved" | "recoverable" | "backupRef" | "reason">> & {
    message: string;
  },
): MoveResult {
  return {
    ...base,
    committed: false,
    sourcePreserved: true,
    destinationPreserved: true,
    recoverable: false,
    phase,
    commitOutcome: outcomeForPhase(phase),
    ...patch,
  };
}

/** 「目标已就位但删源失败」的部分完成结果(反例 A 的正解)。 */
function partialSourceRemains(base: BaseResult, source: string, error: NodeJS.ErrnoException): MoveResult {
  return mk(base, "PARTIALLY_APPLIED", {
    committed: true,
    sourcePreserved: true,
    destinationPreserved: true,
    recoverable: true,
    reason: "PARTIALLY_APPLIED",
    message: `目标内容已就位,但删除源失败(${error.code ?? error.message});源仍在:${source},请确认目标无误后删除源,不要重跑整次移动`,
  });
}

/**
 * `overwrite=false` 且目标当前不存在时,**不制造 TOCTOU** 地把源提交到目标。
 *
 * 返回的是一个**分阶段**结论,让调用者能区分「目标真的建出来了」与「什么都没落」:
 *  - `"ok"` —— 目标已就位且源已删(整次移动完成);
 *  - `"exists"` —— 操作期间目标被并发创建,已拒绝、源未动;
 *  - `"partial"` —— 目标内容已就位,但删源失败(**已产生可见副作用**,不得当没发生);
 *  - `"failed"` —— 没有任何净副作用(源未删、目标未建)。
 *
 * ⚠️ **不能靠 `rename` 做 no-clobber。** 实测(win32/NTFS):`rename(file, 已存在文件)`
 * **静默覆盖**,既不抛 `EEXIST` 也不报错。所以对**文件**改用在该 OS 有原子 no-clobber
 * 语义的原语:`link`(同卷,目标已存在抛 `EEXIST`;跨卷 `EXDEV`)→ 成功后删源;跨卷时用
 * `copyFile(COPYFILE_EXCL)`(目标已存在抛 `EEXIST`)。**目录**没有跨平台的原子
 * no-clobber rename 原语:退回「紧贴 rename 前再 `lstat` 一次」,并依赖 win32 上
 * `rename` 撞已存在目录会抛 `EPERM`(绝不静默覆盖);POSIX 上仅可能替换掉「窗口内新建的
 * **空**目录」这一极窄情形,绝不删除非空目标。
 */
type NoClobberOutcome =
  | { status: "ok" }
  | { status: "exists" }
  | { status: "partial"; error: NodeJS.ErrnoException }
  | { status: "failed"; error: NodeJS.ErrnoException };

async function moveNoClobber(src: string, dst: string, srcStat: Stats): Promise<NoClobberOutcome> {
  return srcStat.isFile() ? noClobberFile(src, dst) : noClobberDir(src, dst);
}

async function noClobberFile(src: string, dst: string): Promise<NoClobberOutcome> {
  try {
    // link 是本机原子 no-clobber(win32/NTFS 与 POSIX 均已验目标已存在抛 EEXIST)。
    await fs.link(src, dst);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { status: "exists" };
    if (e.code !== "EXDEV") return { status: "failed", error: e };
    return noClobberFileCrossDevice(src, dst);
  }
  // 硬链接已建成:目标真的出现了。此刻删源失败也绝不能报「什么都没发生」。
  try {
    await fs.rm(src, { force: true });
    return { status: "ok" };
  } catch (err) {
    return { status: "partial", error: err as NodeJS.ErrnoException };
  }
}

/** Compare copied file bytes, not just size. Use bounded chunks rather than
 * loading multi-gigabyte user files into the Electron main process heap.
 * A mismatch/IO error MUST preserve the source for manual recovery. */
async function digestFile(path: string): Promise<string> {
  const handle = await fs.open(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function copiedFileMatches(src: string, dst: string): Promise<boolean> {
  const [source, target] = await Promise.all([fs.lstat(src), fs.lstat(dst)]);
  if (!source.isFile() || !target.isFile() || source.size !== target.size) return false;
  const [a, b] = await Promise.all([digestFile(src), digestFile(dst)]);
  return a === b;
}

/** Verify the full copied directory tree BEFORE deleting the source.
 * A successful fs.cp() does not prove every descendant arrived unchanged.
 * Never follow a symlink while verifying: compare link targets as metadata. */
async function copiedTreeMatches(src: string, dst: string): Promise<boolean> {
  const [source, target] = await Promise.all([fs.lstat(src), fs.lstat(dst)]);
  if (source.isFile()) return target.isFile() && copiedFileMatches(src, dst);
  if (source.isSymbolicLink()) {
    return target.isSymbolicLink() && (await fs.readlink(src)) === (await fs.readlink(dst));
  }
  if (!source.isDirectory() || !target.isDirectory()) return false;
  const [sourceNames, targetNames] = await Promise.all([fs.readdir(src), fs.readdir(dst)]);
  sourceNames.sort();
  targetNames.sort();
  if (sourceNames.length !== targetNames.length ||
      sourceNames.some((name, i) => name !== targetNames[i])) return false;
  for (const name of sourceNames) {
    if (!(await copiedTreeMatches(join(src, name), join(dst, name)))) return false;
  }
  return true;
}

async function noClobberFileCrossDevice(src: string, dst: string): Promise<NoClobberOutcome> {
  try {
    await fs.copyFile(src, dst, FS_CONSTANTS.COPYFILE_EXCL);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { status: "exists" };
    // COPYFILE_EXCL 会原子拒绝已存在的目标;此刻目标若真在,多半是本次写入中途落下的半截 ——
    // 如实报部分完成,绝不静默当成「没建出来」。
    const landed = await fs.lstat(dst).catch(() => null);
    return landed ? { status: "partial", error: e } : { status: "failed", error: e };
  }
  try {
    if (!(await copiedFileMatches(src, dst))) {
      return { status: "partial", error: Object.assign(
        new Error("跨卷目标内容校验失败：已保留源，请人工检查并清理不一致目标"),
        { code: "ECOPYVERIFY" },
      ) };
    }
  } catch (error) {
    return { status: "partial", error: error as NodeJS.ErrnoException };
  }
  try {
    await fs.rm(src, { force: true });
    return { status: "ok" };
  } catch (err) {
    return { status: "partial", error: err as NodeJS.ErrnoException };
  }
}

async function noClobberDir(src: string, dst: string): Promise<NoClobberOutcome> {
  const fresh = await fs.lstat(dst).catch(() => null);
  if (fresh) return { status: "exists" };
  try {
    await fs.rename(src, dst);
    return { status: "ok" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST" || e.code === "ENOTEMPTY" || e.code === "ENOTDIR" || e.code === "EPERM") {
      return { status: "exists" };
    }
    if (e.code !== "EXDEV") return { status: "failed", error: e };
    try {
      await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    } catch (err2) {
      const e2 = err2 as NodeJS.ErrnoException;
      if (e2.code === "EEXIST" || e2.code === "ERR_FS_CP_EEXIST") return { status: "exists" };
      const landed = await fs.lstat(dst).catch(() => null);
      return landed ? { status: "partial", error: e2 } : { status: "failed", error: e2 };
    }
    try {
      if (!(await copiedTreeMatches(src, dst))) {
        return { status: "partial", error: Object.assign(
          new Error("跨卷目录内容校验失败，已保留源；目标可能不完整，请人工处理"),
          { code: "ECOPYVERIFY" },
        ) };
      }
    } catch (error) {
      return { status: "partial", error: error as NodeJS.ErrnoException };
    }
    try {
      await fs.rm(src, { recursive: true, force: true });
      return { status: "ok" };
    } catch (err2) {
      return { status: "partial", error: err2 as NodeJS.ErrnoException };
    }
  }
}

/**
 * 无原子 no-clobber 目录 rename 的平台上,靠 `mkdir` 的原子性先占住目标槽位,再把备份
 * 的子项逐个搬进去 —— 只要占位成功,槽位就是我们的,后续移动不会撞上第三方内容。
 */
async function restoreDirNoClobber(backup: string, destination: string): Promise<boolean> {
  try {
    // 占位:槽位已被占(mkdir 抛 EEXIST)就绝不再动它。
    await fs.mkdir(destination);
  } catch {
    return false;
  }
  try {
    const children = await fs.readdir(backup);
    for (const name of children) {
      await fs.rename(join(backup, name), join(destination, name));
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    // 半途失败:destination 已有部分内容、backup 也还在 —— 交人工,不外删。
    return false;
  }
}

/** 恢复旧目标 —— 目标槽位**未被占用**才安全提交;文件走原子 `link`,目录走 `mkdir` 占位。 */
async function restoreBackupNoClobber(backup: string, destination: string): Promise<boolean> {
  const bstat = await fs.lstat(backup).catch(() => null);
  if (!bstat) return false; // 备份都不在了,无从恢复(交人工)。
  if (!bstat.isDirectory()) {
    // 原子 no-clobber:link 目标已存在即 EEXIST → 不覆盖第三方内容(反例 B 的正解)。
    try {
      await fs.link(backup, destination);
    } catch {
      return false;
    }
    await fs.rm(backup, { force: true }).catch(() => {});
    return true;
  }
  return restoreDirNoClobber(backup, destination);
}

type CrossResult =
  | { ok: true }
  | { ok: false; phase: "copy" | "switch" | "remove-source"; error: NodeJS.ErrnoException };

/**
 * 跨卷移动:先复制到目标卷的独立临时位置并校验,再切换目标,最后才删源。
 * 复制/切换失败会清掉临时残留、**不动源**;删源失败如实回报(目标已稳,源仍在)。
 */
async function crossDeviceMove(src: string, dst: string): Promise<CrossResult> {
  const tmp = `${dst}.mcode-move-tmp-${uniqueSuffix()}`;
  try {
    await fs.cp(src, tmp, { recursive: true, force: false, errorOnExist: true });
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, phase: "copy", error: err as NodeJS.ErrnoException };
  }
  // 完整性校验:文件比大小;目录确认落盘。
  try {
    if (!(await copiedTreeMatches(src, tmp))) {
      throw Object.assign(new Error("跨卷复制校验失败:文件或目录树内容不一致"), { code: "ECOPYVERIFY" });
    }
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, phase: "copy", error: err as NodeJS.ErrnoException };
  }
  // 切换目标(tmp 与 dst 同卷,rename 原子)。
  try {
    await fs.rename(tmp, dst);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, phase: "switch", error: err as NodeJS.ErrnoException };
  }
  // 目标已稳定提交,**此时才**删除源。
  try {
    await fs.rm(src, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, phase: "remove-source", error: err as NodeJS.ErrnoException };
  }
  return { ok: true };
}

/** 尽力清理备份;删不掉就把路径报出来(不静默),并如实标 `recoverable`。 */
async function cleanupBackup(backup: string, result: MoveResult): Promise<void> {
  try {
    await fs.rm(backup, { recursive: true, force: true });
  } catch (err) {
    result.recoverable = true;
    result.backupRef = backup;
    result.message += `;旧备份暂未清掉,可手动删除:${backup}(${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
}

/**
 * 安全移动/重命名。**不抛**预期内的错误 —— 一切经 {@link MoveResult} 如实回答;只有
 * 编程错误(不该发生的)才会冒泡。
 */
export async function moveFileSafe(
  source: string,
  destination: string,
  opts: MoveFileOptions = {},
): Promise<MoveResult> {
  const operationId = randomUUID();
  const overwrite = opts.overwrite === true;
  const base: BaseResult = { operationId };

  const srcStat = await fs.lstat(source).catch(() => null);
  if (!srcStat) return mk(base, "PREPARED", { reason: "SOURCE_MISSING", message: `原路径不存在:${source}` });

  /* ── 副作用前预检:身份/拓扑 ── */
  if (resolve(source) === resolve(destination)) {
    // 源 == 目标:no-op 成功,源字节逐字节不变。
    return mk(base, "COMMITTED", { committed: true, reason: "SAME_SOURCE_DESTINATION", message: `源与目标相同,未做任何改动:${source}` });
  }
  if (foldCase(source) === foldCase(destination)) {
    // 仅大小写不同:同卷 rename 原子、不删目标,支持「只改大小写」的重命名。
    try {
      await fs.rename(source, destination);
      return mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已改名(仅大小写)${source} -> ${destination}` });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return mk(base, "PREPARED", { reason: "CASE_RENAME_FAILED", message: `仅大小写改名失败(${e.code ?? e.message});源未改动` });
    }
  }
  const srcCanon = canon(source);
  const dstCanon = canon(destination);
  if (srcCanon === dstCanon) {
    // 不同字面、同一实体(符号链接别名等):拒绝而非猜意图,避免误删。
    return mk(base, "PREPARED", { reason: "SAME_SOURCE_DESTINATION", message: `源与目标解析到同一实体,已拒绝以免误删:${source}` });
  }
  if (srcStat.isDirectory() && isInside(srcCanon, dstCanon)) {
    return mk(base, "PREPARED", { reason: "DESTINATION_INSIDE_SOURCE", message: `目标位于源的目录树内部,拒绝移动以免数据丢失:${destination} 在 ${source} 之内` });
  }
  if (isInside(dstCanon, srcCanon)) {
    return mk(base, "PREPARED", { reason: "SOURCE_CONTAINED_IN_DESTINATION", message: `源位于目标的目录树内部,拒绝移动:${source} 在 ${destination} 之内` });
  }

  let destStat = await fs.lstat(destination).catch(() => null);
  await fs.mkdir(dirname(destination), { recursive: true });

  /* ── 目标当前不存在 ── */
  if (!destStat && (!overwrite || srcStat.isFile())) {
    // 即使 overwrite=true，预检时目标不存在也不能直接用 win32 rename:
    // 另一个进程可能在 lstat(ENOENT) 后抢先创建目标。文件走原子 link
    // no-clobber；撞目标才在下面执行正式「先备份、再覆盖」协议。
    const verdict = await moveNoClobber(source, destination, srcStat);
    if (verdict.status === "ok") {
      return mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已移动 ${source} -> ${destination}` });
    }
    if (verdict.status === "exists") {
      if (!overwrite) {
        return mk(base, "PREPARED", { reason: "DESTINATION_EXISTS", message: `目标在操作过程中被创建,overwrite=false 不覆盖:${destination}` });
      }
      destStat = await fs.lstat(destination).catch(() => null);
      if (!destStat) {
        return mk(base, "PREPARED", { reason: "DESTINATION_CHANGED", message: `并发目标在准备覆盖前再次改变，拒绝猜测:${destination}` });
      }
    } else {
      if (verdict.status === "partial") return partialSourceRemains(base, source, verdict.error);
      return mk(base, "PREPARED", { reason: verdict.error.code ?? "RENAME_FAILED", message: `移动失败(${verdict.error.code ?? verdict.error.message});源未改动` });
    }
  }
  if (!destStat) {
    try {
      await fs.rename(source, destination);
      return mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已移动 ${source} -> ${destination}` });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST" || e.code === "ENOTEMPTY" || e.code === "ENOTDIR") {
        // 并发中出现的目标:overwrite=true 允许覆盖,但此刻它已被建出 —— 传下去走覆盖分支。
        return await moveFileSafe(source, destination, { overwrite: true });
      }
      if (e.code !== "EXDEV") {
        return mk(base, "PREPARED", { reason: e.code ?? "RENAME_FAILED", message: `移动失败(${e.code ?? e.message});源未改动` });
      }
    }
    // 跨卷:两阶段复制。
    const cr = await crossDeviceMove(source, destination);
    if (cr.ok) return mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已跨卷移动 ${source} -> ${destination}` });
    if (cr.phase === "remove-source") return partialSourceRemains(base, source, cr.error);
    return mk(base, "PREPARED", { reason: cr.error.code ?? "COPY_FAILED", message: `跨卷移动失败(${cr.error.code ?? cr.error.message});源未改动` });
  }

  /* ── 目标已存在 ── */
  if (!overwrite) {
    return mk(base, "PREPARED", { reason: "DESTINATION_EXISTS", message: `目标已存在:${destination};确认覆盖时传 overwrite=true` });
  }

  // 覆盖:先把旧目标挪到同卷唯一备份,**绝不先删**。
  const backup = `${destination}.mcode-move-bak-${uniqueSuffix()}`;
  try {
    await fs.rename(destination, backup);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return mk(base, "PREPARED", { reason: e.code ?? "BACKUP_FAILED", message: `未能暂存旧目标(${e.code ?? e.message});源与目标均未改动` });
  }

  // 旧目标已安全暂存;现在 destination 位置空出,尝试把源提交过去。
  const failReason: NodeJS.ErrnoException = { code: "RENAME_FAILED" } as NodeJS.ErrnoException;
  try {
    await fs.rename(source, destination);
    const ok = mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已覆盖移动 ${source} -> ${destination}` });
    await cleanupBackup(backup, ok);
    return ok;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EXDEV") {
      const cr = await crossDeviceMove(source, destination);
      if (cr.ok) {
        const ok = mk(base, "COMMITTED", { committed: true, sourcePreserved: false, message: `已跨卷覆盖移动 ${source} -> ${destination}` });
        await cleanupBackup(backup, ok);
        return ok;
      }
      if (cr.phase === "remove-source") {
        // 目标已就位(新内容),源仍在:覆盖意图已达成 → 清旧备份,但如实报部分完成。
        const partial = partialSourceRemains(base, source, cr.error);
        await cleanupBackup(backup, partial);
        return partial;
      }
      // 复制/切换失败:destination 位置仍是空的 → 恢复旧目标。
      failReason.code = cr.error.code ?? "COPY_FAILED";
      failReason.message = cr.error.message;
    } else {
      failReason.code = e.code ?? "RENAME_FAILED";
      failReason.message = e.message;
    }
  }

  // 走到这里 = 提交失败:把旧目标从备份恢复回去 —— **只在目标槽位未被占用时**才安全提交。
  const restored = await restoreBackupNoClobber(backup, destination);
  if (restored) {
    return mk(base, "PREPARED", { sourcePreserved: true, destinationPreserved: true, reason: failReason.code ?? "RENAME_FAILED", message: `移动失败(${failReason.code ?? failReason.message});已恢复原目标,源未改动` });
  }
  // 槽位已被别的写入者占用(或恢复中断):保留备份 + 保留第三方内容,交人工,**绝不强替**。
  // `destinationPreserved` 如实反映此刻槽位**是否真有内容** —— 第三方内容也算内容,不算丢。
  const occupied = (await fs.lstat(destination).catch(() => null)) !== null;
  return mk(base, "UNCERTAIN", {
    sourcePreserved: true,
    destinationPreserved: occupied,
    recoverable: true,
    backupRef: backup,
    reason: "UNCERTAIN",
    message: occupied
      ? `移动失败(${failReason.code ?? failReason.message});目标槽位已被其它写入者占用,未强行覆盖;旧目标保留在备份:${backup},请人工核对后处置`
      : `移动失败(${failReason.code ?? failReason.message});且旧目标恢复也失败;旧内容仍保留在备份,请人工恢复:${backup}`,
  });
}
