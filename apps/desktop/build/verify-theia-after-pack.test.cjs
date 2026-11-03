"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildProbeScript } = require("./verify-theia-after-pack.cjs");

function makeTheiaRoot(t, pluginHostSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-theia-probe-"));
  const entry = path.join(root, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, pluginHostSource, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Theia probe success sentinel bypasses RPC-backed console overrides", t => {
  const root = makeTheiaRoot(t, "");
  // Keep cleanup local to this test while exercising the exact generated probe.
  const entry = path.join(root, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
  fs.writeFileSync(entry, [
    'console.log = console.info = console.warn = console.error = () => {};',
    'process.stdout.write("PLUGIN_HOST_STARTED\\n");',
  ].join("\n"), "utf8");

  try {
    const output = execFileSync(process.execPath, ["-e", buildProbeScript(root)], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    });
    assert.match(output, /PLUGIN_HOST_STARTED/);
    assert.match(output, /PROBE_OK/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Theia probe still fails closed for an unexpected runtime import error", t => {
  const root = makeTheiaRoot(t, 'require("mcode-intentionally-missing-probe-dependency");');
  assert.throws(
    () => execFileSync(process.execPath, ["-e", buildProbeScript(root)], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }),
    error => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /PROBE_FAIL Cannot find module/);
      return true;
    },
  );
});

test("Theia probe accepts the known standalone IPC descriptor boundary", t => {
  const root = makeTheiaRoot(t, 'throw new Error("Unsupported fd type");');
  const output = execFileSync(process.execPath, ["-e", buildProbeScript(root)], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5000,
  });
  assert.match(output, /PROBE_OK/);
});
