/**
 * `@main/ipc/git.js` 的替身 —— 只给 `vision-relay-heavy-smoke` 用（`--alias:`）。
 *
 * `visionRelay.ts` 只从 git.ts 取 `resolveModelForGitOp` 一个函数（复用"非内置模型 →
 * 经本地桥 → 返回 Anthropic 形态 config"那条既有链路）。真那份 import electron / simple-git
 * 一堆重依赖，无头 bundle 不动，且解析自定义模型配置要读库。这里给最小形状：
 *
 *   - 内置模型（`@claude*`）不经这条路，所以桩只需处理"非内置"分支；
 *   - 自定义模型 id 以 `cfg-` 开头 → 当作**拿得到配置**（返回一份假 config + 假 releaseBridge），
 *     让 `describeImage` 走完 `resolveActiveModel`/`buildCustomEnv`（各自也被换成桩/null）；
 *   - 其它 id → `{ok:false}`，模拟"找不到模型配置"。
 */
export async function resolveModelForGitOp(
  customModelId: string,
  _role: string | undefined,
): Promise<
  | { ok: true; config: Record<string, unknown>; releaseBridge: () => void }
  | { ok: false; error: string }
> {
  if (customModelId.startsWith("cfg-")) {
    return {
      ok: true,
      config: { id: customModelId, protocol: "anthropic", baseUrl: "http://127.0.0.1:0", model: "vision-model" },
      releaseBridge: () => {
        if (process.env["MCODE_SMOKE_RELEASE_EXOTIC"] === "1") throw Object.create(null);
        if (process.env["MCODE_SMOKE_RELEASE_THROW"] === "1") {
          throw new Error("fixture: releaseBridge cleanup failed");
        }
      },
    };
  }
  return { ok: false, error: "找不到指定的模型配置" };
}
