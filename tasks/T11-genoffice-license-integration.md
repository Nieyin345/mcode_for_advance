# T11｜GenOffice 许可证材料集成与发行门禁复验

- Status: ready-for-agent
- Category: bug
- Priority: P0 release blocker
- Depends on: T9 source/provenance policy decision
- Exclusive writable files: GenOffice-specific notices/manifest and dedicated tests only; do not overlap T10 or alter unknown-license policy.
## Required Skills
  - `research`: ensure exact-version source material is supported by primary evidence.
  - `mcode-smoke`: validate notice generation and release gate positive/negative cases.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, release ledger, archived T76/T87/T89/T90.
- Acceptance: include only evidence-backed original license material; all unresolved packages continue to block release. Re-run relevant release-readiness checks and prove a known bad/unknown package remains blocked.
- Execute: do not start until T9 is accepted; stop if required source files overlap another active task.
- Result writeback: evidence-to-notice mapping, tests, unresolved list, commit SHA.
