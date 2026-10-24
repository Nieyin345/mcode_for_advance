/**
 * Per-turn file snapshot — backs the "撤销本轮" feature (Claude Code's
 * `/rewind` analog, scoped to a single turn).
 *
 * Lifecycle:
 *   1. `recordPre(cwd, filePath)` is called once for each file Edit/Write
 *      touches in the turn. The first call snapshots; subsequent calls
 *      for the same path are no-ops (the *original* content is what
 *      matters, not the latest).
 *   2. At turn end, `freeze()` returns the list of files for the renderer
 *      and marks the snapshot as "ready to rewind", then RELEASES the
 *      in-memory file contents: the rewind path restores from the frozen
 *      entries (rendered card / persisted turn_files), never from this map,
 *      so keeping the texts would only pin an idle session's last-turn
 *      files in memory forever.
 *   3. What survives freeze are the PATHS (`hasPaths`) — the runtime uses
 *      them to decide whether a rewind targeted the live snapshot before
 *      calling `clear()`.
 *
 * Path safety: every path is `path.resolve(cwd, filePath)`-d before any
 * disk access and rejected if it escapes `cwd`. This prevents a hostile
 * prompt from getting us to write outside the project working directory.
 *
 * Why we don't use git / a real checkpoint: out of scope for v1. The
 * roadmap reserves checkpoint timeline for P5; this is the lightweight
 * "last turn only" version that solves 90% of the actual user pain
 * (accidental file overwrite / wrong edits) without taking on a
 * dependency.
 */
import { lstat, readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TurnFileEntry } from "@contracts/runtime";
import { msysToWindowsPath } from "@main/lib/msysPath.js";
import { pathWithin } from "@main/lib/realPathWithin.js";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

/** Strict decoder for pre-turn snapshots: throws on invalid UTF-8 instead of
 *  substituting U+FFFD, and keeps a leading BOM (like readFile "utf-8") so a
 *  rewind writes back the exact original text. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 行级 diff 的**总格数上限**。【MC-003】
 *
 *  `countLineDiff` 的 LCS 表是 `(m+1) × (n+1)` 个 int32。1 万行旧 + 1 万行新 ≈ 1 亿
 *  格 ≈ 400MB(还只是表),5 万行级别理论上是 10GB —— 足以让主进程在收尾时卡死或
 *  直接 OOM。文件改动细微也照样付这份钱,因为表的大小只由文件**行数**决定。
 *
 *  超过这个格数就不建表,直接退化成"整段计数"(把旧的全算删除、新的全算新增)。
 *  数字偏大是可接受的 —— 它是给用户看的 `+N -M` 摘要,不是机器要用的精确 diff;
 *  而且行数比这还大的文件本来就没有逐行对照的可读性。宁可数字粗一点也不卡死。
 *
 *  400 万格 ≈ 16MB(临时),对 2000×2000 行以内的文件仍是精确的。 */
const MAX_DIFF_CELLS = 4_000_000;

/** Internal record per snapshotted file. */
interface FileRecord {
  /** Path the snapshot was taken from (cwd-resolved, absolute). */
  absPath: string;
  /** True if the file existed when recordPre was called; false if the
   *  file was created by this turn. Restore uses this to choose
   *  writeFile vs unlink. */
  exists: boolean;
  /** Pre-turn content. Empty string for "existed but was empty" or
   *  "didn't exist" (the latter shouldn't be read; we only use
   *  `content` when `exists === true`). */
  content: string;
}

/** @deprecated Use {@link TurnFileEntry} — kept as an alias so existing
 *  imports keep compiling during the payload expansion. */
export type FrozenFile = TurnFileEntry;

export class FileSnapshot {
  /** protected (not private) so CodexFileSnapshot can subclass: codex has no
   *  pre-write hook for auto-approved edits and rebuilds `before` from the
   *  turn's unified diff instead (see codex-sdk/CodexFileSnapshot.ts). */
  protected originals = new Map<string, FileRecord>();
  /** Paths whose pre-turn content was not valid UTF-8 (see recordPre). */
  private readonly unrestorable = new Set<string>();
  /** 【T125】这一轮被工具碰过、`before` 读不到、**但能确认 turn 前它是个普通文件**
   *  的路径 → 收尾时的字节（用于判断「本轮之后有没有被再改过」）。
   *
   *  **和 `unrestorable` 的区别是这条区分的全部价值：**
   *
   *  | 情况 | 归属 | 进 `turn.files` 吗 |
   *  |---|---|---|
   *  | 读到了，但不是合法 UTF-8（docx / GBK 文本 / 图片） | `unreadableFiles` | ✅ `restorable: false` |
   *  | 读失败，且**不是** ENOENT（EISDIR / EACCES / EPERM） | `unrestorable` | ❌ **不进** |
   *
   *  第二类不进的理由是 `file-snapshot-smoke` 的 FULL-1 钉着的：一个路径 turn 前是
   *  **目录**、turn 中被换成文件时，我们**根本不知道 turn 前它是什么** —— 记成
   *  `modified` 就是编造一段没发生过的历史（旧实现正是这么伪造出 `before` 的）。
   *
   *  所以「读不出内容」和「读失败」必须分开：前者的字节我们**看见了**（只是解不成文本），
   *  后者的字节我们**从来没读到过**。
   *
   *  值是 `null` 表示「抓到过、但收尾时确认不到了」—— 那种也照样进卡片
   *  （`restorable: false` 的条目本来就不参与冲突检测，见 `freeze` 里的注释）。 */
  private readonly unreadableFiles = new Map<string, { afterBytes: Uint8Array | null }>();
  /** 【MC-008】正在读取中的路径 → 该次读取的 promise。
   *
   *  只靠 `originals.has(abs)` 挡不住并发:那个检查发生在 `await readFile` **之前**,
   *  而 `originals.set` 在异步读取**之后** —— 两次并发 recordPre 同一路径会在
   *  await 之间双双通过检查,各自读一次,后完成的那个 set 覆盖先完成的。
   *  万一第一次写入动作恰好夹在两次异步读之间,后完成的那次读到的就是**改过之后**
   *  的内容,于是"首次原始内容"被悄悄换掉,撤销会把用户的改动写回去。
   *
   *  这里给每条路径预占一个 promise:同路径的第二次调用 await 它,而不是再读一遍。
   *  无论成功、失败(ENOENT/EACCES)还是不可恢复,都在 finally 里摘掉占位,
   *  绝不留一个永远 pending 的洞。 */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Invalidate asynchronous reads from an abandoned turn after clear(). */
  private generation = 0;
  /** Once frozen, recordPre() is a no-op. Lets us safely call
   *  freeze() at turn end and have any straggling tool_use events
   *  (rare, but possible) be ignored. */
  protected frozen = false;

  /** Number of files currently snapshotted (used by tests and the
   *  empty-after-freeze check). */
  get size(): number {
    return this.originals.size;
  }

  /** Snapshot a file's pre-turn state. Safe to call concurrently — the
   *  first call per path does the read; concurrent calls for the same path
   *  await it instead of re-reading (see `inflight`). Returns silently on any
   *  error (ENOENT = created, anything else = log + skip, never crash the
   *  event stream). */
  async recordPre(cwd: string, filePath: string): Promise<void> {
    if (this.frozen) return;
    const abs = safeResolve(cwd, filePath);
    if (abs === null) return; // path escapes cwd — silently ignore
    if (this.originals.has(abs)) return; // already snapshotted
    if (this.unrestorable.has(abs)) return; // pre-turn bytes not representable
    const pending = this.inflight.get(abs);
    if (pending) {
      // 同路径的读取已在飞 —— 等它落地,别读第二遍(否则后完成的那次可能读到写后的内容)。
      await pending;
      return;
    }
    const job = this.capturePre(abs, this.generation);
    this.inflight.set(abs, job);
    try {
      await job;
    } finally {
      if (this.inflight.get(abs) === job) this.inflight.delete(abs);
    }
  }

  /** The actual first-read-and-record. Protected (not private) so a test can
   *  subclass and count how many times a read actually happens — that count IS
   *  the MC-008 invariant (concurrent calls for one path must read once, not
   *  once each), and counting it avoids a nondeterministic filesystem race
   *  between the read and a concurrent write. Split out from `recordPre` so
   *  that method can register the in-flight promise before awaiting it. */
  protected async capturePre(abs: string, generation = this.generation): Promise<void> {
    try {
      const bytes = await readFile(abs);
      if (generation !== this.generation) return; // stale in-flight capture after clear()
      let content: string;
      try {
        content = STRICT_UTF8.decode(bytes);
      } catch {
        // Not valid UTF-8 (GBK/Shift-JIS/binary...). A lossy decode would put
        // U+FFFD into `before`, and rewinding would then write that mangled
        // text over the user's file — the undo itself would corrupt it. Leave
        // the file out of the rewind set instead, and remember that: a later
        // tool call must not snapshot the post-edit state as "before".
        //
        // 【T125】两条记录都写，但它们的含义不同（见字段声明处的表）：
        //   - `unrestorable` 挡住后续 recordPre（现有语义，不改）；
        //   - `unreadableFiles` 让 freeze() 能产出一条 `restorable: false` 的卡片
        //     —— 这一轮真的改过它，用户有权在「本轮文件」里看见。
        if (generation === this.generation) {
          this.unrestorable.add(abs);
          this.unreadableFiles.set(abs, { afterBytes: null });
        }
        console.warn(`FileSnapshot: skip ${abs} (not valid UTF-8, cannot restore losslessly)`);
        return;
      }
      if (generation === this.generation) this.originals.set(abs, { absPath: abs, exists: true, content });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File didn't exist before — claude will create it. Record
        // exists:false so restore can unlink.
        if (generation === this.generation) this.originals.set(abs, { absPath: abs, exists: false, content: "" });
      } else {
        // EACCES / EISDIR / EPERM do NOT prove absence. If the tool later
        // replaces the directory or an unreadable file with writable bytes,
        // a second pre-hook must not capture those post-edit bytes as the
        // original. Suppress retry for this turn; clear() permits a new one.
        if (generation === this.generation) this.unrestorable.add(abs);
        console.warn(`FileSnapshot: skip ${abs} (${code ?? (err as Error).message})`);
      }
    }
  }

  /** Freeze and return the list of files for the renderer, enriched with
   *  per-file change tallies (`adds` / `dels`) and the pre-turn `before`
   *  content. The contents are released before returning: everything the
   *  rewind needs lives in the returned entries (which the renderer renders
   *  and `turn.files` persists), and post-freeze consumers of this map are
   *  keys-only (`hasPaths`) plus `clear()`. Without the release, an idle
   *  session would pin the full text of its last turn's edited files until
   *  the session was deleted.
   *
   *  Not re-entrant: freezing twice returns nothing — there is no second
   *  turn end (adapters call this exactly once from flushFinal).
   *
   *  Async because we read each file's current on-disk content to diff
   *  against the snapshotted `before`. Read failures (deleted mid-turn,
   *  binary, permission) degrade gracefully to adds=dels=0 and before=""
   *  so a single bad file never blocks the whole turn-files event. */
  /** Overridable IO seam for deterministic async freeze-race regression. */
  protected readCurrent(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async freeze(): Promise<TurnFileEntry[]> {
    if (this.frozen) return [];
    this.frozen = true;
    const generation = this.generation;
    // Every pre-turn read ACCEPTED before freeze belongs in the frozen card.
    // Snapshot pending reads now; later recordPre calls are blocked by frozen.
    await Promise.all([...this.inflight.values()]);
    if (generation !== this.generation) return []; // clear() abandoned this turn
    const out: TurnFileEntry[] = [];
    for (const [path, rec] of [...this.originals]) {
      if (generation !== this.generation) return [];
      const before = rec.exists ? rec.content : "";
      // exists=false 时 `after` 读不到 → 用 null 与"读到了空文件"区分开(见下)。
      // 【MC-002 残余】`after` 的**字符串**用于 diff 计数与"逐字节相等"判据(既有语义:
      // 宽松解码),而**指纹**必须按原始字节算(见 `hashBytes` 注释)。
      let after: string | null = null;
      let afterBytes: Uint8Array | null = null;
      let afterMissing = false;
      try {
        afterBytes = await this.readCurrent(rec.absPath);
        after = Buffer.from(afterBytes).toString("utf-8");
      } catch (error) {
        // Only ENOENT proves this *created* pathname is now absent.
        // EISDIR, EPERM and transient IO errors mean the path may still
        // exist, so never hide the card or invent a checksum for empty bytes.
        afterMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
        afterBytes = null;
        after = null;
      }
      if (generation !== this.generation) return []; // clear() during awaited read
      // 【MC-005】"净零"必须按**原始字节**判,不能按 `adds === 0 && dels === 0`。
      // 行数统计有个角落:文件内容只是**末尾换行**变了("hello" ⇄ "hello\n"),
      // splitLines 把末尾单个换行当终止符丢掉,于是两边都是 ["hello"],adds=dels=0
      // —— 而磁盘上字节确实变了。原先就据此把这条当成"无变化"从卡片和快照里剔掉,
      // 用户改了换行却在界面上看不见、也回滚不了。
      // 判据改成逐字节相等:真的没变才丢;变了就留着(行数可以是 0/0,卡片按"无行变化"
      // 显示,但文件在、能回滚)。
      //
      // 两种情况仍要剔:
      //   ① 读到了内容且与 before 逐字节相同 —— 真·无变化的空转重写;
      //   ② 本轮**创建**的文件收尾时已不存在(`after === null` 且 `!rec.exists`)
      //      —— 写了又被删,没有东西可看也没有东西可还原。
      // 而"改过的文件收尾时读不到"(`after === null` 但 `rec.exists`)一律**保留**:
      // 那可能是被删/无权限/二进制,宁可留一张说得出话的卡,也别把磁盘上真实发生过
      // 的改动当成没发生。
      if (after === null) {
        if (!rec.exists && afterMissing) {
          this.originals.delete(path);
          continue;
        }
      } else if (rec.exists && afterBytes !== null &&
        Buffer.from(afterBytes).equals(Buffer.from(before, "utf-8"))) {
        // A string-only equality test is unsafe: valid pre-turn U+FFFD and
        // invalid post-turn 0xff decode to the same JS text. Compare BYTES.
        // Also never drop a newly created *empty* file: its existence is
        // the change to rewind even when the content is zero bytes.
        this.originals.delete(path);
        continue;
      }
      const { adds, dels } = countLineDiff(before, after ?? "");
      out.push({
        filePath: rec.absPath,
        kind: rec.exists ? "modified" : "created",
        adds,
        dels,
        before,
        // 【MC-002】记下"本轮收尾时磁盘上的样子"。历史回滚前拿它跟当前磁盘比一比:
        // 不一致 = 这个文件在本轮之后又被改过(第二轮、或用户自己改的),直接写回
        // before 会把那些改动也一起抹掉 —— 那正是"撤销第 1 轮顺手毁了第 2 轮"。
        // An unreadable/unverifiable after-state has no truthful checksum.
        // Restore treats legacy/no-hash entries as conflicts (fail closed).
        ...(afterBytes === null ? {} : { afterHash: hashBytes(afterBytes) }),
      });
    }
    if (generation !== this.generation) return [];
    // 【T125】被 `capturePre` 跳过的文件（读不出 `before`）也要出现在卡片里 ——
    // 但标成 `restorable: false`，**不进 rewind 的还原集**。
    //
    // 为什么必须在这里补：`originals` 只收「before 读到了」的文件，而这些文件
    // 被主动排除在外（理由见 `capturePre` 里那段注释 —— 有损解码会让撤销毁文件）。
    // 于是它们在 `turn.files` 里**完全不存在**：任务中心看不见这一轮改过的 docx，
    // 用户也不知道「本轮文件」里少了什么。
    //
    // 两条边界：
    //   - **`before` 一律是空串**，`adds`/`dels` 一律 0 —— 我们根本没读到原内容，
    //     编一个数字出来就是撒谎。卡片的文案要按 `restorable === false` 分别渲染。
    //   - **不带 `afterHash`**（`afterHash` 的语义是「回滚时拿它比对，防覆盖新改动」，
    //     而这一条根本不参与回滚）。带上它会让 `restoreFiles` 的遗留快照分支
    //     误以为这是个正常的可还原条目。
    for (const [path, rec] of [...this.unreadableFiles]) {
      if (generation !== this.generation) return [];
      // 收尾时再读一次：文件已经被删掉就没有卡片可给（与 created 的「写了又删」同理）；
      // 读得到就记下字节供 `afterHash` 用 —— 那让「本轮之后又被改过」的判定在这一类上
      // 也成立（虽然它们不参与还原，但 UI 的「已过期」提示要用）。
      let afterBytes: Uint8Array | null = null;
      try {
        afterBytes = await this.readCurrent(path);
      } catch {
        // 收尾时读不到 —— 可能被删、也可能被替换成目录。记 null，仍然出卡片：
        // `restorable: false` 的条目本来就告诉用户「这条没法撤销」，藏起来更糟。
      }
      if (generation !== this.generation) return [];
      rec.afterBytes = afterBytes;
      out.push({
        filePath: path,
        kind: "modified",
        adds: 0,
        dels: 0,
        before: "",
        restorable: false,
        ...(afterBytes === null ? {} : { afterHash: hashBytes(afterBytes) }),
      });
    }
    if (generation !== this.generation) return [];
    // Hand the contents to the GC: the entries above carry `before` to the
    // renderer + DB, and post-freeze readers of this map need keys only.
    for (const rec of this.originals.values()) {
      rec.content = "";
    }
    return out;
  }

  /** Drop the restore records. Now only called after a successful LIVE
   *  rewind (the contents are back on disk, nothing left to restore).
   *  Turn start and session dispose drop the whole registry entry
   *  instead (fileSnapshotRegistry.dropFileSnapshot) — an interrupted
   *  turn's adapter keeps its own instance, so its late freeze() still
   *  sees the records and its `frozen` flag can't leak into the next
   *  turn's snapshot. */
  clear(): void {
    this.generation++;
    this.inflight.clear(); // new turn must not wait for an old turn\u0027s slow read
    this.originals.clear();
    this.unrestorable.clear();
    this.unreadableFiles.clear();
    this.frozen = false;
  }

  /** Snapshot keys (cwd-resolved absolute paths) — used by the runtime
   *  to decide whether a rewind's `files` argument matches the live
   *  snapshot (so it can clear() safely) or came from elsewhere (e.g.
   *  the DB, for a historical-turn rewind) and shouldn't touch the
   *  live snapshot. */
  hasPaths(paths: string[]): boolean {
    if (paths.length !== this.originals.size) return false;
    return paths.every((p) => this.originals.has(p));
  }
}

/** Restore an arbitrary set of {@link TurnFileEntry} to their `before`
 *  state. The single source of truth for the restore operation — used
 *  both by {@link FileSnapshot.restore} (live latest-turn rewind) and
 *  by `RuntimeManager.rewindTurn` when it receives explicit entries
 *  (historical-turn rewind, or a session reopened after restart where
 *  the in-memory snapshot is gone).
 *
 *  Path safety: every entry's `filePath` is re-checked against `cwd`
 *  via {@link safeResolveOk} — a path that escapes cwd is refused and
 *  excluded from the result. This keeps the restore guard identical to
 *  the one that governed the original write.
 *
 *  Returns the paths that landed back on disk, and the ones that did NOT. A
 *  partial failure is**用户能看见的事实** —— 从前这里只 `console.warn` 就把它丢了,
 *  调用方只拿到成功列表、卡片照样画「已恢复」,用户以为整轮都还原了。所以现在把
 *  `failed` 一并交出去(越界被拒的路径也算失败 —— 它确实没还原)。 */
export interface RestoreReport {
  /** 真的写回/删掉的路径。 */
  restored: string[];
  /** 没还原成功的路径(越界被拒 / 写盘失败)。 */
  failed: string[];
  /** 【MC-002】本轮之后**又被改过**、因此拒绝覆盖的路径。
   *
   *  历史回滚最危险的样子:第 1 轮把 X 从 A 改成 B;第 2 轮(或用户手动)又改成 C;
   *  现在回滚第 1 轮 —— 老实现直接把 `before`(=A)写回去,**C 连同第 2 轮一起没了**。
   *  确认弹窗不是冲突检测。现在:收尾时把当时的 `after`(B)指纹存进快照,回滚前拿它
   *  跟当前磁盘比,B ≠ 当前 → 这个文件**原样保留**,列进这里,由 UI 明说「这几个没还原」
   *  (它们不是"失败",是"故意不动")。
   *
   *  没有 `afterHash` 的旧快照(本次改动前落盘的历史条目)无从比对,按老行为处理。 */
  conflicts: string[];
  /** 【T125】**从来就没法撤销**的路径（`restorable === false`）。
   *
   *  **不能并进 `conflicts`**：那个通道的用户文案是「{n} 个文件之后又改过,为避免
   *  覆盖新改动没有动它们」—— 而这些文件**从来没有被之后改过**，它们只是
   *  `capturePre` 读不出 `before`（非 UTF-8 / 二进制）。并进去就是让 toast 说假话。
   *
   *  也不能并进 `failed`：那不是「还原失败」，是「本就不该还原」—— 混在一起会让
   *  用户以为是自己运气不好、重试就能成。
   *
   *  所以单列一类，由 UI 说「这 N 个含有无法无损读取的内容，撤销不会动它们」。 */
  unrestorable: string[];
}

export async function restoreFiles(
  cwd: string,
  entries: TurnFileEntry[],
): Promise<RestoreReport> {
  const restored: string[] = [];
  const failed: string[] = [];
  const conflicts: string[] = [];
  const unrestorable: string[] = [];
  // Historical cards are serialized inputs and may contain relative paths or
  // conflicting duplicate rows. Resolve using the *project* cwd once and
  // apply ALL IO to this absolute identity, never Electron's process.cwd().
  const normalized = entries.map((entry) => typeof entry?.filePath === "string" ? safeResolve(cwd, entry.filePath) : null);
  const canonicalKey = (p: string) => process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
  const frequencies = new Map<string, number>();
  for (const path of normalized) {
    if (path !== null) {
      const key = canonicalKey(path);
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    }
  }
  // Process created-files first (unlink) so a parent that was also
  // modified can be cleanly rewritten without the child blocking.
  const order = entries.map((entry, i) => ({ entry, normalized: normalized[i] }))
    .sort((a, b) => Number(a.entry?.kind !== "created") - Number(b.entry?.kind !== "created"));
  const seenConflicts = new Set<string>();
  for (const { entry, normalized: preflight } of order) {
    // 【T125】`restorable: false` 的条目**不参与还原**，一个字节都不碰。
    //
    // 它出现在这里只有一个来路：`freeze()` 发现这一轮的某个文件读不出 `before`
    // （非 UTF-8 / 二进制），于是产出一条 `before: ""` 的卡片让用户**看见**它，
    // 同时标成不可还原。**它的 `before` 是空串，而 `atomicReplaceFile(path, "")`
    // 会把用户的 docx 清成 0 字节。**
    //
    // 所以这条守卫必须在任何写盘之前，而且判据必须是 `!== false`（缺省可还原）——
    // 旧会话落盘的条目没有这个字段，用 `=== true` 会让历史回合一律撤销不了。
    //
    // 与 `conflicts` / `failed` 分开报（见 RestoreReport.unrestorable 的注释）：
    // 这三者的用户文案完全不同，混用对用户说假话。
    if (entry?.restorable === false) {
      unrestorable.push(preflight ?? entry.filePath);
      continue;
    }
    // IPC/SQLite rows are not protected by their TypeScript annotation at
    // runtime. A corrupt kind previously fell through to unlink(!), and
    // a non-string 'before' could throw while hashing and abort the batch.
    if ((entry?.kind !== "created" && entry?.kind !== "modified") ||
        typeof entry?.before !== "string" ||
        (entry?.afterHash !== undefined && typeof entry?.afterHash !== "string")) {
      failed.push(preflight ?? (typeof entry?.filePath === "string" ? entry.filePath : "[invalid rewind entry]"));
      continue;
    }
    const path = safeResolve(cwd, entry.filePath);
    if (path === null || preflight === null || path !== preflight) {
      console.warn(`restoreFiles: refused, unsafe or moved path: ${entry.filePath}`);
      failed.push(entry.filePath);
      continue;
    }
    if ((frequencies.get(canonicalKey(path)) ?? 0) > 1) {
      if (!seenConflicts.has(canonicalKey(path))) {
        seenConflicts.add(canonicalKey(path));
        conflicts.push(path);
      }
      continue;
    }
    // 【MC-002】先看这个文件在本轮之后有没有被再改过。
    if (entry.afterHash !== undefined) {
      let current: string | null;
      let currentBytes: Uint8Array | null;
      try {
        currentBytes = await readFile(path);
        // 宽松解码只为与 `before` 做字符串相等(幂等判断),指纹另走字节(见下)。
        current = Buffer.from(currentBytes).toString("utf-8");
      } catch (error) {
        // ENOENT is the ONLY read failure proving absence. EISDIR/EACCES/
        // EPERM can all describe an existing entry; reporting them as an
        // already-restored created file silently lies to the user.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(`restoreFiles: cannot inspect ${path} (${code ?? String(error)})`);
          failed.push(path);
          continue;
        }
        if (entry.kind === "modified") {
          // A later deletion is a real conflicting user edit. Never turn a
          // failed read into the empty-file hash and recreate the file.
          conflicts.push(path);
          continue;
        }
        current = null; // created, already missing: target state reached
        currentBytes = null;
      }
      if (current !== null && hashBytes(currentBytes ?? new Uint8Array()) !== entry.afterHash) {
        // 【MC-002】磁盘上现在的内容 ≠ 本轮收尾时的样子。**但先别急着判冲突** ——
        // 有一种"不一致"是**上一次撤销已经成功**:那之后文件停在 `before`,与
        // `afterHash` 当然对不上。第 13 轮复查点名的"额外幂等陷阱"正是这一格:用户
        // 见有文件没还原、点重试,整批原样再送一遍,已成功的那几个被重新读成"冲突",
        // 于是**越重试越糟** —— 明明已经好了的也被拒。
        //
        // 所以"当前 == before"要认作**已达目标态**,幂等放行(不重写、不报错)。
        // 只有既不是 `afterHash`、也不是 `before` 的,才是真被后来的动作改过。
        // 比对按**原始字节**:`before` 是严格解码出来的(→ 能无损编回同样的字节),
        // `currentBytes` 是磁盘原文,两者字节相等才算"已回到目标态"。
        if (
          entry.kind === "modified" &&
          hashBytes(currentBytes ?? new Uint8Array()) === hashBytes(Buffer.from(entry.before, "utf-8"))
        ) {
          restored.push(path);
          continue;
        }
        // 磁盘上现在的内容 ≠ 本轮收尾时的样子 —— 被后来的动作改过了。
        // 直接写回/删除会把那些改动一并抹掉,所以**什么都不做**,如实列进 conflicts。
        console.warn(`restoreFiles: skip ${path} (changed after the turn; refusing to clobber)`);
        conflicts.push(path);
        continue;
      }
      if (entry.kind === "created" && current === null) {
        // 本轮创建的文件现在不存在了 —— 目标状态已达成,算已还原(不报错)。
        restored.push(path);
        continue;
      }
    } else {
      // 【MC-002 第 23 轮残余】**没有 `afterHash` 的旧快照**(本次改动前落盘的历史条目)。
      // 从前这里"按老行为直接还原" —— 但那条老行为正是本条要堵的:无从判断文件在本轮
      // 之后有没有被再改过,直接写回 `before` / 删除就可能把用户后来的改动一并抹掉。
      // 第 23 轮明确要求:对无指纹的遗留快照**保守拒绝**(不自动覆盖),在文件级结果里
      // 如实标成冲突,让用户自己决定。宁可少还原一个,也不静默毁掉用户的当前内容。
      console.warn(
        `restoreFiles: skip ${path} (no afterHash — legacy snapshot; refusing to auto-restore)`,
      );
      conflicts.push(path);
      continue;
    }
    try {
      // Revalidate immediately before mutation: the read/hash check above
      // may have yielded while another process changed the target. In
      // particular never follow a newly substituted hardlink when writing.
      // This narrows a real race but is not a cross-process atomic CAS.
      if (safeResolve(cwd, path) !== path) {
        conflicts.push(path);
        continue;
      }
      let latest: Uint8Array;
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.nlink !== 1) {
          conflicts.push(path);
          continue;
        }
        latest = await readFile(path);
      } catch (error) {
        // A user may have deleted/replaced this file between the first
        // check and the final write; never recreate or report restored.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          conflicts.push(path);
          continue;
        }
        throw error;
      }
      if (hashBytes(latest) !== entry.afterHash) {
        conflicts.push(path);
        continue;
      }
      if (entry.kind === "modified") {
        // The target was lstat-validated just above: it already exists.
        // Truncating it with writeFile destroys the current bytes if disk
        // write/fsync crashes mid-way. Reuse the one Host atomic writer
        // (same-directory random wx stage, sync, rename, no in-place fallback)
        // so a failed restore preserves the file still on disk.
        await atomicReplaceFile(path, entry.before);
      } else {
        try {
          await unlink(path);
        } catch (err) {
          // Already gone — nothing to do.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      restored.push(path);
    } catch (err) {
      console.warn(`restoreFiles: failed for ${path} (${(err as Error).message})`);
      failed.push(path);
    }
  }
  return { restored, failed, conflicts, unrestorable };
}

/* ──────────────────────────── path safety ──────────────────────────── */
/* Exported so the on-demand file-read IPC handler reuses the exact same
   cwd-escape guard the snapshot uses, rather than re-implementing it. */

/** File-mutating tools whose `file_path` / `notebook_path` input must be
 *  normalized (WSL → Windows) and confined to the project working directory.
 *  Shared between the provider's canUseTool guard and the adapter's rewind
 *  snapshot so both sides agree on the target path. */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Extract the target path from a file-mutating tool's input. Returns ""
 *  when the input is missing/malformed. NotebookEdit names its field
 *  `notebook_path`; the rest use `file_path`. */
export function getToolFilePath(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const raw = toolName === "NotebookEdit" ? obj.notebook_path : obj.file_path;
  return typeof raw === "string" ? raw : "";
}

/** Whether a raw (pre-resolve) path ascends above its root via a literal `..`
 *  path segment. Splits on BOTH separators so it behaves the same whichever
 *  dialect the model emitted.
 *
 *  【MC-001/MC-006】这是一个"意图"信号,不是包含性证明 —— normalizeToolFilePath
 *  最终仍以物理 `insideProject` 为准。它的价值在于把"模型主动写了 `../`"与
 *  "模型写了个合法的 `..config` 点文件名"分开:
 *   - `../escape`、`a/../../b`  → true(在爬出去);
 *   - `..config`、`..backup`     → false(合法的点文件名,`..` 是名字的一部分);
 *   - `..`                       → true(裸的父目录)。 */
export function containsDotDotEscape(rawPath: string): boolean {
  return rawPath.split(/[/\\]/).some((seg) => seg === "..");
}

/** Normalize a file path coming out of a file-mutating tool input:
 *  fix the WSL/MSYS-path footguns and classify it relative to the project
 *  root.
 *
 *  Claude occasionally emits `/mnt/<drive>/...` (WSL-style) or `/d/...`
 *  (Git Bash-style) paths even on native Windows — both notations are baked
 *  into its training data. On Windows `path.resolve()` treats such a path as
 *  root-relative on the current drive, so `/mnt/d/foo.md` would silently land
 *  in a garbage `D:\mnt\d\foo.md` folder. We translate both dialects to
 *  native paths first, then resolve against cwd.
 *
 *  Returns `{ absPath, insideProject, escaped }`:
 *    - absPath: the absolute path the write should actually target (the
 *      provider rewrites the tool input to this).
 *    - insideProject: whether absPath stays PHYSICALLY within cwd — lexical
 *      containment AND its symlink/junction destination (MC-001). A worktree
 *      link pointing outside no longer reads as "inside".
 *    - escaped: the raw path, after dialect translation, ascends above cwd via
 *      a literal `..` segment (MC-001). The lexical+physical check already
 *      rejects such paths, but this flag lets a caller distinguish a genuine
 *      escape attempt from a path that merely happens to be outside (e.g. an
 *      absolute path in a different tree), which matters for how loudly to
 *      refuse.
 *  Returns null when the path can't be resolved (caller skips silently). */
export function normalizeToolFilePath(
  cwd: string,
  filePath: string,
): { absPath: string; insideProject: boolean; escaped: boolean } | null {
  // WSL/MSYS dialect → native Windows path: /mnt/d/foo → D:\foo, /d/foo →
  // D:/foo (shared with the Pi read-tool override and the bash-command
  // normalizer, so every path check agrees on the same translation).
  const win = msysToWindowsPath(filePath);
  let abs: string;
  try {
    abs = resolve(cwd, win);
  } catch {
    return null;
  }
  return {
    absPath: abs,
    insideProject: safeResolveOk(cwd, abs),
    escaped: containsDotDotEscape(win),
  };
}

/** Resolve `filePath` against `cwd` and refuse any path that escapes.
 *  Returns null if the path is unsafe (caller should skip silently). */
export function safeResolve(cwd: string, filePath: string): string | null {
  let abs: string;
  try {
    abs = resolve(cwd, filePath);
  } catch {
    return null;
  }
  return safeResolveOk(cwd, abs) ? abs : null;
}

/** Re-check that an already-resolved absolute path stays within cwd.
 *  Used by restore() to defend against the cwd changing between
 *  recordPre and restore. */
export function safeResolveOk(cwd: string, abs: string): boolean {
  // path.relative with the second arg outside cwd returns a path
  // starting with "..". On Windows an absolute result also means
  //  "different root" (different drive).
  //
  // 【MC-006】越界判据只能是 `rel === ".."` 或 `rel` 以 `".." + sep` 开头 ——
  // **不能**是 `startsWith("..")`。后者会把 `..config`、`..backup` 这种**合法**的
  // 点文件当成逃逸路径拒掉(它们在根目录内,只是名字恰好以两个点开头)。
  // 这不是理论问题:项目里放 `.env`、`..config` 这类文件很常见,一写就被静默拒绝,
  // 用户看到的是"改不了这个文件"而没有任何提示。
  const rel = relative(cwd, abs);
  if (rel === "") return false; // cwd 本身不是"cwd 内的文件"
  if (isAbsolute(rel)) return false; // 不同盘(Windows)或不同根
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  // 物理包含性:工作区里的 symlink/junction 可以指向外面,而字面路径看着还在里面。
  // 复用 pathGuard 同一份 `pathWithin`(经零依赖叶子模块),不另写一套。
  return pathWithin(cwd, abs);
}

/** 内容指纹(SHA-256 十六进制)。用于两处:
 *   - 【MC-002】把某轮 `after` 的指纹存进快照,历史回滚前比对当前磁盘;
 *   - 同轮运行时判断"文件现在还是不是我收尾时看到的样子"。
 *
 *  【MC-002 第 23 轮残余】**必须按原始磁盘字节算,不能按 UTF-8 解码后的字符串**。
 *  从前这里收的是 `string`,`createHash("sha256").update(text,"utf-8")` 先把字符串
 *  按 UTF-8 编回字节 —— 而**非法 UTF-8 的文件**(GBK / Shift-JIS / 二进制)读成字符串时
 *  每段坏字节都塌成同一个 U+FFFD,于是两个**内容不同**的非法 UTF-8 文件会算出**相同的
 *  指纹**,冲突检测被绕过、直接覆盖掉用户后来的改动。改成直接吃字节(`Buffer`)就没了
 *  这层有损转换。 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ──────────────────────────── line counting ──────────────────────────── */

/** Split text into lines, dropping a single trailing empty produced by a
 *  final `\n` (matches the renderer's lineDiff.splitLines so before/after
 *  are counted on the same basis). */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "" && s.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

/** Tally added/deleted line counts between two texts via an LCS table walk.
 *  A counting-only sibling of the renderer's `lineDiff` — we don't need the
 *  actual diff *lines* in main, just the `+N -M` numbers for the folded card,
 *  so this stays allocation-light (one Int32Array, no output array). */
function countLineDiff(oldText: string, newText: string): { adds: number; dels: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  // Fast paths: identical, or one side empty.
  if (m === 0) return { adds: n, dels: 0 };
  if (n === 0) return { adds: 0, dels: m };

  // 【MC-003】表太大就别建 —— 退化成"整段计数"而不是拿主进程的内存去赌。
  // (m+1)×(n+1) 个 int32:两边各 1 万行就要 ≈400MB,5 万行级别理论上 10GB。
  // 对超限的大文件给出 adds=n / dels=m:数字偏大,但它是给用户看的摘要,且这种
  // 体量的文件本来就没有逐行对照的可读性 —— 卡死主进程才是真问题。
  if ((m + 1) * (n + 1) > MAX_DIFF_CELLS) {
    return { adds: n, dels: m };
  }

  const cols = n + 1;
  const lcs = new Int32Array((m + 1) * cols);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i * cols + j] = lcs[(i - 1) * cols + (j - 1)] + 1;
      } else {
        const up = lcs[(i - 1) * cols + j];
        const left = lcs[i * cols + (j - 1)];
        lcs[i * cols + j] = up > left ? up : left;
      }
    }
  }
  // Walk back to count deletes/inserts (same logic as lineDiff, but tally
  // instead of push).
  let adds = 0;
  let dels = 0;
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      dels++;
      i--;
    } else {
      adds++;
      j--;
    }
  }
  while (i > 0) {
    dels++;
    i--;
  }
  while (j > 0) {
    adds++;
    j--;
  }
  return { adds, dels };
}
