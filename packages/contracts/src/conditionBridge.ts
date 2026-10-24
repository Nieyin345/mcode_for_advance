/**
 * **`condition` 节点迁到 Node-RED 之后，谁把真假算出来并写进 `msg.mcode.condition`。**
 *
 * ## 它解决的那个静默错
 *
 * 迁移器把旧 `condition` 节点落成**上游原生 `switch`**（`flowMigration.ts` 的
 * `NODE_RED_TYPE_OF_RUNNER.condition = "switch"`），规则是「`msg.mcode.condition`
 * 为 `true` → 口 0，否则 → 口 1」。而**全仓没有任何地方写这个字段** —— 迁移之后的
 * 每一张条件图**永远走 else 口**。`mcode-node-pack-smoke` 当时只验了规则形状
 * （`rules=[true,else]`、`checkall:"false"`），没验「真值从哪来」，所以全绿也看不见它。
 *
 * ## 桥接形状：`mcode-condition-eval` + 上游 `switch`
 *
 * 迁移器在**每个表达式能解析的条件 switch 之前**插一个求值适配节点
 * （{@link MCODE_CONDITION_EVAL_NODE_TYPE}），它只做三件事：
 *
 *   1. 把节点 `x-mcode.params` 里的 `expression` 连同 run 上下文交给 Host；
 *   2. Host 用**旧的那一份** `evaluateConditionExpression`（`@contracts/condition`）
 *      求值，scope 按旧调度器的方式拼（见 `nodePackProductionPorts.ts`）；
 *   3. 把布尔结果写成 `msg.mcode.condition`，原样放行 —— 分流仍由上游 `switch` 做。
 *
 * **求值不在引擎子进程里做**：子进程读不到 Host 的执行记录，也读不到任何原生节点的
 * 产出；在那里求值等于发明第二套语义。硬规矩 2（共享实现只有一份）决定了求值必须
 * 在 Host，且直接 `import` 旧函数。
 *
 * ## 为什么不是方案 C（把表达式翻译成 JSONata 塞进 switch 的规则）
 *
 * 三条实测（`.tmp/w17/probe-switch-jsonata.cjs`，真 `10-switch.js` + 真
 * `@node-red/util` 的 jsonata）：
 *
 *  - **比较语义会漂**：旧 `equal` 是 `textOf(value) === rule.value`，`textOf` 对数字
 *    用 JS `String()`；JSONata 的 `$string` 不是它 —— 实测
 *    `$string(1.2345678901234567e-8)` = `"1.23456789012346e-8"`，而 JS 给
 *    `"1.2345678901234567e-8"`（JSONata 截到 15 位有效数字）。`equal` 只要有一个
 *    输入对不上，就不是等价物。
 *  - **作用域拿不到**：switch 的 JSONata 只能看 `msg`。旧求值能读**任意上游**的
 *    `summary` / `outputs` / `status` / `params` / `title`；msg 上只有一个上游的
 *    payload。要给 JSONata 拼 scope，就得先有另一个生产者 —— 那已经是方案 B。
 *  - **「引用不存在 → 失败」JSONata 表达得了**（`$error(...)` 会让 switch 调
 *    `node.error` 且一个口都不发 —— 实测）。卡怀疑的这条不成立；真正让 C 出局的
 *    是上面两条。
 *
 * ## 为什么规则仍是 `{t:"true"}` 而不是 `jsonata_exp`
 *
 * 实测：`{t:"true", vt:"bool"}` 规则比较的是 `switch.property`（从 msg 取的
 * `mcode.condition`）与 `true` 全等 —— **它读消息，不是读规则自带的值**。
 * 所以求值放在适配节点、switch 只看布尔，是两种写法里更小的一种；换成
 * `jsonata_exp` 只会多一层 JSONata，语义不变。
 *
 * ## 等价边界（如实声明，别处不要粉饰）
 *
 * | 旧 `conditionOutcome`（`scheduler.ts`） | 本桥接 |
 * |---|---|
 * | `parseConditionExpression` 失败 → 节点失败 | 迁移时**不插求值节点**并报 `lossy`（该图此后仍永远走 else —— 明确写进报告） |
 * | 引用不在上游 / 图上没有 / 标题歧义 → 失败 | 同（Host 拼的 `upstream` 就是旧的那套 id+标题词表） |
 * | 值缺失 / `null` → `exists=false`，其余谓词 false | 同（`conditionValue` 原样） |
 * | 上游结局 `unselected` → 非 status 字段取不到 | 同（Host 用执行记录；**没有记录的上游按 `unselected`**，不猜） |
 * | `{{trigger.*}}` | **未接**：native 触发节点的载荷 Host 看不到；引用它 → 显式失败 |
 * | 产出变量（`{{A.某变量}}` / `outputs.*`） | **未接**：native 执行记录不保留结构化产出变量；引用它 → 显式失败 |
 * | 原生节点（`function` / `exec` / `inject` …）的产出 | **Host 看不见**（只有标识符离开子进程）；引用它 → 显式失败 |
 * | 「恰好 true/false 两条出边」 | 旧校验仍在保存/迁移预检；native 侧由 switch 的两个端口表达 |
 *
 * 三行「显式失败」是**有意的 fail-closed**：它们在旧图上能算出值，而 native 侧拿不到。
 * 让条件**安静地为假**比报错坏得多 —— 那正是本卡要修的那种错。
 */
import type { WorkflowDoc } from "./workflow.js";

/** 求值适配节点的 Node-RED 类型名（`mcodeNodeTypes.ts` 注册）。 */
export const MCODE_CONDITION_EVAL_NODE_TYPE = "mcode-condition-eval" as const;

/**
 * 适配节点在 `msg.mcode` 上交给 Host 的求值请求键。
 *
 * 只带**求值需要的那几样**（不是整个 msg）：Host 从 `x-mcode.params.expression`
 * 取表达式、从 `msg.mcode.results` 取上游执行事实 —— 这两个键由 Host 自己定义，
 * 引擎侧不参与解释。
 */
export const CONDITION_EVAL_OPERATION = "condition.evaluate" as const;

/**
 * `switch` 读取的属性名（`propertyType: "msg"`）。
 *
 * **只有这一处定义**：迁移器写规则、Host 求值、套件断言都引它。从前它只是迁移器
 * 里的一个字符串字面量，没人守。
 */
export const CONDITION_SWITCH_PROPERTY = "mcode.condition" as const;

/** `switch` 的规则：布尔 true → 口 0，`else` → 口 1。 */
export const CONDITION_SWITCH_RULES: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { t: "true", v: "", vt: "bool" },
  { t: "else" },
];

/**
 * **必须 `"false"`** —— 上游 Node-RED 的默认值是 `"true"`
 * （`10-switch.js` 的 `this.checkall = n.checkall || "true"`）。
 *
 * 今天这条 switch 只有「一条可比较规则 + else」，`else` 的 `elseflag` 语义让
 * `checkall` **看不出差别**（实测：两种取值的输出完全相同）。它守的是**将来**：
 * 任何人往这张 switch 上再加一条可比较规则时，`"true"` 会让一条消息同时走多个出口
 * （实测两条 `true` 规则：`[MSG, MSG]`）。
 *
 * 所以套件必须**同时**有形状断言（迁移产物里就是 `"false"`）**和**行为对照
 * （在同一个真 switch 上让两条规则都命中，证明 `"true"` 双发、`"false"` 只发一口）——
 * 只做前者时，`checkall` 这一项在验什么说不清。
 */
export const CONDITION_SWITCH_CHECKALL = "false" as const;

/**
 * 适配节点在 `x-mcode` 上记录「我替哪个 Mcode 条件节点求值」的键。
 *
 * 反向迁移（`flowToWorkflowDoc`）靠它把适配节点**折回**原条件节点：适配节点不进
 * `WorkflowDoc.nodes`，它的入边重定向到条件 switch、它到 switch 的那条边丢弃 ——
 * 否则一次往返就多出一个节点，`roundTripMismatchPaths` 会把每张含条件的图判成
 * 不可迁移（预检 REJECT）。
 */
export const CONDITION_EVAL_BRIDGE_KEY = "bridgesNodeId" as const;

/**
 * 这条 native 节点是不是「条件求值适配节点」，是的话它替哪个 Mcode 节点求值。
 *
 * 判据**只有**「类型对 + `bridgesNodeId` 是非空字符串」这一处 —— 正向写、
 * 反向折、预检白名单都引它。返回 `null` = 不是适配节点；类型对但 `bridgesNodeId`
 * 坏掉时抛错（fail-closed：被复制/损坏的适配节点不能悄悄变成一条普通未知节点，
 * 更不能折错目标）。
 */
export function conditionEvalTargetOf(node: { type?: unknown; "x-mcode"?: unknown }): string | null {
  if (node.type !== MCODE_CONDITION_EVAL_NODE_TYPE) return null;
  const meta = node["x-mcode"];
  const target = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)[CONDITION_EVAL_BRIDGE_KEY]
    : undefined;
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("condition 求值适配节点缺少 bridgesNodeId（被复制或损坏）—— 拒绝折叠，须在原生编辑器里重新迁移");
  }
  return target;
}

/** 一个 `switch` 的静态形状（迁移器与套件共用，**没有第二处写这些字面量**）。 */
export function conditionSwitchShape(): {
  property: string;
  propertyType: string;
  rules: Array<Record<string, unknown>>;
  checkall: string;
  repair: boolean;
} {
  return {
    property: CONDITION_SWITCH_PROPERTY,
    // typedInput 的取值域：msg = 从消息上按属性路径取。
    propertyType: "msg",
    rules: CONDITION_SWITCH_RULES.map((rule) => ({ ...rule })),
    checkall: CONDITION_SWITCH_CHECKALL,
    // 上游 switch 的「修复 msg.parts」开关。Mcode 的条件节点不产生分批消息
    // （`msg.parts`），开它只会让规则在带 parts 的消息上改走分组路径 —— 语义
    // 多一个分支而收益为零，所以显式关掉。
    repair: false,
  };
}

/**
 * 从一张 Mcode 文档算出「哪些条件节点应当有求值适配节点」。
 *
 * `isParsable` 由调用方注入（迁移器传真 `parseConditionExpression`），本模块因此
 * **不依赖 zod** —— `mcodeNodeTypes.ts` 要打进 Node-RED 子进程 bundle，往那里拖校验库
 * 是没必要的体积与攻击面（实测 bundle 里今天没有 zod）。
 */
export function bridgedConditionNodeIds(
  doc: WorkflowDoc,
  kindOf: (type: string) => string | undefined,
  isParsable: (expression: unknown) => boolean,
): string[] {
  return doc.nodes
    .filter((node) => kindOf(node.type) === "condition")
    .filter((node) => isParsable(node.params["expression"]))
    .map((node) => node.id);
}

/**
 * Host 能替旧 `evaluateConditionExpression` 拼出来的引用字段集。
 *
 * 不在这个集合里的字段（产出变量、`outputs.*`、原生节点产物）在 native 侧**没有
 * 数据源**。Host 必须对它**显式报错**，不许落成 `found:false` —— 后者会把「拿不到」
 * 说成「值是假的」，正是本卡要修的那类静默错。
 *
 * `readConditionRef` 支持的字段全集在 `@contracts/nodeTemplate`；这里是它的子集，
 * 且**只有这一处**定义「哪一半在 native 侧可满足」。
 */
export const CONDITION_HOST_REF_FIELDS = {
  /** `{{A}}` 与 `{{A.output}}` —— 执行记录里的结果文本。 */
  output: true,
  status: true,
  error: true,
  title: true,
  /** `{{A.params.路线}}` —— 配置，不依赖执行记录。 */
  paramsPrefix: "params.",
  /** `{{A.artifacts[.n]}}` —— Host 执行记录里有 artifacts。 */
  artifactsPrefix: "artifacts",
} as const;

/**
 * 把一个条件引用拆成「节点名 + 字段」，并按上表判断 Host 是否拿得到。
 *
 * 与 `@contracts/nodeTemplate` 的 `readConditionRef` 同一套词法（`{{name.field}}`，
 * 没有点就是 `.output`）。**本函数只做分类，不求值** —— 它唯一要说的是「这个字段
 * 在 native 侧有没有数据源」。
 *
 * ⚠️ **裸字段要分两半**（2026-10-24 实测踩过）：
 *
 *  - `summary` 是清单声明的产出键，但它在运行时住在 `outcome.summary`（执行记录
 *    的**外层**，见 `readVar` 那段长注释）—— **Host 拿得到**；
 *  - 其它裸字段（`{{A.年份}}`）是上游**自己声明的产出变量**，
 *    `readConditionRef` 从 `outcome.outputs` 取 —— native 执行记录不保留它。
 *
 * 两者的**词法完全一样**（都是 `{{节点.某词}}`），所以不能只看有没有 `outputs.`
 * 前缀：不看这一条，出厂预设 `wf_auto_download` 的 `{{trigger.input.doi}}` 之外，
 * 最常见的 `{{上游.summary}}` 会被误判成「算不了」——条件图整片失败，比原本的
 * 「永远走 else」还坏。
 *
 * 返回 `"unsupported"` 时调用方必须**失败**（带 ref 原文），不是返回 false。
 */
export function classifyConditionRef(
  ref: string,
): { name: string; field: string; supported: true } | { name: string; field: string; supported: false; reason: string } {
  const match = /^\{\{([^{}]+)\}\}$/.exec(ref);
  if (!match) return { name: "", field: "", supported: false, reason: "不是完整的 {{上游.字段}}" };
  const spec = (match[1] ?? "").trim();
  if (spec === "user") return { name: "user", field: "user", supported: false, reason: "用户请求不在 native 执行记录里" };
  const dot = spec.indexOf(".");
  const name = (dot < 0 ? spec : spec.slice(0, dot)).trim();
  const field = dot < 0 ? "output" : spec.slice(dot + 1).trim();
  if (name === "trigger") {
    return { name, field, supported: false, reason: "原生触发节点的载荷不离开引擎进程，Host 取不到 {{trigger.*}}" };
  }
  if (field === "output" || field === "status" || field === "error" || field === "title") {
    return { name, field, supported: true };
  }
  if (field.startsWith("params.")) return { name, field, supported: true };
  if (field === "artifacts" || field.startsWith("artifacts.") || field.startsWith("artifacts[")) {
    return { name, field, supported: true };
  }
  // 产出变量。`summary` 是唯一一个住在执行记录外层、Host 拿得到的裸字段。
  if (field === "summary") return { name, field, supported: true };
  if (field.startsWith("outputs.")) {
    return {
      name, field, supported: false,
      reason: "结构化产出变量（outputs.*）不在 native 执行记录里；迁到 Node-RED 后 Host 取不到它",
    };
  }
  return {
    name, field, supported: false,
    reason: "上游声明的产出变量不在 native 执行记录里；迁到 Node-RED 后 Host 取不到它（要取结果文本请用 .summary）",
  };
}
