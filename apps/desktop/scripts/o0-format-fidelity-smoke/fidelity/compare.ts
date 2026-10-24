/**
 * O0 —— 旅程共用的**保真检查步骤**（跑在探针主进程里）。
 *
 * 每条 O0 旅程的形状（卡 §2.2 的三步）：
 *
 *   1. `open → record 基线指纹`（`baseline()`，存进证据目录的 JSON）
 *   2. `只改一处与复杂部件无关的内容`（各旅程自己的编辑步骤，和 t7 一样走真页面桥）
 *   3. `保存 → 关闭 → 重开 → compare`（`compare()`，读基线 + 现文件，逐项比对）
 *
 * ## 证据落在磁盘上，不只落进 observed
 *
 * `journey-result.json` 的 observed 会截断大对象（证据框架的目的不是当数据仓库）。
 * 所以基线指纹与比对结果各自写一份 JSON 到 `evidenceDir/o0/`，红绿表可以由
 * 这些文件**逐条重建**，不依赖某一次运行的控制台输出。
 *
 * ## 为什么比较在**重开之后**做
 *
 * 卡 §2.2 第 3 步是「保存 → 关闭 → 重开 → 逐项比对」。重开之前比的是内存态，
 * 那证明不了「写回磁盘的字节是对的」；本套件的所有 compare 都发生在 relaunch
 * 之后的新进程里，读的是**新进程从磁盘读到的文件**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { diffFingerprints, fingerprint, type DiffEntry, type Fingerprint, type FingerprintOptions, type FormatKind } from "../fidelity/fingerprint.js";

export interface O0CompareResult {
  ok: boolean;
  format: FormatKind;
  /** 基线文件（保存前拷贝）与现文件（保存后）。 */
  baselineFile: string;
  currentFile: string;
  /** 逐项结果；红绿表直接由它生成。 */
  entries: DiffEntry[];
  /** 哪些证据项在基线里根本不存在（present=false）—— 这类要单独报「未验证」。 */
  absentInBaseline: string[];
  excluded: string[];
}

/** 把基线指纹写进证据目录；返回基线文件路径（保存前原文件也拷一份在旁边）。 */
export function recordBaseline(
  evidenceDir: string,
  kind: FormatKind,
  file: string,
  repoRoot: string,
  opts?: FingerprintOptions,
): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  return (async () => {
    const dir = join(evidenceDir, "o0");
    mkdirSync(dir, { recursive: true });
    const fp = await fingerprint(kind, file, repoRoot, opts);
    const baselineCopy = join(dir, `${kind}-baseline.bin`);
    writeFileSync(baselineCopy, readFileSync(file));
    const out = join(dir, `${kind}-baseline.json`);
    writeFileSync(out, JSON.stringify({ fingerprint: fp, baselineCopy }, null, 2));
    // 卡 §2.1 的「必须包含」逐项检查：缺任何一项 = 样本本身不合法，
    // **不许**带着缺失基线继续跑（那会让 PASS 只证明「两处都没有」）。
    const byId = new Map(fp.items.map((i) => [i.id, i]));
    const missing = fp.required.filter((id) => byId.get(id)?.present !== true);
    if (missing.length > 0) {
      return {
        ok: false,
        observed: { missing, required: fp.required, items: fp.items.map((i) => ({ id: i.id, present: i.present })) },
        detail: `基线指纹缺**必需**部件：${missing.join(", ")} —— 样本没有造出该复杂部件，后续比对无意义`,
      };
    }
    return {
      ok: true,
      observed: {
        file,
        baselineCopy,
        sha256: fp.sha256,
        required: fp.required,
        items: fp.items.map((i) => ({ id: i.id, present: i.present, where: i.where })),
        excluded: fp.excluded,
      },
    };
  })();
}

/** 重开之后：读基线指纹 + 现文件指纹，逐项比对；结果写进证据目录。 */
export function compareAgainstBaseline(
  evidenceDir: string,
  kind: FormatKind,
  file: string,
  repoRoot: string,
  opts?: FingerprintOptions,
): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  return (async () => {
    const dir = join(evidenceDir, "o0");
    const baselinePath = join(dir, `${kind}-baseline.json`);
    if (!existsSync(baselinePath)) {
      return { ok: false, detail: `基线指纹不存在：${baselinePath}（record 步骤没有执行）` };
    }
    const stored = JSON.parse(readFileSync(baselinePath, "utf8")) as { fingerprint: Fingerprint; baselineCopy: string };
    const after = await fingerprint(kind, file, repoRoot, opts);
    const diff = diffFingerprints(stored.fingerprint, after);
    const result: O0CompareResult = {
      ok: diff.ok,
      format: kind,
      baselineFile: stored.baselineCopy,
      currentFile: file,
      entries: diff.entries,
      absentInBaseline: stored.fingerprint.items.filter((i) => !i.present).map((i) => i.id),
      excluded: stored.fingerprint.excluded,
    };
    writeFileSync(join(dir, `${kind}-compare.json`), JSON.stringify(result, null, 2));
    if (diff.ok) {
      return {
        ok: true,
        observed: {
          compared: diff.entries.length,
          items: diff.entries.map((e) => e.id),
          excluded: result.excluded,
        },
      };
    }
    const bad = diff.entries.filter((e) => e.status !== "same");
    return {
      ok: false,
      // FAIL 的 detail 是「哪一项、哪个 XML path、前后各是什么」——卡 §2.3 的要求
      observed: { failed: bad.map((e) => ({ id: e.id, where: e.where, status: e.status })) },
      detail: bad
        .map((e) => `${e.status.toUpperCase()} ${e.id} @ ${e.where}\n  before=${clip(e.before)}\n  after=${clip(e.after)}`)
        .join("\n"),
    };
  })();
}

function clip(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}…（截断，全文见 o0/${"compare"}.json）` : s;
}

/** 路径解析：`@projectDir/...` → 真实路径（与 runner 的占位符规则一致）。 */
export function projectPath(projectDir: string, name: string): string {
  return join(projectDir, name);
}
