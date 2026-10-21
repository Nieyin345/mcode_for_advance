"use strict";
/**
 * T19: reproducible Node-RED 5.0.8 vendor release payload.
 * Isolated clone (gitignored) is the source of truth, never a host-side npm install.
 * This stages the original built editor, upstream Node-RED packages and a clean
 * production-only npm dependency tree outside ASAR. No user data is accessed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const BASE_COMMIT = "935b8d3e12ec8be064f3a72ac6547131f778a7b1";
const VERSION = "5.0.8";
const URL = "https://github.com/node-red/node-red.git";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) {
    throw new Error("Node-RED staging command failed: " + command + " " + args.join(" ") + ": " + (result.error?.message || result.status));
  }
}
function gitOutput(vendor, ...args) {
  const result = spawnSync("git", ["-C", vendor, ...args], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("Node-RED checkout inspection failed: " + result.stderr);
  return result.stdout.trim();
}
function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function assertFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error("Node-RED release file missing/empty: " + file);
  }
}
function assertSafeTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Node-RED release dependency symlink denied: " + path.join(root, entry.name));
    if (entry.isDirectory()) assertSafeTree(path.join(root, entry.name));
    else if (!entry.isFile()) throw new Error("Node-RED unsupported release file type: " + entry.name);
  }
}
function prepareNodeRedResources({ appDir, repoRoot, install = true } = {}) {
  const app = path.resolve(appDir);
  const vendor = path.join(path.resolve(repoRoot), "node-red");
  const destination = path.join(app, ".tmp", "node-red-release");
  if (!fs.existsSync(vendor)) {
    if (!install) throw new Error("Node-RED vendor checkout missing: " + vendor);
    run("git", ["clone", "--depth", "1", "--branch", VERSION, URL, vendor], path.resolve(repoRoot));
    run("git", ["-C", vendor, "checkout", "-b", "mcode/integration", BASE_COMMIT], path.resolve(repoRoot));
  }
  const commit = gitOutput(vendor, "rev-parse", "HEAD");
  if (commit !== BASE_COMMIT) throw new Error("Node-RED vendor commit mismatch: " + commit);
  if (gitOutput(vendor, "status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("Node-RED vendor tracked files are modified; refusing release");
  }
  const packages = path.join(vendor, "packages", "node_modules");
  const pkg = path.join(packages, "node-red", "package.json");
  const editor = path.join(packages, "@node-red", "editor-client", "public", "red", "red.min.js");
  const rootLicense = path.join(vendor, "LICENSE");
  const rootLock = path.join(vendor, "package-lock.json");
  for (const file of [pkg, rootLicense, rootLock]) assertFile(file);
  const meta = JSON.parse(fs.readFileSync(pkg, "utf8"));
  if (meta.name !== "node-red" || meta.version !== VERSION) throw new Error("Node-RED source version mismatch");
  if (install) {
    run("npm", ["ci", "--no-audit", "--no-fund"], vendor);
    run("npm", ["run", "build"], vendor);
  }
  assertFile(editor);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(destination), ".node-red-stage-"));
  const backup = destination + ".old-" + randomUUID();
  let previous = false;
  try {
    // Production-only dependency installation in scratch (never prune vendor).
    fs.mkdirSync(path.join(tmp, "_npm"), { recursive: true });
    fs.copyFileSync(path.join(vendor, "package.json"), path.join(tmp, "_npm", "package.json"));
    fs.copyFileSync(rootLock, path.join(tmp, "_npm", "package-lock.json"));
    if (install) run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(tmp, "_npm"));
    else throw new Error("Node-RED release production dependencies require npm ci");
    const production = path.join(tmp, "_npm", "node_modules");
    assertFile(path.join(production, "express", "package.json"));
    // npm may create .bin links: those are not needed to require production packages.
    fs.cpSync(production, path.join(tmp, "node_modules"), {
      recursive: true, filter: (source) => path.basename(source) !== ".bin", dereference: false,
    });
    fs.rmSync(path.join(tmp, "_npm"), { recursive: true, force: true });
    fs.cpSync(packages, path.join(tmp, "packages", "node_modules"), { recursive: true, dereference: false });
    fs.copyFileSync(rootLicense, path.join(tmp, "LICENSE"));
    fs.copyFileSync(rootLock, path.join(tmp, "package-lock.json"));
    assertSafeTree(path.join(tmp, "packages"));
    assertSafeTree(path.join(tmp, "node_modules"));
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
      format: "mcode.node-red.release.v1", version: VERSION, sourceCommit: BASE_COMMIT,
      editorSha256: hashFile(path.join(tmp, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js")),
      packageSha256: hashFile(path.join(tmp, "packages", "node_modules", "node-red", "package.json")),
      lockSha256: hashFile(path.join(tmp, "package-lock.json")),
    }, null, 2) + "\n");
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); previous = true; }
    try { fs.renameSync(tmp, destination); }
    catch (error) { if (previous) fs.renameSync(backup, destination); throw error; }
    if (previous) fs.rmSync(backup, { recursive: true, force: true });
    return destination;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    console.log("Staged Node-RED vendor:", prepareNodeRedResources({
      appDir: path.resolve(__dirname, ".."), repoRoot: path.resolve(__dirname, "../../.."),
    }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
module.exports = { prepareNodeRedResources, hashFile, BASE_COMMIT, VERSION };
