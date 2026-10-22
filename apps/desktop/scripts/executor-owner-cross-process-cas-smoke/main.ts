/**
 * executor-owner-cross-process-cas-smoke —— 【T4】工作流 owner 跨进程 CAS。
 *
 * 缺陷(旧行为,已用真实双进程复现):`FileExecutorOwnershipStore` 的 insert/remove
 * 与**启动对账**都以本实例内存 Map 为准整表覆盖写盘。两个 OS 进程各自持有旧快照时,
 * 后写者把先写者的记录整表抹掉,而**两个进程都返回成功**。
 *
 * 本套件全部用 `mktemp` 临时目录,起**真实 OS 子进程**(`child-owner.ts`),走生产同一份
 * `FileExecutorOwnershipStore`,不用两个对象的同进程交替冒充并发:
 *   A. 两个真进程竞争同一 flowId → 至多一个 insert 成功,磁盘一条记录;
 *   B. 两个真进程插不同 flowId → 两个都成功,磁盘两条记录(不丢更新);
 *   C. 启动对账与并发 insert 相撞 → 新记录不被启动写覆盖;
 *   D. 持有租约的进程被 SIGKILL → 下一个进程能回收死进程的锁并继续(崩溃恢复);
 *   E. 崩溃留下的 owner 记录可由新进程按 owner 身份释放并交接(登记权限不被死进程永久锁死);
 *   F. 写盘中途崩溃留下的 `.mcode-tmp` 碎片被忽略,owner 文件仍完整可读;
 *   G. 运行中文件损坏 → insert 抛错 fail-closed,磁盘字节不动;
 *   H. 启动时文件损坏 → 原档逐字节保留、blocked、mcode 登记被拒、node-red 恢复登记可用;
 *   I. 同进程两个 store 实例互不丢记录;
 *   J. 同步租约与异步 `osFileLease` 是**同一把锁**(两个方向都互斥)。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FileExecutorOwnershipStore, OWNERSHIP_FILE } from "@main/workflowEngines/fileExecutorOwnershipStore.js";
import { acquireOsFileLease } from "@main/lib/osFileLease.js";

let total = 0, failed = 0;
function check(name: string, ok: boolean, info?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + " — " + JSON.stringify(info)); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const entry = process.env["MCODE_T4_CHILD_ENTRY"];
if (!entry || !existsSync(entry)) throw new Error("缺少 child-owner 入口(应经 run.sh 设置):" + entry);
const root = mkdtempSync(join(tmpdir(), "mcode-t4-owner-cas-"));
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

type ChildReply = { result?: boolean; records?: Array<{ flowId: string; owner: string }>; error?: string };

function spawnChild(args: string[]): { child: ReturnType<typeof spawn>; done: Promise<ChildReply>; firstLine: Promise<string> } {
  const child = spawn(process.execPath, [entry!, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", errOut = "";
  let resolveFirst: ((line: string) => void) | undefined;
  const firstLine = new Promise<string>((resolve) => { resolveFirst = resolve; });
  child.stdout!.on("data", (chunk: Buffer) => {
    const previous = out;
    out += chunk.toString("utf8");
    // "ready" 行在长时间自旋之前输出；只在它**完整到达**时兑现一次。
    if (resolveFirst !== undefined && !previous.includes("\n") && out.includes("\n")) {
      const line = out.split(/\r?\n/)[0] ?? "";
      resolveFirst(line);
      resolveFirst = undefined;
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { errOut += chunk.toString("utf8"); });
  const done = new Promise<ChildReply>((resolve) => {
    child.once("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try { resolve(JSON.parse(line) as ChildReply); }
      catch { resolve({ result: false, error: `不可解析输出 stdout=${out.trim()} stderr=${errOut.trim().slice(-800)}` }); }
    });
  });
  return { child, done, firstLine };
}

function readDisk(dir: string): Array<{ flowId: string; owner: string }> {
  return (JSON.parse(readFileSync(join(dir, OWNERSHIP_FILE), "utf8")) as { records: Array<{ flowId: string; owner: string }> }).records;
}
const freshDir = (name: string): string => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return dir; };
const ownPath = (dir: string): string => join(dir, OWNERSHIP_FILE);

try {
  // ══════════ A. 两个真实 OS 进程竞争同一 flowId ══════════
  for (let round = 1; round <= 5; round++) {
    const dir = freshDir("same-" + round);
    const at = Date.now() + 800;
    const a = spawnChild(["boot-then-insert", dir, "flow-race", "mcode", String(at)]);
    const b = spawnChild(["boot-then-insert", dir, "flow-race", "node-red", String(at)]);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const disk = readDisk(dir);
    check(`★A 第${round}轮:两个真进程竞争同一 flowId,只有一个 insert 成功`,
      ra.result === true !== (rb.result === true), { a: ra, b: rb });
    eq(`★A 第${round}轮:磁盘上该 flowId 只有一条记录`, disk.filter((r) => r.flowId === "flow-race").length, 1);
    eq(`★A 第${round}轮:磁盘记录数恰好为 1`, disk.length, 1);
    const winner = ra.result === true ? ra.records : rb.records;
    check(`★A 第${round}轮:成功方读取到的 owner 与磁盘一致`,
      winner?.length === 1 && disk[0]?.owner === winner[0]?.owner, { winner, disk });
  }

  // ══════════ B. 两个真进程并发插不同 flowId —— 不丢更新 ══════════
  for (let round = 1; round <= 3; round++) {
    const dir = freshDir("diff-" + round);
    const at = Date.now() + 800;
    const a = spawnChild(["boot-then-insert", dir, "flow-a", "mcode", String(at)]);
    const b = spawnChild(["boot-then-insert", dir, "flow-b", "node-red", String(at)]);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const disk = readDisk(dir);
    check(`B 第${round}轮:不同 flowId 的两个并发 insert 都成功`, ra.result === true && rb.result === true, { a: ra, b: rb });
    check(`B 第${round}轮:两条记录都在磁盘上(无整表覆盖)`,
      disk.some((r) => r.flowId === "flow-a" && r.owner === "mcode") &&
      disk.some((r) => r.flowId === "flow-b" && r.owner === "node-red"), disk);
  }

  // ══════════ C. 启动对账(构造时的读-改-写)与并发 insert 相撞 ══════════
  for (let round = 1; round <= 3; round++) {
    const dir = freshDir("boot-" + round);
    writeFileSync(join(dir, "flows.json"), JSON.stringify([{ id: "tab1", type: "tab", "x-mcode": { docId: "native-flow" } }]), "utf8");
    const at = Date.now() + 800;
    const insert = spawnChild(["insert", dir, "late-flow", "mcode", String(at)]);
    // 另一个进程恰在同一时刻构造:启动对账会写 native owner;它不得抹掉 late-flow。
    const boot = spawnChild(["delayed-boot", dir, "", "", "0", String(at)]);
    const [ri, rb] = await Promise.all([insert.done, boot.done]);
    const disk = readDisk(dir).map((r) => r.flowId + ":" + r.owner);
    check(`C 第${round}轮:并发 insert 成功`, ri.result === true, ri);
    check(`C 第${round}轮:启动对账没有覆盖并发写入的 late-flow`, disk.includes("late-flow:mcode"), disk);
    check(`C 第${round}轮:启动对账恢复的 native-flow 也在`, disk.includes("native-flow:node-red"), disk);
    check(`C 第${round}轮:delayed-boot 进程正常结束`, rb.error === undefined, rb);
  }

  // ══════════ D. 进程持有租约时被 SIGKILL —— 死进程的锁必须能被回收 ══════════
  {
    const dir = freshDir("killed-holder");
    const holder = spawnChild(["hold-lease-until-killed", dir, OWNERSHIP_FILE]);
    const ready = JSON.parse(await holder.firstLine) as { ready?: boolean; pid?: number };
    check("D 崩溃注入:子进程确实拿到了生产同一把租约", ready.ready === true, ready);
    const lockPath = ownPath(dir) + ".mcode-lock";
    check("D 崩溃注入:锁文件在盘上", existsSync(lockPath));
    holder.child.kill();
    await holder.done;
    check("D 崩溃注入:被杀后锁文件仍留在盘上(模拟崩溃)", existsSync(lockPath));
    const deadPid = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    eq("D 崩溃注入:锁里记的是被杀进程的 pid", deadPid.pid, ready.pid);
    const survivor = spawnChild(["insert", dir, "after-crash", "mcode"]);
    const rs = await survivor.done;
    check("★D 崩溃恢复:下一个进程回收死 pid 的锁并成功登记", rs.result === true, rs);
    check("★D 崩溃恢复:成功后锁文件已被释放", !existsSync(lockPath));
    eq("★D 崩溃恢复:磁盘上留下了新登记", readDisk(dir).filter((r) => r.flowId === "after-crash").length, 1);
  }

  // ══════════ E. 崩溃后 stale owner 的交接(登记不是租约,不能自动抢占) ══════════
  {
    const dir = freshDir("stale-owner");
    const first = spawnChild(["insert", dir, "orphan-flow", "mcode"]);
    check("E 前置:进程 1 登记 orphan-flow=mcode 后直接退出(等价崩溃,无 release)", (await first.done).result === true);
    // 新进程启动:必须看见这条持久登记(T10 的重启保证),不能当没发生过。
    const restarted = new FileExecutorOwnershipStore(dir);
    eq("E 重启后 stale owner 仍在(持久登记不因进程退出丢失)", restarted.get("orphan-flow")?.owner, "mcode");
    // 同一 owner 身份在新进程里可以显式释放——"另一个进程能接管清理"。
    eq("★E 新进程按 owner 身份释放崩溃进程留下的登记", restarted.remove("orphan-flow", "mcode"), true);
    eq("E 释放后 node-red 可以合法接管", restarted.insert({ flowId: "orphan-flow", owner: "node-red", reason: "takeover" }), true);
    eq("E 磁盘上 owner 已交接", readDisk(dir).find((r) => r.flowId === "orphan-flow")?.owner, "node-red");
    eq("E 非当前 owner 不能释放", restarted.remove("orphan-flow", "mcode"), false);
  }

  // ══════════ F. 写盘中途崩溃:遗留 .mcode-tmp 碎片被忽略,原档完整 ══════════
  {
    const dir = freshDir("write-crash");
    const store = new FileExecutorOwnershipStore(dir);
    check("F 前置:登记 before-crash", store.insert({ flowId: "before-crash", owner: "mcode" }));
    const beforeBytes = readFileSync(ownPath(dir), "utf8");
    // 模拟崩溃在 atomicReplaceFileSync 的 temp 阶段:同目录留下一个半截临时文件。
    const debris = ownPath(dir) + ".0123abcd-dead-beef-0000-000000000000.mcode-tmp";
    writeFileSync(debris, "{\"version\":1,\"records\":[{\"flowId\":\"half", "utf8");
    const restarted = new FileExecutorOwnershipStore(dir);
    eq("★F 崩溃碎片不影响启动读取", restarted.get("before-crash")?.owner, "mcode");
    check("★F 新登记照常成功", restarted.insert({ flowId: "after-crash-write", owner: "node-red" }));
    eq("F 崩溃碎片仍在但被忽略", existsSync(debris), true);
    check("F 原记录未被碎片污染", readDisk(dir).some((r) => r.flowId === "before-crash" && r.owner === "mcode"));
    check("F 文件在崩溃前后都是合法 JSON", JSON.parse(beforeBytes) !== null);
  }

  // ══════════ G. 运行中文件损坏 → fail-closed,磁盘字节不动 ══════════
  {
    const dir = freshDir("corrupt-live");
    const store = new FileExecutorOwnershipStore(dir);
    check("G 前置:store 正常启动", store.insert({ flowId: "g-ok", owner: "mcode" }));
    const broken = "{not-owner-json";
    writeFileSync(ownPath(dir), broken, "utf8");
    let thrown: unknown;
    try { store.insert({ flowId: "g-new", owner: "node-red" }); } catch (err) { thrown = err; }
    check("★G 运行中损坏:insert 抛错而不是静默重建", thrown instanceof Error, String(thrown));
    eq("★G 运行中损坏:磁盘字节原样保留", readFileSync(ownPath(dir), "utf8"), broken);
    eq("★G 运行中损坏:内存没有凭空多出记录", store.get("g-new"), null);
    let removed: unknown;
    try { store.remove("g-ok", "mcode"); } catch (err) { removed = err; }
    check("★G 运行中损坏:remove 同样 fail-closed", removed instanceof Error, String(removed));
  }

  // ══════════ H. 启动时文件损坏 → T10 档保 + 阻断旧 runner,node-red 恢复可用 ══════════
  {
    const dir = freshDir("corrupt-boot");
    const broken = "{corrupt-at-boot";
    writeFileSync(ownPath(dir), broken, "utf8");
    writeFileSync(join(dir, "flows.json"), JSON.stringify([{ id: "tab1", type: "tab", "x-mcode": { docId: "native-h" } }]), "utf8");
    const store = new FileExecutorOwnershipStore(dir);
    const archived = readdirSync(dir).filter((f) => f.startsWith(OWNERSHIP_FILE + ".corrupt-"));
    check("H 启动损坏:原档逐字节保留为 .corrupt-*", archived.some((f) => readFileSync(join(dir, f), "utf8") === broken), archived);
    check("H 启动损坏:legacyBlocked 生效", store.diagnostics().legacyBlocked === true);
    eq("H 启动损坏:从 flows.json 恢复 native owner", store.get("native-h")?.owner, "node-red");
    let thrown: unknown;
    try { store.insert({ flowId: "h-mcode", owner: "mcode" }); } catch (err) { thrown = err; }
    check("★H 启动损坏:mcode 登记被拒(fail-closed)", thrown instanceof Error, String(thrown));
    eq("H 启动损坏:node-red 恢复登记仍可用", store.insert({ flowId: "h-native-2", owner: "node-red" }), true);
    check("H 启动损坏:重写后的文件是合法 JSON 且保留 blocked 标记",
      (JSON.parse(readFileSync(ownPath(dir), "utf8")) as { legacyBlocked?: boolean }).legacyBlocked === true);
  }

  // ══════════ I. 同进程两个 store 实例互不丢记录 ══════════
  // 注意契约:`get()`/`list()` 只读本实例内存(T10 热路径不读盘),所以先构造的实例
  // 看不到后发生的写入是**设计如此**;要守住的是**写路径每次先读盘**,不整表覆盖。
  {
    const dir = freshDir("in-process");
    const a = new FileExecutorOwnershipStore(dir);
    const b = new FileExecutorOwnershipStore(dir);
    check("I 实例 A 先登记", a.insert({ flowId: "i-a", owner: "mcode" }));
    check("I 实例 B 登记另一条(随后构造前已过期的快照)", b.insert({ flowId: "i-b", owner: "node-red" }));
    check("★I 先构造的实例 A 再写时先读盘,不覆盖 B 的记录", a.insert({ flowId: "i-c", owner: "mcode" }));
    eq("★I 磁盘上三条记录都在", readDisk(dir).length, 3);
    check("I 同 flow 在另一实例上重复登记仍被拒", b.insert({ flowId: "i-a", owner: "mcode" }) === false);
    eq("★I 被拒的重复登记没有把 B 的旧快照写回磁盘(仍三条)", readDisk(dir).length, 3);
    // 写路径会刷新本实例内存:做完上面那次写入后,B 的 get 应已看到全部记录。
    check("★I 写入后实例 B 的内存已按磁盘刷新", b.get("i-a")?.owner === "mcode" && b.get("i-c")?.owner === "mcode");
  }

  // ══════════ J. 同步租约与异步 osFileLease 是同一把锁 ══════════
  // 同一线程里同步持有后不能再 await 异步抢锁(会死等),所以用两个真 OS 进程各自持锁,
  // 父进程只观察:同步子进程持锁期间,父进程(异步租约)必须冲突;释放后立即可抢。
  {
    const dir = freshDir("same-lock");
    const target = join(dir, "shared-target.txt");
    writeFileSync(target, "x", "utf8");
    const lockPath = target + ".mcode-lock";
    const holder = spawnChild(["hold-lease-until-killed", dir, "shared-target.txt"]);
    const ready = JSON.parse(await holder.firstLine) as { ready?: boolean };
    check("J 前置:子进程用**同步**租约持有 shared-target", ready.ready === true && existsSync(lockPath), ready);
    let asyncConflict = false;
    try { const release = await acquireOsFileLease(lockPath, 300); await release(); }
    catch (err) { asyncConflict = /FILE_VERSION_CONFLICT/.test(String(err)); }
    check("★J 同步租约持有时,父进程的异步租约冲突 —— 同一个 .mcode-lock", asyncConflict);
    holder.child.kill();
    await holder.done;
    // 同步持有者是**已死进程**:异步租约必须能回收它并成功。
    const release = await acquireOsFileLease(lockPath, 2_000);
    check("★J 同步持有者死亡后,异步租约按同一套死活判据回收并成功", true);
    await release();
  }
} finally {
  console.log(`executor-owner-cross-process-cas-smoke: ${total - failed}/${total} 通过`);
  if (failed !== 0) process.exitCode = 1;
}
