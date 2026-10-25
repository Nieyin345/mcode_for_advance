/** F025 E1: real multi-entry VSIX, real Theia host and rejection controls. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { TheiaVsixPreview, parseTheiaVsix } from "../../src/main/modules/theiaHost/theiaVsixPreview.js";
import { registerTheiaPreviewHandlers, theiaDesktopSender } from "../../src/main/ipc/theiaPreview.js";
import { IPC } from "@contracts/ipc";
import { policyFor } from "../../src/main/appControl/policy.js";
import { APP_METHOD_PERMISSIONS } from "@contracts/appPermission";

const root = process.env.MCODE_SMOKE_REPO_ROOT;
if (!root) throw Error("MCODE_SMOKE_REPO_ROOT missing");
const theia = path.join(root, "vendor", "theia");
const hostJs = path.join(theia, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
const vscodeJs = path.join(theia, "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js");
if (!existsSync(hostJs) || !existsSync(vscodeJs)) {
  console.error("THEIA_BUILD_REQUIRED: plugin-ext and plugin-ext-vscode must be built");
  process.exit(2);
}
const fixture = path.join(root, "apps/desktop/scripts/theia-host-boot-smoke/fixtures/spawn-ext");
const rawManifest = readFileSync(path.join(fixture, "package.json"));
const mainJs = readFileSync(path.join(fixture, "extension.js"));
const work = mkdtempSync(path.join(tmpdir(), "mcode-f025-smoke-"));
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { pass++; console.log("  ok " + label); }
  else { fail++; console.log("  FAIL " + label + " " + String(detail ?? "")); }
}
async function rejects(label: string, action: () => unknown | Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  check(label, rejected);
}
function crc32(raw: Buffer): number {
  let crc = 0xffffffff;
  for (const b of raw) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
interface Entry { name: string; bytes: Buffer; mode?: number; corruptCrc?: boolean; declaredSize?: number }
function zip(entries: Entry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.corruptCrc ? crc + 1 : crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.mode === undefined ? 0 : (entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const middle = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(middle.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, middle, eocd]);
}
const manifest = { name: "extension/package.json", bytes: rawManifest };
const script = { name: "extension/extension.js", bytes: mainJs };
const extra = { name: "extension/doc/readme.txt", bytes: Buffer.from("hello") };
const normal = zip([manifest, script, extra, { name: "extension.vsixmanifest", bytes: Buffer.from("<xml/>") }]);
const vsix = path.join(work, "real.vsix");
writeFileSync(vsix, normal);
const mgr = new TheiaVsixPreview(theia);
try {
  check("Agent 不可委托试运行与执行接口", policyFor("modules.theiaPreview").level === "blocked");
  check("试运行即使 blocked 也记录真实副作用", policyFor("modules.theiaPreview").effect === "mutating");
  check("扩展模块无权委托试运行", APP_METHOD_PERMISSIONS["modules.theiaPreview"] === null);
  const parsed = parseTheiaVsix(normal);
  check("多文件 DEFLATE VSIX 正确解析", parsed.files.size === 4);
  check("真实 manifest 与 main 匹配", parsed.extensionId === "mcode-smoke.spawn-ext@1.0.0" && parsed.main === "extension.js");
  await rejects("路径穿越被拒绝", () => parseTheiaVsix(zip([manifest, script, {name:"extension/../outside.txt",bytes:Buffer.from("x")}])));
  await rejects("Windows 设备名不允许解包", () => parseTheiaVsix(zip([manifest, script, {name:"extension/CON.txt",bytes:Buffer.from("x")}])));
  await rejects("Windows 文件名尾部空格拒绝", () => parseTheiaVsix(zip([manifest, script, {name:"extension/a.txt ",bytes:Buffer.from("x")}])));
  await rejects("Windows 大小写碰撞路径被拒绝", () => parseTheiaVsix(zip([manifest, script, {name:"extension/PACKAGE.JSON",bytes:rawManifest}])));
  await rejects("ZIP 符号链接被拒绝", () => parseTheiaVsix(zip([manifest, script, {name:"extension/link.js",bytes:Buffer.from("x"), mode:0xa000}])));
  await rejects("CRC 与压缩内容不符被拒绝", () => parseTheiaVsix(zip([manifest, { ...script, corruptCrc: true }])));
  await rejects("宣称大于单文件上限的 ZIP 被拒绝", () => parseTheiaVsix(zip([manifest, { ...script, declaredSize: 40 * 1024 * 1024 }])));
  await rejects("无执行入口的扩展被明确拒绝", () => parseTheiaVsix(zip([manifest,extra])));
  await rejects("无桌面选择源时拒绝目录替代 VSIX", () => mgr.inspect(10, path.join(work, "fake.txt")));
  const inspecting = mgr.inspect(10, vsix);
  await rejects("并发预检被拒绝，不会覆盖正在检查的 ticket", () => mgr.inspect(10, vsix));
  const inspect = await inspecting;
  check("检查阶段只返回静态能力报告与 ticket", inspect.kind === "inspection" &&
    inspect.prompt.capabilities.some(c=>c.capability === "spawnsProcesses") &&
    inspect.prompt.disclosure.includes("不是沙箱"));
  if (inspect.kind !== "inspection") throw Error("missing inspection");
  await rejects("跨窗口 ticket 不允许启动", () => mgr.start(11, inspect.ticket, true));
  await rejects("伪造随机 ticket 不允许启动", () => mgr.start(10, "db65fa29-ab20-46bb-8e9b-e267e7477aa1", true));
  const session = await mgr.start(10, inspect.ticket, true);
  check("获准之后真实 Theia 宿主启动并注册命令", session.kind === "started" && session.commands.includes("mcodeSmoke.spawnEcho"), session);
  if (session.kind !== "started") throw Error("missing start");
  await rejects("一次性 ticket 不可再次启动", () => mgr.start(10, inspect.ticket, true));
  await rejects("未注册命令不能调用", () => mgr.execute(10, session.sessionId, "mcodeSmoke.declaredOnly"));
  await rejects("另一窗口不可调用扩展命令", () => mgr.execute(11, session.sessionId, "mcodeSmoke.spawnEcho"));
  const result = await mgr.execute(10, session.sessionId, "mcodeSmoke.spawnEcho");
  check("真实扩展命令往返值返回", result.kind === "executed" && result.result.includes('"echo":"pong"'));
  const stopped = await mgr.stop(10, session.sessionId);
  check("明确停止后释放宿主", stopped.kind === "stopped");
  await rejects("停止后的命令不可再调用", () => mgr.execute(10, session.sessionId, "mcodeSmoke.spawnEcho"));
  const inspect2 = await mgr.inspect(10, vsix);
  if (inspect2.kind !== "inspection") throw Error("inspection-2 failed");
  const cancelled = await mgr.cancel(10, inspect2.ticket);
  check("拒绝权限之后清理临时 ticket", cancelled.kind === "stopped");
  await rejects("拒绝后的 ticket 不能启动", () => mgr.start(10, inspect2.ticket, true));
  const inspect3 = await mgr.inspect(10, vsix);
  if (inspect3.kind !== "inspection") throw Error("inspection-3 failed");
  await mgr.disposeSender(10);
  await rejects("窗口关闭清理已预检 ticket", () => mgr.start(10, inspect3.ticket, true));
  await rejects("已关闭窗口不能重新预检", () => mgr.inspect(10, vsix));

  // The real IPC registration, not a copied stand-in, enforces sender frame and schema.
  process.env.MCODE_THEIA_ROOT = theia;
  const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
  registerTheiaPreviewHandlers({handle: (name: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
    if (handlers.has(name)) throw Error("duplicate channel");
    handlers.set(name, fn);
  }} as never);
  const invoke = handlers.get(IPC.MODULE_THEIA_PREVIEW);
  check("正式 Theia IPC 注册器暴露且仅暴露一个预览入口", handlers.size === 1 && Boolean(invoke));
  if (!invoke) throw Error("Theia preview IPC not registered");
  const mainFrame = {};
  const webContents = Object.assign(new EventEmitter(), {id: 10, mainFrame, isDestroyed: () => false});
  const sender = {sender: webContents, senderFrame: mainFrame};
  check("产品 IPC 能核实桌面主框架身份", theiaDesktopSender(sender) === 10);
  await rejects("Agent / 无身份事件不能调用试运行", () => invoke({}, {op:"inspect",path:vsix}));
  await rejects("子框架不能调用试运行", () => invoke({sender:{id:10,mainFrame},senderFrame:{}}, {op:"inspect",path:vsix}));
  await rejects("未知入参字段拒绝", () => invoke(sender, {op:"inspect",path:vsix,accepted:true}));
  const ipcInspect = await invoke(sender, {op:"inspect",path:vsix}) as {kind:string;ticket:string};
  check("桌面用户预检经真正 IPC 跑通", ipcInspect.kind === "inspection");
  await rejects("未同意不能跨过 IPC 启动", () => invoke(sender, {op:"start",ticket:ipcInspect.ticket,accepted:false}));
  await rejects("不同窗口不能通过 IPC 使用已有 ticket", () => invoke({ ...sender, sender:{ ...sender.sender, id:11 } }, {op:"start",ticket:ipcInspect.ticket,accepted:true}));
  const ipcRun = await invoke(sender, {op:"start",ticket:ipcInspect.ticket,accepted:true}) as
    {kind:string;sessionId:string;commands:string[]};
  check("桌面 IPC 确认后启动真实宿主", ipcRun.kind === "started" && ipcRun.commands.includes("mcodeSmoke.spawnEcho"));
  const ipcReply = await invoke(sender, {op:"execute",sessionId:ipcRun.sessionId,commandId:"mcodeSmoke.spawnEcho"}) as
    {kind:string;result:string};
  check("桌面 IPC 命令调用与回值闭环", ipcReply.kind === "executed" && ipcReply.result.includes('"echo":"pong"'));
  const ipcStop = await invoke(sender, {op:"stop",sessionId:ipcRun.sessionId}) as {kind:string};
  check("桌面 IPC 停止并清理", ipcStop.kind === "stopped");
  check("真实 IPC 为窗口关闭注册清理回调", webContents.listenerCount("destroyed") === 1);
  const ipcInspect2 = await invoke(sender, {op:"inspect",path:vsix}) as {kind:string;ticket:string};
  webContents.emit("destroyed");
  let closedReason = "";
  let unexpectedSessionId: string | undefined;
  try {
    const later = await invoke(sender, {op:"start",ticket:ipcInspect2.ticket,accepted:true}) as {sessionId?:string};
    unexpectedSessionId = later.sessionId;
  } catch (error) { closedReason = String(error); }
  check("窗口销毁后凭据被撤销", closedReason.length > 0, closedReason || "IPC erroneously accepted destroyed sender");
  // Mutation/failure cleanup: a failing assertion must never strand an unsandboxed child process.
  if (unexpectedSessionId) await invoke(sender, {op:"stop",sessionId:unexpectedSessionId}).catch(() => {});
} finally {
  await mgr.disposeAll();
  rmSync(work, { recursive: true, force: true });
}
console.log("NOT-COVERED: 正式 ModuleHost 安装 / 重启恢复 / 完整 VS Code API / 运行时沙箱 / Electron U1");
console.log("theia-vsix-preview-smoke: " + pass + "/" + (pass + fail) + " 通过");
process.exitCode = fail ? 1 : 0;
