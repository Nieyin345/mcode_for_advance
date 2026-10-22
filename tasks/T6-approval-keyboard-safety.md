# T6｜审批卡键盘、焦点与拒绝路径回归

- Status: ready-for-agent
- Category: bug
- Priority: P1 security
- Depends on: none
- Exclusive writable files: approval component and its isolated regression suite only, after exact paths are confirmed.
## Required Skills
  - `mcode-smoke`: cover keyboard/focus/IME regressions with deterministic component tests.
  - `security-best-practices`: ensure keyboard shortcuts cannot bypass approval or convert denial into allow.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, relevant approval/security ledger entries, archived T96.
- Acceptance: Enter never grants unexpectedly; Esc denies/closes according to current contract; IME composition, hidden panes, stale focus, and dangerous-method denials are safe. Unknown or ambiguous state fails closed.
- Execute: verify current behavior first; no permission semantic changes without evidence.
- Result writeback: test matrix, old-red/new-green, commit SHA, real Electron cases still outstanding.
