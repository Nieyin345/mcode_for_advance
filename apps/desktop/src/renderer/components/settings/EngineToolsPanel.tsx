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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部快照变化(保存成功/切换)时同步草稿。
  useEffect(() => {
    setSelected(new Set(state.exclude));
  }, [state.exclude.join("\u0000")]);

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
      const res = await api.engineTools.set({ engine: engine as "claude" | "pi" | "codex", exclude: [...selected] });
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
          {rpc.error && <ErrorNote>{rpc.error.message}</ErrorNote>}
          {!snap ? (
            rpc.loading ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : null
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
