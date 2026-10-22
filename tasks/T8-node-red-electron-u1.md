# T8｜Node-RED 原生画布真实 Electron U1 验收

- Status: ready-for-agent
- Category: bug
- Priority: P1
- Depends on: T2, T3, T4 stable; must run serially and exclusively with T7
- Exclusive writable files: acceptance scripts/reports only; product fixes need separate bounded cards.
## Required Skills
  - `mcode-smoke`: distinguish isolated E1 from real Electron U1.
  - `code-review`: keep defects and acceptance evidence separate.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, archived T77/T93/T94/T97 and current dependency results.
- Acceptance: real Electron verifies load/edit/deploy/reopen, Library reconciliation, trigger single ownership, and failure recovery. No fake renderer or component-only test counts as U1.
- Execute: acquire exclusive Electron slot only after dependencies are accepted.
- Result writeback: step-by-step PASS/FAIL/BLOCKED evidence, commit/build SHA, remaining defects in separate cards.
