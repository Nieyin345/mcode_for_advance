/**
 * 设置 → 工作流 的**视图模型**:哪些字段能改、什么时候要存、节点类型怎么分组、
 * 删除按钮该叫什么。全是纯函数 —— 不 import React、不碰 `api`、不读 i18n。
 *
 * 真正**修改文档**的那批函数在 `workflowEdit.ts`(加节点、连依赖…);这里只做
 * "看"和"判"。
 *
 * ## 为什么单独拎出来
 *
 * 这几条都是有分支的规则(内置与自建可改的字段不同、同一个 RPC 在界面上有两种说
 * 法),埋在组件里就只剩"点一下看看"这一种验证方式。拎出来之后
 * `scripts/workflow-view-smoke/` 能直接喂输入断言输出 —— 这个仓库没有测试框架,那是
 * 它实际在用的验证方式。
 */
import {
  MAIN_NODE_TYPE_ID,
  TRIGGER_NODE_TYPE_ID,
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeSource,
} from "@contracts/nodeType";
import {
  isLoopGateNode,
  type WorkflowDoc,
  type WorkflowTrigger,
} from "@contracts/workflow";

/* ── 工作流 / 自动化 ── */

/** 库里那两栏。同一份数据、同一张画布,只有"谁把它跑起来"不同。 */
export type WorkflowPurpose = "workflow" | "automation";

/**
 * 一份文档(或一条列表项)属于哪一栏。
 *
 * **判据只有 `trigger` 一个字段**(见 `@contracts/workflow` 的 `WorkflowDocSchema`)——
 * 不另设一个"这是自动化"的标志位,否则两者迟早不同步。`trigger` 在文档和列表项上
 * 同名同义,所以这一个函数两边都能收。
 */
export function purposeOf(doc: { trigger?: WorkflowTrigger }): WorkflowPurpose {
  return doc.trigger ? "automation" : "workflow";
}

/* ── 可改的字段 ── */

/**
 * 名称与说明是否**不可改** —— 内置退役(2026-09-26)后**恒为否**。
 *
 * 从前内置工作流的名字走 i18n 词条、数据里的 `name` 永不显示,所以要锁。现在自带
 * 内容播种成表里的普通行(见 `main/orchestration/library.ts` 文件头),名字/说明就是
 * 数据本身(`workflowDisplayName` 也改为直读数据),没有"改了不生效"的假话可说,
 * 锁也就没有存在的理由。函数保留(而不是删掉十来个调用点):它是"这类字段能不能改"
 * 的**唯一判定口**,将来若真出现要锁的形态(如插件带来的只读工作流),改这一处就够。
 */
export function isIdentityLocked(_doc: WorkflowDoc): boolean {
  return false;
}

/* ── 什么时候该存 ── */

/**
 * 名称空着吗 —— 空着就**存不下去**(`WorkflowDocSchema.name` 有 `min(1)`)。
 *
 * 两个地方要用同一个判据:那颗「保存」按钮(空着就发不出去,免得换来主进程一句
 * zod 报错)、以及状态行(把原因说出来)。内置工作流的名称不可改,所以它永远不空。
 *
 * 会走到这里是因为输入框允许暂时为空 —— 用户全选重打的那一瞬间必然经过空值,那一刻
 * 不该弹红字,也不该把整份文档发出去。
 */
export function missingRequiredName(doc: WorkflowDoc): boolean {
  return !isIdentityLocked(doc) && doc.name.trim().length === 0;
}

/**
 * 草稿与基线有没有差别(决定状态行说不说"有未保存的改动"、保存按钮点得下去吗)。
 *
 * **比引用,不深比。** 所有改动都从 `nodes` / `edges` / 那三个字符串派生,所以
 * "引用没变"就等于"没动过"(见 `workflowEdit.ts` 文件头第 1 条不变式)。深比一遍
 * 一张几十节点的图是白花时间,而它会在**每次按键**上跑。
 *
 * **锁住的字段不参与判断,这一点必须和 {@link forSave} 对齐**:那个函数会把内置
 * 工作流的名称与说明还原成基线里的值,这里如果不一起忽略,存完之后这两个字段仍然
 * 不同,"脏"就永远为真 —— 那颗按钮就永远点得下去，而点下去也没有任何作用。
 *
 * `updatedAt` 同样不参与:那个值由主进程盖(`saveWorkflow`),草稿里那份永远是旧的,
 * 比它会让"刚存完"立刻又判成脏,同一个死循环。
 */
export function isDocDirty(working: WorkflowDoc, baseline: WorkflowDoc): boolean {
  if (working.prompt !== baseline.prompt || working.frameworkNote !== baseline.frameworkNote) return true;
  if (working.nodes !== baseline.nodes || working.edges !== baseline.edges) return true;
  if (isIdentityLocked(baseline)) return false;
  return working.name !== baseline.name || working.description !== baseline.description;
}

/**
 * 存盘前把**名称与说明还原成基线里的那一份**(只对内置工作流)。
 *
 * 界面上这两个框对内置是只读的,所以正常路径下它们本来就没变 —— 这一句是**兜底**:
 * 主进程的 `saveWorkflow` 防不了这件事(它只校验图与参数),而以后还会有别的写入方
 * (导入一份别人分享来的工作流、批量操作)。让"内置的名字不该被写回"这条规则在
 * **执行保存的那一处**显式存在,而不是靠"那个 input 恰好是 readOnly"。
 */
export function forSave(working: WorkflowDoc, baseline: WorkflowDoc): WorkflowDoc {
  if (!isIdentityLocked(baseline)) return working;
  return { ...working, name: baseline.name, description: baseline.description };
}

/* ── 新建 ── */

/**
 * 给新建的工作流起一个不重名的名字。
 *
 * **实现搬去了 `@contracts/workflow`** —— 导入那条路(主进程)也要用同一个规则,而
 * 主进程 import 不到渲染端的组件目录。这里保留 re-export,是为了既有调用方与冒烟脚本
 * 不用改 import 路径(`workflow-view-smoke` 一直从本模块取它)。
 */
export { uniqueWorkflowName } from "@contracts/workflow";

/* ── 「恢复默认」与「删除」 ── */

/**
 * 那颗按钮该叫什么 —— 内置退役后**恒为「删除」**。
 *
 * 从前删内置的覆盖行等于"恢复默认"(代码里的默认版回来),措辞要分叉;现在自带的
 * 也是普通行,删了就是删了(「恢复默认」是钉过自定默认才有的另一颗按钮,见
 * `WorkflowListEntry.pinned`)。函数保留同 `isIdentityLocked` 的理由:调用点统一
 * 从这里问,语义变化只改一处。
 */
export function removeActionOf(_w: { builtin: boolean }): "reset" | "delete" {
  return "delete";
}

/* ── 节点类型 ── */

export interface NodeTypeGroup {
  source: NodeTypeSource;
  entries: NodeTypeEntry[];
}

/** 组头顺序。**与优先级顺序相反** —— 这里回答的是"我手上有什么",先看随应用来的,
 *  再看装进来的、自己写的;优先级(local > plugin > builtin)是"谁盖谁",是另一个问题。 */
const GROUP_ORDER: readonly NodeTypeSource[] = ["builtin", "plugin", "local"];

/**
 * 按来源分组,组内按 id 排序。
 *
 * **空组不出现** —— 一个写着「插件」却什么都没有的标题只会让人以为加载出了问题;
 * 目录里没有东西是正常情况(没人写过自定义节点),空状态那句话由视图决定怎么说。
 */
export function groupNodeTypes(entries: NodeTypeEntry[]): NodeTypeGroup[] {
  return GROUP_ORDER.map((source) => ({
    source,
    entries: entries
      .filter((e) => e.source === source)
      .sort((a, b) => a.id.localeCompare(b.id)),
  })).filter((g) => g.entries.length > 0);
}

/**
 * 按 id 找一份清单。**找不到不是错误** —— 一份别人分享来的工作流可能引用了没装的
 * 类型(见 `@contracts/workflow` 文件头),那种节点照样能看、能存,只是画不出来也
 * 跑不了。调用方据此把它画成"类型未安装"。
 */
export function findNodeType(
  entries: NodeTypeEntry[],
  id: string,
): NodeTypeEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/**
 * 图上的这个节点是不是**环的闸门** —— 界面这边只有一处要用它:判"新拉的这条边会不会成
 * 一个**合法**的环"(`wouldCycle`)。
 *
 * ## 两半,和存盘校验**同一个判据**
 *
 * 是**岔路口**(`runner.kind === "branch"`)只是候补那一半;另一半是**决定权得在用户手上**
 * —— 模型选的分支自己判完自己转,没有人拦得住,它当闸门的环根本停不下来(见
 * `@contracts/workflow` 的「回头」)。
 *
 * ⚠️ **这后半句以前漏在这儿**(2026-09-19),于是出现"画布上拉得出来、存盘被拒":从一个
 * 决定权给模型的分支拉一根回头线,这里放行;点保存时 `validateWorkflowDoc` 算成"无闸门
 * 的环",报一句"环上必须有一个岔路口"。
 *
 * 所以这条规则**只从契约层取**(`isLoopGateNode`)—— 两边各写一遍就是这次事故的成因。
 * "谁是分支"仍要在这里判(读的是节点类型清单,契约层够不到),所以回调照传。
 *
 * 判据是**清单**而不是节点类型 id:第三方可以随插件带自己的分支类型进来,认 id 的话
 * 那些节点在界面上拉不出回边,而它们跑起来和内置那个一模一样(同 `scheduler.ts` 里
 * `isBranch` 那条)。
 */
export function isLoopGate(catalog: NodeTypeCatalog, doc: WorkflowDoc, nodeId: string): boolean {
  return isLoopGateNode(
    (id) => {
      const node = doc.nodes.find((n) => n.id === id);
      return (
        node !== undefined &&
        findNodeType(catalog.entries, node.type)?.manifest.runner.kind === "branch"
      );
    },
    (id) => doc.nodes.find((n) => n.id === id)?.params,
    nodeId,
  );
}

/** 画布上那张卡片显示什么标题:用户起的 > 清单里的名字 > 类型 id。 */
export function nodeTitle(node: { title: string; type: string }, entry?: NodeTypeEntry): string {
  if (node.title.length > 0) return node.title;
  return entry?.manifest.name ?? node.type;
}

/* ── 键盘 ── */

/**
 * 这一次按键该不该删掉**选中的那个节点**。
 *
 * 三条规矩,少一条都会变成一个"偶尔很让人上火"的功能:
 *
 *  - **只在 Delete / Backspace 上**;
 *  - **按着修饰键不算**(Ctrl / ⌘ / Alt + Delete 在别处有别的意思);
 *  - **正在打字的地方不算** —— 检查器里那些输入框里的 Backspace 是删一个字符,而它
 *    离"删掉整个节点"只差一次误触。是不是"正在打字"由调用方查(`isEditableTarget`),
 *    那件事要碰 DOM,不该混进这个纯函数里。
 */
export function isNodeDeleteKey(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  typing: boolean,
): boolean {
  if (typing) return false;
  if (e.key !== "Delete" && e.key !== "Backspace") return false;
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

/**
 * 这个节点是不是**不能删**的那种 —— 现在是主代理。
 *
 * ## 为什么它不可删
 *
 * 它是这张图的**入口**:用户那句话先到它这儿。删掉之后图就没有起点了(还会连带删掉
 * 所有从它出发的边,整张图散架),而用户多半只是想"清掉这张图重来",并不是真想删
 * 这一步。新建的工作流本来就自带一个,所以"删不掉"不会挡着任何人 —— 他从来没有
 * 需要**加**它的时候。
 *
 * ## 为什么是一条单独的函数
 *
 * 判据只有一行,但它是**规矩**,而规矩要能单独断言(`workflow-view-smoke`):写进
 * 事件处理函数里的话,验它就得起一整个 React 树。拦的地方是 `handleRemoveNode` ——
 * 检查器里那个「删除节点」按钮和键盘的 Delete 走的都是它,所以一道就够。这条注释是
 * 给以后加"右键删除"「卡片上那个 ×」的人看的:**新加的入口也要过那里**。
 */
export function isProtectedNode(
  node: { type: string },
  purpose?: WorkflowPurpose,
  nodes?: readonly { type: string }[],
  catalog?: NodeTypeCatalog,
): boolean {
  // ⚠️ **两种图保护的东西不一样**（2026-09-22 用户明确要求）。
  //
  //  - **工作流**护 `mcode.main` —— 它的入口就是主代理，而且存盘会查
  //    `graph.no-main-node`。真让它删掉，用户点保存会被拒，而他刚删的那个节点
  //    已经不在了，等于走进死胡同。
  //  - **自动化**护 `mcode.trigger`（存盘查 `graph.no-trigger-node`），
  //    而**主代理能删** —— 在自动化里它只是"下游随便接的一个节点"之一，
  //    用户完全可能想接别的东西。原话：「自动化是不能删的，主代理是可以删的」。
  //
  // 判不了是哪一种时两种入口都护着：拦错的代价是"一个合法节点删不掉"，
  // 比"删了之后存盘被拒"更难解释。
  const trigger = (n: { type: string }) => n.type === TRIGGER_NODE_TYPE_ID ||
    catalog?.entries.some((e) => e.id === n.type && e.manifest.runner.kind === "trigger") === true;
  if (purpose === "automation") return trigger(node) && (!nodes || nodes.filter(trigger).length <= 1);
  if (purpose === "workflow") return node.type === MAIN_NODE_TYPE_ID &&
    (!nodes || nodes.filter((n) => n.type === MAIN_NODE_TYPE_ID).length <= 1);
  return node.type === MAIN_NODE_TYPE_ID || node.type === TRIGGER_NODE_TYPE_ID;
}
