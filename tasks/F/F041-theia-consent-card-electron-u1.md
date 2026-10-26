# F041｜Theia 安装同意卡真实产品 UI U1

- Status: ✅ implementation and acceptance complete. Implementation commit: pending until scoped commit is created.
- Depends: F023, F040, T16. Required Skills: `mcode-smoke`, `desktop-testing-electron`, `codebase-design`.
- Goal: 在真实 Mcode App 中打开生产 `ModuleSurface → VsixInstallSection → TheiaInstalledPanel`，通过真实产品 preload / `MODULE_THEIA_INSTALLED` IPC 验证 VSIX 预检、取消、风险告知和用户明确同意后的安装；不再只在 E1 纯函数层证明 consent policy。
- Exclusive write scope: `apps/desktop/scripts/electron-u1/build.mjs`, `apps/desktop/scripts/theia-native-u1/product-api-bridge.js`, `apps/desktop/scripts/theia-native-u1/journeys/product.ts`（只导出 F040 临时 fixture setup）、`apps/desktop/scripts/theia-native-u1/journeys/consent.ts`, `apps/desktop/src/main/modules/theiaHost/installConsent.ts`, `apps/desktop/src/renderer/components/modules/TheiaInstalledPanel.tsx`, `apps/desktop/scripts/theia-host-boot-smoke/main.ts`, this card, `tasks/F/README.md`, and a local append-only `DEV_CLAIM` event under ARC-006 in `audit-ledgers/Mcode_统一审查台账.md`. The ledger directory is intentionally ignored by `.gitignore`: preserve its local update, do not force-add it.
- Do not modify Theia IPC authorization, installed registry semantics, VSIX fixture source, user files, or any unrelated UI owners.

## Execution
1. Reuse F040's isolated temporary project, VSIX fixture, real product preload, real Theia handler registration and `useRealDb`; navigate the production Settings/Custom UI path and open the real `ModuleSurface` manager.
2. Use a narrowly gated test-only file-picker result to select the VSIX generated under the U1 temp project. The OS-native file dialog is explicitly out of scope; all `inspect`, `cancel`, and `install` calls must go through the real preload and production IPC.
3. Exercise inspect → visible consent card → cancel → card disappears and extension remains uninstalled; inspect again → consent remains unchecked and Confirm is disabled → explicit checkbox click enables Confirm → install succeeds and the real installed list shows the extension.
4. Verify the actual prompt includes the detected capability and evidence, the static-scan lower-bound disclaimer, and the “知情同意，不是沙箱” disclosure. The disclosure is rendered as plain React text, so remove Markdown `**` markers from its production string and add an E1 regression assertion that user-facing copy contains no raw Markdown markers.
5. Add an opt-in U1 bundle mutation `--theia-consent-mutation=unguarded` that changes only the in-memory bundled `TheiaInstalledPanel` guard from `disabled={busy||!approved}` to `disabled={busy}`. The normal production source must remain byte-identical; the mutation run must go red at the unchecked-confirm assertion.
6. Keep all generated VSIX/install/database data under the U1 temp root. Do not start the extension in this consent-only journey.

## Safety / non-goals
- The file-picker choice is fixture-backed, but the consent card, product component tree, preload API, IPC ticket and install operation are real.
- No real user VSIX, home-directory extension store, native file picker, packaged release, full shipped main-process boot, or runtime sandbox claim.
- Do not bypass the checkbox guard in production; mutation is a test-bundle-only opt-in control.

## Acceptance
- `node apps/desktop/scripts/electron-u1/build.mjs --registry=apps/desktop/scripts/theia-native-u1/journeys/consent.ts --prebuild=apps/desktop/scripts/theia-native-u1/product-prebuild.mjs --monaco-workers --only=product-theia-install-consent-ui`: 1/1 literal PASS.
- The test proves the real `ModuleSurface` / `TheiaInstalledPanel` is mounted, cancel leaves no installation, unchecked Confirm is disabled, explicit consent enables it, real IPC installs, and the list refreshes.
- `--theia-consent-mutation=unguarded` returns unexpected-failure at the unchecked-confirm guard; production source SHA before/after is identical; default U1 rerun is green.
- `theia-host-boot-smoke`, `theia-installed-smoke`, dual TypeScript checks, default `ui-project-switch` U1, and scoped `git diff --check` pass.
- Record both green/red evidence paths, production source SHA, commit SHA and the remaining dialog/full-app limits.

## Verification result

- Product consent U1: **PASS 1/1** — `.tmp/electron-u1/2026-10-26T09-09-25-125Z/`. Covers real production `ModuleSurface` / `TheiaInstalledPanel`, picker fixture limited to the isolated temp VSIX, real `MODULE_THEIA_INSTALLED` preload IPC for inspect/cancel/install, visible risk disclosure/evidence, cancellation without installation, unchecked Confirm disabled, explicit checkbox enables Confirm, successful install and list refresh.
- Mutation control: expected red at `confirm-install-disabled-until-explicit-checkbox` — `.tmp/electron-u1/2026-10-26T09-08-49-335Z/`; only the in-memory bundle was mutated. Production `TheiaInstalledPanel.tsx` SHA-1 before/after: `1e9082fbef5dea1f36293741e69b00498e5b5858`.
- Restored/default consent U1 rerun: **PASS 1/1** after the mutation run.
- `theia-host-boot-smoke` and `theia-installed-smoke`: **2/2 PASS**; both Desktop and contracts TypeScript checks: **PASS**; default `ui-project-switch` U1: **PASS 1/1**; scoped `git diff --check`: **PASS**.
- Product copy no longer contains raw Markdown `**`; `theia-host-boot-smoke` asserts this regression explicitly.
- Limits remain intentional: native OS picker, packaged release, full shipped main-process boot and runtime sandbox are not claimed. The U1 uses a picker fixture for the temporary VSIX only; inspection, cancellation and installation still pass through the real preload/production IPC.
