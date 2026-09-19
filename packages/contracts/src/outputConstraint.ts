/**
 * 节点产出的**变量表** —— 这一步会交出来哪几样东西,以及怎么保证它真的交出来了。
 *
 * ## 用户看到的是「变量名 + 一个例子」,看不到 JSON
 *
 * 界面上只有一张两栏的表:
 *
 * | 变量名 | 示例 |
 * |---|---|
 * | 年份 | 2024 |
 * | 标题 | 量子纠缠的实验检验 |
 *
 * 底下确实还是 JSON(不然代码没东西可提取),但**那是软件的事**:用户填完表,软件把
 * 它拼成一段样例交给模型,再按同一个形状把产出解回来。**任何一步都不需要用户写 JSON,
 * 界面上也不出现"JSON"这个词** —— 一个不会写代码的人应该能配完这一步。
 *
 * 示例那一栏**不是可选的**:它比任何描述都更能说明"这个字段该填什么",而且它就是
 * 给模型看的形状。少了它,模型只能靠猜。
 *
 * ## 一个节点身上的硬约束有两处,而它们是同一件事
 *
 * | | 什么时候查 | 查什么 |
 * |---|---|---|
 * | **变量引用**(`@contracts/nodeTemplate`) | 跑**之前** | 引用的那一步、那个变量在不在 |
 * | **产出变量**(本文件) | 跑**之后** | 产出里有没有这几样东西 |
 *
 * 两处都是"**代码说了算**":配置错了就明确失败,不指望模型自觉。分开写不是因为它们
 * 不同,而是因为它们卡在流程的两头 —— 一头是输入,一头是产出。
 *
 * ## 为什么"必须有"这件事要代码来管
 *
 * 「期望产出」原来只有一段**文本**,写给模型看("请输出年份和标题")。那是**软**的:
 * 模型大多数时候会照做,偶尔会先说一句"好的,这是结果:"再给内容,或者漏掉一样。
 * 下游拿到的是文本,它没法知道这次是不是那个意外。
 *
 * 硬约束把"大多数时候"变成"要么对、要么这一步失败"。失败是**好事**:一张图里某一步
 * 悄悄给了个不完整的东西,错误会一路传到最下游才暴露,而那时已经看不出是哪一步的问题。
 *
 * ## 判定用的还是"提取",不是"整段必须长这样"
 *
 * 模型围着结果说一句话(或者把它放进 ``` 围栏里)是**常态**,不是错误。要求"整段一字不差"
 * 会把大量其实没问题的产出判死,而那种失败用户会觉得莫名其妙。
 *
 * 所以判据是:**能从产出里提出一个对象** —— 先找 ``` 围栏,再找第一段配平的 `{}`。
 * 提取规则是确定的、可断言的,不是"大概认得出来"。
 */
import { z } from "zod";
import { isModelDecider, type NodeTypeManifest } from "./nodeType.js";
import { RESERVED_VAR_NAMES } from "./nodeTemplate.js";

/* ── 约定键 ── */

/** 产出的**文字说明**(软约束)。写给模型看的,代码不查。 */
export const NODE_OUTPUT_CONTRACT_KEY = "outputContract";
/** 产出的**变量表**(硬约束)。值是 `OutputVar[]`,见 {@link OutputVar}。 */
export const NODE_OUTPUT_VARS_KEY = "outputVars";

/* ── 变量 ── */

/**
 * 一个变量:**名字** + **一个例子**。
 *
 * 名字同时是三样东西:界面上那一栏、给模型看的字段名、下游引用时写的那个词。所以它
 * 不能是空的、不能重复、也不能撞上内置的那几个字段(见 {@link RESERVED_VAR_NAMES})。
 */
export const OutputVarSchema = z.object({
  name: z.string().min(1),
  example: z.string(),
});
export type OutputVar = z.infer<typeof OutputVarSchema>;
export const OutputVarsSchema = z.array(OutputVarSchema);

/**
 * 变量名里不能有的字符。花括号会破坏 `{{...}}` 的语法,点号会和字段路径打架。
 *
 * ⚠️ 不许叫 `output` / `status` / `error` / `title` / `user` 那一条**不在这里** ——
 * 那份名单属于解算那一端(`@contracts/nodeTemplate` 的 `RESERVED_VAR_NAMES`),这里
 * 只是引用它。两张表各自写一遍的话,迟早有一边加了词、另一边没加。
 */
const BAD_VAR_CHARS = /[{}.\s]/;

/* ── 从参数里取(带清单门) ── */

/**
 * 这份清单用不用产出变量。**只有声明了 `outputVars` 的类型才有"配错了"这回事。**
 *
 * 这道门不是洁癖:节点换过类型之后,`params` 里会留下上一个类型的键(检查器专门有一段
 * 显示"不认识的参数"),其中可能有一个仍然合法的变量表。不设门的话,一个跟产出毫无
 * 关系的节点会突然开始因为"产出里没有某某"而失败。
 */
export function usesOutputRules(manifest: { params: readonly { key: string }[] }): boolean {
  return manifest.params.some((p) => p.key === NODE_OUTPUT_VARS_KEY);
}

/**
 * 从节点参数里取出变量表。**只留下形状对的那些** —— 参数是用户和 AI 都能写的自由数据,
 * 一条脏记录不该让整个节点崩掉,但它也确实不算数(真正的拦截在
 * {@link validateOutputRules},那里会把它变成一条存不下去的错误)。
 */
export function outputVarsOf(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
): OutputVar[] {
  if (!usesOutputRules(manifest)) return [];
  return normalizeVars(params[NODE_OUTPUT_VARS_KEY]);
}

/* ── 分支(模型选)的那一项固定产出 ── */

/**
 * 分支节点且**决定权给模型**时(见 `{@link isModelDecider}`)必须交出来的那一项,
 * 名字就叫**「出路」**。
 *
 * ## 为什么走向要装在一个变量里
 *
 * 这种分支跑完要**自己**选一条出边,而"它选了哪条"必须是一份**可校验**的东西:交给模型
 * 自由发挥的话,下游拿到的是一句"我觉得应该进入查重环节",而调度器要的是一个能对上某条
 * 边的**名字**。把它做成产出变量,就复用了这条管道现成的一切 —— 少了一样这一步失败、
 * 值写进 `NodeOutcome.outputs`、下游能 `{{那一步.出路}}` 取到。
 *
 * ## 值必须是某条出边的名字,一字不改
 *
 * 匹配顺序:先比出边的 `label`(选项名),再比目标节点的标题,两边都去空白、大小写不敏感。
 * 编一个不在其中的名字 = 这一步**失败**,不是"猜一条最近的"。理由和产出约束那边一样:
 * 含糊的走向比一个明确的失败危险得多 —— 后者当场看得见,前者要等下游全跑偏才暴露。
 *
 * ## 它不在 {@link RESERVED_VAR_NAMES} 里
 *
 * 那份名单的语义是"解算时内置字段优先"(撞上就永远取不到),与这里要表达的"不许重复
 * 声明"是两件事。所以那条规矩写在 {@link validateOutputRules} 里,针对这一种分支单独一条。
 */
export const DECIDE_VAR_NAME = "出路";

/**
 * 这一步要交给模型的全部产出变量 —— 分支(模型选)会**追加**「出路」。
 *
 * ## 为什么收口成一个函数
 *
 * 三处要给出**同一个答案**:调度器发提示词时(要模型交出这几样)、调度器查产出时(要按
 * 同样的名单查)、渲染端的结果卡摊变量时(要按同样的名单显示)。三处各拼一遍,迟早出现
 * "提示词里要了、查的时候没算上"这种错 —— 而它的表现是这一步永远失败。
 *
 * `options` 是它**能有**的那几条出路的名字(出边的选项名,没填 label 时是目标节点标题)。
 * 例子取第一条 —— 那是最直白的示范("照这个样子填").一条出路都没有时**不追加**:那种图
 * 节点根本选不了路,该失败在"没有出边"那一条上,而不是逼模型交一个交不出来的值。
 *
 * ⚠️ **这里**只有"用户定的"和"分支的出路"两样 —— **清单声明的 `outputs` 不在内**。
 * 那几样是**运行时填的**(`commandRunner` 往 `outcome.outputs` 里塞的 `exitCode`),
 * 不是模型要交的东西;并进来会让每一个 agent 节点都被要求"只交一个 `{"summary": ...}`
 * 的对象",而 `withOutputCheck` 那边压根不查它 —— 等于凭空给模型加了一道假约束。
 * 菜单要列那几样是另一回事,见 {@link referenceableOutputsOf}。
 */
export function outputVarsFor(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
  options: readonly string[] = [],
): OutputVar[] {
  return withDecideVar(outputVarsOf(manifest, params), manifest, params, options);
}

/** 查产出时用的那一项(只有名字参与判定,例子在这一步没有意义)。 */
export const DECIDE_OUTPUT_VAR: OutputVar = { name: DECIDE_VAR_NAME, example: "" };

/* ── 一个节点**能被取到**的产出(用户定的 + 清单声明的 + 分支的「出路」) ── */

/**
 * 模型选的分支要追加「出路」这一项。抽出来是因为**两种产出名单都要走这一步**
 * ({@link outputVarsFor} 和 {@link referenceableOutputsOf}),而"什么算模型选的分支、
 * 没有出路时追不追加"这两条判据只该有一份。
 */
function withDecideVar(
  vars: OutputVar[],
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
  options: readonly string[],
): OutputVar[] {
  if (!isModelDecider(manifest, params) || options.length === 0) return vars;
  return [...vars, { name: DECIDE_VAR_NAME, example: options[0] as string }];
}

/**
 * 清单里 `outputs` 声明的那几样,**当成产出变量**。
 *
 * ## 为什么必须并进来(2026-09-19)
 *
 * 命令节点(`runner.kind === "command"`)在清单里声明了 `exitCode` / `stdout`,而运行
 * 时 `outcome.outputs` 里**真的有这两个键**(见 `commandRunner.ts`),存盘校验
 * (`workflowValidation.declaredOutputsOf`)也把它们算进"这一步声明过的产出"、放行
 * `{{某步.exitCode}}`。**三层里有两层认它,只有「插入变量」菜单不列** —— 于是这个
 * 能取到、校验也通过的东西,用户在界面上看不见、只能靠猜。
 *
 * `example` 取那一条 `label`(命令节点的 `stdout` 就是「输出尾部」这种)。这几样由
 * 运行时填,不是模型交的,所以它**只进菜单**,不进给模型看的那份({@link outputVarsFor})。
 */
export function manifestOutputVars(manifest: Pick<NodeTypeManifest, "outputs">): OutputVar[] {
  return (manifest.outputs ?? []).map((o) => ({ name: o.key, example: o.label }));
}

/**
 * 这个节点**下游引用得到的全部产出变量** —— 用户定的 + 清单声明的 + 分支的「出路」。
 *
 * ## 它和 {@link outputVarsFor} 差在哪、为什么必须有这一份
 *
 * 两者只差**清单声明的那几样**,而那几样恰好是"用户能不能从界面上发现它"的分水岭:
 *
 * | | 给模型看的 / 查产出的 | 菜单里列的 |
 * |---|---|---|
 * | `outputVarsFor` | ✅ 用户定的 + 出路 | ❌ 少列 `exitCode` / `stdout` |
 * | 本函数 | — | ✅ 三样齐全 |
 *
 * 用 `outputVarsFor` 去列菜单的话,菜单里就少了清单声明的那几样 —— 命令节点的
 * `{{那步.stdout}}` 能取到、存盘也放行,偏偏界面上没有,用户只能靠猜(这就是这个函数
 * 被拆出来的原因)。反过来拿本函数去发提示词,就会逼着每个 agent 节点交一个
 * `{"summary": ...}`(见 `outputVarsFor` 那段警告)。
 *
 * 一句话:**给人挑的名单 ⊇ 要模型交的名单**,多的那部分是运行时填的。
 */
export function referenceableOutputsOf(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
  options: readonly string[] = [],
): OutputVar[] {
  const vars = [...outputVarsOf(manifest, params), ...manifestOutputVars(manifest)];
  return withDecideVar(vars, manifest, params, options);
}

/** 把「出路」的值对上一条出边。**先比选项名,再比目标节点标题**,两边都去空白、
 *  大小写不敏感。对不上返回 `undefined`(调用方负责报出一条能照着改的错)。 */
export function matchDecisionOption(
  raw: string,
  options: ReadonlyArray<{ label: string; title: string }>,
): string | undefined {
  const want = raw.trim().toLowerCase();
  if (want.length === 0) return undefined;
  const hit =
    options.find((o) => o.label.trim().toLowerCase() === want) ??
    options.find((o) => o.title.trim().toLowerCase() === want);
  return hit?.label;
}

/** 把任意脏值收成一张变量表:丢掉不是对象的、名字空的、名字重复的。 */
export function normalizeVars(raw: unknown): OutputVar[] {
  if (!Array.isArray(raw)) return [];
  const out: OutputVar[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, example } = item as { name?: unknown; example?: unknown };
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({ name: trimmed, example: typeof example === "string" ? example : "" });
  }
  return out;
}

/* ── 校验 ── */

export type RulesCheck = { ok: true; vars: OutputVar[] } | { ok: false; error: string };

/**
 * 变量表本身有没有问题。**存盘前和派发前都会查**(同 `validateNodeParams` 的位置),
 * 因为一张配错的表不会报错 —— 它只会在某一步跑完之后以一个看不懂的理由失败。
 *
 * 这里用的名字是**界面上那个词**(「变量」),不是字段名(`outputVars`):看这句话的是
 * 配置节点的人,他看的是表单。
 */
export function validateOutputRules(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
): RulesCheck {
  if (!usesOutputRules(manifest)) return { ok: true, vars: [] };
  const raw = params[NODE_OUTPUT_VARS_KEY];
  if (raw === undefined || raw === null) return { ok: true, vars: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "产出变量应该是一张表" };

  const vars = normalizeVars(raw);
  const names = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "产出变量表里有一项不是「名字 + 示例」" };
    }
    const { name, example } = item as { name?: unknown; example?: unknown };
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: "产出变量有一项没填名字" };
    }
    const trimmed = name.trim();
    if (names.has(trimmed)) return { ok: false, error: `产出变量「${trimmed}」重复了` };
    names.add(trimmed);
    if ((RESERVED_VAR_NAMES as readonly string[]).includes(trimmed)) {
      return {
        ok: false,
        error: `产出变量不能叫「${trimmed}」—— 那是内置的名字(取结果文本、状态、错误、标题、用户请求用的),起了这个名字下游永远取到的是内置的那个`,
      };
    }
    // 分支(模型选)自己那一项(见 {@link DECIDE_VAR_NAME})。**不是**加进 RESERVED_VAR_NAMES:
    // 那份名单管的是"取不到",这一条管的是"不许重复声明" —— 两件事。
    if (isModelDecider(manifest, params) && trimmed === DECIDE_VAR_NAME) {
      return {
        ok: false,
        error: `「${DECIDE_VAR_NAME}」是这一步自己就要交的那一项(值就是它选的那条出路的名字),不用在表里再声明一遍`,
      };
    }
    if (BAD_VAR_CHARS.test(trimmed)) {
      return { ok: false, error: `产出变量「${trimmed}」里有空格、点号或花括号,换一个` };
    }
    if (typeof example !== "string" || example.trim().length === 0) {
      return {
        ok: false,
        error: `产出变量「${trimmed}」没填示例 —— 示例是给模型看的形状,少了它这一步的产出会飘`,
      };
    }
  }
  return { ok: true, vars };
}

/* ── 提取与检查(纯函数) ── */

/**
 * 从一段产出里提取一个对象。
 *
 * 两步,顺序是刻意的:
 *  1. **``` 围栏优先**。模型把结果放进围栏时,围栏里就是它的完整答案 —— 从整段里再找
 *     第一个配平的括号,可能先撞上正文里提到的一个花括号。
 *  2. 没有围栏就找第一段**配平**的 `{}`。配平要按字符串状态走(引号里的括号不算),
 *     否则 `{"a":"}"}` 里的那个 `}` 会提前收尾。
 *
 * 找不到 / 解不出来返回 `null`。
 */
export function extractJson(text: string): unknown | null {
  for (const candidate of jsonCandidates(text)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 这一段不是我们想要的形状 —— 试下一个候选(比如正文里先出现的一对花括号)。
    }
  }
  return null;
}

/** 按优先级给出**可能**是那个对象的片段。 */
function* jsonCandidates(text: string): Generator<string> {
  // 1) ```json ... ``` / ``` ... ``` 围栏
  const fence = /```[ \t]*[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = (match[1] ?? "").trim();
    if (body.length > 0) yield body;
  }
  // 2) 第一段配平的 {} —— 从第一个 `{` 起找它配平的那一段。
  const obj = balancedObject(text);
  if (obj !== null) yield obj;
}

/** 从 `{` 第一次出现的位置起,找它配平的那一段。 */
function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    // **引号里的括号不算** —— 否则 `{"a":"}"}` 会在那个 `}` 上提前收尾。
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 一次检查的结果。`value` 是提取出来的那个对象(没有变量要求时是 `undefined`)。 */
export type OutputCheck = { ok: true; value?: unknown } | { ok: false; error: string };

/**
 * 按变量表查一段产出。
 *
 * 报错的话术按"用户下一步要干什么"来写:说清**缺哪一样**、**它交了什么**(给一小段
 * 原文),而不是只说"格式不对" —— 那种话等于没说。
 */
export function checkOutput(text: string, vars: readonly OutputVar[]): OutputCheck {
  if (vars.length === 0) return { ok: true };

  const trimmed = text.trim();
  const value = extractJson(trimmed);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: `这一步应该交出来${vars.map((v) => `「${v.name}」`).join("、")},但产出里读不出这几样东西。实际给的是:${preview(trimmed)}`,
    };
  }

  const have = new Set(Object.keys(value as Record<string, unknown>));
  const missing = vars.filter((v) => !have.has(v.name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `这一步的产出缺少:${missing.map((v) => `「${v.name}」`).join("、")}${missing.some((v) => v.example.trim().length > 0) ? `(比如「${missing[0]?.example}」)` : ""}`,
    };
  }
  return { ok: true, value };
}

/** 产出的一小段原文,放进报错里。太长就截断 —— 报错是给人看的,不是把产出再贴一遍。 */
function preview(text: string, limit = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/**
 * 解出来的东西怎么放进 `NodeOutcome.outputs`,好让下游用 `{{某步.某变量}}` 取到。
 *
 * **只留表里声明过的那几样,多出来的一律不要。** 这是这张表最要紧的一条:它是一句
 * **承诺**,不是一份"最好有"的清单。模型这次心情好多给了一个字段、下次不给,如果那个
 * 多出来的字段也能被下游引用,那下游的失败就是**随机的** —— 今天跑得通明天跑不通,而
 * 图上没有任何地方能看出为什么。多出来的内容不会丢,它还在那一步的结果文本里。
 *
 * (`checkOutput` 只放行对象,所以走到这里的一定是对象 —— 数组和标量在那一步就失败了,
 * 不需要在这里再兜一次。)
 */
export function pickOutputs(value: unknown, vars: readonly OutputVar[]): Record<string, unknown> {
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const v of vars) out[v.name] = obj[v.name];
  return out;
}

/**
 * 变量值 → 给人看的文本:字符串 trim、undefined 空串、数组/对象原样 `JSON.stringify`。
 *
 * 这条规则在两处各写过一份(runner 的 structuredReplyText 给用户的变量卡片、scheduler
 * 的 recordBodyOf 写进流程记录),一处改了另一处忘了就会漂移 —— 收口到这里。
 * "记录是散文式的日志,但**结构化状态该保持结构**"(同 Anthropic 那条"状态用结构化
 * 格式、进度用散文")。
 */
export function outputValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/* ── 给模型看的那两段 ── */

/**
 * 变量表拼成的**样例** —— 这就是用户说的"示例是固定的,一定要有"。
 *
 * 交给模型的是一个**填好的具体例子**,不是一份要在脑子里执行的规范。这比任何描述都
 * 有效:模型照着形状填,值的类型(数字还是文字、一项还是一组)也一并带过去了。
 */
export function outputExampleOf(vars: readonly OutputVar[]): string {
  if (vars.length === 0) return "";
  const pairs = vars.map((v) => `${JSON.stringify(v.name)}: ${JSON.stringify(v.example)}`);
  return `{${pairs.join(", ")}}`;
}

/**
 * 拼进提示词的那一段。**只讲这件事本身**,标题由调用方加(它要把软的说明和这一节放在
 * 一起,两节标题会让"这一步要产出什么"看起来像两件事)。
 *
 * 措辞避开"JSON" —— 不是因为模型看不懂(它比谁都懂),而是因为这句话和界面上那段
 * 说明是同一件事的两种说法,用户迟早会看到这一份。用"照这个形状交"来说,不会写代码的
 * 人也能对上号。
 *
 * ## 「除了这个对象什么都不要写」这句是**硬约束的字面意思**
 *
 * 用户的规定:「这个节点如果加了硬约束,就不要有除了 json 以外的任何东西了,他的输出
 * 全部都是放在了变量里面,不需要多余的输出。」实测里模型交完那个对象之后又补了 5 条
 * 说明 —— 按这段话的字面意思,那 5 条是**多余的**。
 *
 * 两版措辞都试过,别再来回翻:
 *  - 「别用别的话把它包起来」——想说的是"对象别拆",但读起来像"这段别加注释",模型还是
 *    会另外写正文;
 *  - 「正文照常交,那几样另起一段列一遍」——反过来了,等于承认正文是正当产出。
 *
 * 定下来的这一版:**产出就是这个对象,别的一个字都不写**。值里面想放什么就放什么,
 * 所以内容一点没少,只是不再重复两遍。
 *
 * ⚠️ **这条成立的前提在界面上**:产出成了一坨对象之后,卡片**不能把原文摊给用户看**
 * (那正是用户说的"别让我看见 JSON")。`WorkflowStepCard` 拿解出来的变量逐项渲染,
 * 所以这里越严格,界面那边越好看。改这段话之前先看那一处。
 */
export function describeOutputVars(vars: readonly OutputVar[]): string {
  if (vars.length === 0) return "";
  return [
    "这一步的产出**就是这个对象** —— 除它之外**不要写任何内容**(不要开场白、不要解释、不要总结):",
    "",
    "```",
    outputExampleOf(vars),
    "```",
    "",
    `它包含:${vars.map((v) => `「${v.name}」`).join("、")}。**这些会被检查** —— 少一样这一步就失败,所以名字一个字都不能改。这几样要说的内容都写在**值里面**,不必在对象之外重复一遍。`,
  ].join("\n");
}
