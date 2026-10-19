import path from "node:path";
import { normalizeNodeArtifacts } from "@main/orchestration/artifactRefs.js";
let n = 0, failed = 0;
const check = (label: string, ok: boolean, evidence?: unknown) => {
  n++;
  console.log(`${ok ? "ok" : "FAIL"} ${label}${ok || evidence === undefined ? "" : " — " + JSON.stringify(evidence)}`);
  if (!ok) failed++;
};
const cwd = path.join(path.sep, "mcode-artifact-fixture");
const normalized = normalizeNodeArtifacts([
  { kind: "file", uri: "out/log.txt", name: "Build log", sizeBytes: 123 },
  { kind: "directory", uri: "out" },
  { kind: "data", uri: "https://example.test/resource/1", mimeType: "application/json" },
], cwd);
check("valid artifacts preserve all supported kinds", normalized.length === 3);
check("relative file path resolves against workflow cwd", normalized[0]?.uri === path.resolve(cwd, "out/log.txt"), normalized[0]?.uri);
check("directory path is resolved consistently", normalized[1]?.uri === path.resolve(cwd, "out"));
check("data resource URI remains unchanged", normalized[2]?.uri === "https://example.test/resource/1");
for (const size of [-2, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
  const item = normalizeNodeArtifacts([{ kind: "file", uri: "out.bin", sizeBytes: size }], cwd);
  check(`★ invalid artifact byte size is not presented as real size: ${String(size)}`,
    item.length === 1 && item[0]?.sizeBytes === undefined, item);
}
check("zero byte size remains a valid fact",
  normalizeNodeArtifacts([{ kind: "file", uri: "empty.bin", sizeBytes: 0 }], cwd)[0]?.sizeBytes === 0);
for (const uri of ["sample\u0000.pdf", "unexpected\nsecond-file.txt", "part\rname.pdf", "file:///tmp/part\u0000secret"]) {
  const items = normalizeNodeArtifacts([{ kind: "file", uri }], cwd);
  check("★ control characters in artifact references cannot reach open-path UI", items.length === 0, items);
}
check("non-array artifact input is ignored", normalizeNodeArtifacts({ kind: "file", uri: "a" }, cwd).length === 0);
check("unsupported kind rejected", normalizeNodeArtifacts([{ kind: "javascript", uri: "alert(1)" }], cwd).length === 0);
console.log(`artifact-ref-integrity-smoke:${n - failed}/${n} PASS`);
if (failed) process.exitCode = 1;
