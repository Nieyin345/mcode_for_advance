# T2｜Node-RED Deploy 与 Mcode Library 对账恢复

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: none; coordinate shared workflow files before starting T3/T4
- Exclusive writable files: declare exact files after inspecting current state; do not overlap T3/T4 or alter release/license gates.
## Required Skills
  - `mcode-smoke`: build isolated deploy/recovery regression with fake flow and storage.
  - `code-review`: inspect state ownership and error paths.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T72/T85/T93.
- Acceptance: native Deploy and Library mirror cannot silently diverge; failures are observable and recoverable; duplicate/late ACK, crash/restart, invalid data, and retry paths are tested. Do not claim cross-store atomicity unless demonstrated.
- Execute: inspect current owner/reconciliation code and Git state; isolate one bounded seam; add old-red/new-green tests and run targeted smoke.
- Result writeback: changed paths, tests, failure/recovery evidence, remaining multi-process/U1 limitations, commit SHA.
