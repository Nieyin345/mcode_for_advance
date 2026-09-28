import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillInfo } from "@contracts/ipc";

const home = process.env.MCODE_SKILLS_SMOKE_HOME;
const artifacts = process.env.MCODE_SKILLS_SMOKE_ARTIFACTS;
if (!home || !artifacts || resolve(homedir()) !== resolve(home)) throw Error("Isolated HOME/USERPROFILE required");
const root = join(home, ".mcode", "skills");
const projectA = join(artifacts, "project-a");
const projectB = join(artifacts, "project-b");
const projectRoot = (project: string) => join(project, ".claude", "skills");
const pluginRoot = join(artifacts, "plugin-skills");
process.env.MCODE_SKILLS_FIXTURE_PLUGIN_ROOT = pluginRoot;
process.env.MCODE_SKILLS_FIXTURE_PROJECTS = JSON.stringify([
  { id: "a", name: "Project A", path: projectA }, { id: "b", name: "Project B", path: projectB },
]);
for (const p of [root, projectRoot(projectA), projectRoot(projectB), pluginRoot]) mkdirSync(p, { recursive: true });
const { IPC, SKILL_NAME_RE } = await import("@contracts/ipc");
const { registerSkillsHandlers, readSkillForProject } = await import("@main/ipc/skills.js");
const { skillNamesInRoot } = await import("@main/lib/skillEngines.js");
const handlers = new Map<string, (...args: unknown[]) => unknown>();
registerSkillsHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never);
async function call<T>(channel: string, input: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw Error("Unregistered channel: " + channel);
  return await handler(null, input) as T;
}
type Ok = { ok: boolean; error?: string };
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: fixture ${name}\n---\n\n${body}\n`;
function skill(at: string, folder: string, name: string, body = name): string {
  const dir = join(at, folder);
  mkdirSync(dir, { recursive: true });
  const text = md(name, body);
  writeFileSync(join(dir, "SKILL.md"), text);
  writeFileSync(join(dir, "helper.txt"), "support file for " + name);
  return text;
}
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { await run(); results.push({ name, ok: true }); console.log("PASS " + name); }
  catch (e) { const error = e instanceof Error ? e.stack ?? e.message : String(e); results.push({ name, ok: false, error }); console.log("FAIL " + name + "\n" + error); }
}
const globalShared = skill(root, "shared", "shared", "GLOBAL");
const aShared = skill(projectRoot(projectA), "shared", "shared", "PROJECT A");
const bShared = skill(projectRoot(projectB), "shared", "shared", "PROJECT B");
const aliasText = skill(root, "installed-folder", "displayed-name", "long source\n" + "x".repeat(18000) + "\nEND OF FULL MARKDOWN");
skill(root, ".hidden-skill", "hidden-valid-name");
skill(root, ".system", ".system");
skill(join(root, ".system"), "skill-installer", "skill-installer");
mkdirSync(join(root, "support-files"));
mkdirSync(join(root, "not-markdown", "SKILL.md"), { recursive: true });
skill(root, "bad-metadata", "../escape");
mkdirSync(join(root, "empty-source"));
writeFileSync(join(root, "empty-source", "SKILL.md"), "");
skill(pluginRoot, "plugin-folder", "plugin-alias", "PLUGIN SOURCE");

await test("only callable skills with a regular SKILL.md are listed; hidden/system containers are not skills", async () => {
  const { skills } = await call<{ skills: SkillInfo[] }>(IPC.SKILLS_LIST, {});
  assert.ok(skills.some(s => s.name === "displayed-name"));
  assert.ok(skills.some(s => s.name === "empty-source"));
  for (const name of [".system", "hidden-valid-name", "support-files", "not-markdown", "../escape", "skill-installer"]) assert.ok(!skills.some(s => s.name === name), "unexpected row: " + name);
  assert.ok(skills.every(s => SKILL_NAME_RE.test(s.name)));
});
await test("engine name discovery uses the same valid-document rule", () => {
  const names = skillNamesInRoot(root);
  assert.equal(names.get("displayed-name"), join(root, "installed-folder"));
  for (const name of [".system", "hidden-valid-name", "support-files", "not-markdown", "../escape"]) assert.ok(!names.has(name), "unexpected engine skill: " + name);
});
await test("logical name reads the real directory and the complete source, never a truncated metadata head", async () => {
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "global", name: "displayed-name" })).content, aliasText);
});
await test("saving an alias updates the original directory without creating a second skill", async () => {
  const content = md("displayed-name", "SAVED ORIGINAL");
  assert.equal((await call<Ok>(IPC.SKILLS_SAVE, { source: "global", name: "displayed-name", content })).ok, true);
  assert.equal(readFileSync(join(root, "installed-folder", "SKILL.md"), "utf8"), content);
  assert.equal(existsSync(join(root, "displayed-name")), false);
});
// Remove only a wrongly-created fixture directory from the red implementation,
// so the next independent alias-copy check cannot accidentally use it.
rmSync(join(root, "displayed-name"), { recursive: true, force: true });
await test("copy resolves the logical source name and preserves supporting files", async () => {
  const res = await call<{ copied: string[]; failed: unknown[] }>(IPC.SKILLS_COPY_TO_PROJECT, { projectPath: projectB, names: ["displayed-name"] });
  assert.deepEqual(res.copied, ["displayed-name"]);
  assert.deepEqual(res.failed, []);
  assert.equal(readFileSync(join(projectRoot(projectB), "displayed-name", "helper.txt"), "utf8"), "support file for displayed-name");
});
await test("copy does not overwrite or duplicate a project skill with the same logical name in another directory", async () => {
  const local = skill(projectRoot(projectA), "local-folder", "displayed-name", "PROJECT EDITS");
  const res = await call<{ copied: string[]; skipped: Array<{ name: string }> }>(IPC.SKILLS_COPY_TO_PROJECT, { projectPath: projectA, names: ["displayed-name"] });
  assert.deepEqual(res.copied, []);
  assert.equal(res.skipped[0]?.name, "displayed-name");
  assert.equal(readFileSync(join(projectRoot(projectA), "local-folder", "SKILL.md"), "utf8"), local);
  assert.equal(existsSync(join(projectRoot(projectA), "displayed-name")), false);
});
await test("delete resolves the actual aliased directory and preserves unrelated skills", async () => {
  skill(root, "remove-folder", "remove-alias");
  assert.equal((await call<Ok>(IPC.SKILLS_DELETE, { source: "global", name: "remove-alias" })).ok, true);
  assert.equal(existsSync(join(root, "remove-folder")), false);
  assert.equal(readFileSync(join(root, "shared", "SKILL.md"), "utf8"), globalShared);
});
await test("logical identity takes precedence over a same-named directory owned by another skill", async () => {
  const owner = skill(root, "collision", "different-owner", "DO NOT TOUCH");
  const wanted = skill(root, "physical-collision", "collision", "THIS ONE");
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "global", name: "collision" })).content, wanted);
  assert.equal((await call<Ok>(IPC.SKILLS_DELETE, { source: "global", name: "collision" })).ok, true);
  assert.equal(readFileSync(join(root, "collision", "SKILL.md"), "utf8"), owner);
  assert.equal(existsSync(join(root, "physical-collision")), false);
});
await test("creating a skill never overwrites a differently-named skill occupying that directory", async () => {
  const existing = skill(root, "occupied", "occupying-owner", "KEEP THIS");
  const res = await call<Ok>(IPC.SKILLS_SAVE, { source: "global", name: "occupied", content: md("occupied", "REPLACEMENT") });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal(readFileSync(join(root, "occupied", "SKILL.md"), "utf8"), existing);
});
await test("new skills can still be explicitly created and read", async () => {
  const content = md("brand-new", "CREATED");
  assert.equal((await call<Ok>(IPC.SKILLS_SAVE, { source: "global", name: "brand-new", content })).ok, true);
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "global", name: "brand-new" })).content, content);
});
await test("project reads are scoped to the chosen path; global and same-name peers remain independent", async () => {
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "project", projectPath: projectA, name: "shared" })).content, aShared);
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "project", projectPath: projectB, name: "shared" })).content, bShared);
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "global", name: "shared" })).content, globalShared);
});
await test("project save and delete cannot mutate the global library or the other project", async () => {
  const content = md("shared", "A EDITED");
  assert.equal((await call<Ok>(IPC.SKILLS_SAVE, { source: "project", projectPath: projectA, name: "shared", content })).ok, true);
  assert.equal((await call<Ok>(IPC.SKILLS_DELETE, { source: "project", projectPath: projectB, name: "shared" })).ok, true);
  assert.equal(readFileSync(join(projectRoot(projectA), "shared", "SKILL.md"), "utf8"), content);
  assert.equal(existsSync(join(projectRoot(projectB), "shared")), false);
  assert.equal(readFileSync(join(root, "shared", "SKILL.md"), "utf8"), globalShared);
});
await test("missing/relative project identity is an explicit read error, not a blank document", async () => {
  await assert.rejects(() => call(IPC.SKILLS_READ, { source: "project", name: "shared" }));
  await assert.rejects(() => call(IPC.SKILLS_READ, { source: "project", projectPath: "relative", name: "shared" }));
});
await test("missing or unreadable SKILL.md rejects rather than looking like a successfully loaded empty source", async () => {
  await assert.rejects(() => call(IPC.SKILLS_READ, { source: "global", name: "missing" }));
  await assert.rejects(() => call(IPC.SKILLS_READ, { source: "global", name: "not-markdown" }));
});
await test("a truly zero-byte SKILL.md remains distinguishable and readable", async () => {
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "global", name: "empty-source" })).content, "");
});
await test("contributed alias source is readable but remains readonly at the mutation schema", async () => {
  const expected = readFileSync(join(pluginRoot, "plugin-folder", "SKILL.md"), "utf8");
  assert.equal((await call<{ content: string }>(IPC.SKILLS_READ, { source: "plugin", name: "plugin-alias" })).content, expected);
  await assert.rejects(() => call(IPC.SKILLS_DELETE, { source: "plugin", name: "plugin-alias" }));
  await assert.rejects(() => call(IPC.SKILLS_SAVE, { source: "plugin", name: "plugin-alias", content: "bad" }));
});
await test("symlink/junction deletion removes only the link, never the shared target", async () => {
  const targetRoot = join(artifacts, "linked-source");
  const expected = skill(targetRoot, "real", "linked-alias", "SHARED CHECKOUT");
  const link = join(root, "linked-folder");
  symlinkSync(join(targetRoot, "real"), link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await call<Ok>(IPC.SKILLS_DELETE, { source: "global", name: "linked-alias" })).ok, true);
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(join(targetRoot, "real", "SKILL.md"), "utf8"), expected);
});
await test("hidden names and traversal stay rejected at IPC and shared-read boundaries", async () => {
  for (const name of [".system", "../outside", "/absolute", "a/b", "a\\b"]) {
    await assert.rejects(() => call(IPC.SKILLS_READ, { source: "global", name }));
    await assert.rejects(() => call(IPC.SKILLS_DELETE, { source: "global", name }));
    await assert.rejects(() => call(IPC.SKILLS_SAVE, { source: "global", name, content: "bad" }));
    await assert.rejects(() => readSkillForProject(undefined, "global", name));
  }
  assert.ok(existsSync(join(root, ".system", "skill-installer", "SKILL.md")));
});
await test("external source scans do not import containers and still discover conventional nested collections", async () => {
  const checkout = join(artifacts, "skill-collection");
  skill(join(checkout, "skills"), "nested-folder", "nested-skill");
  mkdirSync(join(checkout, "docs"));
  const codex = join(home, ".codex", "skills");
  skill(codex, ".system", ".system");
  mkdirSync(join(codex, "support-files"));
  const { sources } = await call<{ sources: Array<{ name: string; sourcePath: string }> }>(IPC.SKILLS_SCAN_SOURCES, { localDir: checkout });
  assert.ok(sources.some(s => s.name === "nested-skill"));
  for (const name of ["skills", "docs", ".system", "support-files"]) assert.ok(!sources.some(s => s.name === name), name);
});

const failed = results.filter(r => !r.ok).length;
writeFileSync(join(artifacts, "results.json"), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} skills-management checks passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
