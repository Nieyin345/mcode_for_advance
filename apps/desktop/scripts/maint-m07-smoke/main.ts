/**
 * MAINT-2026-09 / M07 · 本地路径、文件树与快照安全 —— 独占回归。
 *
 * ## 它盯的是什么
 *
 * `main/ipc/files.ts` 的处理器**同时用了两份不同的包含性判定**:
 *
 *  - 外层用共享的 `lib/pathGuard.ts`(`findContainingWorkspaceRoot` /
 *    `isKnownWorkspaceRoot`)—— 在 Windows / macOS 这类**大小写不敏感**的文件系统上
 *    刻意做了大小写归一(那个文件的头注释写明了缘由:Monaco / LSP 交上来的盘符
 *    可能是小写的 `d:\foo`,而项目根存的是 `D:\foo`);
 *  - 内层的"纵深防御"用的却是 `files.ts` 自己的一份私有 `pathWithin`,它是
 *    **大小写敏感**的裸 `resolve()` 前缀比较。
 *
 * 于是同一次调用里两道闸的结论可以相反:外层认下了这条路径、内层又判它越界。
 * 表现是**静默失败** —— `file:writeFile` 返回 `{ ok: false }`(编辑器"存不下去"),
 * `file:rename` 返回 `{ ok: false }`,而渲染端只看得到一个失败,主进程日志里才有
 * 一句 "escapes root"。
 *
 * 本套件直接驱动真实处理器,断言的是**两道闸必须给出同一个结论**。
 *
 * ## 平台
 *
 * 大小写这一组只在大小写不敏感的文件系统(win32 / darwin)上才有意义,别的平台
 * **显式跳过并打印**(不静默略过,也不伪称通过)。与平台无关的那几条(正常路径、
 * 越界、同名前缀兄弟目录)在所有平台都跑。
 *
 * 不起 Electron、不联网、不碰真实项目根:项目根是 mkdtemp 出来的临时目录,
 * 用完即删;数据根桩直接抛(文献库/模版库那一类根在本套件里不存在)。
 *
 * Run: scripts/maint-m07-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { IPC } from "@contracts/ipc";
import { listDirGuarded, readFileGuarded, registerFileHandlers } from "@main/ipc/files.js";
import { acquireOsFileLease } from "@main/lib/osFileLease.js";
import { setFsFault } from "./fsFaultShim.js";
import { projectPaths, warnings } from "./stubs.js";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (Object.is(actual, expected)) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name} — ${JSON.stringify({ actual, expected })}`);
}

/** 大小写不敏感的文件系统 —— 与 pathGuard.ts 的判据一致。 */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/* ── 一个真实的临时项目 ─────────────────────────────────────────────────── */
const base = mkdtempSync(join(tmpdir(), "mcode-maint-m07-"));
// 目录名里同时有大小写字母,才变换得出一个"同一个目录、不同写法"的路径。
const projectRoot = join(base, "M07Proj");
mkdirSync(join(projectRoot, "src"), { recursive: true });
writeFileSync(join(projectRoot, "src", "index.ts"), "export const a = 1;\n", "utf-8");
projectPaths.push(projectRoot);

/** 把项目目录名换个大小写写法。**同一个目录**(在 win32/darwin 上),只是写法不同 ——
 *  这正是 Monaco / LSP 交回来的路径可能长的样子。 */
function caseVariant(p: string): string {
  const name = basename(projectRoot);
  return p.replace(projectRoot, join(dirname(projectRoot), name.toUpperCase()));
}

/* ── 假的 ipcMain:把处理器收下来直接调 ──────────────────────────────────── */
const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
registerFileHandlers({
  handle(channel: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) {
    handlers.set(channel, fn);
  },
} as never);
async function call(channel: string, payload: unknown): Promise<{ ok?: boolean; conflict?: boolean }> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return (await fn(null, payload)) as { ok?: boolean; conflict?: boolean };
}

/** 锁文件是 `${real}.mcode-lock`(见 lib/osFileLease.ts)—— realpath 解析,文件不存在时
 *  回落到 `resolve`(与实际实现同一套兜底,便于对刚删掉的文件清锁)。**唯一一份**。 */
function lockPathFor(f: string): string {
  let real: string;
  try { real = realpathSync(f); } catch { real = resolve(f); }
  return `${real}.mcode-lock`;
}

/** 起一个**独立 OS 进程**去调真实的 FILE_WRITE(入口由 run.cjs 打成 mjs 并经环境变量给出)。 */
const childEntry = process.env.MCODE_M07_CHILD_ENTRY ?? "";
function spawnWrite(filePath: string, fill: string, count: number, expectedVersion: string): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    if (!childEntry || !existsSync(childEntry)) {
      reject(new Error(`缺少 child-write 入口(应经 run.cjs 设置):${childEntry}`));
      return;
    }
    const child = spawn(
      process.execPath,
      [childEntry, filePath, projectRoot, fill, String(count), expectedVersion],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "", errOut = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try { resolve(JSON.parse(line) as { ok: boolean; conflict?: boolean; error?: string }); }
      catch { resolve({ ok: false, error: `子进程无可解析输出:stdout=${out.trim()} stderr=${errOut.trim()}` }); }
    });
  });
}

/** 【MC-097 跨进程租约】独立子进程入口(由 run.cjs 打成 mjs 并经环境变量给出)——
 *  真 OS 进程直接去抢/持有同一把 `lib/osFileLease.ts` 的磁盘租约。 */
const leaseEntry = process.env.MCODE_M07_LEASE_ENTRY ?? "";
function requireLeaseEntry(): void {
  if (!leaseEntry || !existsSync(leaseEntry)) throw new Error(`缺少 child-lease 入口(应经 run.cjs 设置):${leaseEntry}`);
}
/** 起一个真 OS 进程试抢锁一次:抢到立即释放退出 / 抢不到打印冲突。等它退出后返回结果。 */
function spawnLeaseOnce(lockPath: string, waitMs: number): Promise<{ acquired: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    try { requireLeaseEntry(); } catch (e) { reject(e); return; }
    const child = spawn(process.execPath, [leaseEntry, lockPath, "acquire-once", String(waitMs)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errOut = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try { resolve(JSON.parse(line) as { acquired: boolean; error?: string }); }
      catch { resolve({ acquired: false, error: `子进程无可解析输出:stdout=${out.trim()} stderr=${errOut.trim()}` }); }
    });
  });
}
/** 起一个真 OS 进程抢锁并**持有不释放**,等父进程真 SIGKILL。返回它的 pid 与进程句柄
 *  (句柄供测试发 SIGKILL)。 */
function spawnLeaseHolder(lockPath: string): Promise<{ child: import("node:child_process").ChildProcess; pid: number; acquired: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    try { requireLeaseEntry(); } catch (e) { reject(e); return; }
    const child = spawn(process.execPath, [leaseEntry, lockPath, "hold", "8000"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errOut = "", done = false;
    const finish = (): void => {
      if (done) return; done = true;
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try { resolve({ child, ...(JSON.parse(line) as { pid: number; acquired: boolean; error?: string }) }); }
      catch { resolve({ child, acquired: false, pid: -1, error: `子进程无可解析输出:stdout=${out.trim()} stderr=${errOut.trim()}` }); }
    };
    // hold 模式子进程不会退出:拿到第一行 JSON 就够(pid 是它自己报的,进程随后保持存活)。
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); if (out.includes("\n")) finish(); });
    child.stderr.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", finish);
    setTimeout(finish, 8000);
  });
}
/** 轮询某 pid 直到它在**本机探活**下判死(`process.kill(pid,0)` 抛 ESRCH)——与 osFileLease.ts
 *  的 `leaseOwnerAlive` 同一判据。返回是否已死。 */
async function waitChildDead(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let err: NodeJS.ErrnoException | null = null;
    try { process.kill(pid, 0); } catch (e) { err = e as NodeJS.ErrnoException; }
    if (err && err.code === "ESRCH") return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}


try {
  /* ── 1. 基线:写法与登记的项目根完全一致时,一切正常(所有平台) ───────── */
  console.log("\n基线:路径写法与登记的项目根一致");
  const exact = join(projectRoot, "src", "index.ts");
  check("readFile 读得到", (await readFileGuarded(exact)).content.includes("export const a"), true);
  check("listDir 列得出 src", (await listDirGuarded(projectRoot, "src")).entries.length, 1);
  check("writeFile 存得下", (await call(IPC.FILE_WRITE, { filePath: exact, content: "export const a = 2;\n" })).ok, true);
  check("写进去的就是新内容", readFileSync(exact, "utf-8").trim(), "export const a = 2;");
  const renamedExact = join(projectRoot, "src", "renamed.ts");
  check("rename 改得动", (await call(IPC.FILE_RENAME, { oldPath: exact, newPath: renamedExact })).ok, true);
  check("改完文件真在新名字上", existsSync(renamedExact), true);

  /* ── 1b. 【MC-097】故障注入 E1:崩溃 / 租约失效下的原子性与可恢复性 ──────────────
   * 真实 Electron 两端并发做不了(那是无头套件之外的事),但「写临时文件 / rename 崩了会怎样」
   * 可以在**不改生产代码**的前提下注入:用 esbuild 把 `node:fs/promises` 换成一份转发壳
   * (`fsFaultShim.ts`),让 `open`(临时文件创建)或 `rename`(原子替换提交步)按需失败。壳里
   * 未设故障开关时逐调用转发真实实现。断言的是**用户能看到的事实**:原文件一个字节都没动、
   * 磁盘上没留下半截临时文件、卡死的租约能被下一个写者回收、失败者释放锁后别人写得进。 */
  console.log("\n【MC-097 E1】故障注入:崩溃/租约失效下的原子性与可恢复性");
  {
    // 锁文件是 `${real}.mcode-lock`(见 lib/osFileLease.ts)—— 用模块级唯一一份 `lockPathFor`。
    const mkLockPath = lockPathFor;
    const tmpResidue = (dir: string): string[] =>
      readdirSync(dir).filter((n) => n.includes(".mcode-tmp"));

    // 找一个**确定已死**的 pid(在本机探测:kill(pid,0) 抛 ESRCH 即为不存在),给租约回收用。
    let deadPid = -1;
    for (let p = 40_000; p < 60_000; p++) {
      try { process.kill(p, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") { deadPid = p; break; } }
    }
    check("前提:探测到一个已死 pid(供陈旧租约回收)", deadPid > 0, true);

    // ① 注入 rename 失败(临时文件已写+fsync,提交那一步崩)→ 原文件逐字节不变,无临时残留。
    {
      const p = join(projectRoot, "src", "e1-rename.ts");
      const ORIGINAL = "ORIGINAL-BYTES-MUST-SURVIVE\n";
      writeFileSync(p, ORIGINAL, "utf-8");
      const before = readFileSync(p);
      const ver = (await readFileGuarded(p)).version;
      setFsFault({ failRename: (target) => target === p });
      let outcome: { ok?: boolean; conflict?: boolean };
      try {
        outcome = await call(IPC.FILE_WRITE, { filePath: p, content: "SHOULD-NOT-LAND\n", expectedVersion: ver });
      } finally {
        setFsFault(null);
      }
      check("★ E1:rename 崩溃 → 写入如实报失败(不静默成功)", outcome.ok === false, true);
      check("★ E1:rename 崩溃 → 原文件逐字节不变(没被半写/覆盖)", readFileSync(p).equals(before), true);
      check("★ E1:rename 崩溃 → 磁盘不留 .mcode-tmp 临时残留", tmpResidue(join(projectRoot, "src")).length, 0);
      // 崩溃后这个文件仍可读、可重写(回读证明没被污染)。
      check("★ E1:崩溃后文件仍可读回原内容", readFileSync(p, "utf-8"), ORIGINAL);
    }

    // ② 注入临时文件 open 失败(写临时文件前就崩)→ 同样原文件不动、无残留。
    {
      const p = join(projectRoot, "src", "e1-open.ts");
      const ORIGINAL = "OPEN-FAIL-ORIGINAL\n";
      writeFileSync(p, ORIGINAL, "utf-8");
      const before = readFileSync(p);
      setFsFault({ failOpen: (target) => target.includes(".mcode-tmp") });
      let outcome: { ok?: boolean };
      try {
        outcome = await call(IPC.FILE_WRITE, { filePath: p, content: "NOPE\n" });
      } finally {
        setFsFault(null);
      }
      check("★ E1:临时文件 open 崩溃 → 报失败", outcome.ok === false, true);
      check("★ E1:临时文件 open 崩溃 → 原文件逐字节不变", readFileSync(p).equals(before), true);
      check("★ E1:临时文件 open 崩溃 → 不留临时残留", tmpResidue(join(projectRoot, "src")).length, 0);
    }

    // ③ 陈旧租约(死 pid)被回收 → 下一个写者照常写入(不再永久阻塞)。
    //    直接对**共享原语** `acquireOsFileLease` 断言(给的超时很短):回收失效时它是**快速而精确**的红
    //    (2s 后抛 FILE_VERSION_CONFLICT),不必等 FILE_WRITE 那 60s 的默认等待 —— 变异跑才跑得完。
    {
      const p = join(projectRoot, "src", "e1-stale-pid.ts");
      writeFileSync(p, "stale-base\n", "utf-8");
      const lockPath = mkLockPath(p);
      writeFileSync(
        lockPath,
        JSON.stringify({ host: hostname(), pid: deadPid, token: "dead-token", createdAt: Date.now() }),
        "utf-8",
      );
      check("前提:已埋下一个死 pid 的陈旧租约", existsSync(lockPath), true);
      let acquired = false;
      try { const rel = await acquireOsFileLease(lockPath, 2_000); acquired = true; await rel(); }
      catch { acquired = false; }
      check("★ E1:死 pid 陈旧租约被回收(2000ms 内取得,未卡到超时)", acquired, true);
      const cleaned = !existsSync(lockPath);
      check("★ E1:回收成功后原陈旧锁已清(不留残骸)", cleaned, true);
      // 端到端:FILE_WRITE 也照常写入 —— 证明"下一个写者 proceeds"。**只在回收成功且锁确实被清时跑**,
      // 否则(回收/释放失效)这里会白等 60s 默认租约超时,把变异跑拖垮;上面已红。
      if (acquired && cleaned) {
        const res = await call(IPC.FILE_WRITE, { filePath: p, content: "RECLAIMED\n" });
        check("★ E1:回收后下一个写者(FILE_WRITE)写入成功", res.ok, true);
        check("★ E1:回收后内容真的落盘", readFileSync(p, "utf-8"), "RECLAIMED\n");
        check("★ E1:写入完成后锁文件已释放", existsSync(lockPath), false);
      }
    }

    // ③b 陈旧租约(非本机 host + 旧时间戳)被回收 → 下一个写者照常写入。
    {
      const p = join(projectRoot, "src", "e1-stale-host.ts");
      writeFileSync(p, "stale-host-base\n", "utf-8");
      const lockPath = mkLockPath(p);
      writeFileSync(
        lockPath,
        JSON.stringify({ host: "some-other-host-not-" + hostname(), pid: 1234, token: "x", createdAt: Date.now() - 10 * 60_000 }),
        "utf-8",
      );
      check("前提:已埋下一个跨机+过期时间戳的陈旧租约", existsSync(lockPath), true);
      let acquired = false;
      try { const rel = await acquireOsFileLease(lockPath, 2_000); acquired = true; await rel(); }
      catch { acquired = false; }
      check("★ E1:跨机过期陈旧租约被回收(2000ms 内取得)", acquired, true);
      const cleaned = !existsSync(lockPath);
      check("★ E1:回收成功后原陈旧锁已清(跨机)", cleaned, true);
      if (acquired && cleaned) {
        const res = await call(IPC.FILE_WRITE, { filePath: p, content: "RECLAIMED-HOST\n" });
        check("★ E1:回收后下一个写者写入成功(跨机)", res.ok, true);
        check("★ E1:回收后内容真的落盘(跨机)", readFileSync(p, "utf-8"), "RECLAIMED-HOST\n");
      }
    }

    // ④ 持有租约时写入失败必须**释放**租约 —— 否则下一个写者会一直阻塞到超时。
    {
      const p = join(projectRoot, "src", "e1-release.ts");
      writeFileSync(p, "hold-base\n", "utf-8");
      const lockPath = mkLockPath(p);
      setFsFault({ failRename: (target) => target === p });
      let failed: { ok?: boolean };
      try {
        failed = await call(IPC.FILE_WRITE, { filePath: p, content: "FIRST-FAILS\n" });
      } finally {
        setFsFault(null);
      }
      check("前提:注入后首发写入确实失败", failed.ok === false, true);
      const released = !existsSync(lockPath);
      check("★ E1:失败者释放了租约(锁文件已不在 → 后续写不被永久阻塞)", released, true);
      // 后续写(无注入)必须成功且**很快**返回(没有等到 60s 租约超时)。只在已释放时跑,免得
      // 释放失效时白等 60s(上面那条已红)。
      if (released) {
        const t0 = Date.now();
        const second = await call(IPC.FILE_WRITE, { filePath: p, content: "SECOND-OK\n" });
        const elapsed = Date.now() - t0;
        check("★ E1:后续写者立刻写入成功(未卡在租约超时)", second.ok, true);
        check("★ E1:后续写者耗时远小于租约等待上限(证明租约已释放)", elapsed < 5_000, true);
        check("★ E1:后续写内容真的落盘", readFileSync(p, "utf-8"), "SECOND-OK\n");
      }
    }

    // ⑤ CAS 失败后,用**当前**版本重试必须成功(文件可读 + 可重写,不是一次冲突就死锁)。
    {
      const p = join(projectRoot, "src", "e1-cas-retry.ts");
      writeFileSync(p, "base\n", "utf-8");
      const v0 = (await readFileGuarded(p)).version;
      const first = await call(IPC.FILE_WRITE, { filePath: p, content: "first\n", expectedVersion: v0 });
      check("前提:首发 CAS 写入成功", first.ok, true);
      const stale = await call(IPC.FILE_WRITE, { filePath: p, content: "should-not-land\n", expectedVersion: v0 });
      check("★ E1:过期版本 CAS 失败(拒绝)", stale.ok === false && stale.conflict === true, true);
      check("★ E1:CAS 失败时磁盘未被覆盖", readFileSync(p, "utf-8"), "first\n");
      // 回读当前版本 → 用它重试 → 必须成功。
      const v1 = (await readFileGuarded(p)).version;
      check("前提:回读拿到的是当前版本(与过期版本不同)", v1 !== v0 && typeof v1 === "string", true);
      const retry = await call(IPC.FILE_WRITE, { filePath: p, content: "second\n", expectedVersion: v1 });
      check("★ E1:CAS 失败后用当前版本重试 → 成功(文件可读+可重写)", retry.ok, true);
      check("★ E1:重试内容真的落盘", readFileSync(p, "utf-8"), "second\n");
    }

    // 清理本段产物,别影响后面「src 只有 1 条」之类断言。
    const e1Files = ["e1-rename.ts", "e1-open.ts", "e1-stale-pid.ts", "e1-stale-host.ts", "e1-release.ts", "e1-cas-retry.ts"];
    for (const n of e1Files) {
      const p = join(projectRoot, "src", n);
      rmSync(p, { force: true });
      // 兜底:任何一例若留下锁文件,一并清掉(下一段断言依赖磁盘干净)。
      rmSync(mkLockPath(p), { force: true });
    }
  }

  /* ── 1c. 【MC-097】写入的乐观并发(CAS)+ 原子替换 ──────────────────────────
   * 从前 FILE_WRITE 只收 `{filePath,content}` 直接 `writeFile`:渲染端读到写之间隔一次 IPC,
   * 另一个 Agent 改了文件也会被静默覆盖;写一半崩溃还会毁原文件。现在带 `expectedVersion`
   * (读到的那版内容哈希)时,主进程在**提交点**比对,不一致就 `{ok:false,conflict:true}`。 */
  console.log("\n【MC-097】写前 CAS + 原子替换");
  {
    const casPath = join(projectRoot, "src", "cas.ts");
    writeFileSync(casPath, "v1\n", "utf-8");
    // 读回版本哈希(readFileGuarded 现在回传)。
    const read1 = await readFileGuarded(casPath);
    check("readFile 回传内容版本哈希", typeof read1.version === "string" && read1.version.length > 0, true);
    // ① 版本正确 → 写得进。
    const okWrite = await call(IPC.FILE_WRITE, { filePath: casPath, content: "v2\n", expectedVersion: read1.version });
    check("★ MC-097:版本匹配 → 写入成功", okWrite.ok, true);
    check("写入内容真的落盘", readFileSync(casPath, "utf-8").trim(), "v2");
    // ② 用**过期**的版本(还是 v1 的哈希)再写 → 冲突拒绝,磁盘不被覆盖。
    const staleWrite = await call(IPC.FILE_WRITE, { filePath: casPath, content: "v3-should-not-land\n", expectedVersion: read1.version });
    check("★ MC-097:版本过期(磁盘已被改)→ 拒绝写入", staleWrite.ok === false && staleWrite.conflict === true, true);
    check("★ MC-097:冲突时磁盘内容保持 v2(没被覆盖)", readFileSync(casPath, "utf-8").trim(), "v2");
    // ③ 不带 expectedVersion → 向后兼容,照写(旧调用方不破)。
    const legacyWrite = await call(IPC.FILE_WRITE, { filePath: casPath, content: "v4\n" });
    check("不带 expectedVersion → 向后兼容照写", legacyWrite.ok && readFileSync(casPath, "utf-8").trim() === "v4", true);
    // ④ 原子替换:目标目录里**不留** `.mcode-tmp` 残留(临时文件写了必被 rename 或清理掉)。
    check("★ MC-097:写入后不留临时文件残留", readdirSync(join(projectRoot, "src")).some((n) => n.includes(".mcode-tmp")), false);
    // ⑤ 读不存在的文件 → version 为 null;新建直接成功。
    const newPath = join(projectRoot, "src", "brand-new.ts");
    const readMissing = await readFileGuarded(newPath);
    check("读不存在的文件 → version 为 null", readMissing.version, null);
    const newWrite = await call(IPC.FILE_WRITE, { filePath: newPath, content: "new\n" });
    check("新建文件成功", newWrite.ok && readFileSync(newPath, "utf-8") === "new\n", true);
    // 清理:这两份文件不能影响后面「listDir 列得出 src 只有 1 条」那类断言。
    rmSync(casPath, { force: true });
    rmSync(newPath, { force: true });
  }

  /* ── 1d. 【MC-097】同路径跨进程写锁:并发写同一路径必须**串行**(互斥,不只是 CAS) ──
   * 提交点 CAS + 原子替换只挡得住「静默覆盖」与「半写」,**不是互斥**:两个拿着同一
   * `expectedVersion` 的写者若都还没落盘就都通过了 CAS,再各自 rename,就会交错。修复把这段
   * 临界区包进**按路径的宿主级文件租约**(`lib/osFileLease.ts`,与 Excel/PDF/DOCX 共用同一份),
   * 同路径串行 → 先到的落盘后,后到的 CAS 重读必看到新版本而冲突。这里直接并发调**真实**
   * FILE_WRITE 处理器验这一点;不同路径必须**互不阻塞**(锁是按路径的,不是全局的)。 */
  console.log("\n【MC-097】同路径并发写互斥 + 不同路径不阻塞");
  {
    // ① 同路径、同一 expectedVersion 的两发并发写 → 恰好一个成功,另一个明确冲突(不静默覆盖)。
    const racePath = join(projectRoot, "src", "race.ts");
    writeFileSync(racePath, "race-v1\n", "utf-8");
    const raceVersion = (await readFileGuarded(racePath)).version;
    // 用一份**够大的内容**拉宽「CAS 通过 → 落盘」的窗口:撤掉租约时两发都更容易在对方落盘前
    // 通过 CAS、双双报成功(变异下可靠转红);有租约时序列化让它不可能。
    const bigA = "A".repeat(2_000_000) + "\n";
    const bigB = "B".repeat(2_000_000) + "\n";
    const [raceA, raceB] = await Promise.allSettled([
      call(IPC.FILE_WRITE, { filePath: racePath, content: bigA, expectedVersion: raceVersion }),
      call(IPC.FILE_WRITE, { filePath: racePath, content: bigB, expectedVersion: raceVersion }),
    ]);
    const a = raceA.status === "fulfilled" ? raceA.value : { ok: false as const };
    const b = raceB.status === "fulfilled" ? raceB.value : { ok: false as const };
    const okCount = [a, b].filter((r) => r.ok === true).length;
    const conflictCount = [a, b].filter((r) => r.ok === false && r.conflict === true).length;
    check("★ MC-097:同路径同版本并发写 → 恰好一个成功(不交错)", okCount, 1);
    check("★ MC-097:另一个明确 conflict(而非静默覆盖)", conflictCount, 1);
    const landed = readFileSync(racePath, "utf-8");
    check(
      "★ MC-097:落盘的是唯一胜者的完整内容(无撕裂/半写)",
      landed === bigA || landed === bigB,
      true,
    );
    rmSync(racePath, { force: true });

    // ② 不同路径并发写 → 两发都必须成功(锁是按路径的,不同路径不互相阻塞)。
    const diffA = join(projectRoot, "src", "diff-a.ts");
    const diffB = join(projectRoot, "src", "diff-b.ts");
    const [da, db] = await Promise.allSettled([
      call(IPC.FILE_WRITE, { filePath: diffA, content: "da\n" }),
      call(IPC.FILE_WRITE, { filePath: diffB, content: "db\n" }),
    ]);
    const dOk = [da, db].every(
      (r) => r.status === "fulfilled" && (r.value as { ok?: boolean }).ok === true,
    );
    check("★ MC-097:不同路径并发写 → 两个都成功(不互相阻塞)", dOk, true);
    check(
      "★ MC-097:两个不同路径各自内容都落盘",
      readFileSync(diffA, "utf-8") === "da\n" && readFileSync(diffB, "utf-8") === "db\n",
      true,
    );
    rmSync(diffA, { force: true });
    rmSync(diffB, { force: true });

    // ③ **真正的跨进程**:两个独立 OS 进程对同一路径、同一 expectedVersion 并发写 →
    //    仍然恰好一个成功、另一个 conflict。进程内锁**给不出**这个结论(两个进程各有一张
    //    Map,互不知情),只有按路径的宿主级文件租约能保证。
    const crossPath = join(projectRoot, "src", "cross-proc.ts");
    writeFileSync(crossPath, "cross-v1\n", "utf-8");
    const crossVersion = (await readFileGuarded(crossPath)).version as string;
    const [pa, pb] = await Promise.all([
      spawnWrite(crossPath, "A", 2_000_000, crossVersion),
      spawnWrite(crossPath, "B", 2_000_000, crossVersion),
    ]);
    const crossOk = [pa, pb].filter((r) => r.ok === true).length;
    const crossConflict = [pa, pb].filter((r) => r.ok === false && r.conflict === true).length;
    check("★ MC-097:两个独立 OS 进程同版本并发写 → 恰好一个成功", crossOk, 1);
    check("★ MC-097:另一个明确 conflict(跨进程互斥生效)", crossConflict, 1);
    const crossLanded = readFileSync(crossPath, "utf-8");
    check(
      "★ MC-097:跨进程落盘的是唯一胜者的完整内容(非撕裂)",
      crossLanded === "A".repeat(2_000_000) + "\n" || crossLanded === "B".repeat(2_000_000) + "\n",
      true,
    );
    rmSync(crossPath, { force: true });
  }

  /* ── 1e. 【MC-097】真·另一个 OS 进程对**同一把租约**的互斥 —— 以及**真进程被杀**后的恢复 ────
   * 这一段是复核缺口的核心:租约是**宿主级 OS 文件租约**,它的全部意义就是**跨进程**生效,
   * 而此前没有任何断言真的起过第二个进程去抢同一把锁。这里:
   *  ① 父进程先持锁;起一个**真独立 node 进程**去抢**同一** lock 路径 → 必须**被拒**
   *     (不是「它成功了」,也不是父进程进程内 Map 的复印件在自说自话);
   *  ② 父进程释放后再让该真进程抢 → 必须**抢得到**(证明上面那次被拒是锁本身,不是它坏了);
   *  ③ 让真进程抢到锁后**被真 SIGKILL**(child.kill("SIGKILL"),父进程收到 SIGKILL 退出、
   *     `process.kill(pid,0)` 判死)——锁文件因进程猝死**留在盘上**;断言下一个写者能靠
   *     陈旧租约回收照常写入,并**回读**正确内容(证明崩溃没毁数据、也没永久卡死)。 */
  console.log("\n【MC-097】真独立进程对同一租约的互斥 + 真 SIGKILL 后的恢复");
  {
    const leaseFile = join(projectRoot, "src", "lease-cross-proc.ts");
    writeFileSync(leaseFile, "lease-base-v1\n", "utf-8");
    const lockPath = lockPathFor(leaseFile);

    // ① 父进程(本进程)持锁;真独立进程抢同一 lock → 被拒。
    {
      const releaseParent = await acquireOsFileLease(lockPath, 2_000);
      check("前提:父进程已持有租约(锁文件在盘上)", existsSync(lockPath), true);
      const refused = await spawnLeaseOnce(lockPath, 1_500);
      check("★ MC-097:真独立进程在父进程持锁时抢同一租约 → 被拒(acquired=false)", refused.acquired, false);
      check(
        "★ MC-097:拒绝理由是租约冲突(不是别的手滑)",
        typeof refused.error === "string" && refused.error.includes("FILE_VERSION_CONFLICT"),
        true,
      );
      await releaseParent();
      check("★ MC-097:父进程释放后锁文件已清", existsSync(lockPath), false);

      // ② 释放后,同一个真独立进程再抢 → 必须抢得到(证明上面不是「锁坏了/进程起不来」)。
      const allowed = await spawnLeaseOnce(lockPath, 2_000);
      check("★ MC-097:父进程释放后真独立进程能抢到租约(acquired=true)", allowed.acquired, true);
      check("对照:该真进程用完立刻释放,锁文件已清", existsSync(lockPath), false);
    }

    // ③ 真进程抢到锁后被**真 SIGKILL** → 锁残留在盘上 → 下一个写者靠陈旧回收照常写入并回读。
    {
      const holder = await spawnLeaseHolder(lockPath);
      try {
        check("前提:真独立进程抢到租约并持有(pid 有效)", holder.acquired && holder.pid > 0, true);
        check("前提:租约锁文件此刻在盘上(由该进程持有)", existsSync(lockPath), true);

        // 真·SIGKILL(不是让它优雅退出)。Windows 上 child.kill("SIGKILL") 走 TerminateProcess,
        // 实测父进程退出后 `process.kill(pid,0)` 立即 ESRCH —— 与生产判活同一判据。
        holder.child.kill("SIGKILL");
        const dead = await waitChildDead(holder.pid, 8_000);
        check("★ MC-097:被 SIGKILL 的真进程确已死亡(process.kill(pid,0) → ESRCH)", dead, true);
        check("★ MC-097:SIGKILL 后锁文件仍残留在盘上(进程没来得及释放)", existsSync(lockPath), true);

        // 死 pid 的陈旧租约必须被**快速**回收(用 2000ms 短超时精确断言;回收失效时这里是
        // 快而准的红,不必等 FILE_WRITE 那 60s 默认等待 —— 变异跑才跑得完)。
        let reclaimed = false;
        try { const rel = await acquireOsFileLease(lockPath, 2_000); reclaimed = true; await rel(); }
        catch { reclaimed = false; }
        check("★ MC-097:SIGKILL 留下的死 pid 陈旧租约被回收(2000ms 内取得,未卡到超时)", reclaimed, true);
        const cleaned = !existsSync(lockPath);
        check("★ MC-097:回收成功后 SIGKILL 残留锁已清", cleaned, true);

        // 端到端:下一个写者(FILE_WRITE)照常写入 + 回读证明崩溃没毁数据、也没永久卡死。
        // **只在回收成功且锁确实被清时跑**,否则(回收失效)会白等 60s 默认超时把变异跑拖垮;上面已红。
        if (reclaimed && cleaned) {
          const t0 = Date.now();
          const res = await call(IPC.FILE_WRITE, { filePath: leaseFile, content: "after-sigkill-v2\n" });
          const elapsed = Date.now() - t0;
          check("★ MC-097:持有者被 SIGKILL 后,下一个写者(FILE_WRITE)照常写入(陈旧租约被回收)", res.ok, true);
          check("★ MC-097:回收+写入耗时远小于 60s 租约等待上限(没被死进程永久卡住)", elapsed < 10_000, true);
          check("★ MC-097:回读证明崩溃后被写者内容正确落盘", readFileSync(leaseFile, "utf-8"), "after-sigkill-v2\n");
          check("★ MC-097:写入完成锁文件已释放", existsSync(lockPath), false);
        }
      } finally {
        // 任何意外路径都别再留一个活着的子进程(那正是本条目担心的一类抖动)。
        holder.child.kill("SIGKILL");
        rmSync(leaseFile, { force: true });
        rmSync(lockPath, { force: true });
      }
    }
  }

  /* ── 2. 越界仍然要挡住(所有平台) ──────────────────────────────────────── */
  console.log("\n越界仍然要挡住");
  const outside = join(base, "outside.ts");
  writeFileSync(outside, "secret\n", "utf-8");
  check("项目根之外的文件读不到", (await readFileGuarded(outside)).content, "");
  check("项目根之外的文件写不进", (await call(IPC.FILE_WRITE, { filePath: outside, content: "x" })).ok, false);
  check("越界写被挡住后原文件没被改", readFileSync(outside, "utf-8").trim(), "secret");
  const sibling = `${projectRoot}-other`;
  mkdirSync(sibling, { recursive: true });
  check("同名前缀的兄弟目录不算在根里", (await listDirGuarded(sibling, ".")).entries.length, 0);

  /* ── 3. 同一条路径,两道闸必须给出同一个结论 ──────────────────────────── */
  console.log("\n大小写:外层闸认下的路径,内层闸不能反过来判它越界");
  if (!CASE_INSENSITIVE) {
    console.log(`  skip  当前文件系统大小写敏感(${process.platform}),这一组不适用 —— 未执行,不计入通过数`);
  } else {
    const variantFile = caseVariant(renamedExact);
    check("前提:换个大小写写法指的是同一个文件", existsSync(variantFile), true);
    // 外层闸(共享 pathGuard)认下它 —— readFile 走的就是外层闸。
    check("外层闸认下这条路径:readFile 读得到", (await readFileGuarded(variantFile)).content.includes("export const a"), true);
    check("listDir 也认(projectPath 与 dirPath 同一份写法)", (await listDirGuarded(caseVariant(projectRoot), "src")).entries.length, 1);

    warnings.length = 0;
    const wrote = await call(IPC.FILE_WRITE, { filePath: variantFile, content: "export const a = 3;\n" });
    check("writeFile:同一条路径外层认下了,就不能被内层判越界", wrote.ok, true);
    check("writeFile:内容真的落到了盘上", readFileSync(renamedExact, "utf-8").trim(), "export const a = 3;");
    check("writeFile:没有 escapes root 的越界日志", warnings.filter((w) => w.includes("escapes root")).length, 0);

    warnings.length = 0;
    const variantNew = caseVariant(join(projectRoot, "src", "renamed2.ts"));
    const renamed = await call(IPC.FILE_RENAME, { oldPath: variantFile, newPath: variantNew });
    check("rename:同一条路径外层认下了,就不能被内层判越界", renamed.ok, true);
    check("rename:文件真的改了名", existsSync(join(projectRoot, "src", "renamed2.ts")), true);
    check("rename:没有 escapes root 的越界日志", warnings.filter((w) => w.includes("escapes root")).length, 0);

    // ★ **只改大小写的重命名必须放行。** 那道"目标已存在"守卫 `access(newPath)` 在大小写
    //   不敏感的文件系统上解析到**源文件自己** —— 于是 `readme.md` → `README.md` 这种常见
    //   操作永远失败。渲染端本来就允许(它把条目自身从冲突检查里排除),两处判据得对得上。
    {
      const mixed = join(projectRoot, "src", "CaseOnly.ts");
      writeFileSync(mixed, "export const c = 1;\n", "utf-8");
      const upper = join(projectRoot, "src", "CASEONLY.ts");
      check("前提:两个大小写写法指的是同一个文件", existsSync(upper), true);
      const res = await call(IPC.FILE_RENAME, { oldPath: mixed, newPath: upper });
      check("★ 只改大小写的重命名被放行(不再误报「目标已存在」)", res.ok, true);
    }
  }

  /* ── 4. 空查询的 file.grep 不能把主进程钉死 ───────────────────────────── */
  // 高亮循环用 indexOf(needle, from):needle === "" 时恒返回 from、from 原地踏步,
  // 内层 for(;;) 无限 push → 主进程 OOM。rg 快路径会掩盖它,但没 rg 的机器/起不来时会
  // 走这段 JS,而 agent 那条 app_api_call 直达 handler(渲染端才挡空串)。
  // 判据:必须**立刻**返回空结果;用超时兜底 —— 真钉死了这里会红而不是把套件挂住。
  console.log("\n空查询的 grep 立即返回,不进入无限高亮循环");
  {
    const raced = await Promise.race([
      call(IPC.FILE_GREP, { projectPath: projectRoot, query: "" }) as Promise<{ matches?: unknown[] }>,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    check("★ 空查询不挂起(2 秒内返回)", raced !== "timeout", true);
    check("★ 空查询返回空匹配集", raced === "timeout" ? "挂起" : (raced.matches?.length ?? -1), 0);
    // 对照:非空查询照常工作(证明上面那条红不是"handler 整个坏了")。
    const hit = (await call(IPC.FILE_GREP, { projectPath: projectRoot, query: "export" })) as { matches?: unknown[] };
    check("对照:非空查询照常命中", (hit.matches?.length ?? 0) > 0, true);
  }

  console.log(`\nmaint-m07-smoke: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) { console.error(`maint-m07-smoke: ${failures} FAILED`); process.exitCode = 1; }
} finally {
  rmSync(base, { recursive: true, force: true });
}

