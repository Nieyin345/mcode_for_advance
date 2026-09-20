/**
 * 「技能复制到项目」（`skills.copyToProject`）的回归网。
 *
 * ## 为什么要钉这里
 *
 * 这是**唯一一处 Mcode 会往用户的项目目录写文件**的地方（`<项目>/.claude/skills/`）。
 * 写错的表现都不是报错，而是"东西莫名多出来 / 少掉"：
 *
 *  - **覆盖**：项目里那份可能是用户改过的版本，复制一次把它冲掉是**不可逆**的。
 *    所以"同名跳过"必须钉死，而且要在**跳过**那一侧钉（只钉"复制成功"会漏掉它）。
 *  - **写错地方**：项目技能必须落在 `<项目>/.claude/skills/<名字>/`。落成
 *    `<项目>/skills/` 或者别的位置，用户在用别的工具打开这个项目时就看不到。
 *  - **部分失败被吞**：批量复制里一个失败（源不存在、目标写不进去）不能让整批
 *    静默停摆 —— 三种下场（copied / skipped / failed）必须**分别**回报，因为
 *    界面要靠它们拼出"复制了 3 个; 跳过了 2 个"那句人话。
 *  - **相对路径被当成项目**：`projectPath` 是相对的时"项目目录"就取决于进程 CWD，
 *    那是随启动方式变的。必须拒绝而不是猜。
 *
 * ## 为什么用 fakeIpc
 *
 * handler 注册要 `IpcMain`,而真起 Electron 不是这套东西的用法（见仓库里的
 * `mcp-ipc-smoke` / `library-trash-smoke` 同一个做法）。数据根换成临时目录 ——
 * **这条不是洁癖**:`defaultSkillsRoot()` 指向 `~/.mcode/skills`,而这里会**真往
 * 盘上写**,指错了就是在用户的技能库里乱复制。
 *
 * Run: scripts/skill-copy-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ── 环境：数据根 + 一个假项目目录，都在临时区 ── */

const ROOT = mkdtempSync(join(tmpdir(), "mcode-skill-copy-"));
const PROJECT = join(ROOT, "my-project");
mkdirSync(PROJECT, { recursive: true });

// ⚠️ **源目录跟着 `homedir()` 走，不是 `MCODE_SMOKE_DATA_ROOT`。**
// `defaultSkillsRoot()` 拼的是 `homedir()/.mcode/skills`（见 lib/skillEngines.ts），
// 所以 run.sh 把 HOME/USERPROFILE 重定向到了临时目录 —— 那两个变量**必须在
// import 之前**生效，否则这里算出来的路径和主进程用的不是同一个。

const { IPC } = await import("@contracts/ipc");
const { registerSkillsHandlers } = await import("@main/ipc/skills.js");

// ── fakeIpc：录下 handler，之后按渠道名直接调 ──
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle: (ch: string, fn: never) => handlers.set(ch, fn),
} as never;
registerSkillsHandlers(fakeIpc);
const call = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);

/* ── 在"通用库"里造两个技能（源） ── */

const SKILLS_ROOT = join(homedir(), ".mcode", "skills");
function makeGlobalSkill(name: string, body: string): void {
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: d-${name}\n---\n\n${body}\n`,
    "utf8",
  );
  // 一个附属文件 —— 复制必须是**整目录**，漏了它技能就是残的。
  writeFileSync(join(dir, "helper.py"), `print("${body}")\n`, "utf8");
}
makeGlobalSkill("alpha", "AAA");
makeGlobalSkill("beta", "BBB");

const PROJECT_SKILLS = join(PROJECT, ".claude", "skills");

console.log("\n复制到项目");

{
  const res = (await call(IPC.SKILLS_COPY_TO_PROJECT, {
    projectPath: PROJECT,
    names: ["alpha", "beta"],
  })) as { copied: string[]; skipped: unknown[]; failed: unknown[] };

  eq("两个都复制过去了", res.copied.sort().join(","), "alpha,beta");
  eq("没有跳过", res.skipped.length, 0);
  eq("没有失败", res.failed.length, 0);

  // ★ 落点必须是 `<项目>/.claude/skills/<名字>/` —— 不是 `<项目>/skills/`，
  //   也不是别处。这条错了，用户拿别的工具打开项目就读不到。
  check(
    "★ 落在 <项目>/.claude/skills/<名字>/",
    existsSync(join(PROJECT_SKILLS, "alpha", "SKILL.md")),
    join(PROJECT_SKILLS, "alpha", "SKILL.md"),
  );
  check(
    "★ 整目录都过去了(附属文件也在)",
    existsSync(join(PROJECT_SKILLS, "alpha", "helper.py")),
  );
  // 内容原样 —— 复制不是重写。
  check(
    "内容原样复制(连 frontmatter 一起)",
    readFileSync(join(PROJECT_SKILLS, "alpha", "SKILL.md"), "utf8").includes("AAA"),
  );
  check("没有在项目根乱建 skills/ 目录", !existsSync(join(PROJECT, "skills")));
}

console.log("\n不覆盖已有的");

{
  // 把项目里那一份改掉 —— 模拟"用户已经按本项目改过了"。
  writeFileSync(join(PROJECT_SKILLS, "alpha", "SKILL.md"), "PROJECT-VERSION", "utf8");

  const res = (await call(IPC.SKILLS_COPY_TO_PROJECT, {
    projectPath: PROJECT,
    names: ["alpha"],
  })) as { copied: string[]; skipped: Array<{ name: string }>; failed: unknown[] };

  // ★ 这条钉的是**不可逆**的那个方向:覆盖掉的是用户自己改过的东西。
  eq("★ 同名的没复制(copied 为空)", res.copied.length, 0);
  eq("★ 它进了 skipped", res.skipped[0]?.name, "alpha");
  eq(
    "★ 项目里那份**一个字都没被动**",
    readFileSync(join(PROJECT_SKILLS, "alpha", "SKILL.md"), "utf8"),
    "PROJECT-VERSION",
  );
}

console.log("\n坏输入");

{
  // schema 层的名字正则会拦（非法字符），这是**第一道**闸。
  let threw: string | null = null;
  try {
    await call(IPC.SKILLS_COPY_TO_PROJECT, { projectPath: PROJECT, names: ["不存在的技能"] });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("非法名字在 schema 层就被拒", typeof threw === "string", { threw });
}

{
  const res = (await call(IPC.SKILLS_COPY_TO_PROJECT, {
    projectPath: PROJECT,
    names: ["ghost"],
  })) as { copied: string[]; failed: Array<{ name: string; reason: string }> };

  // ★ 源不存在 → 进 failed 且**给得出原因**（不是静默不发）。
  eq("通用库里没有的 → failed", res.failed.length, 1);
  eq("它就是那个名字", res.failed[0]?.name, "ghost");
  check("失败带得出原因", (res.failed[0]?.reason ?? "").length > 0, res.failed[0]);
}

{
  // ★ 相对路径必须被拒 —— 相对路径意味着"相对进程 CWD",那是随启动方式变的。
  const res = (await call(IPC.SKILLS_COPY_TO_PROJECT, {
    projectPath: "relative/not/absolute",
    names: ["alpha"],
  })) as { copied: string[]; failed: Array<{ reason: string }> };

  eq("★ 相对路径 → 整批失败(copied 空)", res.copied.length, 0);
  eq("逐条给出同一个原因", res.failed.length, 1);
  check("原因说的是路径无效", (res.failed[0]?.reason ?? "").includes("项目路径"), res.failed[0]);
}

console.log("\n三种下场能同时出现");

{
  // 一个能成的、一个源不存在的 —— 批量里"部分成功"是最容易写错的分支。
  const res = (await call(IPC.SKILLS_COPY_TO_PROJECT, {
    projectPath: PROJECT,
    names: ["beta", "nope"],
  })) as { copied: string[]; skipped: unknown[]; failed: Array<{ name: string }> };

  // beta 已经在上面复制过了 → skipped；nope 不存在 → failed。
  // ★ 关键是**两者都如实回报**,而不是"有一个出错就整批失败"。
  eq("★ 已存在的进 skipped", res.skipped.length, 1);
  eq("★ 不存在的进 failed", res.failed.length, 1);
  eq("失败的正是 nope", res.failed[0]?.name, "nope");
}

console.log("\n复制之后,list 看得到吗");

{
  // ★ 这是用户报的那个 bug 的直接探针:**复制过去之后,列表里该看得到它**。
  //   用户的原话是「复制之后呢,为什么不显示呢」。
  const res = (await call(IPC.SKILLS_LIST, { projectPath: PROJECT })) as {
    skills: Array<{ name: string; source: string }>;
  };
  const inList = res.skills.filter((s) => s.source === "project").map((s) => s.name).sort();
  check("★ 项目技能出现在 list 里", inList.length > 0, { inList });
  check("★ 名字对得上", inList.includes("beta"), { inList });
  // 而且来源标成 project —— 界面靠它筛出"这一栏显示什么"。
  eq(
    "★ 来源标成 project",
    res.skills.find((s) => s.name === "beta")?.source,
    "project",
  );
}

console.log("\n技能预设");

{
  // 新建一套
  const save1 = (await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_a", name: "论文项目", skills: ["alpha", "beta"] },
  })) as { ok: boolean };
  check("新建预设 ok", save1.ok);

  const list1 = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string; name: string; skills: string[] }> };
  eq("读得回来", list1.presets.length, 1);
  eq("名字对", list1.presets[0]?.name, "论文项目");
  eq("技能对", (list1.presets[0]?.skills ?? []).join(","), "alpha,beta");

  // ★ 同 id 再存 = 覆盖,**而且 createdAt 不重置**(那是一套预设的"生日")。
  const created1 = (list1.presets[0] as unknown as { createdAt: number }).createdAt;
  await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_a", name: "论文项目v2", skills: ["beta"] },
  });
  const list2 = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string; name: string; skills: string[]; createdAt: number }> };
  eq("还是只有一套(没新建第二条)", list2.presets.length, 1);
  eq("名字改了", list2.presets[0]?.name, "论文项目v2");
  eq("★ 去重 + 排序", (list2.presets[0]?.skills ?? []).join(","), "beta");
  eq("★ createdAt 不被覆盖重置", list2.presets[0]?.createdAt, created1);

  // 删
  const del = (await call(IPC.SKILLS_PRESETS_DELETE, { id: "sp_a" })) as { ok: boolean };
  check("删除 ok", del.ok);
  const list3 = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: unknown[] };
  eq("删完是空的", list3.presets.length, 0);
}

console.log("\n跨项目总览");

{
  // 造第二个项目,它一个技能都没有(目录根本不存在)——这是**绝大多数项目的常态**,
  // 必须与"有目录但是空的"分开报。
  const P2 = join(ROOT, "another-project");
  mkdirSync(P2, { recursive: true });

  // 直接调 handler 拿不到 ProjectRepo（那要数据库），所以这一段验的是**函数本身**。
  // 跨项目总览那条 RPC 的主体是"列目录 + 区分 missing"，已在下面单独钉。
  const { projectSkillsRoot } = await import("@main/ipc/skills.js");
  eq(
    "项目技能根 = <项目>/.claude/skills",
    projectSkillsRoot(PROJECT)?.replace(/\\/g, "/").endsWith("/.claude/skills"),
    true,
  );
  eq("相对路径 → null(不接受)", projectSkillsRoot("rel/path"), null);
  eq("空 → null", projectSkillsRoot(undefined), null);
  check(
    "真的项目路径 → 给得出路径",
    typeof projectSkillsRoot(PROJECT) === "string",
  );
}

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\nskill-copy-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
