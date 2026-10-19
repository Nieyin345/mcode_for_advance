import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitBash } from "@main/lib/binaryResolve.js";

if (process.platform !== "win32") {
  console.log("git-bash-file-smoke: skipped (Git Bash resolver is Windows-specific)");
} else {
  const root = mkdtempSync(join(tmpdir(), "mcode-shell-file-fixture-"));
  const prev = {
    pf: process.env["ProgramFiles"],
    pf86: process.env["ProgramFiles(x86)"],
    local: process.env["LOCALAPPDATA"],
  };
  try {
    const invalid = join(root, "fake-pf", "Git", "bin", "bash.exe");
    const valid = join(root, "fake-pf86", "Git", "bin", "bash.exe");
    mkdirSync(invalid, { recursive: true });  // directory with executable suffix
    mkdirSync(join(root, "fake-pf86", "Git", "bin"), { recursive: true });
    writeFileSync(valid, Buffer.from("synthetic bash fixture"));
    process.env["ProgramFiles"] = join(root, "fake-pf");
    process.env["ProgramFiles(x86)"] = join(root, "fake-pf86");
    process.env["LOCALAPPDATA"] = join(root, "missing");
    assert.equal(resolveGitBash(), valid, "must skip a directory named bash.exe and find a file");
    console.log("git-bash-file-smoke: 1/1 PASS");
  } finally {
    for (const [key, value] of Object.entries({
      ProgramFiles: prev.pf,
      "ProgramFiles(x86)": prev.pf86,
      LOCALAPPDATA: prev.local,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
