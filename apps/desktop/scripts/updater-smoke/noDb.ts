/**
 * 「库坏了」那一趟:数据库**根本没起来**时,更新流程自己还得能跑。
 *
 * ## 为什么单开一趟
 *
 * `initDb()` 在一个进程里是**记忆化**的(`dbReadyPromise` 缓存),`closeDb()` 之后
 * `SettingRepo.set` 那句 `getDb()` 会抛 —— 但那是"关掉了",不是"从来没起来"。而
 * `getDb()` 抛的那句话正是本套要的现场:**库里写不进去**。
 *
 * ⚠️ 一个进程里做不到:*main.ts* 那一趟必须真的 `initDb()`(它要验快照落盘),而
 * `initDb()` 一旦跑过就回不去"没起过"。所以这一趟**故意不调 initDb()**,让
 * `SettingRepo.set` 一路抛 `getDb() called before initDb() resolved`。
 *
 * ## 它钉的是什么
 *
 * `persistUpdateState` / `clearPersistedUpdateState` 里那两个 `catch`。它们是
 * **best-effort**:存不上一条快照不该让更新这件事本身坏掉。少了它们,`update-downloaded`
 * 那个监听器会**抛进 autoUpdater 的事件派发里**,后果是:
 *
 *  - 界面收不到 `update:downloaded` —— 用户下完了却看不到"重启安装";
 *  - 而且 autoUpdater 的 `emit` 是同步的,异常会顺着 `dispatchUpdateDownloaded`
 *    冒回去,可能把整条下载流程带崩。
 *
 * 判据因此立在**"界面那一条推没推出去"**上,不是立在"有没有抛"。
 *
 * ⚠️ 这一趟**仍然要 `MCODE_SMOKE_DATA_ROOT`** —— 不是为了写库,是因为 `dataRoot()`
 * 那个共用桩没设就抛,而 import 图里 `db.ts` 会碰到它。安全前提照旧。
 *
 * Run: scripts/updater-smoke/run.sh(第五趟)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const DATA = mkdtempSync(join(tmpdir(), "mcode-updater-nodb-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
delete process.env["ELECTRON_RENDERER_URL"]; // prod

const { IPC } = await import("@contracts/ipc");
const updater = await import("@main/updater.js");

const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const fake = requireFromHere("electron-updater").autoUpdater as {
  nextCheck: Record<string, unknown>;
  nextDownload: Record<string, unknown>;
  calls: string[];
  fire(e: string, p?: unknown): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  quitAndInstallArgs: unknown[] | null;
};
const windowStub = (await import("@main/window.js")) as unknown as {
  sent: Array<{ channel: string; args: unknown[] }>;
  resetSent(): void;
  sentOf(ch: string): Array<Record<string, unknown>>;
};

// ⚠️ **故意不调 `initDb()`** —— 这一趟的全部意义就在这儿。
await updater.initUpdater();

console.log(`\n${"─".repeat(70)}`);
console.log("库里写不进去时,更新流程不许炸");
console.log("─".repeat(70));

/** 每一段都换一条新的 `update:downloaded` 版本号,免得和上一段混。 */
function fireDownloaded(version: string): { threw: unknown } {
  let threw: unknown = null;
  try {
    fake.fire("update-downloaded", { version });
  } catch (err) {
    threw = err;
  }
  return { threw };
}

/* ──────────────── 1. update-downloaded ──────────────── */

{
  windowStub.resetSent();
  const { threw } = fireDownloaded("1.0.0");
  eq("★ 库里写不进去时,update-downloaded 这条事件仍不抛", threw, null);
  eq(
    "★ 而推给界面的那条照样发出去了(用户看得到「重启安装」)",
    windowStub.sentOf(IPC.UPDATE_DOWNLOADED).length,
    1,
  );
  eq("推的还是那个版本号", windowStub.sentOf(IPC.UPDATE_DOWNLOADED)[0]?.["version"], "1.0.0");
}

/* ──────────────── 2. download-progress ──────────────── */

{
  windowStub.resetSent();
  let threw: unknown = null;
  try {
    fake.fire("download-progress", {
      percent: 10,
      transferred: 1_000,
      total: 10_000,
      bytesPerSecond: 500,
    });
  } catch (err) {
    threw = err;
  }
  eq("★ 进度事件在库里写不进去时也不抛", threw, null);
  eq(
    "★ 而进度照样推给了界面(那条进度条还能动)",
    windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS).length,
    1,
  );
  eq("进度里的百分比是原样的", windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS)[0]?.["percent"], 10);
}

/* ──────────────── 3. update-not-available 那条清理 ──────────────── */

{
  windowStub.resetSent();
  let threw: unknown = null;
  try {
    fake.fire("update-not-available", { version: "0.0.1" });
  } catch (err) {
    threw = err;
  }
  eq("update-not-available 触发的清快照在库里写不进去时也不抛", threw, null);
}

/* ──────────────── 4. 下载失败那条路 ──────────────── */

{
  fake.nextCheck = { ok: true, availableVersion: "2.0.0", infoVersion: "2.0.0" };
  // `checkForUpdates` 本身不写库,所以这条不受影响 —— 顺便验它在这种情况下照常工作。
  let threw: unknown = null;
  let status: unknown = null;
  try {
    status = ((await updater.checkForUpdates("manual")) as { status: string }).status;
  } catch (err) {
    threw = err;
  }
  eq("库没起来时「检查更新」照样能用(它不写库)", threw, null);
  eq("而且结论是对的(发现了新版本)", status, "available");

  // 下载失败:那条 catch 里要清快照 —— 清不动也不许把原始错误吃掉。
  fake.nextDownload = { ok: false, error: new Error("net::ERR_CONNECTION_RESET") };
  let downloadThrew: unknown = null;
  try {
    await updater.downloadUpdate();
  } catch (err) {
    downloadThrew = err;
  }
  check("库没起来时下载失败仍然抛回发起方", downloadThrew !== null, { threw: String(downloadThrew) });
  eq(
    "而且抛的还是那条真正的失败原因(没被清快照的失败顶掉)",
    (downloadThrew as Error)?.message,
    "net::ERR_CONNECTION_RESET",
  );
}

/* ──────────────── 5. 读快照:库没起来时读成 null ──────────────── */

{
  eq(
    "库没起来时读快照返回 null(不把面板带崩)",
    updater.getPersistedUpdateState(),
    null,
  );
}

rmSync(DATA, { recursive: true, force: true });

console.log();
console.log(`updater-smoke(noDb):${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
