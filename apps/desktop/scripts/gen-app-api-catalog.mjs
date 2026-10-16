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
/**
 * 【MC-040】`inputFull` —— 对**浅展开被截断**的入参再展开一层(递归深度 2),
 * 供 `app_api_describe({detail:"full"})` 按需返回。
 *
 * 为什么做成第二份而不是直接把浅的那份加大:清单是**每回合常驻**在模型上下文里
 * 的(`app_api_list` 的输出 + 提示词),逐条膨胀会挤占预算;完整结构只有"要动手调
 * 这个方法"时才需要 —— 按需展开的代价落在 describe 那一次调用上。
 */
const LIMIT_INPUT_FULL = 3200;
/**
 * 深度预算。取 4 的理由(以台账红例 `workflow.save` 为尺):调用方要看到
 * `workflow.nodes[].position.x` —— 参数对象(1) → `workflow` 字段(2) →
 * `WorkflowDoc` 字段(3) → `nodes` 元素(4) → 深度耗尽时 `summaryOf` 列出
 * `position` 的**字段名**。再深就只有预算在挡(见 LIMIT_INPUT_FULL)。
 */
const FULL_DEPTH = 5;

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

/**
 * 把一个类型摊成「第一层字段」那一段文字 —— **入参和返回都走它**。
 *
 * 从前只有入参走:返回一律 `checker.typeToString`,于是返回值是**具名接口**的方法
 * (比如 `browser.*` 全返 `BrowserOpResult`)在清单里只写一个名字 —— agent 照着拼得到
 * 参数,却**猜不出返回里有哪些字段**(报告附录 D 的 B3:`otherPath` / `item.id` 全栽在
 * 这上面,只能试错)。名字在 `@contracts` 里是有定义的类型,展开一下就有了,没成本。
 */
function describeShape(type, node, emptyLabel) {
  if (!type) return emptyLabel;
  // 判别式联合(如 `CheckForUpdatesResult` = 三种 `{ status; … }`):逐支摊开 ——
  // 名字对 agent 没用,它要看的是"每一步回报里有哪些字段"。
  if (type.isUnion()) {
    const parts = type.types.map((t) => describeShape(t, node, "")).filter((t) => t && t !== "void");
    if (parts.length > 0) return clip(parts.join(" | "), LIMIT_OUTPUT);
    return checker.typeToString(type, node, flags);
  }
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

/**
 * 【MC-040】深度展开:`depth` 层嵌套对象逐层摊开,每层字段名+类型+注释首句。
 *
 * 浅展开(`describeShape`,给常驻清单)只摊第一层,嵌套对象留 `{…}`;而
 * `workflow.save` 那种"入参里有一棵图"的方法,恰恰是嵌套层决定调用合法性
 * (`nodes[].position` / `edges[].from` 全在省略号里)。full 版按需生成:
 * 深度到 {@link FULL_DEPTH} 或字符预算耗尽为止 —— 用**预算**而不是硬深度兜底,
 * 免得一个超级节点把整段撑爆(截断处显式留 `…`)。
 */
function describeShapeDeep(type, node, budget, depth, seen = new Set()) {
  // ⚠️ 这里**不能用** NoTruncation 的 `flags` —— 那是给浅层一次性打印用的;递归类型
  // (自引用接口)会让 `typeToString` 自己栈溢出。默认截断(TS 自己会打 `…`)天然安全。
  // 某些病态深类型连默认截断都可能爆栈 —— 兜底给 "unknown",不让整个生成器倒。
  const safeToString = (t, n) => {
    try {
      return checker.typeToString(t, n);
    } catch {
      return "unknown";
    }
  };
  const primitive = () => clip(safeToString(type, node), 200);
  if (!type || budget.left <= 0) return "…";
  // `unknown` / `any`:没有可展开的结构。
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return primitive();
  // 环(自引用类型)与同一类型重复出现:给名字,别递归。
  // ⚠️ key 用 `type.id`(checker 内部给的稳定数字),**不能**用 typeToString ——
  // 对深层自引用类型,typeToString 自己就可能爆栈(见 primitive 的 catch)。
  const key = type.id;
  if (seen.has(key)) return clip(safeToString(type, node), 120);
  if (type.isUnion()) {
    const parts = type.types
      .map((t) => describeShapeDeep(t, node, budget, depth, seen))
      .filter((t) => t && t !== "void");
    // 对象联合逐支摊(判别式联合的样子);纯标量联合合并成一行。
    const allObjects = type.types.every(
      (t) => (t.flags & ts.TypeFlags.Object) !== 0 || t.isUnion() || t.isIntersection(),
    );
    if (parts.length > 1 && allObjects) return parts.join(" | ");
    return primitive();
  }
  // 数组:展开**元素**形状,而不是把 Array 原型上的 length/push/… 当字段列出来。
  // 元素递归同样降 depth —— **必须先查 depth**:数组分支在 props 分支之前,
  // 若把 depth<=0 的守卫留在后面,`Array<Array<…>>` 会先在这里无限递归(实测爆栈)。
  // ⚠️ `getNumberIndexType()` 在病态递归类型上可能让 checker 自己爆栈 —— 兜底。
  // ⚠️ 只有 **Object** 标志的类型才走数组分支:`string` 也有数字索引签名
  // (string[0] => string),不挡会打印成 `Array<string>`。
  if (depth > 0 && (type.flags & ts.TypeFlags.Object) !== 0) {
    let numberIndex = undefined;
    try {
      numberIndex = type.getNumberIndexType?.();
    } catch {
      numberIndex = undefined;
    }
    if (numberIndex && !(numberIndex.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any))) {
      const elem = describeShapeDeep(numberIndex, node, budget, depth - 1, seen);
      return `Array<${elem}>`;
    }
  }
  let props = [];
  try {
    props = checker.getPropertiesOfType(type);
  } catch {
    props = [];
  }
  const isObjectLike = (type.flags & ts.TypeFlags.Object) !== 0 || type.isIntersection();
  if (!isObjectLike || props.length === 0) return primitive();
  if (depth <= 0) {
    // 到深度上限:给"这个对象有哪些字段"的提示,别只说 `{…}`(那正是台账红例)。
    // ⚠️ **必须滤掉原型成员**:数组/Map 这类结构在 checker 里是对象,`getPropertiesOfType`
    // 会把 `length/push/pop/…` 全列出来 —— 那不是"这棵树有哪些字段",是噪声。
    const own = props.filter((p) => {
      const d = p.valueDeclaration ?? p.declarations?.[0];
      return d !== undefined && !ts.isSourceFile(d.getSourceFile());
    });
    const names = (own.length > 0 ? own : props).map((p) => p.name);
    return `{ ${names.slice(0, 24).join("; ")}${names.length > 24 ? "; …" : ""} }`;
  }
  seen.add(key);
  const lines = [];
  for (const p of props) {
    if (budget.left <= 0) {
      lines.push("…");
      break;
    }
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    const pt = checker.getTypeOfSymbolAtLocation(p, decl ?? node);
    const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
    const d = clip(firstSentence(docOf(p)), LIMIT_FIELD_DOC);
    const rendered = describeShapeDeep(pt, decl ?? node, budget, depth - 1, seen);
    const line = `${p.name}${optional ? "?" : ""}: ${rendered}${d ? ` // ${d}` : ""}`;
    budget.left -= line.length;
    lines.push(line);
  }
  seen.delete(key);
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
  let inputFull = "(无参数)";
  let output = "void";
  if (sig) {
    const param = sig.getParameters()[0];
    if (param) {
      const rawInput = describeShape(checker.getTypeOfSymbolAtLocation(param, member), member, "(无参数)");
      input = clip(rawInput, LIMIT_INPUT);
      // 【MC-040】浅展开被截断时才生成 full 版(没截断的两份相同,别白占体积)。
      inputFull =
        input !== clip(rawInput, LIMIT_INPUT_FULL * 10) || rawInput.includes("{…")
          ? clip(describeShapeDeep(checker.getTypeOfSymbolAtLocation(param, member), member, { left: LIMIT_INPUT_FULL }, FULL_DEPTH), LIMIT_INPUT_FULL)
          : input;
    }
    let ret = sig.getReturnType();
    const awaited = checker.getAwaitedType?.(ret);
    if (awaited) ret = awaited;
    // 返回也摊开第一层 —— 具名接口从前只剩一个名字(见 `describeShape` 的说明)。
    output = describeShape(ret, member, "void");
  }
  const channel = methodChannel.get(method);
  if (!channel) {
    console.warn(`skip ${method}: no preload/IPC channel`);
    continue;
  }
  entries.push({ method, channel, doc, input: clip(input, LIMIT_INPUT), inputFull, output: clip(output, LIMIT_OUTPUT) });
}
entries.sort((a, b) => a.method.localeCompare(b.method));

const body =
  `// ⚠️ 生成文件,别手改。来源:packages/contracts/src/ipc/rpcMap.ts + src/preload/index.ts\n` +
  `// 重新生成:在 apps/desktop 下 \`node scripts/gen-app-api-catalog.mjs\`\n` +
  `export interface ApiCatalogEntry {\n  method: string;\n  channel: string;\n  doc: string;\n  /** 浅展开(给每回合常驻的 app_api_list 输出;嵌套对象留 {…})。 */\n  input: string;\n  /** 【MC-040】深展开(给 app_api_describe({detail:\"full\"}) 按需返回;嵌套到 2 层)。 */\n  inputFull: string;\n  output: string;\n}\n\n` +
  `export const API_CATALOG: readonly ApiCatalogEntry[] = ${JSON.stringify(entries, null, 1)};\n`;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body, "utf8");
console.log(`wrote ${entries.length} entries → ${outFile}`);
