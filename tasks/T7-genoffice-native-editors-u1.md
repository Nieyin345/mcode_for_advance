# T7｜GenOffice 六类原生编辑器真实 Electron U1 验收

- Status: ready-for-agent
- Category: bug
- Priority: P1
- Depends on: T0 stable; must run serially and exclusively with T8 because both need Electron UI
- Exclusive writable files: acceptance scripts/reports only unless a separately approved defect card is created; do not opportunistically patch product code.
## Required Skills
  - `mcode-smoke`: understand existing smoke evidence and keep E1 separate from U1.
  - `code-review`: classify any discovered defect without expanding this acceptance card.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, archived T71/T92 and current T0 result.
- Acceptance: execute real Electron journeys for Docs, Sheets, Slides, PDF, Markdown, and HTML; verify open/edit/save/reopen and native renderer tool path where applicable. Record environment and evidence; no simulated UI counted as U1.
- Execute: reserve Electron alone; if T0 is incomplete, stop and report dependency.
- Result writeback: per-editor PASS/FAIL/BLOCKED, evidence paths, build/commit SHA, defects split into new bounded cards.
