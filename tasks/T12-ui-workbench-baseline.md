# T12｜UI 工作台现状与用户旅程基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T12-ui-workbench-baseline.md. Read all other files as needed but do not modify source, tests, audit-ledgers, tasks/README.md, or another report.
## Required Skills
- frontend-design: evaluate the actual shell and user journeys against the product direction; do not redesign by taste alone.
- code-review: distinguish source-backed behavior from assumptions and tests from real user-journey evidence.
- mcode-smoke: understand existing smoke evidence without treating headless results as Electron U1.
- domain-modeling: use the recovered product spec vocabulary consistently.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, relevant ARC-005/ARC-004 sections, and tasks/README.md.
- Goal: create a source-backed baseline matrix for the UI/workbench line, showing existing screens/modules, real main-to-renderer entry points, shared shell integration, existing tests, proven behavior, and uncovered U1 journeys.
- Execute: first record current HEAD and full git status; preserve every dirty/untracked file. Read-only investigation only. Cite concrete paths/functions/tests and evidence level. Separate implemented, partial, missing, and unknown. Map keyboard/focus, sessions, tabs/panes, terminal, diff, approval, GenOffice, Node-RED, memory and extension navigation.
- Acceptance: report includes (1) source/entry-point matrix; (2) prior evidence vs real Electron U1 gap; (3) top five blockers ranked by impact and dependency; (4) proposed next bounded implementation cards with candidate exclusive paths; (5) no claims based solely on screenshot/mock/headless tests.
- Do not: modify product code or tests; mark ARC complete; edit another task card; infer features from filenames alone.
- Result writeback: report path, HEAD observed, files inspected, commands/tests merely inspected vs actually run, exact blockers and commit SHA. If report is all that changed, state that clearly.
