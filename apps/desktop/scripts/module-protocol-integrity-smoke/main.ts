/**
 * MC-035 independent adversarial protocol integrity smoke.
 * Runs only in disposable child processes with virtual paths; does not touch the user's data root.
 * An untrusted extension must not convert a failed child process into "verified"/"successful"
 * by printing a protocol-looking line to stdout.
 */
import { verifyPermissionedProgram, runPermissionedProcess, permissionedFailure } from "../../src/main/modules/permissionedProcessRunner.js";

let total = 0, failed = 0;
function check(label: string, pass: boolean, detail?: unknown): void {
  total++;
  if (!pass) failed++;
  console.log((pass ? "  ok   " : "  FAIL ") + label + (pass ? "" : " " + JSON.stringify(detail)));
}
const fakePath = "mcode-virtual-resource-not-read-by-fixture";

// Healthy controls use the same real spawned child and real permission model.
const normalVerify = await verifyPermissionedProgram(
  '({ inspect: async () => ({ text: "normal" }) })', ["inspect"], 8000,
);
check("合法工厂可正常核验", normalVerify.ok === true, normalVerify);
const normalRun = await runPermissionedProcess({
  source: '({ inspect: async () => ({ text: "normal" }) })',
  capability: "inspect", resource: { projectPath: ".", path: fakePath },
  allowWrite: false, timeoutMs: 8000, signal: new AbortController().signal,
}).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
check("合法能力正常返回结果", normalRun.ok && normalRun.value?.text === "normal", normalRun);

// The malicious extension's actual function NEVER returns a result. It forges the child
// output line and exits with a failure status. A failed child must never be reported as
// successfully executed regardless of the stdout it wrote.
const forgedRuntime = String.raw`({
  inspect: async () => {
    process.stdout.write("@@mcode:ext-result " + JSON.stringify({ ok: true, result: { text: "forged" } }) + "\n",
      () => process.exit(37));
    await new Promise(() => {});
  },
})`;
let forgedRuntimeResult: unknown;
try {
  forgedRuntimeResult = await runPermissionedProcess({
    source: forgedRuntime, capability: "inspect",
    resource: { projectPath: ".", path: fakePath }, allowWrite: false,
    timeoutMs: 8000, signal: new AbortController().signal,
  });
  check("★ 非零退出的伪造协议行不得使执行成功", false, forgedRuntimeResult);
} catch (error) {
  const kind = permissionedFailure(error);
  check("★ 非零退出的伪造协议行必须被标为子进程异常",
    kind?.code === "isolated_crash", { kind, error: String(error) });
}

// During installation, malicious factory evaluation can itself print a fake verifier
// success; its non-zero process exit is independent evidence that verification failed.
// A synchronous write to stdout avoids swallowing bytes at process.exit on Windows.
const forgedVerify = String.raw`(() => {
  require("node:fs").writeSync(1, "@@mcode:ext-verify " +
    JSON.stringify({ ok: true, declared: ["inspect"] }) + "\n");
  process.exit(39);
})()`;
const installed = await verifyPermissionedProgram(forgedVerify, ["inspect"], 8000);
check("★ 安装核验必须拒绝异常退出的伪造成功回包", installed.ok === false, installed);

// A factory can schedule an extra protocol-looking stdout line after the trusted
// bootstrap has already emitted its authentic result. "Last matching line wins"
// incorrectly converts a genuine verification refusal into a success.
const forgedLateVerify = String.raw`(() => {
  setTimeout(() => process.stdout.write("@@mcode:ext-verify " +
    JSON.stringify({ ok: true, declared: ["inspect"] }) + "\n"), 30);
  return { inspect: "not-a-function" };
})()`;
const lateVerify = await verifyPermissionedProgram(forgedLateVerify, ["inspect"], 8000);
check("★ 真假两条核验协议行不得以最后一个伪造成功覆盖真实拒绝",
  lateVerify.ok === false, lateVerify);

// Likewise, genuine ability output must not be superseded by a timer's counterfeit.
const forgedLateRuntime = String.raw`({
  inspect: async () => {
    setTimeout(() => process.stdout.write("@@mcode:ext-result " +
      JSON.stringify({ ok: true, result: { text: "timer-forged" } }) + "\n"), 30);
    return { text: "real" };
  },
})`;
const lateRun = await runPermissionedProcess({
  source: forgedLateRuntime, capability: "inspect",
  resource: { projectPath: ".", path: fakePath }, allowWrite: false,
  timeoutMs: 8000, signal: new AbortController().signal,
}).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
check("★ 多条相互冲突的执行协议行必须拒绝而非认最后一个",
  lateRun.ok === false, lateRun);

// An untrusted factory runs in the child and can print exactly ONE plausible
// success row then exit cleanly, without ever exporting the declared capability.
// Exit-status and duplicate-line guards alone do not authenticate that row.
const forgedCleanVerify = String.raw`(() => {
  require("node:fs").writeSync(1, "@@mcode:ext-verify " +
    JSON.stringify({ ok: true, declared: ["inspect"], proof: typeof p !== "undefined" ? p.challenge : "unknown" }) + "\n");
  process.exit(0);
})()`;
const cleanVerify = await verifyPermissionedProgram(forgedCleanVerify, ["inspect"], 8000);
check("★ 单条伪造成功核验行 + 正常退出也必须拒绝", cleanVerify.ok === false, cleanVerify);

const forgedCleanRuntime = String.raw`({
  inspect: async () => {
    require("node:fs").writeSync(1, "@@mcode:ext-result " +
      JSON.stringify({ ok: true, result: { text: "forged-clean-exit" },
        proof: typeof p !== "undefined" ? p.challenge : "unknown" }) + "\n");
    process.exit(0);
  },
})`;
let cleanRuntimeResult: unknown;
try {
  cleanRuntimeResult = await runPermissionedProcess({
    source: forgedCleanRuntime, capability: "inspect",
    resource: { projectPath: ".", path: fakePath }, allowWrite: false,
    timeoutMs: 8000, signal: new AbortController().signal,
  });
  check("★ 未执行完成但单条伪造成功 + exit0 不得按能力成功", false, cleanRuntimeResult);
} catch (error) {
  check("★ 单条伪造结果 + 正常退出仍产生明确协议失败",
    permissionedFailure(error)?.code === "isolated_crash", String(error));
}

// Direct eval inherits bootstrap's closure, which contains the secret challenge.
// Factories must be evaluated indirectly so they cannot see invocation internals.
const leakedVerification = await verifyPermissionedProgram(
  '(() => { if (typeof p !== "undefined") throw Error("invocation leaked"); return { inspect: async () => ({}) }; })()',
  ["inspect"], 8000,
);
check("★ 安装期不暴露 bootstrap 入参的局部变量 p", leakedVerification.ok, leakedVerification);
const scopedExecution = await runPermissionedProcess({
  source: '({ inspect: async () => ({ text: typeof p === "undefined" ? "scoped" : "leaked" }) })',
  capability: "inspect", resource: { projectPath: ".", path: fakePath },
  allowWrite: false, timeoutMs: 8000, signal: new AbortController().signal,
}).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
check("★ 执行期工厂无法读取 bootstrap 的局部变量 p",
  scopedExecution.ok && scopedExecution.value?.text === "scoped", scopedExecution);

// Even when the parent compares a per-call nonce, extension code shares the child's
// process.stdout. An output-hook can capture the *real* bootstrap reply and mutate it,
// preserving any correlation fields. The bootstrap must write through a previously
// captured emitter rather than looking up the mutable global after factory evaluation.
const interceptVerify = String.raw`(() => {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, ...args) {
    const s = String(chunk);
    if (s.startsWith("@@mcode:ext-verify ")) {
      const value = JSON.parse(s.slice("@@mcode:ext-verify ".length));
      value.ok = true; value.declared = ["inspect"]; delete value.message;
      return original("@@mcode:ext-verify " + JSON.stringify(value) + "\n", ...args);
    }
    return original(chunk, ...args);
  };
  return { inspect: null };
})()`;
const hookedInstall = await verifyPermissionedProgram(interceptVerify, ["inspect"], 8000);
check("★ 工厂不得通过覆盖 stdout.write 把核验错误改成成功", hookedInstall.ok === false, hookedInstall);

const interceptRun = String.raw`({
  inspect: async () => {
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk, ...args) {
      const s = String(chunk);
      if (s.startsWith("@@mcode:ext-result ")) {
        const value = JSON.parse(s.slice("@@mcode:ext-result ".length));
        value.ok = true; value.result = { text: "altered-stdout" }; delete value.message;
        return original("@@mcode:ext-result " + JSON.stringify(value) + "\n", ...args);
      }
      return original(chunk, ...args);
    };
    throw new Error("expected-failure");
  },
})`;
const hookedRun = await runPermissionedProcess({
  source: interceptRun, capability: "inspect",
  resource: { projectPath: ".", path: fakePath }, allowWrite: false,
  timeoutMs: 8000, signal: new AbortController().signal,
}).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
check("★ 工厂不得通过覆盖 stdout.write 把执行错误改成成功", hookedRun.ok === false, hookedRun);

// Real subprocess output must satisfy the shared contract, not merely be a JS
// object: accepting nested values/oversized strings/too many keys bypasses
// ModuleResult constraints and can damage downstream renderers or persistence.
for (const [label, source] of [
  ["nested values", '({ inspect: async () => ({ nested: { shouldNotPersist: true } }) })'],
  ["oversized field", '({ inspect: async () => ({ text: "x".repeat(5000) }) })'],
  ["more than 32 fields", '({ inspect: async () => Object.fromEntries(Array.from({length: 33}, (_, i) => ["key"+i,"x"])) })'],
] as const) {
  let blocked = false;
  let kind = "";
  try {
    await runPermissionedProcess({
      source, capability: "inspect", resource: { projectPath: ".", path: fakePath },
      allowWrite: false, timeoutMs: 8000, signal: new AbortController().signal,
    });
  } catch (error) {
    kind = permissionedFailure(error)?.code ?? "";
    blocked = kind === "isolated_crash";
  }
  check("★ MC-035 child result violates ModuleResult contract: " + label, blocked, kind);
}

console.log("module-protocol-integrity-smoke: " + (total - failed) + "/" + total + " PASS");
if (failed > 0) process.exitCode = 1;
