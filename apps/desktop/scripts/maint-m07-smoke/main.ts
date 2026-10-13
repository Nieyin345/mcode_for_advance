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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawn } from "node:child_process";
import { IPC } from "@contracts/ipc";
import { listDirGuarded, readFileGuarded, registerFileHandlers } from "@main/ipc/files.js";
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

  /* ── 1b. 【MC-097】写入的乐观并发(CAS)+ 原子替换 ──────────────────────────
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

  /* ── 1c. 【MC-097】同路径跨进程写锁:并发写同一路径必须**串行**(互斥,不只是 CAS) ──
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

