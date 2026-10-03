import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildMcpMarketConfig } from "@contracts/ipc";
import {
  addMcpMarketSource,
  listMcpMarketSources,
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
} from "@main/lib/skillMarket.js";
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
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

console.log(`market-smoke: ${passed} passed`);
