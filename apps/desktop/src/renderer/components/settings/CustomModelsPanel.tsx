import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, HintLabel, Input, Select, Switch, Tooltip } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconCheck,
  IconCopy,
  IconKey,
  IconHash,
  IconBrandOpenai,
  IconWorld,
  IconAdjustmentsHorizontal,
  IconCircleOff,
  IconArrowsExchange,
  IconPlugConnected,
  IconDownload,
} from "@renderer/lib/icons.js";
import { SiClaude, OpenAIBrandIcon, SiGoogle } from "@renderer/lib/icons.js";
import type {
  CustomModelPublic,
  CustomModelEntry,
  AuthMode,
  Protocol,
  ExtensionBridgeStatus,
} from "@contracts/customModel";
import { isValidHeaderName, isValidHeaderValue } from "@contracts/customModel";
import { copyText } from "@renderer/lib/clipboard.js";
import { PanelHeader } from "./PanelHeader.js";
import { RemoteControlPanel } from "./RemoteControlPanel.js";
import {
  PI_KNOWN_APIS,
  PI_THINKING_KEYS,
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_1M_CONTEXT_WINDOW,
  type PiProviderConfig,
  type PiProviderPublic,
  type PiModelDefinition,
  type PiThinkingKey,
} from "@contracts/piModel";
import type { CodexProviderPublic } from "@contracts/codexModel";

/**
 * Unified model-config panel — the single "模型配置" settings surface.
 *
 * Claude and Pi each get their own TAB at the top; within a tab the page is a
 * left provider list + right form:
 *   - Claude (Anthropic-compatible gateways, encrypted-token customModel store)
 *   - Pi     (writes ~/.pi/agent/models.json, encrypted apiKey in settings map)
 *
 * Selecting an item loads a family-specific form (ClaudeProviderForm /
 * PiProviderForm) on the right. The "+ Claude 端点" / "+ Pi Provider" button
 * at the list foot (of the matching tab) creates a transient new entry that
 * promotes on save / discards on cancel. Switching tabs discards any open
 * form/draft, same as the add buttons.
 *
 * Credential viewing: Token / API Key fields default to masked (password). An
 * eye-icon button fetches the cleartext via customModel.getToken /
 * piModels.getApiKey and reveals it inline — a deliberate, user-initiated
 * carve-out of the usual "cleartext never crosses IPC" rule.
 *
 * Pi context window: the UI exposes a single "1M 上下文" toggle per model
 * (off → 200k default, on → 1M), mirroring the Claude side's 1M declaration —
 * the user no longer types a raw token count.
 */

/* ════════════════════════ shared option constants ════════════════════════ */
// Static Select option catalogs carrying a per-option icon, so every dropdown
// in this panel shows a visual cue alongside the label (and in the trigger).

const AUTH_MODE_OPTIONS: { value: AuthMode; label: string; icon: ReactNode }[] = [
  { value: "auth_token", label: "Bearer", icon: <IconKey size={14} className="text-content-muted" /> },
  { value: "api_key", label: "x-api-key", icon: <IconHash size={14} className="text-content-muted" /> },
];

const PROTOCOL_OPTIONS: { value: Protocol; labelKey: MessageId; icon: ReactNode }[] = [
  {
    value: "anthropic",
    labelKey: "settings.customModels.protocolAnthropic",
    icon: <SiClaude size={14} className="text-content-muted" />,
  },
  {
    value: "openai",
    labelKey: "settings.customModels.protocolOpenai",
    icon: <IconBrandOpenai size={14} className="text-content-muted" />,
  },
  // 网页端：上游不是某个 API，而是用户自己浏览器里那个真实运行的网页版大模型
  // （由浏览器扩展桥驱动，见 main/providers/bridge/webUpstream.ts）。选它之后
  // Base URL / Token 都不再需要，改成一个站点选择 + 扩展桥配对信息。
  {
    value: "web",
    labelKey: "settings.customModels.protocolWeb",
    icon: <IconWorld size={14} className="text-content-muted" />,
  },
];

/**
 * 网页端可选站点。
 *
 * 与契约层 `WEB_SITES`（packages/contracts/src/customModel.ts）一一对应；这里
 * 额外挂一个 `defaultModelId` —— 那是渲染端自己的事（站点即模型，这个 id 只是
 * 显示名），契约层不该知道。
 *
 * `driver` 是契约层的原样转述（浏览器扩展有没有实现这个站点的驱动）：false 的
 * 站点**选得到、配置存得下**，但开跑会明确报"扩展还不支持"，所以标签后缀上
 * 标出来，不让人以为是配错了。
 */
const WEB_SITE_OPTIONS: { value: string; labelKey: MessageId; defaultModelId: string; driver: boolean }[] = [
  { value: "deepseek", labelKey: "settings.customModels.webSiteDeepseek", defaultModelId: "deepseek-web", driver: true },
  { value: "chatgpt", labelKey: "settings.customModels.webSiteChatgpt", defaultModelId: "chatgpt-web", driver: true },
];

/**
 * 网页端的「模型 id」只是个显示名 —— 站点本身就是模型（DeepSeek 网页版没有让你
 * 选模型的余地，对话页那边也用不上这个 id）。所以它有一个站点默认值：用户不填就
 * 用这个，不该把人挡在保存门外。
 */
function defaultWebModelId(siteId: string): string {
  const o = WEB_SITE_OPTIONS.find((x) => x.value === siteId);
  return o?.defaultModelId ?? WEB_SITE_OPTIONS[0].defaultModelId;
}

/** Per-API-type brand icon for the Pi "API 类型" select (label stays the raw
 *  api string, e.g. "openai-completions"). Unknown api strings get no icon. */
const PI_API_ICONS: Record<string, ReactNode> = {
  "openai-completions": <IconBrandOpenai size={14} className="text-content-muted" />,
  "openai-responses": <IconBrandOpenai size={14} className="text-content-muted" />,
  "anthropic-messages": <SiClaude size={14} className="text-content-muted" />,
  "google-generative-ai": <SiGoogle size={14} className="text-content-muted" />,
};

const THINKING_MODE_OPTIONS: { value: string; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "default", labelKey: "settings.customModels.thinkingDefault", icon: <IconAdjustmentsHorizontal size={14} className="text-content-muted" /> },
  { value: "null", labelKey: "settings.customModels.thinkingNull", icon: <IconCircleOff size={14} className="text-content-muted" /> },
  { value: "value", labelKey: "settings.customModels.thinkingValue", icon: <IconArrowsExchange size={14} className="text-content-muted" /> },
];

/* ════════════════════════ shared helpers ════════════════════════ */

/** Read-only value + copy button, for the extension-bridge address / token pair.
 *  Both are opaque strings the user has to move into the browser extension by
 *  hand, so copyable beats pretty. */
function BridgeRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-20 shrink-0 text-[0.7143em] text-content-subtle">{label}</span>
      <code
        className={cn(
          "min-w-0 flex-1 truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[0.7143em] text-content",
          !value && "text-content-subtle",
        )}
        title={value}
      >
        {value || "—"}
      </code>
      <Button variant="ghost" size="sm" disabled={!value} onClick={onCopy} className="shrink-0">
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        <span className="ml-1">
          {copied ? t("settings.customModels.bridgeCopied") : t("settings.customModels.bridgeCopy")}
        </span>
      </Button>
    </div>
  );
}

/** Labeled form field wrapper. */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[0.6428em] leading-relaxed text-content-subtle">{hint}</span>}
    </label>
  );
}

/** A credential input that defaults to masked and reveals plaintext via an
 *  eye-icon button. `onReveal` is called once on first reveal and should
 *  return the cleartext (new mode: the form value; edit mode: fetched via
 *  IPC). Subsequent clicks just toggle the masked/text type. */
function SecretInput({
  value,
  onChange,
  placeholder,
  onReveal,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onReveal: () => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    // First reveal of this mount: pull the plaintext in.
    setLoading(true);
    try {
      const plain = await onReveal();
      if (plain) {
        onChange(plain);
        setRevealed(true);
      }
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="relative">
      <Input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-7"
        spellCheck={false}
        autoComplete="off"
      />
      <Tooltip.Root>
        <Tooltip.Trigger
          type="button"
          onClick={() => void toggle()}
          disabled={loading}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-content-subtle outline-none hover:text-content"
          aria-label={revealed ? t("settings.customModels.hidePlain") : t("settings.customModels.showPlain")}
        >
          {loading ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : revealed ? (
            <IconEyeOff size={13} />
          ) : (
            <IconEye size={13} />
          )}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top">
            <Tooltip.Popup>
              {revealed ? t("settings.customModels.hidePlain") : t("settings.customModels.showPlain")}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

/* ════════════════════════ Claude form ════════════════════════ */

type TestState =
  | { status: "idle" }
  | { status: "testing"; idx: number }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

/** Select sentinel for the subagent-model "follow main session" option. The
 *  form state stores "" for that case (maps at the boundary — a bare "" would
 *  be ambiguous as a Select value). */
const SUBAGENT_FOLLOW_MAIN = "__subagent_follow_main__";

interface ClaudeModelFormState {
  /** Gateway-side model id, e.g. "deepseek-v4-pro". */
  id: string;
  supports1m: boolean;
  /** 声明该模型接受**图片输入**（用户自述，不上行）。供「视觉中继」挑眼睛用 ——
   *  与 Pi 侧的 `vision` 同一语义，只是这里只存一份声明。 */
  supportsVision: boolean;
  /** 每模型「档位 → 该网关要的值」映射（与 Pi 同一形状）。空串 = 用默认；
   *  复选框勾上但值为空 = 该档位不支持（null）。这里用 `thinking`/`thinkingValue`
   *  两个平行表，落到配置时再折算成 `{ [档位]: 值 | null }`。 */
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
}

/** One editable row of the custom-headers list. Held as rows rather than a
 *  record so a half-typed row can sit in the form while the user is editing
 *  it; {@link customHeadersFromRows} converts on save. */
interface CustomHeaderRow {
  name: string;
  value: string;
}

/** Rows → the persisted record. Rows that are entirely empty are dropped (they
 *  are just unused UI slots); a partially filled or malformed row is a hard
 *  error rather than a silent skip, so a typo can't quietly fail to be sent.
 *  Validation uses the same rule the main process applies at request time. */
function customHeadersFromRows(
  rows: CustomHeaderRow[],
): { ok: true; headers: Record<string, string> | undefined } | { ok: false } {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!isValidHeaderName(name) || !isValidHeaderValue(value)) return { ok: false };
    out[name] = value;
  }
  return { ok: true, headers: Object.keys(out).length > 0 ? out : undefined };
}

/** 把 header 行换算成探测入参：无效行在**保存**时才拦（这里只要尽力而为），
 *  所以 ok=false 或空就当作"没有额外头"。探测不该被一个待修的行卡住。 */
function endpointHeaders(rows: CustomHeaderRow[]): Record<string, string> | undefined {
  const r = customHeadersFromRows(rows);
  return r.ok ? r.headers : undefined;
}

/** 额外请求头的行编辑器 —— Claude / Pi / Codex 三个表单共用同一份（2026-10-11 统一）。
 *  从前只有 Claude 有；Pi 的 models.json 与 Codex 的 config.toml 底层本来就收 headers，
 *  只是没做界面。三处用同一个件，观感与校验才不会各长各的。 */
function HeadersEditor({
  rows,
  onChange,
}: {
  rows: CustomHeaderRow[];
  onChange: (rows: CustomHeaderRow[]) => void;
}) {
  const { t } = useI18n();
  const update = (idx: number, patch: Partial<CustomHeaderRow>) =>
    onChange(rows.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  return (
    <div className="space-y-1.5 border-t border-edge pt-2">
      <div className="flex items-center justify-between">
        <HintLabel hint={t("settings.customModels.customHeadersHint")} className="text-[0.7857em] text-content-muted">
          {t("settings.customModels.customHeadersLabel")}
        </HintLabel>
        <Button variant="ghost" size="sm" onClick={() => onChange([...rows, { name: "", value: "" }])}>
          <IconPlus size={12} />
          {t("settings.customModels.customHeadersAdd")}
        </Button>
      </div>
      {rows.map((h, idx) => (
        <div key={idx} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
          <Input
            value={h.name}
            onChange={(e) => update(idx, { name: e.target.value })}
            placeholder={t("settings.customModels.customHeadersNamePlaceholder")}
          />
          <Input
            value={h.value}
            onChange={(e) => update(idx, { value: e.target.value })}
            placeholder={t("settings.customModels.customHeadersValuePlaceholder")}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(rows.filter((_, i) => i !== idx))}
            title={t("settings.customModels.customHeadersRemove")}
          >
            <IconTrash size={13} />
          </Button>
        </div>
      ))}
    </div>
  );
}

/* ── 思考强度档位映射（三引擎共用同一形状）──
 *
 * 不同网关/引擎对同一个思考档位用的标识符不一样（A 家要 "high"、B 家要 "3"、
 * C 家要 "reasoning_high"）。Pi 早在它的 models.json 里就有这套（`thinkingLevelMap`）；
 * 2026-10-11 把同一套推广到 Claude 与 Codex 的每模型设置里。
 *
 * 表单里用两个平行表表示（与 Pi 表单一致）：`thinking[档位]` 是三态选择
 * (default / null / value)，`thinkingValue[档位]` 在选 value 时填具体字符串。
 * 落到配置时折成 `{ [档位]: 值 | null }`。 */
function defaultThinkingModes(): Record<PiThinkingKey, "default" | "null" | "value"> {
  return { off: "default", minimal: "default", low: "default", medium: "default", high: "default", xhigh: "default" };
}
function emptyThinkingValues(): Record<PiThinkingKey, string> {
  return { off: "", minimal: "", low: "", medium: "", high: "", xhigh: "" };
}

/** 从配置里的 `thinkingLevelMap` 还原成表单的两张表。 */
function thinkingFromMap(map: Record<string, string | null> | undefined): {
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
} {
  const thinking = defaultThinkingModes();
  const thinkingValue = emptyThinkingValues();
  for (const k of PI_THINKING_KEYS) {
    const v = map?.[k];
    if (v === null) thinking[k] = "null";
    else if (typeof v === "string") {
      thinking[k] = "value";
      thinkingValue[k] = v;
    }
  }
  return { thinking, thinkingValue };
}

/** 表单两张表 → 配置里的 `thinkingLevelMap`（全 default 就不写）。 */
function thinkingMapFromForm(
  thinking: Record<PiThinkingKey, "default" | "null" | "value">,
  thinkingValue: Record<PiThinkingKey, string>,
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const k of PI_THINKING_KEYS) {
    const mode = thinking[k];
    if (mode === "null") out[k] = null;
    else if (mode === "value") {
      const v = thinkingValue[k].trim();
      if (v) out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface ClaudeFormState {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  /** 仅 `protocol === "web"`：驱动哪个网页版站点（站点适配器 id）。 */
  webSiteId: string;
  authToken: string;
  /** Flat model list — mirrors the Pi form's models array. */
  models: ClaudeModelFormState[];
  /** Model id from `models` pinned for Task-tool subagents; "" = follow the
   *  main session's model (no CLAUDE_CODE_SUBAGENT_MODEL override). */
  subagentModel: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs: string;
  /** Extra request headers for the endpoint. See CustomHeaders in contracts. */
  customHeaders: CustomHeaderRow[];
}

function emptyClaudeModel(): ClaudeModelFormState {
  return { id: "", supports1m: false, supportsVision: false, thinking: defaultThinkingModes(), thinkingValue: emptyThinkingValues() };
}
function emptyClaudeForm(): ClaudeFormState {
  return {
    name: "",
    baseUrl: "",
    authMode: "auth_token",
    protocol: "anthropic",
    webSiteId: "",
    authToken: "",
    models: [],
    subagentModel: "",
    disableNonEssentialTraffic: true,
    timeoutMs: "",
    customHeaders: [],
  };
}

function claudeFormFromConfig(m: CustomModelPublic): ClaudeFormState {
  return {
    id: m.id,
    name: m.name,
    baseUrl: m.baseUrl,
    authMode: m.authMode,
    protocol: m.protocol,
    webSiteId: m.webSiteId ?? "",
    authToken: "",
    models: m.models.map((e) => ({ id: e.id, supports1m: Boolean(e.supports1m), supportsVision: Boolean(e.supportsVision), ...thinkingFromMap(e.thinkingLevelMap) })),
    subagentModel: m.subagentModel ?? "",
    disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
    timeoutMs: m.timeoutMs ? String(m.timeoutMs) : "",
    customHeaders: Object.entries(m.customHeaders ?? {}).map(([name, value]) => ({ name, value })),
  };
}

/* ════════════════════════ Pi form ════════════════════════ */

interface PiModelFormState {
  id: string;
  name: string;
  enable1m: boolean;
  maxTokens: string;
  reasoning: boolean;
  /** Whether the model accepts image input. Written to models.json as
   *  `input: ["text","image"]` / `["text"]` — the SDK defaults undeclared
   *  models to TEXT-ONLY, which makes pi-ai swap user-attached images for an
   *  "(image omitted)" placeholder before the request leaves the process. */
  vision: boolean;
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
}

interface PiFormState {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader: boolean;
  /** 额外请求头（落到 models.json 的 `headers`），与 Claude 侧同一套编辑器。 */
  customHeaders: CustomHeaderRow[];
  models: PiModelFormState[];
}

function emptyPiModel(): PiModelFormState {
  return {
    id: "",
    name: "",
    enable1m: false,
    maxTokens: "",
    reasoning: false,
    vision: true,
    thinking: {
      off: "default",
      minimal: "default",
      low: "default",
      medium: "default",
      high: "default",
      xhigh: "default",
    },
    thinkingValue: { off: "", minimal: "", low: "", medium: "", high: "", xhigh: "" },
  };
}

function emptyPiForm(): PiFormState {
  return { name: "", baseUrl: "", api: "openai-completions", apiKey: "", authHeader: false, customHeaders: [], models: [] };
}

function piModelFromDef(def: PiModelDefinition): PiModelFormState {
  const m = emptyPiModel();
  m.id = def.id ?? "";
  m.name = def.name ?? "";
  m.enable1m = typeof def.contextWindow === "number" && def.contextWindow >= PI_1M_CONTEXT_WINDOW;
  m.maxTokens = def.maxTokens ? String(def.maxTokens) : "";
  m.reasoning = def.reasoning ?? false;
  // Declared input wins; absent = the SDK's text-only default, but the form
  // still shows vision ON because the provider patches it in at turn time
  // whenever the user actually attaches an image (see PiAgentSdkProvider).
  m.vision = def.input ? def.input.includes("image") : true;
  const tlm = def.thinkingLevelMap ?? {};
  for (const k of PI_THINKING_KEYS) {
    const v = tlm[k];
    if (v === null) m.thinking[k] = "null";
    else if (typeof v === "string") {
      m.thinking[k] = "value";
      m.thinkingValue[k] = v;
    } else m.thinking[k] = "default";
  }
  return m;
}

function piFormFromConfig(name: string, cfg: PiProviderConfig): PiFormState {
  return {
    name: cfg.name ?? name,
    baseUrl: cfg.baseUrl ?? "",
    api: cfg.api ?? "openai-completions",
    apiKey: "",
    authHeader: cfg.authHeader ?? false,
    customHeaders: Object.entries(cfg.headers ?? {}).map(([n, v]) => ({ name: n, value: String(v) })),
    models: (cfg.models ?? []).map(piModelFromDef),
  };
}

/** Build the PiProviderConfig from the form (apiKey passed separately on save). */
function piConfigFromForm(form: PiFormState): PiProviderConfig {
  const models: PiModelDefinition[] = form.models
    .filter((m) => m.id.trim())
    .map((m) => {
      const def: PiModelDefinition = {
        id: m.id.trim(),
        // 1M toggle picks the context-window preset; the user no longer types it.
        contextWindow: m.enable1m ? PI_1M_CONTEXT_WINDOW : PI_DEFAULT_CONTEXT_WINDOW,
      };
      if (m.name.trim()) def.name = m.name.trim();
      const mt = Number(m.maxTokens);
      if (m.maxTokens.trim() && Number.isFinite(mt) && mt > 0) def.maxTokens = mt;
      if (m.reasoning) def.reasoning = true;
      // Always write `input` explicitly — the SDK's implicit default for
      // models.json models is text-only, which silently strips user-attached
      // images (replaced by an "(image omitted)" placeholder in the request).
      def.input = m.vision ? ["text", "image"] : ["text"];
      const tlm: NonNullable<PiModelDefinition["thinkingLevelMap"]> = {};
      let hasMap = false;
      for (const k of PI_THINKING_KEYS) {
        const mode = m.thinking[k];
        if (mode === "null") {
          tlm[k] = null;
          hasMap = true;
        } else if (mode === "value") {
          const v = m.thinkingValue[k].trim();
          if (v) {
            tlm[k] = v;
            hasMap = true;
          }
        }
      }
      if (hasMap) def.thinkingLevelMap = tlm;
      return def;
    });
  const cfg: PiProviderConfig = {};
  if (form.name.trim()) cfg.name = form.name.trim();
  if (form.baseUrl.trim()) cfg.baseUrl = form.baseUrl.trim();
  if (form.api) cfg.api = form.api;
  if (form.authHeader) cfg.authHeader = true;
  // 额外请求头：空行跳过；校验交回调用方（和 Claude 侧同一个 customHeadersFromRows）。
  const headerResult = customHeadersFromRows(form.customHeaders);
  if (headerResult.ok && headerResult.headers) cfg.headers = headerResult.headers;
  cfg.models = models;
  return cfg;
}


/* ════════════════════════ Codex form state ════════════════════════ */

interface CodexModelFormState {
  id: string;
  /** 1M context toggle (Pi-style): on → contextWindow 1,000,000, spawned as
   *  a process-local `-c model_context_window` override. */
  context1m: boolean;
}

interface CodexFormState {
  /** Slug id (TOML table key + env suffix). Locked after creation. */
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Opt-in unlock for codex's imagegen tool (actor-header injection into
   *  the provider's config.toml table). Requires a gateway backing the
   *  OpenAI images API (gpt-image-2). */
  imageGeneration: boolean;
  /** 额外请求头（落到 config.toml 的 `http_headers`）。 */
  customHeaders: CustomHeaderRow[];
  models: CodexModelFormState[];
}

const emptyCodexForm = (): CodexFormState => ({
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  imageGeneration: false,
  customHeaders: [],
  models: [{ id: "", context1m: false }],
});

const codexFormFromConfig = (cfg: CodexProviderPublic): CodexFormState => ({
  id: cfg.id,
  name: cfg.name,
  baseUrl: cfg.baseUrl,
  apiKey: "",
  imageGeneration: Boolean(cfg.imageGeneration),
  customHeaders: Object.entries(cfg.headers ?? {}).map(([n, v]) => ({ name: n, value: String(v) })),
  models: cfg.models.map((m) => ({ id: m.id, context1m: m.contextWindow === 1_000_000 })),
});

/* ════════════════════════ unified list ════════════════════════ */

type Family = "claude" | "pi" | "codex";
type Selection =
  | { kind: "claude"; id: string | "new" }
  | { kind: "pi"; id: string | "new" }
  | { kind: "codex"; id: string | "new" }
  | null;
type ListItem = { kind: Family; id: string; name: string; sub: string };

/* ════════════════════════ main panel ════════════════════════ */

export function CustomModelsPanel() {
  const { t } = useI18n();
  const customModels = useSessionStore((s) => s.customModels);
  const customModelsStoreInvalid = useSessionStore((s) => s.customModelsStoreInvalid);
  const reloadCustomModels = useSessionStore((s) => s.reloadCustomModels);

  const [tab, setTab] = useState<Family>("claude");
  const [piProviders, setPiProviders] = useState<Record<string, PiProviderPublic>>({});
  const [codexProviders, setCodexProviders] = useState<CodexProviderPublic[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [claudeForm, setClaudeForm] = useState<ClaudeFormState | null>(null);
  const [piForm, setPiForm] = useState<PiFormState | null>(null);
  const [codexForm, setCodexForm] = useState<CodexFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [pendingDelete, setPendingDelete] = useState<Selection & { id: string } | null>(null);

  const reloadPi = async () => {
    try {
      const { providers } = await api.piModels.list();
      setPiProviders(providers);
    } catch (err) {
      console.error("piModels.list failed:", err);
    }
  };

  const reloadCodex = async () => {
    try {
      const { providers } = await api.codexModels.list();
      setCodexProviders(providers);
    } catch (err) {
      console.error("codexModels.list failed:", err);
    }
  };

  useEffect(() => {
    void reloadPi();
    void reloadCodex();
  }, []);

  const listItems = useMemo<ListItem[]>(() => {
    if (tab === "codex") {
      return codexProviders.map((p) => ({
        kind: "codex" as const,
        id: p.id,
        name: p.name,
        sub: [
          p.models.length > 0
            ? t("settings.customModels.modelCount", { n: p.models.length })
            : t("settings.customModels.noModels"),
          p.hasApiKey
            ? t("settings.customModels.keyConfigured")
            : t("settings.customModels.keyNotConfigured"),
        ].join(" · "),
      }));
    }
    if (tab === "pi") {
      return Object.entries(piProviders).map(([name, cfg]) => ({
        kind: "pi" as const,
        id: name,
        name,
        sub: [
          (cfg.models?.length ?? 0) > 0
            ? t("settings.customModels.modelCount", { n: cfg.models!.length })
            : t("settings.customModels.noModels"),
          cfg.api,
          cfg.hasApiKey
            ? t("settings.customModels.keyConfigured")
            : t("settings.customModels.keyNotConfigured"),
        ].join(" · "),
      }));
    }
    return customModels.map((m) => {
      const count = m.models.filter((e) => e.id.trim()).length;
      return {
        kind: "claude" as const,
        id: m.id,
        name: m.name,
        sub: count > 0
          ? `${t("settings.customModels.modelCount", { n: count })} · ${m.authMode === "api_key" ? "x-api-key" : "Bearer"}`
          : t("settings.customModels.noModels"),
      };
    });
  }, [tab, customModels, piProviders, codexProviders, t]);

  const isSelected = (item: ListItem) =>
    selection?.kind === item.kind && selection.id === item.id;

  const startNewClaude = () => {
    setSelection({ kind: "claude", id: "new" });
    setClaudeForm(emptyClaudeForm());
    setPiForm(null);
    setCodexForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startNewPi = () => {
    setSelection({ kind: "pi", id: "new" });
    setPiForm(emptyPiForm());
    setClaudeForm(null);
    setError(null);
  };
  const startNewCodex = () => {
    setSelection({ kind: "codex", id: "new" });
    setCodexForm(emptyCodexForm());
    setClaudeForm(null);
    setPiForm(null);
    setError(null);
  };
  const startEditCodex = (id: string) => {
    const cfg = codexProviders.find((p) => p.id === id);
    if (!cfg) return;
    setSelection({ kind: "codex", id });
    setCodexForm(codexFormFromConfig(cfg));
    setClaudeForm(null);
    setPiForm(null);
    setError(null);
  };
  const startEditClaude = (m: CustomModelPublic) => {
    setSelection({ kind: "claude", id: m.id });
    setClaudeForm(claudeFormFromConfig(m));
    setPiForm(null);
    setCodexForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startEditPi = (name: string) => {
    const cfg = piProviders[name];
    if (!cfg) return;
    setSelection({ kind: "pi", id: name });
    setPiForm(piFormFromConfig(name, cfg));
    setClaudeForm(null);
    setCodexForm(null);
    setError(null);
  };
  const cancel = () => {
    setSelection(null);
    setClaudeForm(null);
    setPiForm(null);
    setCodexForm(null);
    setTest({ status: "idle" });
    setError(null);
  };

  /** Switch the Claude/Pi tab. A form (or unsaved draft) open in the OTHER
   *  tab can't keep rendering here, so it's discarded — same semantics as
   *  the per-tab "新增" buttons, which also reset the transient draft. */
  const switchTab = (next: Family) => {
    if (next === tab) return;
    setTab(next);
    cancel();
  };

  /** Fetch cleartext credential for the currently-open form. New mode returns
   *  the form value (already plaintext in the field); edit mode calls IPC. */
  const revealToken = async (): Promise<string | null> => {
    if (!selection || selection.id === "new") {
      if (selection?.kind === "claude") return claudeForm?.authToken ?? null;
      if (selection?.kind === "pi") return piForm?.apiKey ?? null;
      if (selection?.kind === "codex") return codexForm?.apiKey ?? null;
      return null;
    }
    if (selection.kind === "claude") return (await api.customModel.getToken({ id: selection.id })).token;
    if (selection.kind === "codex") return (await api.codexModels.getApiKey({ id: selection.id })).apiKey;
    return (await api.piModels.getApiKey({ name: selection.id })).apiKey;
  };

  const saveClaude = async () => {
    if (!claudeForm) return;
    // Trim + dedupe: the same id twice in one config is always a typo.
    const seen = new Set<string>();
    const models: CustomModelEntry[] = [];
    for (const m of claudeForm.models) {
      const id = m.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const tmap = thinkingMapFromForm(m.thinking, m.thinkingValue);
      models.push({
        id,
        ...(m.supports1m ? { supports1m: true } : {}),
        ...(m.supportsVision ? { supportsVision: true } : {}),
        ...(tmap ? { thinkingLevelMap: tmap } : {}),
      });
    }
    // 网页端不需要 Base URL / Token（上游是浏览器扩展在用户自己浏览器里驱动的
    // 那个页面，不是某个 API），但必须选一个站点。
    const isWeb = claudeForm.protocol === "web";
    // 名称与地址分开报错：网页端根本没有 Base URL 这一栏，合起来报会让用户
    // 对着一个不存在的输入框找半天（"保存还要填 Base URL？"）。
    if (!claudeForm.name.trim()) {
      setError(t("settings.customModels.errName"));
      return;
    }
    if (!isWeb && !claudeForm.baseUrl.trim()) {
      setError(t("settings.customModels.errBaseUrl"));
      return;
    }
    if (isWeb && !claudeForm.webSiteId) {
      setError(t("settings.customModels.errWebSite"));
      return;
    }
    // 网页端空着就补默认值：站点才是模型，这个 id 只是下拉里的显示名，没必要
    // 让用户对着"DeepSeek 该填哪个模型"卡住。
    if (isWeb && models.length === 0) {
      models.push({ id: defaultWebModelId(claudeForm.webSiteId) });
    }
    if (models.length === 0) {
      setError(t("settings.customModels.errNeedModel"));
      return;
    }
    if (!isWeb && !claudeForm.id && !claudeForm.authToken.trim()) {
      setError(t("settings.customModels.errTokenRequired"));
      return;
    }
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError(t("settings.customModels.errTimeout"));
      return;
    }
    // The pin must reference a saved model row; drop it otherwise (the store
    // re-validates, this just avoids persisting a value the UI could show as
    // selected while its model row was being removed in the same edit).
    const subagentModel =
      claudeForm.subagentModel && seen.has(claudeForm.subagentModel)
        ? claudeForm.subagentModel
        : undefined;
    const headersResult = customHeadersFromRows(claudeForm.customHeaders);
    if (!headersResult.ok) {
      setError(t("settings.customModels.errHeader"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { models: saved } = await api.customModel.save({
        id: claudeForm.id,
        name: claudeForm.name.trim(),
        baseUrl: claudeForm.baseUrl.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        // 站点 id 只在网页端有意义 —— 换成别的协议时把它清掉，免得配置里留着
        // 一个以后会被误读的残值。
        webSiteId: claudeForm.protocol === "web" ? claudeForm.webSiteId : undefined,
        authToken: claudeForm.authToken.trim() || undefined,
        models,
        subagentModel,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
        customHeaders: headersResult.headers,
      });
      useSessionStore.setState({ customModels: saved });
      const landedId = claudeForm.id ?? saved[saved.length - 1]?.id ?? null;
      setSelection(landedId ? { kind: "claude", id: landedId } : null);
      setClaudeForm(null);
      setTest({ status: "idle" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      void reloadCustomModels();
    }
  };

  const runClaudeTest = async (idx: number) => {
    if (!claudeForm) return;
    // 网页端没有端点可探 —— 它的"连通性"就是浏览器扩展有没有连上这条桥。
    if (claudeForm.protocol === "web") {
      setTest({ status: "testing", idx });
      try {
        const s = await api.webBridge.status();
        setTest(
          s.paired
            ? { status: "ok", detail: t("settings.customModels.webTestOk") }
            : { status: "fail", error: t("settings.customModels.webTestHint") },
        );
      } catch (err) {
        setTest({ status: "fail", error: (err as Error).message });
      }
      return;
    }
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError(t("settings.customModels.errTimeout"));
      return;
    }
    const entry = claudeForm.models[idx];
    const model = entry?.id.trim() ?? "";
    if (!claudeForm.baseUrl.trim() || !model) {
      setTest({ status: "fail", error: t("settings.customModels.errTestFields") });
      return;
    }
    if (!claudeForm.authToken.trim()) {
      setTest({
        status: "fail",
        error: claudeForm.id
          ? t("settings.customModels.errTestTokenEdit")
          : t("settings.customModels.errTestToken"),
      });
      return;
    }
    // Probe with the same headers a saved turn would send: an endpoint that
    // requires one would otherwise always fail its test.
    const headersResult = customHeadersFromRows(claudeForm.customHeaders);
    if (!headersResult.ok) {
      setTest({ status: "fail", error: t("settings.customModels.errHeader") });
      return;
    }
    setError(null);
    setTest({ status: "testing", idx });
    try {
      const result = await api.customModel.test({
        baseUrl: claudeForm.baseUrl.trim(),
        authToken: claudeForm.authToken.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        model,
        supports1m: entry?.supports1m ?? false,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
        customHeaders: headersResult.headers,
      });
      setTest(
        result.ok
          ? { status: "ok", detail: result.detail ?? t("settings.customModels.testOk") }
          : { status: "fail", error: result.error ?? t("settings.unknownError") },
      );
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  const savePi = async () => {
    if (!piForm) return;
    if (!piForm.name.trim()) return setError(t("settings.customModels.errProviderName"));
    if (!piForm.baseUrl.trim()) return setError(t("settings.customModels.errBaseUrl"));
    if (!piForm.api) return setError(t("settings.customModels.errApiType"));
    if (selection?.id === "new" && !piForm.apiKey.trim()) return setError(t("settings.customModels.errApiKey"));
    const valid = piForm.models.filter((m) => m.id.trim());
    if (valid.length === 0) return setError(t("settings.customModels.errNeedModel"));
    for (const m of valid) {
      if (m.maxTokens.trim()) {
        const mt = Number(m.maxTokens);
        if (!Number.isFinite(mt) || mt <= 0)
          return setError(t("settings.customModels.errMaxTokens", { id: m.id }));
      }
    }
    setSaving(true);
    setError(null);
    try {
      const cfg = piConfigFromForm(piForm);
      const { providers: next } = await api.piModels.save({
        name: piForm.name.trim(),
        config: cfg,
        apiKey: piForm.apiKey,
      });
      setPiProviders(next);
      setSelection({ kind: "pi", id: piForm.name.trim() });
      void useSessionStore.getState().reloadPiAvailableModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveCodex = async () => {
    if (!codexForm) return;
    if (!codexForm.id.trim()) return setError(t("settings.customModels.errCodexId"));
    if (!/^[a-zA-Z0-9_-]+$/.test(codexForm.id.trim()))
      return setError(t("settings.customModels.errCodexIdFormat"));
    if (!codexForm.name.trim()) return setError(t("settings.customModels.errProviderName"));
    if (!codexForm.baseUrl.trim()) return setError(t("settings.customModels.errBaseUrl"));
    const valid = codexForm.models.filter((m) => m.id.trim());
    if (valid.length === 0) return setError(t("settings.customModels.errNeedModel"));
    if (selection?.id === "new" && !codexForm.apiKey.trim())
      return setError(t("settings.customModels.errApiKey"));
    const headerResult = customHeadersFromRows(codexForm.customHeaders);
    if (!headerResult.ok) return setError(t("settings.customModels.errHeader"));
    setSaving(true);
    setError(null);
    try {
      const { providers } = await api.codexModels.save({
        id: codexForm.id.trim(),
        name: codexForm.name.trim(),
        baseUrl: codexForm.baseUrl.trim(),
        ...(codexForm.imageGeneration ? { imageGeneration: true } : {}),
        ...(headerResult.ok && headerResult.headers ? { headers: headerResult.headers } : {}),
        models: valid.map((m) => ({
          id: m.id.trim(),
          ...(m.context1m ? { contextWindow: 1_000_000 } : {}),
        })),
        apiKey: codexForm.apiKey,
      });
      setCodexProviders(providers);

      setSelection({ kind: "codex", id: codexForm.id.trim() });
      setCodexForm(null);
      void useSessionStore.getState().reloadCodexAvailableModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Pi / Codex 的「测试连接」与「从端点拉模型」—— 两者共用 `lib/modelEndpoint` 那条
   *  通道（Claude 走它自己的 `customModel.test`）。这里把「表单状态 → 探测入参」这层
   *  收口一次，两个表单都不必各自拼。 */
  const runEndpointTest = async (
    kind: "pi" | "codex",
    form: { baseUrl: string; apiKey: string; model: string; headers: Record<string, string> | undefined; authMode?: "bearer" | "x-api-key" },
  ) => {
    setError(null);
    setTest({ status: "testing", idx: 0 });
    try {
      const call = kind === "pi" ? api.piModels.test : api.codexModels.test;
      const res = await call({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        authMode: form.authMode,
        headers: form.headers,
        model: form.model,
      });
      setTest(res.ok ? { status: "ok", detail: res.detail ?? t("settings.customModels.testOk") } : { status: "fail", error: res.error ?? t("settings.unknownError") });
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  /** 问端点要模型列表，填进该表单的模型行。拉不到时**明说**（抛出的错进错误条），
   *  由界面回退到手输 —— 不静默失败。 */
  const pullEndpointModels = async (
    kind: "pi" | "codex",
    form: { baseUrl: string; apiKey: string; headers: Record<string, string> | undefined; authMode?: "bearer" | "x-api-key" },
  ): Promise<string[] | null> => {
    setError(null);
    try {
      const call = kind === "pi" ? api.piModels.listEndpointModels : api.codexModels.listEndpointModels;
      const { models } = await call({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        authMode: form.authMode,
        headers: form.headers,
      });
      if (models.length === 0) {
        setError(t("settings.customModels.listModelsEmpty"));
        return null;
      }
      return models;
    } catch (err) {
      // 端点没有这条路由是常见情形（很多第三方网关没有）—— 如实说，别装成"拉到了空"。
      setError(t("settings.customModels.listModelsFailed", { error: (err as Error).message }));
      return null;
    }
  };

  const confirmRemove = async () => {
    const target = pendingDelete;
    if (!target) return;
    try {
      if (target.kind === "claude") {
        const { models } = await api.customModel.delete({ id: target.id });
        useSessionStore.setState({ customModels: models });
      } else if (target.kind === "codex") {
        const { providers } = await api.codexModels.delete({ id: target.id });
        setCodexProviders(providers);
        void useSessionStore.getState().reloadCodexAvailableModels();
      } else {
        const { providers } = await api.piModels.delete({ name: target.id });
        setPiProviders(providers);
        void useSessionStore.getState().reloadPiAvailableModels();
      }
      if (selection?.kind === target.kind && selection.id === target.id) cancel();
    } catch (err) {
      setError((err as Error).message);
    }
    setPendingDelete(null);
  };

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col", PANEL_MAX_W.form)}>
      <PanelHeader
        className="mb-3"
        title={t("settings.customModels.title")}
      />

      {/* 密钥表损坏 —— 必须显式说出来。损坏时上面的清单会**显得比实际少**
          （读不出来的当没有），不说的话用户会以为自己的配置凭空消失了。
          同 agentSsh 的 storeInvalid 一个路子。 */}
      {customModelsStoreInvalid && (
        <div
          data-slot="store-invalid"
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[0.7857em] text-danger"
        >
          {t("settings.customModels.storeInvalid")}
        </div>
      )}

      {/* ───────── Claude / Pi family tabs ───────── */}
      <div className="mb-3 flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
        {(["claude", "pi", "codex"] as const).map((k) => {
          const count =
            k === "claude"
              ? customModels.length
              : k === "codex"
                ? codexProviders.length
                : Object.keys(piProviders).length;
          const label = k === "claude" ? "Claude" : k === "codex" ? "Codex" : "Pi";
          return (
            <button
              key={k}
              type="button"
              onClick={() => switchTab(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1 text-[0.7857em] font-medium transition-colors",
                tab === k ? "bg-surface-hover text-content" : "text-content-muted hover:text-content",
              )}
            >
              {k === "claude" ? <SiClaude size={13} className={tab === k ? "text-accent" : "text-content-subtle"} /> : null}
              {k === "codex" ? <OpenAIBrandIcon size={13} className={tab === k ? "text-accent" : "text-content-subtle"} /> : null}
              {label}
              <span className="tabular-nums text-[0.8571em] text-content-subtle">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr] gap-4">
        {/* ───────── Left: provider list (family of the active tab) ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>{t("settings.customModels.providers")}</span>
            <span className="tabular-nums">{listItems.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {listItems.map((item) => {
              const active = isSelected(item);
              return (
                <button
                  key={item.id}
                  onClick={() =>
                    item.kind === "claude"
                      ? startEditClaude(customModels.find((m) => m.id === item.id)!)
                      : item.kind === "codex"
                        ? startEditCodex(item.id)
                        : startEditPi(item.id)
                  }
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />}
                  <div className="truncate text-[0.7857em] font-medium text-content">{item.name}</div>
                  <div className="mt-0.5 truncate pl-0.5 text-[0.7143em] text-content-subtle">{item.sub}</div>
                </button>
              );
            })}
            {selection?.id === "new" && selection.kind === tab && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t(
                  tab === "pi"
                    ? "settings.customModels.newPi"
                    : tab === "codex"
                      ? "settings.customModels.newCodex"
                      : "settings.customModels.newClaude",
                )}
              </div>
            )}
            {listItems.length === 0 && !(selection?.id === "new" && selection.kind === tab) && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.customModels.emptyProviders")}
              </div>
            )}
          </nav>
          <div className="border-t border-edge p-1.5">
            {tab === "claude" ? (
              <Button variant="outline" size="sm" onClick={startNewClaude} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addClaude")}
              </Button>
            ) : tab === "codex" ? (
              <Button variant="outline" size="sm" onClick={startNewCodex} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addCodex")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={startNewPi} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addPi")}
              </Button>
            )}
          </div>
        </aside>

        {/* ───────── Right: family-specific form ───────── */}
        <div className="min-h-0 overflow-y-auto rounded-md border border-edge bg-surface/40 p-3">
          {selection?.kind === "claude" && claudeForm ? (
            <ClaudeProviderForm
              key={`claude:${claudeForm.id ?? "new"}`}
              form={claudeForm}
              setForm={setClaudeForm}
              test={test}
              saving={saving}
              error={error}
              revealToken={revealToken}
              onTest={(idx) => void runClaudeTest(idx)}
              onSave={() => void saveClaude()}
              onCancel={cancel}
              onDelete={claudeForm.id ? () => setPendingDelete({ kind: "claude", id: claudeForm.id! }) : undefined}
              onError={setError}
            />
          ) : selection?.kind === "codex" && codexForm ? (
            <CodexProviderForm
              key={`codex:${selection.id}`}
              form={codexForm}
              setForm={setCodexForm}
              saving={saving}
              error={error}
              test={test}
              revealToken={revealToken}
              isEdit={selection.id !== "new"}
              onTest={(idx) => void runEndpointTest("codex", {
                baseUrl: codexForm.baseUrl, apiKey: codexForm.apiKey,
                model: codexForm.models[idx]?.id ?? "",
                headers: endpointHeaders(codexForm.customHeaders),
              })}
              onPullModels={async () => {
                const models = await pullEndpointModels("codex", {
                  baseUrl: codexForm.baseUrl, apiKey: codexForm.apiKey,
                  headers: endpointHeaders(codexForm.customHeaders),
                });
                if (models) setCodexForm({ ...codexForm, models: models.map((id) => ({ id, context1m: false })) });
              }}
              onSave={() => void saveCodex()}
              onCancel={cancel}
              onDelete={selection.id !== "new" ? () => setPendingDelete({ kind: "codex", id: selection.id }) : undefined}
            />
          ) : selection?.kind === "pi" && piForm ? (
            <PiProviderForm
              key={`pi:${selection.id}`}
              form={piForm}
              setForm={setPiForm}
              saving={saving}
              error={error}
              test={test}
              revealToken={revealToken}
              isEdit={selection.id !== "new"}
              onTest={(idx) => void runEndpointTest("pi", {
                baseUrl: piForm.baseUrl, apiKey: piForm.apiKey,
                model: piForm.models[idx]?.id ?? "",
                headers: endpointHeaders(piForm.customHeaders),
                // Pi 的 authHeader 开关即「加不加 Bearer」；关了就走 x-api-key。
                authMode: piForm.authHeader ? "bearer" : "x-api-key",
              })}
              onPullModels={async () => {
                const models = await pullEndpointModels("pi", {
                  baseUrl: piForm.baseUrl, apiKey: piForm.apiKey,
                  headers: endpointHeaders(piForm.customHeaders),
                  authMode: piForm.authHeader ? "bearer" : "x-api-key",
                });
                if (models) setPiForm({ ...piForm, models: models.map((id) => ({ ...emptyPiModel(), id })) });
              }}
              onSave={() => void savePi()}
              onCancel={cancel}
              onDelete={selection.id !== "new" ? () => setPendingDelete({ kind: "pi", id: selection.id }) : undefined}
            />
          ) : (
            // **没选中供应商时,右边放「远程控制」面板** —— 不是一块空白占位。
            //
            // 这块地方跟"选中哪个模型端点"完全无关,所以放它正合适:用户点开模型配置
            // 页就能看见"网页端能不能操作我这台机器",不必先随便选一个供应商才能找到。
            // 见 `RemoteControlPanel` 的文件头(为什么它不该待在引擎表单里)。
            <RemoteControlPanel onError={setError} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title={t(
          pendingDelete?.kind === "pi"
            ? "settings.customModels.deletePiTitle"
            : pendingDelete?.kind === "codex"
              ? "settings.customModels.deleteCodexTitle"
              : "settings.customModels.deleteClaudeTitle",
        )}
        description={
          pendingDelete?.kind === "codex" ? (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete.id}</code>
              {t("settings.customModels.deleteCodexPost")}
            </>
          ) : pendingDelete?.kind === "pi" ? (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete.id}</code>
              {t("settings.customModels.deletePiPost")}
            </>
          ) : (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete?.id}</code>
              {t("settings.customModels.deleteClaudePost")}
            </>
          )
        }
        confirmText={t("common.delete")}
        danger
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}


/* ════════════════════════ Codex provider form ════════════════════════ */

function CodexProviderForm({
  form,
  setForm,
  saving,
  error,
  test,
  revealToken,
  isEdit,
  onTest,
  onPullModels,
  onSave,
  onCancel,
  onDelete,
}: {
  form: CodexFormState;
  setForm: (f: CodexFormState | null) => void;
  saving: boolean;
  error: string | null;
  test: TestState;
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onTest: (idx: number) => void;
  onPullModels: () => void | Promise<void>;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    try {
      await onPullModels();
    } finally {
      setPulling(false);
    }
  };
  const update = <K extends keyof CodexFormState>(key: K, value: CodexFormState[K]) =>
    setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<CodexModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, { id: "", context1m: false }] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <ProviderFormShell
      engine="codex"
      name={
        <Field label={t("settings.customModels.providerNameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="DeepSeek" />
        </Field>
      }
      identity={
        <Field label={t("settings.customModels.codexIdLabel")} hint={t("settings.customModels.codexIdHint")}>
          <Input
            value={form.id}
            onChange={(e) => update("id", e.target.value)}
            disabled={isEdit}
            placeholder="deepseek"
          />
        </Field>
      }
      baseUrl={
        <Field label={t("settings.customModels.baseUrlLabel")} hint={t("settings.customModels.codexResponsesNote")}>
          <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/v1" />
        </Field>
      }
      credential={
        <Field label={t("settings.customModels.apiKeyLabel")} hint={t("settings.customModels.apiKeyHint")}>
          <SecretInput
            value={form.apiKey}
            onChange={(v) => update("apiKey", v)}
            placeholder={isEdit ? t("settings.customModels.apiKeyKeepPlaceholder") : "sk-..."}
            onReveal={revealToken}
          />
        </Field>
      }
      headers={
        <HeadersEditor rows={form.customHeaders} onChange={(rows) => update("customHeaders", rows)} />
      }
      pull={
        <EndpointActionRow
          icon={<IconDownload size={12} />}
          label={t("settings.customModels.pullModels")}
          hint={form.baseUrl.trim() ? t("settings.customModels.pullModelsHint") : t("settings.customModels.pullModelsNeedUrl")}
          disabled={pulling || !form.baseUrl.trim()}
          busy={pulling}
          onClick={() => void pull()}
        />
      }
      models={
        <ModelListSection
          count={form.models.filter((m) => m.id.trim()).length}
          onAdd={addModel}
          isEmpty={form.models.length === 0}
        >
          {form.models.map((m, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5 rounded border border-edge bg-surface/40 p-2">
              <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder={t("settings.customModels.modelIdPlaceholder")} />
              <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.enable1m")}>
                <Switch checked={m.context1m} onCheckedChange={(v) => updateModel(idx, { context1m: v })} label={t("settings.customModels.enable1m")} />
                <span className="text-[0.6428em] text-content-muted">1M</span>
              </label>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onTest(idx)}
                disabled={test.status === "testing"}
                title={t("settings.customModels.testWithModel")}
              >
                {test.status === "testing" && test.idx === idx
                  ? <IconLoader2 size={12} className="animate-spin" />
                  : <IconPlugConnected size={12} />}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                <IconTrash size={12} />
              </Button>
            </div>
          ))}
        </ModelListSection>
      }
      // Codex 特有：图片生成开关（往 config.toml 的 http_headers 补一条 actor 头，
      // 解锁 codex 的 imagegen 工具）。默认折叠 —— 它是可选的解锁项，不是必填。
      advanced={
        <div className="flex items-start justify-between gap-3 rounded border border-edge bg-surface/40 p-2.5">
          <HintLabel hint={t("settings.customModels.imageGenHint")} className="text-[0.7857em] font-medium text-content">
            {t("settings.customModels.imageGen")}
          </HintLabel>
          <Switch
            checked={form.imageGeneration}
            onCheckedChange={(v) => update("imageGeneration", v)}
            label={t("settings.customModels.imageGen")}
          />
        </div>
      }
      error={error}
      actions={
        <FormActions
          testStatus={test}
          onDelete={onDelete}
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
          isEdit={isEdit}
        />
      }
    />
  );
}

/* ════════════════════════ Claude provider form ════════════════════════ */

function ClaudeProviderForm({
  form,
  setForm,
  test,
  saving,
  error,
  revealToken,
  onTest,
  onSave,
  onCancel,
  onDelete,
  onError,
}: {
  form: ClaudeFormState;
  setForm: (f: ClaudeFormState | null) => void;
  test: TestState;
  saving: boolean;
  error: string | null;
  revealToken: () => Promise<string | null>;
  onTest: (idx: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  /** 上报一条错误给父组件的统一错误条 —— 表单内部的按钮（重新生成令牌）
   *  失败了也得让人看见，而错误条归父组件所有。 */
  onError: (message: string) => void;
}) {
  const isEdit = !!form.id;
  const isOpenAi = form.protocol === "openai";
  const isWeb = form.protocol === "web";
  const { t } = useI18n();
  /** 展开哪个模型行看它的思考强度映射（与 Pi 表单同一个交互）。 */
  const [thinkingOpen, setThinkingOpen] = useState<number | null>(null);
  /** 「测试连接」用列表里第一个填了 id 的模型去探；没有就落在第 0 行（由 runClaudeTest 报错）。 */
  const firstModelIdx = form.models.findIndex((m) => m.id.trim());
  // 扩展桥配对信息：只在网页端需要。5s 轮询一次 —— "配上了"这件事发生在另一个
  // 程序里（用户在浏览器里装扩展），主进程没有事件可推，只能问。
  const [bridge, setBridge] = useState<ExtensionBridgeStatus | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  useEffect(() => {
    if (!isWeb) return;
    let alive = true;
    const poll = () => {
      api.webBridge
        .status()
        .then((s) => {
          if (alive) setBridge(s);
        })
        .catch(() => {
          /* 主进程还没就绪 / 设置页正在关 —— 徽章保持上次的值就好 */
        });
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [isWeb]);
  const copy = async (key: string, value: string) => {
    if (await copyText(value)) {
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };
  const regenerate = async () => {
    setRegenerating(true);
    try {
      setBridge(await api.webBridge.regenerateToken());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setRegenerating(false);
    }
  };

  const update = <K extends keyof ClaudeFormState>(key: K, value: ClaudeFormState[K]) =>
    setForm({ ...form, [key]: value });

  const updateModel = (idx: number, patch: Partial<ClaudeModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, emptyClaudeModel()] });
  const removeModel = (idx: number) =>
    setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <ProviderFormShell
      engine="claude"
      // 顶部一行：名称 + 协议（引擎标识）。名称在前，三页一致。
      name={
        <Field label={t("settings.customModels.nameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder={t("settings.customModels.namePlaceholder")} />
        </Field>
      }
      identity={
        <Field
          label={t("settings.customModels.protocolLabel")}
          hint={isOpenAi ? t("settings.customModels.openaiNote") : undefined}
        >
          <Select.Root
            value={form.protocol}
            onValueChange={(v) => {
              const next = v as Protocol;
              // 切到网页端时顺手补一条模型 id：站点才是模型，这个 id 只是个显示名，
              // 让用户对着空列表琢磨"DeepSeek 该填哪个模型"没有意义（保存时也会补）。
              if (next === "web" && form.models.every((m) => !m.id.trim())) {
                setForm({
                  ...form,
                  protocol: next,
                  models: [{ id: defaultWebModelId(form.webSiteId), supports1m: false, supportsVision: false, thinking: defaultThinkingModes(), thinkingValue: emptyThinkingValues() }],
                });
                return;
              }
              update("protocol", next);
            }}
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: Protocol) => {
                  const o = PROTOCOL_OPTIONS.find((x) => x.value === val) ?? PROTOCOL_OPTIONS[0];
                  return <span className="flex items-center gap-1.5">{o.icon}{t(o.labelKey)}</span>;
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {PROTOCOL_OPTIONS.map((o) => (
                <Select.Item key={o.value} value={o.value}>
                  {o.icon}
                  <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      }
      // 网页端没有 Base URL / Token / 认证方式 —— 上游是浏览器扩展在用户自己浏览器里
      // 驱动的那个页面，不是 API。这几格在这个协议下整块不渲染（站点选择与扩展桥信息
      // 收进高级区）。
      baseUrl={
        !isWeb ? (
          <Field label={t("settings.customModels.baseUrlLabel")}>
            <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder={isOpenAi ? "https://api.openai.com/v1" : "https://api.deepseek.com/anthropic"} />
          </Field>
        ) : undefined
      }
      credential={
        !isWeb ? (
          <Field label={t("settings.customModels.authTokenLabel")}>
            <SecretInput
              value={form.authToken}
              onChange={(v) => update("authToken", v)}
              placeholder={isEdit ? t("settings.customModels.tokenKeepPlaceholder") : "sk-..."}
              onReveal={revealToken}
            />
          </Field>
        ) : undefined
      }
      auth={
        !isWeb ? (
          <Field label={t("settings.customModels.authLabel")}>
            <Select.Root value={form.authMode} onValueChange={(v) => update("authMode", v as AuthMode)}>
              <Select.Trigger className="w-full">
                <Select.Value>
                  {(val: AuthMode) => {
                    const o = AUTH_MODE_OPTIONS.find((x) => x.value === val) ?? AUTH_MODE_OPTIONS[0];
                    return <span className="flex items-center gap-1.5">{o.icon}{o.label}</span>;
                  }}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                {AUTH_MODE_OPTIONS.map((o) => (
                  <Select.Item key={o.value} value={o.value}>
                    {o.icon}
                    <Select.ItemText>{o.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List></Select.Popup></Select.Positioner></Select.Portal>
            </Select.Root>
          </Field>
        ) : undefined
      }
      // 请求头与「测连接」现在落在**通用位置**（2026-10-11 统一）。从前 Claude 把请求头
      // 塞在高级区里，位置和 Pi / Codex 不一样。
      //
      // Claude 的自定义端点没有可列举的 /models 路由，所以这一格用「测试连接」代替
      // 「从端点拉模型」——同一个 `EndpointActionRow` 外壳、同一个位置，只是按钮语义不同。
      headers={
        !isWeb ? (
          <HeadersEditor
            rows={form.customHeaders}
            onChange={(rows) => update("customHeaders", rows)}
          />
        ) : undefined
      }
      pull={
        !isWeb ? (
          <EndpointActionRow
            icon={<IconPlugConnected size={12} />}
            label={t("settings.customModels.testConnection")}
            hint={
              form.models.some((m) => m.id.trim())
                ? t("settings.customModels.testConnectionHint")
                : t("settings.customModels.testConnectionNeedModel")
            }
            disabled={test.status === "testing"}
            busy={test.status === "testing"}
            onClick={() => onTest(firstModelIdx >= 0 ? firstModelIdx : 0)}
          />
        ) : undefined
      }
      models={
        <ModelListSection
          count={form.models.filter((m) => m.id.trim()).length}
          onAdd={addModel}
          isEmpty={form.models.length === 0}
        >
          {form.models.map((m, idx) => {
            const testingThis = test.status === "testing" && test.idx === idx;
            return (
              <div key={idx} className="rounded border border-edge bg-surface/40 p-2">
                <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-1.5">
                  <Input
                    value={m.id}
                    onChange={(e) => updateModel(idx, { id: e.target.value })}
                    placeholder={t(
                      isWeb
                        ? "settings.customModels.modelIdPlaceholderWeb"
                        : "settings.customModels.modelIdPlaceholder",
                    )}
                    spellCheck={false}
                  />
                  <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.supports1mLabel")}>
                    <Switch checked={m.supports1m} onCheckedChange={(v) => updateModel(idx, { supports1m: v })} label={t("settings.customModels.supports1mLabel")} />
                    <span className="text-[0.6428em] text-content-muted">1M</span>
                  </label>
                  {/* 声明这个模型能读图 —— 供「视觉中继」挑眼睛（与 Pi 表单同一开关、同一 i18n key）。 */}
                  <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.visionLabel")}>
                    <Switch checked={m.supportsVision} onCheckedChange={(v) => updateModel(idx, { supportsVision: v })} label={t("settings.customModels.visionLabel")} />
                    <span className="text-[0.6428em] text-content-muted">{t("settings.customModels.visionSpan")}</span>
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onTest(idx)}
                    disabled={test.status === "testing"}
                    title={t("settings.customModels.testWithModel")}
                  >
                    {testingThis ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlugConnected size={12} />}
                  </Button>
                  {/* 展开看这个模型的思考强度档位映射（与 Pi 同一交互）。 */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setThinkingOpen(thinkingOpen === idx ? null : idx)}
                    title={t("settings.customModels.thinkingMapEdit")}
                  >
                    {thinkingOpen === idx ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                    <IconTrash size={12} />
                  </Button>
                </div>
                {thinkingOpen === idx && (
                  <ThinkingMapEditor
                    thinking={m.thinking}
                    thinkingValue={m.thinkingValue}
                    onChange={(patch) => updateModel(idx, patch)}
                  />
                )}
              </div>
            );
          })}
        </ModelListSection>
      }
      // 高级区：网页端站点/扩展桥 + 子代理模型固定 + 超时 + 禁用遥测。全是 Claude 特有。
      advanced={
        <>
          {isWeb && (
            <>
              <Field label={t("settings.customModels.webSiteLabel")}>
                <Select.Root value={form.webSiteId} onValueChange={(v) => update("webSiteId", v as string)}>
                  <Select.Trigger className="w-full">
                    <Select.Value>
                      {(val: string) => {
                        const o = WEB_SITE_OPTIONS.find((x) => x.value === val);
                        return (
                          <span>
                            {o ? t(o.labelKey) : t("settings.customModels.webSitePlaceholder")}
                          </span>
                        );
                      }}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                    {WEB_SITE_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        <Select.ItemText>
                          {o.driver
                            ? t(o.labelKey)
                            : `${t(o.labelKey)} ${t("settings.customModels.webSiteDriverPending")}`}
                        </Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                </Select.Root>
                {/* 驱动没实现的站点：说清"能配但不能跑"，并把原因指到扩展那边 ——
                    否则用户会以为是 mcode 这里配坏了。 */}
                {!WEB_SITE_OPTIONS.find((o) => o.value === form.webSiteId)?.driver && (
                  <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
                    {t("settings.customModels.webSiteDriverPendingHint")}
                  </p>
                )}
              </Field>

              <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2.5">
                <div className="flex items-center gap-1.5">
                  <HintLabel hint={t("settings.customModels.bridgeHint")} className="text-[0.7857em] font-medium text-content-muted">
                    {t("settings.customModels.bridgeTitle")}
                  </HintLabel>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[0.7143em]",
                      bridge?.paired ? "bg-accent/15 text-accent" : "bg-surface-muted text-content-subtle",
                    )}
                  >
                    {bridge?.paired
                      ? t("settings.customModels.bridgePaired")
                      : t("settings.customModels.bridgeUnpaired")}
                  </span>
                </div>

                <BridgeRow
                  label={t("settings.customModels.bridgeUrlLabel")}
                  value={bridge?.url ?? ""}
                  copied={copied === "url"}
                  onCopy={() => bridge && void copy("url", bridge.url)}
                />
                <BridgeRow
                  label={t("settings.customModels.bridgeTokenLabel")}
                  value={bridge?.token ?? ""}
                  copied={copied === "token"}
                  onCopy={() => bridge && void copy("token", bridge.token)}
                />

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-0.5"
                  disabled={regenerating}
                  onClick={() => void regenerate()}
                >
                  {regenerating ? (
                    <IconLoader2 size={13} className="mr-1 animate-spin" />
                  ) : (
                    <IconPlugConnected size={13} className="mr-1" />
                  )}
                  {t("settings.customModels.bridgeRegenerate")}
                </Button>

                <p className="text-[0.6428em] leading-relaxed text-content-subtle">
                  {t("settings.customModels.webNote")}
                </p>
              </div>
            </>
          )}

          {/* Subagent-model pin — a per-config setting: Claude sessions running
              on THIS provider route Task-tool subagents through the picked model
              (CLAUDE_CODE_SUBAGENT_MODEL). "" = follow the main session's model.
              Options come from the model rows above, so a pin whose row was
              deleted in this edit simply disappears from the list and is dropped
              on save. */}
          <Field label={t("settings.subagentModel.select")} hint={t("settings.subagentModel.hint")}>
            <Select.Root
              value={form.subagentModel || SUBAGENT_FOLLOW_MAIN}
              onValueChange={(v) => update("subagentModel", v === SUBAGENT_FOLLOW_MAIN ? "" : (v as string))}
            >
              <Select.Trigger className="w-full">
                <Select.Value>
                  {(val: string | null) => (
                    <span
                      className={cn(
                        "flex items-center",
                        (!val || val === SUBAGENT_FOLLOW_MAIN) && "text-content-subtle",
                      )}
                    >
                      {val && val !== SUBAGENT_FOLLOW_MAIN
                        ? val
                        : t("settings.subagentModel.follow")}
                    </span>
                  )}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                <Select.Item value={SUBAGENT_FOLLOW_MAIN}>
                  <Select.ItemText>{t("settings.subagentModel.follow")}</Select.ItemText>
                </Select.Item>
                {form.models.filter((m) => m.id.trim()).map((m) => (
                  <Select.Item key={m.id.trim()} value={m.id.trim()}>
                    <Select.ItemText>{m.id.trim()}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List></Select.Popup></Select.Positioner></Select.Portal>
            </Select.Root>
          </Field>

          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label={t("settings.customModels.timeoutLabel")}>
              <Input value={form.timeoutMs} onChange={(e) => update("timeoutMs", e.target.value)} placeholder="3000000" />
            </Field>
            <label className="flex items-end gap-1.5 pb-1 text-[0.7857em] text-content-muted">
              <input type="checkbox" checked={form.disableNonEssentialTraffic} onChange={(e) => update("disableNonEssentialTraffic", e.target.checked)} className="accent-accent" />
              {t("settings.customModels.disableTelemetry")}
            </label>
          </div>
        </>
      }
      // Open by default when anything inside it is already configured, so an
      // existing value is never hidden behind a collapsed section (子代理模型 / 超时
      // 已有值,或网页端 —— 站点选择是必填、扩展桥是这块唯一能连上的凭据)。请求头
      // 现在住在通用区、不在这里,所以不再据它判断。
      advancedDefaultOpen={isWeb || Boolean(form.timeoutMs) || Boolean(form.subagentModel)}
      error={error}
      actions={
        <FormActions
          testStatus={test}
          onDelete={onDelete}
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
          isEdit={isEdit}
        />
      }
    />
  );
}

/* ════════════════════════ Pi provider form ════════════════════════ */

function PiProviderForm({
  form,
  setForm,
  saving,
  error,
  test,
  revealToken,
  isEdit,
  onTest,
  onPullModels,
  onSave,
  onCancel,
  onDelete,
}: {
  form: PiFormState;
  setForm: (f: PiFormState | null) => void;
  saving: boolean;
  error: string | null;
  test: TestState;
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onTest: (idx: number) => void;
  onPullModels: () => void | Promise<void>;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [expandedModel, setExpandedModel] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    try {
      await onPullModels();
    } finally {
      setPulling(false);
    }
  };

  const update = <K extends keyof PiFormState>(key: K, value: PiFormState[K]) => setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<PiModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, emptyPiModel()] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <ProviderFormShell
      engine="pi"
      name={
        <Field label={t("settings.customModels.providerNameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="deepseek" />
        </Field>
      }
      identity={
        <Field label={t("settings.customModels.apiTypeLabel")}>
          <Select.Root value={form.api} onValueChange={(v) => update("api", String(v))}>
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string) => (
                  <span className="flex items-center gap-1.5">
                    {PI_API_ICONS[val]}
                    {val}
                  </span>
                )}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {PI_KNOWN_APIS.map((a) => (
                <Select.Item key={a} value={a}>
                  {PI_API_ICONS[a]}
                  <Select.ItemText>{a}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      }
      baseUrl={
        <Field label={t("settings.customModels.baseUrlLabel")}>
          <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.deepseek.com" />
        </Field>
      }
      credential={
        <Field label={t("settings.customModels.apiKeyLabel")} hint={t("settings.customModels.apiKeyHint")}>
          <SecretInput
            value={form.apiKey}
            onChange={(v) => update("apiKey", v)}
            placeholder={isEdit ? t("settings.customModels.apiKeyKeepPlaceholder") : "sk-..."}
            onReveal={revealToken}
          />
        </Field>
      }
      auth={
        <div className="flex items-center gap-2">
          <Switch checked={form.authHeader} onCheckedChange={(v) => update("authHeader", v)} label={t("settings.customModels.authHeaderLabel")} />
          <span className="text-[0.7857em] text-content-muted">{t("settings.customModels.authHeaderSpan")}</span>
        </div>
      }
      headers={<HeadersEditor rows={form.customHeaders} onChange={(rows) => update("customHeaders", rows)} />}
      pull={
        <EndpointActionRow
          icon={<IconDownload size={12} />}
          label={t("settings.customModels.pullModels")}
          hint={form.baseUrl.trim() ? t("settings.customModels.pullModelsHint") : t("settings.customModels.pullModelsNeedUrl")}
          disabled={pulling || !form.baseUrl.trim()}
          busy={pulling}
          onClick={() => void pull()}
        />
      }
      models={
        <ModelListSection
          count={form.models.filter((m) => m.id.trim()).length}
          onAdd={addModel}
          isEmpty={form.models.length === 0}
        >
          {form.models.map((m, idx) => (
            <div key={idx} className="rounded border border-edge bg-surface/40 p-2">
              <div className="grid grid-cols-[1fr_90px_70px_auto] items-center gap-1.5">
                <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder={t("settings.customModels.modelIdPlaceholder")} />
                <Input value={m.maxTokens} onChange={(e) => updateModel(idx, { maxTokens: e.target.value })} placeholder={t("settings.customModels.maxTokensPlaceholder")} title={t("settings.customModels.maxTokensTitle")} />
                <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.enable1m")}>
                  <Switch checked={m.enable1m} onCheckedChange={(v) => updateModel(idx, { enable1m: v })} label={t("settings.customModels.enable1m")} />
                  <span className="text-[0.6428em] text-content-muted">1M</span>
                </label>
                <span className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onTest(idx)}
                      disabled={test.status === "testing"}
                      title={t("settings.customModels.testWithModel")}
                    >
                      {test.status === "testing" && test.idx === idx
                        ? <IconLoader2 size={12} className="animate-spin" />
                        : <IconPlugConnected size={12} />}
                    </Button>
                    <button type="button" onClick={() => setExpandedModel(expandedModel === idx ? null : idx)} className="rounded p-0.5 text-content-muted hover:bg-surface-hover" title={expandedModel === idx ? t("settings.customModels.collapse") : t("settings.customModels.expandModel")}>
                      {expandedModel === idx ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                    </button>
                    <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                      <IconTrash size={12} />
                    </Button>
                  </span>
                </div>
                {expandedModel === idx && (
                  <div className="mt-2 space-y-2 border-t border-edge/60 pt-1.5">
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5">
                        <Switch checked={m.reasoning} onCheckedChange={(v) => updateModel(idx, { reasoning: v })} label={t("settings.customModels.reasoningLabel")} />
                        <span className="text-[0.7143em] text-content-muted">{t("settings.customModels.reasoningSpan")}</span>
                      </label>
                      <label className="flex items-center gap-1.5" title={t("settings.customModels.visionLabel")}>
                        <Switch checked={m.vision} onCheckedChange={(v) => updateModel(idx, { vision: v })} label={t("settings.customModels.visionLabel")} />
                        <span className="text-[0.7143em] text-content-muted">{t("settings.customModels.visionSpan")}</span>
                      </label>
                      <Field label={t("settings.customModels.displayNameLabel")}>
                        <Input value={m.name} onChange={(e) => updateModel(idx, { name: e.target.value })} placeholder={t("settings.customModels.displayNamePlaceholder")} />
                      </Field>
                    </div>
                    <ThinkingMapEditor
                      thinking={m.thinking}
                      thinkingValue={m.thinkingValue}
                      onChange={(patch) => updateModel(idx, patch)}
                    />
                  </div>
                )}
            </div>
          ))}
        </ModelListSection>
      }
      // Pi 没有任何 provider 级的引擎特有字段 —— 它的引擎特有项（推理 / 图片输入 /
      // 显示名 / 思考级别映射）都是**逐模型**的，住在每个模型行的「展开」按钮里。
      // 这一区照旧渲染（三页观感一致），内容只说清这件事，不硬塞一个假字段。
      advanced={
        <p className="text-[0.715em] leading-relaxed text-content-subtle">
          {t("settings.customModels.piAdvancedHint")}
        </p>
      }
      error={error}
      actions={
        <FormActions
          testStatus={test}
          onDelete={onDelete}
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
          isEdit={isEdit}
        />
      }
    />
  );
}

/* ════════════════════════ shared action bar ════════════════════════ */

/** 模型列表的共同外壳：标题带条数 + 「添加模型」+ 空状态 + 行容器。
 *
 *  三个引擎的行内容不一样（各自带 1M / maxTokens / 思考映射 那些开关），但**这一圈
 *  是逐字相同的** —— 抽出来保证三页的观感与文案不会各长各的（2026-10-11 统一）。
 *  从前这段在三个表单里各抄了一份。 */
function ModelListSection({
  count,
  onAdd,
  isEmpty,
  children,
}: {
  count: number;
  onAdd: () => void;
  isEmpty: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[0.7857em] font-medium text-content-muted">
          {t("settings.customModels.modelListTitle", { n: count })}
        </span>
        <button type="button" onClick={onAdd} className="flex items-center gap-1 text-[0.7857em] text-accent hover:text-accent/80">
          <IconPlus size={11} /> {t("settings.customModels.addModel")}
        </button>
      </div>
      {isEmpty && (
        <p className="rounded border border-dashed border-edge px-2 py-3 text-center text-[0.7143em] text-content-subtle">
          {t("settings.customModels.modelsEmpty")}
        </p>
      )}
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** 「从端点拉取模型 / 测试连接」那一行 —— 三个引擎在**同一个外壳槽位**里各放一个（2026-10-11 统一）。
 *
 *  Pi / Codex 的自定义端点支持列模型（`listEndpointModels`），这一格是「问端点要模型列表」；
 *  Claude 的自定义端点只有逐模型探测（`customModel.test`）、没有可列举的 `/models` 路由，
 *  所以同一格换成「测试连接」——**位置相同、外壳相同**，只是按钮语义不同。按钮文字/图标/禁用
 *  条件由调用方给，外壳只保证这一行在三页里落在同一处。 */
function EndpointActionRow({
  icon,
  label,
  hint,
  disabled,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
        {busy ? <IconLoader2 size={12} className="mr-1 animate-spin" /> : <span className="mr-1">{icon}</span>}
        {label}
      </Button>
      <span className="text-[0.7143em] text-content-subtle">{hint}</span>
    </div>
  );
}

/** 三个引擎表单的**共享外壳** —— 骨架与顺序归它，各引擎只声明「这一格放什么」（2026-10-11 真正统一）。
 *
 *  期望的固定顺序（三处逐格相同，`data-slot` 就是给回归断言的锚点）：
 *    顶部一行(名称 + 引擎标识) → Base URL → 密钥/Token → 认证方式 → 请求头 →
 *    从端点拉模型/测试连接 → 模型列表 → 高级折叠(引擎特有) → 错误条 → 操作栏
 *
 *  从前这三个 tab「看起来没变」的根因是：上一轮只抽了子控件（ModelListSection / FormActions /
 *  HeadersEditor），**每个 tab 仍自己排字段顺序**，而且只有 Claude 有高级折叠区。现在顺序由
 *  这一个组件保证 —— 谁想把某一格挪回旧样，`custom-models-ui-smoke` 的顺序断言就会变红。
 *
 *  高级折叠区：必填或已有值的字段不能藏进去让人看不见（Claude 原有的规矩），所以默认展开与否
 *  由 `advancedDefaultOpen` 决定，各引擎按「里面有没有已配置的值」自己算。 */
function ProviderFormShell({
  engine,
  name,
  identity,
  baseUrl,
  credential,
  auth,
  headers,
  pull,
  models,
  advanced,
  advancedDefaultOpen,
  error,
  actions,
}: {
  /** 引擎标识，写成 `data-provider-form` 供 UI 回归定位该表单。 */
  engine: "claude" | "pi" | "codex";
  name: ReactNode;
  identity: ReactNode;
  baseUrl?: ReactNode;
  credential?: ReactNode;
  auth?: ReactNode;
  headers?: ReactNode;
  pull?: ReactNode;
  models: ReactNode;
  advanced?: ReactNode;
  advancedDefaultOpen?: boolean;
  error?: string | null;
  actions: ReactNode;
}) {
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(advancedDefaultOpen));
  return (
    <div className="space-y-2.5" data-provider-form={engine}>
      {/* 顶部一行：名称 + 该引擎的「标识/类型」字段。名称在前、标识在后，三页一致。 */}
      <div className="grid grid-cols-2 gap-2" data-slot="top">
        <div data-slot="name">{name}</div>
        <div data-slot="identity">{identity}</div>
      </div>

      {baseUrl ? <div data-slot="baseUrl">{baseUrl}</div> : null}
      {credential ? <div data-slot="credential">{credential}</div> : null}
      {auth ? <div data-slot="auth">{auth}</div> : null}
      {/* 请求头与「拉模型/测连接」现在是**通用位置**（从前只有 Claude 把请求头塞在高级区里）。 */}
      {headers ? <div data-slot="headers">{headers}</div> : null}
      {pull ? <div data-slot="pull">{pull}</div> : null}

      <div data-slot="models">{models}</div>

      {advanced ? (
        <div data-slot="advanced">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 pt-1 text-[0.7857em] text-content-subtle hover:text-content-muted"
          >
            <IconChevronRight size={12} className={cn("transition-transform", advancedOpen && "rotate-90")} />
            {t("settings.customModels.advancedSection")}
          </button>
          {advancedOpen && (
            <div className="mt-1 space-y-2 rounded border border-edge bg-surface/50 p-2">{advanced}</div>
          )}
        </div>
      ) : null}

      {error ? (
        <div data-slot="error" className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[0.7857em] text-danger">
          {error}
        </div>
      ) : null}

      <div data-slot="actions">{actions}</div>
    </div>
  );
}

/** 展开一个模型行时看它的思考强度档位映射。
 *
 *  与 Pi 表单里那段**同一份 UI**（2026-10-11 统一）：六个档位，每个可选
 *  「默认 / 不支持 / 具体值」。用户的诉求原话是「不同的 api 的思考强度的标识符
 *  不一样」—— 不同网关对同一档位用的词不同，这一格就是把它接对的地方。 */
function ThinkingMapEditor({
  thinking,
  thinkingValue,
  onChange,
}: {
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
  onChange: (patch: { thinking?: Record<PiThinkingKey, "default" | "null" | "value">; thinkingValue?: Record<PiThinkingKey, string> }) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 space-y-2 border-t border-edge/60 pt-1.5">
      <span className="mb-1 block text-[0.7143em] text-content-muted">{t("settings.customModels.thinkingMapHint")}</span>
      <div className="grid grid-cols-2 gap-1.5">
        {PI_THINKING_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[0.7143em] text-content-muted">{k}</span>
            <Select.Root
              value={thinking[k]}
              onValueChange={(v) => onChange({ thinking: { ...thinking, [k]: v as "default" | "null" | "value" } })}
            >
              <Select.Trigger className="flex-1">
                <Select.Value>
                  {(val: string) => {
                    const o = THINKING_MODE_OPTIONS.find((x) => x.value === val) ?? THINKING_MODE_OPTIONS[0];
                    return <span className="flex items-center gap-1.5">{o.icon}{t(o.labelKey)}</span>;
                  }}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                {THINKING_MODE_OPTIONS.map((o) => (
                  <Select.Item key={o.value} value={o.value}>
                    {o.icon}
                    <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List></Select.Popup></Select.Positioner></Select.Portal>
            </Select.Root>
            {thinking[k] === "value" && (
              <Input
                value={thinkingValue[k]}
                onChange={(e) => onChange({ thinkingValue: { ...thinkingValue, [k]: e.target.value } })}
                placeholder={t("settings.customModels.thinkingValuePlaceholder")}
                className="flex-1"
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

function FormActions({
  testStatus,
  onDelete,
  onCancel,
  onSave,
  saving,
  isEdit,
}: {
  testStatus?: TestState;
  onDelete?: () => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  isEdit: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {testStatus?.status === "ok" && <span className="flex items-center gap-0.5 text-[0.7857em] text-accent"><IconCheck size={12} /> {testStatus.detail}</span>}
      {testStatus?.status === "fail" && <span className="truncate text-[0.7857em] text-danger">✗ {testStatus.error}</span>}
      <div className="flex-1" />
      {isEdit && onDelete && (
        <Button variant="danger" size="sm" onClick={onDelete} title={t("common.delete")}>
          <IconTrash size={12} /> {t("common.delete")}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
        {saving ? t("settings.saving") : isEdit ? t("settings.customModels.update") : t("common.save")}
      </Button>
    </div>
  );
}
