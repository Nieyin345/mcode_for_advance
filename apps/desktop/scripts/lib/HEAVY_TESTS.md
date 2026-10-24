# Mcode heavy UI test budget (ARC-005 / test-runner resource guard)

Mcode's shared Windows workstation runs multiple AI conversations. An Electron U1
test can allocate >1 GB in esbuild and more in renderer processes. Passing smoke
tests must not require the rest of the user's desktop to freeze.

## Protected entrypoints

- `node apps/desktop/scripts/run-smokes.mjs <suite>`: default **one light
  suite**, **one heavy suite**; the light pool completes before the heavy pool.
  Electron/browser suites are recognized from source, not just `withAuditPage`.
- `apps/desktop/scripts/electron-u1/build.mjs`: locks *before* importing
  esbuild or launching any real Electron journey. All wrappers that reuse this
  builder benefit from the guard.
- `apps/desktop/scripts/arc005-pane-electron-smoke/build.mjs`: uses the same
  admission lock.
- `electron-u1/build.mjs`: launches Electron with `runOwnedProcess`, which
  terminates the **owned process tree** on timeout, output overflow, SIGINT
  or SIGTERM, and bounds captured output to 32 MiB.

The lock is `apps/desktop/.tmp/mcode-heavy-test.lock/owner.json`. It is **not**
the product's runtime lock. It stores a PID, unique token, label and start
time; it contains no user data. Contention **fails fast** with the current PID.
Nested suites inherit `MCODE_HEAVY_TEST_TOKEN` and validate that the parent
still owns the lock. Normal exit removes only its own lock. A valid dead
owner's lock can be reclaimed. A missing or corrupt owner is deliberately
**not** auto-deleted, because another process may still be initializing it.

## Adding new standalone U1 builds

Import `guardHeavyTestProcess` from `scripts/lib/heavy-test-lease.mjs` and call
`guardHeavyTestProcess(desktop, "your-test-label")` **before starting esbuild or
Electron**. Use the same `desktop` path (the `apps/desktop` folder). Do not
implement a second independent semaphore; do not set or spoof the nested
lease token manually.

Prefer routing suites through `run-smokes.mjs`; direct scripts not integrated
with this helper remain **outside** the cross-process guarantee. Plain
`pnpm exec tsc`, third-party tools and other Agent conversations' unrelated
commands likewise do not acquire this lock. They must be scheduled separately
when machine memory is low. This guard does not substitute for running real
U1 evidence after the machine is idle.

## Lightweight verification (does not launch Electron)

```bash
node --test apps/desktop/scripts/lib/heavy-test-lease.test.mjs apps/desktop/scripts/lib/owned-test-process.test.mjs apps/desktop/scripts/run-smokes.test.mjs
```

Never use `taskkill /IM node.exe` or `taskkill /IM electron.exe` to recover
a test: that would close unrelated agents and installed apps. Identify the
exact owning PID/process tree first. Never delete someone else's recent
`.tmp` output or alter shared working-tree changes.
