// 【MC-026 复核】真 Electron 下挂**真面板**的渲染端入口(按 ?panel= 选一个)。
//
// 【MC-045 复核·U1】`?panel=app` 挂真 `App`(含真 SettingsPage / 真 store):深链
// 判据必须落在"用户看得见的高亮与内容"上,而那两样只有真设置页才画得出来。其余
// `?panel=` 维持 MC-026 的单面板夹具不变。
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CustomModelsPanel } from "@renderer/components/settings/CustomModelsPanel.js";
import { EngineToolsPanel } from "@renderer/components/settings/EngineToolsPanel.js";
import { WorkflowLibraryView } from "@renderer/components/settings/workflows/WorkflowLibraryView.js";
import { EngineRuntimePanel } from "@renderer/components/settings/workflows/EngineRuntimePanel.js";
import { AppearancePanel } from "@renderer/components/settings/AppearancePanel.js";
import { GeneralPanel } from "@renderer/components/settings/GeneralPanel.js";
import { ApprovalPrompt } from "@renderer/components/chat/ApprovalPrompt.js";
import { App } from "@renderer/App.js";
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
  __store?: typeof useSessionStore;
}
const probeWindow = window as ProbeWindow;
probeWindow.__probe = { renderError: null, mounted: false };
probeWindow.__store = useSessionStore;

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

/** `?panel=app` 挂的是真 `App`,它自己就调这四个 hook —— 不要再套一层
 *  (重复订阅 theme.changed 会把同一次推送处理两遍;夹具要的是生产形状,不是双份)。 */
function MaybeAppearanceShell({ children }: { children: ReactNode }) {
  return panel === "app" ? <>{children}</> : <AppearanceShell>{children}</AppearanceShell>;
}

/**
 * 【ARC-005 输入保护】真 `ApprovalPrompt` 夹具（Claude 工具审批卡）。
 *
 * 挂在 `?panel=approval`：记录每次 `onDecide` 的参数到 `window.__approvalDecisions`，
 * 供探针断言「Esc → denied」「延迟期内允许不可点、等待后可以批准」。真组件、真事件，
 * 不伪造任何焦点状态。
 */
function ApprovalHarness({ providerName, toolName }: { providerName: string; toolName: string }) {
  const [n, setN] = useState(0);
  const decisions = ((window as unknown as { __approvalDecisions?: Array<{ granted: boolean; always?: boolean }> })
    .__approvalDecisions ??= []);
  return (
    <div>
      <ApprovalPrompt
        key={n}
        providerName={providerName}
        toolName={toolName}
        input={{ command: "echo arc005" }}
        queuePosition={1}
        queueTotal={1}
        onDecide={(granted, always) => {
          decisions.push({ granted, always });
          // 决策之后重新挂一片新卡，便于探针连续验证「延迟 → 可批」而不刷新页面。
          setN((v) => v + 1);
        }}
      />
    </div>
  );
}

const panelEl =
  panel === "app" ? (
    // 真 App:设置覆盖层、真 SettingsPage、真 sessionStore 全在里面(MC-045)。
    <App />
  ) : panel === "approval" ? (
    <ApprovalHarness providerName="Agent A" toolName="Bash" />
  ) : panel === "engine-runtime" ? (
    // 真引擎面板（含 EngineNodePackagesSection 的安装审批卡）。主进程推送审批
    // 请求由探针 `wc.send("workflowEngine:nodeInstallApproval", …)` 触发。
    <EngineRuntimePanel />
  ) : panel === "appearance" ? (
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
      onOpenNativeEditor={() => {}}
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
    <MaybeAppearanceShell>
      {/* 与生产 SettingsPage 的容器同形:`fontSize: var(--right-panel-font-size)`
          (见 SettingsPage.tsx 的 center style)—— 断言"正文计算字号随设置变化"时
          量的就是这一层,而不是另造一套变量读取。`?panel=app` 挂的是真 App,
          它自带根布局,不再套这层探针容器(但 chat-font 探针照留)。 */}
      {panel === "app" ? (
        panelEl
      ) : (
        <main className="h-screen bg-surface p-6 text-content" style={{ fontSize: "var(--right-panel-font-size)" }}>
          {panelEl}
        </main>
      )}
      {/* 聊天正文消费的 `--chat-font-size` 探针(与 MessageRow/Markdown 同一个类写法):
          让"计算值真的变了"可以量,而不只是读内联变量。 */}
      <span data-testid="chat-font-probe" aria-hidden className="[font-size:var(--chat-font-size)]">
        probe
      </span>
      <Toaster />
    </MaybeAppearanceShell>
  </StrictMode>,
);

queueMicrotask(() => {
  probeWindow.__probe!.mounted = true;
  probeWindow.__ready = true;
});
