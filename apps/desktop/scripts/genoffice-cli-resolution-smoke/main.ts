import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveGenofficeCliPath } from "@main/document/genofficeCli.js";

const root = mkdtempSync(join(tmpdir(), "mcode-genoffice-cli-resolver-"));
let passed=0;
function check(name: string, actual: unknown, expected: unknown) {
  assert.equal(actual, expected, name); console.log("ok " + name); passed++;
}
function put(file: string, value: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}
try {
  const repo = join(root, "repo");
  const resources = join(root, "packaged-resources");
  const vendorCli = join(repo, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
  put(vendorCli, "fake local CLI");
  check("developer checkout still uses vendored source when no packaged source is supplied",
    resolveGenofficeCliPath(repo), vendorCli);
  const pkg = join(resources, "genoffice");
  put(join(pkg, "availability.json"), JSON.stringify({ format:"mcode.genoffice.resources.v1",bundled:false,editorsBundled:false,editors:[] }));
  check("opt-out packaged installation never borrows a nearby development checkout",
    resolveGenofficeCliPath(repo, resources), null);
  put(join(pkg, "cli", "genoffice.cjs"), "fake stale CLI");
  mkdirSync(join(pkg, "cli", "node_modules"), { recursive: true });
  put(join(pkg, "wasm", "pdfium.wasm"), "invalid-wasm");
  check("bundled:false marker wins even with stale CLI and adjacent dev checkout",
    resolveGenofficeCliPath(repo, resources), null);
  put(join(pkg, "availability.json"), JSON.stringify({format:"mcode.genoffice.resources.v1", bundled:true, editorsBundled:false, editors:[]}));
  check("opt-in with malformed PDFium wasm is not falsely shown as a usable tool",
    resolveGenofficeCliPath(repo, resources), null);
  writeFileSync(join(pkg, "wasm", "pdfium.wasm"), Buffer.from([0,97,115,109,1,0,0,0,21]));
  check("opt-in installed resource resolves its own CLI",
    resolveGenofficeCliPath(repo, resources), join(pkg,"cli","genoffice.cjs"));
  put(join(pkg, "availability.json"), JSON.stringify({format:"bogus-marker",bundled:true}));
  check("invalid release marker cannot activate a stale sidecar", resolveGenofficeCliPath(repo, resources), null);
  put(join(pkg, "availability.json"), JSON.stringify({format:"mcode.genoffice.resources.v1",bundled:true}));
  put(join(pkg, "availability.json"), JSON.stringify({format:"mcode.genoffice.resources.v1",bundled:true}) + " ".repeat(16000));
  check("oversized release marker is refused instead of synchronously parsed on each IPC call",
    resolveGenofficeCliPath(repo, resources), null);
  put(join(pkg, "availability.json"), JSON.stringify({format:"mcode.genoffice.resources.v1",bundled:true}));
  const cliDir = join(pkg,"cli");
  const cli = join(cliDir,"genoffice.cjs");
  const privateDir = join(root,"external-cli");
  renameSync(cliDir,privateDir);
  symlinkSync(privateDir,cliDir,process.platform==="win32"?"junction":"dir");
  check("junctioned executable ancestor outside release resources is never trusted",
    resolveGenofficeCliPath(repo, resources), null);
  rmSync(cliDir,{recursive:true,force:true});
  renameSync(privateDir,cliDir);
  rmSync(cli);
  check("incomplete packaged opt-in fails closed instead of falling back to repo",
    resolveGenofficeCliPath(repo, resources), null);
  check("explicit missing resources do not silently borrow checked-out development CLI",
    resolveGenofficeCliPath(repo, join(root,"no-install-resources")), null);
  const packagedProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  const previousResources = packagedProcess.resourcesPath;
  const previousDefaultApp = packagedProcess.defaultApp;
  try {
    packagedProcess.resourcesPath = join(root,"deleted-packaged-resources");
    packagedProcess.defaultApp = false;
    check("packaged Electron with an entirely missing resources folder never executes a nearby checkout",
      resolveGenofficeCliPath(repo), null);
    packagedProcess.defaultApp = true;
    check("unpackaged Electron developer mode can still use source checkout",
      resolveGenofficeCliPath(repo), vendorCli);
  } finally {
    if (previousResources === undefined) delete (packagedProcess as Partial<typeof packagedProcess>).resourcesPath;
    else packagedProcess.resourcesPath = previousResources;
    if (previousDefaultApp === undefined) delete (packagedProcess as Partial<typeof packagedProcess>).defaultApp;
    else packagedProcess.defaultApp = previousDefaultApp;
  }
  assert.equal(existsSync(vendorCli),true);
  assert.equal(lstatSync(vendorCli).isFile(), true);
  console.log("genoffice-cli-resolution-smoke: " + passed + "/" + passed + " PASS");
} finally { rmSync(root,{recursive:true,force:true}); }
