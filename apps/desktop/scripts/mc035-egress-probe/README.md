# MC-035 independent egress evidence

Run (Windows): `node apps/desktop/scripts/mc035-egress-probe/probe-a.mjs` from the repo root.

The script bundles the **current production** `permissionedProcessRunner.ts`, starts an isolated real Node child for each of five techniques and uses only the temporary in-process **127.0.0.1** server (no public requests). Each line is `method=... result=blocked|connected|error:...`; `blocked` means either the process could not be launched or its current JS/Node guard rejected the attempt. **Do not infer OS isolation from blocked alone**; the independent `diagnoseEgressIsolation` kernel probe distinguishes that.

## Recorded baseline before production changes (2026-10-20)

```text
method=net.connect result=blocked
method=dns.lookup result=blocked
method=worker_threads result=error:ERR_ACCESS_DENIED
method=process.binding(tcp_wrap) result=error:ERR_ACCESS_DENIED
method=fetch result=blocked
mc035-egress-probe: blocked=3 connected-or-local=0 error=2 total=5
```

The two `ERR_ACCESS_DENIED` cases are **Node --permission** restrictions, not a JS network-hook bypass; no live egress bypass was demonstrated for these five APIs on Node 22.21.1. `dns.lookup("localhost")` is a local-hosts resolver check, NOT proof that OS network blocking covers DNS transport. The kernel-only probe uses an unguarded loopback TCP attempt to reject fake/JS-only isolation.

## Supported OS boundary

- **Linux:** `unshare --user --map-root-user --net -- <node>` only after a real network-connect OS probe returns `ENETUNREACH` / `EHOSTUNREACH` / `EPERM` / `EACCES`. The newly isolated net namespace prevents host egress even if JS hooks are bypassed; requires user namespaces and `unshare`.
- **macOS:** OS `sandbox-exec -p '(version 1)(allow default)(deny network*)'` only after the same real probe confirms kernel denial. Deprecated on modern macOS: fail closed when unavailable.
- **Windows (T16 explicit downgrade, NOT an OS sandbox):** No working per-child AppContainer/WFP launcher exists in this repository. `node --permission` cannot restrict sockets; a Job Object does not provide network isolation. Implementing AppContainer reliably would require a maintained native helper and packaged binaries/signing/file-access policy; WFP would require elevated per-process filtering and cleanup. Neither was available in this task without introducing unreviewed native dependencies or modifying global firewall policy. **Default: every executable module without an OS sandbox is refused before installation verification or execution** (`egress_isolation_unavailable`; runtime `isolated_denied`). The desktop user can explicitly opt in at **Settings → Extensions → Custom UI → Advanced → Module manager**: check the risk acknowledgment and click the enable button. That preference is stored in the managed, atomically written `ui-modules/js-only-egress-consent.json` file (under Mcode's data root) and read anew on every launch; disable it there at any time (new installs/executions fail closed). Corrupt/missing/symlinked approval files are rejected; generic `setting.set` and settings import/restore cannot access this separate approval store; Agent `modules.egressConsentGet/Set` access is policy-blocked, and mobile/web returns unsupported. With consent, undeclared-network programs use Node permission flags plus `NETWORK_GUARD` and annotate successful results `_mcodeEgressIsolation: "js-guard-only; OS egress isolation unavailable"`; this remains bypassable by sufficiently malicious code. **Declared-network executable modules are still rejected at install/execute on Windows even with this switch on.** A direct trusted call to `runPermissionedProcess({allowNetwork:true})` intentionally retains the preexisting explicit-approval behavior; it is not an untrusted extension permission grant.

The production guard remains defence-in-depth. A failed guard installation exits before source evaluation; an action-time invariant check and interval detect and terminate after tampering. This self-check does NOT replace OS isolation or create authenticated child stdout.

## T16 verification and mutation evidence (2026-10-21)

Windows smoke: run `node apps/desktop/scripts/run-smokes.mjs mc035-egress-isolation-smoke module-protocol-integrity-smoke module-extension-lifecycle-smoke`; the default-deny checks are in the first suite, while the two older suites explicitly inject an **opted-in test-only** consent reader for their authorized positive controls. Run `node apps/desktop/scripts/mc035-egress-isolation-smoke/mutation.mjs`: the build mutates the policy **only in its esbuild bundle**, removes the new default refusal, and requires three denial/revocation checks to turn red. Source SHA must remain unchanged.

Linux/WSL production run: Node 22.21.1 from the local VS Code server at `/home/nieyin/.vscode-server/bin/994fd12f8d3a5aa16f17d42c041e5809167e845a/node` (no download); a Windows-generated esbuild bundle of `mc035-egress-probe/main.ts` runs under **real Linux Node** via WSL Ubuntu and reports all five production child methods blocked. `os-mutation.mjs` runs an **independent OS-only five-route** adversarial battery (no JS guard, same production Linux unshare argv and Node permission flags), mutating a *copy* of the source by removing only the unshare wrapper. Wrapped: five blocked. Without unshare: three routes show actual traffic (TCP, loopback-DNS-UDP, fetch) and two are still rejected by Node permission restrictions (worker_threads and tcp_wrap). Original source / restored copy compare byte-for-byte. This separate OS-only control is necessary: the *full production* five-route guard would also return blocked when the OS launcher fails closed, which cannot by itself prove OS isolation. Both modes connect **only** to temporary local 127.0.0.1 servers; no external network. macOS sandbox was **not** dynamically tested: do not conflate Linux evidence with macOS support.

Windows AppContainer/WFP remains unimplemented: T16 chooses its explicitly visible, reversible downgrade alternative. The `module-phase2-e2e-smoke` suite additionally verifies real Electron preload → native module IPC → durable consent-file write → revocation and rejects requests lacking `acknowledgeRisk:true`; the setting UI's actual human click journey (and a packaged installer) have not been manually witnessed here and cannot be claimed as full U1.
