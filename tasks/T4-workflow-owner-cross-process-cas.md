# T4｜工作流 owner 跨进程 CAS 互斥证明

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: coordinate with T2/T3; independent files only
- Exclusive writable files: exact owner registry/CAS implementation and dedicated smoke files after inspection; do not overlap T2/T3.
## Required Skills
  - `mcode-smoke`: launch real OS child processes for competing owner acquisition.
  - `code-review`: review atomicity and recovery assumptions.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T03/T10/T97.
- Acceptance: two real OS processes racing for the same flow cannot both become owner; stale owner recovery and process crash are tested. In-process mocks alone do not satisfy acceptance.
- Execute: inspect existing lock/CAS implementation and use temp paths; do not change persistent production user data.
- Result writeback: process-level race evidence, tests, failure injection, commit SHA, limitations.
