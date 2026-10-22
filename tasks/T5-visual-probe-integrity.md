# T5｜UI 视觉探针假阳性收敛

- Status: ready-for-agent
- Category: bug
- Priority: P1
- Depends on: none; does not authorize real Electron session ownership
- Exclusive writable files: visual-probe assertions and dedicated fixtures only; list exact paths before edit.
## Required Skills
  - `mcode-smoke`: make probe fail when real product content is absent or replaced by fixtures.
  - `code-review`: check assertions are discriminative rather than merely present.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, relevant ARC-005 ledger entries, archived T78/T95.
- Acceptance: tests distinguish real content, fixture-only content, missing content, and wrong container; demonstrate old-red/new-green. DOM/E1 only—do not claim Electron U1.
- Execute: confirm current probe false-positive modes and add negative controls.
- Result writeback: assertions, negative controls, tests, commit SHA, deferred U1 cases.

## 结果回写（2026-10-23，总控验收）

- **结果**：视觉探针假阳性已收敛。`arc005-visual-baseline/probe.ts` 里内联的场景断言与选择器表被抽到 `probe-assertions.ts`，并新增三态判定 `real` / `fixture-only` / `wrong-container` / `missing`；`settings` 从 `header` 兜底改为精确选择器。
- **实现范围**：`apps/desktop/scripts/arc005-visual-baseline/probe.ts`（改为调用外部断言模块）、新增 `apps/desktop/scripts/arc005-visual-baseline/probe-assertions.ts`（319 行）、新增 `apps/desktop/scripts/t5-visual-probe-integrity-smoke/`（`fixtures.ts` 197 行 + `main.ts` 301 行 + `run.sh` 11 行）。
- **动态证据 E1**：`bash apps/desktop/scripts/t5-visual-probe-integrity-smoke/run.sh` → `27/27 PASS`。覆盖真实 composer / fixture textarea / 容器外 composer 三态区分、tool row 的 rail lookalike 拒绝、settings header 兜底拒绝、diff/sidechat/narrow-window 的 fixture-only 与缺内容区分。
- **变异验证**：把 `probe-assertions.ts` 里 5 处 `"wrong-container"` 全部改写成 `"real"` 后重跑 → `22/27 PASS`，**5 条红**，分别是 settings header lookalike、composer 容器外、tool rail lookalike、message 容器外、tool scene 仅 rail lookalike。随后从备份**逐字节还原**（`cmp` 确认相同），重跑 `27/27 PASS`。
- **证据边界**：本套件是**无头 DOM E1**（`main.ts` 零处引用 electron，跑在 `node:vm` 的合成文档上），**不是真实 Electron U1**。T5 卡要求的正是 DOM/E1 边界，故判据达成。
- **未做**：真实 Electron 下逐屏视觉对照仍属 ARC-005 V4，不在本卡范围。
- **提交 SHA**：`d250a159`
