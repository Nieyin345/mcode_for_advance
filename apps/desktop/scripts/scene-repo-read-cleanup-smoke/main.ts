/**
 * MC-002: 场景部署发现链的 sqlite statement 必须在所有读取结果（包括抛错）后 free。
 * 真实 SceneDeploymentRepo + 隔离 sql.js DB；仅替换临时 DB 对象的 prepare 方法以注入
 * bind/step/投影错误，不碰用户数据、不替换被测源码。
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { SceneDeploymentRepo } from "@main/store/repositories/scene.js";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, actual?: unknown): void {
  if (condition) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label + (actual === undefined ? "" : " — " + JSON.stringify(actual))); }
}

type Row = {
  deployment_id: string; scene_id: string; status: string;
  spec_digest: string; plan_digest: string; payload: string;
  created_at: number; updated_at: number;
};
const sample: Row = {
  deployment_id: "dep_fake", scene_id: "scene_fake", status: "partial",
  spec_digest: "spec_fake", plan_digest: "plan_fake", payload: "{}",
  created_at: 123, updated_at: 456,
};
const reads = {
  get: () => SceneDeploymentRepo.get("dep_fake"),
  listByScene: () => SceneDeploymentRepo.listByScene("scene_fake", 5),
  listRecent: () => SceneDeploymentRepo.listRecent(5, { resumableOnly: true }),
};
type Stage = "bind" | "step" | "row" | "none" | "ok";

await initDb();
const db = getDb() as unknown as { prepare: (...args: unknown[]) => unknown };
const original = db.prepare;
try {
  for (const [name, run] of Object.entries(reads)) {
    for (const stage of ["bind", "step", "row"] as const) {
      let freed = 0;
      let bindCalls = 0;
      let prepareCalls = 0;
      const failure = new Error("FAKE_SCENE_" + name + "_" + stage);
      const statement = {
        bind: (..._args: unknown[]) => { bindCalls++; if (stage === "bind") throw failure; },
        step: () => { if (stage === "step") throw failure; return true; },
        getAsObject: () => { if (stage === "row") throw failure; return sample; },
        free: () => { freed++; },
      };
      db.prepare = (..._args: unknown[]) => { prepareCalls++; return statement; };
      let caught: unknown = null;
      try { run(); } catch (error) { caught = error; }
      check(name + "/" + stage + " 抛出原始故障，不伪装成功或空表", caught === failure, { caught: String(caught) });
      check(name + "/" + stage + " 出错时仅释放一次 statement", freed === 1, { freed, prepareCalls, bindCalls });
    }

    for (const stage of ["none", "ok"] as const satisfies readonly Stage[]) {
      let freed = 0;
      let stepCalls = 0;
      let where = "";
      db.prepare = (sql) => {
        where = String(sql);
        return {
          bind: () => {},
          step: () => { stepCalls++; return stage === "ok" && stepCalls === 1; },
          getAsObject: () => sample,
          free: () => { freed++; },
        };
      };
      let rows: ReturnType<typeof run> = null;
      let err: unknown = null;
      try { rows = run(); } catch (error) { err = error; }
      const expected = stage === "ok" ? "dep_fake" : undefined;
      const actual = Array.isArray(rows) ? rows[0]?.deploymentId : rows?.deploymentId;
      check(name + "/" + stage + " 正常投影不回归", !err && actual === expected, { actual, expected, err: String(err) });
      check(name + "/" + stage + " 正常返回后释放一次", freed === 1, { freed });
      if (name === "listRecent" && stage === "ok") {
        check("跨场景 resumableOnly 过滤仍在 SQL 中", where.includes("WHERE status IN ('partial','failed')"), where);
      }
    }
  }
} finally {
  db.prepare = original;
  closeDb();
}

console.log("scene-repo-read-cleanup-smoke " + passed + "/" + (passed + failed) + " PASS");
if (failed > 0) process.exitCode = 1;
