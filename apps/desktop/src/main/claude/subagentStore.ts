/**
 * subagentStore — persistence + validation for the Claude provider's custom
 * subagent definitions (Settings → 子代理, contract shape in
 * `@contracts` claudeSubagent.ts).
 *
 * Storage rides the settings table under `claude.subagents` (JSON array) —
 * same threat model and lifecycle as every other preference; no new table.
 * Read fresh at every claude-sdk startTurn (forwarded as the SDK's
 * `Options.agents`), so an edit applies from the NEXT turn on.
 *
 * One validator, three consumers: saveSubagents (IPC write path), load (turn
 * path — invalid entries are dropped with a warning rather than rejected, so
 * one bad hand-edited row can't take down every turn), and the SDK-options
 * mapping (structural subset of the SDK's AgentDefinition).
 */
import { SettingRepo } from "@main/store/repositories.js";
import { CLAUDE_SUBAGENTS_SETTING_KEY } from "@contracts/ipc";
import type { SubagentDefinition } from "@contracts/claudeSubagent.js";
import { log } from "@main/lib/logger.js";

/** Invocation-name shape: what the Agent tool accepts as subagent_type. */
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Upper bound on the stored list — a typo'd paste shouldn't be able to
 *  balloon every turn's options payload without bound. */
const MAX_SUBAGENTS = 50;

/** Validate one raw (JSON-decoded) entry. Returns the normalized definition
 *  or a human-readable error. Tools/model are normalized (trimmed; empty
 *  arrays/strings dropped) so the stored shape is canonical. */
function validateOne(raw: unknown): { ok: true; def: SubagentDefinition } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "子代理定义必须是对象" };
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `名称「${String(r.name ?? "")}」不合法:只能用字母/数字/下划线/连字符,1-64 位` };
  }
  const description = typeof r.description === "string" ? r.description.trim() : "";
  if (description.length === 0 || description.length > 1024) {
    return { ok: false, error: `「${name}」的描述不能为空且不超过 1024 字` };
  }
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (prompt.length === 0 || prompt.length > 100_000) {
    return { ok: false, error: `「${name}」的提示词不能为空且不超过 100000 字` };
  }
  const def: SubagentDefinition = { name, description, prompt };
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools) || r.tools.some((t) => typeof t !== "string" || t.trim().length === 0)) {
      return { ok: false, error: `「${name}」的工具列表不合法:应为非空字符串数组` };
    }
    const tools = (r.tools as unknown[]).map((t) => (t as string).trim());
    if (tools.length > 0) def.tools = tools;
  }
  if (r.model !== undefined) {
    if (typeof r.model !== "string" || r.model.trim().length === 0 || r.model.trim().length > 128) {
      return { ok: false, error: `「${name}」的模型必须是 1-128 位的字符串` };
    }
    def.model = r.model.trim();
  }
  return { ok: true, def };
}

/** Validate the whole list. Duplicate names are rejected (the SDK's
 *  Options.agents is a name-keyed record — later entries would silently win). */
export function validateSubagentList(raw: unknown[]): { ok: true; defs: SubagentDefinition[] } | { ok: false; error: string } {
  if (raw.length > MAX_SUBAGENTS) {
    return { ok: false, error: `子代理最多 ${MAX_SUBAGENTS} 个(当前 ${raw.length})` };
  }
  const defs: SubagentDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const v = validateOne(item);
    if (!v.ok) return { ok: false, error: v.error };
    if (seen.has(v.def.name)) {
      return { ok: false, error: `名称「${v.def.name}」重复` };
    }
    seen.add(v.def.name);
    defs.push(v.def);
  }
  return { ok: true, defs };
}

/** Load the stored list for the turn path. Invalid entries are DROPPED (with
 *  a warn) instead of failing the turn — a degraded config beats a dead
 *  session. Duplicate names keep the first occurrence (same reasoning). */
export function loadSubagents(): SubagentDefinition[] {
  let raw: string | null = null;
  try {
    raw = SettingRepo.get(CLAUDE_SUBAGENTS_SETTING_KEY);
  } catch (err) {
    log.warn(`subagentStore: read failed: ${(err as Error).message}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SubagentDefinition[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const v = validateOne(item);
      if (!v.ok) {
        log.warn(`subagentStore: dropping invalid entry: ${v.error}`);
        continue;
      }
      if (seen.has(v.def.name)) continue;
      seen.add(v.def.name);
      out.push(v.def);
    }
    return out;
  } catch {
    log.warn("subagentStore: stored claude.subagents is not valid JSON; ignoring");
    return [];
  }
}

/** IPC save path: validate strictly, persist canonically. Returns the saved
 *  list so the editor can snap to what actually landed. */
export function saveSubagents(raw: unknown[]): { ok: true; subagents: SubagentDefinition[] } | { ok: false; error: string } {
  const v = validateSubagentList(raw);
  if (!v.ok) return v;
  SettingRepo.set(CLAUDE_SUBAGENTS_SETTING_KEY, JSON.stringify(v.defs));
  return { ok: true, subagents: v.defs };
}

/** Map stored definitions onto the SDK's `Options.agents` record (keyed by
 *  name). Structurally compatible with the SDK's AgentDefinition — kept here
 *  as plain objects so contracts/tests never import the SDK. */
export function subagentsToAgentsRecord(defs: SubagentDefinition[]): Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> {
  const out: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> = {};
  for (const d of defs) {
    out[d.name] = { description: d.description, prompt: d.prompt, tools: d.tools, model: d.model };
  }
  return out;
}
