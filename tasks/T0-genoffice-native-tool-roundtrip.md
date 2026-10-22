# T0｜GenOffice 原生工具同轮往返接线

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: none (T83/T86/T98 protocol prerequisites are historical; revalidate current HEAD)
- Exclusive writable files: to be confirmed from current source call chain before editing; list exact paths in the result. Do not modify provider adapters, appControl/T49, GenOffice upstream, or patches unless this card is explicitly amended.
- Acceptance: a scoped Docs renderer tool call executes only in the bound trusted renderer and returns its result to the same SDK turn; test parallel A/B request binding, wrong sender/session/document/callId, duplicate/late ACK, cancellation, denial, and missing approval. Unknown operations fail closed.
## Required Skills
  - `mcode-smoke`: write isolated fake-IPC/renderer regressions and perform mutation verification.
  - `code-review`: review the final diff against this bounded integration contract.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T92/T83/T86/T98.
- Execute: inspect current HEAD and dirty state; confirm old-red behavior first; implement only the Host↔renderer↔same-turn seam; run focused smoke and mutation check.
- Do not: claim live online SDK or Electron U1 passes from fakes.
- Result writeback: implementation SHA, exact tests/results, mutation proof, remaining U1 limitations, commit SHA.
