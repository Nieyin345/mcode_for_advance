# F040｜产品 FileEditor + 真实 preload/VSIX 的扩展语言 U1

- Status: ✅ implementation and acceptance complete (commit SHA recorded in the F registry after the scoped implementation commit).
- Depends: F039, T16 (Electron U1), F026/F038. Required Skills: `mcode-smoke`, `desktop-testing-electron`, `codebase-design`.
- Goal: 从真实产品 `App.tsx` 打开真实 `FileEditor.tsx`，使用产品 preload、真实 `MODULE_THEIA_INSTALLED` IPC 和临时安装的真实 VSIX，完成 Rename / Code Action 用户旅程；不以独立 Monaco 页面代替产品编辑器。
- Exclusive write scope: `apps/desktop/scripts/electron-u1/build.mjs`, `apps/desktop/scripts/theia-native-u1/product-api-bridge.js`, `apps/desktop/scripts/theia-native-u1/product-prebuild.mjs`, `apps/desktop/scripts/theia-native-u1/product-runtime.ts`, `apps/desktop/scripts/theia-native-u1/journeys/product.ts`, `tasks/F/F040-native-fileeditor-real-vsix-u1.md`, `tasks/F/README.md`, and one append-only `DEV_CLAIM` event under ARC-006 in `audit-ledgers/Mcode_统一审查台账.md`. Do not modify production UI owners, unrelated preload/main modules, vendor sources, or other tasks.

## Execution
1. Add an opt-in `--monaco-workers` mode to the existing U1 build. Bundle the same five worker entry points used by production `monacoSetup.ts`; keep existing journeys' stub/default behavior unchanged.
2. In the real App U1 only, route the test App's `labApi.modules.theiaInstalled`, `labApi.on.theiaContributionChanged`, and `labApi.file.readFile` through the real preload API. All other unrelated App API surfaces remain fixture-backed and network access stays disabled.
3. Register the production `registerTheiaInstalledHandlers` through `createDbGuardedIpc` in the U1 main process, with the U1 temp data root and built vendor Theia. Use `useRealDb` so file reads are protected by the actual workspace path guard.
4. Package the existing `spawn-ext` VSIX fixture into a one-off VSIX inside the U1 temp project; install with explicit test approval; start it against the temp project workspace; then open the temp `.txt` in the actual product FileEditor.
5. Exercise real F2 prepareRename, text replacement, undo, Ctrl+. Quick Fix, apply, undo, provider refusal or safe failure, and explicit extension stop. Verify both visible Monaco text and actual provider metadata.
6. Record worker creation/errors and fail if the editor silently falls back to main-thread workers in this mode.

## Safety / non-goals
- All data, VSIX archive, installed extension storage, and database live under the Electron U1 temp directory. Do not touch user projects or installed user extensions.
- The VSIX consent card UI itself is not part of this slice: the test explicitly supplies the accepted confirmation to the real IPC API. Do not claim install-consent U1 coverage.
- Other unrelated App IPC endpoints remain fixture-backed; this is a production FileEditor + real Theia extension IPC slice, not a full launch of the complete shipped main process.
- Do not add npm dependencies, bypass sender/frame checks, or change extension security policy.
- If actual workers cannot load, preserve the failure evidence and fix the test bundle/CSP rather than restoring the worker fallback.

## Acceptance
- `node apps/desktop/scripts/electron-u1/build.mjs --registry=apps/desktop/scripts/theia-native-u1/journeys/product.ts --prebuild=apps/desktop/scripts/theia-native-u1/product-prebuild.mjs --monaco-workers --only=product-fileeditor-real-vsix-rename-fix`: 1/1 literal PASS.
- Evidence confirms real product `FileEditor` DOM, product preload API, actual `MODULE_THEIA_INSTALLED` request, real Theia session/provider descriptors, successful prepareRename placeholder/range, Quick Fix edit, undo, and clean stop.
- Worker evidence includes at least one successfully constructed same-origin worker and zero worker errors/fallback warnings.
- `theia-installed-smoke`, `theia-palette-smoke`, `theia-host-boot-smoke`, dual TypeScript checks, and `git diff --check` pass.
- Mutation verification: deliberately corrupt the fixture's prepareRename placeholder or Code Action text and demonstrate the product U1 goes red; restore exact bytes/hash and rerun green.
- Commit only this card's declared scope; record SHA, logs/evidence paths, and any unresolved product/full-app limits.

## Verification result

- Product U1: **PASS 1/1** — final evidence: `.tmp/electron-u1/2026-10-26T07-41-59-854Z/product-fileeditor-real-vsix-rename-fix/`. It records real same-origin module workers, zero worker/fallback warnings, real preload file read + contribution event, valid prepareRename range/placeholder, Rename/Quick Fix edits and undo, zero rejected preload calls, and confirmed extension stop.
- Mutation control: **expected red** at `real-provider-prepare-rename-range-and-placeholder` — evidence: `.tmp/electron-u1/2026-10-26T07-40-43-121Z/product-fileeditor-real-vsix-rename-fix/`. The mutation changes only the extension source copied into the U1 temp VSIX; repository fixture SHA-256 remained `585e2aca38b3c36fac27de4748739975f1880007a8a7e9d15645eb2526588d35` before and after.
- Restored/default product U1 rerun: **PASS 1/1** after the mutation control.
- Existing U1 compatibility: `ui-project-switch` **PASS 1/1** without `--monaco-workers` — evidence: `.tmp/electron-u1/2026-10-26T07-26-05-047Z/ui-project-switch/`.
- `theia-installed-smoke`, `theia-palette-smoke`, `theia-host-boot-smoke`: all **PASS**. Dual TypeScript checks and `git diff --check`: **PASS**.
- Worker evidence: at least one production Monaco worker constructed, zero worker error events; final run emitted no Theia IPC rejection. Explicit extension stop returned `stopped`, and a subsequent list confirmed the session was no longer running.
- Limits are intentional: this slice does not test the consent-card UI and does not boot every unrelated production IPC surface; those remain outside the declared F040 scope.
