/**
 * `env/agentEnv.js` 的桩。⚠️ 同 `toolchain.ts`:会被打两次,状态走 `slot`。
 *
 * 真的那个会**改 `process.env.PATH`**(把自管工具的目录注进去)、设 `PYTHONUTF8`、
 * 并且**无条件覆盖 `CLAUDE_CONFIG_DIR`**。本套跑在被 node 直接执行的脚本里 ——
 * 让真的那个跑,就是把本进程的 PATH 和 CLAUDE_CONFIG_DIR 当场改掉,顺带拉进
 * `customEnv.ts` / `upstreamHeaders.ts` 一整张图。
 *
 * `toolInstall` 在装成之后、卸掉之后各调它一次(路径变了要重算)。这里只计数:
 * **「装完了有没有把环境重新算一遍」正是本套要立的一条断言** —— 漏掉它的后果是
 * 「面板显示已装、agent 的 shell 里却 command not found」,而界面上看不出来。
 */
import { slot } from "./shared.js";

export function applyAgentEnvironment(): void {
  slot.counts.applyEnv++;
}

/** 真的那个导出它,`terminal/envRefresh` 那边用。本套不验。 */
export function injectedToolDirs(): string[] {
  return [];
}
