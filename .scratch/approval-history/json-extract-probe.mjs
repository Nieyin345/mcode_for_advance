// 验证 sql.js 是否支持 json_extract —— 总控提议的「审批→任务」join 写法依赖它。
// 如果不支持，那条反查路就不成立，spec 的结论要跟着改。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 仓库根 = 本文件往上两级（.scratch/approval-history/ → 仓库根）
const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sqlJsRoot = join(repo, "node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js");
const require = createRequire(join(repo, "package.json"));
const initSqlJs = require(sqlJsRoot);
const wasmBinary = readFileSync(join(sqlJsRoot, "dist/sql-wasm.wasm"));

const SQL = await initSqlJs({ wasmBinary });
const db = new SQL.Database();

// 复刻 tasks 表的相关形状（只留 origin）
db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT NOT NULL)");
db.run(`INSERT INTO tasks VALUES ('t1', '{"kind":"session","ref":"sess_A","projectPath":"/p"}')`);
db.run(`INSERT INTO tasks VALUES ('t2', '{"kind":"user","ref":"u1"}')`);
db.run(`INSERT INTO tasks VALUES ('t3', '{"kind":"session","ref":"sess_B"}')`);

const sql = `SELECT id FROM tasks
  WHERE json_extract(origin, '$.kind') = 'session'
    AND json_extract(origin, '$.ref') = 'sess_A'`;

try {
  const r = db.exec(sql);
  console.log("raw:", JSON.stringify(r));
  const ids = r.length > 0 ? r[0].values.map((v) => v[0]) : [];
  console.log(ids.length === 1 && ids[0] === "t1"
    ? "PASS: json_extract 可用，origin.ref 反查成立"
    : `FAIL: 结果不对 -> ${JSON.stringify(ids)}`);
} catch (e) {
  console.log("FAIL: json_extract 不可用 ->", e.message);
}

// 顺带验索引：json_extract 能不能走索引（不能的话大表会全扫）
try {
  db.run("CREATE INDEX idx_origin_ref ON tasks(json_extract(origin, '$.ref'))");
  console.log("PASS: 可以给 json_extract 表达式建索引");
} catch (e) {
  console.log("注意: 不能给 json_extract 表达式建索引 ->", e.message);
}

// 附：确认 sqlite 版本（json1 是 3.38 起内置）
console.log("sqlite_version:", db.exec("SELECT sqlite_version()")[0].values[0][0]);
