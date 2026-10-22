# T5｜UI 视觉探针假阳性收敛

- Status: ready-for-agent
- Category: bug
- Priority: P1
- Depends on: none; does not authorize real Electron session ownership
- Exclusive writable files: visual-probe assertions and dedicated fixtures only; list exact paths before edit.
## Required Skills
  - `mcode-smoke`: make probe fail when real product content is absent or replaced by fixtures.
  - `code-review`: check assertions are discriminative rather than merely present.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, relevant ARC-005 ledger entries, archived T78/T95.
- Acceptance: tests distinguish real content, fixture-only content, missing content, and wrong container; demonstrate old-red/new-green. DOM/E1 only—do not claim Electron U1.
- Execute: confirm current probe false-positive modes and add negative controls.
- Result writeback: assertions, negative controls, tests, commit SHA, deferred U1 cases.
