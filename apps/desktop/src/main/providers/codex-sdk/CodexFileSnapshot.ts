/**
 * Codex per-turn file snapshot — extends FileSnapshot with unified-diff
 * reconstruction for auto-approved edits.
 *
 * The app-server only surfaces file changes AFTER they land, as a cumulative
 * per-turn unified diff (`turn/diff/updated`). That diff is the ONLY capture
 * path on this provider: unlike Claude/Pi there is no pre-write hook, and the
 * approval request params carry only `grantRoot` (no per-file paths), so the
 * approval handler cannot recordPre either — freeze() reconstructs each
 * changed path's pre-turn content by reverse-applying the diff to the current
 * on-disk content. Reconstruction is conservative — any hunk mismatch drops
 * the rewind entry (the card stays honest).
 *
 * Deleted files (present pre-turn, removed in-turn) reconstruct via the
 * diff's whole-file deletion section and restore as `modified` entries
 * (writing the original content back).
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import type { TurnFileEntry } from "@contracts/runtime";
import { parseUnifiedDiff, reverseApplySection } from "./codexTurnDiff.js";

export class CodexFileSnapshot extends FileSnapshot {
  /** Latest cumulative per-turn unified diff (raw text). Replaced on every
   *  `turn/diff/updated` — the server sends the full aggregated diff, not
   *  increments. */
  private turnDiff = "";

  constructor(private readonly cwd: string) {
    super();
  }

  setTurnDiff(diff: string): void {
    if (this.frozen) return;
    this.turnDiff = diff;
  }

  /** Freeze with diff reconstruction. recordPre'd paths keep the exact
   *  base-class behavior (read current → LCS tallies); diff-only paths get
   *  reconstructed pre-turn content. Net-zero entries are dropped, same as
   *  the base class. */
  override async freeze(): Promise<TurnFileEntry[]> {
    const base = await super.freeze();
    if (!this.turnDiff) return base;

    const seen = new Set(base.map((e) => e.filePath));
    const sections = parseUnifiedDiff(this.turnDiff);
    for (const section of sections) {
      const abs = this.resolveWithinCwd(section.path);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);

      let after = "";
      try {
        after = await readFile(abs, "utf-8");
      } catch {
        // Missing file + not marked deleted in the diff = deleted in-turn;
        // reverse-applying against "" still works for whole-file deletions
        // (the diff carries the original lines) and fails cleanly otherwise.
        after = "";
      }
      const before = reverseApplySection(after, section);
      if (before === null) {
        // Reconstruction failed (binary file, drifted content, unfamiliar
        // hunk shape) — skip rather than guess; rewind just won't offer
        // this one path.
        continue;
      }
      if (section.adds === 0 && section.dels === 0) continue;
      const existed = !section.created;
      this.originals.set(abs, { absPath: abs, exists: existed, content: before });
      base.push({
        filePath: abs,
        kind: existed ? "modified" : "created",
        adds: section.adds,
        dels: section.dels,
        before,
        // 【MC-002】收尾时磁盘上的样子;历史回滚拿它做冲突检测(见 lib/fileSnapshot)。
        // 这里 `after` 就是刚读到的当前内容(读失败时为空串,与 modified 的"读不到
        // 即冲突"约定一致)。
        afterHash: createHash("sha256").update(after, "utf-8").digest("hex"),
      });
    }
    return base;
  }

  /** Resolve a diff-header path (cwd-relative per 0.152+, absolute tolerated)
   *  against the turn cwd. Returns null when it escapes the cwd — the same
   *  confinement the base class enforces for recordPre. */
  private resolveWithinCwd(p: string): string | null {
    const raw = p.trim();
    if (!raw || raw === "/dev/null") return null;
    let abs: string;
    try {
      abs = isAbsolute(raw) ? raw : resolve(this.cwd, raw);
    } catch {
      return null;
    }
    // 【MC-006】同 safeResolveOk:越界只能是 `..` 本身或以 `..` + 分隔符开头,
    // 不能是 `startsWith("..")` —— 那会把合法的 `..config` 点文件名也拒掉。
    const rel = relative(this.cwd, abs);
    if (rel === "" || isAbsolute(rel)) return null;
    if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
    return abs;
  }
}
