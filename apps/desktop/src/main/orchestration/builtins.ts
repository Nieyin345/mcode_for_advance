import { MEMORY_WORKFLOWS } from "./memoryWorkflows.js";
/**
 * 内置工作流 —— 六个对话模式 + 三条自动化(长任务守望、导入后取原文、下载完转 Markdown),
 * id 沿用原来那五个模式的名字。
 *
 * ## id 沿用旧值是**故意的**
 *
 * `sessions.composer_mode` 列里已经存着 `default` / `search` / `read` / `write` /
 * `review` / `code` 这些值。内置工作流继续用同样的 id,那些旧行就**不需要任何迁移**
 * —— 老会话打开时仍然落在同一个流程上。用户自建的用 `wf_` 前缀,两者天然不撞。
 *
 * ## 两种形态并存,不是过渡期的权宜
 *
 * - **提示词型**:`prompt` 是一段流程文字,直接注入对话的系统提示词。
 * - **图型**:`nodes` + `edges` 表达流程,由调度器按依赖驱动。
 *
 * 两者的差别是**真的**:
 *
 * - **图型**:每一步是**一段指令 + 上游的结果**,靠产出变量传值(所以指令必须自足),
 *   能并排跑的步骤会一起起跑。其中 `mcode.agent` 那种**另开一段独立会话**(互相看不见),
 *   而 `mcode.main` / `mcode.conversation` **跑在主对话里**(看得见全部聊天记录)。
 * - **提示词型**:一整段话,全程同一个上下文,所以能写"边聊边定"。
 *
 * **2026-09-16 起 `search`(文献检索)与 `write`(文献写作)改成了图型。** 这两个
 * 流程原本就是**分步**的(定方向 → 构检索式 → 检索 → 入库;明确 → 核对引用 → 写),
 * 每步的边界本来就清楚,拆成节点之后:
 *
 * - 每一步有自己的**卡片**,用户看得见流程走到哪儿了、卡在哪一步;
 * - 「检索式」这类中间产物变成了**要交出来的东西**(产出变量),而不是一段聊天记录;
 * - 文献写作多了一个**岔路口**:成稿之后由用户决定「再改一轮」还是「就这样定稿」,
 *   而**没走的那条路不会把后续步骤拖下水**(见 `scheduler.ts` 里 `unselected` 那段)。
 *
 * `read` / `review` / `code` **仍然是提示词型** —— 精读和评审本质上是"一口气读完再
 * 说话",拆成节点只会把一次通读切成几段互不相干的检查。**逐个流程评审后再动**,不
 * 一次性全改。
 *
 * ## 提示词型那三个:正文**原地引用**,不搬家
 *
 * `prompt` 直接取 `COMPOSER_MODE_PROMPTS` 的那一段。这样 `docs/工作模式.md` 里
 * "改一边必须同步另一边"的纪律仍然成立 —— 正文只有一份。搬进来就成了第二份真相,
 * 而两份流程文字一定会漂移。
 *
 * ⚠️ 改写成图的那两个**已经把那一段从 `COMPOSER_MODE_PROMPTS` 里删掉了** —— 留着
 * 就是一份没人读的旧正文,而"到底哪份在跑"从此说不清。它们的流程文字现在活在
 * **节点的指令**里,人读的那一份在 `docs/工作模式.md`。
 */

import {
  autoLayout,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import { BUILTIN_WORKFLOW_IDS, type BuiltinWorkflowId } from "@contracts/runtime";
import {
  NODE_CODE_LANGUAGE_KEY,
  NODE_CODE_PARAM_KEY,
  NODE_CODE_TIMEOUT_KEY,
  NODE_CONDITION_EXPRESSION_KEY,
  NODE_CRITERIA_PARAM_KEY,
  NODE_FLOW_RECORD_PARAM_KEY,
  NODE_INJECT_MODE_KEY,
  NODE_INJECT_TARGET_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_TRIGGER_EVENTS_PARAM_KEY,
  NODE_TRIGGER_FILTER_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
} from "@contracts/nodeType";
import { COMPOSER_MODE_PROMPTS } from "@main/lib/systemPrompt.js";
import { CONDITION_NODE_TYPE_ID } from "@contracts/nodeType";
import { LIT_IMPORT_PY, MINERU_PY } from "@main/workflows/assets.js";

/** 内置工作流的 id。**直接引用 contracts 那一份,不在这里复制一份。**
 *
 *  这两份列表曾经各写各的(选择器一份、这里一份),注释里还写着"一一对应,不是巧合"
 *  —— 那正是两份状态一定会漂移的样子。漂移的表现是"选择器里选得到,运行时报查不到"。
 *  见文件头「id 沿用旧值是故意的」。 */
export { BUILTIN_WORKFLOW_IDS };
export type { BuiltinWorkflowId };

export function isBuiltinWorkflowId(value: unknown): value is BuiltinWorkflowId {
  return typeof value === "string" && (BUILTIN_WORKFLOW_IDS as readonly string[]).includes(value);
}

/* ── 图型内置工作流的构造 ── */

/** 图型内置工作流的一个节点,坐标先不给。 */
type NodeSpec = Omit<WorkflowNode, "position">;

/**
 * 把一组节点排好版。
 *
 * **坐标现算,不手写。** 手写的那一份会在 `CELL_W` 改掉的那天变成一坨叠在一起的
 * 卡片 —— 而那是纯视觉的坏法,没有任何测试会红,也没人会想到去查内置工作流的坐标。
 * `autoLayout` 本来就是干这个的(画布的「整理布局」和 AI 建的图用的是同一份)。
 */
function graph(nodes: readonly NodeSpec[], edges: readonly WorkflowEdge[]): WorkflowNode[] {
  const placed: WorkflowNode[] = nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } }));
  const at = autoLayout(placed, [...edges]);
  return placed.map((n) => ({ ...n, position: at.get(n.id) ?? n.position }));
}

/** 一条边。id 沿用界面那套约定(`e_<from>__<to>`)—— 用户在画布上改这张图时,
 *  新拉的线和这几条长得一样。 */
function wire(
  from: string,
  to: string,
  extra: { label?: string; note?: string } = {},
): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, ...extra };
}

/* ── 文献检索(图型)────────────────────────────────────────── */

const SEARCH_NODES: readonly NodeSpec[] = [
  {
    id: "main",
    type: "mcode.main",
    title: "定方向",
    // 默认只读:这一步只问和确认,不动任何东西。
    params: {
      instruction: [
        "先确认这一轮要找什么。用户给出的往往只是一句笼统的话 —— 用 AskUserQuestion 一次问 2–4 项,每项都给出可点击的选项(推荐的默认值放在第一项),尽量让用户点选而不是输入:",
        "",
        "- 他最想解决的**具体问题**是什么(不是大领域,而是这一轮要找什么);",
        "- 研究的**角度或切入点**;",
        "- 有没有**明确排除**的方向;",
        "- 有没有**已知的关键工作**可以作为锚点。",
        "",
        "⚠️ 提示词末尾「这次的固定条件」一段给出的那几项是用户设好的习惯,**不要再问他**;而且**要把那几条原样转写进你的产出「检索方向」的末尾**(一行一条,如「- 时间范围:近三年」)—— 下游步骤全靠产出里带的这几条执行筛选,漏了就没了。用户已经说清楚的部分直接采用,不必再走一遍流程问一遍。",
        "",
        "**先看一眼手上有什么检索工具。** 这个软件自己**不带**任何联网检索 / 下载文献的能力 —— 那些由用户接入的外部 MCP 服务提供(工具名各家不同,看你的工具表里有哪些)。一个能联网检索文献的工具都没有时,**开场就如实告诉用户**,并建议他在设置 → MCP 里接一个,不要硬走下面的步骤。",
        "",
        "**同时确认这批文献放进哪个分类。** 检查本次对话的附件里有没有文献库分类:",
        "",
        "- **有** → 直接使用,并用一句话告知用户;",
        "- **没有** → 让用户在两者之间选择:「挂一个现有的分类」或「新建一个分类」。挂现有的用 `library_collections` 列出候选,再用 `library_attach_to_chat` 挂上;新建用 `library_create_collection` 建好后挂上。**挂上之后用户的界面上会真的多出这个附件**,所以要说一句「已挂上」。",
        "",
        "**做完的样子**:这两件事都有了答案 —— 一句具体到能直接拿去构检索式的方向,以及一个**已经挂在这个对话上**的分类(他在左栏和输入框上看得见)。检索本身是后续步骤的事。",
      ].join("\n"),
      outputVars: [
        {
          name: "检索方向",
          example:
            "卫星量子密钥分发里的波长选择方案对比。要的是近三年把波长选择和星地链路衰减放在一起做的那些工作;不要纯粹的诱骗态协议改进。锚点:用户手上已有的一篇 2023 年 NP 的星地 QKD 综述。",
        },
      ],
      // **固定条件**:输入框上方那排下拉框的条目表。这四条原本写死在渲染端的
      // `SearchFilterBar` 里,现在搬进主节点参数 —— 候选值可以在这里改,条件可以加删。
      // 注入时机:每次运行最开始,随运行提示词进**这一步**(见 `runner.ts`),一次;
      // 下游步骤从上游产出里拿条件 —— 所以上面的指令要求把这几条转写进产出。
      [NODE_CRITERIA_PARAM_KEY]: [
        { name: "时间范围", choices: ["不限", "近三年", "近五年", "近十年"] },
        {
          name: "期刊层次",
          choices: ["不限", "只要 T1(Q1 或中科院 1 区,或 Top)", "T1 或 T2(Q1/Q2,或中科院 1/2 区)"],
        },
        { name: "影响因子", choices: ["不限", "≥ 3", "≥ 5", "≥ 10"] },
        { name: "每源条数", choices: ["10 条", "20 条", "50 条"] },
      ],
    },
  },
  {
    id: "query",
    type: "mcode.agent",
    title: "构造检索式",
    params: {
      instruction: [
        "把上游给出的方向**转换成可用的检索式**,并**先经用户确认再继续**。",
        "",
        "**检索式用英文词写。** 常见的学术检索源(Crossref / arXiv / OpenAlex / Semantic Scholar…)都按英文元数据匹配,整句中文提交过去命中为零。所以:",
        "",
        "- 把方向拆成 **2–4 个概念块**(例:量子密钥分发 / 卫星 / 波长选择);",
        "- 每个概念块给一组**英文同义词**,块内用 OR 连接;",
        "- 概念块之间用 AND 连接;",
        "- 中文专有词(算法名、机构名)保留拉丁拼写;",
        "- 概念块越少命中越多 —— 先用最核心的两三个。",
        "",
        "把**概念块 → 同义词**整理成一张表交给用户,问一句「这样拆对吗?要加或去掉哪个词?」,**用 AskUserQuestion 让他确认**。他改动之后就地改完,确认之后再交出最终那一条。",
        "",
        "**做完的样子**:用户已经点过头,而你手上是一条**能原样提交给检索工具**的完整检索式 —— 概念块、同义词、连接词都在里面。中间那张对照表交出去了,改动也落进最终那一条了。",
      ].join("\n"),
      outputVars: [
        {
          name: "检索式",
          example:
            '("quantum key distribution" OR QKD) AND (satellite OR "space-borne" OR "satellite-to-ground") AND ("wavelength selection" OR "wavelength division" OR "wavelength optimization")',
        },
      ],
    },
  },
  {
    id: "run",
    type: "mcode.agent",
    title: "检索并按条件筛",
    params: {
      instruction: [
        "用上游给出的检索式,调用**你工具表里那个外部检索工具**(由用户接入的 MCP 服务提供;这个软件自己不带检索)执行检索,每源条数按上游产出里带的固定条件。**把用过的检索式和用的是哪个工具告知用户** —— 他需要知道你在搜什么才能纠正你。",
        "",
        "**命中为零或明显跑偏时换用词重试**:先减少概念块,再替换同义词,把几轮尝试走完再下结论。拿跑偏的结果凑数,后面每一步都会跟着偏。",
        "",
        "取得命中之后,按上游产出里带的固定条件过一遍:",
        "",
        "- 年份直接按元数据筛;",
        "- **期刊层次和影响因子只能用工具查**(用户接入的期刊数据 / 分区查询工具,有就用),凭印象报的区号和影响因子会直接错;",
        "- 没有这样的工具、或查不到时,如实说明「期刊数据不可用,这次无法按层次筛选」,**不要编数字**;",
        "- 条件过严导致一篇都不剩时,如实说明并询问用户是否放宽,放宽与否由他定。",
        "",
        "交出筛选之后**仍然保留**的那一份清单,一篇一行,带齐后续判断需要的字段(标题、年份、期刊、DOI)。",
        "",
        "**做完的样子**:清单上每一条都来自真实命中,而且都过了上游带来的那几项条件;用过的检索式已经告诉用户;筛选中的例外(数据缺失、条件过严)已经如实交代。清单为空也是一个说得出理由的结论。",
      ].join("\n"),
      outputVars: [
        {
          name: "候选清单",
          example:
            "[1] Wavelength selection for satellite QKD | 2023 | Optics Express | 10.1364/OE.480123\n[2] Optimal wavelength in space-borne QKD | 2022 | PRApplied | 10.1103/PhysRevApplied.17.034056",
        },
      ],
    },
  },
  {
    id: "pick",
    type: "mcode.agent",
    title: "判断并入库",
    // **写能力**:这一步要往用户的库里塞东西(`library_import_files` / 外部工具的入库)。
    // 默认的 `read` 会把这一步按在计划模式里,连一次导入都做不成。
    capability: "write",
    params: {
      instruction: [
        "逐条审阅这份候选清单,判断哪些确实和方向相关。看标题和摘要即可。",
        "",
        "**挑中一篇就立刻处理一篇**:用外部检索 / 下载工具把它的 PDF 拿到本地,再用 `library_import_files` 收进库。拿不到 PDF 时,当前工具没有创建无文件条目的入口:不要调用 `library_write_note`、不要声称已经入库;在最终答复里列出来源和待入库原因。**给成功入库的每篇写一句总结**(30–80 字,说清:这篇讲了什么、**为什么值得收录**、和用户的方向是什么关系,用 `library_write_note` 写在该条目上)。用户左栏里会立刻多出成功入库的条目,所以他随时看得见进度、也随时可以叫停 —— 攒到最后一次性导入,他要等到底才知道你收了什么。",
        "",
        "**总结写「为什么值得收」**,不复述标题或摘要。不相关的跳过就行,不必逐条解释原因。",
        "",
        "导入前先用 `library_search` 查一下库里有没有,已有的跳过(除非用户明确要求)。",
        "",
        "全部处理完之后用一段话收尾:实际入库了几篇、哪些因未取得 PDF 待入库、分别属于哪个方向、有什么缺口(某个子方向一篇都没找到)。**转录由用户配的自动化接手**(成功入库会发事件),这一步到此为止。",
        "",
        "**做完的样子**:清单上每一条都有了结论(入库、待入库或跳过);每一条实际入库的都带着自己那句总结;**收尾那段话留到清单上每一条都处理完之后再写**。",
        "",
        "**边界**:每一条入库的都必须来自检索工具的**真实命中** —— DOI、作者、年份一律从命中结果里抄进总结,凭记忆写出来的 DOI 会往库里塞一篇不存在的文献。宁可少而准:用户的库要能一眼看懂。",
      ].join("\n"),
    },
  },
];

const SEARCH_EDGES: readonly WorkflowEdge[] = [
  wire("main", "query"),
  wire("query", "run"),
  wire("run", "pick"),
];

/* ── 文献写作(图型,带一个岔路口)────────────────────────────── */

const WRITE_NODES: readonly NodeSpec[] = [
  {
    id: "main",
    type: "mcode.main",
    title: "明确写什么",
    params: {
      instruction: [
        "先弄清这次要写的是什么:**哪一段 / 哪一节、给谁看、大概多长、中文还是英文**。说不清楚就先用 AskUserQuestion 问一句(给出可点击的选项),拿到答案再动笔 —— 这四项里错一项,整篇都要重写。",
        "",
        "用户手上已有的稿子或材料,在这一步一并问清楚放在哪里。",
        "",
        "**做完的样子**:这四项都有了明确答案,而且用户那份材料的位置也记下来了。正文留到后续步骤。",
      ].join("\n"),
      outputVars: [
        {
          name: "写作要求",
          example:
            "《引言》的第一节,投稿用的中文期刊论文,600 字左右。要交代清楚这个方向为什么值得做,并在结尾点出本文要解决的问题。",
        },
      ],
    },
  },
  {
    id: "refs",
    type: "mcode.agent",
    title: "核对引用",
    params: {
      instruction: [
        "把这一步要用到的文献**逐条核实** —— 这是整条流程最硬的一步。",
        "",
        "- 用 `library_search` / `library_items` 在库里确认每一条**确实存在**,并从它的笔记 / 转录正文里抄录真实的引用信息(作者、年份、期刊、DOI)—— 库里的条目本身只记标题,引用字段要从内容里读;",
        "- 手上有 `.bib` 时执行 `python \"<脚本目录>/check_citations.py\" refs.bib` —— 它逐条对库,把「库里没有、也对不上」的挑出来。**那一档一律不引。**",
        "- 核不到的,**如实列出**交给用户决定。作者、年份、DOI 一律从库里的查询结果抄 —— 编出来的引用会往用户的库里塞一篇不存在的文献。",
        "",
        "**这一步只核对,落笔留给下游。**",
        "",
        "**做完的样子**:两样都交齐 —— 能引的那几条(**每条都带着库里查到的真实字段**),以及**没能核到的那几条**(把用户原本提到的样子照抄下来,而不是一句「有几条没找到」)。两样都可能是空的,空的写成「无」,照样交。",
      ].join("\n"),
      outputVars: [
        {
          name: "可引文献",
          example:
            "[1] 张三, 李四. 星地量子密钥分发中的波长优化. 物理学报, 2023. DOI: 10.7498/aps.72.20230456\n[2] Alice B, et al. Wavelength selection for satellite QKD. Opt. Express, 2022. DOI: 10.1364/OE.470123",
        },
        {
          name: "没核到的",
          example:
            "用户提到的「2024 年那篇 Nature Photonics 的星地 QKD 综述」在库里没有,检索也没找到对应条目。",
        },
      ],
    },
  },
  {
    id: "draft",
    type: "mcode.agent",
    title: "成稿",
    // **写能力**:成稿可能要落成文件(`write` → `acceptEdits`,写盘不再逐次弹审批)。
    capability: "write",
    params: {
      instruction: [
        "按上游给出的写作要求写作。中文学术写作规范:",
        "",
        "- 结论先行,一段一个论点,顺着论证往下走(「首先 / 其次 / 最后」式的流水叙述会让论证散成一张清单);",
        "- 术语前后一致,首次出现时给出中英文对照;",
        "- 每句话都落到具体的对象、数字或机制上(「具有重要意义」「取得了良好效果」这类句子没有信息量,写进去等于占位);",
        "- **只引「可引文献」里那几条**,引用处给出真实的作者 / 年份 / DOI;",
        "- 「没核到的」那几样**一律不进正文** —— 需要它们的地方写「此处待补」,让那个空位留在明面上。",
        "",
        "**需要成段写作时直接给出成稿**,「写作建议」对下游没有用。要落成文件就写成**新文件**:`library/` 下的 PDF 与 Markdown 是资料(按内容哈希寻址,重新转换会覆盖编辑),用户的笔记是别人的稿子 —— 这两处除非用户明确说写的就是那一份,否则另起新文件。",
        "",
        "**当上下文里出现「流程记录」时**:如果其中已经有这一步此前的产出,说明用户在分支处选择了「再改一轮」—— **这一轮是改稿,不是重写。** 以前一版为基础修改:",
        "",
        "- 用户点到的地方按他说的改,未提及的部分**原样保留**(另行润色、调整结构、更换术语都会让他以为改错了地方);",
        "- 改完把**完整的正文**重新交一遍(不是只交改动的那几句),用户下一眼看到的就是这一份;",
        "- 用户说的若是别的意思(例如提问,或让你解释某处为什么这么写),**先回答他**,并说明正文这次没有改动。",
        "",
        "**做完的样子**:交出的是一份**可以直接读的完整正文** —— 不是提纲、不是片段、不是写作建议;正文里出现的每一条引用都能在上游的「可引文献」里找到;需要未核实内容的地方写着「此处待补」。",
      ].join("\n"),
    },
  },
  {
    id: "fork",
    type: "mcode.branch",
    title: "稿子怎么样",
    params: {},
  },
  {
    id: "final",
    type: "mcode.agent",
    title: "定稿",
    capability: "write",
    params: {
      // **显式打开「读流程记录」。** 定稿不在环上(默认是关的),而它恰恰是最需要看
      // 全程的一步 —— 它要交代"这一稿是怎么改过来的、哪几处仍是「此处待补」",而
      // 那些只在记录里。环上的「成稿」不用写,它默认就是开的(见调度器 `readsRecord`)。
      [NODE_FLOW_RECORD_PARAM_KEY]: true,
      instruction: [
        "用户认为可以了。把稿子整理成**最终交付的样子**:",
        "",
        "- 交完整的正文,内容保持这一版(定稿是整理,不是又一轮写作);",
        "- 需要落成文件就写成新文件,并说明写到哪儿了;",
        "- 收尾交代一句:这次写了什么、引了哪几篇、**有哪些地方仍然是「此处待补」** —— 没核到的引用即使定稿也照样留在清单上。",
        "",
        "**做完的样子**:用户手上是一份可以直接用的完整稿子,而且他知道哪里还空着。",
      ].join("\n"),
    },
  },
];

const WRITE_EDGES: readonly WorkflowEdge[] = [
  wire("main", "refs"),
  wire("refs", "draft"),
  wire("draft", "fork"),
  // 两条出路。**「再改一轮」是一条回边** —— 它指回「成稿」,于是「成稿 → 稿子怎么样」
  // 这一段会真的再走一遍(见 `scheduler.ts` 的「回头」)。
  //
  // 为什么不做成两个节点(「成稿」后面再挂一个「修订」):那样只能表达**固定几轮**,
  // 想再改一轮就得再加一个节点,而"几轮才够"是跑起来才知道的。回边把这件事交回给用户
  // —— 每绕一圈都要在岔路口点一下,所以它既停不下来也跑不飞。
  wire("fork", "draft", {
    label: "再改一轮",
    note: "用户对现在这版还不满意。按他下面说的改，**只改他提到的地方**，其余原样保留。",
  }),
  wire("fork", "final", {
    label: "就这样，定稿",
    note: "用户认为可以了。把稿子整理成最终交付的样子，内容保持这一版。",
  }),
];

/* ── 长任务守望(图型,内置模板)────────────────────────────── */

/**
 * 守望模板的 id 与**图上三个节点的 id** —— 「守望」按钮起跑时靠它们找到入口、
 * 把这一次的命令与消息填进去(见 `automationRunner.startWatch`)。
 *
 * ⚠️ 它**不在** `BUILTIN_WORKFLOW_IDS` 里:那份列表是**对话模式下拉**的六个,
 * 守望不是一种聊天模式,不该出现在那儿。它只出现在工作流库的「自动化」栏,
 * 以及会话输入区那颗「守望」按钮后面。
 */
export const WATCH_WORKFLOW_ID = "watch";
export const WATCH_TRIGGER_NODE_ID = "watch-trigger";
export const WATCH_COMMAND_NODE_ID = "watch-command";
export const WATCH_SAY_NODE_ID = "watch-say";

/**
 * 触发器上「这次要做什么」的兜底。用户把模板改到把这句话删了的时候,守望按钮
 * 照这句话起跑 —— 而不是带着一句空请求跑出去。
 */
export const WATCH_DEFAULT_TASK =
  "运行「跑命令」里写的那条命令,等它退出,把退出码与输出尾部交给下一步。";

/**
 * 注入那一步的默认指令。发进发起会话的是**完整的一轮提示词**(命令的退出码、
 * 输出尾部这些上游产出由调度器拼在这句话后面),所以这里只需要把
 * "为什么这条对话里突然冒出一条消息"交代清楚。
 */
export const WATCH_DEFAULT_MESSAGE =
  "守望的命令已经跑完了。下面是这次守望的说明,以及命令的退出码与输出尾部 —— 请接着处理。";

const WATCH_NODES: readonly NodeSpec[] = [
  {
    id: WATCH_TRIGGER_NODE_ID,
    type: "mcode.trigger",
    title: "守望入口",
    params: {
      triggerKind: "manual",
      // ⚠️ **空是故意的**:内置模板没法预知这台机器上有哪些项目。守望按钮起跑时
      // 会把**发起会话的项目**填进来并顺手存一份(见 `automationRunner.startWatch`)
      // —— 所以用过一次之后,这一项就有着落了。在那之前想在库里手工「立刻运行一次」,
      // 先在触发器上把项目填上(存盘那一关本来就要求它非空)。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: "",
      [NODE_TRIGGER_TASK_PARAM_KEY]: WATCH_DEFAULT_TASK,
    },
  },
  {
    id: WATCH_COMMAND_NODE_ID,
    type: "mcode.command",
    title: "跑命令",
    params: {
      // 面板每次起跑都会填(选的模板或现写的那条),这里只是让图开箱看着是个完整的东西。
      command: "echo done",
      timeoutMs: 0,
    },
  },
  {
    id: WATCH_SAY_NODE_ID,
    type: "mcode.conversation",
    title: "回话",
    params: {
      [NODE_PROMPT_PARAM_KEY]: WATCH_DEFAULT_MESSAGE,
      // 守望的本职:发完就走,发回**发起会话**。想改成发完等一轮回答、或发进跑图的
      // 会话,在节点上改这两个下拉(见 `@contracts/nodeType` 的 INJECT_*)。
      [NODE_INJECT_MODE_KEY]: "auto",
      [NODE_INJECT_TARGET_KEY]: "origin",
    },
  },
];

const WATCH_EDGES: readonly WorkflowEdge[] = [
  wire(WATCH_TRIGGER_NODE_ID, WATCH_COMMAND_NODE_ID),
  wire(WATCH_COMMAND_NODE_ID, WATCH_SAY_NODE_ID),
];

/* ── 导入后自动取原文(内置自动化,事件触发)──────────────────────── */

/**
 * 与守望同款:它**不在** `BUILTIN_WORKFLOW_IDS` 里(那份是**对话模式下拉**的六个),
 * 只出现在工作流库的「自动化」栏。
 *
 * ## 它为什么是两条自动化,而不是一条
 *
 * 因为它要听的是**两个不同的时机**:
 *
 *  1. `library.item.imported` —— 库里多了一条,但**文件可能还没有**。这时能做的是
 *     "去把原文拿回来"(就是这一条);
 *  2. `library.item.downloaded` —— PDF **真到本地了**(见 `@contracts/runtime` 的
 *     `LibraryItemDownloadedEvent`;`library_attach_pdf` 挂上 PDF 时发)。想对着 PDF
 *     做事(转录)只能等这一刻,导入那一下动手只会扑空 —— 那是下面那条 `AUTO_CONVERT_*` 听的。
 *
 * ## 软件自己**不下载**(2026-09-27 起)
 *
 * 内置的下载队列(开放获取解析、机构登录、并发下载)随学术功能整体退役。这条自动化
 * 只是一个**壳**:它把"有条目没文件"这件事交给模型,由模型调**用户接入的外部 MCP
 * 下载工具**把 PDF 弄到本地,再用 `library_attach_pdf` 交回库。没有那样的工具时它
 * 什么都不做、如实说一句 —— 用户也可以把它关掉。
 *
 * ## 它们与「事件发生时」那条放宽是配对的
 *
 * 两个事件都**不属于任何项目**,而内置模板预置不出项目 id(项目 id 是建项目时现生成
 * 的)。所以「在哪个项目里跑」留空,由 `parseTriggerSpec` 放行、运行退回宿主目录 ——
 * 这两条要做的事(排队、转录)都是拿条目 id 去操作库里的文件,不需要工作目录。
 *
 * ## 这两条指令为什么都强调"就用载荷里那个 id"
 *
 * 因为**这两件事都是并发的**:批量导入时好几条连着进来,下载线程也是并行跑的。从前
 * 载荷里只有一句「发生了「library.item.imported」」—— 那条指令只能退而求其次,让模型
 * 去查"库里最新的一条"。它猜错的代价是**下错/转错了另一篇,而且不报错**。
 *
 * 现在载荷带着 `itemId` / `itemTitle` / `itemKind`(下载那条还带 `pdfPath`,见
 * `@contracts/hook` 的 `HOOK_EVENT_ITEM_FACT_FIELDS`),所以指令可以要求它照 id 办。
 *
 * ⚠️ 而且**可能不止一条**:触发器有个合并窗口(默认 2 秒),窗口里连着来的事件合一次
 * 运行。所以载荷上写的是「一共有 N 条,这次都要办」—— 指令里那句"见下面载荷"覆盖的是
 * **几条**,不是一条。少办一条的表现是那篇论文再也没人管,不报错。
 */
export const AUTO_DOWNLOAD_WORKFLOW_ID = "wf_auto_download";
export const AUTO_DOWNLOAD_TRIGGER_NODE_ID = "auto-download-trigger";
export const AUTO_DOWNLOAD_AGENT_NODE_ID = "auto-download-agent";
/** 收下表单里选中的文件那一步(code)。2026-09-28 加。 */
export const AUTO_DOWNLOAD_COLLECT_NODE_ID = "auto-download-collect";
/** 「填了 DOI 吗」那道判断(condition)。 */
export const AUTO_DOWNLOAD_GATE_NODE_ID = "auto-download-doi-gate";

/**
 * 触发器上「这次要做什么」的兜底。被触发时这句话就是**这次运行的请求**(根节点
 * 读到的那一句)。
 */
export const AUTO_DOWNLOAD_DEFAULT_TASK =
  "从「文献导入」表单来:选中的文件由第一步收进库,填的 DOI 由模型那一步用外部下载工具取回原文。转录由「文件在线转 MD」那条接手。";

const AUTO_DOWNLOAD_NODES: readonly NodeSpec[] = [
  {
    id: AUTO_DOWNLOAD_TRIGGER_NODE_ID,
    type: "mcode.trigger",
    title: "导入触发",
    params: {
      triggerKind: "event",
      // ⚠️ **空是故意的,而且现在是对的。** 内置模板没法预知这台机器上有哪些项目,
      // 而导入事件**不属于任何项目**。早先这里空着等于这条自动化**永远挂不上**
      // (`parseTriggerSpec` 一律要求项目非空);现在「事件发生时」允许留空,运行退回
      // 宿主目录 —— 这一步要做的只是"取回原文并挂上",不需要工作目录。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: "",
      [NODE_TRIGGER_TASK_PARAM_KEY]: AUTO_DOWNLOAD_DEFAULT_TASK,
      // 听哪个事件,取值来自 `@contracts/hook` 的 HOOK_EVENTS。
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.imported",
      // 留空:这个事件没有可筛的主语(没工具名、没文件路径,见 hookSubjectOf),
      // 填了也不会生效 —— validateTrigger 会直接拒。
      [NODE_TRIGGER_FILTER_PARAM_KEY]: "",
    },
  },
  {
    id: AUTO_DOWNLOAD_AGENT_NODE_ID,
    type: "mcode.agent",
    title: "按 DOI 取原文",
    // **写能力**:把 PDF 挂回库是写操作(`library_attach_pdf` 不在只读集合里)。默认的
    // `read` 会把这一步按在计划模式里,连一次都挂不上。
    capability: "write",
    params: {
      instruction: [
        "用户在「文献导入」表单里填的 DOI 是:{{trigger.input.doi}}",
        "",
        "可能是多个,用逗号分隔。**上游那道判断已经确认它像个 DOI 才会走到你这儿**,所以不必再怀疑它是不是空的。",
        "",
        "对每一个 DOI:",
        "",
        "- 用你手上的**外部 MCP 下载工具**(检索 / 下载文献的那些,名字各家不同,看你的工具表)找到并下载 PDF 到本地;",
        "- 下到了就调 `library_attach_pdf` 挂到对应条目上;库里还没有这一条时,先用 `library_import_files` 把 PDF 收进库,**不要另建空条目**;",
        "- 找不到可下载版本的**如实说明**,不要编造 DOI、链接或文件路径。",
        "",
        "⚠️ 这个软件自己**不会下载**任何东西(内置下载队列已随学术功能退役)。一个下载工具都没有时,如实说一句「没有可用的下载工具」,**不要用浏览器硬凑**。",
        "",
        "挂上 PDF 会触发「文件在线转 MD」那条自动化,**转录和挂回都不用你管**。",
        "",
        "**做完的样子**:每个 DOI 都交代过了(挂上的、拿不到的),各自什么标题、什么原因。",
      ].join("\n"),
    },
  },
  {
    id: AUTO_DOWNLOAD_COLLECT_NODE_ID,
    type: "mcode.code",
    title: "收下选中的文件",
    params: {
      [NODE_CODE_LANGUAGE_KEY]: "python",
      // 正文见 `workflows/assets.ts` 的 `LIT_IMPORT_PY`(同一份,不另抄)。
      [NODE_CODE_PARAM_KEY]: LIT_IMPORT_PY,
      // 它只报一句给宿主,真正的拷贝入库在主进程里做 —— 五分钟绰绰有余。
      [NODE_CODE_TIMEOUT_KEY]: 5 * 60 * 1000,
    },
  },
  {
    id: AUTO_DOWNLOAD_GATE_NODE_ID,
    type: CONDITION_NODE_TYPE_ID,
    title: "填了 DOI 吗",
    params: {
      // ⚠️ **判据是 contains \"10.\",不是 exists。** `exists` 问的是"有没有这个字段",
      // 而**空串也算存在**(见 `@contracts/condition`)—— 表单交上来一个空的 doi 字段,
      // 模型就得白跑一轮说"这次没填",那这道判断等于没立。所有 DOI 都以 10. 开头
      // (`10.1038/...`),这一条同时挡住"没填"和"填了空白",粘整串 doi.org 链接也命中。
      //
      // 事件触发(载荷里压根没有 input 这一项)时读到的是**缺失** —— `readConditionRef`
      // 对触发器名字空间的缺失键给 found=false,走 false,不会炸。
      //
      // ⚠️ **但「整份载荷都没有」是另一回事**:`scope.trigger === undefined` 时
      // `readConditionRef` 是**硬失败**(「这次运行没有触发器载荷」),条件节点当场判死、
      // 整次运行失败。这条流程只从自定义 UI / 事件起跑,两条都带载荷,所以撞不上;
      // 但把带 `{{trigger.*}}` 的条件节点放进一条**对话模式**的工作流就会炸 ——
      // 下一个抄这段的人要知道这一点。
      [NODE_CONDITION_EXPRESSION_KEY]: {
        logic: "and",
        rules: [{ ref: "{{trigger.input.doi}}", op: "contains", value: "10." }],
      },
    },
  },
];

const AUTO_DOWNLOAD_EDGES: readonly WorkflowEdge[] = [
  // 两路**并行**从触发器分出去:文件那一路不花钱、直接跑;DOI 那一路先过判断。
  wire(AUTO_DOWNLOAD_TRIGGER_NODE_ID, AUTO_DOWNLOAD_COLLECT_NODE_ID),
  wire(AUTO_DOWNLOAD_TRIGGER_NODE_ID, AUTO_DOWNLOAD_GATE_NODE_ID),
  wire(AUTO_DOWNLOAD_GATE_NODE_ID, AUTO_DOWNLOAD_AGENT_NODE_ID, {
    label: "true",
    note: "表单里填了 DOI —— 用外部下载工具把原文取回来。",
  }),
  // false 接回「收文件」而不是另造一个空节点:条件节点**必须恰好两条出边**
  // (`workflowValidation` 的 condition.edges),而这条边的语义正好是"没填 DOI,
  // 这次就只收文件"。汇合点在没走的支路上照常跑,所以收文件那步无论如何都执行。
  wire(AUTO_DOWNLOAD_GATE_NODE_ID, AUTO_DOWNLOAD_COLLECT_NODE_ID, {
    label: "false",
    note: "没填 DOI,这一路没活可干(收文件那步照常跑)。",
  }),
];

/* ── 下载完自动转 Markdown(内置自动化,事件触发)───────────────── */

/**
 * 这条自动化是**软件原来写死的那件事**的替代品。
 *
 * 早先「下载完就转录 Markdown」是一个注册进下载线程的钩子,做的事(pdf.js 抽文本)
 * 写在 `ipc/library.ts` 里 —— 用户改不了、换不掉,想接自己那套高质量转录工具只能去
 * 动源码。现在软件只发一条 `library.item.downloaded` 事件,转录这件事**变成一张用户
 * 看得见、改得动的图**。他可以把这一步换掉(改成调自己装的 OCR 工具)、加一步、或者
 * 干脆把这条自动化关掉。
 *
 * ## 为什么让模型去调工具,而不是写一段固定脚本
 *
 * 因为「转录」在这个软件里的**合法做法只有一条**:产生一份 `.md`(配图一起),然后用
 * `library_adopt_markdown` 挂回条目。而"哪条路能转出这份 md"是用户环境里的事实 ——
 * 他装的是 `mineru`,你装的是别的,第三个人干脆用手上的网页版转好再丢进来。
 * 让模型按条目状态决定调哪个工具,比在软件里枚举"支持哪些转录工具"要活得久。
 *
 * ⚠️ **这一步不能失败得无声无息。** 它跑在后台,用户不在场 —— 指令里要求"下不了的
 * 如实说明原因",就是为了让它至少有一条能查的痕迹(节点卡片上的产出)。
 */
export const AUTO_CONVERT_WORKFLOW_ID = "wf_auto_convert";
export const AUTO_CONVERT_TRIGGER_NODE_ID = "auto-convert-trigger";
export const AUTO_CONVERT_CODE_NODE_ID = "auto-convert-code";
export const AUTO_CONVERT_AGENT_NODE_ID = "auto-convert-agent";

export const AUTO_CONVERT_DEFAULT_TASK =
  "文档库里有一批文件刚导入或下载完成（见载荷中的条目列表，可能不止一条；尚无本地文件的跳过）。只用 MinerU 在线 API 转录并挂回对应条目；禁止本地抽取。";

/**
 * 转录那一步跑的 Python —— 调 MinerU 的**在线 API**。
 *
 * ## 为什么是 code 节点而不是让模型自己挑工具(2026-09-24 改)
 *
 * 原来这一段是**一条指令**,让模型"按手上的条件选一条路"(装了什么就调什么)。那写法
 * 有个说不出口的毛病:**转录这件事是确定性的**,而"模型会选对工具"不是 —— 它可能挑
 * 本地 `library_convert`(扫描件抽不出正文)、可能挑一个不存在的工具、可能干脆跳过。
 * 用户要的是"下完就转",那就不该经过一次判断。
 *
 * 现在改成**固定的两步**:触发 → code 节点调 MinerU 并挂回。判据全在脚本里(见
 * `workflows/assets.ts` 的 `MINERU_PY` 文件头:token 填在脚本顶上的 `TOKEN_INLINE`
 * 或走 `MINERU_TOKEN`、失败带原因退 1)。
 *
 * ## 脚本正文**直接当 `code`**,不落文件再调
 *
 * `mcode.code` 节点的 `code` 参数**就是代码正文**(它自己会写临时文件再跑),所以这里
 * 内嵌的是同一份 `MINERU_PY` —— 不需要拼路径、不需要管数据根在哪、也不怕用户删了
 * `<数据根>/workflows/scripts/` 里那份(那一份是给**模型**用 shell 调的,见
 * `systemPrompt.ts`;这条路完全不经过它)。
 *
 * ## 挂回也在这一步里(2026-09-28 去掉了子代理那一节)
 *
 * 挂回曾经是后面一个**子代理**节点:`library_adopt_markdown` 是主进程的 MCP 工具,
 * 而 code 节点起的是子进程,碰不到它,于是只能让模型去调。
 *
 * 可「把这份 md 挂到那个条目上」是**确定性**的事 —— 该挂哪条、挂哪个文件,上一步的
 * 产出里写得清清楚楚。让模型来做,换来的是它可能漏挂一条、可能挂错文件,每次还要
 * 花模型的钱;而漏挂的表现特别难查:**转都转了,就是没挂上,还不报错**。
 *
 * 现在脚本在 `outputs.adoptMarkdown` 里报「这几条要挂回」,由**主进程**逐条调
 * `adoptMarkdownFile`(与那个 MCP 工具同一个函数)。为什么不让脚本自己写库:文档库
 * 的底是 sql.js,子进程在旁边写 `mcode.db` 会把整个库覆盖掉 —— 见
 * `orchestration/adoptFromCode.ts` 的文件头。
 */
const AUTO_CONVERT_NODES: readonly NodeSpec[] = [
  {
    id: AUTO_CONVERT_TRIGGER_NODE_ID,
    type: "mcode.trigger",
    title: "文件导入或下载完成触发",
    params: {
      triggerKind: "event",
      // 同上面那条:事件不属于任何项目,留空跑在宿主目录。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: "",
      [NODE_TRIGGER_TASK_PARAM_KEY]: AUTO_CONVERT_DEFAULT_TASK,
      // 核心只入库并发事件；启用此自动化后，上传只通过工作流 code 节点执行。
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.imported,library.item.downloaded",
      [NODE_TRIGGER_FILTER_PARAM_KEY]: "",
    },
  },
  {
    id: AUTO_CONVERT_CODE_NODE_ID,
    type: "mcode.code",
    title: "调 MinerU 转 Markdown",
    params: {
      [NODE_CODE_LANGUAGE_KEY]: "python",
      // 正文见 `workflows/assets.ts` 的 `MINERU_PY`(同一份,不另抄)。
      [NODE_CODE_PARAM_KEY]: MINERU_PY,
      // 长论文 + 排队要时间。这一步真的会等:脚本自己轮询到 done 或超时。
      [NODE_CODE_TIMEOUT_KEY]: 30 * 60 * 1000,
    },
  },
];

const AUTO_CONVERT_EDGES: readonly WorkflowEdge[] = [
  wire(AUTO_CONVERT_TRIGGER_NODE_ID, AUTO_CONVERT_CODE_NODE_ID),
];

/* ── 内置工作流(六个对话模式 + 两条自动化)── */

/** 内置工作流的**默认版**。用户的修改不入这里 —— 它们存在 `workflows` 表里,
 *  同名 id 的一行覆盖这里的一份;「恢复默认」= 删掉那一行(见 `main/orchestration/`)。 */
export const BUILTIN_WORKFLOWS: readonly WorkflowDoc[] = [
  ...MEMORY_WORKFLOWS,
  {
    id: "default",
    // ⚠️ `name` / `description` 只是**兜底与日志用**。内置工作流在界面上显示的名字
    // 走 i18n(`composer.mode.*`,和原来那个模式下拉是同一组键),这样切语言时
    // 它们跟着变 —— 而用户自建的工作流用的是 `name` 字段(用户自己起的名字不该被翻译)。
    name: "默认",
    description: "不追加任何流程,通用研究助手。",
    icon: "message",
    // 默认模式**故意没有提示词** —— 它是"什么都不追加"的逃生口,身份片段与文件架构
    // 片段本来就在每一轮里。用空字符串而不是省略字段,是为了让"它有一条空提示词"
    // 和"这个字段没人填"在数据上可区分。
    prompt: "",
    nodes: [],
    edges: [],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "search",
    name: "文献检索",
    // ⚠️ 这条 `description` **会进提示词** —— 流程记录的开头就是它(`flowRecordSection`
    // 里那句「**本流程**:<名字> —— <这句>」),读它的是模型。所以写的是**这条流程
    // 是干什么的**,而不是给用户看的宣传语。
    //
    // (界面上显示的那一句不在这里 —— 内置工作流的名字与说明走 i18n,见
    // `renderer/lib/workflowLabels.tsx`。所以这一份可以专为模型写。)
    description: "确定检索方向,构造检索式,按期刊层次与年份筛选命中,逐条判断后入库。",
    icon: "world-search",
    // 图型:**没有 `prompt`**。流程文字在各节点的指令里,见 `SEARCH_NODES`。
    nodes: graph(SEARCH_NODES, SEARCH_EDGES),
    edges: [...SEARCH_EDGES],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "read",
    name: "文献精读",
    description: "定位、读全文、拆问题/方法/实验/局限。",
    icon: "book",
    prompt: COMPOSER_MODE_PROMPTS.read,
    nodes: [],
    edges: [],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "write",
    name: "文献写作",
    // 同 `search`:这一句会进提示词(流程记录的开头),所以写的是流程是干什么的。
    description: "先核实每一条引用确实存在,再落笔成稿;成稿之后由用户决定是再改一轮,还是就此定稿。",
    icon: "pencil",
    // 图型,带一个岔路口(见 `WRITE_EDGES`)。
    nodes: graph(WRITE_NODES, WRITE_EDGES),
    edges: [...WRITE_EDGES],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "review",
    name: "文献评审",
    description: "查贡献、查方法、查实验、查可复现性,逐条给可执行意见。",
    icon: "clipboard-text",
    prompt: COMPOSER_MODE_PROMPTS.review,
    nodes: [],
    edges: [],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "code",
    name: "代码编辑",
    description: "遵循代码库既有约定改代码,如实报告校验结果。",
    icon: "code",
    prompt: COMPOSER_MODE_PROMPTS.code,
    nodes: [],
    edges: [],
    builtin: true,
    updatedAt: 0,
  },
  {
    // **不是对话模式**(见 WATCH_WORKFLOW_ID 上的说明):它没有 prompt、不出现在
    // 模式下拉里。入口是会话输入区那颗「守望」按钮(D3),以及工作流库的自动化栏。
    id: WATCH_WORKFLOW_ID,
    name: "长任务守望",
    // 会进流程记录的开头(同 search/write 的规矩),写的是这条流程是干什么的。
    description: "跑一条命令,等它退出,把退出码与输出尾部注入发起会话。",
    icon: "eye",
    nodes: graph(WATCH_NODES, WATCH_EDGES),
    edges: [...WATCH_EDGES],
    trigger: "manual",
    builtin: true,
    updatedAt: 0,
  },
  {
    // 同守望:**自动化**,不出现在模式下拉里(见 AUTO_DOWNLOAD_WORKFLOW_ID 上的说明)。
    id: AUTO_DOWNLOAD_WORKFLOW_ID,
    name: "文献导入(PDF / DOI)",
    // 会进流程记录的开头(同 search/write 的规矩),写的是这条流程是干什么的。
    description: "自定义 UI 的「文献导入」入口:表单里选中的 PDF 由 code 节点收进库,填的 DOI 交给模型用外部下载工具取原文。",
    icon: "download",
    nodes: graph(AUTO_DOWNLOAD_NODES, AUTO_DOWNLOAD_EDGES),
    edges: [...AUTO_DOWNLOAD_EDGES],
    trigger: "event",
    builtin: true,
    updatedAt: 0,
  },
  {
    // 与上一条**配对**:上一条负责"把 PDF 弄下来",这一条负责"下完之后转 Markdown"。
    // 分开是因为它们听的是两个不同的时机(见 AUTO_DOWNLOAD_WORKFLOW_ID 上的说明)。
    id: AUTO_CONVERT_WORKFLOW_ID,
    name: "文件到位后在线转 Markdown",
    description: "启用并配置此自动化后，导入或下载完成的文件会上传到 MinerU 在线转录，再挂回对应条目。核心导入本身不转录；屏蔽设置只控制 AI 可见性，不是上传开关。",
    icon: "file-text",
    nodes: graph(AUTO_CONVERT_NODES, AUTO_CONVERT_EDGES),
    edges: [...AUTO_CONVERT_EDGES],
    trigger: "event",
    builtin: true,
    updatedAt: 0,
  },
];

/** 按 id 取内置工作流的默认版。 */
export function getBuiltinWorkflow(id: string): WorkflowDoc | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.id === id);
}
