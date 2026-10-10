/**
 * 剪贴板通路(`main/ipc/files.ts` 的 `clipboard:saveFile` / `clipboard:writeImage`)的
 * 「错误是给人看的中文」回归。
 *
 * ## 为什么单开一套
 *
 * 这两条 handler 的失败回执是 `{ ok:false, error }`,而两处渲染端都把它**原样**摆给用户:
 *  - `ChatPane` 粘贴外部文件:`chat.toast.attachFailedBody: "{reason}"` → 一条中文
 *    toast,里面却是 `reason` 原文;
 *  - `image-preview` 复制图片:错误态也只回 `ok:false`。
 *
 * 于是 `mkdir` 撞到同名文件时,用户看到的是
 *   `EEXIST: file already exists, mkdir 'C:\Users\…\AppData\Local\Temp\mcode-pastes'`。
 * 判据立在**那行 error 文本**上:是中文、且没有 OS 原文/绝对路径的形状。
 *
 * ## 失败是**真造出来的**
 *
 * `clipboard:saveFile` 会 `mkdir(pasteTempDir(), {recursive:true})`,而
 * `pasteTempDir()` = `join(app.getPath("temp"), "mcode-pastes")`。本套件把
 * `app.getPath("temp")` 指向一个受控临时目录,并在其中摆一个**同名普通文件**
 * `mcode-pastes`,于是 `mkdir` 真的抛 `EEXIST`。`writeImage` 那条则让替身的
 * `clipboard.write` 抛一个带 `code` 的 errno 错误。
 *
 * Run: scripts/ipc-clipboard-smoke/run.sh
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { registerFileHandlers } from "@main/ipc/files.js";
import { clipboardControl } from "./stubs/electron.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const TEMP = process.env.MCODE_SMOKE_TEMP_DIR;
if (!TEMP) throw new Error("run via run.sh (MCODE_SMOKE_TEMP_DIR unset)");

// 造现场:`<temp>/mcode-pastes` 是一个**普通文件**(不是目录),于是 handler 里的
// `mkdir(pasteTempDir(), {recursive:true})` 真的抛 `EEXIST`。
const pasteDir = join(TEMP, "mcode-pastes");
writeFileSync(pasteDir, "this file blocks the paste dir\n");

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void { handlers.set(channel, listener); },
} as unknown as IpcMain;
registerFileHandlers(fakeIpc);

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return Promise.resolve(fn(null, ...args));
}

/** 「给人看的中文」这条判据的全套:是中文、且没有 OS 原文的形状,也没有绝对路径。 */
const OS_SHAPE = /EEXIST|ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|ENOSPC|EROFS|no such file|illegal operation|already exists|permission denied|mkdir |open '|[A-Za-z]:\\|\/Users\/|\/home\//;

/* ── 1. clipboard:saveFile —— 磁盘侧失败时 error 是中文 ── */
console.log("\nclipboard:saveFile:落盘失败时交回的是人话");
{
  const res = (await call(IPC.CLIPBOARD_SAVE_FILE, {
    name: "note.txt",
    bytes: Buffer.from("hello").toString("base64"),
  })) as { ok?: boolean; error?: string };
  check("★ 真的失败了(ok:false)", res.ok === false, res);
  const err = res.error ?? "";
  check("★ 给用户的 error 是中文", /[\u4e00-\u9fff]/.test(err), err);
  check("★ error 里没有 OS 原文/绝对路径的形状", !OS_SHAPE.test(err), err);
}

/* ── 2. clipboard:writeImage —— 剪贴板写入失败时 error 是中文 ── */
console.log("\nclipboard:writeImage:写剪贴板失败时交回的是人话");
{
  const e = new Error("EACCES: permission denied, write") as NodeJS.ErrnoException;
  e.code = "EACCES";
  clipboardControl.writeError = e;
  const res = (await call(IPC.CLIPBOARD_WRITE_IMAGE, {
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  })) as { ok?: boolean; error?: string };
  check("★ 真的失败了(ok:false)", res.ok === false, res);
  const err = res.error ?? "";
  check("★ 给用户的 error 是中文", /[\u4e00-\u9fff]/.test(err), err);
  check("★ error 里没有 OS 原文的形状(不是 'EACCES: permission denied…')", !OS_SHAPE.test(err), err);
  clipboardControl.writeError = null;
}

console.log(`\nipc-clipboard-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
