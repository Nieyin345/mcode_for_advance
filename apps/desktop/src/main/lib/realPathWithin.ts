/**
 * 物理路径包含性判据 —— **唯一一份**,零依赖(只 import node:path / node:fs)。
 *
 * ## 为什么单独拆出来
 *
 * {@link pathWithin} 原先长在 `@main/lib/pathGuard.ts` 里,而那个文件 import 了
 * `store/repositories`(→ `db.ts` → `electron`)。于是**任何只想做一次"这个绝对路径
 * 是否还在根里"判断的模块**,一 import 它就把整条数据库/Electron 的链拉进了自己的
 * bundle —— 无头 smoke 会当场打不出来,主进程里也只是白白多一份循环依赖。
 *
 * 而这条判断的输入输出全是**纯文件系统事实**(`realpath` / `lstat`),与项目、
 * 会话、数据库毫无关系。把它落成一个叶子模块,`pathGuard` 与 `fileSnapshot` 就能
 * 共用**同一段代码**,而不是各写一份(仓库硬规矩:共享实现只有一份 —— 从前
 * `library/paths` 的 `toLibraryRelative` 那种"两处各写一遍"就出过静默失效)。
 *
 * ## 它判什么
 *
 * 只判字面路径(`resolve` 后剥 `.`/`..`/多余分隔符)是**不够**的:工作区里的一个
 * 符号链接 / Windows junction 可以指向工作区之外,而字面路径看起来仍在里面 ——
 * `path.relative` 那套纯字符串判据对此**完全无感**。所以这里在字面判据之上再比一次
 * **真实目的地**:逐级 `realpath` 到最近存在的祖先后拼回不存在的尾部。
 *
 * ⚠️ 这不解决 TOCTOU(检查与使用之间链接被换掉)。它是"拒绝明显越界"的一道闸,
 * 不是原子隔离 —— 真正的隔离要靠操作系统账户/沙箱,那不在本文件职责内。
 */
import { basename, dirname, join, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { platform } from "node:os";

/** 大小写不敏感的文件系统(Windows、macOS)上比较要折叠大小写:Monaco/LSP 会给出
 *  小写盘符(`d:\foo`),而项目里存的是大写(`D:\foo`)。 */
const CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";

/** 归一化:resolve 之后在大小写不敏感平台折成小写。 */
function norm(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** 分隔符感知的包含判定;两边都已归一化。 */
export function contained(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 解析到**物理路径**:已有的祖先照实解析(junction、symlink 都跟),尚不存在的
 * 尾部原样拼回。
 *
 * 断裂的符号链接或任何非 ENOENT 的文件系统错误一律**失败关闭**(返回 null),
 * 而不是当成"不存在的子路径"放过去。
 */
export function physicalPath(path: string): string | null {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return norm(join(realpathSync.native(current), ...missing.reverse()));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try {
        // lstat 看得见 realpath 跟不动的断裂链接。
        lstatSync(current);
        return null;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 只有当**字面路径**与它的**物理目的地**(新文件取最近存在的祖先)都落在 `root`
 * 内时才是 true。Windows/macOS 上大小写不敏感。
 *
 * 这是文件、git、终端、LSP、快照与资料库共用的那一道闸 —— 挡的就是
 * "工作区里的链接指向工作区外面"。
 */
export function pathWithin(root: string, abs: string): boolean {
  const r = norm(root);
  const a = norm(abs);
  if (!contained(r, a)) return false;
  return physicalTargetInRoot(root, abs);
}

/**
 * **只看真实目的地** —— 这个路径最终落在 `root` 里吗?不管它的字面样子。
 *
 * 与 {@link pathWithin} 的区别正是"字面"那半边:
 *
 * | 输入 | `pathWithin(root, x)` | `physicalTargetInRoot(root, x)` |
 * |---|---|---|
 * | `root/a/b` | true | true |
 * | `root/../other` | false(字面越界) | false |
 * | **`elsewhere/link`(link→root)** | **false**(字面不在 root 里) | **true** |
 *
 * 第三种是**两个方向**要分开用的根因:问"这份文件是不是库里的记录"时,答案该是
 * **false** —— 它字面上就是别人的别名,不是库的内容;问"往这儿写会不会改到库"时,
 * 答案该是 **true** —— 真实目的地就是库。一个函数兼不了这两问(资料库 MC-001)。
 */
export function physicalTargetInRoot(root: string, abs: string): boolean {
  const physicalRoot = physicalPath(root);
  const physicalAbs = physicalPath(abs);
  return physicalRoot !== null && physicalAbs !== null && contained(physicalRoot, physicalAbs);
}
