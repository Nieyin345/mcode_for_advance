import { z } from "zod";
import { ModuleManifestSchema } from "../modules.js";
import { ModuleGrantedPermissionsSchema } from "../modulePermissions.js";
export { ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "../modules.js";
/** 【T18】安装卡片的**三态** —— 与手机装软件同一语义。
 *
 *  - `allow-once`   —— 本次安装 + 本次运行有效；重启后重新询问。
 *  - `allow-always` —— 写入持久决策；仍绑定「扩展身份 + 权限集指纹」，
 *    清单/权限/程序任一变化都会强制重新询问。
 *  - `deny`         —— 安装中止，**磁盘无任何写入**（不是"先装了再禁用"）。
 *
 * 信任模型与既有的 `confirmReadAccess` / `confirmExecutableCode` 一致：这一层
 * 记录的是**渲染端用户在卡片上的选择**。主进程**不采信**非桌面窗口发来的
 * `allow-always`（Agent / 扩展委托 / 面板桥都没有真实渲染端发送方）——
 * 那些入口一律按 `allow-once` 落盘，见 `ipc/modules.ts`。这样"永远允许"只能
 * 由坐在电脑前的用户亲自给出，任何自动化通道都无法铸造跨重启授权。
 */
export const MODULE_INSTALL_CONSENT_DECISIONS = ["allow-once", "allow-always", "deny"] as const;
export const ModuleInstallConsentSchema = z.enum(MODULE_INSTALL_CONSENT_DECISIONS);
export type ModuleInstallConsentDecision = z.infer<typeof ModuleInstallConsentSchema>;
export const ModuleInstallSchema = z.object({
  manifest:ModuleManifestSchema,
  confirmReadAccess:z.literal(true),
  /** Explicit user-chosen subset of the manifest, including an empty grant. */
  grantedPermissions:ModuleGrantedPermissionsSchema.optional(),
  /** 【MC-035】带 `program` 的扩展包**额外**要求一次针对"会执行代码"的确认 ——
   *  与只读声明分开:同意"读我选中的文件"不等于同意"在我机器上跑一段程序"。
   *  桌面 UI 勾选框与 Agent 的 danger 审批卡(每次必弹)是两个入口的同一件事。 */
  confirmExecutableCode:z.literal(true).optional(),
  /** 【T18】安装卡片的选择（见 {@link MODULE_INSTALL_CONSENT_DECISIONS}）。
   *  缺省 = `allow-once`：不携带持久授权，重启后重新询问。 */
  installConsent:ModuleInstallConsentSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.grantedPermissions !== undefined) {
    for (const grant of value.grantedPermissions) {
      if (!value.manifest.permissions.includes(grant)) context.addIssue({
        code:z.ZodIssueCode.custom, path:["grantedPermissions"], message:`Not declared in manifest: ${grant}`,
      });
    }
  }
  if (value.manifest.program !== undefined && value.confirmExecutableCode !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmExecutableCode"], message: "Executable module installs require explicit code-execution consent" });
  }
});
export type ModuleInstallInput = z.infer<typeof ModuleInstallSchema>;

/** 【F006】从 `.vsix` 安装的输入。
 *
 *  与 {@link ModuleInstallSchema} 的**关键区别**：这里没有 `manifest` —— 清单是从
 *  vsix 包里读出来的，渲染端提供的只是一份路径与用户的同意。**渲染端不能借这条
 *  通道塞一个自己拼的清单**（那等于绕过 `modules.install` 的 manifest 校验）。
 *
 *  `installConsent` 的三态语义与 `ModuleInstallSchema` 完全一致，见
 *  {@link MODULE_INSTALL_CONSENT_DECISIONS}。`deny` 时主进程在**解析 vsix 之前**
 *  就中止，磁盘零写入。
 */
export const ModuleInstallVsixSchema = z.object({
  /** 用户从文件选择器里选中的 `.vsix` 路径（绝对路径）。 */
  path: z.string().min(1).max(4096),
  confirmReadAccess: z.literal(true),
  /** 【MC-035】vsix 里带的 `extension.js` 是要在本机跑的程序 —— 与 `modules.install`
   *  同一条规矩：同意"读我选中的文件"不等于同意"在我机器上跑一段程序"。 */
  confirmExecutableCode: z.literal(true).optional(),
  installConsent: ModuleInstallConsentSchema.optional(),
}).strict();
export type ModuleInstallVsixInput = z.infer<typeof ModuleInstallVsixSchema>;

/** 一个被 VSIX 宿主**接受、但不会真正生效**的贡献点。
 *
 * 【F012】为什么要带 `kind` 而不只是一个字符串：
 * `declarative`（我们不**读**）与 `runtime`（我们不**做**）对用户意味着不同的事 ——
 * 一个是「设置项改了没用」，一个是「菜单项不会出现」。压成一个字符串会丢掉这个区分，
 * 而那个区分正是让用户判断「还要不要用这个扩展」的依据。 */
export interface IgnoredVsixContribution {
  /** 贡献点名，如 `configuration` / `menus`。 */
  section: string;
  /** `declarative` = 本宿主不读取；`runtime` = 本宿主不实现。 */
  kind: "declarative" | "runtime";
}

/** 【F006】从 vsix 安装的回包。在 `ModuleChangeResult` 之上多一个 `moduleId` ——
 *  渲染端要拿它做提示（「已安装：user.publisher.name」），而这个 ID 是主进程从
 *  vsix 里解析出来的，渲染端自己拼不出来（publisher/name 在包里）。
 *
 *  【F012】再加 `ignoredContributions`：装上真实扩展之后，它的菜单项不出现、
 *  设置项不生效 —— **用户会以为自己装坏了**。这个列表是唯一能让他停止自我怀疑的东西。
 *
 *  ⚠️ **它放在这里，不是放进 `ModuleChangeResult`** —— 后者是 `modules.install` 与
 *  `modules.remove` 共用的返回类型，往那里加字段会让 `remove` 也承诺返回一个
 *  它永远不会有的列表（变异表第 3 条就是验这个）。VSIX 独有的信息进 VSIX 独有的类型。 */
export interface ModuleInstallVsixResult {
  catalog: import("../modules.js").ModuleCatalog;
  cancelledTasks: number;
  cancelFailures: Array<{ taskId: string; reason: string }>;
  moduleId: string;
  ignoredContributions: IgnoredVsixContribution[];
}

/** 扩展在 `contributes.commands` 里声明的命令。 */
export interface TheiaCommandContribution { commandId:string; title:string; category?:string }

/** 由 Mcode 自己的界面渲染的扩展动作（标题栏 / 编辑器标题菜单）。 */
export interface TheiaUiContribution {
  commandId:string; label:string;
  placement:"toolbar"|"editor"; group?:string; when?:string;
}

/** 扩展声明的 Webview 视图（`contributes.views`）。 */
export interface TheiaWebviewViewContribution { viewType:string; name:string; container?:string }

/** 扩展声明的自定义编辑器（`contributes.customEditors`）。 */
export interface TheiaCustomEditorContribution { viewType:string; displayName:string; filenamePatterns:string[] }

/** F025: an explicit, temporary Theia compatibility preview, NOT a persistent module install.
 * Inspection performs no extension execution. Start needs a short-lived one-use ticket and a
 * second explicit user gesture. No session or ticket may come from an Agent bridge. */
export const TheiaPreviewInputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("inspect"), path: z.string().min(1).max(4096) }).strict(),
  z.object({ op: z.literal("start"), ticket: z.string().uuid(), accepted: z.literal(true) }).strict(),
  z.object({ op: z.literal("cancel"), ticket: z.string().uuid() }).strict(),
  z.object({ op: z.literal("execute"), sessionId: z.string().uuid(), commandId: z.string().min(1).max(256) }).strict(),
  z.object({ op: z.literal("stop"), sessionId: z.string().uuid() }).strict(),
]);
export type TheiaPreviewInput = z.infer<typeof TheiaPreviewInputSchema>;
export interface TheiaPreviewPermissionPrompt {
  extensionId: string;
  headline: string;
  capabilities: Array<{ capability: "readsFiles" | "writesFiles" | "spawnsProcesses" | "network"; label: string; evidence: string[] }>;
  limits: string[];
  disclosure: string;
}
export type TheiaPreviewResult =
  | { kind: "inspection"; ticket: string; extensionId: string; fileCount: number; prompt: TheiaPreviewPermissionPrompt }
  | { kind: "started"; sessionId: string; extensionId: string; commands: string[]; activationErrors: string[] }
  | { kind: "executed"; result: string }
  | { kind: "stopped" };

/** F029: bounded Mcode editor owner snapshot + reverse edit confirmation.
 * Transaction ranges are 1-based (Monaco), text offsets UTF-16.
 */
export interface TheiaMonacoEditorSnapshot {
  filePath:string; languageId:string; text:string;
  selection?:{start:{line:number;character:number};end:{line:number;character:number}};
}
export interface TheiaMonacoEditRequest {
  channel:"modules:theiaEditorApply";
  requestId:string; sessionId:string;
  transaction:{
    filePath:string;version:number;beforeText:string;afterText:string;
    edits:Array<{range:{startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number};
      text:string;rangeOffset:number;rangeLength:number}>;
    undoStopBefore:boolean;undoStopAfter:boolean;
  };
}

/** F031: runtime extension notifications, rendered by Mcode's existing toast/dialog layer.
 * Exact source sender and session are checked when returning an action choice.
 */
export interface TheiaRuntimeMessage {
  channel:"modules:theiaRuntimeMessage";requestId:string;sessionId:string;extensionId:string;
  kind:"info"|"warning"|"error";message:string;detail?:string;
  modal:boolean;actions:string[];
}
/** F034: sandboxed inline Webview event flow.
 * No local file loading, Node integration, external scripts or untrusted
 * scheme conversion; advanced VS Code Webview resources remain unsupported.
 */
export interface TheiaWebviewEvent {
  channel:"modules:theiaWebview";sessionId:string;extensionId:string;
  handle:string;
  /** `options` = 扩展改了 webview 的 options（enableScripts / localResourceRoots）；
   *  `description` / `badge` / `dirty` 是编辑器标题栏的附属状态。 */
  action:"create"|"html"|"message"|"dispose"|"title"|"reveal"|"options"|"description"|"badge"|"dirty";
  title?:string;html?:string;payload?:unknown;state?:unknown;
  /** `options` 动作：是否允许脚本、允许读哪些本地根。 */
  enableScripts?:boolean;resourceOrigin?:string;
  /** 这个 webview 挂在哪：面板 / 侧边视图 / 自定义编辑器。 */
  surface?:"panel"|"view"|"custom-editor";viewType?:string;
  description?:string|null;badge?:{value:number;tooltip?:string}|null;
  /** 自定义编辑器文档状态。 */
  filePath?:string;editable?:boolean;dirty?:boolean;undoCount?:number;redoCount?:number;
  /** `reveal` 动作：是否正在前台。 */
  active?:boolean;
}
/** F033: native VS Code diagnostics owned by the active Theia session. */
export interface TheiaExtensionDiagnostic {
  startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number;
  severity:1|2|4|8;message:string;source?:string;code?:string;
}
export interface TheiaDiagnosticsEvent {
  channel:"modules:theiaDiagnostics";sessionId:string;collectionId:string;
  resource:string;markers:TheiaExtensionDiagnostic[];removed?:boolean;
}
/** F032: status bar entries are ordinary Mcode chrome contributed by VS Code extensions. */
export interface TheiaEditorMenu {
  commandId:string;label:string;group?:string;when?:string;
}
export interface TheiaContributionChanged {
  channel:"modules:theiaContributionChanged";sessionId:string;
}
export interface TheiaStatusEntry {
  channel:"modules:theiaStatusEntry";sessionId:string;extensionId:string;id:string;
  removed?:boolean;text?:string;name?:string;tooltip?:string;command?:string;
  priority?:number;alignment?:number;
}
/** F032: Quick Pick/Input Box using native Mcode modal UI. */
export interface TheiaQuickInputRequest {
  channel:"modules:theiaQuickInput";requestId:string;sessionId:string;extensionId:string;
  kind:"input"|"pick";title?:string;placeholder?:string;value?:string;password?:boolean;
  canPickMany?:boolean;items?:Array<{label:string;description?:string;detail?:string}>;
}
/** VS Code language-provider contributions supported by Mcode's native Monaco. */
export type TheiaLanguageProviderKind =
  | "hover" | "completion" | "definition" | "references" | "implementation" | "typeDefinition"
  | "documentSymbols" | "formatting" | "rangeFormatting" | "onTypeFormatting" | "signatureHelp"
  | "rename" | "codeActions";
/** File location returned by an installed extension. Coordinates are zero-based VS Code positions. */
export interface TheiaLanguageLocation {
  uri:string;
  range:{
    start:{line:number;character:number};
    end:{line:number;character:number};
  };
}
/** F036: bounded native Monaco language contributions; no extension-controlled file write. */
export interface TheiaLanguageRange {
  start:{line:number;character:number};
  end:{line:number;character:number};
}
export interface TheiaLanguageSymbol {
  name:string;detail:string;kind:number;range:TheiaLanguageRange;
  selectionRange:TheiaLanguageRange;children:TheiaLanguageSymbol[];
}
/** F038: only bounded same-document text edits; never file operations or commands. */
export interface TheiaLanguageTextEdit {range:TheiaLanguageRange;text:string}
export interface TheiaRenameLocation {range:TheiaLanguageRange;text:string}
export interface TheiaLanguageCodeAction {title:string;kind?:string;isPreferred?:boolean;edits:TheiaLanguageTextEdit[]}
export interface TheiaLanguageSignature {
  label:string;documentation?:string;parameters:Array<{label:string;documentation?:string}>;
  activeParameter?:number;
}
export interface TheiaSignatureHelp {
  signatures:TheiaLanguageSignature[];activeSignature:number;activeParameter:number;
}
/** F026: persistent Theia VSIX installs. Every command is desktop-only and non-delegable. */
export const TheiaInstalledInputSchema = z.discriminatedUnion("op", [
  z.object({op:z.literal("list")}).strict(),
  z.object({op:z.literal("inspect"),path:z.string().min(1).max(4096)}).strict(),
  z.object({op:z.literal("cancel"),ticket:z.string().uuid()}).strict(),
  z.object({op:z.literal("install"),ticket:z.string().uuid(),accepted:z.literal(true)}).strict(),
  z.object({op:z.literal("start"),id:z.string().uuid(),workspacePath:z.string().min(1).max(4096).optional()}).strict(),
  z.object({op:z.literal("execute"),sessionId:z.string().uuid(),commandId:z.string().min(1).max(256),args:z.array(z.string().max(4096)).max(5).optional()}).strict(),
  z.object({op:z.literal("editorSync"),sessionId:z.string().uuid(),editor:z.object({
    filePath:z.string().min(1).max(4096),languageId:z.string().min(1).max(100),text:z.string().max(2_000_000),
    selection:z.object({start:z.object({line:z.number().int().min(0),character:z.number().int().min(0)}).strict(),
      end:z.object({line:z.number().int().min(0),character:z.number().int().min(0)}).strict()}).strict().optional(),
  }).strict().nullable()}).strict(),
  z.object({op:z.literal("editorApplied"),sessionId:z.string().uuid(),requestId:z.string().uuid(),accepted:z.boolean()}).strict(),
  z.object({op:z.literal("webviewMessage"),sessionId:z.string().uuid(),
    handle:z.string().min(1).max(256),payload:z.unknown()}).strict(),
  z.object({op:z.literal("webviewDispose"),sessionId:z.string().uuid(),
    handle:z.string().min(1).max(256)}).strict(),
  z.object({op:z.literal("languageQuery"),sessionId:z.string().uuid(),
    query:z.enum(["hover","completion","definition","references","implementation","typeDefinition",
      "documentSymbols","formatting","rangeFormatting","onTypeFormatting","signatureHelp",
      "rename","codeActions"]),
    lineNumber:z.number().int().min(1).max(100000),column:z.number().int().min(1).max(100000),
    includeDeclaration:z.boolean().optional(),
    editContext:z.object({newName:z.string().min(1).max(256).optional(),prepare:z.boolean().optional(),
      range:z.object({start:z.object({line:z.number().int().min(0).max(100000),character:z.number().int().min(0).max(100000)}).strict(),
        end:z.object({line:z.number().int().min(0).max(100000),character:z.number().int().min(0).max(100000)}).strict()}).strict().optional(),
      trigger:z.number().int().min(1).max(2).optional()}).strict().optional(),
    formatOptions:z.object({tabSize:z.number().int().min(1).max(16),insertSpaces:z.boolean()}).strict().optional(),
    formatContext:z.object({range:z.object({
      start:z.object({line:z.number().int().min(0).max(100000),character:z.number().int().min(0).max(100000)}).strict(),
      end:z.object({line:z.number().int().min(0).max(100000),character:z.number().int().min(0).max(100000)}).strict(),
    }).strict().optional(),triggerCharacter:z.string().min(1).max(2).optional()}).strict().optional(),
    signatureContext:z.object({triggerKind:z.number().int().min(1).max(3),
      isRetrigger:z.boolean(),triggerCharacter:z.string().max(2).optional()}).strict().optional()}).strict(),
  z.object({op:z.literal("messageRespond"),sessionId:z.string().uuid(),requestId:z.string().uuid(),choice:z.number().int().min(0).max(7).nullable()}).strict(),
  z.object({op:z.literal("quickRespond"),sessionId:z.string().uuid(),requestId:z.string().uuid(),
    choice:z.union([z.string().max(4096),z.array(z.number().int().min(0).max(199)).max(50),z.null()])}).strict(),
  z.object({op:z.literal("webviewList")}).strict(),
  z.object({op:z.literal("webviewViewOpen"),sessionId:z.string().uuid(),viewType:z.string().min(1).max(256)}).strict(),
  z.object({op:z.literal("customEditorOpen"),sessionId:z.string().uuid(),viewType:z.string().min(1).max(256),filePath:z.string().min(1).max(4096)}).strict(),
  z.object({op:z.literal("customEditorAction"),sessionId:z.string().uuid(),handle:z.string().min(1).max(256),action:z.enum(["save","revert","undo","redo"])}).strict(),
  z.object({op:z.literal("webviewStateSet"),sessionId:z.string().uuid(),handle:z.string().min(1).max(256),state:z.unknown()}).strict(),
  z.object({op:z.literal("webviewReveal"),sessionId:z.string().uuid(),handle:z.string().min(1).max(256)}).strict(),
  z.object({op:z.literal("stop"),sessionId:z.string().uuid()}).strict(),
  z.object({op:z.literal("setEnabled"),id:z.string().uuid(),enabled:z.boolean()}).strict(),
  z.object({op:z.literal("configList"),id:z.string().uuid()}).strict(),
  z.object({op:z.literal("configSet"),id:z.string().uuid(),key:z.string().min(1).max(150),
    value:z.union([z.string().max(4096),z.number().finite(),z.boolean(),z.null()])}).strict(),
  z.object({op:z.literal("remove"),id:z.string().uuid()}).strict(),
]);
export type TheiaInstalledInput = z.infer<typeof TheiaInstalledInputSchema>;
export interface TheiaInstalledEntry {
  id:string; extensionId:string; version:string; enabled:boolean; installedAt:number;
  running:boolean; corrupted?:boolean;
  /** Metadata-only catalogue is not a security check. Full payload verification occurs before launch. */
  integrity:"not-checked"|"corrupt";
  /** F028: only the desktop sender that owns a live Theia session receives command metadata. Never persisted. */
  activeSession?: {sessionId:string;commands:string[];
    /** 命令的显示名（category: title）。 */
    commandContributions?:TheiaCommandContribution[];
    editorMenus?:TheiaEditorMenu[];
    /** 扩展贡献的 Mcode 界面动作（标题栏 / 编辑器标题）。 */
    uiContributions?:TheiaUiContribution[];
    /** 扩展贡献的状态栏条目（重挂载时恢复用）。 */
    statusEntries?:TheiaStatusEntry[];
    /** 扩展贡献的侧边 Webview 视图。 */
    webviewViews?:TheiaWebviewViewContribution[];
    /** 扩展贡献的自定义编辑器。 */
    customEditors?:TheiaCustomEditorContribution[];
    languageProviders?:Array<{kind:TheiaLanguageProviderKind;language:string;
      triggerCharacters?:string[];retriggerCharacters?:string[];supportsRenameLocation?:boolean}>};
}
export interface TheiaNativeConfigSetting {
  key:string;type:"string"|"number"|"boolean";description?:string;
  value:string|number|boolean|null;
}
export type TheiaInstalledResult =
  | {kind:"list";items:TheiaInstalledEntry[]}
  | {kind:"inspected";ticket:string;extensionId:string;fileCount:number;prompt:TheiaPreviewPermissionPrompt;upgradeFrom?:string;newVersion?:string}
  | {kind:"installed"|"updated"|"upgraded";item:TheiaInstalledEntry}
  | {kind:"started";id:string;sessionId:string;commands:string[];activationErrors:string[]}
  | {kind:"executed";result:string}
  | {kind:"editorSynced";active:boolean}
  | {kind:"webviewAcknowledged"}
  | {kind:"languageResult";contents:string[];
    suggestions:Array<{label:string;insertText:string;kind:number;detail?:string}>;
    locations?:TheiaLanguageLocation[];
    formattingEdits?:Array<{range:TheiaLanguageRange;text:string}>;
    documentSymbols?:TheiaLanguageSymbol[];
    renameEdits?:TheiaLanguageTextEdit[];
    renameLocation?:TheiaRenameLocation;
    renameRejectReason?:string;
    codeActions?:TheiaLanguageCodeAction[];
    signatureHelp?:TheiaSignatureHelp}
  | {kind:"editorAcknowledged"}
  | {kind:"messageAcknowledged"}
  | {kind:"quickAcknowledged"}
  | {kind:"configurations";settings:TheiaNativeConfigSetting[]}
  | {kind:"configurationUpdated"}
  | {kind:"removed";id:string}
  | {kind:"webviews";items:TheiaWebviewEvent[]}
  | {kind:"stopped"};
