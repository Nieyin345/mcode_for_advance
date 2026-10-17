/**
 * 设置导入 / 导出的 IPC(R39)。规则与清洗在 `settings/settingsTransfer.ts`;这里只管
 * 对话框、读写文件和导入前的备份。两个对话框都在主进程(渲染端没有保存框,也读不了
 * 项目外的任意路径 —— 和工作流导入导出同一个理由)。
 */
import type { IpcMain } from "electron";
import { app, dialog } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { IPC, type SettingExportFileResult, type SettingImportFileResult, SettingExportToPathSchema, SettingImportFromTextSchema } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { getDb, commitNow } from "@main/store/db.js";
import { isDurable, type CommitResult } from "@contracts/commit";
import { getMainWindow } from "@main/window.js";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { log } from "@main/lib/logger.js";
import { errText } from "@main/lib/ipcError.js";
import { dialogText } from "@main/lib/dialogText.js";
import { broadcastSettingChangedToAll } from "@main/lib/sessionSync.js";
import { isSyncedSettingKey } from "@contracts/ipc/settingsSync";
import { buildSettingsExport, parseSettingsImport, restoreKeysToDelete } from "@main/settings/settingsTransfer.js";

function allSettings(): Record<string, string | null> {
  const keys = SettingRepo.keysWithPrefix("");
  return SettingRepo.getMany(keys);
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 导入文件的**字节**上限(MC-030)。导出的是"跟着人走的偏好",几 MB 就到顶;20 MB
 *  之上不可能是正常设置文件。 */
const IMPORT_MAX_BYTES = 20_000_000;

/** 读取一个导入文件,但**先 `stat` 再 `read`**(MC-030)。
 *
 *  从前是 `readFile(file,"utf8")` 读完整份到内存,之后才检查 `text.length` —— 于是
 *  一个被诱导选中的超大文件(或一个巨大的非设置文件)会在**任何上限生效之前**先被
 *  整份读进主进程内存并转成字符串。这里改成:
 *
 *    1. **读取前**先 `stat` 拿大小,超限直接拒 —— 根本不读那个文件;
 *    2. 读完之后再按**实际字节数**核一遍 —— 堵住"`stat` 与 `read` 之间文件被追加/替换"
 *       的竞态(否则第 1 步测出的小文件可以在 reads 期间膨胀)。
 *
 *  返回**去掉 BOM 后的文本**;超限时返回 `{ tooLarge: true }`。 */
async function readImportFileWithinLimit(file: string): Promise<{ text: string } | { tooLarge: true }> {
  // 1. 便宜的预检查:不读内容,只看大小。
  const st = await stat(file);
  if (st.size > IMPORT_MAX_BYTES) return { tooLarge: true };
  // 2. 读进来(预检查保证这里读的是小文件)。BOM 交给 `parseSettingsImport` 去剥
  //    (它本来就在 `JSON.parse` 前做这件事),这里不再重复。
  const text = await readFile(file, "utf8");
  // 3. 读后复核:文件可能在 1 与 2 之间长大 —— 按真实字节数再挡一次。
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) return { tooLarge: true };
  return { text };
}

/** 备份文件名的随机尾巴(MC-026)。秒级时间戳在同秒内会撞名,加 4 字节随机后缀把碰撞
 *  概率压到可忽略;`writeFile` 的 `flag: "wx"` 再兜一层 —— 即便真撞上也是"生成新名字 /
 *  报错",永不静默覆盖前一份备份。 */
function backupSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** 原子、**排他**地写一份导入前备份;返回落定的路径。
 *
 *  MC-026:从前固定名 `before-import-<秒>.json` + 无排他标志,一秒内两次导入第二份会
 *  **覆盖**第一份。这里用 `wx`(存在即 EEXIST)循环挑新名字,保证"两次导入拿到两个不同
 *  的备份文件、各自是各自导入前的状态"。 */
async function writeImportBackup(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = attempt === 0
      ? `before-import-${stamp()}-${backupSuffix()}.json`
      : `before-import-${stamp()}-${backupSuffix()}-${attempt}.json`;
    const candidate = join(dir, name);
    try {
      await writeFile(candidate, content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // 撞名 → 换一个,绝不覆盖
      throw err;
    }
  }
  throw new Error("无法生成唯一的备份文件名");
}

/** 导入整批写入的结构化结果(ARC-005)。
 *
 *  成功与失败不再是「返回键 / 抛错」两态 —— durable 提交的结果、以及**内存补偿有没有成**
 *  是两件不同事实:`commit` 非 DURABLE 时,若内存恢复成功,库与磁盘都没留半套新值;若恢复
 *  自身也抛了,内存里可能仍握着导入的新值(进程还读得到,重启才回到旧值)。后者绝不是
 *  「当前设置未改动」,调用方必须把这句话说清楚,不能拿它骗用户。 */
type ApplyImportOutcome =
  | { ok: true; changedKeys: string[] }
  | { ok: false; commit: CommitResult; compensation: "rolled-back" | "rollback-failed" };

/** 把一批设置**整体**写进库,并结构化地交出这次提交的结果(见下)。
 *
 *  MC-025:从前是 `for { SettingRepo.set(k,v); broadcast…(k,v) }` —— 每项各自
 *  `persist()`,第 N 项抛错时前 N-1 项已落库、已广播,导入留下"半套新值 + 失效状态"。
 *  这里把**全部写入收进一个事务**:任一项抛错就 ROLLBACK,库回到导入前(零部分写入);
 *  提交成功才落盘。广播交给调用方在提交之后统一发(见 handler)。
 *
 *  复用 `SettingRepo.set` 同一句 upsert —— 不另造一套写库逻辑(硬规矩 2)。
 *
 *  【MC-029】`deleteKeys`(恢复模式)在同一事务里一并删 —— 只删**可迁移**键(由调用方用
 *  `restoreKeysToDelete` 算好),让"完整恢复"真的回到导出那一刻,而敏感/本机键绝不误删。
 *
 *  【ARC-005】落盘走 {@link commitNow} 的**结构化结果**(与 `@contracts/commit` 同一份判据),
 *  而不是 `persistNowOrThrow` 的「失败即抛」:这样本函数能区分「写盘没成、内存已恢复」
 *  与「写盘没成、内存补偿也失败」。返回 `rollback-failed` 时上层**不许**说「已整体回滚」——
 *  内存里可能还留着新值(MC-053 同款:改了内存、没落盘、还对外报成功/全回滚)。 */
function applySettingsImport(
  entries: ReadonlyArray<readonly [string, string]>,
  deleteKeys: ReadonlyArray<string> = [],
): ApplyImportOutcome {
  const db = getDb();
  // 【MC-025 第二轮】durable 落盘失败时,COMMIT 已经在**内存**里生效了 —— 只抛错、不广播
  // 挡不住同一应用里的其它读者(以及后续别的持久化动作)看到这批"失败"的新值。所以先在
  // 改动前把**受影响的键**的旧值读下来,落盘失败时用它把内存 DB 恢复原状(连同 deleteKeys
  // 的旧行),再返回 —— 内存与磁盘都不留半套新值。
  const touched = [...entries.map(([k]) => k), ...deleteKeys];
  const before = new Map<string, string>();
  for (const k of touched) {
    const row = db.exec("SELECT value FROM settings WHERE key = ?", [k])[0];
    if (row && row.values.length > 0) before.set(k, String(row.values[0]![0]));
  }
  db.run("BEGIN");
  try {
    for (const [k, v] of entries) {
      db.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [k, v],
      );
    }
    for (const k of deleteKeys) {
      db.run("DELETE FROM settings WHERE key = ?", [k]);
    }
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err; // 写入事务本身失败 → 内存已被 ROLLBACK 复位,「已整体回滚」此刻是真话。
  }
  // 【MC-025】提交之后必须**同步确认 durable** 才返回 —— 从前这里调 `persist()`(异步调度),
  // "COMMIT 成功"就被当成"导入成功"并把新值广播出去,而磁盘可能还没落定(甚至终将失败):
  // 用户看到部分/全部新值、多端广播了新值,重启后却没了。
  const commit = commitNow();
  if (isDurable(commit)) return { ok: true, changedKeys: entries.map(([k]) => k) };
  // 【MC-025 第二轮 / ARC-005】落盘失败 → **同步恢复内存 DB** 到导入前的值。恢复本身也可能
  // 失败(内存此刻可能是坏的 / 触发器等) —— 那一次失败不能被静默吞掉:它决定上层能否说
  // 「当前设置未改动」。恢复成功才报 rolled-back;抛了就报 rollback-failed,把真事实交给调用方。
  let compensation: "rolled-back" | "rollback-failed" = "rolled-back";
  try {
    db.run("BEGIN");
    for (const k of touched) {
      if (before.has(k)) {
        db.run(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [k, before.get(k)!],
        );
      } else {
        db.run("DELETE FROM settings WHERE key = ?", [k]);
      }
    }
    db.run("COMMIT");
  } catch {
    // 恢复失败:内存可能仍是新值 —— 如实标记,别让上层拿"已整体回滚"骗用户。
    // 尽力撤掉可能残留的打开事务,避免污染后续写入。
    try {
      db.run("ROLLBACK");
    } catch {
      /* 没有打开的事务:忽略 */
    }
    compensation = "rollback-failed";
  }
  return { ok: false, commit, compensation };
}

/**
 * 【MC-026】导出到**显式路径** —— 界面(保存框选中后)与 Agent(`setting.exportToPath`)
 * 共用这一份:同一套清洗(`buildSettingsExport`)、同一套落盘、同一份日志。
 *
 * ⚠️ 调用方负责**路径来源**:界面从系统对话框拿,Agent 那条由宿主在 **danger 审批**之后
 * 传入(见 policy 的 setting.exportToPath)。本函数不做路径围栏 —— 它能写任何可写路径,
 * 所以谁能调它,谁就必须先过审批。
 */
export async function exportSettingsToPath(path: string): Promise<SettingExportFileResult> {
  try {
    const { doc, count, skipped, scrubbed } = buildSettingsExport(allSettings(), { appVersion: app.getVersion() });
    await writeFile(path, `${JSON.stringify(doc, null, 2)}
`, "utf8");
    log.info(`settings.export: ${count} keys → ${path} (skipped ${skipped}, scrubbed ${scrubbed})`);
    return { ok: true, path, count, skipped, scrubbed };
  } catch (err) {
    log.warn(`settings.export failed: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 【MC-026】从**已读入的文本**导入 —— 界面(读文件后)与 Agent(直接给 JSON 内容)共用
 * 这一份:同一套解析/清洗(`parseSettingsImport`)、同一套导入前备份、同一个整批事务、
 * 同一份提交后广播。Agent 那条**不需要系统对话框**,因此可以自主编排(审批仍走宿主的
 * danger 卡 —— 见 policy 的 setting.importFromText)。
 *
 * `sourceLabel` 只用于日志/备份路径的可读性(界面传文件名,Agent 传 "agent")。
 */
export async function importSettingsFromText(
  text: string,
  mode: "merge" | "restore",
  sourceLabel: string,
): Promise<SettingImportFileResult> {
  const parsed = parseSettingsImport(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // 导入前先备份当前设置(同样不含密钥),导坏了能用「导入」再导回来。
  // ⚠️ 备份写不出去就地中止,绝不继续往下覆盖(见原 handler 的注释)。
  const dir = join(app.getPath("userData"), "settings-backups");
  let backupPath: string;
  try {
    backupPath = await writeImportBackup(
      dir,
      `${JSON.stringify(buildSettingsExport(allSettings(), { appVersion: app.getVersion() }).doc, null, 2)}
`,
    );
  } catch (err) {
    const why = (err as Error).message;
    log.warn(`settings.import: backup failed, aborting import: ${why}`);
    return { ok: false, error: `导入前的设置备份失败,已中止导入(当前设置未改动):${why}` };
  }
  const exportedKeys = new Set(parsed.entries.map(([k]) => k));
  const deleteKeys =
    mode === "restore"
      ? restoreKeysToDelete(SettingRepo.keysWithPrefix("").filter((k) => SettingRepo.get(k) !== null), exportedKeys)
      : [];
  let changedKeys: string[];
  try {
    const applied = applySettingsImport(parsed.entries, deleteKeys);
    if (!applied.ok) {
      const why = applied.commit.reason ?? "sqlite commit failed";
      if (applied.compensation === "rolled-back") {
        log.warn(`settings.import: write not durable, memory rolled back: ${why}`);
        return { ok: false, error: `写入设置失败,已整体回滚(当前设置未改动):${why}` };
      }
      log.warn(`settings.import: write not durable AND memory rollback failed: ${why}`);
      return {
        ok: false,
        error: `写入设置失败,且内存回滚也失败 —— 当前设置可能仍停在导入的新值上(重启动后会回到旧值),请重启应用确认后再试:${why}`,
      };
    }
    changedKeys = applied.changedKeys;
  } catch (err) {
    log.warn(`settings.import: write failed, rolled back: ${(err as Error).message}`);
    return { ok: false, error: `写入设置失败,已整体回滚(当前设置未改动):${(err as Error).message}` };
  }
  // 只在**提交之后**广播(注释见原 handler:必须 ...ToAll,手机与桌面本端都要收到)。
  for (const k of changedKeys) {
    if (isSyncedSettingKey(k)) broadcastSettingChangedToAll(k, SettingRepo.get(k) ?? "");
  }
  try {
    notificationManager.reloadPrefs();
  } catch {
    /* 尽力而为 */
  }
  log.info(`settings.import: ${parsed.entries.length} keys from ${sourceLabel} (skipped ${parsed.skipped.length})`);
  return {
    ok: true,
    count: parsed.entries.length,
    skipped: parsed.skipped.length,
    deleted: deleteKeys.length,
    backupPath,
  };
}

export function registerSettingsTransferHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.SETTING_EXPORT_FILE, async () => {
    const win = getMainWindow();
    const opts = {
      title: dialogText("common.dialog.exportSettings"),
      defaultPath: `mcode-settings-${stamp()}.json`,
      filters: [{ name: dialogText("common.dialog.settingsFilter"), extensions: ["json"] }],
    };
    const res = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false as const, canceled: true };
    // 【MC-026】落盘/清洗/日志走**共享服务** —— Agent 的 `setting.exportToPath` 调同一份。
    return (await exportSettingsToPath(res.filePath)) as SettingExportFileResult;
  });

  ipc.handle(IPC.SETTING_IMPORT_FILE, async (_evt, raw) => {
    const input = (raw ?? {}) as { mode?: "merge" | "restore" };
    const win = getMainWindow();
    const opts = {
      title: dialogText("common.dialog.importSettings"),
      properties: ["openFile" as const],
      filters: [{ name: dialogText("common.dialog.settingsFilter"), extensions: ["json"] }],
    };
    const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = res.filePaths[0];
    if (res.canceled || !file) return { ok: false as const, canceled: true };
    // MC-030:先按文件大小预检查,**超限根本不读**。
    let readResult: Awaited<ReturnType<typeof readImportFileWithinLimit>>;
    try {
      readResult = await readImportFileWithinLimit(file);
    } catch (err) {
      log.warn(`settings.import: cannot stat/read ${file}: ${(err as Error).message}`);
      return { ok: false as const, error: `读不了这个文件:${(err as Error).message}` };
    }
    if ("tooLarge" in readResult) return { ok: false as const, error: "文件太大,不像是设置导出文件" };
    // 【MC-026】解析/备份/事务/广播走**共享服务** —— Agent 的 `setting.importFromText` 调同一份。
    const mode: "merge" | "restore" = input?.mode === "restore" ? "restore" : "merge";
    return (await importSettingsFromText(readResult.text, mode, file)) as SettingImportFileResult;
  });

  // ── 【MC-026】Agent 可编排的两条(不弹系统对话框)──
  // 显式路径导出:调用方只在**过了 danger 审批**之后才够得到(policy 的 DANGER 表)。
  // 清洗/落盘与界面导出同一份(exportSettingsToPath),不存在第二套脱敏逻辑。
  ipc.handle(IPC.SETTING_EXPORT_TO_PATH, async (_evt, raw) => {
    let input;
    try {
      input = SettingExportToPathSchema.parse(raw);
    } catch (err) {
      return { ok: false as const, error: errText(err) };
    }
    return (await exportSettingsToPath(input.path)) as SettingExportFileResult;
  });

  // 直接文本导入:解析/清洗/导入前备份/整批事务/提交后广播与界面导入同一份。
  ipc.handle(IPC.SETTING_IMPORT_FROM_TEXT, async (_evt, raw) => {
    let input;
    try {
      input = SettingImportFromTextSchema.parse(raw);
    } catch (err) {
      return { ok: false as const, error: errText(err) };
    }
    if (Buffer.byteLength(input.text, "utf8") > IMPORT_MAX_BYTES) {
      return { ok: false as const, error: "内容太大,不像是设置导出文件" };
    }
    return (await importSettingsFromText(input.text, input.mode === "restore" ? "restore" : "merge", "agent")) as SettingImportFileResult;
  });
}