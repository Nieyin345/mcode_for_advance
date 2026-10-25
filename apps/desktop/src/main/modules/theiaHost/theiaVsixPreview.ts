/**
 * F025 Theia VSIX compatibility PREVIEW. This is NOT ModuleHost.install:
 * everything is temporary and must not appear in the persistent module catalog.
 * A preview needs desktop user confirmation and grants an unsandboxed Node host.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { buildExtensionPermissionReport } from "../theiaPermissionReport.js";
import { buildInstallConsentPrompt } from "./installConsent.js";
import { TheiaHost, type TheiaExtensionHandle } from "./host.js";
import type { TheiaPreviewResult } from "@contracts/ipc/modules.js";

const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;
const MAX_SINGLE = 32 * 1024 * 1024;
const MAX_FILES = 3000;
const MAX_TICKET_AGE_MS = 5 * 60 * 1000;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface VsixArchive {
  files: Map<string, Uint8Array>;
  extensionId: string;
  main: string;
}
function reject(message: string): never { throw Error("THEIA_VSIX_REJECT: " + message); }

/** Validates the entire central directory, local headers, CRCs and decompression before extraction. */
export function parseTheiaVsix(bytes: Uint8Array): VsixArchive {
  if (bytes.byteLength < 100 || bytes.byteLength > MAX_ARCHIVE) reject("压缩包超过 64 MiB 上限或太小");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  const within = (p: number, size: number) =>
    Number.isSafeInteger(p) && Number.isSafeInteger(size) && p >= 0 && size >= 0 && p + size <= bytes.byteLength;
  let eocd = -1;
  for (let p = bytes.byteLength - 22; p >= Math.max(0, bytes.byteLength - 65557); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.byteLength) { eocd = p; break; }
  }
  if (eocd < 0) reject("找不到 ZIP 结束目录");
  const count = u16(eocd + 10), centralSize = u32(eocd + 12), centralStart = u32(eocd + 16);
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== count ||
      count === 0 || count === 0xffff || count > MAX_FILES || centralSize === 0xffffffff ||
      centralStart === 0xffffffff || !within(centralStart, centralSize) ||
      centralStart + centralSize !== eocd) reject("不支持跨卷/ZIP64/损坏的 ZIP 目录");
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];
  let offset = centralStart, uncompressedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (!within(offset, 46) || u32(offset) !== 0x02014b50) reject("无效中央目录条目");
    const flags = u16(offset + 8), method = u16(offset + 10);
    const crc = u32(offset + 16), packed = u32(offset + 20), unpacked = u32(offset + 24);
    const nameLen = u16(offset + 28), extra = u16(offset + 30), comment = u16(offset + 32);
    const diskStart = u16(offset + 34), attrs = u32(offset + 38), local = u32(offset + 42);
    if ((flags & ~0x808) !== 0 || (method !== 0 && method !== 8) ||
        packed === 0xffffffff || unpacked === 0xffffffff || diskStart !== 0 ||
        !within(offset + 46, nameLen + extra + comment) || !within(local, 30) ||
        u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) {
      reject("不支持的加密/压缩/ZIP64/局部条目");
    }
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    const isDir = name.endsWith("/");
    const segments = name.split("/");
    if (!name || name.includes("\\") || name.includes("\0") || /[<>:"|?*]/.test(name) ||
        name.startsWith("/") || segments.some((part, index) => (part === "" && !(isDir && index === segments.length - 1)) ||
          part === "." || part === ".." || /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) || name.length > 400) reject("包内路径不安全：" + name.slice(0, 100));
    // Windows is case-insensitive. Duplicate names must not overwrite one another.
    const folded = name.toLowerCase().replace(/\/$/, "");
    if (seen.has(folded)) reject("重复 ZIP 路径：" + name);
    seen.add(folded);
    const fileType = (attrs >>> 16) & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) reject("不允许符号链接或特殊文件");
    if ((fileType === 0x4000) !== isDir && fileType !== 0) reject("文件类型与路径不一致");
    uncompressedTotal += unpacked;
    if (unpacked > MAX_SINGLE || uncompressedTotal > MAX_TOTAL) reject("解压内容超过安全上限");
    const localNameLen = u16(local + 26), localExtra = u16(local + 28);
    const start = local + 30 + localNameLen + localExtra;
    if (!within(local + 30, localNameLen + localExtra) ||
        decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLen)) !== name ||
        !within(start, packed) || start + packed > centralStart ||
        (method === 0 && packed !== unpacked)) reject("局部 ZIP 头与中央目录不一致");
    spans.push([local, start + packed]);
    let data: Uint8Array;
    try {
      data = method === 0 ? bytes.subarray(start, start + packed) :
        new Uint8Array(inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: Math.max(unpacked, 1) }));
    } catch { reject("DEFLATE 解压失败或声明长度不匹配：" + name); }
    if (data.byteLength !== unpacked) reject("解压长度不匹配：" + name);
    let computed = 0xffffffff;
    for (const octet of data) {
      computed ^= octet;
      for (let bit = 0; bit < 8; bit++) computed = (computed >>> 1) ^ ((computed & 1) ? 0xedb88320 : 0);
    }
    if (((computed ^ 0xffffffff) >>> 0) !== crc) reject("CRC 校验失败：" + name);
    if (!isDir) {
      if (!name.startsWith("extension/") &&
          name !== "extension.vsixmanifest" && name !== "[Content_Types].xml") reject("包内未知根目录：" + name);
      files.set(name, new Uint8Array(data));
    }
    offset += 46 + nameLen + extra + comment;
  }
  if (offset !== eocd) reject("中央目录含有未解析字节");
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) reject("ZIP 数据块重叠");
  const manifestBytes = files.get("extension/package.json");
  if (!manifestBytes || manifestBytes.byteLength > 256 * 1024) reject("缺少或过大的 extension/package.json");
  let manifest: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(decoder.decode(manifestBytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    manifest = value as Record<string, unknown>;
  } catch { reject("无效扩展清单 JSON"); }
  const publisher = manifest.publisher, name = manifest.name, version = manifest.version;
  if (typeof publisher !== "string" || typeof name !== "string" || typeof version !== "string" ||
      typeof manifest.engines !== "object" || manifest.engines === null ||
      typeof (manifest.engines as Record<string, unknown>).vscode !== "string") reject("缺少扩展身份或 VS Code 引擎声明");
  const main = manifest.main;
  if (typeof main !== "string" || !main.trim()) reject("目前仅试运行有 Node main 的扩展");
  const suffix = main.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!suffix || suffix.startsWith("/") || suffix.split("/").some(x => !x || x === "." || x === "..")) reject("main 路径非法");
  const mainFile = files.has("extension/" + suffix) ? suffix : suffix + ".js";
  if (!files.has("extension/" + mainFile)) reject("清单 main 对应文件不存在");
  return { files, extensionId: (publisher + "." + name + "@" + version).toLowerCase(), main: mainFile };
}

interface Prepared {
  senderId: number; root: string; createdAt: number; ticket: string;
  extensionDir: string; extensionId: string;
}
interface Running {
  senderId: number; root: string; sessionId: string; host: TheiaHost; handle: TheiaExtensionHandle;
  commands: Set<string>;
}

/** One process-owned temporary preview at a time; never persists a "module installed" claim. */
export class TheiaVsixPreview {
  private prepared: Prepared | null = null;
  private running: Running | null = null;
  private starting = false;
  private inspecting = false;
  private preparedTimer: NodeJS.Timeout | null = null;
  private startingOwner: number | null = null;
  private readonly closedSenders = new Set<number>();
  constructor(private readonly theiaRoot: string) {}
  private clearTicketTimer(): void {
    if (this.preparedTimer) clearTimeout(this.preparedTimer);
    this.preparedTimer = null;
  }
  private discardTicket(): void {
    this.clearTicketTimer();
    const pending = this.prepared;
    this.prepared = null;
    if (pending) this.removeDir(pending.root);
  }
  private armTicket(ticket: string): void {
    this.clearTicketTimer();
    this.preparedTimer = setTimeout(() => {
      if (this.prepared?.ticket === ticket) this.discardTicket();
    }, MAX_TICKET_AGE_MS);
    this.preparedTimer.unref?.();
  }
  private removeDir(root: string): void { rmSync(root, { recursive: true, force: true }); }

  async inspect(senderId: number, vsixPath: string): Promise<TheiaPreviewResult> {
    if (this.closedSenders.has(senderId)) throw Error("窗口已关闭，拒绝启动或预检");
    if (this.starting || this.running || this.inspecting) throw Error("已有 Theia 预检或试运行正在进行");
    this.inspecting = true;
    try { return await this.inspectExclusive(senderId, vsixPath); }
    finally { this.inspecting = false; }
  }

  private async inspectExclusive(senderId: number, vsixPath: string): Promise<TheiaPreviewResult> {
    if (!path.isAbsolute(vsixPath) || path.extname(vsixPath).toLowerCase() !== ".vsix") throw Error("必须选择绝对路径 .vsix 文件");
    const stat = lstatSync(vsixPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE) throw Error("VSIX 必须是普通独立文件，且不超过 64 MiB");
    const archive = parseTheiaVsix(new Uint8Array(readFileSync(vsixPath)));
    this.discardTicket();
    const root = mkdtempSync(path.join(tmpdir(), "mcode-theia-vsix-"));
    try {
      const extensionDir = path.join(root, "extension");
      for (const [name, data] of archive.files) {
        if (!name.startsWith("extension/")) continue;
        const destination = path.resolve(root, name);
        if (!destination.startsWith(root + path.sep)) reject("解包路径越界");
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, data, { flag: "wx" });
      }
      const report = await buildExtensionPermissionReport(extensionDir, { entry: archive.main });
      if (this.closedSenders.has(senderId)) throw Error("窗口已关闭，不能保留预检凭据");
      const prompt = buildInstallConsentPrompt(report);
      // A scanner that could not inspect a main must not produce a seemingly clean consent card.
      if (report.limits.some(line => line.includes("读取 package.json 失败") ||
          line.includes("没有 main / browser") || line.includes("入口路径在扩展目录之外"))) {
        reject("静态权限报告不完整，拒绝试运行");
      }
      const ticket = randomUUID();
      this.prepared = { senderId, root, createdAt: Date.now(), ticket, extensionDir, extensionId: archive.extensionId };
      this.armTicket(ticket);
      return { kind: "inspection", ticket, extensionId: archive.extensionId,
        fileCount: archive.files.size, prompt };
    } catch (error) { this.removeDir(root); throw error; }
  }

  async cancel(senderId: number, ticket: string): Promise<TheiaPreviewResult> {
    const prepared = this.prepared;
    if (!prepared || prepared.senderId !== senderId || prepared.ticket !== ticket) throw Error("试运行授权不存在或发送方不匹配");
    this.discardTicket();
    return { kind: "stopped" };
  }

  async start(senderId: number, ticket: string, accepted: true): Promise<TheiaPreviewResult> {
    const candidate = this.prepared;
    if (this.running || this.starting || !candidate || candidate.ticket !== ticket ||
        candidate.senderId !== senderId || Date.now() - candidate.createdAt > MAX_TICKET_AGE_MS ||
        accepted !== true) throw Error("试运行授权不存在、过期或发送方不一致；请重新预检");
    this.prepared = null; // ticket single use, even if start fails
    this.clearTicketTimer();
    this.starting = true;
    this.startingOwner = senderId;
    const host = new TheiaHost({ theiaRoot: this.theiaRoot, extensionDir: candidate.extensionDir,
      storageRoot: path.join(candidate.root, "storage") });
    try {
      await host.start();
      const handle = await host.activate();
      const commands = await handle.commands();
      if (this.closedSenders.has(senderId)) throw Error("窗口在启动期间关闭，已取消启动");
      const sessionId = randomUUID();
      this.running = { senderId, root: candidate.root, sessionId, host, handle, commands: new Set(commands) };
      return { kind: "started", sessionId, extensionId: candidate.extensionId,
        commands, activationErrors: handle.activationErrors.map(error => error.message).slice(0, 8) };
    } catch (error) {
      await host.dispose();
      this.removeDir(candidate.root);
      throw error;
    } finally { this.starting = false; this.startingOwner = null; }
  }

  async execute(senderId: number, sessionId: string, commandId: string): Promise<TheiaPreviewResult> {
    const active = this.running;
    if (!active || active.senderId !== senderId || active.sessionId !== sessionId ||
        !active.commands.has(commandId)) throw Error("试运行已经结束或命令并未注册");
    const raw = await active.handle.executeCommand<unknown>(commandId);
    // A stopped/replaced session cannot publish late command results as success.
    if (this.running !== active || this.closedSenders.has(senderId)) throw Error("试运行在命令执行过程中已被停止");
    let result: string;
    try { result = JSON.stringify(raw) ?? "undefined"; }
    catch { result = "[unserializable result]"; }
    return { kind: "executed", result: result.slice(0, 3000) };
  }

  async stop(senderId: number, sessionId: string): Promise<TheiaPreviewResult> {
    const active = this.running;
    if (!active || active.senderId !== senderId || active.sessionId !== sessionId) throw Error("试运行不存在或发送方不匹配");
    this.running = null;
    try { await active.host.dispose(); }
    finally { this.removeDir(active.root); }
    return { kind: "stopped" };
  }

  async disposeSender(senderId: number): Promise<void> {
    this.closedSenders.add(senderId);
    if (this.prepared?.senderId === senderId) this.discardTicket();
    // A currently starting session sees closedSenders before it can publish a handle.
    const active = this.running;
    if (active?.senderId === senderId) {
      this.running = null;
      try { await active.host.dispose(); }
      finally { this.removeDir(active.root); }
    }
  }
  async disposeAll(): Promise<void> {
    const active = this.running; this.running = null;
    this.discardTicket();
    if (this.startingOwner !== null) this.closedSenders.add(this.startingOwner);
    if (active) { try { await active.host.dispose(); } finally { this.removeDir(active.root); } }
  }
}
