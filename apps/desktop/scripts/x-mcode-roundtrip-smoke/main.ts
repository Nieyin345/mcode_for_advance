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
 * **B. 真上游往返（本套件的核心）**：把仓库里真实的
 * `node-red/packages/node_modules/@node-red/editor-client/src/js/nodes.js` 装进
 * `vm`，用与编辑器相同的 `appendConfig` 语义执行我们生成的节点 HTML，然后走**上游自己**
 * 的 `createCompleteNodeSet`（导出）→ **新建一个同样的编辑器**（等价于"清空画布"）
 * → `import` 同一份 JSON → 再 `createCompleteNodeSet`：
 *
 *   - 导出 JSON 里 `x-mcode` 在（tab 与节点两处）；
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
  allNodeHtml,
  branchNodeHtml,
  conversationNodeHtml,
  moduleCapabilityNodeHtml,
  nodeRedCallNodeHtml,
  triggerNodeHtml,
} from "@main/workflowEngines/mcodeNodeTypes.js";
import { migrateWorkflowDoc, flowToWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { expectedNodePackFiles } from "@main/workflowEngines/nodePackManifest.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import {
  addNodeSet,
  createUpstreamEditor,
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

/* ══════════════ B/C. 真上游往返 ══════════════ */
const upstreamPath = requireUpstreamAvailable(REPO_ROOT);
if (upstreamPath === null) {
  console.log("\nSKIP: 仓库没有 vendor Node-RED（node-red/ 缺失）—— 真上游往返段整套跳过（不是失败）。");
} else {
  const version = upstreamVersion(REPO_ROOT);
  console.log(`\nB. 真上游往返（node-red ${String(version)}：${upstreamPath}）`);
  check("vendor 版本是 5.0.8（本套件的断言按此版本的上游源码写成）", version === "5.0.8", { version });

  // ── 夹具：一份 Mcode 图 → 迁移器产出的原生节点数组（与生产装载同一条路径） ──
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
        id: "n_t28_agent",
        type: "mcode.agent",
        title: "执行一步",
        params: { instruction: "把这件事做完" },
        position: { x: 320, y: 100 },
      },
    ],
    edges: [{ id: "e_t28", from: "n_t28_trigger", to: "n_t28_agent" }],
  });
  const fixtureTypes = (): Map<string, NodeTypeManifest> => {
    const types = new Map<string, NodeTypeManifest>();
    for (const id of ["mcode.trigger", "mcode.agent"]) {
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

  /** 组装一个编辑器上下文并注册全部六类型（与编辑器加载节点包的顺序一致）。 */
  const bootEditor = (htmlFor: (type: string) => string): UpstreamEditor => {
    const editor = createUpstreamEditor(upstreamPath);
    // 真实编辑器里核心节点（`inject`/`watch`…）由 node-red 自己的 node set 提供。
    // 本套件只用到 `inject`（manual trigger 的迁移落点），按上游同一种「node set +
    // 最小注册」给它一个可导入的定义；未注册时上游会把它当 unknown 并需要
    // `unknown` 节点定义（那是编辑器自带的核心资产，本 vm 不加载）。
    addNodeSet(editor, MCODE_NODE_PACK_TYPES);
    editor.RED.nodes.addNodeSet({
      id: "node-red", module: "node-red", name: "node-red", version: String(version ?? "5.0.8"),
      local: false, added: false, enabled: true, types: ["inject"],
    });
    editor.RED.nodes.registerType("inject", {
      category: "common", defaults: { name: { value: "" }, props: { value: [] }, repeat: { value: "" }, crontab: { value: "" }, once: { value: false }, onceDelay: { value: "" } },
      inputs: 0, outputs: 1, color: "#a6bbcf", label: function (this: { name?: string }) { return this.name || "inject"; },
    });
    for (const type of MCODE_NODE_PACK_TYPES) editor.runNodeHtml(htmlFor(type), `${type}.html`);
    return editor;
  };

  /** 把一份节点数组按上游真实导入路径放进画布（编辑器「导入」对话框同一条）。 */
  const loadIntoCanvas = (editor: UpstreamEditor, payload: unknown): void => {
    const result = editor.RED.nodes.import(JSON.parse(JSON.stringify(payload)), { generateIds: false, addFlow: false });
    if (!Array.isArray(result.nodes)) throw new Error("T28: upstream import() 没有返回 nodes 数组");
  };

  /** 从导出集合里取回我们关心的对象（trigger 走 manual → 内置 inject）。 */
  const pick = (set: Array<Record<string, unknown>>): {
    tab: Record<string, unknown> | undefined;
    agent: Record<string, unknown> | undefined;
    trigger: Record<string, unknown> | undefined;
  } => ({
    tab: set.find((n) => n["type"] === "tab" && (n["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip"),
    agent: set.find((n) => n["type"] === "mcode-agent"),
    trigger: set.find((n) => {
      const meta = n["x-mcode"] as { nodeId?: unknown } | undefined;
      return meta?.nodeId === "n_t28_trigger";
    }),
  });

  // ── B1. 导出：x-mcode 在 JSON 里（tab + 节点两处） ──
  {
    const editor = bootEditor((type) => htmlByType[type]!());
    loadIntoCanvas(editor, nativeNodes);
    const exported = editor.RED.nodes.createCompleteNodeSet({ credentials: false });
    const { tab, agent, trigger } = pick(exported);
    check("B1 tab 的 x-mcode 被导出（含 docId）",
      (tab?.["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip");
    check("B1 mcode-agent 的 x-mcode 被导出（含 nodeId）",
      (agent?.["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === "n_t28_agent");
    check("B1 mcode-trigger 的 x-mcode 被导出（含 nodeId）",
      (trigger?.["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === "n_t28_trigger");
    eq("B1 导出的 tab x-mcode 与迁移器写入的逐字段相等", tab?.["x-mcode"], sourceTabMeta);
    eq("B1 导出的 agent x-mcode 与迁移器写入的逐字段相等",
      agent?.["x-mcode"], (nativeNodes.find((n) => n["type"] === "mcode-agent") ?? {})["x-mcode"]);

    // ── B2. 「清空画布，导入那份 JSON」：新建一个同样的编辑器（没有旧节点），导入。 ──
    const exportedJson = JSON.parse(JSON.stringify(exported)) as Array<Record<string, unknown>>;
    const fresh = bootEditor((type) => htmlByType[type]!());
    loadIntoCanvas(fresh, exportedJson);
    const after = fresh.RED.nodes.createCompleteNodeSet({ credentials: false });
    const afterPick = pick(after);
    check("B2 导入后 tab 的 x-mcode 还在且 docId 一致",
      (afterPick.tab?.["x-mcode"] as { docId?: unknown } | undefined)?.docId === "wf_t28_roundtrip");
    check("B2 导入后 agent 的 x-mcode 还在且 nodeId 一致",
      (afterPick.agent?.["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === "n_t28_agent");
    check("B2 导入后 trigger 的 x-mcode 还在且 nodeId 一致",
      (afterPick.trigger?.["x-mcode"] as { nodeId?: unknown } | undefined)?.nodeId === "n_t28_trigger");
    eq("B2 往返前后 tab x-mcode 逐字段相等",
      afterPick.tab?.["x-mcode"], exportedJson.find((n) => n["type"] === "tab")?.["x-mcode"]);
    eq("B2 往返前后 agent x-mcode 逐字段相等",
      afterPick.agent?.["x-mcode"], exportedJson.find((n) => n["type"] === "mcode-agent")?.["x-mcode"]);
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
      restored.nodes.map((n) => n.id).sort(), ["n_t28_agent", "n_t28_trigger"]);
    check("B3 往返后恢复的文档仍标记 engine=node-red", restored.engine === "node-red", { engine: restored.engine });
  }

  // ── C. 反向对照：剥掉声明 → 同一路径必须丢身份（内建负控） ──
  {
    const stripDeclarations = (type: string): string => htmlByType[type]!()
      .replace(`${MCODE_X_MCODE_DEFAULT_ENTRY},`, "")
      .replace(tabMetaDefaultsScript(), "");
    const strippedAgent = stripDeclarations(MCODE_AGENT_NODE_TYPE);
    check("C 负控前提：剥掉后 agent HTML 不再含 x-mcode 声明与 tab 补丁",
      !strippedAgent.includes(MCODE_X_MCODE_DEFAULT_ENTRY) && !strippedAgent.includes(tabMetaDefaultsScript()));
    const editor = bootEditor(stripDeclarations);
    loadIntoCanvas(editor, nativeNodes);
    const exported = editor.RED.nodes.createCompleteNodeSet({ credentials: false });
    const { tab, agent } = pick(exported);
    eq("C 负控：未声明时导出的 agent 没有 x-mcode（复现 T8 缺陷 2）", agent?.["x-mcode"], undefined);
    eq("C 负控：未声明时导出的 tab 没有 x-mcode（复现 T8 缺陷 2）", tab?.["x-mcode"], undefined);
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
  check("package.json 的 node-red.nodes 仍声明六个类型",
    Object.keys((JSON.parse(files["package.json"] ?? "{}") as { "node-red"?: { nodes?: Record<string, string> } })["node-red"]?.nodes ?? {}).length === 6);
  // 安装版本号只在「编辑器资产变了」时前进：这里钉住它确实前进了（旧数据目录会被重写）。
  const manifest = JSON.parse(files["package.json"] ?? "{}") as { name?: string };
  eq("package 名字仍是 mcode-node-pack", manifest.name, "mcode-node-pack");
  void readFileSync;
}
