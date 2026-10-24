/**
 * 「从出厂预设导入」那颗按钮 —— 库列表底部、紧挨「新建」。
 *
 * ## 为什么需要它(【MC-007】)
 *
 * 五个对话模式 + 两条自动化在 2026-10-10 从内置摘出去了,内容落在
 * `resources/presets/workflows.json`,注释写着"用户按需导入"。可在此之前**没有任何
 * 界面入口**:release 用户装上之后,模式下拉里没有它们,库里也找不到,只能开发者
 * clone 仓库后手动导文件。外置了内容却没有可达路径 = 对真实用户等于没做。
 *
 * ## 它不做任何"导入"的事
 *
 * 列预设走 `workflow.listPresets`;选中之后走 `workflow.importPreset` —— 主进程那边
 * 读文件、解析、校验、落库全都汇进与「从文件导入」**同一个** `importWorkflowInto`。
 * 这里只画列表、把选中的 id 递过去。**不要**在这里读文件或拼 JSON(渲染端读不了
 * 安装包里的路径,也不该有第二份导入逻辑)。
 *
 * ## 三态必须分开说
 *
 * `health` 的 `absent` / `corrupt` 与 `ok` 对用户是**不同的事**:
 * 「这个版本没带出厂预设」 vs 「带了但那份文件坏了,报给我们」 vs 正常列表。
 * 都画成空列表的话,用户和 Agent 都分不出该不该报 bug(硬规矩 3)。
 *
 * ## 导入之后
 *
 * 往父组件递 `onImported(id)` —— 与「从文件导入」走同一个交接(收草稿 + 切过去),
 * 所以这里不需要知道自己被谁调用。预设导入**永远新建**(名字重了主进程自动加后缀),
 * 所以没有"覆盖"那条分支。
 */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Dialog, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui/index.js";
import { IconAlertTriangle, IconDownload } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import type { PresetCatalogHealth, PresetWorkflowSummary } from "@contracts/workflow";

function healthNoteKey(health: PresetCatalogHealth): "settings.workflows.presetsAbsent" | "settings.workflows.presetsCorrupt" | null {
  if (health === "absent") return "settings.workflows.presetsAbsent";
  if (health === "corrupt") return "settings.workflows.presetsCorrupt";
  return null;
}

export function PresetImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入成功之后交接(落库后的 id)。与「从文件导入」同一个回调。 */
  onImported: (id: string) => void;
}) {
  const { t } = useI18n();
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 只在对话框打开时拉列表 —— 设置页一进来就拉一次 58KB 文件的摘要没有意义。
  const { data, loading, error: loadError, refetch } = useRpc(
    () => api.workflow.listPresets(),
    [open],
    { enabled: open, toastOnError: false },
  );

  const doImport = async (preset: PresetWorkflowSummary): Promise<void> => {
    setImporting(preset.id);
    setError(null);
    try {
      const res = await api.workflow.importPreset({ id: preset.id });
      if (!res.ok) {
        const lines = res.errors ?? [];
        setError(
          lines.length > 0
            ? lines.slice(0, 3).join("; ") + (lines.length > 3 ? t("settings.workflows.errorsMore", { n: lines.length - 3 }) : "")
            : res.error ?? t("settings.workflows.unknownError"),
        );
        return;
      }
      onOpenChange(false);
      onImported(res.id!);
    } catch (err) {
      setError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    } finally {
      setImporting(null);
    }
  };

  const noteKey = data ? healthNoteKey(data.health) : null;
  const presets = data?.presets ?? [];
  const problems = data?.problems ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o && importing === null) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[460px] max-w-[92vw] p-4">
          <Dialog.Title className="text-body font-semibold text-content">
            {t("settings.workflows.presetsTitle")}
          </Dialog.Title>
          <Dialog.Description className="mb-3 text-code leading-relaxed text-content-muted">
            {t("settings.workflows.presetsDesc")}
          </Dialog.Description>

          <div className="max-h-[50vh] min-h-[80px] overflow-y-auto rounded-md border border-edge">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
                <Spinner size="xs" />
                {t("common.loading")}
              </div>
            )}
            {!loading && loadError !== null && (
              <div className="p-3">
                <ErrorNote>{t("settings.workflows.presetsLoadFailed", { error: loadError.message })}</ErrorNote>
                <Button variant="secondary" size="sm" className="mt-2" onClick={() => void refetch()}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {!loading && loadError === null && noteKey !== null && (
              <div className="flex items-start gap-2 p-3 text-[0.7857em] leading-relaxed text-content-muted">
                <IconAlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <span className="min-w-0">
                  {t(noteKey)}
                  {data?.reason ? <span className="mt-1 block break-all text-content-subtle">{data.reason}</span> : null}
                </span>
              </div>
            )}
            {!loading && loadError === null && noteKey === null && presets.length === 0 && (
              <EmptyState title={t("settings.workflows.presetsEmpty")} />
            )}
            {!loading && loadError === null && presets.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[0.8571em] font-medium text-content">{p.name}</span>
                    <span className="shrink-0 rounded bg-surface px-1 text-[0.7143em] text-content-subtle">
                      {p.kind === "graph"
                        ? t("settings.workflows.presetKindGraph", { n: p.nodeCount })
                        : t("settings.workflows.presetKindPrompt")}
                    </span>
                    {p.trigger !== undefined && (
                      <span className="shrink-0 rounded bg-surface px-1 text-[0.7143em] text-content-subtle">
                        {t("settings.workflows.presetBadgeAutomation")}
                      </span>
                    )}
                    {p.sameNameExists && (
                      <span className="shrink-0 text-[0.7143em] text-content-subtle">
                        {t("settings.workflows.presetAlreadyInLibrary")}
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <div className="mt-0.5 truncate text-[0.7857em] text-content-subtle">{p.description}</div>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing !== null}
                  onClick={() => void doImport(p)}
                  className={cn("shrink-0 gap-1")}
                >
                  {importing === p.id ? <Spinner size="xs" /> : <IconDownload size={12} />}
                  {t("settings.workflows.presetImport")}
                </Button>
              </div>
            ))}
          </div>

          {problems.length > 0 && (
            <p className="mt-2 break-words text-[0.7143em] leading-relaxed text-warning">
              {t("settings.workflows.presetsProblems", { n: problems.length })}:{problems.slice(0, 3).join("; ")}
              {problems.length > 3 ? `;…(还有 ${problems.length - 3} 处)` : ""}
            </p>
          )}
          {error !== null && <ErrorNote className="mt-2">{error}</ErrorNote>}

          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" disabled={importing !== null} onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
