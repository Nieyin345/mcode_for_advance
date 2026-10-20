import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildMcpMarketConfig } from "@contracts/ipc";
import {
  addMcpMarketSource,
  listMcpMarketSources,
  mcpMarketSourcesCorrupt,
  normalizeRegistryBase,
  registryServerToEntry,
  removeMcpMarketSource,
  searchMcpMarket,
  suggestMcpServerName,
} from "@main/lib/mcpMarket.js";
import {
  addSkillMarket,
  installSkillsFromMarket,
  listSkillMarkets,
  removeSkillMarket,
  skillMarketBundle,
  skillMarketsCorrupt,
  refreshSkillMarket,
} from "@main/lib/skillMarket.js";
import { parseGithubSkillIndex } from "@main/lib/githubSkillCatalog.js";
import { defaultSkillsRoot, parseSkillFrontmatter } from "@main/lib/skillEngines.js";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// run.sh points HOME/USERPROFILE into its temp dir; work only below it.
assert.ok(homedir().includes("mcode-market-smoke"), `HOME must be redirected (got ${homedir()})`);
const out = mkdtempSync(path.join(homedir(), "work-"));

await test("registry names and base URLs", () => {
  assert.equal(normalizeRegistryBase("https://r.example.com/v0.1/servers/"), "https://r.example.com");
  assert.equal(normalizeRegistryBase("https://r.example.com/sub/v0"), "https://r.example.com/sub");
  assert.equal(normalizeRegistryBase("ftp://x"), null);
  assert.equal(suggestMcpServerName("com.example/my.server"), "my-server");
  assert.equal(suggestMcpServerName("io.github.x/mcode-app"), "x-mcode-app");
});

const SERVER = {
  server: {
    name: "io.example/fs",
    title: "FS",
    description: "files",
    version: "1.2.0",
    repository: { url: "https://github.com/example/fs" },
    packages: [
      {
        registryType: "npm", identifier: "@ex/fs", version: "1.2.0", transport: { type: "stdio" },
        environmentVariables: [{ name: "TOKEN", isRequired: true, isSecret: true }],
        packageArguments: [{ type: "positional", isRequired: true, valueHint: "dir" }, { type: "named", name: "--mode", value: "ro" }],
      },
      { registryType: "pypi", identifier: "ex-fs", version: "0.3", transport: { type: "stdio" } },
      { registryType: "oci", identifier: "docker.io/ex/fs", version: "1.0", environmentVariables: [{ name: "K" }] },
      { registryType: "npm", identifier: "@ex/fs-http", transport: { type: "streamable-http", url: "http://localhost:3000" } },
      { registryType: "mcpb", identifier: "https://x/fs.mcpb" },
    ],
    remotes: [{ type: "streamable-http", url: "https://ex.com/mcp", headers: [{ name: "Authorization", value: "Bearer {token}", isRequired: true, isSecret: true }] }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
};

await test("server.json → install options", () => {
  const e = registryServerToEntry(SERVER)!;
  assert.equal(e.suggestedName, "fs");
  assert.equal(e.repositoryUrl, "https://github.com/example/fs");
  assert.deepEqual(e.options.map((o) => o.label), ["HTTP", "npx (npm)", "uvx (PyPI)", "docker (OCI)"]);
  const npm = e.options[1];
  assert.deepEqual(npm.inputs.map((i) => i.key), ["env:TOKEN", "pk0"]);
  assert.equal(buildMcpMarketConfig(npm, {}).config, undefined);
  assert.deepEqual(buildMcpMarketConfig(npm, {}).missing, ["env:TOKEN", "pk0"]);
  assert.deepEqual(buildMcpMarketConfig(npm, { "env:TOKEN": " s ", pk0: "/data" }).config, {
    command: "npx", args: ["-y", "@ex/fs@1.2.0", "/data", "--mode", "ro"], env: { TOKEN: "s" },
  });
  assert.deepEqual(buildMcpMarketConfig(e.options[2], {}).config, { command: "uvx", args: ["ex-fs==0.3"] });
  assert.deepEqual(buildMcpMarketConfig(e.options[3], { "env:K": "v" }).config, {
    command: "docker", args: ["run", "-i", "--rm", "-e", "K", "docker.io/ex/fs:1.0"], env: { K: "v" },
  });
  assert.deepEqual(buildMcpMarketConfig(e.options[0], { "header:Authorization": "Bearer t" }).config, {
    type: "http", url: "https://ex.com/mcp", headers: { Authorization: "Bearer t" },
  });
  assert.equal(registryServerToEntry({ server: { name: "x/y" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } }), null);
});

// Fake registry: /v0.1 → 404 (old registry), /v0 → two pages, page 1 lists an old + latest version.
// 另含一个最小假 GitHub(mc037/race):**commit 请求**是 addSkillMarket 拉索引的第一跳 ——
// 在它返回前执行 `raceHook`,用来精确落在「读到写之间」的 await 窗口里。
const calls: string[] = [];
const SHA = "a".repeat(40);
let raceHook: (() => void) | null = null;
let remoteProbe: ((url: URL, init?: RequestInit) => Response | null) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  const probe = remoteProbe?.(url, init);
  if (probe !== undefined && probe !== null) return probe;
  // 时序注入:任意**第一跳**请求返回前执行一次 —— 技能市场的第一跳是 commit,
  // MCP 探测的第一跳是 /v0.1/servers;两者都落在"已读过记录、还没写回"的窗口里。
  const hook = raceHook;
  raceHook = null; // 只触发一次
  hook?.();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.github.com" && url.pathname.startsWith("/repos/mc037/race")) {
    if (url.pathname === "/repos/mc037/race/commits/HEAD") {
      return new Response(SHA, { status: 200, headers: { "content-type": "application/vnd.github.sha" } });
    }
    if (url.pathname === `/repos/mc037/race/git/trees/${SHA}`) {
      return json({
        truncated: false,
        tree: [{ path: "race-skill/SKILL.md", sha: "b".repeat(40), size: 12, mode: "100644", type: "blob" }],
      });
    }
    return json({ error: "nope" }, 404);
  }
  if (url.hostname === "raw.githubusercontent.com" && url.pathname.startsWith("/mc037/race/")) {
    return new Response("---\nname: race-skill\ndescription: R\n---\n", { status: 200 });
  }
  if (url.hostname === "old.example.com") {
    if (url.pathname === "/v0.1/servers") return json({}, 404);
    if (url.pathname === "/v0/servers") {
      if (url.searchParams.get("cursor") === "p2") return json({ servers: [{ server: { name: "b/two", version: "1", remotes: [{ type: "sse", url: "https://b/sse" }] } }], metadata: {} });
      return json({
        servers: [
          { server: { name: "a/one", version: "0.9", packages: [{ registryType: "pypi", identifier: "one", version: "0.9" }] } },
          { server: { name: "a/one", version: "1.0", packages: [{ registryType: "pypi", identifier: "one", version: "1.0" }] } },
        ],
        metadata: { nextCursor: "p2" },
      });
    }
  }
  return json({ error: "nope" }, 404);
}) as typeof fetch;

// ── 时序窗口注入辅助:在假 fetch 的 commit 跳里执行一次回调 ──
const CORRUPT_JSON = "{\"markets\":[";
function raceBreak(recordsPath: string): void {
  raceHook = () => writeFileSync(recordsPath, CORRUPT_JSON, "utf8");
}
function raceConcurrentAdd(recordsPath: string, record: unknown): void {
  raceHook = () => {
    const cur = JSON.parse(readFileSync(recordsPath, "utf8")) as { version: number; markets: unknown[] };
    writeFileSync(recordsPath, JSON.stringify({ ...cur, markets: [...cur.markets, record] }, null, 2) + "\n", "utf8");
  };
}
function raceBreakSetting(key: string, repo: { get: (k: string) => string | null; set: (k: string, v: string) => void }): void {
  raceHook = () => repo.set(key, "{not json");
}
function raceConcurrentAddSetting(key: string, repo: { get: (k: string) => string | null; set: (k: string, v: string) => void }, rec: unknown): void {
  raceHook = () => repo.set(key, JSON.stringify([...JSON.parse(repo.get(key) ?? "[]"), rec]));
}
function raceClean(): void {
  raceHook = null;
}
function raceReset(): void {
  raceHook = null;
}


await test("registry sources: add (probed) / list / remove", async () => {
  assert.equal(listMcpMarketSources().length, 1);
  const bad = await addMcpMarketSource({ url: "https://nothing.example.com" });
  assert.equal(bad.ok, false);
  const dup = await addMcpMarketSource({ url: "https://registry.modelcontextprotocol.io/v0.1/servers" });
  assert.equal(dup.ok, false);
  const ok = await addMcpMarketSource({ url: "https://old.example.com/v0/servers", label: "Old" });
  assert.equal(ok.ok, true, ok.error);
  const sources = listMcpMarketSources();
  assert.deepEqual(sources.map((s) => [s.label, s.url, s.builtin]), [
    ["MCP Registry", "https://registry.modelcontextprotocol.io", true],
    ["Old", "https://old.example.com", false],
  ]);
  assert.equal(removeMcpMarketSource("official").ok, false);
});

await test("search: /v0 fallback, dedupe, cursor paging", async () => {
  const id = listMcpMarketSources()[1].id;
  calls.length = 0;
  const p1 = await searchMcpMarket({ source: id, query: "one" });
  assert.equal(p1.ok, true, p1.error);
  assert.deepEqual(p1.entries.map((e) => [e.id, e.version]), [["a/one", "1.0"]]);
  assert.equal(p1.nextCursor, "p2");
  assert.ok(calls[0].startsWith("/v0.1/servers?") && calls[1].startsWith("/v0/servers?"));
  assert.ok(calls[0].includes("search=one") && calls[0].includes("version=latest"));
  const p2 = await searchMcpMarket({ source: id, query: "one", cursor: p1.nextCursor });
  assert.deepEqual(p2.entries.map((e) => e.options[0].kind), ["sse"]);
  assert.equal(p2.nextCursor, undefined);
  const missing = await searchMcpMarket({ source: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(removeMcpMarketSource(id).ok, true);
  assert.equal(listMcpMarketSources().length, 1);
});

await test("SKILL.md frontmatter block scalars", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: a\ndescription: >\n  one\n  two\nmetadata:\n  name: inner\n---\n"), { name: "a", description: "one two" });
  assert.deepEqual(parseSkillFrontmatter("---\r\nname: b\r\ndescription: |\r\n  l1\r\n  l2\r\n---\r\n"), { name: "b", description: "l1\nl2" });
});

await test("skill market: local catalog add / scan / install / remove", async () => {
  const cat = path.join(out, "catalog");
  for (const [dir, md] of [
    ["skills/alpha", "---\nname: alpha\ndescription: >\n  Alpha skill\n---\nbody"],
    ["skills/.curated/beta", "---\nname: beta\ndescription: Beta\n---\n"],
    ["template", "---\nname: template\n---\n"],
    ["node_modules/x", "---\nname: x\n---\n"],
  ] as const) {
    mkdirSync(path.join(cat, dir), { recursive: true });
    writeFileSync(path.join(cat, dir, "SKILL.md"), md);
  }
  writeFileSync(path.join(cat, "skills/alpha/helper.py"), "print(1)");
  const builtins = await listSkillMarkets();
  assert.ok(builtins.length >= 2 && builtins.every((m) => m.builtin && !m.cloned));
  const add = await addSkillMarket({ kind: "local", ref: cat });
  assert.equal(add.ok, true, add.error);
  const m = (await listSkillMarkets()).find((x) => x.name === add.name)!;
  assert.deepEqual(m.skills.map((s) => [s.name, s.description]), [["alpha", "Alpha skill"], ["beta", "Beta"]]);
  assert.equal((await addSkillMarket({ kind: "local", ref: cat + path.sep })).ok, false);
  const ins = await installSkillsFromMarket(add.name!, ["alpha", "missing"]);
  assert.deepEqual(ins.imported, ["alpha"]);
  assert.equal(ins.errors.length, 1);
  assert.ok(existsSync(path.join(defaultSkillsRoot(), "alpha", "helper.py")));
  assert.deepEqual((await installSkillsFromMarket(add.name!, ["alpha"])).skipped, ["alpha"]);
  assert.equal((await listSkillMarkets()).find((x) => x.name === add.name)!.skills[0].installed, true);
  assert.equal(skillMarketBundle(add.name!)?.id, `market--${add.name}`);
  assert.equal((await removeSkillMarket("anthropic-skills")).ok, false);
  assert.equal((await removeSkillMarket(add.name!)).ok, true);
  assert.ok(existsSync(cat), "removing a local market never deletes the user's folder");
});

// 坏的技能索引:抛出的句子**必须给用户看**(它经 `installSkillsFromMarket` 的 catch
// 原样回给设置面板)。同一函数里三句判据,从前只有第一句是中英双语,后两句是**纯英文**// (`Invalid cached skill` / `Invalid cached file`)—— 中文用户点「安装」只见一行英文。
// 判据:三句都要含中文,不只是前一句。
await test("技能索引损坏时的报错是给用户看的中文", () => {
  const good = {
    version: 1,
    source: { owner: "o", repo: "r", ref: "main" },
    commit: "a".repeat(40),
    skills: [{ name: "alpha", description: "A", relPath: ".", dir: "/x" }],
    files: [],
  };
  const hasCjk = (s: string) => /[一-鿿]/.test(s);
  const throwText = (idx: unknown): string => {
    try { parseGithubSkillIndex(JSON.stringify(idx)); return ""; }
    catch (err) { return (err as Error).message; }
  };
  // ① 顶层形状不对(一直是双语的)
  const top = throwText({ ...good, version: 2 });
  assert.ok(hasCjk(top), `顶层判据应是中文:${top}`);
  // ② 技能条目坏 —— 从前是纯英文
  const skillBad = throwText({ ...good, skills: [{ name: "bad name!", description: "A", relPath: "." }] });
  assert.ok(hasCjk(skillBad), `技能条目判据应是中文(从前是 'Invalid cached skill'):${skillBad}`);
  // ③ 文件条目坏 —— 从前是纯英文
  const fileBad = throwText({ ...good, files: [{ path: "a.py", sha: "zzz", size: 1, mode: "644", type: "blob" }] });
  assert.ok(hasCjk(fileBad), `文件条目判据应是中文(从前是 'Invalid cached file'):${fileBad}`);
  // 正控:好的索引不该抛(否则上面三条是"总是抛"造成的假绿)。
  assert.equal(throwText(good), "", "合法索引不应抛");
});

/* ══════════ 【MC-037】坏记录不许被读成"从未添加过"、更不许被下一次写入覆盖 ══════════
 *
 * 台账红例:有自定义来源的 markets.json / mcp.marketSources 被截断或手改坏之后,
 * readRecords/readUserSources 把坏数据当空表 → 列表谎报"还没添加过";随后 add 拿
 * 这个空数组整表写回,历史来源**静默消失**。
 *
 * 判据立在**盘上的字节**与**用户可见的错误**上:损坏时①读侧如实报(列表照常给
 * 内置/官方,但 `corrupt` 标记有值)②写侧拒绝且原字节一个不动③修好之后一切恢复。
 * 不钉实现(不查"调没调 classify")。
 */
{
  // ⚠️ 夹具在 corpus 里区分**已导入**与**待导入**两段英文,避免和既有的中文断言互相干扰。
  const skillRecordsPath = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
  const corruptJson = "{\"markets\":["; // 半截写入的典型形状

  // ── 技能市场:文件副本 ──
  await test("MC-037 技能市场:坏记录如实报、拒绝写入、字节不动、修复后恢复", async () => {
    // 先建一份**健康**记录(一个真实市场),再把它砸坏 —— 复刻"已有来源被损坏"。
    const cat = path.join(out, "mc037-catalog");
    mkdirSync(path.join(cat, "skills", "gamma"), { recursive: true });
    writeFileSync(path.join(cat, "skills", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: G\n---\n");
    const add = await addSkillMarket({ kind: "local", ref: cat });
    assert.equal(add.ok, true, add.error);
    const healthyBytes = readFileSync(skillRecordsPath, "utf8");
    assert.ok(healthyBytes.includes(add.name!), "夹具:健康记录在盘上");

    // ① 砸坏:读取如实报,而不是当空表。
    writeFileSync(skillRecordsPath, corruptJson, "utf8");
    const corruptState = skillMarketsCorrupt();
    assert.ok(corruptState, "坏记录必须如实报(不能静默当空表)");
    assert.ok(/合法 JSON|顶层不是数组|读取失败/.test(corruptState!.reason), `原因要能给人看:${corruptState!.reason}`);
    // 读侧降级:内置市场照常列出(不是"列表整个挂了")。
    const stillListed = await listSkillMarkets();
    assert.ok(stillListed.length >= 2 && stillListed.every((m) => m.builtin), "坏记录下列表仍给内置市场");

    // ② 写侧拒绝:加新市场被拒,且**盘上字节一个不动**。
    const rejected = await addSkillMarket({ kind: "local", ref: cat });
    assert.equal(rejected.ok, false, "坏记录下添加必须被拒");
    assert.equal(rejected.corrupt, true, "拒绝要带 corrupt 标记,便于 UI 分口径");
    assert.equal(readFileSync(skillRecordsPath, "utf8"), corruptJson, "★ 原字节一个不动(不许被覆盖)");
    // 移除/刷新同样拒绝(不许拿降级空表判"不存在")。
    assert.equal((await removeSkillMarket("whatever")).ok, false);
    assert.equal((await removeSkillMarket("whatever")).corrupt, true);

    // ③ 修复之后一切恢复:健康记录重新可用,添加照常。
    writeFileSync(skillRecordsPath, healthyBytes, "utf8");
    assert.equal(skillMarketsCorrupt(), null, "修复后不再报损坏");
    assert.ok((await listSkillMarkets()).some((m) => m.name === add.name), "修复后原市场又列得出来");
    const cat2 = path.join(out, "mc037-catalog-2");
    mkdirSync(path.join(cat2, "skills", "delta"), { recursive: true });
    writeFileSync(path.join(cat2, "skills", "delta", "SKILL.md"), "---\nname: delta\ndescription: D\n---\n");
    const added2 = await addSkillMarket({ kind: "local", ref: cat2 });
    assert.equal(added2.ok, true, added2.error);
  });

  // ── MCP 市场:SettingRepo 行副本(同一判据) ──
  await test("MC-037 MCP 市场:坏设置行如实报、拒绝写入、值不动", async () => {
    const { SettingRepo: stubRepo } = await import("@main/store/repositories.js");
    const KEY = "mcp.marketSources";
    // 夹具:先建一个**自定义来源**(前一个测试结尾把 Old 删掉了),再砸坏。
    // ⚠️ 用 `old.example.com`(假 fetch 认识这个 host;别的 host 会 404,夹具会假红)。
    const seeded = await addMcpMarketSource({ url: "https://old.example.com", label: "MC037" });
    assert.equal(seeded.ok, true, seeded.error);
    const healthy = stubRepo.get(KEY)!;
    assert.ok(healthy.includes("old.example.com"), "夹具:已有自定义来源");
    stubRepo.set(KEY, "{not json");
    const corrupt = mcpMarketSourcesCorrupt();
    assert.ok(corrupt, "坏行必须如实报");
    // ① 读侧降级:列表仍给官方来源。
    assert.equal(listMcpMarketSources().length, 1);
    assert.equal(listMcpMarketSources()[0].id, "official");
    // ② 写侧拒绝 —— ⚠️ 拒绝发生在**网络检查之前**(本地事实,不必等 fetch);
    //    fetch 会打到假注册中心并成功,所以这条若绿是"因为坏表拒",不是"因为网络拒"。
    const rejected = await addMcpMarketSource({ url: "https://another.invalid" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.corrupt, true, "拒绝带 corrupt 标记");
    assert.equal(stubRepo.get(KEY), "{not json", "★ 设置行的值一个不动");
    const rmRejected = removeMcpMarketSource(seeded.id!);
    assert.equal(rmRejected.corrupt, true, "坏行时移除也拒(不许拿空表判'不存在')");
    assert.equal(stubRepo.get(KEY), "{not json");
    // ③ 修复后恢复。
    stubRepo.set(KEY, healthy);
    assert.equal(mcpMarketSourcesCorrupt(), null);
    assert.equal(listMcpMarketSources().length, 2, "修复后自定义来源又列得出来");
  });

  // 正控:从未写过(absent)与损坏**必须分开** —— 全新用户第一次添加要照常成功。
  await test("MC-037 正控:从未写过(absent)不算损坏,首次添加照常成功", async () => {
    const { SettingRepo: stubRepo } = await import("@main/store/repositories.js");
    const KEY = "mcp.marketSources";
    const before = stubRepo.get(KEY)!;
    stubRepo.set(KEY, "");
    assert.equal(mcpMarketSourcesCorrupt(), null, "空值 = 从未写过 = 合法初始态");
    // ⚠️ 同样用假 fetch 认识的 host(否则 404 拒,绿的原因就不是判据了)。
    const added = await addMcpMarketSource({ url: "https://old.example.com", label: "Fresh" });
    assert.equal(added.ok, true, added.error);
    assert.ok(listMcpMarketSources().some((s) => s.label === "Fresh"));
    stubRepo.set(KEY, before);
  });

  /* ══════════ 【MC-037 时序变体】读→写之间的 await 窗口 ══════════
   *
   * 台账验收点名「读后并发修改」。add/refresh 在入口处读一次记录,然后要经过
   * git 索引拉取 / 网络探测这类**秒级 await**;窗口内记录被并发改写或砸坏时,
   * 从前写回用的仍是操作前的快照(或降级读 `readRecords()` → []),于是:
   *   ① 窗口内被砸坏 → 原字节被一次"成功"写入覆盖(台账原例的时序版);
   *   ② 窗口内并发新增 → 新增的记录下来被整表覆盖丢失。
   * 判据仍立在**盘上的字节**上:写回必须用写回时刻的 fresh 记录。
   */
  await test("MC-037 时序:技能市场 add 的 await 窗口内坏档 → 拒绝且原字节不动", async () => {
    const skillRecords = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    writeFileSync(skillRecords, JSON.stringify({ version: 1, markets: [] }, null, 2) + "\n", "utf8");
    assert.equal(skillMarketsCorrupt(), null, "前置:起点是健康空表");
    // 造一个**可被假 GitHub 索引**接受的仓库;fetch 桩在 commit 请求处把记录砸坏。
    const gh = path.join(out, "mc037-race-repo");
    mkdirSync(gh, { recursive: true });
    // 假 fetch:见下方 RACE_FETCH 注入(按 pathname 开关)。
    raceBreak(skillRecords);
    const res = await addSkillMarket({ kind: "git", ref: "https://github.com/mc037/race" });
    assert.equal(res.ok, false, "窗口内砸坏的记录必须让写入被拒");
    assert.equal(res.corrupt, true, "拒绝要带 corrupt 标记");
    assert.equal(readFileSync(skillRecords, "utf8"), CORRUPT_JSON, "★ 窗口内砸坏的原字节一个不动");
    raceReset();
  });

  await test("MC-037 时序:技能市场 add 的 await 窗口内并发新增 → 不丢别人刚加的记录", async () => {
    const skillRecords = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    const existing = { name: "race-existing", source: { kind: "local", ref: path.join(out, "race-existing") }, addedAt: "x" };
    writeFileSync(skillRecords, JSON.stringify({ version: 1, markets: [existing] }, null, 2) + "\n", "utf8");
    // 窗口内并发新增一条(相当于另一个 add 在 await 期间完成)。
    raceConcurrentAdd(skillRecords, { name: "race-newcomer", source: { kind: "local", ref: path.join(out, "race-newcomer") }, addedAt: "y" });
    const res = await addSkillMarket({ kind: "git", ref: "https://github.com/mc037/race" });
    assert.equal(res.ok, true, res.error);
    const onDisk = JSON.parse(readFileSync(skillRecords, "utf8")).markets.map((m: { name: string }) => m.name).sort();
    assert.deepEqual(onDisk, ["race-existing", "race-newcomer", res.name].sort(), "★ 窗口内并发新增的 race-newcomer 必须还在");
    raceReset();
  });

  await test("MC-037 时序:MCP 来源 add 的网络探测窗口内坏档 → 拒绝且设置行不动", async () => {
    const { SettingRepo: stubRepo } = await import("@main/store/repositories.js");
    const KEY = "mcp.marketSources";
    stubRepo.set(KEY, JSON.stringify([{ id: "seed", label: "Seed", url: "https://seed.example.com" }]));
    raceBreakSetting(KEY, stubRepo);
    const res = await addMcpMarketSource({ url: "https://old.example.com", label: "Race" });
    assert.equal(res.ok, false, "窗口内砸坏的设置行必须让写入被拒");
    assert.equal(res.corrupt, true, "拒绝要带 corrupt 标记");
    assert.equal(stubRepo.get(KEY), "{not json", "★ 窗口内砸坏的设置行一个不动");
    raceReset();
  });

  await test("MC-037 时序:MCP 来源 add 的探测窗口内并发新增 → 不丢", async () => {
    const { SettingRepo: stubRepo } = await import("@main/store/repositories.js");
    const KEY = "mcp.marketSources";
    stubRepo.set(KEY, JSON.stringify([{ id: "seed", label: "Seed", url: "https://seed.example.com" }]));
    raceConcurrentAddSetting(KEY, stubRepo, { id: "newcomer", label: "Newcomer", url: "https://newcomer.example.com" });
    const res = await addMcpMarketSource({ url: "https://old.example.com", label: "Race2" });
    assert.equal(res.ok, true, res.error);
    const ids = JSON.parse(stubRepo.get(KEY)!).map((s: { id: string }) => s.id);
    assert.ok(ids.includes("seed") && ids.includes("newcomer"), `★ 并发新增的 newcomer 必须还在:${ids}`);
    raceReset();
  });


  /* MC-037 同族时序缺口：刷新在网络 await 之后不可复活已删除的自定义市场，
   * 也不能把旧来源的 fetchedAt 写给同名新来源。此处操作完全隔离 home 和假 fetch。 */
  await test("MC-037 刷新并发：网络期间删除的自定义来源不得复活", async () => {
    const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    const name = "mc037-race-removed";
    const rec = { name, source: { kind: "git", ref: "https://github.com/mc037/race" }, addedAt: "old" };
    writeFileSync(file, JSON.stringify({ version: 1, markets: [rec] }), "utf8");
    raceHook = () => {
      // 另一窗口完成了删除：这份记录已经明确不在盘上。
      writeFileSync(file, JSON.stringify({ version: 1, markets: [] }), "utf8");
    };
    const result = await refreshSkillMarket(name);
    assert.equal(result.ok, false, "网络窗口内市场已删除，旧 refresh 必须报告冲突");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).markets, [], "旧 refresh 不得把用户已删除的来源重新加回");
    assert.equal(existsSync(path.join(homedir(), ".mcode", "skill-markets", name)), false,
      "刷新在网络窗口发现删除后，不得重新落地旧缓存目录");
    raceReset();
  });

  await test("MC-037 刷新并发：同名新来源不得被旧来源刷新冒充成功", async () => {
    const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    const name = "mc037-race-replaced";
    const oldRec = { name, source: { kind: "git", ref: "https://github.com/mc037/race" }, addedAt: "old" };
    const newRec = { name, source: { kind: "local", ref: path.join(out, "replacement") }, addedAt: "new" };
    writeFileSync(file, JSON.stringify({ version: 1, markets: [oldRec] }), "utf8");
    raceHook = () => writeFileSync(file, JSON.stringify({ version: 1, markets: [newRec] }), "utf8");
    const result = await refreshSkillMarket(name);
    assert.equal(result.ok, false, "同名替换不能将旧 Git 网络结果归属到本地新来源");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).markets, [newRec], "替换后的来源元数据逐字段保持原值");
    assert.equal(existsSync(path.join(homedir(), ".mcode", "skill-markets", name)), false,
      "网络完成后已换成 local 来源，不得偷偷覆盖同名缓存");
    raceReset();
  });

  await test("MC-037 刷新正控：来源身份不变时 fetchedAt 正常更新", async () => {
    const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    const rec = { name: "mc037-race-stable", source: { kind: "git", ref: "https://github.com/mc037/race" }, addedAt: "stable" };
    writeFileSync(file, JSON.stringify({ version: 1, markets: [rec] }), "utf8");
    raceReset();
    const result = await refreshSkillMarket(rec.name);
    assert.equal(result.ok, true, result.error);
    const onDisk = JSON.parse(readFileSync(file, "utf8")).markets;
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].source.ref, rec.source.ref);
    assert.ok(typeof onDisk[0].fetchedAt === "string" && !Number.isNaN(Date.parse(onDisk[0].fetchedAt)),
      "正常刷新仍然写回更新时间（不能靠全部拒绝使红例变绿）");
  });


  await test("MC-037 添加并发：别人新建同名来源时缓存不得被旧请求覆盖/删除", async () => {
    const root = path.join(homedir(), ".mcode", "skill-markets");
    const file = path.join(root, "markets.json");
    const name = "mc037-race";
    const dest = path.join(root, name);
    mkdirSync(dest, { recursive: true });
    const sentinel = path.join(dest, "owner-sentinel.txt");
    writeFileSync(sentinel, "other-window owns this cache", "utf8");
    writeFileSync(file, JSON.stringify({ version: 1, markets: [] }), "utf8");
    const another = { name, source: { kind: "local", ref: path.join(out, "newcomer-dir") }, addedAt: "other-window" };
    raceHook = () => writeFileSync(file, JSON.stringify({ version: 1, markets: [another] }), "utf8");
    const res = await addSkillMarket({ kind: "git", ref: "https://github.com/mc037/race" });
    assert.equal(res.ok, false, "同名来源必须拒绝，不可冒充安装完成");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).markets, [another], "并行加入的来源应保留");
    assert.equal(readFileSync(sentinel, "utf8"), "other-window owns this cache",
      "旧添加不得覆盖/删除并行来源拥有的同名缓存");
    raceReset();
  });

  // 正控(防空过):窗口干净时同样的 add 必须成功并真的落盘 —— 否则上面几条
  // "被拒"可能只是"这个仓/这个 URL 本来就加不进去"造成的假绿。
  await test("MC-037 时序正控:窗口无干扰时 git add 成功并落盘", async () => {
    const skillRecords = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
    writeFileSync(skillRecords, JSON.stringify({ version: 1, markets: [] }, null, 2) + "\n", "utf8");
    raceClean();
    const res = await addSkillMarket({ kind: "git", ref: "https://github.com/mc037/race" });
    assert.equal(res.ok, true, res.error);
    const names = JSON.parse(readFileSync(skillRecords, "utf8")).markets.map((m: { name: string }) => m.name);
    assert.ok(names.includes(res.name!), `正控失败会让上面的拒绝断言变成假绿:${names}`);
    raceReset();
  });
}

await test("MC-037 真实本地并发 add 必须每条成功且落在同一份 markets.json", async () => {
  const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
  writeFileSync(file, JSON.stringify({ version: 1, markets: [] }), "utf8");
  const inputs = Array.from({ length: 16 }, (_, i) => ({
    name: `concurrent-local-${i}`,
    dir: path.join(out, `parallel-local-${i}`),
  }));
  for (const input of inputs) {
    mkdirSync(input.dir, { recursive: true });
    writeFileSync(path.join(input.dir, "SKILL.md"),
      `---\nname: parallel-${input.name}\ndescription: Fixture\n---\n`, "utf8");
  }
  const results = await Promise.all(inputs.map((x) =>
    addSkillMarket({ kind: "local", ref: x.dir, name: x.name })));
  assert.ok(results.every((r) => r.ok),
    `并发调用不能冒充完成或冲突失败: ${JSON.stringify(results)}`);
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    markets: Array<{ name: string; source: { ref: string } }>;
  };
  assert.equal(state.markets.length, inputs.length, "16 个被同意的合法市场必须全部留在磁盘上");
  for (const input of inputs) {
    assert.ok(state.markets.some((m) => m.name === input.name && m.source.ref === input.dir),
      `丢失已确认来源: ${input.name}`);
  }
  assert.equal(skillMarketsCorrupt(), null, "并发添加后清单仍须是合法完整 JSON");
});

await test("MC-037 同一本地源并发注册不同别名不应重复", async () => {
  const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
  writeFileSync(file, JSON.stringify({ version: 1, markets: [] }), "utf8");
  const dir = path.join(out, "mc037-same-source");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: same-src\ndescription: Test\n---\n");
  const results = await Promise.all(["local-alias-a", "local-alias-b"].map((name) =>
    addSkillMarket({ kind: "local", ref: dir, name })));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  const data = JSON.parse(readFileSync(file, "utf8")) as { markets: Array<{ source: { ref: string } }> };
  assert.equal(data.markets.length, 1);
  assert.equal(path.resolve(data.markets[0].source.ref), path.resolve(dir));
});

await test("MC-037 不可信 MCP Registry 不能任意替换本机执行器命令", () => {
  const bad = registryServerToEntry({server:{name:"fixture/shell",packages:[
    {registryType:"npm",identifier:"safe-name",version:"1.0.0",runtimeHint:"alternate-runner",transport:{type:"stdio"}}
  ]}})!;
  assert.equal(bad.options.length,0,"远程注册中心不得将 npm runner 改成任意 shell");
  const good = registryServerToEntry({server:{name:"fixture/npm",packages:[
    {registryType:"npm",identifier:"safe-name",version:"1.0.0",runtimeHint:"npx",transport:{type:"stdio"}}
  ]}})!;
  assert.equal(good.options.length,1,"合法 npx 运行器仍应保留");
});

await test("MC-037 MCP Registry 不允许 302 自动跳转到其它来源/内网", async () => {
  let automaticallyFollowed = 0;
  remoteProbe = (url, init) => {
    if(url.hostname !== "mcp-redirect.example.com") return null;
    if(init?.redirect === "manual") return new Response(null, {status:302,headers:{location:"https://alternate-market.invalid/not-the-registry"}});
    automaticallyFollowed++;
    return new Response(JSON.stringify({servers:[]}),{status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const result=await addMcpMarketSource({url:"https://mcp-redirect.example.com",label:"redirect-fixture"});
    assert.equal(result.ok,false,"注册中心跳转到回环 IP 必须拒绝");
    assert.equal(automaticallyFollowed,0,"不得触发本地回环自动请求");
  } finally {remoteProbe=null;}
});

await test("MC-037 MCP Registry 巨大 JSON 响应必须有字节预算", async () => {
  const huge=JSON.stringify({servers:[],padding:"x".repeat(2*1024*1024+64)});
  remoteProbe=(url)=>url.hostname==="mcp-oversized.example.com"
    ? new Response(huge,{status:200,headers:{"content-type":"application/json"}}) : null;
  try {
    const result=await addMcpMarketSource({url:"https://mcp-oversized.example.com",label:"oversized-fixture"});
    assert.equal(result.ok,false,"MCP 市场目录响应超出预算应失败而不是无限读入内存");
    assert.match(result.error??"",/过大|大小|字节|limit|大于|超出/);
  } finally {remoteProbe=null;}
});

await test("MC-037 Registry 远程端点 URL/头字段不接受非法或原型字段", () => {
  assert.equal(normalizeRegistryBase("https://user:pass@registry.example/v0"),null,
    "不能默默丢弃用户填在 URL 内的凭据");
  const entry=registryServerToEntry({server:{name:"fixture/remote-headers",remotes:[
    {type:"http",url:"https://user:pass@registry.example/api"},
    {type:"http",url:"https://registry.example/api#fragment"},
    {type:"http",url:"https://registry.example/api",headers:[
      {name:"Bad\nHeader",isRequired:true},
      {name:"__proto__",isRequired:true},
      {name:"Authorization",isRequired:true}
    ]}
  ]}})!;
  assert.equal(entry.options.length,1,"只有有效且无身份/片段的 URL 才应提供安装方式");
  assert.deepEqual(entry.options[0].inputs.map((i)=>i.name),["Authorization"],
    "合法鉴权头可用，但换行和 JS 原型字段不能进入配置");
});

await test("MC-037 技能市场部分坏行拒绝覆盖其原始字节",async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[
   {name:"valid-catalog",source:{kind:"local",ref:path.join(out,"valid-catalog")},addedAt:"2026-01-01"},
   {name:"incomplete-catalog",source:{kind:"local"},addedAt:"2026-01-02"}
 ]});
 writeFileSync(file,original,"utf8");
 assert.ok(skillMarketsCorrupt(),"一条坏行必须显式报告损坏");
 const removed=await removeSkillMarket("valid-catalog");
 assert.equal(removed.ok,false,"任何一条坏记录存在时不能用过滤后的列表写回");
 assert.equal(readFileSync(file,"utf8"),original,"失败不得改变任何历史来源字节");
});
await test("MC-037 技能市场重复来源身份不能删除其他用户记录",async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const variants=[
  [
   {name:"dupe-market",source:{kind:"local",ref:path.join(out,"source-a")},addedAt:"2026-01-01"},
   {name:"dupe-market",source:{kind:"local",ref:path.join(out,"source-b")},addedAt:"2026-01-02"}
  ],
  [
   {name:"catalog-one",source:{kind:"local",ref:path.join(out,"shared-source")},addedAt:"2026-01-01"},
   {name:"catalog-two",source:{kind:"local",ref:path.join(out,"shared-source")},addedAt:"2026-01-02"}
  ]
 ];
 for(const records of variants){
  const original=JSON.stringify({version:1,markets:records});
  writeFileSync(file,original,"utf8");
  assert.ok(skillMarketsCorrupt(),"同名或同源的历史记录必须提示损坏");
  const removed=await removeSkillMarket(records[0].name);
  assert.equal(removed.ok,false);
  assert.equal(readFileSync(file,"utf8"),original,"拒写必须保留两条原始记录");
 }
});

// The installed skill directory is executable input to SDK tools. A local
// market can point at a folder that includes junctions to files outside that
// market, and a library-root junction can redirect the whole installation.
await test("MC-037 安装本地技能时拒绝源树内部 Junction，保留外部字节", async () => {
  const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
  writeFileSync(file, JSON.stringify({version:1,markets:[]}),"utf8");
  const catalog = path.join(out,"install-links-catalog");
  const skill = path.join(catalog,"private-linked-skill");
  const other = path.join(out,"outside-skill-secret");
  mkdirSync(skill,{recursive:true});
  mkdirSync(other,{recursive:true});
  writeFileSync(path.join(skill,"SKILL.md"),"---\nname: private-linked-skill\ndescription: fixture\n---\n");
  writeFileSync(path.join(other,"owner-sentinel"),"NOT-A-PART-OF-THE-SKILL");
  symlinkSync(other,path.join(skill,"external"),process.platform==="win32"?"junction":"dir");
  const added=await addSkillMarket({kind:"local",ref:catalog,name:"fixture-link-market"});
  assert.equal(added.ok,true,added.error);
  const result=await installSkillsFromMarket(added.name!,["private-linked-skill"]);
  assert.equal(result.ok,false,"带外链的本地技能不能安装到全局可执行技能库");
  assert.equal(result.imported.length,0);
  assert.equal(existsSync(path.join(defaultSkillsRoot(),"private-linked-skill")),false,
    "失败不留下半复制的可执行技能");
  assert.equal(readFileSync(path.join(other,"owner-sentinel"),"utf8"),"NOT-A-PART-OF-THE-SKILL");
});

await test("MC-037 安装目标技能库根是 Junction 时不得写入外部目录", async () => {
  const file = path.join(homedir(), ".mcode", "skill-markets", "markets.json");
  writeFileSync(file, JSON.stringify({version:1,markets:[]}),"utf8");
  const catalog=path.join(out,"install-root-catalog");
  const skill=path.join(catalog,"root-redirect-skill");
  mkdirSync(skill,{recursive:true});
  writeFileSync(path.join(skill,"SKILL.md"),"---\nname: root-redirect-skill\ndescription: fixture\n---\n");
  const added=await addSkillMarket({kind:"local",ref:catalog,name:"fixture-root-market"});
  assert.equal(added.ok,true,added.error);
  const root=defaultSkillsRoot();
  const saved=path.join(out,"saved-skill-library");
  const outside=path.join(out,"outside-skill-library");
  mkdirSync(outside,{recursive:true});
  // All paths here belong to the smoke's redirected HOME; restore even if the
  // assertion fails. No user library or original project is touched.
  renameSync(root,saved);
  try {
    symlinkSync(outside,root,process.platform==="win32"?"junction":"dir");
    const result=await installSkillsFromMarket(added.name!,["root-redirect-skill"]);
    assert.equal(result.ok,false,"全局技能库为外链时必须拒绝安装");
    assert.equal(existsSync(path.join(outside,"root-redirect-skill")),false);
    assert.equal(existsSync(path.join(saved,"alpha","helper.py")),true,
      "原隔离技能库保留以前安装的文件");
  } finally {
    if(existsSync(root)) rmSync(root,{recursive:true,force:true});
    renameSync(saved,root);
  }
});

await test("MC-037 多个窗口同时安装同名本地技能不可全部返回已导入", async () => {
  const file=path.join(homedir(),".mcode","skill-markets","markets.json");
  writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
  const catalog=path.join(out,"concurrent-install-catalog");
  const skill=path.join(catalog,"concurrent-install-skill");
  mkdirSync(skill,{recursive:true});
  writeFileSync(path.join(skill,"SKILL.md"),"---\nname: concurrent-install-skill\ndescription: fixture\n---\n");
  writeFileSync(path.join(skill,"payload.bin"),Buffer.alloc(2*1024*1024,0x45));
  const added=await addSkillMarket({kind:"local",ref:catalog,name:"fixture-concurrent-market"});
  assert.equal(added.ok,true,added.error);
  const results=await Promise.all(Array.from({length:12},()=>installSkillsFromMarket(
    added.name!,["concurrent-install-skill"])));
  assert.equal(results.flatMap(r=>r.imported).length,1,
    "只有一个安装事务可以原子发布，其他请求应发现目录已存在而跳过");
  assert.equal(results.flatMap(r=>r.errors).length,0,
    "并行竞争不应读到半复制目录、失败或误报为完成");
  assert.equal(readFileSync(path.join(defaultSkillsRoot(),"concurrent-install-skill","payload.bin")).length,
    2*1024*1024,"最终只留下完整的技能文件");
});


// A record may be corrupted while GitHub metadata is awaited. A failed
// refresh/add must not publish a fresh cache before the final write gate.
await test("MC-037 Git 技能添加遇坏账本不得发布孤立缓存", async () => {
  const root=path.join(homedir(),".mcode","skill-markets");
  const file=path.join(root,"markets.json");
  const cache=path.join(root,"mc037-race");
  rmSync(cache,{recursive:true,force:true});
  writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
  raceBreak(file);
  try {
    const result=await addSkillMarket({kind:"git",ref:"https://github.com/mc037/race"});
    assert.equal(result.ok,false);
    assert.equal(result.corrupt,true,"损坏账本应返回明确 corrupt");
    assert.equal(existsSync(cache),false,
      "批准账本已坏，Git 缓存也不能在目录下单独发布");
  } finally{raceReset();}
});
await test("MC-037 Git 技能刷新遇坏账本不得覆盖旧缓存", async () => {
  const root=path.join(homedir(),".mcode","skill-markets");
  const file=path.join(root,"markets.json");
  const name="mc037-corrupt-cache-refresh";
  const cache=path.join(root,name);
  mkdirSync(cache,{recursive:true});
  const sentinel=path.join(cache,"old-cache-owner");
  writeFileSync(sentinel,"PREVIOUS-CACHE-MUST-SURVIVE");
  writeFileSync(file,JSON.stringify({version:1,markets:[{
    name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"stable"
  }]}),"utf8");
  raceBreak(file);
  try {
    const result=await refreshSkillMarket(name);
    assert.equal(result.ok,false);
    assert.equal(result.corrupt,true);
    assert.equal(readFileSync(sentinel,"utf8"),"PREVIOUS-CACHE-MUST-SURVIVE");
  } finally{raceReset();}
});

await test("MC-037 Git 仓库下载期间其他窗口以别名登记相同仓库不得留下孤儿缓存", async () => {
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const attempted="mc037-alias-pending";
 const other={name:"mc037-alias-winner",
   source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"other-window"};
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 rmSync(path.join(root,attempted),{recursive:true,force:true});
 raceConcurrentAdd(file,other);
 try{
   const result=await addSkillMarket({kind:"git",ref:"https://github.com/mc037/race",name:attempted});
   assert.equal(result.ok,false,"相同仓库即使别名不同也不能重复批准");
   assert.equal(existsSync(path.join(root,attempted)),false,
     "失败不能把同仓库另一个别名的缓存发布为孤儿目录");
   const recorded=JSON.parse(readFileSync(file,"utf8")).markets;
   assert.deepEqual(recorded,[other],"其他窗口已经批准的来源一字不动");
 }finally{raceReset();}
});
await test("MC-037 技能源父目录 Junction 不可把外部普通目录伪装成安全来源", async () => {
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const parent=path.join(out,"catalog-parent-link");
 const source=path.join(parent,"repo");
 const srcSkill=path.join(source,"ancestor-linked-skill");
 mkdirSync(srcSkill,{recursive:true});
 writeFileSync(path.join(srcSkill,"SKILL.md"),"---\nname: ancestor-linked-skill\ndescription: Fixture\n---\n");
 const added=await addSkillMarket({kind:"local",ref:source,name:"ancestor-linked-market"});
 assert.equal(added.ok,true,added.error);
 const external=path.join(out,"external-source-parent");
 renameSync(parent,external);
 try {
  symlinkSync(external,parent,process.platform==="win32"?"junction":"dir");
  const result=await installSkillsFromMarket(added.name!,["ancestor-linked-skill"]);
  assert.equal(result.ok,false,"技能本身虽普通，但 katalog 上级 Junction 应拒绝");
  assert.equal(existsSync(path.join(defaultSkillsRoot(),"ancestor-linked-skill")),false);
 } finally {
  if(existsSync(parent)) rmSync(parent,{recursive:true,force:true});
  renameSync(external,parent);
 }
});

await test("MC-037 SDK 技能库的 .mcode 父目录为 Junction 时不得写入间接外部库", async () => {
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const catalog=path.join(out,"parent-junction-catalog");
 const skill=path.join(catalog,"mcode-parent-link-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: mcode-parent-link-skill\ndescription: Fixture\n---\n");
 const added=await addSkillMarket({kind:"local",ref:catalog,name:"parent-junction-market"});
 assert.equal(added.ok,true,added.error);
 const mcodeDir=path.join(homedir(),".mcode");
 const realDir=path.join(out,"mcode-original-parent");
 renameSync(mcodeDir,realDir);
 try {
  symlinkSync(realDir,mcodeDir,process.platform==="win32"?"junction":"dir");
  const result=await installSkillsFromMarket(added.name!,["mcode-parent-link-skill"]);
  assert.equal(result.ok,false,"目标技能库本身是普通目录也不能经上级 Junction 越界写入");
  assert.equal(existsSync(path.join(realDir,"skills","mcode-parent-link-skill")),false);
 } finally {
  if(existsSync(mcodeDir)) rmSync(mcodeDir,{recursive:true,force:true});
  renameSync(realDir,mcodeDir);
 }
});

await test("MC-037 市场清单根的父级 Junction 不能绕过 market root 守卫", async ()=>{
 const original=process.env.MCODE_SKILL_MARKETS_DIR;
 const external=path.join(out,"market-root-parent-external");
 const link=path.join(out,"market-root-parent-link");
 mkdirSync(external,{recursive:true});
 symlinkSync(external,link,process.platform==="win32"?"junction":"dir");
 process.env.MCODE_SKILL_MARKETS_DIR=path.join(link,"market-data");
 try {
  const dir=path.join(out,"market-root-junction-source");
  mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(dir,"SKILL.md"),"---\nname: source\ndescription: fixture\n---\n");
  const result=await addSkillMarket({kind:"local",ref:dir,name:"parent-market-junction"});
  assert.equal(result.ok,false,"市场根本身普通，但祖先 Junction 不得写盘");
  assert.equal(existsSync(path.join(external,"market-data","markets.json")),false);
 }finally{
  if(original===undefined) delete process.env.MCODE_SKILL_MARKETS_DIR;
  else process.env.MCODE_SKILL_MARKETS_DIR=original;
  rmSync(link,{recursive:true,force:true});
 }
});

await test("MC-037 损坏账本不能伪装内置市场身份或自定义市场不可移除", async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const rows=[
  {name:"anthropic-skills",source:{kind:"local",ref:path.join(out,"fake-anthropic")},addedAt:"old"},
  {name:"openai-skills",source:{kind:"git",ref:"https://github.com/elsewhere/skills"},addedAt:"old"},
  {name:"unremovable-local",source:{kind:"local",ref:path.join(out,"fake-immutable")},addedAt:"old",builtin:true}
 ];
 for(const row of rows){
  const bytes=JSON.stringify({version:1,markets:[row]});
  writeFileSync(file,bytes,"utf8");
  assert.ok(skillMarketsCorrupt(),"伪内置来源/无批准 builtin flag 必须显式报损坏");
  const result=await removeSkillMarket(row.name);
  assert.equal(result.ok,false);
  assert.equal(readFileSync(file,"utf8"),bytes);
 }
 const valid=JSON.stringify({version:1,markets:[
  {name:"anthropic-skills",source:{kind:"git",ref:"https://github.com/anthropics/skills"},addedAt:"old",builtin:true}
 ]});
 writeFileSync(file,valid,"utf8");
 assert.equal(skillMarketsCorrupt(),null,"真正对应官方来源的内置市场保存记录仍应接受");
 assert.equal((await removeSkillMarket("anthropic-skills")).ok,false);
});

await test("MC-037 本地市场来源上级 Junction 不能在批准登记阶段通过", async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const external=path.join(out,"source-register-external");
 const link=path.join(out,"source-register-link");
 const skill=path.join(external,"repo","untrusted-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: untrusted-skill\ndescription: fixture\n---\n");
 symlinkSync(external,link,process.platform==="win32"?"junction":"dir");
 try {
  const result=await addSkillMarket({kind:"local",ref:path.join(link,"repo"),name:"alias-register-source"});
  assert.equal(result.ok,false,"保存用户批准来源时就应阻断上级 Junction");
  assert.deepEqual(JSON.parse(readFileSync(file,"utf8")).markets,[]);
 }finally{rmSync(link,{recursive:true,force:true});}
});

await test("MC-037 本地来源注册后变成 Junction，列表和刷新均拒绝跟随", async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const parent=path.join(out,"source-after-register");
 const dir=path.join(parent,"repo");
 const skill=path.join(dir,"post-register-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: post-register-skill\ndescription: fixture\n---\n");
 const result=await addSkillMarket({kind:"local",ref:dir,name:"source-after-register-market"});
 assert.equal(result.ok,true,result.error);
 const saved=path.join(out,"source-after-register-saved");
 const bytes=readFileSync(file,"utf8");
 renameSync(parent,saved);
 try {
  symlinkSync(saved,parent,process.platform==="win32"?"junction":"dir");
  const items=await listSkillMarkets();
  const market=items.find(x=>x.name==="source-after-register-market");
  assert.ok(market);
  assert.equal(market!.cloned,false,"不能把外链缓存对用户展示为可用来源");
  assert.deepEqual(market!.skills,[]);
  const refresh=await refreshSkillMarket("source-after-register-market");
  assert.equal(refresh.ok,false,"本地刷新不得在来源链接时虚报成功");
  assert.equal(readFileSync(file,"utf8"),bytes,"拒绝读取外链不改持久记录");
 } finally{
  if(existsSync(parent))rmSync(parent,{recursive:true,force:true});
  renameSync(saved,parent);
 }
});

await test("MC-037 Windows 市场名称仅大小写不同不能生成坏账本", async ()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const firstDir=path.join(out,"case-market-source-A");
 const secondDir=path.join(out,"case-market-source-B");
 mkdirSync(firstDir,{recursive:true});
 mkdirSync(secondDir,{recursive:true});
 writeFileSync(path.join(firstDir,"SKILL.md"),"---\nname: first\ndescription: fixture\n---\n");
 writeFileSync(path.join(secondDir,"SKILL.md"),"---\nname: second\ndescription: fixture\n---\n");
 const one=await addSkillMarket({kind:"local",ref:firstDir,name:"CaseSensitiveDemo"});
 assert.equal(one.ok,true,one.error);
 const two=await addSkillMarket({kind:"local",ref:secondDir,name:"casesensitivedemo"});
 if(process.platform==="win32"){
  assert.equal(two.ok,false,"Windows 同名仅大小写区别，必须阻断后一个");
  assert.equal(skillMarketsCorrupt(),null,"添加失败不能顺手写坏整个持久化清单");
  assert.equal(JSON.parse(readFileSync(file,"utf8")).markets.length,1);
 }else{
  assert.equal(two.ok,true,"POSIX 严格大小写命名仍允许不同市场");
 }
});

await test("MC-037 撤销 Git 市场只撤登记，不得误删同名无关缓存目录", async () => {
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="unowned-cache-remove";
 const dir=path.join(root,name);
 mkdirSync(dir,{recursive:true});
 const original="UNRELATED-USER-CACHE";
 writeFileSync(path.join(dir,"owner-sentinel"),original);
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"test"
 }]}),"utf8");
 const result=await removeSkillMarket(name);
 assert.equal(result.ok,true,"撤销批准记录不应被孤儿缓存干扰");
 assert.equal(JSON.parse(readFileSync(file,"utf8")).markets.length,0,"来源登记应移除");
 assert.equal(readFileSync(path.join(dir,"owner-sentinel"),"utf8"),original,
  "没有合法归属索引的目录可能是用户内容，不能按市场名称盲删");
});

await test("MC-037 Git 撤销不能删除含有效但不归该来源的旧缓存",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="foreign-source-cache";
 const dir=path.join(root,name);
 mkdirSync(dir,{recursive:true});
 const foreignIndex={version:1,source:{owner:"someone-else",repo:"unrelated"},
   commit:"a".repeat(40),skills:[],files:[]};
 const bytes=JSON.stringify(foreignIndex);
 writeFileSync(path.join(dir,".github-skill-index.json"),bytes,"utf8");
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"test"
 }]}),"utf8");
 const result=await removeSkillMarket(name);
 assert.equal(result.ok,true);
 assert.equal(JSON.parse(readFileSync(file,"utf8")).markets.length,0);
 assert.equal(readFileSync(path.join(dir,".github-skill-index.json"),"utf8"),bytes,
  "另一 Git 仓库的 cache 必须保全");
});

await test("MC-037 外部 Junction 伪装已安装技能时列表不能显示成功",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}),"utf8");
 const catalog=path.join(out,"catalog-symlink-installed");
 const dir=path.join(catalog,"untrusted-installed-skill");
 mkdirSync(dir,{recursive:true});
 writeFileSync(path.join(dir,"SKILL.md"),"---\nname: untrusted-installed-skill\ndescription: fixture\n---\n");
 const registration=await addSkillMarket({kind:"local",ref:catalog,name:"linked-installed-market"});
 assert.equal(registration.ok,true,registration.error);
 const external=path.join(out,"external-installed-skill");
 mkdirSync(external,{recursive:true});
 const sentinel="EXTERNAL-DO-NOT-CHANGE";
 writeFileSync(path.join(external,"sentinel"),sentinel);
 const dest=path.join(defaultSkillsRoot(),"untrusted-installed-skill");
 symlinkSync(external,dest,process.platform==="win32"?"junction":"dir");
 try{
  const listed=(await listSkillMarkets()).find(x=>x.name==="linked-installed-market");
  assert.ok(listed);
  assert.equal(listed!.skills[0].installed,false,
    "SDK 库内仅有 Junction，不是 Mcode 实际安装的普通技能");
  const install=await installSkillsFromMarket("linked-installed-market",["untrusted-installed-skill"]);
  assert.equal(install.imported.length,0);
  assert.equal(install.skipped.length,0,
    "不能把已有外部软链当作用户已经安装并自动跳过");
  assert.equal(install.errors.length,1,"要报告用户需要处理的冲突");
  assert.equal(readFileSync(path.join(external,"sentinel"),"utf8"),sentinel);
 }finally{rmSync(dest,{recursive:true,force:true});}
});

await test("MC-037 归属匹配且只有 index 的 Git 市场缓存撤销后可正常清理", async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const name="verified-owned-cache";
 const dir=path.join(root,name);
 const index={version:1,source:{owner:"mc037",repo:"race"},commit:"a".repeat(40),skills:[],files:[]};
 mkdirSync(dir,{recursive:true});
 writeFileSync(path.join(dir,".github-skill-index.json"),JSON.stringify(index));
 writeFileSync(path.join(root,"markets.json"),JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"test"
 }]}));
 const result=await removeSkillMarket(name);
 assert.equal(result.ok,true);
 assert.equal(existsSync(dir),false,"只有与批准来源身份匹配的索引缓存才能被自动清理");
});
await test("MC-037 已安装目录缺少 SKILL.md 不能误标安装完成",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}));
 const catalog=path.join(out,"partially-installed-market");
 const dir=path.join(catalog,"partial-skill");
 mkdirSync(dir,{recursive:true});
 writeFileSync(path.join(dir,"SKILL.md"),"---\nname: partial-skill\ndescription: fixture\n---\n");
 const registration=await addSkillMarket({kind:"local",ref:catalog,name:"partially-installed-market"});
 assert.equal(registration.ok,true);
 const dest=path.join(defaultSkillsRoot(),"partial-skill");
 mkdirSync(dest,{recursive:true});
 writeFileSync(path.join(dest,"unfinished-file"),"HALF-COPIED");
 const listed=(await listSkillMarkets()).find(m=>m.name==="partially-installed-market");
 assert.ok(listed);
 assert.equal(listed!.skills[0].installed,false);
 const installation=await installSkillsFromMarket("partially-installed-market",["partial-skill"]);
 assert.equal(installation.imported.length,0);
 assert.equal(installation.skipped.length,0);
 assert.equal(installation.errors.length,1);
 assert.equal(readFileSync(path.join(dest,"unfinished-file"),"utf8"),"HALF-COPIED");
});

await test("MC-037 技能库根为 Junction 时 UI 不能误判外部技能已安装",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}));
 const catalog=path.join(out,"ui-root-junction-catalog");
 const source=path.join(catalog,"outside-root-installed");
 mkdirSync(source,{recursive:true});
 writeFileSync(path.join(source,"SKILL.md"),"---\nname: outside-root-installed\ndescription: fixture\n---\n");
 const added=await addSkillMarket({kind:"local",ref:catalog,name:"root-junction-ui-market"});
 assert.equal(added.ok,true);
 const root=defaultSkillsRoot();
 const moved=path.join(out,"ui-root-junction-original");
 mkdirSync(path.join(root,"outside-root-installed"),{recursive:true});
 writeFileSync(path.join(root,"outside-root-installed","SKILL.md"),"---\nname: outside-root-installed\n---\n");
 renameSync(root,moved);
 try{
  symlinkSync(moved,root,process.platform==="win32"?"junction":"dir");
  const listed=(await listSkillMarkets()).find(s=>s.name==="root-junction-ui-market");
  assert.ok(listed);
  assert.equal(listed!.skills[0].installed,false,
    "Junction 指向的外部技能不是 SDK 在普通受管库中真实安装");
 }finally{
  if(existsSync(root))rmSync(root,{recursive:true,force:true});
  renameSync(moved,root);
 }
});

await test("MC-037 自定义别名不得借官方 Git 来源伪装成不可删除内置市场",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[{
  name:"forged-builtin-alias",
  source:{kind:"git",ref:"https://github.com/openai/skills"},
  addedAt:"fixture",
  builtin:true
 }]});
 writeFileSync(file,original);
 assert.ok(skillMarketsCorrupt(),"伪造官方源的别名不能带 builtin=true 假扮受保护市场");
 const result=await removeSkillMarket("forged-builtin-alias");
 assert.equal(result.ok,false);
 assert.equal(readFileSync(file,"utf8"),original);
});
await test("MC-037 技能来源 markets.json 是外部硬链接时不得读取或改写",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const external=path.join(out,"market-ledger-unrelated-hardlink.json");
 const original=JSON.stringify({version:1,markets:[{
  name:"external-ledger-source",
  source:{kind:"local",ref:path.join(out,"unrelated-local-path")},
  addedAt:"fixture"
 }]});
 writeFileSync(external,original);
 rmSync(file,{force:true});
 linkSync(external,file);
 try{
  assert.ok(skillMarketsCorrupt(),"来源账本为 nlink>1 硬链接时应拒绝读取外部原件");
  const removed=await removeSkillMarket("external-ledger-source");
  assert.equal(removed.ok,false);
  assert.equal(readFileSync(file,"utf8"),original);
  assert.equal(readFileSync(external,"utf8"),original,"外部字节必须保留");
 }finally{rmSync(file,{force:true});}
});


await test("MC-037 市场账本的父目录 Junction 不得被读取成受信任批准来源", async()=>{
 const original=process.env.MCODE_SKILL_MARKETS_DIR;
 const external=path.join(out,"external-records-root");
 const alias=path.join(out,"linked-records-root");
 mkdirSync(external,{recursive:true});
 writeFileSync(path.join(external,"markets.json"),JSON.stringify({version:1,markets:[]}));
 symlinkSync(external,alias,process.platform==="win32"?"junction":"dir");
 process.env.MCODE_SKILL_MARKETS_DIR=alias;
 try{
  assert.ok(skillMarketsCorrupt(),"父目录即使链接到合法 JSON，也必须展示为损坏而不是无来源");
  const result=await addSkillMarket({kind:"local",ref:out,name:"alias-ledger-rejected"});
  assert.equal(result.ok,false);
  assert.equal(JSON.parse(readFileSync(path.join(external,"markets.json"),"utf8")).markets.length,0);
 }finally{
  if(original===undefined) delete process.env.MCODE_SKILL_MARKETS_DIR;
  else process.env.MCODE_SKILL_MARKETS_DIR=original;
  rmSync(alias,{force:true,recursive:true});
 }
});

await test("MC-037 Git 索引的外部硬链接不能冒充已批准可安装市场",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="linked-git-index-catalog";
 const cache=path.join(root,name);
 mkdirSync(cache,{recursive:true});
 const target=path.join(out,"external-owned-git-index.json");
 const original=JSON.stringify({version:1,source:{owner:"mc037",repo:"race"},
  commit:"a".repeat(40),skills:[{name:"linked-git-skill",description:"external",relPath:"linked-git-skill"}],files:[]});
 writeFileSync(target,original);
 linkSync(target,path.join(cache,".github-skill-index.json"));
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"test"
 }]}));
 const listed=(await listSkillMarkets()).find(x=>x.name===name);
 assert.ok(listed);
 assert.equal(listed!.cloned,false,"硬链接索引没有独立文件身份，不能被视为已缓存市场");
 assert.deepEqual(listed!.skills,[]);
 const install=await installSkillsFromMarket(name,["linked-git-skill"]);
 assert.equal(install.ok,false);
 assert.equal(install.imported.length,0);
 assert.ok(install.error,"应在读取外部缓存索引前向用户报告异常");
 assert.equal(readFileSync(target,"utf8"),original);
});

await test("MC-037 已批准的本地市场在安装前换成 Junction 必须先于扫描拒绝",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}));
 const root=path.join(out,"catalog-link-after-approved");
 const skill=path.join(root,"preflight-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: preflight-skill\ndescription: not for scanning\n---\n");
 const added=await addSkillMarket({kind:"local",ref:root,name:"preflight-link-market"});
 assert.equal(added.ok,true,added.error);
 const moved=path.join(out,"external-approved-catalog");
 renameSync(root,moved);
 try{
  symlinkSync(moved,root,process.platform==="win32"?"junction":"dir");
  const result=await installSkillsFromMarket("preflight-link-market",["preflight-skill"]);
  assert.equal(result.ok,false);
  assert.ok(/链接|Junction/i.test(result.error??""),"拒绝必须在扫描 SKILL.md 前完成并返回顶层错误");
  assert.equal(result.imported.length,0);
  assert.deepEqual(result.errors,[]);
  assert.equal(existsSync(path.join(defaultSkillsRoot(),"preflight-skill")),false);
 }finally{
  if(existsSync(root))rmSync(root,{recursive:true,force:true});
  renameSync(moved,root);
 }
});

await test("MC-037 Git 市场刷新不应通过外部 Junction 替换缓存",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="linked-refresh-catalog";
 const cache=path.join(root,name);
 const external=path.join(out,"external-refresh-catalog");
 mkdirSync(external,{recursive:true});
 const original="EXTERNAL-OWNER-STAYS";
 writeFileSync(path.join(external,"owner-sentinel"),original);
 const fixture={version:1,source:{owner:"mc037",repo:"race"},
  commit:"a".repeat(40),skills:[{name:"race-skill",description:"test",relPath:"race-skill"}],files:[]};
 writeFileSync(path.join(external,".github-skill-index.json"),JSON.stringify(fixture));
 symlinkSync(external,cache,process.platform==="win32"?"junction":"dir");
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"stable"
 }]}));
 try{
  const result=await refreshSkillMarket(name);
  assert.equal(result.ok,false,"Git 缓存根被 Junction 替换时不能继续刷新/提升索引");
  assert.equal(readFileSync(path.join(external,"owner-sentinel"),"utf8"),original);
  assert.ok(lstatSync(cache).isSymbolicLink(),"拒绝刷新后应保留原链接供用户检查");
 }finally{if(existsSync(cache))rmSync(cache,{recursive:true,force:true});}
});

await test("MC-037 持久来源的 addedAt/fetchedAt/builtin 字段损坏需保留原 JSON",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const base={name:"malformed-market-metadata",source:{kind:"local",ref:path.join(out,"fixture-valid-local")},addedAt:"2026-01-01"};
 for(const rec of [
  {...base,addedAt:undefined},
  {...base,addedAt:123},
  {...base,fetchedAt:{nested:true}},
  {...base,builtin:"false"},
 ]){
  const original=JSON.stringify({version:1,markets:[rec]});
  writeFileSync(file,original);
  assert.ok(skillMarketsCorrupt(),"不可信 metadata 不应默认为健康来源");
  const result=await removeSkillMarket(base.name);
  assert.equal(result.ok,false);
  assert.equal(readFileSync(file,"utf8"),original);
 }
});

await test("MC-037 异常大市场登记文件应有限额并拒绝解析",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[{
  name:"oversized-market",source:{kind:"local",ref:path.join(out,"oversized-market")},
  addedAt:"x".repeat(5*1024*1024)
 }]});
 writeFileSync(file,original);
 assert.ok(skillMarketsCorrupt(),"超出预算的来源 JSON 不应无界占用主进程内存");
 const result=await removeSkillMarket("oversized-market");
 assert.equal(result.ok,false);
 assert.equal(readFileSync(file,"utf8").length,original.length);
});

await test("MC-037 本地技能源中的硬链接载荷不能复制外部文件到 SDK",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}));
 const catalog=path.join(out,"local-hardlink-payload-catalog");
 const skill=path.join(catalog,"linked-payload-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: linked-payload-skill\ndescription: fixture\n---\n");
 const external=path.join(out,"private-external-payload.txt");
 const secret="EXTERNAL-UNAPPROVED-BYTES";
 writeFileSync(external,secret);
 linkSync(external,path.join(skill,"payload.txt"));
 const added=await addSkillMarket({kind:"local",ref:catalog,name:"hardlink-payload-market"});
 assert.equal(added.ok,true,added.error);
 const installed=await installSkillsFromMarket("hardlink-payload-market",["linked-payload-skill"]);
 assert.equal(installed.ok,false,"本地市场不能将外部硬链接文件复制进 SDK");
 assert.equal(installed.errors.length,1);
 assert.equal(existsSync(path.join(defaultSkillsRoot(),"linked-payload-skill")),false);
 assert.equal(readFileSync(external,"utf8"),secret);
});
await test("MC-037 技能描述 SKILL.md 硬链接外部文件必须在市场登记时拒绝",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 writeFileSync(file,JSON.stringify({version:1,markets:[]}));
 const catalog=path.join(out,"local-hardlink-frontmatter-catalog");
 const skill=path.join(catalog,"external-frontmatter-skill");
 mkdirSync(skill,{recursive:true});
 const external=path.join(out,"external-frontmatter.txt");
 const content="---\nname: external-frontmatter-skill\ndescription: private description\n---\n";
 writeFileSync(external,content);
 linkSync(external,path.join(skill,"SKILL.md"));
 const result=await addSkillMarket({kind:"local",ref:catalog,name:"external-frontmatter-market"});
 assert.equal(result.ok,false,"不应从本地目录之外的硬链接内容生成市场条目");
 assert.equal(readFileSync(external,"utf8"),content);
 assert.equal(JSON.parse(readFileSync(file,"utf8")).markets.length,0);
});

await test("MC-037 Git 刷新遇缓存索引硬链接必须拒绝替换而非直接提升",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="linked-refresh-index-only";
 const cache=path.join(root,name);
 mkdirSync(cache,{recursive:true});
 const external=path.join(out,"external-refresh-index.json");
 const original=JSON.stringify({version:1,source:{owner:"mc037",repo:"race"},
  commit:"a".repeat(40),skills:[{name:"race-skill",description:"test",relPath:"race-skill"}],files:[]});
 writeFileSync(external,original);
 linkSync(external,path.join(cache,".github-skill-index.json"));
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"test"
 }]}));
 const result=await refreshSkillMarket(name);
 assert.equal(result.ok,false,"索引文件硬链接到外部时，刷新不能绕过读取围栏进行缓存提升");
 assert.equal(readFileSync(external,"utf8"),original);
 assert.equal(readFileSync(path.join(cache,".github-skill-index.json"),"utf8"),original,
   "坏缓存须保留现场供人工恢复");
});

await test("MC-037 本地市场不能无限遍历空目录消耗主进程IO预算",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[]});
 writeFileSync(file,original);
 const root=path.join(out,"scan-budget-market");
 mkdirSync(root,{recursive:true});
 // Deliberately place one real skill after >2,000 empty folders in sorted
 // traversal order. Old code limits the number of *skills*, not dirs visited.
 for(let i=0;i<2049;i++) mkdirSync(path.join(root,"empty-"+String(i).padStart(4,"0")));
 const last=path.join(root,"zzz-final-skill");
 mkdirSync(last);
 writeFileSync(path.join(last,"SKILL.md"),"---\nname: zzz-final-skill\ndescription: fixture\n---\n");
 const result=await addSkillMarket({kind:"local",ref:root,name:"huge-untrusted-tree"});
 assert.equal(result.ok,false,"超过遍历上限必须停止，而不是扫描任意深度和数目");
 assert.match(result.error??"",/目录.*上限|扫描.*上限/,"应报告资源预算耗尽而不是无技能");
 assert.equal(readFileSync(file,"utf8"),original);
});

await test("MC-037 超大 Git index 的额外字段不能触发无限 JSON 解析",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="oversized-github-index";
 const cache=path.join(root,name);
 mkdirSync(cache,{recursive:true});
 const payload={
  version:1,source:{owner:"mc037",repo:"race"},commit:"a".repeat(40),
  skills:[{name:"external-oversized",description:"fixture",relPath:"external-oversized"}],
  files:[],extraPadding:"p".repeat(9*1024*1024)
 };
 writeFileSync(path.join(cache,".github-skill-index.json"),JSON.stringify(payload));
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"fixture"
 }]}));
 const listed=(await listSkillMarkets()).find(x=>x.name===name);
 assert.ok(listed);
 assert.equal(listed!.cloned,false,"缓存超限必须拒绝读取，而不是解析未受信任的9MiB JSON");
 assert.deepEqual(listed!.skills,[]);
 const installed=await installSkillsFromMarket(name,["external-oversized"]);
 assert.equal(installed.ok,false);
 assert.match(installed.error??"",/大小|上限|超出/);
});


await test("MC-037 子目录访问异常不可静默缩减市场技能列表",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[]});
 writeFileSync(file,original);
 const root=path.join(out,"unreadable-child-market");
 const normal=path.join(root,"valid-visible");
 const forbidden=path.join(root,"restricted-child");
 mkdirSync(normal,{recursive:true});
 mkdirSync(forbidden,{recursive:true});
 writeFileSync(path.join(normal,"SKILL.md"),"---\nname: valid-visible\ndescription: fixture\n---\n");
 writeFileSync(path.join(forbidden,"SKILL.md"),"---\nname: restricted-child\ndescription: fixture\n---\n");
 const originalReadDir=fsPromises.readdir;
 (fsPromises as unknown as {readdir:typeof fsPromises.readdir}).readdir=
   ((location:string,...args:unknown[])=>{
     if(path.resolve(String(location))===forbidden){
       return Promise.reject(Object.assign(new Error("fake access denied"),{code:"EACCES"}));
     }
     return (originalReadDir as (...a:unknown[])=>unknown)(location,...args);
   }) as typeof fsPromises.readdir;
 try{
  const result=await addSkillMarket({kind:"local",ref:root,name:"partly-unreadable-market"});
  assert.equal(result.ok,false,"单个目录无法读取不得把缺失的技能默默隐藏");
  assert.match(result.error??"",/扫描失败|EACCES|读取/);
  assert.equal(readFileSync(file,"utf8"),original);
 }finally{
  (fsPromises as unknown as {readdir:typeof fsPromises.readdir}).readdir=originalReadDir;
 }
});
await test("MC-037 刷新 Git 时超大索引不能被悄悄覆盖并称成功",async()=>{
 const root=path.join(homedir(),".mcode","skill-markets");
 const file=path.join(root,"markets.json");
 const name="oversized-index-refresh";
 const cache=path.join(root,name);
 mkdirSync(cache,{recursive:true});
 const original=JSON.stringify({version:1,source:{owner:"mc037",repo:"race"},
  commit:"a".repeat(40),skills:[],files:[],padding:"x".repeat(9*1024*1024)});
 const index=path.join(cache,".github-skill-index.json");
 writeFileSync(index,original);
 writeFileSync(file,JSON.stringify({version:1,markets:[{
  name,source:{kind:"git",ref:"https://github.com/mc037/race"},addedAt:"stable"
 }]}));
 const result=await refreshSkillMarket(name);
 assert.equal(result.ok,false,"缓存索引超预算，刷新不能悄悄替换原始可疑字节");
 assert.equal(readFileSync(index,"utf8"),original);
});


await test("MC-037 市场目录一次返回海量无关文件必须受扫描条目预算约束",async()=>{
 const file=path.join(homedir(),".mcode","skill-markets","markets.json");
 const original=JSON.stringify({version:1,markets:[]});
 writeFileSync(file,original);
 const root=path.join(out,"huge-single-directory");
 const skill=path.join(root,"real-skill");
 mkdirSync(skill,{recursive:true});
 writeFileSync(path.join(skill,"SKILL.md"),"---\nname: real-skill\ndescription: fixture\n---\n");
 const originalReadDir=fsPromises.readdir;
 (fsPromises as unknown as {readdir:typeof fsPromises.readdir}).readdir=
  ((location:string,...args:unknown[])=>{
   const real=(originalReadDir as (...a:unknown[])=>Promise<unknown>)(location,...args);
   if(path.resolve(String(location))!==root) return real;
   return real.then((items)=>{
    const decoys=Array.from({length:8500},(_,i)=>({
      name:"payload-"+i,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,
    }));
    return [...(items as unknown[]),...decoys];
   });
  }) as typeof fsPromises.readdir;
 try{
  const result=await addSkillMarket({kind:"local",ref:root,name:"wide-tree-market"});
  assert.equal(result.ok,false,"单个目录中的无关海量文件不能绕过目录数预算");
  assert.match(result.error??"",/扫描.*条目.*上限/);
  assert.equal(readFileSync(file,"utf8"),original);
 }finally{
  (fsPromises as unknown as {readdir:typeof fsPromises.readdir}).readdir=originalReadDir;
 }
});

console.log(`market-smoke: ${passed} passed`);
