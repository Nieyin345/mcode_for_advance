import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { join } from "node:path";
import {
  setOnlyOfficeConfig, openOnlyOfficeSession, closeSession,
  getOnlyOfficeSessionState, forceSave, shutdownOnlyOfficeBridge,
} from "@main/onlyoffice/OnlyOfficeBridge.js";
import { state } from "./stubs/ports.js";
import { servers } from "./stubs/http.js";

const root = process.env.MCODE_ONLYOFFICE_SMOKE_ROOT;
assert.ok(root, "Only private test files may be opened");
await mkdir(root, { recursive: true });
let checks = 0, failures = 0;
function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} Office: ${label}`);
}
let bytes = "saved by fake Document Server";
let downloadFails = false;
let forceMode: "save" | "unchanged" | "silent" | "mismatched" = "save";
const callbacks = new Map<string, string>();
const pending: Promise<unknown>[] = [];
let base = "";
async function callback(url: string, key: string, status: number, userdata?: string) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, status, userdata, url: `${base}/download` }) });
  return { status: response.status, body: await response.json().catch(() => null) as { error?: number } | null };
}
const ds = createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(downloadFails ? 503 : 200);
    res.end(downloadFails ? "injected download failure" : bytes);
    return;
  }
  if (req.url === "/coauthoring/CommandService.ashx") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { key: string; userdata?: string };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: forceMode === "unchanged" ? 4 : 0 }));
      if (forceMode === "save" || forceMode === "mismatched") {
        const url = callbacks.get(body.key);
        const id = forceMode === "mismatched" ? "a-different-save" : body.userdata;
        if (url) pending.push(new Promise<void>(done => setTimeout(done, 40)).then(() => callback(url, body.key, 6, id)));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>(done => ds.listen(0, "127.0.0.1", done));
base = `http://127.0.0.1:${(ds.address() as AddressInfo).port}`;
setOnlyOfficeConfig({ serverUrl: base, jwtSecret: "", callbackHost: "127.0.0.1" });
async function open(name: string) {
  const path = join(root!, name);
  await writeFile(path, "original test document");
  const opened = await openOnlyOfficeSession(path, { lang: "en", dark: false, userName: "Isolated smoke" });
  assert.ok(opened.ok && opened.config && opened.sessionKey);
  const document = opened.config.document as Record<string, unknown>;
  const editor = opened.config.editorConfig as Record<string, unknown>;
  assert.equal(typeof document.url, "string"); assert.equal(typeof editor.callbackUrl, "string");
  const fileUrl = document.url as string, callbackUrl = editor.callbackUrl as string;
  callbacks.set(opened.sessionKey, callbackUrl);
  // Simulates the server actually opening the document; no user Office files.
  assert.equal((await fetch(fileUrl)).status, 200);
  return { path, key: opened.sessionKey, fileUrl, callbackUrl };
}
try {
  const viewPath = join(root!, "mobile-view.docx");
  await writeFile(viewPath, "read-only quote test document");
  const view = await openOnlyOfficeSession(viewPath, {
    lang: "en", dark: false, userName: "Phone", mode: "view", deviceType: "mobile",
  });
  assert.ok(view.ok && view.config && view.sessionKey);
  const viewDocument = view.config.document as Record<string, unknown>;
  const viewEditor = view.config.editorConfig as Record<string, unknown>;
  assert.equal(viewDocument.permissions && (viewDocument.permissions as Record<string, unknown>).edit, false);
  assert.equal(viewEditor.mode, "view");
  assert.equal(viewEditor.callbackUrl, undefined);
  assert.equal(view.config.type, "mobile");
  check("mobile Office opens are view-only and omit the save callback", viewDocument.permissions !== undefined && viewEditor.callbackUrl === undefined);
  check("Office document opens without the Mcode quote plugin", typeof viewDocument.url === "string" && (await fetch(viewDocument.url as string)).status === 200 && !("plugins" in viewEditor));
  closeSession(view.sessionKey);

  const concurrent = await Promise.all([open("concurrent-a.docx"), open("concurrent-b.docx")]);
  check("concurrent first opens share one callback server", new URL(concurrent[0].fileUrl).origin === new URL(concurrent[1].fileUrl).origin);
  for (const doc of concurrent) { closeSession(doc.key); await callback(doc.callbackUrl, doc.key, 4); }
  const doc = await open("failure.docx");
  downloadFails = true;
  const failed = await callback(doc.callbackUrl, doc.key, 6);
  check("failed download is not acknowledged as a successful save", failed.body?.error !== 0);
  check("failed download retains the old file", await readFile(doc.path, "utf8") === "original test document");
  check("failure is visible in session state", Boolean(getOnlyOfficeSessionState(doc.key).lastError));
  downloadFails = false; state.failRename = true;
  const renameFailed = await callback(doc.callbackUrl, doc.key, 6);
  check("failed atomic replacement is not acknowledged as success", renameFailed.body?.error !== 0);
  check("failed replacement retains old file and removes owned staging files",
    await readFile(doc.path, "utf8") === "original test document" && (await readdir(root)).every(name => !name.endsWith(".tmp")));
  state.failRename = false;
  const retried = await callback(doc.callbackUrl, doc.key, 6);
  check("a real retry succeeds after the fault clears", retried.body?.error === 0 && await readFile(doc.path, "utf8") === bytes);
  check("successful retry clears the error", getOnlyOfficeSessionState(doc.key).lastError === null);

  bytes = "force save must reach local disk";
  const forced = await forceSave(doc.key);
  check("force-save success waits for the actual write-back", forced.ok && await readFile(doc.path, "utf8") === bytes);
  await Promise.all(pending.splice(0));
  forceMode = "unchanged";
  check("no-change force save is a successful no-op", (await forceSave(doc.key)).ok);
  forceMode = "silent";
  const silent = await forceSave(doc.key, 100);
  check("accepted command without a write-back does not become false success", !silent.ok);
  forceMode = "mismatched";
  check("a different callback cannot acknowledge this force-save request", !(await forceSave(doc.key, 120)).ok);
  forceMode = "save";
  const afterSave = await openOnlyOfficeSession(doc.path, { lang: "en", dark: false, userName: "After save" });
  check("an active document keeps its shared key after write-back changes mtime", afterSave.sessionKey === doc.key);
  if (afterSave.sessionKey) closeSession(afterSave.sessionKey);
  closeSession(doc.key); await callback(doc.callbackUrl, doc.key, 4);

  const late = await open("late-close.docx");
  closeSession(late.key);
  bytes = "final save after pane was destroyed";
  downloadFails = true;
  const failedFinal = await callback(late.callbackUrl, late.key, 2);
  check("a failed final save retains the closed session for retry", failedFinal.body?.error !== 0 && getOnlyOfficeSessionState(late.key).alive);
  downloadFails = false;
  const final = await callback(late.callbackUrl, late.key, 2);
  check("close retains the capability for the final delayed callback", final.status === 200 && final.body?.error === 0);
  check("delayed final save really updates the local file", await readFile(late.path, "utf8") === bytes);
  check("completed final save retires the closed session", !getOnlyOfficeSessionState(late.key).alive);
  check("retired session cannot serve its file", (await fetch(late.fileUrl)).status === 404);

  // AI (or anything else) rewrites the file while the editor is open.
  const raced = await open("ai-edited.docx");
  check("an untouched open file reports no external change", getOnlyOfficeSessionState(raced.key).externalChange === false);
  await new Promise<void>(done => setTimeout(done, 20));
  await writeFile(raced.path, "AI rewrote the whole document");
  check("an external rewrite is visible in session state", getOnlyOfficeSessionState(raced.key).externalChange === true);
  const reopened = await openOnlyOfficeSession(raced.path, { lang: "en", dark: false, userName: "Reload" });
  check("reopening after an external rewrite gets a fresh session (new content, new key)",
    reopened.ok === true && reopened.sessionKey !== raced.key && reopened.externallyChanged === true);
  bytes = "stale editor content plus user edits";
  const stale = await callback(raced.callbackUrl, raced.key, 6);
  check("a stale editor's save is acknowledged", stale.body?.error === 0);
  check("a stale editor's save never overwrites the external rewrite",
    await readFile(raced.path, "utf8") === "AI rewrote the whole document");
  const copyPath = getOnlyOfficeSessionState(raced.key).conflictCopyPath;
  check("the stale save is kept in a conflict copy next to the file",
    typeof copyPath === "string" && copyPath !== raced.path && await readFile(copyPath, "utf8") === bytes);
  check("no staging files are left behind", (await readdir(root)).every(name => !name.endsWith(".tmp")));
  if (reopened.sessionKey) closeSession(reopened.sessionKey);
  closeSession(raced.key); await callback(raced.callbackUrl, raced.key, 4);

  const shared = await open("shared.docx");
  const again = await openOnlyOfficeSession(shared.path, { lang: "en", dark: false, userName: "Second pane" });
  check("two panes reuse the same document session", again.sessionKey === shared.key);
  closeSession(shared.key);
  check("closing one pane does not revoke another pane's session", getOnlyOfficeSessionState(shared.key).alive);
  closeSession(shared.key);
  const unchanged = await callback(shared.callbackUrl, shared.key, 4);
  check("no-change final callback retires the last closed pane", unchanged.body?.error === 0 && !getOnlyOfficeSessionState(shared.key).alive);
} finally {
  state.failRename = false;
  await Promise.allSettled(pending);
  shutdownOnlyOfficeBridge();
  // Every server here is owned by this test; closes even if old code leaked one.
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
console.log(`onlyoffice-smoke: ${checks - failures}/${checks} passed`);
process.exitCode = failures ? 1 : 0;
