#!/usr/bin/env node
/**
 * 生成 `src/main/appControl/apiCatalog.generated.ts` —— 给 agent 看的「Mcode 功能清单」。
 *
 * 数据来源:
 *   - `packages/contracts/src/ipc/rpcMap.ts` 的 `RpcMap`:方法名、JSDoc、入参/返回类型;
 *   - `src/preload/index.ts`:方法名 → `IPC.X` 常量(由此得到真正的通道字符串)。
 *
 * 用 TypeScript 编译器 API 展开入参的**第一层**字段(名字 + 类型 + 字段注释首句),
 * 模型照着就能拼出合法的 input;更深的结构靠 handler 的 zod 报错兜底。
 *
 * 用法(在 apps/desktop 下):node scripts/gen-app-api-catalog.mjs
 * 改了 RpcMap / preload 之后重跑一次;`app-control-smoke` 会核对清单没有漏项。
 */
import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const contractsDir = resolve(appDir, "../../packages/contracts/src");
const rpcMapFile = join(contractsDir, "ipc/rpcMap.ts");
const preloadFile = join(appDir, "src/preload/index.ts");
const outFile = join(appDir, "src/main/appControl/apiCatalog.generated.ts");

const LIMIT_DOC = 260;
const LIMIT_FIELD_DOC = 90;
const LIMIT_INPUT = 900;
const LIMIT_OUTPUT = 260;

/* ── 通道字符串:IPC 对象里的 KEY: "literal" / KEY: SOME_CHANNEL,外加 *_CHANNEL 常量 ── */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const channelConsts = new Map();
const ipcKeys = new Map();
for (const file of walk(contractsDir)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]*_CHANNEL)\s*=\s*"([^"]+)"/g)) channelConsts.set(m[1], m[2]);
}
const rpcSrc = readFileSync(rpcMapFile, "utf8");
for (const m of rpcSrc.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*"([^"]+)",?\s*$/gm)) ipcKeys.set(m[1], m[2]);
for (const m of rpcSrc.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*([A-Z][A-Z0-9_]*_CHANNEL),?\s*$/gm)) {
  const v = channelConsts.get(m[2]);
  if (v) ipcKeys.set(m[1], v);
}
for (const m of rpcSrc.matchAll(/^\s+\[?([A-Z][A-Z0-9_]*_CHANNEL)\]?,?\s*$/gm)) {
  // shorthand `MEMORY_LIST_CHANNEL,` style entries (rare) — key = name without suffix
  const v = channelConsts.get(m[1]);
  if (v) ipcKeys.set(m[1].replace(/_CHANNEL$/, ""), v);
}

/* ── preload:方法名 → 通道 ── */
const preloadSrc = readFileSync(preloadFile, "utf8").replace(/\r/g, "");
const methodChannel = new Map();
for (const m of preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*(IPC\.[A-Z0-9_]+|[A-Z0-9_]+_CHANNEL)[\s\S]*?as\s*RpcMap\["([^"]+)"\]/g)) {
  const ref = m[1];
  const method = m[2];
  if (methodChannel.has(method)) continue;
  const ch = ref.startsWith("IPC.") ? ipcKeys.get(ref.slice(4)) : channelConsts.get(ref);
  if (ch) methodChannel.set(method, ch);
}

/* ── RpcMap 类型展开 ── */
const program = ts.createProgram([rpcMapFile], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();
const sf = program.getSourceFile(rpcMapFile);
let rpcIface = null;
ts.forEachChild(sf, (n) => {
  if (ts.isInterfaceDeclaration(n) && n.name.text === "RpcMap") rpcIface = n;
});
if (!rpcIface) throw new Error("RpcMap interface not found");

const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;
const clip = (s, n) => {
  // 类型里的 `import("D:/…/contracts/src/x").Foo` 只剩 `Foo` —— 绝对路径既没用又会泄漏构建机目录。
  const t = s.replace(/import\("[^"]+"\)\./g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstSentence = (s) => {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.+?[。.!?！？])(\s|$)/.exec(t);
  return m ? m[1] : t;
};
const docOf = (sym) => ts.displayPartsToString(sym.getDocumentationComment(checker));

function describeInput(type, node) {
  if (!type) return "(无参数)";
  const props = checker.getPropertiesOfType(type);
  const isObjectLike = (type.flags & ts.TypeFlags.Object) !== 0 || type.isIntersection();
  if (!isObjectLike || props.length === 0) return checker.typeToString(type, node, flags);
  const lines = props.map((p) => {
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    const pt = checker.getTypeOfSymbolAtLocation(p, decl ?? node);
    const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
    const d = clip(firstSentence(docOf(p)), LIMIT_FIELD_DOC);
    return `${p.name}${optional ? "?" : ""}: ${clip(checker.typeToString(pt, node, flags), 160)}${d ? ` // ${d}` : ""}`;
  });
  return `{ ${lines.join("; ")} }`;
}

const entries = [];
for (const member of rpcIface.members) {
  if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
  const method = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(sf);
  const sym = checker.getSymbolAtLocation(member.name);
  const doc = sym ? clip(docOf(sym), LIMIT_DOC) : "";
  const fnType = checker.getTypeFromTypeNode(member.type);
  const sig = fnType.getCallSignatures()[0];
  let input = "(无参数)";
  let output = "void";
  if (sig) {
    const param = sig.getParameters()[0];
    if (param) input = describeInput(checker.getTypeOfSymbolAtLocation(param, member), member);
    let ret = sig.getReturnType();
    const awaited = checker.getAwaitedType?.(ret);
    if (awaited) ret = awaited;
    output = checker.typeToString(ret, member, flags);
  }
  const channel = methodChannel.get(method);
  if (!channel) {
    console.warn(`skip ${method}: no preload/IPC channel`);
    continue;
  }
  entries.push({ method, channel, doc, input: clip(input, LIMIT_INPUT), output: clip(output, LIMIT_OUTPUT) });
}
entries.sort((a, b) => a.method.localeCompare(b.method));

const body =
  `// ⚠️ 生成文件,别手改。来源:packages/contracts/src/ipc/rpcMap.ts + src/preload/index.ts\n` +
  `// 重新生成:在 apps/desktop 下 \`node scripts/gen-app-api-catalog.mjs\`\n` +
  `export interface ApiCatalogEntry {\n  method: string;\n  channel: string;\n  doc: string;\n  input: string;\n  output: string;\n}\n\n` +
  `export const API_CATALOG: readonly ApiCatalogEntry[] = ${JSON.stringify(entries, null, 1)};\n`;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body, "utf8");
console.log(`wrote ${entries.length} entries → ${outFile}`);
