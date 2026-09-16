/**
 * 调用本地的 **paper-fetch** —— 用户原来那套下载脚本,原样搬进
 * `<数据根>/workflows/scripts/paper-fetch/`。
 *
 * ## 为什么是「调脚本」而不是再实现一遍
 *
 * 这个脚本已经把「一个 DOI 去哪儿找开放获取 PDF」这件事做透了:Unpaywall / OpenAlex /
 * Semantic Scholar / arXiv / PMC / Europe PMC / OpenAIRE / bioRxiv / 出版商直链模板,
 * 还有 6 秒级的按源回退与失败分类。原作者对每一条路的坑都写在注释里(比如 PMC 会用
 * 工作量证明页挡直链,所以要改走 Europe PMC 的 `?pdf=render`)。重写一遍只会丢掉这些
 * 细节 —— 所以**整份搬过来直接调**。
 *
 * ## 它的角色:Mcode 下载链路的**第一候选来源**
 *
 * `downloader.ts` 自己也能解析(arXiv / 出版商模板 / OpenAlex),但那是"一次机会"。
 * 这里把它的 `--dry-run` 结果当候选喂回去,再走 Mcode 本来就有的**内嵌浏览器下载**
 * —— 后者带会话 cookie,机构订阅的直链才下得动。分工是:
 *
 *     paper-fetch 负责「找」(它更会找)  +  Mcode 负责「下」(它带登录态)
 *
 * ## 两条刻意的限制
 *
 * ① **永远不发 Sci-Hub。** 脚本默认会去 sci-hub.* 那一串镜像找盗版副本。这个仓库
 *    搬过来的其他部分都是合法的开放获取渠道,Sci-Hub 不是 —— 所以调用时固定带上
 *    `PAPER_FETCH_NO_SCIHUB=1`(脚本作者自己留的开关),无论用户怎么配。除了合规,
 *    它每命中一次失败要白等 8~9 秒,对失败的那些 DOI 是纯浪费。
 *
 * ② **不阻断。** 机器上没有 Python、脚本被删了、跑超时 —— 一律返回空数组,由调用方
 *    继续走自己的链路。这只是"多问一个更会找的朋友",不是必需依赖。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";
import { scriptsDir } from "@main/workflows/seed.js";

/** paper-fetch 的目录名(在 `<数据根>/workflows/scripts/` 下)。 */
const PAPER_FETCH_DIR = "paper-fetch";

/** 单次运行的墙钟上限。
 *
 *  脚本内部按源**串行**回退,真实的慢来自网络而不是计算:实测一条 2~4 秒,但偶发
 *  某个源挂住时会拖到 30 秒以上。所以除了这里的总上限,还给脚本传了
 *  `--timeout`(单请求上限)—— 两层都要有:单请求不受限的话,总上限只会把已经
 *  跑出结果的工作一起丢掉。 */
const TIMEOUT_MS = 60_000;

/** 传给脚本的单请求超时(秒)。它自己的默认是 30 —— 对交互式的下载队列来说太长。 */
const PER_REQUEST_TIMEOUT_S = 15;

export function paperFetchScriptPath(): string {
  return join(scriptsDir(), PAPER_FETCH_DIR, "paper_fetch.py");
}

/** 这台机器上可用的 Python 解释器。按顺序试,全都没有就返回 null。 */
let cachedPython: string | null | undefined;

function findPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const exe of candidates) {
    // 探测只为确认解释器存在;真正的调用走下面的异步 spawn。
    const r = spawnSync(exe, ["--version"], { windowsHide: true, timeout: 10_000 });
    if (r.status === 0) {
      cachedPython = exe;
      return exe;
    }
  }
  cachedPython = null;
  return null;
}

/** paper-fetch 给出的一条候选。`via` 是它的来源名(arxiv / europe_pmc / mdpi_cdn…),只用于日志。 */
export interface PaperFetchCandidate {
  url: string;
  via: string;
}

/** `--format json` 对**单条 DOI** 的输出形状(实测,cli 0.16.0):
 *
 * ```json
 * {"ok":true,"data":{"results":[{"doi":"…","success":true,"source":"europe_pmc",
 *   "pdf_url":"https://europepmc.org/articles/PMC…?pdf=render",
 *   "candidates":[{"source":"europe_pmc","url":"…"},{"source":"pmc","url":"…"}]}],
 *   "summary":{…}},"meta":{…}}
 * ```
 *
 * 注意 `candidates` 是**脚本自己按优先级排好的完整候选表**,比单个 `pdf_url` 有用得多
 * —— 直接拿它当候选列表。批量模式输出的是逐行 NDJSON 而不是这个信封,所以下面两种
 * 形状都认。 */
interface PaperFetchResult {
  success?: boolean;
  source?: string;
  pdf_url?: string;
  candidates?: Array<{ source?: string; url?: string }> | null;
}

/** 从一个 result 对象里取出候选(优先用完整的 `candidates` 表)。 */
function candidatesOf(r: PaperFetchResult): PaperFetchCandidate[] {
  const out: PaperFetchCandidate[] = [];
  for (const c of r.candidates ?? []) {
    if (c?.url) out.push({ url: c.url, via: `paper-fetch:${c.source ?? "?"}` });
  }
  if (out.length === 0 && r.pdf_url) {
    out.push({ url: r.pdf_url, via: `paper-fetch:${r.source ?? "?"}` });
  }
  return out;
}

/** 从一整段 stdout 里收集候选 —— 信封与 NDJSON 两种形状都处理。 */
function collectCandidates(stdout: string): PaperFetchCandidate[] {
  const out: PaperFetchCandidate[] = [];
  const seen = new Set<string>();
  const push = (cands: PaperFetchCandidate[]) => {
    for (const c of cands) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  };

  // 形状一:整个 stdout 就是一个 JSON 信封(单条 DOI)
  const whole = tryJson<{ data?: { results?: PaperFetchResult[] } }>(stdout);
  if (whole?.data?.results) {
    for (const r of whole.data.results) push(candidatesOf(r));
    if (out.length > 0) return out;
  }

  // 形状二:逐行 NDJSON(批量 / --stream)。只认 dry_run 那条 —— 它是"最终选定"的
  // 结果;source_hit 也带 pdf_url,但那是各源各自命中的中间态。
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const evt = tryJson<PaperFetchResult & { event?: string }>(trimmed);
    if (!evt) continue;
    if (evt.event === "dry_run") push(candidatesOf(evt));
    else if (evt.candidates) push(candidatesOf(evt));
  }
  return out;
}

function tryJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 让 paper-fetch **真的去下载**一篇 —— 返回它落盘的 PDF 绝对路径。
 *
 * ## 为什么下载也交给它,而不是走 Mcode 的内嵌浏览器
 *
 * 一开始只借它的「找地址」(`--dry-run`),下载仍走 Mcode 的浏览器会话 —— 结果在
 * 出版商站点上全线失败:Nature / Wiley / ScienceDirect 这些站点**既不是付费墙,也没有
 * 下载按钮**,点开是在浏览器里内联渲染出 PDF,而且挂着 Cloudflare 人机检测。
 * 程序化的 `session.downloadURL()` 对它们要么挂到超时、要么被 0 字节中断。
 *
 * 而这个脚本**本来就是干这件事的**,而且干得比我们好:它有自己的 UA 与 cookie 罐、
 * 重定向安全检查、大小上限、`%PDF` 魔数自检(不合格会标 `not_a_pdf` 并换下一个源),
 * 还有机构 EZproxy(`institutional_download.py`)与通过 CDP 复用已登录浏览器
 * (`cdp_download.mjs`)两条备用通道。
 *
 * 实测:Nat. Commun. 那篇先试 nature.com 直链 → 自检 `not_a_pdf` → 自动换 Europe PMC
 * 的渲染端点 → **9 秒拿到 4MB 的真 PDF**。这就是"用成熟的,别自己写"。
 */
export async function downloadViaPaperFetch(
  doi: string,
  outDir: string,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  const script = paperFetchScriptPath();
  if (!existsSync(script)) return { ok: false, error: "paper-fetch 脚本不存在" };
  const python = findPython();
  if (!python) return { ok: false, error: "本机没有可用的 Python 解释器" };

  const stdout = await runPython(python, [
    script,
    doi,
    "--out",
    outDir,
    "--format",
    "json",
    "--timeout",
    String(PER_REQUEST_TIMEOUT_S),
  ]);
  if (!stdout) return { ok: false, error: "paper-fetch 没有返回结果" };

  const parsed = tryJson<{
    ok?: boolean;
    error?: { code?: string; message?: string };
    data?: {
      results?: Array<{
        success?: boolean;
        file?: string;
        error?: { code?: string; message?: string };
      }>;
    };
  }>(stdout);
  const r = parsed?.data?.results?.[0];
  if (r?.success && r.file) return { ok: true, file: r.file };
  // 失败形状有两种:有 results 时错在 result.error 里;整篇没找到时是**信封**上的
  // `ok:false` + `error.message`(比如 "No open-access PDF found")。两种都要取到,
  // 否则用户只会看到一句"没能下载到这一篇",不知道到底是没找到还是下载坏了。
  const detail = r?.error?.message ?? r?.error?.code ?? parsed?.error?.message ?? parsed?.error?.code;
  return { ok: false, error: detail ?? "paper-fetch 没能下载到这一篇" };
}

/**
 * 让 paper-fetch 解析一个 DOI,拿回它认为可下载的直链(按它自己的优先级)。
 *
 * 用 `--dry-run`:**只要地址,不要文件** —— 真正的下载交给 Mcode 的内嵌浏览器,
 * 那里才有用户的登录态。脚本自己下的话是 urllib,既没有 cookie 也没有代理配置。
 *
 * 解析不出/跑不起来都返回 `[]`。
 */
export async function resolveViaPaperFetch(doi: string): Promise<PaperFetchCandidate[]> {
  const script = paperFetchScriptPath();
  if (!existsSync(script)) {
    // 脚本不在 = 还没落到数据根。不是错误(增强功能缺席),但要说一声,
    // 否则「为什么这条链路一直没生效」会变成一个查不出来的问题。
    log.warn(`paper-fetch 脚本不存在,跳过:${script}`);
    return [];
  }
  const python = findPython();
  if (!python) {
    log.warn("本机没有可用的 Python 解释器,paper-fetch 这条链路跳过。");
    return [];
  }

  const stdout = await runPython(python, [
    script,
    doi,
    "--dry-run",
    "--format",
    "json",
    "--timeout",
    String(PER_REQUEST_TIMEOUT_S),
  ]);
  if (!stdout) return [];
  return collectCandidates(stdout);
}

/** 跑一次 paper-fetch。失败/超时都返回 null 并把原因记进日志(不抛)。 */
function runPython(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // 见文件头:盗版镜像一律不发,与用户配置无关。
        PAPER_FETCH_NO_SCIHUB: "1",
        // Unpaywall 要求一个**真实**邮箱(示例邮箱会被 422 拒掉),而它是脚本里
        // 字段最全的一个源。用户配了就透传,没配就让脚本自己跳过那一路 ——
        // 不替用户编一个假邮箱去撞人家的接口。
        ...(process.env.UNPAYWALL_EMAIL ? { UNPAYWALL_EMAIL: process.env.UNPAYWALL_EMAIL } : {}),
        // Windows 上 Python 默认按 GBK 写 stdout,事件流里的中文会乱码。
        PYTHONIOENCODING: "utf-8",
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (r: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      log.warn(`paper-fetch 超时(${TIMEOUT_MS}ms),跳过`);
      finish(null);
    }, TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      log.warn(`paper-fetch 无法启动(${exe}):${e.message}`);
      finish(null);
    });
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8");
      // 判据是「stdout 里有没有 JSON」,**不是退出码**。退出码 1 表示「没有开放获取
      // 副本」—— 那是一个正常结果(信封里 `ok:false` 并带着每个源为什么没命中),
      // 不是运行失败。把它当失败丢掉,只会让"这一篇确实没有免费版本"和"脚本跑坏了"
      // 变成同一件事。
      const hasJson = text.trim().startsWith("{");
      if (!hasJson) {
        const detail = Buffer.concat(err).toString("utf8").trim().replace(/\s+/g, " ");
        log.warn(
          code === 0
            ? `paper-fetch 没有输出:${detail.slice(0, 200)}`
            : `paper-fetch 退出码 ${code}(非正常结果):${detail.slice(0, 200)}`,
        );
        finish(null);
        return;
      }
      finish(text);
    });
  });
}

/** 预热:把解释器探测挪到启动路径之外,免得第一次下载多等一次 spawn。 */
export function warmUpPaperFetch(): void {
  if (existsSync(paperFetchScriptPath())) findPython();
}
