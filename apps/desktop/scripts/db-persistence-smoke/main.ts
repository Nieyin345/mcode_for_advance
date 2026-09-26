/** Real sql.js + real temporary files; only filesystem failure points are
 * injected. Every case has its own process/database so even a broken closeDb
 * cannot poison the next case. No real user database is ever opened. */
import initSqlJs from "sql.js/dist/sql-asm.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initDb, getDb, persist, flushDb, persistNowOrThrow, closeDb, onDbPersistenceError } from "@main/store/db.js";
import { armFault, clearFault, faultHits } from "./stubs/fs.js";

const operations = ["persist", "flush", "barrier", "close"] as const;
const faults = ["write", "rename", "sync"] as const;
type Operation = typeof operations[number];
type Fault = typeof faults[number];

if (process.argv[2] !== "--case") {
  let failed = 0;
  for (const operation of operations) {
    for (const fault of faults) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--case", operation, fault], {
        stdio: "inherit", timeout: 15_000,
      });
      if (child.error || child.status !== 0) failed++;
    }
  }
  console.log(`db-persistence-smoke: ${operations.length * faults.length} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const operation = process.argv[3] as Operation;
const fault = process.argv[4] as Fault;
if (!operations.includes(operation) || !faults.includes(fault)) throw new Error("invalid smoke case");
const root = mkdtempSync(join(tmpdir(), "mcode-db-persistence-"));
process.env.MCODE_SMOKE_DATA_ROOT = root;
const target = join(root, "mcode.db");
let checks = 0;
let failures = 0;
function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok" : "FAIL"} ${operation}/${fault}: ${label}`);
}
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const errors: Error[] = [];
const removeBrokenObserver = onDbPersistenceError(() => { throw new Error("expected smoke observer failure"); });
const removeObserver = onDbPersistenceError((error) => { errors.push(error); });
try {
  const SQL = await initSqlJs();
  await initDb();
  getDb().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('persistence.smoke', 'old')");
  persistNowOrThrow();
  const oldBytes = readFileSync(target);
  const savedValue = (): string | undefined => {
    try {
      const disk = new SQL.Database(new Uint8Array(readFileSync(target)));
      try { return disk.exec("SELECT value FROM settings WHERE key='persistence.smoke'")[0]?.values[0]?.[0] as string | undefined; }
      finally { disk.close(); }
    } catch { return undefined; }
  };
  getDb().run("UPDATE settings SET value='new' WHERE key='persistence.smoke'");
  armFault(target, fault);
  let thrown = false;
  const invoke = (): void => {
    if (operation === "persist") persist();
    else if (operation === "flush") flushDb();
    else if (operation === "barrier") persistNowOrThrow();
    else closeDb();
  };
  try { invoke(); } catch { thrown = true; }
  await wait(0); // drain the actual persist microtask, not a copied implementation
  check("injected failure was reached", faultHits > 0);
  check("failure is observable even when another observer throws", errors.length === 1);
  check("old database bytes survive a failed save", readFileSync(target).equals(oldBytes));
  check("old database is still readable", savedValue() === "old");
  check("failed staging files are removed", readdirSync(root).every((name) => name === "mcode.db"));
  check("synchronous callers see failure (async persist stays non-throwing)", thrown === (operation !== "persist"));
  let live = false;
  try {
    live = getDb().exec("SELECT value FROM settings WHERE key='persistence.smoke'")[0]?.values[0]?.[0] === "new";
    check("foreign keys remain enabled after failed export/save", getDb().exec("PRAGMA foreign_keys")[0]?.values[0]?.[0] === 1);
  } catch { /* the old closeDb loses the handle here; assert it explicitly below */ }
  check("unsaved changes remain in the live connection", live);
  if (operation === "persist") {
    const hits = faultHits;
    persist(); persist();
    await wait(0);
    check("new edits during an outage do not bypass retry backoff", faultHits === hits);
    if (fault === "write") {
      try { flushDb(); } catch { /* a second failure within the same outage */ }
      check("repeated failures notify once per outage", errors.length === 1);
    }
  }
  clearFault();

  if (operation === "persist") {
    // Clearing a transient filesystem fault must recover WITHOUT another
    // user edit calling persist(). A rejected save must remain dirty.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && savedValue() !== "new") await wait(25);
    check("dirty autosave retries without another mutation", savedValue() === "new");
  } else if (live) {
    let retried = true;
    try { invoke(); } catch { retried = false; }
    check("explicit retry succeeds", retried && savedValue() === "new");
  }
  if (operation === "persist" && fault === "write") {
    armFault(target, fault);
    try { flushDb(); } catch { /* new failure episode after recovery */ }
    check("a new outage after recovery notifies again", errors.length === 2);
    clearFault(); flushDb();
    removeObserver();
    armFault(target, fault);
    try { flushDb(); } catch { /* unsubscribed observer must not run */ }
    check("error observer can unsubscribe", errors.length === 2);
    clearFault(); flushDb();
    persist();
    closeDb();
    await wait(0);
    await initDb();
    check("close invalidates queued saves and permits clean reopen", getDb().exec("SELECT value FROM settings WHERE key='persistence.smoke'")[0]?.values[0]?.[0] === "new");
  }
  check("successful save leaves no staging files", readdirSync(root).every((name) => name === "mcode.db"));
  if (operation === "close" && live) {
    let closed = false;
    try { getDb(); } catch { closed = true; }
    check("successful close releases the connection", closed);
  }
} finally {
  removeObserver(); removeBrokenObserver();
  clearFault();
  try { closeDb(); } catch { /* preserve the test failure; remove only our own temp root */ }
  rmSync(root, { recursive: true, force: true });
}
console.log(`${operation}/${fault}: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
