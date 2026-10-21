// T74 mutation evidence: edit ONLY the exclusive adapter, then restore its exact bytes.
// The runner checks that each removal makes the real file smoke red.
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const src = resolve("apps/desktop/src/main/document/genofficeCli.ts");
const original = readFileSync(src);
const sha = b => createHash("sha256").update(b).digest("hex");
const base = original.toString("utf8");
const mutations = [
  {
    name: "remove-create-workspace-gate",
    old: 'const refusal = requireWorkspacePath(ports, source, "创建源文件")\n    ?? requireWorkspacePath(ports, out, "创建输出路径");',
    replacement: "const refusal: string | null = null;",
    expected: "FAIL outside input refused before child",
  },
  {
    name: "remove-missing-cli-resource-check",
    old: "if (!existsSync(ports.cliPath)) {",
    replacement: "if (false && !existsSync(ports.cliPath)) {",
    expected: "FAIL missing vendor classified unavailable",
  },
];
try {
  for (const { name, old, replacement, expected } of mutations) {
    if (readFileSync(src).compare(original) !== 0) throw new Error("source changed before mutation " + name);
    if (base.split(old).length !== 2) throw new Error("mutation target not uniquely found " + name);
    writeFileSync(src, base.replace(old, replacement));
    if (sha(readFileSync(src)) === sha(original)) throw new Error("mutation did not apply");
    let result;
    try {
      const runner = "C:\\Program Files\\Git\\bin\\bash.exe";
      result = spawnSync(runner, ["apps/desktop/scripts/t74-genoffice-headless-smoke/run.sh"], { cwd: resolve("."), encoding: "utf8", timeout: 120000 });
    } finally {
      writeFileSync(src, original);
    }
    if (readFileSync(src).compare(original) !== 0) throw new Error("restoration mismatch " + name);
    if (result.status === 0 || !result.stdout.includes(expected)) {
      throw new Error("mutation was NOT caught: " + name + "\n" + result.stdout.slice(-3500) + "\n" + result.stderr.slice(-1500));
    }
    console.log("T74_MUTATION RED " + name + " SHA256_RESTORED=" + sha(original) + "\n" +
      result.stdout.split("\n").filter(l => l.includes("FAIL")).slice(0, 5).join("\n"));
  }
  console.log("T74_MUTATIONS 2/2 RED_CONFIRMED_AND_BYTE_IDENTICAL");
} finally {
  // Do not overwrite an unrelated concurrent source edit. This task owns this
  // file exclusively; the guard makes unexpected overlap a loud failure.
  const current = readFileSync(src);
  if (current.compare(original) !== 0) {
    const mutated = mutations.some(({ old, replacement }) => base.replace(old, replacement) === current.toString("utf8"));
    if (mutated) writeFileSync(src, original);
    else throw new Error("Unexpected external change to source during mutation; refusing overwrite");
  }
}
