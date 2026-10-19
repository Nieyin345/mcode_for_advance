/** MC-035/ARC-002: worker startup, cancellation, and result-shape regression.
 * In-memory fake worker plus a real Node worker positive control; no filesystem or network access.
 */
import {
  configureIsolatedWorkerFactory,
  runIsolatedAction,
  isolationFailure,
  type IsolatedWorkerLike,
} from "../../src/main/modules/isolatedActionRunner.js";

let total = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : " " + String(detail)));
}
const spec = { source: 'async () => ({text:"real-ok"})' };
const real = await runIsolatedAction(spec, null, {timeoutMs:2000});
check("real Node worker still returns an object", real?.text === "real-ok", real);

async function expectingFailure(
  signal?: AbortSignal,
  timeoutMs = 80,
): Promise<string> {
  try {
    await runIsolatedAction(spec, null, {signal, timeoutMs});
    return "unexpected-success";
  } catch (e) {
    return isolationFailure(e)?.code ?? "unclassified";
  }
}

function fakeWorker(options: {
  onRegister?: (event: string) => void;
  immediateMessage?: unknown;
  throwOnRegister?: string;
}, stopped: () => void): IsolatedWorkerLike {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const keepAlive = setInterval(() => {}, 1000);
  const fallback = setTimeout(() => clearInterval(keepAlive), 250);
  let terminated = false;
  return {
    on(event, listener) {
      handlers.set(event, listener);
      options.onRegister?.(event);
      if (options.throwOnRegister === event) throw new Error("SYNTHETIC_WORKER_ON_ERROR");
      if (event === "message" && options.immediateMessage !== undefined) {
        queueMicrotask(() => handlers.get("message")?.(options.immediateMessage));
      }
    },
    terminate() {
      if (!terminated) { terminated = true; clearInterval(keepAlive); clearTimeout(fallback); stopped(); }
    },
  };
}

try {
  const already = new AbortController();
  already.abort();
  let starts = 0;
  configureIsolatedWorkerFactory(() => {
    starts++;
    return fakeWorker({}, () => {});
  });
  const pre = await expectingFailure(already.signal);
  check("★ cancelled before invocation launches zero workers", pre === "isolated_cancelled" && starts === 0, {pre,starts});

  const duringFactory = new AbortController();
  let stoppedFactory = 0;
  configureIsolatedWorkerFactory(() => {
    duringFactory.abort();
    return fakeWorker({}, () => { stoppedFactory++; });
  });
  const factory = await expectingFailure(duringFactory.signal);
  check("★ cancellation during factory startup still terminates constructed worker",
    factory === "isolated_cancelled" && stoppedFactory === 1, {factory,stoppedFactory});

  const duringRegistration = new AbortController();
  let stoppedRegistration = 0;
  configureIsolatedWorkerFactory(() => fakeWorker({
    onRegister: (event) => {
      if (event === "message") duringRegistration.abort();
    },
  }, () => { stoppedRegistration++; }));
  const registration = await expectingFailure(duringRegistration.signal);
  check("★ cancellation while registering worker listeners is never lost",
    registration === "isolated_cancelled" && stoppedRegistration === 1,
    {registration, stoppedRegistration});

  for (const [label, value] of [
    ["missing result", undefined],
    ["array result", []],
    ["primitive result", "not-an-object"],
    ["nested object result", {nested: {untrusted: true}}],
    ["non-finite number result", {amount: NaN}],
  ] as const) {
    let stopped = 0;
    configureIsolatedWorkerFactory(() => fakeWorker({immediateMessage: {ok:true,result:value}}, () => { stopped++; }));
    const outcome = await expectingFailure();
    check("★ successful worker message cannot contain " + label,
      outcome === "isolated_crash" && stopped === 1, {outcome,stopped});
  }

  let stoppedOnFailure = 0;
  configureIsolatedWorkerFactory(() =>
    fakeWorker({throwOnRegister:"error"}, () => { stoppedOnFailure++; }));
  const registrationFailure = await expectingFailure();
  check("★ worker event-listener registration failure terminates worker and is classified",
    registrationFailure === "isolated_spawn_failed" && stoppedOnFailure === 1,
    {registrationFailure, stoppedOnFailure});

  configureIsolatedWorkerFactory(() => fakeWorker({immediateMessage:{ok:true,result:{text:"valid"}}}, () => {}));
  const valid = await runIsolatedAction(spec, null, {timeoutMs:80});
  check("realistic fake worker object result remains allowed", valid?.text === "valid", valid);
} finally {
  configureIsolatedWorkerFactory(null);
}
console.log("isolated-action-lifecycle-smoke:"+(total-failed)+"/"+total);
if (failed) process.exitCode=1;
