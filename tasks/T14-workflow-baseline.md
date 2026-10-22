# T14｜Node-RED 唯一工作流内核现状与迁移基线

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline; data-loss/duplicate-execution findings escalate as P0
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T14-workflow-baseline.md. Do not modify workflow implementation, tests, release/license gates, tasks/README.md, or other reports.
## Required Skills
- research: establish exact Node-RED version/source and evidence for upstream behavior.
- code-review: follow flow state, storage, deploy and trigger ownership paths.
- mcode-smoke: interpret existing migration/deploy regression evidence and identify missing negative controls.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, archived T72/T77/T85/T93/T94/T97 and active T2/T3/T4/T8/T10 cards.
- Goal: document how Node-RED editor-client/runtime/registry/nodes are actually integrated and where Mcode still has duplicate or competing workflow/automation state.
- Execute: record current outer HEAD/status and exact upstream/fork source SHA/version; preserve dirty state. Trace flow import/migration fields, IDs/wires/tabs/metadata, persistence, deploy/restore, runtime execution, trigger owner, old AutomationRunner overlap, Node/extension entry points, permissions and real Electron evidence. Read-only only.
- Acceptance: provide field-level old-flow-to-Node-RED migration matrix; single-source-of-truth diagram; failure/recovery and duplicate-trigger matrix; exact source/test evidence; U1 gaps; top bounded implementation slices with non-overlapping candidate file paths.
- Do not: change workflow source, execute live user automations, or claim Node-RED is the only runtime merely because the UI loads.
- Result writeback: report path, source SHAs, inspected commands/tests, blockers and commit SHA.
