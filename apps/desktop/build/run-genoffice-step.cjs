"use strict";

/**
 * Run one reviewed GenOffice release gate with the release-only opt-in flags.
 *
 * Keeping these flags in the child environment (rather than POSIX
 * NAME=value command prefixes) makes the package command work under cmd.exe,
 * PowerShell, and Bash without changing the parent process environment.
 */
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const ALLOWED_GENOFFICE_STEPS = new Set([
  "verify-genoffice-upstream.cjs",
  "stage-genoffice-resources.cjs",
]);

function runGenofficeStep(scriptName, {
  args = [],
  env = process.env,
  cwd = path.resolve(__dirname, ".."),
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!ALLOWED_GENOFFICE_STEPS.has(scriptName)) {
    throw new Error("Unapproved GenOffice release step: " + String(scriptName));
  }
  if (!Array.isArray(args) || !args.every(value => typeof value === "string")) {
    throw new TypeError("GenOffice release step arguments must be strings");
  }
  const scriptPath = path.join(__dirname, scriptName);
  const childEnv = {
    ...env,
    MCODE_INCLUDE_GENOFFICE_BUNDLE: "1",
    MCODE_INCLUDE_GENOFFICE_EDITORS: "1",
  };
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error("GenOffice release step terminated by signal " + result.signal);
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try {
    const [scriptName, ...args] = process.argv.slice(2);
    process.exitCode = runGenofficeStep(scriptName, { args });
  } catch (error) {
    console.error("GenOffice release step failed closed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { runGenofficeStep, ALLOWED_GENOFFICE_STEPS };
