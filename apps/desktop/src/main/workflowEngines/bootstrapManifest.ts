/**
 * 【ARC-006 Gate B / P1-5】**引导脚本的版本与完整性校验**。
 *
 * ## 为什么需要这一层
 *
 * `registry.ts` 从前只在 `bootstrap.cjs` **不存在时**写一次（台账 P1-5）。盘上的
 * 旧版本会被一直使用：修好了当前源码的引导形状，存档目录里的过期 JS 照样执行；
 * 更糟的是外部进程改了这个文件也没有任何东西会发现 —— 数据目录被当成可信代码源。
 *
 * ## 清单形状（`bootstrap.manifest.json`，落在引擎 dataDir）
 *
 * ```json
 * {
 *   "schema": "mcode.workflow-engine.bootstrap/v1",
 *   "engineId": "node-red",
 *   "bootstrap": { "version": 1, "sha256": "<64 hex>", "source": "mcode-registry:BOOTSTRAP" }
 * }
 * ```
 *
 * - `version` 是**引导脚本形态的单调版本号**。每次改 `BOOTSTRAP` 的内容都要 +1；
 *   清单与盘上文件都带版本，宿主可以据此判断盘上是旧版还是被篡改。
 * - `sha256` 是脚本**逐字节**的哈希。比较的是字节，不是解析后的语义 —— 编码/BOM/
 *   换行差异一律算不一致。
 * - `source` 是生成来源的描述（当前恒为 mcode 源码里的常量），只用于诊断，不参与判据。
 *
 * ## 启动时的判定顺序（`ensureEngineBootstrap`）
 *
 *   1. 盘上文件存在且 sha256 == 清单 → **不动它**（不重写，mtime 不变）；
 *   2. 盘上文件存在但哈希不一致（旧版本 / 被外部篡改）→ 备份为
 *      `bootstrap.cjs.bak-<时间戳>`（**旧字节原样**），再原子替换为新版；
 *   3. 盘上文件缺失，或清单缺失 / 损坏 / 版本低于当前 → 同样走「备份（若有）→
 *      原子替换」；清单在任何情况下都会被写成当前版本；
 *   4. 备份或替换任一步失败 → 返回 `{ ok:false, reason }`，**调用方不得启动引擎**，
 *      绝不静默回退去执行盘上的旧代码。
 *
 * ## 引导脚本 vs 用户数据
 *
 * 受管、可被自动升级的**只有** `bootstrap.cjs`（以及本清单）。同一目录下的
 * `flows.json` / `flows_cred.json` / `.config.runtime.json` 等是**用户数据**，
 * 本模块不读、不写、不备份、不删除 —— 有断言钉住。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";

/** 当前引导脚本形态的版本。**改 BOOTSTRAP 内容时 +1**（清单与判据都靠它）。 */
export const BOOTSTRAP_VERSION = 4;

/** 清单文件名（引擎 dataDir 下）。 */
export const BOOTSTRAP_MANIFEST_FILENAME = "bootstrap.manifest.json";

const MANIFEST_SCHEMA = "mcode.workflow-engine.bootstrap/v1";

export interface BootstrapManifest {
  schema: string;
  engineId: string;
  bootstrap: {
    version: number;
    sha256: string;
    source: string;
  };
}

export type BootstrapAction = "unchanged" | "written" | "upgraded" | "restored";

export interface BootstrapEnsureResult {
  ok: boolean;
  /** 实际做了什么：不动 / 首次写入 / 旧版升级 / 篡改恢复。 */
  action: BootstrapAction | null;
  /** 盘上旧文件的备份路径（只有发生了替换才有）。 */
  backupPath: string | null;
  /** 失败原因（ok=false 时必有）。 */
  reason: string | null;
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 字节级哈希 —— 盘上文件比较用这个（编码/BOM/换行差异一律算不一致）。 */
function sha256OfBuffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildManifest(engineId: string, content: string): BootstrapManifest {
  return {
    schema: MANIFEST_SCHEMA,
    engineId,
    bootstrap: {
      version: BOOTSTRAP_VERSION,
      sha256: sha256Of(content),
      source: "mcode-registry:BOOTSTRAP",
    },
  };
}

/**
 * 受管脚本/清单只允许原生普通文件。文件型 symlink 即使当前指向正确字节，
 * 也可能把备份读口引向 dataDir 外部；目录/特殊文件不能被误判为首次安装。
 * lstat 与后续读取仍有 TOCTOU：这不是跨进程锁或 OS 沙箱。
 */
function managedFileExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    // isFile() also returns true for NTFS/POSIX hardlinks. With nlink>1
    // the managed file is shared with an external path even without symlinks:
    // never trust/copy it into backup or mark a linked manifest unchanged.
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("受管引导文件必须是独立普通文件（拒绝软/硬链接及特殊文件）：" + path);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** 读清单：仅真正不存在 / 坏 JSON / 形状不符返回 null；其他读取异常必须拒绝更新。 */
export function readManifest(path: string): BootstrapManifest | null {
  if (!managedFileExists(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const v = value as { schema?: unknown; engineId?: unknown; bootstrap?: unknown };
    if (v.schema !== MANIFEST_SCHEMA || typeof v.engineId !== "string") return null;
    if (typeof v.bootstrap !== "object" || v.bootstrap === null) return null;
    const b = v.bootstrap as { version?: unknown; sha256?: unknown; source?: unknown };
    if (typeof b.version !== "number" || !Number.isInteger(b.version)) return null;
    if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return null;
    if (typeof b.source !== "string") return null;
    return {
      schema: MANIFEST_SCHEMA,
      engineId: v.engineId,
      bootstrap: { version: b.version, sha256: b.sha256, source: b.source },
    };
  } catch {
    return null;
  }
}

/**
 * 同目录原子写。每次写入使用自己的 staging 文件并独占创建，不能使用固定
 * `<path>.tmp`：两个并行引擎启动/上次崩溃留下的 staging 会被互相覆盖，
 * 甚至在 rename 时交错提交错误版本。失败后只清理本次创建的文件。
 */
function atomicWrite(path: string, content: string): void {
  const staging = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(staging, content, { encoding: "utf8", flag: "wx" });
    renameSync(staging, path);
  } catch (err) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* 清理失败不改变结论 */
    }
    throw err;
  }
}

/**
 * 把盘上的引导脚本升级到当前版本（或恢复被篡改的同版文件）。
 *
 * `now` 可注入，只为测试备份文件名的确定性；生产不用传。
 */
export function ensureEngineBootstrap(opts: {
  engineId: string;
  dataDir: string;
  content: string;
  now?: () => Date;
}): BootstrapEnsureResult {
  // 产物加载异常可能返回空字符串。绝不能把空白文件当成「新版本」
  // 替换已经能启动的引擎，甚至落一份声称安装成功的 manifest。
  if (typeof opts.content !== "string" || opts.content.trim().length === 0) {
    return { ok: false, action: null, backupPath: null, reason: "引导脚本内容为空，拒绝安装或覆盖" };
  }
  const bootstrapPath = join(opts.dataDir, "bootstrap.cjs");
  const manifestPath = join(opts.dataDir, BOOTSTRAP_MANIFEST_FILENAME);
  const expectedHash = sha256Of(opts.content);
  const expectedManifest = buildManifest(opts.engineId, opts.content);
  const expectedManifestText = `${JSON.stringify(expectedManifest, null, 2)}\n`;

  let currentBytes: Buffer | null = null;
  try {
    if (managedFileExists(bootstrapPath)) currentBytes = readFileSync(bootstrapPath);
  } catch (err) {
    return { ok: false, action: null, backupPath: null, reason: "引导脚本读取失败：" + String(err) };
  }

  let manifest: BootstrapManifest | null;
  try {
    manifest = readManifest(manifestPath);
  } catch (err) {
    return { ok: false, action: null, backupPath: null, reason: "引导清单读取失败：" + String(err) };
  }
  const manifestMatches = manifest !== null
    && manifest.engineId === opts.engineId
    && manifest.bootstrap.version === BOOTSTRAP_VERSION
    && manifest.bootstrap.sha256 === expectedHash;
  const currentMatches = currentBytes !== null && sha256OfBuffer(currentBytes) === expectedHash;

  if (currentMatches && manifestMatches) {
    return { ok: true, action: "unchanged", backupPath: null, reason: null };
  }

  // 文件已对、只有清单缺失/损坏/落后：只补写清单，**不重写脚本**（避免无谓写盘）。
  if (currentMatches && !manifestMatches) {
    try {
      atomicWrite(manifestPath, expectedManifestText);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`[workflow-engine:${opts.engineId}] 引导脚本清单写入失败：${reason}`);
      return { ok: false, action: null, backupPath: null, reason: `引导脚本清单写入失败：${reason}` };
    }
    log.info(`[workflow-engine:${opts.engineId}] 引导脚本清单已补齐（文件内容本来就一致，未重写脚本）`);
    return { ok: true, action: "written", backupPath: null, reason: null };
  }

  // 判定「发生了什么」：盘上有旧内容时，是旧版本升级，还是同版本被篡改。
  // 无清单的旧布局（P1-5 的原始形态）按升级处理；只有「清单说版本就是当前、
  // 哈希却对不上」才算篡改恢复。
  const isUpgrade = currentBytes !== null
    && (manifest === null || manifest.bootstrap.version < BOOTSTRAP_VERSION);
  const action: BootstrapAction = currentBytes === null
    ? "written"
    : isUpgrade
      ? "upgraded"
      : "restored";

  let backupPath: string | null = null;
  try {
    if (currentBytes !== null) {
      const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
      // 同一毫秒可发生多次升级/恢复。旧的仅时间戳文件名会覆盖先前
      // 的原始备份，违背每次升级都可逆。UUID + COPYFILE_EXCL 双重防撞。
      backupPath = `${bootstrapPath}.bak-${stamp}-${randomUUID()}`;
      // 用字节级复制，且绝不覆盖已有历史备份。
      copyFileSync(bootstrapPath, backupPath, constants.COPYFILE_EXCL);
    }
    atomicWrite(bootstrapPath, opts.content);
    atomicWrite(manifestPath, expectedManifestText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      `[workflow-engine:${opts.engineId}] 引导脚本${action === "restored" ? "恢复" : "升级"}失败：${reason}`,
    );
    return { ok: false, action: null, backupPath, reason: `引导脚本写入失败：${reason}` };
  }

  const detail = manifest === null
    ? "清单缺失或损坏"
    : manifestMatches
      ? "文件内容与清单哈希不符（外部篡改）"
      : `清单与当前版本不符（盘上 v${manifest.bootstrap.version}，当前 v${BOOTSTRAP_VERSION}）`;
  if (action === "restored") {
    log.warn(`[workflow-engine:${opts.engineId}] 引导脚本已恢复：${detail}；旧文件备份为 ${backupPath}`);
  } else {
    log.info(
      `[workflow-engine:${opts.engineId}] 引导脚本${action === "written" ? "写入" : "升级到 v" + BOOTSTRAP_VERSION}：${detail}${backupPath === null ? "" : `；旧文件备份为 ${backupPath}`}`,
    );
  }
  return { ok: true, action, backupPath, reason: null };
}
