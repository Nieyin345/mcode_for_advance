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
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  AGENT_PROFILE_ID_RE,
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

/**
 * 【MC-033】一个引用**是不是**一个合法的档案 id(形如 `p_xxxx`)。
 *
 * 这是**唯一**的档案引用判据 —— 落盘、删除、哈希三处共用同一份。正则来自契约
 * (`AGENT_PROFILE_ID_RE`),与 `AgentProfileSchema` 里那格是**同一个常量**,不另抄一遍。
 *
 * 从前 `agentProfileContentHash` 直接 `path.join(dir, id + ".json")` 而不验 id:工作流
 * 契约里 `params` 是开放的 `z.record(z.string(), z.unknown())`,于是节点上一个额外参数
 * (键名以 `profileId` 结尾)可以塞进 `../../x`,宿主就去读档案目录**之外**的文件算哈希;
 * 同一个缺口在 `removeAgentProfile` 那侧更重 —— `rmSync` 会删掉界外的 `.json` 文件。
 * 判据钉在**拼路径之前**,所以两个方向一起收口。
 */
export function isAgentProfileIdRef(id: string): boolean {
  return typeof id === "string" && AGENT_PROFILE_ID_RE.test(id);
}

/** 读全部档案。**目录不存在、单个文件坏了都不抛** —— 档案是附加能力,它坏了不该让
 *  工作流页打不开(同 `loadNodeTypes` 对坏清单的处理)。 */
/**
 * ARC-016: 一份档案**内容**的哈希(供运行记录锁版)。读不到/坏了 → null。
 * 只哈希文件字节,不含任何解密后的密钥字段。
 *
 * 【MC-033】id 不是合法档案引用时**直接返回 null,不碰文件系统** —— 参数来自节点上的
 * 自由字段,不能让它决定读哪个路径。
 */
export function agentProfileContentHash(id: string): string | null {
  const file = fileOf(id);
  if (!file) return null;
  try {
    return createHash("sha256").update(readFileSync(file, "utf-8")).digest("hex");
  } catch {
    return null;
  }
}

export function readAgentProfiles(): AgentProfileCatalog {
  const dir = agentProfilesDir();
  const out: AgentProfileCatalog = { profiles: [], problems: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    // 【MC-030】**只有真·ENOENT 才是「一份档案都还没存过」的正常空**;ACL 拒绝 / 硬盘错误这类
    //   **读不了**必须如实记进 `problems`(字段本来就有,界面 `AgentProfilesView` 在消费),
    //   否则已存的档案会因暂时读不了而静默消失。
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      out.problems.push({ file: dir, error: `读不了目录:${(err as Error).message}` });
    }
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

/**
 * 一份档案的落盘路径 —— **唯一的拼路径口**,三处(读哈希 / 写 / 删)共用。
 *
 * 【MC-033】id **必须是合法档案引用**(`AGENT_PROFILE_ID_RE`,与 schema 同一常量):
 * 不合法就返回 `null`,调用方**一个字节都不碰**。从前只有写路径走这里、且假定
 * 「id 已经被 schema 限制过」,而读哈希与删除是各自 `path.join` 的 —— MCP 那条
 * `agent_profile_remove` 的入参是裸 `z.string()`,于是 `../../x` 能到 `rmSync`。
 * 判据集中在这里,新增调用点就不可能绕过。
 */
function fileOf(id: string): string | null {
  return isAgentProfileIdRef(id) ? path.join(agentProfilesDir(), `${id}${FILE_SUFFIX}`) : null;
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
  const file = fileOf(check.profile.id);
  if (!file) return { ok: false, error: `档案 id「${check.profile.id}」不是合法引用(须形如 p_xxxx)` };
  const dir = agentProfilesDir();
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
  // 【MC-033】非法引用**明说拒绝**,不静默当"本来就不在" —— MCP 那条路的入参是裸
  //  z.string(),`../../x` 从前能一路走到 rmSync 删界外文件;现在连"成功的假象"都不给。
  if (!file) return { ok: false, error: `档案 id「${id}」不是合法引用(须形如 p_xxxx)` };
  if (!existsSync(file)) return { ok: true };
  try {
    rmSync(file, { force: true });
    return { ok: true };
  } catch (err) {
    log.warn(`[agentProfiles] 删不掉(${file}):${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}
