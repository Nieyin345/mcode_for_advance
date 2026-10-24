/**
 * O10 —— **四个格式的保存守卫**（Mcode 侧）。
 *
 * 装上它之后，html / markdown / pdf / slides 的保存会经过：
 *
 * ```
 * withOsFileLease(real) ─┬─ 重算 fileContentVersion(real)
 *                        ├─ 与「打开时版本」比较 → 不一致就抛冲突（一个字节不写）
 *                        ├─ 调用 vendor 的写盘回调（write 在租约内）
 *                        └─ 推进打开会话表里的版本
 * ```
 *
 * ## 「打开时版本」从哪来
 *
 * `DocumentViewHost` 的**打开会话表**（`sessions`，按 `physicalPath` 归一后建键）
 * 在 `claimOpenedPath` 时把 `fileContentVersion(filePath)` 的快照记进
 * `session.revision`；docs 的 `saveOpenedFile` 用的就是它。四个 vendor 视图
 * 走的是同一个 `claimOpenedPath`（`open()` 的 kind 分支），所以表里**已经有**
 * 这四家的打开版本 —— 不需要在 vendor 里另记一份。守卫只读它、写成功后推进它。
 *
 * ## 为什么版本不进请求、不进渲染端
 *
 * 渲染端只知道「我打开时看到的内容」，不知道盘上后来发生了什么。让它回报版本
 * 等于让它转述一个它拿不到的事实。docs 的 `saveOpenedFile` 已经证明主进程侧
 * 快照就够了（页面从不传版本，CAS 照样生效）。
 *
 * ## 冲突怎么让用户看见
 *
 * 抛一个 `Error`，message 是给人看的整句。四个 vendor 保存 handler 的
 * `catch` 都把它们转成 `{ ok: false, error: <message> }`（pdf/markdown/html 逐字
 * 相同；slides 是 `String(err)`），而四个渲染端都读 `error` 并显示
 * （slides 是错误 toast + 状态栏，pdf 是 `.tb-save-error` 芯片 + notice，
 * md/html 是状态栏 `.status-save.status-failed`）。所以**不需要改任何渲染端**。
 */
import { physicalPath } from "@main/lib/realPathWithin.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { log } from "@main/lib/logger.js";
import type { DocumentSaveGuard, DocumentSaveFormat } from "@genoffice/electron-utils/document-save-guard";

/** 守卫需要的宿主能力（注入，便于无头套件用假的）。 */
export interface DocumentSaveGuardHost {
  /** 按归一化物理路径取「打开时版本」的 Promise（没有该路径的会话 → null）。 */
  openedRevisionFor(realPath: string): Promise<string | null> | null;
  /** 保存成功后推进打开会话表里的版本。 */
  recordSavedRevision(realPath: string, revision: string | null): void;
}

/** 冲突错误的文案（与 docs 的 `saveOpenedFile` 同义：说清后果与下一步）。 */
export const CONFLICT_MESSAGE =
  "文档已被别处改动（另一个窗口、Agent 或外部编辑器）—— 为避免覆盖对方刚保存的内容，本次保存未执行。请重新打开后再改。";

/** 带人话与 `conflict` 标记的错误：vendor 的 catch 会把它折成 `{ok:false,error}`。 */
export class DocumentSaveConflictError extends Error {
  readonly reason = "conflict";
  constructor(message: string = CONFLICT_MESSAGE) {
    super(message);
    this.name = "DocumentSaveConflictError";
  }
}

export interface DocumentSaveGuardDeps extends DocumentSaveGuardHost {
  /** 诊断/测试接缝：生产是 no-op；回归网在这里把「胜者持锁窗口」拉长做真并发断言。 */
  beforeWrite?: (realPath: string) => void | Promise<void>;
}

/**
 * 造守卫。**只在装配期调一次**，由 `setDocumentSaveGuard` 装进 vendor 的接缝。
 *
 * 语义与 `documentViewHost.saveOpenedFile` 一致：
 *  - 没有该路径的打开会话 → **不拦**（独立运行时/未知视图，vendor 自己写）；
 *  - 有会话且盘上版本 === 打开版本 → 写，并推进版本；
 *  - 有会话但版本不一致 → 抛 `DocumentSaveConflictError`，**一个字节不写**。
 */
export function makeDocumentSaveGuard(deps: DocumentSaveGuardDeps): DocumentSaveGuard {
  return async (ctx) => {
    const format: DocumentSaveFormat = ctx.format;
    // 归一化与打开会话表**同一份判据**（`physicalPath`：resolve + symlink/junction）。
    // 拿不到归一化路径（断裂链接等）时退回 vendor 给的原始 target ——
    // 此时 `openedRevisionFor` 也查不到会话，语义退化成「不拦」，与独立运行一致。
    const real = physicalPath(ctx.target) ?? ctx.target;
    const opened = deps.openedRevisionFor(real);
    if (opened === null) {
      // 没有打开会话：不拦（vendor 独立运行 / 非本宿主打开的视图）。
      await ctx.write();
      return;
    }
    const expected = await opened;
    await withOsFileLease(real, async (leasedReal) => {
      const current = await fileContentVersion(leasedReal);
      if (expected !== null && current !== expected) {
        log.warn(
          `document save conflict (${format}): ${leasedReal} expected=${String(expected)} current=${String(current)}`,
        );
        throw new DocumentSaveConflictError();
      }
      if (deps.beforeWrite !== undefined) await deps.beforeWrite(leasedReal);
      // 写发生在租约内（防 TOCTOU：比较与写必须是同一个临界区）。
      await ctx.write();
      const advanced = await fileContentVersion(leasedReal);
      deps.recordSavedRevision(leasedReal, advanced);
      log.info(`document save committed (${format}): ${leasedReal} revision=${String(advanced)}`);
    });
  };
}
