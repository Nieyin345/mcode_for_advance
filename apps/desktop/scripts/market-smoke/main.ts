import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
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

console.log(`market-smoke: ${passed} passed`);
