# T9｜GenOffice 未决第三方许可证来源证据

- Status: ready-for-agent
- Category: bug
- Priority: P0 release blocker
- Depends on: none; T11 integration depends on this evidence/policy result
- Exclusive writable files: research report and exact source/notice evidence paths only; do not modify vendor manifests, notices, packages, or release gates.
## Required Skills
  - `research`: gather high-trust primary-source evidence for exact package versions.
  - `code-review`: validate evidence is version-specific and conclusions do not overreach.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, current release ledger, archived T76/T87/T89/T90.
- Acceptance: resolve each currently unresolved package/version with source URL, exact version, license identifier and original text/provenance. If evidence cannot be proven, preserve explicit unresolved blocker; do not infer license from a newer release.
- Execute: first enumerate the exact unresolved items from current ledger; don't re-research already verified entries.
- Result writeback: evidence table, unresolved list, no release-gate weakening, report commit SHA.
