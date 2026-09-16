/**
 * 代理档案的落盘 —— `<数据根>/workflows/agents/<id>.json`。
 *
 * ## 为什么**一份档案一个文件**
 *
 * 和钩子(`hooks.json` 一份文件装全部)相反。差别在**内容是谁的**:
 *
 *  - 钩子是一张列表,用户从头到尾都在设置页里改它,一份文件最好读写;
 *  - 档案是**内容** —— 用户会想把它拷给同事、塞进一个仓库、让 AI 直接写一份新的。
 *    一份文件装全部的话,分享一份就要对方手工合并一遍 JSON 数组。
 *
 * 这和 `<数据根>/workflows/node-types/` 是同一个判断。
 *
 * ## 格式规则不在这里
 *
 * "什么算合法"在 `@contracts/agentProfile` 里(纯函数),理由同钩子:这个文件是用户直接
 * 改的,那是一条对外承诺;而且纯函数才喂得进无头脚本。这一层只负责文件系统。
 *
 * ## 读的时候**坏文件不静默丢弃**
 *
 * 一个格式错的文件如果被悄悄跳过,用户看到的现象是"我存的档案不见了",没有任何线索。
 * 所以 `problems` 一起返回,界面原样显示(同 `loadNodeTypes`)。
 *
 * ⚠️ 本文件**故意不 import `@main/workflows/seed.js` 的 `workflowsRoot()`** ——
 * `ipc/orchestration.ts` 立了一条硬规矩:`main/orchestration/` 与 `main/workflows/`
 * 互不 import。目录名在这里复述一遍是那条规矩的代价(见 `nodeTypes.ts` 同款注释)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  parseAgentProfile,
  validateAgentProfile,
  type AgentProfile,
  type AgentProfileCatalog,
} from "@contracts/agentProfile";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";

/** 档案目录。用户可见、可手改、可拷贝。 */
export function agentProfilesDir(): string {
  return path.join(dataRoot(), "workflows", "agents");
}

const FILE_SUFFIX = ".json";

/** 读全部档案。**目录不存在、单个文件坏了都不抛** —— 档案是附加能力,它坏了不该让
 *  工作流页打不开(同 `loadNodeTypes` 对坏清单的处理)。 */
export function readAgentProfiles(): AgentProfileCatalog {
  const dir = agentProfilesDir();
  const out: AgentProfileCatalog = { profiles: [], problems: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录不存在是**正常情况**(一份档案都还没存过),不是问题。
    return out;
  }
  for (const name of names.filter((n) => n.toLowerCase().endsWith(FILE_SUFFIX)).sort()) {
    const file = path.join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch (err) {
      out.problems.push({ file: name, error: `读不了:${(err as Error).message}` });
      continue;
    }
    const parsed = parseAgentProfile(text);
    if ("error" in parsed) {
      out.problems.push({ file: name, error: parsed.error });
      continue;
    }
    // **文件名和里面的 id 必须一致。** 不一致时以文件名为准会让人对着 A 文件改出 B 的
    // 行为;直接拒掉则把"我改了 id 但文件没改名"这个很常见的手改失误说清楚。
    const expected = name.slice(0, -FILE_SUFFIX.length);
    if (parsed.profile.id !== expected) {
      out.problems.push({
        file: name,
        error: `文件里的 id 是 ${parsed.profile.id},和文件名对不上(要么改名,要么改 id)`,
      });
      continue;
    }
    out.profiles.push(parsed.profile);
  }
  // 新建的排在前面 —— 列表里最想看见的通常是刚存的那份。
  out.profiles.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 一份档案的落盘路径。**id 已经由 schema 限制了字符集**(见 `AGENT_PROFILE_ID_RE`),
 *  所以拼进来不会有路径穿越。 */
function fileOf(id: string): string {
  return path.join(agentProfilesDir(), `${id}${FILE_SUFFIX}`);
}

/**
 * 新增或覆盖一份(按 id)。
 *
 * **先写临时文件再改名** —— 改名在同一个目录里是原子的,所以任何时刻读到的都是完整的
 * 一份(同 `main/hooks/store.ts` 的写盘)。
 */
export function saveAgentProfile(
  profile: AgentProfile,
): { ok: true } | { ok: false; error: string } {
  const check = validateAgentProfile(profile);
  if (!check.ok) return check;
  const dir = agentProfilesDir();
  const file = fileOf(check.profile.id);
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(check.profile, null, 2), "utf-8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    log.warn(`[agentProfiles] 写不进去(${file}):${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 删一份。**找不到也算成功**(想要的结局已经在了)。
 *
 * 这里和钩子有一处刻意的不同:钩子删不掉"格式坏、被 problems 挡下"的条目,而档案
 * **删得掉** —— 因为档案一份一个文件,删掉它不需要先读懂它。坏档案恰恰是最该能删的
 * 那一种(界面上也会把它的文件名说出来)。
 */
export function removeAgentProfile(id: string): { ok: true } | { ok: false; error: string } {
  const file = fileOf(id);
  if (!existsSync(file)) return { ok: true };
  try {
    rmSync(file, { force: true });
    return { ok: true };
  } catch (err) {
    log.warn(`[agentProfiles] 删不掉(${file}):${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}
