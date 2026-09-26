/**
 * 把一份**代理档案**装到一个**会话**上 —— 「新建子对话 → 档案」那一路。
 *
 * ## 和节点那一侧的关系
 *
 * 档案(`<数据根>/workflows/agents/<id>.json`,契约见 `@contracts/agentProfile`)原本只有
 * 一个消费者:工作流画布。画布上挑一份 → `paramsForProfile` 把参数铺到一个节点上 →
 * 节点在隐藏子会话里跑。**从档案建一个对话**是第二条路,而它**不新建机制** ——
 * 认档案、取指令、判类型全部复用契约里那几个函数。
 *
 * 两处刻意的不同,各自都是对的:
 *
 * | | 节点(画布) | 会话(新建子对话) |
 * |---|---|---|
 * | 什么时候读档案 | **每轮现读**(`paramsForProfile`) | **建会话那一刻抄一份** |
 * | 改档案之后 | 下一次跑就是新的 | 已经开出去的对话不跟着变 |
 * | 为什么 | "跑一次算一次" | 对话是连续的,半路换人格会让上下文自相矛盾 |
 *
 * ## 记忆:建会话时挂一次
 *
 * 「档案+记忆」那一路把快照**排队**到新会话上(`queueBackflow`),于是它随**第一轮**的
 * 用户消息一起进上下文。之后不再刷新 —— 这个对话就建在那一刻的记忆上,过时了多少取决于
 * 用户开着它多久。**这是"记忆是快照不是订阅"的代价,与上面那张表同源。**
 *
 * ⚠️ **与节点那边正相反**:节点的记忆是**每轮重新取**的(`nodeInputBuilders` 的
 * `memorySectionOf`),因为节点根本没有"一个长期的对话",每一轮都是一次独立执行。
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  agentProfileInstruction,
  agentProfileRef,
  isSessionAgentProfile,
  parseAgentProfile,
  type AgentProfile,
  type SessionAgentProfileRef,
} from "@contracts/agentProfile";
import { scopedMemorySnapshot } from "@main/memory/retrieval.js";
import { log } from "@main/lib/logger.js";

/** 一份档案能当会话角色用,结果就是这两样:落进会话行的快照 + 会话标题。 */
export interface SessionProfileSeed {
  ref: SessionAgentProfileRef;
  /** 会话标题 —— 用档案名,而不是 `Quick ask`(那个占位符会被第一条消息覆盖掉,
   *  而这个对话的名字应该一直是"它是谁")。 */
  title: string;
}

/**
 * 按 id 读一份档案。
 *
 * **读不到就返回说清原因的错误,不返回 undefined**:调用方拿它决定"这一条会话建不建
 * 得成",而**建不成必须让用户看见**。悄悄退回"建一个没有角色的空会话"是最坏的一种 ——
 * 用户看到一个建成了的子对话,以为它是那个角色,而它其实什么都不是。
 *
 * ⚠️ 这里**故意不走 `readAgentProfiles()`**(一次读整个目录、连带 `problems`):那一条路
 * 是给"列出全部"的界面用的;建会话只要一份,按 id 读一份不需要把整个目录的坏文件都算
 * 进来。文件名即 id(`AGENT_PROFILE_ID_RE` 限制了字符集,拼不出路径穿越)。
 */
export function loadAgentProfileForSession(
  id: string,
  dir: string,
): { ok: true; profile: AgentProfile } | { ok: false; error: string } {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return { ok: false, error: `档案不在了:${id}` };
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    return { ok: false, error: `档案读不了:${(err as Error).message}` };
  }
  const parsed = parseAgentProfile(text);
  if ("error" in parsed) return { ok: false, error: `档案读不了:${parsed.error}` };
  if (!isSessionAgentProfile(parsed.profile)) {
    return { ok: false, error: `这份档案是给「${parsed.profile.type}」用的,当不了对话的角色` };
  }
  if (agentProfileInstruction(parsed.profile).length === 0) {
    return { ok: false, error: `档案「${parsed.profile.name}」没填指令 —— 一个没有角色提示词的"角色"没有意义` };
  }
  return { ok: true, profile: parsed.profile };
}

/**
 * 档案 → 要写进会话行的那一份快照 + 标题。
 *
 * `instruction` 为空时不编一句顶上(`agentProfileRef` 就是空串),但**标题仍然用档案名** ——
 * 用户挑了一份档案,他看到的那个子对话就该叫那个名字;至于是不是"真的当了那个角色",
 * 见 `@contracts/agentProfile` 的 `agentProfileRef` 那段代价说明。
 */
export function profileSeedOf(profile: AgentProfile): SessionProfileSeed {
  return { ref: agentProfileRef(profile), title: profile.name };
}

/**
 * 「档案+记忆」那一路要排队的内容 —— **记忆库此刻的一份快照**。空库(或读不动)返回空串,
 * 调用方据此**不排队**。
 *
 * 这里**只取原样的快照**,不拼 `## 长期记忆` 那一节 —— 拼装由 `pendingBackflow` 的
 * `backflowPrompt` 统一做,否则这一段会被包两层标题(队列那层加一个、这里再加一个)。
 *
 * 读出来的是**快照**,不是订阅:见文件头那段。节点那边每轮重取,这里只此一次。
 */
export function sessionMemorySnapshot(projectId: string): string {
  try {
    return scopedMemorySnapshot(projectId);
  } catch (err) {
    log.warn(`[sessionMemory] 取记忆快照失败,这个对话不注记忆:${(err as Error).message}`);
    return "";
  }
}
