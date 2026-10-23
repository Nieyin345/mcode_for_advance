/**
 * 【T51】工作流搭建指南 —— 真读 Node-RED 的 en-US 帮助文件。
 *
 * ## 钉住什么
 *
 *  1. `design` 主题给出**可执行的**方法论：节点怎么选、数据怎么流动、失败怎么处理、
 *     验收怎么做 —— 并明确「自足步骤用子 agent、需要历史才用 conversation」这条
 *     最容易搞反的判断；
 *  2. `debugging` 主题给出症状对照表；
 *  3. `nodes` 主题列出 Node-RED **原生**节点，数量与实测一致（49）；
 *  4. 取单个节点（`inject`）返回**上游原文**：含 `payload` / `topic` 与 cron 陷阱 ——
 *     证明真的读到了 Node-RED 自己的帮助，不是我们编的；
 *  5. 负控：未知节点、未知主题都显式报错并给可用清单；
 *  6. 目录读不到时**如实报错**，不返回空指南冒充成功。
 *
 * ## 变异
 *
 *  `--mutate=empty-help`：`readNodeRedHelp` 不解析任何帮助块（返回空索引），
 *  断言必须变红 —— 模拟「接了但取不到内容」。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MUTATE = process.argv.find((arg) => arg.startsWith("--mutate="))?.slice("--mutate=".length) ?? null;

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 700)}`}`);
  }
}

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const NODE_RED = join(REPO_ROOT, "node-red");

const guide = await import("../../src/main/orchestration/workflowGuide.js");

/** 变异：把所有帮助块都"解析不出来"。 */
const readHelp = MUTATE === "empty-help"
  ? (root: string) => ({ ...guide.readNodeRedHelp(root), byName: new Map() })
  : guide.readNodeRedHelp;

console.log("\n1. 实测 Node-RED 帮助目录（证据）");
const index = readHelp(NODE_RED);
{
  check("扫描根指向仓库内 node-red 快照", index.root.includes("node-red"), { root: index.root });
  const names = guide.nodeRedHelpNames(index);
  console.log(`     节点数=${names.length} problems=${index.problems.length}`);
  if (MUTATE !== "empty-help") {
    check("节点数与实测一致（49）", names.length === 49, { count: names.length, sample: names.slice(0, 5) });
    check("包含 inject", names.includes("inject"));
    check("包含 http request", names.includes("http request"));
    check("解析问题清单为空（没有跳过任何文件）", index.problems.length === 0, index.problems.slice(0, 3));
  }
}

console.log("\n2. design：方法论必须可直接执行");
{
  const r = guide.workflowGuide(index, { topic: "design" });
  check("取到了", r.ok === true, r.ok ? undefined : r);
  if (r.ok) {
    console.log(`     chars=${r.chars}`);
    for (const [label, needle] of [
      ["节点选型表", "节点怎么选"],
      ["子 agent vs conversation 的判断", "mcode.conversation"],
      ["上游产出怎么引用", "{{"],
      ["失败怎么处理", "失败与重试"],
      ["验收先跑一遍", "app_workflow_run"],
      ["不要做的事", "不要做的事"],
    ] as Array<[string, string]>) {
      check(`正文含：${label}`, r.text.includes(needle));
    }
    check("明确说「上下文只增不减」这个反直觉点", r.text.includes("只增不减"));
  }
}

console.log("\n3. debugging：症状对照");
{
  const r = guide.workflowGuide(index, { topic: "debugging" });
  check("取到了", r.ok === true, r.ok ? undefined : r);
  if (r.ok) {
    check("有症状对照表", r.text.includes("症状") && r.text.includes("多半是"));
    check("指出「引用了非上游/未声明产出」是最常见原因", r.text.includes("产出变量"));
  }
}

console.log("\n4. nodes：目录 + 单个节点原文");
{
  const list = guide.workflowGuide(index, { topic: "nodes" });
  check("列目录取到了", list.ok === true, list.ok ? undefined : list);
  if (list.ok) {
    check("目录里点名了 Node-RED 原生节点", list.text.includes("inject") && list.text.includes("debug"));
    check("目录里提醒 Mcode 自有节点要走 workflow.nodeTypes", list.text.includes("workflow.nodeTypes"));
  }

  const inject = guide.workflowGuide(index, { topic: "nodes", node: "inject" });
  check("取 inject 帮助成功", inject.ok === true, inject.ok ? undefined : inject);
  if (inject.ok) {
    // 这几条是**上游原文**里才有的内容，证明不是我们编的
    check("含 payload 输出属性", inject.text.includes("payload"));
    check("含 topic 可选属性", inject.text.includes("topic"));
    check("含 cron 陷阱原文（20 minutes will be at the next hour）",
      /20 minutes will be at the next hour/i.test(inject.text));
    check("标注了来源文件", inject.text.includes("locales/en-US/"));
    check("正文不是 HTML 原文（标签已剥）", !/<p>|<dl|<\/p>/.test(inject.text), { sample: inject.text.slice(0, 200) });
  }
}

console.log("\n5. 负控：未知节点 / 未知主题");
{
  const badNode = guide.workflowGuide(index, { topic: "nodes", node: "no_such_node_xyz" });
  check("未知节点显式报错", badNode.ok === false, badNode);
  check("报错时给出可用节点清单", (badNode.nodes?.length ?? 0) > 0, { count: badNode.nodes?.length });
  check("报错时说明 Mcode 自有节点不在这个目录", !badNode.ok && (badNode.reason ?? "").includes("workflow.nodeTypes"),
    badNode.ok ? null : badNode.reason);

  const badTopic = guide.workflowGuide(index, { topic: "no_such_topic" });
  check("未知主题显式报错并给可用主题", badTopic.ok === false && (badTopic.reason ?? "").includes("design"), badTopic);
}

console.log("\n6. 目录读不到时如实报错（不返回空指南冒充成功）");
{
  const empty = guide.readNodeRedHelp(join(REPO_ROOT, "no-such-node-red-dir"));
  const r = guide.workflowGuide(empty, { topic: "nodes" });
  check("空索引 + nodes 主题 → 失败", r.ok === false, r);
  check("失败原因点名读不到的目录", !r.ok && (r.reason ?? "").includes("读不到"), r.ok ? null : r.reason);
  // design/debugging 是 Mcode 自己写的，不依赖 Node-RED
  const designStillWorks = guide.workflowGuide(empty, { topic: "design" });
  check("但 design 方法论不依赖 Node-RED（仍可用）", designStillWorks.ok === true, designStillWorks.ok ? undefined : designStillWorks);
}

console.log("\n7. 源文件确实存在（证据可追溯）");
{
  const en = join(NODE_RED, "packages/node_modules/@node-red/nodes/locales/en-US");
  let files: string[] = [];
  try { files = readdirSync(en, { recursive: true } as never).filter((f: unknown) => String(f).endsWith(".html")); } catch { /* 旧 node */ }
  check("en-US 帮助文件数 > 0", files.length > 0, { count: files.length });
}

console.log(`\nt51-workflow-guide-smoke:${total - failures}/${total} 通过${MUTATE ? `（变异 ${MUTATE}）` : ""}`);
process.exit(failures === 0 ? 0 : 1);
