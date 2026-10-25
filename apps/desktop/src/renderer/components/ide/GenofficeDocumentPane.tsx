/**
 * 【ARC-007】**GenOffice 文档面板**（用户可达的只读/结构化视图）。
 *
 * ## 它在链路的哪一段
 *
 * G0 轨道（方案 C）的渲染端出口：经 `api.document.*` 读文档结构，展示块/页/表，
 * 并显式报告本机能力（CLI 是否就绪、哪些路由需要 headless 宿主）。它**不是**
 * 完整编辑器。
 *
 * ⚠️ **2026-10-24 更正**：这里原本写着「可视化编辑要等方案 A（受控 WebContentsView）
 * 接上」。**方案 A 就是 `GenofficeViewHostPane.tsx`，早已接线**（六家编辑器的原生
 * 视图全通，见 T94 审计）。本面板不承担编辑，是**产品分层**的选择（结构化视图
 * 便宜、无依赖、可诊断；原生视图重但能真编辑），不是"还没做"。用户可在工具栏
 * 切换「GenOffice 视图」与「编辑视图」两档。
 *
 * ## 为什么按需挂载
 *
 * 与「按需挂载」的通用取舍一致：面板只在文件被打开时挂载，`document.read`
 * 走 `useRpc`（硬规矩 7）。读失败/CLI 缺失/格式无路由都**显式画出来**，不装作空文档。
 */
import { useEffect, useRef } from "react";
import type { FullTextMatch } from "@contracts/library";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, Spinner } from "@renderer/components/ui/index.js";

/** 读结果的 detail 形状（CLI 的 items/blocks/slides）。各格式取交集展示。 */
interface GenofficeDetail {
  blocks?: number;
  slides?: number;
  sheets?: number;
  items?: Array<{ index?: number; type?: string; text?: string; title?: string }>;
  pages?: Array<{ index?: number; id?: string; elements?: unknown[] }>;
}

export function GenofficeDocumentPane({ filePath, searchLocation, searchText }: {
  filePath: string; searchLocation?: FullTextMatch["location"]; searchText?:string;
}) {
  const { t } = useI18n();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  // 能力诊断与文档读取分开取：能力失败不影响读（读会自己报 unavailable）。
  const caps = useRpc(() => api.document.capabilities(), [], { toastOnError: false });
  const doc = useRpc(() => api.document.read({ filePath, full: true }), [filePath], { toastOnError: false });

  const unavailableReason =
    doc.data !== undefined && doc.data.ok === false && doc.data.kind === "unavailable" ? doc.data.reason : null;
  const refusedReason =
    doc.data !== undefined && doc.data.ok === false && doc.data.kind === "refused" ? doc.data.reason : null;

  useEffect(() => {
    if (!doc.data?.ok || searchLocation?.block === undefined) return;
    const block = searchLocation.block;
    if (!Number.isInteger(block) || block < 0) return;
    // RequestAnimationFrame runs after the structured rows are painted.
    const frame = requestAnimationFrame(() => {
      scrollRootRef.current?.querySelector<HTMLElement>(`[data-document-block="${block}"]`)
        ?.scrollIntoView({block:"center",behavior:"smooth"});
    });
    return () => cancelAnimationFrame(frame);
  }, [doc.data,searchLocation?.block]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-code text-content-muted">
        <span className="font-medium text-content">GenOffice</span>
        <span className="truncate font-mono" title={filePath}>{filePath}</span>
        <span className="ml-auto flex items-center gap-2">
          {caps.data !== undefined && (
            <span className={caps.data.cli.available ? "text-success" : "text-warning"}>
              {caps.data.cli.available ? t("ide.genoffice.cliReady") : t("ide.genoffice.cliMissing")}
            </span>
          )}
          <Button size="sm" variant="ghost" disabled={doc.loading} onClick={() => void doc.refetch()}>
            {t("common.retry")}
          </Button>
        </span>
      </div>

      <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {doc.loading && <Spinner label={t("common.loading")} />}
        {doc.error !== null && (
          <ErrorNote action={<Button onClick={() => void doc.refetch()}>{t("common.retry")}</Button>}>
            {doc.error.message}
          </ErrorNote>
        )}
        {unavailableReason !== null && (
          <ErrorNote>
            <div className="font-medium">{t("ide.genoffice.unavailable")}</div>
            <div className="mt-1 text-content-muted">{unavailableReason}</div>
            {caps.data !== undefined && (
              <ul className="mt-2 list-disc pl-5 text-content-muted">
                {caps.data.needsApp.map((x) => <li key={x}>{x}</li>)}
                {caps.data.needsSidecar.map((x) => <li key={x}>{x}</li>)}
              </ul>
            )}
          </ErrorNote>
        )}
        {refusedReason !== null && <ErrorNote>{refusedReason}</ErrorNote>}

        {doc.data !== undefined && doc.data.ok && (() => {
          const detail = (doc.data.detail ?? {}) as GenofficeDetail;
          const rows: Array<{ key: string; text: string; block: number }> = [];
          if (detail.items !== undefined) {
            for (const item of detail.items) {
              rows.push({
                key: `b${item.index ?? rows.length}`,
                block: item.index ?? rows.length,
                text: `${item.type ?? "?"} · ${(item.text ?? item.title ?? "").slice(0, 200)}`,
              });
            }
          }
          if (detail.pages !== undefined) {
            for (const page of detail.pages) {
              rows.push({
                key: `p${page.index ?? rows.length}`,
                block: page.index ?? rows.length,
                text: `${t("ide.genoffice.page")} ${(page.index ?? 0) + 1} · ${page.elements?.length ?? 0} ${t("ide.genoffice.elements")}`,
              });
            }
          }
          const summary =
            detail.blocks !== undefined ? `${detail.blocks} ${t("ide.genoffice.blocks")}`
              : detail.slides !== undefined ? `${detail.slides} ${t("ide.genoffice.slides")}`
                : detail.sheets !== undefined ? `${detail.sheets} ${t("ide.genoffice.sheets")}`
                  : doc.data.summary ?? "";
          return (
            <div className="space-y-2">
              <div className="text-body text-content-muted">{summary}</div>
              {rows.length > 0 ? (
                <ol className="space-y-1">
                  {rows.map((r) => (
                    <li key={r.key} data-document-block={r.block}
                      className={`rounded border px-2 py-1 font-mono text-code text-content ${
                        searchLocation?.block === r.block ? "border-accent bg-accent/10" : "border-edge bg-surface-muted"
                      }`}>
                      {r.text}
                      {searchLocation?.block === r.block && searchText && <span className="mt-1 block break-words text-accent">{searchText.slice(0,300)}</span>}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="text-code text-content-subtle">{doc.data.summary ?? ""}</div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
