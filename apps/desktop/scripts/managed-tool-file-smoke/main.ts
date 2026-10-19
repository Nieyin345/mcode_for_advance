import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedToolExecutable, managedToolBinDirs, setToolRoot } from "@main/env/managedToolRoots.js";

const root = mkdtempSync(join(tmpdir(), "mcode-managed-tool-files-"));
const exe = (n: string) => process.platform === "win32" ? n + ".exe" : n;
const put = (file: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fake executable fixture"); if (process.platform !== "win32") chmodSync(file, 0o755); };
let checks = 0;
function check(name: string, predicate: boolean) {
  assert.ok(predicate, name); checks++; console.log("ok " + name);
}
try {
  setToolRoot(root);
  const bad = join(root, "pandoc", "9.0.0", exe("pandoc"));
  mkdirSync(bad, { recursive: true });
  const good = join(root, "pandoc", "8.0.0", exe("pandoc"));
  put(good);
  check("higher-version directory named pandoc executable is not selected",
    managedToolExecutable("pandoc") === good);
  check("PATH projection includes real pandoc directory, never fake directory",
    managedToolBinDirs().includes(dirname(good)) && !managedToolBinDirs().includes(dirname(bad)));
  const fakeTex = join(root, "latex", "10.0.0", "bin", "a-linux", exe("xelatex"));
  mkdirSync(fakeTex, { recursive: true });
  const realTex = join(root, "latex", "10.0.0", "bin", "z-linux", exe("xelatex"));
  put(realTex);
  check("TinyTeX skips an executable-named directory and uses real file",
    managedToolExecutable("latex") === realTex);
  check("TinyTeX PATH directory is derived from real executable",
    managedToolBinDirs().includes(dirname(realTex)) && !managedToolBinDirs().includes(dirname(fakeTex)));
  const externalBin = join(root, "external-install", "platform");
  const externalExe = join(externalBin, exe("xelatex"));
  put(externalExe);
  const linkedVersion = join(root, "latex", "11.0.0");
  mkdirSync(linkedVersion, { recursive: true });
  symlinkSync(join(root, "external-install"), join(linkedVersion, "bin"),
    process.platform === "win32" ? "junction" : "dir");
  check("TinyTeX rejects an external junction at the bin root",
    managedToolExecutable("latex") === realTex);
  check("external linked executable never enters agent PATH",
    !managedToolBinDirs().includes(externalBin));
  // The *tool family* folder can itself be a junction. Checking each version
  // directory and bin/ is insufficient if the entire managed family points
  // at somebody else's installation.
  const otherTools = join(root, "other-tools");
  const alternateRoot = join(root, "alternate-root");
  mkdirSync(join(otherTools, "12.0.0"), { recursive: true });
  put(join(otherTools, "12.0.0", exe("pandoc")));
  mkdirSync(alternateRoot);
  symlinkSync(otherTools, join(alternateRoot, "pandoc"),
    process.platform === "win32" ? "junction" : "dir");
  setToolRoot(alternateRoot);
  check("linked managed pandoc family directory cannot supply an executable",
    managedToolExecutable("pandoc") === null);
  check("linked tool family cannot inject an external directory into PATH",
    managedToolBinDirs().length === 0);
  setToolRoot(root);
  console.log("managed-tool-file-smoke: " + checks + "/" + checks + " PASS");
} finally {
  setToolRoot("");
  rmSync(root, { recursive: true, force: true });
}
