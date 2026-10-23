/**
 * 【T51】**工作流搭建指南 + Node-RED 原生节点帮助**。
 *
 * ## 缺口（与 T47 同形）
 *
 * T47 之前，模型能建 deck 却拿不到 `guide slides design` 的设计方法论。工作流这边
 * 是同一个形状，但**分开两半**：
 *
 *  - **参数那一半不缺**：`workflow.nodeTypes`（`read` 档，模型经 `app_api_call` 可达）
 *    已经返回 Mcode 全部节点类型，每个参数带 `help`、每个节点带大段 `usage`。
 *  - **「怎么搭」那一半缺**：节点清单只回答「有哪些类型、每个键填什么」，
 *    不回答「一个自动化该怎么组织」「什么时候用子 agent、什么时候用对话节点」
 *    「下游怎么引用上游产出」「失败了怎么办」「什么情况根本不该建成工作流」。
 *
 * 所以本模块**不复制** `nodeTypes` 已给的参数说明，只补方法论 + 一份
 * **Node-RED 原生节点**的说明目录（那些不在 `workflow.nodeTypes` 里）。
 *
 * ## Node-RED 原生节点的说明从哪来（实测结论）
 *
 * 实测 `node-red/packages/node_modules/@node-red/nodes/`：
 *
 *  - 主 HTML（`core/**\/*.html`）里有 `defaults: {}`，但**混着 validator 的 JS**
 *    （36 个节点里 11 个带 `function(v, opt)`），正则解析不可靠 → **不做**；
 *  - `locales/en-US/**\/*.html` 里有 `<script type="text/html" data-help-name="X">`
 *    的**纯 HTML 帮助**：36 个文件、49 个节点，内容是给人看的完整说明
 *    （输出属性、cron 陷阱、注意事项）→ **这就是我们的来源**。
 *
 * 也就是**方案 A（复用 Node-RED 自己的帮助）**用于节点说明，
 * **方案 B（Mcode 自己写）**只用于「怎么搭」的方法论 —— 即方案 C 的混合。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/* ───────────────────────── Node-RED 帮助目录 ───────────────────────── */

export interface NodeRedHelpEntry {
  /** `data-help-name`，例如 `inject` / `http in`。 */
  name: string;
  /** 相对 `locales/en-US` 的源文件路径（证据可追溯）。 */
  source: string;
  /** 帮助正文（HTML 原文，未改写）。 */
  html: string;
}

export interface NodeRedHelpIndex {
  /** 节点名 → 条目。 */
  byName: ReadonlyMap<string, NodeRedHelpEntry>;
  /** 解析时跳过/失败的文件（**显式列出**，不静默跳过）。 */
  problems: readonly { file: string; reason: string }[];
  /** 扫描根目录（证据用）。 */
  root: string;
}

/**
 * 扫描 Node-RED 的 en-US 帮助目录。
 *
 * 判据来自实测：帮助在 `<script type="text/html" data-help-name="X">…</script>`。
 * 一个文件可能有多个帮助块（例如 `20-inject.html` 只有一个）。
 *
 * **读不到就返回空索引 + problems**，绝不编造节点说明。
 */
export function readNodeRedHelp(nodeRedRoot: string): NodeRedHelpIndex {
  const byName = new Map<string, NodeRedHelpEntry>();
  const problems: { file: string; reason: string }[] = [];
  const localeRoot = join(nodeRedRoot, "packages", "node_modules", "@node-red", "nodes", "locales", "en-US");
  let files: string[] = [];
  try {
    files = walkHtml(localeRoot);
  } catch (error) {
    return {
      byName,
      problems: [{ file: localeRoot, reason: `无法读取 Node-RED 帮助目录：${error instanceof Error ? error.message : String(error)}` }],
      root: localeRoot,
    };
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      problems.push({ file, reason: `读取失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const blocks = [...text.matchAll(/<script[^>]*type="text\/html"[^>]*data-help-name="([^"]+)"[^>]*>([\s\S]*?)<\/script>/gi)];
    if (blocks.length === 0) {
      problems.push({ file, reason: "没有 data-help-name 帮助块" });
      continue;
    }
    for (const block of blocks) {
      const name = block[1]!.trim();
      const html = block[2]!.trim();
      if (html === "") {
        problems.push({ file, reason: `节点 ${name} 的帮助块为空` });
        continue;
      }
      byName.set(name, { name, source: file.slice(localeRoot.length + 1).replaceAll("\\", "/"), html });
    }
  }
  return { byName, problems, root: localeRoot };
}

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) out.push(...walkHtml(abs));
    else if (name.toLowerCase().endsWith(".html")) out.push(abs);
  }
  return out;
}

/** 帮助正文 → 纯文本（给模型读；保留段落与列表的可读性）。 */
export function helpHtmlToText(html: string): string {
  return html
    .replace(/<\/?(?:p|h[1-6]|div|dl|dt|dd|ul|ol|li|table|thead|tbody|tr|th|td)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 全部可用节点名（按字母序）。 */
export function nodeRedHelpNames(index: NodeRedHelpIndex): string[] {
  return [...index.byName.keys()].sort();
}

/* ───────────────────────── Mcode 搭建指南 ───────────────────────── */

export type WorkflowGuideTopic = "design" | "nodes" | "debugging";

export interface WorkflowGuideResult {
  ok: boolean;
  topic: string;
  text: string;
  chars: number;
  /** `nodes` 主题附带的节点名清单（模型据此再取单个节点）。 */
  nodes?: string[];
  reason?: string;
}

/**
 * 【T51】工作流方法论。**这是 Mcode 自己写的那一半**（方案 B），与
 * `workflow.nodeTypes` 的参数清单互补，不重复。
 */
const WORKFLOW_GUIDE_DESIGN = `# 怎么搭一条 Mcode 工作流

## 先问：这件事该不该做成工作流

工作流的价值是**可重复、可无人值守、步骤之间的产出能传递**。以下情况**不要**建工作流：

- 一次性任务 —— 直接在对话里说。
- 需要人在每一步看着改 —— 用普通对话，或工作流里放 \`mcode.conversation\` 节点。
- 只是把一句话拆成两句 —— 拆开反而更难维护。

## 节点怎么选（Mcode 内置类型，参数见 workflow.nodeTypes）

| 你要做的事 | 用哪个 | 为什么 |
|---|---|---|
| 这一步是自足的，只要上游产出就能做完 | \`mcode.agent\`（子 agent） | 干净、可重复、分享给别人照样跑 |
| 这一步要用**之前聊过的东西** | \`mcode.conversation\` | 子 agent 的会话里没有你们的聊天记录 |
| 跑一条命令 / 脚本 | \`mcode.command\` | 有退出码与 stdout，可判定成败 |
| 岔路口按结果分流 | \`mcode.branch\`（分支） | 选项是**边**，不是填在节点上的表 |
| 直接复用一张 Node-RED 流 | \`mcode.node-red\` | 见下 |

**最常见的错误**：把长流程里每一步都设成 \`mcode.conversation\`。它的上下文**只增不减** ——
这一步读过的每个文件、每次工具返回都永久留在那个对话里，后面每一轮都背着。自足的步骤用子 agent。

## 数据怎么在步骤之间流动

- **引用上游产出**用「插入变量」：\`{{某步.output}}\`（结果文本）、\`.status\` / \`.error\` / \`.title\`、
  \`{{某步.params.某参数}}\`（它的配置）、\`{{某步.变量名}}\`（它声明过的产出变量）。
- 节点可以写 **id**，也可以写**标题**；但只能引用**这一步的上游节点**（整条上游链，不只直接上游）。
- 只有在上游的「产出变量」里**声明过**的名字才取得到 —— 没声明就取不到，不会静默给空。

## 失败与重试

- 节点失败时整条链停在那里（不会带着半成品往下跑）。
- 需要重试的步骤，把重试放在**节点自己的指令**里（子 agent 可以自己再试一次），
  不要用工作流层面去猜「失败了要不要重跑」—— 那会把已经成功的步骤再跑一遍。
- 想「跑一步看一眼再决定」，用 \`mcode.conversation\` 的「运行前先问我」，
  或 \`mcode.branch\` 的「弹出窗口，我来选」。

## 验收：搭完先自己跑一遍

1. 用 \`app_workflow_run\` 真跑一次（不要只看图搭得对不对）；
2. 看每一步的**状态与输出**，特别是有没有「跑了但结果是空的」；
3. 失败就改那一步的指令，别整个重搭；
4. 确认无误再 \`app_workflow_publish\`。

## 不要做的事

- **不要**在一个节点里塞整条流程（一个超长指令 = 没法定位是哪一步坏的）。
- **不要**靠「重跑整条」绕过某一步的失败。
- **不要**在没有跑过的情况下发布。`;

const WORKFLOW_GUIDE_DEBUGGING = `# 工作流跑不通时怎么查

## 按顺序看

1. **哪一步停的** —— 看运行记录里最后一条状态；失败的那一步就是起点，别从头猜。
2. **它的输入是什么** —— 引用上游写错了（引用了非上游、或引用没声明过的产出变量）是最常见的原因。
   症状通常是「这一步收到的内容不对/为空」，而不是报错。
3. **它真的跑了吗** —— 状态是「跑了但空」和「根本没跑」要分开：
   前者去看那一步的指令，后者去看它的上游是不是没产出。
4. **命令节点** —— 看退出码与 stderr，退出码非零就是失败，不要只看有没有输出。

## 常见症状 → 原因

| 症状 | 多半是 |
|---|---|
| 某一步收到的内容为空 | 引用了不存在的产出变量，或引用了非上游节点 |
| 整条卡住不动 | 那一步在等「运行前先问我」的答复 |
| 同一步重复跑了两遍 | 重试逻辑写在了工作流层面，而不是节点内部 |
| 改了图但行为没变 | 没有重新发布（\`app_workflow_publish\`），跑的还是旧版 |

## 修改的正确顺序

改 → 跑一遍 → 看这一步的结果 → 再改。**一次只改一步**，否则改坏了不知道是哪一处。`;

/**
 * 【T51】取工作流搭建指南。
 *
 * `topic` 三类：
 *  - `design`（默认）：怎么组织一条工作流；
 *  - `debugging`：跑不通时怎么查；
 *  - `nodes`：**Node-RED 原生节点**的说明目录（不含参数 —— 参数从 HTML 的
 *    \`defaults\` 取不可靠，见文件头；也**不**重复 \`workflow.nodeTypes\` 的 Mcode 节点）。
 *
 * `node` 给了就返回那一个节点的帮助正文（只对 `nodes` 主题有意义）。
 */
export function workflowGuide(
  index: NodeRedHelpIndex,
  args: { topic?: string; node?: string },
): WorkflowGuideResult {
  const topic = (args.topic ?? "design").trim().toLowerCase();
  if (args.node !== undefined && args.node.trim() !== "") {
    const name = args.node.trim();
    const entry = index.byName.get(name) ?? index.byName.get(name.toLowerCase());
    if (!entry) {
      const names = nodeRedHelpNames(index);
      return {
        ok: false, topic: "node", text: "", chars: 0,
        reason: `没有这个 Node-RED 原生节点的帮助：${name}。` +
          `可用的 ${names.length} 个见 topic:"nodes"。` +
          `注意：Mcode 自己的节点类型（mcode.*）不在这个目录里，它们的参数用 app_api_call("workflow.nodeTypes") 查。`,
        nodes: names,
      };
    }
    const text = [
      `# Node-RED 节点：${entry.name}`,
      `来源：node-red/packages/node_modules/@node-red/nodes/locales/en-US/${entry.source}`,
      "",
      helpHtmlToText(entry.html),
    ].join("\n");
    return { ok: true, topic: "node", text, chars: text.length };
  }

  if (topic === "nodes") {
    const names = nodeRedHelpNames(index);
    if (names.length === 0) {
      return {
        ok: false, topic, text: "", chars: 0,
        reason: `读不到 Node-RED 的帮助目录（${index.root}）。` +
          (index.problems.length > 0 ? `问题：${index.problems.slice(0, 3).map((p) => `${p.file}: ${p.reason}`).join("; ")}` : ""),
      };
    }
    const lines = [
      "# Node-RED 原生节点（可取的帮助）",
      "",
      `共 ${names.length} 个，来源 \`locales/en-US\` 里的 \`data-help-name\` 帮助块（原文，未改写）。`,
      "取某一个的完整说明：`workflow_guide({topic:\"nodes\", node:\"<名字>\"})`。",
      "",
      names.join(" · "),
      "",
      "⚠️ 这些是 **Node-RED 原生节点**。Mcode 自己的节点类型（`mcode.agent` / `mcode.conversation` /",
      "`mcode.branch` …）参数与用法用 `app_api_call(\"workflow.nodeTypes\")` 查 —— 那里每个参数都带 help。",
    ];
    const text = lines.join("\n");
    return { ok: true, topic, text, chars: text.length, nodes: names };
  }

  if (topic === "debugging") {
    return { ok: true, topic, text: WORKFLOW_GUIDE_DEBUGGING, chars: WORKFLOW_GUIDE_DEBUGGING.length };
  }

  if (topic === "design") {
    return { ok: true, topic, text: WORKFLOW_GUIDE_DESIGN, chars: WORKFLOW_GUIDE_DESIGN.length };
  }

  return {
    ok: false, topic, text: "", chars: 0,
    reason: `没有这个工作流指南主题：${topic}。可用：design（怎么搭）/ debugging（怎么查）/ nodes（Node-RED 原生节点说明）。`,
  };
}

/** 证据用：这个索引扫的是哪个目录。 */
export function nodeRedHelpRoot(index: NodeRedHelpIndex): string {
  return index.root;
}

/** 证据用：某个帮助条目的源文件名。 */
export function nodeRedHelpSourceOf(index: NodeRedHelpIndex, name: string): string | null {
  const entry = index.byName.get(name);
  return entry ? basename(entry.source) : null;
}
