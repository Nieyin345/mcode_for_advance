/**
 * T42 — managed Node-RED node-pack payload and integrity manifest.
 * Every startup verifies all fourteen executable/editor files plus locales.
 * Updates are atomic per file, backed up on replacement; failure blocks spawn.
 * Never touches flows.json, credentials, or user-owned <userDir>/nodes.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCODE_NODE_PACK_TYPES, conversationNodeHtml, branchNodeHtml,
  triggerNodeHtml, moduleCapabilityNodeHtml, nodeRedCallNodeHtml,
} from "./mcodeNodeTypes.js";
import { agentNodeHtml } from "./mcodeNodePack.js";
import { MCODE_NODE_PACK_BUNDLE } from "./nodePackBundle.generated.js";

export const MCODE_NODE_PACK_DIR = "mcode-node-pack";
export const MCODE_NODE_PACK_MANIFEST = "node-pack.manifest.json";
export const MCODE_NODE_PACK_SCHEMA = "mcode.workflow-engine.node-pack/v1";
export const MCODE_NODE_PACK_INSTALL_VERSION = 2;

const htmlByType: Record<string, () => string> = {
  "mcode-agent": agentNodeHtml,
  "mcode-conversation": conversationNodeHtml,
  "mcode-branch": branchNodeHtml,
  "mcode-trigger": triggerNodeHtml,
  "mcode-module-capability": moduleCapabilityNodeHtml,
  "mcode-node-red-call": nodeRedCallNodeHtml,
};
function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertIndependentFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("Managed node-pack file must be an independent regular file: " + path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
function assertDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Managed node-pack directory is not safe: " + path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Managed node-pack directory changed: " + path);
  }
}
function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp-" + randomUUID();
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
/** Per-node text is resolved by Node-RED's own editor i18n, not by Mcode React. */
function localeText(type: string, language: "en-US" | "zh-CN"): string {
  const labels = {
    "en-US": {
      name: "Name", instruction: "Instruction", capability: "Capability",
      outputVar: "Output variable", sessionId: "Mcode session ID", decider: "Decision by",
      note: "Note", triggerKind: "Trigger kind", task: "Task",
      cron: "Cron expression", moduleId: "Module ID", contributionId: "Contribution ID",
      path: "Path", projectPath: "Authorized project path", enginePath: "Engine path",
      engineMethod: "HTTP method", engineBody: "Request body",
    },
    "zh-CN": {
      name: "名称", instruction: "指令", capability: "权限能力",
      outputVar: "输出变量", sessionId: "Mcode 会话 ID", decider: "决策者",
      note: "备注", triggerKind: "触发类型", task: "任务",
      cron: "定时表达式", moduleId: "模块 ID", contributionId: "能力 ID",
      path: "路径", projectPath: "已授权项目路径", enginePath: "引擎路径",
      engineMethod: "请求方法", engineBody: "请求正文",
    },
  };
  const placeholders = {
    "en-US": {
      instruction: "Describe what to do", outputVar: "Output variable name",
      sessionId: "Existing visible Mcode session ID", note: "Describe the decision",
      task: "Event task", cron: "Cron expression", moduleId: "Module ID",
      contributionId: "Contribution ID", path: "Resource path",
      projectPath: "Authorized project path", enginePath: "API path (starts with /)",
      engineBody: "Request body",
    },
    "zh-CN": {
      instruction: "描述要执行的指令", outputVar: "输出变量名称",
      sessionId: "现有可见的 Mcode 会话 ID", note: "描述分支决策",
      task: "事件任务", cron: "Cron 定时表达式", moduleId: "模块 ID",
      contributionId: "能力 ID", path: "资源路径",
      projectPath: "已授权的项目路径", enginePath: "API 路径（以 / 开头）",
      engineBody: "请求正文",
    },
  };
  const tooltips = {
    "en-US": {
      name: "Optional label shown on the canvas", instruction: "Prompt to send to the selected session",
      capability: "Requested capability; this is not a permission grant",
      outputVar: "Optional downstream output binding", sessionId: "Host-verified visible chat session ID",
      decider: "Host user dialog or model decision", note: "Context for the branch decision",
      triggerKind: "Host event subscription kind", task: "Task for the event source",
      cron: "Scheduling expression (supported sources depend on Host)",
      moduleId: "Installed module identifier", contributionId: "Module capability identifier",
      path: "Resource path", projectPath: "Project path authorized by Host",
      enginePath: "Host-scoped Node-RED API endpoint", engineMethod: "Request method; mutating calls are restricted",
      engineBody: "Request body sent through Host",
    },
    "zh-CN": {
      name: "在画布上显示的可选名称", instruction: "发送到指定会话的提示词",
      capability: "请求的能力，不代表已获授权", outputVar: "可选的下游输出变量名",
      sessionId: "由宿主验证的可见聊天会话 ID",
      decider: "由宿主弹窗用户决策或模型决策", note: "分支决策的上下文",
      triggerKind: "宿主订阅的事件类型", task: "事件源任务",
      cron: "定时表达式（是否支持由宿主决定）", moduleId: "已安装模块的标识符",
      contributionId: "模块能力标识符", path: "资源路径",
      projectPath: "宿主授予权限的项目路径", enginePath: "仅限宿主管控的 Node-RED API",
      engineMethod: "请求方法；修改操作受限制", engineBody: "经宿主发送的请求正文",
    },
  };
  const options = {
    "en-US": {
      read: "Read", write: "Write", user: "User", model: "Model",
      manual: "Manual", schedule: "Schedule", file: "File", event: "Event",
      GET: "GET (read)", POST: "POST (create/deploy)", PUT: "PUT (replace)",
      PATCH: "PATCH (update)", DELETE: "DELETE (remove)",
    },
    "zh-CN": {
      read: "读取", write: "写入", user: "用户", model: "模型",
      manual: "手动", schedule: "定时", file: "文件", event: "事件",
      GET: "GET（读取）", POST: "POST（创建/部署）", PUT: "PUT（替换）",
      PATCH: "PATCH（更新）", DELETE: "DELETE（删除）",
    },
  };
  // Explain actual Host port semantics; labels do not grant capability or bypass approvals.
  const help: Record<"en-US" | "zh-CN", Record<string, { input: string; output: string; approval: string }>> = {
    "en-US": {
      "mcode-agent": {
        input: "Input: msg.payload is combined with the instruction and sent to the selected visible Mcode session.",
        output: "Output: one msg.payload with { text, artifacts }; msg.mcode carries the run ID.",
        approval: "Approval: Host session permissions still apply. Tool actions may require user approval; selecting write is not authorization.",
      },
      "mcode-conversation": {
        input: "Input: msg.payload and the instruction are sent to the selected visible Mcode chat session.",
        output: "Output: one msg.payload with { text, artifacts }; msg.mcode includes the run ID.",
        approval: "Approval: native model tool actions can require Mcode user approval; the capability field does not grant permission.",
      },
      "mcode-branch": {
        input: "Input: original msg.payload is preserved; decider selects a Host-backed user or model decision.",
        output: "Output: original msg.payload is routed to one configured output; index is zero-based.",
        approval: "Approval: user choice requires a Host dialog; cancellation stops routing. Model decisions may request tool approval.",
      },
      "mcode-trigger": {
        input: "Input: no upstream msg.payload; the Host subscribes to the configured event source.",
        output: "Output: the Host event's msg.payload is emitted on one output.",
        approval: "Approval: subscriptions require Host authorization; the node does not itself open an approval dialog.",
      },
      "mcode-module-capability": {
        input: "Input: msg.payload and module/contribution IDs, path and authorized project path go to the Host module.",
        output: "Output: Host module result becomes msg.payload with { text, artifacts }.",
        approval: "Approval: Mcode Host validates module permission grants; missing or denied grants block execution.",
      },
      "mcode-node-red-call": {
        input: "Input: msg.payload accompanies the configured Node-RED API path, method and body.",
        output: "Output: response becomes msg.payload with { text, artifacts }; HTTP status is in msg.mcode.engineStatus.",
        approval: "Approval: GET is Host scoped; POST /flows requires user approval and deployment ownership checks. Other mutations are rejected.",
      },
    },
    "zh-CN": {
      "mcode-agent": {
        input: "输入：msg.payload 与指令合并，发送到指定的可见 Mcode 会话。",
        output: "输出：msg.payload 为 { text, artifacts }，msg.mcode 包含运行 ID。",
        approval: "审批：仍需遵守宿主会话权限。工具操作可能要求用户审批；选择写入不等于授权。",
      },
      "mcode-conversation": {
        input: "输入：msg.payload 与指令发送到指定的可见 Mcode 聊天会话。",
        output: "输出：msg.payload 为 { text, artifacts }，msg.mcode 记录运行 ID。",
        approval: "审批：模型工具操作可能需要 Mcode 用户批准；能力字段不能自行授予权限。",
      },
      "mcode-branch": {
        input: "输入：保留原始 msg.payload，由宿主根据用户或模型决定分支。",
        output: "输出：原始 msg.payload 只发送到一个已连接输出端口（从 0 开始）。",
        approval: "审批：用户分支需要宿主弹窗确认；取消即停止路由。模型分支的工具操作仍可能需要审批。",
      },
      "mcode-trigger": {
        input: "输入：没有上游 msg.payload，由宿主订阅指定事件源。",
        output: "输出：宿主事件的 msg.payload 从单个出口发出。",
        approval: "审批：订阅须满足宿主授权；节点本身不弹出审批窗口。",
      },
      "mcode-module-capability": {
        input: "输入：msg.payload 与模块 ID、能力 ID、路径及授权项目路径交给宿主模块。",
        output: "输出：宿主模块的结果作为 msg.payload（{ text, artifacts }）。",
        approval: "审批：Mcode 宿主核验模块能力授权；缺失或被拒绝的授权会阻止执行。",
      },
      "mcode-node-red-call": {
        input: "输入：msg.payload 与 Node-RED API 路径、方法和正文一起交给宿主。",
        output: "输出：响应写入 msg.payload（{ text, artifacts }），HTTP 状态在 msg.mcode.engineStatus。",
        approval: "审批：GET 受宿主管控；POST /flows 须经用户审批和部署归属检查；其他修改操作拒绝。",
      },
    },
  };
  const localizedHelp = help[language][type];
  if (!localizedHelp) throw Error("Missing Node-RED node locale: " + language + "/" + type);
  return JSON.stringify({ mcode: {
    label: labels[language], placeholder: placeholders[language],
    tooltip: tooltips[language], option: options[language], help: localizedHelp,
  }, type }, null, 2) + "\n";
}

export function expectedNodePackFiles(): Record<string, string> {
  // A valid Node-RED module is required for the upstream loader to register
  // locales. Plain userDir/nodes JS pairs are classified as core "node-red"
  // and loadNodeLocales() explicitly skips their language catalogs.
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "mcode-node-pack", version: "2.0.0", private: true,
      "node-red": { nodes: Object.fromEntries(MCODE_NODE_PACK_TYPES.map((type) => [type, type + ".js"])) },
    }, null, 2) + "\n",
    "mcode-runtime.cjs": MCODE_NODE_PACK_BUNDLE,
  };
  for (const type of MCODE_NODE_PACK_TYPES) {
    files[type + ".js"] = '"use strict";\nmodule.exports = function(RED) {\n'
      + '  require("./mcode-runtime.cjs").registerType(RED, ' + JSON.stringify(type) + ');\n};\n';
    files[type + ".html"] = htmlByType[type]!();
    for (const lang of ["en-US", "zh-CN"] as const)
      files["locales/" + lang + "/" + type + ".json"] = localeText(type, lang);
  }
  return files;
}
export interface NodePackEnsureResult {
  ok: boolean;
  action: "unchanged" | "written" | "restored" | null;
  reason: string | null;
  changed: number;
  bundleBytes: number;
}
/** dataDir already belongs to the Host and has passed registry's directory guard. */
export function ensureNodePack(dataDir: string, engineId: string): NodePackEnsureResult {
  const files = expectedNodePackFiles();
  const bundleBytes = Buffer.byteLength(MCODE_NODE_PACK_BUNDLE);
  const fail = (reason: string): NodePackEnsureResult =>
    ({ ok: false, action: null, reason, changed: 0, bundleBytes });
  try {
    const packDir = join(dataDir, MCODE_NODE_PACK_DIR);
    assertDirectory(packDir);
    const localeDir = join(packDir, "locales");
    assertDirectory(localeDir);
    for (const lang of ["en-US", "zh-CN"]) assertDirectory(join(localeDir, lang));
    const manifestPath = join(dataDir, MCODE_NODE_PACK_MANIFEST);
    const expected = {
      schema: MCODE_NODE_PACK_SCHEMA, engineId,
      pack: { version: MCODE_NODE_PACK_INSTALL_VERSION, source: "mcode-esbuild:nodePackChildRuntime" },
      files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])),
    };
    const manifestText = JSON.stringify(expected, null, 2) + "\n";
    // Manifest is itself an independent file; a symlink/hardlink is never
    // accepted, even when the content happens to match current source.
    const currentManifest = assertIndependentFile(manifestPath)
      ? readFileSync(manifestPath, "utf8") : null;
    let changed = 0;
    for (const [name, content] of Object.entries(files)) {
      const path = join(packDir, ...name.split("/"));
      const exists = assertIndependentFile(path);
      const actual = exists ? readFileSync(path) : null;
      if (actual !== null && hash(actual) === hash(content)) continue;
      if (actual !== null) {
        copyFileSync(path, path + ".bak-" + randomUUID(), constants.COPYFILE_EXCL);
      }
      atomicWrite(path, content);
      changed++;
    }
    if (currentManifest !== manifestText) atomicWrite(manifestPath, manifestText);
    return { ok: true, action: changed ? currentManifest ? "restored" : "written" : currentManifest === manifestText ? "unchanged" : "restored", reason: null, changed, bundleBytes };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
