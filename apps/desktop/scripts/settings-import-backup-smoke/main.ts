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
import { fsOps, resetFsOps, setStatSizeOverride } from "./stubs/fsPromises.js";
import { failNextExclusiveCreate, disarmExclusiveCreate } from "./stubs/fsSync.js";

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
const { initDb, getDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");
// `@main/window.js` 被 run.sh 换成了 projects-ipc-smoke 的桩 —— 它把每一帧广播记在 `sent`
// 里(桌面端这一路)。运行时用的是**那个同一个桩实例**(alias 指向同一文件),这里只是把
// 它 cast 成桩的类型好让 typecheck 看得见 `resetSent` / `eventsOfType`(真 `@main/window`
// 没有这两个只属于桩的导出)。拿来断言"导入失败时没有任何客户端看到半套值"。
const windowStub = (await import("@main/window.js")) as unknown as typeof import("../projects-ipc-smoke/stubs/window.js");
const { resetSent, eventsOfType } = windowStub;

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

type ImportResult = { ok: boolean; count?: number; skipped?: number; deleted?: number; backupPath?: string; error?: string; canceled?: boolean };

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

/* ──────────────── 4. MC-026:同一秒内两次导入,备份不能互相覆盖 ──────────────── */

console.log("\nMC-026:冻结时钟让两次导入落在同一秒,备份文件名仍不得相同、也不得覆盖");

/** 写一个带任意 settings 的导出文件。 */
function makeImportFileMulti(settings: Record<string, string>, name: string): string {
  const p = join(WORK, name);
  const doc = { format: "mcode-settings", version: 1, exportedAt: new Date().toISOString(), settings };
  writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return p;
}

{
  clearBackups();
  SettingRepo.set("ui.locale", "V0");

  // **冻结时钟**到一个确定的整秒 —— 这样两次 `stamp()` 逐字相同,正是 MC-026 说的
  // "同一秒两次导入"。不冻的话这个场景要靠运气才撞得上同秒,断言会偶发漏过。
  const RealDate = Date;
  const FIXED = new RealDate("2026-01-02T03:04:05Z").getTime();
  const FrozenDate = function (this: unknown, ...args: unknown[]): Date {
    return args.length === 0
      ? new RealDate(FIXED)
      : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  FrozenDate.now = () => FIXED;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  globalThis.Date = FrozenDate;
  let res1: ImportResult;
  let res2: ImportResult;
  try {
    res1 = await runImport(makeImportFileMulti({ "ui.locale": "V1" }, "same-second-1.json"));
    // 两次导入之间用户又改了值(模拟"第一次导入之后、第二次导入之前"的状态)。
    SettingRepo.set("ui.locale", "V2");
    res2 = await runImport(makeImportFileMulti({ "ui.locale": "V3" }, "same-second-2.json"));
  } finally {
    globalThis.Date = RealDate;
  }

  check("两次导入都成功", res1.ok && res2.ok, { res1, res2 });
  check(
    "★ 同一秒两次导入拿到**两个不同**的备份路径(第二次不覆盖第一次)",
    typeof res1.backupPath === "string" && res1.backupPath !== res2.backupPath,
    { first: res1.backupPath, second: res2.backupPath },
  );
  check("★ 第一次的备份文件仍在(没被第二次盖掉)", existsSync(res1.backupPath as string), res1.backupPath);
  check("★ 第二次的备份文件也在", existsSync(res2.backupPath as string), res2.backupPath);
  const b1 = JSON.parse(readFileSync(res1.backupPath as string, "utf8")) as { settings?: Record<string, string> };
  const b2 = JSON.parse(readFileSync(res2.backupPath as string, "utf8")) as { settings?: Record<string, string> };
  eq("★ 第一份备份是第一次导入**前**的状态(V0)", b1.settings?.["ui.locale"], "V0");
  eq("★ 第二份备份是第二次导入**前**的状态(V2,不是 V0)", b2.settings?.["ui.locale"], "V2");
  eq("两次导入后库里是最后那次的值", SettingRepo.get("ui.locale"), "V3");
}

/* ──────────────── 5. MC-025:导入是整体事务,中途失败零部分写入、零失效广播 ──────────────── */

console.log("\nMC-025:第 2/N 项写入抛错时整体回滚 —— 旧值全在,没有任何客户端看到半套值");

{
  clearBackups();
  SettingRepo.set("ui.locale", "OLD");
  // 清掉别的键(免得干扰"没有广播"的断言)。
  resetSent();

  // **在第 2 项上注入一次确定性失败。** 用一条 BEFORE INSERT 触发器:写 `ui.reloadProbe`
  // 时 RAISE(ABORT) —— 于是事务里第 1 项(ui.locale)已改、第 2 项必抛,正好测"半套值"。
  const db = getDb();
  db.run("DROP TRIGGER IF EXISTS mc025_boom");
  db.run(
    "CREATE TRIGGER mc025_boom BEFORE INSERT ON settings WHEN NEW.key = 'ui.reloadProbe' " +
      "BEGIN SELECT RAISE(ABORT, 'MC025 injected failure'); END;",
  );

  let res: ImportResult;
  try {
    res = await runImport(
      makeImportFileMulti({ "ui.locale": "NEW", "ui.reloadProbe": "boom" }, "atomic-fail.json"),
    );
  } finally {
    db.run("DROP TRIGGER IF EXISTS mc025_boom");
  }

  eq("★ 写入中途失败时导入报**失败**(不谎报成功)", res.ok, false);
  check("失败理由点明了是写入失败 / 回滚", typeof res.error === "string" && /回滚|写入/.test(res.error), res);

  eq("★ 前一项(ui.locale)没有被部分写入(仍是旧值)", SettingRepo.get("ui.locale"), "OLD");
  {
    const probe = SettingRepo.keysWithPrefix("ui.reloadProbe");
    eq("★ 触发失败那一项也没落库", probe.length, 0);
  }
  {
    // 没有任何 `setting.changed` 广播 —— 桌面端 / 手机端都不该看到半套值。
    const changed = eventsOfType("setting.changed");
    eq("★ 失败导入没有向任何客户端广播设置变更", changed.length, 0);
  }

  // 正控:拆掉触发器后同样的两项一次性成功生效,并且**有**广播。
  resetSent();
  SettingRepo.set("ui.locale", "OLD");
  const ok = await runImport(
    makeImportFileMulti({ "ui.locale": "NEW", "ui.reloadProbe": "ok" }, "atomic-ok.json"),
  );
  eq("正控:同样的两项一次性成功", ok.ok, true);
  eq("正控:两项都生效了", SettingRepo.get("ui.locale"), "NEW");
  eq("正控:第二项也写进去了", SettingRepo.keysWithPrefix("ui.reloadProbe").length, 1);
  check(
    "正控:成功导入广播了同步键(桌面本端也收到)",
    eventsOfType("setting.changed").some((e: Record<string, unknown>) => e.key === "ui.locale"),
    eventsOfType("setting.changed"),
  );
}

/* ──────────────── 6. MC-030:导入先 stat 再 read,超限根本不读 ──────────────── */

console.log("\nMC-030:超大导入文件在**读取之前**被拒(不是先读完整份再检查)");

{
  clearBackups();
  SettingRepo.set("ui.locale", "KEEP");

  /** 一份合法 JSON 的**头**,后面跟大段空白把文件撑到超过上限 —— 前半个 JSON 解析器
   *  会一直读到结尾,所以"先读后拒"和"先拒"的可见区别只在**有没有 readFile**。 */
  const HUGE = join(WORK, "huge.json");
  const body =
    `{"format":"mcode-settings","version":1,"exportedAt":"${new Date().toISOString()}","settings":{"ui.locale":"en"},` +
    `"pad":"${"x".repeat(20_000_100)}"}`;
  writeFileSync(HUGE, body, "utf8");

  // ── (a) 正常超大文件:预检查就拦下 → readFile 根本没被调用 ──
  resetFsOps();
  resetDialog();
  pushOpenResult({ canceled: false, filePaths: [HUGE] });
  const res = (await IMPORTER!(null)) as ImportResult;

  eq("★ 超大导入文件被拒", res.ok, false);
  check("拒绝理由说的是文件太大", typeof res.error === "string" && res.error.includes("太大"), res);
  const hugeOps = fsOps();
  check(
    "★ MC-030:对被拒的超大文件调了 stat(读取前的预检查)",
    hugeOps.some((o) => o.op === "stat" && o.path === HUGE),
    { hugeOps },
  );
  eq(
    "★ MC-030:对被拒的超大文件**没有**调 readFile(没有先读进内存)",
    hugeOps.filter((o) => o.op === "readFile" && o.path === HUGE).length,
    0,
  );
  eq("被拒时当前设置没被改(仍是 KEEP)", SettingRepo.get("ui.locale"), "KEEP");

  // ── (b) 竞态:stat 谎报小、真文件大 → 预检查放过,读后复核必须兜住 ──
  // 模拟"检查与读取之间文件长大":stat 见过 1 字节,但 readFile 拿到的是 2e7 字节。
  const SMALL_THEN_BIG = join(WORK, "stat-lies.json");
  writeFileSync(SMALL_THEN_BIG, body, "utf8");
  resetFsOps();
  setStatSizeOverride(SMALL_THEN_BIG, 1); // 预检查看到 1 字节 → 放过
  try {
    resetDialog();
    pushOpenResult({ canceled: false, filePaths: [SMALL_THEN_BIG] });
    const res2 = (await IMPORTER!(null)) as ImportResult;
    eq("★ MC-030:stat 与 read 之间文件变大的竞态也被拒", res2.ok, false);
    check(
      "竞态被拒时理由同样是文件太大(读后复核生效)",
      typeof res2.error === "string" && res2.error.includes("太大"),
      res2,
    );
    const raceOps = fsOps();
    check(
      "★ 竞态:确实读过那个文件(readFile 被调过)",
      raceOps.some((o) => o.op === "readFile" && o.path === SMALL_THEN_BIG),
      { raceOps },
    );
    eq("竞态被拒时设置仍未改", SettingRepo.get("ui.locale"), "KEEP");
  } finally {
    setStatSizeOverride(SMALL_THEN_BIG, null);
  }

  // 正控:同一个路径,去掉 size 谎报后它是正常小文件 → 导入成功(证明 (b) 断的是
  // "复核生效",不是"这个文件被整体拉黑")。
  const okFile = join(WORK, "small-ok.json");
  writeFileSync(
    okFile,
    `${JSON.stringify({ format: "mcode-settings", version: 1, exportedAt: new Date().toISOString(), settings: { "ui.locale": "en" } }, null, 2)}\n`,
    "utf8",
  );
  resetFsOps();
  resetDialog();
  pushOpenResult({ canceled: false, filePaths: [okFile] });
  const res3 = (await IMPORTER!(null)) as ImportResult;
  eq("正控:正常大小的导入文件照常成功", res3.ok, true);
  eq("正控:值真的写进去了", SettingRepo.get("ui.locale"), "en");

  rmSync(HUGE, { force: true });
  rmSync(SMALL_THEN_BIG, { force: true });
}

/* ──────────────── 6. 【MC-029】完整恢复 vs 合并导入 ────────────────
 *
 * 普通导入是 upsert(只合并):"导入前只有 A、导入新增 B,再拿只含 A 的备份导回来" ——
 * B 仍留着,并没真回到导入前。`mode:"restore"` 则**删掉备份里没有的可迁移键**,回到导出
 * 那一刻;而敏感/本机键(密钥/路径/授信)本就不在备份里,绝不能被"恢复"误删。 */

console.log("\nMC-029:合并导入不删未提及的键;完整恢复把备份里没有的键删掉");
{
  clearBackups();
  // 先摆一份"导入前"的档:只含 A(ui.locale)。restore 前,库里还有 B(ui.theme) —— 模拟
  // 导入时新增的键。恢复这份只含 A 的档,必须把 B 删掉、A 还原成档里的值。
  const backupFile = join(WORK, "before-import.json");
  writeFileSync(backupFile, `${JSON.stringify({
    format: "mcode-settings", version: 1, exportedAt: new Date().toISOString(),
    settings: { "ui.locale": "A" },
  }, null, 2)}\n`, "utf8");

  // (a) merge 模式:不删 B。
  SettingRepo.set("ui.locale", "A");
  SettingRepo.set("ui.theme", "B");
  resetDialog(); pushOpenResult({ canceled: false, filePaths: [backupFile] });
  const merged = (await IMPORTER!(null, { mode: "merge" })) as ImportResult & { deleted?: number };
  eq("合并导入成功", merged.ok, true);
  eq("★ 合并导入**不删**未提及的键 B(仍是 B)", SettingRepo.get("ui.theme"), "B");
  eq("合并导入 deleted 为 0", merged.deleted, 0);

  // (b) restore 模式:删掉备份里没有的 B。
  SettingRepo.set("ui.locale", "A");
  SettingRepo.set("ui.theme", "B");
  resetDialog(); pushOpenResult({ canceled: false, filePaths: [backupFile] });
  const restored = (await IMPORTER!(null, { mode: "restore" })) as ImportResult & { deleted?: number };
  eq("完整恢复成功", restored.ok, true);
  eq("★ 备份里没有的键 B 被删掉(真回到导入前)", SettingRepo.get("ui.theme"), null);
  eq("A 还原成备份里的值", SettingRepo.get("ui.locale"), "A");
  check("★ deleted 报出了删掉的键数(>=1)", (restored.deleted ?? 0) >= 1, restored.deleted);
}

console.log("\nMC-029:恢复**不得**误删敏感/本机键(它们本就不在备份里)");
{
  clearBackups();
  const f = join(WORK, "nokeys.json");
  writeFileSync(f, `${JSON.stringify({
    format: "mcode-settings", version: 1, exportedAt: new Date().toISOString(),
    settings: { "ui.locale": "A" },
  }, null, 2)}\n`, "utf8");
  // 摆一个密钥类键与一个授信类键:它们不会被导出,恢复时绝不能因"备份里没有"而被删。
  SettingRepo.set("customModelKeys", JSON.stringify({ k: "secret" }));
  SettingRepo.set("mcp.projectTrust", JSON.stringify(["fp"]));
  resetDialog(); pushOpenResult({ canceled: false, filePaths: [f] });
  const res = (await IMPORTER!(null, { mode: "restore" })) as ImportResult;
  eq("恢复成功", res.ok, true);
  eq("★ 密钥键未被误删", typeof SettingRepo.get("customModelKeys"), "string");
  eq("★ 授信键未被误删", typeof SettingRepo.get("mcp.projectTrust"), "string");
}

/* ──────────────── MC-025:durable 落盘失败不得被当成导入成功 ──────────────── */

console.log("\nMC-025:提交之后的 durable 落盘失败 → 报失败、不广播(不把异步 persist 当成功)");

{
  // 从前提交之后调**异步** `persist()`:COMMIT 成功就被当成导入成功并把新值广播出去,
  // 而磁盘可能还没落定(甚至终将失败)。现在走**同步** `persistNowOrThrow()`:写盘失败
  // 即抛 → 调用方 catch → 返回 ok:false 且**零广播**。这里让 staging 的排他创建
  // (`openSync(x,"wx")`,即 `writeSnapshot` 的第一步)失败一次来模拟。
  resetSent();
  SettingRepo.set("ui.locale", "OLD");
  let res: ImportResult;
  failNextExclusiveCreate();
  try {
    res = await runImport(
      makeImportFileMulti({ "ui.locale": "NEW", "ui.reloadProbe": "durable" }, "durable-fail.json"),
    );
  } finally {
    disarmExclusiveCreate();
  }
  eq("★ durable 落盘失败时导入报**失败**", res.ok, false);
  check("失败理由点明是写入失败", typeof res.error === "string" && /写入/.test(res.error), res);
  eq("★ durable 失败时**零** setting.changed 广播(不把未落盘当成功)", eventsOfType("setting.changed").length, 0);
  // 【MC-025 第二轮】durable 失败后,**内存 DB 也必须回到导入前** ——
  // 只抛错挡住广播还不够:同一应用里的其它读者会从内存读到这批"失败"的新值,后续别的
  // 持久化动作还可能把它写到磁盘。断言旧值仍在、新键没进来。
  eq("★ durable 失败后内存里旧值未被提交(读到的仍是旧值)", SettingRepo.get("ui.locale"), "OLD");
  eq("★ durable 失败后新键没有留在内存表里", SettingRepo.keysWithPrefix("ui.reloadProbe").length, 0);

  // 正控:解除注入后同样两项一次成功、且广播。
  resetSent();
  const ok = await runImport(
    makeImportFileMulti({ "ui.locale": "NEW2", "ui.reloadProbe": "durable-ok" }, "durable-ok.json"),
  );
  eq("正控:解除注入后导入成功", ok.ok, true);
  eq("正控:值生效", SettingRepo.get("ui.locale"), "NEW2");
  check(
    "正控:成功导入广播了同步键",
    eventsOfType("setting.changed").some((e: Record<string, unknown>) => e.key === "ui.locale"),
    eventsOfType("setting.changed"),
  );
}

/* ──────────────── ARC-005:durable 失败且**内存补偿也失败**时不得谎称「已整体回滚」 ────────────────
 *
 * 上面那条 §MC-025 断的是「durable 失败 → 内存补偿**成功** → 旧值仍在」。可补偿本身也可能失败:
 * `applySettingsImport` 里恢复内存 DB 的那段是个 `try/catch {}`,恢复一抛就**静默吞掉**、
 * 照旧把**原始 durable 错误**抛给上层。于是上层那句「写入设置失败,已整体回滚(当前设置未改动)」
 * 就成了**假话** —— 内存里其实还留着一整批导入的新值(同一进程的其它读者立刻读到,后续别的
 * 持久化动作还可能把它写回磁盘),而用户被明确告知「当前设置未改动」。
 *
 * 这正是 ARC-005 的根因:「SQL 内存提交成功 / 磁盘稳定保存 / 外部命令已执行是三种不同事实 ——
 * 把第二种归进成功就是假成功,归进失败又抹掉『进程还握着它』的真事实」,以及它写死的纪律
 * **「不以 false = 完全回滚欺骗调用者」**。判据立在**用户看到的那行字**上(错误里有没有那句
 * 「已整体回滚/未改动」),再拿内存的真实值作证:那句话若为真,内存就该是旧值;而它是新值。
 *
 * 注入方式与 §MC-025 同源:`.persist-` 排他创建失败让 durable 那步必抛;再用一条只在
 * **恢复旧值**时才命中的 BEFORE INSERT 触发器(`WHEN NEW.value = 'PRE'`)让**补偿这一次写**
 * 必抛 —— 导入那一次写的是 'POST',不命中,所以断的确实是「补偿失败」而不是「导入整体坏了」。 */

console.log("\nARC-005:durable 失败 + 内存补偿也失败 → 错误不得谎称『已整体回滚/当前设置未改动』");

{
  resetSent();
  clearBackups();
  SettingRepo.set("ui.locale", "PRE"); // 补偿要恢复的那个旧值
  const db = getDb();
  db.run("DROP TRIGGER IF EXISTS arc005_comp_fail");
  // 只在把 ui.locale 恢复成 PRE(**补偿那一步**)时 ABORT;导入写的是 POST,不命中。
  db.run(
    "CREATE TRIGGER arc005_comp_fail BEFORE INSERT ON settings " +
      "WHEN NEW.key = 'ui.locale' AND NEW.value = 'PRE' " +
      "BEGIN SELECT RAISE(ABORT, 'ARC005 compensation injected failure'); END;",
  );

  let res: ImportResult;
  failNextExclusiveCreate(); // durable 落盘那步必抛 → 进补偿分支
  try {
    res = await runImport(makeImportFileMulti({ "ui.locale": "POST" }, "comp-fail.json"));
  } finally {
    disarmExclusiveCreate();
    db.run("DROP TRIGGER IF EXISTS arc005_comp_fail");
    // 补偿事务可能被 ABORT 留在打开态;收尾把它清掉,别污染后续(本段已是最后一节)。
    try {
      db.run("ROLLBACK");
    } catch {
      /* 没有打开的事务:忽略 */
    }
  }

  eq("durable 失败时导入报**失败**", res.ok, false);
  // ── 承重断言(判据立在用户看到的那行字)──
  check(
    "★ 补偿失败时错误**不得**谎称『已整体回滚 / 当前设置未改动』",
    typeof res.error === "string" && !/整体回滚|未改动/.test(res.error),
    res,
  );
  check(
    "★ 补偿失败时错误明说内存可能已变 / 无法回滚(重启才回到旧值)",
    typeof res.error === "string" && /内存|无法回滚|可能已变|重启/.test(res.error),
    res,
  );
  // ── 那句「未改动」若为真,内存就该是 PRE;可它是 POST —— 证明旧写法在撒谎 ──
  eq("★ 内存里确实仍是导入的新值 POST(补偿没成,memory 未回滚)", SettingRepo.get("ui.locale"), "POST");
  // 修正后的正控地基:清掉残留状态,确认库还能正常读写(没被这段搞坏)。
  SettingRepo.set("ui.locale", "AFTER");
  eq("本段收尾后库仍可正常读写", SettingRepo.get("ui.locale"), "AFTER");
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });

console.log(`\nsettings-import-backup-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
