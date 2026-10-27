/**
 * Theia 扩展宿主的 IPC 契约 —— **转发文件**。
 *
 * 这些类型定义在 `./modules.ts`（那里同时还有模块清单 / 权限 / 能力目录）。
 * 本文件只把它们再导出一次，让消费方可以按**域** import：
 *
 *   - `@contracts/ipc/theia.js`  —— 扩展宿主、Webview、语言 provider
 *   - `@contracts/ipc/modules.js` —— 模块清单、安装卡、能力目录
 *
 * ⚠️ **不要在这里复制定义。** 同一个类型两处各写一份，改一处忘一处就是
 * 两个真相 —— 这个仓库为这件事栽过。这里只有 `export`，没有 `const`/`interface`。
 *
 * 背景：`renderer/components/modules/Theia*.tsx` 与 `theiaHost/*` 已经按
 * `@contracts/ipc/theia.js` 写好了 import；这个文件存在的唯一目的是满足它们，
 * 同时不把 `modules.ts` 拆散。
 */
export type {
  TheiaCommandContribution,
  TheiaUiContribution,
  TheiaWebviewViewContribution,
  TheiaCustomEditorContribution,
  TheiaPreviewInput,
  TheiaPreviewPermissionPrompt,
  TheiaPreviewResult,
  TheiaMonacoEditorSnapshot,
  TheiaMonacoEditRequest,
  TheiaRuntimeMessage,
  TheiaWebviewEvent,
  TheiaExtensionDiagnostic,
  TheiaDiagnosticsEvent,
  TheiaEditorMenu,
  TheiaContributionChanged,
  TheiaStatusEntry,
  TheiaQuickInputRequest,
  TheiaLanguageProviderKind,
  TheiaLanguageLocation,
  TheiaLanguageRange,
  TheiaLanguageSymbol,
  TheiaLanguageTextEdit,
  TheiaRenameLocation,
  TheiaLanguageCodeAction,
  TheiaLanguageSignature,
  TheiaSignatureHelp,
  TheiaInstalledInput,
  TheiaInstalledEntry,
  TheiaNativeConfigSetting,
  TheiaInstalledResult,
} from "./modules.js";
export {
  TheiaPreviewInputSchema,
  TheiaInstalledInputSchema,
} from "./modules.js";
