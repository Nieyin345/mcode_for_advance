import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { VscodeL1Bridge, readMinimalVsix } from "../../src/main/modules/vscodeL1Bridge.js";

let passed = 0, failed = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + label); }
  catch (error) { failed++; console.error("FAIL " + label, error); }
}

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Real .vsix ZIP (STORE, no dependencies, just the 2 allowlisted files). */
function vsix(manifest: unknown, entry: string): Buffer {
  const entries = [
    { name: "extension/package.json", body: Buffer.from(JSON.stringify(manifest)) },
    { name: "extension/extension.js", body: Buffer.from(entry) },
  ];
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const crc = crc32(item.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(item.body.length, 18);
    local.writeUInt32LE(item.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, item.body);
    const descriptor = Buffer.alloc(46);
    descriptor.writeUInt32LE(0x02014b50, 0);
    descriptor.writeUInt16LE(20, 4);
    descriptor.writeUInt16LE(20, 6);
    descriptor.writeUInt32LE(crc, 16);
    descriptor.writeUInt32LE(item.body.length, 20);
    descriptor.writeUInt32LE(item.body.length, 24);
    descriptor.writeUInt16LE(name.length, 28);
    descriptor.writeUInt32LE(offset, 42);
    central.push(descriptor, name);
    offset += local.length + name.length + item.body.length;
  }
  const centralData = Buffer.concat(central);
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50, 0);
  ending.writeUInt16LE(2, 8);
  ending.writeUInt16LE(2, 10);
  ending.writeUInt32LE(centralData.length, 12);
  ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, ending]);
}

const manifest = {
  publisher: "acme", name: "demo", version: "1.0.0",
  displayName: "Local L1 Example", main: "./extension.js",
  engines: { vscode: "^1.95.0" },
  activationEvents: ["onCommand:acme.demo.hello"],
  contributes: { commands: [{ command: "acme.demo.hello", title: "Say Hello" }] },
};
// Keep the callback simple: the command is declared, bound, invoked and returns data.
const entry = `
exports.activate = function(context) {
  const vscode = require("vscode");
  const status = vscode.window.createStatusBarItem();
  status.text = "L1 ready";
  status.tooltip = "Local-only fixture";
  status.command = "acme.demo.hello";
  status.show();
  context.subscriptions.push(vscode.commands.registerCommand("acme.demo.hello",
    async (resource) => "hello " + resource.path.split(/[\\\\/]/).pop()));
};`;
const temp = await mkdtemp(join(tmpdir(), "mcode-vsix-l1-"));
try {
  const path = join(temp, "demo.txt");
  await writeFile(path, "fixture");
  const resource = { projectPath: temp, path };
  let authorizations = 0, persistCalls = 0;
  const host = new ModuleHost({
    authorize: async r => {
      authorizations++;
      if (r.projectPath !== temp || r.path !== path) throw Error("scope_denied");
    },
    persist: async () => { persistCalls++; },
    resolveResource: async r => r.path,
    verifyProgram: async (source, names, timeout) => {
      const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
      return verifyPermissionedProgram(source, names, timeout);
    },
  });

  await test("local fictional VSIX is a genuine two-entry ZIP archive", async () => {
    const zip = vsix(manifest, entry);
    assert.equal(readMinimalVsix(zip).source, entry);
    const corrupted = Buffer.from(zip);
    corrupted[80] ^= 1;
    assert.throws(() => readMinimalVsix(corrupted), /CRC|mismatch/);
  });

  await test("install code requires both read and executable consents (fail closed)", async () => {
    await assert.rejects(VscodeL1Bridge.install(host, vsix(manifest, entry),
      { confirmReadAccess: true, confirmExecutableCode: false }), /confirmExecutableCode|Invalid|literal/);
    assert.equal(persistCalls, 0);
    assert.equal(host.catalog().modules.some(x => x.id === "user.acme.demo"), false);
  });

  let bridge: VscodeL1Bridge;
  await test("manifest command maps to ModuleHost and installs only after child verification", async () => {
    bridge = await VscodeL1Bridge.install(host, vsix(manifest, entry),
      { confirmReadAccess: true, confirmExecutableCode: true });
    assert.equal(persistCalls, 1);
    assert.ok(host.catalog().capabilities.some(x => x.id === "module.acme.demo.run"));
    assert.equal(bridge.statusBarItem(), null, "No status bar before child activation");
  });

  await test("L1 command executes through scoped ModuleHost and returns status-bar snapshot", async () => {
    const before = authorizations;
    const result = await bridge.executeCommand("acme.demo.hello", resource, randomUUID());
    assert.equal(result.type, "result");
    if (result.type === "result") {
      assert.equal(result.value.message, "hello demo.txt");
      assert.equal(result.value.statusBarText, "L1 ready");
    }
    assert.equal(authorizations, before + 1, "Must use real ModuleHost.authorize");
    assert.deepEqual(bridge.statusBarItem(),
      { text: "L1 ready", tooltip: "Local-only fixture", command: "acme.demo.hello" });
  });

  await test("unauthorized resource is denied by host before child execution", async () => {
    const before = authorizations;
    await assert.rejects(bridge.executeCommand("acme.demo.hello",
      { projectPath: temp, path: join(temp, "forbidden.txt") }, randomUUID()), /scope_denied/);
    assert.equal(authorizations, before + 1);
    assert.equal(bridge.statusBarItem()?.text, "L1 ready", "Denied invocation must not update UI state");
  });

  await test("undeclared command cannot run or mutate ModuleHost", async () => {
    const before = authorizations;
    await assert.rejects(bridge.executeCommand("acme.demo.hidden", resource, randomUUID()), /Undeclared/);
    assert.equal(authorizations, before);
  });

  await test("invalid contributes.commands and unsupported contribution points reject before persistence", async () => {
    const before = persistCalls;
    const bad = { ...manifest, contributes: { ...manifest.contributes,
      keybindings: [{ command: "acme.demo.hello", key: "ctrl+q" }] } };
    await assert.rejects(VscodeL1Bridge.install(host, vsix(bad, entry),
      { confirmReadAccess: true, confirmExecutableCode: true }), /Unrecognized|unrecognized|strict|keybindings/);
    assert.equal(persistCalls, before);
  });

  await test("unregistered declared command fails closed inside the permissioned child", async () => {
    const otherHost = new ModuleHost({
      authorize: async () => {}, persist: async () => {},
      resolveResource: async r => r.path,
      verifyProgram: async (source, names, timeout) => {
        const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
        return verifyPermissionedProgram(source, names, timeout);
      },
    });
    const missing = await VscodeL1Bridge.install(otherHost,
      vsix(manifest, "exports.activate = () => {};"),
      { confirmReadAccess: true, confirmExecutableCode: true });
    await assert.rejects(missing.executeCommand("acme.demo.hello", resource, randomUUID()), /not registered/);
  });

  await test("child crash is isolated; host still executes a valid command afterward", async () => {
    const crashHost = new ModuleHost({
      authorize: async () => {}, persist: async () => {},
      resolveResource: async r => r.path,
      verifyProgram: async (source, names, timeout) => {
        const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
        return verifyPermissionedProgram(source, names, timeout);
      },
    });
    const crashed = await VscodeL1Bridge.install(crashHost,
      vsix(manifest, `exports.activate = (ctx) => {
        const vscode = require("vscode");
        ctx.subscriptions.push(vscode.commands.registerCommand("acme.demo.hello", async () => process.exit(37)));
      };`),
      { confirmReadAccess: true, confirmExecutableCode: true });
    await assert.rejects(crashed.executeCommand("acme.demo.hello", resource, randomUUID()),
      /异常退出|crash|exit=37/);
    assert.equal((await bridge.executeCommand("acme.demo.hello", resource, randomUUID())).type, "result");
  });

  await test("removal revokes command via the same ModuleHost capability registry", async () => {
    await host.remove("user.acme.demo");
    await assert.rejects(bridge.executeCommand("acme.demo.hello", resource, randomUUID()), /removed or replaced/);
    assert.equal(bridge.statusBarItem(), null, "Removed extension must not retain a visible status item");
    assert.equal(host.catalog().capabilities.some(x => x.id === "module.acme.demo.run"), false);
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log("vscode-l1-smoke: " + passed + "/" + (passed + failed) + " PASS");
if (failed) process.exitCode = 1;
