# T10｜Node-RED 已核验许可证材料接入与发行门禁

- Status: ready-for-agent
- Category: bug
- Priority: P0 release blocker
- Depends on: prior T91/T88 evidence; verify exact current ledger before modifying files
- Exclusive writable files: only the dedicated Node-RED third-party notice/manifest integration paths and tests confirmed from source; do not touch GenOffice notices or shared release gate without explicit coordination.
## Required Skills
  - `research`: confirm the precise upstream package/version/license evidence.
  - `mcode-smoke`: run targeted release-readiness and notice validation checks.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, release ledger, archived T76/T88/T91.
- Acceptance: integrate only verified original license material (including pause@0.0.1 if still applicable); unknown license data continues to block release. Verify notice/manifest consistency and negative gate behavior.
- Execute: inspect current dirty state and exact source provenance first; do not overwrite unrelated release-readiness edits.
- Result writeback: verified source, touched paths, smoke results, unresolved blockers, commit SHA.
