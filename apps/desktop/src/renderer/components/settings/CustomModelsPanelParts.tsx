/**
 * `CustomModelsPanel` 的**共享常量与纯展示子组件**（从 `CustomModelsPanel.tsx` 拆出）。
 *
 * 头部那批 Select 选项常量、小型子组件（Field / SecretInput / BridgeRow /
 * HeadersEditor）以及尾部三个引擎表单共用的外壳（ModelListSection /
 * EndpointActionRow / ProviderFormShell / ThinkingMapEditor / FormActions）都是
 * **互不依赖的渲染单元**（AST 实测零闭包捕获、零 `api.` 调用）—— 纯搬迁，函数体
 * 逐字节一致（见 `.tmp/verify-custommodels-move.py`）。
 *
 * 网：`scripts/custom-models-ui-smoke/`（真 Chromium 里真渲染 CustomModelsPanel，
 * 真点真输入）与 `scripts/settings-panel-smoke/`（扫源码文本断言三段表单的字段顺序
 * 与 supportsVision 落点）。
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, HintLabel, Input, Select, Tooltip } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
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
} from "@renderer/lib/icons.js";
import { SiClaude, SiGoogle } from "@renderer/lib/icons.js";
import type { AuthMode, Protocol } from "@contracts/customModel";
import { isValidHeaderName, isValidHeaderValue } from "@contracts/customModel";
import { PI_THINKING_KEYS, type PiThinkingKey } from "@contracts/piModel";
import { CODEX_EFFORT_VALUES, type ThinkingCapability } from "@contracts/thinkingMap";

/* ════════════════════════ shared option constants ════════════════════════ */
// Static Select option catalogs carrying a per-option icon, so every dropdown
// in this panel shows a visual cue alongside the label (and in the trigger).

export const AUTH_MODE_OPTIONS: { value: AuthMode; label: string; icon: ReactNode }[] = [
  { value: "auth_token", label: "Bearer", icon: <IconKey size={14} className="text-content-muted" /> },
  { value: "api_key", label: "x-api-key", icon: <IconHash size={14} className="text-content-muted" /> },
];

export const PROTOCOL_OPTIONS: { value: Protocol; labelKey: MessageId; icon: ReactNode }[] = [
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
export const WEB_SITE_OPTIONS: { value: string; labelKey: MessageId; defaultModelId: string; driver: boolean }[] = [
  { value: "deepseek", labelKey: "settings.customModels.webSiteDeepseek", defaultModelId: "deepseek-web", driver: true },
  { value: "chatgpt", labelKey: "settings.customModels.webSiteChatgpt", defaultModelId: "chatgpt-web", driver: true },
];

/**
 * 网页端的「模型 id」只是个显示名 —— 站点本身就是模型（DeepSeek 网页版没有让你
 * 选模型的余地，对话页那边也用不上这个 id）。所以它有一个站点默认值：用户不填就
 * 用这个，不该把人挡在保存门外。
 */
export function defaultWebModelId(siteId: string): string {
  const o = WEB_SITE_OPTIONS.find((x) => x.value === siteId);
  return o?.defaultModelId ?? WEB_SITE_OPTIONS[0].defaultModelId;
}

/** Per-API-type brand icon for the Pi "API 类型" select (label stays the raw
 *  api string, e.g. "openai-completions"). Unknown api strings get no icon. */
export const PI_API_ICONS: Record<string, ReactNode> = {
  "openai-completions": <IconBrandOpenai size={14} className="text-content-muted" />,
  "openai-responses": <IconBrandOpenai size={14} className="text-content-muted" />,
  "anthropic-messages": <SiClaude size={14} className="text-content-muted" />,
  "google-generative-ai": <SiGoogle size={14} className="text-content-muted" />,
};

export const THINKING_MODE_OPTIONS: { value: string; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "default", labelKey: "settings.customModels.thinkingDefault", icon: <IconAdjustmentsHorizontal size={14} className="text-content-muted" /> },
  { value: "null", labelKey: "settings.customModels.thinkingNull", icon: <IconCircleOff size={14} className="text-content-muted" /> },
  { value: "value", labelKey: "settings.customModels.thinkingValue", icon: <IconArrowsExchange size={14} className="text-content-muted" /> },
];

/* ════════════════════════ shared helpers ════════════════════════ */

/** Read-only value + copy button, for the extension-bridge address / token pair.
 *  Both are opaque strings the user has to move into the browser extension by
 *  hand, so copyable beats pretty. */
export function BridgeRow({
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
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
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
export function SecretInput({
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

export type TestState =
  | { status: "idle" }
  | { status: "testing"; idx: number }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

/** Select sentinel for the subagent-model "follow main session" option. The
 *  form state stores "" for that case (maps at the boundary — a bare "" would
 *  be ambiguous as a Select value). */
export const SUBAGENT_FOLLOW_MAIN = "__subagent_follow_main__";

export interface ClaudeModelFormState {
  /** Gateway-side model id, e.g. "deepseek-v4-pro". */
  id: string;
  supports1m: boolean;
  /** 声明该模型接受**图片输入**（用户自述，不上行）。供「视觉中继」挑眼睛用 ——
   *  与 Pi 侧的 `vision` 同一语义，只是这里只存一份声明。 */
  supportsVision: boolean;
  /** 每模型「档位 → 翻译成什么」。表单里用 `thinking`（三态）+ `thinkingValue`
   *  （具体值）两个平行表，落到配置时由 `thinkingMapFromForm` 折成判别式的
   *  `ThinkingLevelMap`（见 `@contracts/thinkingMap`）。
   *
   *  ⚠️ 具体值那半边是 `ThinkingRowValue`（带 kind：文本 / 数字 / token 预算）——
   *  不再是一个字符串，因为 Claude 有三条不同的落点（见 `ThinkingMapEditor`）。 */
  thinking: Record<PiThinkingKey, ThinkingRowMode>;
  thinkingValue: Record<PiThinkingKey, ThinkingRowValue>;
}

/** One editable row of the custom-headers list. Held as rows rather than a
 *  record so a half-typed row can sit in the form while the user is editing
 *  it; {@link customHeadersFromRows} converts on save. */
export interface CustomHeaderRow {
  name: string;
  value: string;
}

/** Rows → the persisted record. Rows that are entirely empty are dropped (they
 *  are just unused UI slots); a partially filled or malformed row is a hard
 *  error rather than a silent skip, so a typo can't quietly fail to be sent.
 *  Validation uses the same rule the main process applies at request time. */
export function customHeadersFromRows(
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
export function endpointHeaders(rows: CustomHeaderRow[]): Record<string, string> | undefined {
  const r = customHeadersFromRows(rows);
  return r.ok ? r.headers : undefined;
}

/** 额外请求头的行编辑器 —— Claude / Pi / Codex 三个表单共用同一份（2026-10-11 统一）。
 *  从前只有 Claude 有；Pi 的 models.json 与 Codex 的 config.toml 底层本来就收 headers，
 *  只是没做界面。三处用同一个件，观感与校验才不会各长各的。 */
export function HeadersEditor({
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

/* ════════════════════════ shared action bar ════════════════════════ */

/** 模型列表的共同外壳：标题带条数 + 「添加模型」+ 空状态 + 行容器。
 *
 *  三个引擎的行内容不一样（各自带 1M / maxTokens / 思考映射 那些开关），但**这一圈
 *  是逐字相同的** —— 抽出来保证三页的观感与文案不会各长各的（2026-10-11 统一）。
 *  从前这段在三个表单里各抄了一份。 */
export function ModelListSection({
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
        <button type="button" onClick={onAdd} className="flex items-center gap-1 text-[0.7857em] text-content-muted hover:text-content">
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
export function EndpointActionRow({
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
export function ProviderFormShell({
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

/**
 * 一个档位「具体值」的输入控件 —— **按引擎能力给不同形态**。
 *
 * - `enum`（Codex）：下拉，只列 `CODEX_EFFORT_VALUES`（二进制认的那串）+ 几个常用档位名。
 *   ⚠️ 下拉里出现的值**必须是枚举内的** —— 让用户手打一个"看起来合理"的词，是这一格
 *   最容易骗人的失败方式（填了、存了、发出去 codex 不认、静默用默认）。
 * - `flexible`（Claude）：先选**值类型**（文本 / 数字 / token 预算），再填对应的框。
 * - `free`（Pi）：自由文本。
 */
function ThinkingValueInput({
  capability,
  value,
  onChange,
}: {
  capability: ThinkingCapability;
  value: ThinkingRowValue;
  onChange: (v: ThinkingRowValue) => void;
}) {
  const { t } = useI18n();
  if (capability === "enum") {
    return (
      <Select.Root
        value={value.text}
        onValueChange={(v: unknown) => onChange({ ...value, kind: "string", text: String(v ?? "") })}
      >
        <Select.Trigger className="flex-1">
          {/* 值本身就是 `CODEX_EFFORT_VALUES` 里的裸字符串，直接显示即可
              （与下面 flexible 分支用函数取 label 不同 —— 那里要翻译成人话）。 */}
          <Select.Value>
            {(val: string) => val || t("settings.customModels.thinkingValuePlaceholder")}
          </Select.Value>
        </Select.Trigger>
        <Select.Portal><Select.Positioner><Select.Popup><Select.List>
          {CODEX_EFFORT_VALUES.map((v) => (
            <Select.Item key={v} value={v}><Select.ItemText>{v}</Select.ItemText></Select.Item>
          ))}
        </Select.List></Select.Popup></Select.Positioner></Select.Portal>
      </Select.Root>
    );
  }
  if (capability === "flexible") {
    return (
      <span className="flex flex-1 items-center gap-1">
        <Select.Root
          value={value.kind}
          onValueChange={(v) => onChange({ ...value, kind: v as ThinkingRowValue["kind"] })}
        >
          <Select.Trigger className="w-24 shrink-0">
            <Select.Value>
              {(val: string) => t(`settings.customModels.thinkingValueKind.${val}` as MessageId)}
            </Select.Value>
          </Select.Trigger>
          <Select.Portal><Select.Positioner><Select.Popup><Select.List>
            {(["string", "number", "budget"] as const).map((kind) => (
              <Select.Item key={kind} value={kind}>
                <Select.ItemText>{t(`settings.customModels.thinkingValueKind.${kind}` as MessageId)}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
        <Input
          value={value.kind === "number" ? value.num : value.kind === "budget" ? value.budget : value.text}
          onChange={(e) =>
            onChange(
              value.kind === "number"
                ? { ...value, num: e.target.value }
                : value.kind === "budget"
                  ? { ...value, budget: e.target.value }
                  : { ...value, text: e.target.value },
            )
          }
          placeholder={t(
            value.kind === "budget"
              ? "settings.customModels.thinkingBudgetPlaceholder"
              : "settings.customModels.thinkingValuePlaceholder",
          )}
          className="flex-1"
        />
      </span>
    );
  }
  // free（Pi）
  return (
    <Input
      value={value.text}
      onChange={(e) => onChange({ ...value, text: e.target.value })}
      placeholder={t("settings.customModels.thinkingValuePlaceholder")}
      className="flex-1"
    />
  );
}

/** 一个档位在表单里的三态（旧形状，Pi/Claude 一直在用）。 */
export type ThinkingRowMode = "default" | "null" | "value";

/** 表单里「具体值」那半边的类型 —— 按引擎能力给不同的输入控件。 */
export type ThinkingRowValue = {
  /** 自由文本（Pi / Claude 的自定义字符串）。 */
  text: string;
  /** 数字（只有 Claude 的 Options.effort 收 number）。 */
  num: string;
  /** token 预算（只有 Claude 的 thinking.budgetTokens）。 */
  budget: string;
  /** 具体值的**种类** —— 决定这一行右边给什么控件。 */
  kind: "string" | "number" | "budget";
};

/** 展开一个模型行时看它的思考强度档位映射。
 *
 *  ## 为什么要按能力渲染（2026-10-17 改）
 *
 *  三个引擎**能接受的东西不一样**（查过各自的 SDK / 二进制，见
 *  `@contracts/thinkingMap` 的文件头那张表）：
 *
 *  - **Pi**：任意字符串，由 pi-ai 的每个 wire adapter 逐条翻译 → 给自由输入框；
 *  - **Claude**：命名档 / **整数**（`Options.effort` 也收 number）/ **token 预算**
 *    （`Options.thinking.budgetTokens`）/ 自定义字符串（只能走 env）→ 给「值类型」选择；
 *  - **Codex**：**二进制的封闭枚举** → 只能下拉选它认识的，填别的**不会生效**。
 *
 *  用一个统一的自由文本表就会让用户在 Codex 上填一个永远不生效的值 —— 那比不给这一格更糟。
 *  所以同一个组件按 `capability` 渲染三种形态，**判据（哪些档位、什么语义）只有一份**。 */
export function ThinkingMapEditor({
  thinking,
  thinkingValue,
  capability,
  onChange,
}: {
  thinking: Record<PiThinkingKey, ThinkingRowMode>;
  thinkingValue: Record<PiThinkingKey, ThinkingRowValue>;
  /** 这一家引擎能表达什么（见上面的表）。 */
  capability: ThinkingCapability;
  onChange: (patch: {
    thinking?: Record<PiThinkingKey, ThinkingRowMode>;
    thinkingValue?: Record<PiThinkingKey, ThinkingRowValue>;
  }) => void;
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
              <ThinkingValueInput
                capability={capability}
                value={thinkingValue[k]}
                onChange={(v) => onChange({ thinkingValue: { ...thinkingValue, [k]: v } })}
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

export function FormActions({
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
