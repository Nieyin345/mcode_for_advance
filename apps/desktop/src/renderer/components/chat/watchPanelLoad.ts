/**
 * 「守望」起跑面板的**读口外壳**(MC-048)。
 *
 * 面板打开时要读两样东西:命令模板(带健康态)与该会话的守望活跃状态。这一层抽出来
 * 是为了让「读失败」与「没有模板」的区分可以被无头断言钉住:
 *
 *   - 从前 `catch { setTemplates([]) }` 把读失败画成一张正常空面板 —— 健康态仍是
 *     `valid`、红条不出现,用户完全看不出真实设置坏着/读不动;
 *   - 现在失败显式落成 `read_error` + 原因,面板的红条(MC-054 起的「备份并重建」)
 *     照常给出诊断入口。
 *
 * 纯函数、只依赖类型,放在单独模块里以便 `renderer-pure-smoke` 直接 import 断言。
 */
import type { WatchCommandTemplate } from "@contracts/ipc";

export type WatchTemplatesHealth = "absent" | "valid" | "partial" | "corrupt" | "read_error";

/** 面板打开时要读的两样东西 —— 抽成纯函数,让"读失败"与"没有模板"的**区分**可以被
 *  无头断言钉住(MC-048;从前 `catch { setTemplates([]) }` 把两者画成同一张脸)。 */
export async function loadWatchPanelState(ports: {
  templates: () => Promise<{ templates: WatchCommandTemplate[]; health?: "absent" | "valid" | "partial" | "corrupt" | "read_error"; problems?: string[]; revision?: string }>;
  status: () => Promise<{ active: boolean }>;
}): Promise<{ templates: WatchCommandTemplate[]; health: "absent" | "valid" | "partial" | "corrupt" | "read_error"; problems: string[]; active: boolean; revision: string | null }> {
  const [tpl, status] = await Promise.all([ports.templates(), ports.status()]);
  return {
    templates: tpl.templates,
    // 【MC-054】健康态随读一起回来(旧 preload 没这两字段 → 当正常)。
    health: tpl.health ?? "valid",
    problems: tpl.problems ?? [],
    active: status.active,
    // 【MC-054】原值版本:保存时原样带回,主进程据此拒绝覆盖别人刚保存的内容。
    // 旧主进程没有该字段 → null(保存时不带 expectedRevision,行为与从前一致)。
    revision: tpl.revision ?? null,
  };
}

/** 读失败时的面板状态 —— **显式**的 `read_error` + 原因,不是"空表+正常"。 */
export function watchPanelLoadFailure(error: unknown): {
  templates: WatchCommandTemplate[];
  health: "read_error";
  problems: string[];
  revision: null;
} {
  return { templates: [], health: "read_error", problems: [error instanceof Error ? error.message : String(error)], revision: null };
}

/**
 * 【MC-054】保存冲突后的**重新加载判据**(纯函数,可无头断言):主进程以
 * `conflict:true` 拒绝时,面板必须①把提示语给用户,②把本地列表换成**盘上的当前内容**
 * (而不是继续显示自己那份已过期的),③把 revision 换成新的 —— 否则下一次保存还会撞。
 * 不做这三样,"拒绝"只是换了个地方丢更新。
 */
export function watchSaveConflictState(reply: {
  conflict?: boolean; error?: string; currentRevision?: string;
}, reloaded: { templates: WatchCommandTemplate[]; health?: "absent" | "valid" | "partial" | "corrupt" | "read_error"; problems?: string[]; revision?: string }): {
  notice: string | null;
  templates: WatchCommandTemplate[];
  health: "absent" | "valid" | "partial" | "corrupt" | "read_error";
  problems: string[];
  revision: string | null;
} | null {
  if (reply.conflict !== true) return null;
  return {
    notice: reply.error ?? "命令模板已被别处改动,已重新加载。",
    templates: reloaded.templates,
    health: reloaded.health ?? "valid",
    problems: reloaded.problems ?? [],
    revision: reloaded.revision ?? null,
  };
}
