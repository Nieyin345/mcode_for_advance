/**
 * 自定义模型 / Pi 模型 / Codex 供应商三个设置面板的 RPC 入参。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { webSiteById } from "../customModel.js";
import type { CustomModelInput } from "../customModel.js";

/* ── Custom model configs (user-defined Anthropic-compatible endpoints) ── */

/** One selectable model within a custom-model config. */
const CustomModelEntrySchema = z.object({
  id: z.string().min(1),
  supports1m: z.boolean().optional(),
  /** 声明该模型接受**图片输入**(用户自述,不上行)。与 `supports1m` 同形:这里
   *  必须列出来,zod 会把未在 schema 里的键**静默剥掉** —— 少了这一格,设置页的
   *  「支持图片输入」开关勾了也存不进库。 */
  supportsVision: z.boolean().optional(),
  /** 每模型「思考强度档位 → 该网关要的具体值」映射（2026-10-11 加，与 Pi 的
   *  `thinkingLevelMap` 同一形状、同一语义）。不同网关对同一档位用的标识符不一样，
   *  这一格让用户在设置里把它接对。三态：缺席 = 用网关/引擎默认；字符串 = 具体值；
   *  null = 这个档位不支持（下拉里隐藏）。 */
  thinkingLevelMap: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
});

const AuthModeSchema = z.enum(["auth_token", "api_key"]);

const ProtocolSchema = z.enum(["anthropic", "openai", "web"]);

/** Extra request headers for a custom endpoint, keyed by header name. Shape
 *  only — names/values are validated in main (see
 *  `providers/upstreamHeaders.ts`), which owns the delivery rules and drops
 *  entries a gateway would reject instead of failing the whole save. */
const CustomHeadersSchema = z.record(z.string(), z.string());

/** Save (create or update) a custom-model config. On update, an omitted
 *  `authToken` keeps the existing stored token; on create, `authToken` is
 *  required. At least one model entry is required. */
export const SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  /** Endpoint base URL. **Not** required for `protocol: "web"` — a web-page
   *  model has no endpoint at all (its "upstream" is a chat page in the user's
   *  own browser, driven by the Mcode bridge extension). The rule lives in the
   *  superRefine below. */
  baseUrl: z.string(),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  /** Required when `protocol: "web"`: which site the extension should drive
   *  (an id from `WEB_SITES` in customModel.ts). */
  webSiteId: z.string().optional(),
  authToken: z.string().optional(),
  models: z.array(CustomModelEntrySchema).min(1),
  /** Task-subagent model pin (one of models[].id); the store drops a value
   *  not present in the list. Absent = follow the main session's model. */
  subagentModel: z.string().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  customHeaders: CustomHeadersSchema.optional(),
}).superRefine((val, ctx) => {
  // 两条互斥的必填规则：普通协议要有地址，网页端要有站点。放在这里而不是字段上，
  // 是因为 zod 的字段级校验看不到兄弟字段。
  if (val.protocol === "web") {
    if (!val.webSiteId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "网页端必须选择站点",
        path: ["webSiteId"],
      });
    } else if (!webSiteById(val.webSiteId)) {
      // 目录里没有这个 id：多半是手改过配置文件，或者从别的版本带过来的。
      // 拦在这里，而不是等到开跑时才在 bridge 里报一句看不懂的错。
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `不认识的网页端站点：${val.webSiteId}`,
        path: ["webSiteId"],
      });
    }
    return;
  }
  if (!val.baseUrl.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "baseUrl is required",
      path: ["baseUrl"],
    });
  }
});
export type SaveCustomModelInput = CustomModelInput;

export const DeleteCustomModelSchema = z.object({ id: z.string() });

/** Probe a custom endpoint using the supplied (not-yet-saved) values, so the
 *  user can verify auth/baseUrl/a-specific-model before committing. The probe
 *  tests ONE model at a time (the user picks which model in the UI). */
export const TestCustomModelSchema = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  /** The single model id to probe in this request. */
  model: z.string().min(1),
  /** Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the
   *  model row's toggle. */
  supports1m: z.boolean().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  /** Headers to probe with, so an endpoint that requires one (and would
   *  otherwise fail the test) can be verified before saving. */
  customHeaders: CustomHeadersSchema.optional(),
});
export type TestCustomModelInput = z.infer<typeof TestCustomModelSchema>;

/** Fetch the cleartext auth token for an already-saved custom-model config.
 *  This BREAKS the usual "cleartext never crosses IPC" rule on purpose: it
 *  exists solely so the settings UI can show the token when the user clicks
 *  the eye icon on an edit form. It MUST NOT be used by any background /
 *  turn-time path (those resolve the token in main via resolveApiConfig). */
export const GetCustomModelTokenSchema = z.object({ id: z.string().min(1) });
export type GetCustomModelTokenInput = z.infer<typeof GetCustomModelTokenSchema>;

/* ── Pi models (visual editor for ~/.pi/agent/models.json) ── */

/** Save a provider to models.json. `config` is the full provider object from
 *  the form; unknown fields are preserved by the store. `apiKey` is encrypted
 *  separately (safeStorage) and never written to models.json — empty string
 *  means "preserve the existing key" when updating; required when creating
 *  a new provider. */
export const SavePiProviderSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  apiKey: z.string().optional(),
});
export type SavePiProviderInput = z.infer<typeof SavePiProviderSchema>;

export const DeletePiProviderSchema = z.object({ name: z.string().min(1) });
export type DeletePiProviderInput = z.infer<typeof DeletePiProviderSchema>;

/** Get a provider's API key in cleartext. Main-process only — never
 *  exposed to the renderer. Used by PiAgentSdkProvider to inject the key
 *  into the pi authStorage at turn time. */
export const GetPiApiKeySchema = z.object({ name: z.string().min(1) });
export type GetPiApiKeyInput = z.infer<typeof GetPiApiKeySchema>;

/* ── Codex model providers (third-party Responses-API endpoints driving the
      Codex harness; materialized into <CODEX_HOME>/config.toml) ── */

/** Save (create/update) one Codex provider. `config` carries the metadata
 *  (name/baseUrl/models); `apiKey` is encrypted separately (safeStorage,
 *  `codexProviderKeys`) and never lands in config.toml — empty string means
 *  "preserve the existing key" when updating; required when creating. */
export const SaveCodexProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      hint: z.string().optional(),
      /** Optional context-window override (spawned as `-c
       *  model_context_window=<n>`, process-local). */
      contextWindow: z.number().int().positive().optional(),
    }),
  ).min(1),
  /** 额外请求头，落到该 provider 的 config.toml `http_headers`。 */
  headers: z.record(z.string(), z.string()).optional(),
  /** Opt-in: unlock codex's image generation tool by injecting the
   *  `x-openai-actor-authorization` http_header into the provider's TOML
   *  table (gateway must back /v1/images/generations with gpt-image-2). */
  imageGeneration: z.boolean().optional(),
  apiKey: z.string().optional(),
});
export type SaveCodexProviderInput = z.infer<typeof SaveCodexProviderSchema>;

export const DeleteCodexProviderSchema = z.object({ id: z.string().min(1) });
export type DeleteCodexProviderInput = z.infer<typeof DeleteCodexProviderSchema>;

/* ── 端点探测：连通性测试 + 拉模型列表（三个引擎共用同一形状）──
 *  2026-10-11 加：用户要 Claude 那两个能力（「测试连接」与「列出模型」）在 Pi / Codex
 *  上也有。两者的输入都是「地址 + 密钥 + 认证头形态 + 额外头」，与引擎无关 ——
 *  所以用同一对 schema，三个引擎的 handler 都转调 `lib/modelEndpoint`。 */

export const TestEndpointSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  /** 认证头形态。缺省 = bearer（多数第三方网关）。 */
  authMode: z.enum(["bearer", "x-api-key"]).optional(),
  /** 额外请求头（与保存进配置的那份一致，测试才代表真回合）。 */
  headers: z.record(z.string(), z.string()).optional(),
  /** 要探测哪个模型。 */
  model: z.string().min(1),
  /** Anthropic 风格端点要 anthropic-version 头。 */
  anthropicVersion: z.boolean().optional(),
});
export type TestEndpointInput = z.infer<typeof TestEndpointSchema>;

export const ListEndpointModelsSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  authMode: z.enum(["bearer", "x-api-key"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  anthropicVersion: z.boolean().optional(),
});
export type ListEndpointModelsInput = z.infer<typeof ListEndpointModelsSchema>;

/** 两条探测通道的返回：`ok` + 人话的 detail/error（直接进设置页那行状态字）。 */
export interface EndpointProbeOutcome {
  ok: boolean;
  detail?: string;
  error?: string;
}

/** Cleartext apiKey getter — same security carve-out as
 *  customModel.getToken / piModels.getApiKey: settings-UI eye icon only,
 *  never a turn-time path (turn-time resolution happens inside main). */
export const GetCodexApiKeySchema = z.object({ id: z.string().min(1) });
export type GetCodexApiKeyInput = z.infer<typeof GetCodexApiKeySchema>;

/* ── 通用引擎健康检查 ── */

export const ProviderHealthCheckSchema = z.object({
  providerId: z.string().min(1),
  /** Bypass a completed cached result; an in-flight probe is still shared. */
  force: z.boolean().optional(),
});
export type ProviderHealthCheckInput = z.infer<typeof ProviderHealthCheckSchema>;

export type ProviderHealthStatusCode =
  | "ok"
  | "unavailable"
  | "not_registered"
  | "unsupported"
  | "timeout"
  | "probe_failed";

export interface ProviderHealthCheckResult {
  providerId: string;
  ok: boolean;
  code: ProviderHealthStatusCode;
  checkedAt: number;
  version?: string;
  error?: string;
}

/* ── 引擎自己的斜杠命令清单（见 rpcMap 里 `provider.commands` 的说明）── */
/**
 * 问哪个引擎要清单。`providerId` 是注册表里的 id（`"claude-sdk"` / `"codex-sdk"` /
 * `"pi-sdk"`）。
 *
 * `cwd` 是**会话跑在哪个目录** —— 清单里的技能是按目录发现的（项目技能排全局之前），
 * 所以同一个引擎在不同项目下答案不同。不给就走引擎自己的默认根。
 */
export const ProviderCommandsSchema = z.object({
  providerId: z.string().min(1),
  cwd: z.string().optional(),
});
export type ProviderCommandsInput = z.infer<typeof ProviderCommandsSchema>;

/** 一条引擎命令。形状与 `@contracts/runtime` 的 `EngineCommandInfo` 一致 ——
 *  **刻意共用同一种形状**：事件那条路（engine 中途换清单）与这条请求/应答的路
 *  喂的是同一个 store 字段，两种形状会让消费端分叉。 */
export interface ProviderCommandEntry {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

/**
 * 清单结果。
 *
 * ⚠️ **`supported: false` 与 `commands: []` 是两件事**：前者是"这个引擎的命令，
 * 在我们这条路上执行不了"（Pi / Codex 都有斜杠命令，但那些命令由它们各自的 TUI
 * 在本地解析，不经过 Mcode 走的 SDK / app-server 协议 —— 实测见各 provider 的
 * `listCommands` 注释），后者是"有，但这次一条都没取到"。界面上前者该说"这里用不了"，
 * 后者该说"还没取到" —— 混成一种会让用户以为引擎坏了。
 */
export interface ProviderCommandsResult {
  supported: boolean;
  commands: ProviderCommandEntry[];
}

