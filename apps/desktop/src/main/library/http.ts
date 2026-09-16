/**
 * 文献库的 HTTP 取数(元数据 API)。
 *
 * ## 为什么是 curl 而不是 fetch
 *
 * undici 的 `fetch` **完全不读代理环境变量** —— `plugins/pluginManager.ts:221`
 * 有同样的记载。用户机器上常驻代理(本机是 `127.0.0.1:7877`),裸 fetch 会静默
 * 绕过代理直连,结果要么 DNS 失败要么挂到超时,而且报出来的是一句毫无信息量的
 * "fetch failed"。
 *
 * curl 像机器上其他工具一样解析代理配置,所以以它为首选。这不是新发明 ——
 * `pluginManager.ts` 的下载路径用同一策略(curl → 必要时剥代理重试 → fetch 兜底),
 * 这里只是把该策略复用到 JSON 取数上。
 *
 * ⚠️ 只处理**公开元数据 API**(Crossref / OpenAlex / arXiv / Europe PMC)。
 * 需要登录态的 PDF 下载走内嵌浏览器,不走这里 —— 见 `downloader.ts` 的说明。
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** 代理连接被拒的 curl 报错特征。只在这种**明确的**代理故障时才绕过代理;
 *  代理在跑但因鉴权/DNS 失败的情况不该绕过,否则会掩盖真正的问题。
 *  (与 pluginManager.ts:175 的同名常量保持一致的判据。) */
const PROXY_REFUSED_RE = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?)\s*port/i;

const DEFAULT_TIMEOUT_MS = 30_000;

/** 文献库对外请求时用的身份。
 *
 *  Crossref 的礼貌池要求 UA 里带一个能联系到人的邮箱 —— 约定是放在 **User-Agent
 *  头**里,不是查询参数(带了约 5 req/s → 10 req/s)。OpenAlex 认的是 `mailto`
 *  查询参数,两处都用到同一个邮箱,所以放在这里由两个模块共用。 */
export const LIBRARY_MAILTO = "mcode-library@localhost";
export const LIBRARY_UA = `McodeLibrary/0.1 (mailto:${LIBRARY_MAILTO})`;

/** 一次请求的结果。`ok` 为 false 时 `error` 一定有人话可看 —— 上层要拿它填
 *  下载任务的 error 字段给用户看。 */
export interface HttpJsonResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一个子进程并收集输出(stdout 按 utf8 转字符串)。带超时强杀。
 *
 *  只是 {@link runBuffer} 的字符串版:spawn、剥代理、超时强杀、finish 幂等守卫
 *  那套逻辑只实现一遍(以前 run/runBuffer 各抄一份约 45 行,除 stdout 类型外
 *  逐行相同),这里只做 Buffer → string 转换。 */
function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; stripProxy: boolean },
): Promise<RunResult> {
  return runBuffer(cmd, args, opts).then((r) => ({
    ok: r.ok,
    code: r.code,
    stdout: r.stdout.toString("utf8"),
    stderr: r.stderr,
  }));
}

/**
 * 取一个 JSON 端点。
 *
 * 顺序:curl(继承代理)→ curl(剥掉代理)→ 直连 fetch 兜底。
 * 第二跳只在第一跳**确实是代理连接被拒**时才走。
 *
 * `accept` 覆盖默认的 `Accept: application/json`。doi.org 的**内容协商**要求
 * `Accept: application/vnd.citationstyles.csl+json` —— 靠 `headers` 是覆盖不掉的:
 * 那会在默认的 Accept 之后**再追加**一个 Accept 头,而服务端按哪个是谁也说不准
 * (RFC 允许合并,实现各异)。所以这里做成替换而不是追加。
 */
export async function fetchJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; accept?: string } = {},
): Promise<HttpJsonResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const accept = opts.accept ?? "application/json";
  const headerArgs = Object.entries(opts.headers ?? {}).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);

  const args = [
    "-sSL", // 静默但仍输出内容;跟随重定向
    "--fail-with-body", // 4xx/5xx 也要拿到 body(错误详情在里面)
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-H",
    `Accept: ${accept}`,
    ...headerArgs,
    url,
  ];

  const first = await run("curl", args, { timeoutMs, stripProxy: false });
  if (first.ok) return parseJson<T>(first.stdout);

  // curl 缺失(极简环境):退回 fetch,并如实告知代理可能不通
  if (/无法启动/.test(first.stderr)) {
    return fetchJsonViaFetch<T>(url, opts);
  }

  if (PROXY_REFUSED_RE.test(first.stderr)) {
    const bypass = await run("curl", args, { timeoutMs, stripProxy: true });
    if (bypass.ok) return parseJson<T>(bypass.stdout);
    return {
      ok: false,
      error: `代理不可用,绕过代理直连也失败:${shorten(bypass.stderr)}`,
    };
  }

  return { ok: false, error: shorten(first.stderr) || `curl 退出码 ${first.code}` };
}

/** 解析 JSON 正文。解析失败不算致命 —— 有些源在异常时返回 HTML 错误页。 */
function parseJson<T>(text: string): HttpJsonResult<T> {
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: `响应不是合法 JSON:${shorten(text)}` };
  }
}

/** 最后兜底:node 的 fetch。**不读代理环境变量**,失败信息里要提示用户这一点。 */
async function fetchJsonViaFetch<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; accept?: string },
): Promise<HttpJsonResult<T>> {
  try {
    const res = await fetch(url, {
      headers: { Accept: opts.accept ?? "application/json", ...opts.headers },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}: ${shorten(text)}` };
    return parseJson<T>(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${msg}(若该地址需要代理,请注意本机缺少 curl 时无法自动走代理)`,
    };
  }
}

/** 把多行报错压成一行并截断 —— 它最终会出现在任务的 error 字段里给用户看。 */
function shorten(s: string, max = 300): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/* ─────────────── 通用请求(POST / 上传 / 下载字节) ─────────────── */

/**
 * 一次原始请求的结果。`body` 是 **Buffer** —— 上传/下载要处理二进制(zip、PDF),
 * 按 utf8 转成字符串会毁掉内容。
 */
export interface HttpRawResult {
  ok: boolean;
  status?: number;
  body?: Buffer;
  error?: string;
}

/** 子进程收集输出的**唯一实现**:stdout 保留为 Buffer(上传/下载要处理二进制,
 *  按 utf8 转成字符串会毁掉内容)。要字符串版用 {@link run}。 */
function runBuffer(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; stripProxy: boolean },
): Promise<{ ok: boolean; code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let env = process.env;
    if (opts.stripProxy) {
      env = { ...process.env };
      for (const k of Object.keys(env)) {
        if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k];
      }
    }
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (r: { ok: boolean; code: number | null; stdout: Buffer; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout: Buffer.alloc(0), stderr: `超时(${opts.timeoutMs}ms)` });
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) =>
      finish({ ok: false, code: null, stdout: Buffer.alloc(0), stderr: `无法启动 ${cmd}: ${e.message}` }),
    );
    child.on("close", (code) =>
      finish({
        ok: code === 0,
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

/**
 * 通用请求:POST / 上传字节 / 下载字节都走它。代理策略与 {@link fetchJson} 一致
 * ——先继承代理,只有在**确实是代理连接被拒**时才剥代理重试,避免掩盖真问题。
 *
 * `body` 是 Buffer 时写临时文件再用 `--data-binary @file` 喂给 curl:命令行参数
 * 传不了 200MB 的 PDF,Windows 上的引号/转义也会把它搞坏。
 *
 * ⚠️ MinerU 明确要求**上传时不要带 Content-Type** —— 所以这里默认不设,要设就由
 * 调用方在 `headers` 里显式给。
 */
export async function curlRaw(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    timeoutMs?: number;
    /** 上传/下载大文件时用(默认 30s 对 200MB 的 PDF 不够)。 */
  } = {},
): Promise<HttpRawResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let bodyFile: string | null = null;
  const cleanup = () => {
    if (bodyFile) {
      try {
        rmSync(bodyFile, { force: true });
      } catch {
        /* 临时文件清不掉不该让请求失败 */
      }
      bodyFile = null;
    }
  };

  const args = [
    "-sS", // 静默进度,但保留报错;不跟随重定向由 -L 控制
    "-L",
    "--fail-with-body",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
  ];
  if (opts.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.headers ?? {})) args.push("-H", `${k}: ${v}`);
  if (opts.body !== undefined) {
    // ⚠️ curl 用 `--data-binary` 时会**自作主张加**一个
    // `Content-Type: application/x-www-form-urlencoded`。
    // 对签名敏感的**预签名上传 URL**(Aliyun OSS 这类)这是致命的:签名是照着
    // "没有 Content-Type"算出来的,凭空多出这个头就 `SignatureDoesNotMatch`。
    // MinerU 的文件上传正是这种情况 —— 它文档里那句「上传文件时无须设置
    // Content-Type」说的其实是「**不许有**」。
    // 所以:调用方没显式指定时,把 curl 默认的那个删掉(`-H "X:"` 是 curl 的
    // "移除这个头"写法)。
    const hasContentType = Object.keys(opts.headers ?? {}).some(
      (k) => k.toLowerCase() === "content-type",
    );
    if (!hasContentType) args.push("-H", "Content-Type:");
    if (typeof opts.body === "string") {
      args.push("--data-binary", opts.body);
    } else {
      bodyFile = join(tmpdir(), `mcode-http-${randomUUID()}.bin`);
      writeFileSync(bodyFile, opts.body);
      args.push("--data-binary", `@${bodyFile}`);
    }
  }
  args.push(url);

  try {
    const first = await runBuffer("curl", args, { timeoutMs, stripProxy: false });
    if (first.ok) return { ok: true, body: first.stdout };
    if (/无法启动/.test(first.stderr)) {
      return { ok: false, error: `本机没有可用的 curl:${shorten(first.stderr)}` };
    }
    if (PROXY_REFUSED_RE.test(first.stderr)) {
      const bypass = await runBuffer("curl", args, { timeoutMs, stripProxy: true });
      if (bypass.ok) return { ok: true, body: bypass.stdout };
      return { ok: false, error: `代理不可用,绕过代理直连也失败:${shorten(bypass.stderr)}` };
    }
    // --fail-with-body:HTTP 错误码时 curl 退出非 0,但 stdout 里带着错误详情
    const detail = first.stdout.length > 0 ? first.stdout.toString("utf8") : first.stderr;
    return { ok: false, status: first.code ?? undefined, error: shorten(detail) };
  } finally {
    cleanup();
  }
}
