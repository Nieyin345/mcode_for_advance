/**
 * repositories-barrel-smoke —— 拆分之后**导出面不许少一个**的回归网。
 *
 * ## 盯的是什么
 *
 * `main/store/repositories.ts` 从 3277 行、13 张表挤在一起，拆成
 * `repositories/<实体>.ts` + 一个 barrel。**90 个消费方**靠 `import { XxxRepo }
 * from "@main/store/repositories.js"` 活着 —— 拆分只要漏导出一个符号，
 * 类型检查**不一定**当场红（消费者可能没被 tsc 覆盖到，或只在运行时才炸）。
 *
 * 所以这条判据立在一个**与实现无关的清单**上：拆分前导出的 19 个名字
 * （+ `SYSTEM_AUTOMATION_PROJECT_ID`），今天必须一个不少、一个不多。
 *
 * ## 为什么清单写死在这里
 *
 * 它**就是**"对外契约"本身。将来真要增删导出，改这个清单 + barrel 一起改 ——
 * 那是一次**有意的**契约变更，本就该有人看一眼。悄悄少一个才是要防的。
 *
 * ## 它怎么跑
 *
 * 不起 Electron：barrel 只是转发，但它的依赖链会摸到 `electron`（`db.ts`）。
 * 所以按仓库惯例换掉 `electron` / `dataRoot` / `logger` 三个桩，
 * 然后 `await import` barrel 本身，**看它实际导出了什么**。
 *
 * Run: scripts/repositories-barrel-smoke/run.sh
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 拆分前 `repositories.ts` 导出的**全部**名字 —— 对外契约。 */
const CONTRACT = [
  "SYSTEM_AUTOMATION_PROJECT_ID",
  "ProjectRepo",
  "SessionRepo",
  "MessageRepo",
  "SettingRepo",
  "WorkflowRepo",
  "WorkflowRunRepo",
  "SceneDeploymentRepo",
  "HookRunRepo",
  "LibraryRepo",
  "CollectionRepo",
  "NoteRepo",
  "LibraryLinkRepo",
  // 拆分前也导出的常量 —— 我自己第一版契约清单漏了它，是这个套件把它揪出来的。
  "HOOK_RUNS_RETAIN",
].sort();

/** 拆分前导出的**类型** —— 只在这条断言里存在，不参与运行期导入。 */
const CONTRACT_TYPES = [
  "WorkflowRow",
  "WorkflowRunStatus",
  "WorkflowRunRow",
  "SceneDeploymentRow",
  "HookRunRow",
  "LibraryListFilter",
].sort();

/** 拆分前 `repositories.ts` 导出的**值**里，那一个常量之外的 Repo 对象。 */
const REPOS = CONTRACT.filter((n) => n.endsWith("Repo"));

/* ─────────────── §A 运行期：barrel 真的导出了这些值 ─────────────── */

console.log("\n§A barrel 的运行期导出面");
{
  const mod = (await import("@main/store/repositories.js")) as Record<string, unknown>;

  const missing = CONTRACT.filter((n) => !(n in mod));
  check("★ 契约里的每个名字都能从 barrel 取到", missing.length === 0, missing);

  const extra = Object.keys(mod).filter((n) => !CONTRACT.includes(n));
  check("barrel 没有多导出契约外的运行期名字", extra.length === 0, extra);

  // Repo 对象必须是「有 list/get 之类方法的对象」—— 防"导出了但值不对"
  const badShape = REPOS.filter((n) => {
    const v = mod[n];
    return typeof v !== "object" || v === null || Object.keys(v).length === 0;
  });
  check("★ 每个 Repo 都是有方法成员的对象（不是 undefined/null/空壳）", badShape.length === 0, badShape);

  check(
    "SYSTEM_AUTOMATION_PROJECT_ID 还是那个值",
    mod["SYSTEM_AUTOMATION_PROJECT_ID"] === "proj_internal_automation",
    mod["SYSTEM_AUTOMATION_PROJECT_ID"],
  );
}

/* ─────────────── §B 源码：每个 Repo 在自己的实体文件里 ─────────────── */

console.log("\n§B 实体拆分（每个 Repo 一个文件）");
{
  const dir = join(process.cwd(), "src/main/store/repositories");
  check("repositories/ 目录存在（拆分发生过）", existsSync(dir));

  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")) : [];
  check("目录里有多个实体文件（不是又攒回一个）", files.length >= 10, files.length);

  // 每个 Repo 必须**恰好**在一个实体文件里定义（不多不少）—— 防"复制一份到别处各改各的"
  const where = new Map<string, string[]>();
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const repo of REPOS) {
      if (new RegExp(`^export const ${repo}\\b`, "m").test(text)) {
        where.set(repo, [...(where.get(repo) ?? []), f]);
      }
    }
  }
  const dup = [...where.entries()].filter(([, fs]) => fs.length !== 1);
  check(
    "★ 每个 Repo 恰好在一个实体文件里定义（没有第二份副本）",
    dup.length === 0,
    dup.map(([n, fs]) => `${n}: ${fs.join(",")}`),
  );

  check("13 个 Repo 全部找到了落点", where.size === REPOS.length, {
    found: where.size,
    expected: REPOS.length,
  });
}

/* ─────────────── §C 源码：barrel 本身只转发，不藏实现 ─────────────── */

console.log("\n§C barrel 保持只转发（无实现）");
{
  const src = readFileSync(join(process.cwd(), "src/main/store/repositories.ts"), "utf8");
  const lines = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*") && !l.trim().startsWith("*/"));
  const nonExport = lines.filter((l) => !l.trim().startsWith("export "));
  check("★ barrel 里除了 export 语句没有别的代码", nonExport.length === 0, nonExport);
  check("barrel 行数在合理范围（是转发层，不是又长回来了）", lines.length < 40, lines.length);

  // 类型必须用 `export type`（isolatedModules）—— 用值导出会在运行时炸
  const typeAsValue = CONTRACT_TYPES.filter((t) => new RegExp(`^export \\{ [^}]*\\b${t}\\b`, "m").test(src));
  check("★ 纯类型都是 export type（不是 export { }）", typeAsValue.length === 0, typeAsValue);
}

console.log(`\nrepositories-barrel-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
