# T1｜Worktree merge-back ownership 探测失败时 fail-closed

- Status: ready-for-agent
- Category: bug
- Priority: P0 security/data integrity
- Depends on: none
- Exclusive writable files: first verify current code; intended narrow boundary is `apps/desktop/src/main/lib/worktreeOps.ts` and its dedicated regression smoke only. Do not touch unrelated dirty files.
- Acceptance: ownership probe error, missing metadata, stale identity, and deleted/recreated worktree never authorize merge-back; valid owner still works. Test using a temporary fake Git repository.
## Required Skills
  - `mcode-smoke`: add isolated regression and demonstrate old-red/new-green.
  - `security-best-practices`: assess fail-open ownership and data-integrity consequences.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T99/T101/T105.
- Execute: prove whether `.catch(() => true)` or equivalent remains on current HEAD; if already fixed, do not reimplement—record evidence and stop. Otherwise patch narrowly.
- Result writeback: commit SHA, exact tests, mutation evidence, and whether identity-generation redesign remains separately needed.


## 结果回写（2026-10-22）

- **结果**：已修复 merge-back ownership fail-open；未改其他对话的既有 dirty 文件。
- **开工基线 HEAD**：`813c15400e5ec5231abe98d0cfe7158b5b884490`。开工工作区有多项既有修改（`.aoci/baseline.json`、`.gitignore`、其他 smoke、`apiCatalog.generated.ts`、`settingsTransfer.ts` 和未跟踪项）；本任务未触碰它们。
- **实现范围**：`apps/desktop/src/main/lib/worktreeOps.ts` 的 `mergeBackWorktree`；`apps/desktop/scripts/maint-m10-smoke/main.ts` 回归夹具。ownership list probe 异常现在拒绝；另验证 live checkout 的 `--git-common-dir` 与 owner 仓库一致，防止同路径被删除并重建为另一仓库后仅凭 porcelain path 被误认。
- **动态证据 E1**：`node apps/desktop/scripts/maint-m10-smoke/run.cjs` — PASS，28 passed / 0 failed。覆盖未注册/缺失元数据路径、ownership probe 报错且外部 dirty 文件未被提交、同路径删除并重建为另一仓库且其 dirty 内容未变、合法 worktree 仍可 merge-back。夹具只使用临时 Git 仓库。
- **变异验证**：将 common-dir identity 比较变异为 `if (false)` 后重跑同一命令 — 预期失败，27 passed / 1 failed；失败断言为“重建仓库的未提交内容保持原样”，证明测试可抓住 stale-identity 授权。已恢复原实现并再次跑绿（28/28）。
- **静态/类型验证**：`git diff --check` PASS；`npx tsc --noEmit -p apps/desktop/tsconfig.json` PASS；`npx tsc --noEmit -p packages/contracts/tsconfig.json` PASS。Git 输出仅有既有 `settingsTransfer.ts` CRLF 提醒；smoke 有临时仓库的 LF/CRLF 警告，不影响结果。
- **身份代际重设计**：仍需单独评估/设计。当前 live common-dir 校验可拒绝同路径被替换成其他仓库，但无法区分“同一父仓库下旧 worktree 被移除、随后在同路径重新创建”的新旧代际；若要彻底拒绝旧身份重占，需持久化 generation/identity 并贯穿创建、登记和 merge-back。
- **剩余验收**：实现和隔离动态回归已通过；尚未完成上述身份 generation redesign，也未做真实 Electron/U1 验收。
- **提交 SHA**：由总控在 T1 回写核对后补记（见下方「总控补记」）。

## 总控补记（2026-10-23）

- 执行对话交付的实现与回归已由总控**独立复跑**：`node apps/desktop/scripts/maint-m10-smoke/run.cjs` → `28 passed, 0 failed`，与回写一致。
- 执行对话漏做最后一步（提交），按用户 2026-10-23 决定由总控代为精准提交：只提交本卡的三个文件（`worktreeOps.ts`、`maint-m10-smoke/main.ts`、本卡），不带入工作区其他 dirty 文件。
- 按「写回即完成」规则，T1 记为**已完成**；回写里列出的两项遗留（身份 generation 重设计、真实 Electron/U1）不属本卡判据，需另开卡。
- 提交 SHA：`2d31f675`（只含本卡三个文件）
