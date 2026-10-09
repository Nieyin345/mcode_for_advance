/**
 * settings-import-backup-smoke —— 「导入设置前先备份」这条承诺的回归网。
 *
 * ## 盯的是什么
 *
 * `ipc/settingsTransfer.ts` 的导入路径在覆盖整张设置表**之前**先把当前设置备份到
 * `<userData>/settings-backups/before-import-<时间戳>.json`,理由是"导坏了能用「导入」
 * 再导回来"。界面那句 `settings.transfer.importDesc` 逐字对用户承诺了这件事:
 * 「导入前会先把当前设置备份一份」。
 *
 * 而原来的写法是:备份失败(磁盘满 / 目录只读 / `settings-backups` 被一个同名文件占住,
 * 都是真实入口)只 `log.warn` 一行,然后**照常往下覆盖** —— 返回值里悄悄少了 `backupPath`,
 * 用户看到的一次「成功」导入其实**没有任何后路**。唯一的恢复路径是那份备份,而它没写成。
 *
 * 判据立在**用户能感知的两件事**上:
 *   1. 返回值是不是 `ok:false`(面板会不会说「导入失败」);
 *   2. 库里那个键**有没有被覆盖**(当前设置动不动)。
 *
 * 撤掉修复(备份失败照样往下走)→ 这两条一起红,而且第二条的 `detail` 会直接告诉你
 * `ui.locale` 从 `zh` 变成了 `en`。
 *
 * ## 它怎么跑
 *
 * `ipc/settingsTransfer.ts` 走**真的** handler(不是复述):造一个记名 `ipcMain`,把
 * `SETTING_IMPORT_FILE` 那条收下来调。外面那层只换 `electron`(能喂 userData 根与
 * 打开框返回值)、`window` / `MobileEventBus` / `NotificationManager`(导入会广播、
 * 会重读偏好,那几个真实现要窗口 / 引擎 SDK)。
 *
 * ⚠️ **数据根必须是 `mktemp -d`。** 这一套真建库、真写设置行(`persist()` 重写整个
 * `mcode.db`)。共用桩 `dataRoot.ts` 没设环境变量就抛,别把它改成回落默认值。
 *
 * Run: scripts/settings-import-backup-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

import { setUserData, pushOpenResult, resetDialog } from "./stubs/electron.js";
import { reset as resetNotif, reloadCount } from "./stubs/notificationManager.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ──────────────── 0. 数据根 / userData 先钉死,再 import 被测模块 ──────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-settings-import-"));
const USER_DATA = mkdtempSync(join(tmpdir(), "mcode-settings-import-userdata-"));
const WORK = mkdtempSync(join(tmpdir(), "mcode-settings-import-work-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
setUserData(USER_DATA);

const { IPC } = await import("@contracts/ipc");
const { registerSettingsTransferHandlers } = await import("@main/ipc/settingsTransfer.js");
const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");

/** `getMainWindow()`(window 桩)返回 null —— 走的是不带 win 的那条 dialog 路径。 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerSettingsTransferHandlers(fakeIpc);
await initDb();

const IMPORTER = handlers.get(IPC.SETTING_IMPORT_FILE);
if (!IMPORTER) throw new Error("registerSettingsTransferHandlers 没有注册 SETTING_IMPORT_FILE");

/** 写一个合法的最小导出文件,里面只带 `ui.locale`。返回它的路径。 */
function makeImportFile(locale: string, name = "import.json"): string {
  const p = join(WORK, name);
  const doc = {
    format: "mcode-settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { "ui.locale": locale },
  };
  writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return p;
}

type ImportResult = { ok: boolean; count?: number; skipped?: number; backupPath?: string; error?: string; canceled?: boolean };

async function runImport(file: string): Promise<ImportResult> {
  resetDialog();
  pushOpenResult({ canceled: false, filePaths: [file] });
  return (await IMPORTER!(null)) as ImportResult;
}

/** 清掉 `settings-backups/` 里这一趟攒下的文件(每个场景开跑前调一次)。 */
function clearBackups(): void {
  const dir = join(USER_DATA, "settings-backups");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
}

/* ──────────────── 1. 正控:备份写得成时,导入照常成功 ──────────────── */

console.log("\n导入的正常路径:备份先落盘,再覆盖");

{
  clearBackups();
  SettingRepo.set("ui.locale", "zh");
  resetNotif();

  const res = await runImport(makeImportFile("en"));

  eq("导入成功", res.ok, true);
  eq("导入了 1 项", res.count, 1);
  eq("库里的键被覆盖成导入的那个值", SettingRepo.get("ui.locale"), "en");
  check("返回值带上了备份路径(面板要把这行字显示给用户)", typeof res.backupPath === "string" && res.backupPath.length > 0, res);
  const backup = res.backupPath as string;
  check("备份文件真的存在", existsSync(backup), backup);
  const backupDoc = JSON.parse(readFileSync(backup, "utf8")) as { settings?: Record<string, string> };
  eq("★ 备份里存的是覆盖**之前**的值(导坏了才能导回来)", backupDoc.settings?.["ui.locale"], "zh");
  eq("导入完重读了通知偏好", reloadCount(), 1);
}

/* ──────────────── 2. 备份写不成 → 必须中止,绝不覆盖 ──────────────── */

console.log("\n备份失败:就地中止,当前设置一个字节不动");

{
  SettingRepo.set("ui.locale", "zh"); // 先摆一个会被覆盖的旧值
  clearBackups();

  // 让备份写不成:把 `<userData>/settings-backups` 占成一个**同名文件** —— `mkdir(dir,
  // {recursive:true})` 撞上它会抛 EEXIST(实测)。这比"把目录设成只读"更可控,而且是
  // 真实入口(用户手滑 / 上次异常退出留了个同名文件 / 同步盘占位)。
  const blocker = join(USER_DATA, "settings-backups");
  rmSync(blocker, { recursive: true, force: true });
  writeFileSync(blocker, "占住这个名字,让 mkdir 抛 EEXIST");

  const res = await runImport(makeImportFile("en"));

  eq("★ 备份写不成时导入报**失败**(不许悄悄当成成功)", res.ok, false);
  check("★ 失败理由是人话,且点明了是备份这一步", typeof res.error === "string" && res.error.includes("备份"), res);
  eq("★ 当前设置没被覆盖(仍是旧值 zh)", SettingRepo.get("ui.locale"), "zh");

  // 收工:把那块占位文件删掉,免得影响后面的场景。
  rmSync(blocker, { force: true });
}

/* ──────────────── 3. 恢复原来的后路之后,导入又能走通 ──────────────── */

console.log("\n把占位文件清掉:导入恢复可用(证明上一条断的是'备份失败',不是'导入整体坏了')");

{
  clearBackups();
  SettingRepo.set("ui.locale", "zh");
  const res = await runImport(makeImportFile("en", "import2.json"));
  eq("导入又成功了", res.ok, true);
  eq("键被覆盖成 en", SettingRepo.get("ui.locale"), "en");
  check("又给出了备份路径", typeof res.backupPath === "string", res);
  const doc = JSON.parse(readFileSync(res.backupPath as string, "utf8")) as { settings?: Record<string, string> };
  eq("这次备份存的是 zh", doc.settings?.["ui.locale"], "zh");
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });

console.log(`\nsettings-import-backup-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
