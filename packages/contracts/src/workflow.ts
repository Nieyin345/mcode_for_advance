/**
 * 工作流:一张图,节点是任务,边是依赖。
 *
 * **通常**是有向无环的;唯一的例外是**回头**(见下面「回头」那一节)。
 *
 * ## 它是什么(和「对话模式」的关系)
 *
 * 它取代的是 `main/lib/systemPrompt.ts` 里那五个写死的对话模式。原来模式 = 一段
 * 流程文字,只有代码能改;现在工作流 = 一张图,用户在设置里画、拖动、改,**选中
 * 它就驱动这次对话**。
 *
 * 图是"这次对话的流程"的定义,不是独立运行的东西 —— 用户照常发消息,调度器按
 * 依赖把图上的节点跑下去(见 `main/orchestration/`)。
 *
 * ## 「自动化」是同一张图的另一种跑法
 *
 * 一份文档带上 {@link WorkflowTriggerSchema} 的 `trigger` 就成了**自动化**:还是这张
 * 图、还是这个编辑器,区别只在**谁把它跑起来** —— 工作流跟着一次对话跑,自动化等一个
 * 事件自己跑。所以它们共用 `WorkflowDoc`,只是多了一个可选的触发方式,而不是两套数据。
 *
 * 触发方式**长在图上**:一条自动化至少有一个**触发器节点**(`mcode.trigger`),它声明
 * 等的是什么(定时 / 文件 / 事件 / 手动)以及这次运行要做什么。`trigger` 那个字段是
 * 从它反推出来的一个**开关**(见 {@link WORKFLOW_TRIGGERS} 的注释)。
 *
 * ## 为什么放在 contracts 而不是主进程
 *
 * 同一份数据要**三处**用:主进程调度器(判定依赖、排层)、渲染端画布(算列位、
 * 画连线)、以及校验(存盘前拒绝成环的图)。分层算法和校验规则各写一遍必然漂移,
 * 而漂移的后果是"界面上看着能跑、一执行就死循环"。
 *
 * ## 两条设计决定(都不是随手选的)
 *
 * ### 1. 依赖的真相是 `edges`,不是节点上的 `dependsOn`
 *
 * 初稿把 `dependsOn` 放在节点上,后来改成边为准。图是**编辑面**,箭头在那里是一等
 * 对象(画一条、删一条);节点上再存一份依赖列表就有了两个真相,而它们一定会不同步
 * (改了边忘了改节点)。需要邻接表的地方用 {@link buildAdjacency} 派生。
 *
 * ### 2. 节点**引用一个类型**,不描述自己
 *
 * 初稿让节点自带 `kind` 判别字段(`"agent"`,将来加 `"script"` / `"train"`)。现在
 * 改成 `type` + 一袋 `params`,指向 `nodeType.ts` 里的一份**清单**。
 *
 * 差别在于**加一种节点要不要改 Mcode 的源码**:判别字段是一张封闭列表,加一个值就要
 * 改这里、改调度器、改画布三处;而类型是**可注册的** —— 第三方随插件带一份清单进来
 * 就能用,用户让 AI 现场写一份也行,图和调度器一行都不用动。`kind` 能表达的 `type`
 * 都能表达,反过来不成立,所以 `kind` 被它取代了,不是并存。
 *
 * 规范(清单长什么样、能声明什么、三种来源谁覆盖谁)在 `nodeType.ts`。
 *
 * ⚠️ **`type` 认不出来时不算错误。** 一份别人分享来的工作流,在没装对应节点类型的
 * 机器上照样能存、能看 —— 只是那个节点画不出来、也跑不了。把"类型缺失"做成硬错误
 * 会让工作流没法分享。
 *
 * ## 分层只在画图时用,执行只看边
 *
 * {@link topoLayers} 算出来的"列"是**自动布局的产物**,不是语义:把两个有依赖的
 * 节点拖到同一列只会在视觉上难看,不会让它们真的并行。执行完全由边的可达性决定。
 * 这样"布局"和"语义"不会耦死 —— 用户可以自由摆位置而不改变流程行为。
 */

import { z } from "zod";

/* ── 节点能力 ── */

/**
 * 节点能做什么。建节点会话时映射成该会话的 `permissionMode`(粗粒度,见
 * `main/orchestration/`)。
 *
 * **两级默认值**:类型声明默认(清单里的 `capability`),单个节点可覆盖。两级的必要
 * 性在于分工 —— 类型作者最清楚"我这脚本要不要写盘",而用户在某个具体节点上可能要
 * 收紧(一个本来可写的节点,这次只想让它读)。
 */
export const WORKFLOW_CAPABILITIES = ["read", "write", "exec", "net"] as const;
export type WorkflowCapability = (typeof WORKFLOW_CAPABILITIES)[number];
export const WorkflowCapabilitySchema = z.enum(WORKFLOW_CAPABILITIES);

/* ── 图 ── */

/** 画布坐标。拖动后写回,纯粹是显示位置 —— 不参与执行语义。 */
export const WorkflowPositionSchema = z.object({ x: z.number(), y: z.number() });
export type WorkflowPosition = z.infer<typeof WorkflowPositionSchema>;

/**
 * 图上的一个节点。
 *
 * 它**不描述自己怎么跑** —— 那全在它引用的那份节点类型清单里(见 `nodeType.ts`)。
 * 这里只有"是哪个类型"和"这次填了什么参数"。
 *
 * 指令、模型、输出契约这些原本直接挂在节点上的字段,现在是 `mcode.agent` 这个**类型**
 * 的参数(`params.instruction` / `params.model` / …)。挪进类型是让"加一种节点"不必
 * 修改这个 schema 的关键一步。
 */
export const WorkflowNodeSchema = z.object({
  /** `"n_"` 前缀 + 随机。图内唯一。 */
  id: z.string().min(1),
  /** 节点类型的 id,形如 `mcode.agent`。见 `nodeType.ts` 的 `NODE_TYPE_ID_RE`。 */
  type: z.string().min(1),
  /** 卡片标题。用户可改;留空则显示类型名。 */
  title: z.string().max(80),
  /** 这个类型的参数。**这里只当袋子** —— 值的合法性由该类型的清单校验
   *  (`validateNodeParams`),因为只有清单知道哪些键必填、各自该是什么类型。 */
  params: z.record(z.string(), z.unknown()),
  /** 覆盖类型的默认能力。省略 = 用清单声明的默认值。 */
  capability: WorkflowCapabilitySchema.optional(),
  position: WorkflowPositionSchema,
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/**
 * 一条依赖边:`from` 完成后 `to` 才能开始。
 *
 * ## `label` / `note`:一条边也可以是一条**出路**
 *
 * 分支节点(`mcode.branch`,见 `@contracts/nodeType` 的 `runner.kind`)的出边不是
 * "依赖",是**选项** —— 用户在那个节点上选一条,其余几条连同它们拖着的整条支路一起
 * 作废。所以边需要能带两样东西:
 *
 * | 字段 | 是什么 | 给谁看 |
 * |---|---|---|
 * | `label` | 这个选项叫什么(「再来一轮」/「进入查重」) | **用户**,在选择按钮上 |
 * | `note` | 选了这条之后,给下一步的一句说明 | **模型**,拼进下一步的提示词 |
 *
 * **选项住在边上,而不是节点上的一张表里。** 一张表会有两种真相:表里填了三个选项、
 * 图上只拉了两根线(或者反过来)。那时候"用户能选什么"要读哪一份?两边都读就得处理
 * 不一致,只读一份另一份就是死的。而**边本来就是选项** —— 每个选项必然通向某一步,
 * 不可能有"通向虚空的选项",也不可能有一根"没有名字的线"说不出它是什么(没填
 * `label` 就用目标节点的标题兜底,见调度器)。
 *
 * `label` 只对**上游是分支节点**的边有意义;其余边上是普通依赖,填了不显示。
 * 不在契约层拦这一条:这里不认识节点类型(那要读清单,是异步的),而"这条边算不算
 * 选项"由 `from` 那个节点的 `runner.kind` 决定。
 */
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1), // "e_" 前缀 + 随机
  from: z.string().min(1),
  to: z.string().min(1),
  /** 分支节点的选项名。留空 = 用目标节点的标题。 */
  label: z.string().max(40).optional(),
  /** 选了这一项之后给下一步的一句说明(会拼进它的提示词)。 */
  note: z.string().max(500).optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

/**
 * 一个节点的**出边**,按它们在文档里存着的顺序。
 *
 * 顺序就是**分支节点上选项的先后** —— 用户在画布上试选项按钮的顺序,和这里给的
 * 顺序必须一致,否则"第二个按钮"在两处指的不是同一条边。所以不排序、不去重,原样
 * 交出去;要排序的地方(比如按目标节点的位置排)自己做,但那样两处就得各写一遍 ——
 * 而这一份是**唯一**的默认顺序。
 */
export function outgoingEdgesOf(doc: WorkflowDoc, nodeId: string): WorkflowEdge[] {
  return doc.edges.filter((e) => e.from === nodeId);
}

/* ── 自动化 ── */

/**
 * 一条自动化**靠什么跑起来**。
 *
 * 这是「自动化」和「工作流」唯一的差别所在:工作流是**跟着对话跑的** —— 用户发一条
 * 消息,调度器按依赖把图走完,这一次对话就是它的生命周期;自动化是**自己跑起来的**
 * —— 没有人发消息,它在后台被某个事件触发(见 `main/orchestration/automationRunner.ts`)。
 *
 * ## 这个字段现在只是一个**开关**
 *
 * 触发方式的**参数**(定时的表达式、监听的路径、听哪些事件)长在**触发器节点**上
 * (`mcode.trigger`,见 `@contracts/nodeType` 的 `NODE_TRIGGER_*` 那一组键)—— 因为一条
 * 自动化可以有**多个**触发器,而"几点"、"监听哪"是每个触发器各自的事。
 *
 * 所以这里的值**由触发器节点反推写回**(`orchestration/library.ts` 的 `deriveTrigger`),
 * 是唯一一个写入方。列表分栏、MCP、i18n 照旧读它,它们不必知道节点那一层的事。
 *
 * ## `webhook` 现在没有写入方
 *
 * 它要一个**对外**的 HTTP 入口(得动手机服务那一摊),属于另一件事。值保留在枚举里,
 * 是为了老文档读得回来 —— 读得回来就不会在解析时炸,只是没人再写它。
 */
export const WORKFLOW_TRIGGERS = ["manual", "schedule", "file", "event", "webhook"] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];
export const WorkflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);

/**
 * 一份工作流。
 *
 * `id` 有两类:内置的**沿用原来的模式 id**(`default` / `search` / `read` / `write` /
 * `review` / `code`),用户自建的用 `wf_` 前缀。这样 `sessions.composer_mode` 列的
 * 已有值不需要任何迁移(见 `db.ts`),而两种 id 天然不会撞。
 */
export const WorkflowDocSchema = z.object({
  id: z.string().min(1),
  /** 名称**不能为空** —— 库里一行没有名字,列表、选择器、确认框里都会显示成一片空白。
   *  界面上存盘前也拦了一道(`settings/workflows/workflowView.ts` 的
   *  `missingRequiredName`,调度自动保存的那一处用它决定"先不发"),这里是兜底:
   *  以后还有别的写入方(画布、导入分享来的工作流)。
   *  内置工作流的 `name` 只是兜底值(界面显示的是词条,见 `lib/workflowLabels.tsx`),
   *  但同样不给空 —— 一份导出的工作流不该带着一个空名字。 */
  name: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
  /** 图标键,渲染端映射成具体图标。 */
  icon: z.string().optional(),
  /**
   * 提示词型工作流的正文 —— 就是原来 `COMPOSER_MODE_PROMPTS` 里那段流程文字。
   * 图型工作流留空(流程由节点表达)。两种形态并存是有意的:五个内置模式里
   * 有几个本质就是"一段流程",硬掰成图反而是倒退。
   */
  prompt: z.string().optional(),
  /**
   * 触发方式。**有它就是一条自动化,没有它就是一张工作流。**
   *
   * 用**一个字段的有没有**来区分两者,而不是再加一个 `purpose: "workflow" |
   * "automation"` 标志位 —— 那个标志位和触发方式必然会不同步(改了一个忘了另一个),
   * 而这个文件头上第 1 条设计决定(`dependsOn` 让位给 `edges`)讲的正是这件事:同一个
   * 事实不留两个真相。
   *
   * 老文档没有这个字段,解析出来就是 undefined,行为与从前完全一致 —— 不需要迁移。
   */
  trigger: WorkflowTriggerSchema.optional(),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  /** true = 随应用发布的内置工作流(默认版在代码里,用户的修改存表里覆盖它)。 */
  builtin: z.boolean(),
  updatedAt: z.number(),
});
export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>;

/* ── 列表项 ── */

/** 工作流库列表里的一项 —— **不含 `nodes` / `edges`** 的轻量摘要。
 *
 *  列表里可能有几十个工作流,把每张图的全部节点都塞进列表响应是白花带宽;画布
 *  编辑器打开某一个时才走 `workflow.get` 取完整文档。 */
export const WorkflowListEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  /** 这个 id 是不是内置的(内置的默认版在代码里,不在这张表里)。 */
  builtin: z.boolean(),
  /** 内置 + 用户改过 = true。界面据此显示「已修改 · 恢复默认」。 */
  edited: z.boolean(),
  /** 提示词型还是图型 —— 由有没有节点决定,不是另存的标志位。 */
  kind: z.enum(["prompt", "graph"]),
  /** 有触发器 = 自动化,没有 = 工作流(见 {@link WorkflowDocSchema} 的 `trigger`)。
   *  列表分栏靠它,所以它必须一路带到渲染端 —— 丢在 `summarize` 里的话,自动化就会
   *  出现在"工作流"那一栏。 */
  trigger: WorkflowTriggerSchema.optional(),
  updatedAt: z.number(),
});
export type WorkflowListEntry = z.infer<typeof WorkflowListEntrySchema>;

/* ── 生成 id ── */

/**
 * 生成一个工作流 id。`wf_` 前缀是**自建**那一类的记号 —— 内置的沿用原来那六个模式 id
 * (`default` / `search` / …),两类天然不会撞(见 {@link WorkflowDocSchema} 的注释)。
 *
 * 不用名字做 slug:名字多半是中文,slug 出来会是空的;而同一秒里建两份就会撞。id 只要求
 * 互不相同,那么时间戳加随机就是它该有的样子(与 `makeAgentProfileId` / `makeHookId` 同款)。
 *
 * 放在 contracts 而不是渲染端,是因为**有两个写入方**:画布上的「新建」,以及 AI 通过
 * MCP 建图(`main/mcp/mcodeServer.ts`)。两处各写一份的话,迟早出现一边的 id 不合另一边的
 * 假设 —— 同一条理由已经让 {@link autoLayout} 待在这里了。
 */
export function makeWorkflowId(now: number = Date.now()): string {
  return `wf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成一个节点 id。图内唯一即可(`n_` 前缀与 `WorkflowNode.id` 的注释一致)。 */
export function makeNodeId(now: number = Date.now()): string {
  return `n_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成一条边的 id。同理,只是换个前缀。 */
export function makeEdgeId(now: number = Date.now()): string {
  return `e_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ── 回头:分出去的一条线指回前面 ── */

/**
 * 一条**回边** —— 目标是自己祖先的那条边。它和图上别的边不是一回事:别的边是
 * "上一步做完了才轮到我",它是"**回到前面去,再来一轮**"。
 *
 * ## 为什么要有它
 *
 * 用户原话:「分支能分出去很多的线,一个线就是一个选项 …… 他应该是能够**回头分**的呀,
 * 而且这个不会死循环,因为需要用户选择,这样就能不断迭代。」
 *
 * 用节点表达迭代(「成稿」→「修订」→「再修订」)只能表达**固定几轮** —— 想要第四轮就得
 * 再加一个节点,而"几轮才够"是跑起来才知道的事。回边把这件事交回给用户:每一轮都由他
 * 决定还有没有下一轮。
 *
 * ## 它凭什么不会转飞
 *
 * **因为回边必须经过一个岔路口。** 走到岔路口,调度器就停下来问用户
 * (`scheduler.ts` 的 `chooseOne`),所以绕一圈**至少要有一次人的点击** —— 这是
 * **结构上**成立的,不是靠一个"最多 N 轮"的计数器兜着。
 *
 * 计数器那种做法有三个毛病:数到 N 就不许再转了,而"还要不要改"用户说了算;N 定大了
 * 没拦住,定小了白改;最要紧的是**它拦不住真正想拦的那种图** —— 一个根本没人参与的环
 * (`A → B → A`)会安静地转到 N 次,烧掉 N 轮 token 才停,而用户只看到账单。
 *
 * 所以判据是"**环上有没有岔路口**",见 {@link validateDag}。
 *
 * ## 回边不是一条依赖
 *
 * 就绪判断(`上游全都成功了才轮到我`)必须**排除回边**。理由:环体内部,回边的目标是
 * 环的入口,而它的源头在环的出口 —— "入口要等出口"和"出口要等入口"同时成立的话,这个
 * 环一次都转不起来(见调度器里的 `forwardDeps` / `loopBackIn`)。回边承担的是另一件事:
 * **把环的入口重新布防**。
 */
export interface BackEdge {
  edge: WorkflowEdge;
  /** 这个环上的**全部**节点(含两端)。判"环上有没有岔路口"要用它。 */
  cycle: string[];
}

/**
 * 找出图上所有的回边,以及每条回边闭出来的那个环。
 *
 * 用一次深度优先:走到一个**还在栈上**(灰色)的节点,那条边就是回边;而**栈上从那个
 * 节点到当前节点的这一段**,正好就是这个环的全部节点 —— 所以环是顺手拿到的,不用再搜
 * 一遍。
 *
 * **顺序是确定的**:根按 `nodes` 的次序、邻居按 `edges` 的次序。同样的图必须给出同样的
 * 回边集合,否则"同一张图两次跑出不同结果"这种最难查的问题就有了入口。
 *
 * 迭代而不是递归:图的规模是人画的(几十个节点),但**深链是合法的**,而爆栈后的症状
 * 是渲染进程整个白掉 —— 不值得为省几行冒这个险。
 */
export function backEdgesOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): BackEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    (outgoing.get(edge.from) as WorkflowEdge[]).push(edge);
  }

  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const found: BackEdge[] = [];

  for (const root of nodes) {
    if (color.has(root.id)) continue;
    const stack: Array<{ id: string; at: number }> = [{ id: root.id, at: 0 }];
    color.set(root.id, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; at: number };
      const list = outgoing.get(top.id) as WorkflowEdge[];
      if (top.at >= list.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const edge = list[top.at++] as WorkflowEdge;
      const seen = color.get(edge.to);
      if (seen === GRAY) {
        const from = stack.findIndex((f) => f.id === edge.to);
        found.push({ edge, cycle: stack.slice(from).map((f) => f.id) });
      } else if (seen === undefined) {
        color.set(edge.to, GRAY);
        stack.push({ id: edge.to, at: 0 });
      }
    }
  }
  return found;
}

/**
 * 其中**算数的**那些回边 —— 环上有岔路口的。
 *
 * 这个过滤不能省:一个没有岔路口的环是**坏图**(存盘时 {@link validateDag} 就拒了),
 * 而一旦它真到了调度器,当成正常依赖处理会得到"依赖永远满足不了"的结局 —— 那正是
 * 用户需要看到的那句话(`scheduler.ts` 收尾时写的「依赖没有满足(图里是不是有环?)」)。
 * 在这里一并放行的话,那个环会**当作一条直线跑一遍**,而用户画的明明是个死循环。
 */
export function loopBackEdgesOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  isLoopGate: (nodeId: string) => boolean,
): BackEdge[] {
  return backEdgesOf(nodes, edges).filter((b) => b.cycle.some(isLoopGate));
}

/**
 * 图上**在环里**的那些节点 —— 回头绕一圈会经过的全部节点(含那个岔路口)。
 *
 * 两处必须给出同一个答案:
 *  - **调度器**决定"没表过态的节点要不要读流程记录"的默认值;
 *  - **检查器**显示那个开关的默认态。
 *
 * 各算一遍的话,会出现"界面上显示关着、实际按开着跑"—— 而那种不一致不报错,只在某一步
 * 悄悄多带或少带一大段上下文时才看得出来。同 `nodesWithDownstream` 那条理由。
 */
export function nodesOnLoopOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  isLoopGate: (nodeId: string) => boolean,
): Set<string> {
  const on = new Set<string>();
  for (const back of loopBackEdgesOf(nodes, edges, isLoopGate)) {
    for (const id of back.cycle) on.add(id);
  }
  return on;
}

/* ── 校验 ── */

export type DagCheck = { ok: true } | { ok: false; error: string };

/** 校验图时要知道的那点外部事实。不传 = **任何环都不放行**(老行为)。 */
export interface DagCheckOptions {
  /**
   * 这个节点是不是**岔路口**(分支节点)—— 环上的"闸门"。
   *
   * 做成回调而不是在这一层查节点类型,是因为"谁是分支"要读节点类型清单,而那是主进程
   * 的事(`orchestration/nodeTypes.ts` 要读盘)。contracts 这边只认"有人告诉我它是"。
   */
  isLoopGate?: (nodeId: string) => boolean;
}

/**
 * 校验图是否可用。**存盘前必须过这一道** —— 有环的图会让调度器永远等不到就绪
 * 节点,那不是报错,是静默卡死。
 *
 * 检查项:节点 id 重复 / 边指向不存在的节点 / 自环 / 无闸门的环。
 *
 * ## 环**不是**一律拒绝的
 *
 * 环上有一个岔路口就能存(见文件头的「回头」)。判据是"环上有没有闸门",不是"环了几条边"
 * —— 闸门意味着绕一圈至少要有用户点一下,所以图上画得出来、也一定停得下来。
 *
 * ⚠️ **闸门必须在环上,不是在别处。** 一张图里另有一个岔路口,和这个环没关系,绕这个环
 * 一圈可以一次都不经过它 —— 那样它就还是个没人拦着的死循环。
 */
export function validateDag(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  opts?: DagCheckOptions,
): DagCheck {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, error: `节点 id 重复:${node.id}` };
    ids.add(node.id);
  }

  for (const edge of edges) {
    if (!ids.has(edge.from)) return { ok: false, error: `边 ${edge.id} 的上游节点不存在:${edge.from}` };
    if (!ids.has(edge.to)) return { ok: false, error: `边 ${edge.id} 的下游节点不存在:${edge.to}` };
    if (edge.from === edge.to) return { ok: false, error: `节点 ${edge.from} 不能依赖自己` };
  }

  // **有回边 ⟺ 有环**(深度优先的标准结论),所以一次 DFS 就够了,不用再跑一遍消解。
  // 报错时按 id 排序,保证同样输入报同样的节点。
  const open = backEdgesOf(nodes, edges).filter(
    (b) => !b.cycle.some((id) => opts?.isLoopGate?.(id) ?? false),
  );
  if (open.length > 0) {
    const onCycle = [...new Set(open.flatMap((b) => b.cycle))].sort();
    return {
      ok: false,
      error:
        `图里有环,涉及节点:${onCycle.join("、")}。` +
        "环上必须有一个**岔路口**(分支节点)—— 它的每一条出路都要用户点一下才走," +
        "所以有它在才停得下来。想让这一段反复来,就把某个分支的一条出路指回前面去。",
    };
  }
  return { ok: true };
}

/* ── 分层(自动布局用) ── */

/**
 * 这张图里**有下游**的那些节点(把边起点收成集合;起点不在图上的边不算)。
 *
 * 单独提出来是因为它有两个消费方,而这两处**必须给出同一个答案**:
 *  - 调度器的 {@link planOf} —— 决定提示词里说"你是最后一步"还是"你只做这一步";
 *  - 设置界面 —— 决定要不要提示"这一步后面没有别的步骤"。
 *
 * 各写一遍的话,用户会在界面上看到"你是最后一步",而模型在提示词里读到的是另一回事。
 * 那种不一致没有报错、只有一次跑歪,是最难查的一类。
 */
export function nodesWithDownstream(doc: WorkflowDoc): Set<string> {
  const ids = new Set(doc.nodes.map((n) => n.id));
  return new Set(doc.edges.map((e) => e.from).filter((id) => ids.has(id)));
}

/**
 * 每个节点所在的层(画布上的列)。**最长路径分层**:节点的层 = 它所有上游的层
 * 的最大值 + 1,根节点为 0。于是"互不依赖的节点落在同一层",同层即视觉上的可并行。
 *
 * **回边不参与分层。** 环体里那几步在原图上互为上下游,按它们算的话谁都拿不到层、
 * 全被赋 0 —— 用户会看到「成稿」和「稿子怎么样」叠在左边缘上,而它们明明是一前一后。
 * 把回边摘掉之后剩下的是一张 DAG,分层就回到"从左到右是流程"这个本来的意思上;
 * **那条回边在画布上照画**(见渲染端),只是它不决定列位。
 *
 * 摘掉**所有**回边,而不是只摘"环上有闸门"的那些:闸门是存盘那一关的事
 * ({@link validateDag}),而这里是几何 —— 一份坏图(没闸门的环)也该画得出来,
 * 好让用户看见它、然后去修。
 *
 * 复杂度 O(V·E),工作流的规模(几十个节点)下完全无所谓。
 */
export function topoLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, number> {
  const layers = new Map<string, number>();
  for (const node of nodes) layers.set(node.id, 0);

  const back = new Set(backEdgesOf(nodes, edges).map((b) => b.edge.id));
  const forward = edges.filter((e) => !back.has(e.id));

  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  for (const edge of forward) {
    if (incoming.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const base = layers.get(id) ?? 0;
    for (const edge of forward) {
      if (edge.from !== id || !incoming.has(edge.to)) continue;
      // 最长路径:多次被指向时取最深的那个,否则会把下游排到它上游的左边
      layers.set(edge.to, Math.max(layers.get(edge.to) ?? 0, base + 1));
      const next = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, next);
      if (next === 0) queue.push(edge.to);
    }
  }
  return layers;
}

/* ── 自动布局 ── */

/**
 * 卡片尺寸。**画布和主进程用的是同一份** —— 见 {@link autoLayout}。
 *
 * 尺寸按"**两行**"定:标题一行、类型+能力一行。卡片上那句"出了什么问题"**顶掉能力
 * 标签**、不另起一行(见 `WorkflowNodeCard`)—— 三种提示同时最多出现一种,专门为它
 * 留一行是白留,而多留的那十几像素每张卡片都要付。
 *
 * 缩过一次(2026-09-16):208×60 → 176×48。一张图动辄十来个节点,原来那个尺寸在画布
 * 上占得太满,一屏看不下几步。
 */
export const NODE_W = 176;
export const NODE_H = 48;
/**
 * **层与层之间**的间隔 —— 流程方向上的那一档。
 *
 * 图是**从上往下**走的(一层一行),所以这一档是**纵向**的,而且比同层内那档大得多:
 * "一层一层往下"是这张图唯一要让人一眼看出来的结构,而它靠的就是这个间距差。
 */
export const LAYER_GAP = 68;
/** **同一层内**相邻两个节点之间的间隔(横向那一档)。同层的那几步是并列的,挨着放才
 *  看得出并列。 */
export const SIBLING_GAP = 24;
/** 网格步长(= 卡片尺寸 + 对应的间距)。 */
export const CELL_W = NODE_W + SIBLING_GAP;
export const CELL_H = NODE_H + LAYER_GAP;

/**
 * 按依赖把节点排成**行**(Y = 层号)与行内顺序(X = 层内次序)。
 *
 * **从上往下走**:层号越大越靠下,同层的那几步横着并排。竖着排是因为一条流程的步骤
 * 多半是"一步接一步"的一长串,而屏幕是竖的 —— 横着排会把第十步推到屏幕外面去。
 *
 * 分层用 {@link topoLayers}(最长路径)。**层内保持已有的左右顺序** —— 按当前 `x` 排序,
 * 所以"整理布局"是整理,不是把顺序推倒重来。
 *
 * 返回 `id → 新坐标`,由调用方一次性写回文档。不在这里改文档,是因为这个函数只做几何。
 *
 * ## 为什么在 contracts 而不是渲染端
 *
 * 它有两个调用方,而且**必须给出一模一样的答案**:画布的「整理布局」按钮,以及主进程那
 * 边——AI 通过 MCP 建出来的工作流**没有坐标可言**,得由代码排一份给它(见
 * `main/mcp/mcodeServer.ts`)。两处各写一份的话,漂移的表现是"AI 建的图在画布上叠成
 * 一坨",而同一条理由已经让 {@link topoLayers} 和 {@link upstreamClosure} 待在这里了。
 */
export function autoLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, WorkflowPosition> {
  const layers = topoLayers(nodes, edges);
  const byLayer = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    let list = byLayer.get(layer);
    if (!list) {
      list = [];
      byLayer.set(layer, list);
    }
    list.push(node);
  }

  const out = new Map<string, WorkflowPosition>();
  for (const [layer, list] of byLayer) {
    // 同层内按当前 x 排;x 相同(刚建出来的一行)时按 id 排,保证同样输入同样输出。
    list.sort((a, b) => a.position.x - b.position.x || a.id.localeCompare(b.id));
    list.forEach((node, index) => {
      out.set(node.id, { x: index * CELL_W, y: layer * CELL_H });
    });
  }
  return out;
}

/* ── 邻接表(调度器用) ── */

export interface WorkflowAdjacency {
  /** nodeId → 它依赖的节点(上游)。 */
  deps: Map<string, string[]>;
  /** nodeId → 依赖它的节点(下游)。失败时要按这个传播 skip。 */
  dependents: Map<string, string[]>;
}

/**
 * 摘掉**全部**回边之后剩下的边。
 *
 * "谁在谁前面"这类判断一律用它 —— 回边在**结构上**指向后面(它从环的出口指回入口),
 * 拿它当"上游"会得出「成稿」在「稿子怎么样」后面这种恰好相反的结论。用法见
 * {@link buildForwardAdjacency}。
 *
 * 这里摘**全部**回边,不看环上有没有闸门:函数算的是几何/可达性,而那些判断在坏图上
 * 也该给得出答案(坏图要画得出来,用户才修得了)。"这条回边算不算数"是执行语义,
 * 在 {@link loopBackEdgesOf} 那边。
 */
export function forwardEdgesOf(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): WorkflowEdge[] {
  const back = new Set(backEdgesOf(nodes, edges).map((b) => b.edge.id));
  return edges.filter((e) => !back.has(e.id));
}

/**
 * 从边派生邻接表。**这是节点"依赖谁"的唯一来源** —— 节点上不存 `dependsOn`。
 *
 * 主进程用它算"就绪节点"(依赖全部完成)与"失败传播"(下游全标 skip);
 * 渲染端用它画依赖多选的候选项。
 *
 * ⚠️ **`deps` 含回边,别直接拿它当"上游"。** 要"谁在谁前面"用
 * {@link buildForwardAdjacency} —— 见 {@link forwardEdgesOf} 里那段。
 */
export function buildAdjacency(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowAdjacency {
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    deps.set(node.id, []);
    dependents.set(node.id, []);
  }
  for (const edge of edges) {
    if (!deps.has(edge.to) || !dependents.has(edge.from)) continue;
    (deps.get(edge.to) as string[]).push(edge.from);
    (dependents.get(edge.from) as string[]).push(edge.to);
  }
  return { deps, dependents };
}

/**
 * 只按**前进边**派生的邻接表 —— 回边不算依赖。
 *
 * 拿它做就绪判断、上游闭包、变量候选:这三件事问的都是"谁在我**前面**",而回边的源头
 * 在我后面。含进回边的后果各不相同,而且都不报错:
 *
 * - 就绪判断:入口要等出口、出口要等入口,环一次都转不起来(见调度器的 `forwardDeps`);
 * - 变量候选:菜单里列出一步**还没跑**的节点,选中了就是个取不到的值。
 */
export function buildForwardAdjacency(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowAdjacency {
  return buildAdjacency(nodes, forwardEdgesOf(nodes, edges));
}

/**
 * 一个节点的**上游传递闭包** —— 它能引用的全部节点(`@contracts/nodeTemplate`)。
 *
 * 传递闭包而不是直接依赖:「前面几步拼出来的东西」本来就可能跨过中间那一步(中间那步
 * 只是把材料整理了一下)。而**只认上游**这条不能松:上游是这张图唯一的求值顺序承诺,
 * 允许引用旁支的话,同一张图在改动依赖之后会给出不同结果,而那种问题只在某些执行顺序
 * 下才出现。
 *
 * 定在 contracts 是因为**两处要用同一份**:调度器拿它解算 `{{...}}`
 * (`orchestration/scheduler.ts`),检查器的「插入变量」拿它列候选。两处各写一遍的话,
 * 迟早出现"菜单里选得到、跑起来说不是上游"。
 *
 * ⚠️ `deps` 要传 {@link buildForwardAdjacency} 的那一份,**不是**含回边的那一份 ——
 * 否则一个环体里的节点会把**自己**算进自己的上游,于是 `{{这一步.产出}}` 在它自己的
 * 指令里是合法的,而那个值要到它跑完才有。
 */
export function upstreamClosure(deps: Map<string, string[]>, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(deps.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(deps.get(id) ?? []));
  }
  return seen;
}
