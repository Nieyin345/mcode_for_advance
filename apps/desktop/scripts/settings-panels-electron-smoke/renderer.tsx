// 【MC-026 复核】真 Electron 下挂**真面板**的渲染端入口(按 ?panel= 选一个)。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CustomModelsPanel } from "@renderer/components/settings/CustomModelsPanel.js";
import { EngineToolsPanel } from "@renderer/components/settings/EngineToolsPanel.js";
import { WorkflowLibraryView } from "@renderer/components/settings/workflows/WorkflowLibraryView.js";
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

const panelEl =
  panel === "engine-tools" ? (
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
    <main className="h-screen bg-surface p-6 text-content">{panelEl}</main>
  </StrictMode>,
);

queueMicrotask(() => {
  probeWindow.__probe!.mounted = true;
  probeWindow.__ready = true;
});
