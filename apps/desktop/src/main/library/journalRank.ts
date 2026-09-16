/**
 * 期刊档次查询 —— JCR 分区/影响因子、中科院分区/Top、CCF、预警名单。
 *
 * ## 为什么是 TS 而不是搬那个 Python 脚本
 *
 * 用户自己的 `sci-lit-search` skill 里有一份 `journal_rank.py`(283 行),逻辑是对的,
 * 但它做的是**只读一个 SQLite** 这件事 —— 而应用本来就带着 sql.js(主进程的库就是它)。
 * 搬一份 Python 进来要处理脚本内嵌转义、Python 运行环境、跨平台路径三件事,而这里
 * 真正需要的只是一次 `SELECT`。所以按同一套判据在 TS 里重写一遍。
 *
 * ⚠️ 判据必须与那份脚本**逐条一致**(T1/T2/T3/EXCLUDE 的定义、预警名单直接排除、
 * 中科院分区字段形如 `"2 [118/1437]"` 只取开头数字)。两边不一致的话,用户在自己
 * 的 vault 里查出来是 T1、在应用里查出来是 T2,而这恰恰是最难发现的那种错。
 *
 * ## 数据来源
 *
 * `jcr.db` 是**用户自己维护**的 22MB 离线库(由 `模板库/期刊数据/fetch.py` 每年更新),
 * 不随应用发布 —— 它是有版权的商业数据。找不到就**降级**:返回"查不了",绝不猜一个
 * 影响因子出来(那比不查更糟)。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js/dist/sql-asm.js";
import { SEARCH_JOURNAL_DB_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";

/** 中科院分区字段形如 `"2 [118/1437]"`,只取开头的数字。与 Python 那份一致。 */
const ZONE_RE = /^\s*(\d)/;

/** 期刊档次的判据。`EXCLUDE` = 预警名单(直接排除,不参与降级豁免)。 */
export type JournalTier = "T1" | "T2" | "T3" | "EXCLUDE" | "UNKNOWN";

export interface JournalRank {
  journal: string;
  impactFactor?: number;
  jcrQuartile?: string;
  jcrCategory?: string;
  casZone?: string;
  casTop?: string;
  ccf?: string;
  /** 预警名单命中时的说明(年份 + 等级)。 */
  warn?: string;
  tier: JournalTier;
}

/** jcr.db 在哪。找不到返回 null —— 调用方据此如实告知"期刊数据不可用"。 */
export function journalDbPath(): string | null {
  const configured = (SettingRepo.get(SEARCH_JOURNAL_DB_SETTING_KEY) ?? "").trim();
  if (configured && existsSync(configured)) return configured;
  // 数据根下 —— 用户把 jcr.db 丢进 workflows/ 就能用,不用去设置里填路径
  const local = join(dataRoot(), "workflows", "jcr.db");
  if (existsSync(local)) return local;
  return null;
}

/* ── 连接缓存 ──
   打开一个 22MB 的 SQLite 要几百毫秒,而一次检索里可能要查十几个刊名 ——
   每次重开是不能接受的。只读打开,查完不写,缓存住没有一致性风险。 */
let cached: { path: string; db: Database } | null = null;

async function openDb(path: string): Promise<Database | null> {
  if (cached && cached.path === path) return cached.db;
  try {
    const SQL = await initSqlJs();
    const buf = await import("node:fs").then((fs) => fs.readFileSync(path));
    const db = new SQL.Database(new Uint8Array(buf));
    cached?.db.close();
    cached = { path, db };
    return db;
  } catch (err) {
    log.warn(`journalRank: 打不开 ${path}: ${(err as Error).message}`);
    return null;
  }
}

/** 跑一条查询,拿第一行。表/列不存在(不同年份的表结构会变)时返回 null 而不是抛。 */
function firstRow(db: Database, sql: string, params: unknown[]): unknown[] | null {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params as never);
    const row = stmt.step() ? (stmt.get() as unknown[]) : null;
    stmt.free();
    return row;
  } catch {
    // 该年份的表不存在 —— 换下一个年份继续找,不是错误
    return null;
  }
}

/** 按刊名精确查(不区分大小写)。各表分别按年份由新到旧回落。 */
function lookup(db: Database, journal: string): JournalRank {
  const out: JournalRank = { journal, tier: "UNKNOWN" };

  for (const yr of ["2025", "2024"]) {
    const row = firstRow(
      db,
      `SELECT "IF(${yr})", "IF Quartile(${yr})_1", "Category_1", "IF Rank(${yr})_1"
       FROM JCR${yr} WHERE Journal = ? COLLATE NOCASE`,
      [journal],
    );
    if (row) {
      const raw = row[0];
      const num = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
      if (Number.isFinite(num)) out.impactFactor = num;
      out.jcrQuartile = str(row[1]);
      out.jcrCategory = str(row[2]);
      break;
    }
  }

  for (const yr of ["2025", "2023", "2022", "2021"]) {
    const row = firstRow(
      db,
      `SELECT "大类", "大类分区", "Top", "小类1" FROM FQBJCR${yr} WHERE Journal = ? COLLATE NOCASE`,
      [journal],
    );
    if (row) {
      const zone = ZONE_RE.exec(str(row[1]) ?? "");
      if (zone) out.casZone = zone[1];
      out.casTop = str(row[2]);
      break;
    }
  }

  const ccfRow = firstRow(
    db,
    `SELECT "CCF推荐类别（国际学术刊物/会议）", "CCF推荐类型" FROM CCF2026 WHERE "刊物名称" = ? COLLATE NOCASE`,
    [journal],
  );
  if (ccfRow && str(ccfRow[0])) out.ccf = str(ccfRow[0]);

  for (const yr of ["2025", "2024", "2023", "2021", "2020"]) {
    const row = firstRow(db, `SELECT * FROM GJQKYJMD${yr} WHERE Journal = ? COLLATE NOCASE`, [journal]);
    if (row) {
      out.warn = `${yr}:${str(row[1]) ?? ""}`;
      break;
    }
  }

  out.tier = classify(out);
  return out;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/** 分档判据 —— **必须与 `journal_rank.py` 的 classify() 逐条一致**(理由见文件头)。 */
function classify(r: JournalRank): JournalTier {
  if (r.warn) return "EXCLUDE";
  const q = (r.jcrQuartile ?? "").toUpperCase();
  const z = r.casZone ?? "";
  if (q === "Q1" || z === "1") return "T1";
  if (r.casTop === "是") return "T1";
  if (q === "Q2" || z === "2") return "T2";
  if (q === "Q3" || q === "Q4" || z === "3" || z === "4") return "T3";
  return "UNKNOWN";
}

/**
 * 查一批刊名。数据不可用时返回 `dbPath: null` —— 调用方必须**如实转告**,不能假装
 * 查过了。
 */
export async function rankJournals(names: string[]): Promise<{
  dbPath: string | null;
  ranks: JournalRank[];
}> {
  const path = journalDbPath();
  if (!path) return { dbPath: null, ranks: [] };
  const db = await openDb(path);
  if (!db) return { dbPath: null, ranks: [] };
  return { dbPath: path, ranks: names.map((n) => lookup(db, n)) };
}
