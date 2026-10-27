/**
 * 文档 / GenOffice 设置页 —— **六编辑器的宿主事实与边界，全部集中在这一页**。
 *
 * ## 为什么要有这一页
 *
 * 六个 GenOffice 编辑器（docs / sheets / slides / pdf / markdown / html）在
 * Mcode 里是**原厂编辑器内核 + Mcode 宿主外壳**：文件打开、保存、冲突检测、
 * 权限、AI 全部走 Mcode；只有渲染与编辑内核来自 GenOffice。用户在编辑器里
 * 找不到"GenOffice 的设置"，也不该找 —— 那一页在宿主里根本不该存在。
 *
 * 所以这一页只做三件事：
 *   1. **如实报告**每个格式在这台机器上的可用性（`document.capabilities()`
 *      就是唯一事实源，不猜、不美化）；
 *   2. 说清**AI 走哪里**（Mcode 的三家引擎；GenOffice 自带的 AI 面板与
 *      BYOK 配置在宿主里已被移除，不是"隐藏"）；
 *   3. 给出不可用时的**可执行下一步**（缺什么、去哪构建），而不是一句失败。
 *
 * ## 它刻意不做什么
 *
 * - **不提供 GenOffice 的 AI 配置**：模型、API Key、端点在 Mcode 的
 *   「模型配置」页，且只有那一份。在这里再放一份就是第二套事实源。
 * - **不改编辑器行为**：本页是只读的状态报告 + 跳转入口。真正会改变行为的
 *   设置（主题、字号、语言）在外观页，作用于整个 Mcode。
 * - **不假装能"检查更新"**：GenOffice 是随 Mcode 打包的固定快照，版本由
 *   Mcode 的发布决定，单独更新它会和宿主对不上。
 */
import { useMemo } from "react";
import type { ComponentType } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Badge, ErrorNote, Skeleton } from "@renderer/components/ui/index.js";
import {
  IconFileTypeDocx,
  IconFileSpreadsheet,
  IconFileTypePpt,
  IconFileTypePdf,
  IconFileTypeTxt,
  IconFileTypeHtml,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

type EditorKind = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

/** 六格式的展示名 + 图标。顺序 = 用户最常见到它们的顺序，不是字母序。 */
const EDITORS: ReadonlyArray<{
  kind: EditorKind;
  labelKey:
    | "settings.genoffice.docs"
    | "settings.genoffice.sheets"
    | "settings.genoffice.slides"
    | "settings.genoffice.pdf"
    | "settings.genoffice.markdown"
    | "settings.genoffice.html";
  ext: string;
  icon: ComponentType<TablerIconProps>;
}> = [
  { kind: "docs", labelKey: "settings.genoffice.docs", ext: ".docx", icon: IconFileTypeDocx },
  { kind: "sheets", labelKey: "settings.genoffice.sheets", ext: ".xlsx", icon: IconFileSpreadsheet },
  { kind: "slides", labelKey: "settings.genoffice.slides", ext: ".pptx", icon: IconFileTypePpt },
  { kind: "pdf", labelKey: "settings.genoffice.pdf", ext: ".pdf", icon: IconFileTypePdf },
  { kind: "markdown", labelKey: "settings.genoffice.markdown", ext: ".md", icon: IconFileTypeTxt },
  { kind: "html", labelKey: "settings.genoffice.html", ext: ".html", icon: IconFileTypeHtml },
];

/** `document.capabilities().hosts` 里每个格式对应的字段名。
 *
 *  ⚠️ `slides` 有两个字段：`slides`（结构化视图）与 `slidesNative`（原厂原生
 *  视图）。它们在报告里是**两件事**，混用会把「能看」说成「能编辑」。 */
function hostFieldFor(kind: EditorKind): string {
  return kind === "slides" ? "slidesNative" : kind;
}

export function GenofficePanel() {
  const { t } = useI18n();
  const caps = useRpc(() => api.document.capabilities(), [], { toastOnError: false });
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const report = useMemo(() => {
    const hosts = caps.data?.hosts as Record<string, unknown> | undefined;
    return EDITORS.map((editor) => {
      const raw = hosts === undefined ? undefined : hosts[hostFieldFor(editor.kind)];
      // 三态，不是一个布尔：`undefined` 是「能力报告还没到 / 这一项没报」，
      // 与「报了 false（这台机器确实不行）」必须分开显示 —— 否则页面会在
      // 数据到达前先闪一排「不可用」。
      const state: "available" | "unavailable" | "unknown" =
        raw === true ? "available" : raw === false ? "unavailable" : "unknown";
      return { ...editor, state };
    });
  }, [caps.data]);

  const cli = caps.data?.cli;
  const unavailableCount = report.filter((row) => row.state === "unavailable").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t("settings.genoffice.title")} icon={IconFileTypeDocx} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {caps.loading && (
          <div className="mt-5">
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {caps.error !== null && (
          <div className="mt-5">
            <ErrorNote title={t("settings.genoffice.capsFailed")}>
              <div>{caps.error.message}</div>
            </ErrorNote>
          </div>
        )}
        {!caps.loading && caps.error === null && (
          <div className="mt-5 space-y-5">
            <SettingsSection title={t("settings.genoffice.enginesTitle")}>
              {report.map((row) => {
                const Icon = row.icon;
                return (
                  <SettingRow
                    key={row.kind}
                    title={
                      <span className="flex items-center gap-2">
                        <Icon size={15} className="shrink-0 text-content-muted" />
                        <span>{t(row.labelKey)}</span>
                        <span className="font-mono text-[0.85em] text-content-muted">{row.ext}</span>
                      </span>
                    }
                    desc={
                      row.state === "available"
                        ? t("settings.genoffice.engineReady")
                        : row.state === "unavailable"
                          ? t("settings.genoffice.engineMissing")
                          : t("settings.genoffice.engineUnknown")
                    }
                  >
                    <Badge variant={row.state === "available" ? "success" : row.state === "unavailable" ? "warning" : "neutral"}>
                      {row.state === "available"
                        ? t("settings.genoffice.stateReady")
                        : row.state === "unavailable"
                          ? t("settings.genoffice.stateMissing")
                          : t("settings.genoffice.stateUnknown")}
                    </Badge>
                  </SettingRow>
                );
              })}
            </SettingsSection>

            {unavailableCount > 0 && (
              <SettingsSection title={t("settings.genoffice.howToFixTitle")}>
                <div className="px-4 py-3 text-[0.93em] leading-relaxed text-content-muted">
                  <p className="m-0">{t("settings.genoffice.howToFixBody")}</p>
                  {cli !== undefined && (
                    <p className="m-0 mt-2 break-all font-mono text-[0.85em]" data-genoffice-cli-path="">
                      {cli.available === true
                        ? t("settings.genoffice.cliFound", { path: cli.path ?? "" })
                        : t("settings.genoffice.cliMissing")}
                    </p>
                  )}
                </div>
              </SettingsSection>
            )}

            <SettingsSection title={t("settings.genoffice.aiTitle")}>
              <SettingRow
                title={t("settings.genoffice.aiRunsOn")}
                desc={t("settings.genoffice.aiRunsOnDesc")}
              >
                <button
                  type="button"
                  data-cds="GenofficeOpenModelSettings"
                  className="rounded-[var(--cds-radius-btn-xs)] border border-edge px-2.5 py-1 text-[0.93em] font-medium text-content transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => setSettingsOpen(true, "custom-models")}
                >
                  {t("settings.genoffice.openModelSettings")}
                </button>
              </SettingRow>
              <SettingRow
                title={t("settings.genoffice.aiNoVendorConfig")}
                desc={t("settings.genoffice.aiNoVendorConfigDesc")}
              >
                <Badge variant="neutral">{t("settings.genoffice.removed")}</Badge>
              </SettingRow>
            </SettingsSection>

            <SettingsSection title={t("settings.genoffice.behaviourTitle")}>
              <SettingRow
                title={t("settings.genoffice.themeTitle")}
                desc={t("settings.genoffice.themeDesc")}
              >
                <button
                  type="button"
                  className="rounded-[var(--cds-radius-btn-xs)] border border-edge px-2.5 py-1 text-[0.93em] font-medium text-content transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => setSettingsOpen(true, "appearance")}
                >
                  {t("settings.genoffice.openAppearance")}
                </button>
              </SettingRow>
              <SettingRow
                title={t("settings.genoffice.saveGuardTitle")}
                desc={t("settings.genoffice.saveGuardDesc")}
              >
                <Badge variant="neutral">{t("settings.genoffice.alwaysOn")}</Badge>
              </SettingRow>
            </SettingsSection>
          </div>
        )}
      </div>
    </div>
  );
}
