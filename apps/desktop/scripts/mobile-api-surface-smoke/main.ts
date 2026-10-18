/**
 * mobile-api-surface-smoke — 手机 HTTP 桥的**通道对齐**回归。
 *
 * ## 这条套件钉的是什么
 *
 * `renderer/lib/webApi.ts` 是手机端(独立组件树、无 preload、走 `/api/rpc`)的
 * `window.api` 实现。CLAUDE.md 里登记过的那条坑:
 *
 * > 共用组件里每加一个 RPC 都要在 `webApi.ts` 补一项,漏了会同步抛错、
 * > React 19 整棵卸载。
 *
 * 所以判据不是"webApi 长得像 preload",而是**手机壳实际会加载的代码里出现的
 * `api.<ns>.<method>` 调用,每一个都必须落在 `createWebApi()` 的显式实现上**
 * (`rpc(...)` / 本地实现 / `webUnsupported(...)` 都算 —— 后者是"显式不支持",
 * 不是缺项)。
 *
 * 机械清单(不是手写):
 *   A. **缺失**:从 `AppMobile.tsx` 出发沿 import 图可达的 renderer 文件里出现的
 *      `api.<ns>.<method>`,对照 webApi 的显式 surface —— 命中即红;
 *   B. **名不副实**:webApi 里每条 `rpc("x:y")` 是否在**主进程手机白名单**
 *      (`main/mobile/mobileRpc.ts` + `mobileGitRpc.ts` 的 handler 表)里 ——
 *      不在了就是"手机发一条注定 unknown-method 的 RPC";命中即红;
 *   C. **态度**:preload 的每个命名空间在 webApi 里必须"有态度"—— 要么列出方法
 *      (实现 / 桩),要么在 {@link PROXY_ONLY} 里**显式声明**为整块不适用。
 *      新增命名空间而两边都不动 = 静默落 Proxy,命中即红;
 *   D. 桩的**行为**:桌面专属桩必须同步抛带 `WEB_UNSUPPORTED_MARKER` 的错且原因
 *      非空 —— 不能是 `undefined`、不能是空错误。

 * ⚠️ 本套**不发真 RPC、不起服务、不连网**。AST/import 图用仓库自带的 TypeScript
 * compiler(`--external:typescript`,运行时从 apps/desktop/node_modules 解析)。
 *
 * Run: scripts/mobile-api-surface-smoke/run.sh
 */
import "./prelude.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import { createWebApi, isWebUnsupportedError } from "@renderer/lib/webApi.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const ROOT = resolve(process.cwd()); // apps/desktop (run.sh cd 到这里)
const RENDERER = join(ROOT, "src/renderer");
const PRELOAD = join(ROOT, "src/preload/index.ts");
const WEBAPI = join(RENDERER, "lib/webApi.ts");
const MAIN_MOBILE = [
  join(ROOT, "src/main/mobile/mobileRpc.ts"),
  join(ROOT, "src/main/mobile/mobileGitRpc.ts"),
];

/**
 * 整个命名空间**声明为不适用**、靠 Proxy 兜底的 preload 命名空间。
 *
 * 判据:手机壳加载的代码里**没有任何** `api.<ns>.<method>` 的静态调用(下面的 B 项
 * 会逐条证明),而且它们都是"那台电脑的本机界面/进程":原生窗口、系统对话框、
 * 更新器、SSH 中继、手机伴侣自己的配对管理(那些动作只发生在 PC 的弹窗里)。
 * 加新名字到这张表 = 明确表态"整块不上手机";不加 = 必须先列方法,否则 A/C 红。
 */
const PROXY_ONLY: ReadonlySet<string> = new Set([
  "app", // 版本信息 / 数据根迁移 / 更新器 —— 手机没有"这台电脑的应用"这个概念
  "rg", // ripgrep 安装(本机工具链)
  "browser", // 内嵌浏览器是主窗口里的 WebContentsView
  "engineTools", // 设置 → 引擎工具(本机配置)
  "context", // 全局指令(本机设置)
  "tools", // 工具 schema 静态枚举(设置面板)
  "outputStyle", // 输出风格(设置面板)
  "mobile", // 手机伴侣的 PC 侧管理(配对 / 设备 / 隧道)—— 手机自己不是它的入口
  "relay", // SSH 反向隧道(PC 侧面板)
  "toolchain", // 文档工具链安装(本机进程)
  "runs", // 工作流运行史(桌面监控页)
  "unattendedPlans", // 无人值守计划的跨重启面(桌面设置)
  "monitoring", // 总览监控(桌面)
  "hooks", // 钩子(设置 → 钩子,宿主侧执行)
  "extensionStore", // 扩展私有 KV(浏览器扩展宿主)
]);

/* ────────────────────────── AST helpers ────────────────────────── */

function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function propName(node: ts.Node | undefined): string | null {
  if (node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))) return node.text;
  return null;
}

/** `as X` / `satisfies X` / 括号 —— 剥到对象字面量本身。 */
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let x = node;
  while (
    x &&
    (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x))
  ) {
    x = x.expression;
  }
  return x;
}

/** 文件里的 const 声明(递归到函数体内也收,供 `createWebApi` 里的 base)。 */
function constsOf(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

/* ─────────────── webApi surface(实现分类) ─────────────── */

interface MethodInfo {
  params: number;
  /** "rpc" = 真 HTTP 调用;"local" = 本地实现;"stub" = webUnsupported。 */
  kind: "rpc" | "local" | "stub";
  rpcTarget: string | null;
}

function classifyMethod(init: ts.Expression): MethodInfo {
  const text = init.getText();
  const info: MethodInfo = { params: -1, kind: "local", rpcTarget: null };
  const node = unwrap(init);
  if (node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
    info.params = node.parameters.length;
  }
  const rpcMatch = text.match(/\brpc(?:<[^>]*>)?\(\s*"([^"]+)"/);
  if (/webUnsupported\(/.test(text)) info.kind = "stub";
  else if (rpcMatch) {
    info.kind = "rpc";
    info.rpcTarget = rpcMatch[1];
  }
  return info;
}

function webApiSurface(): Map<string, Map<string, MethodInfo>> {
  const sf = parseFile(WEBAPI);
  const consts = constsOf(sf);
  let base: ts.Expression | undefined;
  const findBase = (n: ts.Node): void => {
    if (base) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === "createWebApi" && n.body) {
      n.body.forEachChild((s) => {
        if (!ts.isVariableStatement(s)) return;
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === "base" && d.initializer) base = d.initializer;
        }
      });
    }
    ts.forEachChild(n, findBase);
  };
  findBase(sf);
  const lit = unwrap(base);
  if (!lit || !ts.isObjectLiteralExpression(lit)) throw new Error("webApi: createWebApi().base object literal not found");
  const out = new Map<string, Map<string, MethodInfo>>();
  const collect = (ns: string, value: ts.Expression | undefined): void => {
    let obj = unwrap(value);
    if (obj && ts.isIdentifier(obj) && consts.has(obj.text)) obj = unwrap(consts.get(obj.text));
    const methods = new Map<string, MethodInfo>();
    if (obj && ts.isObjectLiteralExpression(obj)) {
      for (const p of obj.properties) {
        const name = propName(p.name);
        if (!name) continue;
        if (ts.isPropertyAssignment(p)) methods.set(name, classifyMethod(p.initializer));
        else if (ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
          methods.set(name, { params: -1, kind: "local", rpcTarget: null });
        }
      }
    }
    out.set(ns, methods);
  };
  for (const p of lit.properties) {
    const ns = propName(p.name);
    if (!ns) continue;
    if (ts.isPropertyAssignment(p)) collect(ns, p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) collect(ns, p.name);
    else out.set(ns, new Map()); // e.g. `getPathForFile`
  }
  return out;
}

/* ─────────────── preload surface(参照形状 + 参数个数) ─────────────── */

function preloadSurface(): Map<string, Map<string, number>> {
  const sf = parseFile(PRELOAD);
  const consts = constsOf(sf);
  const apiLit = unwrap(consts.get("api"));
  if (!apiLit || !ts.isObjectLiteralExpression(apiLit)) throw new Error("preload: `api` object literal not found");
  const out = new Map<string, Map<string, number>>();
  for (const p of apiLit.properties) {
    const ns = propName(p.name);
    if (!ns) continue;
    const methods = new Map<string, number>();
    let value = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined;
    if (value && ts.isObjectLiteralExpression(value)) {
      for (const q of value.properties) {
        const name = propName(q.name);
        if (!name) continue;
        const init = ts.isPropertyAssignment(q) ? unwrap(q.initializer) : undefined;
        methods.set(name, init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init.parameters.length : -1);
      }
    }
    out.set(ns, methods);
  }
  return out;
}

/* ─────────────── reachable import graph ─────────────── */

function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@renderer/")) base = join(RENDERER, spec.slice("@renderer/".length));
  else return null;
  base = base.replace(/\.(js|jsx)$/, "");
  for (const cand of [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function reachableFiles(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const sf = parseFile(file);
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const hit = resolveSpec(n.moduleSpecifier.text, file);
        if (hit) queue.push(hit);
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const hit = resolveSpec(n.arguments[0].text, file);
        if (hit) queue.push(hit);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return seen;
}

/** 可达文件里所有 `api.<ns>.<method>`,以及**一级可调用**的 `api.<name>`
 *  (pickFolder / pickFiles / getPathForFile —— preload 里它们就是 callable)。
 *  后者记成 `<name>`(不带点),与两级的 key 不会撞。 */
function usageIn(files: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    if (file === WEBAPI || file.endsWith("lib/api.ts")) continue; // 实现本体不是"调用方"
    const sf = parseFile(file);
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const inner = n.expression;
        if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "api") {
          const ns = propName(inner.name);
          const method = propName(n.name);
          if (ns && method) {
            const key = `${ns}.${method}`;
            const list = out.get(key) ?? new Set<string>();
            list.add(file.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", ""));
            out.set(key, list);
          }
        } else if (ts.isIdentifier(inner) && inner.text === "api") {
          // 一级:`api.pickFolder(...)` / `api.getPathForFile(...)`。
          // 跳过两级访问的**内层**节点(`api.theme` 在 `api.theme.get` 里也会被访问到,
          // 那是命名空间不是 callable —— 它的父节点是 `api.theme.get` 这个属性访问)。
          const isInnerOfTwoLevel =
            ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n;
          if (!isInnerOfTwoLevel) {
            const name = propName(n.name);
            if (name) {
              const list = out.get(name) ?? new Set<string>();
              list.add(file.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", ""));
              out.set(name, list);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/* ─────────────── mobile RPC whitelist(服务端) ─────────────── */

function mobileWhitelist(): Set<string> {
  const out = new Set<string>();
  for (const file of MAIN_MOBILE) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*"([a-zA-Z]+:[a-zA-Z]+)"\s*:/gm)) out.add(m[1]);
  }
  return out;
}

/* ══════════════════════════════ checks ══════════════════════════════ */

const api = createWebApi();
const reachable = reachableFiles(join(RENDERER, "AppMobile.tsx"));
const usage = usageIn(reachable);
const surface = webApiSurface();
const pre = preloadSurface();

/* ── A. ★ 可达组件里的 api 调用 ⊆ webApi 显式 surface ── */
console.log("\n[A] ★ 可达组件里的 api 调用全部有显式实现(桩也算)");
{
  const missing: Array<{ call: string; files: string[] }> = [];
  for (const [key, files] of usage) {
    if (!key.includes(".")) {
      // 一级 callable(pickFolder / pickFiles / getPathForFile):base 的顶层键里有它
      // 才算显式实现。⚠️ 不能靠 `typeof api[key] === "function"` 判 —— Proxy 对任何
      // 未列出的名字都返回 callable proxy,删掉桩它也仍然"是函数"(只会换个地方抛)。
      if (!surface.has(key)) missing.push({ call: key, files: [...files] });
      continue;
    }
    const [ns, method] = key.split(".");
    const impl = surface.get(ns);
    if (!impl || !impl.has(method)) missing.push({ call: key, files: [...files] });
  }
  check(
    `可达图(${reachable.size} 个文件)里 ${usage.size} 个 api.<ns>.<method> 全部落在 webApi 的显式实现上`,
    missing.length === 0,
    { missing },
  );
}

/* ── B. ★ rpc() 目标必须落在主进程手机白名单 ── */
console.log("\n[B] ★ webApi 的每条 rpc() 都有服务端 handler");
{
  const whitelist = mobileWhitelist();
  const unknown: Array<{ ns: string; method: string; target: string }> = [];
  let total = 0;
  for (const [ns, methods] of surface) {
    for (const [method, info] of methods) {
      if (info.kind !== "rpc" || !info.rpcTarget) continue;
      total++;
      if (!whitelist.has(info.rpcTarget)) unknown.push({ ns, method, target: info.rpcTarget });
    }
  }
  check(`webApi 的 ${total} 条 rpc 目标全部在主进程手机白名单里`, unknown.length === 0, { unknown });
}

/* ── C. ★ preload 每个命名空间在 webApi 里"有态度" ── */
console.log("\n[C] ★ preload 的每个命名空间在 webApi 里有明确态度");
{
  const unexplained: string[] = [];
  for (const [ns, methods] of pre) {
    const impl = surface.get(ns);
    if (impl) {
      // 已列出:preload 有的方法一个都不能少(少一个 = undefined is not a function)。
      const holes = [...methods.keys()].filter((m) => !impl.has(m));
      if (holes.length > 0) unexplained.push(`${ns}: listed but missing ${holes.join(",")}`);
      continue;
    }
    if (PROXY_ONLY.has(ns)) {
      // 声明为整块不适用 —— 可达图里也不许有静态调用(有的话 A 会红,A 红在此点名原因)。
      continue;
    }
    unexplained.push(`${ns}: neither implemented nor declared PROXY_ONLY`);
  }
  check("每个命名空间要么列出方法、要么显式声明为整块不适用", unexplained.length === 0, { unexplained });

  const declaredButUsed = [...PROXY_ONLY].flatMap((ns) =>
    [...usage.keys()].filter((k) => k.startsWith(ns + ".")).map((k) => ({ ns, call: k })),
  );
  check("PROXY_ONLY 里的命名空间没有被可达组件静态调用", declaredButUsed.length === 0, { declaredButUsed });

  // 反向:webApi 里列出的命名空间不能是 preload 里没有的(拼写错误 / 过期)。
  const phantom = [...surface.keys()].filter((ns) => !pre.has(ns));
  check("webApi 列出的命名空间全部存在于 preload", phantom.length === 0, { phantom });
}

/* ── D. 桩的行为:显式 unsupported(带 marker、原因非空),不是 undefined ── */
console.log("\n[D] 桌面专属桩是显式 unsupported,而不是 undefined");
{
  // 逐个把 reachable 里用到的、webApi 分类为 stub 的方法真调一次:必须同步抛 marker
  // 错,**或者**返回一个以 marker 错 reject 的 Promise(`async () => webUnsupported` 的
  // 写法 —— projectInit / scene 那一块)。两者都算"显式说出来",不算静默 undefined。
  const bad: string[] = [];
  const promises: Array<Promise<void>> = [];
  const isValidReason = (err: unknown): boolean =>
    isWebUnsupportedError(err) && (err as Error).message.trim().length > 0;
  for (const [key] of usage) {
    if (!key.includes(".")) continue; // 一级 callable 由 A 检查
    const [ns, method] = key.split(".");
    const info = surface.get(ns)?.get(method);
    if (!info || info.kind !== "stub") continue;
    const fn = (api as unknown as Record<string, Record<string, unknown>>)[ns]?.[method];
    if (typeof fn !== "function") {
      bad.push(`${key}: not a function`);
      continue;
    }
    try {
      const result = (fn as () => unknown)();
      if (result instanceof Promise) {
        promises.push(
          result.then(
            () => void bad.push(`${key}: resolved instead of rejecting`),
            (err: unknown) => {
              if (!isValidReason(err)) bad.push(`${key}: rejected non-marker ${String(err)}`);
            },
          ),
        );
      } else {
        bad.push(`${key}: returned instead of throwing`);
      }
    } catch (err) {
      if (!isValidReason(err)) bad.push(`${key}: threw non-marker ${String(err)}`);
    }
  }
  await Promise.all(promises);
  check("可达调用里的每个 unsupported 桩都抛/reject marker 错且原因非空", bad.length === 0, { bad });

  // 未列出的命名空间经 Proxy 兜底,同样抛 marker(而不是 undefined)。
  let proxyErr: unknown = null;
  try {
    (api as unknown as Record<string, () => unknown>).definitelyNotANamespace();
  } catch (err) {
    proxyErr = err;
  }
  check(
    "未列出的命名空间经 Proxy 兜底抛 webUnsupported(带 marker)",
    isWebUnsupportedError(proxyErr) && /definitelyNotANamespace/.test(String((proxyErr as Error).message)),
    { error: String(proxyErr) },
  );

  // 四个具体样本:点名的桌面专属桩必须真的有原因文本(同步抛或 rejected Promise 都算)。
  const samples: Array<[string, () => unknown]> = [
    ["library.list", () => api.library.list({ limit: 1 })],
    ["notification.getPrefs", () => api.notification.getPrefs()],
    ["plugins.list", () => api.plugins.list()],
    ["claude.listSideChats", () => api.claude.listSideChats({ parentSessionId: "x" })],
    ["session.listAll", () => api.session.listAll({ offset: 0, limit: 10 })],
    ["git.fileBlob", () => api.git.fileBlob({ repoPath: "/x", filePath: "a", side: "HEAD" })],
    ["pickFiles", () => api.pickFiles({})],
    ["pickFolder", () => api.pickFolder()],
  ];
  const sampleBad: string[] = [];
  const samplePromises: Array<Promise<void>> = [];
  for (const [name, call] of samples) {
    const ok = (err: unknown): boolean => isWebUnsupportedError(err) && (err as Error).message.trim().length > 0;
    try {
      const result = call();
      if (result instanceof Promise) {
        samplePromises.push(
          result.then(
            () => void sampleBad.push(name),
            (err: unknown) => {
              if (!ok(err)) sampleBad.push(name);
            },
          ),
        );
      } else {
        sampleBad.push(name);
      }
    } catch (err) {
      if (!ok(err)) sampleBad.push(name);
    }
  }
  await Promise.all(samplePromises);
  check("点名的桌面专属桩全部带 marker + 原因文本", sampleBad.length === 0, { sampleBad });
}

/* ── E. 签名可疑(preload 收参数 / webApi 实现不收)—— 只报告,不判红 ── */
console.log("\n[E] 签名清单(preload 收参数、webApi 实现不收)—— 供人工核对");
{
  const suspicious: string[] = [];
  for (const [ns, methods] of surface) {
    const preMethods = pre.get(ns);
    if (!preMethods) continue;
    for (const [method, info] of methods) {
      const preParams = preMethods.get(method);
      if (preParams !== undefined && preParams > 0 && info.params === 0 && info.kind !== "stub") {
        suspicious.push(`${ns}.${method}(preload ${preParams} 参,webApi 0 参,${info.kind})`);
      }
    }
  }
  console.log(`  （${suspicious.length} 条非桩实现忽略入参）`);
  for (const s of suspicious) console.log(`    - ${s}`);
  check("签名清单已打印(本项只报告)", true);
}

/* ── F. createWebApi() 关键面完整性 ── */
console.log("\n[F] createWebApi() 关键面完整性");
{
  const required = [
    "project.list", "project.sessions", "session.messages", "session.upsertMessages",
    "claude.startSession", "claude.sendTurn", "claude.approve", "claude.respondQuestion",
    "file.readFile", "file.readBinary", "file.listDir", "file.search",
    "git.status", "git.diff", "git.commit",
    "setting.get", "setting.set", "setting.getMany",
    "workflow.list", "workflow.choose", "workflow.retry",
    "theme.get", "theme.set", "terminal.list", "onlyoffice.open",
  ];
  const missing = required.filter((key) => {
    const [ns, m] = key.split(".");
    const group = (api as unknown as Record<string, Record<string, unknown>>)[ns];
    return typeof group?.[m] !== "function";
  });
  check("关键方法全部是函数", missing.length === 0, { missing });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`);
if (failures > 0) process.exit(1);
