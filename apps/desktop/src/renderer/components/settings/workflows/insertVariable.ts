/**
 * 「插入变量」—— 检查器里那个让人**挑**而不是**打**的东西。
 *
 * ## 为什么要有它
 *
 * `{{检索.年份}}` 这种写法本身不难,但**要求用户记住上游那一步叫什么、上面定过哪几个
 * 变量名** —— 而这两个都是他自己起的,记不住很正常,记错一个字的后果是那一步跑不起来
 * (见 `@contracts/nodeTemplate` 的"解不出来就失败")。所以界面上不提供"打"这条路:
 * 上游定过什么变量,菜单里就列什么,点一下插到光标处。
 *
 * 手写那条路**依然通**(解算器认文本,不认识菜单),留给读提示词、写文档、从别处拷一份
 * 指令过来的人。这里只是不给它做界面。
 *
 * ## 候选为什么是这个集合
 *
 * 和调度器解算时认的**完全同一份**:上游的**传递闭包**(见 `@contracts/workflow` 的
 * `upstreamClosure`)。两处各写一遍的话,迟早出现"菜单里选得到、跑起来说不是上游"。
 *
 * ## 名字用标题还是 id
 *
 * 优先用标题(好认),但**标题重名时退回 id** —— 解算器对重名标题是直接报错的
 * (`@contracts/nodeTemplate` 的 `findNode`),所以这里插进去的必须是**一定能解出来**
 * 的那个写法。
 */
import { buildAdjacency, upstreamClosure, type WorkflowDoc, type WorkflowNode } from "@contracts/workflow";
import { outputVarsOf } from "@contracts/outputConstraint";
import type { NodeTypeCatalog } from "@contracts/nodeType";

/**
 * 菜单里的一项。
 *
 * `kind` 是一个**判别位**,而不是把显示的字直接拼在这里:内置那一条(「整段结果」)的
 * 文字要走 i18n,而 i18n 是个 hook —— 这个模块是纯函数,不能碰。所以这里只说"这是
 * 哪一种",显示成什么由组件决定。
 */
export interface InsertableItem {
  kind: "var" | "whole";
  /** 变量名。内置项没有。 */
  name?: string;
  /** 插进指令的文本。 */
  insert: string;
}

/** 菜单里的一组 —— 一个上游节点一组。 */
export interface InsertableGroup {
  /** 那一步的标题(重名/没起名时是 id)。 */
  title: string;
  items: InsertableItem[];
}

/** 插进指令的文本长什么样。**这是解算器认的语法**,别在这里改花样。 */
export function snippetFor(refName: string, varName: string): string {
  return `{{${refName}.${varName}}}`;
}

/**
 * 这一步现在能插入哪些变量。
 *
 * 没有上游时返回空数组 —— 界面上据此说"上面还没有别的步骤",而不是给一个空菜单。
 */
export function insertableGroups(
  doc: WorkflowDoc,
  nodeId: string,
  catalog: NodeTypeCatalog,
): InsertableGroup[] {
  const deps = buildAdjacency(doc.nodes, doc.edges).deps;
  const upstream = upstreamClosure(deps, nodeId);
  if (upstream.size === 0) return [];

  const groups: InsertableGroup[] = [];
  // **按图上的顺序列**(`doc.nodes` 就是画布/列表的顺序)。按依赖顺序排看着更"对",
  // 但同一层里哪个在前没有意义,而在图上找"我上面那步"用的就是眼睛看到的顺序。
  for (const node of doc.nodes) {
    if (!upstream.has(node.id)) continue;
    const title = refNameOf(node, doc.nodes);
    const manifest = catalog.entries.find((e) => e.id === node.type)?.manifest;
    const vars = manifest ? outputVarsOf(manifest, node.params) : [];
    groups.push({
      title,
      items: [
        ...vars.map((v) => ({ kind: "var" as const, name: v.name, insert: snippetFor(title, v.name) })),
        // 内置那一条放最后 —— 它是"整段",不是一个具体的变量。
        { kind: "whole" as const, insert: snippetFor(title, "output") },
      ],
    });
  }
  return groups;
}

/**
 * 一步一步叫它什么。
 *
 * 标题重名时**退回 id**:解算器对重名标题是直接报错的,所以这里插进去的必须是那个
 * 一定能解出来的写法。没起标题的同样退 id。
 */
function refNameOf(node: WorkflowNode, all: readonly WorkflowNode[]): string {
  const title = node.title.trim();
  if (title.length === 0) return node.id;
  const sameTitle = all.filter((n) => n.title.trim() === title).length;
  return sameTitle > 1 ? node.id : title;
}

/**
 * 把一段文本插到光标处(替换掉选中的那一段)。
 *
 * **纯函数**,因为光标这件事全是边界情况:没聚焦过的 textarea 给的是 `-1`,值刚被别处
 * 改过时旧的位置可能超出长度。这些都不该让插入崩掉,也不该把文本插到奇怪的地方。
 */
export function insertSnippet(
  value: string,
  start: number,
  end: number,
  snippet: string,
): { value: string; caret: number } {
  const from = clamp(start, 0, value.length);
  const to = clamp(Math.max(end, from), from, value.length);
  return {
    value: value.slice(0, from) + snippet + value.slice(to),
    // 光标落在插进来的那段**后面** —— 连着插两个的时候不用再点一次。
    caret: from + snippet.length,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}
