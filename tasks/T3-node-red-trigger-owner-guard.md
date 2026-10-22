# T3｜Node-RED 工作流触发器单一归属门禁

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: coordinate with T2 and T4; do not modify their exclusive files
- Exclusive writable files: identify exact trigger dispatch/ownership files before editing; stop if the required path overlaps another active card.
## Required Skills
  - `mcode-smoke`: test trigger ownership and prevent duplicate firing.
  - `code-review`: verify legacy/new runner ownership semantics.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T46/T72/T94.
- Acceptance: one flow has exactly one active trigger owner; legacy AutomationRunner cannot duplicate Node-RED-owned scheduled/event triggers. Cover migration, restart, stale owner, cancellation, and fallback behavior.
- Execute: confirm current code still permits dual ownership; make a narrow change and run isolated smoke. No live user automations.
- Result writeback: proof of one owner, tests, touched paths, remaining deployment/U1 risks, commit SHA.
