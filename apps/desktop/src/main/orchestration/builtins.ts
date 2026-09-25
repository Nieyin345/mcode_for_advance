/**
 * 内置工作流 —— 六个对话模式 + 两条自动化(长任务守望、文献自动下载),
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
import { MINERU_PY } from "@main/workflows/assets.js";

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
        "⚠️ 提示词末尾「这次的固定条件」一段给出的那几项(时间范围、期刊层次、影响因子、每源条数)是用户设好的习惯,**不要再问他**;而且**要把那几条原样转写进你的产出「检索方向」的末尾**(一行一条,如「- 时间范围:近三年」)—— 下游步骤全靠产出里带的这几条执行筛选,漏了就没了。用户已经说清楚的部分直接采用,不必再走一遍流程问一遍。",
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
        "**检索式用英文词写。** Crossref / arXiv / OpenAlex 都按英文元数据匹配,整句中文提交过去命中为零。所以:",
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
        "用上游给出的检索式执行 `library_search_online`,每源条数按上游产出里带的固定条件。**把用过的检索式告知用户** —— 他需要知道你在搜什么才能纠正你。",
        "",
        "**命中为零或明显跑偏时换用词重试**:先减少概念块,再替换同义词,把几轮尝试走完再下结论。拿跑偏的结果凑数,后面每一步都会跟着偏。",
        "",
        "取得命中之后,按上游产出里带的固定条件过一遍:",
        "",
        "- 年份直接按元数据筛;",
        "- **期刊层次和影响因子用 `library_journal_rank` 查出来**,把候选的期刊名一次传入 —— 凭印象报的区号和影响因子会直接错;",
        "- 期刊数据查不到时,如实说明「期刊数据不可用,这次无法按层次筛选」;",
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
    // **写能力**:这一步要往用户的库里塞东西(`library_add_paper`)。默认的 `read`
    // 会把这一步按在计划模式里,连一次导入都做不成。
    capability: "write",
    params: {
      instruction: [
        "逐条审阅这份候选清单,判断哪些确实和方向相关。看标题和摘要即可。",
        "",
        "**挑中一篇就立刻导入一篇**:用 `library_add_paper` 导入,并在**同一次调用里写下总结**(30–80 字,说清:这篇讲了什么、**为什么值得收录**、和用户的方向是什么关系)。用户左栏里会立刻多出这一条,所以他随时看得见进度、也随时可以叫停 —— 攒到最后一次性导入,他要等到底才知道你收了什么。",
        "",
        "**总结写「为什么值得收」**,不复述标题或摘要。不相关的跳过就行,不必逐条解释原因。",
        "",
        "导入前先用 `library_search` 查一下库里有没有,已有的跳过(除非用户明确要求)。",
        "",
        "全部处理完之后用一段话收尾:入库了几篇、分别属于哪个方向、有什么缺口(某个子方向一篇都没找到)。**下载和转录由应用自动完成**,这一步到此为止。",
        "",
        "**做完的样子**:清单上每一条都有了结论(入库或跳过);每一条入库的都带着自己那句总结;**收尾那段话留到清单上每一条都处理完之后再写**。",
        "",
        "**边界**:每一条入库的都必须来自 `library_search_online` 的**真实命中** —— DOI、作者、年份一律从命中结果里抄,凭记忆写出来的 DOI 会往库里塞一篇不存在的文献。宁可少而准:用户的库要能一眼看懂。",
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
        "- 用 `library_search` / `library_items` 在库里确认每一条**确实存在**,并抄录它给出的真实字段(作者、年份、期刊、DOI);",
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

/* ── 文献自动下载(内置自动化,事件触发)──────────────────────── */

/**
 * 与守望同款:它**不在** `BUILTIN_WORKFLOW_IDS` 里(那份是**对话模式下拉**的六个),
 * 只出现在工作流库的「自动化」栏。
 *
 * ## 它为什么是两条自动化,而不是一条
 *
 * 因为它要听的是**两个不同的时机**:
 *
 *  1. `library.item.imported` —— 库里多了一条,但**文件还没下来**。这时能做的是
 *     "给它排队下载"(就是这一条);
 *  2. `library.item.downloaded` —— PDF **真到本地了**(见 `@contracts/runtime` 的
 *     `LibraryItemDownloadedEvent`)。想对着 PDF 做事(转录)只能等这一刻,导入那一下
 *     动手只会扑空 —— 那是下面那条 `AUTO_CONVERT_*` 听的。
 *
 * `imported` 这一半是**兜底**:按标识符导入(DOI / arXiv)那条路自己会排队
 * (`operations.importIdentifiers` 末尾那句 `enqueueDownloads`),而按文件导入、
 * 手动加条目、以及"当时下不动"的那批都不会。所以这条自动化是给它们留的第二次机会
 * —— 用户也可以把它关掉。
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

/**
 * 触发器上「这次要做什么」的兜底。被触发时这句话就是**这次运行的请求**(根节点
 * 读到的那一句)。
 */
export const AUTO_DOWNLOAD_DEFAULT_TASK =
  "资料库刚有新条目导入。把**这次导入的那几条**(见下面载荷里的「条目:」那几行;可能不止一条)排队下载,并汇报结果。";

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
      // 宿主目录 —— 这一步要做的只是"排队下载",不需要工作目录。
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
    title: "排队下载",
    // **写能力**:排队下载是写操作(`library_download` 不在只读集合里)。默认的
    // `read` 会把这一步按在计划模式里,连一次下载都排不上。
    capability: "write",
    params: {
      instruction: [
        "资料库里刚有新条目导入了。**是哪几条见下面那段载荷里的「条目:」那几行**(id 和标题",
        "都在那儿;批量导入时那儿会有好几条,写着「一共有 N 条,这次都要办」)。",
        "你的任务:**把里面列出来的每一条都排队下载**,一条都不许落下。",
        "",
        "做法:",
        "",
        "- **就照着载荷里那些 id 一条条办**,不要自己去查「最新导入的」—— 批量导入时好几条会",
        "  连着进来,猜错了下的是别的一篇,而且不报错;",
        "- 调 `library_download` 给每一条排队 —— 它要求条目有 DOI / arXiv ID 或可用的链接;",
        "- 两条标识都没有的条目下载不了,**如实说明缺了什么,不要编造 DOI**;",
        "- 已经有 PDF 的条目跳过,不要重复排队。",
        "",
        "**做完的样子**:载荷里列的每一条都交代过了(排上队的、跳过的、下不了的),并向用户" +
          "汇报 —— 排了几条、各自什么标题;下不了的说明原因。下载由应用自动完成,不需要你等它下完。",
      ].join("\n"),
    },
  },
];

const AUTO_DOWNLOAD_EDGES: readonly WorkflowEdge[] = [
  wire(AUTO_DOWNLOAD_TRIGGER_NODE_ID, AUTO_DOWNLOAD_AGENT_NODE_ID),
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
  "资料库里有一批的 PDF 刚下载完(**是哪些见下面载荷里的「条目:」那几行**;可能不止一条)。把它们各自转成 Markdown 挂回对应条目。";

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
 * 现在改成**固定的三步**:触发 → code 节点调 MinerU → 子代理挂回。中间那步的判据全在
 * 脚本里(见 `workflows/assets.ts` 的 `MINERU_PY` 文件头:token 从 `MINERU_TOKEN` 取、
 * 失败带原因退 1)。
 *
 * ## 脚本正文**直接当 `code`**,不落文件再调
 *
 * `mcode.code` 节点的 `code` 参数**就是代码正文**(它自己会写临时文件再跑),所以这里
 * 内嵌的是同一份 `MINERU_PY` —— 不需要拼路径、不需要管数据根在哪、也不怕用户删了
 * `<数据根>/workflows/scripts/` 里那份(那一份是给**模型**用 shell 调的,见
 * `systemPrompt.ts`;这条路完全不经过它)。
 *
 * ## 为什么挂回要单独一步(不能并进 code 节点)
 *
 * `library_adopt_markdown` 是**主进程的 MCP 工具**,而 code 节点起的是**子进程** ——
 * 它碰不到。所以"转"和"挂回"必须分两步:code 节点产出 md,子代理拿它去挂。
 */
const AUTO_CONVERT_NODES: readonly NodeSpec[] = [
  {
    id: AUTO_CONVERT_TRIGGER_NODE_ID,
    type: "mcode.trigger",
    title: "下载完成触发",
    params: {
      triggerKind: "event",
      // 同上面那条:事件不属于任何项目,留空跑在宿主目录。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: "",
      [NODE_TRIGGER_TASK_PARAM_KEY]: AUTO_CONVERT_DEFAULT_TASK,
      // ⚠️ **必须是 `downloaded`,不能是 `imported`。** 导入那一下 PDF 还没下来,
      // 拿它当转录时机只会扑空 —— 而"扑空"的表现是安静地什么都没发生。
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
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
  {
    id: AUTO_CONVERT_AGENT_NODE_ID,
    type: "mcode.agent",
    title: "挂回库",
    // **写能力**:转录产物要挂回条目(`library_adopt_markdown` 是写工具)。默认的
    // `read` 会把这一步按在计划模式里 —— 无人值守时计划模式等于拒绝执行。
    capability: "write",
    params: {
      instruction: [
        "上一步已经用 MinerU 把 PDF 转成了 Markdown,产物路径在它的产出里",
        "(`outputs` 里每条一个 `mdPath`;那是一份 `full.md`,同级的 `images/` 里是配图)。",
        "",
        "你的任务:**把每一份转出来的 Markdown 挂回它对应的条目**。",
        "",
        "做法:调 `library_adopt_markdown`,`itemId` 是那条条目、`path` 是那份 `full.md` 的",
        "**绝对路径**。**配图按 md 里的引用搬,不用你挑目录** —— 所以你只需把 `full.md`",
        "指对(不是它旁边那个 `images/`)。",
        "",
        "⚠️ **可能不止一份**(下载是并发跑的,合并窗口里可能攒了好几条)。上一步的产出里",
        "每一条各自有一份 md,一条都不许落下 —— 少挂一条的表现是那篇**转都转了、却没人",
        "挂上去**,而且不报错。",
        "",
        "**做完的样子**:每一条都交代过了 —— 挂上的(条目详情页读得到)、挂不上的",
        "(说明为什么);并向用户汇报每条多少字、几张图。",
      ].join("\n"),
    },
  },
];

const AUTO_CONVERT_EDGES: readonly WorkflowEdge[] = [
  wire(AUTO_CONVERT_TRIGGER_NODE_ID, AUTO_CONVERT_CODE_NODE_ID),
  wire(AUTO_CONVERT_CODE_NODE_ID, AUTO_CONVERT_AGENT_NODE_ID),
];

/* ── 内置工作流(六个对话模式 + 两条自动化)── */

/** 内置工作流的**默认版**。用户的修改不入这里 —— 它们存在 `workflows` 表里,
 *  同名 id 的一行覆盖这里的一份;「恢复默认」= 删掉那一行(见 `main/orchestration/`)。 */
export const BUILTIN_WORKFLOWS: readonly WorkflowDoc[] = [
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
    name: "文献自动下载",
    // 会进流程记录的开头(同 search/write 的规矩),写的是这条流程是干什么的。
    description: "资料库有新条目导入时,读出最新导入的条目,有 DOI/arXiv 或链接的就排队下载 PDF。",
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
    name: "下载完自动转 Markdown",
    description: "资料库某条目的 PDF 下载完成时,把它转成 Markdown 并挂回该条目。",
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
