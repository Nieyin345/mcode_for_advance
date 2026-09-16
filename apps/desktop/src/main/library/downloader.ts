/**
 * 文献下载管道。
 *
 * ## 设计要点(读之前先看这三条)
 *
 * 1. **下载走内嵌浏览器,不自己发 HTTP。** 主进程的裸 `fetch`(undici)
 *    既不带会话 cookie 也不读代理环境变量 —— 付费文献一个都下不了。
 *    唯一能带上 cookie 的通道是共享分区,所以走 `downloadViaBrowser`
 *    (内部是 `session.downloadURL`,由 Chromium 处理 cookie/代理/重定向)。
 *
 * 2. **拿到文件必须校验。** 认证过期时 Chromium 不报错,它会老老实实把一个
 *    登录页 HTML 存下来,状态同样是 "completed"。所以必须验 `%PDF` 魔数,
 *    并把疑似登录页的情况归类为 `needs_login`(一等状态,提示用户去重新登录),
 *    而不是让它变成一个打不开的"PDF"躺在库里。
 *
 * 3. **失败要分类,因为处理方式不同。** `needs_login` 不自动重试(等用户操作);
 *    `rate_limited` / 网络类退避后可重试;`not_found` 换下一个来源。
 *    把它们混成一个 "failed" 会让用户不知道该做什么。
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LibraryItem, DownloadStatus } from "@contracts/library";
import { LibraryRepo, DownloadJobRepo } from "@main/store/repositories.js";
import { downloadViaBrowser, printUrlToPdf } from "@main/browser/BrowserManager.js";
import { log } from "@main/lib/logger.js";
import { sendToRenderer } from "@main/window.js";
import { arxivIdFromDoi, resolvePdfCandidates } from "./oaResolvers.js";
import { downloadViaPaperFetch } from "./paperFetch.js";
import { IPC } from "@contracts/ipc";
import {
  ensureLibraryDirs,
  downloadConcurrency,
  pdfPathForHash,
  tempDownloadPath,
  toLibraryRelative,
} from "./paths.js";

/** 小于这个字节数的一定不是有效 PDF(arXiv 最小的论文也有几十 KB)。 */
const MIN_PDF_BYTES = 1024;

/**
 * **单个候选地址**的下载上限,20 秒。
 *
 * 这个数是从实测来的:真正能下的候选(arXiv / PMC / Europe PMC 那些开放获取副本)
 * 下完 2.4MB 只用了 **0.5 秒**;而会卡住的那些 —— 出版商站点的反爬质询页 ——
 * **给多久都不会完成**,它们只是安静地挂在那里。
 *
 * 队列是**串行**的(共用同一个浏览器会话),所以一条卡住的候选会拖住后面所有任务:
 * 60 秒 × 七八个候选 = 十几分钟,用户看到的就是「点了一直没反应」。20 秒足够覆盖
 * 慢网络上的正常 PDF,又让卡住的候选尽快让位给下一个。
 */
const CANDIDATE_TIMEOUT_MS = 20_000;

/** 「打印成 PDF」那条兜底的路的上限。比直连下载宽松 —— 它要真的把页面渲染出来
 *  (含 PDF 查看器),慢一些是正常的;而且它只在最后一步跑,不会拖累别的候选。 */
const PRINT_TIMEOUT_MS = 45_000;

/** 判断下载到的内容是不是登录/错误页而不是 PDF。
 *  认证过期时这是**预期**结果,不是异常 —— 所以要能认出来。 */
function looksLikeHtml(buf: Buffer): boolean {
  // 只嗅前 512 字节:HTML 的文档类型/根标签一定在最前面
  const head = buf.subarray(0, 512).toString("utf8").toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.includes("<head");
}

/** 只读文件开头 n 字节。校验只需要魔数,不该把整个 PDF 读进内存。 */
function readHead(filePath: string, n: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * 校验下载产物。返回 null 表示通过,否则返回失败原因与归类。
 *
 * 这是整个管道里**最重要的一段代码** —— 少了它,用户会得到一库打不开的文件,
 * 而且完全不知道问题出在登录态过期上。
 */
export function verifyPdf(
  filePath: string,
): { status: DownloadStatus; error: string } | null {
  let size = 0;
  let buf: Buffer;
  try {
    size = statSync(filePath).size;
    buf = readHead(filePath, 512);
  } catch (err) {
    return { status: "failed", error: `无法读取下载文件:${(err as Error).message}` };
  }

  if (size < MIN_PDF_BYTES) {
    return { status: "failed", error: `文件过小(${size} 字节),不是有效 PDF` };
  }
  // %PDF 魔数是判定 PDF 的唯一可靠依据 —— 只看扩展名会被 .pdf 结尾的错误页骗过
  if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
    if (looksLikeHtml(buf)) {
      return {
        status: "needs_login",
        error: "拿到的是网页而不是 PDF,通常是登录态已过期。请在内嵌浏览器里重新登录后重试。",
      };
    }
    return { status: "failed", error: "下载内容不是 PDF(缺少 %PDF 文件头)" };
  }
  return null;
}

/** 算整个文件的 sha256(内容寻址的键)。 */
export function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * 解析出可下载的 PDF 地址。
 *
 * v1 支持两条明确可靠的路径:
 *   - arXiv ID → `arxiv.org/pdf/<id>`(开放获取,无需认证)
 *   - 元数据里已带的、以 `.pdf` 结尾的 URL(来自检索结果或用户提供)
 *
 * 刻意**没有**做 OpenAlex/Unpaywall 的开放获取解析:前者 2026 年起强制 API key,
 * 后者需要一个真实邮箱。两者都是「需要用户先配置」的依赖,不该挡在开箱可用路径上。
 * 出版商落地页的 PDF 地址也不做自动嗅探 —— 那需要针对每个出版商写解析规则,
 * 维护成本远高于收益。这类文献让用户在内嵌浏览器里打开页面、点一次下载,
 * 或者把 PDF 地址直接给 AI。
 */
/**
 * 形如 PDF 直链的地址。
 *
 * 不只看 `.pdf` 结尾 —— 好几个大出版商的直链根本不以 `.pdf` 收尾:
 *   Nature     https://www.nature.com/articles/s41567-...-.pdf        (.pdf)
 *   Wiley      https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/...
 *   TechRxiv   https://www.techrxiv.org/doi/pdf/10.36227/...
 *   arXiv      https://arxiv.org/pdf/2302.01934
 *   MDPI       https://www.mdpi.com/2076-3417/15/3/1308/pdf?version=...
 *   Elsevier   https://www.sciencedirect.com/science/article/pii/S.../pdfft
 * 这些 URL 是**开放获取解析器或出版商模板给的**,本来就保证是 PDF 而不是落地页 ——
 * 所以按形状放行,不要再要求 `.pdf` 后缀把它们全挡掉。
 * (实测:只用 `.pdf$` 时,Wiley / TechRxiv / arXiv / MDPI / Elsevier 那几个明明拿到了
 * 直链,却依然被判成"落地页"下不了。)
 */
export const PDF_URL_RE = /\.pdf(\?|$)|\/pdf\/|\/pdfdirect\/|\/pdf\?|\/pdfft/i;

/**
 * 给一个条目排出「可以试的 PDF 地址」,按可信度排序。
 *
 * 三档:
 *   ① 条目自己带的直链(arXiv ID 换算出来的、或检索时拿到的开放获取直链);
 *   ② 条目里只有落地页(最常见的是 `https://doi.org/...`)时,走多源解析
 *      (`oaResolvers.resolvePdfCandidates` —— 它还会调搬过来的 paper-fetch)。
 *
 * **返回的是列表,不是一个地址**,因为"解析出地址"不等于"能下":真正的判据是
 * `verifyPdf` 的 `%PDF` 魔数。下载时会按顺序逐个试,第一个通过校验的就算成功 ——
 * 这是「下载不够智能」的解药:原来是问一次、试一次,一个 403 就判死刑。
 *
 * 顺带自愈:解析出直链后写回条目(`setUrl`),下次就不用再跑一遍解析。
 */
async function pdfCandidates(item: LibraryItem): Promise<string[]> {
  const out: string[] = [];

  // arXiv 有两个入口:条目直接带 arxivId,或者只有那个 arXiv 的 DOI
  // (`10.48550/arXiv.2302.01934`)。两种都是同一篇,都能直接下 /pdf/。
  const arxivId = item.arxivId ?? arxivIdFromDoi(item.doi);
  if (arxivId) out.push(`https://arxiv.org/pdf/${arxivId}`);

  // 条目上的 url 是直链就用它,是落地页就交给解析链
  if (item.url && PDF_URL_RE.test(item.url)) out.push(item.url);

  if (item.doi) {
    try {
      const resolved = await resolvePdfCandidates(item.doi);
      const fresh = resolved.map((c) => c.url).filter((u) => !out.includes(u));
      out.push(...fresh);
      // 自愈:条目里存的还是落地页,但解析出了直链 —— 写回去。
      //
      // 这一步专治「已经导入的那批全都下载失败」:光把解析写进导入流程,只对
      // **新导入**的条目生效,用户库里已经躺着的那几条还是下不了。
      if (fresh.length > 0 && (!item.url || !PDF_URL_RE.test(item.url))) {
        LibraryRepo.setUrl(item.id, fresh[0]!);
      }
    } catch (err) {
      log.warn(`PDF 解析失败(${item.doi}):${(err as Error).message}`);
    }
  }
  return out;
}

/** 一次下载尝试失败后,该报哪一种错。`needs_login` 最有用(它告诉用户下一步做什么),
 *  其次是"没有公开版本"。逐个候选试完之后,报的是**出现过的最有用的那个**。 */
function mergeFailure(
  current: { status: DownloadStatus; error: string } | null,
  next: { status: DownloadStatus; error: string },
): { status: DownloadStatus; error: string } {
  const rank = (s: DownloadStatus) => (s === "needs_login" ? 3 : s === "not_found" ? 2 : 1);
  if (!current || rank(next.status) > rank(current.status)) return next;
  return current;
}

/**
 * 校验 + 落盘 + 收尾。**成功返回 null,失败返回该报的错**(临时文件由调用方清理)。
 *
 * 抽出来是因为它现在有两条调用路径:正常的直连下载,以及最后那招「打印成 PDF」——
 * 两条都必须过**同一道** `%PDF` 校验。用户的要求很明确:「如果下载的不是 pdf 就不要
 * 下了,就算失败」。认证过期或撞上反爬时 Chromium **不报错**,它会把登录页/质询页
 * HTML 老老实实存下来,状态同样是 completed;少了这道校验,库里就会多出一批打不开的
 * "PDF"。
 */
function finalize(
  item: LibraryItem,
  tmpPath: string,
  source: string,
): { status: DownloadStatus; error: string } | null {
  const invalid = verifyPdf(tmpPath);
  if (invalid) return invalid;

  // 校验通过 → 按内容哈希落盘(内容相同则自然合并,天然去重)
  const sha = hashFile(tmpPath);
  const dest = pdfPathForHash(sha);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    // rename 在目标已存在时会失败(Windows);同内容时直接丢弃临时文件即可
    if (dest !== tmpPath) {
      try {
        renameSync(tmpPath, dest);
      } catch {
        rmSync(dest, { force: true });
        renameSync(tmpPath, dest);
      }
    }
  } catch (err) {
    return { status: "failed", error: `落盘失败:${(err as Error).message}` };
  }

  LibraryRepo.setPdf(item.id, toLibraryRelative(dest), sha);
  DownloadJobRepo.setStatus(item.id, "done", undefined, false);
  pushJobChanged(item.id, "done");
  log.info(
    `library download ok: ${item.title} (${sha.slice(0, 12)}…) via ${source} → ${toLibraryRelative(dest)}`,
  );
  // 下载完就该自动转录 —— 用户的要求是「导入之后是软件自动下载，自动转录的，不需要
  // ai 去管」。这里只发通知,具体怎么做由注册进来的钩子决定(见 setDownloadCompleteHook)。
  if (onDownloadComplete) {
    try {
      // 重新读一次:上面的 setPdf 刚写完,手上这个 item 还停在下载前的状态
      const fresh = LibraryRepo.get(item.id);
      if (fresh) onDownloadComplete(fresh);
    } catch (err) {
      log.warn(`library download hook failed: ${(err as Error).message}`);
    }
  }
  return null;
}

/** 下载单条文献。成功后写库并返回 ok。
 *
 *  会按 `pdfCandidates` 的顺序逐个试:同一篇的开放获取副本常常不止一个地址,
 *  第一个 403 / 拿到登录页 / 指向落地页都是常事。 */
async function downloadOne(item: LibraryItem): Promise<boolean> {
  const job = DownloadJobRepo.getByItem(item.id);
  const jobId = job?.id ?? item.id;
  log.info(`library: 开始处理 —— ${item.title}${item.doi ? ` (${item.doi})` : ""}`);

  ensureLibraryDirs();
  const tmpPath = tempDownloadPath(jobId);
  try {
    mkdirSync(dirname(tmpPath), { recursive: true });
  } catch {
    /* ensureLibraryDirs 已经建过 tmp/;失败就让下面报错 */
  }

  let failure: { status: DownloadStatus; error: string } | null = null;

  // ── ① 首选:交给 paper-fetch 自己下 ──────────────────────────────────
  //
  // 搬过来的那套脚本**本来就是干这个的**,而且干得比我们的浏览器路径好:它有自己
  // 的 cookie 罐与重定向安全检查、`%PDF` 魔数自检(不合格自动换下一个源)、机构
  // EZproxy 与 CDP 复用已登录浏览器两条备用通道。实测 Nat. Commun. 那篇 9 秒拿到
  // 4MB 真 PDF,而我们的 `session.downloadURL()` 在同一篇上挂满 60 秒然后超时。
  //
  // 下面 ② 那条链只在它失败、或条目没有 DOI 时才走。
  if (item.doi) {
    DownloadJobRepo.setStatus(item.id, "running", undefined, true);
    pushJobChanged(item.id, "running");
    const outDir = join(dirname(tmpPath), `pf-${jobId}`);
    try {
      const pf = await downloadViaPaperFetch(item.doi, outDir);
      if (pf.ok && pf.file) {
        const rejected = finalize(item, pf.file, "paper-fetch");
        if (!rejected) return true;
        failure = mergeFailure(failure, rejected);
        log.warn(`paper-fetch 下到的不是 PDF(${rejected.status}):${item.title}`);
      } else if (pf.error) {
        log.info(`paper-fetch 没能取到 ${item.doi}:${pf.error}`);
      }
    } catch (err) {
      log.warn(`paper-fetch 下载异常:${(err as Error).message}`);
    } finally {
      // 它按"标题_年份_期刊"命名落盘;成功时文件已被 rename 进库,这里只剩空目录
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* 清不掉不影响结果 */
      }
    }
  }

  // ── ② 退回 Mcode 自己的候选链 ──────────────────────────────────────
  const candidates = await pdfCandidates(item);
  if (candidates.length === 0) {
    // paper-fetch 报过的错更具体(`not_a_pdf` / 没有开放获取副本…),优先用它 ——
    // 报"没有公开版本"而实际原因不同,会让用户不知道该做什么。
    const final = failure ?? {
      status: "not_found" as DownloadStatus,
      error: "没有可用来源:这一篇没有公开的 PDF 版本(arXiv 副本 / 开放获取 / 出版商直链都没找到)。",
    };
    DownloadJobRepo.setStatus(item.id, final.status, final.error, true);
    return false;
  }

  for (const [index, url] of candidates.entries()) {
    DownloadJobRepo.setStatus(item.id, "running", undefined, true);
    pushJobChanged(item.id, "running");

    const result = await downloadViaBrowser({
      url,
      savePath: tmpPath,
      timeoutMs: CANDIDATE_TIMEOUT_MS,
    });
    if (!result.ok) {
      // 超时/中断归到网络类,可退避重试;不猜成 needs_login(那是内容层面的判断)
      failure = mergeFailure(failure, { status: "failed", error: result.error ?? "下载失败" });
      safeUnlink(tmpPath);
      continue;
    }

    const rejected = finalize(item, tmpPath, url);
    if (rejected) {
      failure = mergeFailure(failure, rejected);
      safeUnlink(tmpPath);
      log.warn(`候选 ${index + 1}/${candidates.length} 被拒(${rejected.status}):${item.title}`);
      continue; // 换下一个候选 —— 换一个源往往就不用登录了
    }
    return true;
  }

  // ── 最后一招:打印成 PDF ───────────────────────────────────────────
  //
  // 有一类站点(Nature / Wiley / ScienceDirect / TechRxiv 这些)**既不是付费墙,也没有
  // 下载按钮**:点开就是在浏览器里内联渲染出 PDF,人只能靠「打印 → 另存为 PDF」存下来。
  // 它们普遍挂着 Cloudflare 之类的人机检测,上面那些直连下载会**全部**失败(要么挂到
  // 超时,要么被 0 字节中断)—— 这里把那套手工流程自动化。
  //
  // 只在前面全败时才走:它拿到的是**重新渲染**的 PDF,批注/表单域会丢,能拿原件就
  // 不该拿这个。
  const printable = candidates.find((u) => /^https?:/i.test(u));
  if (printable) {
    log.info(`library: 直连下载全部失败,改用打印导出 —— ${item.title}`);
    DownloadJobRepo.setStatus(item.id, "running", undefined, false);
    pushJobChanged(item.id, "running");
    const printed = await printUrlToPdf({
      url: printable,
      savePath: tmpPath,
      timeoutMs: PRINT_TIMEOUT_MS,
    });
    if (printed.ok) {
      const rejected = finalize(item, tmpPath, `print:${printable}`);
      if (!rejected) return true;
      failure = mergeFailure(failure, rejected);
      safeUnlink(tmpPath);
    } else {
      log.warn(`library: 打印导出也失败:${printed.error}`);
    }
  }

  // 所有办法都试过了。报停在最后那个最有用的失败上,并把"试了几个地址"说清楚 ——
  // 只报"下载失败"的话,用户不知道是没找到还是找到了但下不动。
  const final = failure ?? { status: "failed" as DownloadStatus, error: "下载失败" };
  const detail = `${final.error}（已尝试 ${candidates.length} 个来源）`;
  DownloadJobRepo.setStatus(item.id, final.status, detail, false);
  pushJobChanged(item.id, final.status, detail);
  return false;
}

/**
 * 下载成功后的钩子。启动时注册(见 `main/ipc/library.ts`)。
 *
 * ## 为什么是钩子而不是直接 import
 *
 * 要做的事是「转 Markdown」,而 `convert.ts` 反过来要 import 本模块的 `hashFile` ——
 * 两边直接互相 import 就成了环。钩子把依赖方向拉直:downloader 只管"下载完了",
 * 不知道谁会拿它做什么。
 *
 * 钩子在**下载线程里同步调用**,所以实现方必须立刻返回、把活儿丢到后台去 ——
 * 它是 `void` 的,没有 await 的口子,这是刻意的。
 */
let onDownloadComplete: ((item: LibraryItem) => void) | null = null;

export function setDownloadCompleteHook(fn: ((item: LibraryItem) => void) | null): void {
  onDownloadComplete = fn;
}

function safeUnlink(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 把任务状态推给渲染端,让下载进度条能动。 */
function pushJobChanged(itemId: string, status: DownloadStatus, error?: string): void {
  try {
    sendToRenderer(IPC.LIBRARY_JOB_CHANGED, {
      channel: IPC.LIBRARY_JOB_CHANGED,
      itemId,
      status,
      error,
    });
  } catch (err) {
    // 窗口未就绪时推送会失败 —— 不该因此中断下载
    log.warn(`library job push failed: ${(err as Error).message}`);
  }
}

/* ──────────────────────────── 队列 ──────────────────────────── */

let running = false;

/**
 * 跑一遍待办队列。
 *
 * 刻意做成「跑完就退」而不是常驻 worker:下载是由用户/AI 触发的离散事件,
 * 常驻循环只会带来空闲轮询和生命周期管理的麻烦。需要重新触发时再调一次即可。
 * `running` 守卫避免并发重入(两次入库可能同时触发)。
 */
export async function processDownloadQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const concurrency = downloadConcurrency();
    // 每轮都重新取待办 —— 处理过程中会有新任务被排进来
    for (;;) {
      const pending = DownloadJobRepo.listByStatus("pending");
      if (pending.length === 0) break;

      const batch = pending.slice(0, concurrency);
      const items = batch
        .map((j) => LibraryRepo.get(j.itemId))
        .filter((i): i is LibraryItem => i !== null);
      log.info(`library: 下载队列取出 ${items.length} 条(待办 ${pending.length} 条)`);

      // 串行执行这一批:走的是同一个浏览器会话,并行只会互相抢带宽,
      // 且 will-download 的意图认领在并发下更难对齐。
      for (const item of items) {
        await downloadOne(item);
      }
    }
  } catch (err) {
    log.error(`library download queue failed: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

/** 把一批文献排入下载队列并启动处理。`force` 为真时已有 PDF 的也重下。 */
export function enqueueDownloads(ids: string[], force = false): void {
  for (const id of ids) {
    const item = LibraryRepo.get(id);
    if (!item) continue;
    if (item.pdfPath && !force) continue;
    DownloadJobRepo.enqueue(id);
  }
  // 不 await —— 下载是分钟级操作,不该阻塞 IPC 返回
  void processDownloadQueue();
}

/** 启动时调一次:把上次退出遗留的 `running` 任务打回 pending,并重新启动队列。
 *
 *  少了这一步,每次非正常退出都会留下一批**永远停在「下载中」**的条目:进程没了,
 *  那次下载就地蒸发,而数据库里的状态不会自己变回来 —— 界面上它永远转圈,队列也
 *  不会再捡起它(只取 pending)。 */
export function resumeDownloadsOnStartup(): void {
  try {
    const n = DownloadJobRepo.resetStale();
    if (n > 0) log.info(`library: ${n} 个下载任务在上次退出时中断,已重新排队`);
    void processDownloadQueue();
  } catch (err) {
    log.warn(`library: 恢复下载队列失败:${(err as Error).message}`);
  }
}
