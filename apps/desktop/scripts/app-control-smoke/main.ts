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
import { redactValue, redactString, renderResult, REDACTED } from "@main/appControl/redact.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { invokeAppTool, appMcpTools, panelApiCall, APP_READONLY_TOOLS, suggestMethod } from "@main/appControl/tools.js";
import { appToolDescriptors, isAppToolName } from "@main/appControl/engineTools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import { ApprovalBridge } from "@main/claude/ApprovalBridge.js";
import {
  ACTIONS_BY_SLOT,
  CUSTOM_UI_ICONS,
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
    return { sessions: [], hasMore: false, total: 0, parsedOk: true, limit: input.limit ?? null };
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

/* ── 4. ApprovalBridge ── */
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
          data: { itemId: "p1", label: "我的面板", mode: "float", url: "mcode-panel://panel/x", text: "Hello panel", html: "<h1>Hello panel</h1>", textLength: 11, htmlLength: 22 },
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
  check("★ read_panel 下发给渲染端的指令是对的", (seen.at(-1) as { op: string }).op === "read_panel", seen.at(-1));
  const readById = await invokeAppTool("app_ui", { action: "read_panel", item_id: "p1" }, "me", ctx);
  check("★ read_panel 带 item_id 时原样传给渲染端", !readById.isError && (seen.at(-1) as { itemId?: string }).itemId === "p1", seen.at(-1));
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
