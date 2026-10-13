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
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const LEASE_STALE_MS = 120_000;
const LEASE_WAIT_MS = 60_000;
/** 锁文件已存在但读不出合法 JSON 时,按 mtime 判「正被另一进程创建中(新鲜)→ 退让」
 *  还是「写崩了(陈旧)→ 回收」。 */
const LEASE_FRESH_GRACE_MS = 5_000;

interface LeaseRecord { host: string; pid: number; token: string; createdAt: number; }

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
  let existing: LeaseRecord | null = null;
  try { existing = JSON.parse(raw) as LeaseRecord; } catch { existing = null; }
  if (existing && Number.isFinite(existing.pid)) {
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
