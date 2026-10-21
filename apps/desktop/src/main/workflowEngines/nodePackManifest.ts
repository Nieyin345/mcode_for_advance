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
function localeText(type: string, language: "en-US" | "zh-CN"): string {
  const en: Record<string, string> = {
    name: "Name", instruction: "Instruction", capability: "Capability",
    outputVar: "Output variable", sessionId: "Mcode session ID", decider: "Decider",
    note: "Note", triggerKind: "Trigger kind", task: "Event type",
    cron: "Cron", moduleId: "Module ID", contributionId: "Contribution ID",
    path: "Path", projectPath: "Authorized project path", enginePath: "Engine path",
    engineMethod: "Method", engineBody: "Body",
  };
  const zh: Record<string, string> = {
    name: "名称", instruction: "指令", capability: "权限能力", outputVar: "输出变量",
    sessionId: "Mcode 会话 ID", decider: "决策者", note: "备注", triggerKind: "触发类型",
    task: "事件类型", cron: "定时表达式", moduleId: "模块 ID",
    contributionId: "能力 ID", path: "路径", projectPath: "已授权项目路径",
    enginePath: "引擎路径", engineMethod: "请求方法", engineBody: "请求正文",
  };
  return JSON.stringify({ mcode: { label: language === "en-US" ? en : zh }, type }, null, 2) + "\n";
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
