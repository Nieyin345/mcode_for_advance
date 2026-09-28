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
 */
import type { NodeOutcome } from "@contracts/nodeType";

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
 * 没有请求就**原样返回**那个 outcome(连 import 都不会发生,见下面的动态 import)。
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

  const { importAnyFiles } = await import("@main/library/importDispatch.js");
  const { notifyLibraryChanged } = await import("@main/library/broadcast.js");
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
  if (outcome.status !== "success") return outcome;
  const requests = requestsOf(outcome.outputs);
  if (requests.length === 0) return outcome;

  // **动态 import**:挂回要牵出 `LibraryRepo` → sql.js 那一整条链。绝大多数 code 节点
  // 与文档库毫无关系,没理由让它们(以及只装了执行器的冒烟测试)为此把库加载起来。
  const { adoptMarkdownFile } = await import("@main/library/adoptMarkdown.js");
  const { notifyLibraryChanged } = await import("@main/library/broadcast.js");

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
  if (adopted.length === 0) {
    return {
      ...outcome,
      status: "failed",
      summary,
      outputs,
      error: `挂回文档库全部失败：${failed.join("；")}`,
    };
  }
  return { ...outcome, summary, outputs };
}
