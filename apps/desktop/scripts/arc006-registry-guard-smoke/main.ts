/**
 * ARC-006 MERGE-1: registry 的公开数据目录入口必须先核验引擎/项目身份再落盘。
 * 只在 MCODE_SMOKE_DATA_ROOT 指向的隔离 mktemp 目录读写，不启动引擎、不读用户数据。
 *
 * 原失败输入：
 *  1. dataDirOf("unregistered") 会无条件 mkdir，凭空建立未注册引擎目录；
 *  2. projectDataDirOf("node-red"," bad") 先 mkdir 单例引擎目录，之后才拒绝坏 ID。
 * 变异核对：撤掉两个前置校验时，这两条真正出现 FAIL。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
import { safeProjectDirName } from "@main/workflowEngines/projectFlowDir.js";

let total = 0;
let failures = 0;
function check(label: string, good: boolean, details?: unknown): void {
  total++;
  if (good) console.log("  ok   " + label);
  else {
    failures++;
    console.log("  FAIL " + label + " " + JSON.stringify(details ?? null));
  }
}
function mustThrow(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const base = dataRoot();
if (!base || !base.includes("mcode-registry-guard")) {
  throw new Error("必须明确使用测试隔离数据根，拒绝指向真实用户目录");
}
const engineRoot = join(base, "workflow-engines", "node-red");
const wrongEngineDir = join(base, "workflow-engines", "unregistered");
const escapedEngineDir = join(base, "rogue-engine");
const registry = new ProductionWorkflowEngineRegistry();

check("前置：尚未创建引擎根目录", !existsSync(engineRoot));
check("未知引擎 dataDirOf 必须抛错", mustThrow(() => registry.dataDirOf("unregistered")));
check("未知引擎不应建出目录", !existsSync(wrongEngineDir));
check("未知引擎 projectDataDirOf 必须抛错", mustThrow(() => registry.projectDataDirOf("unregistered", "project-a")));
check("未知引擎的项目目录同样不应创建", !existsSync(wrongEngineDir));
check("带 ../ 的引擎 ID 必须先于 join 和 mkdir 被拒绝", mustThrow(() => registry.dataDirOf("../rogue-engine")));
check("路径穿越引擎 ID 不得在引擎目录之外落盘", !existsSync(escapedEngineDir));

check("非法项目 ID（首尾空白）必须拒绝", mustThrow(() => registry.projectDataDirOf("node-red", " bad")));
check("非法项目 ID 在拒绝前不应创建单例根目录", !existsSync(engineRoot));
check("非法项目 ID（路径穿越）仍拒绝", mustThrow(() => registry.projectDataDirOf("node-red", "../escape")));
check("路径穿越拒绝不应留下任何引擎根目录", !existsSync(engineRoot));

const defDir = registry.projectDataDirOf("node-red", "default");
check("显式默认项目仍落在旧单例目录", defDir === resolve(engineRoot), { defDir, engineRoot });
check("合法默认项目会创建自己的目录", existsSync(engineRoot));

const implicitDefault = registry.dataDirOf("node-red");
check("dataDirOf 与默认项目完全同一目录", implicitDefault === defDir);
const a = registry.projectDataDirOf("node-red", "project-a");
const b = registry.projectDataDirOf("node-red", "project-b");
check("两个合法项目目录互不相同", a !== b && a !== defDir && b !== defDir);
check("两个合法项目各自的目录都已创建", existsSync(a) && existsSync(b));
check("合法项目路径始终落在引擎根之下", a.startsWith(engineRoot + sep) && b.startsWith(engineRoot + sep));
check("相同 projectId 可稳定解析到同一路径", registry.projectDataDirOf("node-red", "project-a") === a);

// 真实 sha256 32-bit collision：首40字符相同、尾部不同的两个合法 ID。
const collidingId1 = "p".repeat(40) + "-195";
const collidingId2 = "p".repeat(40) + "-92702";
const collidingDir = registry.projectDataDirOf("node-red", collidingId1);
const sentinelCollision = join(collidingDir, "flow-user-data.json");
writeFileSync(sentinelCollision, "belongs-to-first-project", "utf8");
check("★ 32-bit hash 碰撞第二项目不得接管第一项目凭据目录",
  mustThrow(() => registry.projectDataDirOf("node-red", collidingId2)));
check("★ 32-bit hash 碰撞绝不改动第一个项目字节",
  readFileSync(sentinelCollision, "utf8") === "belongs-to-first-project");
check("★ 已绑定身份的原项目仍可稳定访问",
  registry.projectDataDirOf("node-red", collidingId1) === collidingDir);

// 历史已经有数据但没有 projectId 归属标记；不知道原项目身份就不可静默接管。
// 这是兼容受控迁移的闸门，不得删除该目录/旧内容来冒充首次创建。
const unknownId = "unmarked-project";
const legacyUnknown = join(engineRoot, "projects", safeProjectDirName(unknownId));
mkdirSync(legacyUnknown, {recursive:true});
writeFileSync(join(legacyUnknown, "flows.json"), "legacy-unknown-owner", "utf8");
check("★ 无身份标记且非空旧目录必须拒绝自动接管",
  mustThrow(() => registry.projectDataDirOf("node-red", unknownId)));
check("★ 拒绝接管不能破坏历史 flows.json",
  readFileSync(join(legacyUnknown, "flows.json"), "utf8") === "legacy-unknown-owner");
const corruptDir = registry.projectDataDirOf("node-red", "project-corrupt-marker");
const identityFile = join(corruptDir, ".mcode-project-id.json");
const validBytes = readFileSync(identityFile, "utf8");
writeFileSync(identityFile, "{malformed", "utf8");
check("★ 项目身份标记坏 JSON 不能被静默修复或绕过",
  mustThrow(() => registry.projectDataDirOf("node-red", "project-corrupt-marker")));
check("★ 身份标记坏档应保留原字节供人工核查",
  readFileSync(identityFile, "utf8") === "{malformed");
writeFileSync(identityFile, validBytes, "utf8");
check("★ 人工恢复原身份标记后同 ID 可重新访问",
  registry.projectDataDirOf("node-red", "project-corrupt-marker") === corruptDir);
const emptyLegacyId = "empty-unmarked-project";
const emptyLegacyDir = join(engineRoot, "projects", safeProjectDirName(emptyLegacyId));
mkdirSync(emptyLegacyDir, {recursive:true});
check("★ 空的旧目录可受控初始化身份标记，不改变既有目录名",
  registry.projectDataDirOf("node-red", emptyLegacyId) === emptyLegacyDir
  && existsSync(join(emptyLegacyDir, ".mcode-project-id.json")));


/* ARC-006 MERGE-1：真实目录重解析点（Windows junction / POSIX symlink）。
 * 每条只替换当前 smoke 的私有目录，目标也在隔离 DATA 内，不接触任何真实用户资料。
 * rmdir(junction) / unlink(symlink) 专门拆链，绝不递归清理外部目标。 */
function checkLinkedDirectory(label: string, original: string, external: string, action: () => unknown): void {
  mkdirSync(external, { recursive: true });
  const sentinel = join(external, "sentinel.txt");
  writeFileSync(sentinel, "unmodified", "utf8");
  const backup = original + ".mcode-test-original";
  renameSync(original, backup);
  let linked = false;
  try {
    try {
      symlinkSync(external, original, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (err) {
      // 不把当前 OS 权限不足当 PASS：明确计数外 SKIP，仍复原原目录。
      console.log("  SKIP " + label + "（系统无法创建目录链接：" + (err as Error).message + "）");
      return;
    }
    check(label + "：确有 OS 目录链接（防夹具空过）", lstatSync(original).isSymbolicLink());
    check(label + "：生产数据目录访问必须显式拒绝", mustThrow(action));
    check(label + "：重定向目标字节未变", readFileSync(sentinel, "utf8") === "unmodified");
    check(label + "：不能在目标中创建新文件或目录",
      JSON.stringify(readdirSync(external).sort()) === JSON.stringify(["sentinel.txt"]));
  } finally {
    if (linked) {
      if (process.platform === "win32") rmdirSync(original);
      else unlinkSync(original);
    }
    renameSync(backup, original);
  }
}
checkLinkedDirectory("项目叶子目录 junction", a, join(base, "outside-project-leaf"),
  () => registry.projectDataDirOf("node-red", "project-a"));
checkLinkedDirectory("projects 容器目录 junction", join(engineRoot, "projects"), join(base, "outside-projects-container"),
  () => registry.projectDataDirOf("node-red", "project-c"));
checkLinkedDirectory("引擎目录 junction 与缓存", engineRoot, join(base, "outside-engine-root"),
  () => registry.dataDirOf("node-red"));
checkLinkedDirectory("workflow-engines 父目录 junction", join(base, "workflow-engines"), join(base, "outside-workflow-engines"),
  () => registry.projectDataDirOf("node-red", "project-d"));

console.log("\narc006-registry-guard-smoke:" + (total - failures) + "/" + total + " 通过");
if (failures > 0) process.exitCode = 1;
