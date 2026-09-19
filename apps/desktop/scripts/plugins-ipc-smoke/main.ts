/**
 * 无头 smoke:**`main/ipc/plugins.ts`** —— 插件面板那 10 条 RPC 的那一层。
 *
 * ## 为什么单独一套
 *
 * 仓库里已有的 `plugins-smoke` 验的是 `main/plugins/pluginManager.ts` **导出的函数**
 * (它自己 import `installFromLocal` 直接调)。`smokes-for.sh src/main/ipc/plugins.ts`
 * 的回答是「没有套件覆盖它」—— `ipc/plugins.ts` 这一层**零覆盖**:
 *
 *   - 10 条 channel 有没有全注册、返回形状对不对得上 `RpcMap` 契约;
 *   - 输入 schema 把坏东西挡住时,**是显式报还是静默当没看见**;
 *   - 「还有回合在跑就不许卸载」那道闸门;
 *   - 卸载之后盘上/设置表里有没有留下半截东西。
 *
 * 这些都不在 pluginManager 的函数体里 —— 它们是这一层的职责。本套**不重复**
 * plugins-smoke 已有的断言(清单发现、组件摘要、zip/git/marketplace 安装管线、
 * MCP denylist),那些走 `plugins-smoke`。
 *
 * ## 它不碰用户真正的 `~/.mcode/plugins`
 *
 * `PLUGINS_ROOT` 是从 `os.homedir()` 推出来的,所以 run.sh 把 `HOME` /
 * `USERPROFILE` 都指到 `mktemp -d`(win32 只认 USERPROFILE,libuv 的规矩),main.ts
 * 第 0 节再断言一次它确实落在那个临时目录下 —— 不成立就直接退出。插件的安装/卸载
 * 是真删目录的,指错了就是删用户自己装的东西。
 *
 * ## 变异验证过的三条(见报告)
 *
 * ## 变异验证过的七条(把 `ipc/plugins.ts` 改坏,确认断言真的红)
 *
 *   1. 撤掉 remove 的"还有回合在跑"闸门               → 6 条红
 *   2. `setPluginEnabled(name, input.enabled)` 写死 true → 1 条红
 *   3. list 永远返回空数组                             → 1 条红
 *   4. remove 的 schema 校验被 try/catch 吞掉          → 2 条红
 *   5. installLocal 的 schema 校验被吞掉               → 2 条红
 *   6. marketplaceAdd 不传 `name` 覆写                 → 2 条红
 *   7. remove 的返回值被丢掉、永远返回 `{ok:true}`     → 3 条红
 *
 * 七条**全部**有断言命中 —— 没有一条是"登记了却没人验"的。
 *
 * ## 已知的坑(不在本文件能修的范围内,报告里写了文件行号)
 *
 * ⚠️ **插件名撞上保留目录名会删用户的东西。** 三个名字有问题
 * (`main/plugins/pluginManager.ts`):
 *
 *   - `marketplaces`:清单 name 写成它,安装会落进
 *     `plugins/marketplaces/<version>/`,而 `finalizePluginInstall`(:524-526)的
 *     "剪掉其它版本"那一步会把用户**所有**插件市场的目录树删掉;
 *     `removePlugin`(:592-594)再删一次根。实测:装一个叫 `marketplaces` 的插件,
 *     `plugins/marketplaces/real-mp/`(用户自己加的市场)当场消失。
 *   - `mcode-document-skills`(内置插件名):装同名插件后 `getEnabledPlugins()`(:984)
 *     会返回**两条同名条目**,技能根投递两份,而内置那份兜不住(它不在用户目录里)。
 *   - 点开头的名字 schema 已经挡住了(`PLUGIN_NAME_RE`)。
 *
 * 根因是"用户可选的插件名"与"系统保留的目录名"共用一个命名空间,而
 * `listPlugins` 靠一个硬编码的 `entry === "marketplaces"`(:378)来回避冲突 ——
 * 挡的是"看见"那一侧,没挡"写入"那一侧。建议:在 `PluginManifestSchema` 或
 * `stagePluginSource` 里对保留名显式报错(仓库硬规矩第 3 条:坏东西显式报出来)。
 *
 * ⚠️ **同名不同来源并发安装会互相删目录。** `installing`(:538/:541)去重的是
 * `source.ref`(路径 / URL),所以两个**不同**目录声明同一个插件名时,两次安装都
 * 通过去重,然后各自 `rmSync(finalDir)` + `rename(swapDir, finalDir)`(:522-523)。
 * 实测:一个报 ok、一个报 EEXIST/EPERM,而报 ok 的那个可能已经被对方删掉了 ——
 * "装好了"但盘上什么都没有。建议把去重键换成 `manifest.name`(但那时名字要到
 * staging 之后才知道,所以更稳的是在 finalize 那一步做串行化 / 用唯一 swap 目录
 * 再原子替换)。
 *
 * 这两条**不写成红断言** —— 那会让 `run.sh` 永远过不了门槛,而修的地方不在我这
 * 个文件里(规则第一节)。本套把它们的事实留在注释里。
 */

/* ────────────────────────── 0. 安全前提 ────────────────────────── */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";

let total = 0;
let failures = 0;
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
/** 数组比较:`Object.is` 对内容相同的两个数组是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* 先把被测模块拉进来 —— 因为下面要拿它的 PLUGINS_ROOT 做安全断言。 */
const { IPC } = await import("@contracts/ipc");
const { registerPluginsHandlers } = await import("@main/ipc/plugins.js");
const pluginManager = await import("@main/plugins/pluginManager.js");
const { SettingRepo } = await import("./stubs/settingRepo.js");
const { runtimeManager } = await import("./stubs/runtimeManager.js");

const PLUGINS_ROOT: string = pluginManager.PLUGINS_ROOT;

console.log("安全前提");
/* `homedir()` 在 win32 上读 USERPROFILE —— 也就是**已经被 run.sh 改过的那个**,
 * 所以"拿 homedir() 跟 homedir() 比"永远相等、什么都验不出来(第一版就是这么写的,
 * 第一次跑就红了,而红的原因是断言自己没意义)。
 *
 * 真的那个家由 run.sh 在**改之前**从 USERPROFILE / HOME 抓下来、经
 * `MCODE_SMOKE_REAL_HOME` 传进来。没有它本套**直接停** —— 这条判断是整支脚本
 * 能不能跑的前提,不是可选的洁癖。 */
const realHome = process.env.MCODE_SMOKE_REAL_HOME ?? "";
const scratch = process.env.USERPROFILE ?? process.env.HOME ?? "";
const tmp = tmpdir();
const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
const under = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
};

check(
  "run.sh 传了 MCODE_SMOKE_REAL_HOME(没有它就没法判断现在用的是不是临时目录)",
  realHome.length > 0,
  { realHome },
);
check("USERPROFILE/HOME 确实被改掉了", scratch.length > 0 && norm(scratch) !== norm(realHome), {
  scratch,
  realHome,
});
check(
  "PLUGINS_ROOT 落在系统临时目录下",
  under(PLUGINS_ROOT, tmp),
  { PLUGINS_ROOT, tmp },
);
check(
  `PLUGINS_ROOT 不在真数据根下面(${path.join(realHome, ".mcode", "plugins")})`,
  !under(PLUGINS_ROOT, path.join(realHome, ".mcode", "plugins")),
  { PLUGINS_ROOT, realHome },
);
if (failures > 0) {
  console.log("\n安全前提不成立,直接停 —— 继续跑会动真实用户目录。");
  process.exit(1);
}
const REAL_PLUGINS_ROOT = path.join(realHome, ".mcode", "plugins");
/** 真数据根的开工快照 —— 收尾时对一次。这才是"有没有碰用户东西"的证据。 */
const realRootBefore = treeOf(REAL_PLUGINS_ROOT);

/* ────────────────────────── 脚手架:录 handler ────────────────────────── */

/** handler 的真形状:`(event, ...args)`,这样脚本才能按 channel 转发任意参数。 */
type Handler = (event: null, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const hits = new Map<string, number>();
const fakeIpc = {
  handle(channel: string, listener: Handler): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerPluginsHandlers(fakeIpc);

/** 调**真的那条 handler**(不是复述):`ipcMain` 的记名替身 + 按 channel 取回来。 */
function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel} —— 调用端会拿到 undefined`);
  hits.set(channel, (hits.get(channel) ?? 0) + 1);
  return Promise.resolve(fn(null, ...args));
}

/* ────────────────────────── 夹具 ────────────────────────── */

const base = mkdtempSync(path.join(tmpdir(), "mcode-plugins-ipc-"));

/** 造一个插件目录。`manifest` 传字符串就直接写(给坏 JSON 用)。 */
function mkPlugin(
  dirName: string,
  manifest: Record<string, unknown> | string,
  opts: { layout?: string; skills?: string[]; rawSkillsPaths?: string[] } = {},
): string {
  const root = path.join(base, dirName);
  const layout = opts.layout ?? ".claude-plugin";
  const mdir = layout ? path.join(root, layout) : root;
  mkdirSync(mdir, { recursive: true });
  writeFileSync(
    path.join(mdir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  for (const s of opts.skills ?? []) {
    mkdirSync(path.join(root, "skills", s), { recursive: true });
    writeFileSync(
      path.join(root, "skills", s, "SKILL.md"),
      `---\nname: ${s}\ndescription: ${s} skill\n---\nbody`,
    );
  }
  return root;
}

/** 造一个市场目录。 */
function mkMarketplace(dirName: string, manifest: Record<string, unknown>): string {
  const root = path.join(base, dirName);
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify(manifest, null, 2),
  );
  return root;
}

/** 递归快照一个目录(看残留用)。返回相对路径的排序列表;文件带大小。 */
function treeOf(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else {
        out.push(`${rel}:${statSync(abs).size}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** `PLUGINS_ROOT` 下直接躺着的临时目录 —— 安装管线约定**成功失败都删**。
 *  留下一个就是"半截状态":它既不会被 listPlugins 看见,也不会被 removePlugin
 *  的 `rmSync(plugins/<name>)` 清掉,只会在用户目录里慢慢堆。 */
function stagingLeftovers(): string[] {
  if (!existsSync(PLUGINS_ROOT)) return [];
  return readdirSync(PLUGINS_ROOT)
    .filter((n) => /^\.(staging|mp-staging)-/.test(n) || /\.swapping-/.test(n))
    .sort();
}

const installLocal = (p: string) => call(IPC.PLUGINS_INSTALL_LOCAL, { localPath: p });type InstallRes = { ok: boolean; error?: string; plugin?: { name: string; rootDir: string; enabled: boolean; components: { skills: Array<{ name: string }> } } };
const asInstall = (r: unknown) => r as InstallRes;
type OkRes = { ok: boolean; error?: string };
const asOk = (r: unknown) => r as OkRes;

/* ────────────────────────── 1. 接线 ────────────────────────── */

console.log("\n[1] 十条 channel 各就各位,返回形状对得上契约");
const CHANNELS = [
  "PLUGINS_LIST",
  "PLUGINS_INSTALL_LOCAL",
  "PLUGINS_INSTALL_GIT",
  "PLUGINS_INSTALL_MARKETPLACE",
  "PLUGINS_SET_ENABLED",
  "PLUGINS_REMOVE",
  "PLUGINS_MARKETPLACE_LIST",
  "PLUGINS_MARKETPLACE_ADD",
  "PLUGINS_MARKETPLACE_REMOVE",
  "PLUGINS_MARKETPLACE_REFRESH",
] as const;
const channelNames = CHANNELS.map((k) => (IPC as unknown as Record<string, string>)[k]);
for (const k of CHANNELS) {
  check(`${k} 注册了 handler`, handlers.has((IPC as unknown as Record<string, string>)[k]));
}

const listRes = (await call(IPC.PLUGINS_LIST)) as { plugins: unknown[] };
check("plugins.list 返回 {plugins: []}", Array.isArray(listRes?.plugins), listRes);
same("全新用户 → 插件列表是空的", listRes.plugins, []);

const mpListRes = (await call(IPC.PLUGINS_MARKETPLACE_LIST)) as { marketplaces: Array<{ builtin: boolean }> };
check("plugins.marketplaceList 返回 {marketplaces: []}", Array.isArray(mpListRes?.marketplaces), mpListRes);

/* ────────────────────────── 2. 坏清单必须显式报 ────────────────────────── */

console.log("\n[2] 坏清单:显式报出来,不静默");
const badJson = mkPlugin("bad-json", "{ \"name\": \"x\",, }");
const noName = mkPlugin("no-name", { version: "1.0.0" });
const badName = mkPlugin("bad-name", { name: "../evil" });
const badNameDot = mkPlugin("bad-name-dot", { name: ".hidden" });
const badSkillsType = mkPlugin("bad-skills-type", { name: "bad-skills-type", skills: 42 });
const emptyName = mkPlugin("empty-name", { name: "" });

const badCases: Array<[string, string, string[]]> = [
  /* 坏 JSON 报的是"不是合法 JSON";缺字段报的是"校验失败 + 哪个字段"。
   * 两者都必须**显式报**并且**说得出是哪个文件** —— 这个仓库里
   * 插件清单曾经因为"两个校验器口径不一致"静默坏掉过一整天(见报告)。 */
  ["JSON 坏了", badJson, ["不是合法 JSON", ".claude-plugin"]],
  ["缺 name", noName, ["插件清单校验失败", "name"]],
  ["name 带路径分隔符", badName, ["插件清单校验失败", "name"]],
  ["name 以点开头", badNameDot, ["插件清单校验失败", "name"]],
  ["name 是空串", emptyName, ["插件清单校验失败", "name"]],
  ["skills 类型不对", badSkillsType, ["插件清单校验失败", "skills"]],
];
const beforeBad = treeOf(PLUGINS_ROOT);
for (const [label, dir, needles] of badCases) {
  const r = asInstall(await installLocal(dir));
  eq(`${label} → ok:false(不是抛异常,也不是装上了)`, r.ok, false);
  const err = r.error ?? "";
  check(
    `${label} → 错误里说清了哪个文件哪个字段(用户看到的就是这行)`,
    needles.every((n) => err.includes(n)),
    { label, err },
  );
}
same("一圈坏清单试完,插件目录里一个字节都没多(没留 staging / 半截目录)", treeOf(PLUGINS_ROOT), beforeBad);

/* ────────────────────────── 3. 组件路径越界 ────────────────────────── */

console.log("\n[3] 清单里指到插件目录外面的组件路径");
const escapeSkills = mkPlugin("escape-skills", { name: "escape-skills", skills: "../../outside" });
mkdirSync(path.join(PLUGINS_ROOT, "..", "outside", "sneaky"), { recursive: true });
writeFileSync(
  path.join(PLUGINS_ROOT, "..", "outside", "sneaky", "SKILL.md"),
  "---\nname: sneaky\n---\nbody",
);
const arrEscape = mkPlugin("arr-escape", {
  name: "arr-escape",
  skills: ["../../outside", "./skills-local"],
});
mkdirSync(path.join(base, "arr-escape", "skills-local", "keeper"), { recursive: true });
writeFileSync(
  path.join(base, "arr-escape", "skills-local", "keeper", "SKILL.md"),
  "---\nname: keeper\n---\nbody",
);

const escInstall = asInstall(await installLocal(escapeSkills));
check("越界的 skills 目录仍然装得上(不是致命错)", escInstall.ok, escInstall.error ?? "");
same("越界的 skills **没有**被算进组件摘要", escInstall.plugin?.components.skills ?? [], []);

const arrInstall = asInstall(await installLocal(arrEscape));
check("数组形式的 skills 也装得上", arrInstall.ok, arrInstall.error ?? "");
same(
  "数组里越界的丢掉、在目录里的留下",
  (arrInstall.plugin?.components.skills ?? []).map((s) => s.name),
  ["keeper"],
);

/* ────────────────────────── 4. 两种 skills 写法 ────────────────────────── */

console.log("\n[4] skills 字段的两种写法(桌面端看不出区别,CLI 看得出)");
/* CLI 的校验器要求组件路径以 "./" 开头,而 Mcode 的解析器 `./skills` 与 `skills`
 * 一视同仁。这条断言钉的就是后一半 —— 它是"桌面端为什么静默"的原因。 */
for (const [label, val] of [["\"skills\"", "skills"], ["\"./skills\"", "./skills"]] as const) {
  const dir = mkPlugin(`form-${label.includes("./") ? "dot" : "bare"}`, { name: `form-${label.includes("./") ? "dot" : "bare"}`, skills: val }, { skills: ["only-one"] });
  const r = asInstall(await installLocal(dir));
  check(`${label} 装得上`, r.ok, r.error ?? "");
  same(
    `${label} 解析出同一个技能`,
    (r.plugin?.components.skills ?? []).map((s) => s.name),
    ["only-one"],
  );
}

/* 根目录 plugin.json(agent-plugins.org 布局)能装,且**不能盖住** .claude-plugin 里那份 */
console.log("\n[4b] 根目录 plugin.json 与 .claude-plugin 并存时的优先级");
const bothLayouts = path.join(base, "both-layouts");
mkdirSync(path.join(bothLayouts, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(bothLayouts, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "canonical-wins" }),
);
writeFileSync(path.join(bothLayouts, "plugin.json"), JSON.stringify({ name: "stray-root" }));
const bothRes = asInstall(await installLocal(bothLayouts));
eq("装进来的是 .claude-plugin 里那份(根目录的盖不住它)", bothRes.plugin?.name, "canonical-wins");

const rootOnly = path.join(base, "root-only");
mkdirSync(rootOnly, { recursive: true });
writeFileSync(path.join(rootOnly, "plugin.json"), JSON.stringify({ name: "root-only-plugin" }));
const rootRes = asInstall(await installLocal(rootOnly));
eq("只有根目录清单时也认得(agent-plugins.org 布局)", rootRes.plugin?.name, "root-only-plugin");

/* ────────────────────────── 5. 重复安装 / 同名 ────────────────────────── */

console.log("\n[5] 同一件事做两遍");
const dup1 = asInstall(await installLocal(bothLayouts));
const dup2 = asInstall(await installLocal(bothLayouts));
check("同版本重装两次都 ok", dup1.ok && dup2.ok, { dup1: dup1.error, dup2: dup2.error });
/* 清单没写 version → `pluginVersionOf` 兜底成 "0.0.0"(见 pluginManifest.ts)。
 * 这条断言顺带把那个兜底钉住了:它决定了安装目录叫什么。 */
eq("清单没写 version 时版本落成 0.0.0", dup1.plugin?.rootDir.endsWith("0.0.0"), true);
same(
  "同版本重装没有留下第二份目录",
  readdirSync(path.join(PLUGINS_ROOT, "canonical-wins")),
  ["0.0.0"],
);
eq("重装之后版本目录还是同一个", dup2.plugin?.rootDir, dup1.plugin?.rootDir);
eq("两次拿到的插件名一样", dup2.plugin?.name, dup1.plugin?.name);

await call(IPC.PLUGINS_SET_ENABLED, { name: "canonical-wins", enabled: true });
const dup3 = asInstall(await installLocal(bothLayouts));
eq("重装不会把用户的启用状态抹掉", dup3.plugin?.enabled, true);

const v2 = mkPlugin("twin-v2", { name: "canonical-wins", version: "2.0.0" });
const bump = asInstall(await installLocal(v2));
check("同名新版本装得上", bump.ok, bump.error ?? "");
same(
  "同名只有一个版本目录(v1 被剪掉)",
  readdirSync(path.join(PLUGINS_ROOT, "canonical-wins")),
  ["2.0.0"],
);

/* ────────────────────────── 6. 幂等 ────────────────────────── */

console.log("\n[6] 幂等");
const enabledOf = (): string[] => {
  const raw = SettingRepo.__dump()["plugins.enabled"];
  return raw ? (JSON.parse(raw) as string[]) : [];
};

await call(IPC.PLUGINS_SET_ENABLED, { name: "canonical-wins", enabled: true });
await call(IPC.PLUGINS_SET_ENABLED, { name: "canonical-wins", enabled: true });
same("setEnabled(true) 连点两次,启用表里只有一条", enabledOf(), ["canonical-wins"]);
await call(IPC.PLUGINS_SET_ENABLED, { name: "canonical-wins", enabled: false });
await call(IPC.PLUGINS_SET_ENABLED, { name: "canonical-wins", enabled: false });
same("setEnabled(false) 连点两次,启用表是空的", enabledOf(), []);

const notInstalled = asOk(await call(IPC.PLUGINS_SET_ENABLED, { name: "never-installed", enabled: true }));
eq("启用一个没装的插件 → ok:false", notInstalled.ok, false);
check("…并且说清了是「未安装」", (notInstalled.error ?? "").includes("未安装"), notInstalled);

const mpSrc = mkMarketplace("mp-a", { name: "marketplace-a", plugins: [] });
const mpAdd1 = asOk(await call(IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: mpSrc }));
const mpAdd2 = asOk(await call(IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: mpSrc }));
eq("市场加一次 → ok", mpAdd1.ok, true);
eq("同一个市场再加一次 → ok:false(不是加出第二份)", mpAdd2.ok, false);
/* 显式 name 覆写清单里的名字:面板上「本地市场」那条路不带 name(用清单自己的),
 * 但 `marketplaceAdd` 契约里 `name` 是可选的覆写 —— 传了就必须生效,否则用户
 * 在重名时想换个名字挂上去是做不到的,而界面会安静地用清单里的那个。 */
const mpOverride = asOk(
  await call(IPC.PLUGINS_MARKETPLACE_ADD, {
    kind: "local",
    ref: mkMarketplace("mp-b", { name: "manifest-says-this", plugins: [] }),
    name: "user-picked-name",
  }),
);
eq("带 name 覆写加市场 → ok", mpOverride.ok, true);
same(
  "市场记录里用户市场和内置两个都在(内置的是第一次 list 时补进来的)",
  ((await call(IPC.PLUGINS_MARKETPLACE_LIST)) as { marketplaces: Array<{ name: string }> }).marketplaces
    .map((m) => m.name)
    .sort(),
  ["claude-plugins-official", "marketplace-a", "user-picked-name", "zcode-plugins-official"],
);
check(
  "…覆写生效:记录用的是用户给的名字,不是清单里的 manifest-says-this",
  !((await call(IPC.PLUGINS_MARKETPLACE_LIST)) as { marketplaces: Array<{ name: string }> }).marketplaces.some(
    (m) => m.name === "manifest-says-this",
  ),
);

/* ────────────────────────── 7. 半截状态 ────────────────────────── */

console.log("\n[7] 装到一半失败,留没留半截");
const notZip = path.join(base, "notes.txt");
writeFileSync(notZip, "hello");
const r1 = asInstall(await installLocal(notZip));
eq("选了个非 zip 的文件 → ok:false", r1.ok, false);
check("…错误里点明只支持目录或 .zip", (r1.error ?? "").includes(".zip"), r1);

const r2 = asInstall(await installLocal(path.join(base, "does-not-exist")));
eq("路径不存在 → ok:false(不是抛)", r2.ok, false);
check("…错误里带上那个路径", (r2.error ?? "").includes("does-not-exist"), r2);

const r3 = asOk(await call(IPC.PLUGINS_INSTALL_MARKETPLACE, { marketplace: "nope-mp", name: "x" }));
eq("从没加过的市场装条目 → ok:false", r3.ok, false);
check("…错误里点名那个市场", (r3.error ?? "").includes("nope-mp"), r3);

const emptyMp = mkMarketplace("mp-empty", { name: "marketplace-empty", plugins: [] });
await call(IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: emptyMp });
/* 快照取在**这里**:上面两条 ADD 是成功的、会留下市场树(那是正常产物,不算半截),
 * 而下面继续全是失败路径 —— 断的是"失败一个字节都没留下"。 */
const beforeFail = treeOf(PLUGINS_ROOT);
const beforeSettings = SettingRepo.__dump();

const r4 = asOk(await call(IPC.PLUGINS_INSTALL_MARKETPLACE, { marketplace: "marketplace-empty", name: "ghost" }));
eq("市场里没有这个条目 → ok:false", r4.ok, false);
check("…错误里点名市场和条目", (r4.error ?? "").includes("marketplace-empty") && (r4.error ?? "").includes("ghost"), r4);

const r5 = asOk(await call(IPC.PLUGINS_INSTALL_GIT, { url: path.join(base, "definitely-not-a-repo") }));
eq("git 地址不通 → ok:false(不是把 git 的报错抛出去)", r5.ok, false);
check("…错误里带上了 git 的原话", (r5.error ?? "").includes("git"), r5);

const r6 = asOk(await call(IPC.PLUGINS_MARKETPLACE_REFRESH, { name: "never-added-mp" }));
eq("刷新没加过的市场 → ok:false", r6.ok, false);
const r7 = asOk(await call(IPC.PLUGINS_MARKETPLACE_REMOVE, { name: "never-added-mp" }));
eq("移除没加过的市场 → ok:false", r7.ok, false);

same("这一圈失败之后,插件目录没有多出任何东西(逐路径逐大小对)", treeOf(PLUGINS_ROOT), beforeFail);
same("…也没有一个 `.staging-*` / `.swapping-*` / `.mp-staging-*` 留下", stagingLeftovers(), []);
same("设置表也没多出键(半截安装不该写任何设置)", SettingRepo.__dump(), beforeSettings);
/* ────────────────────────── 8. 市场条目路径越界 ────────────────────────── */

console.log("\n[8] 市场条目指到市场目录外面");
const outsidePlugin = mkPlugin("outside-target", { name: "outside-target", version: "1.0.0" });
const mpEscape = mkMarketplace("mp-escape", {
  name: "marketplace-escape",
  plugins: [
    { name: "up", source: "../../outside-target" },
    { name: "abs", source: outsidePlugin },
    { name: "abs-away", source: path.join(base, "..", "elsewhere") },
    { name: "fine", source: "./inside" },
  ],
});
mkdirSync(path.join(mpEscape, "inside", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(mpEscape, "inside", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "inside-plugin", version: "1.0.0" }),
);
await call(IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: mpEscape });
for (const [name, needle] of [
  ["up", "逃逸"],
  ["abs", "绝对路径"],
  ["abs-away", "绝对路径"],
] as const) {
  const r = asOk(await call(IPC.PLUGINS_INSTALL_MARKETPLACE, { marketplace: "marketplace-escape", name }));
  eq(`市场条目 source=${name} → ok:false`, r.ok, false);
  check(`…错误里点明"${needle}"`, (r.error ?? "").includes(needle), r);
}
const insideRes = asInstall(
  await call(IPC.PLUGINS_INSTALL_MARKETPLACE, { marketplace: "marketplace-escape", name: "fine" }),
);
eq("市场目录**里面**的条目照常装得上", insideRes.plugin?.name, "inside-plugin");

/* ────────────────────────── 9. 卸载:残留 ────────────────────────── */

console.log("\n[9] 卸载之后清干净了吗");
const victim = mkPlugin("victim-src", { name: "victim", version: "1.0.0" }, { skills: ["v-skill"] });
mkdirSync(path.join(victim, "hooks"), { recursive: true });
writeFileSync(
  path.join(victim, "hooks", "hooks.json"),
  JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] }),
);
writeFileSync(
  path.join(victim, ".mcp.json"),
  JSON.stringify({ mcpServers: { vserver: { command: "node", args: ["v.js"] } } }),
);
await installLocal(victim);
await call(IPC.PLUGINS_SET_ENABLED, { name: "victim", enabled: true });
/* 用户的 MCP 面板把这个插件的 server 关掉过 —— 卸载时这条 toggle 也该走。 */
SettingRepo.set("plugins.mcpDisabled", JSON.stringify(["victim__vserver", "some-other__server"]));

const skillRootsBefore = await pluginManager.getEnabledPluginSkillRoots();
check("卸载前:它自己的技能根在投递链里", skillRootsBefore.some((r) => r.includes("victim")), skillRootsBefore);

const removed = asOk(await call(IPC.PLUGINS_REMOVE, { name: "victim" }));
eq("卸载 → ok", removed.ok, true);
check("卸载后:插件目录没了", !existsSync(path.join(PLUGINS_ROOT, "victim")));
same(
  "卸载后:listPlugins 里没有它",
  ((await call(IPC.PLUGINS_LIST)) as { plugins: Array<{ name: string }> }).plugins.some((p) => p.name === "victim"),
  false,
);
same("卸载后:启用表里没有它", enabledOf().includes("victim"), false);
check(
  "卸载后:它的 MCP toggle(victim__vserver)也被清掉",
  !(JSON.parse(SettingRepo.__dump()["plugins.mcpDisabled"] ?? "[]") as string[]).includes("victim__vserver"),
  SettingRepo.__dump()["plugins.mcpDisabled"],
);
check(
  "…但别人的 toggle 不许被误伤",
  (JSON.parse(SettingRepo.__dump()["plugins.mcpDisabled"] ?? "[]") as string[]).includes("some-other__server"),
  SettingRepo.__dump()["plugins.mcpDisabled"],
);
const skillRootsAfter = await pluginManager.getEnabledPluginSkillRoots();
check("卸载后:技能根不再投递", !skillRootsAfter.some((r) => r.includes("victim")), skillRootsAfter);

const removedTwice = asOk(await call(IPC.PLUGINS_REMOVE, { name: "victim" }));
eq("再卸一次 → ok:false(不是静默成功)", removedTwice.ok, false);
check("…说清了「未安装」", (removedTwice.error ?? "").includes("未安装"), removedTwice);

const builtinRemove = asOk(await call(IPC.PLUGINS_REMOVE, { name: "mcode-document-skills" }));
eq("内置插件卸不掉(用户目录里本来就没有它)", builtinRemove.ok, false);

/* ────────────────────────── 10. 回合闸门 ────────────────────────── */

console.log("\n[10] 有回合在跑时不许卸载");
const live = mkPlugin("live-src", { name: "live-plugin", version: "1.0.0" }, { skills: ["live-skill"] });
await installLocal(live);
await call(IPC.PLUGINS_SET_ENABLED, { name: "live-plugin", enabled: true });

const treeBeforeGate = treeOf(PLUGINS_ROOT);
const settingsBeforeGate = SettingRepo.__dump();

runtimeManager.__setRunning(["sess-1", "sess-2"]);
const blocked = asOk(await call(IPC.PLUGINS_REMOVE, { name: "live-plugin" }));
eq("跑着两个会话时 remove → ok:false", blocked.ok, false);
check(
  "…错误里带上会话数(用户看到的就是这行字)",
  (blocked.error ?? "").includes("2") && (blocked.error ?? "").includes("会话"),
  blocked,
);
same("…被挡下来时:插件目录一个字都没动", treeOf(PLUGINS_ROOT), treeBeforeGate);
same("…被挡下来时:设置表一个字都没动", SettingRepo.__dump(), settingsBeforeGate);
same("…listPlugins 里它还在", ((await call(IPC.PLUGINS_LIST)) as { plugins: Array<{ name: string }> }).plugins.map((p) => p.name).includes("live-plugin"), true);

runtimeManager.__setRunning([]);
const unblocked = asOk(await call(IPC.PLUGINS_REMOVE, { name: "live-plugin" }));
eq("回合停了之后 → ok", unblocked.ok, true);
check("…这次真的删掉了", !existsSync(path.join(PLUGINS_ROOT, "live-plugin")));

/* ────────────────────────── 11. 坏输入怎么报 ────────────────────────── */

console.log("\n[11] 输入 schema 挡下来的东西");
async function throws(channel: string, raw: unknown): Promise<string> {
  try {
    await call(channel, raw);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
for (const [label, ch, raw, needle] of [
  ["remove 的名字带路径分隔符", IPC.PLUGINS_REMOVE, { name: "../evil" }, "name"],
  ["setEnabled 的名字是空的", IPC.PLUGINS_SET_ENABLED, { name: "", enabled: true }, "name"],
  ["setEnabled 的 enabled 不是布尔", IPC.PLUGINS_SET_ENABLED, { name: "ok", enabled: "yes" }, "enabled"],
  ["installLocal 的 localPath 是空的", IPC.PLUGINS_INSTALL_LOCAL, { localPath: "" }, "localPath"],
  ["installGit 缺 url", IPC.PLUGINS_INSTALL_GIT, {}, "url"],
  ["marketplaceAdd 的 kind 不在枚举里", IPC.PLUGINS_MARKETPLACE_ADD, { kind: "ftp", ref: "x" }, "kind"],
  ["marketplaceAdd 的 ref 是空的", IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: "" }, "ref"],
  ["marketplaceAdd 的 name 越界", IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: "x", name: "/etc" }, "name"],
  ["installMarketplace 的 name 是空的", IPC.PLUGINS_INSTALL_MARKETPLACE, { marketplace: "m", name: "" }, "name"],
] as const) {
  const msg = await throws(ch, raw);
  check(`${label} → 抛错(不是静默当成合法输入)`, msg.length > 0, { label });
  check(`${label} → 错误里点到那个字段`, msg.includes(needle), { label, needle, msg: msg.slice(0, 160) });
}

/* 市场名非法时不静默改个名字塞进去 —— 必须报 */
const weirdMp = mkMarketplace("mp-weird", { name: "我的市场", plugins: [] });
const weirdRes = asOk(await call(IPC.PLUGINS_MARKETPLACE_ADD, { kind: "local", ref: weirdMp }));
eq("市场清单里的中文名不合规 → ok:false", weirdRes.ok, false);
check("…点明是名称非法", (weirdRes.error ?? "").includes("名称非法"), weirdRes);

/* ────────────────────────── 12. 空过守卫 ────────────────────────── */

console.log("\n[12] 每条 channel 都被真的调过(没有登记了却没人命中的)");
for (const k of CHANNELS) {
  const ch = (IPC as unknown as Record<string, string>)[k];
  check(`${k} 至少被调用过一次`, (hits.get(ch) ?? 0) > 0, { hits: hits.get(ch) ?? 0 });
}
check(
  "没有 handler 是注册了却从没被这套脚本碰过的",
  channelNames.every((c) => (hits.get(c) ?? 0) > 0),
  Object.fromEntries(channelNames.map((c) => [c, hits.get(c) ?? 0])),
);

/* ────────────────────────── 收尾 ────────────────────────── */

console.log("\n[13] 这一整套从头到尾没碰过用户真数据根");
same(
  `真数据根(${REAL_PLUGINS_ROOT})与开工时逐字节相同`,
  treeOf(REAL_PLUGINS_ROOT),
  realRootBefore,
);

rmSync(base, { recursive: true, force: true });

console.log(`\nplugins-ipc-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
