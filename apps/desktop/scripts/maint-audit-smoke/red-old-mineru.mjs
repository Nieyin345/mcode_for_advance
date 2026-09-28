
// red-old-mineru.mjs — 修复前红证据:HEAD 版 MINERU_PY 会把结果目录写出 mineru/。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
const desktop = resolve(process.cwd());           // apps/desktop
const repo = resolve(desktop, "../..");
const OUT = join(desktop, ".tmp", "audit-old-mineru");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "cwd"), { recursive: true });
const oldTs = execFileSync("git", ["-C", repo, "show", "HEAD:apps/desktop/src/main/workflows/assets.ts"], { maxBuffer: 64*1024*1024 });
writeFileSync(join(OUT, "assets-old.ts"), oldTs);
// 找 esbuild 二进制(与各 run.sh 同法)
function findEsbuild(dir) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("esbuild@")) continue;
    const bin = join(dir, name, "node_modules", "esbuild", "bin", "esbuild");
    for (const cand of [bin, bin + ".exe", join(dir, name, "node_modules", "@esbuild")]) {
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}
const pnpm = join(repo, "node_modules", ".pnpm");
const esbuild = findEsbuild(pnpm);
console.log("esbuild:", esbuild);
execFileSync("node", [esbuild, join(OUT,"assets-old.ts"), "--bundle", "--platform=node", "--format=cjs",
  "--tsconfig=" + join(desktop,"tsconfig.json"), "--outfile=" + join(OUT,"assets-old.cjs"), "--log-level=error"], { cwd: desktop });
const m = await import("file://" + join(OUT, "assets-old.cjs").replace(/\\/g, "/"));
const PY = m.MINERU_PY ?? m.default?.MINERU_PY;
console.log("old MINERU_PY bytes:", PY.length);
writeFileSync(join(OUT, "mineru_transcribe.py"), PY);
writeFileSync(join(OUT, "src.pdf"), "%PDF fake");
const probe = `
import sys
sys.path.insert(0, ${JSON.stringify(OUT)})
import mineru_transcribe as m
def _boom(*a, **k): raise RuntimeError("SENTINEL_NET")
m.http_json = _boom
try:
    m.transcribe_one({"itemId": "../\u9003\u9038x", "filePath": ${JSON.stringify(join(OUT,"src.pdf"))}}, 1)
    print("@@no-raise")
except RuntimeError as e:
    print("@@raised:" + str(e))
`;
writeFileSync(join(OUT, "probe.py"), probe);
const res = spawnSync("python", ["-u", join(OUT,"probe.py")], { cwd: join(OUT,"cwd"), encoding: "utf8" });
console.log("PROBE OUT:", (res.stdout||"") + (res.stderr||""));
const escaped = join(OUT, "cwd", "\u9003\u9038x");
console.log("ESCAPED_DIR_CREATED(outside mineru/):", existsSync(escaped) && statSync(escaped).isDirectory());
console.log("mineru/ has it:", existsSync(join(OUT,"cwd","mineru","\u9003\u9038x")));
