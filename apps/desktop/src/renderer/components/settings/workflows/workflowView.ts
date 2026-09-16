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
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeSource,
} from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowTrigger } from "@contracts/workflow";

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
 * 名称与说明是否**不可改** —— 内置工作流就是这种情况。
 *
 * 这不是保守,是因为内置的名字**根本不存在数据里**:它们走 i18n
 * (`composer.mode.*`,见 `lib/workflowLabels.tsx`),切语言时跟着变。让用户在这里
 * 改一个界面上永远不显示的名字,是"界面在说假话" —— 改完保存、刷新,它还是原来的
 * 样子,而没有任何地方解释为什么。自建的没有这个问题:它的名字就是 `name`,改了
 * 立刻生效(选择器也读它)。
 *
 * **判据取 `doc.builtin`**:它是 `WorkflowDocSchema` 里唯一一处"这是内置的"标记,
 * 而 `WorkflowListEntry.builtin` 由主进程从同一个字段派生
 * (`main/orchestration/library.ts` 的 `summarize`),两者不会分家。流程文字与节点图
 * 不受它影响 —— 那是这个功能存在的理由,两种工作流都可改。
 */
export function isIdentityLocked(doc: WorkflowDoc): boolean {
  return doc.builtin;
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
  if (working.prompt !== baseline.prompt) return true;
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
 * 重名本身不会坏事(id 才是主键),但库里两行都叫「新工作流」时用户没法分辨哪个是
 * 哪个 —— 而重命名要先进去选中它,鸡生蛋。所以直接起成「新工作流 2」。
 */
export function uniqueWorkflowName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n <= taken.length + 2; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${taken.length + 2}`;
}

/* ── 「恢复默认」与「删除」 ── */

/**
 * 那颗按钮该叫什么。
 *
 * 两个名字背后是**同一个存储动作**(`workflow.remove`):删掉 `workflows` 表里那一行。
 * 对内置 id 来说那叫「恢复默认」(代码里的默认版立刻回来),对自建 id 来说那叫
 * 「删除」。区别只在措辞 —— 见 `main/orchestration/library.ts` 文件头,那里为此
 * 明确否掉了"两个 RPC"的初稿。
 */
export function removeActionOf(w: { builtin: boolean }): "reset" | "delete" {
  return w.builtin ? "reset" : "delete";
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
 * 图上的这个节点是不是**岔路口**(`runner.kind === "branch"`)。
 *
 * 界面这边只有一处要用它:判"新拉的这条边会不会成一个**合法**的环"(`wouldCycle`)——
 * 环上有岔路口就合法,见 `@contracts/workflow` 的「回头」。
 *
 * 判据是**清单**而不是节点类型 id:第三方可以随插件带自己的分支类型进来,认 id 的话
 * 那些节点在界面上拉不出回边,而它们跑起来和内置那个一模一样(同 `scheduler.ts` 里
 * `isBranch` 那条)。
 */
export function isLoopGate(catalog: NodeTypeCatalog, doc: WorkflowDoc, nodeId: string): boolean {
  const node = doc.nodes.find((n) => n.id === nodeId);
  return node !== undefined && findNodeType(catalog.entries, node.type)?.manifest.runner.kind === "branch";
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
export function isProtectedNode(node: { type: string }): boolean {
  return node.type === MAIN_NODE_TYPE_ID;
}
