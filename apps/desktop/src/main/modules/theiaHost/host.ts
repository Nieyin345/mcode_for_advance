/**
 * 【F023】Theia 扩展宿主进程 —— 装配、握手、命令、只读编辑器桥。
 *
 * ## 这一层在什么位置
 *
 * ```
 * Mcode 主进程                     本地子进程（Theia plugin host）
 *   TheiaHost ── fork(stdio[4]='overlapped') ──▶ plugin-host.js
 *        │                                            │
 *        └──── RPCProtocolImpl（Theia 的，不是我们的）◀──┘
 *                  │
 *        宿主反向调用 *Main 服务（本文件实现的那几个）
 * ```
 *
 * **协议完全是 Theia 的**，不是自造的：`@theia/plugin-ext` 的 `RPCProtocolImpl`
 * 走 `BinaryMessagePipe`（`<MessageStart>` + uint32 长度），底层是 `stdio[4]`。
 * 我们只做两件事：**按它的形状起进程**、**在父进程一侧把 `*Main` 服务补齐**。
 *
 * ## 已经实测的平台事实（本机 Windows 11 / Node 22）
 *
 * - `cp.fork(..., { stdio: ['pipe','pipe','pipe','ipc','overlapped'] })` 能起；
 *   `child.stdio[4]` 是 `Socket`，双向二进制可用。
 * - 子进程 `net.Socket({ fd: 4 })`（`ipc-channel.js:54`）在 Windows **成立**。
 *   双向各发一条 framed 消息round-trip通过，随后真实宿主 `$init` / `$start` 完成。
 *
 * 所以 F017 留下的最大未知（「裸 fork 活了 6 秒」→「握手真的能走完吗」）在这里
 * 有了答案：**能**。
 *
 * ## 本文件刻意不做的事
 *
 * - **不动 `vendor/theia`**。`plugin-ext-vscode` 的 `lib/` 是我们本机用上游
 *   `tsc --build` 产出的（`lib` 在 vendor 的 `.gitignore` 里，vendor git 树干净），
 *   本文件只在它缺失时报一条明确的装配错误。
 * - **不碰旧通道 `vscodeL1Bridge.ts`**。两条路并存到 F025。
 * - **不做运行时隔离**。用户裁决是「装时说清楚，之后不打断」。
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createRequire as createTheiaRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McodeWorkspaceFs, fileResource, type FileResource } from "./mcodeWorkspaceFs.js";
import { McodeExtensionPreferences } from "./mcodeExtensionPreferences.js";
import { McodeExtensionState } from "./mcodeExtensionState.js";
import { McodeWorkspaceWatcher } from "./mcodeWorkspaceWatcher.js";
import { prepareTheiaEdits, type EditorEditTransaction, type TheiaTextEdit, type TheiaEditOptions } from "./editorTransactions.js";
import type { TheiaLanguageLocation, TheiaLanguageProviderKind, TheiaLanguageSymbol, TheiaSignatureHelp, TheiaLanguageCodeAction, TheiaLanguageTextEdit } from "@contracts/ipc/modules.js";
import { formattingEdits, documentSymbols, signatureHelp, languageRange, localWorkspaceTextEdits } from "./languageResults.js";

/* ───────────────────────── 依赖定位 ───────────────────────── */

/**
 * `vendor/theia` 的根。产品里由调用方传入（测试要指向副本），
 * 这里只给默认值 —— **必须是绝对路径**，因为 vendor 是嵌套 git 仓库，
 * 不是 pnpm 的依赖，`require("@theia/...")` 在本仓主的 node_modules 里解析不到。
 *
 * 用 `import.meta.url` 而不是 `__dirname`：本文件会被无头 smoke 以 **ESM** 打包
 * （`--format=esm`），`__dirname` 在那里不存在 —— 表达成 ESM 形式后，esbuild 的
 * CJS 输出里它仍然有效（有 `import.meta.url` → `__filename` 的 shim）。
 */
export const DEFAULT_THEIA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../vendor/theia",
);

/** 用**扩展自己的解析根**去 require Theia 的构建产物。 */
export interface TheiaNativeTerminalDriver {
  create(id:string,opts:{name?:string;cwd?:string;shellPath?:string;shellArgs?:unknown;isPseudo?:boolean}):Promise<string>;
  sendText(id:string,text:string,execute?:boolean):Promise<void>;
  dispose(id:string):Promise<void>;
  disposeAll():Promise<void>;
  getProcessId?(id:string):number|undefined;
}
export interface TheiaHostOptions {
  /** `vendor/theia` 的绝对路径。 */
  theiaRoot: string;
  /** 要加载的扩展目录（含 `package.json`）。 */
  extensionDir: string;
  /**
   * 配置默认值的来源。不传就取扩展清单里的 `contributes.configuration`。
   *
   * **这一项不是可选的装饰**：实测 latex-workshop 在**模块加载期**就调
   * `workspace.getConfiguration('latex-workshop').get('intellisense.package.exclude').includes(...)`。
   * 清单里声明了 `default: []`，但**没有任何一方把清单默认值送进宿主** ——
   * 不送，`get` 返回 `undefined`，`activate()` 直接 `TypeError` 失败。
   * Theia 自己是从 `PreferenceProvider`（用户 / 工作区设置）取，而**默认档**
   * 由 `contributes.configuration.schema` 注入；Mcode 没有那套服务，
   * 所以在这里显式合成。
   */
  preferenceDefaults?: Record<string, unknown>;
  /** 工作区根目录（`workspaceFolders`）。可选 —— 本卡只做只读编辑器桥。 */
  workspaceRoot?: string;
  /** Validated native filesystem adapter; absence means no real workspace. */
  workspaceFs?: McodeWorkspaceFs;
  /** 宿主的临时目录（日志 / 存储）。必须可写。 */
  storageRoot: string;
  /** 日志回调；不传就丢弃。 */
  onLog?: (entry: TheiaHostLogEntry) => void;
  /** F031: live notification/user action bridge into Mcode's native toast/dialog.
   * Called even during activate(), before the installed session becomes active.
   * Action indices match Theia's MainMessageItem handles. No callback = no UI.
   */
  onMessage?: (input:{type:number;message:string;detail?:string;modal:boolean;actions:string[]})=>Promise<number|undefined>;
  /** Mcode-native Quick Pick / Input Box dialog, never a second Theia UI. */
  onStatus?: (input:{id:string;removed?:boolean;text?:string;name?:string;tooltip?:string;command?:string;priority?:number;alignment?:number})=>void;
  terminalDriver?:TheiaNativeTerminalDriver;
  onWebview?:(event:{handle:string;action:"create"|"html"|"message"|"dispose"|"title";
    title?:string;html?:string;payload?:unknown})=>void;
  onDiagnostics?: (collectionId:string,resource:string,markers:Array<{
    severity:1|2|4|8;message:string;source?:string;code?:string;
    startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number;
  }>,removed?:boolean)=>void;
  onQuickInput?: (input:{
    kind:"input"|"pick";title?:string;placeholder?:string;value?:string;password?:boolean;
    canPickMany?:boolean;items?:Array<{label:string;description?:string;detail?:string}>;
  })=>Promise<string|number[]|undefined>;
  /** 宿主 stdout/stderr 原文；不传就丢弃。 */
  onHostOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** 握手超时（毫秒）。默认 15 s。 */
  handshakeTimeoutMs?: number;
}

export interface TheiaHostLogEntry {
  level: "trace" | "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
}

/**
 * 宿主起不来时抛的错误。**每一种失败都有自己的 `code`** ——
 * 调用方（和用户）需要知道是「找不到构建产物」还是「握手超时」，
 * 而不是一句「扩展宿主启动失败」。
 */
export class TheiaHostError extends Error {
  constructor(
    readonly code:
      | "theia-root-missing"
      | "plugin-host-missing"
      | "vscode-init-missing"
      | "extension-manifest-invalid"
      | "spawn-failed"
      | "stdio4-missing"
      | "handshake-timeout"
      | "handshake-failed"
      | "host-exited"
      | "not-started"
      | "command-not-registered"
      | "command-failed",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TheiaHostError";
  }
}

/* ───────────────────────── Theia 构建产物的最小形状 ───────────────────────── */

/**
 * 我们只依赖这几条 API。**不 import Theia 的 `.d.ts`**（那会把 300 MB 的
 * 类型树拉进主进程的 typecheck），而是按用到的形状声明 —— 这样 vendor 升级
 * 破坏契约时会**在运行时立刻明显**（`undefined is not a function` 带本文件的栈），
 * 而不是在某个远处炸。
 */
interface IpcChannelLike {
  onClose: (listener: (e: { reason: string }) => void) => { dispose(): void };
}
interface RpcProtocolImplLike {
  set(identifier: unknown, instance: unknown): unknown;
  getProxy<T>(identifier: unknown): T;
  dispose(): void;
}
interface ProxyIdentifierLike {
  readonly id: string;
}
interface TheiaModules {
  createIpcChannel(child: ChildProcess): IpcChannelLike;
  RPCProtocolImpl: new (channel: IpcChannelLike) => RpcProtocolImplLike;
  PLUGIN_RPC_CONTEXT: Record<string, ProxyIdentifierLike>;
  MAIN_RPC_CONTEXT: Record<string, ProxyIdentifierLike>;
  buildModelForVsCode(manifest: Record<string, unknown>, options: { uiKind: "desktop" | "web" }): Record<string, unknown>;
  buildLifecycle(manifest: Record<string, unknown>, engineType: "vscode"): Record<string, unknown>;
  loadManifest(pluginPath: string): Promise<Record<string, unknown>>;
  /** 父进程也必须注册与宿主相同的 msgpack 扩展，否则含 vscode URI 的载荷解码会抛。 */
  registerMsgPackExtensions(): void;
  BinaryBuffer: {wrap(bytes:Uint8Array):unknown};
}

/**
 * 加载 Theia 的构建产物。
 *
 * ⚠️ **必须走 `common/index.js`**：它在模块加载时执行 `registerMsgPackExtensions()`。
 * 直接 require `rpc-protocol.js` 会漏掉这一步，症状是**第一次收到含 vscode URI
 * 的 RPC 就抛 `Unknown extension 4`**（msgpackr 的扩展 tag）—— 实测踩过。
 */
function loadTheiaModules(theiaRoot: string): TheiaModules {
  const pkgJson = path.join(theiaRoot, "package.json");
  if (!existsSync(pkgJson)) {
    throw new TheiaHostError(
      "theia-root-missing",
      `Theia 源码树不存在：${theiaRoot}（需要 vendor/theia 已 checkout 并构建）`,
    );
  }
  const pluginHost = path.join(theiaRoot, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
  if (!existsSync(pluginHost)) {
    throw new TheiaHostError(
      "plugin-host-missing",
      `Theia 扩展宿主构建产物不存在：${pluginHost}（在 vendor/theia 里跑 tsc --build packages/plugin-ext）`,
    );
  }
  const vscodeInit = path.join(theiaRoot, "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js");
  if (!existsSync(vscodeInit)) {
    throw new TheiaHostError(
      "vscode-init-missing",
      `VS Code 扩展入口缺失：${vscodeInit}（在 vendor/theia 里跑 tsc --build packages/plugin-ext-vscode）`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const requireFromTheia = createTheiaRequire(path.join(theiaRoot, "package.json"));
  // ⚠️ 两件事分属两个模块，**都要**：
  //   - `common/index.js` 在加载时执行 `registerMsgPackExtensions()`（漏了它，第一次
  //     收到含 vscode URI 的载荷就抛 `Unknown extension 4`）；
  //   - `RPCProtocolImpl` 本身只在 `rpc-protocol.js` 里导出（index 只 re-export
  //     plugin-protocol / plugin-api-rpc，不 re-export rpc-protocol）。
  requireFromTheia("@theia/plugin-ext/lib/common/index.js");
  const rpcProtocol = requireFromTheia("@theia/plugin-ext/lib/common/rpc-protocol.js") as {
    RPCProtocolImpl: TheiaModules["RPCProtocolImpl"];
    registerMsgPackExtensions: TheiaModules["registerMsgPackExtensions"];
  };
  const apiRpc = requireFromTheia("@theia/plugin-ext/lib/common/plugin-api-rpc.js") as {
    PLUGIN_RPC_CONTEXT: TheiaModules["PLUGIN_RPC_CONTEXT"];
    MAIN_RPC_CONTEXT: TheiaModules["MAIN_RPC_CONTEXT"];
  };
  const ipcChannel = requireFromTheia("@theia/core/lib/node/messaging/ipc-channel.js") as {
    IPCChannel: new (child: ChildProcess) => IpcChannelLike;
  };
  const pluginModel = requireFromTheia("@theia/plugin-utils/lib/common/plugin-model.js") as {
    buildModelForVsCode: TheiaModules["buildModelForVsCode"];
    buildLifecycle: TheiaModules["buildLifecycle"];
  };
  const binary = requireFromTheia("@theia/core/lib/common/buffer.js") as {BinaryBuffer:TheiaModules["BinaryBuffer"]};
  const pluginManifest = requireFromTheia("@theia/plugin-utils/lib/node/plugin-manifest.js") as {
    loadManifest: TheiaModules["loadManifest"];
  };
  return {
    createIpcChannel: (child) => new ipcChannel.IPCChannel(child),
    RPCProtocolImpl: rpcProtocol.RPCProtocolImpl,
    PLUGIN_RPC_CONTEXT: apiRpc.PLUGIN_RPC_CONTEXT,
    MAIN_RPC_CONTEXT: apiRpc.MAIN_RPC_CONTEXT,
    buildModelForVsCode: pluginModel.buildModelForVsCode,
    buildLifecycle: pluginModel.buildLifecycle,
    loadManifest: pluginManifest.loadManifest,
    registerMsgPackExtensions: rpcProtocol.registerMsgPackExtensions,
    BinaryBuffer:binary.BinaryBuffer,
  };
}

/* ───────────────────────── 能力接口 ───────────────────────── */

/** 一个成功激活的扩展的对外句柄。 */
export interface TheiaExtensionHandle {
  /** 版本化 id，`publisher.name@version`（小写）。 */
  readonly id: string;
  /** 清单里声明的全部命令 id（**不是**注册表快照 —— 见 `commands()`）。 */
  readonly declaredCommands: string[];
  /**
   * 激活期间宿主记录下来的 **error 级** 日志（扩展自己 catch 掉的不算）。
   *
   * 用途是让「activate() 跑完了」这句话可被证伪：一个因为某个 API 未实现而
   * 半途抛错的扩展，`$start` 仍会 resolve，只有错误日志能说明它没走完。
   */
  readonly activationErrors: readonly TheiaHostLogEntry[];
  /** 当前真的在宿主命令表里的命令。 */
  commands(): Promise<string[]>;
  /** 从 Mcode 侧执行一个扩展命令，返回扩展的返回值（序列化后）。 */
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T>;
}

/** Editor snapshots and editor-owner-mediated edit transactions (F024). */
export interface TheiaEditorBridge {
  /** 没有打开编辑器时 `null`（不是 `{}`、不是抛错）。 */
  activeTextEditor(): Promise<ActiveEditorSnapshot | null>;
  visibleTextEditors(): Promise<ActiveEditorSnapshot[]>;
}

export interface ActiveEditorSnapshot {
  /** 文件的绝对路径（`file` scheme）。 */
  filePath: string;
  languageId: string;
  /** `document.getText()` 的全文。 */
  text: string;
  /** 主选区（0-based，与 vscode API 一致）。 */
  selection: { start: { line: number; character: number }; end: { line: number; character: number } } | undefined;
  /** 全部选区。 */
  selections: { start: { line: number; character: number }; end: { line: number; character: number } }[];
}

/** 推给宿主的一份编辑器状态（**从 Mcode 侧的真实编辑器读出来**，不是伪造的）。 */
export interface EditorInput {
  filePath: string;
  languageId: string;
  text: string;
  /** 0-based；不传就是光标在 0:0 的空选区。 */
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Only the real Mcode editor owner can apply edits and own undo/redo. No callback = reject. */
  applyEdits?: (transaction: EditorEditTransaction) => Promise<boolean>;
}

interface EditorSession {
  id: string;
  input: EditorInput;
  uri: Record<string, unknown>;
  version: number;
  busy: boolean;
}

function snapshotOf(_id: string, input: EditorInput): ActiveEditorSnapshot {
  const selection = input.selection ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  return {
    filePath: input.filePath,
    languageId: input.languageId,
    text: input.text,
    selection,
    selections: [selection],
  };
}

/** Normalize untrusted VS Code Location/LocationLink DTOs before they cross IPC. */
function languageFileUri(value: unknown): string | undefined {
  if (typeof value === "string") return value.startsWith("file:") && value.length <= 4096 ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const input = value as {scheme?:unknown;path?:unknown;fsPath?:unknown;authority?:unknown};
  if (input.scheme !== "file") return undefined;
  const rawPath = typeof input.path === "string" ? input.path
    : typeof input.fsPath === "string" ? input.fsPath : "";
  if (!rawPath || rawPath.length > 4096) return undefined;
  const normalized = rawPath.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : "/" + normalized;
  const authority = typeof input.authority === "string" && input.authority.length <= 255
    ? input.authority : "";
  return "file://" + authority + encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F");
}
function languagePosition(value: unknown): {line:number;character:number} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as {line?:unknown;character?:unknown;lineNumber?:unknown;column?:unknown};
  const line = Number.isSafeInteger(p.line) ? Number(p.line)
    : Number.isSafeInteger(p.lineNumber) ? Number(p.lineNumber) - 1 : -1;
  const character = Number.isSafeInteger(p.character) ? Number(p.character)
    : Number.isSafeInteger(p.column) ? Number(p.column) - 1 : -1;
  if (line < 0 || character < 0 || line > 1_000_000 || character > 1_000_000) return undefined;
  return {line,character};
}
function languageLocation(value: unknown): TheiaLanguageLocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string,unknown>;
  const uri = languageFileUri(item.uri ?? item.targetUri);
  const rangeValue = item.range ?? item.targetSelectionRange ?? item.targetRange;
  if (!uri || !rangeValue || typeof rangeValue !== "object") return undefined;
  const range = rangeValue as {start?:unknown;end?:unknown;
    startLineNumber?:unknown;startColumn?:unknown;endLineNumber?:unknown;endColumn?:unknown};
  const start = languagePosition(range.start??{lineNumber:range.startLineNumber,column:range.startColumn});
  const end = languagePosition(range.end??{lineNumber:range.endLineNumber,column:range.endColumn});
  if (!start || !end || end.line < start.line ||
      (end.line === start.line && end.character < start.character)) return undefined;
  return {uri,range:{start,end}};
}

/* ───────────────────────── 宿主 ───────────────────────── */

/**
 * 一个 Theia 扩展宿主进程。
 *
 * 生命周期：`start()` → （`extension` / `editors`）→ `dispose()`。
 * **失败一律抛 `TheiaHostError`**，不静默重试 —— 用户需要看到「它没起来」
 * 以及为什么。
 */
export class TheiaHost {
  private child: ChildProcess | undefined;
  private rpc: RpcProtocolImplLike | undefined;
  private modules: TheiaModules | undefined;
  private hostLogPath = "";
  private readonly log: (entry: TheiaHostLogEntry) => void;
  private readonly hostOutput: (stream: "stdout" | "stderr", text: string) => void;
  private started = false;
  private disposed = false;
  /** `$start` 之后由宿主经 `$registerCommand` 推上来的命令表。 */
  private readonly registeredCommands = new Set<string>();
  /** 激活期间宿主报的 error 级日志（见 `TheiaExtensionHandle.activationErrors`）。 */
  private readonly activationErrorLog: TheiaHostLogEntry[] = [];
  /** 扩展 id（`publisher.name`，小写）。 */
  private extensionId = "";
  private declaredCommands: string[] = [];
  private exitReason: string | undefined;
  private activeEditorSession: EditorSession | null = null;
  private extensionPreferences: McodeExtensionPreferences | null = null;
  private extensionState:McodeExtensionState|null=null;
  private readonly languageProviders=new Map<number,{kind:TheiaLanguageProviderKind;languages:string[];triggerCharacters?:string[];retriggerCharacters?:string[]}>();
  private readonly webviewHandles=new Set<string>();
  async sendWebviewMessage(handle:string,payload:unknown):Promise<void>{
    if(!this.webviewHandles.has(handle)||!this.rpc||!this.modules||this.disposed)
      throw Error("扩展 Webview 已失效");
    const ext=this.rpc.getProxy<{$onMessage(h:string,message:unknown):Promise<void>|void}>(
      this.modules.MAIN_RPC_CONTEXT.WEBVIEWS_EXT);
    await ext.$onMessage(handle,payload);
  }
  async disposeWebview(handle:string):Promise<void>{
    if(!this.webviewHandles.delete(handle))throw Error("扩展 Webview 已失效");
    this.options.onWebview?.({handle,action:"dispose"});
    if(!this.rpc||!this.modules||this.disposed)return;
    const ext=this.rpc.getProxy<{$onDidDisposeWebviewPanel(h:string):Promise<void>|void}>(
      this.modules.MAIN_RPC_CONTEXT.WEBVIEWS_EXT);
    await ext.$onDidDisposeWebviewPanel(handle);
  }
  getLanguageDescriptors():Array<{kind:TheiaLanguageProviderKind;language:string;triggerCharacters?:string[];retriggerCharacters?:string[]}>{
    type Descriptor={kind:TheiaLanguageProviderKind;language:string;
      triggerCharacters?:string[];retriggerCharacters?:string[]};
    const byKey=new Map<string,Descriptor>();
    for(const item of this.languageProviders.values())for(const language of item.languages){
      const key=item.kind+":"+language;
      const existing=byKey.get(key);
      if(!existing){byKey.set(key,{kind:item.kind,language,
        ...(item.triggerCharacters?{triggerCharacters:[...item.triggerCharacters]}:{}),
        ...(item.retriggerCharacters?{retriggerCharacters:[...item.retriggerCharacters]}:{})});
        continue;
      }
      if(item.triggerCharacters)existing.triggerCharacters=[...new Set([
        ...existing.triggerCharacters??[],...item.triggerCharacters])].slice(0,20);
      if(item.retriggerCharacters)existing.retriggerCharacters=[...new Set([
        ...existing.retriggerCharacters??[],...item.retriggerCharacters])].slice(0,20);
    }
    return [...byKey.values()];
  }
  async languageQuery(kind:TheiaLanguageProviderKind,lineNumber:number,column:number,includeDeclaration=true,
    formatOptions?:{tabSize:number;insertSpaces:boolean},
    signatureContext?:{triggerKind:number;isRetrigger:boolean;triggerCharacter?:string},
    formatContext?:{range?:import("@contracts/ipc/modules.js").TheiaLanguageRange;triggerCharacter?:string},
    editContext?:{newName?:string;range?:import("@contracts/ipc/modules.js").TheiaLanguageRange;trigger?:number}):
    Promise<{contents:string[];suggestions:Array<{label:string;insertText:string;kind:number;detail?:string}>;
      locations:TheiaLanguageLocation[];formattingEdits:Array<{range:import("@contracts/ipc/modules.js").TheiaLanguageRange;text:string}>;
      documentSymbols:TheiaLanguageSymbol[];signatureHelp?:TheiaSignatureHelp;
      renameEdits?:TheiaLanguageTextEdit[];renameRejectReason?:string;codeActions?:TheiaLanguageCodeAction[]}>{
    const current=this.activeEditorSession,modules=this.modules,rpc=this.rpc;
    if(!current||!modules||!rpc||this.disposed||!this.started||
      !Number.isSafeInteger(lineNumber)||!Number.isSafeInteger(column)||
      lineNumber<1||column<1||lineNumber>100000||column>100000)
      throw Error("Mcode 当前编辑器无法执行扩展语言查询");
    const requested=current.input.languageId;
    // Range and on-type formatting must not invoke an unrelated provider or
    // accept arbitrary coordinates/characters from an untrusted IPC caller.
    const requestedRange=kind==="rangeFormatting"?languageRange(formatContext?.range):null;
    if(kind==="rangeFormatting"&&!requestedRange)throw Error("选区格式化范围无效");
    const trigger=kind==="onTypeFormatting"?formatContext?.triggerCharacter:undefined;
    if(kind==="onTypeFormatting"&&(!trigger||trigger.length!==1))throw Error("输入格式化触发字符无效");
    const editRange=kind==="codeActions"?languageRange(editContext?.range):null;
    if(kind==="codeActions"&&!editRange)throw Error("代码操作选区无效");
    if(kind==="rename"&&(!editContext?.newName||editContext.newName.length>256))
      throw Error("重命名目标无效");
    const eligible=[...this.languageProviders.entries()].filter(([,provider])=>
      provider.kind===kind&&provider.languages.some(language=>language==="*"||language===requested)&&
      (kind!=="onTypeFormatting"||provider.triggerCharacters?.includes(trigger!))).slice(0,kind==="rename"?1:6);
    const ext=rpc.getProxy<Record<string,(...args:unknown[])=>Promise<unknown>>>(modules.MAIN_RPC_CONTEXT.LANGUAGES_EXT);
    const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose:()=>{}})};
    const position={lineNumber,column};
    const results:{contents:string[];suggestions:Array<{label:string;insertText:string;kind:number;detail?:string}>;
      locations:TheiaLanguageLocation[];formattingEdits:Array<{range:import("@contracts/ipc/modules.js").TheiaLanguageRange;text:string}>;
      documentSymbols:TheiaLanguageSymbol[];signatureHelp?:TheiaSignatureHelp;
      renameEdits?:TheiaLanguageTextEdit[];renameRejectReason?:string;codeActions?:TheiaLanguageCodeAction[]}=
      {contents:[],suggestions:[],locations:[],formattingEdits:[],documentSymbols:[]};
    for(const [handle] of eligible){
      let operation:Promise<unknown>;
      switch(kind){
        case "hover":operation=ext.$provideHover(handle,current.uri,position,undefined,token);break;
        case "completion":operation=ext.$provideCompletionItems(handle,current.uri,position,{triggerKind:0},token);break;
        case "definition":operation=ext.$provideDefinition(handle,current.uri,position,token);break;
        case "references":operation=ext.$provideReferences(handle,current.uri,position,{includeDeclaration},token);break;
        case "implementation":operation=ext.$provideImplementation(handle,current.uri,position,token);break;
        case "typeDefinition":operation=ext.$provideTypeDefinition(handle,current.uri,position,token);break;
        case "documentSymbols":operation=ext.$provideDocumentSymbols(handle,current.uri,token);break;
        case "formatting":operation=ext.$provideDocumentFormattingEdits(handle,current.uri,
          {tabSize:formatOptions?.tabSize??4,insertSpaces:formatOptions?.insertSpaces??true},token);break;
        case "rangeFormatting":operation=ext.$provideDocumentRangeFormattingEdits(handle,current.uri,{
          startLineNumber:requestedRange!.start.line+1,startColumn:requestedRange!.start.character+1,
          endLineNumber:requestedRange!.end.line+1,endColumn:requestedRange!.end.character+1,
        },{tabSize:formatOptions?.tabSize??4,insertSpaces:formatOptions?.insertSpaces??true},token);break;
        case "onTypeFormatting":operation=ext.$provideOnTypeFormattingEdits(handle,current.uri,position,trigger!,
          {tabSize:formatOptions?.tabSize??4,insertSpaces:formatOptions?.insertSpaces??true},token);break;
        case "rename":operation=ext.$provideRenameEdits(handle,current.uri,position,editContext!.newName!,token);break;
        case "codeActions":operation=ext.$provideCodeActions(handle,current.uri,{
          startLineNumber:editRange!.start.line+1,startColumn:editRange!.start.character+1,
          endLineNumber:editRange!.end.line+1,endColumn:editRange!.end.character+1,
        },{trigger:editContext?.trigger??1,markers:[]},token);break;
        case "signatureHelp":operation=ext.$provideSignatureHelp(handle,current.uri,position,{
          triggerKind:signatureContext?.triggerKind??1,isRetrigger:signatureContext?.isRetrigger??false,
          ...(signatureContext?.triggerCharacter?{triggerCharacter:signatureContext.triggerCharacter}:{})
        },token);break;
      }
      let timer:NodeJS.Timeout|undefined;
      try{
        const output=await Promise.race([
          operation,
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("扩展语言查询超时")),1800);timer.unref?.();}),
        ]);
        if(kind==="hover"){
          const payload=output as {contents?:Array<string|{value?:string}>}|undefined;
          for(const content of payload?.contents??[]){
            const raw=typeof content==="string"?content:content?.value;
            if(typeof raw==="string"&&results.contents.length<12)results.contents.push(raw.slice(0,4000));
          }
        }else if(kind==="completion"){
          const payload=output as {completions?:Array<{
            label:string|{label:string};insertText?:string;kind?:number;detail?:string
          }>}|undefined;
          for(const item of payload?.completions??[]){
            const label=typeof item?.label==="string"?item.label:item?.label?.label;
            if(typeof label!=="string"||!label||results.suggestions.length>=100)continue;
            results.suggestions.push({label:label.slice(0,180),
              insertText:typeof item.insertText==="string"?item.insertText.slice(0,4000):label.slice(0,180),
              kind:Number.isInteger(item.kind)?item.kind!:18,
              ...(typeof item.detail==="string"?{detail:item.detail.slice(0,320)}:{})});
          }
        }else if(kind==="documentSymbols"){
          results.documentSymbols.push(...documentSymbols(output));
        }else if(kind==="formatting"||kind==="rangeFormatting"||kind==="onTypeFormatting"){
          results.formattingEdits.push(...formattingEdits(output));
        }else if(kind==="rename"){
          const payload=output as {rejectReason?:unknown}|undefined;
          if(typeof payload?.rejectReason==="string")results.renameRejectReason=payload.rejectReason.slice(0,250);
          else{
            const edits=localWorkspaceTextEdits(output,current.input.filePath,current.input.text);
            if(edits)results.renameEdits=edits;
            else results.renameRejectReason="该重命名涉及其他文件或不支持的修改，Mcode 已拒绝执行";
          }
        }else if(kind==="codeActions"){
          const entries=Array.isArray(output)?output:[];
          const releaseIds:number[]=[];
          for(const item of entries){
            if(!item||typeof item!=="object")continue;
            const candidate=item as Record<string,unknown>;
            if(Number.isSafeInteger(candidate.cacheId))releaseIds.push(Number(candidate.cacheId));
            if(results.codeActions?.length===20||typeof candidate.title!=="string"||
              !candidate.title||candidate.title.length>250||candidate.disabled||candidate.command)continue;
            const edits=localWorkspaceTextEdits(candidate.edit,current.input.filePath,current.input.text);
            if(!edits)continue; // commands, cross-file and unresolved edits are not executable
            (results.codeActions??=[]).push({title:candidate.title,
              ...(typeof candidate.kind==="string"?{kind:candidate.kind.slice(0,80)}:{}),
              ...(candidate.isPreferred===true?{isPreferred:true}:{}),edits});
          }
          if(releaseIds.length)void ext.$releaseCodeActions(handle,releaseIds).catch(()=>{});
        }else if(kind==="signatureHelp"){
          const value=signatureHelp(output);
          if(value)results.signatureHelp=value;
          const signatureId=output&&typeof output==="object"?
            (output as {id?:unknown}).id:undefined;
          if(typeof signatureId==="number"&&Number.isSafeInteger(signatureId)){
            void ext.$releaseSignatureHelp(handle,signatureId).catch(()=>{});
          }
        }else{
          const rows=Array.isArray(output)?output:
            output&&typeof output==="object"&&Array.isArray((output as {locations?:unknown}).locations)
              ?(output as {locations:unknown[]}).locations:output?[output]:[];
          for(const row of rows){
            const location=languageLocation(row);
            if(location&&results.locations.length<100)results.locations.push(location);
          }
        }
      }catch(error){
        this.log({level:"warn",source:"theia-language",message:String(error)});
      }finally{if(timer)clearTimeout(timer);}
    }
    // Multiple registered formatters may each return valid but overlapping edits.
    // Enforce the same global bounds before exposing one Monaco undo operation.
    if(kind==="formatting"||kind==="rangeFormatting"||kind==="onTypeFormatting")
      results.formattingEdits=formattingEdits(results.formattingEdits);
    return results;
  }
  private workspaceWatcher:McodeWorkspaceWatcher|undefined;
  private readonly quickPicks=new Map<number,{resolve:(selected:number|number[]|undefined)=>void;
    opts:{title?:string;placeHolder?:string;canPickMany?:boolean}}>();
  private configurationDefaults:Record<string,unknown>={};

  constructor(private readonly options: TheiaHostOptions) {
    this.log = options.onLog ?? (() => undefined);
    this.hostOutput = options.onHostOutput ?? (() => undefined);
  }

  /**
   * fork 宿主 → 建立 MessagePack 通道 → `$init`。**不含 `$start`**：
   * 那一步才真正加载扩展，分开是为了让「宿主起来了」和「扩展激活了」
   * 两种失败在错误码上就分得开。
   */
  async start(): Promise<void> {
    if (this.started) throw new TheiaHostError("not-started", "宿主已经启动过了");
    if (this.disposed) throw new TheiaHostError("not-started", "宿主已释放");
    const modules = loadTheiaModules(this.options.theiaRoot);
    this.modules = modules;

    const extensionDir = path.resolve(this.options.extensionDir);
    let manifest: Record<string, unknown>;
    try {
      manifest = await modules.loadManifest(extensionDir);
    } catch (e) {
      throw new TheiaHostError("extension-manifest-invalid", `读取扩展清单失败：${extensionDir}`, e);
    }
    const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "unpublished";
    const name = typeof manifest.name === "string" ? manifest.name : path.basename(extensionDir);
    this.extensionId = `${publisher}.${name}`.toLowerCase();
    const contributes = manifest.contributes as { commands?: unknown } | undefined;
    this.declaredCommands = Array.isArray(contributes?.commands)
      ? (contributes.commands as { command?: unknown }[])
          .map((c) => (typeof c?.command === "string" ? c.command : ""))
          .filter((id) => id.length > 0)
      : [];

    const pluginHost = path.join(this.options.theiaRoot, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
    this.hostLogPath = path.join(this.options.storageRoot, "logs");
    const storagePath = path.join(this.options.storageRoot, "workspace-storage");
    const globalStoragePath = path.join(this.options.storageRoot, "global-storage");

    let child: ChildProcess;
    try {
      child = fork(pluginHost, [], {
        silent: true,
        execArgv: [],
        // cwd 用 theiaRoot：宿主内部按相对路径找它的资源（实测需要）
        cwd: this.options.theiaRoot,
        env: {
          ...process.env,
          THEIA_PARENT_PID: String(process.pid),
          VSCODE_PID: String(process.pid),
        },
        // 第 5 条必须是 `overlapped` —— Theia 上游自己的注释（hosted-plugin-process.js:130）
        // 写明 Windows 上不这么写就不工作。实测：Windows 11 / Node 22 通过。
        stdio: ["pipe", "pipe", "pipe", "ipc", "overlapped"],
      });
    } catch (e) {
      throw new TheiaHostError("spawn-failed", `fork 扩展宿主进程失败`, e);
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.hostOutput("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.hostOutput("stderr", chunk.toString("utf8")));
    child.on("exit", (code, signal) => {
      this.exitReason = `宿主进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
      this.started = false;
    });

    const pipe = child.stdio[4];
    if (!pipe) {
      throw new TheiaHostError(
        "stdio4-missing",
        "宿主没有第 5 条 stdio（Plugin host requires a 5th stdio channel）",
      );
    }

    const channel = modules.createIpcChannel(child);
    const rpc = new modules.RPCProtocolImpl(channel);
    this.rpc = rpc;
    this.installMainServices(rpc, modules);

    // 握手 = **一次真实的请求/应答**。这里必须用 `HOSTED_PLUGIN_MANAGER_EXT.$init`：
    // 它是宿主**唯一**对外暴露的请求型服务（`MAIN_RPC_CONTEXT`），而 `ENV_MAIN`
    // 方向相反 —— 那是**宿主调我们**的服务（`$getClientOperatingSystem` 由宿主发起）。
    // 第一版把方向搞反了，症状是宿主收到一个它没有的服务 id，回 `no local service
    // handler with id EnvMain`。这一条注释就是防止下次再反。
    const manager = rpc.getProxy<PluginManagerProxy>(modules.MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
    this.extensionPreferences=await McodeExtensionPreferences.open(this.options.storageRoot);
    this.extensionState=await McodeExtensionState.open(this.options.storageRoot,this.options.workspaceFs?.root);
    this.configurationDefaults=this.options.preferenceDefaults ?? collectConfigurationDefaults(manifest);
    const preferences = this.buildPreferenceData(manifest);
    const timeoutMs = this.options.handshakeTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const state=this.extensionState.snapshot();
      await Promise.race([
        manager.$init({
          preferences,
          globalState: state.globalState,
          workspaceState: state.workspaceState,
          env: {
            queryParams: {},
            language: "en",
            shell: process.platform === "win32" ? "cmd.exe" : (process.env.SHELL ?? "sh"),
            // 1 = UIKind.Desktop
            uiKind: 1,
            appName: "Mcode",
            appHost: "desktop",
            appRoot: this.options.theiaRoot,
            appUriScheme: "mcode",
          },
          // 2 = ExtensionKind.Workspace
          pluginKind: 2,
          webview: { webviewResourceRoot: "", webviewCspSource: "" },
          jsonValidation: [],
          supportedActivationEvents: [
            "onCommand",
            "onLanguage",
            "onStartupFinished",
            "onDebug",
            "workspaceContains",
            "onFileSystem",
            "onView",
            "onUri",
            "onWebviewPanel",
            "*",
          ],
          telemetryLevel: "off",
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TheiaHostError(
                  "handshake-timeout",
                  `扩展宿主在 ${timeoutMs} ms 内没有完成握手（它可能已崩溃；看 stderr）`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
      this.log({ level: "info", source: "theia-host", message: "$init 完成（握手成功）" });
    } catch (e) {
      this.dispose();
      if (e instanceof TheiaHostError) throw e;
      throw new TheiaHostError("handshake-failed", "$init 失败（宿主拒绝初始化）", e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.started = true;
    if(this.options.workspaceFs){
      const sink=rpc.getProxy<{ $onFileEvent(events:unknown):Promise<void>|void }>(
        modules.MAIN_RPC_CONTEXT.ExtHostFileSystemEventService);
      this.workspaceWatcher=new McodeWorkspaceWatcher(this.options.workspaceFs.root,events=>{
        try{void sink.$onFileEvent(events);}catch{/* A crashed child must not crash Mcode. */}
      });
      this.workspaceWatcher.start();
      const proxy=rpc.getProxy<{ $onWorkspaceFoldersChanged(event:{roots:string[]}):Promise<void>|void }>(
        modules.MAIN_RPC_CONTEXT.WORKSPACE_EXT);
      await proxy.$onWorkspaceFoldersChanged({roots:[pathToFileURL(this.options.workspaceFs.root).toString()]});
    }
  }

  /**
   * 加载并激活扩展。**调用前必须先 `start()`。**
   *
   * 激活事件用的是 `onCommand:<第一个声明命令>` —— 这与 VS Code 的惰性激活一致：
   * 真正的宿主不会在启动时激活一个还没人用的扩展，`$start` 只负责登记。
   * （实测：不触发 `onCommand`，命令表是 0 条；触发后 latex-workshop 注册 25 条。）
   */
  async activate(): Promise<TheiaExtensionHandle> {
    const modules = this.modules;
    const rpc = this.rpc;
    if (!this.started || !modules || !rpc || !this.child) {
      throw new TheiaHostError("not-started", "宿主尚未启动，不能激活扩展");
    }
    const extensionDir = path.resolve(this.options.extensionDir);
    const rawModel = (await modules.loadManifest(extensionDir)) as Record<string, unknown>;
    rawModel.packagePath = extensionDir;
    const manifest = rawModel as {
      publisher?: string;
      engines?: Record<string, string>;
      main?: string;
      browser?: string;
    };
    if (!manifest.engines?.vscode) {
      throw new TheiaHostError(
        "extension-manifest-invalid",
        `扩展没有声明 engines.vscode，不是 VS Code 扩展：${extensionDir}`,
      );
    }
    const model = modules.buildModelForVsCode(
      {
        ...rawModel,
        publisher: manifest.publisher ?? "unpublished",
        packageUri: `file:///${extensionDir.replace(/\\/g, "/")}`,
      },
      { uiKind: "desktop" },
    );
    const lifecycle = modules.buildLifecycle(rawModel, "vscode");
    lifecycle.backendInitPath = path.join(
      this.options.theiaRoot,
      "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
    );
    const entryPoint = model.entryPoint as { backend?: string; frontend?: string } | undefined;
    if (!entryPoint?.backend && !entryPoint?.frontend) {
      throw new TheiaHostError(
        "extension-manifest-invalid",
        `扩展清单没有可加载的入口（main / browser）：${extensionDir}`,
      );
    }
    if (entryPoint.backend) entryPoint.backend = path.resolve(extensionDir, entryPoint.backend);

    const pluginMetadata = { host: "main", model, lifecycle, outOfSync: false };
    const manager = rpc.getProxy<PluginManagerProxy>(modules.MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
    try {
      await manager.$start({
        plugins: [pluginMetadata],
        configStorage: {
          hostLogPath: this.hostLogPath,
          hostStoragePath: path.join(this.options.storageRoot, "workspace-storage"),
          hostGlobalStoragePath: path.join(this.options.storageRoot, "global-storage"),
        },
        activationEvents: [],
      });
    } catch (e) {
      throw new TheiaHostError("command-failed", `$start 失败（扩展无法登记）`, e);
    }

    // 惰性激活：用第一个声明命令作为 onCommand 事件。没有声明命令时退到
    // onStartupFinished（与 VS Code 对 `*` / onStartupFinished 的语义一致）。
    const activationEvent =
      this.declaredCommands.length > 0 ? `onCommand:${this.declaredCommands[0]}` : "onStartupFinished";
    this.log({ level: "info", source: "theia-host", message: `激活事件：${activationEvent}` });
    await manager.$activateByEvent(activationEvent);

    return {
      id: this.extensionId,
      declaredCommands: [...this.declaredCommands],
      /**
       * 命令表**从宿主推上来的 `$registerCommand` 事件里读**，不是问宿主。
       *
       * 这是 F015 踩过的那个坑的同一类：`CommandRegistryExt`（宿主侧的对外接口）
       * 只有 `$executeCommand` / `registerArgumentProcessor` 两个方法 ——
       * **没有 `$getCommands`**。第一版在这里调了 `$getCommands`，Theia 的
       * RPC 代理于是把它当成一个不存在的远端方法发出去，宿主侧 `handler[method]`
       * 拿到 `undefined` 直接抛 `TypeError` —— 而这个抛错**沿着 `activate()`
       * 的调用栈冒出来**，看起来像是激活失败。
       *
       * 所以「注册上了」只能由 `$registerCommand` 这**一条单向通知**来证明；
       * 它同时也是本卡第 2 组第 3 步的判据来源。
       */
      commands: async () => [...this.registeredCommands].sort(),
      activationErrors: [...this.activationErrorLog],
      executeCommand: async <T,>(command: string, ...args: unknown[]): Promise<T> => {
        const ext = rpc.getProxy<{ $executeCommand<U>(id: string, ...a: unknown[]): Promise<U> }>(
          modules.MAIN_RPC_CONTEXT.COMMAND_REGISTRY_EXT,
        );
        try {
          return await ext.$executeCommand<T>(command, ...args);
        } catch (e) {
          throw new TheiaHostError(
            "command-failed",
            `扩展命令执行失败：${command} — ${e instanceof Error ? e.message : String(e)}`,
            e,
          );
        }
      },
    };
  }

  /**
   * 只读编辑器桥。它靠**把编辑器状态以 delta 推给宿主**实现
   * （`EDITORS_AND_DOCUMENTS_EXT.$acceptEditorsAndDocumentsDelta`）——
   * 这是 Theia 的真实协议：宿主侧的 `EditorsAndDocumentsExtImpl` 收到 delta
   * 才会让 `window.activeTextEditor` 有值。
   *
   * **`setActive(null)` 必须推 `newActiveEditor: null`** ——
   * 宿主侧的判据是 `delta.newActiveEditor !== undefined`：`undefined` 是
   * 「没有变化」，`null` 才是「没有活动编辑器」。写成 `undefined` 就会得到
   * 一个幽灵编辑器（关掉了还一直在）。这是本卡负控要抓的那个变异。
   */
  editors(): TheiaEditorBridge & { setActive(input: EditorInput | null): Promise<void> } {
    const modules = this.modules;
    const rpc = this.rpc;
    if (!modules || !rpc) throw new TheiaHostError("not-started", "宿主尚未启动");
    const pushDelta = async (delta: Record<string, unknown>): Promise<void> => {
      const ext = rpc.getProxy<{ $acceptEditorsAndDocumentsDelta(d: unknown): Promise<void> }>(
        modules.MAIN_RPC_CONTEXT.EDITORS_AND_DOCUMENTS_EXT,
      );
      await ext.$acceptEditorsAndDocumentsDelta(delta);
    };

    let nextEditorId = 1;
    let current: EditorSession | null = null;
    const owner = this;

    const toUri = (filePath: string) => ({
      $mid: 1,
      scheme: "file",
      path: filePath.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, (_, d: string) => `/${d.toLowerCase()}:`),
    });

    return {
      async setActive(input) {
        if (input === null) {
          if (current === null) {
            // 已经是空的：仍然推一次 null，保证宿主侧状态与本侧一致
            await pushDelta({ newActiveEditor: null });
            return;
          }
          const old = current;
          current = null;
          owner.activeEditorSession = null;
          await pushDelta({ removedEditors: [old.id], removedDocuments: [old.uri], newActiveEditor: null });
          return;
        }
        const editorId = String(nextEditorId++);
        const uri = toUri(input.filePath);
        const previous = current;
        current = { id: editorId, input, uri, version: 1, busy: false };
        owner.activeEditorSession = current;
        const lines = input.text.split(/\r?\n/);
        await pushDelta({
          ...(previous ? { removedEditors: [previous.id], removedDocuments: [previous.uri] } : {}),
          addedDocuments: [
            {
              uri,
              versionId: 1,
              lines,
              languageId: input.languageId,
              modeId: input.languageId,
              EOL: input.text.includes("\r\n") ? "\r\n" : "\n",
              isDirty: false,
              encoding: "utf8",
            },
          ],
          addedEditors: [
            {
              id: editorId,
              documentUri: uri,
              // 从 1 计（Theia 的 selection 字段是 1-based 行列号，
              // 宿主侧 toSelection 会减 1 → 得到 0-based 的 vscode Selection）
              selections: [
                {
                  selectionStartLineNumber: (input.selection?.start.line ?? 0) + 1,
                  selectionStartColumn: (input.selection?.start.character ?? 0) + 1,
                  positionLineNumber: (input.selection?.end.line ?? 0) + 1,
                  positionColumn: (input.selection?.end.character ?? 0) + 1,
                },
              ],
              options: { tabSize: 4, indentSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
              visibleRanges: [
                {
                  startLineNumber: 1,
                  startColumn: 1,
                  endLineNumber: Math.max(lines.length, 1),
                  endColumn: 1,
                },
              ],
              // 1 = EditorPosition.ONE
              editorPosition: 1,
            },
          ],
          newActiveEditor: editorId,
        });
      },
      async activeTextEditor() {
        if (current === null) return null;
        return snapshotOf(current.id, current.input);
      },
      async visibleTextEditors() {
        return current === null ? [] : [snapshotOf(current.id, current.input)];
      },
    };
  }

  /** 释放：先礼貌地让宿主自己退（`ProcessTerminateMessage`），超时就杀。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeEditorSession = null;
    this.workspaceWatcher?.dispose();this.workspaceWatcher=undefined;
    for(const handle of this.webviewHandles)this.options.onWebview?.({handle,action:"dispose"});
    this.webviewHandles.clear();
    await this.options.terminalDriver?.disposeAll();
    const child = this.child;
    this.child = undefined;
    this.started = false;
    try {
      this.rpc?.dispose();
    } catch {
      // 已经断了
    }
    this.rpc = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已经没了
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        // Theia 的约定：一条 JSON（不是 msgpack）告诉宿主自己退
        child.send?.(JSON.stringify({ type: "ProcessTerminateMessage" }));
      } catch {
        try {
          child.kill();
        } catch {
          // 已经没了
        }
      }
    });
  }

  /** 宿主最近一次退出的原因（用于把「它中途死了」说清楚）。 */
  get exitInfo(): string | undefined {
    return this.exitReason;
  }

  /* ───────────────────── 内部：父进程侧的 *Main 服务 ───────────────────── */

  /**
   * 把宿主会反向调用的 `*Main` 服务注册进 RPC。
   *
   * **只实现本卡需要的那几个**，其余用「显式空实现」—— 关键区别是：
   * 空实现**记一条 debug 日志并返回合理的空值**，不是静默 `undefined`。
   * 一个 `$showQuickPick` 返回 `undefined` 是合法的（用户取消）；
   * 但 `$getClientOperatingSystem` 返回 `undefined` 会让宿主侧解析出垃圾。
   * 所以按方法给默认值，而不是一把 `undefined`。
   */
  private installMainServices(rpc: RpcProtocolImplLike, modules: TheiaModules): void {
    const P = modules.PLUGIN_RPC_CONTEXT;
    const log = this.log;
    /** 已经被显式实现过的 service 标识 —— 兜底循环用它判断「别覆盖」。 */
    const implemented = new Set<ProxyIdentifierLike>();

    const setProxyHandler = (identifier: ProxyIdentifierLike | undefined, handlers: Record<string, (...args: never[]) => unknown>): void => {
      if (!identifier) return;
      if (implemented.has(identifier)) return;
      implemented.add(identifier);
      // ⚠️ 只有 **`$` 开头**的名字才生成兜底函数。第一版对**任何**字符串属性都返回
      // 一个函数，于是：
      //   - `Disposable.is(instance)` 探 `dispose` → 拿到函数 → 判定「这是可释放的」，
      //     RPC 把它塞进 toDispose，随后真的去调它；
      //   - `await proxy` 探 `then` → 拿到函数 → 被当成 thenable。
      // 两者都会把 RPC 内部状态搅乱，症状是宿主报 `handler[method] is not a function`
      // —— 一个完全指错方向的错误。Theia 的 `*Main` 接口方法都以 `$` 开头
      // （唯一例外 `registerArgumentProcessor` 是本地方法，不走 RPC）。
      const target = Object.create(null) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(handlers)) target[name] = fn;
      const proxy = new Proxy(target, {
        get(t, prop, receiver) {
          if (typeof prop !== "string" || !prop.startsWith("$")) return Reflect.get(t, prop, receiver);
          const own = Reflect.get(t, prop, receiver);
          if (own !== undefined) return own;
          // 未实现的方法：**明确记一条**，按名字给安全默认值
          return (...args: unknown[]) => {
            log({
              level: "debug",
              source: "theia-host",
              message: `未实现的 ${identifier.id}.${prop}(${JSON.stringify(args).slice(0, 200)})`,
            });
            return Promise.resolve(safeDefault(prop));
          };
        },
      });
      rpc.set(identifier, proxy);
    };

    const commandRegistry = {
      /** 宿主登记命令 —— 这是 `extension.commands()` 的数据源。 */
      $registerCommand: (command: { id?: unknown }) => {
        if (typeof command?.id === "string") this.registeredCommands.add(command.id);
      },
      $unregisterCommand: (id: string) => {
        this.registeredCommands.delete(id);
      },
      $registerHandler: (id: string) => {
        // **这条才是「命令真的注册上了」的主证据。**
        //
        // 为什么不能只数 `$registerCommand`：宿主侧 `CommandRegistryImpl.registerCommand`
        // 有一道分支（`plugin-context.js` 的 `commandIsDeclaredInPackage`）——
        // **清单里声明过的命令直接走 `registerHandler`，根本不发 `$registerCommand`**。
        // 实测 latex-workshop：清单里 46 条声明命令，只有 27 条未声明的走了
        // `$registerCommand`。第一版只数后者，于是「注册了 25 条」而 `wordcount`
        // 永远查不到 —— 一个看起来像「注册没跑完」、实际是「查错了来源」的假象。
        if (typeof id === "string") this.registeredCommands.add(id);
      },
      $unregisterHandler: (id: string) => {
        this.registeredCommands.delete(id);
      },
      /**
       * 宿主侧的「执行命令」入口 —— 扩展调 `vscode.commands.executeCommand(...)`
       * 时走这里（反方向：宿主 → 我们）。
       *
       * ⚠️ **它不能把未知命令的失败往上抛。** 实测 latex-workshop 的 `activate()`
       * 第一句就是 `executeCommand('setContext', ...)`；`setContext` 是工作台内置命令，
       * 我们没实现，而 Theia 的 `CommandRegistryImpl.$executeCommand` 对未知 id 是
       * **reject**。第一版把它原样抛出，结果：`$executeCommand` 的 RPC 回包带着
       * `TypeError`，它**顺着 `activate()` 的调用栈冒出来**，宿主报
       * `handler[method] is not a function` —— 一个完全指错方向的错误。
       *
       * 所以：**扩展自己注册的命令**照常转发；**其余的一律当作「本宿主未实现」**
       * 返回 `undefined`，并记一条 debug。这正是 VS Code 对「命令不存在」的宽容面：
       * 扩展不会因为一个可选调用失败而整体激活失败。`NOT-COVERED` 里那三行
       * 说明的就是这件事的边界。
       */
      $executeCommand: async (id: string, ...args: unknown[]) => {
        const ext = rpc.getProxy<{ $executeCommand<T>(id: string, ...a: unknown[]): Promise<T> }>(
          modules.MAIN_RPC_CONTEXT.COMMAND_REGISTRY_EXT,
        );
        if (!this.registeredCommands.has(id)) {
          log({
            level: "debug",
            source: "theia-host",
            message: `扩展调用了未实现的命令 ${id}（当作成功、返回 undefined；见 NOT-COVERED）`,
          });
          return undefined;
        }
        return ext.$executeCommand(id, ...args);
      },
      $getCommands: async () => [...this.registeredCommands],
      $getKeyBinding: async () => undefined,
    };

    setProxyHandler(P.COMMAND_REGISTRY_MAIN, commandRegistry as never);
    setProxyHandler(P.LOGGER_MAIN, {
      $log: (level: number, source: string | undefined, message: string, params: unknown[]) => {
        const names = ["trace", "trace", "debug", "info", "warn", "error"] as const;
        const extra = Array.isArray(params) && params.length > 0 ? ` ${params.map(String).join(" ")}` : "";
        const entry: TheiaHostLogEntry = {
          level: names[Math.min(Math.max(level, 1), 5)],
          source: source ?? "plugin-host",
          message: `${message}${extra}`,
        };
        // 只收 **error**：warn 在真实扩展上很常见（latex-workshop 一来就是 3 条
        // “BibTeX 诊断集合已存在”，那是它自己重复注册，不是宿主的问题）。
        // 把 warn 也算进来，“activate() 没有异常”这条判据会被已知噪音顶红。
        if (entry.level === "error") this.activationErrorLog.push(entry);
        this.log(entry);
      },
    } as never);
    setProxyHandler(P.ENV_MAIN, {
      $getClientOperatingSystem: async () =>
        process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "OSX" : "Linux",
      $getEnvVariable: async (name: string) => process.env[name] ?? null,
    } as never);
    setProxyHandler(P.MESSAGE_REGISTRY_MAIN, {
      $showMessage: async (type:number,message:string,options:{modal?:boolean;detail?:string}|undefined,
        actions:Array<{title:string}>|undefined):Promise<number|undefined> => {
        if(!this.options.onMessage)return undefined;
        return this.options.onMessage({
          type,message:String(message),modal:options?.modal===true,
          ...(typeof options?.detail==="string"?{detail:options.detail}:{}),
          actions:Array.isArray(actions)?actions.map(item=>String(item?.title??"")):[],
        });
      },
    } as never);
    // Sandboxed Mcode Webview drawer: never mount extension HTML in the parent
    // React DOM or give it Node/Electron access. Full vscode-resource schemes
    // are intentionally NOT emulated until a secure resolver exists.
    setProxyHandler(P.WEBVIEWS_MAIN, {
      $createWebviewPanel:(handle:string,_viewType:string,title:string)=>{
        if(!this.options.onWebview)throw Error("此扩展会话未接入 Mcode 原生 Webview");
        if(typeof handle!=="string"||handle.length>256||this.webviewHandles.size>=4)
          throw Error("扩展 Webview 数量/标识不合法");
        if(this.webviewHandles.has(handle))throw Error("扩展 Webview 重复创建");
        this.webviewHandles.add(handle);
        this.options.onWebview?.({handle,action:"create",title:String(title).slice(0,180)});
      },
      $setHtml:(handle:string,html:string)=>{
        if(!this.webviewHandles.has(handle))throw Error("扩展 Webview 已失效");
        if(typeof html!=="string"||html.length>256_000)throw Error("扩展 Webview 内容超出限额");
        this.options.onWebview?.({handle,action:"html",html});
      },
      $setTitle:(handle:string,title:string)=>{
        if(this.webviewHandles.has(handle))this.options.onWebview?.({
          handle,action:"title",title:String(title).slice(0,180),
        });
      },
      $postMessage:async(handle:string,payload:unknown)=>{
        if(!this.webviewHandles.has(handle))return false;
        const text=JSON.stringify(payload);
        if(text===undefined||text.length>64_000)return false;
        this.options.onWebview?.({handle,action:"message",payload});
        return true;
      },
      $disposeWebview:(handle:string)=>this.disposeWebview(handle),
      $reveal:async()=>undefined,
      $setOptions:async()=>undefined,
      $setIconPath:async()=>undefined,
    } as never);
    setProxyHandler(P.TERMINAL_MAIN, {
      $createTerminal:(id:string,opts:{name?:string;cwd?:string;shellPath?:string;shellArgs?:unknown},_parent?:string,isPseudo=false)=>{
        if(!this.options.terminalDriver)throw Error("当前运行环境没有可用的 Mcode 原生终端");
        return this.options.terminalDriver.create(id,{...opts,isPseudo}).then(async created=>{
          const extension=rpc.getProxy<{$terminalCreated(id:string,name:string):Promise<void>|void}>(
            modules.MAIN_RPC_CONTEXT.TERMINAL_EXT);
          await extension.$terminalCreated(created,opts?.name??"Mcode 扩展终端");
          const pid=this.options.terminalDriver?.getProcessId?.(created);
          if(pid!==undefined&&Number.isSafeInteger(pid)&&pid>0){
            const opened=rpc.getProxy<{$terminalOpened(id:string,pid:number,terminalId:number,cols:number,rows:number):Promise<void>|void}>(
              modules.MAIN_RPC_CONTEXT.TERMINAL_EXT);
            await opened.$terminalOpened(created,pid,0,80,24);
          }
          return created;
        });
      },
      $sendText:(id:string,text:string,shouldExecute?:boolean)=>this.options.terminalDriver?.sendText(id,text,shouldExecute),
      $dispose:(id:string)=>this.options.terminalDriver?.dispose(id),
      $show:async()=>undefined,
      $hide:async()=>undefined,
      $setName:async()=>undefined,
    } as never);
    setProxyHandler(P.QUICK_OPEN_MAIN, {
      $show:(instance:number,opts:{title?:string;placeHolder?:string;canPickMany?:boolean})=>{
        if(!this.options.onQuickInput)return Promise.resolve(undefined);
        return new Promise<number|number[]|undefined>(resolve=>{
          this.quickPicks.set(instance,{resolve,opts:opts??{}});
        });
      },
      $setItems:async(instance:number,items:Array<{label:string;description?:string;detail?:string}>)=>{
        const request=this.quickPicks.get(instance);
        if(!request)return;
        this.quickPicks.delete(instance);
        try{
          const choice=await this.options.onQuickInput?.({
            kind:"pick",title:request.opts.title,placeholder:request.opts.placeHolder,
            canPickMany:request.opts.canPickMany,items,
          });
          request.resolve(Array.isArray(choice)?(request.opts.canPickMany?choice:choice[0]):undefined);
        }catch{request.resolve(undefined);}
      },
      $setError:async(instance:number)=>{this.quickPicks.get(instance)?.resolve(undefined);this.quickPicks.delete(instance);},
      $input:async(opts:{prompt?:string;placeHolder?:string;value?:string;password?:boolean})=>
        this.options.onQuickInput?.({kind:"input",title:opts?.prompt,
          placeholder:opts?.placeHolder,value:opts?.value,password:opts?.password}),
      $showInputBox:async(opts:{prompt?:string;placeholder?:string;value?:string;password?:boolean})=>
        this.options.onQuickInput?.({kind:"input",title:opts?.prompt,
          placeholder:opts?.placeholder,value:opts?.value,password:opts?.password}),
      $hide:()=>{for(const pick of this.quickPicks.values())pick.resolve(undefined);this.quickPicks.clear();},
      $dispose:async(instance:number)=>{
        this.quickPicks.get(instance)?.resolve(undefined);this.quickPicks.delete(instance);
      },
    } as never);
    setProxyHandler(P.LANGUAGES_MAIN, {
      $registerHoverProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"hover",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerCompletionSupport:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"completion",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerDefinitionProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"definition",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerReferenceProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"references",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerImplementationProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"implementation",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerTypeDefinitionProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"typeDefinition",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerOutlineSupport:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"documentSymbols",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerDocumentFormattingSupport:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"formatting",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerRangeFormattingSupport:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"rangeFormatting",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerOnTypeFormattingProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>,
        characters:string[])=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"onTypeFormatting",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*"),
          triggerCharacters:(Array.isArray(characters)?characters:[])
            .filter(c=>typeof c==="string"&&c.length===1).slice(0,10)});
      },
      $registerRenameProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"rename",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerQuickFixProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>)=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"codeActions",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*")});
      },
      $registerSignatureHelpProvider:(handle:number,_info:unknown,selectors:Array<{language?:string}>,
        metadata?:{triggerCharacters?:string[];retriggerCharacters?:string[]})=>{
        if(this.languageProviders.size>=60||!Number.isInteger(handle))return;
        this.languageProviders.set(handle,{kind:"signatureHelp",
          languages:(selectors??[]).slice(0,12).map(x=>x.language??"*"),
          triggerCharacters:(metadata?.triggerCharacters??[]).filter(c=>typeof c==="string"&&c.length<=2).slice(0,10),
          retriggerCharacters:(metadata?.retriggerCharacters??[]).filter(c=>typeof c==="string"&&c.length<=2).slice(0,10)});
      },
      $unregister:(handle:number)=>{this.languageProviders.delete(handle);},
      $getLanguages:async()=>["plaintext","javascript","typescript","python","json","markdown","html","css","xml","yaml"],
      $changeDiagnostics:(collectionId:string,delta:Array<[string,Array<{
        severity:number;message:string;source?:string;code?:string;
        startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number;
      }>]>)=>{
        if(!this.options.onDiagnostics||typeof collectionId!=="string"||collectionId.length>150)return;
        for(const [uri,raw] of Array.isArray(delta)?delta.slice(0,30):[]){
          if(typeof uri!=="string"||uri.length>4096||!Array.isArray(raw))continue;
          const markers=raw.slice(0,250).filter(item=>
            typeof item?.message==="string"&&Number.isInteger(item.startLineNumber)&&
            Number.isInteger(item.endLineNumber)&&Number.isInteger(item.startColumn)&&Number.isInteger(item.endColumn))
            .map(item=>({
              severity:([1,2,4,8].includes(item.severity)?item.severity:8) as 1|2|4|8,
              message:item.message.slice(0,2000),
              startLineNumber:Math.max(1,item.startLineNumber),startColumn:Math.max(1,item.startColumn),
              endLineNumber:Math.max(1,item.endLineNumber),endColumn:Math.max(1,item.endColumn),
              ...(typeof item.source==="string"?{source:item.source.slice(0,100)}:{}),
              ...(typeof item.code==="string"?{code:item.code.slice(0,100)}:{}),
            }));
          this.options.onDiagnostics(collectionId,uri,markers);
        }
      },
      $clearDiagnostics:(collectionId:string)=>{
        if(typeof collectionId==="string")this.options.onDiagnostics?.(collectionId,"",[],true);
      },
    } as never);
    setProxyHandler(P.STATUS_BAR_MESSAGE_REGISTRY_MAIN, {
      $setMessage:async(id:string,name:string|undefined,text:string|undefined,
        priority:number,alignment:number,_color:unknown,_backgroundColor:unknown,
        tooltip:unknown,command:string|undefined)=>{
        if(typeof id!=="string"||id.length>256)return;
        this.options.onStatus?.({
          id,text:typeof text==="string"?text.slice(0,160):"",
          ...(typeof name==="string"?{name:name.slice(0,160)}:{}),
          ...(typeof tooltip==="string"?{tooltip:tooltip.slice(0,400)}:{}),
          ...(typeof command==="string"?{command:command.slice(0,256)}:{}),
          priority:Number.isFinite(priority)?priority:0,alignment:Number(alignment)||1,
        });
      },
      $dispose:(id:string)=>{if(typeof id==="string")this.options.onStatus?.({id,removed:true});},
    } as never);
    // 进度条：扩展激活时会 `$startProgress`（latex-workshop 就调）。
    // 返回一个**稳定的 id**是必要的 —— 宿主侧拿它当 key 调 `$stopProgress`，
    // 返回 undefined 会让它把「停止」发到 undefined 上。
    let progressSeq = 0;
    setProxyHandler(P.NOTIFICATION_MAIN, {
      $startProgress: async () => `progress-${progressSeq++}`,
      $updateProgress: async () => undefined,
      $stopProgress: async () => undefined,
    } as never);
    // 输出通道：扩展写日志的地方。本卡只记录，不渲染面板（那是 F025 的 UI 工作）。
    setProxyHandler(P.OUTPUT_CHANNEL_REGISTRY_MAIN, {
      $append: async (channel: string, value: string) => {
        log({ level: "debug", source: `output:${channel}`, message: String(value).trim() });
      },
      $clear: async () => undefined,
      $dispose: async () => undefined,
      $reveal: async () => undefined,
      $close: async () => undefined,
    } as never);
    // F024: the extension's own TextEditor.edit() calls this Theia Main RPC.
    // No owner callback, stale version, overlap, or concurrent transaction can succeed.
    setProxyHandler(P.TEXT_EDITORS_MAIN, {
      $tryApplyEdits: async (id: string, version: number, edits: TheiaTextEdit[], opts: TheiaEditOptions): Promise<boolean> => {
        const session = this.activeEditorSession;
        if (!session || session.id !== id || session.version !== version || session.busy || !session.input.applyEdits) return false;
        const prepared = prepareTheiaEdits(session.input.text, edits, opts);
        if (!prepared) return false;
        session.busy = true;
        const previousText = session.input.text;
        const nextVersion = session.version + 1;
        try {
          const accepted = await session.input.applyEdits({
            filePath: session.input.filePath,
            version,
            beforeText: previousText,
            afterText: prepared.text,
            edits: prepared.changes,
            undoStopBefore: opts.undoStopBefore,
            undoStopAfter: opts.undoStopAfter,
          });
          if (!accepted || this.activeEditorSession !== session || this.disposed) return false;
          session.input = { ...session.input, text: prepared.text };
          session.version = nextVersion;
          // Tell the actual Theia DocumentDataExt, not merely the parent's snapshot.
          const document = rpc.getProxy<{ $acceptModelChanged(uri: unknown, event: unknown, dirty: boolean): Promise<void> }>(
            modules.MAIN_RPC_CONTEXT.DOCUMENTS_EXT,
          );
          await document.$acceptModelChanged(session.uri, {
            changes: prepared.changes,
            eol: prepared.text.includes("\r\n") ? "\r\n" : "\n",
            versionId: nextVersion,
            reason: undefined,
          }, true);
          return true;
        } catch (error) {
          log({ level: "error", source: "theia-editor", message: `编辑事务失败：${String(error)}` });
          return false;
        } finally {
          session.busy = false;
        }
      },
    } as never);
    // F032: vscode.workspace.fs uses Mcode's current project rather than a
    // fake provider. No workspace selected means all file operations fail closed.
    const nativeFs=this.options.workspaceFs;
    const mustFs=():McodeWorkspaceFs=>{
      if(!nativeFs)throw Error("未选择 Mcode 工作区，扩展文件 API 不可用");
      return nativeFs;
    };
    setProxyHandler(P.FILE_SYSTEM_EVENT_SERVICE_MAIN, {
      $watch:async(_id:number,uri:FileResource)=>{
        if(!this.options.workspaceFs)throw Error("当前没有可用的 Mcode 工作区监听根");
        await this.options.workspaceFs.resolve(uri);
        if(!this.workspaceWatcher?.active)throw Error("本机平台无法启用原生项目文件监听");
      },
      $unwatch:async()=>undefined, // Single root watcher is disposed with its host.
    } as never);
    setProxyHandler(P.FILE_SYSTEM_MAIN, {
      $stat:(uri:FileResource)=>mustFs().stat(uri),
      $readdir:(uri:FileResource)=>mustFs().readdir(uri),
      $readFile:async(uri:FileResource)=>modules.BinaryBuffer.wrap(await mustFs().readFile(uri)),
      $writeFile:(uri:FileResource,binary:{buffer:Uint8Array})=>mustFs().writeFile(uri,binary.buffer),
      $mkdir:(uri:FileResource)=>mustFs().mkdir(uri),
      $rename:(src:FileResource,dst:FileResource,opts:{overwrite?:boolean})=>
        mustFs().rename(src,dst,opts?.overwrite===true),
      $copy:(src:FileResource,dst:FileResource,opts:{overwrite?:boolean})=>
        mustFs().copy(src,dst,opts?.overwrite===true),
      $delete:(uri:FileResource,opts:{recursive?:boolean})=>mustFs().delete(uri,opts?.recursive===true),
    } as never);
    setProxyHandler(P.WORKSPACE_MAIN, {
      $getWorkspace:async()=>nativeFs?{
        resource:pathToFileURL(nativeFs.root).toString(),name:path.basename(nativeFs.root),
        isDirectory:true,mtime:0,ctime:0,size:0,
      }:undefined,
      $pickWorkspaceFolder:async()=>undefined,
      $requestWorkspaceTrust:async()=>Boolean(nativeFs),
      $updateWorkspaceFolders:async()=>{throw Error("请在 Mcode 原生项目界面切换工作区");},
      $startFileSearch:async(pattern:string,folder:string|undefined,opts:{
        exclude?:string;maxResults?:number
      })=>{
        const root=mustFs();
        let scope:FileResource|undefined;
        if(folder){
          const parsed=new URL(folder);
          if(parsed.protocol!=="file:")throw Error("仅支持 Mcode 本地工作区搜索");
          scope={scheme:"file",path:decodeURIComponent(parsed.pathname),authority:parsed.host};
        }
        return root.findFiles(pattern,opts?.exclude,opts?.maxResults??200,scope);
      },
      $resolveProxy:async()=>undefined,
      $resolveDecoding:async()=>({preferredEncoding:"utf8",guessEncoding:false}),
      $resolveEncoding:async()=>({encoding:"utf8",hasBOM:false}),
      $getValidEncoding:async()=>("utf8"),
    } as never);
    setProxyHandler(P.PREFERENCE_REGISTRY_MAIN, {
      $updateConfigurationOption:async(_target:unknown,key:string,value:unknown,resource?:string)=>{
        if(resource)throw Error("Mcode 暂不支持扩展按资源覆盖配置");
        const prefs=this.extensionPreferences;
        if(!prefs)throw Error("扩展配置尚未初始化");
        await prefs.update(key,value);
        const ext=rpc.getProxy<{$acceptConfigurationChanged(
          data:Record<number,unknown>,changes:Array<{preferenceName:string}>
        ):Promise<void>}>(modules.MAIN_RPC_CONTEXT.PREFERENCE_REGISTRY_EXT);
        await ext.$acceptConfigurationChanged(this.buildPreferenceData(),[{preferenceName:key}]);
      },
      $removeConfigurationOption:async(target:unknown,key:string,resource?:string)=>{
        if(resource)throw Error("Mcode 暂不支持扩展按资源覆盖配置");
        const prefs=this.extensionPreferences;
        if(!prefs)throw Error("扩展配置尚未初始化");
        await prefs.update(key,undefined);
        const ext=rpc.getProxy<{$acceptConfigurationChanged(
          data:Record<number,unknown>,changes:Array<{preferenceName:string}>
        ):Promise<void>}>(modules.MAIN_RPC_CONTEXT.PREFERENCE_REGISTRY_EXT);
        await ext.$acceptConfigurationChanged(this.buildPreferenceData(),[{preferenceName:key}]);
      },
    } as never);
    setProxyHandler(P.STORAGE_MAIN, {
      $set:async(key:string,value:unknown,isGlobal:boolean)=>{
        if(!this.extensionState)throw Error("扩展状态存储未初始化");
        return this.extensionState.set(key,value,isGlobal);
      },
      $get:async(key:string,isGlobal:boolean)=>this.extensionState?.get(key,isGlobal),
      $getAll:async(isGlobal:boolean)=>this.extensionState?.getAll(isGlobal)??{},
    } as never);

    // 其余：全部走「显式记录 + 安全默认值」的兜底。
    //
    // ⚠️ **判据是「这个 key 有没有被显式实现」，不是「它是否在某个手写名单里」。**
    // 第一版写了一份列举名单；新增 `NOTIFICATION_MAIN` / `OUTPUT_CHANNEL_REGISTRY_MAIN`
    // 的实现之后忘了加进名单，兜底的 `{}` 会**后写覆盖**掉真实实现 ——
    // 症状是 `$startProgress` 返回 undefined，而日志里看不出任何异常。
    // 现在改成：只要上面已经 `set` 过，这里就跳过。名单会过期，状态不会。
    for (const key of Object.keys(P)) {
      if (implemented.has(P[key])) continue;
      setProxyHandler(P[key], {} as never);
    }
  }

  /** Native Mcode settings changes update the live Theia extension without restart. */
  async updatePreference(key:string,value:unknown):Promise<void>{
    const prefs=this.extensionPreferences;
    if(!prefs)throw Error("扩展配置未就绪");
    await prefs.update(key,value);
    if(this.rpc&&this.modules&&this.started&&!this.disposed){
      const ext=this.rpc.getProxy<{$acceptConfigurationChanged(
        data:Record<number,unknown>,changes:Array<{preferenceName:string}>
      ):Promise<void>}>(this.modules.MAIN_RPC_CONTEXT.PREFERENCE_REGISTRY_EXT);
      await ext.$acceptConfigurationChanged(this.buildPreferenceData(),[{preferenceName:key}]);
    }
  }
  private buildPreferenceData(manifest?: Record<string, unknown>): Record<number, unknown> {
    const defaults=manifest
      ?this.options.preferenceDefaults??collectConfigurationDefaults(manifest)
      :this.configurationDefaults;
    // 0 Default, 1 User; Mcode extension-specific settings in app dataRoot.
    return {0:defaults,1:this.extensionPreferences?.user??{},2:{},3:{}};
  }

}

/* ───────────────────────── 内部工具 ───────────────────────── */

interface PluginManagerProxy {
  $init(params: unknown): Promise<void>;
  $start(params: unknown): Promise<void>;
  $activateByEvent(event: string): Promise<void>;
  $stop(id?: string): Promise<void>;
}

/**
 * 未实现方法的默认返回值。
 *
 * 判据：**看宿主的消费代码**。`$showQuickPick` / `$showInputBox` 的
 * `undefined` 在 vscode API 里就是「用户取消」，是正确的；而
 * `$getCommands` 的 `undefined` 会让 `filter` 抛 —— 所以后者上面单独实现了。
 * 这里只兜住「返回 undefined 不改变语义」的那些。
 */
function safeDefault(method: string): unknown {
  if (method.startsWith("$get") || method.startsWith("$fetch")) return undefined;
  return undefined;
}

/**
 * 从扩展清单合成 `PreferenceScope.Default` 的值。
 *
 * 键要带 section 前缀：清单里 `intellisense.package.exclude`，而扩展代码调的是
 * `getConfiguration('latex-workshop').get('intellisense.package.exclude')`。
 * 宿主侧 `lookUp(tree, key)` 是**逐段下钻**的，所以平铺键与嵌套键都能命中；
 * 这里平铺（与 `getConfiguration(section)` 的 `lookUp` 直接兼容）。
 */
export function collectConfigurationDefaults(manifest: Record<string, unknown>): Record<string, unknown> {
  const contributes = manifest.contributes as { configuration?: unknown } | undefined;
  const raw = contributes?.configuration;
  const sections = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const result: Record<string, unknown> = {};
  for (const section of sections) {
    const properties = (section as { properties?: Record<string, unknown> })?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const [key, descriptor] of Object.entries(properties)) {
      if (descriptor && typeof descriptor === "object" && "default" in descriptor) {
        result[key] = (descriptor as { default: unknown }).default;
      }
    }
  }
  return result;
}
