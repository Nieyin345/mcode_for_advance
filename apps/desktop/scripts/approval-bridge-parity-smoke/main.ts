/**
 * ARC-003 三引擎统一审批语义。读取当前源码，以 TypeScript AST 提取真实 Claude
 * canUseTool ArrowFunction 和 Codex invokeDynamicTool FunctionDeclaration，执行原函数，
 * 只注入内存 ctx、虚构引擎工具与事件。无外部 IPC、无账号、无实际文件写入。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";
const require = createRequire(join(process.cwd(), "package.json"));
const ts = require("typescript") as typeof TypeScript;
let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log("  ok   " + label); }
  else { failed++; console.error("  FAIL " + label + " " + JSON.stringify(detail ?? null)); }
}
function source(rel: string): TypeScript.SourceFile {
  const full = join(process.cwd(), "src/main/providers", rel);
  return ts.createSourceFile(rel, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
}
function findNestedArrow(sf: TypeScript.SourceFile, name: string): string {
  let text: string | null = null;
  const visit = (node: TypeScript.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === name && node.initializer
        && ts.isArrowFunction(node.initializer)) {
      text = node.initializer.getText(sf);
      return;
    }
    if (!text) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!text) throw new Error("当前源码缺少生产回调：" + name);
  return text;
}
function findTopFunction(sf: TypeScript.SourceFile, name: string): string {
  const fn = sf.statements.find((n): n is TypeScript.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!fn) throw new Error("当前源码缺少生产函数：" + name);
  return fn.getText(sf);
}
function construct(src: string, exported: string, mocks: Record<string, unknown>): any {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const keys = Object.keys(mocks);
  return new Function(...keys, js + "\nreturn " + exported + ";")(...keys.map(k => mocks[k]));
}

/**
 * 【T51 复现的同一类缺陷】`construct()` 用 `new Function` 重装**生产函数源码**，
 * 函数体里每一个自由标识符都必须由 `mocks` 显式提供。T86 给 `invokeDynamicTool`
 * 加了 `dispatchCodexExternalToolCall(...)` 调用，而 mocks 没跟着加 —— 于是运行期
 * `ReferenceError`，**套件红在「桩过期」，不是产品坏了**。
 *
 * 靠人记得同步是错的（这个仓库已经栽过多次）。所以这里**从源码本身**算出该函数
 * 引用了哪些自由标识符，缺桩时**在构造前就显式失败并列出缺哪些**，而不是让
 * `new Function` 跑到一半才炸。新导出被引用时，报错会直接点名它。
 */
function freeIdentifiers(fnText: string, fnName: string, sf: TypeScript.SourceFile): string[] {
  // 被构造的可能是**顶层函数声明**（`invokeDynamicTool`），也可能是**嵌套箭头**
  // （`canUseTool`，本套件用 `findNestedArrow` 提取）。所以这里不按 statements 找，
  // 而是从传入的源码文本重新解析出一个函数/箭头节点 —— 与 `construct` 装进
  // `new Function` 的**是同一段文本**，判据因此不会和实际执行的东西脱节。
  const wrapper = ts.createSourceFile(
    "fragment.ts", `const __target = ${fnText.replace(/^function\s+\w+/, "function")};`,
    ts.ScriptTarget.Latest, true,
  );
  let fn: TypeScript.Node | null = null;
  const findFn = (node: TypeScript.Node) => {
    if (fn) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      // 只取**最外层**那个：`const __target = <fn>` 的初始化器。
      if (ts.isVariableDeclaration(node.parent ?? node) === false || node.parent?.parent === wrapper) {
        fn = node;
        return;
      }
    }
    ts.forEachChild(node, findFn);
  };
  ts.forEachChild(wrapper, (n) => {
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "__target") fn = d.initializer ?? null;
      }
    }
  });
  if (!fn) throw new Error("无法从源码文本解析出函数：" + fnName);

  // 该函数内**声明过**的名字（参数、局部变量、函数不算自由）。
  const declared = new Set<string>();
  const declare = (name: string | undefined) => { if (name) declared.add(name); };

  /**
   * 模块级 import / 顶层声明的处理 —— 这里是个**刻意的取舍**，写清楚免得后人改错：
   *
   * `construct()` 只把**单个函数**的源码塞进 `new Function`，所以严格说模块级名字
   * （import 进来的、同文件顶层 const/function）在那段文本里也是自由的，全都该由
   * mocks 提供。但实测把这条严格执行会要求补 30 个桩（`browserClick` / `toContent` /
   * `normalizeCodexMode` …），其中大多数只在**本套件不进入的分支**里被引用 ——
   * 逼人补齐等于把套件改成"为了过桩检查而写的桩清单"，反而更难维护。
   *
   * 所以保留「模块级名字算已知」这一条，守卫的职责收窄为：**抓「既不是模块级、
   * 也不是函数内局部」的名字** —— 那才是真正的拼写错误或新引入的未定义标识符。
   *
   * ⚠️ 代价（如实记录）：**新 import 的符号缺失不会在这里报出来**，仍然会在
   * `new Function` 运行到那一行时抛 `ReferenceError`。本卡修 T86 缺桩靠的是
   * 手动补桩 + `constructChecked` 兜住其余形态；不是靠这条守卫自动发现。
   */
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) declare(st.name?.text);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) declare(d.name.text);
    } else if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (clause?.name) declare(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) declare(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) declare(el.name.text);
    }
  }

  const used = new Set<string>();
  const visit = (node: TypeScript.Node) => {
    // 任何声明点都登记（参数、局部 const/let/function、解构名、catch、for-of）。
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) declare(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declare(node.name.text);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) declare(node.name?.text);
    if (ts.isBindingElement(node) || ts.isCatchClause(node)) {
      const nm = (node as { name?: TypeScript.Node }).name;
      if (nm && ts.isIdentifier(nm)) declare(nm.text);
      const vd = (node as { variableDeclaration?: TypeScript.VariableDeclaration }).variableDeclaration;
      if (vd && ts.isIdentifier(vd.name)) declare(vd.name.text);
    }
    // 引用点：标识符，且不是属性访问的右半边、对象字面量的键、类型位置。
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isProp = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isKey = parent && ts.isPropertyAssignment(parent) && parent.name === node;
      const isTypePosition = parent && (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent));
      const inTypeContext = parent && (
        (ts.isTypeNode?.(parent) === true) || ts.isHeritageClause(parent) ||
        ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
      );
      if (!isProp && !isKey && !isTypePosition && !inTypeContext) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);

  /**
   * 最后一道过滤：**只保留在转译产物里真的以变量形式出现的名字**。
   *
   * 上面那些 AST 规则（属性键、类型位置、类型上下文）是「按语法排除」，容易被
   * 新的写法绕过（本卡就先后漏了 `Record`、`RequestDeps`、`contentItems` 三种）。
   * 而 `construct()` 执行的是 `ts.transpileModule` 的**产物** —— 那么判据就该问产物：
   * 名字以独立标识符出现在编译后代码里的，才是真的运行期自由变量。
   *
   * 用 `\b名字\b` 且排除「前面是 `.`」（属性）与「后面是 `:`」（对象键/类型标注）。
   * 这比维护一张语法白名单稳，且与真正执行的东西同源。
   */
  const js = ts.transpileModule(fnText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const appearsAsVariable = (name: string): boolean => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 不在 `.` 之后（属性访问），不在字符串/引号里，不是对象键（`name:` 前面不是值位置）。
    const re = new RegExp(`(^|[^.\\w$'"\\\`])${esc}(?![\\w$])(?!\\s*:)`, "m");
    return re.test(js);
  };

  // 语言内建与运行时全局不算桩。
  const BUILTINS = new Set([
    "undefined", "null", "true", "false", "this", "Math", "JSON", "Object", "Array", "String",
    "Number", "Boolean", "Promise", "Set", "Map", "Date", "Error", "RegExp", "Symbol", "BigInt",
    "console", "require", "module", "exports", "process", "globalThis", "Buffer", "URL",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "structuredClone", "fetch",
  ]);
  return [...used]
    .filter((n) => n.length > 0 && !declared.has(n) && !BUILTINS.has(n) && appearsAsVariable(n))
    .sort();
}

/**
 * 包装 `construct`：先算自由标识符，缺桩就**显式失败并点名**。
 * 这是「判据跟着真相源走」的落点 —— 生产函数新增依赖时，这里会立刻说清楚少了谁，
 * 而不是抛一个只有栈的 `ReferenceError`。
 */
function constructChecked(
  sf: TypeScript.SourceFile, fnText: string, exported: string, mocks: Record<string, unknown>,
): any {
  const free = freeIdentifiers(fnText, exported, sf);
  const missing = free.filter((n) => !(n in mocks));
  if (missing.length > 0) {
    throw new Error(
      `审批桥桩过期：生产函数 ${exported} 引用了未注入的自由标识符 ${JSON.stringify(missing)}。\n` +
      `这些是 T86/T24 之后再接入的依赖；请在调用处补桩（保持真实语义，不要写空实现蒙混）。`,
    );
  }
  return construct(fnText, exported, mocks);
}

const claudeSf = source("claude-sdk/ClaudeAgentSdkProvider.ts");
const canUseTool = findNestedArrow(claudeSf, "canUseTool");
let id = 0;
const claudeCtx = { getPermissionMode: () => "default", isToolAlwaysAllowed: (_name: string) => false, log: { info: (_: string) => {} } };
function makeClaude(requestApproval?: (request: unknown) => Promise<{ allow: boolean; reason?: string }>, always = false) {
  return constructChecked(claudeSf, "const canUseTool = " + canUseTool + ";", "canUseTool", {
    ctx: { ...claudeCtx, isToolAlwaysAllowed: () => always },
    req: { cwd: "virtual-project" },
    requestApproval, requestUserInput: undefined, requestPlanApproval: undefined,
    MEMORY_MCP_SERVER: "memory", APP_MCP_SERVER: "app",
    FILE_MUTATING_TOOLS: new Set(["Write","Edit","NotebookEdit"]),
    getToolFilePath: () => null,
    normalizeToolFilePath: () => null,
    writeLandsInLibrary: () => false,
    normalizeBashCommand: (s: string) => s,
    shouldAutoApprove: () => false,
    randomUUID: () => "approval-" + (++id),
    parseQuestions: () => [],
  }) as (tool: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<any>;
}
const args = { toolUseID: "fake-tool-use-id" };
const blocked = await makeClaude()("Bash", { command: "echo harmless-stub" }, args);
check("Claude 无审批桥时 Bash 必须 deny", blocked?.behavior === "deny" && /审批|用户|批准/.test(blocked.message ?? ""), blocked);
const approved = await makeClaude(async () => ({ allow: true }))("Bash", {}, args);
check("Claude 有真人批准后才允许执行", approved?.behavior === "allow", approved);
const denied = await makeClaude(async () => ({ allow: false, reason: "explicit no" }))("Bash", {}, args);
check("Claude 真人拒绝必须保留拒绝原因", denied?.behavior === "deny" && denied?.message === "explicit no", denied);
const preAllowed = await makeClaude(undefined, true)("Bash", {}, args);
check("Claude 已由宿主明确预批准的工具允许", preAllowed?.behavior === "allow", preAllowed);

const codexSf = source("codex-sdk/CodexAgentSdkProvider.ts");
const codexBody = findTopFunction(codexSf, "invokeDynamicTool");
const invokeDynamicTool = constructChecked(codexSf, codexBody, "invokeDynamicTool", {
  isAppToolName: () => false, isLibraryToolName: () => false, isAgentToolName: () => false,
  workflowEngineBridge: { has: () => false },
  randomUUID: () => "codex-approval-" + (++id),
  // 【T86 之后新增的依赖】Codex 原生动态工具桥的第一跳：只有在**本次请求的
  // allowlist** 里出现过的外部工具才被接管。本套的夹具全是引擎内建工具
  // （exit_plan_mode 等），所以真实的 `matched:false` 分支就是正确语义 ——
  // 返回 `matched:false` 让生产代码继续走它原来的路径，测的仍是审批语义本身。
  // ⚠️ 不要把它写成 `{matched:true, …}`：那会短路掉本套件要验的全部逻辑。
  dispatchCodexExternalToolCall: async () => ({ matched: false as const }),
}) as (p: Record<string, unknown>, deps: any) => Promise<any>;

function makeCodex(bridge?: () => Promise<any>) {
  const events: Array<{ type: string; mode?: string; phase?: string }> = [];
  const active = { active: true };
  return {
    events, active,
    deps: {
      ctx: { emit: (e: any) => events.push(e), requestPlanApproval: bridge },
      req: { cwd: "virtual-project", sessionId: "fake-session", permissionMode: "default" },
      planMode: active, browserToolsEnabled: false,
    },
  };
}
const noCodex = makeCodex();
const codexOut = await invokeDynamicTool({ name: "exit_plan_mode", args: { plan: "# plan" } }, noCodex.deps);
check("Codex 无审批桥时不能离开 plan mode", noCodex.active.active === true, {codexOut, events:noCodex.events});
check("Codex 无审批桥时不得告知模型批准/自动退出", codexOut?.success === false &&
  /审批|拒绝|不可用|批准/.test(codexOut?.contentItems?.[0]?.text ?? "") &&
  !/自动退出|已批准/.test(codexOut?.contentItems?.[0]?.text ?? ""), codexOut);
check("Codex 无审批桥时不得发 default 模式事件", !noCodex.events.some(e=>e.type==="mode.change"&&e.mode==="default"), noCodex.events);

const interrupted = makeCodex(async()=>{ throw new Error("fake disconnect"); });
const interruptedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# cut"}},interrupted.deps);
check("Codex 宿主审批通信异常必须是失败响应，而不是成功",
  interruptedOut?.success === false && /disconnect/.test(interruptedOut?.contentItems?.[0]?.text ?? ""), interruptedOut);
check("Codex 审批通信断开仍在计划模式", interrupted.active.active === true);
check("Codex 审批中断不切默认模式", !interrupted.events.some(e=>e.type==="mode.change"&&e.mode==="default"));

const rejectedPlan = makeCodex(async () => ({ approved: false, reason: "human said no" }));
const rejectedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# revised"}}, rejectedPlan.deps);
check("Codex 真人拒绝保留计划模式", rejectedPlan.active.active === true &&
 /拒绝/.test(rejectedOut?.contentItems?.[0]?.text ?? ""), rejectedOut);
const acceptedPlan = makeCodex(async () => ({ approved: true, editedPlan: "# human edits" }));
const acceptedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# proposed"}}, acceptedPlan.deps);
check("Codex 真人批准才退出计划模式", acceptedPlan.active.active === false &&
 /human edits/.test(acceptedOut?.contentItems?.[0]?.text ?? "") &&
 acceptedPlan.events.some(e=>e.type==="mode.change"&&e.mode==="default"), acceptedOut);

console.log("approval-bridge-parity-smoke: "+passed+"/"+(passed+failed)+" assertions pass");
if(failed)process.exitCode=1;
