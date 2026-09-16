/**
 * 语言服务器(LSP):安装 / 开关 / 健康检查 / 文档同步 / 请求转发,
 * 以及 `lsp:event` 推送的类型。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── Language servers (LSP) ──
 *  Each language has an installable, toggleable language server (TS/JS,
 *  Python, Go, Java). Servers run in the main process as stdio JSON-RPC
 *  children; the renderer talks to them via the `lsp.*` RPC namespace and
 *  receives diagnostics/logs/state changes over the `lsp:event` push channel.
 *  Monaco providers (definition/references/hover) in the renderer call
 *  `lsp.request` to forward LSP method calls; document sync goes through
 *  `lsp.openDocument` / `lsp.didChange` / `lsp.didSave` / `lsp.closeDocument`. */

/** Setting key for the persisted LSP server config list.
 *  Value = JSON.stringify(LspServerConfig[]). */
export const LSP_SERVERS_SETTING_KEY = "lsp.servers";

/** Languages with first-class LSP support. The enum is reused across every
 *  LSP schema so the renderer, preload, and main share one vocabulary. */
export const LspLanguageSchema = z.enum(["typescript", "python", "go", "java"]);
export type LspLanguageId = z.infer<typeof LspLanguageSchema>;

/** A single language's persisted configuration. Stored as a JSON array under
 *  LSP_SERVERS_SETTING_KEY. Missing entries default to { enabled: false }. */
export interface LspServerConfig {
  language: LspLanguageId;
  enabled: boolean;
  /** User override for the server executable. Empty/absent -> auto-detect via
   *  PATH lookup (which/where). */
  serverPath?: string;
  /** Extra CLI args appended after the server's stdio flag. Advanced. */
  args?: string[];
  /** Java only: path to a JDK 17+ home (JAVA_HOME) used to RUN jdtls. This is
   *  independent of the project's JDK -- jdtls needs Java 17+ to run even when
   *  the project itself targets Java 8. Empty/absent -> use system java. */
  javaHome?: string;
}

/** Generic success/failure result for install/stop/health operations. */
export interface LspOpResult {
  ok: boolean;
  error?: string;
}

/** Snapshot of one language's state, sent to the renderer by `lsp.list`. The
 *  renderer treats this as read-only display data. */
export interface LspLanguageState {
  language: LspLanguageId;
  enabled: boolean;
  /** Whether the server binary was found on disk (PATH or custom path). */
  installed: boolean;
  /** Resolved server path (or null if not found). */
  serverPath: string | null;
  /** Whether a server process is currently alive for this language (any
   *  workspace). */
  running: boolean;
  /** Whether an install/uninstall is currently in progress. */
  installing: boolean;
  /** Tail of the most recent install/uninstall output (truncated). */
  installLog: string;
  /** Last error from a failed server start (stderr summary). Empty when the
   *  server is running fine. Shown in the settings panel so the user knows
   *  WHY the server won't start (e.g. "jdtls requires at least Java 21"). */
  lastError: string;
}

/** `lsp:event` stateChanged payload: the language-server lifecycle for one
 *  (workspacePath, language). Emitted at every phase transition so the
 *  renderer can show startup progress in the editor toolbar. `stopped` after
 *  a failed start carries the reason in `error`. */
export interface LspStateChangedPayload {
  /** "starting" = spawned, initialize handshake in flight (can take minutes
   *  for Java); "running" = initialize done; "stopped" = exited/failed;
   *  "importing" = (Java) initialize done but jdtls is still importing the
   *  project — requests queue behind the import job, so the editor should
   *  explain the wait instead of showing a generic running state. */
  phase: "starting" | "running" | "stopped" | "importing";
  /** Boolean view of the phase (running === phase === "running"), kept for
   *  consumers that only care whether the server is usable. */
  running: boolean;
  /** Failure reason when the server couldn't start (phase "stopped"). */
  error?: string;
  /** Human-readable progress detail for the phase — jdtls reports live
   *  import progress ("24% · Importing project welfare-service") on every
   *  language/status update while importing. */
  detail?: string;
}

/** A diagnostic pushed from the server via publishDiagnostics. Mirrors LSP
 *  Diagnostic (0-based line/character). */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

// -- RPC input schemas --

export const LspListSchema = z.object({});
export type LspListInput = z.infer<typeof LspListSchema>;

export const LspInstallSchema = z.object({ language: LspLanguageSchema });
export type LspInstallInput = z.infer<typeof LspInstallSchema>;

/** Install from a user-downloaded archive (tar.gz/zip) or binary. Used when
 *  the package-manager install fails due to network issues -- the user
 *  downloads the file manually via the download-page button, then selects it
 *  here. For Java the archive is extracted into userData/lsp/java; for other
 *  languages the file/binary path is recorded as a custom serverPath. */
export const LspInstallFromFileSchema = z.object({
  language: LspLanguageSchema,
  /** Absolute path to the user-selected file (archive or binary). */
  archivePath: z.string().min(1),
});
export type LspInstallFromFileInput = z.infer<typeof LspInstallFromFileSchema>;

export const LspUninstallSchema = z.object({ language: LspLanguageSchema });
export type LspUninstallInput = z.infer<typeof LspUninstallSchema>;

export const LspToggleSchema = z.object({
  language: LspLanguageSchema,
  enabled: z.boolean(),
});
export type LspToggleInput = z.infer<typeof LspToggleSchema>;

export const LspSetPathSchema = z.object({
  language: LspLanguageSchema,
  serverPath: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Java only: override the JDK used to run jdtls (JAVA_HOME). */
  javaHome: z.string().optional(),
});
export type LspSetPathInput = z.infer<typeof LspSetPathSchema>;

export const LspHealthCheckSchema = z.object({ language: LspLanguageSchema });
export type LspHealthCheckInput = z.infer<typeof LspHealthCheckSchema>;

/** Pre-warm a workspace's Java server: spawn it (and thus start the one-time
 *  Maven/Gradle project import) WITHOUT waiting for the user to open a Java
 *  file. Called when a project becomes active so the import runs while the
 *  user browses instead of blocking their first openDocument. Fire-and-forget
 *  semantics; idempotent (a live server is reused, never restarted). */
export const LspPrewarmSchema = z.object({
  /** Project root to pre-warm (must be a known project). */
  workspacePath: z.string(),
});
export type LspPrewarmInput = z.infer<typeof LspPrewarmSchema>;

/** Restart a language server for one workspace. Unlike a toggle-off/on this
 *  immediately relaunches (with the crash-loop guard cleared) so the editor's
 *  startup pill visibly goes starting → running/stopped. */
export const LspRestartSchema = z.object({
  /** Project root the server was started for (must be a known project). */
  workspacePath: z.string(),
  language: LspLanguageSchema,
});
export type LspRestartInput = z.infer<typeof LspRestartSchema>;

export const LspOpenDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  language: LspLanguageSchema,
});
export type LspOpenDocInput = z.infer<typeof LspOpenDocSchema>;

export const LspCloseDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});
export type LspCloseDocInput = z.infer<typeof LspCloseDocSchema>;

export const LspDidChangeSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
  version: z.number().int(),
});
export type LspDidChangeInput = z.infer<typeof LspDidChangeSchema>;

export const LspDidSaveSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
});
export type LspDidSaveInput = z.infer<typeof LspDidSaveSchema>;

export const LspRequestSchema = z.object({
  workspacePath: z.string(),
  language: LspLanguageSchema,
  /** LSP method, e.g. "textDocument/definition". */
  method: z.string(),
  /** LSP params object (passed through verbatim). */
  params: z.unknown(),
});
export type LspRequestInput = z.infer<typeof LspRequestSchema>;

/** `lsp.request` returns either the LSP result or an error object. */
export type LspRequestResult =
  | { result: unknown }
  | { error: { code: number; message: string } };

