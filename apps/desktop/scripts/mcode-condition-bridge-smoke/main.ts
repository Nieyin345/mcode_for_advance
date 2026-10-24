/**
 * **W17｜条件迁到 Node-RED 之后，谁把真值写进 `msg.mcode.condition`。**
 *
 * ## 缺陷这道套件守的是什么
 *
 * 迁移器把旧 `condition` 落成上游原生 `switch`，规则读 `msg.mcode.condition` ——
 * 而**当时全仓没有生产者**，所以迁移后的条件图**永远走 else 口**，套件全绿也看不见。
 * 本套件测的是**补上的那一环**：
 *
 *   1. **迁移产物**：表达式能解析的条件节点前面有一个 `mcode-condition-eval` 适配
 *      节点，入边接它、它接 switch；switch 的规则/property/checkall 来自
 *      `conditionSwitchShape()`（唯一来源，不在套件里抄一份字面量）；
 *   2. **Host 求值**：`conditionHost.evaluateConditionForHost` —— 直接 import 生产
 *      实现，**并继续走 `@contracts/condition.evaluateConditionExpression`**；
 *      三种输入（exists 命中 / 不命中 / 引用不存在）、`and`/`or`、`equal`、
 *      `contains` 都按旧语义断言；「Host 拿不到」的三类（trigger / 产出变量 /
 *      原生节点结局）**显式失败**而不是落成 false；
 *   3. **适配节点本身**（`runConditionEvalNode`，import 生产实现）：把 Host 回的
 *      布尔写到 `msg.mcode.condition`，并把条件节点的 Mcode id（`bridgesNodeId`）
 *      而不是适配节点自己的 id 记进 `results`；
 *   4. **真上游 switch**（`node-red/packages/.../10-switch.js` 的原文 + 真
 *      `@node-red/util`）：适配节点写出的消息，经它**真的走到 true 口 / else 口**，
 *      且当 `rules` 里有两条会同时命中的规则时，`checkall:"false"` 只走一口、
 *      `"true"` 双发 —— 这是 `checkall` 那条断言**真的在验东西**的证据；
 *   5. **往返**：`migrateWorkflowDoc → flowToWorkflowDoc` 不因适配节点多出节点、
 *      边不减，条件节点的 params 原样回来（预检 `roundTripMismatchPaths` 依赖它）。
 *
 * ## 显式的边界（这套件**不**证明的）
 *
 *  - **不**执行真 Node-RED 引擎进程（不部署、不 spawn）。那是 `mcode-node-pack-smoke`
 *    与 `t8-node-red-u1` 的地盘；本套件的 switch 段在进程内加载上游原文。
 *  - **不**覆盖 `{{trigger.*}}` 与结构化产出变量在 native 侧的**成功**路径 —— 它们
 *    在 native 侧没有数据源，本套件只断言它们**显式失败**。
 *  - **不**覆盖 `registry.ts` 的装配（`withConditionEvaluation` 在 `NodePackHost`
 *    外的接线）之外的生产 wiring；那一段由 `withConditionEvaluation` 的纯函数断言
 *    覆盖（同一个文件）。
 *
 * Run: bash scripts/mcode-condition-bridge-smoke/run.sh
 *      或（run.sh 的 PATH 问题）node scripts/run-smokes.mjs mcode-condition-bridge-smoke
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONDITION_SWITCH_CHECKALL,
  CONDITION_SWITCH_PROPERTY,
  MCODE_CONDITION_EVAL_NODE_TYPE,
  conditionSwitchShape,
} from "@contracts/conditionBridge";
import { migrateWorkflowDoc, flowToWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { evaluateConditionForHost, sanitizeConditionResults } from "@main/workflowEngines/conditionHost.js";
import { withConditionEvaluation, evaluateConditionPayload } from "@main/workflowEngines/conditionHostPorts.js";
import { runConditionEvalNode } from "@main/workflowEngines/mcodeNodeTypes.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowNode, WorkflowEdge } from "@contracts/workflow";

let failures = 0;
let total = 0;
/** 每一项在 `check()` 时登记归属：正控（应为真）还是负控（应为假，判据退化成恒假时会被
 *  抓到）。最后按组打印 —— 混在一起时「少红一条」永远看起来像判据不够强。 */
const negative: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function neg(name: string, cond: boolean, detail?: unknown): void {
  negative.push(name);
  check(name, cond, detail);
}

/* ── 夹具 ── */

const NOW = 1_760_000_000_000;
/** 与生产同一份 runner.kind（`builtinManifestById`）。 */
function typesOf(ids: readonly string[]): Map<string, NodeTypeManifest> {
  const map = new Map<string, NodeTypeManifest>();
  for (const id of ids) {
    const manifest = builtinManifestById(id);
    if (manifest) map.set(id, manifest);
  }
  return map;
}
const TYPES = typesOf(["mcode.agent", "mcode.condition", "mcode.code", "mcode.command", "mcode.trigger"]);

function node(id: string, type: string, title: string, params: Record<string, unknown>, x = 100): WorkflowNode {
  return { id, type, title, params, position: { x, y: 100 } } as WorkflowNode;
}
function edge(id: string, from: string, to: string, label?: string): WorkflowEdge {
  return { id, from, to, ...(label === undefined ? {} : { label }) } as WorkflowEdge;
}
function rule(ref: string, op: "exists" | "equal" | "contains", value?: string): Record<string, unknown> {
  return { ref, op, ...(value === undefined ? {} : { value }) };
}
function expression(logic: "and" | "or", rules: unknown[]): Record<string, unknown> {
  return { logic, rules };
}

/** 一张最普通的条件图：触发 → 子 agent → 条件 → true/false 两个子 agent。 */
function conditionDoc(expr: unknown): WorkflowDoc {
  return {
    id: "wf_w17_bridge", name: "条件桥接", builtin: false, updatedAt: NOW,
    nodes: [
      node("t", "mcode.trigger", "入口", { triggerKind: "manual", task: "跑一下" }, 0),
      node("a", "mcode.agent", "检查", { instruction: "检查 README" }, 160),
      node("c", "mcode.condition", "判断", { expression: expr }, 320),
      node("yes", "mcode.agent", "真路", { instruction: "真路" }, 480),
      node("no", "mcode.agent", "假路", { instruction: "假路" }, 480),
    ],
    edges: [
      edge("e1", "t", "a"),
      edge("e2", "a", "c"),
      edge("e3", "c", "yes", "true"),
      edge("e4", "c", "no", "false"),
    ],
  } as WorkflowDoc;
}
const DOC = conditionDoc(expression("and", [rule("{{a.summary}}", "contains", "README")]));
const migrated = migrateWorkflowDoc(DOC, { types: TYPES });
const flow = migrated.flow;

function nativeOf(mcodeId: string): Record<string, unknown> | undefined {
  return flow.nodes.find((n) => n["x-mcode"]?.nodeId === mcodeId) as unknown as Record<string, unknown> | undefined;
}
function evalNodeOf(): Record<string, unknown> | undefined {
  return flow.nodes.find((n) => n.type === MCODE_CONDITION_EVAL_NODE_TYPE) as unknown as Record<string, unknown> | undefined;
}

/* ══════════════ 1. 迁移产物：求值节点 + switch 形状 ══════════════ */
console.log("\n1. 迁移产物：条件前面有求值节点，switch 只负责按布尔分流");

{
  const evalNode = evalNodeOf();
  check("★ 表达式能解析的条件节点有一个 mcode-condition-eval 适配节点", evalNode !== undefined);
  check("★ 适配节点指向条件节点（bridgesNodeId）",
    (evalNode?.["x-mcode"] as { bridgesNodeId?: string } | undefined)?.bridgesNodeId === "c", evalNode?.["x-mcode"]);

  // switch 的形状 = `conditionSwitchShape()` 的同一份（不在套件里抄字面量）。
  const switchNode = nativeOf("c");
  const shape = conditionSwitchShape();
  check("★ switch 的 property 是 mcode.condition（读 msg 上的那个字段）",
    switchNode?.["property"] === CONDITION_SWITCH_PROPERTY && switchNode?.["property"] === shape.property, switchNode?.["property"]);
  check("★ switch 的规则 = [true, else]（来自 conditionSwitchShape，不是套件里抄的）",
    JSON.stringify(switchNode?.["rules"]) === JSON.stringify(shape.rules), switchNode?.["rules"]);
  check("★ checkall 是 \"false\"（上游默认 \"true\" 会让一条消息走多个出口）",
    switchNode?.["checkall"] === CONDITION_SWITCH_CHECKALL && switchNode?.["checkall"] === "false", switchNode?.["checkall"]);
  check("★ propertyType 是 msg，repair 关（来自同一份形状）",
    switchNode?.["propertyType"] === shape.propertyType && switchNode?.["repair"] === shape.repair, switchNode);

  // 真正的入边：a → 适配节点（不是直接 a → switch）。
  const aNode = nativeOf("a");
  const evalId = evalNode?.["id"] as string | undefined;
  check("★ 上游的 wire 连到适配节点（不是直接连 switch）",
    Array.isArray((aNode as { wires?: string[][] })?.wires)
      && ((aNode as { wires: string[][] }).wires[0] ?? []).includes(evalId ?? "??"),
    (aNode as { wires?: unknown })?.wires);
  check("★ 适配节点连到 switch（它和 switch 之间是唯一的插入连接）",
    JSON.stringify(evalNode?.["wires"]) === JSON.stringify([[switchNode?.["id"]]]), evalNode?.["wires"]);

  // 表达式不能解析 → **不插**适配节点，报告点名「永远走 else」。
  const broken = migrateWorkflowDoc(conditionDoc({ logic: "xor", rules: [] }), { types: TYPES });
  check("★ 表达式非法时不插适配节点（不猜语义）",
    broken.flow.nodes.every((n) => n.type !== MCODE_CONDITION_EVAL_NODE_TYPE), broken.flow.nodes.map((n) => n.type));
  check("★ 表达式非法时报告点名「永远走 false 口」（不是安静地走错）",
    broken.report.lossy.some((i) => i.nodeId === "c" && i.message.includes("永远走 false")),
    broken.report.lossy.map((i) => i.message));

  // 表达式缺失（旧档案）同样不插 —— 与「空规则夹具」同一判据。
  const legacy = migrateWorkflowDoc(conditionDoc(undefined), { types: TYPES });
  check("★ 没有表达式参数（旧档案）时不插适配节点", legacy.flow.nodes.every((n) => n.type !== MCODE_CONDITION_EVAL_NODE_TYPE));
  // 旧的无表达式条件**仍然**只有 switch（最小形状）—— 现状没被这次改动破坏。
  check("★ 没有表达式时 switch 仍是 [true, else] 最小形状",
    JSON.stringify((legacy.flow.nodes.find((n) => n.type === "switch") as { rules?: unknown })?.rules) === JSON.stringify(shape.rules));
}

/* ══════════════ 2. Host 求值：三种输入 + and/or + 谓词 ══════════════ */
console.log("\n2. Host 求值（直接 import conditionHost，内部仍走 @contracts/condition）");

/** 一张图：agent a → condition c；a 这次交了什么由 `results` 决定。 */
function hostEval(expr: unknown, results: Array<{ nodeId: string; summary: string; status?: string }>): ReturnType<typeof evaluateConditionForHost> {
  return evaluateConditionForHost({ expression: expr, doc: DOC, nodeId: "c", results });
}

{
  // ① exists 命中 / 不命中
  const hit = hostEval(expression("and", [rule("{{a.summary}}", "exists")]), [{ nodeId: "a", summary: "ok: done" }]);
  check("★ exists 命中（上游这次交过结果）→ true", hit.ok && hit.matched === true, hit);
  const miss = hostEval(expression("and", [rule("{{a.summary}}", "exists")]), []);
  check("★ exists 不命中（上游这次没有结果）→ false", miss.ok && miss.matched === false, miss);
  // 引用不存在（图上没有这个节点）→ **失败**，不是 false。
  const ghost = hostEval(expression("and", [rule("{{ghost.summary}}", "exists")]), [{ nodeId: "a", summary: "x" }]);
  neg("★ 引用图上不存在的节点 → 失败（不是安静地 false）", !ghost.ok, ghost);

  // ② and / or 都要验（卡里点名的）。
  const andFalse = hostEval(expression("and", [
    rule("{{a.summary}}", "contains", "ok"),
    rule("{{a.summary}}", "contains", "no-such-text"),
  ]), [{ nodeId: "a", summary: "ok: done" }]);
  check("★ and：一条假则整体假", andFalse.ok && andFalse.matched === false, andFalse);
  const orTrue = hostEval(expression("or", [
    rule("{{a.summary}}", "contains", "no-such-text"),
    rule("{{a.summary}}", "contains", "ok"),
  ]), [{ nodeId: "a", summary: "ok: done" }]);
  check("★ or：一条真则整体真", orTrue.ok && orTrue.matched === true, orTrue);
  const orFalse = hostEval(expression("or", [
    rule("{{a.summary}}", "contains", "no-such-text"),
    rule("{{a.summary}}", "equal", "别的"),
  ]), [{ nodeId: "a", summary: "ok: done" }]);
  check("★ or：两条都假则整体假", orFalse.ok && orFalse.matched === false, orFalse);

  // ③ equal / contains 的精确语义（旧 textOf：数字用 String，数组按子串）。
  const eq = hostEval(expression("and", [rule("{{a.count}}", "equal", "0")]), [{ nodeId: "a", summary: "" }]);
  neg("★ equal 对不存在的产出变量 → **失败**（native 侧没有结构化产出变量，不落成 false）", !eq.ok, eq);
  const containsString = hostEval(expression("and", [rule("{{a.summary}}", "contains", "done")]), [{ nodeId: "a", summary: "ok: done" }]);
  check("★ contains 对字符串按子串", containsString.ok && containsString.matched === true, containsString);

  // ④ 非上游（在图上但不在 c 的上游）→ 失败。
  const sibling = hostEval(expression("and", [rule("{{yes.summary}}", "exists")]), [{ nodeId: "a", summary: "x" }]);
  neg("★ 引用图上**但不是上游**的节点 → 失败", !sibling.ok, sibling);

  // ⑤ Host 拿不到的三类必须显式失败（它们不是 found:false）。
  //
  // ⚠️ **两道防线**（实测踩过）：`readConditionRef` 自己也会拒 `{{trigger.*}}`
  // （scope.trigger 是 undefined → 「这次运行没有触发器载荷」）。所以只断言
  // 「失败了」的话，把本文件的分类那一道删掉这条照样绿 —— 被拒了不等于被**你的**
  // 防线拒了。断言必须点名分类那一道的**特有措辞**。
  const trigger = hostEval(expression("and", [rule("{{trigger.kind}}", "exists")]), []);
  neg("★ {{trigger.*}} 被**分类层**拒绝（不是被 readConditionRef 的第二道兜底）",
    !trigger.ok && trigger.error.includes("在 Node-RED 侧算不了")
      && trigger.error.includes("原生触发节点"),
    trigger);

  // 原生节点（不是 `mcode.*` 类型）的 status：文档里得真有一个原生节点，且它在
  // c 的上游。`function` 是 Node-RED 内置类型、不在 Mcode 清单里 —— 正是「引擎里
  // 跑、Host 看不见」的那一类。
  const nativeDoc = {
    ...DOC,
    nodes: [
      ...DOC.nodes,
      { id: "fn", type: "function", title: "原生函数", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      ...DOC.edges.filter((e) => e.id !== "e2"),
      { id: "e2a", from: "a", to: "fn" },
      { id: "e2b", from: "fn", to: "c" },
    ],
  } as unknown as WorkflowDoc;
  const nativeOutcome = evaluateConditionForHost({
    expression: expression("and", [rule("{{fn.status}}", "equal", "success")]),
    doc: nativeDoc, nodeId: "c", results: [],
  });
  neg("★ 原生节点的 status 被**分类层**拒绝（不是落到 readConditionRef 的 found:false）",
    !nativeOutcome.ok && nativeOutcome.error.includes("结局不离开引擎进程"), nativeOutcome);
  // 正控：**同一个原生节点**的 `title`（配置类字段，不依赖执行记录）算得了 ——
  // 证明上一条失败的是「原生节点的结局」，不是「原生节点一律算不了」。
  const nativeTitle = evaluateConditionForHost({
    expression: expression("and", [rule("{{fn.title}}", "equal", "原生函数")]),
    doc: nativeDoc, nodeId: "c", results: [],
  });
  check("★ 正控：原生节点的 title（配置，不是结局）仍能求值", nativeTitle.ok && nativeTitle.matched === true, nativeTitle);
}

{
  // sanitize：不可信 results —— 图外的 nodeId、坏结构、重复都按规则处理。
  const sanitized = sanitizeConditionResults([
    { nodeId: "a", summary: "first" },
    { nodeId: "not-in-doc", summary: "x" },
    { nodeId: "a", summary: "second" },
    { nodeId: "c", summary: 42 },
    "garbage",
  ], DOC);
  check("★ 图外的 nodeId 与坏结构被丢弃；重复 nodeId 取最后一条",
    JSON.stringify(sanitized) === JSON.stringify([{ nodeId: "a", summary: "second" }]), sanitized);
}

/* ══════════════ 3. 适配节点：把布尔写到 msg.mcode.condition ══════════════ */
console.log("\n3. 适配节点 runConditionEvalNode（import 生产实现）");

async function runEvalNode(
  matched: boolean | (() => never),
  inputMsg: Record<string, unknown>,
): Promise<{ msg: Record<string, unknown> } | { error: Error }> {
  const config = {
    id: "n_c_eval", z: "tab1", name: "判断 · 求值",
    "x-mcode": { nodeId: "c__condition_eval", bridgesNodeId: "c", params: { expression: DOC.nodes[2]?.params["expression"] } },
  } as unknown as Parameters<typeof runConditionEvalNode>[1];
  try {
    return await runConditionEvalNode(inputMsg, config, {
      evaluate: async () => {
        if (typeof matched === "function") matched();
        return { matched: matched as boolean };
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

{
  const upstream = { payload: "上游文本", mcode: { runId: "r1", results: [{ nodeId: "a", summary: "ok: done", status: "success" }] } };
  const hit = await runEvalNode(true, structuredClone(upstream));
  check("★ 适配节点把 true 写进 msg.mcode.condition", "msg" in hit
    && (hit.msg["mcode"] as Record<string, unknown>)[CONDITION_SWITCH_PROPERTY] === true, hit);
  check("★ 适配节点保留上游 payload（不改消息内容，只加字段）", "msg" in hit && hit.msg["payload"] === "上游文本");
  const miss = await runEvalNode(false, structuredClone(upstream));
  check("★ 适配节点把 false 写进 msg.mcode.condition", "msg" in miss
    && (miss.msg["mcode"] as Record<string, unknown>)[CONDITION_SWITCH_PROPERTY] === false, miss);

  // results 以**原条件节点的 Mcode id**（bridgesNodeId）记，不是适配节点自己的 id。
  if ("msg" in hit) {
    const results = (hit.msg["mcode"] as { results?: Array<{ nodeId: string }> }).results ?? [];
    check("★ results 里记的是原条件节点 id（c），不是适配节点 id",
      results.length === 2 && results[0]?.nodeId === "a" && results[1]?.nodeId === "c", results);
    check("★ 上游 results 原样保留（不是只留最后一条）", results[0]?.nodeId === "a", results);
  }

  // Host 拒绝 → 适配节点抛错（外壳 node.error，不发消息 —— 与旧调度器失败一致）。
  const refused = await runEvalNode(() => { throw new Error("宿主拒绝"); }, structuredClone(upstream));
  neg("★ Host 求值失败 → 适配节点抛错（不发送一条「安静地 false」的消息）",
    "error" in refused && refused.error.message.includes("宿主拒绝"), refused);
  // 缺 bridgesNodeId → 拒绝（被复制/手改的节点不许求值）。
  const noBridge = await runConditionEvalNode({}, {
    id: "x", "x-mcode": { nodeId: "x__condition_eval" },
  } as unknown as Parameters<typeof runConditionEvalNode>[1], { evaluate: async () => ({ matched: true }) })
    .then(() => null, (err: Error) => err);
  neg("★ 缺 bridgesNodeId 的适配节点拒绝执行", noBridge instanceof Error, String(noBridge));
}

/* ══════════════ 4. 真上游 switch：求值结果真的分流 ══════════════ */
console.log("\n4. 真 10-switch.js：适配节点写出的消息真的走 true / else 口");

/** 加载真的上游 `10-switch.js`（同步 require，测试进程内）。 */
async function loadRealSwitch(): Promise<{ make: (config: Record<string, unknown>) => { node: Record<string, unknown>; run: (msg: Record<string, unknown>) => Promise<string[][] | null> } }> {
  const src = readFileSync(join(process.cwd(), "..", "..", "node-red/packages/node_modules/@node-red/nodes/core/function/10-switch.js"), "utf8");
  // 上游源码是 CJS（`module.exports = function (RED) {...}`）。用 Function 把它包成
  // 模块执行 —— 不走文件系统 require（路径在不同 cwd 下不稳定），也不改上游源码。
  const moduleExports: { exports?: unknown } = {};
  new Function("module", "exports", "require", src)(moduleExports, moduleExports.exports, (id: string) => {
    // 上游 10-switch.js 不 require 任何东西（实测：只有 RED 注入）。给一个响的桩。
    throw new Error(`10-switch.js unexpectedly required ${id}`);
  });
  const register = moduleExports.exports as (RED: Record<string, unknown>) => void;
  const types: Record<string, new (config: Record<string, unknown>) => unknown> = {};
  const util = await import("node:util");
  void util;
  const RED = {
    settings: {},
    _: (key: string) => key,
    nodes: {
      registerType(type: string, ctor: new (config: Record<string, unknown>) => unknown) { types[type] = ctor; },
      createNode(node: Record<string, unknown>, config: Record<string, unknown>) {
        const emitter = new (require("node:events").EventEmitter)();
        node.id = config.id;
        node.z = config.z;
        node.wires = config.wires ?? [];
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.error = (err: unknown) => { (node["_errors"] as unknown[] | undefined ?? []).push?.(err); };
        node.warn = () => {};
        node.status = () => {};
        node.debug = () => {};
        node.log = () => {};
        node.send = (out: unknown) => { (node["_sent"] as unknown[] | undefined ?? []).push?.(out); };
      },
    },
    util: {
      // switch 只用 evaluateNodeProperty（propertyType=msg / 规则 vt=bool）。
      evaluateNodeProperty(value: string, type: string, _node: unknown, msg: Record<string, unknown>, cb: (err: unknown, out: unknown) => void) {
        if (type === "msg") {
          let current: unknown = msg;
          for (const part of value.split(".")) {
            if (current === null || current === undefined) return cb(null, undefined);
            current = (current as Record<string, unknown>)[part];
          }
          return cb(null, current);
        }
        // 上游 typedInput 的 bool 分支：/^true$/i.test(value)（10-switch 不走到这里，
        // 本套件只用 propertyType=msg；留着是为了形状完整）。
        if (type === "bool") return cb(null, String(value).toLowerCase() === "true");
        return cb(null, undefined);
      },
      prepareJSONataExpression: (e: string) => e,
      evaluateJSONataExpression: (_e: unknown, _msg: unknown, cb: (err: unknown, out: unknown) => void) => cb(null, undefined),
    },
  };
  register(RED as unknown as Parameters<typeof register>[0]);
  return {
    make(config) {
      const ctor = types["switch"];
      if (!ctor) throw new Error("real 10-switch.js did not register the switch type");
      const node: Record<string, unknown> = {};
      const sent: unknown[] = [];
      Object.defineProperty(node, "_sent", { value: sent, writable: false });
      const errors: unknown[] = [];
      Object.defineProperty(node, "_errors", { value: errors, writable: false });
      (ctor as unknown as (this: unknown, c: unknown) => void).call(node, config);
      return {
        node,
        async run(msg) {
          (node as { emit?: (event: string, m: unknown) => void }).emit?.("input", msg);
          await new Promise((resolve) => setTimeout(resolve, 60));
          const out: string[][] = [];
          for (const item of sent) {
            if (Array.isArray(item)) out.push(item.map((v) => (v === null ? "." : "MSG")) as string[]);
          }
          return out;
        },
      };
    },
  };
}

const realSwitch = await loadRealSwitch();
/** 上游 `node.send` 会**截掉尾部全 null 的口**（实测：命中时数组长度是 1，
 *  不命中时是 2）。所以断言「口多长」是把上游的数组裁剪当成判据 —— 归一化到两个口
 *  再比（缺的补 "."），这条才是「消息走到了哪几口」。 */
const portsOf = (out: string[][] | null, count = 2): string[] =>
  Array.from({ length: count }, (_, i) => out?.[0]?.[i] ?? ".");
const switchConfig = (rules: unknown[], checkall: string): Record<string, unknown> => ({
  id: "sw1", type: "switch", z: "tab1",
  property: CONDITION_SWITCH_PROPERTY, propertyType: "msg",
  rules, checkall, repair: false, wires: [[], []],
});

{
  const rules = conditionSwitchShape().rules;
  const hitRun = await realSwitch.make(switchConfig(rules, "false")).run({ payload: "x", mcode: { condition: true } });
  check("★ 真 switch + 求值结果 true → 只走 true 口（口 0）",
    JSON.stringify(portsOf(hitRun)) === JSON.stringify(["MSG", "."]), hitRun);
  const missRun = await realSwitch.make(switchConfig(rules, "false")).run({ payload: "x", mcode: { condition: false } });
  check("★ 真 switch + 求值结果 false → 只走 else 口（口 1）",
    JSON.stringify(portsOf(missRun)) === JSON.stringify([".", "MSG"]), missRun);
  const absent = await realSwitch.make(switchConfig(rules, "false")).run({ payload: "x" });
  check("★ 真 switch + 没有 msg.mcode.condition（生产者缺席）→ 走 else 口",
    JSON.stringify(portsOf(absent)) === JSON.stringify([".", "MSG"]), absent);
}

{
  // M3 行为对照：两条**都会命中**的规则。这不是迁移器会产出的形状 —— 它证明的是
  // `checkall` 那个值真的在管「一条消息走几个出口」，而不是一个没人验的字段。
  const coMatchRules = [{ t: "true", v: "", vt: "bool" }, { t: "true", v: "", vt: "bool" }];
  const both = await realSwitch.make(switchConfig(coMatchRules, "true")).run({ mcode: { condition: true } });
  check("★ checkall=\"true\"（上游默认）：一条消息同时走两口（正是 checkall 那条断言在挡的行为）",
    JSON.stringify(portsOf(both)) === JSON.stringify(["MSG", "MSG"]), both);
  // **用迁移器真正会写进 flow 的那个值**（常量），不在套件里抄字面量 —— 抄一份就是
  // 「验的是副本」：把常量改成 "true" 时这条会保持绿，而现实里 flow 已经变了。
  const firstOnly = await realSwitch.make(switchConfig(coMatchRules, CONDITION_SWITCH_CHECKALL)).run({ mcode: { condition: true } });
  check("★ checkall 取迁移器写的值：同一输入只走第一口",
    JSON.stringify(portsOf(firstOnly)) === JSON.stringify(["MSG", "."]), firstOnly);
}

/* ══════════════ 5. 往返：适配节点折回，不多节点、不少边 ══════════════ */
console.log("\n5. 往返：migrate → flowToWorkflowDoc 折回适配节点");
{
  const restored = flowToWorkflowDoc(flow);
  check("★ 往返后节点数不变（适配节点不进入 WorkflowDoc）",
    restored.nodes.length === DOC.nodes.length, { before: DOC.nodes.length, after: restored.nodes.length });
  check("★ 往返后边数不变（适配节点到 switch 的插入连接被丢弃）",
    restored.edges.length === DOC.edges.length, { before: DOC.edges.length, after: restored.edges.length });
  const restoredCond = restored.nodes.find((n) => n.id === "c");
  check("★ 往返后条件节点的 params.expression 原样回来",
    JSON.stringify(restoredCond?.params["expression"]) === JSON.stringify(DOC.nodes[2]?.params["expression"]),
    restoredCond?.params);
  check("★ 往返后没有残留的适配节点",
    !restored.nodes.some((n) => n.type === MCODE_CONDITION_EVAL_NODE_TYPE));
  // 从真实编辑器读回的形态（没有 links sidecar，只有 wires + edgeMeta）：也要折回。
  const fromEditor = structuredClone(flow);
  delete (fromEditor as { links?: unknown }).links;
  const editorRestored = flowToWorkflowDoc(fromEditor);
  check("★ 无 links sidecar（真编辑器读回）也能折回：节点数不变",
    editorRestored.nodes.length === DOC.nodes.length, { after: editorRestored.nodes.length });
  check("★ 无 links sidecar 时边仍由 wires 重建且指向正确的两端",
    editorRestored.edges.some((e) => e.from === "a" && e.to === "c"), editorRestored.edges);
}

/* ══════════════ 6. 生产装配：withConditionEvaluation 只接管 condition.evaluate ══════════════ */
console.log("\n6. 生产装配：withConditionEvaluation 包一层");
{
  const calls: string[] = [];
  const base = {
    execute: async (op: string) => { calls.push(op); return { ran: op }; },
    subscribe: () => () => {},
  };
  const wrapped = withConditionEvaluation(base as never, { getDoc: () => DOC, resolveWorkflow: () => "wf_w17_bridge" });
  const passthrough = await wrapped.execute("agent.run" as never, {});
  check("★ 其它动作原样交给原服务（不复制它的判据）",
    calls.length === 1 && calls[0] === "agent.run" && JSON.stringify(passthrough) === JSON.stringify({ ran: "agent.run" }));
  // 求值动作走本文件，且**要经归属核对 + 宿主库**。
  const payload = { tabId: "tab1", nodeId: "c", expression: DOC.nodes[2]?.params["expression"], results: [{ nodeId: "a", summary: "ok: README" }] };
  const result = await wrapped.execute("condition.evaluate" as never, payload) as { matched: boolean };
  check("★ condition.evaluate 走宿主求值（命中 → matched=true）", result.matched === true, result);
  let denied: unknown;
  try { evaluateConditionPayload(payload, { getDoc: () => DOC, resolveWorkflow: () => null }); }
  catch (err) { denied = err; }
  neg("★ tab 归属不是 Node-RED / 未登记 → 拒绝求值（引擎不能自报 docId）",
    denied instanceof Error && String(denied).includes("无法确认"), String(denied));
  let missingDoc: unknown;
  try { evaluateConditionPayload(payload, { getDoc: () => null, resolveWorkflow: () => "wf_x" }); }
  catch (err) { missingDoc = err; }
  neg("★ 宿主库里没有这张文档 → 拒绝求值", missingDoc instanceof Error, String(missingDoc));
}

console.log(`\nmcode-condition-bridge-smoke：${total - failures}/${total} 通过（其中负控 ${negative.length} 条）`);
if (failures > 0) process.exitCode = 1;
