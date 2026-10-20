import { workflowSaveVersion, workflowSaveIsStale } from "@main/orchestration/workflowSaveVersion.js";
let total = 0, fails = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else { fails++; console.log("  FAIL " + name + " " + JSON.stringify(detail)); }
}
const snapshot = (value: unknown) => ({ id: "wf_test", title: "demo", nodes: [{ id: "x", params: { value } }], edges: [] }) as never;
const hash = (value: unknown) => workflowSaveVersion(snapshot(value));
const rejects = (value: unknown) => {
  try { hash(value); return false; } catch (err) {
    return err instanceof Error && /invalid|invalid value|无效|不支持|循环引用|拒绝计算保存修订/.test(err.message);
  }
};
const base = hash({ a: 1, b: [true, "value"] });
check("equivalent JSON objects with reordered keys get same version", base === hash({ b: [true, "value"], a: 1 }));
check("valid finite numbers remain hashable", typeof hash(123) === "string");
check("valid null remains hashable", typeof hash(null) === "string");
check("different valid values change revision", hash(1) !== hash(2));
check("★ NaN cannot collide with serialized JSON null", rejects(Number.NaN));
check("★ Infinity cannot collide with serialized JSON null", rejects(Infinity));
check("★ array non-finite value cannot collapse into null", rejects([1, -Infinity]));
check("★ Date objects cannot collapse into empty persisted object", rejects(new Date("2026-10-19T00:00:00Z")));
check("★ function cannot silently disappear from persisted version", rejects({ onRun: () => true }));
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
check("★ cyclic values fail with controlled invalid JSON diagnostic", rejects(cyclic));
const serializedDifferent = { x: 1 };
Object.defineProperty(serializedDifferent, 'toJSON', {
  enumerable: false, value: () => ({ x: 999 }),
});
check("★ non-enumerable toJSON cannot make revision differ from actual persisted JSON", rejects(serializedDifferent));
let getterReads = 0;
const accessor: Record<string, unknown> = {};
Object.defineProperty(accessor, "x", {
  enumerable: true,
  get() { return ++getterReads; },
});
check("★ getters cannot mutate values between canonical filter and persisted JSON", rejects(accessor));
check("★ a getter must not be executed just to compute a workflow revision", getterReads === 0, getterReads);
check("ordinary JSON data field named toJSON remains valid (no callable serializer)",
  typeof hash({ toJSON: "data-field", amount: 1 }) === "string");
check("normal JSON optional undefined fields still canonicalize compatibly",
  hash({ a: 1, skipped: undefined }) === hash({ a: 1 }));
check("workflow staleness detects persisted edit", workflowSaveIsStale(snapshot(2), hash(1)));
console.log("workflow-save-version-integrity-smoke:" + (total - fails) + "/" + total + " 通过");
if (fails > 0) process.exitCode = 1;
