/**
 * ARC-006 VS Code L1 experiment (NOT a general VS Code extension host).
 * Only a local, stored, two-file VSIX is accepted. All untrusted JS is
 * delegated to ModuleHost's existing permissioned child process.
 * No renderer, filesystem installer, module loader or marketplace is added.
 */
import { z } from "zod";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { type ModuleResource, type ModuleReply } from "@contracts/modules";
import { ModuleHost } from "./ModuleHost.js";

const COMMAND_ID = /^[a-zA-Z][a-zA-Z0-9.-]{2,99}$/;
const packageSchema = z.object({
  publisher: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().min(1).max(120).optional(),
  main: z.literal("./extension.js"),
  engines: z.object({ vscode: z.string().min(1).max(40) }).strict(),
  activationEvents: z.array(z.string()).max(1).optional(),
  contributes: z.object({
    commands: z.tuple([z.object({
      command: z.string().regex(COMMAND_ID),
      title: z.string().min(1).max(120),
    }).strict()]),
  }).strict(),
}).strict();

export type VscodeStatusBarSnapshot = { text: string; tooltip: string; command: string | null };

/**
 * Opt-in, single-resource L2 adapter ports. The actual Settings/Toast/diagnostics
 * services are owned by the trusted caller, NOT the VSIX process or this bridge.
 * Absent ports fail closed when an extension attempts to publish the corresponding DTO.
 * This is deliberately not a general VS Code API implementation.
 */
export interface VscodeL2Ports {
  /** Non-secret, per-extension SettingRepo projection, taken by a trusted host. */
  configuration?: Record<string, string | number | boolean>;
  /** Requests ModuleHost's existing resource.write/action approval on EVERY invocation. */
  fileWrite?: boolean;
  notify?: (message: { kind: "info" | "warning"; text: string }) => Promise<void>;
  publishDiagnostics?: (snapshot: { name: string; path: string; messages: string[] }) => Promise<void>;
}

const l2ConfigSchema = z.record(z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
  .refine(value => Object.keys(value).length <= 32, "Too many extension configuration keys");

const l2NotificationsSchema = z.array(z.object({
  kind: z.enum(["info", "warning"]), text: z.string().min(1).max(256),
}).strict()).max(4);
const l2DiagnosticsSchema = z.array(z.object({
  name: z.string().min(1).max(80), path: z.string().min(1).max(4096),
  messages: z.array(z.string().min(1).max(256)).max(8),
}).strict()).max(4);

/** Only ZIP STORE with exact offsets and CRC32; no traversal, symlinks, decompression or other entries. */
export function readMinimalVsix(archive: Uint8Array): { packageJson: unknown; source: string } {
  if (archive.length < 100 || archive.length > 128 * 1024) throw Error("VSIX size out of L1 bounds");
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (n: number): number => view.getUint16(n, true);
  const u32 = (n: number): number => view.getUint32(n, true);
  const within = (start: number, length: number): boolean =>
    Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= bytes.length;
  // Local fixture ZIPs have no trailing comment. Other ZIP variants are explicitly unsupported.
  const end = bytes.length - 22;
  if (u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0 ||
      u16(end + 8) !== 2 || u16(end + 10) !== 2 || u16(end + 20) !== 0) {
    throw Error("VSIX requires exactly two plain ZIP entries");
  }
  const centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (!within(centralStart, centralSize) || centralStart + centralSize !== end) throw Error("Invalid VSIX central directory");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map<string, Uint8Array>();
  let pos = centralStart;
  for (let index = 0; index < 2; index++) {
    if (!within(pos, 46) || u32(pos) !== 0x02014b50) throw Error("Invalid VSIX central entry");
    const flags = u16(pos + 8), method = u16(pos + 10), crc = u32(pos + 16);
    const size = u32(pos + 20), unpacked = u32(pos + 24);
    const nameLength = u16(pos + 28), extra = u16(pos + 30), comment = u16(pos + 32);
    const local = u32(pos + 42);
    if (flags !== 0 || method !== 0 || size !== unpacked || u16(pos + 34) !== 0 ||
        u32(pos + 38) !== 0 || !within(pos + 46, nameLength + extra + comment)) {
      throw Error("Unsupported VSIX ZIP entry");
    }
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    if (name !== "extension/package.json" && name !== "extension/extension.js") {
      throw Error("L1 VSIX entry not allowlisted: " + name);
    }
    if (entries.has(name)) throw Error("Duplicate VSIX entry");
    if (!within(local, 30) || u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags || u16(local + 8) !== method ||
        u32(local + 14) !== crc || u32(local + 18) !== size || u32(local + 22) !== size) {
      throw Error("VSIX local header mismatch");
    }
    const localNameSize = u16(local + 26), localExtra = u16(local + 28);
    const dataStart = local + 30 + localNameSize + localExtra;
    if (!within(local + 30, localNameSize + localExtra) ||
        decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name ||
        !within(dataStart, size) || dataStart + size > centralStart) {
      throw Error("Invalid VSIX local data extent");
    }
    const data = bytes.subarray(dataStart, dataStart + size);
    let computed = 0xffffffff;
    for (const value of data) {
      computed ^= value;
      for (let bit = 0; bit < 8; bit++) computed = (computed >>> 1) ^ ((computed & 1) ? 0xedb88320 : 0);
    }
    if (((computed ^ 0xffffffff) >>> 0) !== crc) throw Error("VSIX CRC mismatch");
    entries.set(name, data);
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== end) throw Error("Extra VSIX directory data");
  const manifest = entries.get("extension/package.json");
  const main = entries.get("extension/extension.js");
  if (!manifest || !main || manifest.byteLength > 4096 || main.byteLength > 24 * 1024) {
    throw Error("Missing or oversized VSIX manifest/entry");
  }
  return { packageJson: JSON.parse(decoder.decode(manifest)) as unknown, source: decoder.decode(main) };
}

/**
 * A scoped, ephemeral `require("vscode")` shim inside the existing child process.
 * Activation and command registration repeat for each invocation. Status-bar data
 * is a returned snapshot, NOT a live widget; only commands declared in contributes
 * are eligible. Unsupported vscode API access throws rather than silently no-ops.
 */
/**
 * L2 is a small opt-in API-to-ModuleResource adapter, not a VS Code extension
 * runtime. File operations are bound to the ONE already-authorized resource;
 * the real Node permissioned child is still ModuleHost's sole executor.
 * Editor edit transactions and long-lived diagnostics are NOT emulated.
 */
function childL2Snippet(command: string, section: string, configuration: Record<string, string | number | boolean>, fileWrite: boolean): string {
  return `
      const l2Notifications = [], l2Diagnostics = [];
      const l2Fs = require("node:fs");
      const l2Uri = Object.freeze({
        file: (fsPath) => {
          if (typeof fsPath !== "string" || fsPath.length > 4096) throw Error("L2 invalid file URI");
          return Object.freeze({ scheme: "file", fsPath });
        }
      });
      const l2Path = (uri) => {
        if (!uri || uri.scheme !== "file" || uri.fsPath !== resource.path)
          throw Error("L2 scope denied: URI differs from authorized resource");
        return resource.path;
      };
      const l2Notify = (kind, text) => {
        if (typeof text !== "string" || !text.trim() || text.length > 256 || l2Notifications.length >= 4)
          throw Error("L2 notification out of bounds");
        l2Notifications.push({ kind, text });
        return Promise.resolve(undefined);
      };
      const l2Configuration = Object.freeze(${JSON.stringify(configuration)});
      const l2 = Object.freeze({
        Uri: l2Uri,
        workspace: Object.freeze({
          fs: Object.freeze({
            readFile: async (uri) => {
              const bytes = l2Fs.readFileSync(l2Path(uri));
              if (bytes.byteLength > 1024 * 1024) throw Error("L2 read exceeds 1 MiB");
              return new Uint8Array(bytes);
            },
            writeFile: async (uri, bytes) => {
              if (!${JSON.stringify(fileWrite)}) throw Error("L2 resource.write permission required");
              const path = l2Path(uri);
              if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024)
                throw Error("L2 write requires Uint8Array <= 1 MiB");
              l2Fs.writeFileSync(path, bytes);
            }
          }),
          getConfiguration: (requested) => {
            if (requested !== undefined && requested !== ${JSON.stringify(section)})
              throw Error("L2 configuration namespace denied");
            return Object.freeze({
              get: (key, defaultValue) => {
                if (typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(key))
                  throw Error("L2 configuration key invalid");
                return Object.prototype.hasOwnProperty.call(l2Configuration, key)
                  ? l2Configuration[key] : defaultValue;
              },
              has: (key) => Object.prototype.hasOwnProperty.call(l2Configuration, key)
            });
          }
        }),
        window: Object.freeze({
          showInformationMessage: (text) => l2Notify("info", text),
          showWarningMessage: (text) => l2Notify("warning", text)
        }),
        commands: Object.freeze({
          registerTextEditorCommand: (id, callback) => {
            if (id !== ${JSON.stringify(command)} || typeof callback !== "function" || handlers.has(id))
              throw Error("L2 editor command undeclared or duplicate");
            handlers.set(id, async (selected) => callback(Object.freeze({
              document: Object.freeze({
                uri: l2Uri.file(selected.path),
                getText: () => l2Fs.readFileSync(selected.path, "utf8")
              }),
              edit: () => { throw Error("L2 editor edit transactions unsupported"); }
            })));
            return { dispose() { handlers.delete(id); } };
          }
        }),
        languages: Object.freeze({
          createDiagnosticCollection: (name) => {
            if (typeof name !== "string" || !name.trim() || name.length > 80)
              throw Error("L2 invalid diagnostic collection name");
            if (l2Diagnostics.length >= 4) throw Error("L2 too many diagnostic collections");
            const record = { name, path: resource.path, messages: [] };
            l2Diagnostics.push(record);
            return Object.freeze({
              set: (uri, entries) => {
                l2Path(uri);
                if (!Array.isArray(entries) || entries.length > 8 ||
                    entries.some(x => !x || typeof x.message !== "string" || !x.message.trim() || x.message.length > 256))
                  throw Error("L2 diagnostics out of bounds");
                record.messages = entries.map(x => x.message);
              },
              clear: () => { record.messages = []; },
              dispose: () => { record.messages = []; }
            });
          }
        })
      });
  `;
}

function childProgram(entry: string, command: string, l2?: { section: string; configuration: Record<string, string | number | boolean>; fileWrite: boolean }): string {
  return `({
    run: async (resource) => {
      const handlers = new Map();
      const statusBars = [];
      const disposables = [];
      ${l2 ? childL2Snippet(command, l2.section, l2.configuration, l2.fileWrite) : "const l2 = null;"}
      const vscode = Object.freeze({
        ...(l2 ? { Uri: l2.Uri, workspace: l2.workspace, languages: l2.languages } : {}),
        commands: Object.freeze({
          ...(l2 ? l2.commands : {}),
          registerCommand: (id, handler) => {
            if (id !== ${JSON.stringify(command)} || typeof handler !== "function" || handlers.has(id)) {
              throw Error("Undeclared or duplicate VS Code command");
            }
            handlers.set(id, handler);
            return { dispose() { handlers.delete(id); } };
          }
        }),
        window: Object.freeze({
          ...(l2 ? l2.window : {}),
          createStatusBarItem: () => {
            if (statusBars.length) throw Error("L1 permits one status bar item");
            const item = { text: "", tooltip: "", command: undefined, visible: false,
              show() { this.visible = true; },
              hide() { this.visible = false; },
              dispose() { this.visible = false; }
            };
            statusBars.push(item);
            return item;
          }
        })
      });
      const loaded = { exports: {} };
      const requireCompat = (id) => {
        if (id === "vscode") return vscode;
        throw Error("Unsupported VS Code extension import: " + String(id));
      };
      const source = ${JSON.stringify(entry)};
      (new Function("module", "exports", "require", source))(loaded, loaded.exports, requireCompat);
      if (typeof loaded.exports.activate !== "function") throw Error("VS Code extension activate() missing");
      await loaded.exports.activate({ subscriptions: disposables });
      const handler = handlers.get(${JSON.stringify(command)});
      if (!handler) throw Error("Declared VS Code command not registered");
      // Only an already-authorized resource is passed; no untrusted command args.
      const value = await handler(resource);
      const bar = statusBars.find(x => x.visible);
      return {
        message: typeof value === "string" ? value.slice(0, 4096) : JSON.stringify(value ?? null).slice(0, 4096),
        statusBarText: bar ? String(bar.text).slice(0, 4096) : "",
        statusBarTooltip: bar ? String(bar.tooltip).slice(0, 4096) : "",
        statusBarCommand: bar && bar.command === ${JSON.stringify(command)} ? bar.command : "",
        ...(l2 ? {
          l2Notifications: JSON.stringify(l2Notifications),
          l2Diagnostics: JSON.stringify(l2Diagnostics)
        } : {})
      };
    }
  })`;
}

export class VscodeL1Bridge {
  private bar: VscodeStatusBarSnapshot | null = null;
  private constructor(
    private readonly host: ModuleHost,
    readonly moduleId: string,
    readonly commandId: string,
    private readonly installedManifest: string,
    private readonly l2?: VscodeL2Ports,
  ) {}

  /** Trusted host entry only. Explicit install consent is required; never expose directly to an agent/renderer. */
  static async install(host: ModuleHost, archive: Uint8Array, consent: { confirmReadAccess: boolean; confirmExecutableCode: boolean }, l2?: VscodeL2Ports): Promise<VscodeL1Bridge> {
    const { packageJson, source } = readMinimalVsix(archive);
    const pkg = packageSchema.parse(packageJson);
    const commandId = pkg.contributes.commands[0].command;
    const prefix = pkg.publisher + "." + pkg.name + ".";
    if (!commandId.startsWith(prefix)) throw Error("VSIX command must use its publisher/name prefix");
    if (pkg.activationEvents && (pkg.activationEvents.length !== 1 ||
        pkg.activationEvents[0] !== "onCommand:" + commandId)) {
      throw Error("Only the declared onCommand activation is supported");
    }
    if (source.length > 24 * 1024) throw Error("VSIX entry exceeds the L1 source limit");
    const moduleId = "user." + pkg.publisher + "." + pkg.name;
    const title = pkg.displayName ?? pkg.name;
    const configuration = l2ConfigSchema.parse(l2?.configuration ?? {});
    const manifest = {
      apiVersion: 1, id: moduleId, version: pkg.version,
      title: { zh: title, en: title },
      permissions: l2?.fileWrite ? ["resource.read", "resource.write"] : ["resource.read"],
      contributions: [{
        id: "run", slot: "files.context", capability: "module.run",
        title: { zh: pkg.contributes.commands[0].title, en: pkg.contributes.commands[0].title },
        view: { title: { zh: title, en: title }, fields: [
          { key: "message", title: { zh: "结果", en: "Result" } },
          { key: "statusBarText", title: { zh: "状态", en: "Status" } },
        ] },
      }],
      program: { source: childProgram(source, commandId, l2 ? {
        section: pkg.publisher + "." + pkg.name, configuration, fileWrite: l2.fileWrite === true,
      } : undefined), timeoutMs: 10_000 },
    };
    const checked = ModuleInstallSchema.parse({ manifest, ...consent });
    await host.install(checked.manifest);
    return new VscodeL1Bridge(host, moduleId, commandId, JSON.stringify(checked.manifest), l2);
  }

  /** Prevent a stale adapter from targeting a replaced same-ID extension. */
  private isCurrent(): boolean {
    const installed = this.host.catalog().modules.find(module => module.id === this.moduleId);
    return installed !== undefined && JSON.stringify(installed) === this.installedManifest;
  }

  /** One real ModuleHost invoke (authorization, cancellation and child process); no side-channel execution. */
  async executeCommand(commandId: string, resource: ModuleResource, requestId: string): Promise<ModuleReply> {
    if (commandId !== this.commandId) throw Error("Undeclared VS Code command");
    if (!this.isCurrent()) throw Error("VSIX module removed or replaced; adapter must be reloaded");
    const reply = await this.host.invoke({ moduleId: this.moduleId, contributionId: "run", resource, requestId });
    if (reply.type === "result") {
      if (this.l2) {
        const notifications = l2NotificationsSchema.parse(JSON.parse(String(reply.value.l2Notifications)));
        const diagnostics = l2DiagnosticsSchema.parse(JSON.parse(String(reply.value.l2Diagnostics)));
        for (const notice of notifications) {
          if (!this.l2.notify) throw Error("L2 notification host port unavailable");
          await this.l2.notify(notice);
        }
        for (const diagnostic of diagnostics) {
          if (diagnostic.path !== resource.path) throw Error("L2 diagnostic scope denied");
          if (!this.l2.publishDiagnostics) throw Error("L2 diagnostics host port unavailable");
          await this.l2.publishDiagnostics(diagnostic);
        }
      }
      const text = reply.value.statusBarText;
      const tooltip = reply.value.statusBarTooltip;
      const command = reply.value.statusBarCommand;
      this.bar = typeof text === "string" && text.length > 0
        ? { text, tooltip: typeof tooltip === "string" ? tooltip : "", command: command === this.commandId ? command : null }
        : null;
    }
    return reply;
  }

  /** Host-only DTO (no renderer mapping within this scoped prototype). */
  statusBarItem(): VscodeStatusBarSnapshot | null {
    return this.isCurrent() && this.bar ? { ...this.bar } : null;
  }
}
