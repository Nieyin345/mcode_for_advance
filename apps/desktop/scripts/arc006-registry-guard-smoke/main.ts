/**
 * ARC-006 MERGE-1: registry 的公开数据目录入口必须先核验引擎/项目身份再落盘。
 * 只在 MCODE_SMOKE_DATA_ROOT 指向的隔离 mktemp 目录读写，不启动引擎、不读用户数据。
 *
 * 原失败输入：
 *  1. dataDirOf("unregistered") 会无条件 mkdir，凭空建立未注册引擎目录；
 *  2. projectDataDirOf("node-red"," bad") 先 mkdir 单例引擎目录，之后才拒绝坏 ID。
 * 变异核对：撤掉两个前置校验时，这两条真正出现 FAIL。
 */
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";

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

console.log("\narc006-registry-guard-smoke:" + (total - failures) + "/" + total + " 通过");
if (failures > 0) process.exitCode = 1;
