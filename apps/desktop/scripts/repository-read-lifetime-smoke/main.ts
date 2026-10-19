/**
 * ARC-006: real SettingRepo / NoteRepo + isolated sql.js, fault injection only
 * at prepare() boundary. No user database, no real Electron, no writes outside
 * MCODE_SMOKE_DATA_ROOT. The shared withStatement() must free on EVERY failed
 * bind/step/getAsObject/reset and rethrow the original error unchanged.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories/setting.js";
import { NoteRepo } from "@main/store/repositories/note.js";

let total = 0;
let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log("  ok   " + label);
  else {
    failures++;
    console.log("  FAIL " + label + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

await initDb();
const db = getDb() as unknown as { prepare: (...args: unknown[]) => unknown };
const savedPrepare = db.prepare;
const cases: Array<{
  name: string;
  run: () => unknown;
  stages: readonly ("bind" | "step" | "row" | "reset")[];
}> = [
  { name: "SettingRepo.get", run: () => SettingRepo.get("smoke.key"), stages: ["bind", "step", "row"] },
  { name: "SettingRepo.getMany", run: () => SettingRepo.getMany(["smoke.key", "other"]), stages: ["bind", "step", "row", "reset"] },
  { name: "SettingRepo.keysWithPrefix", run: () => SettingRepo.keysWithPrefix("smoke."), stages: ["bind", "step", "row"] },
  { name: "NoteRepo.listByItem", run: () => NoteRepo.listByItem("not_real"), stages: ["bind", "step", "row"] },
  { name: "NoteRepo.save(exists)", run: () => NoteRepo.save({ id: "nonexistent", itemId: "none", content: "x" }), stages: ["bind", "step", "row"] },
  { name: "NoteRepo.delete", run: () => NoteRepo.delete("not_real"), stages: ["bind", "step", "row"] },
];

try {
  for (const test of cases) {
    for (const stage of test.stages) {
      let freed = 0;
      let stepCount = 0;
      let prepared = 0;
      const error = new Error("INJECT_SQL_" + test.name + "_" + stage);
      const statement = {
        bind: () => { if (stage === "bind") throw error; },
        step: () => {
          if (stage === "step") throw error;
          stepCount++;
          return stepCount === 1;
        },
        getAsObject: () => {
          if (stage === "row") throw error;
          return { value: "value", key: "smoke.key", id: "note_x", item_id: "fake_item", content: "text", origin: "user", created_at: 1, updated_at: 2 };
        },
        reset: () => { if (stage === "reset") throw error; },
        free: () => { freed++; },
      };
      db.prepare = () => { prepared++; return statement; };
      let thrown: unknown = null;
      try { test.run(); } catch (e) { thrown = e; }
      check(test.name + "/" + stage + " preserves original SQL error", thrown === error, { thrown: String(thrown), expected: String(error) });
      check(test.name + "/" + stage + " frees statement exactly once", freed === 1 && prepared === 1, { freed, prepared });
    }
  }
} finally {
  db.prepare = savedPrepare;
}

// Positive control on real sql.js: one isolation-only setting row and a
// completely unused note parent ID (no fake real user data).
SettingRepo.set("smoke.key", "value");
SettingRepo.set("constructor", "special-key");
SettingRepo.set("__proto__", "own-value");
eq("真实DB 正常 get 返回值", SettingRepo.get("smoke.key"), "value");
eq("真实DB 正常 getMany 已有值不变", SettingRepo.getMany(["smoke.key", "absent"])["smoke.key"], "value");
const map = SettingRepo.getMany(["__proto__", "constructor", "absent"]);
check("设置批读不丢掉字面 __proto__ 键", Object.hasOwn(map, "__proto__") && map["__proto__"] === "own-value", { keys: Object.keys(map), value: map["__proto__"] });
check("设置批读无原型污染", Object.getPrototypeOf(map) === null, { prototype: String(Object.getPrototypeOf(map)) });
eq("设置批读保留 constructor 特殊键", map.constructor, "special-key");
eq("设置批读缺失键为 null", map.absent, null);
eq("真实DB keysWithPrefix 仍按前缀读取", SettingRepo.keysWithPrefix("smoke."), ["smoke.key"]);
eq("真实DB 无条目笔记时返回空数组", NoteRepo.listByItem("no_such_item"), []);
eq("真实DB 删除不存在笔记仍返回 null", NoteRepo.delete("no_such_note"), null);

// Library notes are owned by an item, not merely by their globally unique
// note id. A stale/malformed UI edit for item B must not overwrite the note
// that belongs to item A. All rows live only in the isolated smoke database.
const realDb = getDb();
realDb.run("INSERT INTO library_items (id, title, added_at, updated_at) VALUES ('note_parent_a', 'A', 1, 1), ('note_parent_b', 'B', 1, 1)");
NoteRepo.save({ itemId: "note_parent_a", content: "original-note" });
const mine = NoteRepo.listByItem("note_parent_a")[0];
check("笔记归属正控:最初笔记真实存在于 A", mine?.content === "original-note" && !!mine.id, mine);
let mismatchError = "";
try {
  NoteRepo.save({ id: mine.id, itemId: "note_parent_b", content: "overwrote-other-item" });
} catch (err) { mismatchError = String(err); }
check("★★ 改写笔记 id 属于另一条目时必须明确拒绝", mismatchError.includes("item") || mismatchError.includes("条目"), mismatchError);
eq("★★ 改写时归属不匹配不得污染 A 的原笔记", NoteRepo.listByItem("note_parent_a")[0]?.content, "original-note");
eq("★★ 不得在 B 虚构新的该 id 笔记", NoteRepo.listByItem("note_parent_b"), []);
NoteRepo.save({ id: mine.id, itemId: "note_parent_a", content: "legit-edit" });
eq("正控:归属匹配的正常编辑仍可用", NoteRepo.listByItem("note_parent_a")[0]?.content, "legit-edit");

closeDb();
console.log("repository-read-lifetime-smoke:" + (total - failures) + "/" + total + " PASS");
if (failures) process.exitCode = 1;
