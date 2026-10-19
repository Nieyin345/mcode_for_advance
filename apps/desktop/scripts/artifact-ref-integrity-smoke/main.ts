import path from "node:path";
import { pathToFileURL } from "node:url";
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
const localEncoded = path.resolve(cwd, "space # and ?.txt");
const localEncodedUrl = pathToFileURL(localEncoded).href;
const normalizedFileUrl = normalizeNodeArtifacts([{ kind: "file", uri: localEncodedUrl }], cwd);
check("★ 标准 file URL 的 %20/%23/%3F 应还原为本地路径以供 UI 打开",
  normalizedFileUrl[0]?.uri === localEncoded, normalizedFileUrl);
const winUrl = "file:///C:/My%20Docs/notes%23draft.txt";
if (process.platform === "win32") {
  const converted = normalizeNodeArtifacts([{ kind: "file", uri: winUrl }], cwd);
  check("★ Windows file:///C:/ 必须还原为 drive 字母开头而非 /C:/",
    converted[0]?.uri === "C:\\My Docs\\notes#draft.txt", converted);
}
for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox(1)"]) {
  const items = normalizeNodeArtifacts([{ kind: "file", uri: bad }, { kind: "directory", uri: bad }], cwd);
  check("★ 脚本/内联伪 scheme 不得作为可打开的文件/目录引用",items.length===0,{bad,items});
}
check("★ 远程 SMB file://hostname 不得偷渡成宿主 Native open-path",
  normalizeNodeArtifacts([{kind:"file",uri:"file://evil.example/share/file.txt"}],cwd).length===0);
check("data-kind 的合法 HTTPS 资源引用保持不变",
  normalizeNodeArtifacts([{kind:"data",uri:"https://example.test/remote"}],cwd)[0]?.uri==="https://example.test/remote");
check("non-array artifact input is ignored", normalizeNodeArtifacts({ kind: "file", uri: "a" }, cwd).length === 0);
check("unsupported kind rejected", normalizeNodeArtifacts([{ kind: "javascript", uri: "alert(1)" }], cwd).length === 0);
console.log(`artifact-ref-integrity-smoke:${n - failed}/${n} PASS`);
if (failed) process.exitCode = 1;
