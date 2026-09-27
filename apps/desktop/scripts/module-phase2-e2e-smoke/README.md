# P2-06: independent probes and isolated native feature integration

Run from the repository root:

```sh
node apps/desktop/scripts/module-phase2-e2e-smoke/build.mjs
node apps/desktop/scripts/module-phase2-e2e-smoke/native-build.mjs
node apps/desktop/scripts/module-phase2-e2e-smoke/verify-native-mutations.mjs
```

`run.sh` enters the composite build through the normal dynamic smoke runner.
Existing dependencies, Electron and Chrome/Edge are required; no install or download fallback. Linux needs a working display (or an explicitly supplied Xvfb environment) for native window checks.

## Completion gate, not a removed blocker

The original nine segment/lifecycle/registration/fail-closed assertions remain intact. They cannot grant full E2E approval on their own. The old unconditional BLOCKED record has been replaced by an assertion over **fresh child executions in this same build**:

1. `native-build.mjs`: real Electron `BrowserWindow`, unchanged preload and module/workflow IPC, actual AutomationRunner -> runner -> scheduler -> builder -> executor -> lazy service -> ModuleHost -> real files; configuration save, templates, downstream hash-derived path, explicit rerun, import review/revision checks, user-module denial, native result cards/menu/cancel, then a **new Electron process** reopening the actual SQLite DB and manifest store.
2. Task-05 production workflow suite: native-open only, both engine constructions, absent executor, lazy service, existing input registry, schema checks, variable resolution, same-input replay/new dispatch, loop, failure retry/resume and cancellation; IPC and mobile boundary tests. The run-scoped registration expression here is an AST extraction, distinct from the full real runner exercised in the native window.
3. Task-05 shared save/import sentinel: real shared validator, three frozen-call rejection cases.
4. Task-04 catalog browser suite: real components + transport fixture, error/retry, no targets, stale selection, forbidden-field cleanup, locale and metadata behavior. It is not presented as database or native IPC evidence.

`main.ts` without a completion receipt remains BLOCKED (exit 2). Any assertion/composite failure is nonzero. Successful native acceptance requires **both** exit 0 and complete PASS receipts (create >=12, reopen >=7, terminal no-model/no-exception/no-network check). Closing the last Electron window is prevented from supplying an implicit false-green exit.

## Native isolation and explicit seams

- Set unique `home`, `userData`, `sessionData`, logs, crash dumps and temp directories **before** importing the storage/service bundle. A private `data-root.json` points at the isolated root. HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP are redirected for child processes too.
- Initialize the real sql.js database, repositories, workflow library/trust, actual node catalog, automation runner and workflow runner. No user DB or user application instance is opened; no main application single-instance lock is acquired.
- `native-ports.ts` replaces only agent/provider execution and application-window bootstrap. Agent calls fail loudly and are counted. Its event port forwards production runner events over real Electron IPC. The auxiliary project-list bootstrap reader queries the real isolated ProjectRepo.
- Module, workflow and resource authorization code is not mocked. The host invocation spy records identities, then delegates unchanged to the real method. No fabricated bytes/hash/outcome or fake save acknowledgement.
- The cancellation UI timing fixture is explicitly registered only in the private host; it returns no successful file result. Real file IO/cancellation races are separately covered by the original safety/lifecycle suites.
- Hidden but rendered BrowserWindows are driven through native `webContents` input. PNG capture warms the compositor and waits two animation frames plus a paint interval; matching DOM text is saved alongside each image. This is automated feature-window acceptance, **not** full installed-app/manual acceptance, native BrowserView occlusion, or actual FileTree/FilesPanel integration.
- All page network requests and permission prompts are denied. Unrelated editor workers throw if used. No real model calls, dependency installation, or user-app restart.

## Negative controls

`verify-native-mutations.mjs` verifies intended failures, not merely a nonzero command:

- `--mutation-save`: remove only the shared strict guard from a temporary bundle. The actual native save IPC accepts forged fields, so the native unsafe-save assertion must fail (child exit 1).
- `--mutation-early-exit`: the isolated Electron child deliberately exits 0 before tests. The parent must still fail because assertion receipts are absent.

Neither mutation edits production sources. Historical red/fixture failures remain in task-06.md, including the discovered implicit-exit harness problem; their old exit 0 is not acceptance evidence.

## Artifacts

- `.tmp/p2-06-e2e-*`: composite stage logs, `integration-receipt.json`, original probe output/checks and result status.
- `.tmp/p2-06-native-*`: source SHA-256 inventory, build logs, per-process logs/checks, identity traces, SQLite/module data and screenshots; failure HTML/PNG where available.
- `.tmp/p2-06-native-controls-*`: intended red logs and verified negative-control result.

Ordinary runs test the active tree. Task 07 additionally runs these in a sealed candidate and records its HEAD/tree/source hashes. Native fixtures intentionally preserve diagnosis; only their own processes are closed, with no system-wide Chrome/Electron cleanup.
