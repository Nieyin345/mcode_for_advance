/**
 * repo-lockfile-smoke —— 【MC-038】根仓库只许有一份权威 lockfile。
 *
 * ## 盯的是什么
 *
 * 根目录曾同时版本管理 `pnpm-lock.yaml` 与 `package-lock.json`,而两份的依赖约束
 * 已经分叉(root `turbo ^2.10.9` vs lock `^2.9.0`、`node >=22.19.0` vs `>=22.13.0`)
 * —— 谁按 `package-lock.json` 装/扫,拿到的是**另一套解析结果**。全部 CI/release
 * 都用 `pnpm install --frozen-lockfile`,npm 锁文件**没有任何消费方**,是纯脏数据。
 * 已删除 + `.gitignore` 防再生。
 *
 * ## 判据立在"版本控制里有什么"上
 *
 * 不读文件内容(内容会漂),直接问 `git ls-files`:被跟踪的根锁文件**只能**是
 * `pnpm-lock.yaml`;`package.json` 的 `packageManager` 必须指 pnpm;`.gitignore`
 * 必须继续挡住 `package-lock.json`(防止某次 `npm install` 之后被无意提交回来)。
 * 另外钉住"被删的不再回来":工作区里**没有**被跟踪的 package-lock。
 *
 * ⚠️ 只读套件:不删、不写任何仓库文件,不碰数据根。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/**
 * 仓库根 —— **从 cwd 向上找 pnpm-workspace.yaml**。
 *
 * ⚠️ 不能用 `import.meta.url`:本套件经 esbuild 打进临时目录,那个 URL 指向
 * `/tmp/mcode-repo-lockfile.XXX/smoke.mjs`,上溯三层是 `/tmp`(实测报
 * "not a git repository")。run.sh 的 cwd 固定是 `apps/desktop`,真实仓库根
 * 在上两级 —— 用 marker 找比数层级稳(move 了套件目录也不会错)。
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml")) && existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`从 ${process.cwd()} 向上找不到仓库根(要 pnpm-workspace.yaml + .git)`);
}
const ROOT = findRepoRoot();

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// ── §1 唯一 lockfile ──
const lockfiles = tracked.filter((f) =>
  /^(package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb?)$/.test(f),
);
check(
  "★ 被跟踪的 lockfile 只有 pnpm-lock.yaml 一份",
  lockfiles.length === 1 && lockfiles[0] === "pnpm-lock.yaml",
  lockfiles,
);

// ── §2 packageManager 指向 pnpm(唯一安装器的声明) ──
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { packageManager?: string };
check(
  "★ 根 package.json 的 packageManager 声明 pnpm",
  typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@"),
  pkg.packageManager,
);

// ── §3 防再生:gitignore 继续挡住 package-lock.json ──
const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
check(
  "★ .gitignore 挡住根 package-lock.json(防止被无意重新提交)",
  /^\/package-lock\.json$/m.test(ignore),
);
// 实测 check-ignore(静态正则可能被别的规则误伤/失效)。
let ignored = true;
try {
  execFileSync("git", ["check-ignore", "-q", "package-lock.json"], { cwd: ROOT });
} catch {
  ignored = false;
}
check("★ git check-ignore 实测 package-lock.json 确实被忽略", ignored);

// ── §4 CI/release 用同一依赖事实源(pnpm frozen-lockfile,不得出现 npm ci) ──
for (const wf of ["ci.yml", "release.yml"]) {
  const text = readFileSync(path.join(ROOT, ".github", "workflows", wf), "utf8");
  check(`★ ${wf} 使用 pnpm install --frozen-lockfile`, /pnpm install --frozen-lockfile/.test(text));
  check(
    `★ ${wf} 没有 npm ci / npm install 的安装步骤`,
    !/^\s*run:\s*npm (ci|install)\b/m.test(text),
  );
}

console.log(`\nrepo-lockfile-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
