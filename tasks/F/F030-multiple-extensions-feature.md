# F030｜扩展功能优先：多 VSIX 运行与离开设置页不中断

- Status: done (multi-VSIX E1 tested; shared host and true Electron U1 remain unfinished)
- Dependency: F029.
- Owner: F extension track; Required Skills: mcode-smoke, codebase-design.
- Exclusive files: `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts`, `apps/desktop/src/renderer/components/modules/TheiaInstalledPanel.tsx`, `apps/desktop/scripts/theia-installed-smoke/main.ts`, `apps/desktop/scripts/theia-palette-smoke/main.ts` (if needed), this card, `tasks/F/README.md`. Preserve unrelated dirty files.
- Goal: user-requested feature completeness ahead of standalone optimization. Keep functionality native to existing Mcode UI and low idle overhead.
- Acceptance:
  1. Install 2 distinct VSIX packages, explicitly activate both with real Theia child processes; separate sessions & commands, stop one does not stop another; duplicate start rejected; unknown/other sender session rejected.
  2. Bounded concurrent activation (budget explicit), no background polling or startup auto-activation. A Mcode settings panel unmount must *not* stop extensions; explicit stop and window destroyed still do.
  3. The Mcode installed extension list and command palette show each running extension; UI can stop/manage independently.
  4. Cross-sender isolation for document sync, execution, stop; do not allow remove/disable while running.
  5. Focused E1 tests; dual typechecks; diff check; retain every other conversation's work.
- Not yet complete: Main RPC service coverage, persisted permission consolidation, extension-point contributions, real Electron U1, runtime packaging, multi-extension shared worker, performance certification, runtime sandbox.


## Result / verified evidence

- A registry now owns a `Map<installationId, Running>`, rather than a single `Running|null`. Native session ids resolve to exactly one running installation; `editorSync`, `execute` and `stop` remain sender-scoped. `setEnabled` and `remove` refuse to mutate any active/starting installation.
- At most 8 independent installed Theia hosts may be active concurrently, and host spawning remains serialized to avoid simultaneous fork spikes. **This is a temporary protective bound, not shared host reuse nor a measured optimal resource cap.**
- Native installation panel shows each owned live session's actual command list with per-extension selection/result state. Navigating away no longer stops an installed extension; only explicit Stop/window destruction/app shutdown cleans up the owned child process. Pending inspect ticket is still revoked on panel teardown. Mcode Ctrl/Cmd+K retains live commands across navigation.
- `theia-installed-smoke` uses two distinct synthetic VSIX archives with different publisher/name identity, truly forks two different Theia child processes and verifies both execute registered commands, independent stop/uninstall/owner isolation. **69/69 PASS**.
- `theia-palette-smoke` now also checks native panel lifecycle source assertions (no stop in React teardown, per-extension stop, no interval). **28/28 PASS**.
- Final focused regression: **12/12 suites PASS** at `apps/desktop/.tmp/smoke-runs/1792913553270-33316-RFdAUB/`; both `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` and `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` **PASS**.
- No changes to Theia vendor source or dirty files owned by other execution conversations.
- **Remaining feature completeness blockers**: high-fidelity Main RPC integration with native Mcode workspace/FS/terminal/progress/notifications/diagnostics/webview/debugger; extension manifest contributions, settings and activation events; multi-root workspace and live editor document events; version upgrades and recovery policy; packaged runtime; real Electron U1. Runtime has no OS sandbox; installation-stage consent does not imply runtime isolation. No claims about memory/latency yet.
- Code SHA: `d0902af2` (four F030-specific files staged and committed, unrelated dirty state untouched); documentation SHA in follow-up commit.
