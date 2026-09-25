/**
 * 节点提示词里的**变量** —— `{{某一步.output}}` 这种定点引用。
 *
 * ## 它和"上游结果自动拼在指令前面"是两件事
 *
 * 那个是**默认**:每个非根节点都会拿到上游摘要,摆在指令前面(见 `composeNodePrompt`)。
 * 绝大多数步骤这样就够了 —— 所以它是自动的。
 *
 * 变量解决的是它解决不了的那几种:
 *
 *  - **位置**:「把《{{检索.output}}》里的方法一节改写成……」—— 结果要嵌在句子中间,
 *    而不是整段摆在前面;
 *  - **挑一个**:上游有三个节点,只要其中一个的产出;
 *  - **参数本身**:「按 {{规划.params.target}} 这个目标来做」—— 要的是**配置**,
 *    不是结果;
 *  - **状态**:「如果 {{校验.status}} 是 failed 就重做」;
 *  - **产出里的一个变量**:「把 {{检索.年份}} 填进参考文献」—— 要的是**结构**,而结构
 *    来自那一步填的**产出变量表**(见 `@contracts/outputConstraint`)。
 *
 * ⚠️ 最后那一条要成立,上游那一步必须**填过产出变量**:没填的节点产出是一段自由文本,
 * 里面没有一样叫「年份」的东西可以取。这正是"变量引用本身就是硬约束"的意思 —— 两处
 * 都是"代码说了算,取不到就失败",只不过一处卡在跑之前(引用解不出来),一处卡在跑之后
 * (产出里少了几样东西)。
 *
 * ⚠️ 界面上**不该让人手打这些花括号**:检查器里那个「插入变量」把上游定过的变量列出来,
 * 点一下插到光标处(见 `NodeInspector`)。手打是给读提示词、写文档的人留的后路。
 *
 * ## 语法:为什么是 `{{ }}`
 *
 * 另外三种都被占了,而且都撞得很实:`${}` 是 shell 和模板字符串的插入语法(指令里
 * 真会出现),`@` 是附件引用(见 `@contracts/library`),`/name` 是技能。`{{ }}` 在
 * 这几种里面都不出现,而且一眼能看出"这是个占位符"。
 *
 * 指令里**真要写 `{{` 本身**(比如在讲某个模板语言的语法),用 `\{{` 转义。
 *
 * ## 引用不到就**明确失败**,不原样留着
 *
 * 这条和 `validateHook` / `instructionOf` 是同一条:错的配置**不会报错**,它只会让
 * 这一步拿着一句带 `{{...}}` 的指令跑起来 —— 模型看见一个花括号里的东西,多半会
 * 自己脑补一个值填进去,而那个值来自它的想象。这比"跑不了"难查一百倍。
 *
 * ## 只认**上游**
 *
 * 引用一个不是这一步上游的节点是错的,哪怕那个节点在图上、甚至已经跑完了。理由:
 * "上游"是这张图**唯一**的求值顺序承诺(见 `@contracts/workflow` 的 `edges`)。允许
 * 引用旁支,同一张图在改动依赖之后会给出不同的结果,而那种问题只在某些执行顺序下
 * 才出现。
 */
import type { NodeArtifact, NodeOutcome } from "./nodeType.js";

/** 一个可引用的节点在这一刻的样子。 */
export interface NodeTemplateNode {
  /** 节点 id。**引用时可以写 id,也可以写标题**(标题更好记)。 */
  id: string;
  title: string;
  /** 已经跑完才有。没跑完的节点引用它 —— 一定是"不是上游",在别处就拦下了。 */
  outcome?: NodeOutcome;
  /** Stable references to artifacts produced by this node. */
  artifacts?: NodeArtifact[];
  /** 它的参数。`{{某步.params.目标}}` 取的就是这里。 */
  params: Record<string, unknown>;
}

export interface NodeTemplateScope {
  /** 用户这次发的请求。`{{user}}`。 */
  user: string;
  /** **这一步的上游**(依赖闭包)的节点名 —— id 与标题都算。只有这些能引用。 */
  upstream: ReadonlySet<string>;
  /** 图上所有节点(不止上游)。留着是为了在报错时说清楚"这个节点在,但不是你的上游"。 */
  nodes: readonly NodeTemplateNode[];
  /**
   * **这次触发载荷的平面事实**(`{{trigger.<键>}}`),没被触发器起就是 `undefined`。
   *
   * 它**不是节点**,所以不走 `upstream` / `nodes` 那两张表 —— 见下面 `resolveOne` 里
   * 那一段。这一格的存在是因为**同一个字符串里两种名字空间混着写是常态**:
   * 调度器给的指令是 `"上游是 {{检索.年份}},这次是 {{trigger.at}} 触发的"`,
   * 而解算这条指令的是**一次** `renderTemplate`。
   *
   * ⚠️ 从前这两个名字空间是**两个展开器**(调度器先跑 `expandTriggerVars`、再跑这一支),
   * 于是整串里只要混了一处 `{{trigger.*}}`,第一个展开器就把这一整串**原样交出去**
   * (它认不出 `{{检索.年份}}`,只能不碰),第二个展开器再把 `{{trigger.at}}` 当节点名
   * 报「引用不到」。两个展开器各自都对,拼在一起就是"一个用不了的写法"。
   */
  trigger?: Readonly<Record<string, unknown>>;
}

/** 一次解算的结果。失败时 `error` 是**可以直接显示给用户**的一句话。 */
export type TemplateResult = { ok: true; text: string } | { ok: false; error: string };

/** `{{ ... }}`,中间不含花括号。 */
const REF_RE = /\{\{([^{}]*)\}\}/g;

/**
 * `{{trigger.*}}` 的**名字空间**(点号前面那个词),与 `{{某步.某变量}}` 不同源。
 *
 * 抽成导出常量是因为它有**四个**消费方,而它们必须给出同一个答案:这里的解算器、
 * `main/orchestration/triggerVars.ts` 的展开器与词法、存盘校验
 * (`workflowValidation.ts` 要认出"这不是节点引用"),以及界面上「插入变量」那两句提示。
 * 各写一遍字符串,改名那天就会漏掉一处 —— 而漏掉的后果是"菜单插得出来、跑起来却解不了"。
 */
export const TRIGGER_REF_NAMESPACE = "trigger";

/** 转义后的 `{{` —— 解算时先把它换成这个占位符,最后再换回来。 */
const ESCAPED_OPEN = "\u0000mcode-lbrace\u0000";

/**
 * 把一处引用的值变成文本。
 *
 * 规则按"用户会怎么写"来定,不按类型系统:
 *  - 字符串原样(这是绝大多数情况:一段结果文本);
 *  - 数字 / 布尔 → `String`;
 *  - **字符串数组 → 用 `、` 连起来** —— `params.skills` 那种多选存的就是它,
 *    而 `["pdf","docx"]` 直接进提示词很难看;
 *  - 其余(对象、嵌套数组)→ JSON。它不是给人看的,但当用户真要引用一个结构化值时,
 *    有比没有强。
 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (value as string[]).join("、");
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** 变量名不能是这几个 —— 它们是内置字段,撞上了那个变量就**永远取不到**(内置的先生效)。
 *
 *  定在这里而不是 `@contracts/outputConstraint`,因为**名字空间是解算这一端定义的**:
 *  谁在 `resolveOne` 里先认了这几个词,谁就有资格说"这几个词不许当变量名"。那边填表时
 *  的拦截直接引这一份,免得两张表各自长歪。 */
export const RESERVED_VAR_NAMES = ["output", "status", "error", "title", "user"] as const;

/**
 * 清单里给"这一步的结果文本"用的那个键(`mcode.main` / `mcode.agent` /
 * `mcode.conversation` 的 `outputs` 都写着它)。
 *
 * 它**不在** {@link RESERVED_VAR_NAMES} 里,因为它不是"内置字段优先",而是
 * **回落到 `outcome.summary`** —— 用户自己声明了同名变量时听用户的。区别见
 * {@link readVar} 那一段。
 */
export const SUMMARY_OUTPUT_KEY = "summary";

/**
 * 按引用名找一个节点:id 优先,标题兜底。重名返回 `"ambiguous"`。
 *
 * ## ⚠️ 标题**两边都要 trim**(2026-09-19)
 *
 * 节点标题是**原样存**的(渲染端 `NodeInspector` → `updateNode`,不 trim),所以盘上
 * 会有 `"  检索  "` 这种值。而取引用名的那一层**已经 trim 了**:
 *
 *  - 解算这边 `resolveOne` 自己 `spec.slice(0, dot).trim()`;
 *  - 调度器拼上游名单时 `upstreamNames` 也 `titleOf(id).trim()`。
 *
 * 只有这里比的是**没 trim 过的原文** —— 于是三层里两层去空白、一层不去,一个标题带
 * 空白的节点就**永远引用不到**,而且报的是「图上没有这个节点」:用户盯着那个明明在
 * 图上的方块,名字一字不差(他看不见那几个空格)。实测三种写法全解不开,只有 id 行。
 *
 * 所以这里跟另外两层对齐:比的是 trim 过的标题。`name` 那一头也 trim 一次,是为了
 * 不依赖调用方已经去过空白(这个函数是导出的,谁都可以直接调)。
 */
function findNode(
  scope: NodeTemplateScope,
  name: string,
): NodeTemplateNode | "ambiguous" | undefined {
  const want = name.trim();
  const byId = scope.nodes.find((n) => n.id === want);
  if (byId) return byId;
  const byTitle = scope.nodes.filter((n) => n.title.trim() === want);
  if (byTitle.length > 1) return "ambiguous";
  return byTitle[0];
}

/**
 * 解算一处引用。`where` 用来把错报到具体是哪个参数。
 *
 * 三种引用的形状:整个 `{{user}}`、`{{节点.内置字段}}`、`{{节点.产出变量}}`。内置的那
 * 几个字段是**封闭的一小串**(见下面这些分支),而产出变量是**开放的** —— 名字由那一步
 * 的产出变量表决定(`@contracts/outputConstraint`),所以它没有名单可列,只能去那一步
 * 的产出里现查。
 */
function resolveOne(
  inner: string,
  scope: NodeTemplateScope,
  where: string,
): TemplateResult {
  const spec = inner.trim();
  if (spec.length === 0) {
    return { ok: false, error: `${where}:空引用 \`{{}}\`` };
  }

  if (spec === "user") return { ok: true, text: scope.user };

  const dot = spec.indexOf(".");
  const name = (dot < 0 ? spec : spec.slice(0, dot)).trim();
  const field = dot < 0 ? "output" : spec.slice(dot + 1).trim();

  // **`{{trigger.<键>}}` 是另一个名字空间**:它不指向图上任何节点,指向这次触发的载荷。
  // 所以它在查那两张节点表**之前**就被接走 —— 否则会报成"图上没有 trigger 这个节点",
  // 那句话会把用户支去改图,而图没问题,该改的是那个键(或者是他还没给这条图配触发器)。
  if (name === TRIGGER_REF_NAMESPACE) {
    if (scope.trigger === undefined) {
      return {
        ok: false,
        error: `${where}:引用不到 \`{{${spec}}}\` —— 这次运行不是触发器起的(手动发消息跑的工作流没有触发载荷),所以没有触发器变量可用`,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(scope.trigger, field)) {
      const have = Object.keys(scope.trigger);
      return {
        ok: false,
        error:
          `${where}:引用不到 \`{{${spec}}}\` —— 这次触发的载荷里没有这一项` +
          (have.length > 0
            ? `,可用的有:${have.map((k) => `{{${TRIGGER_REF_NAMESPACE}.${k}}}`).join("、")}`
            : "(载荷是空的)"),
      };
    }
    return { ok: true, text: stringify(scope.trigger[field]) };
  }

  if (!scope.upstream.has(name)) {
    // 报错要说清是哪一种:**图上有、但不是你的上游** 和 **图上根本没有**,用户要
    // 做的事完全不一样(改依赖 vs 改名字)。
    const exists = findNode(scope, name);
    const hint = exists === undefined ? "图上没有这个节点" : "它在图上,但不是这一步的上游";
    return {
      ok: false,
      error: `${where}:引用不到 \`{{${spec}}}\` —— ${hint}(只能引用这一步上游的节点)`,
    };
  }

  const node = findNode(scope, name);
  if (node === "ambiguous") {
    return { ok: false, error: `${where}:\`${name}\` 同时是多个节点的标题,改用它俩的 id` };
  }
  if (!node) {
    return { ok: false, error: `${where}:引用不到 \`{{${spec}}}\`` };
  }

  /**
   * **要的是"值",但那一步这次根本没走。**
   *
   * 用户在岔路口选了别的路,那一步被标成 `unselected` —— 它没有产出,而下游**照跑**
   * (没走的那条路当作不存在,见 `@contracts/workflow`)。所以这一步的指令里那句
   * `{{写作②.初稿}}` 是真的解不出来,失败是对的。
   *
   * **但话必须说对。** 不拦的话它会掉进 `readVar` 里那句"还没有产出变量 —— 去那一步的
   * 产出变量里把 X 填上",而那句建议在这里是**错的**:补什么都没用,那条路这次压根
   * 没走。用户会跑去改一个根本没跑的节点,然后发现改了还是报一样的错。
   *
   * `status` / `error` / `title` / `params.` **不拦** —— 那几样是**元信息**,
   * `{{A.status}}` 取到 `unselected` 恰恰是它该有的样子(有人就是要拿它判断)。
   */
  const wantsValue =
    field !== "status" &&
    field !== "error" &&
    field !== "title" &&
    !field.startsWith("params.");
  if (wantsValue && node.outcome?.status === "unselected") {
    return {
      ok: false,
      error: `${where}:\`{{${spec}}}\` 取不到 —— \`${name}\` 这次**没有走这条路**(用户在岔路口选了别的路),它没有产出`,
    };
  }

  if (field === "status") {
    return { ok: true, text: node.outcome?.status ?? "" };
  }
  if (field === "error") {
    return { ok: true, text: node.outcome?.error ?? "" };
  }
  if (field === "artifacts") {
    return { ok: true, text: stringify(node.artifacts ?? node.outcome?.artifacts ?? []) };
  }
  if (field.startsWith("artifacts.") || field.startsWith("artifacts[")) {
    const path = field.slice("artifacts".length).replace(/^\./, "");
    return readArtifactPath(node, path, where, name);
  }
  if (field === "output") {
    if (!node.outcome) {
      // 上游没定案 —— 走不到这里(上游成功才会派发这一步)。真走到了说明调度出了
      // 问题,说清楚比给一个空串强。
      return { ok: false, error: `${where}:\`${name}\` 还没有结果` };
    }
    return { ok: true, text: node.outcome.summary };
  }
  if (field === "title") return { ok: true, text: node.title };

  if (field.startsWith("params.")) {
    const key = field.slice("params.".length);
    if (key.length === 0) {
      return { ok: false, error: `${where}:\`params.\` 后面要写参数名` };
    }
    return { ok: true, text: stringify(node.params[key]) };
  }

  if (field.startsWith("outputs.")) {
    const key = field.slice("outputs.".length);
    if (key.length === 0) {
      return { ok: false, error: `${where}:\`outputs.\` 后面要写变量名` };
    }
    return readVar(node, key, where, name);
  }

  // **短写法**:`{{检索.年份}}`。变量定义在哪一步上,就直接拿那一步的名字去取它的
  // 变量 —— 界面上点选插进来的就是这个形状(见 `NodeInspector` 的「插入变量」)。
  // 长写法 `outputs.年份` 仍然认,但那是给"读提示词的人"看的。
  return readVar(node, field, where, name);
}

/** 取某一步的一个产出变量。取不到的话,把**它实际有的那些**列出来。 */
function pathParts(path: string): string[] {
  return path.match(/[^.\[\]]+|\[(\d+)\]/g)?.map((part) => part.startsWith("[") ? part.slice(1, -1) : part) ?? [];
}

function valueAt(root: unknown, path: string): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const part of pathParts(path)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, part)) return { found: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function readArtifactPath(node: NodeTemplateNode, path: string, where: string, name: string): TemplateResult {
  const artifacts = node.artifacts ?? node.outcome?.artifacts ?? [];
  const result = valueAt(artifacts, path);
  if (!result.found) return { ok: false, error: `${where}:\`${name}\` 没有可引用的产物路径 \`${path}\`` };
  return { ok: true, text: stringify(result.value) };
}

function readVar(
  node: NodeTemplateNode,
  key: string,
  where: string,
  name: string,
): TemplateResult {
  const outputs = node.outcome?.outputs;
  // **`summary` 是清单声明过的产出,而它住在 `outcome` 的外层**(2026-09-19)。
  //
  // 主代理 / 子 agent / 对话节点这三种在清单里都写着
  // `outputs: [{ key: "summary", label: "结果文本" }]` —— 存盘校验认清单声明的键
  // (`workflowValidation.declaredOutputsOf`),所以 `{{那步.summary}}` **存得下去**;
  // 可 `summary` 在运行时是 `outcome.summary`(那一轮的原文),不在 `outcome.outputs`
  // 里(那里只有按变量表解出来的东西)。于是同一个写法一边放行、一边报错。
  //
  // 判据**先看产出**:用户自己声明过一个叫 `summary` 的变量时以他的为准(那是今天就能
  // 用的写法),他没有才回落到原文 —— 而回落到的正好是"这一步给出了什么"。
  const declared = valueAt(outputs ?? {}, key);
  if (key === SUMMARY_OUTPUT_KEY && !declared.found) {
    if (node.outcome === undefined) {
      return { ok: false, error: `${where}:\`${name}\` 还没有结果` };
    }
    return { ok: true, text: node.outcome.summary };
  }
  if (outputs === undefined) {
    // **这是最容易撞上的一种错,所以话术要说清怎么修。** 结构化产出不是白来的:它是
    // 那一步填了产出变量表、跑完之后被解出来的结果(见 `@contracts/outputConstraint`)。
    return {
      ok: false,
      error: `${where}:\`${name}\` 还没有产出变量,所以取不到 \`${key}\` —— 去那一步的「产出变量」里把 \`${key}\` 填上(填了名字和示例,它的产出才有这个东西)`,
    };
  }
  const result = valueAt(outputs, key);
  if (!result.found) {
    const root = key.split(/[.\[]/, 1)[0] ?? key;
    const have = Object.keys(outputs);
    return {
      ok: false,
      error:
        have.length > 0
          ? `${where}:\`${name}\` 的产出里没有 \`${root}\` 这个变量,它有的是:${have.join("、")}`
          : `${where}:\`${name}\` 的产出里没有 \`${root}\` 这个变量`,
    };
  }
  return { ok: true, text: stringify(result.value) };
}

/**
 * 条件节点读的是**值**,而普通提示词读的是格式化后的文本。两者共享同一套
 * 上游/id/标题判定;只有确实存在的节点上的**缺失字段**可作为 exists=false,
 * 「节点不存在」「不是上游」「标题歧义」始终是错误,绝不吞成 false。
 */
export type ConditionRefRead =
  | { ok: true; found: true; value: unknown }
  | { ok: true; found: false }
  | { ok: false; error: string };

function conditionValue(value: unknown): ConditionRefRead {
  return value === undefined || value === null
    ? { ok: true, found: false }
    : { ok: true, found: true, value };
}

export function readConditionRef(ref: string, scope: NodeTemplateScope): ConditionRefRead {
  const match = /^\{\{([^{}]+)\}\}$/.exec(ref);
  if (!match) return { ok: false, error: `条件引用「${ref}」不是完整的 {{上游.字段}}` };
  const spec = (match[1] ?? "").trim();
  if (spec === "user") return conditionValue(scope.user);
  const dot = spec.indexOf(".");
  const name = (dot < 0 ? spec : spec.slice(0, dot)).trim();
  const field = dot < 0 ? "output" : spec.slice(dot + 1).trim();
  if (!name || !field || field === "params." || field === "outputs.") {
    return { ok: false, error: `条件引用「${ref}」缺少节点名或字段名` };
  }

  if (name === TRIGGER_REF_NAMESPACE) {
    if (scope.trigger === undefined) {
      return { ok: false, error: `条件引用「${ref}」取不到:这次运行没有触发器载荷` };
    }
    return conditionValue(Object.prototype.hasOwnProperty.call(scope.trigger, field) ? scope.trigger[field] : undefined);
  }

  if (!scope.upstream.has(name)) {
    const node = findNode(scope, name);
    return { ok: false, error: `条件引用「${ref}」取不到:${node === undefined ? "图上没有这个节点" : "它不是这一步的上游"}` };
  }
  const node = findNode(scope, name);
  if (node === "ambiguous") return { ok: false, error: `条件引用「${ref}」的标题重名,请使用节点 id` };
  if (node === undefined) return { ok: false, error: `条件引用「${ref}」的节点不存在` };

  if (field === "title") return conditionValue(node.title);
  if (field === "status") return conditionValue(node.outcome?.status);
  if (field === "error") return conditionValue(node.outcome?.error);
  if (field.startsWith("params.")) {
    const path = field.slice("params.".length);
    const found = valueAt(node.params, path);
    return conditionValue(found.found ? found.value : undefined);
  }
  if (field === "artifacts" || field.startsWith("artifacts.") || field.startsWith("artifacts[")) {
    const artifacts = node.artifacts ?? node.outcome?.artifacts ?? [];
    if (field === "artifacts") return conditionValue(artifacts);
    const found = valueAt(artifacts, field.slice("artifacts".length).replace(/^\./, ""));
    return conditionValue(found.found ? found.value : undefined);
  }
  if (node.outcome?.status === "unselected") return { ok: true, found: false };
  if (node.outcome === undefined) return { ok: false, error: `条件引用「${ref}」的上游还没有结果` };
  if (field === "output") return conditionValue(node.outcome.summary);
  const key = field.startsWith("outputs.") ? field.slice("outputs.".length) : field;
  if (!key) return { ok: false, error: `条件引用「${ref}」没有填写产出字段` };
  const found = valueAt(node.outcome.outputs ?? {}, key);
  if (found.found) return conditionValue(found.value);
  return key === SUMMARY_OUTPUT_KEY ? conditionValue(node.outcome.summary) : { ok: true, found: false };
}

/**
 * 解算一段文本里的全部引用。
 *
 * **纯函数**:不碰会话、不碰调度器状态 —— 所以它能被无头脚本喂各种畸形写法(见
 * `scripts/scheduler-smoke`)。那些畸形写法正是这块最容易写错的地方:漏一个花括号、
 * 引用了旁支、标题重名。
 */
export function renderTemplate(text: string, scope: NodeTemplateScope, where = "指令"): TemplateResult {
  // 先藏转义:**必须在扫引用之前**,否则 `\{{x}}` 会被当成一个引用。
  const guarded = text.split("\\{{").join(ESCAPED_OPEN);
  const parts: string[] = [];
  let cursor = 0;
  REF_RE.lastIndex = 0;
  for (const match of guarded.matchAll(REF_RE)) {
    const at = match.index ?? 0;
    const resolved = resolveOne(match[1] ?? "", scope, where);
    if (!resolved.ok) return resolved;
    parts.push(guarded.slice(cursor, at), resolved.text);
    cursor = at + match[0].length;
  }
  parts.push(guarded.slice(cursor));
  return { ok: true, text: parts.join("").split(ESCAPED_OPEN).join("{{") };
}

/**
 * 一段文本**点名引用**了哪些节点(标题或 id,**没去重、没校验存在**)。
 *
 * 和 {@link renderTemplate} 共用同一套词法(`REF_RE` + 同一套 `\{{` 转义),理由很直白:
 * 两处各扫一遍的话,"算不算一处引用"迟早有两个答案,而这两处的答案必须一致 —— 见下面
 * 说它是干什么用的。
 *
 * ## 它服务的那个判断
 *
 * 调度器默认会把**上游每一步的结果**整段拼在指令前面,而变量引用(`{{某步.某变量}}`)
 * 又能把上游的产出**定点**取进指令里。两条道都通,于是 `{{检索.年份}}` 加上自动拼接,
 * 同一个节点的东西会以**两种形状**在同一段提示词里出现两遍:一遍是干净的值,一遍是
 * 原始全文。实测一份 657 字的结果因此多花约 237 token,而更要紧的是模型得自己判断
 * "这两份是不是一回事"。
 *
 * 所以调度器拿这个函数的结果去**掐掉被点名那几步的自动拼接**:点名要了,就不再整段
 * 堆一遍。这是"变量是定点取、自动拼接是默认给"这两句话本该有的分工。
 *
 * ## 什么算"点名要产出"
 *
 * 只认**产出**(`{{A}}` / `{{A.output}}` / `{{A.outputs.某变量}}` / `{{A.某变量}}`)。
 * 三种**不算**:
 *  - `{{user}}` —— 它不是节点(内置字段,`findNode` 认不出它);
 *  - `{{A.params.某参数}}` —— 要的是那一步的**配置**,不是它做出来的东西;
 *  - `{{A.status}}` / `{{A.error}}` / `{{A.title}}` —— 那几步的**元信息**,同理。
 *
 * 这三种情况下上游的结果照给:写 `{{A.params.风格}}` 的人多半还是想看见 A 干了什么。
 */
export function referencedNodeNamesIn(text: string): string[] {
  const guarded = text.split("\\{{").join(ESCAPED_OPEN);
  const names: string[] = [];
  REF_RE.lastIndex = 0;
  for (const match of guarded.matchAll(REF_RE)) {
    const spec = (match[1] ?? "").trim();
    if (spec.length === 0 || spec === "user") continue;
    const dot = spec.indexOf(".");
    const name = (dot < 0 ? spec : spec.slice(0, dot)).trim();
    if (name.length === 0) continue;
    const field = dot < 0 ? "output" : spec.slice(dot + 1).trim();
    if (field === "status" || field === "error" || field === "title") continue;
    if (field.startsWith("params.")) continue;
    names.push(name);
  }
  return names;
}
