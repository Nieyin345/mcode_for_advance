/**
 * `McpPanel` 的**对话框与工具**（从 `McpPanel.tsx` 拆出）。
 *
 * 尾部挂着的「添加服务器对话框 / 导入对话框 / 字段行 / JSON 解析 / 两个样式常量」是各自
 * 独立的渲染单元（AST 实测零闭包捕获）—— 纯搬迁，函数体逐字节一致。
 *
 * 网：`scripts/mcp-ui-smoke/` 在真 Chromium 里真渲染 `McpPanel`、真点真输入。
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Dialog, InfoHint, Select } from "@renderer/components/ui/index.js";
import { IconLoader2 } from "@renderer/lib/icons.js";
import {
  MCP_RESERVED_NAME,
  isReservedMcpServerName,
  type McpImportSource,
  type McpServerConfig,
  type McpServerEntry,
  MCP_NAME_RE,
} from "@contracts/ipc";
import { GLOBAL_ORIGIN_KEY, originKey, KindBadge } from "@renderer/components/settings/McpPanel.js";

const inputCls =
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

const textareaCls =
  "min-h-[64px] w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    // div 而不是 label:ⓘ 是个 button,包在 label 里会抢走「点标题聚焦输入框」的目标。
    <div className="mb-2 block w-full">
      <span className="mb-0.5 flex items-center gap-1.5 text-[0.7857em] font-medium text-content-muted">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      {children}
    </div>
  );
}

/** Parse a JSON object of string→string (env / headers). Returns an error
 *  message on invalid input, else the record (undefined when text is empty).
 *  `t` localizes the error templates; `what` is the already-localized field
 *  name interpolated into them. */
function parseStringRecordJson(
  text: string,
  what: string,
  t: (key: MessageId, params?: Record<string, string | number>) => string,
): { error?: string; value?: Record<string, string> } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: t("settings.mcp.errNotJson", { what }) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: t("settings.mcp.errNotObject", { what }) };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") return { error: t("settings.mcp.errValueString", { what }) };
    out[k] = v;
  }
  return { value: out };
}

export function AddServerDialog({
  open,
  editServer,
  projectPath,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** 非空 = 编辑模式:预填该行的 config,名字锁定,保存走 replace 通道。 */
  editServer: McpServerEntry | null;
  /** 非空 = 写进这个项目的 `.mcp.json`(项目 tab);空 = 总库(用户级)。 */
  projectPath?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envJson, setEnvJson] = useState("");
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog opens — from the edited row's config
  // when editing, else blank.
  useEffect(() => {
    if (!open) return;
    const cfg = editServer?.config;
    if (cfg) {
      setName(editServer?.name ?? "");
      // McpServerConfig 是带 passthrough 的 zod union：每个分支都带着
      // [k: string]: unknown 索引签名，跨分支访问属性只会得到 unknown 而不是
      // 报缺失 —— 必须用判别字段 type 收窄到具体分支后再取值。
      if (cfg.type === "http" || cfg.type === "sse") {
        setType(cfg.type);
        setUrl(cfg.url ?? "");
        setHeadersJson(cfg.headers ? JSON.stringify(cfg.headers, null, 2) : "");
        setCommand("");
        setArgs("");
        setEnvJson("");
      } else {
        setType("stdio");
        setCommand(cfg.command ?? "");
        setArgs((cfg.args ?? []).join(" "));
        setEnvJson(cfg.env ? JSON.stringify(cfg.env, null, 2) : "");
        setUrl("");
        setHeadersJson("");
      }
    } else {
      setName("");
      setType("stdio");
      setCommand("");
      setArgs("");
      setEnvJson("");
      setUrl("");
      setHeadersJson("");
    }
    setError(null);
  }, [open, editServer]);

  const save = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!MCP_NAME_RE.test(trimmedName)) {
      setError(t("settings.nameCharsError"));
      return;
    }
    // ⚠️ 用契约的**整段前缀**判据(`isReservedMcpServerName`),不是单个字面名。从前这里
    // 写的是 `trimmedName === MCP_RESERVED_NAME`,只挡 `mcode-browser` —— 用户建
    // `mcode-app` / `mcode-memory` 时面板放行、点保存被主进程 `ipc/mcp.ts` 拒
    // ("界面允许、保存却被拒")。与项目级 `.mcp.json` 那条路也才对得齐。
    if (isReservedMcpServerName(trimmedName)) {
      setError(t("settings.mcp.errReserved", { name: MCP_RESERVED_NAME }));
      return;
    }
    let config: McpServerConfig;
    if (type === "stdio") {
      if (!command.trim()) {
        setError(t("settings.mcp.errCommand"));
        return;
      }
      const envRes = parseStringRecordJson(envJson, t("settings.mcp.envLabel"), t);
      if (envRes.error) {
        setError(envRes.error);
        return;
      }
      const argList = args.trim() ? args.trim().split(/\s+/) : undefined;
      config = {
        type: "stdio",
        command: command.trim(),
        ...(argList ? { args: argList } : {}),
        ...(envRes.value ? { env: envRes.value } : {}),
      };
    } else {
      if (!url.trim()) {
        setError(t("settings.mcp.errUrl"));
        return;
      }
      const headersRes = parseStringRecordJson(headersJson, t("settings.mcp.headersLabel"), t);
      if (headersRes.error) {
        setError(headersRes.error);
        return;
      }
      config = {
        type,
        url: url.trim(),
        ...(headersRes.value ? { headers: headersRes.value } : {}),
      };
    }
    setSaving(true);
    try {
      // 编辑模式带 replace:同名覆盖写回(主进程同时清掉 stash 里的禁用副本,
      // 编辑即重新启用 —— 面板会在保存后刷新看到)。
      const res = projectPath
        ? await api.mcp.projectSave({
            projectPath,
            name: trimmedName,
            config,
            ...(editServer ? { replace: true } : {}),
          })
        : await api.mcp.save({
            name: trimmedName,
            config,
            ...(editServer ? { replace: true } : {}),
          });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[520px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">
            {t(editServer ? "settings.mcp.editTitle" : "settings.mcp.addTitle")}
          </Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.mcp.addDescPre")}
            <code className="rounded bg-surface-muted px-0.5">
              {projectPath ? `${projectPath}${projectPath.includes("\\") ? "\\" : "/"}.mcp.json` : "~/.mcode/.claude.json"}
            </code>
            {t("settings.mcp.addDescPost")}
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Field label={t("settings.mcp.fName")} hint={t("settings.mcp.fNameHint")}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
                className={inputCls}
                spellCheck={false}
                autoFocus
                disabled={editServer != null}
              />
            </Field>
            <Field label={t("settings.mcp.fType")}>
              <Select.Root value={type} onValueChange={(v) => setType(v as "stdio" | "http" | "sse")}>
                <Select.Trigger className="w-full">
                  <Select.Value>{(val: string) => val}</Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup>
                      <Select.List>
                        <Select.Item value="stdio">
                          <Select.ItemText>{t("settings.mcp.typeStdio")}</Select.ItemText>
                        </Select.Item>
                        <Select.Item value="http">
                          <Select.ItemText>{t("settings.mcp.typeHttp")}</Select.ItemText>
                        </Select.Item>
                        <Select.Item value="sse">
                          <Select.ItemText>{t("settings.mcp.typeSse")}</Select.ItemText>
                        </Select.Item>
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </Field>
            {type === "stdio" ? (
              <>
                <Field label={t("settings.mcp.fCommand")} hint={t("settings.mcp.fCommandHint")}>
                  <input
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label={t("settings.mcp.fArgs")} hint={t("settings.mcp.fArgsHint")}>
                  <input
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="--port 3000"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label={t("settings.mcp.fEnv")} hint={t("settings.mcp.fEnvHint")}>
                  {editServer && <p className="mb-1 text-xs text-content-muted">{t("settings.mcp.secretEditHint")}</p>}
                  <textarea
                    value={envJson}
                    onChange={(e) => setEnvJson(e.target.value)}
                    className={textareaCls}
                    spellCheck={false}
                    placeholder='{"API_KEY": "xxx"}'
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" hint={t("settings.mcp.fUrlHint")}>
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label={t("settings.mcp.fHeaders")} hint={t("settings.mcp.fHeadersHint")}>
                  {editServer && <p className="mb-1 text-xs text-content-muted">{t("settings.mcp.secretEditHint")}</p>}
                  <textarea
                    value={headersJson}
                    onChange={(e) => setHeadersJson(e.target.value)}
                    className={textareaCls}
                    spellCheck={false}
                    placeholder='{"Authorization": "Bearer xxx"}'
                  />
                </Field>
              </>
            )}
            {error && <div className="mt-1 text-[0.7857em] text-danger">{error}</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
              {saving
                ? t("settings.saving")
                : t(editServer ? "settings.mcp.editBtn" : "settings.mcp.addBtn")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────── Import dialog ───────── */

/** Modal dialog for importing MCP servers from the local Claude CLI config
 *  (~/.claude.json — global + per-project entries). On open, scans the CLI
 *  config and the current user-scope list (to mark already-present names);
 *  presents a grouped, checkbox-selectable list; copies the selected configs
 *  on confirm. Mirrors ImportSkillsDialog. */
export function ImportMcpDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<McpImportSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    setExisting(new Set());
    void (async () => {
      try {
        const [scanRes, listRes] = await Promise.all([
          api.mcp.scanImport({}),
          api.mcp.list({}),
        ]);
        if (cancelled) return;
        setSources(scanRes.sources);
        setExisting(
          new Set(listRes.servers.filter((s) => s.scope === "user").map((s) => s.name)),
        );
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Selection key is `origin:name` (the same name can exist globally and in
  // several projects; both are offered, first import wins the name).
  const sourceKey = (s: McpImportSource) => `${originKey(s.origin)}:${s.name}`;
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group by origin — global scope first, then project paths.
  const groups = sources.reduce<Record<string, McpImportSource[]>>((acc, s) => {
    const k = originKey(s.origin);
    (acc[k] ??= []).push(s);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups).sort((a, b) =>
    a === GLOBAL_ORIGIN_KEY ? -1 : b === GLOBAL_ORIGIN_KEY ? 1 : a.localeCompare(b),
  );

  const selectedCount = selected.size;

  const doImport = async () => {
    if (selectedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = sources
        .filter((s) => selected.has(sourceKey(s)))
        .map((s) => ({ name: s.name, origin: s.origin }));
      const res = await api.mcp.import({ servers: items });
      setResult(res);
      setSelected(new Set());
      setExisting((prev) => {
        const next = new Set(prev);
        for (const name of res.imported) next.add(name);
        return next;
      });
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">{t("settings.mcp.importTitle")}</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.mcp.importDesc1")}
            <code className="rounded bg-surface-muted px-0.5">~/.claude.json</code>
            {t("settings.mcp.importDesc2")}
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("settings.scanning")}
              </div>
            ) : sources.length === 0 ? (
              <div className="py-8 text-center text-[0.7857em] leading-relaxed text-content-subtle">
                {t("settings.mcp.importEmpty1")}
                <br />
                {t("settings.mcp.importEmpty2")}
              </div>
            ) : (
              <div className="space-y-3">
                {groupKeys.map((origin) => (
                  <div key={origin}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          origin === GLOBAL_ORIGIN_KEY
                            ? "bg-accent/12 text-accent"
                            : "bg-surface-hover text-content-subtle",
                        )}
                        title={origin === GLOBAL_ORIGIN_KEY ? undefined : origin}
                      >
                        {origin === GLOBAL_ORIGIN_KEY
                          ? t("settings.mcp.originGlobal")
                          : origin}
                      </span>
                      <span className="text-[0.7143em] text-content-subtle">
                        {t("settings.mcp.count", { n: groups[origin].length })}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {groups[origin].map((s) => {
                        const key = sourceKey(s);
                        const isExisting = existing.has(s.name);
                        const isChecked = selected.has(key);
                        return (
                          <label
                            key={key}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors",
                              isExisting
                                ? "opacity-50"
                                : isChecked
                                  ? "bg-accent/8"
                                  : "hover:bg-surface-hover/60",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isExisting}
                              onChange={() => toggle(key)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-[0.7857em] font-medium text-content">
                                  {s.name}
                                </span>
                                <KindBadge kind={s.kind} />
                                {isExisting && (
                                  <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] text-content-subtle">
                                    {t("settings.importExisting")}
                                  </span>
                                )}
                              </div>
                              <p className="truncate font-mono text-[0.7143em] text-content-subtle" title={s.detail}>
                                {s.detail}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result && (
              <div className="mt-3 rounded border border-edge bg-surface/40 p-2 text-[0.7143em]">
                {result.imported.length > 0 && (
                  <p className="text-accent">
                    {t("settings.importResultImported", { n: result.imported.length, list: result.imported.join(", ") })}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-content-subtle">
                    {t("settings.importResultSkipped", { n: result.skipped.length, list: result.skipped.join(", ") })}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="text-danger">
                    {t("settings.importResultFailed", {
                      n: result.errors.length,
                      list: result.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                    })}
                  </p>
                )}
              </div>
            )}

            {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <span className="text-[0.7143em] text-content-subtle">
              {selectedCount > 0 ? t("settings.importSelectedCount", { n: selectedCount }) : ""}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
              {result ? t("common.close") : t("common.cancel")}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void doImport()}
                disabled={importing || selectedCount === 0}
              >
                {importing
                  ? t("settings.importing")
                  : `${t("settings.importBtn")}${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
