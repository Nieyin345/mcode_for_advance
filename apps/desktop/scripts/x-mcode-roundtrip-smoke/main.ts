/**
 * T28 —— **`x-mcode` 经原生编辑器导出/导入往返不丢**（真上游 `nodes.js` 在 vm 里跑）。
 *
 * ## 缺陷（T8 真 Electron 实测，原话）
 *
 * > **P0**：经编辑器 Import 进入画布的图**丢失全部 `x-mcode` 身份**（上游只导出
 * > `_def.defaults`，Mcode 节点包未声明）——「用户在原生编辑器手工导入 Mcode 图」
 * > 这条路径结构性不可用。
 *
 * ## 本套件判什么
 *
 * **A. 声明契约（源码级）**：六个 Mcode 类型生成的编辑器 HTML 里，`defaults` 都声明了
 * `x-mcode`；每份 HTML 都带 tab 定义补丁脚本；补丁脚本在缺 tab 定义时显式抛错
 * （fail-closed，不静默丢身份）。
 *
 * **A2. 补丁脚本的行为（桩 RED，运行时执行）**：补丁生效时 `defaults` 里**确实**有
 * `x-mcode`；tab 定义缺失/形状不对/补丁不生效时**抛错**而不是静默放过；比补丁脚本
 * 晚注册的内置类型（`registry:node-type-added` 路径）也会被补上。
 *
 * **B. 真上游往返（本套件的核心）**：把仓库里真实的
 * `node-red/packages/node_modules/@node-red/editor-client/src/js/nodes.js` 装进
 * `vm`，用与编辑器相同的 `appendConfig` 语义执行我们生成的节点 HTML，然后走**上游自己**
 * 的 `createCompleteNodeSet`（导出）→ **新建一个同样的编辑器**（等价于"清空画布"）
 * → `import` 同一份 JSON → 再 `createCompleteNodeSet`：
 *
 *   - 补丁在真上游的 tab 定义上生效（`getType("tab").defaults` 真的多出 `x-mcode`）；
 *   - 导出 JSON 里 `x-mcode` 在（tab、Mcode 节点、以及迁移落到的**内置类型**节点）；
 *   - 导入后 `x-mcode` 仍在，且 `docId` / `nodeId` 逐字段一致；
 *   - 再导出的 JSON 与第一份在 `x-mcode` 上**深相等**（往返稳定，不是一次性保留）；
 *   - 导入后 `flowToWorkflowDoc`（Mcode 的真实反向适配器）能把它关联回原库文档。
 *
 * **C. 反向对照（同一 vm，去掉声明）**：把生成的 HTML 里 `x-mcode` 声明与 tab 补丁
 * 剥掉后再跑一遍同一路径 —— 必须复现 T8 的丢身份现象。这是 B 的**内建负控**：如果某天
 * B 绿而 C 也绿，说明断言根本没在判。
 *
 * **D. 托管清单**：安装器写进 `<userDir>/nodes` 的那几份 HTML 字节就是带声明的那一份。
 *
 * 真引擎（`GET /flows` 读回）+ 真 Electron 手势级往返分别由
 * `node-red-e2e-smoke`（已有）与 T8 的 U1 旅程（本卡新增一步）覆盖。
 *
 * Run: bash scripts/x-mcode-roundtrip-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCODE_AGENT_NODE_TYPE,
  MCODE_X_MCODE_DEFAULT_ENTRY,
  agentNodeHtml,
  tabMetaDefaultsScript,
} from "@main/workflowEngines/mcodeNodePack.js";
import {
  MCODE_NODE_PACK_TYPES,
  MCODE_REGISTERED_NODE_TYPES,
  allNodeHtml,
  branchNodeHtml,
  conversationNodeHtml,
  moduleCapabilityNodeHtml,
  nodeRedCallNodeHtml,
  triggerNodeHtml,
} from "@main/workflowEngines/mcodeNodeTypes.js";
import { migrateWorkflowDoc, flowToWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { expectedNodePackFiles, MCODE_NODE_PACK_INSTALL_VERSION } from "@main/workflowEngines/nodePackManifest.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import {
  UPSTREAM_CORE_HTML,
  addNodeSet,
  createUpstreamEditor,
  loadUpstreamCoreNodes,
  requireUpstreamAvailable,
  upstreamVersion,
  type UpstreamEditor,
} from "./upstreamEditor.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const REPO_ROOT = process.env.MCODE_T28_REPO ?? join(process.cwd(), "..", "..");
const htmlByType: Record<string, () => string> = {
  "mcode-agent": agentNodeHtml,
  "mcode-conversation": conversationNodeHtml,
  "mcode-branch": branchNodeHtml,
  "mcode-trigger": triggerNodeHtml,
  "mcode-module-capability": moduleCapabilityNodeHtml,
  "mcode-node-red-call": nodeRedCallNodeHtml,
};

/* ══════════════ A. 声明契约（源码级） ══════════════ */
console.log("\nA. 声明契约：六类型 defaults 都声明 x-mcode + tab 补丁脚本");

for (const type of MCODE_NODE_PACK_TYPES) {
  const html = htmlByType[type]!();
  check(`${type} defaults 声明了 x-mcode`, html.includes(MCODE_X_MCODE_DEFAULT_ENTRY), { marker: MCODE_X_MCODE_DEFAULT_ENTRY });
  check(`${type} HTML 带 tab 定义补丁脚本`, html.includes(tabMetaDefaultsScript()));
}
check("allNodeHtml 覆盖全部六类型的补丁脚本（每类一份）",
  allNodeHtml().split(tabMetaDefaultsScript()).length - 1 === MCODE_NODE_PACK_TYPES.length);
check("补丁脚本带 fail-closed 自检（缺 tab 定义时抛错）",
  /throw new Error\("Mcode node pack: built-in tab definition unavailable"\)/.test(tabMetaDefaultsScript()));
check("补丁脚本带生效自检（补后仍读不到 x-mcode 时抛错）",
  /throw new Error\("Mcode node pack: tab defaults patch failed"\)/.test(tabMetaDefaultsScript()));
check("agent 节点包的 HTML 标签仍以 mcode-agent 注册",
  htmlByType[MCODE_AGENT_NODE_TYPE]!().includes(`RED.nodes.registerType("${MCODE_AGENT_NODE_TYPE}"`));
{
  const files = expectedNodePackFiles();
  check("托管清单生成的文件里 HTML 与生成器一致（安装器会用这一份）",
    MCODE_NODE_PACK_TYPES.every((type) => files[type + ".html"] === htmlByType[type]!()));
}

/* ══════════════ A2. 补丁脚本的运行行为（桩 RED，fail-closed 判据） ══════════════ */

/**
 * 在一个最小 `RED` 桩上执行补丁脚本。`tab` 是内置定义（与上游同一形状：
 * `defaults` 里 label/disabled/locked/info/env，没有 x-mcode）；`preTypes` 是提前
 * 注册的其它内置类型；其余走 `register(type, def)` 模拟**晚注册**。
 */
function runPatchScript(options: {
  tab?: Record<string, unknown> | null;
  preTypes?: string[];
  eventsApi?: boolean;
} = {}): {
  threw: string | null;
  logs: string[];
  defaultsOf: (type: string) => Record<string, unknown> | undefined;
  register: (type: string) => void;
  errorLogs: string[];
} {
  const defs = new Map<string, Record<string, unknown>>();
  if (options.tab !== null) {
    defs.set("tab", options.tab ?? {
      defaults: { label: { value: "" }, disabled: { value: false }, locked: { value: false }, info: { value: "" }, env: { value: [] } },
    });
  }
  for (const type of options.preTypes ?? []) defs.set(type, { defaults: { name: { value: "" } } });
  const logs: string[] = [];
  const handlers: Array<(type: string) => void> = [];
  const RED = {
    nodes: { getType: (type: string) => defs.get(type) },
    events: options.eventsApi === false ? undefined : {
      on: (event: string, fn: (type: string) => void) => { if (event === "registry:node-type-added") handlers.push(fn); },
    },
  };
  let threw: string | null = null;
  try {
    // 与编辑器执行 `<script type="text/javascript">` 同一条路径：页面上下文里的 RED/console。
    new Function("RED", "console", tabMetaDefaultsScript())(
      RED,
      { error: (message: unknown) => logs.push(String(message)), warn: (message: unknown) => logs.push(String(message)), log: () => undefined },
    );
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  return {
    threw,
    logs,
    errorLogs: logs,
    defaultsOf: (type) => defs.get(type)?.["defaults"] as Record<string, unknown> | undefined,
    register: (type) => {
      defs.set(type, { defaults: { name: { value: "" } } });
      for (const fn of [...handlers]) fn(type);
    },
  };
}

console.log("\nA2. 补丁脚本运行行为：生效时有声明，失效时抛错（fail-closed）");
{
  // 正路：上游 5.0.8 形状的 tab 定义 + 核心类型都已注册。
  const ok = runPatchScript({ preTypes: ["inject", "watch", "switch", "exec", "function"] });
  check("A2 全类型已注册时补丁不抛错", ok.threw === null, { threw: ok.threw });
  check("A2 补丁生效时 tab.defaults 里确实有 x-mcode（fail-closed 的正面判据）",
    Object.prototype.hasOwnProperty.call(ok.defaultsOf("tab") ?? {}, "x-mcode"), { defaults: ok.defaultsOf("tab") });
  check("A2 补丁对已注册的内置节点类型同样生效（inject/watch/switch/exec/function）",
    ["inject", "watch", "switch", "exec", "function"].every((type) =>
      Object.prototype.hasOwnProperty.call(ok.defaultsOf(type) ?? {}, "x-mcode")));
  check("A2 补丁不覆盖内置 defaults 的原有键（label/disabled/locked/info/env 仍在）",
    ["label", "disabled", "locked", "info", "env"].every((key) =>
      Object.prototype.hasOwnProperty.call(ok.defaultsOf("tab") ?? {}, key)), { defaults: ok.defaultsOf("tab") });

  // 晚注册：上游节点集比节点包 HTML 后加载时，靠 registry:node-type-added 补。
  const late = runPatchScript({ eventsApi: true });
  check("A2 晚注册前 inject 还没有 x-mcode（前提成立）",
    !Object.prototype.hasOwnProperty.call(late.defaultsOf("inject") ?? {}, "x-mcode"));
  late.register("inject");
  check("A2 晚注册的类型在 registry:node-type-added 之后被补上（事件路径真的接了线）",
    Object.prototype.hasOwnProperty.call(late.defaultsOf("inject") ?? {}, "x-mcode"), { defaults: late.defaultsOf("inject") });

  // 失效路径 1：tab 定义不存在（编辑器升级/加载顺序与假设不符）→ 必须响。
  const noTab = runPatchScript({ tab: null, preTypes: ["inject"] });
  check("A2 tab 定义缺失时补丁抛错（不静默导出没有身份的图）",
    noTab.threw === "Mcode node pack: built-in tab definition unavailable", { threw: noTab.threw });
  check("A2 tab 定义缺失时同时记 console.error", noTab.errorLogs.some((l) => l.includes("built-in tab definition missing")), { logs: noTab.errorLogs });

  // 失效路径 2：tab 定义形状变了（defaults 不在/null）→ 必须响，且错误可区分。
  const badShape = runPatchScript({ tab: { noDefaults: true }, preTypes: [] });
  check("A2 tab 定义形状变了（没有 defaults）时补丁抛错",
    badShape.threw === "Mcode node pack: built-in tab definition unavailable", { threw: badShape.threw });

  // 失效路径 3：defaults 存在但不可写（冻结对象）→ 补不进去必须响，而不是"看起来跑了"。
  // 脚本标签是 sloppy mode，给冻结对象赋值不抛而是静默失败；此时 patch() 返回 false，
  // tab 落入 missing → 第一条 fail-closed 抛错。两种错误都是"响的"，关键是绝不静默。
  const frozenDefaults = Object.freeze({ label: { value: "" } });
  const frozen = (() => {
    const defs = new Map<string, Record<string, unknown>>([
      ["tab", { defaults: frozenDefaults }],
    ]);
    let threw: string | null = null;
    try {
      new Function("RED", "console", tabMetaDefaultsScript())(
        { nodes: { getType: (type: string) => defs.get(type) }, events: { on: () => undefined } },
        { error: () => undefined, warn: () => undefined, log: () => undefined },
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    return threw;
  })();
  check("A2 tab.defaults 不可写（补丁没生效）时 fail-closed 抛错，而不是静默继续",
    frozen !== null && /^Mcode node pack: /.test(frozen), { threw: frozen });
}

/* ══════════════ B/C. 真上游往返 ══════════════ */
const upstreamPath = requireUpstreamAvailable(REPO_ROOT);
if (upstreamPath === null) {
  console.log("\nSKIP: 仓库没有 vendor Node-RED（node-red/ 缺失）—— 真上游往返段整套跳过（不是失败）。");
} else {
  const version = upstreamVersion(REPO_ROOT);
  console.log(`\nB. 真上游往返（node-red ${String(version)}：${upstreamPath}）`);
  check("vendor 版本是 5.0.8（本套件的断言按此版本的上游源码写成）", version === "5.0.8", { version });

  // ── 夹具：一份 Mcode 图 → 迁移器产出的原生节点数组（与生产装载同一条路径）。
  // 覆盖补丁点名的全部落点：manual trigger → inject、file trigger → watch、
  // condition → switch、JS code → function、command → exec，外加 Mcode 自有类型。
  const fixtureDoc = (): WorkflowDoc => ({
    id: "wf_t28_roundtrip",
    engine: "node-red",
    name: "T28 往返夹具",
    builtin: false,
    trigger: "manual",
    updatedAt: 1_700_000_000_000,
    nodes: [
      {
        id: "n_t28_trigger",
        type: "mcode.trigger",
        title: "入口",
        params: { triggerKind: "manual", task: "跑一下" },
        position: { x: 100, y: 100 },
      },
      {
        id: "n_t28_watch",
        type: "mcode.trigger",
        title: "文件入口",
        params: { triggerKind: "file", task: "盯着", paths: "/tmp/in" },
        position: { x: 100, y: 220 },
      },
      {
        id: "n_t28_agent",
        type: "mcode.agent",
        title: "执行一步",
        params: { instruction: "把这件事做完" },
        position: { x: 320, y: 100 },
      },
      {
        id: "n_t28_cond",
        type: "mcode.condition",
        title: "条件",
        params: { expression: { logic: "and", rules: [] } },
        position: { x: 520, y: 100 },
      },
      {
        id: "n_t28_fn",
        type: "mcode.code",
        title: "脚本",
        params: { language: "node", code: "return msg;" },
        position: { x: 720, y: 100 },
      },
      {
        id: "n_t28_exec",
        type: "mcode.command",
        title: "命令",
        params: { command: "echo hi" },
        position: { x: 920, y: 100 },
      },
    ],
    edges: [
      { id: "e_t28_a", from: "n_t28_trigger", to: "n_t28_agent" },
      { id: "e_t28_b", from: "n_t28_watch", to: "n_t28_agent" },
      { id: "e_t28_c", from: "n_t28_agent", to: "n_t28_cond" },
      { id: "e_t28_d", from: "n_t28_cond", to: "n_t28_fn", label: "true" },
      { id: "e_t28_e", from: "n_t28_fn", to: "n_t28_exec" },
    ],
  });
  const fixtureTypes = (): Map<string, NodeTypeManifest> => {
    const types = new Map<string, NodeTypeManifest>();
    for (const id of ["mcode.trigger", "mcode.agent", "mcode.condition", "mcode.code", "mcode.command"]) {
      const manifest = builtinManifestById(id);
      if (manifest === undefined) throw new Error(`T28: 内置清单缺 ${id}`);
      types.set(id, manifest);
    }
    return types;
  };
  const migrated = migrateWorkflowDoc(fixtureDoc(), { types: fixtureTypes() });
  const nativeNodes = JSON.parse(JSON.stringify(migrated.flow.nodes)) as Array<Record<string, unknown>>;
  const sourceTabMeta = (nativeNodes.find((n) => n["type"] === "tab") ?? {})["x-mcode"];
  check("夹具迁移产物：tab 上有 x-mcode.docId（生产的正向载体）",
    typeof (sourceTabMeta as { docId?: unknown } | undefined)?.docId === "string",
    { sourceTabMeta });
  // 前提：夹具确实落到了补丁点名的每一个内置类型上（否则后面的断言不在判）。
  eq("夹具覆盖全部内置落点（inject/watch/switch/function/exec）",
    [...new Set(nativeNodes.map((n) => n["type"]))].sort(),
    ["exec", "function", "inject", "mcode-agent", "switch", "tab", "watch"]);

  /**
   * 组装一个编辑器上下文：先建 node set，再执行节点包 HTML，核心类型由**真上游
   * 核心节点 HTML** 注册。
   *
   * `coreOrder` 决定核心类型比节点包早还是晚注册：
   *   - `"before"`：补丁脚本执行时类型已在 → 走"立即补"分支；
   *   - `"after"`：补丁脚本先执行、类型后注册 → 走 `registry:node-type-added`。
   * 编辑器真实时序是「全部节点集加载完之后才导入 flows」，两种顺序都在导入之前。
   */
  const bootEditor = (
    htmlFor: (type: string) => string,
    coreOrder: "before" | "after" = "after",
  ): UpstreamEditor => {
    const editor = createUpstreamEditor(upstreamPath);
    editor.RED.nodes.addNodeSet({
      id: "node-red", module: "node-red", name: "node-red", version: String(version ?? "5.0.8"),
      local: false, added: false, enabled: true, types: UPSTREAM_CORE_HTML.map((entry) => entry.type),
    });
    addNodeSet(editor, MCODE_NODE_PACK_TYPES);
    const loadNodePack = (): void => {
      for (const type of MCODE_NODE_PACK_TYPES) editor.runNodeHtml(htmlFor(type), `${type}.html`);
    };
    if (coreOrder === "before") {
      loadUpstreamCoreNodes(editor, REPO_ROOT);
      loadNodePack();
    } else {
      loadNodePack();
      loadUpstreamCoreNodes(editor, REPO_ROOT);
    }
    return editor;
  };

  /** 把一份节点数组按上游真实导入路径放进画布（编辑器「导入」对话框同一条）。 */
  const loadIntoCanvas = (editor: UpstreamEditor, payload: unknown): void => {
    const result = editor.RED.nodes.import(JSON.parse(JSON.stringify(payload)), { generateIds: false, addFlow: false });
    if (!Array.isArray(result.nodes)) throw new Error("T28: upstream import() 没有返回 nodes 数组");
  };

  /** 从导出集合里取回我们关心的对象。 */
  const pick = (set: Array<Record<string, unknown>>): {
    tab: Record<string, unknown> | undefined;
    byNodeId: (nodeId: string) => Record<string, unknown> | undefined;
  } => ({
    tab: set.find((n) => n["type"] === "tab" && (n["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip"),
    byNodeId: (nodeId) => set.find((n) => (n["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === nodeId),
  });

  const FIXTURE_NODE_IDS = ["n_t28_trigger", "n_t28_watch", "n_t28_agent", "n_t28_cond", "n_t28_fn", "n_t28_exec"];
  const sourceByNodeId = (nodeId: string): Record<string, unknown> =>
    nativeNodes.find((n) => (n["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === nodeId) ?? {};

  /** 补丁生效的**直接**判据（对真上游的 tab 定义对象）。 */
  const assertPatchEffective = (editor: UpstreamEditor, label: string): void => {
    const tabDef = editor.RED.nodes.getType("tab") as { defaults?: Record<string, unknown> } | undefined;
    check(`${label} 补丁在真上游 tab 定义上生效（defaults 里确实有 x-mcode）`,
      tabDef !== undefined && tabDef.defaults !== undefined
        && Object.prototype.hasOwnProperty.call(tabDef.defaults, "x-mcode"),
      { defaults: tabDef?.defaults });
    for (const type of ["inject", "watch", "switch", "function", "exec"]) {
      const def = editor.RED.nodes.getType(type) as { defaults?: Record<string, unknown> } | undefined;
      check(`${label} 内置 ${type} 定义也带上了 x-mcode`,
        def !== undefined && def.defaults !== undefined
          && Object.prototype.hasOwnProperty.call(def.defaults, "x-mcode"), { defaults: def?.defaults });
    }
  };

  // ── B1. 导出：x-mcode 在 JSON 里（tab + 每个节点） ──
  {
    // 默认顺序 `after`：核心类型晚于节点包注册 —— 这正是编辑器里「节点包脚本先跑、
    // 上游核心节点集后到」的时序，验证 `registry:node-type-added` 延迟补丁生效。
    const editor = bootEditor((type) => htmlByType[type]!());
    assertPatchEffective(editor, "B1");
    loadIntoCanvas(editor, nativeNodes);
    const exported = editor.RED.nodes.createCompleteNodeSet({ credentials: false });
    const { tab, byNodeId } = pick(exported);
    check("B1 tab 的 x-mcode 被导出（含 docId）",
      (tab?.["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip");
    eq("B1 导出的 tab x-mcode 与迁移器写入的逐字段相等", tab?.["x-mcode"], sourceTabMeta);
    for (const nodeId of FIXTURE_NODE_IDS) {
      eq(`B1 导出含 ${nodeId} 的 x-mcode（逐字段相等）`,
        byNodeId(nodeId)?.["x-mcode"], sourceByNodeId(nodeId)["x-mcode"]);
    }

    // ── B1b. 立即补分支：核心类型先于节点包注册，结果必须完全一致 ──
    const earlyEditor = bootEditor((type) => htmlByType[type]!(), "before");
    assertPatchEffective(earlyEditor, "B1b");
    loadIntoCanvas(earlyEditor, nativeNodes);
    eq("B1b 先注册后补的导出 x-mcode 与晚注册路径逐字段一致",
      earlyEditor.RED.nodes.createCompleteNodeSet({ credentials: false }).map((n) => n["x-mcode"] ?? null),
      exported.map((n) => n["x-mcode"] ?? null));

    // ── B2. 「清空画布，导入那份 JSON」：新建一个同样的编辑器（没有旧节点），导入。 ──
    const exportedJson = JSON.parse(JSON.stringify(exported)) as Array<Record<string, unknown>>;
    const fresh = bootEditor((type) => htmlByType[type]!());
    loadIntoCanvas(fresh, exportedJson);
    const after = fresh.RED.nodes.createCompleteNodeSet({ credentials: false });
    const afterPick = pick(after);
    check("B2 导入后 tab 的 x-mcode 还在且 docId 一致",
      (afterPick.tab?.["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip");
    for (const nodeId of FIXTURE_NODE_IDS) {
      eq(`B2 导入后 ${nodeId} 的 x-mcode 还在且逐字段一致`,
        afterPick.byNodeId(nodeId)?.["x-mcode"], exportedJson.find((n) =>
          (n["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === nodeId)?.["x-mcode"]);
    }
    eq("B2 往返前后 tab x-mcode 逐字段相等",
      afterPick.tab?.["x-mcode"], exportedJson.find((n) => n["type"] === "tab")?.["x-mcode"]);
    // 往返稳定（第二次导出与第一次在 x-mcode 上深相等，而不是只有第一次带）。
    eq("B2 二次导出与首次导出的 x-mcode 深相等（往返稳定）",
      after.map((n) => n["x-mcode"] ?? null), exported.map((n) => n["x-mcode"] ?? null));

    // ── B3. 能关联回原库文档：Mcode 的真实反向适配器 ──
    const restored = flowToWorkflowDoc({
      id: String(afterPick.tab?.["id"] ?? ""),
      label: String(afterPick.tab?.["label"] ?? ""),
      nodes: after as never,
    });
    eq("B3 往返后 flowToWorkflowDoc 关联回原库文档 id", restored.id, "wf_t28_roundtrip");
    eq("B3 往返后恢复的 Mcode 节点 id 与库文档一致",
      restored.nodes.map((n) => n.id).sort(), [...FIXTURE_NODE_IDS].sort());
    check("B3 往返后恢复的文档仍标记 engine=node-red", restored.engine === "node-red", { engine: restored.engine });
  }

  // ── C. 反向对照：剥掉声明 → 同一路径必须丢身份（内建负控） ──
  {
    // 声明条目是 `"x-mcode": { value: undefined }`，六份 HTML 里位置不同（mcode-agent
    // 后面还有别的键，带上逗号；另外五类它是最后一个）。只剥「带逗号」的写法会漏掉
    // 五类（原半成品的负控因此只真的覆盖了 mcode-agent）—— 这里按条目本身剥。
    const stripDeclarations = (type: string): string => htmlByType[type]!()
      .replace(`${MCODE_X_MCODE_DEFAULT_ENTRY},`, "")
      .replace(MCODE_X_MCODE_DEFAULT_ENTRY, "")
      .replace(tabMetaDefaultsScript(), "");
    // 前提：六份 HTML 都真的被剥干净了（否则负控可能"部分生效"，结论说不清）。
    check("C 负控前提：六份 HTML 剥掉后都不再含 x-mcode 声明与 tab 补丁",
      MCODE_NODE_PACK_TYPES.every((type) => {
        const stripped = stripDeclarations(type);
        return !stripped.includes(MCODE_X_MCODE_DEFAULT_ENTRY) && !stripped.includes(tabMetaDefaultsScript());
      }));
    const editor = bootEditor(stripDeclarations);
    loadIntoCanvas(editor, nativeNodes);
    const exported = editor.RED.nodes.createCompleteNodeSet({ credentials: false });
    const { tab, byNodeId } = pick(exported);
    eq("C 负控：未声明时导出的 tab 没有 x-mcode（复现 T8 缺陷 2）", tab?.["x-mcode"], undefined);
    check("C 负控：未声明时六类节点的 x-mcode 全部丢失（副本逐类型复现）",
      FIXTURE_NODE_IDS.every((nodeId) => byNodeId(nodeId)?.["x-mcode"] === undefined),
      { present: FIXTURE_NODE_IDS.filter((nodeId) => byNodeId(nodeId)?.["x-mcode"] !== undefined) });
    const logs = editor.logs.errors.concat(editor.logs.warns).join("\n");
    check("C 负控：丢数据是静默的（编辑器不报 x-mcode 相关错误，正是缺陷性质）",
      !/x-mcode/i.test(logs), { logs });
  }
}

/* ══════════════ D. 托管清单：安装到数据目录的 HTML 就是带声明的那一份 ══════════════ */
console.log("\nD. 安装到 <userDir>/nodes 的节点包字节 = 生成器当前产物");
{
  const files = expectedNodePackFiles();
  const allHtml = MCODE_NODE_PACK_TYPES.map((type) => files[type + ".html"] ?? "").join("\n");
  eq("清单里六份 HTML 的 x-mcode 声明计数 = 6", allHtml.split(MCODE_X_MCODE_DEFAULT_ENTRY).length - 1, 6);
  eq("清单里 tab 补丁脚本计数 = 6", allHtml.split(tabMetaDefaultsScript()).length - 1, 6);
  check("runtime CJS 不含 HTML（HTML 是独立资产，安装器逐文件写盘）",
    !(files["mcode-runtime.cjs"] ?? "").includes("data-template-name"));
  // 声明数 = **实际安装**的类型数（palette 六 + 内部求值适配节点）。从前写死 6：
  // W17 加了内部节点后这条会假红，而它想验的是「package.json 与安装清单同源」。
  check("package.json 的 node-red.nodes 与安装的类型清单同源",
    Object.keys((JSON.parse(files["package.json"] ?? "{}") as { "node-red"?: { nodes?: Record<string, string> } })["node-red"]?.nodes ?? {}).length
      === MCODE_REGISTERED_NODE_TYPES.length);
  const manifest = JSON.parse(files["package.json"] ?? "{}") as { name?: string };
  eq("package 名字仍是 mcode-node-pack", manifest.name, "mcode-node-pack");
  // 安装版本号是清单的一部分 —— 资产变了而不前进，旧数据目录里的 HTML 就不会被重写。
  eq("安装版本号已前进到 3（T28 改了编辑器 HTML）", MCODE_NODE_PACK_INSTALL_VERSION, 3);
  void readFileSync;
}

console.log(`\nx-mcode-roundtrip-smoke：${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
