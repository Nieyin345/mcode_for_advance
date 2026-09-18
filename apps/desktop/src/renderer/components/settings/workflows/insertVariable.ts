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
import type { MessageId } from "@renderer/lib/i18n/core.js";

/**
 * 菜单里的一项。
 *
 * `kind` 是一个**判别位**,而不是把显示的字直接拼在这里:内置那几条(「整段结果」、
 * 「用户输入」)的文字要走 i18n,而 i18n 是个 hook —— 这个模块是纯函数,不能碰。所以
 * 这里只说"这是哪一种",显示成什么由组件决定。
 *
 * - `var` —— 上游声明过的**产出变量**(`{{A.年份}}`),菜单一行就是变量名。
 * - `param` —— 上游**填过值**的**参数**(`{{A.params.target}}`),要的是那一步的
 *   配置而不是产出(见 `@contracts/nodeTemplate` 的 `params.` 分支)。
 * - `meta` —— 那一步的**元信息**(`status` / `error` / `artifacts`),解算器对它们
 *   不做"必须跑成功"的拦截 —— 有人就是要拿 `{{A.status}}` 判断。
 * - `whole` —— 上游的**整段结果**(`{{A.output}}`)。
 * - `user` —— 这次运行的**原始输入**(`{{user}}`)。它不属于任何上游(解算器在查
 *   上游之前就接住了它),单独成组,组的 `title` 留空。
 * - `trigger` —— 触发器带给这次运行的事实(`{{trigger.kind}}` 等)。**只有图里挂着
 *   触发器(或文档标了 trigger)时才有这一组** —— 没有触发器,这些解出来永远是空,
 *   列出来只会让人插一个寂寞(同参数那边的"只列填过值的")。
 */
export interface InsertableItem {
  kind: "var" | "param" | "meta" | "whole" | "user" | "trigger";
  /** 变量 / 参数 / 元字段名。内置项(`whole` / `user`)没有。 */
  name?: string;
  /** 插进指令的文本。 */
  insert: string;
}

/** 菜单里的一组 —— 一个上游节点一组;「用户输入」「触发器」这两组没有节点标题。 */
export interface InsertableGroup {
  /** 那一步的标题(重名/没起名时是 id)。空串 = 内置组,标题由 `titleKey` 或条目自己带。 */
  title: string;
  /** 内置组的**词典标题**(「触发器」)。组件翻译它;上游节点组没有这个字段。 */
  titleKey?: MessageId;
  items: InsertableItem[];
}

/** 插进指令的文本长什么样。**这是解算器认的语法**,别在这里改花样。 */
export function snippetFor(refName: string, varName: string): string {
  return `{{${refName}.${varName}}}`;
}

/**
 * 元信息字段 —— **菜单列的每一项都是解算器真的认的**(`resolveOne` 里那几个封闭
 * 分支),这里不发明第四种写法。`title` 不列:菜单的组名就是它,再插一遍没有意义。
 */
const META_FIELDS = ["status", "error", "artifacts"] as const;

/**
 * 触发器带给这次运行的**事实字段** —— 菜单列的每一项都是调度器拼触发器上下文时
 * 真的会带的(`{{trigger.<key>}}`)。触发方式、触发时刻、文件触发器变化的文件、
 * 事件触发器的事件体、工具名、涉及对象。
 */
const TRIGGER_FIELDS = ["kind", "at", "files", "event", "toolName", "subjects"] as const;

/**
 * 这张图现在**挂着触发器吗**。两个判据,满足其一就算:
 *  - 图里有 `runner.kind === "trigger"` 的节点 —— 同 `NodeInspector` 认触发器/分支的
 *    判据是**清单**而不是类型 id(第三方可以带自己的触发器类型进来);
 *  - 文档本体标了 `trigger` —— 那是主进程从触发器节点反推写回的结果(见
 *    `library.deriveTrigger`),老图/手写的图靠它兜住。
 */
function hasTrigger(doc: WorkflowDoc, catalog: NodeTypeCatalog): boolean {
  return (
    doc.trigger !== undefined ||
    doc.nodes.some(
      (node) =>
        catalog.entries.find((e) => e.id === node.type)?.manifest.runner.kind === "trigger",
    )
  );
}

/** 表状参数(产出变量表、输入选项表、条件表)的值是一整个结构,拼进指令里没人读得懂
 *  —— 那不是"参数"该有的样子,不进菜单。其余种类(文本、数字、开关、路径、引用…)
 *  填过值就可以被 `{{A.params.xxx}}` 引走。 */
const NON_SCALAR_PARAM_KINDS: ReadonlySet<string> = new Set(["variables", "options", "selects"]);

/**
 * 这一步现在能插入哪些变量。
 *
 * 第一组永远是「用户输入」(`{{user}}`)—— 它不依赖上游,入口节点的指令同样引用得到。
 * 图里挂着触发器时,「触发器」一组跟在它后面(同样不依赖上游);没有上游、也没有
 * 触发器时,后面就只有用户输入这一组 —— 界面上不再说"上面还没有别的步骤"当成
 * 空态,因为菜单已经不是空的了。
 */
export function insertableGroups(
  doc: WorkflowDoc,
  nodeId: string,
  catalog: NodeTypeCatalog,
): InsertableGroup[] {
  const deps = buildAdjacency(doc.nodes, doc.edges).deps;
  const upstream = upstreamClosure(deps, nodeId);

  const groups: InsertableGroup[] = [
    { title: "", items: [{ kind: "user", insert: "{{user}}" }] },
  ];

  // 触发器的事实与上游无关:挂在图上就有,和「用户输入」一样是运行时喂进来的输入侧。
  // 组名走词典(`titleKey`),渲染由组件翻译 —— 这个模块是纯函数,碰不到 hook。
  if (hasTrigger(doc, catalog)) {
    groups.push({
      title: "",
      titleKey: "settings.workflows.triggerGroup",
      items: TRIGGER_FIELDS.map((f) => ({
        kind: "trigger" as const,
        name: f,
        insert: `{{trigger.${f}}}`,
      })),
    });
  }

  // **按图上的顺序列**(`doc.nodes` 就是画布/列表的顺序)。按依赖顺序排看着更"对",
  // 但同一层里哪个在前没有意义,而在图上找"我上面那步"用的就是眼睛看到的顺序。
  for (const node of doc.nodes) {
    if (!upstream.has(node.id)) continue;
    const title = refNameOf(node, doc.nodes);
    const manifest = catalog.entries.find((e) => e.id === node.type)?.manifest;
    const vars = manifest ? outputVarsOf(manifest, node.params) : [];
    // 只列**填过值**的参数:没填的解算出来是空串,列出来只会让人插一个寂寞。
    // 顺序跟清单走 —— 和参数表单同一个顺序,找起来不费劲。
    const params = manifest
      ? manifest.params
          .filter(
            (spec) =>
              !NON_SCALAR_PARAM_KINDS.has(spec.kind) &&
              node.params[spec.key] !== undefined &&
              node.params[spec.key] !== "",
          )
          .map((spec) => ({
            kind: "param" as const,
            name: `params.${spec.key}`,
            insert: snippetFor(title, `params.${spec.key}`),
          }))
      : [];
    groups.push({
      title,
      items: [
        ...vars.map((v) => ({ kind: "var" as const, name: v.name, insert: snippetFor(title, v.name) })),
        ...params,
        ...META_FIELDS.map((f) => ({ kind: "meta" as const, name: f, insert: snippetFor(title, f) })),
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
