// 【MC-026 复核】真 Electron 下挂**真面板**的渲染端入口(按 ?panel= 选一个)。
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CustomModelsPanel } from "@renderer/components/settings/CustomModelsPanel.js";
import { EngineToolsPanel } from "@renderer/components/settings/EngineToolsPanel.js";
import { WorkflowLibraryView } from "@renderer/components/settings/workflows/WorkflowLibraryView.js";
import { AppearancePanel } from "@renderer/components/settings/AppearancePanel.js";
import { GeneralPanel } from "@renderer/components/settings/GeneralPanel.js";
import { Toaster } from "@renderer/components/layout/Toaster.js";
import { useTheme } from "@renderer/lib/theme.js";
import { useChatAppearance, useRightPanelAppearance, useThemeStyle } from "@renderer/lib/appearance.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import catalogJson from "./catalog.generated.json";

const params = new URLSearchParams(location.search);
const panel = params.get("panel") ?? "custom-models";
const catalog = catalogJson as unknown as import("@contracts/nodeType").NodeTypeCatalog;

interface ProbeWindow extends Window {
  __probe?: { renderError: string | null; mounted: boolean };
  __ready?: boolean;
}
const probeWindow = window as ProbeWindow;
probeWindow.__probe = { renderError: null, mounted: false };

useSessionStore.setState({ locale: "zh" });

/**
 * 【MC-026 复核·外观即时生效】真 `App` 的四个外观 hook 在这里**原样挂一遍**:
 *  `useTheme`(主进程 theme.changed → `<html>.dark`)、`useChatAppearance` /
 *  `useRightPanelAppearance`(store → `--chat-font-size` / `--right-panel-font-size`)、
 *  `useThemeStyle`(`<html>.sketch`)。生产里这四行在 `App.tsx` 的 AppRoot 内,
 *  SettingsPanel 只在设置页打开时才挂 —— 本套件直接挂面板,所以把同一批 hook
 *  放进一个包装组件(不复制实现,只调用生产的 hook)。
 */
function AppearanceShell({ children }: { children: ReactNode }) {
  useTheme();
  useChatAppearance();
  useRightPanelAppearance();
  useThemeStyle();
  return <>{children}</>;
}

const panelEl =
  panel === "appearance" ? (
    <AppearancePanel />
  ) : panel === "general" ? (
    <GeneralPanel />
  ) : panel === "engine-tools" ? (
    <EngineToolsPanel />
  ) : panel === "automation" ? (
    <WorkflowLibraryView
      purpose="automation"
      catalog={catalog}
      catalogError={null}
      onRetryCatalog={() => {}}
      profiles={[]}
      profileError={null}
      onSaveProfile={async () => true}
      onRemoveProfile={async () => {}}
      focusWorkflowId="auto-1"
    />
  ) : (
    <CustomModelsPanel />
  );

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    probeWindow.__probe!.renderError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  },
}).render(
  <StrictMode>
    <AppearanceShell>
      {/* 与生产 SettingsPage 的容器同形:`fontSize: var(--right-panel-font-size)`
          (见 SettingsPage.tsx 的 center style)—— 断言"正文计算字号随设置变化"时
          量的就是这一层,而不是另造一套变量读取。 */}
      <main className="h-screen bg-surface p-6 text-content" style={{ fontSize: "var(--right-panel-font-size)" }}>
        {panelEl}
        {/* 聊天正文消费的 `--chat-font-size` 探针(与 MessageRow/Markdown 同一个类写法):
            让"计算值真的变了"可以量,而不只是读内联变量。 */}
        <span data-testid="chat-font-probe" aria-hidden className="[font-size:var(--chat-font-size)]">
          probe
        </span>
      </main>
      <Toaster />
    </AppearanceShell>
  </StrictMode>,
);

queueMicrotask(() => {
  probeWindow.__probe!.mounted = true;
  probeWindow.__ready = true;
});
