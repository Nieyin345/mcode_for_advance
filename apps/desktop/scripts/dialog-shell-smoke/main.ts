/**
 * Headless smoke for **`main/ipc/dialog.ts`** + **`main/ipc/shell.ts`** —— 原生对话框
 * 与「用系统程序打开路径」这两条最贴近用户手指的通道。
 *
 * ## 为什么押在这两个文件上
 *
 * 它们的错法**用户一定会信**,而且**基本不会有任何报错**:
 *
 *   - 取消选择返回 `undefined` / 半截对象 → 渲染端读 `.paths` / `.path` 直接炸;
 *   - 白名单外的文件被**读进内存** → 一个 16MB 的 `.psd` 悄悄跨 IPC,界面卡一下了事;
 *   - `shell.showItemInFolder` 拒了一个**合法**路径 → 用户点「在文件管理器里显示」
 *     **没反应**,不弹窗、不报错,他会以为软件卡了;
 *   - 围栏少了分隔符边界 → 项目根 `D:\proj\foo` 会把 `D:\proj\foobar\x.txt` **静默放行**。
 *
 * ## 覆盖到的两个真 bug(本套写完时就红了)
 *
 *   1. `dialog.ts` 的扩展名查表 `PICK_IMAGE_MIME[ext]` —— `PICK_IMAGE_MIME` 是字面量
 *      对象,**原型链在查表范围内**:文件名叫 `照片.constructor` / `x.__proto__` 时
 *      `ext` 命中 `Object.prototype` 上的成员,查出来的 `mimeType` **不是字符串**,
 *      于是"不在白名单里"这个判断为假 → 它被当合格图片读进内存,渲染端收到一个
 *      mimeType 是 `"object"` 的图,`data:${mimeType};base64,...` 拼出来是个打不开的
 *      `<img>`。**与大小写无关**(源码已经小写化了),就是白名单查表的口径问题。
 *   2. `shell.ts` 自己抄了一份 `pathWithin`,**没有大小写归一** —— 项目根存
 *      `D:\Proj\Foo`、渲染端给 `d:\proj\foo\a.txt` 时合法路径被拒。见 §3。
 *
 * ## 两套怎么"看见"自己该看见的
 *
 * 不起 Electron,也不碰真用户数据:
 *
 *   - `electron` → `stubs/electron.ts`,**记录型**:dialog 的返回值由脚本喂,
 *     `shell.openPath` / `showItemInFolder` 的调用逐条记下来。
 *   - `node:fs/promises` → `stubs/fsPromises.ts`,**真身转发 + 记账**。"不合格的文件
 *     没被读进内存"这件事只有靠 readFile 的调用记录才分得出来 —— 读文件**不改 mtime**,
 *     而返回值上"先判后读"和"先读后判"长得一模一样。
 *   - `@main/store/repositories.js` 用**真的**(`ProjectRepo.list()` 要真读得到项目根),
 *     数据根是 `mktemp -d`,跑完删。
 *
 * Run: scripts/dialog-shell-smoke/run.sh
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IpcMain } from "electron";

import { IPC, UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { registerDialogHandlers } from "@main/ipc/dialog.js";
import { registerShellHandlers } from "@main/ipc/shell.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { findContainingWorkspaceRoot, isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";

import {
  dialogCalls,
  openPathReturn,
  pushDialogResult,
  resetDialog,
  resetShell,
  shellCalls,
} from "./stubs/electron.js";
import { readFileCalls, resetFsCalls } from "./stubs/fsPromises.js";

/* ──────────────── 脚手架 ──────────────── */

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 比数组 —— **不能**用 `eq`(它是 `Object.is`,数组是引用比,内容相同也永远红)。 */
// ⚠️ `actual` 允许 undefined:好些断言断的是 `res?.skipped` 这种**可选链**读出来的
// 字段,那个 `?.` 是判据的一部分(整个 RPC 没返回东西时,这里就该红,而不是 TypeScript
// 先抱怨类型对不上)。`JSON.stringify(undefined)` 是 `undefined`,跟 `'["ghost.png"]'`
// 比必然不等 —— 该红的照样红,detail 里也看得见 actual 是空的。
function eqArr(
  name: string,
  actual: readonly unknown[] | undefined,
  expected: readonly unknown[],
): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ──────────────── 磁盘夹具 ──────────────── */

/** 夹具根。**不能拿 git-bash 的 `/tmp` 当路径** —— 那是 `C:\tmp`,而 node 看到的
 *  `os.tmpdir()` 是 `%TEMP%`,两个不是一回事(实测过)。这里统一用 node 的。 */
const TMP = join(tmpdir(), `mcode-dialog-shell-smoke-${process.pid}-${Date.now()}`);
const IMGS = join(TMP, "imgs");
const ROOT_A = join(TMP, "projA");
const ROOT_B = join(TMP, "projB");
const ROOT_ARCHIVED = join(TMP, "projArchived");

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** 写一个内容全是 `x` 的假文件(不关心是不是真图片,只关心"读完有多少字节")。 */
function writeFake(p: string, bytes = 64): string {
  ensureDir(dirname(p));
  writeFileSync(p, Buffer.alloc(bytes, 0x78));
  return p;
}

const P = {
  png: writeFake(join(IMGS, "photo.png")),
  jpg: writeFake(join(IMGS, "scan.jpg")),
  // 大写扩展名:Windows 的资源管理器默认把扩展名显示成大写,用户选中的很可能就是它。
  upperPng: writeFake(join(IMGS, "IMG_0001.PNG")),
  // **目录名里带点**。`basename` 会先切目录,所以这条其实不该影响扩展名判断 ——
  // 放这儿是"钉住现状",不是"守着一个修复"。
  dottedDir: writeFake(join(TMP, "my.folder", "photo.png")),
  // 完全不带扩展名。
  noExt: writeFake(join(IMGS, "noext")),
  // 白名单外:`.txt` / `.psd` 都在这里。
  txt: writeFake(join(IMGS, "notes.txt")),
  psd: writeFake(join(IMGS, "poster.psd")),
  // ⚠️ 扩展名是 **Object 原型上的成员名** —— 查表时会被原型链吃掉,见 §1 那条真 bug。
  protoKey: writeFake(join(IMGS, "照片.constructor")),
  // 超限:15MB 上限,**真的写盘** 16MB(别 mock stat —— 那就变成验 mock 了)。
  huge: writeFake(join(IMGS, "huge.png"), 16 * 1024 * 1024),
  // 存在但是个目录:stat 过了、`isFile` 不是。
  dir: (() => {
    const d = join(IMGS, "adir.png");
    ensureDir(d);
    return d;
  })(),
  // 根本不存在:readFile/stat 抛错那条路。
  missing: join(IMGS, "ghost.png"),
};

/* ──────────────── handler 记名替身 ──────────────── */

const handlers = new Map<string, (evt: unknown, ...rest: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (evt: unknown, ...rest: unknown[]) => unknown) {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

process.env.MCODE_SMOKE_DATA_ROOT = join(TMP, "data");
await initDb();
registerDialogHandlers(fakeIpc);
registerShellHandlers(fakeIpc);

async function call<T = unknown>(channel: string, raw?: unknown): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`handler 没注册: ${channel}`);
  return (await h(null, raw)) as T;
}

/** 调一次并拿回错误消息(`""` = 没抛)。"被拒了"和"没炸"是两件事,都要能断言。 */
async function catching(channel: string, raw?: unknown): Promise<string> {
  try {
    await call(channel, raw);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

/** 调一次并拿回 `[错误消息, 结果]`。`""` + 结果 = 没抛;有消息 + `undefined` = 抛了。
 *  比 `catching` 多一样东西:抛的时候结果拿不到,没抛的时候结果拿得到 —— 两条都能断言。 */
async function settled<T>(fn: () => Promise<T>): Promise<[string, T | undefined]> {
  try {
    return ["", await fn()];
  } catch (err) {
    return [(err as Error).message, undefined];
  }
}

type PickImagesResult = { images: Array<{ name: string; mimeType?: string }>; skipped: string[] };

/**
 * 「喂一个返回值 + 调一次 `file:pickImages`」——**绑成一次**。
 *
 * ⚠️ 这两个动作散着写就是这个套件踩过的坑:一个 `pushDialogResult` 对两次 `call`,
 * 第二轮开始对话框桩就没值可喂了,而它是**故意抛**的 —— 于是套件当场崩在收尾之前,
 * 那行 `N/M 通过` 根本不打,看起来像"没输出"而不是"崩了"。
 */
async function pickImages(...filePaths: string[]): Promise<PickImagesResult> {
  resetDialog();
  resetFsCalls();
  pushDialogResult({ canceled: false, filePaths });
  return await call<PickImagesResult>(IPC.FILE_PICK_IMAGES, {});
}

/**
 * 同 `pickImages`,但**不炸脚本**:拿回 `[错误消息, 结果]`。
 *
 * ⚠️ 夹具里夹着坏文件时必须用它。handler 那边一旦漏掉 catch(或变异把 catch 撤掉),
 * 裸 `pickImages` 会让 **Node 未捕获异常把套件带走** —— 汇总那行不打、退出码也不对,
 * 看起来像"没输出"而不是"崩了"(变异验证时就是这么栽的)。有了它,那几条
 * "坏文件不会让整个 RPC 抛" 才会**红得有名有姓**。
 */
async function pickImagesSettled(
  ...filePaths: string[]
): Promise<[string, PickImagesResult | undefined]> {
  return await settled(() => pickImages(...filePaths));
}

/**
 * 「喂一个返回值 + 调一次」的包装,`pickFiles` / `pickFolder` 各一份。
 *
 * ⚠️ 为什么要把这两步绑成一次:散着写(base `pushDialogResult` + 裸 `call`)的话,
 * 一个 push 对两次 call、或者顺序反了,都会让对话框桩**没值可喂** —— 而那个桩是
 * **故意抛**的(见 stubs/electron.ts),于是套件当场崩在收尾之前:汇总那行不打、
 * 退出码也不对,看起来像"没输出"而不是"崩了"。变异验证时正是栽在这儿。
 */
async function pickFiles(
  result: { canceled: boolean; filePaths: string[] },
): Promise<{ paths: string[] }> {
  resetDialog();
  pushDialogResult(result);
  return await call<{ paths: string[] }>(IPC.DIALOG_PICK_FILES, {});
}

async function pickFolder(
  result: { canceled: boolean; filePaths: string[] },
): Promise<{ path: string | null }> {
  resetDialog();
  pushDialogResult(result);
  return await call<{ path: string | null }>("dialog:pickFolder");
}

/* ──────────────── 0. 脚手架自己 ──────────────── */

console.log("\n0. 脚手架自己(通道名对不对得上一件真事)");

{
  const needed = [
    IPC.DIALOG_PICK_FILES,
    "dialog:pickFolder",
    IPC.FILE_PICK_IMAGES,
    IPC.SHELL_OPEN_PATH,
    IPC.SHELL_SHOW_ITEM_IN_FOLDER,
    IPC.SHELL_OPEN_FILE,
  ];
  const missing = needed.filter((c) => !handlers.has(c));
  eq("要验的通道全都注册上了", missing.length, 0);
  if (missing.length > 0) console.log(`     缺: ${JSON.stringify(missing)}`);
  // 通道名写错一个字上面那条也会红 —— 但真正要防的是**这条字符串本身**写错,
  // 那种情况下套件会拿着一个不存在的 IPC 名字一路空跑到收尾。
  eq("通道名不是编的(拿一条已知的跟契约对)", IPC.SHELL_OPEN_PATH, "shell:openPath");
  // MAINT M36:`pickFolder` 已进 `IPC` 常量表(值不变),preload 走 `IPC.DIALOG_PICK_FOLDER`。
  // 钉住**值**:谁把常量改名/改值,主进程 `dialog.ts` 那条字面量注册就对不上,渲染端静默打不通。
  eq("pickFolder 已入 IPC 常量表且通道值不变(M36)", IPC.DIALOG_PICK_FOLDER, "dialog:pickFolder");
}

/* ──────────────── 1. dialog:pickFiles / dialog:pickFolder ──────────────── */

console.log("\n1. 文件 / 目录选择:取消、空、多选");

{
  // 取消:用户按了「取消」。必须落到**空结果**,不是 undefined 也不是半截对象。
  const res = await pickFiles({ canceled: true, filePaths: [] });
  check("取消时返回的是空数组,不是 undefined", Array.isArray(res?.paths), res);
  eq("取消时数组是空的", res?.paths?.length, 0);
  check("取消时**没有**返回半截对象(渲染端读 .paths 要有东西接)", res !== undefined && res.paths !== undefined, res);
}

{
  // 用户点了确定,但一个文件都没选 —— Electron 这时给的是 `canceled: false` +
  // `filePaths: []`。这条**必须**和上面落成同一个结果,否则渲染端两种"啥也没选"
  // 要走两条分支。
  const res = await pickFiles({ canceled: false, filePaths: [] });
  check(
    "选了 0 个文件时也是空数组(和取消同一个结果)",
    Array.isArray(res?.paths) && res.paths.length === 0,
    res,
  );
}

{
  // 正常多选:原样返回,顺序不能动(用户在原生框里点出来的顺序就是他看到的顺序)。
  const res = await pickFiles({ canceled: false, filePaths: [P.txt, P.psd] });
  eqArr("多选按原样、原顺序返回", res.paths, [P.txt, P.psd]);
}

{
  // title / filters 要真的传到 `showOpenDialog` 上 —— 渲染端 filter 是按扩展名挑的
  // (导入 PDF 那条路),传丢了用户会在一堆文件里找不到自己的 PDF。
  resetDialog();
  pushDialogResult({ canceled: true, filePaths: [] });
  await call(IPC.DIALOG_PICK_FILES, {
    title: "挑一个 PDF",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  const opts = dialogCalls[0] as { title?: string; filters?: unknown; properties?: unknown };
  eq("title 传到原生对话框上", opts?.title, "挑一个 PDF");
  eqArr("filters 传到原生对话框上", opts?.filters as unknown[], [{ name: "PDF", extensions: ["pdf"] }]);
  eqArr("允许多选", opts?.properties as unknown[], ["openFile", "multiSelections"]);

  // 不给 filters 时**不能**塞一个空的进去 —— 空的 filters 会让原生框里什么都不显示。
  resetDialog();
  pushDialogResult({ canceled: true, filePaths: [] });
  await call(IPC.DIALOG_PICK_FILES, {});
  check("没给 filters 时不硬塞一个空的", !("filters" in (dialogCalls[0] as object)), dialogCalls[0]);
}

{
  // ★ 系统对话框的**默认标题 / 文件类型名跟着界面语言走**。
  //
  // 这些字符串画在 OS 的原生模态上(不是渲染端画的),早先在三处各自写死中文 ——
  // 英文界面下点「导出工作流」弹出来的是「导出工作流」+「工作流 JSON」。判据立在
  // **真的传给 `showOpenDialog` 的那个 title** 上:把语言切成 en,它必须变英文。
  // (撤掉 `dialogText` 换回硬编码中文 → 这条红。)
  const saved = SettingRepo.get(UI_LOCALE_SETTING_KEY);
  try {
    resetDialog();
    pushDialogResult({ canceled: true, filePaths: [] });
    SettingRepo.set(UI_LOCALE_SETTING_KEY, "en");
    await call(IPC.FILE_PICK_IMAGES, {});
    const en = dialogCalls[0] as { title?: string; filters?: { name?: string }[] };
    check("★ 英文界面:选图对话框标题是英文", en?.title === "Choose images", en?.title);
    check("★ 英文界面:文件类型名也是英文", en?.filters?.[0]?.name === "Images", en?.filters);

    resetDialog();
    pushDialogResult({ canceled: true, filePaths: [] });
    SettingRepo.set(UI_LOCALE_SETTING_KEY, "zh");
    await call(IPC.FILE_PICK_IMAGES, {});
    const zh = dialogCalls[0] as { title?: string };
    check("★ 中文界面:同一条变回中文", zh?.title === "选择图片", zh?.title);

    // ★ **界面语言规则只有一份。** `SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh"`
    //   曾在 onlyoffice / titleGen / orchestration.library(两处) / mobileRpc 各内联一遍
    //   (那些副本还没有 DB 未就绪的兜底)。现在都走 `dialogText.uiLocale`。判据钉在源码上:
    //   那几个文件里不许再出现内联的三元。
    {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const root = process.cwd();
      const files = [
        "src/main/ipc/onlyoffice.ts",
        "src/main/ipc/titleGen.ts",
        "src/main/orchestration/library.ts",
        "src/main/mobile/mobileRpc.ts",
      ];
      const inline = files.filter((rel) =>
        /UI_LOCALE_SETTING_KEY\)\s*===\s*"en"\s*\?\s*"en"\s*:\s*"zh"/.test(readFileSync(join(root, rel), "utf8")),
      );
      check("★ 界面语言规则不再内联在多处(统一走 dialogText.uiLocale)", inline.length === 0, inline);
      // 防空过:确认真源还在(dialogText 里那条就是唯一真源)。
      check(
        "对照:dialogText.uiLocale 仍是唯一真源",
        /UI_LOCALE_SETTING_KEY\)\s*===\s*"en"\s*\?\s*"en"\s*:\s*"zh"/.test(readFileSync(join(root, "src/main/lib/dialogText.ts"), "utf8")),
      );
    }
  } finally {
    if (saved === null) SettingRepo.set(UI_LOCALE_SETTING_KEY, "");
    else SettingRepo.set(UI_LOCALE_SETTING_KEY, saved);
  }
}

{
  // pickFolder:裸字符串频道,返回 `{ path: null }` 而不是 `{}`。渲染端写的是
  // `const { path } = await api.pickFolder()` —— 返回 `{}` 的话 `path` 是 undefined,
  // 而各个调用点对 undefined 的处理不一样(有的当"没选",有的 `?? ""` 存进设置里)。
  const res = await pickFolder({ canceled: true, filePaths: [] });
  check("取消时 path 是 null(不是 undefined、不是缺字段)", res?.path === null, res);
  check("取消时对象本身在(渲染端直接解构 .path)", res !== undefined, res);

  const res2 = await pickFolder({ canceled: false, filePaths: [] });
  eq("选了 0 个目录时也是 null", res2?.path, null);

  const res3 = await pickFolder({ canceled: false, filePaths: [ROOT_A] });
  eq("选中目录时给的是那个目录", res3?.path, ROOT_A);
  eqArr(
    "只用 openDirectory 属性(不许把文件也放进来)",
    (dialogCalls[0] as { properties?: unknown }).properties as unknown[],
    ["openDirectory"],
  );
}

/* ──────────────── 2. file:pickImages:白名单 / 上限 / 坏文件 ──────────────── */

console.log("\n2. 图片选择:白名单、上限、坏文件");

{
  resetDialog();
  resetFsCalls();
  pushDialogResult({ canceled: true, filePaths: [] });
  const res = await call<PickImagesResult>(IPC.FILE_PICK_IMAGES, {});
  check(
    "取消时 images / skipped 都是数组,不是 undefined",
    Array.isArray(res?.images) && Array.isArray(res?.skipped),
    res,
  );
  eq("取消时一个文件都不读", readFileCalls().length, 0);
}

{
  // 白名单:**不在名单里的和超限的,一个字节都不许读进内存**。返回值上这两种写法
  // (先判后读 / 先读后判)长得一模一样,只有 readFile 的调用记录分得出来。
  // 夹具夹着三个坏文件,所以走 `pickImagesSettled`:漏了 catch 也不会把套件带走。
  const [err, res] = await pickImagesSettled(P.png, P.txt, P.psd, P.huge, P.noExt, P.dir, P.missing);
  eq("夹着坏文件时整个 RPC 不抛", err, "");
  const images = res?.images ?? [];
  const skipped = res?.skipped ?? [];

  eqArr("只有名单里的那个被读出来", images.map((i) => i.name), ["photo.png"]);
  const read = readFileCalls();
  eq("**读过的文件正好只有那一个**(不合格的一个字节都没读)", read.length, 1);
  eq("读的确实是那个合格文件", read[0], P.png);
  check("超大文件**没被读**(不是「读完了才发现太大」)", !read.includes(P.huge), read);
  check("白名单外的 .psd 没被读", !read.includes(P.psd), read);
  check("白名单外的 .txt 没被读", !read.includes(P.txt), read);
  check("没扩展名的没被读", !read.includes(P.noExt), read);

  // skipped 里要**恰好**是那六个坏的(按文件名,渲染端提示面板上就是这么列的)。
  eqArr(
    "skipped 里恰好是那六个坏的",
    [...skipped].sort(),
    ["adir.png", "ghost.png", "huge.png", "noext", "notes.txt", "poster.psd"],
  );
  check("坏文件不影响好文件(一个坏了不是全丢)", images.length === 1 && skipped.length === 6, {
    images: images.length,
    skipped: skipped.length,
  });
}

{
  // 大小写:`.PNG` 和 `.png` 必须是同一个东西。
  const res = await pickImages(P.upperPng);
  eqArr("大写扩展名照收", res.images.map((i) => i.name), ["IMG_0001.PNG"]);
  eq("大写扩展名拿到的 mime 是 png", res.images[0]?.mimeType, "image/png");
  eq("大写扩展名不进 skipped", res.skipped.length, 0);
}

{
  // ⚠️ **本套抓到的第一个真 bug**。
  //
  // `ext` 是从文件名剥出来的**任意字符串**,而 `PICK_IMAGE_MIME` 是字面量对象 ——
  // `PICK_IMAGE_MIME[ext]` 的查表范围包含 `Object.prototype`。文件名只要以原型成员的
  // 名字结尾(`照片.constructor`、`x.__proto__`、`a.valueOf` …),查出来的就不是
  // `undefined`,于是"不在白名单里"这个判断**为假**,它被当合格图片读进内存 ——
  // 而拿到的 `mimeType` 是个对象/函数,渲染端拼出来是
  // `data:[object Object];base64,...`,一个打不开的 `<img>`,没有任何提示。
  //
  // 与大小写无关(源码已经小写化了),是**白名单查表的口径**问题。
  const res = await pickImages(P.protoKey, P.png);
  eqArr("扩展名撞上 Object 原型成员的(「照片.constructor」)进 skipped", res.skipped, ["照片.constructor"]);
  eq("它没被当图片返回", res.images.length, 1);
  check(
    "**它一个字节都没被读**",
    !readFileCalls().includes(P.protoKey),
    readFileCalls(),
  );
  // 返回的 mimeType 必须是**真的字符串** —— 原型链吃进去的话会是个函数/对象。
  eq("每个返回的图 mimeType 都是 png 那种字符串", res.images[0]?.mimeType, "image/png");
}

{
  // ⚠️ **目录名里有点**(`…/my.folder/photo.png`)。`basename` 会先切掉目录,所以这条
  // 记录的是**现状**:扩展名只取自最后一段,目录名里的点不参与。
  // (曾经怀疑这里是坑 —— `basename` 在 Windows 上给的是 `photo.png`,是对的。)
  const res = await pickImages(P.dottedDir);
  eqArr("目录名里带点不影响扩展名判断", res.images.map((i) => i.name), ["photo.png"]);
  eq("而且它没进 skipped", res.skipped.length, 0);
}

{
  // 文件不存在 / 不是文件:进 skipped,而且**整个 RPC 不能炸**。一个坏文件毁掉整次
  // 多选,用户会以为是自己选错了。
  //
  // ⚠️ **每一问只喂一次、只调一次** —— `pickImages` 把"喂一个返回值 + 调一次"
  // 绑在一起。散着写的话,一个 `push` 对两次 `call` 就会从第二轮开始缺返回值,
  // 而那个桩是**故意抛**的(见 stubs/electron.ts),于是套件当场崩在收尾之前。
  eq("坏文件不会让整个 RPC 抛(夹着一个好文件)", (await settled(() => pickImages(P.missing, P.png)))[0], "");
  eq("只有那个坏文件时也不抛", (await settled(() => pickImages(P.missing)))[0], "");
  const [onlyBadErr, onlyBad] = await pickImagesSettled(P.missing);
  eq("只有那个坏文件时也不抛(再拿一次结果)", onlyBadErr, "");
  eqArr("不存在的文件进 skipped", onlyBad?.skipped, ["ghost.png"]);
  eq("它当然没有被读出来", onlyBad?.images.length ?? -1, 0);

  eq("是个目录(名字却像图片)时也不抛", (await settled(() => pickImages(P.dir)))[0], "");
  const [dirErr, dirRes] = await pickImagesSettled(P.dir);
  eq("只有一个坏目录时也不抛", dirErr, "");
  eqArr("目录进 skipped", dirRes?.skipped, ["adir.png"]);
  eq("目录没被 readFile 读", readFileCalls().length, 0);
}

{
  // ★ 无参方法:该 RPC 的 schema 是 `z.object({})`,而 `app_api_call` 对无参方法
  //   **明确让模型省略 input**(tools.ts 的 `input` 是 `.optional()`),那时 handler 收到
  //   的是 `undefined`。`PickImagesSchema.parse(undefined)` 抛 "Required" —— 渲染端走
  //   `{}` 掩盖了它,模型点「选图」时会拿到一句 zod 报错而不是图片。同 `context.get` 的 ?#115。
  //   (`pickImages` 助手固定喂 `{}`;这里直接调 channel 传 `undefined`。)
  resetDialog();
  pushDialogResult({ canceled: false, filePaths: [P.png] });
  const [omitErr, omitRes] = await settled(() =>
    call<PickImagesResult>(IPC.FILE_PICK_IMAGES, undefined),
  );
  eq("★ file:pickImages 接受省略的 input(undefined)", omitErr, "");
  eqArr("省略 input 时照常返回选中的图", omitRes?.images.map((i) => i.name), ["photo.png"]);
}

{
  // 超限是**按每个文件算**的,不是"有一个超了就全不读了":两个 16MB 里夹一个好文件。
  const res = await pickImages(P.huge, P.jpg, P.huge);
  eqArr("夹在超大文件中间的好文件照常返回", res.images.map((i) => i.name), ["scan.jpg"]);
  eq("两个超大的都进了 skipped", res.skipped.length, 2);
  eq("两个超大文件里只有那一个好文件被读", readFileCalls().length, 1);
  check("读的那一次是好文件", readFileCalls()[0] === P.jpg, readFileCalls());
}

{
  // 15MB 是**上限**,不是"超过 15MB 才拒" —— 边界差一字节必须判对,否则用户选中的图
  // 有时能过有时不能,而他不会知道为什么。
  const justOver = join(IMGS, "just-over.png");
  const justUnder = join(IMGS, "just-under.png");
  ensureDir(IMGS);
  writeFileSync(justOver, Buffer.alloc(15 * 1024 * 1024 + 1, 0x78));
  writeFileSync(justUnder, Buffer.alloc(15 * 1024 * 1024, 0x78));

  const res = await pickImages(justOver, justUnder);
  eqArr("正好 15MB 放行", res.images.map((i) => i.name), ["just-under.png"]);
  eqArr("15MB 多 1 字节被拒", res.skipped, ["just-over.png"]);
  check("被拒的那个**没被读**", !readFileCalls().includes(justOver), readFileCalls());
}

/* ──────────────── 3. shell 的围栏:精确等于 vs 在里面 ──────────────── */

console.log("\n3. shell 围栏:哪些路径进得来");

const PX = "D:\\proj\\foo";
const PX_SIBLING = "D:\\proj\\foobar";

function mkProject(id: string, name: string, path: string, archived = false): string {
  const now = Date.now();
  ProjectRepo.create({
    id,
    name,
    path,
    archived,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  } as never);
  return id;
}

/**
 * 一次调用前后的 shell 调用记录 —— "拒绝了"和"根本没走到"的分界。
 *
 * ⚠️ handler 抛出去时**不往外抛**,而是往返回值里塞一条 `THREW:<消息>` 哨兵。
 * 两个理由:
 *
 *   1. 这三条通道明确承诺 "no throw into the renderer"。抛出去的话,裸 `await` 会让
 *      **套件当场崩在收尾之前** —— 汇总那行不打、退出码也不对,看起来像"没输出"
 *      而不是"崩了"(变异验证时栽过一次)。哨兵让断言红得有名有姓。
 *   2. 哨兵混在"调用记录"这个数组里,正好和它要区分的那件事同框:期望
 *      `["openPath:…"]` 时多出一条 `THREW:…`,detail 里一眼就看得出是"抛了",
 *      期望 `[]` 时同理 —— 而不是只看到"数组不相等"。
 */
async function shellEffect(fn: () => Promise<unknown>): Promise<string[]> {
  resetShell();
  return await withSentinel(fn);
}

/** 喂好 `shell.openPath` 的返回值,再跑一次 —— **顺序不能反**。
 *
 *  ⚠️ `resetShell()` 顺手把 `openPathReturn` 清回 `""`,所以必须先 reset 再写值。
 *  写成 `set 返回值; resetShell()` 会把那一行**静默清掉** —— "系统打不开"那条路
 *  一次都没走到,而三条断言全绿。这就是"登记了夹具却没人命中"(本套踩过,靠变异抓出来)。 */
async function shellEffectWithOpenPath(
  returnValue: string,
  fn: () => Promise<unknown>,
): Promise<string[]> {
  resetShell();
  openPathReturn.value = returnValue;
  return await withSentinel(fn);
}

/** 跑一次,把异常转成记录数组末尾的一条 `THREW:` 哨兵。 */
async function withSentinel(fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
  } catch (err) {
    return [...shellCalls.map((c) => `${c.fn}:${c.path}`), `THREW:${(err as Error).message}`];
  }
  return shellCalls.map((c) => `${c.fn}:${c.path}`);
}

{
  mkProject("projA", "甲", ROOT_A);
  mkProject("projB", "乙", ROOT_B);
  mkProject("projArchived", "归档的", ROOT_ARCHIVED, true);
  mkProject("projWin", "Windows 路径", PX);

  // 前提:项目根真读得到(真库、真 repository 方法,没手写 SQL)。
  const paths = ProjectRepo.list().map((p) => p.path);
  check("夹具项目根真的落库了", paths.includes(ROOT_A) && paths.includes(ROOT_B), paths);
}

{
  // openPath:只认**精确等于**某个非归档项目根。
  const effect = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: ROOT_A }));
  eqArr("项目根本身能打开", effect, [`openPath:${ROOT_A}`]);

  // 项目根**里面**的东西:openPath 是"打开项目文件夹本身"那条路,不该吃。
  const inside = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: join(ROOT_A, "a.txt") }));
  eqArr("项目根**里面**的东西 openPath 不吃(它是「打开文件夹本身」)", inside, []);

  // 尾分隔符、多余的 `.`:`resolve` 时都归一,要认成同一个目录。
  // 打开的是**用户给的那个字符串**(不是归一后的),所以这里期望原样。
  const trailing = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: ROOT_A + "\\" }));
  eqArr("尾部分隔符不影响判定(打开的就是给的那个字符串)", trailing, [`openPath:${ROOT_A}\\`]);
  const dotted = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: join(ROOT_A, ".") }));
  eq("路径里的 `.` 也归一才能认成同一个目录", dotted.length, 1);
  check(
    "`…\\projA\\.` 确实被放行了(用点结尾的那串原样交给系统)",
    dotted.length === 1 && dotted[0].startsWith("openPath:"),
    dotted,
  );

  // 不是项目根的目录:一次都不许调。
  const outside = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: join(TMP, "not-a-project") }));
  eqArr("不是项目根的目录一次都不调 shell.openPath", outside, []);

  // 归档的项目根:**归档了就不该再能从渲染端打开它下面的东西**。
  const archived = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: ROOT_ARCHIVED }));
  eqArr("归档的项目根被拒", archived, []);
}

{
  // showItemInFolder / openFile:认"在某个非归档项目根**里面**"。
  const deep = join(ROOT_A, "src", "deep", "x.ts");
  const effect = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: deep }));
  eqArr("项目根里面的文件能定位", effect, [`showItemInFolder:${deep}`]);

  const eqRoot = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: ROOT_A }));
  eqArr("项目根自己也算(在或等于)", eqRoot, [`showItemInFolder:${ROOT_A}`]);

  const outside = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(TMP, "x.txt") }));
  eqArr("项目根外面的路径一次都不调", outside, []);

  const archived = await shellEffect(() =>
    call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(ROOT_ARCHIVED, "a.txt") }),
  );
  eqArr("归档项目根下面的东西也被拒", archived, []);

  // openFile:同一套围栏,但走的是 `shell.openPath`(真的用系统程序打开)。
  const of = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: join(ROOT_A, "paper.docx") }));
  eqArr("openFile 允许项目根里面的文件", of, [`openPath:${join(ROOT_A, "paper.docx")}`]);
  const ofRoot = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: ROOT_A }));
  eqArr("openFile 也认项目根本身", ofRoot, [`openPath:${ROOT_A}`]);
  const ofOut = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: join(TMP, "x.docx") }));
  eqArr("openFile 拒项目根外面的", ofOut, []);
}

{
  // ⚠️ **分隔符边界**。这是这套里最该守住的一条:少了 `+ sep`,项目根 `D:\proj\foo`
  // 会把兄弟目录 `D:\proj\foobar\x.txt` 放行 —— 而它是**静默放行**,没有谁会看见。
  const sibling = PX_SIBLING + "\\x.txt";
  const effect = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: sibling }));
  eqArr("项目根少一个分隔符时不放行(foo 不许吃 foobar)", effect, []);

  const sibOpen = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: sibling }));
  eqArr("openFile 同样不吃兄弟目录", sibOpen, []);

  // root 比路径还长(连前缀都算不上)。
  const w = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: "D:\\proj\\fo" }));
  eqArr("路径比 root 短时也不放行", w, []);

  // `..` 逃逸:resolve 之后落到项目根外面,必须拒。
  const escape = PX + "\\..\\..\\Windows\\System32";
  const e1 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: escape }));
  eqArr("`..` 逃逸到 C:\\Windows 被拒", e1, []);
  const e2 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: PX + "\\..\\foo" }));
  eqArr(
    "`..` 绕一圈回到同一个目录 —— 放行,但底下的路径按 resolve 后的算",
    e2,
    [`showItemInFolder:${PX}\\..\\foo`],
  );
  const e3 = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: PX + "\\..\\..\\Windows\\notepad.exe" }));
  eqArr("openFile 的 `..` 逃逸同样被拒", e3, []);

  // 绝对路径:项目根里的相对写法不该被当成"里面"。
  const rel = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: "foo\\a.txt" }));
  eqArr("相对路径按进程 cwd 解析(不是项目根),因此被拒", rel, []);
}

/* ──────────────── 4. 大小写:本地抄的那份 pathWithin 少了归一 ──────────────── */

console.log("\n4. 大小写归一(本地抄的那份 vs lib/pathGuard.ts)");

{
  // `lib/pathGuard.ts` 那份做了 win32/darwin 的大小写归一,注释里写明了理由:
  // "a lowercased drive letter from Monaco/LSP (`d:\foo`) still matches a project
  // stored with an uppercase letter (`D:\foo`)"。`shell.ts` 自己抄了一份,**没做** ——
  // 于是同一个目录只因大小写不同就被拒,用户点「在文件管理器里显示」**没反应**。
  const lower = PX.toLowerCase(); // d:\proj\foo
  const effect = await shellEffect(() =>
    call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: lower + "\\a.txt" }),
  );
  eqArr(
    "大小写不同但同一个目录时放行(Windows 路径不区分大小写)",
    effect,
    [`showItemInFolder:${lower}\\a.txt`],
  );

  // `shell:openPath` 那条**精确比较**同理:它比的是 `resolve(p.path) === resolve(input.path)`。
  const openLower = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: lower }));
  eqArr("openPath 的精确比较也要归一大小写", openLower, [`openPath:${lower}`]);

  // openFile 走的是同一个 `pathWithin`,一起钉住。
  const ofLower = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: lower.toUpperCase() + "\\x.docx" }));
  eqArr("openFile 也一样(这里两个方向都试了)", ofLower, [`openPath:${lower.toUpperCase()}\\x.docx`]);
}

/* ──────────────── 5. 拒绝的形状:不抛,只 log.warn ──────────────── */

console.log("\n5. 拒绝是「记一笔然后正常返回」,不是把错误扔回渲染端");

{
  // 源码注释写明了 "A refused or failing call logs and resolves (no throw into the
  // renderer)"。"被拒了"和"没炸"是**两件事**,这里都要。
  //
  // ⚠️ 一律走 `shellEffect`(内部有 `resetShell`),**不用裸 `call`**:handler 抛出去的话
  // 那是 Node 的未捕获异常,套件当场退出、收尾那行汇总根本不打 —— 看起来像"没输出",
  // 实际是崩了。变异验证时正是栽在这儿。
  const refusedOpen = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: join(TMP, "nope") }));
  eqArr("openPath 拒绝时不抛,而且一次都没调 shell.openPath", refusedOpen, []);
  const refusedShow = await shellEffect(() =>
    call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(TMP, "nope") }),
  );
  eqArr("showItemInFolder 拒绝时也不抛,也没调", refusedShow, []);
  const refusedFile = await shellEffect(() => call(IPC.SHELL_OPEN_FILE, { path: join(TMP, "nope") }));
  eqArr("openFile 拒绝时也不抛,也没调", refusedFile, []);

  // 被拒的返回值和成功的返回值**形状相同**(都是 undefined)—— 渲染端没法从返回值
  // 分辨,所以"到底有没有反应"只能靠调用记录。这是设计如此,不是漏洞。
  // ⚠️ 用 `catching` 拿错误消息而不是裸 `call`:抛出去的话裸 `call` 会把套件带走。
  eq(
    "被拒时返回 undefined(和成功一样,靠调用记录区分)",
    await catching(IPC.SHELL_OPEN_PATH, { path: join(TMP, "nope") }),
    "",
  );
}

{
  // `shell.openPath` 返回非空字符串 = 失败。失败只该 log.warn,不该把错误抛回去 ——
  // 渲染端点了「用默认程序打开」而系统没有关联程序时,用户不该看到一个红框。
  //
  // ⚠️ 喂返回值**必须**用 `shellEffectWithOpenPath`(它在 `resetShell()` **之后**才写)。
  // `resetShell()` 会把 `openPathReturn` 清回 `""`,手写的话顺序一反就静默清掉了
  // 夹具 —— 于是"失败"那条路一次都没走到,而断言全绿(本套踩过,靠变异验证抓出来)。
  const failedOpen = await shellEffectWithOpenPath("Failed to open path", () =>
    call(IPC.SHELL_OPEN_PATH, { path: ROOT_A }),
  );
  eqArr("系统打不开时也不抛(只记一笔),而且确实调了 shell.openPath", failedOpen, [
    `openPath:${ROOT_A}`,
  ]);

  // openFile 那条路同样:失败字符串不抛回去。
  const failedFile = await shellEffectWithOpenPath("Failed to open file", () =>
    call(IPC.SHELL_OPEN_FILE, { path: join(ROOT_A, "a.docx") }),
  );
  eqArr("openFile 打开失败时也不抛(只记一笔)", failedFile, [`openPath:${join(ROOT_A, "a.docx")}`]);
  resetShell();
}

{
  // 参数校验:明显非法的输入要被 schema 拒掉,而不是一路 resolve 之后再判。
  const threw = await catching(IPC.SHELL_OPEN_PATH, { path: undefined });
  check("缺 path 被 schema 拒", threw !== "", threw || "(没抛)");
  const threw2 = await catching(IPC.SHELL_SHOW_ITEM_IN_FOLDER, {});
  check("showItemInFolder 缺 path 也被拒", threw2 !== "", threw2 || "(没抛)");
  const threw3 = await catching(IPC.SHELL_OPEN_FILE, { path: 123 });
  check("openFile 的 path 类型不对被拒", threw3 !== "", threw3 || "(没抛)");
  const threw4 = await catching(IPC.DIALOG_PICK_FILES, { title: 123 });
  check("pickFiles 的 title 类型不对被拒", threw4 !== "", threw4 || "(没抛)");
}

/* ──────────────── 6. 多个项目根之间不串 ──────────────── */

console.log("\n6. 多个项目根之间不串");

{
  // 两个项目根是**包含**关系时(乙在甲里面),甲下面的文件两个都能开 —— 这是围栏语义
  // ("在某个根里面"),不是 bug。这里钉住的是**各自独立成立**。
  const nested = join(ROOT_A, "inner");
  mkProject("projNested", "嵌套的", nested);

  const e1 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(nested, "f.txt") }));
  eqArr("嵌套根下面的文件能开", e1, [`showItemInFolder:${join(nested, "f.txt")}`]);

  const e2 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(ROOT_A, "top.txt") }));
  eqArr("外层根自己的文件照常", e2, [`showItemInFolder:${join(ROOT_A, "top.txt")}`]);

  const e3 = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: nested }));
  eqArr("嵌套根本身也能 openPath", e3, [`openPath:${nested}`]);

  // 把嵌套根归档:**只有它**失效,外层根照常 —— 归档判断必须逐个根看,不能一票否决。
  ProjectRepo.setArchived("projNested", true);
  const e4 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(nested, "f.txt") }));
  // ⚠️ 这里**故意**还是放行 —— 嵌套根归档了,但它外面的 `ROOT_A` 是活动根,那个文件
  // 在 `ROOT_A` 里面,按"在某个**活的**根里面"这个规则本来就该放行。
  // 归档判断是**逐个根**看的,不是一票否决整个路径。
  eqArr("嵌套根归档了,但外层活动根仍然覆盖这个文件", e4, [`showItemInFolder:${join(nested, "f.txt")}`]);

  // 真正该失效的是**只有这个嵌套根**覆盖的地方:把外层根也归档,它就彻底打不开了。
  // (这两条一起才说明"归档"这件事真的被算进去了,而不是被外层根顺手兜住。)
  ProjectRepo.setArchived("projA", true);
  const e6 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(nested, "f.txt") }));
  eqArr("外层根也归档之后,这个文件才真的打不开", e6, []);

  // 把外层根恢复。注意 `ROOT_A` 归档期间它自己也不该能 openPath。
  ProjectRepo.setArchived("projA", false);
  const e7 = await shellEffect(() => call(IPC.SHELL_OPEN_PATH, { path: ROOT_A }));
  eqArr("恢复之后外层根又能打开了", e7, [`openPath:${ROOT_A}`]);
  const e5 = await shellEffect(() => call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(ROOT_A, "top.txt") }));
  eqArr("但外层根没被连坐", e5, [`showItemInFolder:${join(ROOT_A, "top.txt")}`]);
}

/* ──────────────── 文献库根也是合法工作区根（2026-09-21） ──────────────── */

console.log("\n文献库根 · 编辑那里面的文件要通得过这道闸");

{
  // ★ 用户的规矩是「我不管从哪打开，只要在主页面显示它，我就该能编辑它」——
  //   而文献库的 PDF/markdown 住在 `<数据根>/library/` 下，**不归任何项目根管**。
  //   不加这一类根，那些文件送进 FileEditor（读写全走 file:readFile / file:writeFile）
  //   会**读被拒、写更被拒**，表现是"打开了但是空的、存不下去"。
  //
  //   这一段的判据就一条：**库里的文件在、库外的文件不在**。前一版没有这条时
  //   库里那份会被判成"越界"。
  const lib = join(dataRoot(), "library");
  mkdirSync(join(lib, "papers", "ab"), { recursive: true });
  const insidePdf = join(lib, "papers", "ab", "x.pdf");
  writeFileSync(insidePdf, "x");

  check("★ 库根下的文件 → 有归属", findContainingWorkspaceRoot(insidePdf) !== null, {
    got: findContainingWorkspaceRoot(insidePdf),
  });
  check("★ 库根本身 → 也算", findContainingWorkspaceRoot(lib) !== null);
  check("★ isKnownWorkspaceRoot 认它", isKnownWorkspaceRoot(insidePdf));

  // 反面：**数据根下的别处不该跟着一起开口子**。`mcode.db` / `workflows/` /
  // `memory/` 各有各的 IPC，不该从"随便读写一个文件"这条通用路进去 —— 这条钉的是
  // "加的是 library/ 而不是整个数据根"这个刻意的收窄。
  check(
    "★ 数据根下的 mcode.db **不在**（只放开了 library/）",
    findContainingWorkspaceRoot(join(dataRoot(), "mcode.db")) === null,
  );
  check(
    "★ 数据根下的 workflows/ **不在**",
    findContainingWorkspaceRoot(join(dataRoot(), "workflows", "a.json")) === null,
  );
  check(
    "★ 数据根本身 **不在**",
    findContainingWorkspaceRoot(dataRoot()) === null,
  );
  // 反面二：系统目录更不该在。
  // 模版库也要 —— 它在 `<数据根>/templates/`,与文献库**并列**。只放开 library
  // 是第一版的漏:那边同样是"用户自己的文档、同样要在主页面里编辑"。
  const tpl = join(dataRoot(), "templates");
  mkdirSync(join(tpl, "code", "x"), { recursive: true });
  check(
    "★ 模版库下的文件也认（不是只放开 library）",
    findContainingWorkspaceRoot(join(tpl, "code", "x", "a.py")) !== null,
  );

  check(
    "★ 库外随便一个路径 **不在**",
    findContainingWorkspaceRoot(join(TMP, "..", "definitely-not-ours.txt")) === null,
  );
}

/* ──────────────── 收尾 ──────────────── */

rmSync(TMP, { recursive: true, force: true });

console.log(`\ndialog-shell-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
