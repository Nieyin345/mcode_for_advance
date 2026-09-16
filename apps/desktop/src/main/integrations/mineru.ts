/**
 * MinerU 精准解析接口(`/api/v4`)客户端 —— 把本地 PDF 传上去换回 Markdown。
 *
 * ## 四步流程(官方文档)
 *
 *   1. `POST {base}/api/v4/file-urls/batch`   → `batch_id` + 每份文件的上传链接
 *   2. `PUT  <上传链接>`                       → 传字节。**必须不带 Content-Type**
 *   3. `GET  {base}/api/v4/extract-results/batch/{batch_id}` → 轮询到终态
 *   4. `GET  <full_zip_url>`                   → 解压取 `full.md`
 *
 * 第 2 步之后**不需要**再调一次「提交任务」—— 传完即开始解析。
 *
 * ## 限额与错误码
 *
 * 单文件 200MB / 200 页;每天有优先额度,超出降优先级(不是失败)。
 * `A0202` token 无效 / `A0211` 过期 / `-60005` 超大小 / `-60006` 超页数 /
 * `-60018` 当日额度用尽。
 *
 * ## 为什么走 curlRaw 而不是 fetch
 *
 * MinerU 是境外站点,用户机器上常驻代理。undici 的 fetch 不读代理环境变量 ——
 * 见 `library/http.ts` 顶部的说明。所以这里一律走同一套代理感知的请求层。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { curlRaw, type HttpRawResult } from "@main/library/http.js";
import { log } from "@main/lib/logger.js";
import type { IntegrationTestResult } from "@contracts/integrations";

/** 上传/下载大文件用的超时。200MB 的 PDF 按 30s 是绝对不够的。 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 4000;
/** 单文件硬上限(官方 200MB)。本地再压一道,免得白传一趟。 */
const MAX_BYTES = 200 * 1024 * 1024;

export interface MineruConfig {
  key: string;
  baseUrl: string;
}

type MineruEnvelope<T> = { code: number | string; msg?: string; data?: T };

function parseEnvelope<T>(res: HttpRawResult): { ok: true; data: T } | { ok: false; error: string } {
  if (!res.ok || !res.body) return { ok: false, error: res.error ?? "请求失败" };
  let env: MineruEnvelope<T>;
  try {
    env = JSON.parse(res.body.toString("utf8")) as MineruEnvelope<T>;
  } catch {
    return { ok: false, error: `响应不是合法 JSON:${res.body.toString("utf8").slice(0, 200)}` };
  }
  if (env.code === 0 || env.code === "0") {
    if (env.data === undefined) return { ok: false, error: "响应缺少 data" };
    return { ok: true, data: env.data };
  }
  return { ok: false, error: mineruErrorText(env.code, env.msg) };
}

/** 把错误码翻译成人话。用户看到的应该是「密钥无效」而不是「A0202」。 */
function mineruErrorText(code: number | string, msg?: string): string {
  const table: Record<string, string> = {
    A0202: "密钥无效 —— 检查是不是漏了 `Bearer ` 前缀,或者 token 复制错了",
    A0211: "密钥已过期 —— 去 MinerU 重新生成一个",
    "-60005": "文件超过 200MB 上限",
    "-60006": "页数超过 200 页上限",
    "-60018": "当日额度已用尽(次日恢复)",
    "-60019": "HTML 配额已用尽",
  };
  const human = table[String(code)];
  return human ? `${human}(${code})` : `${msg || "MinerU 报错"}(${code})`;
}

/* ── 连通性测试 ── */

/**
 * 验证密钥是否可用。
 *
 * ⚠️ MinerU 没有专门的「whoami」接口,所以这里用**查一个不存在的批次**来探:
 * 密钥无效会回 `A0202`/`A0211`,密钥有效则会回一个「批次不存在」之类的业务错误。
 * 也就是说 —— 判断依据是「**没有**报鉴权错」,这能可靠地区分密钥好坏,但**不能**
 * 证明解析额度可用。真正的证明是跑一次转换。这里如实把这一点写进提示文案。
 */
export async function mineruTest(cfg: MineruConfig): Promise<IntegrationTestResult> {
  const at = Date.now();
  if (!cfg.key) {
    return { ok: false, message: "还没有填写密钥", at };
  }
  const res = await curlRaw(`${cfg.baseUrl}/api/v4/extract-results/batch/mcode-key-probe`, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
    timeoutMs: 20_000,
  });
  if (!res.ok || !res.body) {
    return { ok: false, message: `连不上 MinerU:${res.error ?? "无响应"}`, at };
  }
  let env: MineruEnvelope<unknown>;
  try {
    env = JSON.parse(res.body.toString("utf8")) as MineruEnvelope<unknown>;
  } catch {
    return { ok: false, message: "响应不是合法 JSON —— 可能被代理/门户拦截了", at };
  }
  if (env.code === 0 || env.code === "0") {
    return { ok: true, message: "密钥可用(未能验证额度)", at };
  }
  if (env.code === "A0202" || env.code === "A0211") {
    return { ok: false, message: mineruErrorText(env.code, env.msg), at };
  }
  // 非鉴权类错误 = 密钥过了鉴权这一关
  return { ok: true, message: "密钥可用(未能验证额度)", at };
}

/* ── 转换 ── */

export type MineruConvertResult =
  | { ok: true; /** 解出来的 `full.md` 的绝对路径(同目录下还有 `images/`) */ markdownPath: string }
  | { ok: false; error: string };

/**
 * 把一个本地 PDF 转成 Markdown,产物落到 `destDir`。
 *
 * ⚠️ **不只是 `full.md`** —— MinerU 的包里还有 `images/`,而 `full.md` 正文引用了
 * 几十处 `![](images/xxx.jpg)`。所以整个包要一起落地,否则 md 里全是断链(实测踩过:
 * 只捞 `full.md` 把图丢了,用户看到的就是"没有图床")。
 *
 * 全程异步、可中断(轮询有总超时),失败一律返回人话错误而不是抛 —— 调用方(导入
 * 流程)要能"转换失败但 PDF 照样入库"。
 */
export async function mineruConvert(
  cfg: MineruConfig,
  filePath: string,
  destDir: string,
): Promise<MineruConvertResult> {
  const data = readFileSync(filePath);
  if (data.length > MAX_BYTES) {
    return { ok: false, error: `文件 ${(data.length / 1024 / 1024).toFixed(0)}MB 超过 200MB 上限` };
  }
  const name = basename(filePath);

  // 1. 申请上传链接
  const createRes = await curlRaw(`${cfg.baseUrl}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      // 模型版本用官方推荐的 vlm;不显式要求 OCR(有文本层的 PDF 不需要)
      model_version: "vlm",
      files: [{ name }],
    }),
    timeoutMs: 60_000,
  });
  const created = parseEnvelope<{ batch_id: string; file_urls: string[] }>(createRes);
  if (!created.ok) return { ok: false, error: created.error };
  const batchId = created.data.batch_id;
  const uploadUrl = created.data.file_urls?.[0];
  if (!batchId || !uploadUrl) return { ok: false, error: "MinerU 没有返回上传链接" };

  // 2. PUT 文件。**不要设 Content-Type** —— 官方明确要求,设了会被拒
  const putRes = await curlRaw(uploadUrl, {
    method: "PUT",
    body: data,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (!putRes.ok) {
    return { ok: false, error: `上传失败:${putRes.error ?? `HTTP ${putRes.status}`}` };
  }

  // 3. 轮询
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let zipUrl: string | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await curlRaw(`${cfg.baseUrl}/api/v4/extract-results/batch/${batchId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
      timeoutMs: 30_000,
    });
    const polled = parseEnvelope<{
      extract_result?: Array<{ state?: string; full_zip_url?: string; err_msg?: string }>;
    }>(pollRes);
    if (!polled.ok) return { ok: false, error: polled.error };
    const first = polled.data.extract_result?.[0];
    if (!first) continue;
    if (first.state === "failed") {
      return { ok: false, error: `MinerU 解析失败:${first.err_msg || "未给出原因"}` };
    }
    if (first.state === "done") {
      zipUrl = first.full_zip_url ?? null;
      break;
    }
    // waiting-file / pending / running / converting → 继续等
  }
  if (!zipUrl) return { ok: false, error: "等待 MinerU 解析超时(15 分钟)" };

  // 4. 下载 zip 并整包解到 destDir
  return downloadAndUnzip(zipUrl, batchId, destDir);
}

async function downloadAndUnzip(
  zipUrl: string,
  batchId: string,
  destDir: string,
): Promise<MineruConvertResult> {
  const zipRes = await curlRaw(zipUrl, { method: "GET", timeoutMs: UPLOAD_TIMEOUT_MS });
  if (!zipRes.ok || !zipRes.body) {
    return { ok: false, error: `下载解析结果失败:${zipRes.error ?? `HTTP ${zipRes.status}`}` };
  }
  const tmpBase = join(tmpdir(), `mcode-mineru-${batchId}`);
  const zipPath = `${tmpBase}.zip`;
  // 先解到 staging,成了再**整体搬到 destDir** —— 半途失败不会在库里留下半套文件
  const staging = `${tmpBase}.staging`;
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(zipPath, zipRes.body);
    // 先确认拿到的是真正的 zip(`PK` 魔数)。MinerU 出错时可能返回一段 JSON/HTML,
    // 那种情况下"解压失败"是个误导性的说法 —— 直接说清楚更好定位。
    const magic = zipRes.body.subarray(0, 2).toString("latin1");
    if (magic !== "PK") {
      log.warn(`mineru: result is not a zip (magic=${JSON.stringify(magic)}, ${zipRes.body.length}B)`);
      return {
        ok: false,
        error: `下载到的不是 zip(${zipRes.body.length} 字节,开头是 ${JSON.stringify(magic)})`,
      };
    }
    const extracted = await extractZip(zipPath, staging);
    if (!extracted.ok) {
      log.warn(`mineru: unzip failed (${zipRes.body.length}B): ${extracted.error}`);
      return { ok: false, error: `解析结果解压失败(${extracted.error})` };
    }
    const mdInStaging = findFullMd(staging);
    if (!mdInStaging) return { ok: false, error: "解析结果里没有 full.md" };
    // full.md 在 staging 里的相对位置,搬到 destDir 后原样成立 —— 所以
    // `images/…` 这类相对引用不会断。
    const rel = relative(staging, mdInStaging);

    mkdirSync(dirname(destDir), { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    moveDirInto(staging, destDir);
    log.info(`mineru: extracted ${rel} into ${destDir}`);
    return { ok: true, markdownPath: join(destDir, rel) };
  } catch (err) {
    return { ok: false, error: `处理解析结果出错:${(err as Error).message}` };
  } finally {
    // 只清中转文件;destDir 是最终产物,不能碰
    for (const p of [zipPath, staging]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* 清不掉不影响结果 */
      }
    }
  }
}

/**
 * 把 `src` 目录整体搬到 `dest`。
 *
 * **不能只用 `rename`。** Windows 上跨盘的 rename 会抛
 * `EXDEV: cross-device link not permitted`,而这里两个路径**天生很可能不在同一个盘**:
 * staging 在**系统临时目录**(通常 C:),`destDir` 在用户设的**数据根**(可能是 D:、
 * 外置盘、网络盘)。实测用户机器正是 C: → D: —— MinerU 明明解析成功了,却在最后
 * **搬不动**这一步失败,整条链路退回本地 pdf.js,用户拿到的是没有公式和排版的一坨
 * 纯文本(而且日志里只有一句 "falling back",不细看根本不知道是这里断的)。
 *
 * 所以先试 rename(同盘时是瞬时的原子操作),不行就退回复制 + 删除。
 */
function moveDirInto(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    // 跨盘是预期内的;Windows 上偶尔还会是 EPERM 之类 —— 一律退回复制。
    // 复制再失败就让调用方的 catch 报出去(它会把 message 带给用户)。
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** 在解压目录里找 full.md(官方保证有,但结果可能在子目录里)。 */function findFullMd(dir: string): string | null {
  const direct = join(dir, "full.md");
  if (existsSync(direct)) return direct;
  // 退一步:按目录名递归找一层(结果通常铺在根,个别情况在 <name>/ 下)
  try {
    const entries = readdirSync(dir);
    for (const e of entries) {
      const nested = join(dir, e, "full.md");
      if (existsSync(nested)) return nested;
    }
  } catch {
    /* 交给调用方报「没有 full.md」 */
  }
  return null;
}

/**
 * 找系统的 bsdtar。
 *
 * ⚠️ **不能直接 `spawn("tar")`**。Windows 上 PATH 里先出现的很可能是 **Git 自带的
 * GNU tar**(`/usr/bin/tar`),而 **GNU tar 根本不认 zip**,会报
 * "This does not look like a tar archive"。Windows 自带的
 * `%SystemRoot%\System32\tar.exe` 才是 bsdtar,解 zip 没问题。
 *
 * 实测踩过:从 Git Bash 启动应用时 PATH 里 Git 的 usr/bin 在前,于是解压必失败;
 * 从 PowerShell 启动时 System32 在前,又能用 —— 这种"看启动方式决定成败"的行为
 * 必须消掉,所以这里显式钉死 System32 那个。
 *
 * (Linux 的 GNU tar 同样不认 zip。真要跨平台,得换成纯 JS 的 zip 读取 —— 那时再说,
 *  目前先把 Windows 这条主路径做对。)
 */
function resolveTar(): string {
  if (process.platform === "win32" && process.env.SystemRoot) {
    const sys = join(process.env.SystemRoot, "System32", "tar.exe");
    if (existsSync(sys)) return sys;
  }
  return "tar";
}

/** 系统 tar 解 zip。失败时**连 stderr 一起带回来** —— 上一版只返回一个布尔,
 *  结果线上只能看到"解压失败"四个字,根本不知道是路径不对、格式不对还是没装。 */
function extractZip(
  zipPath: string,
  destDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const tar = resolveTar();
    const child = spawn(tar, ["-xf", zipPath, "-C", destDir], { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (e) => resolve({ ok: false, error: `无法执行 ${tar}:${e.message}` }));
    child.on("close", (code) =>
      code === 0
        ? resolve({ ok: true })
        : resolve({ ok: false, error: `${tar} 退出码 ${code}:${stderr.trim().slice(0, 200) || "(无输出)"}` }),
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
