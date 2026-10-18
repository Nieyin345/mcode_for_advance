/**
 * 设置 → 「引擎工具」：按引擎禁用**内置**工具。
 *
 * ## 这一页解决什么
 *
 * 三个引擎各带一套内置工具（Claude 的 Bash/Read/Edit…、Pi 的 read/edit/bash…、
 * Codex 的壳命令）。它们的用法、命名、行为都不一致 —— 这是"三个引擎不好统一"的一大来源。
 * 这一页让用户按引擎关掉不想要的内置工具，把基础工具面收敛到自己想要的那一份。
 *
 * ## 能力边界（如实告知，不假装）
 *
 * - **Claude / Pi** 能按名删（Claude → SD K `disallowedTools`，Pi → `excludeTools`）。
 * - **Codex 不能**（只有沙箱/审批档）。UI 对 Codex 显示明确提示，且**不提供**勾选 ——
 *   设置了也不生效的东西，不该给用户点。
 *
 * 底层策略在 `main/lib/engineToolPolicy.ts`，纯文件、轮开始时读取、下一轮生效。
 */
import { useEffect, useState } from "react";
import { ENGINE_TOOL_ENGINE_IDS, type EngineToolsSnapshot } from "@contracts/ipc/engineTools";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { EngineCapabilityMatrix } from "./EngineCapabilityMatrix.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { Button, ErrorNote, Field, Input, Spinner } from "@renderer/components/ui/index.js";

/** 引擎的展示名（不本地化 —— 品牌名）。 */
const ENGINE_LABEL: Record<string, string> = { claude: "Claude", pi: "Pi", codex: "Codex" };

/** 一个引擎的编辑卡片。本地维护 exclude 草稿,显式保存才落盘(与其它设置页一致)。 */
function EngineCard({
  engine,
  state,
  onSaved,
}: {
  engine: string;
  state: EngineToolsSnapshot["engines"][keyof EngineToolsSnapshot["engines"]];
  onSaved: (snap: EngineToolsSnapshot) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set(state.exclude));
  const [custom, setCustom] = useState("");
  // 【MC-043】工具使用说明草稿(与 exclude 分开:说明只进提示词、不改权限)。
  const [guidance, setGuidance] = useState(state.guidance ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部快照变化(保存成功/切换)时同步草稿。
  useEffect(() => {
    setSelected(new Set(state.exclude));
  }, [state.exclude.join("\u0000")]);
  useEffect(() => {
    setGuidance(state.guidance ?? "");
  }, [state.guidance]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const addCustom = () => {
    const name = custom.trim();
    if (!name) return;
    setSelected((prev) => new Set(prev).add(name));
    setCustom("");
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.engineTools.set({ engine: engine as "claude" | "pi" | "codex", exclude: [...selected], guidance });
      if (!res.ok || !res.snapshot) {
        setError(res.error ?? t("settings.engineTools.saveFailed"));
      } else {
        onSaved(res.snapshot);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 「已知工具」勾选项 —— 已选上但不在已知清单里的自定义名也一并列出(不然会被藏掉)。
  const known = state.known;
  const extras = [...selected].filter((n) => !known.includes(n)).sort();
  const rows = [...known, ...extras];

  return (
    <SettingsSection
      title={ENGINE_LABEL[engine] ?? engine}
      desc={state.supported ? t("settings.engineTools.engineHint") : t("settings.engineTools.codexUnsupported")}
    >
      {!state.supported ? (
        <p className="text-sm text-content-muted">{t("settings.engineTools.codexUnsupported")}</p>
      ) : (
        <div className="space-y-3">
          {rows.length === 0 ? (
            <p className="text-sm text-content-muted">{t("settings.engineTools.noneKnown")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {rows.map((name) => {
                const on = selected.has(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggle(name)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                      on
                        ? "border-danger/60 bg-danger/10 text-danger"
                        : "border-edge bg-surface text-content hover:bg-surface-hover",
                    )}
                    title={on ? t("settings.engineTools.clickToEnable") : t("settings.engineTools.clickToDisable")}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          <Field label={t("settings.engineTools.addCustomLabel")}>
            <div className="flex gap-2">
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder={t("settings.engineTools.addCustomPlaceholder")}
              />
              <Button type="button" variant="outline" onClick={addCustom} disabled={!custom.trim()}>
                {t("settings.engineTools.addCustomButton")}
              </Button>
            </div>
          </Field>

          {/* 【MC-043】工具使用说明 —— 与上面的禁用勾选是**两件事**:这段只进提示词,
              不改任何权限。Codex 也支持(它不是"禁用",是"怎么写说明")。 */}
          <Field label={t("settings.engineTools.guidanceLabel")}>
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder={t("settings.engineTools.guidancePlaceholder")}
              rows={4}
              maxLength={4000}
              className="w-full resize-y rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
            />
          </Field>
          <p className="text-xs text-content-muted">{t("settings.engineTools.guidanceHint")}</p>
          {/* 【MC-043 验收】「编辑 / 还原默认」:清空说明 = 回到引擎内置的通用说明
              (与"从未写过"同一语义),所以还原不是第二套存储,只是把这段清空。 */}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGuidance("")}
              disabled={guidance.trim() === ""}
            >
              {t("settings.engineTools.guidanceReset")}
            </Button>
          </div>
          {guidance.trim() && (
            <details className="rounded border border-edge bg-surface-muted/40 px-3 py-2">
              <summary className="cursor-pointer text-xs text-content-muted">{t("settings.engineTools.guidancePreview")}</summary>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-[0.7857em] text-content">{`## 用户的工具使用偏好(${engine})

${guidance.trim()}`}</pre>
            </details>
          )}
          <p className="text-xs text-content-muted">{t("settings.engineTools.appliesNextTurn")}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end">
            <Button type="button" onClick={save} disabled={busy}>
              {busy ? <Spinner /> : t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

export function EngineToolsPanel() {
  const { t } = useI18n();
  const rpc = useRpc<EngineToolsSnapshot>(() => api.engineTools.get({}), []);
  const [snapshot, setSnapshot] = useState<EngineToolsSnapshot | undefined>(undefined);

  useEffect(() => {
    if (rpc.data) setSnapshot(rpc.data);
  }, [rpc.data]);

  const snap = snapshot ?? rpc.data;

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("settings.nav.engineTools")} hint={t("settings.engineTools.hint")} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className={cn("mx-auto space-y-4", PANEL_MAX_W.form)}>
          {/* 「能力 × 引擎」矩阵 —— 只读说明，静态数据、不依赖 RPC，所以放在最上面
              （加载引擎卡片时也一直看得见）。它把散在技能/MCP/插件各页的引擎能力面
              汇到一处（见 engineCapabilityData.ts）。 */}
          {/* 【ARC-003 第 4 条】把本机策略叠加进基础能力矩阵:用户在下面对应卡片里按名
              禁用的内置工具,矩阵那一格必须如实显示「已被用户禁用」—— 静态声明与运行时
              事实同时可见,而不是两张互相打脸的说明。 */}
          <EngineCapabilityMatrix
            excludedByEngine={snap?.engines ? {
              claude: snap.engines.claude.exclude,
              pi: snap.engines.pi.exclude,
              codex: snap.engines.codex.exclude,
            } : undefined}
          />
          {rpc.error && (
            <ErrorNote
              action={
                <Button size="sm" variant="ghost" onClick={() => void rpc.refetch()}>
                  {t("common.retry")}
                </Button>
              }
            >
              {rpc.error.message}
            </ErrorNote>
          )}
          {/* 【MC-071】策略文件损坏时**显式告警**,不把 fail-open 当用户主动启用。
              主进程已据 last-good 保守恢复(或无备份时按不设限),这里把那一事实讲出来。 */}
          {snap?.status === "INVALID" && (
            <ErrorNote tone="warning">
              {snap.recovered
                ? t("settings.engineTools.policyCorruptRecovered")
                : t("settings.engineTools.policyCorruptNoBackup")}
            </ErrorNote>
          )}
          {!snap?.engines ? (
            rpc.loading ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : (
              // 快照形状不对(旧宿主/桩/版本不一致):显式说"读不出来",不白屏。
              rpc.error ? null : <ErrorNote>{t("settings.loadFailed")}</ErrorNote>
            )
          ) : (
            ENGINE_TOOL_ENGINE_IDS.map((engine) => (
              <EngineCard key={engine} engine={engine} state={snap.engines[engine]} onSaved={setSnapshot} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
