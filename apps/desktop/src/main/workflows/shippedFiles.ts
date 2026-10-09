/**
 * 「用户没改过的出厂文件,升级时换成新版;改过的一律不动」——
 * **这一条规则的唯一实现**。
 *
 * ## 为什么要单开这个文件
 *
 * 同一套逻辑在 `workflows/seed.ts`(流程脚本:`library.py` / `check_citations.py` /
 * README)与 `orchestration/nodeTypesSeed.ts`(工作流节点类型的 `README.md`)里**各长了一遍**,
 * 而且**已经漂了**:`seed.ts` 在 2026-09-26 把「只在缺失时写」改成"没改过的换新版、改过的
 * 才不动"(见那边的文件头),`nodeTypesSeed.ts` 却仍停在被修掉的旧版("存在就 continue")——
 * 它的注释还写着"做法照 `main/workflows/seed.ts`…规矩也一样"。
 *
 * 后果(用户真会撞上):`<数据根>/workflows/node-types/README.md` 是系统提示词明确指给
 * 模型的规范("要给工作流加一种新节点,先读这个目录里的 README.md")。它首发出厂时写着
 * "`runner.kind` 只有四个值";现版已列 9 种。老用户升级 App 后,磁盘上那份**逐字没动**,
 * 模型照陈旧 README 以为只有 4 种 kind,写不出 `trigger`/`condition`/`code` 这些合法种类。
 *
 * 抽到这里,两个调用方各按自己的根目录 / 记录文件 / 历史哈希调一次即可。
 *
 * ## 判据(三条)
 *
 *  - 文件不存在 → 写出来;
 *  - 存在、哈希等于**这次要写的**(含只差换行)→ 已是最新,补记录,不动;
 *  - 存在、哈希等于**记录里上次写出去的**或**某次发过的历史版本** → 用户没改过 →
 *    换成这一版;
 *  - 其余 → 当作用户改过,不动,记一条日志。
 *
 * 哈希按 **LF 归一**再算 —— Windows 上 git / 编辑器把换行变成 CRLF 不算「改过」。
 *
 * 写失败一律**只记日志不抛**:文件写不出来(只读数据根、网盘)不该让应用起不来。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "@main/lib/logger.js";

/** 比对用的哈希:LF 归一后的 sha256。 */
export function shippedHashOf(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** 一次落盘做了什么。启动流程只拿它记日志;smoke 拿它断言。 */
export interface SeedReport {
  /** 原来没有、新写的。 */
  written: string[];
  /** 原来是没改过的旧版、换成了这一版的。 */
  upgraded: string[];
  /** 和任何发过的版本都对不上 —— 当作用户改过,没动。 */
  keptModified: string[];
}

export interface ShippedFile {
  /** **相对于 `rootDir`** 的路径(`scripts/library.py` / `node-types/README.md`)。同时是记录表的键。 */
  rel: string;
  body: string;
}

export interface SeedOptions {
  /** 这些文件的根目录。 */
  rootDir: string;
  /** 记录「上次写出去的是哪一版」的文件名(如 `.mcode-shipped.json`)。 */
  recordFile: string;
  /**
   * 记录文件放在**哪个目录**(默认 `rootDir`)。少数调用方必须把记录挪出 `rootDir`:
   * 节点类型的加载器会扫 `node-types/*.json` 当清单,记录文件落在那里会被当成一个
   * 坏清单(见 `orchestration/nodeTypes.ts` 的 `loadDir`)。挪到父目录即可。
   */
  recordDir?: string;
  /** 日志前缀(`workflows` / `node-types`)。 */
  label: string;
  /** 还没有记录文件的老安装,靠这张表认「这是某次发过的原版」:`rel → 历次哈希`。 */
  legacyHashes?: Readonly<Record<string, readonly string[]>>;
  /** 非 Windows 上可执行位给不给(脚本给,文档不给)。 */
  executableExts?: readonly string[];
}

function readShippedRecord(recordDir: string, recordFile: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(recordDir, recordFile), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      return out;
    }
  } catch {
    /* 没有或坏了:当老安装处理,靠 legacyHashes 认 */
  }
  return {};
}

export function seedShippedFiles(files: readonly ShippedFile[], opts: SeedOptions): SeedReport {
  const report: SeedReport = { written: [], upgraded: [], keptModified: [] };
  const recordDir = opts.recordDir ?? opts.rootDir;
  try {
    mkdirSync(opts.rootDir, { recursive: true });
  } catch (err) {
    log.warn(`${opts.label}: 建目录失败:${(err as Error).message}`);
    return report;
  }
  const record = readShippedRecord(recordDir, opts.recordFile);
  let recordDirty = false;

  for (const { rel, body } of files) {
    const abs = join(opts.rootDir, rel);
    const want = shippedHashOf(body);
    let kind: "written" | "upgraded" = "written";
    if (existsSync(abs)) {
      let have: string;
      try {
        have = shippedHashOf(readFileSync(abs, "utf8"));
      } catch (err) {
        log.warn(`${opts.label}: 读 ${rel} 失败,不动它:${(err as Error).message}`);
        report.keptModified.push(rel);
        continue;
      }
      if (have === want) {
        // 已经是这一版(包括只差换行的)。补记录 —— 老安装第一次跑到这里时还没有。
        if (record[rel] !== want) { record[rel] = want; recordDirty = true; }
        continue;
      }
      const pristine = record[rel] === have || (opts.legacyHashes?.[rel] ?? []).includes(have);
      if (!pristine) {
        report.keptModified.push(rel);
        log.warn(`${opts.label}: ${rel} 被改过,不覆盖 —— 它拿不到新版的修复(想要新版就删掉它再重启)`);
        continue;
      }
      kind = "upgraded";
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
      if (opts.executableExts?.some((ext) => rel.endsWith(ext))) {
        // 可执行位:非 Windows 上直接 ./x.py 就能跑。Windows 忽略它,不影响。
        try {
          chmodSync(abs, 0o755);
        } catch {
          /* 文件系统不支持就跳过 */
        }
      }
      report[kind].push(rel);
      record[rel] = want;
      recordDirty = true;
    } catch (err) {
      log.warn(`${opts.label}: 写 ${rel} 失败:${(err as Error).message}`);
    }
  }

  if (recordDirty) {
    try {
      writeFileSync(join(recordDir, opts.recordFile), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (err) {
      log.warn(`${opts.label}: 写 ${opts.recordFile} 失败:${(err as Error).message}`);
    }
  }
  if (report.upgraded.length > 0) log.info(`${opts.label}: 已把没改过的旧版换成新版:${report.upgraded.join("、")}`);
  return report;
}
