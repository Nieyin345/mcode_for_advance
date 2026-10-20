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


  // T14 L2: a trusted host explicitly enables narrow mappings. This is NOT
  // an arbitrary VSIX extension host; all paths use the ModuleResource already
  // authorized/approved by ModuleHost, and UI side effects go through host ports.
  const l2Manifest = {
    ...manifest, name: "l2demo", displayName: "Scoped L2 fixture",
    activationEvents: ["onCommand:acme.l2demo.hello"],
    contributes: { commands: [{ command: "acme.l2demo.hello", title: "L2 scoped" }] },
  };
  const l2Entry = `
exports.activate = (context) => {
  const v = require("vscode");
  context.subscriptions.push(v.commands.registerCommand("acme.l2demo.hello", async (resource) => {
    const mode = resource.path.split(/[\\\\/]/).pop();
    const uri = v.Uri.file(resource.path);
    if (mode === "read") return new TextDecoder().decode(await v.workspace.fs.readFile(uri));
    if (mode === "write") {
      await v.workspace.fs.writeFile(uri, new TextEncoder().encode("approved write"));
      return "written";
    }
    if (mode === "config") return v.workspace.getConfiguration("acme.l2demo").get("theme");
    if (mode === "notice") {
      await v.window.showInformationMessage("L2 notification");
      return "sent";
    }
    if (mode === "diagnostic") {
      v.languages.createDiagnosticCollection("l2").set(uri, [{ message: "diagnosed" }]);
      return "published";
    }
    if (mode === "escape-read") return await v.workspace.fs.readFile(v.Uri.file(resource.path + "-escape"));
    if (mode === "escape-write") return await v.workspace.fs.writeFile(v.Uri.file(resource.path + "-escape"), new Uint8Array([1]));
    if (mode === "escape-config") return v.workspace.getConfiguration("another.extension").get("secret");
    if (mode === "escape-notice") return await v.window.showWarningMessage("x".repeat(300));
    if (mode === "escape-diagnostic") {
      v.languages.createDiagnosticCollection("l2").set(v.Uri.file(resource.path + "-escape"), [{ message: "wrong" }]);
    }
    throw Error("Unhandled fixture operation: " + mode);
  }));
};
`;
  const l2Cases = [
    { name: "read", escape: "escape-read" },
    { name: "write", escape: "escape-write" },
    { name: "config", escape: "escape-config" },
    { name: "notice", escape: "escape-notice" },
    { name: "diagnostic", escape: "escape-diagnostic" },
  ] as const;
  const l2Files = new Map<string, string>();
  for (const { name, escape } of l2Cases) {
    for (const label of [name, escape]) {
      const path = join(temp, label);
      l2Files.set(label, path);
      await writeFile(path, name === "read" ? "L2 fixture bytes" : "initial");
    }
  }
  const uiNotices: Array<{ kind: string; text: string }> = [];
  const uiDiagnostics: Array<{ name: string; path: string; messages: string[] }> = [];
  let l2Authorizations = 0, l2Approvals = 0, approvalAllowed = true;
  const l2Host = new ModuleHost({
    authorize: async r => {
      l2Authorizations++;
      if (r.projectPath !== temp || ![...l2Files.values()].includes(r.path)) throw Error("scope_denied");
    },
    persist: async () => {},
    resolveResource: async r => r.path,
    requestApproval: async () => {
      l2Approvals++;
      if (!approvalAllowed) throw Error("approval_denied");
    },
    verifyProgram: async (source, names, timeout) => {
      const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
      return verifyPermissionedProgram(source, names, timeout);
    },
  });
  const l2Bridge = await VscodeL1Bridge.install(l2Host, vsix(l2Manifest, l2Entry),
    { confirmReadAccess: true, confirmExecutableCode: true }, {
      fileWrite: true, configuration: { theme: "dark" },
      notify: async n => { uiNotices.push(n); },
      publishDiagnostics: async d => { uiDiagnostics.push(d); },
    });
  const l2Call = (label: string, path = l2Files.get(label)!) =>
    l2Bridge.executeCommand("acme.l2demo.hello", { projectPath: temp, path }, randomUUID());

  await test("L2 five API categories dispatch via the existing ModuleHost approval + child", async () => {
    let before = l2Authorizations, approved = l2Approvals;
    for (const { name } of l2Cases) {
      const reply = await l2Call(name);
      assert.equal(reply.type, "result", name);
      assert.equal(l2Authorizations, ++before, name + " authorize");
      assert.equal(l2Approvals, ++approved, name + " approval");
      if (reply.type === "result") {
        assert.equal(reply.value.message,
          ({ read: "L2 fixture bytes", write: "written", config: "dark",
            notice: "sent", diagnostic: "published" } as const)[name], name);
      }
    }
    assert.equal(await (await import("node:fs/promises")).readFile(l2Files.get("write")!, "utf8"), "approved write");
    assert.deepEqual(uiNotices, [{ kind: "info", text: "L2 notification" }]);
    assert.deepEqual(uiDiagnostics,
      [{ name: "l2", path: l2Files.get("diagnostic"), messages: ["diagnosed"] }]);
  });

  for (const { name, escape } of l2Cases) {
    await test("L2 " + name + " rejects unauthorized ModuleResource before child execution", async () => {
      const before = l2Authorizations;
      await assert.rejects(l2Call(name, join(temp, "unapproved-" + name)), /scope_denied/);
      assert.equal(l2Authorizations, before + 1);
    });
    await test("L2 " + name + " rejects out-of-scope API input", async () => {
      const before = l2Authorizations;
      await assert.rejects(l2Call(escape), /L2 scope denied|L2 configuration namespace denied|L2 notification out of bounds/);
      assert.equal(l2Authorizations, before + 1);
    });
  }

  await test("L2 write request without a human approval fails closed (no mutation)", async () => {
    approvalAllowed = false;
    const before = await (await import("node:fs/promises")).readFile(l2Files.get("write")!, "utf8");
    await assert.rejects(l2Call("write"), /approval_denied/);
    assert.equal(await (await import("node:fs/promises")).readFile(l2Files.get("write")!, "utf8"), before);
    approvalAllowed = true;
  });

  await test("L2 no resource.write grant rejects write API, even with a read-only host", async () => {
    const readOnlyHost = new ModuleHost({
      authorize: async () => {},
      persist: async () => {},
      resolveResource: async r => r.path,
      verifyProgram: async (source, names, timeout) => {
        const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
        return verifyPermissionedProgram(source, names, timeout);
      },
    });
    const readOnlyBridge = await VscodeL1Bridge.install(readOnlyHost, vsix(l2Manifest, l2Entry),
      { confirmReadAccess: true, confirmExecutableCode: true }, { fileWrite: false });
    await assert.rejects(readOnlyBridge.executeCommand("acme.l2demo.hello",
      { projectPath: temp, path: l2Files.get("write")! }, randomUUID()), /resource.write permission required/);
  });

  await test("L2 missing notification port explicitly rejects instead of claiming UI delivery", async () => {
    const noPortHost = new ModuleHost({
      authorize: async () => {}, persist: async () => {},
      resolveResource: async r => r.path,
      verifyProgram: async (source, names, timeout) => {
        const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
        return verifyPermissionedProgram(source, names, timeout);
      },
    });
    const noPort = await VscodeL1Bridge.install(noPortHost, vsix(l2Manifest, l2Entry),
      { confirmReadAccess: true, confirmExecutableCode: true }, { configuration: { theme: "dark" } });
    await assert.rejects(noPort.executeCommand("acme.l2demo.hello",
      { projectPath: temp, path: l2Files.get("notice")! }, randomUUID()),
      /L2 notification host port unavailable/);
  });

  const editorManifest = {
    ...l2Manifest, name: "editor", activationEvents: ["onCommand:acme.editor.hello"],
    contributes: { commands: [{ command: "acme.editor.hello", title: "Editor command" }] },
  };
  const editorEntry = `
exports.activate = (context) => {
  const v = require("vscode");
  context.subscriptions.push(v.commands.registerTextEditorCommand("acme.editor.hello",
    async (editor) => {
      if (editor.document.uri.fsPath.endsWith("escape-editor"))
        return v.workspace.fs.readFile(v.Uri.file(editor.document.uri.fsPath + "-escape"));
      return editor.document.getText();
    }));
};`;
  await test("L2 editor command registration uses scoped selected document; not an editable VS Code model", async () => {
    const editor = await VscodeL1Bridge.install(l2Host, vsix(editorManifest, editorEntry),
      { confirmReadAccess: true, confirmExecutableCode: true }, { fileWrite: false });
    const result = await editor.executeCommand("acme.editor.hello",
      { projectPath: temp, path: l2Files.get("read")! }, randomUUID());
    assert.equal(result.type, "result");
    if (result.type === "result") assert.equal(result.value.message, "L2 fixture bytes");
    await assert.rejects(editor.executeCommand("acme.editor.hello",
      { projectPath: temp, path: join(temp, "unapproved-editor") }, randomUUID()), /scope_denied/);
    const escapeEditor = join(temp, "escape-editor");
    l2Files.set("escape-editor", escapeEditor);
    await writeFile(escapeEditor, "read-only editor");
    await assert.rejects(editor.executeCommand("acme.editor.hello",
      { projectPath: temp, path: escapeEditor }, randomUUID()), /L2 scope denied/);
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
