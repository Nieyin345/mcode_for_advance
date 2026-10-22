# T15｜通用 Agent、Provider 与 Host 能力基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T15-agent-host-baseline.md. Do not modify Provider, IPC/contracts, appControl, memory, terminal, Git services, tests, tasks/README.md, or other reports.
## Required Skills
- codebase-design: identify deep module boundaries and the narrow shared interfaces that unblock multiple product lines.
- code-review: verify actual caller-to-handler-to-effect paths and fail-closed semantics.
- research: check official SDK/source/version facts where the repository does not establish them.
- mcode-smoke: classify existing E1/E2/U1 evidence accurately.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, and relevant ARC-001/002/003/006/MC-035/036 entries.
- Goal: map the general-purpose substrate that must serve UI, GenOffice and Node-RED without hardcoding the scientific-report scenario.
- Execute: record current HEAD and full Git status; preserve all dirty files. Trace native SDK loops and Provider adapters; capability discovery/call APIs; IPC/preload/Host; project/file identity and version/CAS; Git and terminal; approvals/permissions; sessions/tasks; memory/library; automation and extension host; runtime environment selection. Read-only investigation only.
- Acceptance: a capability matrix labels each area implemented/partial/missing/unknown, cites exact source path and caller chain, records tests and evidence grade, identifies cross-cutting blockers and shared-file contention, and proposes no more than five next implementation cards ordered by dependency and leverage.
- Do not: implement an alternative Agent loop, silently switch providers, propose AI-driven environment scheduling (user selects environment), or claim a capability from a catalog entry alone.
- Result writeback: report path, HEAD/status, exact evidence and remaining unknowns, proposed cards, commit SHA.
