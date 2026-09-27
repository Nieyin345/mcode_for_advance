# Module workflow wiring smoke (task 05)

Run from the repository root, using installed dependencies only:

```sh
node apps/desktop/scripts/run-smokes.mjs module-workflow-smoke
node apps/desktop/scripts/module-workflow-smoke/build.mjs
node apps/desktop/scripts/module-workflow-smoke/build.mjs --save-guard
node apps/desktop/scripts/module-workflow-smoke/verify.mjs
```

`run.sh` runs the wiring checks **and** the strict save/import sentinel. The latter
is intentionally an integration blocker until task 01 adds the frozen parameter
schema to the shared validator. Do not remove the assertion or loosen it to make
an incomplete integration green. See `docs/parallel-ui-modules/task-05.md`.

## What is real

- Production builtin manifests, both executor registration expressions, the input
  builder registry, variable resolution, scheduler, executor, module service,
  ModuleHost and real file capabilities.
- Real main module IPC handlers and real preload. Electron's transport is a
  structured-clone test harness; this is **not** an Electron window test.
- Real web API rejection, workflow import/export validator and review/replay guard.

The run-scoped engine/input/preflight expressions are extracted from `runner.ts`
with the installed TypeScript AST parser. This avoids importing the real session
manager or database, and avoids handwritten copies of the registration chain.
`runnerPath.ts` fails closed when run without that extraction.

## Isolation and activation

Every invocation writes a unique `apps/desktop/.tmp/module-workflow-*/` directory,
with phase-specific workspace/data roots, output logs, assertion JSON and an exit
status/source-hash manifest. Only the known-workspace lookup, data-root location,
review-marker storage, unrelated plugin/library catalog sources and Electron IPC
transport are replaced. Shell execution fails closed. No model, user database,
user workspace file, app window, dependency install, or network access is used.

When the native contracts gate is closed, `build.mjs` runs two labelled phases:

1. `native-closed`: assert the real scheduler refuses dispatch.
2. `fixture-open`: add the kind **only to the temporary esbuild bundle**, then run
   the real scheduler/registration/input/host chain. Production files are untouched.

When task 01 activates production, the same script runs `native-open` instead.
The fixture-open result is not evidence of production activation or full Electron
end-to-end acceptance. No full smoke run or frozen repository snapshot is claimed.

## Red-light evidence

```sh
node apps/desktop/scripts/module-workflow-smoke/build.mjs --baseline
node apps/desktop/scripts/module-workflow-smoke/build.mjs --mutation-fallback
node apps/desktop/scripts/module-workflow-smoke/build.mjs --mutation-identity
```

`--baseline` targets the three behaviors that were absent before task 05 and is
now expected to pass. Both mutation commands are expected to fail: they alter only
the temporary test bundle (restore model fallback / remove the dispatch nonce),
never production source. A build/start error is a harness failure, not a valid
behavioral red light.
