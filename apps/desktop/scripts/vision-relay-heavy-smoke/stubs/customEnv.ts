/**
 * `@main/providers/claude-sdk/customEnv.js` 的替身 —— 只给 `vision-relay-heavy-smoke` 用。
 *
 * `visionRelay.ts` 只从它取两个函数(`buildCustomEnv` / `resolveActiveModel`),而真那份要
 * 解析自定义模型的完整 `ApiConfig`(models 数组 / authMode / 自定义头…)。本套要验的是
 * 「宿主交给 SDK 的入参」,不是配置解析本身 —— 给它最小形状:
 *   - `resolveActiveModel` → 固定一个假模型名;
 *   - `buildCustomEnv` → 给一个能区分"非内置走了 env 这条"的非空对象。
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export function resolveActiveModel(_cfg: unknown): string | undefined {
  return "vision-model";
}

export function buildCustomEnv(_cfg: unknown, _opts?: { sessionId?: string }): NonNullable<Options["env"]> {
  return { ANTHROPIC_BASE_URL: "http://127.0.0.1:0", ANTHROPIC_MODEL: "vision-model" };
}

export function resolveMappedEffort(effort: string | undefined): string | undefined {
  return effort === "default" ? undefined : effort;
}

export function isNamedEffort(v: string | undefined): boolean {
  return v !== undefined && ["low", "medium", "high", "xhigh", "max"].includes(v);
}
