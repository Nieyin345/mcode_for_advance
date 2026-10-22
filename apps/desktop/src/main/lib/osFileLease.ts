/**
 * 【MC-069 / MC-097】**宿主级按路径文件租约** —— 唯一一份。
 *
 * 进程内的一张 `Map`(`mcp/agentTextFiles.ts` 的 `withTextFileLock`)只对**本进程**排队:
 * 两个独立 Mcode 进程(或一个 Mcode + 一个外部编辑器)各自从同一版本读取、各自通过
 * 自己进程内的锁,再分别替换整个文件,照样丢更新。这里用磁盘上一个**独占创建**的锁文件
 * 把互斥抬到**宿主级**,让两个 OS 进程也串行;同一个进程内的并发 async 同样被它串行
 * (租约由「文件存在」表示,同进程第二次 `open(wx)` 一样撞 `EEXIST`)。
 *
 * ## 为什么收口在这里
 *
 * 这份逻辑原先**只**长在 `mcp/agentDocumentOps.ts` 里(Excel/PDF/DOCX 用),是私有的。
 * `ipc/files.ts` 的 `FILE_WRITE`(Markdown/源码保存)同样需要「同路径跨进程互斥」,
 * 但**不能**另起第二套锁 —— 那正是仓库明令禁止的「两份并存的实现」。于是把它搬到
 * `lib/`,两侧共用同一份(`agentDocumentOps.ts` 的 `withDocumentFileLease` 与
 * `files.ts` 的 `FILE_WRITE` 都在调它)。**不发明第二层锁**。
 *
 * ## 原语
 *
 * `fs.writeFile(lockPath, _, { flag: "wx" })` = `O_CREAT|O_EXCL`,内核保证同路径只有一个
 * 能创建成功;抢到的把 `{host,pid,token,createdAt}` 写进去并**持有**(不持有 fd)到本次
 * 操作结束。抢不到的读取现有锁:若持有者是**本机已死进程**(`process.kill(pid,0)` 抛
 * `ESRCH`)或锁**过期**(超过 `LEASE_STALE_MS` —— 防 pid 复用/跨机),判定为陈旧并回收重抢;
 * 否则短抖动重试到超时,超时抛 `FILE_VERSION_CONFLICT`(调用方据此报冲突,不静默覆盖)。
 *
 * 落盘事实可被第三方进程观测 —— 这不是「进程内 Map 的复印件」。
 *
 * ## 同步孪生(T4)
 *
 * 一些调用方的契约是**同步**的(`workflowEngines/fileExecutorOwnershipStore.ts` 的
 * `ExecutorOwnershipStore` CAS 不能在 `await` 中让出)。它们**不能**另造一套锁 —— 于是
 * 同步版 {@link withOsFileLeaseSync} 也住在**本文件**:同一个 `.mcode-lock` 命名、同一份
 * 记录格式、同一套死活/过期判据,异步租约与同步租约互相排斥。差异只有等待方式
 * (`Atomics.wait` 阻塞 vs 让出事件循环)与默认等待上限,见其文档。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { closeSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const LEASE_STALE_MS = 120_000;
const LEASE_WAIT_MS = 60_000;
/** 同步孪生(见 {@link withOsFileLeaseSync})的默认等待上限:同步版本阻塞调用线程,
 *  不能像异步版那样等 60s。临界区是毫秒级,5s 只用于兜住调度抖动。 */
const LEASE_SYNC_WAIT_MS = 5_000;
/** 锁文件已存在但读不出合法 JSON 时,按 mtime 判「正被另一进程创建中(新鲜)→ 退让」
 *  还是「写崩了(陈旧)→ 回收」。 */
const LEASE_FRESH_GRACE_MS = 5_000;

interface LeaseRecord { host: string; pid: number; token: string; createdAt: number; }

function isCompleteLeaseRecord(value: unknown): value is LeaseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Partial<LeaseRecord>;
  return typeof rec.host === "string" && rec.host.length > 0
    && typeof rec.pid === "number" && Number.isSafeInteger(rec.pid) && rec.pid > 0
    && typeof rec.token === "string" && rec.token.trim().length > 0
    && typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) && rec.createdAt > 0;
}

function leaseOwnerAlive(rec: LeaseRecord): boolean {
  if (rec.host !== hostname()) return Date.now() - rec.createdAt < LEASE_STALE_MS;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function tryAcquireOsLease(lockPath: string, token: string): Promise<boolean> {
  const rec: LeaseRecord = { host: hostname(), pid: process.pid, token, createdAt: Date.now() };
  try {
    // `wx` = O_CREAT|O_EXCL:同路径只有一个进程能创建成功。**不持有 fd** —— 租约由「文件存在」表示。
    await fs.writeFile(lockPath, JSON.stringify(rec), { flag: "wx", encoding: "utf8" });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  // 已存在:读现有锁判断持有者死活。**注意** `wx` 建文件与写入内容之间有一瞬空窗,
  // 另一进程此刻读到的可能是**空/半截**内容 —— 绝不能就此判「陈旧」去删活锁(那等于没有锁),
  // 见 doc-ops-smoke 里两独立进程用例暴露的抢锁竞态。
  const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
  let existing: unknown;
  try { existing = JSON.parse(raw) as unknown; } catch { existing = null; }
  if (isCompleteLeaseRecord(existing)) {
    if (!leaseOwnerAlive(existing)) await fs.rm(lockPath, { force: true }).catch(() => undefined);
    return false;
  }
  // 内容还不完整:按 mtime 新鲜度判 —— 新鲜(另一进程正写)→ 退让;陈旧(写到一半崩了)→ 回收。
  const st = await fs.stat(lockPath).catch(() => null);
  if (st && Date.now() - st.mtimeMs > LEASE_FRESH_GRACE_MS) {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
  return false;
}

/** 抢一把磁盘锁;返回**释放函数**(只删本 token 持有且仍属本 token 的那份锁)。 */
export async function acquireOsFileLease(lockPath: string, waitMs = LEASE_WAIT_MS): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    if (await tryAcquireOsLease(lockPath, token)) {
      return async () => {
        // 只删**本 token 持有**的那份锁 —— 别把回收后又抢到锁的第三方误删。
        const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
        try {
          if ((JSON.parse(raw) as LeaseRecord).token === token) await fs.rm(lockPath, { force: true });
        } catch { /* 已被回收/替换:不动 */ }
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `FILE_VERSION_CONFLICT:文件正被另一个进程编辑(跨进程文件租约未在 ${waitMs}ms 内取得),拒绝并发覆盖:${lockPath}；请稍后重试`,
      );
    }
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
  }
}

/**
 * 把一段**读-改-写**(或校验-写)整体放进「按真实路径的宿主级文件租约」内。
 *
 * `action` 收到的是**真实路径**(`realpath` 解析后;文件不存在时回落到 `path.resolve`),
 * 锁文件即 `${real}.mcode-lock` —— **不同路径得到不同锁文件**,天然互不阻塞;同一路径
 * (含大小写不同的写法,因 `realpath` 归一)串行。
 *
 * 释放放在 `finally`,无论 `action` 抛错还是正常返回都释放;`action` 的错误照常向上抛,
 * 不吞。
 */
export async function withOsFileLease<T>(
  file: string,
  action: (real: string) => Promise<T>,
): Promise<T> {
  const resolved = path.resolve(file);
  const real = await fs.realpath(resolved).catch(() => resolved);
  const release = await acquireOsFileLease(`${real}.mcode-lock`);
  try {
    return await action(real);
  } finally {
    await release().catch(() => undefined);
  }
}

/** 同步等待:阻塞调用线程若干毫秒。与异步版的 `setTimeout` 不同 —— 同步调用方
 *  (如 `ExecutorOwnershipStore` 的同步 CAS 契约)不能让出事件循环。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function tryAcquireOsLeaseSync(lockPath: string, token: string): boolean {
  const rec: LeaseRecord = { host: hostname(), pid: process.pid, token, createdAt: Date.now() };
  try {
    // 与异步版同一个原语:`wx` = O_CREAT|O_EXCL,内核保证同路径只有一个进程创建成功。
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(rec));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  // 已存在:与异步版同一套「持有者死活 / 陈旧回收 / 半截内容按 mtime 判」的判据。
  let raw = "";
  try { raw = readFileSync(lockPath, "utf8"); } catch { /* 刚被释放 */ }
  let existing: unknown;
  try { existing = JSON.parse(raw) as unknown; } catch { existing = null; }
  if (isCompleteLeaseRecord(existing)) {
    if (!leaseOwnerAlive(existing)) { try { rmSync(lockPath, { force: true }); } catch { /* raced */ } }
    return false;
  }
  let stMtimeMs: number | null = null;
  try { stMtimeMs = statSync(lockPath).mtimeMs; } catch { /* 刚被释放 */ }
  if (stMtimeMs !== null && Date.now() - stMtimeMs > LEASE_FRESH_GRACE_MS) {
    try { rmSync(lockPath, { force: true }); } catch { /* raced */ }
  }
  return false;
}

/**
 * {@link withOsFileLease} 的**同步孪生** —— 同一份锁协议(同一命名、同一记录格式、
 * 同一死活/过期判据),只把等待从 `await setTimeout` 换成阻塞睡眠。
 *
 * 为什么必须是孪生而不是复用异步版:同步函数的调用方(所有权存储的同步 CAS 契约、
 * Electron 主线程上的同步读-改-写)无法 `await`;而把异步租约在同步上下文里"等"出来
 * 只能 busy-wait 事件循环之外,等价于自行实现。为不让两份锁协议漂移,两边共用
 * `LeaseRecord` / `leaseOwnerAlive` / `LEASE_STALE_MS` / `LEASE_FRESH_GRACE_MS` /
 * `${real}.mcode-lock` 命名 —— 同一个锁文件,异步租约与同步租约**互相排斥**。
 *
 * 与异步版的差异只有两处,均刻意:
 *  1. 默认等待 {@link LEASE_SYNC_WAIT_MS}(5s)远短于异步版 60s —— 同步版阻塞主线程,
 *     临界区是毫秒级的小文件读-改-写;超时即抛 `FILE_VERSION_CONFLICT`,fail-closed。
 *  2. 等待用 `Atomics.wait` 阻塞,而不是让出事件循环。
 *
 * 进程内并发由 JS 单线程天然串行;跨进程互斥由 `wx` 保证 —— 与异步版同一机制。
 */
export function withOsFileLeaseSync<T>(file: string, action: (real: string) => T, waitMs = LEASE_SYNC_WAIT_MS): T {
  const resolved = path.resolve(file);
  let real = resolved;
  try { real = realpathSync(resolved); } catch { /* 文件尚不存在:与异步版同样回落 resolve 结果 */ }
  const lockPath = `${real}.mcode-lock`;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    if (tryAcquireOsLeaseSync(lockPath, token)) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `FILE_VERSION_CONFLICT:文件正被另一个进程写入(跨进程文件租约未在 ${waitMs}ms 内取得),拒绝并发覆盖:${lockPath}；请稍后重试`,
      );
    }
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
  try {
    return action(real);
  } finally {
    // 只删本 token 持有的锁 —— 与异步版同一释放判据。
    try {
      const raw = readFileSync(lockPath, "utf8");
      if ((JSON.parse(raw) as LeaseRecord).token === token) rmSync(lockPath, { force: true });
    } catch { /* 已被回收/替换:不动 */ }
  }
}
