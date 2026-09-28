/**
 * 让 **code 节点**把转录产物挂回文档库 —— 不经过子代理。
 *
 * ## 为什么需要这一层
 *
 * 「挂回」(`library_adopt_markdown`)从来只有两个入口:界面按钮,和**模型**调的 MCP
 * 工具。而 code 节点起的是**子进程** —— 它既碰不到进程内的 MCP 服务(那个没有端口、
 * 没有 stdio 口,就在主进程里),也不能自己去写库:文档库的底是 **sql.js**,整个库在
 * 主进程内存里、落盘是把 `mcode.db` **整个文件重写一遍**。子进程在旁边写同一个文件,
 * 撞上一次就是整库被覆盖。
 *
 * 于是以前只能在转录那一步后面挂一个**子代理**,让模型去调那个工具。可「把这份 md 挂到
 * 那个条目上」是**确定性**的事:该挂哪一条、挂哪个文件,上一步的产出里写得明明白白。
 * 让模型来做,换来的是它可能漏挂一条、可能挂错文件、慢、而且每次都要花模型的钱 ——
 * 漏挂的表现还特别难查:**转都转了,就是没挂上,也不报错**。
 *
 * ## 现在的分工
 *
 * **脚本说了算,宿主执行。** 脚本在 `@@mcode:result` 的 `outputs` 里多报一项:
 *
 *     "adoptMarkdown": [{"itemId": "li_xxx", "path": "<绝对路径>/full.md"}]
 *
 * code 节点跑完(且成功)之后,主进程逐条调 `adoptMarkdownFile` —— 和 MCP 工具、和界面
 * 那个按钮**走的是同一个函数**,原子换包、按引用搬配图、失败回滚那一整套都还在。
 *
 * 判断留在脚本里(它才知道哪条转成了),写库留在主进程(只有它能安全地写)。中间没有模型。
 *
 * ## 这算不算给 code 节点开了新权限
 *
 * 不算。code 节点本来就是「在这台机器上跑一段你写的程序」(`capability: "exec"`),
 * 它能读能写任何文件。这里多出来的只是一条**安全地写库**的路 —— 否则脚本要么写不了,
 * 要么去硬写 `mcode.db` 把库搞坏。
 *
 * ## 失败怎么算
 *
 * - 一条都没挂上 → **这一步失败**。转录成功而挂回全灭,不该显示成绿的。
 * - 挂上一部分 → 成功,但把没挂上的**逐条列在 summary 里**(与脚本自己对待"转不成的
 *   那几条"是同一个口径:不因一条坏的把好的一起毙掉,但绝不闷声吞掉)。
 * - **导入那一步失败,不取消挂回。** 两件事互不相干:挂回针对的是**早就在库里**的条目,
 *   而导入是往库里添新的。早先这里是「导入失败 → status 翻成 failed → 挂回整批早退」,
 *   于是那些本来能挂上的 md **既没挂、也没在 summary 里留下一个字** —— 正是本文件开头
 *   要根除的那种"转都转了,就是没挂上,也不报错"。现在两步各跑各的、失败原因合并上报。
 */
import type { NodeOutcome } from "@contracts/nodeType";
import type { importAnyFiles } from "@main/library/importDispatch.js";
import type { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";

/**
 * 写库那几样能力 —— 由 `main/index.ts` 注入(`configureCodeNodeLibraryHost`)。
 *
 * ## 为什么注入而不是(动态)import
 *
 * 早先这里是 `await import("@main/library/...")`,意图是「绝大多数 code 节点与库无关,
 * 别为此把库加载起来」。运行时确实如此,但**打包时**不是:esbuild 在不分块时会把
 * 能静态解析的动态 import 照样内联。`importFiles` 接进来之后(→ `importDispatch` →
 * pdf 管线 / `LibraryRepo` / `CollectionRepo` / `dataRoot` / `broadcast` → RuntimeManager
 * → ssh2 原生模块),凡是 bundle 了 `codeExecutor` 的无头 smoke(execution-engine /
 * module-workflow / module-phase2-e2e)都在打包阶段就挂了,而且报的是与它们毫不相干的
 * 桩缺导出。与 `publicMcpSession.configurePublicMcpRuntime` 同一个套路:纯逻辑留在
 * 这里,碰库的那一点从装配点注入。
 *
 * 没注入(无头 smoke / 应用装配前)而脚本又真的报了写库请求 → 这一步**失败**并写明原因,
 * 不静默跳过。
 */
export interface CodeNodeLibraryHost {
  importAnyFiles: typeof importAnyFiles;
  adoptMarkdownFile: typeof adoptMarkdownFile;
  notifyLibraryChanged(reason: string): void;
}
let libraryHost: CodeNodeLibraryHost | null = null;

export function configureCodeNodeLibraryHost(host: CodeNodeLibraryHost): void {
  libraryHost = host;
}

function hostUnavailable(outcome: NodeOutcome, what: string): NodeOutcome {
  const error = `${what}不可用：文档库宿主未装配（code 节点报了写库请求，但当前进程没有文档库）`;
  return { ...outcome, status: "failed", summary: [outcome.summary, error].filter((s) => s !== "").join("\n"), error };
}


/** 脚本报上来的一条挂回请求。 */
interface AdoptRequest {
  itemId: string;
  path: string;
}

/** 脚本报上来的「把这些文件收进库」。 */
interface ImportRequest {
  paths: string[];
  collectionIds: string[];
}

/** 从 `outputs.importFiles` 里认出导入请求。形状:
 *
 *     "importFiles": {"paths": ["C:/x/a.pdf"], "collectionIds": ["col_1"]}
 *
 *  同样只认得懂的部分,认不出就是没有。 */
function importOf(outputs: unknown): ImportRequest | null {
  if (typeof outputs !== "object" || outputs === null) return null;
  const raw = (outputs as Record<string, unknown>)["importFiles"];
  if (typeof raw !== "object" || raw === null) return null;
  const paths = (raw as Record<string, unknown>)["paths"];
  if (!Array.isArray(paths)) return null;
  const list = paths.filter((p): p is string => typeof p === "string" && p !== "");
  if (list.length === 0) return null;
  const cols = (raw as Record<string, unknown>)["collectionIds"];
  return {
    paths: list,
    collectionIds: Array.isArray(cols) ? cols.filter((c): c is string => typeof c === "string") : [],
  };
}

/** 从 `outputs.adoptMarkdown` 里认出请求。**认不出来就是没有**(不报错) ——
 *  这项是可选的,绝大多数 code 节点根本不会带它。 */
function requestsOf(outputs: unknown): AdoptRequest[] {
  if (typeof outputs !== "object" || outputs === null) return [];
  const raw = (outputs as Record<string, unknown>)["adoptMarkdown"];
  if (!Array.isArray(raw)) return [];
  const out: AdoptRequest[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const itemId = (entry as Record<string, unknown>)["itemId"];
    const path = (entry as Record<string, unknown>)["path"];
    if (typeof itemId === "string" && itemId !== "" && typeof path === "string" && path !== "") {
      out.push({ itemId, path });
    }
  }
  return out;
}

/**
 * 把 code 节点报上来的挂回请求办掉,并把结果并进它的产出。
 *
 * 没有请求就**原样返回**那个 outcome(不碰文档库)。
 */
export async function applyHostActions(outcome: NodeOutcome): Promise<NodeOutcome> {
  if (outcome.status !== "success") return outcome;
  const withImports = await applyImports(outcome);
  return applyMarkdownAdoptions(withImports);
}

/**
 * 把脚本报的「收这些文件进库」办掉。
 *
 * 走的是 `importAnyFiles` —— 界面上那两颗「导入文件 / 导入文件夹」按钮同一个函数
 * (按扩展名分派:pdf 走文献管线、md/txt 走笔记、其余收通用条目)。
 *
 * 收进来会发 `library.item.imported` 事件 —— **转录那条自动化就是听这个的**,所以
 * "选文件 → 入库 → 转 md → 挂回"这条链在这里自动接上,不需要谁去调度。
 */
async function applyImports(outcome: NodeOutcome): Promise<NodeOutcome> {
  const req = importOf(outcome.outputs);
  if (req === null) return outcome;

  if (libraryHost === null) return hostUnavailable(outcome, "收进库");
  const { importAnyFiles, notifyLibraryChanged } = libraryHost;
  const res = await importAnyFiles(req.paths, {
    mode: "files",
    ...(req.collectionIds.length > 0 ? { collectionIds: req.collectionIds } : {}),
  });
  if (res.added > 0) notifyLibraryChanged(`code_node_import:${res.added}`);

  const lines = [`已收进库 ${res.added} 个文件` + (res.skipped > 0 ? `（跳过 ${res.skipped} 个重复的）。` : "。")];
  for (const e of res.errors) lines.push(`⚠️ 收不进来:${e.path} —— ${e.error}`);

  const outputs = {
    ...(outcome.outputs ?? {}),
    imported: res.items.map((it) => ({ itemId: it.id, title: it.title })),
    importErrors: res.errors,
  };
  const summary = [outcome.summary, ...lines].filter((s) => s !== "").join("\n");

  // 一个都没收进来、而且全是错 → 这一步失败(选了文件却什么都没进库,不该是绿的)。
  if (res.added === 0 && res.errors.length > 0) {
    return { ...outcome, status: "failed", summary, outputs, error: `导入失败:${res.errors.map((e) => e.error).join("；")}` };
  }
  return { ...outcome, summary, outputs };
}

async function applyMarkdownAdoptions(outcome: NodeOutcome): Promise<NodeOutcome> {
  // 这里**故意不看 status**:进到这个函数说明 code 节点本身是成功的(`applyHostActions`
  // 已经挡过一道),此刻的 failed 只可能来自上一步的导入 —— 那跟挂回是两件事,不该连坐。
  const requests = requestsOf(outcome.outputs);
  if (requests.length === 0) return outcome;

  // 挂回要牵出 `LibraryRepo` → sql.js 那一整条链 —— 由装配点注入(见 `CodeNodeLibraryHost`)。
  if (libraryHost === null) return hostUnavailable(outcome, "挂回 Markdown ");
  const { adoptMarkdownFile, notifyLibraryChanged } = libraryHost;

  const adopted: Array<{ itemId: string; relPath: string; imageCount: number; missing: string[] }> = [];
  const failed: string[] = [];

  for (const req of requests) {
    let res;
    try {
      res = adoptMarkdownFile(req.itemId, req.path);
    } catch (err) {
      failed.push(`${req.itemId}:${(err as Error).message}`);
      continue;
    }
    if (res.ok) {
      adopted.push({
        itemId: req.itemId,
        relPath: res.relPath,
        imageCount: res.imageCount,
        missing: res.missing,
      });
    } else {
      failed.push(`${req.itemId}:${res.error}`);
    }
  }

  // 挂上了才广播 —— 界面靠它刷新条目详情(与 `ipc/library.ts` 那条路一致)。
  if (adopted.length > 0) notifyLibraryChanged(`code_node_adopt:${adopted.length}`);

  const lines: string[] = [];
  if (adopted.length > 0) {
    const images = adopted.reduce((sum, a) => sum + a.imageCount, 0);
    lines.push(`已挂回 ${adopted.length} 份 Markdown（配图 ${images} 张）。`);
    // 配图丢了要说 —— 挂上去但预览断图,是最像"成功了"的一种坏。
    const missing = adopted.filter((a) => a.missing.length > 0);
    for (const a of missing) {
      lines.push(`⚠️ ${a.itemId} 有 ${a.missing.length} 张配图没找到：${a.missing.slice(0, 5).join("、")}`);
    }
  }
  if (failed.length > 0) {
    lines.push(`没挂上的 ${failed.length} 条：`);
    lines.push(...failed);
  }

  const outputs = {
    ...(outcome.outputs ?? {}),
    adopted,
    adoptFailed: failed,
  };
  const summary = [outcome.summary, ...lines].filter((s) => s !== "").join("\n");

  // 全灭 = 这一步失败。转录成功而一条都没挂上,显示成绿的等于把问题藏起来。
  // 上一步(导入)若已经失败,错误原因**合起来报**,不覆盖掉先发生的那条。
  if (adopted.length === 0) {
    const reasons = [outcome.error, `挂回文档库全部失败：${failed.join("；")}`].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    return { ...outcome, status: "failed", summary, outputs, error: reasons.join("；") };
  }
  // 挂回成功,但**不覆写 status** —— 导入失败时这一步整体仍是失败的。
  return { ...outcome, summary, outputs };
}
