/**
 * 把一张 base64 PNG 落到「截图目录」下的**纯 IO 核** —— 浏览器截图(agent 路径)与面板截图
 * (app_ui screenshot_panel)共用这一段,免得两处各写一份、目录规则各自漂移。
 *
 * ## 为什么是零依赖模块
 *
 * `main/appControl/tools.ts` 会被一批**无头 smoke** 打包(esbuild `--external:electron`),
 * 而那些套件在 node 里跑 —— 任何**静态** `import ... from "electron"` 一旦进了这个图,
 * esbuild 会把它提到 bundle 顶部(实测:连**动态** `import()` 到的模块里的静态 electron
 * import 也会被提上去),node 立刻 `SyntaxError: Named export 'app' not found`(electron
 * 是 CJS,外部化后没有具名导出)。所以这一层**只收 `baseDir`**(由调用方各自解析:浏览器那条
 * 读设置 + `app.getPath`,面板那条经 registry),自己不碰 electron / logger。
 *
 * 目录规则(与旧的 `saveScreenshotToDisk` 逐条一致,不新立一套):
 *   `<baseDir>/<sessionId>/turn-<N>/<timestamp>-<toolCallId>.png`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 写一张 base64 PNG。没有 `sessionId` / 空数据 → 返回 `null`(调用方本来也不该存)。
 * 出错**不抛**(只丢文件,不影响"图已给模型"这件事),返回 `null` 由调用方决定要不要记一句。
 */
export function savePngArtifact(
  data: string,
  opts: { baseDir: string; sessionId?: string; turnNumber?: number; toolCallId: string },
): string | null {
  if (!opts.sessionId || !data) return null;
  // 会话 id 正常是 UUID,仍按文件名消毒一道(与浏览器截图同一条规矩)。
  const safeSession = opts.sessionId.replace(/[^\w.-]/g, "_");
  const turnDir = join(opts.baseDir, safeSession, `turn-${opts.turnNumber ?? 0}`);
  try {
    mkdirSync(turnDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    const safeCallId = opts.toolCallId.replace(/[^\w.-]/g, "_");
    const filePath = join(turnDir, `${ts}-${safeCallId}.png`);
    writeFileSync(filePath, Buffer.from(data, "base64"));
    return filePath;
  } catch {
    return null;
  }
}
