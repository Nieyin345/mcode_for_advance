# T13｜GenOffice 六原生编辑器功能与接线基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline; release/license risks are P0 where applicable
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T13-genoffice-baseline.md. Read source freely; do not edit GenOffice nested repo, patches, license notices, tasks/README.md, or other reports.
## Required Skills
- research: collect source-backed version, upstream, license and implementation evidence.
- code-review: verify each claimed integration against the real call path and tests.
- mcode-smoke: classify existing smoke evidence and avoid overclaiming GUI coverage.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, archived legacy T71/T76/T87/T89/T90/T92, and current T0/T7/T9/T11 cards.
- Goal: produce a six-editor matrix for Docs, Sheets, Slides, PDF, Markdown and HTML, grounded in the nested Git SHA and exact source paths.
- Execute: record outer Mcode HEAD, nested GenOffice HEAD/status and full outer git status; preserve all dirty state. For each editor map native UI, business/core packages, preload/Host bridge, open/edit/save/reopen, import/export, AI interactions, native resources/sidecars, existing tests, license provenance and U1 evidence. Read-only only.
- Acceptance: each of six formats has source path, actual integration path, proven behavior, missing/unknown features, tests and real U1 status; separate CLI/API success from GUI integration; list version-specific release blockers without changing any license policy; recommend next bounded tasks and non-overlapping file owners.
- Do not: edit nested GenOffice or license files, run destructive tests on user documents, or claim six-editor acceptance without real Electron evidence.
- Result writeback: report path, both Git SHAs/statuses, sources/commands inspected, U1 gaps, release blockers, commit SHA.
