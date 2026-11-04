"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { runGenofficeStep } = require("./run-genoffice-step.cjs");

test("GenOffice release flags are passed to an allowlisted child process", () => {
  const originalEnv = { KEEP_ME: "yes", MCODE_INCLUDE_GENOFFICE_BUNDLE: "0" };
  let invocation;
  const status = runGenofficeStep("verify-genoffice-upstream.cjs", {
    args: ["--fixture"],
    cwd: "C:\\mcode-fixture",
    env: originalEnv,
    spawnSync(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, signal: null };
    },
  });

  assert.equal(status, 0);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    path.join(__dirname, "verify-genoffice-upstream.cjs"), "--fixture",
  ]);
  assert.equal(invocation.options.cwd, "C:\\mcode-fixture");
  assert.equal(invocation.options.env.KEEP_ME, "yes");
  assert.equal(invocation.options.env.MCODE_INCLUDE_GENOFFICE_BUNDLE, "1");
  assert.equal(invocation.options.env.MCODE_INCLUDE_GENOFFICE_EDITORS, "1");
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(originalEnv.MCODE_INCLUDE_GENOFFICE_BUNDLE, "0", "parent environment must remain unchanged");
});

test("GenOffice release wrapper propagates child failure", () => {
  assert.equal(runGenofficeStep("stage-genoffice-resources.cjs", {
    spawnSync() { return { status: 17, signal: null }; },
  }), 17);
});

test("GenOffice release wrapper fails closed on spawn errors and signals", () => {
  assert.throws(() => runGenofficeStep("verify-genoffice-upstream.cjs", {
    spawnSync() { return { error: new Error("spawn denied") }; },
  }), /spawn denied/);
  assert.throws(() => runGenofficeStep("verify-genoffice-upstream.cjs", {
    spawnSync() { return { status: null, signal: "SIGTERM" }; },
  }), /SIGTERM/);
});

test("GenOffice release wrapper rejects arbitrary script paths", () => {
  assert.throws(() => runGenofficeStep("../../other.cjs"), /Unapproved GenOffice release step/);
});

test("desktop package script invokes both GenOffice gates through the cross-platform wrapper", () => {
  const pkg = require("../package.json");
  const script = pkg.scripts.package;
  assert.ok(script.includes("node build/run-genoffice-step.cjs verify-genoffice-upstream.cjs"));
  assert.ok(script.includes("node build/run-genoffice-step.cjs stage-genoffice-resources.cjs"));
  assert.doesNotMatch(script, /MCODE_INCLUDE_GENOFFICE_(?:BUNDLE|EDITORS)=1/);
});
