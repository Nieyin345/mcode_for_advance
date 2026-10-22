# T1｜Worktree merge-back ownership 探测失败时 fail-closed

- Status: ready-for-agent
- Category: bug
- Priority: P0 security/data integrity
- Depends on: none
- Exclusive writable files: first verify current code; intended narrow boundary is `apps/desktop/src/main/lib/worktreeOps.ts` and its dedicated regression smoke only. Do not touch unrelated dirty files.
- Acceptance: ownership probe error, missing metadata, stale identity, and deleted/recreated worktree never authorize merge-back; valid owner still works. Test using a temporary fake Git repository.
## Required Skills
  - `mcode-smoke`: add isolated regression and demonstrate old-red/new-green.
  - `security-best-practices`: assess fail-open ownership and data-integrity consequences.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T99/T101/T105.
- Execute: prove whether `.catch(() => true)` or equivalent remains on current HEAD; if already fixed, do not reimplement—record evidence and stop. Otherwise patch narrowly.
- Result writeback: commit SHA, exact tests, mutation evidence, and whether identity-generation redesign remains separately needed.
