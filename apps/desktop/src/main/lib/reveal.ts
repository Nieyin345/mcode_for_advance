/**
 * 在系统文件管理器里打开一个路径。
 *
 * ## 为什么不用 Electron 那两个 API
 *
 * 都试过了,在这台机器上都不成:
 *
 *   - **`shell.showItemInFolder(p)`** —— 对**目录**会走 `explorer /select,<dir>`,
 *     而它实际去开的是**父目录**。实测在
 *     `%APPDATA%\@mcode\desktop\templates\word\test` 上会弹
 *     「位置不可用: …\templates\word 不可用」,尽管两个目录都在磁盘上。
 *   - **`shell.openPath(p)`** —— 返回空字符串(按文档就是"成功"),但**什么也没发生**。
 *
 * 而 `explorer.exe <路径>` 是实测能开的。所以 Windows 上直接用 explorer。
 *
 * ## 注意
 *
 * explorer.exe 的退出码**不可靠** —— 成功时也可能返回 1。所以这里**不看退出码**,
 * 只把「没能把它启动起来」当失败(`error` 事件)。
 */
import { spawn } from "node:child_process";
import { shell } from "electron";
import { log } from "@main/lib/logger.js";

/**
 * 打开一个**目录**。
 *
 * @param dir 绝对路径。调用方负责确认它存在。
 * @returns 失败时返回错误字符串,成功返回 null。
 */
export async function openDirectory(dir: string): Promise<string | null> {
  log.info(`reveal: opening directory ${dir}`);
  if (process.platform === "win32") {
    const spawned = await spawnDetached("explorer.exe", [dir]);
    if (spawned === null) return null;
    log.warn(`reveal: explorer.exe failed (${spawned}), falling back to shell.openPath`);
  }
  // 非 Windows,或 explorer 起不来 —— 回到 Electron 的实现
  const err = await shell.openPath(dir);
  return err || null;
}

/** 启动一个游离进程。成功返回 null,失败返回错误信息。 */
function spawnDetached(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // ⚠️ **不能带 `detached: true`,也不能带 `windowsHide: true`** —— 实测这两个
      // 会让 explorer 完全脱离会话,shell 的交接被丢掉:**进程起来了,窗口一个都不开**。
      // 四种写法逐一对照过(用窗口标题判定,进程数会骗人):
      //   detached+ignore+windowsHide → 无窗口
      //   普通 spawn + stdio:ignore    → ✅ 开窗   ← 用这个
      //   shell:true(走 cmd)          → 无窗口
      //   execFile                     → 无窗口
      // `unref()` 让子进程不拖住主进程,但要等一小会儿再确认它没立刻报错。
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", (e) => resolve(e.message));
      child.unref();
      setTimeout(() => resolve(null), 300);
    } catch (err) {
      resolve((err as Error).message);
    }
  });
}
