/**
 * agent 运行时(claude/codex/pi 按需下载)+ 文档工具链(pandoc / TeX / zip)。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。两者的 `...EventMessage` 也在这里 —
 * events.ts 的 union 从这里引用。
 */

import { z } from "zod";

/* ── Agent runtimes (download-on-demand) ──
 *  The claude / codex binaries and the pi JS runtime are NOT bundled with the
 *  installer (~600MB per platform); they live under userData/runtimes and are
 *  downloaded on demand from the npm registry. The settings panel lists one
 *  card per agent via `runtimes.list`; install/remove go through
 *  `runtimes.install` / `runtimes.remove`; live download/extract progress is
 *  pushed over the `runtimes:event` channel. The pinned expected version comes
 *  from this app's own package.json (see runtimeInstaller.ts). */

export const RuntimeAgentSchema = z.enum(["claude", "codex", "pi"]);
export type RuntimeAgentId = z.infer<typeof RuntimeAgentSchema>;

/** Where the provider currently loads a runtime from. "managed" = the
 *  on-demand install under userData/runtimes (what this panel installs);
 *  "dev" = node_modules of a development checkout (devDependencies / the
 *  SDK's platform optionalDependency — absent in packaged builds);
 *  "bundled" = a legacy build that still ships the payload in
 *  app.asar.unpacked. null = not available anywhere → the provider errors
 *  on use and the panel should offer the install button. */
export type RuntimeAgentSource = "managed" | "dev" | "bundled";

/** Snapshot of one agent runtime for the settings panel. Read-only display
 *  data; mutations happen through install/remove and are reflected by
 *  re-listing plus `runtimes:event` pushes. */
export interface RuntimeAgentState {
  agent: RuntimeAgentId;
  /** Version this Mcode build expects (pinned in package.json). */
  expectedVersion: string;
  /** Version installed under userData/runtimes, or null when absent. Note:
   *  a runtime can be USABLE without being installed here (see `source`). */
  installedVersion: string | null;
  /** Where the runtime is currently loaded from (see RuntimeAgentSource). */
  source: RuntimeAgentSource | null;
  /** Version of the copy the provider actually loads (= installedVersion
   *  when source is "managed", else the dev/bundled fallback's version).
   *  Null when nothing is usable. */
  activeVersion: string | null;
  /** Absolute path of the payload the provider actually loads (binary /
   *  package.json). Null when nothing is usable. */
  activePath: string | null;
  /** Latest version advertised by the registry, or null when the check
   *  hasn't run yet / failed (offline). Populated lazily by `runtimes.list`. */
  latestVersion: string | null;
  /** Whether a managed copy exists under userData/runtimes. */
  installed: boolean;
  /** The ACTIVE copy (managed, else dev/bundled fallback) differs from the
   *  version this Mcode build expects. Happens after the app itself
   *  updated; the panel offers an update. */
  updateAvailable: boolean;
  installing: boolean;
  /** Tail of the last install/remove error. Empty when healthy. */
  lastError: string;
  /** On-disk footprint of the managed install (bytes; 0 when absent). */
  diskBytes: number;
  /** Managed install location of the active version (display only). */
  installPath: string | null;
}

/** `runtimes:event` payload — coarse phase + fraction for one agent. */
export interface RuntimeProgressPayload {
  agent: RuntimeAgentId;
  phase: "downloading" | "extracting" | "done" | "error";
  /** 0..1 during "downloading"; -1 when Content-Length is unknown. */
  progress: number;
  /** Populated when phase === "error". */
  error?: string;
}

export interface RuntimeEventMessage {
  channel: "runtimes:event";
  payload: RuntimeProgressPayload;
}

/* ── 文档工具链(外部依赖)──
 *
 * 四个内置文档技能(docx / pptx / xlsx / pdf)本身随应用发布,但它们**要用的
 * 工具**不在应用里:pandoc、python 的若干包、zip、LibreOffice、poppler 都是
 * 机器级的东西。换一台干净电脑,技能在那里、工具不在,一到要读 Word 就失败,
 * 而且失败得莫名其妙。
 *
 * 这一节就是「设置 → 内核」里新加的那一块:检测 + 按需安装,与 agent 内核
 * (claude / codex / pi)同一套思路。
 *
 * ## 哪些能由应用装,哪些只能指路
 *
 * `pandoc` 是**单个自包含可执行文件**,下下来塞进 `<userData>/tools/` 就能用 ——
 * 不要管理员权限、不写系统目录、卸载应用即消失。`latex` 走 **TinyTeX**(TeX Live
 * 的轻量发行版):同样落在应用自己的工具目录里,同样不需要管理员 —— 值得说明的
 * 是它的 Windows 包虽然后缀是 `.exe`,但那是**自解压包**(官方脚本用 `-y` 调它,
 * 注释写的是 "unbundle"),只把 `TinyTeX/` 解开到当前目录,不写注册表、不改 PATH。
 * `python-deps` 正相反:包必须装进用户**已有的**解释器里,所以那一项是"检测 +
 * 调他的 pip",不搬运解释器本身。zip / LibreOffice / poppler 都是要管理员权限的
 * 系统级安装,只检测、给指引 —— 装不装由用户决定,应用不替他动系统。
 */

/** 有检测/安装意义的外部工具 —— 就是四个技能实际会调的那些(数过脚本里的
 *  subprocess 与 SKILL.md 里的命令),不是拍脑袋列的。 */
export const TOOLCHAIN_TOOL_IDS = [
  "pandoc",
  "latex",
  "python-deps",
  "zip-tools",
  "soffice",
  "pdftoppm",
] as const;
export type ToolchainToolId = (typeof TOOLCHAIN_TOOL_IDS)[number];

/** 这个工具是从哪儿被找到的。 */
export type ToolchainSource =
  /** 应用自己下载并管理的副本(在 `<userData>/tools/` 下)。 */
  | "managed"
  /** 用户机器上本来就有的(系统 PATH 上的可执行文件 / 他的 python)。 */
  | "system"
  /** 没找到。 */
  | "missing";

export interface ToolchainToolState {
  id: ToolchainToolId;
  /** 可用 = 下面 components 里每一项都找到了。 */
  ok: boolean;
  source: ToolchainSource;
  /** 主程序版本(pandoc --version 之类),拿不到就 null。 */
  version: string | null;
  /** 主程序的绝对路径(可执行文件 / python 解释器),展示用。 */
  path: string | null;
  /** 能不能由应用安装。false = 只检测并给出指引(zip / LibreOffice / poppler
   *  都是要管理员权限的系统级安装,装不装由用户决定)。 */
  installable: boolean;
  installing: boolean;
  /** 最近一次装/卸失败的尾巴。空 = 正常。 */
  lastError: string;
  /** 组成这个工具的可执行文件 / 宏包 / python 包,以及各自找到没有。
   *
   *  **名字是机器名**(`pandoc` / `unzip` / `openpyxl` / `ctex`),不是文案 ——
   *  主进程不负责措辞,渲染端按 zh/en 自己拼("缺 openpyxl、markitdown")。 */
  components: Array<{ name: string; found: boolean }>;
}

/** `toolchain:event` 载荷 —— 与 runtimes:event 同构,面板用同一套渲染。 */
export interface ToolchainProgressPayload {
  tool: ToolchainToolId;
  phase: "downloading" | "extracting" | "installing" | "done" | "error";
  /** 0..1(下载中);-1 表示 Content-Length 未知 / 该阶段没有进度。 */
  progress: number;
  error?: string;
}

export interface ToolchainEventMessage {
  channel: "toolchain:event";
  payload: ToolchainProgressPayload;
}

// -- RPC input schemas --

export const RuntimesListSchema = z.object({});
export type RuntimesListInput = z.infer<typeof RuntimesListSchema>;

export const RuntimesInstallSchema = z.object({ agent: RuntimeAgentSchema });
export type RuntimesInstallInput = z.infer<typeof RuntimesInstallSchema>;

/** Install from a user-picked LOCAL PATH. Escape hatch when the registry path
 *  fails: @mcode/runtime-pi not published yet, stale mirror, offline.
 *  Accepted: the agent's install directory (claude platform package dir /
 *  codex vendored package dir / pi meta-package dir with node_modules/), the
 *  agent binary file itself (claude/codex), or an npm-shaped .tgz. Mirrors
 *  `lsp.installFromFile` but path-based. */
export const RuntimesInstallLocalSchema = z.object({
  agent: RuntimeAgentSchema,
  /** Absolute local path (directory, binary, or .tgz). */
  localPath: z.string().min(1),
});
export type RuntimesInstallLocalInput = z.infer<typeof RuntimesInstallLocalSchema>;

export const RuntimesRemoveSchema = z.object({ agent: RuntimeAgentSchema });
export type RuntimesRemoveInput = z.infer<typeof RuntimesRemoveSchema>;

/* ── 文档工具链 RPC 入参 ── */

/** 安装/卸载一个工具。只有应用真能装的那几项会被接受 —— 下面这个 enum 就是那道
 *  门,handler 里不必再判一次。 */
export const ToolchainToolSchema = z.enum(TOOLCHAIN_TOOL_IDS);
export const ToolchainInstallSchema = z.object({ tool: ToolchainToolSchema });
export type ToolchainInstallInput = z.infer<typeof ToolchainInstallSchema>;

export const ToolchainRemoveSchema = z.object({ tool: ToolchainToolSchema });
export type ToolchainRemoveInput = z.infer<typeof ToolchainRemoveSchema>;

// `toolchain.check` **没有入参 schema** —— 它检测的是这台机器,不针对某个项目。

