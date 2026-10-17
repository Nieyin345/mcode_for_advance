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
import { resolveGenofficeCliPath, docsRead, docsApply, slidesRead, sheetRead, convertFile, type GenofficeResult } from "@main/document/genofficeCli.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";

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
async function readByKind(
  p: { cliPath: string; withinWorkspace(q: string): boolean },
  filePath: string,
  options: { full?: boolean; range?: string },
): Promise<GenofficeResult> {
  const kind = documentKindOf(filePath);
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
    return toWire(await docsApply(p.ports, input.filePath, input.ops, {
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.track !== undefined ? { track: input.track } : {}),
    }));
  });

  ipc.handle(IPC.DOCUMENT_CONVERT, async (_evt, raw) => {
    const input = DocumentConvertSchema.parse(raw);
    if (!p.ok) return unavailable();
    return toWire(await convertFile(p.ports, input.inputPath, input.to, input.outputPath, {
      ...(input.force !== undefined ? { force: input.force } : {}),
    }));
  });

  ipc.handle(IPC.DOCUMENT_CAPABILITIES, async (): Promise<DocumentCapabilities> => capabilities());
}

function unavailable(): DocumentIpcResult {
  return {
    ok: false,
    kind: "unavailable",
    reason: "没有找到仓库内的 GenOffice CLI 快照（genoffice/packages/cli/dist/genoffice.cjs）。请先在 genoffice/ 下构建 CLI。",
  };
}

function capabilities(): DocumentCapabilities {
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
