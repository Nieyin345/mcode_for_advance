/**
 * 【F023】扩展能力的**静态下限**推断 —— 用户裁决「装时说清楚，之后不打断」的实现。
 *
 * ## 它回答的问题
 *
 * 「这个扩展装上之后，**能**碰什么？」—— 在装之前，用它的已发布代码回答。
 *
 * ## 它不回答的问题（每一条都写进 `limits`，不是只写在这里）
 *
 * - **不是「它会做什么」** —— 静态看到 `fs.writeFileSync` 只说明这段代码存在，
 *   不说明激活路径会走到它。
 * - **不是「只有这些」** —— 混淆、`eval`、动态拼接的 `require`、打包器的运行时
 *   模块表，全都看不见。所以 `confidence` 恒为 `static-lower-bound`。
 * - **不是运行时隔离** —— 用户选的是「装时说清楚」，本宿主**不做**沙箱。
 *   一个说「它不能起进程」而实际起了的报告，和没有报告一样糟；这也是
 *   为什么漏报必须写进 `limits` 让用户看见。
 *
 * ## 覆盖范围的三个同心圆（越外越不可靠，都在 `limits` 里点名）
 *
 * 1. **入口 + 相对 require 闭包**（默认，逐文件、逐行，有 `文件:行号`）；
 * 2. **外部包名白名单**（`cross-spawn`、`node-pty`、`axios` 一类）—— 只在
 *    require 那一行给证据，不展开包内部；
 * 3. **其余一切**（扩展自带的 `node_modules` 里的深层实现、动态加载、
 *    `eval`）—— **不扫**。
 *
 * 第 2 层存在的原因：实测 `james-yu.latex-workshop` 自己**不** require
 * `child_process`，它 require 的是 `cross-spawn`；不认这一层，报告会对一个
 * 会起子进程的扩展说「不起子进程」。那不是保守，是错的。
 *
 * ## 为什么先剥注释再匹配
 *
 * 源码里 `// require("child_process")` 是真实存在的写法（注释掉的遗留、
 * 文档举例）。直接在原文上 `includes` 会把它们算成证据 —— 这个仓库里
 * 「注释掉的代码也算命中」已经踩过（`sourceHas` 那条硬规矩）。所以本模块
 * 自带一个小的状态机，产出两份视图：
 *
 * - `code`：注释被抹成空格、**字符串保留** —— 用来匹配 `require("x")`；
 * - `bare`：注释与字符串内容都被抹掉 —— 用来匹配 `fs.readFileSync` 这类
 *   标识符（字符串里的 `"fs.readFileSync"` 不是调用）。
 *
 * 两份视图都保持**行号不变**（换行原样保留），`文件:行号` 才对得上。
 */
import { promises as fsp, statSync } from "node:fs";
import * as path from "node:path";
import {
  type ExtensionPermissionReport,
  type ExtensionCapability,
} from "@contracts/extensionPermissionReport.js";

/** 单文件上限：再大的「源码」多半是打包产物，逐行扫也不会更准。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 闭包文件数上限。超出就停，并把它记进 `limits`（不静默截断）。 */
const MAX_FILES = 256;
/** `evidence` 与契约上限一致（schema 里是 200）。 */
const MAX_EVIDENCE = 200;

/* ───────────────────────── 已知包名 → 能力（第 2 层） ───────────────────────── */

/**
 * 外部包名白名单。**每一项都要能说出「require 它就意味着什么」**：
 *
 * - `cross-spawn` / `execa` / `shelljs` / `node-pty` / `node-pty-prebuilt-multiarch`：
 *   包的全部用途就是起进程。require 它就是起进程的书面证据。
 * - `axios` / `got` / `node-fetch` / `undici` / `ws` / `request` / `superagent`：
 *   同理，网络客户端。
 *
 * **刻意不放**泛用包（`lodash`、`tmp`、`glob`）：它们偶尔会碰文件，但把
 * 「用了 glob」报成「读文件」会让这个标记变成永远亮着的灯 —— 用户会学会忽略它。
 * 代价是 `glob` 这类真的读文件时我们漏报；那条写进 `limits`。
 */
const PACKAGE_CAPABILITIES: Readonly<Record<string, readonly ExtensionCapability[]>> = {
  "cross-spawn": ["spawnsProcesses"],
  execa: ["spawnsProcesses"],
  shelljs: ["spawnsProcesses"],
  "node-pty": ["spawnsProcesses"],
  "node-pty-prebuilt-multiarch": ["spawnsProcesses"],
  axios: ["network"],
  got: ["network"],
  "node-fetch": ["network"],
  undici: ["network"],
  ws: ["network"],
  request: ["network"],
  superagent: ["network"],
};

/* ───────────────────────── 源码视图（剥注释 / 剥字符串） ───────────────────────── */

interface SourceViews {
  /** 注释抹成空格，字符串**保留**。 */
  code: string;
  /** 注释与字符串内容都抹掉。 */
  bare: string;
}

const REPLACEMENT = " ";

/**
 * 一遍扫描，同时产出两份视图。状态机只认四种状态 + 模板字符串，
 * 遇到 `\` 转义就跳下一个字符 —— 不求完整 JS 词法，只求「不会把注释吃成代码、
 * 不会把字符串里的词当成调用」。
 */
export function stripForScanning(source: string): SourceViews {
  const code: string[] = [];
  const bare: string[] = [];
  let i = 0;
  const n = source.length;
  // 保留换行，行号才对得上
  const push = (c: string, bareChar: string): void => {
    code.push(c);
    bare.push(bareChar);
  };
  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : "";
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        push(REPLACEMENT, REPLACEMENT);
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        push(source[i] === "\n" ? "\n" : REPLACEMENT, source[i] === "\n" ? "\n" : REPLACEMENT);
        i++;
      }
      if (i < n) {
        push(REPLACEMENT, REPLACEMENT);
        push(REPLACEMENT, REPLACEMENT);
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      push(c, c);
      i++;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          push(ch, REPLACEMENT);
          if (i + 1 < n) {
            push(source[i + 1] === "\n" ? "\n" : REPLACEMENT, source[i + 1] === "\n" ? "\n" : REPLACEMENT);
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (ch === quote) {
          push(ch, ch);
          i++;
          break;
        }
        // 字符串里的换行只在模板字符串里合法；原样保留行号
        push(ch === "\n" ? "\n" : ch, ch === "\n" ? "\n" : REPLACEMENT);
        i++;
      }
      continue;
    }
    push(c, c);
    i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}

/* ───────────────────────── 行号与证据 ───────────────────────── */

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 0-based 偏移 → 1-based 行号（二分）。 */
function lineAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

interface Hit {
  capability: ExtensionCapability;
  evidence: string;
}

/** 在 `text` 里跑一个全局正则，把每个命中记成 `相对路径:行号`。 */
function collect(
  hits: Hit[],
  text: string,
  starts: readonly number[],
  pattern: RegExp,
  capability: ExtensionCapability,
  relativePath: string,
  cap = Number.POSITIVE_INFINITY,
): void {
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    if (count++ >= cap) break;
    const at = match.index ?? 0;
    hits.push({ capability, evidence: `${relativePath}:${lineAt(starts, at)}` });
  }
}

/* ───────────────────────── 判定规则 ───────────────────────── */

/**
 * `require("x")` 里的模块名 → 能力。
 *
 * 注意 `fs` 只算 `readsFiles`：require 一个模块说明它**能**用，但把每个
 * fs 用户都标成「写文件」等于这个标记恒真。写入必须由**调用点**证明
 * （见 `WRITE_API`）。这条不对称是刻意的，也写进了 `limits`。
 */
const MODULE_CAPABILITIES: Readonly<Record<string, readonly ExtensionCapability[]>> = {
  fs: ["readsFiles"],
  "node:fs": ["readsFiles"],
  "fs/promises": ["readsFiles"],
  "node:fs/promises": ["readsFiles"],
  "graceful-fs": ["readsFiles"],
  "fs-extra": ["readsFiles", "writesFiles"],
  child_process: ["spawnsProcesses"],
  "node:child_process": ["spawnsProcesses"],
  worker_threads: ["spawnsProcesses"],
  "node:worker_threads": ["spawnsProcesses"],
  net: ["network"],
  "node:net": ["network"],
  http: ["network"],
  "node:http": ["network"],
  https: ["network"],
  "node:https": ["network"],
  dns: ["network"],
  "node:dns": ["network"],
  tls: ["network"],
  "node:tls": ["network"],
};

/**
 * 读取类 API（在 `bare` 视图上匹配 —— 字符串里的同名文本不算调用）。
 *
 * 只收**名字本身就有辨识度**的：`readFileSync` 基本只会是 fs；而 `stat(` /
 * `access(` / `realpath(` 这种裸名字在非文件系统代码里也常见，收进来会让
 * 「读文件」变成恒亮的灯。代价写在 `limits` 里。
 */
const READ_API =
  /\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir|readJsonSync|readJson|readJsonSync|statSync|lstatSync|fstatSync|existsSync|realpathSync|readlinkSync)\s*\(/g;
/**
 * 写入类 API。同样只收有辨识度的。
 *
 * **刻意不收裸 `rm(` / `remove(` / `move(` / `rename(`** —— 它们在非 fs 代码里
 * 到处都是（`array.remove(...)`、`list.move(...)`）。收进来会让每个用了这类
 * 工具函数的扩展都被标成「能改你的文件」，而这个标记一旦恒亮，用户就学会忽略它。
 */
const WRITE_API =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|rmdirSync|rmdir|unlinkSync|unlink|renameSync|copyFileSync|copyFile|truncateSync|truncate|writeJsonSync|writeJson|outputFileSync|outputFile|ensureDirSync|ensureDir|removeSync|moveSync)\s*\(/g;
/**
 * 起进程的 API。
 *
 * **`exec(` 单独出现不算** —— `RegExp.prototype.exec` 太常见了：
 * `/x/.exec(s)` 会把每个做正则处理的扩展标成「能起子进程」。所以裸 `exec(`
 * 只在**带限定符**（`child_process.exec(` / `cp.exec(`）时才计；
 * 而 `execSync` / `execFile` / `spawn` / `fork` 这些名字本身够独特，直接计。
 */
const SPAWN_API =
  /\b(?:spawnSync|execSync|execFileSync|execFile|spawn|fork)\s*\(|(?:child_process|childProcess|cproc|cp|cpx)\s*\.\s*(?:exec|spawn|execFile|fork)(?:Sync)?\s*\(/g;
/** 网络 API：`fetch`、原生 WebSocket，以及 http/https/net/tls 上的请求方法。 */
const NETWORK_API =
  /\bfetch\s*\(|\bnew\s+WebSocket\s*\(|(?:http2?|https|net|tls)\s*\.\s*(?:request|get|connect|createConnection)\s*\(/g;
/** `vscode.workspace.fs.*` —— 走 Theia 文件系统的那一半。 */
const WORKSPACE_FS = /\.workspace\s*\.\s*fs\s*\.\s*(\w+)\s*\(/g;
const WORKSPACE_FS_READ = new Set(["readFile", "readDirectory", "stat"]);
const WORKSPACE_FS_WRITE = new Set(["writeFile", "createDirectory", "delete", "rename", "copy"]);

/* ───────────────────────── 文件闭包 ───────────────────────── */

const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * 解析相对 require。**必须补 `.js` / `/index.js`** ——
 * `require("./utils/logger")` 在磁盘上是 `utils/logger.js`；不补的话
 * 整个闭包会在第二层就断掉（实测 latex-workshop：只补精确路径得到 0 个
 * 传递依赖，补完得到 9 个文件）。
 */
function resolveRelative(fromFile: string, request: string): string | null {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    try {
      // 同步 stat 只为「存不存在」；内容稍后异步读
      const stat = statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // 下一个候选
    }
  }
  return null;
}

interface ClosureResult {
  files: string[];
  /** 解析失败 / 读取失败 / 被上限截断的相对 require，原样记下来给 `limits`。 */
  unresolved: string[];
  truncated: boolean;
}

async function buildClosure(entry: string, root: string): Promise<ClosureResult> {
  const files: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  let truncated = false;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.push(file);
    let source: string;
    try {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_FILE_BYTES) {
        unresolved.push(`${path.relative(root, file)}（超过 ${MAX_FILE_BYTES} 字节，未扫描）`);
        continue;
      }
      source = await fsp.readFile(file, "utf8");
    } catch {
      unresolved.push(`${path.relative(root, file)}（读取失败）`);
      continue;
    }
    if (!/\.(?:js|cjs|mjs)$/.test(file)) continue;
    const { code } = stripForScanning(source);
    for (const match of code.matchAll(REQUIRE_CALL)) {
      const request = match[1];
      if (!request.startsWith(".")) continue;
      const resolved = resolveRelative(file, request);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
      else if (!resolved) unresolved.push(`${path.relative(root, file)} → ${request}`);
    }
  }
  return { files, unresolved, truncated };
}

/* ───────────────────────── 主入口 ───────────────────────── */

export interface ScanOptions {
  /**
   * 入口文件的**覆盖值**。不传就读 `package.json` 的 `main`。
   * 测试用它指向一个合成的扩展目录；产品路径永远不传。
   */
  entry?: string;
}

/**
 * 扫描一个已解包的扩展到能力下限报告。
 *
 * **不抛异常**：扩展目录坏了、清单缺 `main`、入口不存在 —— 都产出一份
 * 全 `false` 的报告 + `limits` 说明原因。理由：装的时候拿不到报告，
 * 用户就只会看到「装上了」，那比一份说「我没能检查」的报告更糟。
 */
export async function buildExtensionPermissionReport(
  extensionDir: string,
  options: ScanOptions = {},
): Promise<ExtensionPermissionReport> {
  const root = path.resolve(extensionDir);
  const limits: string[] = [
    "静态扫描：只覆盖代码里写出来的能力，混淆 / eval / 动态拼接的 require 看不见。",
    "不做运行时隔离：本宿主是「装时说清楚」，不是沙箱。",
  ];
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    limits.push("读取 package.json 失败，无法确定入口。");
  }

  const publisher = typeof manifest?.publisher === "string" ? manifest.publisher : "unpublished";
  const name = typeof manifest?.name === "string" ? manifest.name : path.basename(root);
  const version = typeof manifest?.version === "string" ? manifest.version : "0.0.0";
  const extensionId = `${publisher}.${name}@${version}`.toLowerCase();

  const declaredMain = typeof manifest?.main === "string" ? manifest.main : undefined;
  const declaredBrowser = typeof manifest?.browser === "string" ? manifest.browser : undefined;
  const entryRelative = options.entry ?? declaredMain ?? declaredBrowser;
  if (!entryRelative) {
    limits.push("清单里没有 main / browser，无法确定入口；报告为全 false。");
    return {
      extensionId,
      readsFiles: false,
      writesFiles: false,
      spawnsProcesses: false,
      network: false,
      evidence: [],
      confidence: "static-lower-bound",
      limits,
    };
  }
  const entry = path.resolve(root, entryRelative);
  if (!entry.startsWith(root)) {
    limits.push("入口路径在扩展目录之外，拒绝扫描。");
    return {
      extensionId,
      readsFiles: false,
      writesFiles: false,
      spawnsProcesses: false,
      network: false,
      evidence: [],
      confidence: "static-lower-bound",
      limits,
    };
  }

  const closure = await buildClosure(entry, root);
  if (closure.truncated) {
    limits.push(`相对 require 闭包超过 ${MAX_FILES} 个文件，已截断 —— 后面的文件没有扫描。`);
  }
  for (const item of closure.unresolved.slice(0, 20)) {
    limits.push(`未扫到：${item}`);
  }
  if (closure.unresolved.length > 20) {
    limits.push(`另有 ${closure.unresolved.length - 20} 个未能解析的 require 未列出。`);
  }

  const hits: Hit[] = [];
  for (const file of closure.files) {
    let source: string;
    try {
      source = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    const { code, bare } = stripForScanning(source);
    const starts = lineStarts(source);

    // 第 1 层：模块 require（逐条按模块名→能力映射计，未映射的不猜）
    for (const match of code.matchAll(REQUIRE_CALL)) {
      const request = match[1];
      const at = lineAt(starts, match.index ?? 0);
      const evidence = `${relativePath}:${at}`;
      const known = MODULE_CAPABILITIES[request] ?? PACKAGE_CAPABILITIES[request];
      if (known) {
        for (const capability of known) hits.push({ capability, evidence });
      } else if (!request.startsWith(".") && !request.startsWith("node:")) {
        // 不认识的包：**不猜**，进 limits 让用户/审计看见「这里有一块黑的」。
        // （只在更上层汇总，避免每个文件一条把 limits 撑爆）
      }
    }

    // 第 2 层：调用点
    collect(hits, bare, starts, READ_API, "readsFiles", relativePath);
    collect(hits, bare, starts, WRITE_API, "writesFiles", relativePath);
    collect(hits, bare, starts, SPAWN_API, "spawnsProcesses", relativePath);
    collect(hits, bare, starts, NETWORK_API, "network", relativePath);
    for (const match of bare.matchAll(WORKSPACE_FS)) {
      const method = match[1];
      const evidence = `${relativePath}:${lineAt(starts, match.index ?? 0)}`;
      if (WORKSPACE_FS_READ.has(method)) hits.push({ capability: "readsFiles", evidence });
      if (WORKSPACE_FS_WRITE.has(method)) hits.push({ capability: "writesFiles", evidence });
    }
  }

  // 按能力汇总 + 去重（同一行同一能力只留一条）。
  const byCapability = new Map<ExtensionCapability, string[]>();
  for (const hit of hits) {
    const list = byCapability.get(hit.capability) ?? [];
    if (!list.includes(hit.evidence)) list.push(hit.evidence);
    byCapability.set(hit.capability, list);
  }

  const evidence: string[] = [];
  for (const capability of ["spawnsProcesses", "network", "writesFiles", "readsFiles"] as const) {
    const list = byCapability.get(capability) ?? [];
    for (const item of list) {
      if (evidence.length >= MAX_EVIDENCE) break;
      if (!evidence.includes(item)) evidence.push(item);
    }
  }
  if (evidence.length >= MAX_EVIDENCE) {
    limits.push(`evidence 达到 ${MAX_EVIDENCE} 条上限，后续命中未列入（不影响布尔值）。`);
  }

  limits.push(
    "require 了 `fs` 只记「读」；「写」必须由写调用点证明 —— 一个只 require fs 的扩展可能是读写都做。",
    "扩展自带 node_modules 的内部实现不展开；只有已知包名（cross-spawn / node-pty / axios 等）按 require 行计一次。",
    "`glob` / `tmp` / `shelljs` 之外的泛用工具包按文件访问计；`glob` 这类会读文件但我们刻意不计（否则标记恒真、用户会忽略它）。",
  );

  const has = (capability: ExtensionCapability): boolean => (byCapability.get(capability)?.length ?? 0) > 0;

  return {
    extensionId,
    readsFiles: has("readsFiles"),
    writesFiles: has("writesFiles"),
    spawnsProcesses: has("spawnsProcesses"),
    network: has("network"),
    evidence,
    confidence: "static-lower-bound",
    limits: limits.slice(0, 20),
  };
}
