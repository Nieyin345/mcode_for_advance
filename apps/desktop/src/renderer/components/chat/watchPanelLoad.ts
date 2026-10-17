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
  templates: () => Promise<{ templates: WatchCommandTemplate[]; health?: "absent" | "valid" | "partial" | "corrupt" | "read_error"; problems?: string[] }>;
  status: () => Promise<{ active: boolean }>;
}): Promise<{ templates: WatchCommandTemplate[]; health: "absent" | "valid" | "partial" | "corrupt" | "read_error"; problems: string[]; active: boolean }> {
  const [tpl, status] = await Promise.all([ports.templates(), ports.status()]);
  return {
    templates: tpl.templates,
    // 【MC-054】健康态随读一起回来(旧 preload 没这两字段 → 当正常)。
    health: tpl.health ?? "valid",
    problems: tpl.problems ?? [],
    active: status.active,
  };
}

/** 读失败时的面板状态 —— **显式**的 `read_error` + 原因,不是"空表+正常"。 */
export function watchPanelLoadFailure(error: unknown): {
  templates: WatchCommandTemplate[];
  health: "read_error";
  problems: string[];
} {
  return { templates: [], health: "read_error", problems: [error instanceof Error ? error.message : String(error)] };
}
