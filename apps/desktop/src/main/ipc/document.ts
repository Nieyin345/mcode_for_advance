/**
 * 【ARC-007】文档能力 IPC —— 把 `genofficeCli` 适配层接到唯一能力通道。
 *
 * 三条硬约束（与台账 ARC-007「不可让步」对应）：
 *  1. **路径围栏在宿主**：每条 handler 用 `findContainingWorkspaceRoot` 复核，
 *     不采信调用方自报的路径身份（与 `file:readFile` 同一条判据）。
 *  2. **用户与 Agent 同一段代码**：这些 handler 经 `createDbGuardedIpc` 注册，
 *     于是 `app_api_call` 调到的和界面点按钮调到的**是同一个函数**
 *     （`recordRpcHandler` 那一层，见 `ipc/dbGuardedIpc.ts`）。
 *  3. **失败分类原样透传**：`refused / unavailable / failed` 三档各自带原因，
 *     不把"工具没装/需要 headless 宿主"说成"文档坏了"。
 *
 * 生产装配：CLI 路径在首次调用时解析（仓库内 `genoffice/` 快照）。解析不到时
 * `document.capabilities` 如实报告、其它三条返回 `unavailable` —— 不抛、不静默。
 */
import type { IpcMain } from "electron";
import { dirname } from "node:path";
import {
  IPC,
  DocumentReadSchema,
  DocumentEditSchema,
  DocumentConvertSchema,
  type DocumentCapabilities,
  type DocumentIpcResult,
} from "@contracts/ipc";
import { documentKindOf } from "@contracts/documentKind";
import { resolveGenofficeCliPath, docsRead, docsApply, slidesRead, slidesApply, sheetRead, sheetApply, convertFile, guideOps, type GenofficeResult } from "@main/document/genofficeCli.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";

/**
 * 仓库根的**可注入解析** —— 默认惰性 `require("electron").app.getAppPath()`
 * （打包后是 `resources/app.asar`，开发时是 `apps/desktop`）。
 *
 * 为什么不在模块顶层 import electron：本模块会被无头套件加载（验 handler 注册与
 * 契约接线），顶层 import 会把 electron 的 CJK/`__dirname` 兼容层拖进来并炸在
 * ESM 下（实测 ERR_AMBIGUOUS_MODULE_SYNTAX）。惰性 require 只在真调用时发生；
 * 测试可用 `configureDocumentRepoRoot` 注入。
 */
let repoRootOverride: string | null = null;

/** 测试/装配用：固定仓库根（传 null 复位）。 */
export function configureDocumentRepoRoot(root: string | null): void {
  repoRootOverride = root;
}

function repoRoot(): string {
  if (repoRootOverride !== null) return repoRootOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { app?: { getAppPath?: () => string } };
    const appPath = electron.app?.getAppPath?.();
    if (typeof appPath === "string" && appPath.length > 0) return dirname(dirname(appPath));
  } catch { /* 无头环境 / 非 electron */ }
  return process.cwd();
}

/** **仓库根的唯一解析出口**。`ipc/mcp.ts` 的 GenOffice MCP 安装入口也要拿它
 *  （`resolveGenofficeCliPath` 需要仓库根），不能再抄一份 `getAppPath` 解析 ——
 *  两份一旦分家，安装出来的条目与 `document.*` 会指向不同的 CLI 快照。 */
export function documentRepoRoot(): string {
  return repoRoot();
}

/** 每次现解析（快照可能被替换）；结果不缓存，避免"装好了还要重启"。 */
function ports(): { ok: true; ports: { cliPath: string; withinWorkspace(p: string): boolean } } | { ok: false } {
  const cliPath = resolveGenofficeCliPath(repoRoot());
  if (cliPath === null) return { ok: false };
  return {
    ok: true,
    ports: {
      cliPath,
      withinWorkspace: (p: string) => findContainingWorkspaceRoot(p) !== null,
    },
  };
}

/** `GenofficeResult` → 线格。成功时带上 command/summary/detail。 */
function toWire(result: GenofficeResult): DocumentIpcResult {
  if (result.ok) {
    return {
      ok: true,
      command: result.envelope.command ?? "",
      summary: result.envelope.summary ?? null,
      detail: result.envelope.detail ?? null,
    };
  }
  return {
    ok: false,
    kind: result.kind,
    reason: result.reason,
    ...(result.envelope !== null && typeof result.envelope.code === "number" ? { code: result.envelope.code } : {}),
    ...(result.envelope !== null && typeof result.envelope.error === "string" && result.envelope.code === undefined ? { code: result.envelope.error } : {}),
  };
}

/** 按 `documentKindOf` 选读口（docx / pptx / xlsx）。 */
export async function readByKind(
  p: { cliPath: string; withinWorkspace(q: string): boolean },
  filePath: string,
  options: { full?: boolean; range?: string },
): Promise<GenofficeResult> {
  const kind = documentKindOf(filePath);
  // 【ARC-007】markdown 没有"结构化 read"路由（CLI 的 md 能力是转换，不是读块）。
  // 如实拒绝并指向文件读取通道 —— 不假装 convert 往返等于结构读。
  if (kind === "markdown") {
    return {
      ok: false, kind: "refused", envelope: null,
      reason: "Markdown 请走文件读取通道（file.readFile）或编辑器；GenOffice CLI 对 md 只提供转换（→docx/html），没有块结构读。",
    };
  }
  if (kind === "html") {
    return {
      ok: false, kind: "unavailable", envelope: null,
      reason: "HTML 编辑/转换需要 GenOffice 应用渲染器（GENOFFICE_APP_BIN）；只读展示请走浏览器预览。",
    };
  }
  if (kind === "office") {
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "pptx" || ext === "pptm" || ext === "potx" || ext === "odp") return slidesRead(p, filePath);
    if (ext === "xlsx" || ext === "xlsm" || ext === "xltx" || ext === "ods") return sheetRead(p, filePath);
    return docsRead(p, filePath, options);
  }
  // 其余格式没有"结构化读"的 headless 路由 —— 如实拒绝(不猜)。
  return {
    ok: false, kind: "refused", envelope: null,
    reason: `这个格式没有结构化读取路由:${filePath}（documentKind=${kind}）`,
  };
}

/**
 * 按 `documentKindOf` 选**编辑**口 —— 与 {@link readByKind} 同一张格式判据表。
 *
 * 之前 `document.edit` 无条件走 `docs apply`（docx 专用），于是 pptx/xlsx 的编辑
 * 会返回 `conversion_failed: document.xml has no <w:body> element` —— 那是 docx
 * 解析器在报"这不是 docx"，却被当成"文档执行失败"透传给调用方。CLI 本身有
 * `slides apply` / `sheet apply`（都是纯 Node），按格式路由才是真能力。
 *
 * 不接的格式沿用读侧同款措辞：markdown 指回编辑器，html 需应用渲染器，其余拒绝。
 */
export async function editByKind(
  p: { cliPath: string; withinWorkspace(q: string): boolean },
  filePath: string,
  ops: unknown,
  options: { dryRun?: boolean; track?: boolean },
): Promise<GenofficeResult> {
  const kind = documentKindOf(filePath);
  if (kind === "markdown") {
    return {
      ok: false, kind: "refused", envelope: null,
      reason: "Markdown 请走编辑器或 file.writeFile；GenOffice CLI 对 md 只提供转换（→docx/html），没有结构化编辑。",
    };
  }
  if (kind === "html") {
    return {
      ok: false, kind: "unavailable", envelope: null,
      reason: "HTML 编辑需要 GenOffice 应用渲染器（GENOFFICE_APP_BIN）；请用编辑器写文本。",
    };
  }
  if (kind === "office") {
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "pptx" || ext === "pptm" || ext === "potx" || ext === "odp") {
      return slidesApply(p, filePath, ops, { ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}) });
    }
    if (ext === "xlsx" || ext === "xlsm" || ext === "xltx" || ext === "ods") {
      return sheetApply(p, filePath, ops, { ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}) });
    }
    return docsApply(p, filePath, ops, {
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.track !== undefined ? { track: options.track } : {}),
    });
  }
  return {
    ok: false, kind: "refused", envelope: null,
    reason: `这个格式没有结构化编辑路由:${filePath}（documentKind=${kind}）`,
  };
}

export function registerDocumentHandlers(ipc: IpcMain): void {
  const p = ports();

  ipc.handle(IPC.DOCUMENT_READ, async (_evt, raw) => {
    const input = DocumentReadSchema.parse(raw);
    if (!p.ok) return unavailable();
    return toWire(await readByKind(p.ports, input.filePath, {
      ...(input.full !== undefined ? { full: input.full } : {}),
      ...(input.range !== undefined ? { range: input.range } : {}),
    }));
  });

  ipc.handle(IPC.DOCUMENT_EDIT, async (_evt, raw) => {
    const input = DocumentEditSchema.parse(raw);
    if (!p.ok) return unavailable();
    // 【ARC-007】原值版本检查(与 file.writeFile 的 expectedVersion 同一算法)。
    // 检查在**执行前**；CLI 写入后不再复核 —— 那一段是 CLI 的原子写,宿主无法插进去。
    // 因此判据是"读到版本 → 立刻执行",窗口极小;真正的并发互斥留给后续
    // VersionedFileStore 切片(计划 B.2),这里先把"旧草稿静默覆盖"堵住。
    if (input.expectedRevision !== undefined) {
      const current = await fileContentVersion(input.filePath);
      if (current !== input.expectedRevision) {
        return {
          ok: false,
          kind: "conflict",
          reason: "文档已被别处改动(另一个窗口、Agent 或外部编辑器)—— 为避免覆盖对方刚保存的内容,这次编辑未执行。请重新加载后再改。",
          currentRevision: current,
        };
      }
    }
    const result = await editByKind(p.ports, input.filePath, input.ops, {
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.track !== undefined ? { track: input.track } : {}),
    });
    // 成功时回传新版本(dryRun 不写盘,版本不变)。
    if (result.ok && input.dryRun !== true) {
      const wire = toWire(result);
      return wire.ok ? { ...wire, revision: await fileContentVersion(input.filePath) } : wire;
    }
    return toWire(result);
  });

  ipc.handle(IPC.DOCUMENT_CONVERT, async (_evt, raw) => {
    const input = DocumentConvertSchema.parse(raw);
    if (!p.ok) return unavailable();
    return toWire(await convertFile(p.ports, input.inputPath, input.to, input.outputPath, {
      ...(input.force !== undefined ? { force: input.force } : {}),
    }));
  });

  ipc.handle(IPC.DOCUMENT_CAPABILITIES, async (): Promise<DocumentCapabilities> => capabilities(p.ok ? p.ports : null));
}

function unavailable(): DocumentIpcResult {
  return {
    ok: false,
    kind: "unavailable",
    reason: "没有找到仓库内的 GenOffice CLI 快照（genoffice/packages/cli/dist/genoffice.cjs）。请先在 genoffice/ 下构建 CLI。",
  };
}

async function capabilities(portsArg: { cliPath: string; withinWorkspace(q: string): boolean } | null): Promise<DocumentCapabilities> {
  const base = capabilitiesStatic();
  if (portsArg === null) return base;
  // ops 目录：让 Agent 经 app_api_describe 就能看到"能做哪些编辑操作"。
  // 失败只是少一段说明，不影响能力报告本身（如实标注）。
  const guides: Record<string, string> = {};
  for (const domain of ["docs", "slides"] as const) {
    const r = await guideOps(portsArg, domain);
    if (r.ok) guides[domain] = typeof r.envelope.summary === "string" ? r.envelope.summary : "";
  }
  return { ...base, opsGuides: guides };
}

function capabilitiesStatic(): DocumentCapabilities {
  const cliPath = resolveGenofficeCliPath(repoRoot());
  return {
    cli: { available: cliPath !== null, path: cliPath },
    local: [
      "docx read/apply（纯 Node）",
      "pptx read/apply/create（纯 Node）",
      "xlsx create（纯 JS）、xlsx 操作编辑（纯 JS）",
      "markdown → docx/html（纯 Node）",
      "pdf 文本层读取（纯 Node）",
    ],
    needsApp: [
      "任意格式 → pdf（页面布局需要应用渲染器）",
      "docx → html、网页 html → docx",
      "render / slides render（PNG 导出）",
    ],
    needsSidecar: [
      "sheet read / 公式重算 / xls·ods 旧格式（Rust xlsx-sidecar，需 XLSX_SIDECAR_PATH）",
    ],
    note: cliPath === null
      ? "CLI 不可用：先构建 genoffice/packages/cli。"
      : "CLI 已就绪。标注 needsApp 的路由需要设置 GENOFFICE_APP_BIN 指向 GenOffice 可执行文件；needsSidecar 的路由需要构建 Rust xlsx-sidecar。",
  };
}
