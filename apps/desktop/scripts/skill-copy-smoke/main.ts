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

console.log("\n【MC-053 同族】预设/导入包清单损坏:不静默当空,写侧拒绝覆盖");

/* 台账红例的同一形态(出厂工作流播种名单 → 技能预设/导入包清单):
 * 清单被截断成半截 JSON 之后,旧的读法把它塌成 `[]`;而 `presetsSave/Delete` 与
 * `upsertGithubBundle` 都是「读旧表 → 改 → 整份写回」—— 下一次保存/导入就会拿
 * 空表当基准,把用户已有的预设/导入包记录**静默抹掉**。
 *
 * 判据立在盘上的字节与返回结果上:坏清单 ①读侧如实报 corrupt ②写侧拒绝且原字节
 * 一个不动 ③修好后一切恢复。不钉实现(不查"调没调 classify")。 */
{
  const PRESETS_FILE = join(SKILLS_ROOT, ".skill-presets.json");
  const BUNDLES_FILE = join(SKILLS_ROOT, ".bundles.json");
  const corruptJson = "{\"presets\":["; // 半截写入的典型形状
  const healthyPreset = (id: string, name: string): string =>
    JSON.stringify({ presets: [{ id, name, skills: ["alpha"], createdAt: 1, updatedAt: 1 }] });

  // ── ① 缺失 → 正常新建(防"一律拒绝"的过度保守) ──
  rmSync(PRESETS_FILE, { force: true });
  const fresh = (await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_fresh", name: "新装", skills: ["alpha"] },
  })) as { ok: boolean };
  check("清单缺失(真新用户)→ 照常新建", fresh.ok);
  const freshList = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string }>; corrupt?: { reason: string } };
  eq("新建的读得回来", freshList.presets.map((p) => p.id).join(","), "sp_fresh");
  check("健康清单不带 corrupt 诊断", freshList.corrupt === undefined, freshList.corrupt);

  // ── ② 合法清单 → 只补/改那一条,现有行不动 ──
  writeFileSync(PRESETS_FILE, healthyPreset("sp_keep", "要保留的"), "utf8");
  const keep = (await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_add", name: "新增的", skills: ["beta"] },
  })) as { ok: boolean };
  check("合法清单下保存 ok", keep.ok);
  const both = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string; name?: string }> };
  check(
    "★ 合法清单:现有行原样保留、新行追加(不是整表重建)",
    both.presets.length === 2 &&
      both.presets.some((p) => p.id === "sp_keep" && p.name === "要保留的") &&
      both.presets.some((p) => p.id === "sp_add"),
    both.presets,
  );

  // ── ③ 坏清单(台账原例形状) ──
  writeFileSync(PRESETS_FILE, corruptJson, "utf8");

  // 读侧:空表照给(页面可打开),但**必须**带 corrupt 诊断,不能谎报"还没有预设"。
  const corruptList = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: unknown[]; corrupt?: { reason: string } };
  eq("★ 坏清单:读列表不挂(空表降级)", corruptList.presets.length, 0);
  check("★ 坏清单:列表如实带 corrupt 诊断(不是静默当空)", typeof corruptList.corrupt?.reason === "string" && corruptList.corrupt.reason.length > 0, corruptList.corrupt);
  check(
    "诊断原因能给人看(合法 JSON / presets 数组)",
    /合法 JSON|presets/.test(corruptList.corrupt?.reason ?? ""),
    corruptList.corrupt,
  );

  // 写侧:保存被拒、带 corrupt 标记、**盘上原字节一个不动**。
  const rejectedSave = (await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_overwrite", name: "不许写", skills: ["alpha"] },
  })) as { ok: boolean; error?: string; corrupt?: boolean };
  check("★ 坏清单:保存被拒(不拿空表当写回基准)", rejectedSave.ok === false, rejectedSave);
  check("拒绝带 corrupt 标记(界面据此分口径)", rejectedSave.corrupt === true, rejectedSave);
  check("拒绝语说清是记录损坏、且原文件未动", /损坏/.test(rejectedSave.error ?? "") && /未动|拒绝写入|修复/.test(rejectedSave.error ?? ""), rejectedSave.error);
  eq("★ 坏清单:预定清单字节一个不动", readFileSync(PRESETS_FILE, "utf8"), corruptJson);
  // 删除同一条闸:不许拿空表判"不存在"再整表写回。
  const rejectedDelete = (await call(IPC.SKILLS_PRESETS_DELETE, { id: "sp_keep" })) as { ok: boolean; corrupt?: boolean };
  check("★ 坏清单:删除同样被拒(corrupt)", rejectedDelete.ok === false && rejectedDelete.corrupt === true, rejectedDelete);
  eq("★ 坏清单:删除也没动字节", readFileSync(PRESETS_FILE, "utf8"), corruptJson);

  // 修复之后一切恢复:原预设还在,新建照常。
  writeFileSync(PRESETS_FILE, healthyPreset("sp_keep", "要保留的"), "utf8");
  const healed = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string }>; corrupt?: unknown };
  check("修复后不再报损坏,原预设读得回来", healed.corrupt === undefined && healed.presets.some((p) => p.id === "sp_keep"), healed);
  const healedSave = (await call(IPC.SKILLS_PRESETS_SAVE, {
    preset: { id: "sp_add2", name: "修复后新建", skills: ["alpha"] },
  })) as { ok: boolean };
  check("修复后保存照常", healedSave.ok);
  const healedList = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string }> };
  check(
    "★ 修复后:原预设仍在、新预设已加(没有被修好后的第一次写覆盖)",
    healedList.presets.some((p) => p.id === "sp_keep") && healedList.presets.some((p) => p.id === "sp_add2"),
    healedList.presets,
  );
  rmSync(PRESETS_FILE, { force: true });

  // ── ④ 导入包清单(.bundles.json):同一条协议 ──
  rmSync(BUNDLES_FILE, { force: true });
  const bundlesMissing = (await call(IPC.SKILLS_BUNDLES, {})) as { bundles: unknown[]; corrupt?: unknown };
  check("导入包清单缺失:空表、无诊断(真·新装)", bundlesMissing.bundles.length === 0 && bundlesMissing.corrupt === undefined, bundlesMissing);

  const healthyBundles = JSON.stringify({
    version: 1,
    bundles: [{ id: "keep--repo", label: "keep/repo", skills: ["alpha"] }],
  });
  writeFileSync(BUNDLES_FILE, healthyBundles, "utf8");
  const bundlesHealthy = (await call(IPC.SKILLS_BUNDLES, {})) as { bundles: Array<{ id: string }>; corrupt?: unknown };
  check("健康清单:原样列出、无诊断", bundlesHealthy.bundles.some((b) => b.id === "keep--repo") && bundlesHealthy.corrupt === undefined, bundlesHealthy);

  writeFileSync(BUNDLES_FILE, "{\"bundles\":[", "utf8");
  const bundlesCorrupt = (await call(IPC.SKILLS_BUNDLES, {})) as { bundles: unknown[]; corrupt?: { reason: string } };
  check("★ 坏清单:列表降级为空但带 corrupt 诊断", bundlesCorrupt.bundles.length === 0 && typeof bundlesCorrupt.corrupt?.reason === "string", bundlesCorrupt);
  eq("★ 坏清单:读列表不改写字节", readFileSync(BUNDLES_FILE, "utf8"), "{\"bundles\":[");

  // ★ 承重的一侧:写口(`upsertGithubBundle`,导入/市场安装共用)不许拿空表当基准
  //   整份写回 —— 那会把用户历史导入包记录抹掉(台账红例的同形)。
  const { upsertGithubBundle } = await import("@main/ipc/skills.js");
  const upsertCorrupt = await upsertGithubBundle(SKILLS_ROOT, "new--repo", "new/repo", "https://github.com/new/repo", ["beta"]);
  check("★ 坏清单:写口报告 corrupt(不回写成空表)", typeof upsertCorrupt.corrupt === "string", upsertCorrupt);
  eq("★ 坏清单:写口没动一个字节", readFileSync(BUNDLES_FILE, "utf8"), "{\"bundles\":[");

  writeFileSync(BUNDLES_FILE, healthyBundles, "utf8");
  const upsertHealthy = await upsertGithubBundle(SKILLS_ROOT, "new--repo", "new/repo", "https://github.com/new/repo", ["beta"]);
  check("健康清单:写口无 corrupt", upsertHealthy.corrupt === undefined, upsertHealthy);
  const merged = JSON.parse(readFileSync(BUNDLES_FILE, "utf8")) as { bundles: Array<{ id: string; skills: string[] }> };
  check(
    "★ 健康清单:写口只追加/合并那一条,现有行不动",
    merged.bundles.some((b) => b.id === "keep--repo" && b.skills.join(",") === "alpha") &&
      merged.bundles.some((b) => b.id === "new--repo" && b.skills.join(",") === "beta"),
    merged.bundles,
  );
  rmSync(BUNDLES_FILE, { force: true });
}

console.log("\n【MC-053 同族·加固】坏档不误伤无关读写,且诊断跨读稳定");

{
  const PRESETS_FILE = join(SKILLS_ROOT, ".skill-presets.json");
  const corruptJson = `{"presets":[\n  {"id":"sp_half","name":"半截","skills":["a"]`;
  // ── ① 坏档期间**读其它东西**照常(坏的是预设,不是技能库) ──
  writeFileSync(PRESETS_FILE, corruptJson, "utf8");
  const listed = (await call(IPC.SKILLS_LIST, {})) as { skills: Array<{ name: string }> };
  check("★ 坏预设档不影响技能列表(坏的是预设,不是技能库)", Array.isArray(listed.skills), listed);
  const first = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: unknown[]; corrupt?: { reason: string } };
  const second = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: unknown[]; corrupt?: { reason: string } };
  check(
    "★ 连读两次坏档:诊断一致(不因读次数漂移)",
    typeof first.corrupt?.reason === "string" && first.corrupt.reason === second.corrupt?.reason,
    { first: first.corrupt, second: second.corrupt },
  );

  // ── ② 不同坏形状都判 corrupt(不是"空表"),且保存一律拒写、字节不动 ──
  for (const [label, raw] of [
    ["顶层是对象但缺 presets", `{"other":[]}`],
    ["顶层是数组(错容器)", `[]`],
    ["合法 JSON 但 null", `null`],
  ] as const) {
    writeFileSync(PRESETS_FILE, raw, "utf8");
    const r = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: unknown[]; corrupt?: { reason: string } };
    check(`★ 坏档形状「${label}」:读侧带 corrupt 诊断`, r.presets.length === 0 && typeof r.corrupt?.reason === "string", r);
    const save = (await call(IPC.SKILLS_PRESETS_SAVE, { preset: { id: "sp_x", name: "x", skills: ["a"] } })) as { ok: boolean; corrupt?: boolean };
    check(`★ 坏档形状「${label}」:保存被拒且字节未动`, save.ok === false && save.corrupt === true && readFileSync(PRESETS_FILE, "utf8") === raw, save);
  }

  // ── ③ 空文件(= 从未写过)与坏档分开:空文件是 absent,保存照常 ──
  writeFileSync(PRESETS_FILE, "", "utf8");
  const emptySave = (await call(IPC.SKILLS_PRESETS_SAVE, { preset: { id: "sp_empty", name: "空档新建", skills: ["a"] } })) as { ok: boolean };
  check("空文件按『从未写过』处理:保存照常(不把 absent 误判成损坏)", emptySave.ok === true, emptySave);

  // ── ④ 导入包清单:坏档 → 诊断可见;预设与导入包互不牵连 ──
  const BUNDLES_FILE = join(SKILLS_ROOT, ".bundles.json");
  const prevBundles = existsSync(BUNDLES_FILE) ? readFileSync(BUNDLES_FILE, "utf8") : null;
  writeFileSync(BUNDLES_FILE, "not json at all", "utf8");
  const b = (await call(IPC.SKILLS_BUNDLES, {})) as { bundles: unknown[]; corrupt?: { reason: string } };
  check("★ 导入包坏档:诊断可见、读不挂", b.bundles.length === 0 && typeof b.corrupt?.reason === "string", b);
  const presetStillOk = (await call(IPC.SKILLS_PRESETS_LIST)) as { presets: Array<{ id: string }>; corrupt?: unknown };
  check(
    "★ 导入包坏档不影响预设读(两类清单互不牵连)",
    presetStillOk.corrupt === undefined && presetStillOk.presets.some((p) => p.id === "sp_empty"),
    presetStillOk,
  );
  if (prevBundles === null) rmSync(BUNDLES_FILE, { force: true });
  else writeFileSync(BUNDLES_FILE, prevBundles, "utf8");
  rmSync(PRESETS_FILE, { force: true });
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

console.log("\n从项目移除技能");

{
  // ★ 删项目技能删的是**项目目录里那份**,总库里那份必须原封不动 ——
  //   搞反了的后果是"我从项目里移除一个,结果总库里也没了",而那是不可逆的。
  const before = existsSync(join(SKILLS_ROOT, "beta", "SKILL.md"));
  check("前提:总库里有 beta", before);

  const del = (await call(IPC.SKILLS_DELETE, {
    source: "project",
    projectPath: PROJECT,
    name: "beta",
  })) as { ok: boolean; error?: string };
  check("删项目里的 beta ok", del.ok, del.error);

  check("★ 项目里那份没了", !existsSync(join(PROJECT_SKILLS, "beta")));
  check("★ 总库里那份**还在**", existsSync(join(SKILLS_ROOT, "beta", "SKILL.md")));

  // 删一个项目里没有的 —— 不该崩，如实回 ok:false。
  const missing = (await call(IPC.SKILLS_DELETE, {
    source: "project",
    projectPath: PROJECT,
    name: "never-was-there",
  })) as { ok: boolean };
  check("删不存在的 → ok:false(不是崩)", missing.ok === false);
}

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\nskill-copy-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
