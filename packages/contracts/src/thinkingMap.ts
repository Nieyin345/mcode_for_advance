/**
 * **思考强度档位怎么翻译** —— 三家引擎共用的一份形状。
 *
 * ## 为什么不是一个自由文本表
 *
 * 三家引擎真正能接受的东西**差别很大**（2026-10-17 查过各自的 SDK / 二进制，不是猜的）：
 *
 * | 引擎 | 能接受 |
 * |---|---|
 * | Pi | **任意字符串**（写进 `models.json` 的 `thinkingLevelMap`，由 pi-ai 的每个
 *        wire adapter 逐条翻译；`null` = 该档不支持） |
 * | Claude | 命名档（封闭联合）· **整数**（`Options.effort` 也收 number）·
 *          **token 预算**（`Options.thinking.budgetTokens`）· 自定义字符串（只能走
 *          `CLAUDE_CODE_EFFORT_LEVEL` env） |
 * | Codex | **封闭枚举**（`minimal/low/medium/high/xhigh/max/ultra/persistent`，
 *          抠自 codex.exe；`reasoning_effort` 是它库里的列名 + RPC 字段） |
 *
 * 所以「一档翻译成什么」不是一个字符串，而是一个**带 kind 的选择** —— 每种 kind
 * 落到不同的线上字段。一个统一的自由文本表会让用户填一个在 Codex 上永远不会生效的值，
 * 那比不给这一格更糟。
 */

/** 档位键。**没有 "max" 之外的额外键** —— `max` 是键，具体值由 binding 决定。 */
export const THINKING_LEVEL_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevelKey = (typeof THINKING_LEVEL_KEYS)[number];

/**
 * 一个档位翻译成什么。`kind` 决定它落到**线上哪个字段**：
 *
 * - `passthrough` —— 档位名原样发（`effort: "high"` / `thinkingLevel: "high"`）。
 * - `off` —— **这一档不支持**：不传参数，用引擎/模型默认。等价旧 Pi 形状里的 `null`。
 * - `string` —— 翻译成这个字符串。Pi 上由 pi-ai 逐 adapter 翻译；Claude 上只能走
 *   `CLAUDE_CODE_EFFORT_LEVEL` env；Codex 上**只接受枚举内的值**（主进程会校验）。
 * - `number` —— 翻译成整数。**只有 Claude 有这条路**（`Options.effort` 收 number）。
 * - `budget` —— 翻译成**思考 token 预算**（`Options.thinking = { type:"enabled",
 *   budgetTokens }`）。这是**另一种语义**：固定预算，而不是"自适应档位"。
 *   **只有 Claude 有**。
 */
export type ThinkingLevelBinding =
  | { kind: "passthrough" }
  | { kind: "off" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "budget"; tokens: number };

/** 每模型一张：档位 → 翻译方式。缺席的档 = 引擎默认（等同 `passthrough`）。 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, ThinkingLevelBinding>>;

/** 一家引擎**能表达**哪些 binding kind —— UI 按这个决定那一档给什么控件。 */
export type ThinkingCapability = "free" | "flexible" | "enum";

/**
 * - `free`（Pi）：任意字符串 + 「不传」。数字/预算在 Pi 上没有落点。
 * - `flexible`（Claude）：命名档 / 数字 / 预算 / 自定义字符串 都行。
 * - `enum`（Codex）：只能选它认识的档（+「不传」），选了别的不会生效。
 */
export function thinkingKindsFor(cap: ThinkingCapability): ThinkingLevelBinding["kind"][] {
  switch (cap) {
    case "free":
      return ["passthrough", "off", "string"];
    case "flexible":
      return ["passthrough", "off", "string", "number", "budget"];
    case "enum":
      // 枚举引擎的「自定义字符串」由 UI 限制成下拉选它认识的值 —— kind 上仍是 string，
      // 但 `CODEX_EFFORT_VALUES` 会校验。`passthrough` 让用户显式选"就用这个档位名"。
      return ["passthrough", "off", "string"];
  }
}

/**
 * Codex 能接受的 `effort` 值 —— 从 `codex.exe` 抠出来的枚举
 * （`minimal low medium high xhigh max ultra persistent`）。
 *
 * ⚠️ 这是**二进制的封闭枚举**：不在这个表里的值发过去不会生效（主进程会拦下来并
 * 记一条 warn，**不静默发**）。
 */
export const CODEX_EFFORT_VALUES = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const;
export type CodexEffortValue = (typeof CODEX_EFFORT_VALUES)[number];

export function isCodexEffortValue(v: string): v is CodexEffortValue {
  return (CODEX_EFFORT_VALUES as readonly string[]).includes(v);
}

/* ────────────────────────── 旧的自由文本形状 ⇄ 新形状 ──────────────────────────
 *
 * 落盘的历史数据是 `Record<string, string | null>`（Pi 的 models.json 原生形状，
 * Claude 侧 2026-10-11 复用了它）。**读进来要归一，写回去要还原** —— Pi SDK 只认
 * 那个形状，不能改它。
 */

export type LegacyThinkingLevelMap = Record<string, string | null>;

/** 旧形状 → 新形状。`null` → `off`，字符串 → `string`，其余忽略。 */
export function thinkingMapFromLegacy(
  legacy: LegacyThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (!legacy) return undefined;
  const out: ThinkingLevelMap = {};
  let any = false;
  for (const k of THINKING_LEVEL_KEYS) {
    const v = legacy[k];
    if (v === null) {
      out[k] = { kind: "off" };
      any = true;
    } else if (typeof v === "string" && v.trim()) {
      out[k] = { kind: "string", value: v.trim() };
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * 新形状 → 旧形状（**给 Pi 的 models.json 用**）。数字/预算在 Pi 上没有落点 ——
 * 转成它的字符串形式（`String(value)`），因为 Pi 只认 `string | null`。
 * `passthrough` 不写（= 用默认）。
 */
export function thinkingMapToLegacy(map: ThinkingLevelMap | undefined): LegacyThinkingLevelMap | undefined {
  if (!map) return undefined;
  const out: LegacyThinkingLevelMap = {};
  let any = false;
  for (const k of THINKING_LEVEL_KEYS) {
    const b = map[k];
    if (!b) continue;
    if (b.kind === "off") {
      out[k] = null;
      any = true;
    } else if (b.kind === "string" && b.value.trim()) {
      out[k] = b.value.trim();
      any = true;
    } else if (b.kind === "number") {
      out[k] = String(b.value);
      any = true;
    } else if (b.kind === "budget") {
      out[k] = String(b.tokens);
      any = true;
    }
    // passthrough 不写
  }
  return any ? out : undefined;
}

/**
 * 解析一个档位最终该发什么（**给 Claude 的 provider 用**）。
 *
 * 返回判别式，调用方按 kind 落到不同的字段 —— 这是把「翻译」从"一个字符串"
 * 升级成"一个落点选择"的关键。
 */
export type ResolvedEffort =
  | { target: "omit" }                          // 不传（off / default）
  | { target: "effort"; value: "low" | "medium" | "high" | "xhigh" | "max" }  // Options.effort 命名档
  | { target: "effortNumber"; value: number }    // Options.effort 整数（sdk.d.ts:87 允许）
  | { target: "thinkingBudget"; tokens: number } // Options.thinking.budgetTokens
  | { target: "env"; value: string };            // CLAUDE_CODE_EFFORT_LEVEL（自定义字符串唯一落点）

const NAMED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * 按模型的 `thinkingLevelMap` 把会话档位翻译成"发什么"。
 *
 * 规则（**顺序有意义**）：
 * 1. 没选 / `default` → `omit`；
 * 2. 该档配了 binding → 按 kind 走对应的落点；
 * 3. 没配 → **命名档走命名档**（能进 `Options.effort` 就进），其余走 `env`。
 *
 * ⚠️ `Options.effort` 是**封闭联合 + number**，所以只有那五个名字和整数能走它；
 * 其它字符串必须走 `CLAUDE_CODE_EFFORT_LEVEL`（见 `ClaudeAgentSdkProvider`）。
 */
export function resolveEffortForClaude(
  effort: string | undefined,
  map: ThinkingLevelMap | undefined,
): ResolvedEffort {
  if (!effort || effort === "default") return { target: "omit" };
  const binding = map?.[effort as ThinkingLevelKey];
  if (binding) {
    switch (binding.kind) {
      case "off":
        return { target: "omit" };
      case "budget":
        return { target: "thinkingBudget", tokens: binding.tokens };
      case "number":
        return { target: "effortNumber", value: binding.value };
      case "string": {
        const v = binding.value.trim();
        // ⚠️ **空白的 string binding 不算数** —— `break` 出去走"没配"那条路
        // （回落到命名档 / env）。这不只是防御：旧形状里空白字符串就是"没填"，
        // 而 `thinkingMapFromLegacy` 会把它滤掉；这里是防止手工构造的对象
        // （IPC / 测试 / 将来的 UI）绕过那一层。静默 omit 会让用户看到
        // "明明配了这一档、思考强度却没了"。
        if (v) {
          // 网关要的字符串**恰好就是某个命名档**时，走 effort（比 env 更可靠）。
          if (NAMED_EFFORTS.has(v)) {
            return { target: "effort", value: v as "low" | "medium" | "high" | "xhigh" | "max" };
          }
          return { target: "env", value: v };
        }
        break;
      }
      case "passthrough":
      default:
        break;
    }
  }
  // 没配 / passthrough
  if (NAMED_EFFORTS.has(effort)) {
    return { target: "effort", value: effort as "low" | "medium" | "high" | "xhigh" | "max" };
  }
  return { target: "env", value: effort };
}

/**
 * 一个 binding 在 UI 上该显示成什么（**给人看的**，不是发出去的值）。
 * `undefined` = 没有可见的翻译（passthrough / off / 空字符串），调用方落回档位名。
 *
 * composer 的档位 chip 与设置页的映射编辑器都用这一份 —— 两处显示必须一致
 * （硬规矩：共享实现只有一份）。
 */
export function bindingDisplay(b: ThinkingLevelBinding | undefined): string | undefined {
  if (!b) return undefined;
  switch (b.kind) {
    case "string":
      return b.value.trim() || undefined;
    case "number":
      return String(b.value);
    case "budget":
      return `${b.tokens} tokens`;
    case "off":
      return undefined;
    case "passthrough":
    default:
      return undefined;
  }
}
