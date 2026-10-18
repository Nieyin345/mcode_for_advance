/** ARC-007: atomicReplaceFile 的失败清理与原文保全（仅系统隔离临时目录）。 */
import { chmod, lstat, mkdir, mkdtemp, readlink, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

let total = 0, failures = 0;
function check(name: string, ok: boolean, info?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name} — ${JSON.stringify(info)}`); }
}
const dir = await mkdtemp(join(tmpdir(), "mcode-atomic-write-fail-"));
try {
  const file = join(dir, "sample.txt");
  await writeFile(file, "important old bytes");
  await atomicReplaceFile(file, "valid replacement");
  check("正常文本原子替换成功", (await readFile(file, "utf8")) === "valid replacement");

  // POSIX: 写入临时文件时默认 0666 & umask，rename 会把原本 0600 的文件
  // 变成其他本地用户可读。Windows ACL/stat.mode 不直接等于 POSIX 权限位：
  // 该平台还要明确核查唯一实现使用目标 mode/0600，而不能把它当 OS U1。
  const restricted = join(dir, "restricted.txt");
  await writeFile(restricted, "old secret");
  await chmod(restricted, 0o600);
  const fresh = join(dir, "fresh-private.txt");
  const umaskBefore = process.umask(0); // 仅本 smoke 独立 Node 子进程，刻意放大旧缺陷。
  try {
    await atomicReplaceFile(restricted, "new secret");
    await atomicReplaceFile(fresh, "new private");
  } finally { process.umask(umaskBefore); }
  if (process.platform !== "win32") {
    check("★ 覆盖 0600 文件不扩大原始权限",
      ((await stat(restricted)).mode & 0o777) === 0o600, (await stat(restricted)).mode & 0o777);
    check("★ 首次写入文件默认 0600 而非依赖 umask",
      ((await stat(fresh)).mode & 0o777) === 0o600, (await stat(fresh)).mode & 0o777);
  } else {
    const candidate = [join(process.cwd(), "src/main/lib/atomicFile.ts"),
      join(process.cwd(), "apps/desktop/src/main/lib/atomicFile.ts")].find(existsSync);
    const source = candidate ? await readFile(candidate, "utf8") : "";
    check("★ Windows 测试核查写入实现不使用隐式 0666 临时文件",
      /openFile\(tmp,\s*"wx",\s*mode\)/.test(source), candidate);
    check("★ Windows 测试核查新文件默认私有",
      /let mode = 0o600/.test(source), candidate);
  }

  // POSIX 的 open(mode) 仍会受到 process.umask 约束。例如既有 0644、
  // 当前 umask=077 时，临时文件实际仅 0600；rename 后会意外抹掉原权限。
  const shared = join(dir, "existing-readable.txt");
  await writeFile(shared, "ordinary nonsecret");
  await chmod(shared, 0o644);
  const oldUmask = process.umask(0o077);
  try {
    await atomicReplaceFile(shared, "replacement");
  } finally { process.umask(oldUmask); }
  if (process.platform !== "win32") {
    check("★ 旧目标 0644 在调用者 umask 077 下仍保留精确权限",
      ((await stat(shared)).mode & 0o777) === 0o644,
      (await stat(shared)).mode & 0o777);
  } else {
    const candidate = [join(process.cwd(), "src/main/lib/atomicFile.ts"),
      join(process.cwd(), "apps/desktop/src/main/lib/atomicFile.ts")].find(existsSync);
    const source = candidate ? await readFile(candidate, "utf8") : "";
    check("★ 受 umask 限制后用句柄恢复旧文件权限的回归门槛",
      source.includes("await handle.chmod(mode)"), candidate);
  }
  check("★ 修复权限时不得破坏目标字节",
    (await readFile(shared, "utf8")) === "replacement");

  // 模拟打开临时文件之后、writeFile() 写入失败的分支。
  // 实际 ENOSPC / EIO 也会进入该分支；这里不用修改磁盘限额/用户文件。
  let threw = false;
  try {
    await atomicReplaceFile(file, null as unknown as Uint8Array);
  } catch { threw = true; }
  check("写入失败向上抛错（绝不假成功）", threw);
  check("失败后旧目标字节逐字节保留", (await readFile(file, "utf8")) === "valid replacement");
  const leftovers = (await readdir(dir)).filter((x) => x.includes(".mcode-tmp"));
  check("写入失败不能泄露临时文件", leftovers.length === 0, leftovers);

  const bytes = new Uint8Array([0, 255, 128, 10, 1]);
  await atomicReplaceFile(file, bytes);
  check("有效二进制替换不改变字节", Buffer.compare(await readFile(file), Buffer.from(bytes)) === 0);
  check("正常路径也没有临时残留", (await readdir(dir)).every((x) => !x.includes(".mcode-tmp")));

  // 路径本身是 symlink 时不可以用 stat() 顺着它拿目标 mode，再 rename()
  // 覆盖链接本身：这样既没保存到用户预期的目标，还破坏了原始链接。
  const linkedTarget = join(dir, "symlink-original.txt");
  const symlinkPath = join(dir, "symlink-save.txt");
  await writeFile(linkedTarget, "original-target-bytes");
  let symlinkSupported = true;
  try { await symlink(linkedTarget, symlinkPath, "file"); }
  catch (err) {
    if (process.platform === "win32" &&
        (err as NodeJS.ErrnoException).code === "EPERM") symlinkSupported = false;
    else throw err;
  }
  if (symlinkSupported) {
    let rejected = false;
    try { await atomicReplaceFile(symlinkPath, "new contents"); }
    catch { rejected = true; }
    check("★ 原子保存遇到符号链接必须 fail-closed", rejected);
    check("★ 拒绝时链接身份与原目标字节都不改变",
      (await lstat(symlinkPath)).isSymbolicLink()
      && (await readlink(symlinkPath)) === linkedTarget
      && (await readFile(linkedTarget, "utf8")) === "original-target-bytes");
  } else {
    // Win32 非开发者模式不能创建真正的 symlink；不能把这个 skip 计作
    // 真系统绿例，至少验生产代码不会使用 stat() 顺着链接读取权限。
    console.log("  [SKIP] 当前 Windows 环境缺少建立测试符号链接的权限；无 OS 级 symlink 证明");
    const candidate = [join(process.cwd(), "src/main/lib/atomicFile.ts"),
      join(process.cwd(), "apps/desktop/src/main/lib/atomicFile.ts")].find(existsSync);
    const source = candidate ? await readFile(candidate, "utf8") : "";
    check("★ Windows 跳过 OS symlink 后须有 lstat 不跟随链接的代码围栏",
      /await lstat\(filePath\)/.test(source), candidate);
  }

  // Win32 的目录 junction 不一定要求开发者模式；相比不能创建的文件
  // symlink，它仍是一个真实 OS 重解析点，不可被原子写意外替换。
  if (process.platform === "win32") {
    const directory = join(dir, "junction-original");
    const junction = join(dir, "junction-save");
    await mkdir(directory);
    await writeFile(join(directory, "SENTINEL"), "keep directory");
    try {
      await symlink(directory, junction, "junction");
      let refused = false;
      try { await atomicReplaceFile(junction, "bad"); }
      catch { refused = true; }
      check("★ Win32 真实 junction 写入必须拒绝", refused);
      check("★ junction 目标目录内容和链接类型保持不变",
        (await lstat(junction)).isSymbolicLink()
        && (await readFile(join(directory, "SENTINEL"), "utf8")) === "keep directory");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        console.log("  [SKIP] Windows junction 创建权限不足，不计入动态通过");
      } else { throw err; }
    }
  }

  // rename 被目标目录阻止时也须拒写并清理（这条在重构前后都应成立）。
  const directoryTarget = join(dir, "cannot-replace-directory");
  await mkdir(directoryTarget);
  let renameRejected = false;
  try { await atomicReplaceFile(directoryTarget, "should fail"); }
  catch { renameRejected = true; }
  check("rename 目标是目录时 fail-closed", renameRejected);
  check("rename 失败不残留临时文件，也不覆盖目标目录",
    (await readdir(dir)).every((x) => !x.includes(".mcode-tmp"))
    && (await readdir(directoryTarget)).length === 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`atomic-file-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
