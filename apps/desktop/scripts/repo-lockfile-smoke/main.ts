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
 * 2026-10-19(本车道补强,MC-038 复核轮):`packageManager` 不能只检查
 * `startsWith("pnpm@")` —— 它会把 `pnpm@`(没版本,实际不冻结任何东西)也放绿。
 * 现在要求**精确三段版本** `pnpm@d+.d+.d+`,并且与仓库实际安装状态对齐:
 * 有 `node_modules/.modules.yaml` 时其 `packageManager` 必须是同一字符串(锁文件
 * `pnpm-lock.yaml` 自身不记录包管理器版本,`.modules.yaml` 是 pnpm 落下的实际事实)。
 * 另外补两条:① CI/release 的 `pnpm/action-setup` 无 `version:` 覆盖 —— 它从
 * `packageManager` 取版本,若某天 workflow 钉死另一版本就与本地分叉了;② 仓库根
 * 只认 pnpm-lock.yaml,工作区里散落的未跟踪 package-lock(例如被某个 npm 命令
 * 重新生成)也算"第二套输入",除非它们位于 .gitignore 明确挡住的 vendor 目录
 * (`/genoffice/`、`/open-claude-ui/` —— 第三方快照自带锁文件,不属于本仓库)。
 *
 * ⚠️ 只读套件:不删、不写任何仓库文件,不碰数据根。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// ── §2 packageManager 指向 pnpm(唯一安装器的声明,精确版本) ──
// 空过历史:`startsWith("pnpm@")` 对 `pnpm@`(无版本号)也返回 true —— 那等于
// 声称了包管理器却没冻结任何版本。这里要求三段精确版本。
const PINNED = /^pnpm@(\d+)\.(\d+)\.(\d+)$/;
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { packageManager?: string };
const pm = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
check(
  "★ 根 package.json 的 packageManager 是精确 pnpm 版本(pnpm@X.Y.Z)",
  PINNED.test(pm),
  pkg.packageManager,
);
// 与仓库实际安装状态对齐(有 node_modules 时才验;干净 checkout / CI 装依赖前没有
// `.modules.yaml`,此时跳过不算失败 —— 但下面的 .gitignore/CI 断言依然是全部证据)。
const modulesYaml = path.join(ROOT, "node_modules", ".modules.yaml");
if (existsSync(modulesYaml)) {
  const installed = readFileSync(modulesYaml, "utf8").match(/^\s*"?packageManager"?:\s*"([^"]+)"/m)?.[1];
  check(
    "★ node_modules/.modules.yaml 里 pnpm 实际记录的版本与 packageManager 一致",
    installed === pm,
    { packageManager: pm, installed },
  );
}

// ── §2b 磁盘上也不许有第二套输入 ──
// 根目录的 package-lock.json 即便被 .gitignore 挡住(不入库),存在本身仍说明有人
// 在本仓库跑过 npm 安装/审计,拿到的解析结果与 pnpm-lock 不同 —— 显式报出来,
// 而不是等等看会不会被提交。vendor 快照(genoffice/、open-claude-ui/)是第三方
// 自带锁文件,不是本仓库的安装事实,不在此列。
const strayLocks: string[] = [];
const rootLock = path.join(ROOT, "package-lock.json");
if (existsSync(rootLock)) strayLocks.push("package-lock.json");
// 各 pnpm workspace 包(apps/*、packages/*)也不许自带 npm 锁文件:
// workspace 的依赖事实只有根 pnpm-lock.yaml 一份。
for (const group of ["apps", "packages"]) {
  const groupDir = path.join(ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(path.join(groupDir, entry.name, "package-lock.json"))) {
      strayLocks.push(`${group}/${entry.name}/package-lock.json`);
    }
  }
}
check(
  "★ 磁盘上没有散落的 package-lock.json(根目录与各 workspace 包;vendor 快照除外)",
  strayLocks.length === 0,
  strayLocks,
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
  // pnpm/action-setup@v4 无 `version:` 时从 packageManager 读版本 —— 这正是
  // packageManager 的跨环境价值。若某个 workflow 单独钉了另一个版本,本地与 CI
  // 就各跑各的 pnpm 解析器(锁文件格式/overrides 行为可能不同)。错误写法:
  //     - uses: pnpm/action-setup@v4
  //       with:
  //         version: 9          ← 会覆盖 packageManager,分叉
  const setupBlocks = text.split(/uses:\s*pnpm\/action-setup@/).slice(1);
  check(`★ ${wf} 至少有一处 pnpm/action-setup`, setupBlocks.length > 0);
  const overridden = setupBlocks.filter((block) => /^\s*version\s*:/m.test(block.split(/\n\s*-\s+/)[0] ?? block));
  check(
    `★ ${wf} 的 pnpm/action-setup 不覆盖 version(版本只由 packageManager 决定)`,
    overridden.length === 0,
    overridden.length,
  );
}

console.log(`\nrepo-lockfile-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
