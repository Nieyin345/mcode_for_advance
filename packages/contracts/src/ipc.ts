/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import { WorkflowDocSchema, type WorkflowDoc, type WorkflowListEntry } from "./workflow.js";
import { HookSpecSchema, type HookRun, type HookSpec } from "./hook.js";
import { AgentProfileSchema, type AgentProfile, type AgentProfileCatalog } from "./agentProfile.js";
import type { NodeTypeCatalog } from "./nodeType.js";
import {
  TEMPLATE_KINDS,
  type TemplateEntry,
  type TemplateFileContent,
  type TemplateKind,
} from "./templates.js";
import type { Project, Session, MessageRecord, TurnInput, ApprovalDecision, SessionBookmark } from "./session.js";
import type { ProviderCapabilities, UserInputAnswers, BuiltinModelOption } from "./provider.js";
import type { CustomModelPublic, CustomModelInput, TestCustomModelResult } from "./customModel.js";
import type { PiProviderConfig, PiProviderPublic } from "./piModel.js";
import type { CodexProviderPublic } from "./codexModel.js";
import type { ThemeName, EffectiveTheme, ThemeChangedMessage } from "./theme.js";
import type { PairingStartResult, PairedDevice } from "./mobile.js";
import type { RelayStatus, RelayVpsConfig, RelayVpsConfigInput } from "./relay.js";
import type {
  LibraryItem,
  LibraryCollection,
  InstitutionProfile,
  DownloadJob,
  DownloadStatus,
  ExternalSearchResult,
  FullTextMatch,
  AuthSiteStatus,
  LibraryConversionRow,
  LibraryNote,
} from "./library.js";
import { LIBRARY_KINDS, type LibraryKind } from "./library.js";
import type {
  PluginState,
  PluginMarketplaceState,
  PluginsInstallLocalInput,
  PluginsInstallGitInput,
  PluginsInstallMarketplaceInput,
  PluginsSetEnabledInput,
  PluginsRemoveInput,
  PluginsMarketplaceAddInput,
  PluginsMarketplaceRemoveInput,
  PluginsMarketplaceRefreshInput,
} from "./plugin.js";

// Re-export the plugin contracts so consumers can import from "@contracts/ipc"
// (mirrors the relay.ts pattern).
export {
  BUILTIN_MARKETPLACES,
  PLUGINS_ENABLED_SETTING_KEY,
  PLUGINS_MARKETPLACES_SETTING_KEY,
  PLUGINS_MCP_DISABLED_SETTING_KEY,
  PLUGIN_MANIFEST_DIRS,
  PLUGIN_NAME_RE,
  PluginManifestSchema,
  PluginMarketEntrySourceSchema,
  PluginMarketEntrySchema,
  PluginMarketplaceManifestSchema,
  PluginsListSchema,
  PluginsInstallLocalSchema,
  PluginsInstallGitSchema,
  PluginsInstallMarketplaceSchema,
  PluginsSetEnabledSchema,
  PluginsRemoveSchema,
  PluginsMarketplaceListSchema,
  PluginsMarketplaceAddSchema,
  PluginsMarketplaceRemoveSchema,
  PluginsMarketplaceRefreshSchema,
} from "./plugin.js";
export type {
  PluginManifest,
  PluginMarketEntrySource,
  PluginMarketplaceManifest,
  PluginSkillSummary,
  PluginCommandSummary,
  PluginAgentSummary,
  PluginHookSummary,
  PluginMcpKind,
  PluginMcpServerSummary,
  PluginComponents,
  PluginSourceKind,
  PluginSourceInfo,
  PluginState,
  PluginMarketplaceRecord,
  PluginMarketEntry,
  PluginMarketplaceState,
  PluginsListInput,
  PluginsInstallLocalInput,
  PluginsInstallGitInput,
  PluginsInstallMarketplaceInput,
  PluginsSetEnabledInput,
  PluginsRemoveInput,
  PluginsMarketplaceListInput,
  PluginsMarketplaceAddInput,
  PluginsMarketplaceRemoveInput,
  PluginsMarketplaceRefreshInput,
} from "./plugin.js";

// Re-export relay types so consumers can import from "@contracts/ipc".
export type {
  RelayState,
  RelayStatus,
  RelayVpsConfig,
  RelayVpsConfigInput,
  RelayForwarderChoice,
} from "./relay.js";
export {
  RelayVpsConfigSchema,
  RELAY_CONFIG_SETTING_KEY,
  RELAY_DEFAULT_PUBLIC_PORT,
} from "./relay.js";


/*
 * 下面按域 re-export。ipc.ts 本身只是**门面**(facade)—— 每个域模块住在 ./ipc/ 里,
 * 调用方继续从 `@contracts/ipc` 导入,一行不用改。依赖方向:域文件 → 兄弟
 * contracts 模块,**绝不**反向 import 本文件(那会把门面变成环)。加一个域:
 * 在 ./ipc/ 建文件,回这里加一行 export *。
 */
export * from "./ipc/settings.js";
export * from "./ipc/session.js";
export * from "./ipc/voice.js";
export * from "./ipc/notifications.js";
export * from "./ipc/providers.js";
export * from "./ipc/app.js";
export * from "./ipc/files.js";
export * from "./ipc/git.js";
export * from "./ipc/skills.js";
export * from "./ipc/mcp.js";
export * from "./ipc/context.js";
export * from "./ipc/usage.js";
export * from "./ipc/lsp.js";
export * from "./ipc/runtimes.js";
export * from "./ipc/workflow.js";
export * from "./ipc/events.js";
export * from "./ipc/terminal.js";
export * from "./ipc/browser.js";
export * from "./ipc/library.js";
export * from "./ipc/templates.js";
// 记忆契约(存储/检索/维护共用的那一份,渠道字符串钉在里面)。
export * from "./memory.js";
// 编排域:运行史、触发器事实、监控。
export * from "./ipc/orchestration.js";
export * from "./ipc/rpcMap.js";
