/**
 * Headless smoke for **mcode-app**(本地 agent 完全控制 Mcode 的那组工具)。
 *
 * 覆盖:
 *   1. 权限表:清单里每个方法都能归档;关键几条钉死(自己批自己 = 不开放、装插件 = 高风险……)。
 *   2. 打码:按字段名、按值的样子、二进制、截断。
 *   3. 审批闸门:读自动、写要批、拒绝不执行、「始终允许」按方法生效、完全访问只放写不放高风险、
 *      计划模式全拒、不开放的直接拒、没有审批通道 fail-closed、参数错误说人话。
 *   4. ApprovalBridge:高风险卡就算传了 always 也不记。
 *   5. 界面通道:executeJavaScript 一来一回;不能给自己发消息;发消息先过审批。
 *   6. 接线:三个引擎都挂上、ipc/index.ts 登记了 handler、审批卡认前缀(源码断言)。
 *
 * Run: scripts/app-control-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderContext, ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import { APP_DANGER_APPROVAL_PREFIX, APP_CONTROL_RENDERER_GLOBAL } from "@contracts/appControl";
import { API_CATALOG } from "@main/appControl/apiCatalog.generated.js";
import { DOMAIN_LABELS, policyFor } from "@main/appControl/policy.js";
import { redactValue, redactString, renderResult, slimSessions, REDACTED } from "@main/appControl/redact.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { invokeAppTool, appMcpTools, panelApiCall, APP_READONLY_TOOLS, suggestMethod, __clearOperationLog } from "@main/appControl/tools.js";
import { isEnvelopeMethod } from "@main/appControl/commandOutcome.js";
import { setOperationLedger, type OperationLedger } from "@main/appControl/operations.js";
import { appToolDescriptors, isAppToolName } from "@main/appControl/engineTools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import { ApprovalBridge } from "@main/claude/ApprovalBridge.js";
import { __setSendToRendererThrows } from "./stubs/window.js";
import {
  ACTIONS_BY_SLOT,
  CUSTOM_UI_ICONS,
  CUSTOM_UI_SETTING_KEY,
  CUSTOM_UI_SLOTS,
  TEMPLATE_VARS_BY_SLOT,
} from "@contracts/customUi";
import { PANEL_METHODS, PANEL_THEME_VARS } from "@contracts/customUiPanel";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
/** 取 `app_api_call` 返回里的结构化 OperationResult(ARC-009)。 */
const opResultOf = (r: { structuredContent?: Record<string, unknown> }): Record<string, unknown> | undefined =>
  r.structuredContent?.operation_result as Record<string, unknown> | undefined;

/* ── 1. 权限表 ── */
check("清单不为空", API_CATALOG.length > 300, API_CATALOG.length);
check("清单每条都有 domain:verb 通道", API_CATALOG.every((e) => /^[A-Za-z]+[:.]/.test(e.channel)), API_CATALOG.find((e) => !/^[A-Za-z]+[:.]/.test(e.channel)));
check("清单里没有构建机绝对路径", !API_CATALOG.some((e) => /[A-Z]:\/|\/home\//.test(e.input + e.output)));
// **返回结构也要摊开**(报告附录 D 的 B3)。从前只有入参摊第一层字段,返回值是具名接口的
// 方法(如 `browser.*` 返 `BrowserOpResult`)在清单里只写一个名字 —— agent 拼得出参数却
// **猜不出返回里有哪些字段**,只能试错。判据立在"绝大多数方法的返回不再是光秃秃一个类型名"
// 上:留一点余量给 `Record<string,string>` 这种本来就该原样显示的。
{
  const bare = API_CATALOG.filter((e) => /^"?[A-Z][A-Za-z0-9]*"?$/.test(e.output.trim()));
  check(
    "绝大多数方法的返回结构已摊开(不再是光秃秃的类型名)",
    bare.length <= 5,
    bare.map((e) => `${e.method} → ${e.output}`),
  );
  // 抽样钉一个**具名接口**的返回**真的摊开了**。
  //
  // ⚠️ **样本必须是"修复前会退化成一个光秃秃类型名"的方法**,否则这条守着一条恒真的式子。
  //   初版抽的是 `git.status`,而它返回内联对象 `{ status: GitStatusResult; }` —— 修复前后
  //   都含 `{` 和 `GitStatusResult`,**区分不出修复**(独立复核实测:这条在变异下没红)。
  //   `browser.create` 修复前是 `BrowserCreateResult`(裸名)、修复后是判别联合的字段 ——
  //   拿它做判据才真的承重。
  const sample = API_CATALOG.find((e) => e.method === "browser.create");
  check(
    "抽样:browser.create 的返回摊出了字段(修复前只是一个裸的 BrowserCreateResult)",
    sample !== undefined && sample.output.includes("browserId") && !/^\s*"?BrowserCreateResult"?\s*$/.test(sample.output.trim()),
    sample?.output,
  );
}
const levels = new Map<string, number>();
for (const e of API_CATALOG) levels.set(policyFor(e.method).level, (levels.get(policyFor(e.method).level) ?? 0) + 1);
check("五档都有人", ["read", "write", "danger", "blocked", "ui"].every((l) => (levels.get(l) ?? 0) > 0), [...levels]);
// 每个在清单里出现的域都必须有 `DOMAIN_LABELS` 标签 —— 否则 `app_api_list` 按域列目录时
// 那一行是「- <域>(N):」后面空着,agent 读不出这域是干什么的。`engineTools` / `extensionStore`
// 两个域当初就是这样漏的(独立复核挑出)。
{
  const domains = new Set(API_CATALOG.map((e) => e.method.split(".")[0] ?? ""));
  const unlabeled = [...domains].filter((d) => !(d in DOMAIN_LABELS));
  check("清单里每个域都有 DOMAIN_LABELS 标签(没有无名域)", unlabeled.length === 0, unlabeled);
}
const pin: Array<[string, string]> = [
  ["claude.approve", "blocked"],
  ["claude.respondQuestion", "blocked"],
  ["workflow.approve", "blocked"],
  ["customModel.getToken", "blocked"],
  // 中继配置含明文 SSH 密码 —— 与 customModel.getToken / *Models.getApiKey 同类,
  // 必须同档(报告附录 C:「relay.getConfig 靠按**键名**打码兜底,换个字段名就漏」)。
  // 判据钉在这一档上,别让后来者把它降回 read。
  ["relay.getConfig", "blocked"],
  ["session.saveMessages", "blocked"],
  ["plugins.installGit", "danger"],
  ["mcp.save", "danger"],
  ["hooks.save", "danger"],
  ["project.delete", "danger"],
  ["setting.set", "danger"],
  ["publicMcp.setEnabled", "danger"],
  ["publicMcp.addProjectLink", "danger"],
  ["app.moveDataRoot", "danger"],
  ["session.rename", "write"],
  ["project.create", "write"],
  ["library.createCollection", "write"],
  ["project.list", "read"],
  ["session.messages", "read"],
  ["git.status", "read"],
  ["setting.get", "read"],
  ["notification.focusSession", "ui"],
  ["totally.newThing", "write"],
  // ★ **动词前缀的陷阱(C4/权限,2026-10-08)**:`READ_VERB` 是**前缀**匹配
  // (`^history`、`^check`、`^task` 都算"只读"),而 `browser.historyClear` 只是**以
  // `history` 开头**——它其实清空浏览历史。`git.checkout` 同理:以 `check` 开头,实际会
  // **切换分支、改工作区文件**。这类"名字像只读、实际会写"的必须钉在显式表里,否则
  // agent 能不经审批跑它们。
  ["browser.historyClear", "write"],
  ["browser.historyRemove", "write"],
  ["git.checkout", "write"],
];
for (const [m, l] of pin) check(`权限 ${m} = ${l}`, policyFor(m).level === l, policyFor(m));
// 凡是名字里带 getToken / getApiKey 的都不能是可读档
for (const e of API_CATALOG) {
  if (/getToken|getApiKey/i.test(e.method)) check(`${e.method} 不开放`, policyFor(e.method).level === "blocked");
}
// ★ **系统性兜底:不许"名字像只读、后缀却是破坏性动作"的方法自动放行。**
// `READ_VERB` 是前缀匹配,`browser.historyClear`(`history` 开头)与 `git.checkout`
// (`check` 开头)会误落只读档 —— 这两个是已发现的实例,但**将来新增的同类**也要被拦。
// 判据:方法名的动作部分以只读词开头、**紧接着的剩余部分恰好是一个破坏性动词**
// (clear/remove/delete/reset/drop/kill/truncate/wipe/checkout) → 不得是 read/ui。
// 用"恰好等于"而不是"包含",是为了不误伤 `showCommit`(rest=`Commit`,只读)、
// `checkForUpdates`(rest=`ForUpdates`,只读)这类"只读词 + 宾语名词"。
{
  const DESTRUCTIVE = new Set(["clear", "remove", "delete", "reset", "drop", "kill", "truncate", "wipe", "checkout"]);
  const READ_PREFIX = /^(list|get|read|status|search|info|stats|overview|catalog|history|runs|sessions|tasks|task|has|show|preview|check|describe|count)/;
  const misread = API_CATALOG.filter((e) => {
    const verb = e.method.slice(e.method.lastIndexOf(".") + 1);
    const rest = verb.replace(READ_PREFIX, "");
    if (verb === rest) return false; // 压根不是只读词开头
    // 破坏性动作可能整段就是(`git.checkout` → 前缀吃掉 `check` 剩 `out`,所以要看整词),
    // 也可能是剩余部分(`historyClear` → `Clear`)。两者任一命中即算。
    const isDestructive = DESTRUCTIVE.has(verb.toLowerCase()) || DESTRUCTIVE.has(rest.toLowerCase());
    if (!isDestructive) return false;
    const lvl = policyFor(e.method).level;
    return lvl === "read" || lvl === "ui";
  });
  check(
    "★ 没有「名字像只读、实际会写」的方法被放行",
    misread.length === 0,
    misread.map((e) => `${e.method}=${policyFor(e.method).level}`),
  );
}

/* ── 2. 打码 ── */
const red = redactValue({
  apiKey: "abc",
  nested: { authToken: "zzz", ok: "fine", list: [{ password: "p" }] },
  url: "https://x.trycloudflare.com/mcp/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  note: "key sk-ant-1234567890abcdefXYZ here",
  bin: new Uint8Array(10),
  enabled: true,
  tokenCount: 0,
  usage: { inputTokens: 1200 },
  credentials: { user: "me", nested: { v: "pw" }, n: 3 },
}) as Record<string, unknown>;
check("字段名打码", red.apiKey === REDACTED && (red.nested as Record<string, unknown>).authToken === REDACTED, red);
check("数组里也打码", JSON.stringify(red).includes(`"password":"${REDACTED}"`), red);
check("普通字段不动", (red.nested as Record<string, unknown>).ok === "fine");
check("公网 MCP 路径密钥打码", !String(red.url).includes("AbCdEf"), red.url);
check("sk- 形态打码", !String(red.note).includes("sk-ant-1234"), red.note);
check("二进制只报长度", red.bin === "[二进制 10 字节]", red.bin);
check("布尔/数字不被当密钥", red.enabled === true && red.tokenCount === 0 && (red.usage as { inputTokens: number }).inputTokens === 1200, red);
check("凭据字段之下的字符串全隐藏", JSON.stringify(red.credentials) === JSON.stringify({ user: REDACTED, nested: { v: REDACTED }, n: 3 }), red.credentials);
// 「长十六进制一律当密钥」那条会误伤 **git 的 40 位 SHA** 与**库的内容哈希**(64 位 sha256):
// 它们不是秘密,而是 `appControl` 交给模型的真数据 —— 打码后 agent 拿到的 `hash` 是
// `[已隐藏]`,既串不起 `git.log` → `git.showCommit`,也按不了 sha 引用库文件。
// 修法:字段名**像哈希**(hash/sha…/parent/etag…)时豁免那格,但字段名**像凭据**仍严格优先。
const hex40 = "abcdef0123456789abcdef0123456789abcdef01";
const hex64 = "a".repeat(64);
const hashRed = redactValue({
  hash: hex40,
  shortHash: hex40.slice(0, 8),
  parents: [hex40],
  pdfSha256: hex64,
  actionToken: hex40,
  privateKeyHash: hex40,
}) as Record<string, unknown>;
check("git 提交 SHA 原样给模型(不是密钥)", hashRed.hash === hex40, hashRed.hash);
check("父提交 SHA 也原样", (hashRed.parents as string[])[0] === hex40, hashRed.parents);
check("库内容哈希(pdfSha256)原样", hashRed.pdfSha256 === hex64, hashRed.pdfSha256);
check("同名但不像哈希的短 sha 也不动", hashRed.shortHash === hex40.slice(0, 8), hashRed.shortHash);
check("★字段名像凭据仍严格优先(actionToken 命中 token)", hashRed.actionToken === REDACTED, hashRed.actionToken);
check("★字段名像凭据仍严格优先(privateKeyHash 命中 private…key)", hashRed.privateKeyHash === REDACTED, hashRed.privateKeyHash);
check("裸字符串那句(redactString 默认仍认长十六进制)", redactString(hex40) === REDACTED, redactString(hex40));
// ★ 内容寻址的**文件路径**要放行(报告真机实测 NEW-1)。资料库的文件名就是 sha256,
//   于是 `pdfPath` / `entryPath` 整串是 hex;从前一律打成 `[已隐藏].pdf`,**指不到文件**,
//   而同一篇的 `pdfSha256`(字段名像哈希)却原样返回 —— 遮了无害路径、露了哈希,里外不一致。
//   判据:这一段 hex 是**路径里的一节**(左 `/`\、右 `.`/`\`)就放行;散在文字里/成串的仍打。
const caPath = `papers/66/1b/${hex64}.pdf`;
check("★内容寻址的文件路径不打码(agent 要拿它去读 PDF)", redactString(caPath) === caPath, redactString(caPath));
check(
  "★库相对路径字段整串保留(pdfPath / mdPath)",
  (redactValue({ pdfPath: caPath, mdPath: `markdown/${hex64}.md` }) as { pdfPath: string; mdPath: string }).pdfPath === caPath &&
    (redactValue({ mdPath: `markdown/${hex64}.md` }) as { mdPath: string }).mdPath === `markdown/${hex64}.md`,
);
check("散在文字里的裸 hex 仍打码(不是路径)", redactString(`see ${hex40} here`).includes(REDACTED));
check("整串就是一个 token 的 hex 仍打码", redactString(hex40) === REDACTED);
check("超长截断并说明", renderResult("x".repeat(50), 10).includes("已截断"));
// ★ 列表里的会话行要摘掉"整份内容"级的大字段(报告真机实测 NEW-2):`session.listAll`
//   从前把每条会话的 `turnFiles`(本轮改动的**文件前后全文**)、`subagents` 等 JSON blob
//   原样回给模型 —— 一次"列会话"就打爆上下文。判据:列表里摘、单条读不摘。
{
  const big = "x".repeat(50000);
  const sess = { id: "s1", kind: "chat", providerId: "claude-sdk", title: "T", turnFiles: [{ before: big, after: big }], usageHistory: [1, 2, 3], todos: null };
  const listed = slimSessions({ sessions: [sess], total: 1 }) as { sessions: Array<Record<string, unknown>> };
  check("★列表里会话的大字段被摘成计数(turnFiles)", typeof listed.sessions[0].turnFiles === "string" && String(listed.sessions[0].turnFiles).includes("1 项"), listed.sessions[0].turnFiles);
  check("★列表里 usageHistory 也被摘", typeof listed.sessions[0].usageHistory === "string", listed.sessions[0].usageHistory);
  check("列表里该留的字段照留(id/title)", listed.sessions[0].id === "s1" && listed.sessions[0].title === "T");
  check("列表里 null 的字段保持 null(不是编个计数)", listed.sessions[0].todos === null);
  // 单条读:不摘 —— agent 确实可能想看"这一轮改了哪些文件"。
  const single = slimSessions({ session: sess }) as { session: Record<string, unknown> };
  check("★单条读出时不摘(顶层/命名对象里的会话保持完整)", Array.isArray(single.session.turnFiles), single.session.turnFiles);
  check("列表里的非会话对象不动", JSON.stringify(slimSessions({ a: [{ turnFiles: [1] }] })) === JSON.stringify({ a: [{ turnFiles: [1] }] }));
  // 关键:摘过之后,一页几十条不再爆。
  const page = slimSessions({ sessions: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, kind: "chat", turnFiles: [{ before: big, after: big }] })) });
  check("★40 条会话一页不再超过结果上限(摘前必爆)", renderResult(page).length < 40000);
}

/* ── 3. 审批闸门 ── */
const calls: Record<string, unknown[]> = {};
function fake(channel: string, ret: unknown = { ok: true }): void {
  calls[channel] = [];
  recordRpcHandler(channel, async (_e, raw) => {
    calls[channel]!.push(raw);
    return typeof ret === "function" ? (ret as (r: unknown) => unknown)(raw) : ret;
  });
}
clearRpcHandlers();
fake("project:list", { projects: [{ id: "p1", name: "demo", path: "/x" }] });
fake("session:rename", { session: { id: "s9", title: "new" } });
fake("plugins:installGit", { ok: true });
fake("claude:approve");
fake("setting:get", { value: "secret-ish", apiKey: "k" });
const zodHandler = async (_e: unknown, raw: unknown) => {
  const { z } = await import("zod");
  return z.object({ id: z.string() }).parse(raw);
};
recordRpcHandler("session:archive", zodHandler);
// ★ **无参/全可选方法:agent 省略 `input` 时必须调得通。** 真实 `projects.ts` 的
// `session:listAll` handler **照抄**在这里(它的入参 limit/offset/projectIds/worktreeKey
// **全可选**,所以 `app_api_call { method: "session.listAll" }` 不带 input 是合法调用)。
// 若 `callRpc` 不把 `undefined` 补成 `{}`,`z.object({...all optional}).parse(undefined)`
// 会报根级 `Required` —— agent 永远调不通这个功能,而 `app_api_describe` 明说它的参数都可选。
{
  const { SessionListAllSchema } = await import("@contracts/ipc/session");
  recordRpcHandler("session:listAll", async (_e, raw) => {
    const input = SessionListAllSchema.parse(raw); // 与 src/main/ipc/projects.ts:237 一字不差
    // `parsedOk` 是显式标记 —— `limit` 全缺省时 `JSON.stringify` 会把它整条丢掉,
    // 拿 `gotLimit` 当"解析成功"的证据会假红。
    // ★ 顺带让这一条 stub 带**一条真实形状的会话**(含"整份内容"级大字段),这样
    // 下面 `app_api_call session.listAll` 那条能**端到端**断言瘦身真的生效 ——
    // 独立复核发现:只测 `slimSessions` 纯函数的话,把接线 `renderResult(slimSessions(...))`
    // 改回 `renderResult(...)` 套件**照样全绿**(见 `__slimProbe`)。`parsedOk` 仍要带
    // (另一条断言靠它证明"省略 input 也解析成功")。
    const big = "x".repeat(4000);
    return {
      parsedOk: true,
      limit: input.limit ?? null,
      hasMore: false,
      total: 1,
      sessions: [
        {
          id: "s1", kind: "chat", providerId: "claude-sdk", title: "T", projectId: "p1",
          turnFiles: [{ before: big, after: big }],
          usageHistory: Array.from({ length: 30 }, () => ({ t: 1 })),
          subagentTranscripts: { a: [{ text: big }] },
          bookmarks: [{ id: "b1" }],
          todos: [{ id: "t1", text: "x" }],
        },
      ],
    };
  });
}

interface Asked { req: ApprovalRequest }
function ctxWith(opts: { mode?: string; allow?: boolean; always?: Set<string>; noApproval?: boolean } = {}): { ctx: ProviderContext; asked: Asked[] } {
  const asked: Asked[] = [];
  const ctx = {
    getPermissionMode: () => opts.mode,
    isToolAlwaysAllowed: (name: string) => opts.always?.has(name) ?? false,
    ...(opts.noApproval
      ? {}
      : {
          requestApproval: async (req: ApprovalRequest): Promise<ProviderApprovalDecision> => {
            asked.push({ req });
            return { allow: opts.allow ?? true };
          },
        }),
  } as unknown as ProviderContext;
  return { ctx, asked };
}
const call = (method: string, input: unknown, ctx: ProviderContext) => invokeAppTool("app_api_call", { method, input }, "me", ctx);

{
  const { ctx, asked } = ctxWith();
  const r = await call("project.list", undefined, ctx);
  check("只读:不问、直接返回", !r.isError && asked.length === 0 && textOf(r).includes("demo"), textOf(r));
}
{
  const { ctx, asked } = ctxWith({ allow: false });
  const r = await call("session.rename", { id: "s9", title: "new" }, ctx);
  check("写:被拒 → 不执行", r.isError === true && calls["session:rename"]!.length === 0, textOf(r));
  check("写:审批卡 toolName 按方法", asked[0]?.req.toolName === "mcode-app:session.rename", asked[0]?.req.toolName);
}
{
  const { ctx, asked } = ctxWith({ allow: true });
  const r = await call("session.rename", { id: "s9", title: "new" }, ctx);
  check("写:批准 → 执行且传参原样", !r.isError && asked.length === 1 && (calls["session:rename"]!.at(-1) as { title: string }).title === "new", textOf(r));
}
{
  const { ctx, asked } = ctxWith({ always: new Set(["mcode-app:session.rename"]) });
  await call("session.rename", { id: "s9", title: "a" }, ctx);
  check("始终允许按方法生效", asked.length === 0);
}
{
  const { ctx, asked } = ctxWith({ mode: "bypassPermissions" });
  await call("session.rename", { id: "s9", title: "b" }, ctx);
  check("完全访问:写不问", asked.length === 0);
  const before = calls["plugins:installGit"]!.length;
  await call("plugins.installGit", { url: "https://x/y.git" }, ctx);
  check("完全访问:高风险照问", asked.length === 1 && asked[0]!.req.toolName === `${APP_DANGER_APPROVAL_PREFIX}plugins.installGit`, asked.map((a) => a.req.toolName));
  check("高风险批准后才执行", calls["plugins:installGit"]!.length === before + 1);
}
{
  const { ctx, asked } = ctxWith({ always: new Set([`${APP_DANGER_APPROVAL_PREFIX}plugins.installGit`, "mcode-app:plugins.installGit"]) });
  await call("plugins.installGit", { url: "u" }, ctx);
  check("高风险:始终允许不认", asked.length === 1);
}
{
  const { ctx, asked } = ctxWith({ mode: "plan" });
  const before = calls["session:rename"]!.length;
  const r = await call("session.rename", { id: "s9", title: "c" }, ctx);
  check("计划模式:写被拒、不问、不执行", r.isError === true && asked.length === 0 && calls["session:rename"]!.length === before, textOf(r));
}
{
  const { ctx, asked } = ctxWith({ mode: "bypassPermissions" });
  const r = await call("claude.approve", { requestId: "x", allow: true }, ctx);
  check("不开放:直接拒、不问、不执行", r.isError === true && asked.length === 0 && calls["claude:approve"]!.length === 0, textOf(r));
}
{
  const { ctx } = ctxWith({ noApproval: true });
  const before = calls["session:rename"]!.length;
  const r = await call("session.rename", { id: "s9", title: "d" }, ctx);
  check("没有审批通道:fail-closed", r.isError === true && calls["session:rename"]!.length === before, textOf(r));
}
{
  const { ctx } = ctxWith();
  const r = await call("setting.get", { key: "x" }, ctx);
  check("返回值打码", !textOf(r).includes('"k"') && textOf(r).includes(REDACTED), textOf(r));
}

/* ── 2b. 密钥设置键:setting.get 直读那条旁路 ── */
// `customModel.getToken` / `piModels.getApiKey` / `codexModels.getApiKey` 都显式
// 钉在 blocked 档(「API Key / 令牌不给模型」)。但设置表里那几份**密钥本体**是普通
// 设置键,而 `setting.get` 是 `read` 档、**自动放行** —— 于是同一个东西换条路就拿到了:
// `app_api_call { method: "setting.get", input: { key: "customModelKeys" } }`。而
// renderResult 的打码只认字段名与值的形态,`customModelKeys` 的**值**是一张
// `id → base64(密文)` 的表,id 是随机串、密文不含 `sk-` 之类,两道都绕过了。
{
  const calls2: Record<string, unknown[]> = {};
  // 不 clearRpcHandlers():本文件后面的断言还要用先前那批 handler。只覆盖这两条。
  // 每一条都是**真实存在**的设置键,值是它真正的形状(整块 JSON 字符串、里面嵌着凭据)。
  const SECRET_VALUES: Record<string, string> = {
    customModelKeys: JSON.stringify({ c1: "RU5DSVBIRVJFRF9BUFBfS0VZ" }),
    piProviderKeys: JSON.stringify({ p1: "RU5DSVBIRVJFRF9BUFBfS0VZ" }),
    codexProviderKeys: JSON.stringify({ c1: "RU5DSVBIRVJFRF9BUFBfS0VZ" }),
    "relay.vpsConfig": JSON.stringify({ host: "1.2.3.4", sshPort: 22, username: "root", password: "S3cr3t-vps-pw!", publicPort: 7331 }),
    "onlyoffice.config": JSON.stringify({ baseUrl: "http://x", jwtSecret: "my-jwt-signing-secret-abc" }),
    "publicMcp.projectLinks": JSON.stringify([{ projectId: "p1", secret: "Pr0j3ctL1nkS3cr3t-abcdefghijklmnop", sessionId: null }]),
    "mobile.pairedDevices": JSON.stringify([{ deviceId: "dev_ab12", name: "Pixel", pairedAt: 1, lastSeenAt: 1, deviceToken: "0123456789abcdef".repeat(4) }]),
    // MCP server 的 env/headers 里常放 API key / Authorization 头,而键名不含密钥词。
    "mcp.management": JSON.stringify({ userServers: { gh: { type: "stdio", command: "npx", env: { GITHUB_TOKEN: "ghp_SENTINEL_MCP_TOKEN_1234567890" } } } }),
  };
  recordRpcHandler("setting:get", async (_e, raw) => {
    const k = (raw as { key?: string }).key ?? "";
    // 真实 handler 直读设置表,这里照抄那份"密钥本体在表里"的事实。
    return { value: SECRET_VALUES[k] ?? "ok" };
  });
  recordRpcHandler("setting:getMany", async (_e, raw) => {
    const keys = (raw as { keys?: string[] }).keys ?? [];
    return Object.fromEntries(keys.map((k) => [k, SECRET_VALUES[k] ?? "ok"]));
  });
  void calls2;
  const { ctx } = ctxWith();
  const single = await call("setting.get", { key: "customModelKeys" }, ctx);
  check(
    "★ setting.get 不许直读密钥设置键(customModelKeys)",
    single.isError === true && !textOf(single).includes("RU5DSVBIRVJFRF9BUFBfS0VZ"),
    textOf(single),
  );
  const many = await call("setting.getMany", { keys: ["ui.locale", "customModelKeys"] }, ctx);
  check(
    "★ setting.getMany 也不许夹带密钥设置键",
    many.isError === true || !textOf(many).includes("RU5DSVBIRVJFRF9BUFBfS0VZ"),
    textOf(many),
  );
  // 同一形状的另两个密钥本体(piProviderKeys / codexProviderKeys),以及它们的结构性
  // 名字 —— 逐个往名单里加是追着漏,判据要落在**键名的形状**上。
  for (const key of ["piProviderKeys", "codexProviderKeys"]) {
    const r = await call("setting.get", { key }, ctx);
    check(`★ setting.get 不许直读 ${key}`, r.isError === true, textOf(r));
  }
  // 结构性判据必须**不分大小写**:`settingsTransfer.ts` 的孪生规则(导出时剔)带 `/i`,
  // 这边若不带就会漂开 —— 一个全小写的 `providerkeys` 能经 setting.get 交给模型、
  // 却在导出时被剔掉。全小写/全大写两种写法都要被挡。
  for (const key of ["providerkeys", "PROVIDERTOKENS"]) {
    const r = await call("setting.get", { key }, ctx);
    check(`★ 结构性判据不分大小写:${key} 也被挡`, r.isError === true, textOf(r));
  }
  // ⚠️ **"整块 JSON、键名不含密钥词"的另几个实例(2026-10-09)。** 它们的键名
  // (`relay.vpsConfig` / `onlyoffice.config` / `publicMcp.projectLinks` / `mobile.pairedDevices`)
  // 两道键名正则都不命中,而值是**一个字符串**,里面嵌着 `password`/`jwtSecret`/`secret`/
  // `deviceToken`。`renderResult` 只按值的**形态**认密钥,认不出前面三个 —— 而
  // `mobile.pairedDevices` 的令牌**恰好**是 64 位十六进制、被"值的形态"那道偶然拦下,
  // 但那条判据依赖令牌恰好是这个编码,换个编码就漏。
  //
  // 判据立在**`isError === true`(按键名拒读)**上 —— 这是与 customModelKeys 同一条规矩,
  // 而不是"碰巧被值打码拦下"。撤掉名单 → 这几条立刻红。marker 只作额外保险(证明明文
  // 确实没进返回文本)。
  const LEAK_KEYS: Array<[string, string]> = [
    ["relay.vpsConfig", "S3cr3t-vps-pw!"],
    ["onlyoffice.config", "my-jwt-signing-secret-abc"],
    ["publicMcp.projectLinks", "Pr0j3ctL1nkS3cr3t-abcdefghijklmnop"],
    ["mobile.pairedDevices", "dev_ab12"],
    ["mcp.management", "ghp_SENTINEL_MCP_TOKEN_1234567890"],
  ];
  for (const [key, marker] of LEAK_KEYS) {
    const r = await call("setting.get", { key }, ctx);
    check(`★ setting.get 按键名拒读密钥设置键(${key})`, r.isError === true && !textOf(r).includes(marker), textOf(r));
  }
  // getMany 夹带同样要拦(与逐条读同一条规矩)。
  for (const [key, marker] of LEAK_KEYS) {
    const r = await call("setting.getMany", { keys: ["ui.locale", key] }, ctx);
    check(`★ setting.getMany 不许夹带 ${key}`, r.isError === true && !textOf(r).includes(marker), textOf(r));
  }
}
{
  const { ctx } = ctxWith({ mode: "bypassPermissions" });
  const r = await call("session.archive", { nope: 1 }, ctx);
  check("参数错误说人话", r.isError === true && textOf(r).includes("参数不对") && textOf(r).includes("app_api_describe"), textOf(r));
}
{
  // ★ **`app_api_call` 明说「无参方法省略 `input`」—— 省略时必须真的调得通。**
  // 全可选的 `session.listAll` 不带 input 调一次;若 `callRpc` 不补 `{}`,handler 里那句
  // `SessionListAllSchema.parse(raw)`(与生产一字不差)会抛根级 `Required`,这条立刻红。
  // 与它并列的还有 `undefined` 与 `null` 两种"空参"写法,一并钉住。
  const { ctx } = ctxWith();
  const omitted = await invokeAppTool("app_api_call", { method: "session.listAll" }, "me", ctx);
  check("★ 全可选方法省略 input 也能调通(不再 (根) Required)", omitted.isError !== true && textOf(omitted).includes("parsedOk"), textOf(omitted));
  // ★ **端到端**:这一条走的是 `invokeAppTool → app_api_call → 真 handler` 的完整链路,
  // 断言 agent **实际拿到**的返回里大字段已被摘成计数、关键字段仍在、没有那坨内容。
  // (纯函数断言在上面 §2;这条钉的是"接线真的接上了",独立复核挑出的无覆盖面。)
  {
    const out = textOf(omitted);
    check("★ 端到端:session.listAll 回给 agent 的 turnFiles 已摘成计数", out.includes("1 项") && !out.includes("x".repeat(200)), out.slice(0, 200));
    check("★ 端到端:subagentTranscripts(真正的 transcript blob)也被摘", !out.includes("x".repeat(200)), out.slice(0, 120));
    check("★ 端到端:关键字段(id/title/kind)仍在", out.includes('"s1"') && out.includes('"T"') && out.includes("chat"));
  }
  const explicitNull = await call("session.listAll", null, ctx);
  check("★ input: null 也当无参处理", explicitNull.isError !== true, textOf(explicitNull));
  // 反向控制:真缺**必填**参数的方法仍然照常报错(补 `{}` 不能把必填校验一起放行)。
  const stillRejects = await call("session.archive", undefined, ctx);
  check("正控:缺必填参数的方法仍被拦(未吞掉校验)", stillRejects.isError === true, textOf(stillRejects));
}
{
  const { ctx } = ctxWith();
  const r = await call("no.such", {}, ctx);
  check("未知方法", r.isError === true && textOf(r).includes("app_api_list"), textOf(r));

  // **猜错名字要给"你是不是要找"**(报告 D3)。报告的原话:工具名不可猜、无校验,agent
  // 实测栽在 `session.list`(真名 `session.listAll`)、`browser.list`、`usage.stats` 上,
  // 每次都只得到一句"没有这个方法",于是下一轮**还是靠猜**。名字都在目录里,给一句
  // 最接近的没有成本,却把试错变成"照着改一个字"。
  {
    // 报告里实测栽的那三个 —— 每一个都必须指到真名上。
    const guess = await call("session.list", {}, ctx);
    check(
      "★ 猜 `session.list` → 提示 `session.listAll`",
      textOf(guess).includes("session.listAll"),
      textOf(guess),
    );
    // 目录里没有 `usage.stats`,但同域有 `usage.*` —— 至少不能指到毫不相干的域上去。
    const usage = suggestMethod("usage.stats");
    check(
      "猜 `usage.stats` → 要么不提,要么提同域的",
      usage === undefined || usage.startsWith("usage."),
      usage,
    );
    // 前缀命中:漏了后半截是最常见的一种猜法。
    check("suggestMethod 命中前缀", suggestMethod("session.list") === "session.listAll", suggestMethod("session.list"));
    check("完全不像 → 不硬猜", suggestMethod("qqqzzz") === undefined, suggestMethod("qqqzzz"));
    check("空串 → 不提", suggestMethod("  ") === undefined);
    // **别指到另一件事上**:提示要么是那个真名,要么什么都没有 —— 不能给一个和输入
    // 八竿子打不着的名字。`project.list` 真存在,所以这里得挑一个目录里明确没有的。
    const nonsense = suggestMethod("nonsense.zzz");
    check("八竿子打不着的不提", nonsense === undefined, nonsense);
  }
  const listed = await invokeAppTool("app_api_list", {}, "me", ctx);
  check("app_api_list 目录", textOf(listed).includes("project(") && textOf(listed).includes("app_api_describe"), textOf(listed).slice(0, 200));
  // **几道门要在总览里说清**(报告 D4)。agent 从前得自己猜走哪道门 —— 在 app_api_list
  // 里找不到 browser_*/agent_*,就以为那些能力不存在。判据立在"每道门的名字都在总览里"
  // 上,而不是"有说明文字"。
  {
    const overview = textOf(listed);
    for (const door of ["app_panel_api_list", "browser_*", "agent_*", "app_ui", "app_workflow_run"]) {
      check(`总览点到了这道门:${door}`, overview.includes(door), overview.slice(0, 500));
    }
  }
  const dom = await invokeAppTool("app_api_list", { domain: "plugins" }, "me", ctx);
  check("app_api_list 按域、带权限档", textOf(dom).includes("plugins.installGit [高风险·每次批准]"), textOf(dom).slice(0, 300));
  const desc = await invokeAppTool("app_api_describe", { method: "session.rename" }, "me", ctx);
  check("app_api_describe 有参数格式", textOf(desc).includes("参数:") && textOf(desc).includes("title"), textOf(desc));
}

/* ── 自定义面板/扩展的对外接口(app_panel_api_list)──
 *
 * 报告 E11:`app_api_list` 只列能被 `app_api_call` 调的主进程方法,**不含**面板
 * `window.mcode` 那套,也不含挂载位(slot)能用的动作 / 变量 —— agent 想写面板只能去
 * grep 源码。这段钉住:新工具**确实**能把面板 API、槽位动作、模板变量报出来,且
 * 报的是 `@contracts` 里那份既有 constants(数量逐条对齐),不是另写的一份说明。
 */
{
  const { ctx, asked } = ctxWith();
  const panelTool = appMcpTools().find((t) => t.name === "app_panel_api_list");
  check("app_panel_api_list 在工具表里", panelTool !== undefined);
  check("★ app_panel_api_list 是只读(在 APP_READONLY_TOOLS,自动放行)", APP_READONLY_TOOLS.has("app_panel_api_list"));

  // ★ 总览:面板方法 / 挂载位 / 图标 / 主题变量四份清单都要在,且条数与 constants 一致。
  //   除非判据立在"报的内容 = constants 的内容"上,否则说明表与契约漂开了也照样绿。
  const overview = await invokeAppTool("app_panel_api_list", {}, "me", ctx);
  const ov = textOf(overview);
  check("★ 面板方法全部列出(且只读,不问审批)", !overview.isError && asked.length === 0, ov.slice(0, 200));
  check("★ 面板方法数 = PANEL_METHODS.length", PANEL_METHODS.every((m) => ov.includes(`mcode.${m}`)), {
    missing: PANEL_METHODS.filter((m) => !ov.includes(`mcode.${m}`)),
  });
  // 每个挂载位都要出现,并带上它的动作与变量(判据落在真正的表格内容上,不是只数个数)。
  const slotMissing = CUSTOM_UI_SLOTS.filter((s) => !ov.includes(s));
  check("★ 挂载位全部列出", slotMissing.length === 0, slotMissing);
  check(
    "★ 每个挂载位都报了动作类型与模板变量",
    CUSTOM_UI_SLOTS.every((s) => ov.includes(ACTIONS_BY_SLOT[s].join("/")) && ov.includes(TEMPLATE_VARS_BY_SLOT[s].join("/"))),
    CUSTOM_UI_SLOTS.filter((s) => !(ov.includes(ACTIONS_BY_SLOT[s].join("/")) && ov.includes(TEMPLATE_VARS_BY_SLOT[s].join("/")))),
  );
  check("★ 图标白名单条数 = CUSTOM_UI_ICONS.length", CUSTOM_UI_ICONS.every((i) => ov.includes(i)));
  check("★ 主题变量 = PANEL_THEME_VARS", PANEL_THEME_VARS.every((v) => ov.includes(v)));
  // 名字里的"共 N 个"必须与 constants 的真实条数对上(防漂)。
  check(`方法数标注与实际一致(${PANEL_METHODS.length})`, ov.includes(`共 ${PANEL_METHODS.length} 个方法`), ov.match(/共 \d+ 个方法/)?.[0]);
  check(`挂载位数标注与实际一致(${CUSTOM_UI_SLOTS.length})`, ov.includes(`共 ${CUSTOM_UI_SLOTS.length} 个挂载位`), ov.match(/共 \d+ 个挂载位/)?.[0]);

  // 展开一个面板方法:说明 + 参数 + 返回。
  const read = await invokeAppTool("app_panel_api_list", { method: "files.read" }, "me", ctx);
  check("★ 展开面板方法给说明/参数/返回", !read.isError && textOf(read).includes("mcode.files.read()") && textOf(read).includes("参数:") && textOf(read).includes("path"), textOf(read));
  // 前缀带不带 `mcode.` 都认。
  const dotted = await invokeAppTool("app_panel_api_list", { method: "mcode.api.call" }, "me", ctx);
  check("★ 面板方法名接受 mcode. 前缀", !dotted.isError && textOf(dotted).includes("api.call"), textOf(dotted));
  // 覆盖较隐晦的几个,靠说明能区分语义。
  const shell = await invokeAppTool("app_panel_api_list", { method: "shell" }, "me", ctx);
  check("★ shell 面板方法说明了它在哪跑/要确认", !shell.isError && textOf(shell).includes("终端") && textOf(shell).includes("确认"), textOf(shell));
  // 不知道的方法如实报错。
  const bad = await invokeAppTool("app_panel_api_list", { method: "no.such.panel.method" }, "me", ctx);
  check("★ 未知面板方法:如实报错、不静默", bad.isError === true && textOf(bad).includes("没有这个方法"), textOf(bad));
  // ★ 每个方法都要明说「这一步会不会弹确认」(报告附录 Q2:作者最常问的一句,从前只能靠试)。
  const write = await invokeAppTool("app_panel_api_list", { method: "files.write" }, "me", ctx);
  check("★ files.write 标了「需要确认」", !write.isError && textOf(write).includes("是否需要确认:是"), textOf(write));
  const readOnly = await invokeAppTool("app_panel_api_list", { method: "files.read" }, "me", ctx);
  check("★ files.read 标了「不需要确认」", !readOnly.isError && textOf(readOnly).includes("是否需要确认:否"), textOf(readOnly));
  // ★ storage 的手册要与实现一致(报告附录 Q2:手册还写"浏览器 localStorage / 1MB",其实已改到扩展目录 / 4MB)。
  const storageSet = await invokeAppTool("app_panel_api_list", { method: "storage.set" }, "me", ctx);
  const ss = textOf(storageSet);
  check("★ storage.set 手册说清存在扩展目录、不是 localStorage", !storageSet.isError && ss.includes("扩展") && !ss.includes("localStorage"), ss);
  check("★ storage.set 手册给的配额是 4MB(与 EXTENSION_STORE_MAX 一致)", ss.includes("4MB"), ss);

  // 展开一个挂载位:动作类型 + 模板变量。
  const slot = await invokeAppTool("app_panel_api_list", { slot: "library.item" }, "me", ctx);
  const st = textOf(slot);
  check("★ 展开挂载位给动作类型与模板变量", !slot.isError && st.includes("library.item") && ACTIONS_BY_SLOT["library.item"].every((a) => st.includes(a)) && TEMPLATE_VARS_BY_SLOT["library.item"].every((v) => st.includes(v)), st);
  // 不同的挂载位动作集不同 —— 页签只有 view/file/panel,不能被工具抹平成"都一样"。
  const tab = await invokeAppTool("app_panel_api_list", { slot: "rightPanel.tab" }, "me", ctx);
  check(
    "★ 页签挂载位的动作集确实是它自己的(view/file/panel)",
    !tab.isError && ACTIONS_BY_SLOT["rightPanel.tab"].every((a) => textOf(tab).includes(a)) && !textOf(tab).includes("automation"),
    textOf(tab),
  );
  const badSlot = await invokeAppTool("app_panel_api_list", { slot: "no.such.slot" }, "me", ctx);
  check("★ 未知挂载位:如实报错", badSlot.isError === true && textOf(badSlot).includes("没有这个挂载位"), textOf(badSlot));

  // agent 经 app_api_call 够不到面板 API 本身(它不是主进程 RPC),但**能查** —— 这正是可发现性。
  check("面板 API 不是 app_api_call 的主进程方法(靠工具查,不靠调)", !API_CATALOG.some((e) => e.method === "app_panel_api_list"));
}

/* ── 3b. ARC-009:控制命令必须区分「操作成功 / 通知失败 / 持久化不确定」──
 *
 * ## 这条守的是一个真洞(源码可确认的旧行为)
 *
 * `app_api_call` 从前在 RPC **已经成功**之后调 `notifyAppSettingWrite`(界面刷新通知)。
 * 通知一抛错,就 `return fail("操作已完成,但桌面刷新通知失败…")` —— 返回给 Agent 的是
 * **失败**,可数据副作用已经落定。Agent 按 fail 重试一个非幂等操作(发消息 / 建资源)
 * 就会**重复执行**。
 *
 * ## 失败注入怎么做的
 *
 * `setting.set` 的 `notifyAppSettingWrite` 只有当 `key === CUSTOM_UI_SETTING_KEY` 时才走
 * `sendToRenderer`。本套的 `--alias:@main/window.js=./stubs/window.ts` 让被测代码与脚本
 * 解析到**同一个**桩文件,桩里的 `__setSendToRendererThrows(true)` 就能让"通知"这一步真的
 * 抛 —— 而 RPC(`setting:set`)照常提交。于是精确复现"业务已提交、通知失败"那一刻。
 *
 * 旧行为下:该调用返回的 ToolResult `isError === true` → 下面第一条断言就红。
 */
{
  __clearOperationLog();
  __setSendToRendererThrows(false);
  const setCalls: unknown[] = [];
  recordRpcHandler("setting:set", async (_e, raw) => {
    setCalls.push(raw);
    // **副作用真的发生了一次**(这里以"记录到第 N 次"代表写档 + persist 成功)。
    return { ok: true, saved: true };
  });
  const opArgs = (extra: Record<string, unknown> = {}) => ({
    method: "setting.set",
    input: { key: CUSTOM_UI_SETTING_KEY, value: JSON.stringify({ items: [] }) },
    ...extra,
  });

  // ① 正常路径:提交 + 通知都成功 → SUCCEEDED,没有 warning。
  {
    const { ctx } = ctxWith({ allow: true }); // setting.set 是 danger 档 → 需批准(这里放行)
    const r = await invokeAppTool("app_api_call", opArgs(), "me", ctx);
    check("ARC-009 正常路径:是 SUCCEEDED", opResultOf(r)?.resultKind === "SUCCEEDED", opResultOf(r));
    check("ARC-009 正常路径:无 warning", (opResultOf(r)?.warnings as unknown[] | undefined)?.length === 0, opResultOf(r));
    check("ARC-009 正常路径:副作用恰好一次", setCalls.length === 1, setCalls.length);
  }

  // ② 失败注入:通知抛错,但 RPC 已提交 → 必须是 SUCCEEDED_WITH_WARNINGS,**不是失败**。
  {
    const { ctx } = ctxWith({ allow: true });
    __setSendToRendererThrows(true);
    const opId = "arc009-notify-fail-1";
    const r = await invokeAppTool("app_api_call", opArgs({ operation_id: opId }), "me", ctx);
    __setSendToRendererThrows(false);
    const op = opResultOf(r);
    // ★ 核心:旧行为这里 isError===true(整个调用被判失败)。修复后绝不设 isError。
    check("★ ARC-009:通知失败**不再**返回失败(isError 不设)", r.isError !== true, { isError: r.isError, text: textOf(r) });
    check("★ ARC-009:通知失败 → SUCCEEDED_WITH_WARNINGS", op?.resultKind === "SUCCEEDED_WITH_WARNINGS", op);
    // 警告必须**可观测**(字段层)—— 不是吞掉异常报一句纯成功。
    const w = (op?.warnings as Array<{ code?: string; message?: string }> | undefined)?.[0];
    check("★ ARC-009:warning 可观测(code = ui_refresh_failed)", w?.code === "ui_refresh_failed", w);
    check("★ ARC-009:warning 带真实原因(不吞异常)", typeof w?.message === "string" && w!.message!.includes("刷新通知失败"), w);
    // 文本层也要带上 —— 三个 SDK 都读这行字。
    check("★ ARC-009:文本里能读到「已提交」与警告原因", textOf(r).includes("已提交") && textOf(r).includes("刷新通知失败"), textOf(r).slice(0, 240));
    check("★ ARC-009:文本提醒不要因警告重复执行", textOf(r).includes("不要"), textOf(r).slice(0, 240));
    // 已提交的操作**不可重试**(不然 Agent 会盲目重跑非幂等操作)。
    check("★ ARC-009:已提交的操作 retryable=false", op?.retryable === false, op?.retryable);
    check("★ ARC-009:通知失败这次副作用也只执行一次", setCalls.length === 2, setCalls.length);
  }

  // ③ 幂等重放:带**同一 operationId** 再调一次 → 不重复执行(即便通知现在能成功)。
  {
    const { ctx } = ctxWith({ allow: true });
    const opId = "arc009-notify-fail-1";
    const r = await invokeAppTool("app_api_call", opArgs({ operation_id: opId }), "me", ctx);
    check("★ ARC-009:同一 operationId 重放**不再重复执行**", setCalls.length === 2, setCalls.length);
    check("★ ARC-009:重放返回同一 resultKind(不升级成成功)", opResultOf(r)?.resultKind === "SUCCEEDED_WITH_WARNINGS", opResultOf(r));
    check("★ ARC-009:重放文本点明未重复执行", textOf(r).includes("重放"), textOf(r).slice(0, 160));
  }

  // ④ RPC **未执行** → REJECTED(没有副作用)。
  {
    const { ctx } = ctxWith({ allow: true });
    const before = setCalls.length;
    const r = await invokeAppTool("app_api_call", { method: "no.such.method", input: {} }, "me", ctx);
    check("★ ARC-009:方法不存在 = REJECTED", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
    check("★ ARC-009:REJECTED 仍是错误返回(isError)", r.isError === true, r.isError);
    check("★ ARC-009:REJECTED 没有副作用", setCalls.length === before, setCalls.length);

    // 审批被拒也是"命令没执行" → REJECTED(不是 FAILED)。
    const { ctx: denyCtx } = ctxWith({ allow: false });
    const rej = await invokeAppTool("app_api_call", opArgs(), "me", denyCtx);
    check("★ ARC-009:审批被拒 = REJECTED(命令没执行)", opResultOf(rej)?.resultKind === "REJECTED" && setCalls.length === before, opResultOf(rej));
    check("★ ARC-009:REJECTED 可安全重试(retryable=true)", opResultOf(rej)?.retryable === true, opResultOf(rej));
  }

  // ⑤ 写档 RPC 抛错(可能已部分落定)→ **UNCERTAIN,绝不标成功**,且不可重试。
  {
    const { ctx } = ctxWith({ allow: true });
    recordRpcHandler("setting:set", async () => { throw new Error("fsync 失败:磁盘不可写"); });
    const r = await invokeAppTool("app_api_call", opArgs({ operation_id: "arc009-unc-1" }), "me", ctx);
    check("★ ARC-009:写档 RPC 抛错 = UNCERTAIN(不是 SUCCEEDED)", opResultOf(r)?.resultKind === "UNCERTAIN", opResultOf(r));
    check("★ ARC-009:UNCERTAIN 仍带 isError", r.isError === true, r.isError);
    check("★ ARC-009:UNCERTAIN 不可重试(retryable=false,不盲目重跑)", opResultOf(r)?.retryable === false, opResultOf(r));
    check("★ ARC-009:UNCERTAIN 文本提醒先查状态再决定", textOf(r).includes("不确定") && textOf(r).includes("不要"), textOf(r).slice(0, 240));
    // 恢复一个正常 handler,免得后面若有用到。
    recordRpcHandler("setting:set", async (_e, raw) => { setCalls.push(raw); return { ok: true, saved: true }; });
  }
  __setSendToRendererThrows(false);
}

/* ── 3c. MC-067:operationId 必须绑定**调用者与意图** ──────────────────────────
 *
 * 旧行为(源码可确认):`operationLog` 只按 `operationId` **字符串**缓存已完成结果 ——
 *   ① 换会话/换方法/换参数复用同一 id 会命中旧结果(B 没执行却拿到 A 的回执);
 *   ② 两个并发请求都能穿过缓存各执行一次;
 *   ③ RPC 抛错(UNCERTAIN)没记入缓存,同 id 再试仍会真调一次。
 * 修法是**可信操作账本**(意图身份 + 原子领取 + 全态结算):同 id 换意图 → CONFLICT;
 * 同意图并发 → 只执行一次;UNCERTAIN 同 id 重试 → 回旧 UNCERTAIN,不盲发第二次。
 *
 * 下面三组是台账列出的**长期回归红例**,撤掉账本改造立即真红。
 */
{
  __clearOperationLog();
  const execs: unknown[] = [];
  // `setting.set` 是 danger 档(有副作用);这里真执行一次就记一次(代表副作用发生)。
  recordRpcHandler("setting:set", async (_e, raw) => {
    execs.push(raw);
    return { ok: true, saved: true };
  });
  const setInput = (v: string) => ({ key: CUSTOM_UI_SETTING_KEY, value: JSON.stringify({ v }) });
  const apiCall = (session: string, extra: Record<string, unknown>, ctx: ProviderContext) =>
    invokeAppTool("app_api_call", { method: "setting.set", input: setInput("x"), ...extra }, session, ctx);
  const { ctx: okCtx } = ctxWith({ allow: true });

  // ① 跨会话同 id、**不同意图** → 绝不串单:B 要么执行、要么明确 CONFLICT,**绝不**拿 A 的回执。
  {
    const before = execs.length;
    const a = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("first"), operation_id: "MC067-XS" }, "sess-A", okCtx);
    const aExecs = execs.length - before;
    const b = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("DIFFERENT"), operation_id: "MC067-XS" }, "sess-B", okCtx);
    const opA = opResultOf(a);
    const opB = opResultOf(b);
    check("★ MC-067①:A 先执行成功", aExecs === 1 && opA?.resultKind === "SUCCEEDED", { aExecs, opA });
    check("★ MC-067①:跨会话同 id 不同意图 → B **不**拿 A 的成功回执", opB?.resultKind !== "SUCCEEDED", opB);
    check("★ MC-067①:B 得到明确 CONFLICT(operation_id_conflict)", opB?.code === "operation_id_conflict", opB);
    check("★ MC-067①:B 没有重复执行", execs.length - before === 1, execs.length - before);
  }

  // ② 同会话**并发**同 id、同意图 → 只执行**一次**。
  {
    const before = execs.length;
    const [r1, r2] = await Promise.all([
      invokeAppTool("app_api_call", { method: "setting.set", input: setInput("race"), operation_id: "MC067-RACE" }, "sess-A", okCtx),
      invokeAppTool("app_api_call", { method: "setting.set", input: setInput("race"), operation_id: "MC067-RACE" }, "sess-A", okCtx),
    ]);
    const kinds = [opResultOf(r1)?.resultKind, opResultOf(r2)?.resultKind];
    check("★ MC-067②:并发同意图同 id 只执行一次", execs.length - before === 1, execs.length - before);
    check("★ MC-067②:一次 SUCCEEDED、一次被挡在途(不双执行)", kinds.filter((k) => k === "SUCCEEDED").length === 1, kinds);
  }

  // ③ UNCERTAIN 后同 id 重试 → **不重复执行**,仍回 UNCERTAIN。
  {
    let first = true;
    recordRpcHandler("setting:set", async (_e, raw) => {
      if (first) { first = false; execs.push(raw); throw new Error("fsync 失败:磁盘不可写"); }
      execs.push(raw);
      return { ok: true, saved: true };
    });
    const before = execs.length;
    const r1 = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("unc"), operation_id: "MC067-UNC" }, "sess-A", okCtx);
    const r2 = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("unc"), operation_id: "MC067-UNC" }, "sess-A", okCtx);
    check("★ MC-067③:UNCERTAIN 第一次", opResultOf(r1)?.resultKind === "UNCERTAIN", opResultOf(r1));
    check("★ MC-067③:同 id 重试不重复执行(仍 UNCERTAIN)", execs.length - before === 1 && opResultOf(r2)?.resultKind === "UNCERTAIN", { execs: execs.length - before, r2: opResultOf(r2) });
    check("★ MC-067③:重试文本点明未重复执行", textOf(r2).includes("重放") || textOf(r2).includes("不要再"), textOf(r2).slice(0, 160));
  }

  // ④ 授权复核:同 id 同意图的历史成功,若**授权已收紧**(只读/计划模式) → 不复述原结果。
  {
    // 正常 ctx 下提交一个 setting.set(有副作用),记下它的成功。
    const r1 = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("rev"), operation_id: "MC067-REV" }, "sess-A", okCtx);
    check("★ MC-067④:正常提交成功(打底)", opResultOf(r1)?.resultKind === "SUCCEEDED", opResultOf(r1));
    // 同样的 id/意图,但这次在**只读/计划模式**下重试 → 授权已收紧,不复述原成功。
    const { ctx: planCtx } = ctxWith({ mode: "plan" });
    const r2 = await invokeAppTool("app_api_call", { method: "setting.set", input: setInput("rev"), operation_id: "MC067-REV" }, "sess-A", planCtx);
    const op2 = opResultOf(r2);
    check("★ MC-067④:授权收紧后重放 → 不复述原成功", op2?.resultKind !== "SUCCEEDED", op2);
    check("★ MC-067④:授权收紧后重放 → REJECTED(明确不执行)", op2?.resultKind === "REJECTED", op2);
  }

  __clearOperationLog();
}

/* ── 3c-bis. MC-084:账本领取**未落盘**时,app_api_call 绝不执行副作用 ────────────
 *
 * 洞(源码可确认的旧行为):`DurableOperationLedger.begin` 领到 CLAIMED 后只 `persist()`
 * (250ms 异步合并)就回 `claimed`,于是"领取成功但没落盘"时崩溃,重启后同 id 会**再次领取
 * 并重复执行外部副作用**。修法:领取后同步 durable,失败回 `claim-not-durable`;`tools.ts`
 * 收到这个结果值**绝不执行**,直接返回拒绝。
 *
 * 这里用**可注入的桩账本**精确复现该结果值(真实 fsync 路径的跨进程红例在 run-store-smoke):
 * 桩 begin 返回 claim-not-durable,断言 RPC handler **一次都没被调用**,且结果是明确拒绝、
 * 带 claim_not_durable 短码、可重试。撤掉 tools.ts 里那个分支 → 桩的 claimed 会落到执行,
 * 断言立刻红。 */
{
  __clearOperationLog();
  let rpcCalls = 0;
  recordRpcHandler("setting:set", async () => { rpcCalls += 1; return { ok: true }; });
  const notDurableLedger: OperationLedger = {
    begin: (intent) => ({ begin: "claim-not-durable", record: { ...intent, status: "CLAIMED", updatedAt: Date.now() } }),
    settle: () => { /* 不会执行到 */ },
    get: () => undefined,
  };
  setOperationLedger(notDurableLedger);
  const { ctx } = ctxWith({ allow: true });
  const r = await invokeAppTool(
    "app_api_call",
    { method: "setting.set", input: { key: CUSTOM_UI_SETTING_KEY, value: "{}" }, operation_id: "MC084-ND" },
    "sess-A",
    ctx,
  );
  const op = opResultOf(r);
  check("★ MC-084:领取未落盘时 RPC **一次都没执行**(副作用 0)", rpcCalls === 0, rpcCalls);
  check("★ MC-084:领取未落盘 → REJECTED(明确不执行)", op?.resultKind === "REJECTED", op);
  check("★ MC-084:带 claim_not_durable 稳定短码(区别于普通拒绝)", op?.code === "claim_not_durable", op);
  check("★ MC-084:可安全重试(retryable=true)", op?.retryable === true, op?.retryable);
  __clearOperationLog();
}

/* ── 3d. MC-066:业务层 ok:false 不能被回报成 SUCCEEDED ───────────────────────
 *
 * 旧行为:`callRpc` 只要 Promise resolve 就 `makeOp("SUCCEEDED")`。而 `ipc/browser.ts`
 * 的 `browser:create` 对未知 projectPath **合法返回** `{ok:false,error:...}`(不抛异常)
 * —— 业务明确拒绝,`app_api_call` 却报 SUCCEEDED。修法:显式登记结果合同,`decodeDomainOutcome`
 * 把 ok:false 判成 REJECTED。**不在任意 JSON 上做字符串规则推断**。
 */
{
  __clearOperationLog();
  const { ctx } = ctxWith({ allow: true });
  // 与 `ipc/browser.ts:44-58` 一字不差的合法拒绝(不是我构造的异常)。
  recordRpcHandler("browser:create", async (_e, raw) => {
    const projectPath = String((raw as { projectPath?: string }).projectPath ?? "");
    if (projectPath.includes("not-registered")) {
      return { ok: false as const, error: "未知项目路径，拒绝创建浏览器" };
    }
    return { ok: true as const, browserId: "br_1" };
  });

  // 红例:browser.create 合法 ok:false → isError=true、resultKind 不再 SUCCEEDED。
  {
    const r = await invokeAppTool("app_api_call", { method: "browser.create", input: { projectPath: "C:/fake/not-registered" } }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:browser.create 合法 ok:false → 不再 SUCCEEDED", op?.resultKind !== "SUCCEEDED", op);
    check("★ MC-066:browser.create 合法 ok:false → isError=true", r.isError === true, r.isError);
    check("★ MC-066:browser.create 合法 ok:false → REJECTED(命令没执行)", op?.resultKind === "REJECTED", op);
    check("★ MC-066:拒绝原因原样带出(未知项目路径)", textOf(r).includes("未知项目路径"), textOf(r).slice(0, 200));
  }

  // 正控:ok:true 的真成功仍是 SUCCEEDED(解码器不能把真成功也判成拒绝)。
  {
    const r = await invokeAppTool("app_api_call", { method: "browser.create", input: { projectPath: "C:/proj" } }, "me", ctx);
    check("★ MC-066 正控:browser.create ok:true → SUCCEEDED", opResultOf(r)?.resultKind === "SUCCEEDED" && r.isError !== true, opResultOf(r));
  }

  // ★ 判据是**按模块显式登记**,不是「任意 JSON 上 ok===false 就 retryable」:
  //   一个**没登记** ok/error 合同的方法(project.list)返回 `{ok:false}` 仍算成功 ——
  //   证明解码器只对显式登记的方法生效,不对任意返回做字符串规则推断。
  {
    recordRpcHandler("project:list", async () => ({ ok: false, error: "这不是拒绝，只是一份普通数据里的字段" }));
    const r = await invokeAppTool("app_api_call", { method: "project.list", input: {} }, "me", ctx);
    check("★ MC-066:未登记合同的方法不被 ok:false 误判(不靠字符串规则推断)", opResultOf(r)?.resultKind === "SUCCEEDED", opResultOf(r));
  }

  // 恢复 project:list 的正常形状,免得后面若有用到。
  recordRpcHandler("project:list", async () => ({ projects: [{ id: "p1", name: "demo", path: "/x" }] }));
}

/* ── 3d-2. 【MC-066 / 第 46.1 节】Git 域的合法拒绝也必须判 REJECTED/UNCERTAIN ──
 *
 * 第 45 轮独立 E1:`ipc/git.ts` 的 git.commit/stage/pull 对「仓库不属于任何已添加项目」
 * **合法返回** `{ok:false,error}`(不抛),但 `commandOutcome.ts` 只登记了 browser.* /
 * automation.run / customModel.test —— git.* 落到「无 descriptor = accepted」,把明确拒绝
 * 报成 SUCCEEDED。这里与 `ipc/git.ts` 一字不差地录同一份 ok:false 信封。
 * 分类:纯本地写(stage)拒绝 → REJECTED;可能部分落定的(push/pull)→ UNCERTAIN。 */
{
  __clearOperationLog();
  const { ctx } = ctxWith({ allow: true });
  recordRpcHandler("git:stage", async () => ({ ok: false as const, error: "仓库路径不在任何已添加的项目内" }));
  recordRpcHandler("git:push", async () => ({ ok: false as const, error: "认证失败,请检查凭据" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "git.stage", input: { repoPath: "C:/not-registered", filePaths: ["a.txt"] } }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:git.stage 合法 ok:false → 不再 SUCCEEDED", op?.resultKind !== "SUCCEEDED", op);
    check("★ MC-066:git.stage 合法 ok:false → REJECTED(没执行)", op?.resultKind === "REJECTED", op);
    check("★ MC-066:git.stage 拒绝原因原样带出", textOf(r).includes("不在任何已添加的项目内"), textOf(r).slice(0, 200));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "git.push", input: { repoPath: "C:/proj" } }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:git.push 合法 ok:false → UNCERTAIN(可能已部分落定,不盲目重试)", op?.resultKind === "UNCERTAIN", op);
  }
}

/* ── 3d-3. 【MC-066 残余①】terminal.* 的合法拒绝也必须判 REJECTED ────────────
 *
 * `ipc/terminal.ts` 的 `terminal:create` 对未知项目路径 / cwd 越界**合法返回**
 * `{ok:false,error}`(不抛异常);`terminal:write`/`resize` 对不存在或已退出的终端同样
 * 合法返回 ok:false。它们从前**没登记**,`decodeDomainOutcome` 落到「无 descriptor =
 * accepted」,把业务拒绝报成 SUCCEEDED(isError=false),Agent 以为终端已建/命令已写入。
 * 全是本地进程操作、失败即"没执行" → `refusal`。这里与 `ipc/terminal.ts` 一字不差地
 * 录同一份 ok:false 信封。 */
{
  __clearOperationLog();
  const { ctx } = ctxWith({ allow: true });
  // 与 `ipc/terminal.ts:35` 一字不差的合法拒绝。
  recordRpcHandler("terminal:create", async (_e, raw) => {
    const projectPath = String((raw as { projectPath?: string }).projectPath ?? "");
    if (projectPath.includes("not-registered")) {
      return { ok: false as const, error: "未知项目路径，拒绝创建终端" };
    }
    return { ok: true as const, terminalId: "term_1" };
  });
  recordRpcHandler("terminal:write", async () => ({ ok: false as const, error: "终端不存在或已退出" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "terminal.create", input: { projectPath: "C:/fake/not-registered" } }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:terminal.create 合法 ok:false → 不再 SUCCEEDED", op?.resultKind !== "SUCCEEDED", op);
    check("★ MC-066:terminal.create 合法 ok:false → isError=true", r.isError === true, r.isError);
    check("★ MC-066:terminal.create 合法 ok:false → REJECTED(命令没执行)", op?.resultKind === "REJECTED", op);
    check("★ MC-066:terminal.create 拒绝原因原样带出(未知项目路径)", textOf(r).includes("未知项目路径"), textOf(r).slice(0, 200));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "terminal.write", input: { terminalId: "term_dead", data: "x" } }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:terminal.write 合法 ok:false → REJECTED(终端不在)", op?.resultKind === "REJECTED", op);
  }
  // 正控:ok:true 的真成功仍是 SUCCEEDED(解码器不能把真成功也判成拒绝)。
  {
    const r = await invokeAppTool("app_api_call", { method: "terminal.create", input: { projectPath: "C:/proj" } }, "me", ctx);
    check("★ MC-066 正控:terminal.create ok:true → SUCCEEDED", opResultOf(r)?.resultKind === "SUCCEEDED" && r.isError !== true, opResultOf(r));
  }
  // relay:与 `ipc/relay.ts` / `RelayManager.ts` 一字不差地录同一份 ok:false 信封。
  // saveConfig 的 ok:false 是 zod 校验失败(没写任何设置)→ refusal;connect 的 ok:false
  // 可能在 SSH 已连、forwarder 已部署后才出现 → maybePartial(UNCERTAIN,不盲目重试)。
  recordRpcHandler("relay:saveConfig", async () => ({ ok: false as const, error: "入参不合法(host: 必填)" }));
  recordRpcHandler("relay:connect", async () => ({ ok: false, error: "未配置 VPS，请先填写服务器信息" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "relay.saveConfig", input: { host: "" } }, "me", ctx);
    check("★ MC-066:relay.saveConfig 合法 ok:false → REJECTED(没写设置)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "relay.connect", input: {} }, "me", ctx);
    check("★ MC-066:relay.connect 合法 ok:false → UNCERTAIN(可能已部分部署,不盲目重试)", opResultOf(r)?.resultKind === "UNCERTAIN", opResultOf(r));
  }

  // memory 域:save/delete/reviewDelete 的 ok:false 都是**写盘前的拒绝**(路径非法 /
  // 含疑似密钥 / revision 冲突——冲突时还没写;delete 不匹配就抛、没删;reviewDelete
  // 记忆不存在或指纹已变,同样在 delete 之前返回)。三者都没提交副作用 → REJECTED。
  recordRpcHandler("memory:save", async () => ({ ok: false as const, error: "记忆包含疑似私钥或访问密钥，未保存" }));
  recordRpcHandler("memory:delete", async () => ({ ok: false as const, error: "记忆已发生改动，未删除" }));
  recordRpcHandler("memory:reviewDelete", async () => ({ ok: false as const, error: "记忆不存在或不可读，请重新整理后再选择。" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "memory.save", input: { path: "global/facts/a.md", content: "x" } }, "me", ctx);
    check("★ MC-066:memory.save 合法 ok:false → REJECTED(没写盘)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "memory.delete", input: { path: "global/facts/a.md", expectedRevision: "r1" } }, "me", ctx);
    check("★ MC-066:memory.delete 合法 ok:false → REJECTED(没删)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "memory.reviewDelete", input: { path: "global/facts/a.md", digest: "d1" } }, "me", ctx);
    check("★ MC-066:memory.reviewDelete 合法 ok:false → REJECTED(没删)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }

  // library 只读域:readMarkdown / readPdf 是纯读,ok:false(条目不存在 / 没产物 /
  // 文件不在了)不改任何东西 → REJECTED。
  recordRpcHandler("library:readMarkdown", async () => ({ ok: false as const, error: "还没有转换产物", markdown: "", images: {}, skipped: [], dir: "", fileName: "" }));
  recordRpcHandler("library:readPdf", async () => ({ ok: false as const, error: "文件不在了", bytes: null }));
  {
    const r = await invokeAppTool("app_api_call", { method: "library.readMarkdown", input: { id: "item_1" } }, "me", ctx);
    check("★ MC-066:library.readMarkdown 合法 ok:false → REJECTED(纯读)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "library.readPdf", input: { id: "item_1" } }, "me", ctx);
    check("★ MC-066:library.readPdf 合法 ok:false → REJECTED(纯读)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }

  // engineTools 域:set 的 ok:false 是 zod 失败(没写)或 atomicWriteJson 抛错(目标保持
  // 原样,没有半套)→ REJECTED。
  recordRpcHandler("engineTools:set", async () => ({ ok: false as const, error: "工具名不合法" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "engineTools.set", input: { engine: "claude", exclude: ["Bash"] } }, "me", ctx);
    check("★ MC-066:engineTools.set 合法 ok:false → REJECTED(没写)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }

  // git.generateCommitMessage 是纯计算(生成提交信息),ok:false 不改仓库 → REJECTED。
  recordRpcHandler("git:generateCommitMessage", async () => ({ ok: false as const, error: "模型未返回有效内容" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "git.generateCommitMessage", input: { repoPath: "C:/proj", requestId: "r1" } }, "me", ctx);
    check("★ MC-066:git.generateCommitMessage 合法 ok:false → REJECTED(纯计算)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
}

/* ── 3d-4. 【MC-066 残余① 续】workflow.* 与 skills.* 的合法拒绝 ────────────────
 *
 * 同根因继续纵向迁移:`ipc/orchestration.ts` 的 workflow handler 与 `ipc/skills.ts` 的
 * 预设 handler,都对**合法**情形返回 `{ok:false,...}`(不抛异常),从前没登记 →
 * `decodeDomainOutcome` 落到「无 descriptor = accepted」→ `app_api_call` 报 SUCCEEDED。
 * 判据**按源码**:ok:false 在所有落库动作**之前**的 = refusal(REJECTED);走非原子写、
 * 中途失败可能截断文件的 = maybePartial(UNCERTAIN)。每条都与真 handler 一字不差地录
 * 同一份 ok:false 信封。 */
{
  __clearOperationLog();
  const { ctx } = ctxWith({ allow: true });

  // workflow.save → saveWorkflow:`{ok:false;error}` 三条(校验不过 / deriveTrigger 失败 /
  // expectedRevision 不是当前版)全在 WorkflowRepo.save 之前 → refusal。
  recordRpcHandler("workflow:save", async () => ({ ok: false as const, error: "工作流已被其他写者修改或删除；请保留草稿并重新打开最新版本后再合并" }));
  // workflow.import / importFromFile → importWorkflowInto/finishImport:`{ok:false;errors;warnings}`
  // —— 注意这条**没有 `error` 字段**,只有 `errors` 数组(整体拒绝,库里一个字节没变)。
  recordRpcHandler("workflow:import", async () => ({ ok: false as const, errors: ["图里有个环,而且环上没有岔路口"], warnings: [] }));
  recordRpcHandler("workflow:importFromFile", async () => ({ ok: false as const, errors: ["库里没有 id 为「wf_x」的工作流,覆盖不了不存在的一份"], warnings: [] }));
  // workflow.pinDefault → pinWorkflowDefault:「找不到」/「还在等审阅」在 SettingRepo.set 之前。
  recordRpcHandler("workflow:pinDefault", async () => ({ ok: false as const, error: "这一版还在等待审阅 —— 先在审阅里启用,再把它设为默认" }));
  // workflow.restoreDefault → restoreWorkflowDefault:唯一 ok:false 是「没钉过默认」,在 save 之前。
  recordRpcHandler("workflow:restoreDefault", async () => ({ ok: false as const, error: "这份工作流没有钉过默认 —— 先「设为默认」,才谈得上恢复" }));
  // workflow.retry → resolveWorkflowRetry:全部 {ok:false} 在 launchContinuation 之前(没运行被起)。
  recordRpcHandler("workflow:retry", async () => ({ ok: false as const, error: "原工作流已不可用，请重新选择工作流" }));
  // applyShippedUpdate / dismissShippedUpdate → 库函数:「不是自带的」/「已经删了」在落库之前。
  recordRpcHandler("workflow:applyShippedUpdate", async () => ({ ok: false as const, error: "这份工作流不是软件自带的,没有出厂版可以更新" }));
  recordRpcHandler("workflow:dismissShippedUpdate", async () => ({ ok: false as const, error: "这份工作流不是软件自带的,没有出厂版可以更新" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.save", input: { workflow: { id: "wf_1", nodes: [], edges: [], name: "x" } } }, "me", ctx);
    check("★ MC-066:workflow.save 合法 ok:false → 不再 SUCCEEDED", opResultOf(r)?.resultKind !== "SUCCEEDED", opResultOf(r));
    check("★ MC-066:workflow.save 合法 ok:false → REJECTED(没写库)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
    check("★ MC-066:workflow.save 拒绝原因原样带出", textOf(r).includes("其他写者修改"), textOf(r).slice(0, 200));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.import", input: { text: "{}" } }, "me", ctx);
    check("★ MC-066:workflow.import 合法 ok:false(errors[]) → REJECTED(没写库)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.importFromFile", input: {} }, "me", ctx);
    check("★ MC-066:workflow.importFromFile 合法 ok:false → REJECTED(没写库)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.pinDefault", input: { id: "wf_1" } }, "me", ctx);
    check("★ MC-066:workflow.pinDefault 合法 ok:false → REJECTED(没写设置)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.restoreDefault", input: { id: "wf_1" } }, "me", ctx);
    check("★ MC-066:workflow.restoreDefault 合法 ok:false → REJECTED(没写库)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.retry", input: { sessionId: "s1", runId: "run_1", nodeId: "n1" } }, "me", ctx);
    check("★ MC-066:workflow.retry 合法 ok:false → REJECTED(没起运行)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.applyShippedUpdate", input: { id: "wf_1" } }, "me", ctx);
    check("★ MC-066:workflow.applyShippedUpdate 合法 ok:false → REJECTED(没写库)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.dismissShippedUpdate", input: { id: "wf_1" } }, "me", ctx);
    check("★ MC-066:workflow.dismissShippedUpdate 合法 ok:false → REJECTED(没写设置)", opResultOf(r)?.resultKind === "REJECTED", opResultOf(r));
  }

  // workflow.export:三条 ok:false 里有**一条是 `fs.writeFile` 落盘失败** —— 走的是**非原子**
  // 写(先截断再写),失败时目标文件可能已被截断成半截 → 不能当"没执行" → maybePartial。
  recordRpcHandler("workflow:export", async () => ({ ok: false as const, error: "EACCES: permission denied, open 'D:/out/wf.json'" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.export", input: { id: "wf_1" } }, "me", ctx);
    check("★ MC-066:workflow.export 合法 ok:false → UNCERTAIN(非原子写,可能已截断)", opResultOf(r)?.resultKind === "UNCERTAIN", opResultOf(r));
  }

  // skills.presetsSave / presetsDelete:writePresets 走**非原子** `fs.mkdir + fs.writeFile`
  // —— 中途失败会把 .skill-presets.json 截断成半截 JSON,不是保持原样 → maybePartial。
  recordRpcHandler("skills:presetsSave", async () => ({ ok: false as const, error: "ENOSPC: no space left on device, write" }));
  recordRpcHandler("skills:presetsDelete", async () => ({ ok: false as const, error: "ENOSPC: no space left on device, write" }));
  {
    const r = await invokeAppTool("app_api_call", { method: "skills.presetsSave", input: { preset: { id: "p1", name: "一套", skills: [] } } }, "me", ctx);
    check("★ MC-066:skills.presetsSave 合法 ok:false → 不再 SUCCEEDED", opResultOf(r)?.resultKind !== "SUCCEEDED", opResultOf(r));
    check("★ MC-066:skills.presetsSave 合法 ok:false → UNCERTAIN(非原子写,可能半截)", opResultOf(r)?.resultKind === "UNCERTAIN", opResultOf(r));
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "skills.presetsDelete", input: { id: "p1" } }, "me", ctx);
    check("★ MC-066:skills.presetsDelete 合法 ok:false → UNCERTAIN(非原子写,可能半截)", opResultOf(r)?.resultKind === "UNCERTAIN", opResultOf(r));
  }

  // 正控:ok:true 的真成功仍是 SUCCEEDED(解码器不能把真成功判成拒绝)。
  recordRpcHandler("workflow:save", async () => ({ ok: true as const }));
  {
    const r = await invokeAppTool("app_api_call", { method: "workflow.save", input: { workflow: { id: "wf_1", nodes: [], edges: [], name: "x" } } }, "me", ctx);
    check("★ MC-066 正控:workflow.save ok:true → SUCCEEDED", opResultOf(r)?.resultKind === "SUCCEEDED" && r.isError !== true, opResultOf(r));
  }
}

/* ── 3d-5. 【MC-066 残余① 续】settingsTransfer 与 projectInit 域:**无明确可登记项** ──
 *
 * 按源码逐个判后,这两个域**都不该登记结果合同**,断言把这两条判据钉住(将来谁误登记 /
 * 误放开,这里先红):
 *
 *   ① `setting.exportToFile` / `setting.importFromFile` —— 它们的**合法返回确实是**
 *      `{ok:true,…} | {ok:false,canceled?|error?}` 信封(settingTransfer.ts 里一字不差),
 *      但两者都被 `policy.ts` 钉在 **blocked** 档(会弹系统保存/打开框、整批改写设置,
 *      只能用户本人在设置页操作)。`app_api_call` 的可达性在 `gateAppAction` 的
 *      `level === "blocked"` 分支就**返回**,**根本到不了** `callRpc`/`decodeDomainOutcome`
 *      —— 所以 `ok:false` 永远不可能被 agent 这条路误报成 SUCCEEDED,**没有要补的洞**。
 *   ② `projectInit.*` —— **逐方法读过 handler**(`ipc/projectInit.ts` → `projectInit/service.ts`):
 *      合法路径一律**抛异常**(`stored()` 找不到 / schema 校验 / revision 不符 / 上限……),
 *      只有 `delete`/`setDefault` 返回 `{ok:true}` —— **没有任何 `ok:false` 分支**。抛异常
 *      已由 tools.ts 的 catch 支路判成 REJECTED/UNCERTAIN,不归 `decodeDomainOutcome`。
 *      catalog 的 output 形状也印证:`projectInit.*` 无一条声明 ok:false。
 */
{
  __clearOperationLog();
  const { ctx } = ctxWith({ allow: true });

  // ② 判据锚:这两个域的方法**都不**是 ok/error 信封合同(没登记到 EXACT/FAMILIES)。
  //    将来谁把它们误加进 `commandOutcome.ts` 的 EXACT → 这里真红。
  check("★ MC-066:setting.exportToFile 未登记为 ok/error 信封合同(blocked 不可达)", isEnvelopeMethod("setting.exportToFile") === false);
  check("★ MC-066:setting.importFromFile 未登记为 ok/error 信封合同(blocked 不可达)", isEnvelopeMethod("setting.importFromFile") === false);
  for (const m of ["projectInit.list", "projectInit.get", "projectInit.save", "projectInit.delete", "projectInit.preview", "projectInit.apply", "projectInit.setDefault"]) {
    check(`★ MC-066:${m} 未登记为 ok/error 信封合同(handler 只抛异常/返回 ok:true)`, isEnvelopeMethod(m) === false);
  }
  // 正控:真正登记过的信封方法仍为 true(证明上面的 false 不是"判据整体失灵")。
  check("★ MC-066 正控:browser.create 仍是已登记的信封合同", isEnvelopeMethod("browser.create") === true);

  // ① 端到端:blocked 的 setting.* 经 app_api_call 调,**在 gateAppAction 就被拒**,
  //    并且**真 handler 一个字节没跑**(记一笔调用、断言为 0)。撤掉 policy.ts 里那两条
  //    BLOCKED → 闸门放行 → 未登记 → decodeDomainOutcome 落 accepted → SUCCEEDED,这里真红。
  let exportRan = 0;
  recordRpcHandler("setting:exportToFile", async () => { exportRan += 1; return { ok: false as const, canceled: true }; });
  recordRpcHandler("setting:importFromFile", async () => { exportRan += 1; return { ok: false as const, error: "坏的设置文件" }; });
  {
    const r = await invokeAppTool("app_api_call", { method: "setting.exportToFile", input: {} }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:setting.exportToFile 被 policy 钉死 → REJECTED(不是 SUCCEEDED)", op?.resultKind === "REJECTED", op);
    check("★ MC-066:setting.exportToFile 的稳定短码 = blocked", op?.code === "blocked", op?.code);
    check("★ MC-066:setting.exportToFile 真 handler 从未被调用(agent 到不了)", exportRan === 0, exportRan);
  }
  {
    const r = await invokeAppTool("app_api_call", { method: "setting.importFromFile", input: {} }, "me", ctx);
    const op = opResultOf(r);
    check("★ MC-066:setting.importFromFile 被 policy 钉死 → REJECTED(不是 SUCCEEDED)", op?.resultKind === "REJECTED", op);
    check("★ MC-066:setting.importFromFile 的稳定短码 = blocked", op?.code === "blocked", op?.code);
    check("★ MC-066:setting.importFromFile 真 handler 从未被调用(agent 到不了)", exportRan === 0, exportRan);
  }
}

{
  const bridge = new ApprovalBridge();
  const emitted: unknown[] = [];
  const ask = bridge.makeApprovalHandler("s1", (e) => emitted.push(e));
  const p1 = ask({ requestId: "r1", toolName: `${APP_DANGER_APPROVAL_PREFIX}project.delete`, input: {} });
  bridge.resolveApproval("r1", { allow: true }, true);
  const d1 = await p1;
  check("ApprovalBridge:高风险不带 persist", d1.allow === true && d1.persist !== true, d1);
  check("ApprovalBridge:高风险不记始终允许", !bridge.isAlwaysAllowed("s1", `${APP_DANGER_APPROVAL_PREFIX}project.delete`));
  const p2 = ask({ requestId: "r2", toolName: "mcode-app:session.rename", input: {} });
  bridge.resolveApproval("r2", { allow: true }, true);
  await p2;
  check("ApprovalBridge:普通写照常记", bridge.isAlwaysAllowed("s1", "mcode-app:session.rename"));
}

/* ── 5. 界面通道 ── */
{
  const seen: unknown[] = [];
  const win: Record<string, unknown> = {
    [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
      const cmd = JSON.parse(raw);
      seen.push(cmd);
      if (cmd.op === "state") return JSON.stringify({ ok: true, data: { activeSession: { id: "s1" } } });
      // 「读回」面板(报告 E10):渲染端返回它问到的渲染结果。
      if (cmd.op === "read_panel") {
        if (cmd.itemId === "missing") return JSON.stringify({ ok: false, error: "没有正在渲染 id 为「missing」的面板。" });
        return JSON.stringify({
          ok: true,
          data: {
            itemId: "p1", label: "我的面板", mode: "float", url: "mcode-panel://panel/x",
            text: "Hello panel", html: "<h1>Hello panel</h1>", textLength: 11, htmlLength: 22,
            // 版式摘要(报告 Q1):一个横向溢出 + 重叠的问题元素。
            layout: {
              viewport: { width: 300, height: 200 },
              content: { width: 400, height: 200 },
              elementCount: 2,
              elements: [
                { tag: "div", id: "a", x: 0, y: 0, w: 100, h: 40, text: "Hello panel", fontSize: "14px", color: "rgb(9, 9, 11)" },
                { tag: "span", cls: "bad", x: 10, y: 10, w: 380, h: 30, text: "wide" },
              ],
              problems: ["内容宽 400 > 视口宽 300(横向滚动)", '元素 span.bad "wide" 横向超出视口'],
            },
          },
        });
      }
      if (cmd.op === "open_panel") {
        if (cmd.itemId === "nope") return JSON.stringify({ ok: false, error: "配置里没有 id 为「nope」的自定义项。" });
        return JSON.stringify({ ok: true, data: { itemId: cmd.itemId, label: "我的面板", note: "面板已打开" } });
      }
      return JSON.stringify({ ok: true, data: { sessionId: "s2" } });
    },
  };
  (globalThis as Record<string, unknown>).window = win;
  setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });
  const { ctx, asked } = ctxWith();
  const st = await invokeAppTool("app_ui_state", {}, "me", ctx);
  check("界面状态一来一回", !st.isError && textOf(st).includes("s1") && asked.length === 0, textOf(st));
  const self = await invokeAppTool("app_session_send", { session_id: "me", prompt: "hi" }, "me", ctx);
  check("不能给自己发消息", self.isError === true && asked.length === 0, textOf(self));
  const sent = await invokeAppTool("app_session_send", { session_id: "other", prompt: "hi" }, "me", ctx);
  check("发消息先过审批再下指令", !sent.isError && asked.length === 1 && asked[0]!.req.toolName === "mcode-app:session_send" && (seen.at(-1) as { op: string }).op === "send", textOf(sent));
  const nav = await invokeAppTool("app_ui", { action: "open_session", session_id: "x" }, "me", ctx);
  check("纯界面操作不问", !nav.isError && asked.length === 1, textOf(nav));
  const pm = await invokeAppTool("app_ui", { action: "set_pref", key: "permissionMode", value: "bypassPermissions" }, "me", ctx);
  check("改权限模式 = 高风险", !pm.isError && asked.at(-1)!.req.toolName.startsWith(APP_DANGER_APPROVAL_PREFIX), asked.at(-1)?.req.toolName);

  // ★ 读回面板(报告 E10):只读 —— 不问审批,把渲染出来的文本给 agent。
  const askedBefore = asked.length;
  const read = await invokeAppTool("app_ui", { action: "read_panel" }, "me", ctx);
  check("★ read_panel 是只读(不问审批)", asked.length === askedBefore && !read.isError, { asked: asked.length, err: textOf(read) });
  check("★ read_panel 把面板渲染出来的可见文本给 agent",
    textOf(read).includes("Hello panel") && textOf(read).includes("我的面板"), textOf(read));
  // ★ 默认**不回 HTML**(报告 R2:HTML 常几万字符、是噪声)。只提一句"还有多少没显示"。
  check("★ read_panel 默认不把 HTML 塞进上下文(只报长度)", !textOf(read).includes("<h1>Hello panel</h1>") && textOf(read).includes("22"), textOf(read).slice(0, 200));
  check("★ read_panel 提示可用 include_html 取结构", textOf(read).includes("include_html"), textOf(read).slice(0, 200));
  // 显式索取才给。
  const readHtml = await invokeAppTool("app_ui", { action: "read_panel", include_html: true }, "me", ctx);
  check("★ read_panel include_html:true 才回 HTML", !readHtml.isError && textOf(readHtml).includes("<h1>Hello panel</h1>"), textOf(readHtml).slice(0, 200));
  check("★ read_panel 下发给渲染端的指令是对的", (seen.at(-1) as { op: string }).op === "read_panel", seen.at(-1));
  const readById = await invokeAppTool("app_ui", { action: "read_panel", item_id: "p1" }, "me", ctx);
  check("★ read_panel 带 item_id 时原样传给渲染端", !readById.isError && (seen.at(-1) as { itemId?: string }).itemId === "p1", seen.at(-1));
  // ★ 版式摘要(报告 Q1):agent 要能「看」出版式 —— 尺寸、元素矩形、以及问题清单。
  // 撤掉 tools.ts 的 renderPanelLayout → 下面几条真红。
  const rt = textOf(read);
  check("★ read_panel 给出版式:视口/内容尺寸", rt.includes("视口 300×200px") && rt.includes("内容 400×200px") && rt.includes("有滚动"), rt.slice(0, 400));
  check("★ read_panel 给出版式问题清单(横向超出视口)", rt.includes("版式问题") && rt.includes("横向超出视口"), rt.slice(0, 400));
  check("★ read_panel 列出关键元素(矩形+定位)", rt.includes("<div#a>") && rt.includes("@(0,0) 100×40"), rt.slice(0, 400));
  check("★ read_panel 元素带字号与颜色(判颜色字体对不对)", rt.includes("14px") && rt.includes("rgb(9, 9, 11)"), rt.slice(0, 400));
  const readMissing = await invokeAppTool("app_ui", { action: "read_panel", item_id: "missing" }, "me", ctx);
  check("★ 没有这个面板时如实报错(不静默)", readMissing.isError === true && textOf(readMissing).includes("missing"), textOf(readMissing));

  // ★ 开面板(自验闭环):open_panel 只读界面动作,不问审批,把 item_id 原样传下去。
  const askedBeforeOpen = asked.length;
  const opened = await invokeAppTool("app_ui", { action: "open_panel", item_id: "p1" }, "me", ctx);
  check("★ open_panel 不问审批(纯界面动作)", opened.isError !== true && asked.length === askedBeforeOpen, { asked: asked.length, err: textOf(opened) });
  check("★ open_panel 把 item_id 原样传给渲染端", (seen.at(-1) as { op: string; itemId?: string }).op === "open_panel" && (seen.at(-1) as { itemId?: string }).itemId === "p1", seen.at(-1));
  const openMissing = await invokeAppTool("app_ui", { action: "open_panel", item_id: "nope" }, "me", ctx);
  check("★ open_panel 缺 item_id 时报缺少参数", (await invokeAppTool("app_ui", { action: "open_panel" }, "me", ctx)).isError === true);
  check("★ open_panel 找不到配置项时如实报错", openMissing.isError === true && textOf(openMissing).includes("nope"), textOf(openMissing));

  const badUrl = await invokeAppTool("app_ui", { action: "open_url", url: "file:///etc/passwd" }, "me", ctx);
  check("open_url 只收 http(s)", badUrl.isError === true, textOf(badUrl));
  (globalThis as Record<string, unknown>).window = {};
  const notReady = await invokeAppTool("app_ui_state", {}, "me", ctx);
  check("界面没准备好时说清楚", notReady.isError === true && textOf(notReady).includes("界面还没准备好"), textOf(notReady));
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
}

/* ── 6. 接线(源码) ── */
const src = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
const claude = src("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
check("Claude 挂上 mcode-app", claude.includes("options.mcpServers[APP_MCP_SERVER] = await buildAppMcpServer("));
check("Claude canUseTool 对 app_ 放行(handler 自己审)", claude.includes("mcp__${APP_MCP_SERVER}__app_"));
const codex = src("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
check("Codex 动态工具挂上", codex.includes("...appToolDescriptors(),") && codex.includes("invokeAppEngineTool(name, args, req.sessionId, ctx)"));
const pi = src("src/main/providers/pi-sdk/mcodeExtension.ts");
check("Pi 注册并在守卫放行", pi.includes("for (const tool of appToolDescriptors())") && pi.includes('toolName.startsWith("app_")) return;'));
check("ipc/index.ts 登记 handler", src("src/main/ipc/index.ts").includes("recordRpcHandler(channel, guarded"));
check("审批卡认高风险前缀", src("src/renderer/components/chat/ApprovalPrompt.tsx").includes("APP_DANGER_APPROVAL_PREFIX"));
check("公网/扩展那条路不挂 mcode-app", !src("src/main/mcp/webToolHost.ts").includes("appMcpTools"));
check("描述符与工具表一致", appToolDescriptors().length === appMcpTools().length && appMcpTools().every((t) => isAppToolName(t.name)));
// ★ **功能清单必须与 RpcMap 逐条对齐,不是「数量差不多」。**
//
// 从前这里写的是 `Math.abs(rpcKeys - API_CATALOG.length) > 3` 才 `console.warn` —— 两层
// 都漏:`> 3` 的容差让 **1~3 条**的漂移静默通过(实测 `engineTools.get` / `engineTools.set`
// 就不在清单里,差 2 条,一直没报);而且它只是 `warn`,不是断言,套件照样绿。
//
// 后果是**可发现性**:`apiEntries()` 把「清单」与「实际注册过的通道」并起来(`findEntry`
// 走的是它),所以缺的那两条**调得到**——但只能通过注册那条兜底路径,拿到的说明是空的
// (`"(清单里没有说明,按报错提示传参)"`),`app_api_list` 按域列时也数不到它们。agent 也就
// 看不见「按引擎禁用内置工具」这个能力(设置 → 引擎工具),自然想不起来用。
// ⚠️ 别把它说成"调不到"——那是错的,兜底路径一直在。
//
// 判据用**集合**而不是计数:数目相等而成员不同的情形,恰恰是计数容差最容易放过的那种。
{
  const catalogMethods = new Set(API_CATALOG.map((e) => e.method));
  const rpcMethods = new Set(
    (src("../../packages/contracts/src/ipc/rpcMap.ts").match(/^\s+"([a-zA-Z]+\.[a-zA-Z.]+)":/gm) ?? [])
      .map((m) => m.trim().replace(/^"|":$/g, "")),
  );
  // 防"空过":正则改一行、或 rpcMap 的写法变了,两个集合双双变空 —— 上面那条对齐断言
  // 就成了"0 个缺、0 个多"的假绿。先钉住解析确实取到了东西。
  check("RpcMap 解析得到方法名（防断言空过）", rpcMethods.size > 300, rpcMethods.size);
  const missing = [...rpcMethods].filter((m) => !catalogMethods.has(m)).sort();
  const extra = [...catalogMethods].filter((m) => !rpcMethods.has(m)).sort();
  check(
    "★ 功能清单与 RpcMap 逐条对齐（差一条 agent 就看不见它的说明）",
    missing.length === 0 && extra.length === 0,
    { missing, extra, hint: "跑一次 node scripts/gen-app-api-catalog.mjs" },
  );
  // 钉住那两条曾漂移的:光对齐还不够,它们必须**真的在**清单里(免得将来又被别的手法漏掉)。
  check(
    "engineTools.get / engineTools.set 在清单里",
    catalogMethods.has("engineTools.get") && catalogMethods.has("engineTools.set"),
  );
}

/* ── 自定义面板的 `mcode.api.call`(`panelApiCall`)──
 *
 * 面板从前只能干写死的那 19 件事。这条把它接上**任意**主进程方法,复用 agent
 * `app_api_call` 的同一套分类。三件事必须成立:
 *   1. 只读方法直接执行(实测调到了那个 handler);
 *   2. 写档 / 高风险档**没带 `approved` 就不执行** —— 回 `needsApproval`,交回界面去问;
 *      带了 `approved` 才跑;
 *   3. 密钥设置键前置拦、blocked 档直接拒、返回值打码。
 * 还有一条**安全断言**:agent 经 `app_api_call` **够不到**这条口(否则传个
 * `{approved:true}` 就把面板那层确认整个绕过)。
 */
{
  check("★ customUi.panelApiCall 不在 agent 的可达范围(policyFor = blocked)",
    policyFor("customUi.panelApiCall").level === "blocked", policyFor("customUi.panelApiCall"));

  const panelCalls: Record<string, unknown[]> = {};
  const fakePanel = (channel: string, ret: unknown = { ok: true }): void => {
    panelCalls[channel] = [];
    recordRpcHandler(channel, async (_e, raw) => { panelCalls[channel]!.push(raw); return ret; });
  };
  fakePanel("project:list", { projects: [{ id: "p1", name: "demo", path: "/x" }] });
  fakePanel("session:rename", { session: { id: "s9", title: "new" } });
  fakePanel("project:delete", { ok: true });
  // 返回值里嵌着凭据 → 打码兜底。
  recordRpcHandler("session:listAll", async () => ({ sessions: [], apiKey: "sk-SENTINEL_PANEL_KEY_1234567890" }));

  const read = await panelApiCall("project.list", undefined, false, "我的面板");
  check("面板·只读:直接执行、不问",
    read.ok === true && panelCalls["project:list"]!.length === 1, read);

  panelCalls["session:rename"] = [];
  const writeNoApproval = await panelApiCall("session.rename", { id: "s9", title: "new" }, false, "我的面板");
  check("★ 面板·写档:没带 approved → 不执行、回 needsApproval",
    writeNoApproval.ok === false && writeNoApproval.needsApproval === true
      && writeNoApproval.level === "write" && panelCalls["session:rename"]!.length === 0,
    writeNoApproval);
  const writeApproved = await panelApiCall("session.rename", { id: "s9", title: "new" }, true, "我的面板");
  check("★ 面板·写档:带了 approved → 执行",
    writeApproved.ok === true && panelCalls["session:rename"]!.length === 1, writeApproved);

  panelCalls["project:delete"] = [];
  const dangerNoApproval = await panelApiCall("project.delete", { id: "p1" }, false, "我的面板");
  check("★ 面板·高风险档:同样要先确认(level = danger)",
    dangerNoApproval.ok === false && dangerNoApproval.needsApproval === true
      && dangerNoApproval.level === "danger" && panelCalls["project:delete"]!.length === 0,
    dangerNoApproval);

  const blocked = await panelApiCall("customModel.getToken", { id: "c1" }, true, "我的面板");
  check("面板·不开放档:直接拒", blocked.ok === false && typeof blocked.error === "string", blocked);

  const secret = await panelApiCall("setting.get", { key: "customModelKeys" }, true, "我的面板");
  check("★ 面板·密钥设置键:前置拦,不给内容",
    secret.ok === false && !JSON.stringify(secret).includes("RU5DSVBIRVJFRF9BUFBfS0VZ"), secret);

  const unknown = await panelApiCall("no.such.method", {}, true, "我的面板");
  check("面板·没有的方法:如实报错", unknown.ok === false && String(unknown.error).includes("没有这个方法"), unknown);

  const leaked = await panelApiCall("session.listAll", {}, false, "我的面板");
  check("★ 面板·返回值里的密钥被打码",
    leaked.ok === true && !JSON.stringify(leaked.result).includes("SENTINEL_PANEL_KEY"), leaked);
}

console.log(`\n${passed}/${passed + failures.length} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
