/**
 * 【ARC-007 P0】**一次性文档字节响应** —— 宿主读出的字节交给页面的唯一通道。
 *
 * ## 为什么需要它
 *
 * vendor docs 页的打开链（`file-actions.ts` 的 `loadFileImpl`）拿到
 * `OpenDocxResult` 后第一件事是 `fetchDocBytes(result.dataUrl)` —— 它要的是
 * **一个能 fetch 的 URL**，不是字节本身。vendor 主进程的做法是
 * `handOffBytes()`（`apps/docs/src/main/byte-handoff.ts:44-52`）：内存里存一份
 * 字节，发一个 `genoffice-docx-media://handoff/<token>` 的一次性地址，页面
 * fetch 一次即焚。
 *
 * Mcode 的宿主接手了 vendor 主进程的职责，就必须给出同形状的响应。本模块是
 * 那份机制的 Mcode 版，语义逐条对齐：
 *
 *  - **一次性**：`takeDocumentHandoff` 取走即删（重复 fetch 得到 404）；
 *  - **限时**：60s TTL，超时丢弃（与 vendor `HANDOFF_TTL_MS` 同）；
 *  - **限额**：与 vendor 原版一致，未消费最多 8 份或 1 GiB；
 *    oldest-first 淘汰，但不能用自设 64 MiB 把原厂可打开的文档误挤掉；
 *  - **绑定**：token 只在 `issue` 的调用里生成，而 `issue` 只由宿主在
 *    `readOpened`（已过工作区围栏）里调用 —— 页面自己造不出有效 token；
 *    响应里同时带 docId/路径的 sha256，页面无法把它当成"别的文件"用。
 *
 * ## 协议注册
 *
 * `genoffice-docx-media` 是 vendor 页面 CSP 里**明确放行**的 scheme
 * （`apps/docs/out/renderer/index.html` 的 `connect-src … genoffice-docx-media:`），
 * 所以宿主必须用同一个 scheme，不能自创一个（页面 fetch 会被 CSP 拦）。
 * 注册特权的调用必须在 `app.whenReady` 之前（Electron 硬性要求），与
 * `mcode-panel://` 同一套做法（见 `customUi/panelProtocol.ts`）。
 */
import { randomUUID } from "node:crypto";

/**
 * electron 惰性解析：本模块被无头套件（纯 node）加载时不能顶层 import
 * electron —— esbuild 会把 electron 包打进 ESM 产物并触发
 * `ERR_AMBIGUOUS_MODULE_SYNTAX`（与 documentViewHost 的 createView 同理）。
 * 真正需要 protocol 的两个入口（privileged 注册 / 协议处理）只在生产主进程调。
 */
type ProtocolModule = { protocol: typeof import("electron").protocol };
function electronProtocol(): ProtocolModule["protocol"] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as typeof import("electron");
    return electron.protocol ?? null;
  } catch {
    return null;
  }
}

/** vendor 页面 CSP 放行的 scheme（`packages/docx-engine/src/lazy-media.ts:10`）。 */
export const DOCUMENT_HANDOFF_SCHEME = "genoffice-docx-media";
/** host 段 —— 与 vendor 的 `handoff` 保持同一个形状，页面侧不区分来源。 */
export const DOCUMENT_HANDOFF_HOST = "handoff";

const HANDOFF_TTL_MS = 60_000;
/** 与 genoffice/apps/docs/src/main/byte-handoff.ts 对齐的原厂预算。 */
const MAX_PENDING_HANDOFFS = 8;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

interface HandoffEntry {
  bytes: Buffer;
  /** 发出这份字节的视图（诊断与审计用；不参与协议层的身份判断，理由见文件头）。 */
  docId: string;
  filePath: string;
  sha256: string;
  /** Opaque identity of the owning DocumentViewHost instance. */
  owner?: object;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, HandoffEntry>();
let pendingBytes = 0;

function drop(token: string): void {
  const entry = pending.get(token);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  pending.delete(token);
  pendingBytes -= entry.bytes.length;
}

function evictFor(bytes: number): void {
  // Reuse the vendor eviction order and its combined count+byte budget;
  // a single large (but allowed by the Host) doc is not rejected merely
  // because earlier unclaimed handoffs exist.
  while (pending.size + 1 > MAX_PENDING_HANDOFFS || pendingBytes + bytes > MAX_TOTAL_BYTES) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
}

/**
 * 在内存里存一份字节，返回一次性 URL。**只允许宿主调用**（`readOpened` 路径）；
 * 页面通过 IPC 拿不到这个函数。
 */
export function issueDocumentHandoff(
  bytes: Uint8Array,
  meta: { docId: string; filePath: string; sha256: string; owner?: object },
): string {
  // DocumentViewHost already supplies a Buffer from readFile. Copying it
  // again doubles native memory pressure for a large DOCX. Keep the same
  // Buffer as the vendor handOffBytes does; Uint8Array callers still copy.
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  evictFor(buffer.length);
  const token = randomUUID();
  const timer = setTimeout(() => drop(token), HANDOFF_TTL_MS);
  timer.unref?.();
  pending.set(token, {
    bytes: buffer,
    docId: meta.docId,
    filePath: meta.filePath,
    sha256: meta.sha256,
    owner: meta.owner,
    expires: Date.now() + HANDOFF_TTL_MS,
    timer,
  });
  pendingBytes += buffer.length;
  return `${DOCUMENT_HANDOFF_SCHEME}://${DOCUMENT_HANDOFF_HOST}/${token}`;
}

/** 取走 token 背后的字节（取一次即焚）。非本 scheme / 过期 / 已用过 → null。 */
export function takeDocumentHandoff(url: string): Buffer | null {
  const prefix = `${DOCUMENT_HANDOFF_SCHEME}://${DOCUMENT_HANDOFF_HOST}/`;
  if (!url.startsWith(prefix)) return null;
  const token = url.slice(prefix.length);
  const entry = pending.get(token);
  if (entry === undefined) return null;
  drop(token);
  if (entry.expires <= Date.now()) return null;
  return entry.bytes;
}

/** Revoke unclaimed DOCX responses belonging to a destroyed editor view.
 * Only the originating Host invokes this. Already-taken bytes remain owned
 * by Electron's fetch response and are not invalidated by closing the view. */
export function revokeDocumentHandoffs(docId: string, owner: object): void {
  // docIds are stable file-derived IDs, not globally unique between separate
  // Host/window instances. Never discard another Host's identically named
  // document while closing our own view.
  for (const [token, entry] of pending) {
    if (entry.docId === docId && entry.owner === owner) drop(token);
  }
}

/** 诊断：当前挂起的 handoff 数（套件断言"没有泄漏的未消费响应"）。 */
export function pendingDocumentHandoffCount(): number {
  for (const token of [...pending.keys()]) {
    const entry = pending.get(token);
    if (entry !== undefined && entry.expires <= Date.now()) drop(token);
  }
  return pending.size;
}

/**
 * **必须在 app ready 之前**调（Electron 硬性要求）。与 vendor
 * `DOCX_MEDIA_SCHEME_PRIVILEGE`（`packages/electron-utils/src/renderer-scheme.ts:23-32`）
 * 逐字段一致：`standard/secure/supportFetchAPI/corsEnabled/stream`。
 * 幂等：重复注册抛错被吞掉（Electron 对同一 scheme 重复注册会抛）。
 */
export function registerDocumentHandoffSchemePrivileged(): void {
  const protocol = electronProtocol();
  if (protocol === null) return;
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: DOCUMENT_HANDOFF_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
      },
    ]);
  } catch {
    /* 已注册（另一入口先注册了，或本进程重复调用） */
  }
}

/** A view over an existing Buffer, not `new Uint8Array(buffer)` which
 * copies a potentially 1GiB DOCX in the protocol response path. The
 * outstanding Buffer is retained by the response until Electron consumes it. */
export function handoffResponseBodyView(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/** app ready 之后调：接上协议处理。幂等。 */
export function initDocumentHandoffProtocol(): void {
  const protocol = electronProtocol();
  if (protocol === null) return;
  try {
    if (protocol.isProtocolHandled(DOCUMENT_HANDOFF_SCHEME)) return;
    protocol.handle(DOCUMENT_HANDOFF_SCHEME, (request) => {
      const handed = takeDocumentHandoff(request.url);
      if (handed === null) return new Response(null, { status: 404 });
      return new Response(handoffResponseBodyView(handed), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(handed.byteLength),
          "Access-Control-Allow-Origin": "*",
        },
      });
    });
  } catch {
    /* 非 Electron 环境（无头套件）或已处理 */
  }
}
