# P2-06 independent integration probes — not full E2E approval

Run from repository root: `node apps/desktop/scripts/module-phase2-e2e-smoke/build.mjs`.
The regular smoke runner discovers `run.sh` without configuration changes.

This preparatory suite is intentionally non-green while production integration is incomplete:

- PASS segment = real ExecutionEngine/registry + ModuleCapabilityExecutor + service + ModuleHost + real file capabilities, with test-owned registry composition and schema-checked execution input. **Not** production scheduler input construction.
- Lifecycle tests use real host tasks and timing wrappers, not fabricated success replies.
- Missing-executor fallback and exported production registry are executable independent assertions, not grep checks. Fake fallback never calls a model.
- BLOCKED = full runner/scheduler/dispatch identity/UI chain has not been independently exercised. Exit 2 if only this blocker remains; exit 1 if assertions fail. Never turn this into an unconditional success or skip.
- dataRoot and known-root lookup alone are redirected to unique test directories. No real user DB, models, Electron instance or network.

## After task 05 is ready (06/07 integration handoff)

Replace the terminal BLOCKED record **only after** adding and running the following against the actual task-05 exports (do not guess production interfaces now):

1. Both production registration paths, including run-scoped runner path; fail closed with no executor and keep old runner behavior.
2. Real builtin catalog -> real parameter/variable builder -> scheduler -> engine -> real singleton host -> file -> downstream outputs.
3. Same dispatch transport replay uses one task; loop next round, explicit retry and resume dispatch produce new IDs, including failed attempts (not rounds-based).
4. Persist/reopen/import configuration through isolated repositories; imported workflow does not auto-enable.
5. Browser directory errors/no targets/stale selections, configure-save-reopen, real result/cancel rendering; test profile only.
6. IPC/preload/mobile must not expose invokeForWorkflow. Run existing wiring/parity checks.
7. Electron real-window acceptance remains separate and requires isolated data/profile; no automatic restart of the user's app.

Logs/JSON and source SHA-256 inventory are written to `apps/desktop/.tmp/p2-06-e2e-*/`. Active tree, not a frozen candidate. UI fixture-suite reruns are separately recorded in task-06.md, not relabeled as full E2E.
