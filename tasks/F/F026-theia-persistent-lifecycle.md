# F026｜Theia 持久扩展管理与重启恢复

- Status: done (E1 persistent install + IPC + true Theia child; Electron U1 and packaged runtime not covered)
- Depends on: F022/F023/F024/F025
- Scope: Theia Node VSIX persistent lifecycle (not legacy L1, not Electron U1)
- Required Skills: mcode-smoke, codebase-design
- Exclusive edits: `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts` (new), `apps/desktop/src/main/ipc/theiaInstalled.ts` (new), `apps/desktop/src/main/ipc/index.ts` (wiring), `packages/contracts/src/ipc/modules.ts`, `packages/contracts/src/ipc/rpcMap.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/lib/webApi.ts`, `apps/desktop/src/renderer/components/modules/VsixInstallSection.tsx`, `apps/desktop/src/main/appControl/policy.ts`, generated API catalog + permission mapping, `apps/desktop/scripts/theia-installed-smoke/` (new), this card and `tasks/F/README.md`.
- Preserve all unrelated dirty changes; never reset, clean, broad-stage, or edit workflows / GenOffice / chat UI.
- Storage: `dataRoot()/theia-extensions` only. Tests inject isolated temporary root. Never auto-execute persisted extensions on app startup. A separate user interaction starts installed code.
- Safety: two-phase scan / one-use ticket + same desktop sender / explicit approval; reject malformed or unsafe VSIX via F025 parser. Each saved extension immutable until uninstalled, strict record validation, content hashes on startup, reject symbolic links/hard links, atomic rename to installed folder. Empty / corrupted entries not auto-healed or silently trusted.
- Target: E1 true Theia child spawn / execute / stop / uninstall; no claims of sandbox, packaged release, Electron UI U1, full VS Code API, or Monaco editor integration.


## Implementation / acceptance evidence

- Managed root: \`dataRoot()/theia-extensions/installed/<uuid>\`; independent from the existing \`ModuleHost\` catalog. Each install has a bounded record with SHA-256 for every executable/data file. Before start, the registry rejects missing/changed/unexpected files, symlinks and hardlinked payloads.
- Installation: safe F025 VSIX parser → stage → static capability report → one-use, sender-scoped consent ticket → atomic directory rename. Existing publisher/name cannot be silently replaced. Staged approvals are not recovered after crashes.
- On application restart: enumerate installed entries **as metadata only**; never auto-start. User explicitly starts from a dedicated UI and can run registered commands, stop, disable, enable, and uninstall. Starting/active extensions cannot be disabled or removed mid-flight; windows losing ownership trigger host cleanup.
- Desktop RPC: \`modules.theiaInstalled\` is \`blocked\` and \`mutating\`, and generator output is \`APP_METHOD_PERMISSIONS["modules.theiaInstalled"] = null\`. Web/Agent cannot delegate it.
- E1 smoke: \`theia-installed-smoke\` **44/44 PASS** using isolated temp root and real Theia child. Includes installation persistence, no auto-execute after manager recreation, tamper-detection, disabled rejection, command roundtrip, uninstall, explicit consent, cross-sender and destroyed-window IPC checks.
- Joint regression: **9/9 PASS**, \`apps/desktop/.tmp/smoke-runs/1792902211398-43028-i1OAxT/\`. The suite set is \`theia-installed-smoke\`, \`theia-vsix-preview-smoke\`, \`theia-host-boot-smoke\`, \`module-platform-smoke\`, \`module-permissions-smoke\`, \`module-workflow-smoke\`, \`app-control-smoke\`, \`ipc-wiring-smoke\`, \`extension-honesty-smoke\`.
- \`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json\` and \`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json\`: **PASS**.
- Test-only maintenance: \`extension-honesty-smoke\` excludes generated \`apiCatalog.generated.ts\` prose (not a true L1 bridge runtime caller); still checks actual source imports/callers.
- Exclusions: no Electron real-window U1, no packaged Theia runtime/bundling, no full Monaco/editor integration, no sandbox, no automatic startup of third-party extensions. Corrupt installations currently fail closed and require manual repair/cleanup; they are not silently trusted or automatically deleted.
- F026 代码提交 SHA: `70160262`（15 个独占文件精确提交，不含任何并行任务的未提交变更）；文档与索引另行提交。
