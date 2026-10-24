/**
 * O11 Slides Save As: exercise the *registered production handler* rather than
 * testing a standalone copy of its save logic. All files live in an OS temp dir.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { stagedAtomicWrite } from "../../../../genoffice/packages/electron-utils/src/document-save-guard";

const vendorSource = readFileSync(resolve(process.cwd(), "../../genoffice/apps/slides/src/main/slides-main.ts"), "utf8");
const start = vendorSource.indexOf("ipcMain.handle('slides:save-as'");
const end = vendorSource.indexOf("// ── Export (PDF / images)", start);
assert.ok(start !== -1 && end > start, "must find exact production slides:save-as handler");
const handler = vendorSource.slice(start, end).trim().replace("defaultName: string", "defaultName");
const saveStart = vendorSource.indexOf("ipcMain.handle('slides:save',");
assert.ok(saveStart !== -1 && saveStart < start, "must find real vendor slides:save");
const saveSection = vendorSource.slice(saveStart, start);
const catchStart = saveSection.lastIndexOf("} catch (err) {");
const catchEnd = saveSection.lastIndexOf("\n    }\n  })");
assert.ok(catchStart !== -1 && catchEnd > catchStart, "must find actual slides:save catch");
const realErrorHandler = new Function(
  "raised",
  "try { throw raised } catch (err) {" +
    saveSection.slice(catchStart + "} catch (err) {".length, catchEnd) +
  "}",
) as (raised: unknown) => { ok: false; error: string };

async function inTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mcode-o11-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function harness(target: string, content: Buffer, failAfterPartial = false, replaceDenied = false) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  const session = { path: join(dirname(target), "original.pptx"), opened: {}, fitWidthPx: 1024, metaRev: 1, metaDirty: true };
  const sessions = new Map([[71, session]]);
  let commits = 0;
  const deps = {
    ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => Promise<any>) => handlers.set(ch, fn) },
    sessions,
    dialogParent: () => null,
    saveAsSuggestion: () => target,
    showSaveDialogWithMemory: async () => ({ canceled: false, filePath: target }),
    dialog: {}, getDraftsDir: () => dirname(target),
    stagedAtomicWrite: (options: Parameters<typeof stagedAtomicWrite>[0]) =>
      stagedAtomicWrite(replaceDenied ? {
        ...options,
        replace: async () => { throw new Error("EPERM target locked"); },
      } : options),
    dirname, join, basename, randomUUID,
    savePptxToFile: async (_opened: unknown, path: string) => {
      if (failAfterPartial) {
        await writeFile(path, content.subarray(0, Math.max(1, content.length >> 1)));
        throw new Error("injected PPTX stream failure");
      }
      await writeFile(path, content);
    },
    autosaveBackoff: new Map(),
    dropUntitledRecovery: () => {},
    pushRecent: async () => {},
    syncAttachedPaths: () => {},
    commitSaved: () => { commits++; },
    buildAllRenderSlides: () => [],
  };
  // Test-only evaluation of the real handler slice. No imitation save handler.
  new Function("ctx", "with (ctx) { " + handler + " }")(deps);
  const call = () => handlers.get("slides:save-as")!({ sender: { id: 71 } }, "copy.pptx");
  return { call, session, commits: () => commits };
}

test("O11: failed Save As to a new filename leaves no half-written PPTX", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "copy.pptx");
    const api = harness(target, Buffer.from("COMPLETE-PPTX-PAYLOAD"), true);
    const r = await api.call();
    assert.equal(r.ok, false);
    await assert.rejects(() => stat(target), { code: "ENOENT" });
    assert.equal(api.session.path, join(dir, "original.pptx"));
    assert.equal(api.commits(), 0);
  });
});

test("O11: failed Save As to an existing filename preserves the old bytes", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "copy.pptx");
    const previous = Buffer.from("PREVIOUS-USER-CONTENT");
    await writeFile(target, previous);
    const api = harness(target, Buffer.from("NEW-USER-CONTENT"), true);
    const r = await api.call();
    assert.equal(r.ok, false);
    assert.deepEqual(await readFile(target), previous);
    assert.equal(api.commits(), 0);
  });
});

test("O11: successful Save As commits exact bytes and moves the session's Ctrl+S target", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "copy.pptx");
    const full = Buffer.from("COMPLETE-PPTX-PAYLOAD-UNCHANGED");
    const api = harness(target, full);
    const r = await api.call();
    assert.equal(r.ok, true);
    assert.deepEqual(await readFile(target), full);
    assert.equal(api.session.path, target);
    assert.equal(api.commits(), 1);
  });
});

test("O11: production Save As handler keeps existing bytes if its atomic replace fails", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "copy.pptx");
    await writeFile(target, "ORIGINAL-POWERPOINT");
    const api = harness(target, Buffer.from("COMPLETE-NEW-POWERPOINT"), false, true);
    const r = await api.call();
    assert.equal(r.ok, false);
    assert.equal((await readFile(target)).toString(), "ORIGINAL-POWERPOINT");
    assert.equal(api.session.path, join(dir, "original.pptx"));
    assert.equal(api.commits(), 0);
    const stagingName = (await readdir(dir)).find((x) => x.endsWith(".mcode-saving"));
    assert.ok(stagingName, "complete staging must survive failed replacement");
    assert.deepEqual(await readFile(join(dir, stagingName)), Buffer.from("COMPLETE-NEW-POWERPOINT"));
  });
});

test("O11: conflict errors omit internal class names without changing other vendor errors", () => {
  const conflict = new Error("文档已被别处改动");
  conflict.name = "DocumentSaveConflictError";
  assert.deepEqual(realErrorHandler(conflict), { ok: false, error: "文档已被别处改动" });
  const ordinary = new Error("permission denied");
  assert.deepEqual(realErrorHandler(ordinary), { ok: false, error: "Error: permission denied" });
  assert.deepEqual(realErrorHandler("opaque failure"), { ok: false, error: "opaque failure" });
});

test("O11: strict Save As never falls back to truncating the target if rename is denied", async () => {
  await inTempDir(async (dir) => {
    const target = join(dir, "existing.pptx");
    const staging = join(dir, ".existing.stage");
    await writeFile(target, "ORIGINAL");
    await assert.rejects(() => stagedAtomicWrite({
      target, staging,
      fallbackToInPlaceWrite: false,
      writeTo: async (path) => writeFile(path, "NEW-COMPLETE"),
      replace: async () => { throw new Error("EPERM target locked"); },
    }), /EPERM target locked/);
    assert.equal((await readFile(target)).toString(), "ORIGINAL");
    assert.equal((await readFile(staging)).toString(), "NEW-COMPLETE");
  });
});
