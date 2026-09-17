/**
 * 上下文托管面板 — Settings 页 "Context" 菜单。
 *
 * 三节:
 *  - 全局指令:三引擎共用的常驻指令。编辑的是数据根下的事实源
 *    (<dataRoot>/context/instructions.md),保存即物化(Claude → ~/.mcode/
 *    CLAUDE.md;Codex/Pi 走各自的会话启动组装链),用户不用关心每个引擎的
 *    文件位置 —— 主进程的物化逻辑见 main/lib/appContext.ts。
 *  - 项目记忆:CLI 原生 auto-memory 文件的托管编辑器。左列项目、右列
 *    MEMORY.md;保存直写文件,记忆的注入仍由引擎自动完成。
 *  - 工具占用:按引擎静态枚举 Mcode 可控工具的 schema,估算它们进会话
 *    时吃掉的上下文。静态估算 —— 外部 MCP 只能列服务器行(连接前拿不到
 *    工具清单),浏览器工具没有静态参数 schema(略低估)。
 *
 * 面板局部 state(同 McpPanel):没有跨面板消费者,进面板拉一次、保存后
 * 局部刷新即可。
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Select } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { IconBrain, IconLoader2 } from "@renderer/lib/icons.js";
import type {
  ContextMemoryDir,
  ToolUsageSource,
  ToolsUsageEngineId,
  ToolsUsageResult,
} from "@contracts/ipc";

/** Stable empty array (store convention). */
const EMPTY_DIRS: ContextMemoryDir[] = [];

/** 占用面板的引擎下拉 —— 契约里那个闭合集合,少一个编译不过。 */
const USAGE_ENGINES: ToolsUsageEngineId[] = ["claude", "codex", "pi"];

/** 组标题文案表。新增 ToolUsageSource 时这里必须跟着补(编译器盯着)。 */
const USAGE_SOURCE_LABELS: Record<ToolUsageSource, MessageId> = {
  inprocess: "settings.context.usageInprocess",
  userMcp: "settings.context.usageUserMcp",
  pluginMcp: "settings.context.usagePluginMcp",
  builtin: "settings.context.usageBuiltin",
};

const textareaCls =
  "min-h-[180px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.8571em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

/** `updatedAt` 的短日期(列表行宽有限,精确到天足够;悬停要全量再谈)。 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ContextPanel() {
  const { t } = useI18n();

  // ── 全局指令 ──
  const [instructions, setInstructions] = useState("");
  const [instrLoading, setInstrLoading] = useState(true);
  const [instrSaving, setInstrSaving] = useState(false);
  const [instrError, setInstrError] = useState<string | null>(null);
  const [instrSaved, setInstrSaved] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  // ── 项目记忆 ──
  const [dirs, setDirs] = useState<ContextMemoryDir[]>(EMPTY_DIRS);
  const [selected, setSelected] = useState<ContextMemoryDir | null>(null);
  const [memory, setMemory] = useState("");
  const [memLoading, setMemLoading] = useState(false);
  const [memSaving, setMemSaving] = useState(false);
  const [memError, setMemError] = useState<string | null>(null);
  const [memSaved, setMemSaved] = useState(false);

  // ── 工具占用 ──
  const [usageEngine, setUsageEngine] = useState<ToolsUsageEngineId>("claude");
  const [usage, setUsage] = useState<ToolsUsageResult | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setInstrLoading(true);
    try {
      const [res, mem] = await Promise.all([api.context.get({}), api.context.memoriesList({})]);
      setInstructions(res.content);
      setDirs(mem.dirs.length ? mem.dirs : EMPTY_DIRS);
    } catch (err) {
      setInstrError((err as Error).message);
    } finally {
      setInstrLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 切引擎即重拉 —— 静态枚举很便宜,不做缓存(参数将来按引擎分化时也不会陈旧)。
  useEffect(() => {
    let alive = true;
    setUsageLoading(true);
    setUsageError(null);
    api.tools
      .usage({ engine: usageEngine })
      .then((res) => {
        if (alive) setUsage(res);
      })
      .catch((err) => {
        if (alive) setUsageError((err as Error).message);
      })
      .finally(() => {
        if (alive) setUsageLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [usageEngine]);

  // 列表刷新后,选中的条目可能已消失(记忆目录被引擎清掉)—— 清选中的。
  useEffect(() => {
    if (selected && !dirs.some((d) => d.slug === selected.slug)) setSelected(null);
  }, [dirs, selected]);

  const pickDir = async (dir: ContextMemoryDir) => {
    setSelected(dir);
    setMemError(null);
    setMemSaved(false);
    setMemLoading(true);
    try {
      const { content } = await api.context.memoryGet({ slug: dir.slug });
      setMemory(content);
    } catch (err) {
      setMemError((err as Error).message);
    } finally {
      setMemLoading(false);
    }
  };

  const saveInstructions = async () => {
    setInstrError(null);
    setInstrSaving(true);
    try {
      const res = await api.context.save({ content: instructions });
      if (!res.ok) {
        setInstrError(res.error ?? t("settings.saveFailed"));
        return;
      }
      setWarnings(res.warnings ?? []);
      setInstrSaved(true);
    } catch (err) {
      setInstrError((err as Error).message);
    } finally {
      setInstrSaving(false);
    }
  };

  const saveMemory = async () => {
    if (!selected) return;
    setMemError(null);
    setMemSaving(true);
    try {
      const res = await api.context.memorySave({ slug: selected.slug, content: memory });
      if (!res.ok) {
        setMemError(res.error ?? t("settings.saveFailed"));
        return;
      }
      setMemSaved(true);
      // 顺手刷新左列的「更新于」时间戳
      const { dirs: fresh } = await api.context.memoriesList({});
      setDirs(fresh.length ? fresh : EMPTY_DIRS);
    } catch (err) {
      setMemError((err as Error).message);
    } finally {
      setMemSaving(false);
    }
  };

  return (
    <section className={cn("mx-auto w-full space-y-4", PANEL_MAX_W.form)}>
      <PanelHeader title={t("settings.context.title")} icon={IconBrain} />

      {instrError && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {instrError}
        </div>
      )}

      {/* ───────── 全局指令 ───────── */}
      <SettingsSection
        title={t("settings.context.instructionsSection")}
        desc={t("settings.context.instructionsDesc")}
      >
        <div className="px-4 py-2.5">
          {instrLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
              <IconLoader2 size={14} className="animate-spin" />
              {t("common.loading")}
            </div>
          ) : (
            <>
              <textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value);
                  setInstrSaved(false);
                }}
                placeholder={t("settings.context.instructionsPlaceholder")}
                className={textareaCls}
                spellCheck={false}
              />
              {warnings.length > 0 && (
                <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.7857em] leading-relaxed text-amber-500">
                  {warnings.join("\n")}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveInstructions()}
                  disabled={instrSaving}
                >
                  {t("settings.context.save")}
                </Button>
                {instrSaved && (
                  <span className="text-[0.7857em] text-emerald-500">
                    {t("settings.context.saved")}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </SettingsSection>

      {/* ───────── 项目记忆 ───────── */}
      <SettingsSection
        title={t("settings.context.memoriesSection")}
        desc={t("settings.context.memoriesDesc")}
      >
        <div className="flex gap-3 px-4 py-2.5">
          {/* 左列:项目清单 */}
          <div className="w-56 shrink-0 space-y-0.5">
            {dirs.length === 0 ? (
              <p className="px-1 py-3 text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.context.memoriesEmpty")}
              </p>
            ) : (
              dirs.map((d) => (
                <button
                  key={d.slug}
                  onClick={() => void pickDir(d)}
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left transition-colors",
                    selected?.slug === d.slug
                      ? "bg-accent/10 text-content"
                      : "text-content-muted hover:bg-surface-hover",
                  )}
                >
                  <span className="block truncate text-[0.8571em]" title={d.slug}>
                    {d.label}
                  </span>
                  {d.updatedAt !== null && (
                    <span className="block text-[10px] text-content-subtle">
                      {t("settings.context.updatedAt")} {fmtDate(d.updatedAt)}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
          {/* 右列:MEMORY.md 编辑器 */}
          <div className="min-w-0 flex-1">
            {!selected ? (
              <p className="py-3 text-[0.7857em] text-content-subtle">
                {t("settings.context.noMemorySelected")}
              </p>
            ) : memLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <>
                <textarea
                  value={memory}
                  onChange={(e) => {
                    setMemory(e.target.value);
                    setMemSaved(false);
                  }}
                  className={cn(textareaCls, "min-h-[220px]")}
                  spellCheck={false}
                />
                {memError && (
                  <p className="mt-1 text-[0.7857em] text-danger">{memError}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void saveMemory()}
                    disabled={memSaving}
                  >
                    {t("settings.context.saveMemory")}
                  </Button>
                  {memSaved && (
                    <span className="text-[0.7857em] text-emerald-500">
                      {t("settings.context.saved")}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* ───────── 工具占用 ───────── */}
      <SettingsSection
        title={t("settings.context.usageSection")}
        desc={t("settings.context.usageDesc")}
      >
        <div className="px-4 py-2.5">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[0.7857em] text-content-muted">
              {t("settings.context.usageEngine")}
            </span>
            <Select.Root
              value={usageEngine}
              onValueChange={(v) => setUsageEngine(v as ToolsUsageEngineId)}
            >
              <Select.Trigger className="w-36">
                <Select.Value />
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {USAGE_ENGINES.map((e) => (
                        <Select.Item key={e} value={e}>
                          <Select.ItemText>{e}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>

          {usageLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
              <IconLoader2 size={14} className="animate-spin" />
              {t("common.loading")}
            </div>
          ) : usageError ? (
            <p className="py-2 text-[0.7857em] text-danger">{usageError}</p>
          ) : usage === null || usage.groups.length === 0 ? null : (
            <div className="space-y-3">
              {usage.groups.map((g) => (
                <div key={g.source} className="overflow-hidden rounded border border-edge">
                  <div className="flex items-center justify-between border-b border-edge bg-surface-muted/50 px-3 py-1.5">
                    <span className="text-[0.7857em] font-medium text-content">
                      {t(USAGE_SOURCE_LABELS[g.source])}
                      <span className="ml-1.5 text-[0.9em] font-normal text-content-subtle">
                        ({g.items.length})
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.7143em] text-content-subtle">
                      {g.items.some((it) => it.estTokens !== null)
                        ? `${g.totalEstTokens.toLocaleString()} tokens`
                        : "—"}
                    </span>
                  </div>
                  <ul className="divide-y divide-edge/60">
                    {g.items.map((it) => (
                      <li
                        key={it.name}
                        className="flex items-baseline justify-between gap-3 px-3 py-1"
                      >
                        <span
                          className="min-w-0 truncate text-[0.7857em] text-content"
                          title={it.description ?? it.name}
                        >
                          {it.name}
                        </span>
                        <span className="shrink-0 font-mono text-[0.7143em] text-content-subtle">
                          {it.estTokens === null ? "—" : it.estTokens.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {g.note && (
                    <p className="px-3 py-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
                      {g.note}
                    </p>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-edge pt-2 text-[0.7857em]">
                <span className="text-content-muted">{t("settings.context.usageTotal")}</span>
                <span className="font-mono text-content">
                  {usage.totalEstTokens.toLocaleString()} tokens
                </span>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
    </section>
  );
}
