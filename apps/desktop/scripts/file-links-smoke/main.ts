/** Exercise the actual renderer helpers; only IPC/store are replaced. */
import assert from "node:assert/strict";
import { dirname, resolveRelativePath } from "../../src/renderer/lib/path.js";
import { fileHrefToPath, isAbsolutePath, isLocalFileHref, resolveFilePathToken } from "../../src/renderer/lib/fileLink.js";
import { reset, state, calls } from "./stubs.js";
let passed = 0, failed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  reset();
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}
for (const [base, rel, want] of [
  ["D:/project/docs", "images/../a.png", "D:/project/docs/a.png"],
  ["D:/", "../a.png", "D:/a.png"],
  ["D:/docs", "../../../a.png", "D:/a.png"],
  ["/project", "D:/../../a.png", "D:/a.png"],
  ["D:/docs", "..", "D:/"],
  ["/", "../a.png", "/a.png"],
  ["/docs", "../../a.png", "/a.png"],
  ["//server/share/docs", "../a.png", "//server/share/a.png"],
  ["//server/share/docs", "../../../a.png", "//server/share/a.png"],
  [String.raw`\\server\share\docs`, String.raw`..\a.png`, "//server/share/a.png"],
  ["/project", "//server/share/a.png", "//server/share/a.png"],
  ["", "docs/a.png", "docs/a.png"],
  ["docs", "../../a.png", "../a.png"],
]) await test(`resolve ${base} + ${rel}`, () => assert.equal(resolveRelativePath(base, rel), want));
for (const [input, want] of [["/readme.md", "/"], ["D:/readme.md", "D:/"], [String.raw`D:\readme.md`, "D:\\"], ["docs/a.md", "docs"], ["a.md", ""]]) {
  await test(`dirname ${input}`, () => assert.equal(dirname(input), want));
}
for (const [href, want] of [
  ["file:///D:/docs/a.md", "D:/docs/a.md"],
  ["file://localhost/D:/docs/a.md", "D:/docs/a.md"],
  ["file://LOCALHOST/etc/a.md", "/etc/a.md"],
  ["file://server/share/a.md", "//server/share/a.md"],
  ["file://localhost-backup/share/a.md", "//localhost-backup/share/a.md"],
  ["file:///project/a.md#intro", "/project/a.md"],
  ["docs/a.md?download=1#intro", "docs/a.md"],
  ["file:///project/a%23b%3Fc.md#intro", "/project/a#b?c.md"],
  ["docs/%E5%B0%8F.md", "docs/小.md"],
  ["docs/100%off.md", "docs/100%off.md"],
  ["docs/%2523.md", "docs/%23.md"],
]) await test(`href ${href}`, () => assert.equal(fileHrefToPath(href), want));
await test("UNC is absolute", () => assert.equal(isAbsolutePath(String.raw`\\server\share\a.md`), true));
await test("external URLs and anchors stay external", () => {
  for (const value of ["https://example.com/a.md", "mailto:a@example.com", "#intro", ""]) assert.equal(isLocalFileHref(value), false);
});
await test("drive paths and relative hrefs stay local", () => {
  for (const value of ["D:/a.md", "./a.md", "file://server/share/a.md"]) assert.equal(isLocalFileHref(value), true);
});
await test("Windows absolute link ignores drive/directory case", async () => {
  reset(["D:/Project"]);
  assert.equal((await resolveFilePathToken("d:/project/a.md", "D:/Project"))[0]?.relativePath, "a.md");
  assert.equal(calls.length, 0);
});
await test("UNC link resolves directly without search", async () => {
  reset(["//server/share/project"]);
  const result = await resolveFilePathToken(String.raw`\\SERVER\share\project\a.md`, "//server/share/project");
  assert.equal(result.length, 1); assert.equal(result[0].relativePath, "a.md"); assert.equal(calls.length, 0);
});
await test("absolute dot traversal outside project is rejected", async () => {
  assert.deepEqual(await resolveFilePathToken("/project/../private/a.md", "/project"), []);
});
await test("sibling prefix and POSIX case are rejected", async () => {
  for (const p of ["/project-other/a.md", "/PROJECT/a.md"]) assert.deepEqual(await resolveFilePathToken(p, "/project"), []);
});
await test("POSIX root project allows files", async () => {
  reset(["/"]); assert.equal((await resolveFilePathToken("/a.md", "/"))[0]?.relativePath, "a.md");
});
await test("worktree roots remain eligible", async () => {
  state.pinnedSessions = [{ worktreePath: "/worktree" }];
  assert.equal((await resolveFilePathToken("/worktree/a.md", "/project")).length, 1);
});
const file = (relativePath: string, root = "/project") => ({ name: relativePath.split("/").at(-1)!, path: `${root}/${relativePath}`, relativePath });
await test("ambiguous same-name files return choices, not first hit", async () => {
  reset(["/project"], [file("src/a.ts"), file("tests/a.ts")]);
  assert.deepEqual((await resolveFilePathToken("a.ts", "/project")).map(f => f.relativePath).sort(), ["src/a.ts", "tests/a.ts"]);
  assert.equal(calls.length, 1);
});
await test("suffix must start at a path segment boundary", async () => {
  reset(["/project"], [file("src/not-a.ts"), file("tests/a.ts")]);
  assert.deepEqual((await resolveFilePathToken("a.ts", "/project")).map(f => f.relativePath), ["tests/a.ts"]);
});
await test("partial directory ambiguity preserves all exact suffixes", async () => {
  reset(["/project"], [file("one/src/a.ts"), file("two/src/a.ts"), file("notsrc/a.ts")]);
  assert.deepEqual((await resolveFilePathToken("src/a.ts", "/project")).map(f => f.relativePath).sort(), ["one/src/a.ts", "two/src/a.ts"]);
});
await test("explicit project-relative file wins over suffix matches", async () => {
  reset(["/project"], [file("one/src/a.ts"), file("src/a.ts")]);
  assert.deepEqual((await resolveFilePathToken("src/a.ts", "/project")).map(f => f.relativePath), ["src/a.ts"]);
});
await test("backslash search results can match partial path", async () => {
  const f = file("long/src/a.ts", "D:/Project"); f.path = f.path.replaceAll("/", "\\"); f.relativePath = f.relativePath.replaceAll("/", "\\");
  reset(["D:/Project"], [f]); assert.equal((await resolveFilePathToken("src/a.ts", "D:/Project")).length, 1);
});
await test("candidate count is bounded and paths are deduplicated", async () => {
  reset(["/project"], [file("00/a.ts"), ...Array.from({ length: 20 }, (_, i) => file(`${String(i).padStart(2, "0")}/a.ts`))]);
  const result = await resolveFilePathToken("a.ts", "/project");
  assert.equal(result.length, 12); assert.equal(new Set(result.map(f => f.path)).size, 12);
});
console.log(`File links smoke: ${passed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
