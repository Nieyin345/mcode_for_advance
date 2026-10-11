"""变异验证:撤掉 db.ts 的 MC-019/MC-023 修复,确认 maint-m01 / db-migrate 变红。"""
import io, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.dirname(APP)
DB = os.path.join(APP, "src/main/store/db.ts")


def git_bash():
    cand = os.environ.get("MCODE_TEST_BASH") or r"C:\Program Files\Git\bin\bash.exe"
    return cand if os.path.exists(cand) else "bash"


BASH = git_bash()


def run_suite(name):
    r = subprocess.run([BASH, os.path.join(APP, "scripts", name, "run.sh")], capture_output=True, cwd=APP)
    txt = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")
    fails = [l for l in txt.splitlines() if l.strip().startswith("FAIL") or "✗" in l]
    return len(fails), txt


MUTATIONS = [
    # MC-023: 恢复 DROP institution_profiles
    ("MC-023 恢复 DROP 机构表", DB,
     "  // ── kind 退役（2026-09-24）──",
     '  if (tableExists(database, "institution_profiles")) {\n    database.run("DROP TABLE institution_profiles");\n    schemaChanged = true;\n  }\n  // ── kind 退役（2026-09-24）──',
     "db-migrate-smoke"),
    # MC-019: 迁移落盘的 durable 回归 —— 把 initDb 里的同步 durable 写盘退回协程化 persist()。
    # 后果正是台账点名的那一格:initDb 宣布 ready(内存里已是新结构),而写盘只是排了个
    # microtask、失败还被吞掉 —— 磁盘永远停在老结构。§10 的 reject 断言当场红。
    ("MC-019 迁移落盘退回协程化 persist", DB,
     "      if (migrateNeedsPersist) persistNowOrThrow();",
     "      if (migrateNeedsPersist) persist();",
     "maint-m01-smoke"),
    # MC-019: 撤掉 fail-closed 的回滚清理(失败后不清 db/dbPath/dbReadyPromise)。
    # 后果:落盘失败后 db 仍非 null,getDb() 会交出那个"内存 ready / 磁盘没写"的句柄,
    # awaitDb() 也停在已拒绝的 promise 上 —— 本进程无法干净重试。
    ("MC-019 撤掉失败后的状态回滚", DB,
     "      try { localDb?.close(); } catch { /* 真正的错是上面那个,别盖过它 */ }\n      db = null;\n      dbPath = null;\n      dbReadyPromise = null;\n      migrateNeedsPersist = false;\n      throw err instanceof Error ? err : new Error(String(err));",
     "      throw err instanceof Error ? err : new Error(String(err));",
     "maint-m01-smoke"),
]


def mutate_and_run(label, path, old, new, suite):
    orig = io.open(path, encoding="utf-8", newline="").read()
    bak = path + ".mutbak"
    shutil.copyfile(path, bak)
    try:
        n = orig.count(old)
        if n != 1:
            print("!! %s: anchor appears %d time(s), ineffective" % (label, n))
            return False
        io.open(path, "w", encoding="utf-8", newline="").write(orig.replace(old, new))
        red, txt = run_suite(suite)
        print("%s %s [%s]: red=%d" % ("OK " if red > 0 else "BAD", label, suite, red))
        if red > 0:
            for l in [x for x in txt.splitlines() if x.strip().startswith("FAIL")][:2]:
                print("      " + l.strip()[:110])
        return red > 0
    finally:
        io.open(path, "w", encoding="utf-8", newline="").write(orig)
        os.remove(bak)


allok = True
for label, path, old, new, suite in MUTATIONS:
    try:
        ok = mutate_and_run(label, path, old, new, suite)
    except Exception as e:  # noqa: BLE001
        print("!! %s: %s" % (label, e))
        ok = False
    allok = allok and ok
print("=== all mutations red and restored:", allok)
sys.exit(0 if allok else 1)
