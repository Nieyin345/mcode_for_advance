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
- **Windows (current HEAD, T11 follow-up):** Unsupported: Node --permission + JS monkeypatches are not OS egress isolation; Job Objects do not deny outbound sockets, and WFP/AppContainer cannot be safely configured by existing project tools. No global firewall rules or third-party native installers are attempted. **Unlike the T06 original fail-closed implementation, T11 now allows executable manifests WITHOUT a `network` permission to pass verification and run with an in-process JS guard only**, annotating successful results `_mcodeEgressIsolation: "js-guard-only; OS egress isolation unavailable"`. Executable manifests WITH a declared `network` permission are rejected by `requireNetworkExtensionSupport` at installation and invocation. Thus this Windows path is an explicit product compatibility downgrade, **not OS isolation and not T06 criterion 3's "no OS capability → refuse execution" fail-closed behavior**. An explicitly approved `allowNetwork=true` runner call takes a separate, unguarded path; ModuleHost currently blocks installing network-declaring executable manifests on Windows. No current Windows test result can certify an OS no-egress sandbox.

The production guard remains defence-in-depth. A failed guard installation exits before source evaluation; an action-time invariant check and interval detect and terminate after tampering. This self-check does NOT replace OS isolation or create authenticated child stdout.

Run `node apps/desktop/scripts/run-smokes.mjs mc035-egress-isolation-smoke` for the guarded-process and capability assertions. To prove that OS wrapping itself matters, mutate the actual `egressLaunch` implementation (remove `unshare` or `sandbox-exec` from the **real kernel-only capability probe**): it must reject the isolation capability, and a compatible-platform positive test must turn red. **Current Windows smoke instead asserts JS-only fallback and a diagnostic, not the strict unsupported-platform fail-closed guarantee that T06 originally demanded**; that criterion remains open. A Windows host cannot certify macOS/Linux's Node 5-method E1 run; kernel probing on WSL Python is supporting OS evidence only.
