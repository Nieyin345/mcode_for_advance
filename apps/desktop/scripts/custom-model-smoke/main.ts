/**
 * Headless smoke for **`main/ipc/customModel.ts`** —— 用户自定义模型端点的那五条通道。
 *
 * ## 为什么单独一套
 *
 * 这个文件零覆盖，而它是**配置校验 + 存库**那一类代码：最容易出的不是崩溃，而是
 * 「该报的错不报」和「报了但报得看不懂」—— 本仓库反复出现的就是这两类真问题。
 * 所以这一套的判据都立在**用户实际看到的那行字**上：响应里吐出来的
 * `error.message`（设置页原样显示，见 `CustomModelsPanel.tsx` 的 `{error}` 那一行）。
 *
 * ## 这一套钉住的东西
 *
 *   1. **存进去读出来是不是同一份**（字段级对齐：baseUrl / models / headers / 超时…）；
 *   2. **删掉之后真的没了**（包括它那份密钥）；
 *   3. **同 id 存两次是覆盖，不是变两行**；
 *   4. **密钥的边界**：读接口只给掩码，明文只走 `getToken` 那一条（用户点眼睛图标）；
 *   5. **参数不合法时报出来的是人话**，不是 zod 的内部形状；
 *   6. **连接探测走的是真那条链**（二进制 + env 构造器 + settingSources），
 *      以及上游开跑就报错时**报的是上游那句话**而不是一句"没收到 init"。
 *
 * ## 隔离：这一套会真的起子进程，所以两条边界都要换掉
 *
 * - **数据根**走 `MCODE_SMOKE_DATA_ROOT`（`run.sh` 里 `mktemp -d`）。配置是**存库**的，
 *   指错地方等于拿空库盖掉用户的自定义模型配置 —— 桩里没设就抛。
 * - **`HOME` / `USERPROFILE`**（`MCODE_SMOKE_HOME`）。⚠️ 这一条是踩出来的：信号接口
 *   从 v2.1.x 起**在 init 之前就真的打上游**（实测：一个不存在的端口也会先吐
 *   `system/init`，然后才开始重试）。于是 `Probe` 会**真的启动那个 claude 二进制**，
 *   而它启动时会读**用户级**配置（`~/.claude/settings.json`、凭据、`CLAUDE.md`）。
 *   被测代码会把 `CLAUDE_CONFIG_DIR` 指到 `<HOME>/.mcode`，但除此之外二进制还要
 *   `$HOME/.claude.json` 之类 —— 用户根不隔离，这一套就会拿用户本机的登录态去**打真
 *   上游**：既花钱、又把"网络/额度"这种和被测代码无关的东西变成测试的红。
 *   所以必须在**任何 import 之前**把 `HOME`/`USERPROFILE` 换掉（`homedir()` 在 POSIX
 *   读 `$HOME`、在 Windows 读 `USERPROFILE`）。
 *
 * ## 探测那一段：假上游是真的 HTTP 服务，SDK 换成桩
 *
 * `Probe` 里 `await import("@anthropic-ai/claude-agent-sdk")` 被 `run.sh` 的 `--alias`
 * 换成了 `scripts/custom-model-smoke/stubs/sdk.ts`（照 `run-store-smoke/stubs/` 的既有
 * 做法）。桩把**真实收到的 options**（model / env / settingSources / 二进制路径）记到
 * 一个 JSON 文件里，于是"探测和真实回合走同一条链"这件事是可以断言的，而不是靠读注释。
 * `abortController` 也一并记下 —— 没有它，探测里那个 30s 超时定时器就是白设的。
 *
 * Run: scripts/custom-model-smoke/run.sh
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type { TestCustomModelResult } from "@contracts/customModel";

/* ────────────────────────── 0. 先隔离用户根 ──────────────────────────
 *
 * ⚠️ 必须在**任何被测 import 之前**执行：`customEnv.ts` 的 `MCODE_CONFIG_DIR` 是在
 * 模块求值时用 `homedir()` 算出来的 —— 晚一行，它就是**用户真正的** `~/.mcode`。
 *
 * 三个环境变量都由 `run.sh` 给（`mktemp -d` 出来的目录）。这里**没给就抛**，
 * 理由和 `dataRoot` 桩一样：将就一个默认值 = 拿用户的东西当测试场地。
 */
/** 读一个必须由 `run.sh` 给的环境变量。没给就抛 —— 理由和 `dataRoot` 桩一样：
 *  将就一个默认值 = 拿用户的东西当测试场地。 */
function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 没设 —— ${why}`);
  return value;
}

const SMOKE_HOME = requireEnv(
  "MCODE_SMOKE_HOME",
  "这一套会真的起 claude 子进程，不隔离用户根就会读用户自己的登录态去打真上游",
);
process.env.HOME = SMOKE_HOME;
process.env.USERPROFILE = SMOKE_HOME;

const DATA = requireEnv("MCODE_SMOKE_DATA_ROOT", "指错地方就是拿空库盖掉用户的配置");
/** 桩 SDK 每次被调用时把收到的 options 追加写这里（见 stubs/sdk.ts）。 */
const PROBE_LOG = requireEnv("MCODE_SMOKE_PROBE_LOG", "探测那一段的断言就看不到真相了");

/* ────────────────────────── 断言工具 ────────────────────────── */

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组 / 对象的深比较（`Object.is` 对两份内容相同的是 false，这一套里到处要断
 *  "存进去的那一份和读出来的是不是同一份"）。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 「用户看到的那行字是不是人话」。判据立在**设置页会显示的那个字符串**上：
 * zod 的 `ZodError.message` 是一整段 JSON 数组文本，被原样写进界面就是这一类真 bug。
 * 所以这里认三种形状：嵌着 `"code":`、看着像一段 JSON、或者直接露出 zod 的内部
 * 标识（`invalid_type` / `too_small` / `unrecognized_keys` / `ZodError`）。
 */
function looksLikeRawZod(msg: string): boolean {
  return (
    /"code"\s*:/.test(msg) ||
    /ZodError/.test(msg) ||
    /\binvalid_type\b|\btoo_small\b|\bunrecognized_keys\b/.test(msg) ||
    /^\s*\[\s*\{/.test(msg)
  );
}

/* ────────────────────────── 记名替身 ipcMain ──────────────────────────
 *
 * 不起 Electron：`registerCustomModelHandlers` 把真函数按 channel 收下来，
 * 然后**调那个用户动作本身**。下面所有断言都是它的结果，没有一句在复述 handler
 * 内部的写法 —— 这样哪天 handler 换了实现，断言会真的红。
 */

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerCustomModelHandlers } = await import("@main/ipc/customModel.js");
registerCustomModelHandlers(fakeIpc);

const { MCODE_CONFIG_DIR } = await import("@main/providers/claude-sdk/customEnv.js");
const { dataRoot } = await import("@main/lib/dataRoot.js");
const { CustomModelStore } = await import("@main/lib/secretStore.js");
const { homedir } = await import("node:os");

/** 调一条真 handler（`raw` 就是渲染端传下来的那个对象）。 */
async function call(channel: string, raw?: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerCustomModelHandlers 没有注册 ${channel}`);
  return await fn(null, raw);
}

/** 调一条 handler 并把**抛出来的那句话**取回来（渲染端看到的就是它）。 */
async function rejected(channel: string, raw: unknown): Promise<string | null> {
  try {
    await call(channel, raw);
    return null;
  } catch (err) {
    return msgOf(err);
  }
}

console.log("\n环境隔离");

check("homedir() 已指向隔离目录", homedir() === SMOKE_HOME, {
  homedir: homedir(),
  smokeHome: SMOKE_HOME,
});
// 比之前面归一化：`SMOKE_HOME` 是给子进程看的那份（git-bash 给的是正斜杠），
// 而 `homedir()` / `path.join` 是反斜杠 —— 直接 `startsWith` 会红得莫名其妙。
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
check(
  "claude 的用户根也落在隔离目录里(不是用户真正的 ~/.mcode)",
  norm(MCODE_CONFIG_DIR).startsWith(norm(SMOKE_HOME)),
  { MCODE_CONFIG_DIR, SMOKE_HOME },
);
eq("数据根指向临时目录", dataRoot(), DATA);
for (const ch of [
  IPC.CUSTOM_MODEL_LIST,
  IPC.CUSTOM_MODEL_SAVE,
  IPC.CUSTOM_MODEL_DELETE,
  IPC.CUSTOM_MODEL_TEST,
  IPC.CUSTOM_MODEL_GET_TOKEN,
  IPC.WEB_BRIDGE_STATUS,
  IPC.WEB_BRIDGE_REGENERATE_TOKEN,
]) {
  check(`注册了 ${ch}`, handlers.has(ch));
}

/* ────────────────────────── 1. 存进去读出来是不是同一份 ────────────────────────── */

console.log("\n存 —— 读");

const BASE_INPUT = {
  name: "DeepSeek 中转",
  baseUrl: "https://api.example.test/anthropic",
  authMode: "auth_token" as const,
  protocol: "anthropic" as const,
  authToken: "sk-smoke-abcdefgh123456",
  models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash", supports1m: true }],
  subagentModel: "deepseek-v4-flash",
  disableNonEssentialTraffic: true,
  timeoutMs: 60_000,
  customHeaders: { "x-tenant": "acme", "x-route": "hint" },
};

const saveRes = (await call(IPC.CUSTOM_MODEL_SAVE, BASE_INPUT)) as {
  models: Array<Record<string, unknown>>;
};
eq("新建一条之后列表里正好一条", saveRes.models.length, 1);
const savedId = String(saveRes.models[0]?.id ?? "");
check("主进程自己发了 id（不让渲染端指定）", savedId.startsWith("cm_"), savedId);

const listRes = (await call(IPC.CUSTOM_MODEL_LIST)) as { models: Array<Record<string, unknown>> };
const row = listRes.models[0] ?? {};
eq("存进去的 baseUrl 读出来一模一样", row.baseUrl, BASE_INPUT.baseUrl);
eq("存进去的名字读出来一模一样", row.name, BASE_INPUT.name);
same("models 原样存回（含 supports1m）", row.models, BASE_INPUT.models);
same("自定义请求头原样存回", row.customHeaders, BASE_INPUT.customHeaders);
eq("timeoutMs 原样存回", row.timeoutMs, BASE_INPUT.timeoutMs);
eq("子代理钉住的模型原样存回", row.subagentModel, BASE_INPUT.subagentModel);
eq("协议存回了具体的值（不是 undefined）", row.protocol, "anthropic");
eq("鉴权方式存回了具体的值", row.authMode, "auth_token");
check("带上了 createdAt", typeof row.createdAt === "number" && row.createdAt > 0, row.createdAt);
// 两次读的是不是同一份（中间夹了一次 save 谁也没动它）
same("再 list 一次还是那一份", (await call(IPC.CUSTOM_MODEL_LIST)) as unknown, listRes);

/* ────────────────────────── 2. 同 id 存两次 = 覆盖 ────────────────────────── */

console.log("\n存第二次 —— 覆盖还是变两行");

const updRes = (await call(IPC.CUSTOM_MODEL_SAVE, {
  ...BASE_INPUT,
  id: savedId,
  name: "改过的名字",
  baseUrl: "https://api.example.test/v2",
  models: [{ id: "deepseek-v4-pro" }],
  subagentModel: undefined,
  customHeaders: { "x-route": "other" },
})) as { models: Array<Record<string, unknown>> };

eq("★ 同 id 存两次是覆盖，不是变成两行", updRes.models.length, 1);
eq("id 没变", updRes.models[0]?.id, savedId);
eq("改过的名字生效了", updRes.models[0]?.name, "改过的名字");
eq("改过的地址生效了", updRes.models[0]?.baseUrl, "https://api.example.test/v2");
same("models 换成了新的那一份", updRes.models[0]?.models, [{ id: "deepseek-v4-pro" }]);
same("headers 换成了新的那一份", updRes.models[0]?.customHeaders, { "x-route": "other" });
eq("上一轮钉的子代理模型跟着模型表一起被换掉", updRes.models[0]?.subagentModel, undefined);

// 子代理钉住的值不在模型列表里 = 手里那份配置和模型表对不上了，不该落盘。
const pinRes = (await call(IPC.CUSTOM_MODEL_SAVE, {
  ...BASE_INPUT,
  id: savedId,
  models: [{ id: "deepseek-v4-pro" }],
  subagentModel: "早就删掉的模型",
})) as { models: Array<Record<string, unknown>> };
eq("钉住的子代理模型不在模型表里 → 丢掉，不落盘", pinRes.models[0]?.subagentModel, undefined);

// 更新一个不存在的 id：必须报错，不能静默当成新建。
const beforeStray = ((await call(IPC.CUSTOM_MODEL_LIST)) as { models: unknown[] }).models.length;
const strayErr = await rejected(IPC.CUSTOM_MODEL_SAVE, { ...BASE_INPUT, id: "cm_根本不存在" });
check("更新一个不存在的 id → 报错", strayErr !== null, strayErr);
check("报的那句话里带着那个 id", (strayErr ?? "").includes("cm_根本不存在"), strayErr);
// ★ 这句话是**原样显示给用户**的(`CustomModelsPanel` 把 message 贴进 danger 面板),
//   中文界面上不许冒英文。从前这条报的是 "custom model not found: …" —— 同文件里那条
//   「新建必须给密钥」也是英文("authToken is required when creating a custom model"),
//   而兄弟 store(`piModelsStore` / `codexModelsStore`)同处境是中文。
//   ⚠️ 判据要**先把那句 id 抠掉**再找汉字:测试 id 本身就是中文(`cm_根本不存在`),
//   不抠的话英文原句也会因为 id 而"含汉字",断言就成了恒真。
const strayWithoutId = (strayErr ?? "").replace("cm_根本不存在", "");
check("★ 报错本身是中文(抠掉 id 后仍有汉字,不是英文原句)", /[一-鿿]/.test(strayWithoutId), strayErr);
eq(
  "更新不存在的 id 不会静默新建一条",
  ((await call(IPC.CUSTOM_MODEL_LIST)) as { models: unknown[] }).models.length,
  beforeStray,
);

/* ────────────────────────── 3. 删掉之后真的没了 ────────────────────────── */

console.log("\n删");

const delRes = (await call(IPC.CUSTOM_MODEL_DELETE, { id: savedId })) as {
  models: Array<Record<string, unknown>>;
};
same("删掉之后列表里就没有它了", delRes.models, []);
same("再 list 一次也还是没有", (await call(IPC.CUSTOM_MODEL_LIST)) as unknown, { models: [] });
eq(
  "它的密钥也跟着没了（getToken 拿不到）",
  ((await call(IPC.CUSTOM_MODEL_GET_TOKEN, { id: savedId })) as { token: unknown }).token,
  null,
);
const delAgain = await rejected(IPC.CUSTOM_MODEL_DELETE, { id: savedId });
eq("删一个已经没了的 id → 不报错（幂等）", delAgain, null);

/* ────────────────────────── 4. 密钥的边界 ────────────────────────── */

console.log("\n密钥");

const secret = "sk-super-secret-abcdefgh123456";
const withSecret = (await call(IPC.CUSTOM_MODEL_SAVE, {
  ...BASE_INPUT,
  authToken: secret,
})) as { models: Array<Record<string, unknown>> };
const secretId = String(withSecret.models[0]?.id ?? "");

const listed = (await call(IPC.CUSTOM_MODEL_LIST)) as { models: Array<Record<string, unknown>> };
eq(
  "★ 列表接口不吐明文 token（掩码里没有完整密钥）",
  JSON.stringify(listed).includes(secret),
  false,
);
eq("列表给的是掩码（首 2 尾 4）", listed.models[0]?.authTokenMasked, "sk***3456");
check(
  "列表里根本没有一个字段等于明文",
  Object.values(listed.models[0] ?? {}).every((v) => v !== secret),
  listed.models[0],
);
eq(
  "眼睛图标那条通道给的正好是那一份明文",
  ((await call(IPC.CUSTOM_MODEL_GET_TOKEN, { id: secretId })) as { token: unknown }).token,
  secret,
);
eq(
  "问一个不存在的 id → null，不抛",
  ((await call(IPC.CUSTOM_MODEL_GET_TOKEN, { id: "cm_没有这条" })) as { token: unknown }).token,
  null,
);

// 编辑时留空 = 不换密钥（设置页就是这么发的：`authToken: form.authToken || undefined`）。
await call(IPC.CUSTOM_MODEL_SAVE, { ...BASE_INPUT, id: secretId, authToken: undefined });
eq(
  "更新时不重填 token → 原来那份密钥还在",
  ((await call(IPC.CUSTOM_MODEL_GET_TOKEN, { id: secretId })) as { token: unknown }).token,
  secret,
);
await call(IPC.CUSTOM_MODEL_SAVE, { ...BASE_INPUT, id: secretId, authToken: "sk-new-token-9876543210" });
eq(
  "更新时重填了 token → 密钥跟着换",
  ((await call(IPC.CUSTOM_MODEL_GET_TOKEN, { id: secretId })) as { token: unknown }).token,
  "sk-new-token-9876543210",
);
const noTokenErr = await rejected(IPC.CUSTOM_MODEL_SAVE, { ...BASE_INPUT, authToken: undefined });
eq(
  "新建时不给 token → 报错，而不是存一条没有密钥的配置",
  noTokenErr !== null,
  true,
);
// ★ 同上:这句话也是原样给用户看的,必须是中文(从前是英文 authToken is required …)。
check("★ 「必须给密钥」那句也是中文", /[一-鿿]/.test(noTokenErr ?? ""), noTokenErr);

/* ────────────────────────── 5. 参数不合法时报出来的是人话 ────────────────────────── */

console.log("\n报错是不是人话");

const countBefore = ((await call(IPC.CUSTOM_MODEL_LIST)) as { models: unknown[] }).models.length;

/** 每条：[断言名, 入参, 那句人话里该出现的词]。 */
const badSaves: Array<[string, unknown, string]> = [
  ["名字空着", { ...BASE_INPUT, name: "" }, "name"],
  ["模型列表是空的", { ...BASE_INPUT, models: [] }, "models"],
  ["请求头传了非字符串的值", { ...BASE_INPUT, customHeaders: { "x-a": 1 } }, "customHeaders"],
  ["网页端没选站点", { ...BASE_INPUT, protocol: "web" }, "网页端"],
  ["网页端选了个不认识的站点", { ...BASE_INPUT, protocol: "web", webSiteId: "没这个站" }, "不认识"],
  ["普通协议地址是空白", { ...BASE_INPUT, baseUrl: "   " }, "baseUrl"],
];

for (const [label, input, expectWord] of badSaves) {
  const text = await rejected(IPC.CUSTOM_MODEL_SAVE, input);
  check(`save 被拒(${label}) → 报错`, text !== null, text);
  check(
    `save 被拒(${label}) → 那句话里说的是人话`,
    text !== null && !looksLikeRawZod(text),
    text,
  );
  check(
    `save 被拒(${label}) → 那句话说清了是哪儿不对`,
    (text ?? "").includes(expectWord),
    { text, expectWord },
  );
}

for (const [label, channel, input, expectWord] of [
  ["test 没给模型 id", IPC.CUSTOM_MODEL_TEST, { baseUrl: "https://a.test", authToken: "t", model: "" }, "model"],
  ["test 没给地址", IPC.CUSTOM_MODEL_TEST, { baseUrl: "", authToken: "t", model: "m" }, "baseUrl"],
  ["getToken 没给 id", IPC.CUSTOM_MODEL_GET_TOKEN, { id: "" }, "id"],
  ["delete 没给 id", IPC.CUSTOM_MODEL_DELETE, {}, "id"],
] as Array<[string, string, unknown, string]>) {
  const text = await rejected(channel, input);
  check(`${label} → 报错`, text !== null, text);
  check(`${label} → 那句话里说的是人话`, text !== null && !looksLikeRawZod(text), text);
  check(`${label} → 那句话说清了是哪儿不对`, (text ?? "").includes(expectWord), {
    text,
    expectWord,
  });
}

eq(
  "校验失败时一个字都没写进库",
  ((await call(IPC.CUSTOM_MODEL_LIST)) as { models: unknown[] }).models.length,
  countBefore,
);

// 契约明说：网页端没有端点，地址不是必填 —— 但站点必须有。
const webSave = (await call(IPC.CUSTOM_MODEL_SAVE, {
  ...BASE_INPUT,
  protocol: "web",
  webSiteId: "deepseek",
  baseUrl: "",
  authToken: undefined,
})) as { models: Array<Record<string, unknown>> };
eq("网页端不需要地址也不需要 token 就能存下", webSave.models.length, countBefore + 1);
eq("网页端把站点存下来了", webSave.models[webSave.models.length - 1]?.webSiteId, "deepseek");
await call(IPC.CUSTOM_MODEL_DELETE, { id: webSave.models[webSave.models.length - 1]?.id });

/* ────────────────────────── 6. 连接探测 ────────────────────────── */

console.log("\n连接探测（假上游 + 桩 SDK）");

interface ProbeRun {
  result?: TestCustomModelResult;
  /** handler 自己抛了 —— 契约说它返回 `{ok:false}`，所以这属于 bug。 */
  threw?: string;
  /** 桩 SDK 真实收到的 options。 */
  options?: Record<string, unknown> | null;
}

/**
 * 跑一次探测。`stub` 控制桩 SDK 的行为：
 *   - 不给：走桩里那条**实测出来的正常端点顺序** —— `assistant → system/init →
 *     assistant(text) → result`。⚠️ `system/init` **不在第一条**，因为二进制在
 *     "收到第一条应答"之后才吐它（这一条顺序正是下面那两条红色断言的由来）。
 *   - `messages`：按给定顺序吐，用来模拟"上游开跑就报错"这类形状。
 *   - `throwMsg`：直接抛，用来模拟 SDK 层面的失败（连不上 / 认证被拒 / 到点 abort）。
 */
async function runProbe(
  input: Record<string, unknown>,
  stub: { messages?: unknown[]; throwMsg?: string } = {},
): Promise<ProbeRun> {
  if (stub.messages) process.env.MCODE_SMOKE_PROBE_MESSAGES = JSON.stringify(stub.messages);
  else delete process.env.MCODE_SMOKE_PROBE_MESSAGES;
  if (stub.throwMsg) process.env.MCODE_SMOKE_PROBE_THROW = stub.throwMsg;
  else delete process.env.MCODE_SMOKE_PROBE_THROW;
  rmSync(PROBE_LOG, { force: true });
  const probe = async (): Promise<ProbeRun> => {
    const result = (await call(IPC.CUSTOM_MODEL_TEST, input)) as TestCustomModelResult;
    let options: Record<string, unknown> | null = null;
    try {
      const lines = readFileSync(PROBE_LOG, "utf8").trim().split("\n").filter(Boolean);
      options = JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown> | null;
    } catch {
      options = null;
    }
    return { result, options };
  };
  try {
    return await probe();
  } catch (err) {
    // handler 自己抛了也照样把桩记下的真相带回来：契约说这条通道返回
    // `{ok:false}` 而不是抛，抛到渲染端就是一句 `Uncaught Error`。
    let options: Record<string, unknown> | null = null;
    try {
      const lines = readFileSync(PROBE_LOG, "utf8").trim().split("\n").filter(Boolean);
      options = JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown> | null;
    } catch {
      options = null;
    }
    return { threw: msgOf(err), options };
  }
}

const probeInput = {
  baseUrl: "https://gateway.example.test/anthropic",
  authToken: "sk-probe-token",
  model: "deepseek-v4-pro",
  supports1m: true,
  customHeaders: { "x-probe": "yes" },
};

/**
 * ⚠️ 桩的默认形状是**实测出来的**，不是编的（隔离 HOME + 假上游 + 真二进制跑出来的
 * 消息序列）：
 *
 * | 上游的行为 | 二进制吐出来的 |
 * |---|---|
 * | 正常答话 | `system/init` → `assistant{error:null, content:[text]}` → `result{is_error:false}` |
 * | 一个字都没答 | `system/init` → `user` → `result{is_error:false, result:""}`（**没有 assistant**）|
 * | 开跑就报错(400/503/…) | `system/init` → `assistant{error:…, content:[错误文本]}` → `result{is_error:true, result:错误文本}` |
 *
 * 这三行是下面几条断言的判据来源：探测必须等到**真的答了一句话**才算通过。
 */
const HAPPY_SEQUENCE = [
  { type: "system", subtype: "init", claude_code_version: "9.9.9-smoke" },
  { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
  { type: "result", subtype: "success", is_error: false, result: "hello" },
];

const happy = await runProbe(probeInput, { messages: HAPPY_SEQUENCE });
eq("通得上的端点 → ok", happy.result?.ok, true);
check(
  "通得上的端点 → 那句 detail 里带上了 SDK 版本",
  typeof happy.result?.detail === "string" && happy.result.detail.includes("9.9.9-smoke"),
  happy.result,
);
// ★ 这句 detail **原样画在设置页的成功那行绿字上**(CustomModelsPanel 的
//   `testStatus.detail`),不是内部标记 —— 必须是中文,与同一个 catch 里其它给用户
//   看的句子一条口径。别因为旁边 `error` 分支是英文就跟着写英文。
check(
  "★ 成功那句 detail 是中文(它直接画在设置页上,不是内部标记)",
  typeof happy.result?.detail === "string" && happy.result.detail.includes("连接成功"),
  happy.result?.detail,
);
check("探测不把异常漏给界面（契约说返回 {ok:false}）", happy.threw === undefined, happy.threw);

const opts = happy.options ?? {};
eq(
  "探测用的是一个真的 abortController（否则那 30s 超时定时器是白设的）",
  opts.abortControllerIsAbortController,
  true,
);
eq(
  "探测发出去的模型 id 带着 1M 后缀（和真实回合同一个串）",
  opts.model,
  "deepseek-v4-pro[1m]",
);
eq("探测把地址交给了子进程", opts.baseUrl, probeInput.baseUrl);
eq("探测把 token 放进了 ANTHROPIC_AUTH_TOKEN（auth_token 模式）", opts.authToken, probeInput.authToken);
check(
  "auth_token 模式下不设 ANTHROPIC_API_KEY（免得两种鉴权同时发出去）",
  opts.apiKey === null,
  opts.apiKey,
);
eq(
  "探测带上了自定义请求头（不要求该头的端点才测得过）",
  opts.customHeaders,
  "x-probe: yes",
);
same(
  "探测用的 settingSources 和真实回合一致（'project','local'）",
  opts.settingSources,
  ["project", "local"],
);
// ⚠️ 这一条在**这个仓库的 dev 检出里**就是 null，而且那是设计如此，不是漏了：
// `resolveSdkBinaryPath()` 只在**打好的包**里（或托管运行时下载过之后）才拿得到路径；
// dev 下它故意返回 null，好让 SDK 自己去 node_modules 里解析（见 sdkBinaryPath.ts 里
// `resolveBundledSdkBinaryPath` 那段注释）。所以这里断的是**这条约定本身**：
//   - 拿到路径 → 必须是那个真的 claude 二进制（不是 asar 里那个跑不起来的）
//   - null     → SDK 自己解析，探测照常（`pathToClaudeCodeExecutable` 那个键整个不出现）
// 两头都要钉住的是同一件事：**绝不能把一个 asar 内部的路径交给 spawn**。
const bin = opts.pathToClaudeCodeExecutable;
check(
  "二进制路径要么是真二进制、要么是 null（绝不给 spawn 一个 asar 里的路径）",
  bin === null || (typeof bin === "string" && !bin.includes("app.asar") && bin.includes("claude")),
  bin,
);

const withApiKey = await runProbe({ ...probeInput, authMode: "api_key" }, { messages: HAPPY_SEQUENCE });
eq(
  "api_key 模式把凭据放进 ANTHROPIC_API_KEY",
  withApiKey.options?.apiKey,
  probeInput.authToken,
);
check(
  "api_key 模式下不设 ANTHROPIC_AUTH_TOKEN",
  withApiKey.options?.authToken === null,
  withApiKey.options?.authToken,
);

// 探测要连的是**真网关**，不是本地桥：openai 格式的配置先起一条桥，
// 再把 baseUrl 换成桥的地址（打开一条 127.0.0.1 上的监听 socket）。
const viaBridge = await runProbe(
  { ...probeInput, protocol: "openai", authToken: "sk-x" },
  { messages: HAPPY_SEQUENCE },
);
const bridgeUrl = String(viaBridge.options?.baseUrl ?? "");
check(
  "openai 格式的探测改打本地桥（不让 OpenAI 线上出现 anthropic 那套约定）",
  bridgeUrl.startsWith("http://127.0.0.1:") && bridgeUrl !== probeInput.baseUrl,
  { bridgeUrl, original: probeInput.baseUrl },
);

// 上游开跑就报错：实测形状是 init → assistant{error, content:[错误文本]} →
// result{is_error:true, result:错误文本}。这是**用户最常碰到的失败形状**
// （模型名不对、渠道没开、额度用尽），旧写法在这里报绿色"已连接"。
const upstreamErr = await runProbe(probeInput, {
  messages: [
    { type: "system", subtype: "init", claude_code_version: "9.9.9-smoke" },
    {
      type: "assistant",
      error: "invalid_request",
      message: { content: [{ type: "text", text: "API Error: 503 无可用渠道" }] },
    },
    { type: "result", subtype: "success", is_error: true, result: "API Error: 503 无可用渠道" },
  ],
});
eq("上游开跑就报错 → ok:false", upstreamErr.result?.ok, false);
check(
  "★ 上游开跑就报错 → 报的是上游那句话（不是一句「没收到 init」）",
  typeof upstreamErr.result?.error === "string" &&
    upstreamErr.result.error.includes("无可用渠道"),
  upstreamErr.result,
);

// ⚠️ 这一条钉的是**实测出来的那个坏现象**。假上游从头到尾回同一个 400，
// 真二进制吐的是：
//   `assistant{error:'unknown', content:[错误文本]} → system/init → assistant{…} → result{is_error:true}`
// 也就是 **system/init 夹在那条错误应答的后面** —— 旧写法看到 init 就当成功返回，
// 设置页于是显示绿色的"已连接"，而这条配置**一跑就失败**。
const earlyInitErr = await runProbe(probeInput, {
  messages: [
    {
      type: "assistant",
      error: "unknown",
      message: { content: [{ type: "text", text: "API Error: 400 unknown model: deepseek-v4-pro[1m]" }] },
    },
    { type: "system", subtype: "init", claude_code_version: "9.9.9-smoke" },
    {
      type: "assistant",
      error: "unknown",
      message: { content: [{ type: "text", text: "API Error: 400 unknown model: deepseek-v4-pro[1m]" }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "API Error: 400 unknown model: deepseek-v4-pro[1m]",
    },
  ],
});
eq("★ 上游从头到尾回错误（init 夹在应答后面）→ 不算通过", earlyInitErr.result?.ok, false);
check(
  "★ 并且报出来的是上游那句话（用户要拿着它去查模型名）",
  typeof earlyInitErr.result?.error === "string" && earlyInitErr.result.error.includes("400"),
  earlyInitErr.result,
);

// 只握手、一个字都没答（实测形状：init → user → result{is_error:false, result:""}）：
// 握手通了，但上游**没有真的答话** —— 这**不是**成功，而旧写法在这里报的是
// "endpoint did not send an init message"（一句把用户引去查网络、而网络没问题的错话）。
const quiet = await runProbe(probeInput, {
  messages: [
    { type: "system", subtype: "init", claude_code_version: "9.9.9-smoke" },
    { type: "user", message: { content: [] } },
    { type: "result", subtype: "success", is_error: false, result: "" },
  ],
});
eq("★ 只握手、一句话都没答 → 不算通过", quiet.result?.ok, false);
// 判据钉的是**两句话的区分**,不是某一句英文的字面量 —— 文案会改(它得是中文,
// 见 `customModel.ts` 里那段注释),但这两种情况必须说得出不一样的话:
//   - 握手通了没答话 → 端点能连上,是模型名不认(别把人引去查网络)
//   - 压根没握手     → 才轮到怀疑传输
// 所以对比一个「连 init 都没有」的探针结果,两句话必须不等。
const noInit = await runProbe(probeInput, {
  messages: [{ type: "result", subtype: "success", is_error: false, result: "" }],
});
eq("对照:压根没握手也不算通过", noInit.result?.ok, false);
check(
  "★ 只握手没答话 → 那段话跟「压根没握手」不是同一句(旧写法把两种混成一句)",
  typeof quiet.result?.error === "string" &&
    typeof noInit.result?.error === "string" &&
    quiet.result.error !== noInit.result.error,
  { quiet: quiet.result?.error, noInit: noInit.result?.error },
);
check(
  "★ 而且「只握手没答话」那句说的是握手通了(端点没问题),不是「没收到 init」",
  typeof quiet.result?.error === "string" &&
    quiet.result.error.includes("握手通了") &&
    !quiet.result.error.includes("没收到握手"),
  quiet.result?.error,
);

// 另一条出口:流**既没有 init、也没有 `result` 帧**就结束了(桩里只给 user 帧)。
// 这时走的是 `customModel.ts` 循环外那一句 —— 从前它是**英文**
// ("endpoint did not send an init message"),而同一个判断在 `result` 分支里
// (上面 `noInit` 那条)却是中文,同一页面上两种情况一个中一个英。两处必须同句。
const noFrame = await runProbe(probeInput, {
  messages: [{ type: "user", message: { content: [] } }],
});
eq("对照:流里连 result 帧都没有也不算通过", noFrame.result?.ok, false);
check(
  "★ 没有 result 帧那条出口说的也是中文「没收到握手」(不是英文那一句)",
  typeof noFrame.result?.error === "string" &&
    noFrame.result.error.includes("没收到握手") &&
    !noFrame.result.error.startsWith("endpoint"),
  noFrame.result?.error,
);

const threw = await runProbe(probeInput, { throwMsg: "connect ECONNREFUSED 127.0.0.1:9" });
eq("SDK 直接抛（连不上）→ ok:false，不把异常漏给界面", threw.result?.ok, false);
check(
  "连不上时那句话里带着原因",
  typeof threw.result?.error === "string" && threw.result.error.includes("ECONNREFUSED"),
  threw.result,
);

const auth = await runProbe(probeInput, { throwMsg: "API Error: 401 invalid_api_key" });
check(
  "认证被拒 → 报的是「认证失败」那句",
  typeof auth.result?.error === "string" && auth.result.error.includes("认证失败"),
  auth.result,
);

const noChannel = await runProbe(probeInput, { throwMsg: "上游返回: 无可用渠道" });
check(
  "网关没这个模型的渠道 → 报的是「网关无此模型渠道」那句",
  typeof noChannel.result?.error === "string" && noChannel.result.error.includes("网关无此模型渠道"),
  noChannel.result,
);

// 超时的真实现象：30s 到点 → abortController.abort() → SDK 抛"Operation aborted"
// （实测跑满 66s 才结束，所以这里直接给桩那个异常，不真等半分钟）。
const aborted = await runProbe(probeInput, { throwMsg: "Operation aborted" });
check(
  "到点被 abort → 报的是「连接超时」那句",
  typeof aborted.result?.error === "string" && aborted.result.error.includes("连接超时"),
  aborted.result,
);

/* ────────────────────────── 7. 顺路：扩展桥的那两条通道 ────────────────────────── */

console.log("\n扩展桥");

const status = (await call(IPC.WEB_BRIDGE_STATUS)) as {
  url: string;
  token: string;
  paired: boolean;
};
check("status 把服务拉起来了（打开设置页就该看到地址）", status.url.startsWith("http://127.0.0.1:"), status.url);
check("status 给了一个令牌", status.token.length > 0);
eq("还没有扩展连上 → 未配对", status.paired, false);

const rotated = (await call(IPC.WEB_BRIDGE_REGENERATE_TOKEN)) as { url: string; token: string };
check("换令牌之后令牌变了（旧令牌不再认）", rotated.token !== status.token, {
  before: status.token.slice(0, 6),
  after: rotated.token.slice(0, 6),
});
eq("换令牌不影响桥地址", rotated.url, status.url);

const { stopExtensionBridge } = await import("@main/providers/bridge/extensionBridge.js");
stopExtensionBridge();

/* ────────────────────────── 收尾 ────────────────────────── */

  rmSync(DATA, { recursive: true, force: true });

console.log(`\ncustom-model-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
