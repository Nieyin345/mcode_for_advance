import type { RpcMap } from "@contracts/ipc";
/**
 * Headless smoke for **`main/ipc/orchestration.ts`** 与 **`main/orchestration/nodeTypesSeed.ts`**
 * —— 工作流那一摊的"入口"与"铺目录"。
 *
 * ## 为什么单开一套(这两份零覆盖)
 *
 * `smokes-for.sh` 两个文件都报"没有套件覆盖它"。而这两份站在**用户与 AI 两条写路径
 * 的共同入口**上:
 *
 *   - `registerWorkflowHandlers` 一次注册 **22 条 IPC**,设置 → 工作流那一页、画布、
 *     自动化那一栏全从这儿进;
 *   - 它是**唯一**在启动路径上调 `ensureLocalNodeTypesDir()` 的地方 —— 而那份 README
 *     是系统提示词指给模型的那一份(`lib/systemPrompt.ts` 里明写"先读这个目录里的
 *     README.md")。
 *
 * ## 架子:`nodeTypesSeed` 那句"不能被无头探针直接 import"是**错的**
 *
 * `nodeTypesSeed.ts` 的文件头写着:因为 `./node-types-README.md?raw` 是构建期的东西,
 * 所以"这个模块不能被无头探针直接 import"。对**纯 node** 成立,对这套 esbuild **不**
 * 成立:`--loader:.md=text` 就是 `?raw` 的等价物(esbuild 会把 `x.md?raw` 解析回 `x.md`
 * 再套 text loader)。所以这里 import 的是**真的那一份**,不是抄本 —— 那正是这一套能验
 * "铺出来的 README 和仓库里那份逐字节一致"的前提。
 *
 * ⚠️ **那段注释还把"这个文件不该被验"写进去了**,于是它自己成了这份文件唯一零覆盖的
 * 理由。这一套不认那句话 —— 见 §2/§3/§4,那句错误的话也已经从源码里改掉了。
 *
 * ## 走的是**真的那条 IPC**
 *
 * 全程 `fakeIpc` 记名 + `handlers.get(channel)!(null, raw)` 调真函数(抄
 * `library-trash-smoke` 的 §4)。没有一句在复述 handler 内部的写法 —— 所以哪天有人把
 * 校验顺序换了、把广播漏了、把 `sanitizeFileBase` 的正则改了,这里会红。
 *
 * ## 文件对话框是**可摆的**(stubs/electron.ts)
 *
 * 默认返回"用户取消了"(大部分断言走这条);但 `setSavePath` / `setOpenPaths` 能让它
 * 给回一个真路径 —— 于是导出**真的写一个文件**、从文件导入**真的读一个文件**这两段
 * 也就覆盖到了。只钉死"取消"的话,那两个 handler 里最长的一段(读写 + 失败分支)一行
 * 都验不到。
 *
 * ## 日志也是可观测的
 *
 * `stubs/logger.ts` 把每条 `log.*` 原样写到 stderr,这里抄一份进 `logLines`
 * (原样再写一遍,免得日志从眼前消失)。§9 那几条"坏条目被丢掉时说话没有"的断言就
 * 立在那上面 —— 判据是**用户能看到的那行字**,不是"函数返回了什么"。
 *
 * ## 它不碰用户真正的数据
 *
 * `MCODE_SMOKE_DATA_ROOT` 指向 `mktemp -d`(见 `stubs/dataRoot.ts` 里那句"没设就抛"),
 * 跑完连目录一起删。`SettingRepo.set` 内部就是 `persist()`,**重写整个 `mcode.db`** ——
 * 指错地方就是拿空库盖掉用户的聊天记录。
 *
 * Run: scripts/orchestration-ipc-smoke/run.sh
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IpcMain } from "electron";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { agentProfileContentHash } from "@main/orchestration/agentProfiles.js";
import { watchTemplatesRevision } from "@contracts/ipc/workflow";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组比较。`Object.is` 对两个内容相同的数组是 false —— 这一套里好几处断的是
 *  "集合里正好是这几个"。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-orch-ipc-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/**
 * **接住日志。** `stubs/logger.ts` 把每一条 `log.*` 原样写到 `process.stderr` 上
 * (它故意不静默,见那份文件头)—— 于是日志是可观测的。这里把它抄一份到内存里,
 * 断言就能立在"失败真的说了话没有"上,而不是只能靠人肉看输出。
 *
 * ⚠️ 必须在**任何 import 之前**装上:`main.ts` 是顶层 await 的 ESM,下面的
 * `await import(...)` 会一边加载被测模块一边可能就打日志(比如建库那几条 `[info]`)。
 * 抄的时候原样再写回 stderr —— 免得"装了探针"反而让日志从眼前消失。
 */
const logLines: string[] = [];
{
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    for (const line of String(chunk).split("\n")) if (line.trim().length > 0) logLines.push(line);
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

/* ──────────────── 0. 把真 handler 取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-trash-smoke` 的 §4)。
 *
 * 本套要验的东西整个住在 handler 的**函数体**里 —— 校验拦下了什么、哪次写广播了、
 * 文件名叫什么 —— 而它们从来不是导出符号。唯一拿得到的办法就是调
 * `registerWorkflowHandlers`,把注册进来的那批函数按 channel 收下来。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerWorkflowHandlers, sanitizeFileBase } = await import("@main/ipc/orchestration.js");
const { initDb, getDb } = await import("@main/store/db.js");
const { SessionRepo, SettingRepo, ProjectRepo, WorkflowRunRepo, CollectionRepo, LibraryRepo } = await import(
  "@main/store/repositories.js"
);
const { ensureTrashCollection } = await import("@main/library/trash.js");
const { loadNodeTypes } = await import("@main/orchestration/nodeTypes.js");
const { isNodeRunnable, IMPLEMENTED_RUNNER_KINDS, RESERVED_NODE_TYPE_PREFIX } = await import(
  "@contracts/nodeType"
);
const { NODE_TYPES_FILES, ensureLocalNodeTypesDir } = await import(
  "@main/orchestration/nodeTypesSeed.js"
);
const { localNodeTypesDir } = await import("@main/orchestration/nodeTypes.js");
const { sent, resetSent, setWindow } = (await import("@main/window.js")) as unknown as {
  sent: Array<{ channel: string; payload: unknown }>;
  resetSent: () => void;
  setWindow: (w: { alive: boolean }) => void;
};
// ⚠️ **相对路径**,不是 `"electron"`:`setSavePath` 这几个只有桩才有,从 `"electron"`
// 进会按真 electron 的类型检查(报"没有这个导出")。esbuild 按解析后的**绝对路径**去重,
// 所以这里和 alias 指过去的是**同一个模块实例** —— 摆的开关就是 handler 用的那个。
const { setSavePath, setOpenPaths, resetDialog } = await import("./stubs/electron.js");

await initDb();
registerWorkflowHandlers(fakeIpc);

function call(channel: string, raw?: unknown): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerWorkflowHandlers 没有注册 ${channel}`);
  return fn(null, raw);
}

async function callAsync(channel: string, raw?: unknown): Promise<unknown> {
  return await call(channel, raw);
}

/** 把 `unknown` 收成能点属性的形状 —— 断言里读返回值的字段用。 */
const obj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

/* ──────────────── 1. 32 条 handler 一条不少、一条不多 ──────────────── */

console.log("\n注册面");

// 32 这个数字是**数出来的**(下面按名字逐条对),不是抄的。少一条 = 渲染端某个按钮
// 点了没反应;多一条 = 白名单那边没跟上(renderer 根本调不到,但说明有人改了这里
// 却没改契约那一份)。
const registered = [...handlers.keys()].sort();
check(
  `注册了 32 条 handler(实际 ${registered.length})`,
  registered.length === 32,
  registered,
);

// 逐条点名 —— 断言里写的是**契约里的 channel 常量**,不是字面量:契约改名字这里跟着红。
const expectedChannels: Array<[string, string]> = [
  ["工作流列表", IPC.WORKFLOW_LIST],
  ["取一份工作流", IPC.WORKFLOW_GET],
  ["审查并启用外来工作流", IPC.WORKFLOW_APPROVE],
  ["节点类型清单", IPC.WORKFLOW_NODE_TYPES],
  ["存一份工作流", IPC.WORKFLOW_SAVE],
  ["删/恢复默认", IPC.WORKFLOW_REMOVE],
  ["导出", IPC.WORKFLOW_EXPORT],
  ["导入(文本)", IPC.WORKFLOW_IMPORT],
  ["导入(选文件)", IPC.WORKFLOW_IMPORT_FROM_FILE],
  ["出厂预设(列出)", IPC.WORKFLOW_LIST_PRESETS],
  ["出厂预设(导入)", IPC.WORKFLOW_IMPORT_PRESET],
  ["代理档案列表", IPC.WORKFLOW_AGENT_PROFILES],
  ["存代理档案", IPC.WORKFLOW_SAVE_AGENT_PROFILE],
  ["删代理档案", IPC.WORKFLOW_REMOVE_AGENT_PROFILE],
  ["岔路口选路", IPC.WORKFLOW_CHOOSE],
  ["失败重试", IPC.WORKFLOW_RETRY],
  ["立刻跑一次", IPC.AUTOMATION_RUN],
  ["触发前只读预检", IPC.AUTOMATION_PREFLIGHT],
  ["自动化运行历史", IPC.AUTOMATION_RUNS],
  ["自动化的后台会话", IPC.AUTOMATION_SESSIONS],
  ["全部触发器事实", IPC.AUTOMATION_STATUS_ALL],
  ["某个对话的图运行历史", IPC.RUNS_HISTORY],
  ["守望起跑", IPC.AUTOMATION_WATCH],
  ["守望活跃状态", IPC.AUTOMATION_WATCH_STATUS],
  ["命令模板(读)", IPC.AUTOMATION_WATCH_TEMPLATES],
  ["命令模板(存)", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE],
  ["命令模板(显式重建)", IPC.AUTOMATION_WATCH_TEMPLATES_REBUILD],
  ["钉住默认工作流", IPC.WORKFLOW_PIN_DEFAULT],
  ["恢复默认", IPC.WORKFLOW_RESTORE_DEFAULT],
  ["应用出厂版更新", IPC.WORKFLOW_APPLY_SHIPPED_UPDATE],
  ["忽略出厂版更新", IPC.WORKFLOW_DISMISS_SHIPPED_UPDATE],
  ["自定义 UI 运行自动化", IPC.CUSTOM_UI_RUN_AUTOMATION],
];
const missing = expectedChannels.filter(([, ch]) => !handlers.has(ch)).map(([name]) => name);
same("包括「命令模板(显式重建)」在内的 32 条一条不缺", missing, []);

/* ──────────────── 2. 种子铺出来的目录 ──────────────── */

console.log("\n节点类型目录(seed)");

const dir = localNodeTypesDir();
check("registerWorkflowHandlers 一进来就把目录铺出来了", existsSync(dir), dir);

// ⚠️ **零文件守卫。** 下面的断言全是"文件在那儿、内容对",一份都没铺的话
// `for` 循环一次都不转、断言全绿而什么都没验 —— 那正是 AGENT-RULES §4 说的"空过"。
check(
  `NODE_TYPES_FILES 不是空的(${NODE_TYPES_FILES.length} 项)`,
  NODE_TYPES_FILES.length > 0,
  NODE_TYPES_FILES.map(([n]) => n),
);

for (const [name, body] of NODE_TYPES_FILES) {
  const file = join(dir, name);
  check(`铺出来了 ${name}`, existsSync(file), file);
  if (!existsSync(file)) continue;
  const onDisk = readFileSync(file, "utf8");
  // 逐字节 —— `?raw` 的意义就是"文件逐字不动",少一个字符这里就该红。
  eq(`${name} 的内容与仓库里那份逐字节一致`, onDisk.length, body.length);
  check(
    `${name} 的内容确实相等(不是长度凑巧)`,
    onDisk === body,
    { 盘上: onDisk.slice(0, 40), 源码: body.slice(0, 40) },
  );
}

// **系统提示词指给模型的就是这个路径。** `lib/systemPrompt.ts` 里写着
// 「要给工作流加一种新节点,先读这个目录里的 README.md」—— 而它只在启动时铺一次。
// 铺失败的话模型被指去读一个不存在的文件,而这里是唯一能钉住"那个路径上真有东西"
// 的地方。所以断言立在那句话的落点上,不是立在"函数返回了没有"上。
const promptReadme = join(dir, "README.md");
check("系统提示词让模型读的那个 README.md 真的在", existsSync(promptReadme), promptReadme);
if (existsSync(promptReadme)) {
  const text = readFileSync(promptReadme, "utf8");
  check("README 不是空文件", text.trim().length > 500, text.length);
  check("README 讲了执行方式(模型照着它选 kind)", text.includes("执行方式"), text.length);
  // ★ **README 要把「自动整段拼」和「{{}} 点名取」两个作用域说清是两回事**(报告 P2)。
  //
  // 这两条判据在代码里本来就是**不同**的:`upstreamTextOf` 走直接入边,`upstreamNames`
  // 走传递闭包。作者最容易踩的坑是**以为没整段拼进来的步骤就拿不到** —— 于是要么放弃
  // 引用,要么整段重复灌。README 是系统提示词指给读的那一份,必须把这层边界写出来。
  // 钉的是"它讲了这件事",不是某个具体措辞 —— 换种写法只要还说清边界就不该红。
  check(
    "★ README 说明了「直接上游」和「整条上游链」是两个范围",
    text.includes("直接上游") && text.includes("整条上游链"),
    { 有直接上游: text.includes("直接上游"), 有整条上游链: text.includes("整条上游链") },
  );
}

// ★ **README 承诺的执行方式和代码里那份清单要对得上。**
//
// README 里「执行方式」那一节有张表,逐 kind 写"现在能用吗"。它和 `@contracts/nodeType`
// 的 `IMPLEMENTED_RUNNER_KINDS` 是**两处各写一份**,而这份 README 正是系统提示词指给
// 模型读的那一份 —— 模型照着它选 `runner.kind`。所以两边的取值集合必须一致。
//
// ⚠️ 只扫**那张表的第一列**,不扫全文:`trigger` 这个词在别处大量出现
// (`{{trigger.*}}` 那一节、`trigger` 不能当节点 id 那一段),`text.includes("trigger")`
// 会**因为无关的正文而通过** —— 那种断言测的不是这张表,是"文档里出现过这个词"。
{
  const text = readFileSync(promptReadme, "utf8");
  const start = text.indexOf("## 执行方式");
  // ⚠️ **只取到那节里第一张表结束**(第一行不是 `|` 的行)。往下还有别的表
  // ——「prompt 与 conversation 的差别」那张里写着 `none` / `result` / `full`(那是
  // 「回到主对话」的取值),一起扫会把它们当成执行方式,断言测的东西就变了。
  const body = text.slice(start);
  const tableLines: string[] = [];
  let started = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("|")) {
      started = true;
      tableLines.push(line);
    } else if (started) {
      break;
    }
  }
  // 第一列里形如 `` `prompt` `` / `` `command`(命令进**参数**) ``。
  const tableKinds = [
    ...new Set(
      tableLines
        .map((l) => l.split("|")[1] ?? "")
        .map((cell) => /`([a-z]+(?:-[a-z]+)*)`/.exec(cell)?.[1] ?? "")
        .filter((k) => k.length > 0 && k !== "kind"),
    ),
  ].sort();
  const contractKinds = [...(IMPLEMENTED_RUNNER_KINDS as readonly string[])].sort();

  // 表与契约严格相等:包括带连字符的 module-capability，不删/弱化精确集合检查。
  // 不再把种类数写死 —— 新增执行原语时契约与给模型看的表要一起更新。
  check("★ README 解析保留带连字符的模块 kind", tableKinds.includes("module-capability"));
  same("★ README 执行方式表与契约严格一致", tableKinds, contractKinds);
  check(
    "★ condition 与 trigger 都在表和契约里",
    tableKinds.includes("condition") && tableKinds.includes("trigger") &&
      contractKinds.includes("condition") && contractKinds.includes("trigger"),
    { 契约: contractKinds, README表: tableKinds },
  );
  check(
    "★ README 不再声称执行方式只有过期的四种",
    !text.includes("`runner.kind` 只有四个值"),
  );
  // 反向:表里出现的每个 kind 契约必须认得(表不能自己发明执行原语)。
  const invented = tableKinds.filter((k) => !contractKinds.includes(k));
  same("表里没有契约不认得的 kind(不能自己发明执行原语)", invented, []);

  // ★ **每行的「现在能用吗」标记必须与 isNodeRunnable 一致。**
  //
  // 上面只比了种类**集合**,而 `command` 在表里**占两行**(命令进参数 / 命令进自带脚本),
  // 两行首列都是 `command` —— 集合断言对"自带脚本那行写着 ❌"**完全看不见**。那正是
  // MC-005 的缺口:实现早已落地(`entryRunner.ts` + `commandExecutor` 分流),README 却
  // 还把 `entry` 形态教成"执行还没实现",而这份 README 是系统提示词指给模型读的 ——
  // 模型照它绕开命令节点。逐行比对 ✅/❌,任一行说反了这里就红。
  const rows = tableLines
    .map((l) => l.split("|"))
    .map((cells) => ({
      kind: /`([a-z]+(?:-[a-z]+)*)`/.exec(cells[1] ?? "")?.[1] ?? "",
      runnable: (cells[3] ?? "").includes("✅"),
    }))
    .filter((r) => r.kind.length > 0 && r.kind !== "kind");
  check(
    "★ 表里解析出了 command 的两行(否则下面的逐行比对是空过)",
    rows.filter((r) => r.kind === "command").length === 2,
    rows,
  );
  for (const r of rows) {
    check(
      `★ README 表里 ${r.kind} 的「能用吗」与 isNodeRunnable 一致`,
      r.runnable === contractKinds.includes(r.kind),
      { kind: r.kind, README标记: r.runnable ? "✅" : "❌", 契约认它能跑: contractKinds.includes(r.kind) },
    );
  }
}

/* ──────────────── 3. 数据根坏掉时,应用还起得来吗 ──────────────── */

console.log("\n数据根写不进去时");

// `ensureLocalNodeTypesDir` 的承诺写在它自己的文件头里:「用户可能把数据根放到了只读
// 位置或网盘上,那不该让整个应用起不来」。所以**它不能往外抛** —— 而它是
// `registerWorkflowHandlers` 的第一句,抛出去就 `.catch()` 到启动路径上,22 条 IPC
// 一条都注册不上:整个工作流那一页连同自动化那一栏全是死的,而用户看到的是
// "点了没反应"。
//
// 怎么造:把 `<数据根>/workflows` 做成一个**文件** —— 用户数据根里手滑放个同名文件是
// 真会发生的事,而那样 `mkdirSync(dir, { recursive: true })` 必抛(ENOTDIR)。
{
  const badRoot = mkdtempSync(join(tmpdir(), "mcode-seed-badroot-"));
  writeFileSync(join(badRoot, "workflows"), "这不是一个目录", "utf8");
  const goodRoot = process.env.MCODE_SMOKE_DATA_ROOT;

  const handlersBefore = handlers.size;
  process.env.MCODE_SMOKE_DATA_ROOT = badRoot;
  let threw = "";
  let res: unknown;
  try {
    res = await callAsync(IPC.WORKFLOW_NODE_TYPES);
  } catch (err) {
    threw = (err as Error).message;
  }
  eq("数据根建不出目录时,节点类型 handler 不抛(承诺:不该让应用起不来)", threw, "");
  check(
    "而且它照样返回一份清单(内置那七个不受数据根影响)",
    Array.isArray(obj(res).entries) && (obj(res).entries as unknown[]).length >= 7,
    obj(res).entries,
  );

  // 再直接调一次那个函数本身 —— 上面那条走的是 handler,这条钉的是它自己。
  let threw2 = "";
  try {
    ensureLocalNodeTypesDir();
  } catch (err) {
    threw2 = (err as Error).message;
  }
  eq("ensureLocalNodeTypesDir 自己也不抛", threw2, "");

  // ⚠️ 而失败**只有一行 log.warn**(`[orchestration] 节点类型目录没铺出来(…)`)。
  // 那份 README 是系统提示词指给模型的那一份,用户和模型都读不到"它没铺出来"这件事
  // —— 判据立在用户看到的那行字上,这里没有那行字。记录在报告里,不在这里写一条
  // 永远红的断言。

  process.env.MCODE_SMOKE_DATA_ROOT = goodRoot;
  rmSync(badRoot, { recursive: true, force: true });
  eq("换回好数据根之后 handler 数没变(上面那次失败没留下半截注册)", handlers.size, handlersBefore);
}

/* ──────────────── 4. 幂等:绝不覆盖用户改过的 ──────────────── */

console.log("\n幂等 · 不覆盖用户改过的");

{
  const readme = join(dir, "README.md");
  const userEdited = "# 我自己改过的\n\n这条不能被启动流程冲掉。\n";
  writeFileSync(readme, userEdited, "utf8");

  // 再跑一遍(模拟第二次启动/第二次注册)。
  ensureLocalNodeTypesDir();
  eq("用户改过的 README 再铺一次不会被冲掉", readFileSync(readme, "utf8"), userEdited);

  // 用户删掉了它 → 再铺一次要补回来,否则新用户/删过的人永远没有那份规范。
  rmSync(readme);
  ensureLocalNodeTypesDir();
  check("用户删掉之后会补回来", existsSync(readme));
  eq(
    "补回来的那份是仓库里那份",
    readFileSync(readme, "utf8"),
    NODE_TYPES_FILES.find(([n]) => n === "README.md")?.[1],
  );
}

/* ──────────────── 4a. 没改过的旧版要升到新版 ──────────────── */

console.log("\n没改过的旧版 README 升级成新版");

{
  // 节点类型 README 从前是"存在就跳过"(从不升级),于是老安装永久停在首发出厂那一版 ——
  // 而它是系统提示词指给模型的规范(旧版只列 4 种 kind,现版 9 种)。这里把规则逼出来:
  // 盘上的 README 与**记录里写过的某一版**一致(=没改过),再铺一次必须换成当前版。
  const readme = join(dir, "README.md");
  const current = NODE_TYPES_FILES.find(([n]) => n === "README.md")?.[1]!;
  const recordFile = join(dirname(dir), ".mcode-shipped-node-types.json");

  // 造"一个没改过的旧版":内容任意,**只要记录里记的就是它** —— 那就是"上次我们写出去的"。
  const oldShipped = "# 旧版 README(我们上次铺的)\n\n旧内容。\n";
  writeFileSync(readme, oldShipped, "utf8");
  const { shippedHashOf } = await import("@main/workflows/seed.js");
  writeFileSync(recordFile, JSON.stringify({ "README.md": shippedHashOf(oldShipped) }), "utf8");

  ensureLocalNodeTypesDir();
  eq("★ 没改过的旧版被换成当前版", readFileSync(readme, "utf8"), current);

  // 正控:用户**改过**的(记录里对不上、也不在任何历史版里)不许动 —— §4 已逐字验过,
  // 这里只确认升级逻辑没把那条规矩破坏掉。
  const userEdited = "# 我又改了\n\n别动我。\n";
  writeFileSync(readme, userEdited, "utf8");
  ensureLocalNodeTypesDir();
  eq("★ 用户改过的仍然不动(升级逻辑没破坏那条规矩)", readFileSync(readme, "utf8"), userEdited);

  // ★★ **真正的老安装**:磁盘上有旧 README,但**根本没有记录文件**(2026-09-26 之前
  //    的版本从不写它)。这一条才是那张 `legacyHashes` 表存在的理由 —— 上面那条会写
  //    记录文件,验的是"有记录时能升",而老用户**从来没有过记录**。
  //    没有 legacyHashes 时,旧 README 的 hash 在空记录里查不到 → 被判"用户改过" → 原样留着,
  //    而那份旧 README 写着「runner.kind 只有四个值」,模型照它写不出新 kind。
  {
    rmSync(recordFile, { force: true });
    // 摆一份**发过的**老版 README(用最早那一版的真实 hash 对应的内容做不到逐字复刻,
    // 所以这里直接改用一个**签名可靠**的做法:把 legacy 表里第一个 hash 对应的历史内容
    // 当作"已发过的原版" —— 用 git 历史那一版的文本写盘)。
    const legacyOld = readFileSync(
      join(process.cwd(), "scripts/orchestration-ipc-smoke/fixtures/legacy-node-types-README.md"),
      "utf8",
    );
    writeFileSync(readme, legacyOld, "utf8");
    check("前提:那份老 README 与当前版不同", legacyOld !== current, { len: legacyOld.length });
    ensureLocalNodeTypesDir();
    eq("★ 没有记录文件的老安装,旧 README 也升级成当前版(legacyHashes 生效)", readFileSync(readme, "utf8"), current);
  }
}

/* ──────────────── 4b. 一个文件写失败,后面的还铺不铺 ──────────────── */

console.log("\n一个文件铺失败时其余照铺");

// 今天 `NODE_TYPES_FILES` 只有一项,所以"整个循环一个 try"和"每个文件一个 try"看不出
// 差别 —— 差别要等到**第二项**出现。这里临时塞两项进去,把那个差别提前逼出来。
//
// 怎么让第一项必失败而又不走 `existsSync` 那条跳过路:`path.join(dir, "sub/x.md")`,
// 而 `sub` 是一个**文件** —— `existsSync` 是 false(路径不存在),`writeFileSync` 必抛
// (ENOTDIR)。
{
  const sub = join(dir, "sub");
  writeFileSync(sub, "我是一个文件,不是目录", "utf8");
  const files = NODE_TYPES_FILES as unknown as Array<[string, string]>;
  const added: number[] = [];
  added.push(files.push(["sub/x.md", "这一份铺不出来"]));
  added.push(files.push(["第二个.md", "这一份必须照样铺出来"]));
  const second = join(dir, "第二个.md");

  let threw = "";
  try {
    ensureLocalNodeTypesDir();
  } catch (err) {
    threw = (err as Error).message;
  }
  eq("一项铺失败不妨碍整个函数(不往外抛)", threw, "");
  check(
    "★ 第一项铺失败之后,后面那项**照样铺出来了**(每项一个 try,不是整个循环一个)",
    existsSync(second),
    { 第二项: second, 存在: existsSync(second) },
  );

  // 收拾干净:把塞进去的两项拿掉,别影响后面的节。
  files.splice(files.length - added.length, added.length);
  rmSync(second, { force: true });
  rmSync(sub, { force: true });
  eq("塞进去的两项已拿掉,清单回到原样", files.length, 1);
}

/* ──────────────── 4. 目录里的 JSON 定义 → 注册表(两个方向) ──────────────── */

console.log("\n自定义节点类型 · 正反两个方向");

/** 一份形状真的合法的清单 —— 拿来改坏其中一处,看它是不是"显式报出来"。 */
function manifestFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "smoke.word-count",
    manifestVersion: 1,
    name: "统计字数",
    description: "数一个文件里的字数。",
    icon: "book",
    category: "文本",
    capability: "read",
    runner: { kind: "command" },
    params: [{ key: "command", kind: "text", label: "命令" }],
    ...over,
  };
}

function writeManifest(name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

function removeManifest(name: string): void {
  const f = join(dir, name);
  if (existsSync(f)) rmSync(f);
}

async function catalog(): Promise<{
  entries: Array<{ id: string; source: string; manifest: NodeTypeManifest }>;
  problems: Array<{ file: string; error: string }>;
}> {
  return (await callAsync(IPC.WORKFLOW_NODE_TYPES)) as never;
}

// ① 正向:目录里放一份好清单 → 真的出现在清单里(而且要能被认出来"是从哪来的")。
writeManifest("smoke-good.json", JSON.stringify(manifestFixture()));
{
  const c = await catalog();
  const found = c.entries.find((e) => e.id === "smoke.word-count");
  check("目录里放一份清单 → 注册表里真的认得它", found !== undefined, c.entries.map((e) => e.id));
  eq("它标着来源是 local", found?.source, "local");
  eq("它是可跑的(isNodeRunnable)", isNodeRunnable(found?.manifest as never), true);
  eq("没有 problem", c.problems.length, 0);
}

// ② 反向:注册表里的每一个类型都要说得出**它的执行方式现在真能不能跑**。
//
// 这是"配得出来但跑不通"那一类里唯一能在这里钉住的一半:`workflow:nodeTypes` 是画布
// 「添加节点」菜单的数据源,而菜单上应该只出现能跑的(界面上另有 `isNodeRunnable`
// 那道标 —— 但**至少要能从这一份数据里算出来**)。判据用契约里那个唯一的函数,
// 不用这里另写一遍。
{
  const c = await catalog();
  const unrunnable = c.entries
    .filter((e) => !isNodeRunnable(e.manifest))
    .map((e) => `${e.id}(${e.manifest.runner.kind})`);
  // 今天的答案应该是"一个都没有":内置类型 + 目录里那份 command(param 形状)。
  same("清单里没有『配得出来但跑不通』的类型", unrunnable, []);
}

// ③ **kind 的清单只有一份。** 内置/目录里出现的每种 kind,契约必须认得(在
// `IMPLEMENTED_RUNNER_KINDS` 里)—— 反过来说,契约说实现了的,内置里也该真的有人用。
// 这条钉的是"两套实现只有一份"(硬规矩 2):类型 schema 的 union、调度器的拒绝文案、
// 界面的标,三处都从这一个数组来。
{
  const c = await catalog();
  const kinds: string[] = [...new Set(c.entries.map((e) => e.manifest.runner.kind))].sort();
  const unknown = kinds.filter((k) => !(IMPLEMENTED_RUNNER_KINDS as readonly string[]).includes(k));
  same("每个在用的 kind 都在契约的『已实现』清单里", unknown, []);
  check(
    "契约里的执行方式,清单里全都有实例(否则那个声明是空头支票)",
    (IMPLEMENTED_RUNNER_KINDS as readonly string[]).every((k) => kinds.includes(k)),
    { 契约: IMPLEMENTED_RUNNER_KINDS, 清单: kinds },
  );
}

// ④ 内置类型一个都不能少 —— 少一个,`workflow.list` 里那几份内置图就有一节跑不了。
{
  const c = await catalog();
  const builtinIds = c.entries.filter((e) => e.source === "builtin").map((e) => e.id).sort();
  same("内置节点类型精确包含模块能力、条件、Node-RED 及原有类型", builtinIds, [
    "mcode.agent",
    "mcode.branch",
    "mcode.code",
    "mcode.command",
    "mcode.condition",
    "mcode.conversation",
    "mcode.main",
    "mcode.module-capability",
    "mcode.node-red",
    "mcode.trigger",
  ]);
}

// ④b ★ **「两处各写一份」的漂移闸**:清单里 node-red 的参数键与 runner.kind 必须
// **逐字**等于执行器导出的常量。
//
// 清单(`main/orchestration/nodeTypes.ts`)与执行器(`nodeRedExecutor.ts`)是两份东西:
// 前者给画布/模型看,后者从 `params` 读值。参数键写歪一个字符,症状是"界面上填得进去、
// 运行时执行器读不到"(enginePath 读成 undefined → 那句"缺少路径参数"),而且**两边各自
// 都自洽**,不会报任何错。所以这里直接 import 执行器的常量,对着**真清单**(经真 IPC
// 读出来的那一份)逐字比对 —— 不抄一份字面量进夹具,抄本会跟真货漂开。
{
  const { NODE_RED_PATH_PARAM, NODE_RED_METHOD_PARAM, NODE_RED_BODY_PARAM, NODE_RED_RUNNER_KIND } =
    await import("@main/orchestration/nodeRedExecutor.js");
  const c = await catalog();
  const red = c.entries.find((e) => e.id === "mcode.node-red");
  check("前提:内置清单里真的有 mcode.node-red", red !== undefined, c.entries.map((e) => e.id));
  if (red) {
    // 参数表必须**恰好**是「执行器三格 + 宿主共用的产出变量表」:多一个键(比如把
    // enginePath 改成 enginePathX 又留了个旧的)会让界面上出现一个执行器永远读不到的
    // 控件 —— 那也是漂移,只是方向反过来。第一版只比"三个常量在里面",变异验证时
    // 才发现改名后旧键会漏网,所以这里比**完整键表**。
    const { NODE_OUTPUT_VARS_KEY } = await import("@contracts/outputConstraint");
    same(
      "★ mcode.node-red 的参数键逐字等于执行器常量 + 共用产出变量表(顺序也一致)",
      red.manifest.params.map((p) => p.key),
      [NODE_RED_PATH_PARAM, NODE_RED_METHOD_PARAM, NODE_RED_BODY_PARAM, NODE_OUTPUT_VARS_KEY],
    );
    eq("★ mcode.node-red 的 runner.kind 等于执行器常量", red.manifest.runner.kind, NODE_RED_RUNNER_KIND);
    // 引擎执行器是**条件注册**的:清单必须声明这条需求,否则引擎缺席时预检说不出
    // 「缺少执行器」,节点会掉进模型兜底(它返回的是失败,但原因不对)。
    const req = (red.manifest.requirements ?? []).find(
      (r) => r.kind === "executor" && r.id === NODE_RED_RUNNER_KIND,
    );
    check("★ mcode.node-red 声明了 executor requirement(引擎缺席时预检才说得出原因)", req !== undefined, red.manifest.requirements);
    // 参数说明是悬停浮窗里的一段(mcode-admin-smoke 的 80 字上界同样适用于内置类型),
    // 这里在**真清单**上再钉一次,免得那套的红要等到下次全量才被看见。
    const tooLong = red.manifest.params.filter((p) => (p.help ?? "").length > 80).map((p) => p.key);
    same("★ mcode.node-red 的参数说明都在 80 字以内", tooLong, []);
    check(
      "★ mcode.node-red 每个参数都有说明",
      red.manifest.params.every((p) => (p.help ?? "").trim().length > 0),
      red.manifest.params.map((p) => p.key),
    );
  }
}

// ⑤ ★ **「资料」下拉的候选是资料库大类的现读,不是硬编码。**
//
// 用户的原话是「工作流节点的『收到什么 / 资料』这一路必须走资料库的统一入口」——
// 这条下拉就是那个入口的**候选面**。判据立在三件事上:
//   1. 候选跟着 settings 里的 `library.groups` **当场变**(改表 → 下一次 `workflow.nodeTypes`
//      就看得见,不需要重启,更不是写死的 `docs/templates`);
//   2. 用户清空大类表 → 候选退回**出厂两组**(这是 `contextOptions` 的兜底,理由见
//      `nodeTypes.ts` 那段:一个选项都没有会让 `validateNodeTypeManifest` 把
//      mcode.main / mcode.agent / mcode.conversation 三个内置类型**整个摘掉**);
//   3. 「读失败」与「空表」**不是一回事**:读失败(库还没就绪 / settings 读抛)必须
//      把问题**报出来**(`workflow.nodeTypes` 抛错 → 渲染端那栏显示原因),而不是
//      伪装成"没有资料"让用户以为自己的大类丢了。
//
// 走的是真 handler:改 `SettingRepo`,再按 channel 调 `loadNodeTypes()` 那一份——
// 中间没有一层是这里复刻的。
console.log("\n「资料」下拉的候选(资料库大类现读)");
{
  const { loadLibraryGroups, resetLibraryGroupsCacheForTest } = await import(
    "@main/library/groupRegistry.js"
  );
  const { LIBRARY_GROUPS_SETTING_KEY, DEFAULT_LIBRARY_GROUPS } = await import("@contracts/libraryTypes");
  const { SettingRepo } = await import("@main/store/repositories.js");

  /** 当前 `workflow.nodeTypes` 返回里,给定内置类型的「资料」候选。 */
  const contextOptionsOf = async (typeId: string): Promise<string[]> => {
    const c = (await callAsync(IPC.WORKFLOW_NODE_TYPES)) as {
      entries: Array<{ id: string; manifest: NodeTypeManifest }>;
    };
    const spec = c.entries.find((e) => e.id === typeId)?.manifest.params.find((p) => p.key === "context");
    return (spec?.options ?? []).map((o) => o.value);
  };

  // 起点:把表恢复到出厂两份,先证明**正向**(改表后候选真的跟着变)。
  SettingRepo.set(
    LIBRARY_GROUPS_SETTING_KEY,
    JSON.stringify([
      { id: "docs", name: "文档" },
      { id: "my-readings", name: "我的精读" },
    ]),
  );
  resetLibraryGroupsCacheForTest();
  same("★ 改了大类表 → 「资料」候选跟着变(现读,不是硬编码)", await contextOptionsOf("mcode.agent"), [
    "docs",
    "my-readings",
  ]);
  same("主代理与对话节点共用同一份候选", await contextOptionsOf("mcode.main"), ["docs", "my-readings"]);

  // 清空表 → 退回出厂两组(而不是整批内置类型消失)。
  SettingRepo.set(LIBRARY_GROUPS_SETTING_KEY, JSON.stringify([]));
  resetLibraryGroupsCacheForTest();
  same(
    "★ 用户清空大类表 → 候选退回出厂两组(内置类型不能被摘掉)",
    await contextOptionsOf("mcode.agent"),
    DEFAULT_LIBRARY_GROUPS.map((g) => g.id),
  );
  eq(
    "空表下三个内置模型节点仍然在注册表里",
    (await contextOptionsOf("mcode.main")).length > 0 &&
      (await contextOptionsOf("mcode.conversation")).length > 0,
    true,
  );

  // **读失败 ≠ 空表。** 把 settings 读注入成抛错(库还没就绪 / 磁盘坏),再强制重读——
  // 必须**抛出来**让调用方/界面看见原因,绝不能悄悄退回出厂两组当"没有资料"。
  // (退回出厂两组只在"表合法但为空"与"从没存过"两种情形下成立;读失败是第三种。)
  const storage = await import("@main/store/repositories.js");
  const originalGet = storage.SettingRepo.get;
  let threw = false;
  let message = "";
  resetLibraryGroupsCacheForTest();
  try {
    (storage.SettingRepo as { get: (k: string) => string | null }).get = (key: string) => {
      if (key === LIBRARY_GROUPS_SETTING_KEY) throw new Error("disk I/O error (injected)");
      return originalGet(key);
    };
    try {
      loadLibraryGroups();
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    check(
      "★ 大类表读失败 → 显式抛出(不伪装成『没有资料』)",
      threw && message.includes("injected"),
      { threw, message },
    );
    // `workflow.nodeTypes` 这条入口也必须把同一件事报出来,而不是返回一份缺了三个节点
    // 类型的"正常"目录 —— 那会让用户以为自己的内置类型"莫名其妙没了"。
    let catalogThrew = false;
    try {
      await callAsync(IPC.WORKFLOW_NODE_TYPES);
    } catch {
      catalogThrew = true;
    }
    check("★ 读失败沿 `workflow.nodeTypes` 冒到界面(不是静默少类型)", catalogThrew);
  } finally {
    (storage.SettingRepo as { get: (k: string) => string | null }).get = originalGet;
    SettingRepo.set(LIBRARY_GROUPS_SETTING_KEY, JSON.stringify(DEFAULT_LIBRARY_GROUPS));
    resetLibraryGroupsCacheForTest();
  }
  same(
    "恢复之后候选取回出厂值",
    await contextOptionsOf("mcode.agent"),
    DEFAULT_LIBRARY_GROUPS.map((g) => g.id),
  );
}

/* ──────────────── 5. 坏定义:显式报出来,不静默跳过 ──────────────── */

console.log("\n坏定义 · 是报出来还是当没看见");

// 三种坏法,每一种都对应一类真会发生的手改错误。判据是**同一件事**:
// 坏的必须出现在 `problems` 里(界面那一栏据此显示"读不进来"),而且**不能**悄悄
// 混进 entries —— 静默少一种节点类型是这个问题最难查的表现形式。
const badCases: Array<[string, string, string]> = [
  ["bad-json.json", "{ 这不是 json", "根本不是 JSON"],
  ["bad-shape.json", JSON.stringify({ id: "smoke.no-name", manifestVersion: 1 }), "缺必填字段"],
  [
    "bad-dupe-key.json",
    JSON.stringify(
      manifestFixture({
        id: "smoke.dupe",
        params: [
          { key: "a", kind: "text", label: "甲" },
          { key: "a", kind: "text", label: "乙" },
        ],
      }),
    ),
    "参数键重复",
  ],
  [
    "bad-select.json",
    JSON.stringify(
      manifestFixture({ id: "smoke.select", params: [{ key: "a", kind: "select", label: "甲" }] }),
    ),
    "下拉没有选项",
  ],
  [
    "bad-reserved.json",
    JSON.stringify(manifestFixture({ id: `${RESERVED_NODE_TYPE_PREFIX}mine` })),
    "占用了内置保留前缀",
  ],
];

for (const [file, body, what] of badCases) {
  writeManifest(file, body);
  const c = await catalog();
  const reported = c.problems.filter((p) => p.file.endsWith(file));
  check(`${what} → 出现在 problems 里`, reported.length === 1, c.problems);
  check(
    `${what} → 报的那句话说得清是什么(不是空串)`,
    (reported[0]?.error ?? "").trim().length > 4,
    reported[0]?.error,
  );
  const leaked = c.entries.filter((e) => {
    try {
      return JSON.parse(body)?.id === e.id;
    } catch {
      return false;
    }
  });
  same(`${what} → 没有混进清单里`, leaked.map((e) => e.id), []);
  check(`${what} → 好的那些照样在(一份坏的不能拖垮整份)`, c.entries.some((e) => e.id === "smoke.word-count"));
}

// 保留前缀那句要说清"为什么"(它是内置的命名空间,不是"格式不对")——
// 用户按 README 起名时最容易撞上的就是这一条。
{
  const c = await catalog();
  const reserved = c.problems.find((p) => p.file.endsWith("bad-reserved.json"));
  check(
    "保留前缀那条报文里点了名(mcode.)",
    (reserved?.error ?? "").includes(RESERVED_NODE_TYPE_PREFIX),
    reserved?.error,
  );
}

for (const [file] of badCases) removeManifest(file);
removeManifest("smoke-good.json");
{
  const c = await catalog();
  same("坏文件清掉之后 problems 也空了", c.problems.map((p) => p.file), []);
}

/* ──────────────── 6. sanitizeFileBase:用户起的名字 → 磁盘上的文件名 ──────────────── */

console.log("\n导出文件名");

// ⚠️ 这一段**不测** Windows 保留设备名(`CON` / `nul` / `COM1`)。实测这台机器上
// `writeFileSync(join(dir, "CON"), …)` 成功、还读得回来,所以"导出一个叫 CON 的工作流
// 就炸"这件事在这里**证不出来** —— 拿一个证不出来的前提写断言就是编。见报告末段。
eq("名字里有路径分隔符 → 洗成空格", sanitizeFileBase("文献综述 / 第一版", "wf_1"), "文献综述 第一版");
eq("全非法字符 → 退回 fallback", sanitizeFileBase("*?<>|:", "wf_1"), "wf_1");
eq("空串 → 退回 fallback", sanitizeFileBase("", "wf_1"), "wf_1");
eq("undefined → 退回 fallback", sanitizeFileBase(undefined, "wf_1"), "wf_1");
eq("只有点和空格 → 退回 fallback", sanitizeFileBase("  ..  ", "wf_1"), "wf_1");
eq("末尾的点被削掉(Windows 上会被系统吃掉)", sanitizeFileBase("名字.", "wf_1"), "名字");
eq("末尾的空格被削掉", sanitizeFileBase("名字   ", "wf_1"), "名字");
eq("换行被洗成空格", sanitizeFileBase("第一行\n第二行", "wf_1"), "第一行 第二行");
eq("控制字符被洗掉", sanitizeFileBase("a\x00b", "wf_1"), "a b");
check(
  "超长名字截断到 80",
  sanitizeFileBase("名".repeat(200), "wf_1").length <= 80,
  sanitizeFileBase("名".repeat(200), "wf_1").length,
);
// **只洗文件名那一层**:路径分隔符不出现,意味着落盘的时候不会跑到别的目录去。
{
  const out = sanitizeFileBase("a/b\\c", "wf_1");
  check("洗出来的名字里没有 / 也没有 \\", !out.includes("/") && !out.includes("\\"), out);
  const cut = sanitizeFileBase("来".repeat(100), "wf_1");
  check("截断之后不会只剩一个空格", cut.trim().length > 0, JSON.stringify(cut));
}

/* ──────────────── 7. 存:校验拦下的和存下去的 ──────────────── */

console.log("\n存一份工作流");

function goodDoc(over: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    id: "wf_smoke",
    name: "烟测图",
    prompt: "",
    builtin: false,
    updatedAt: 0,
    nodes: [
      { id: "main", type: "mcode.main", title: "入口", params: { instruction: "把活分给下游" }, position: { x: 0, y: 0 } },
      { id: "n2", type: "mcode.agent", title: "一步", params: { instruction: "做点什么" }, position: { x: 0, y: 120 } },
    ],
    edges: [{ id: "e_main__n2", from: "main", to: "n2" }],
    ...over,
  } as WorkflowDoc;
}

/* ──────────────── 2b. ★ 重名去重:三条路都走同一道闸门 ──────────────── */

console.log("\n★ 同一个名字连存两份");

// 任务是这么问的:「界面上点『新建』建节点」和「AI / 自动化建节点」是不是同一个函数。
// 名字去重这条上原来**不是** —— 三条路里只有两条做了:
//
//   - 界面「新建」(渲染端)→ `uniqueWorkflowName`
//   - 导入(`importWorkflowInto`)→ `uniqueWorkflowName`
//   - AI 走 MCP 的 `workflow_save` → `normalizeWorkflow` → `saveWorkflow`,**没有去重**
//
// 而 `workflow_save` 和界面上的「保存」是**同一条 IPC**:用户把画布上那份改名成和
// 另一份一样,库里就会出现两行一样的名字(选择器、确认框里都只显示名字,"删的是
// 哪一条"就成了要猜的问题)。
//
// ⚠️ 这一段的形状:**这个是 bug,已经修了。** 修法是把去重收进 `saveWorkflow` 这道
// 三条路共用的闸门,于是下面这几条从「记录两行同名」翻成了「第二份被绕开」。
{
  await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_dup1", name: "重名测试" }) });
  await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_dup2", name: "重名测试" }) });
  const listed = obj(await callAsync(IPC.WORKFLOW_LIST));
  const first = (listed.workflows as Array<{ id: string; name: string }>).find(
    (w) => w.id === "wf_dup1",
  );
  const second = (listed.workflows as Array<{ id: string; name: string }>).find(
    (w) => w.id === "wf_dup2",
  );
  // 第一份拿原名 —— 去重要绕开的是**别的行**,不含它自己,所以先存的那份不该被动。
  eq("先存的那份还是原名", first?.name, "重名测试");
  eq("后存的那份被绕开了(库里不再有两行同名)", second?.name, "重名测试 2");
  eq(
    "库里叫「重名测试」的只有一行",
    (listed.workflows as Array<{ name: string }>).filter((w) => w.name === "重名测试").length,
    1,
  );

  // 对照:同样一份东西走**导入**那条路,行为必须**一模一样** —— 去重现在只有一份
  // 实现(saveWorkflow 里那次),这条对照就是钉"没有分家"的。
  const imported = obj(
    await callAsync(IPC.WORKFLOW_IMPORT, {
      text: JSON.stringify(goodDoc({ id: "wf_dup3", name: "重名测试" })),
    }),
  );
  eq("对照:导入那份名字被绕开的规则一致", imported.name, "重名测试 3");
}


resetSent();
{
  const res = obj(await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc() }));
  eq("一份合法的图存得下去", res.ok, true);
  // ⚠️ **存成功才广播。** 少了这一条,AI 走 MCP 建好的东西要等用户关掉设置页再打开
  // 才出现,用户会以为它没干活(见 broadcast.ts 文件头)。而"失败也广播"会让界面
  // 白重拉一次列表 —— 两条都不该发生。
  same(
    "存成功广播了一次,而且报的是 workflow_save",
    sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length,
    1,
  );
  check(
    "广播里带得出是哪个工作流变了",
    JSON.stringify(sent[0]?.payload).includes("wf_smoke"),
    sent[0]?.payload,
  );
}

// **校验不通过时:不落盘、不广播。** 判据立在"用户下次打开看到的是哪一份"上。
{
  writeFileSync(join(DATA, "marker.txt"), "x");
  resetSent();
  const before = obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_smoke" }));
  const badRes = obj(
    await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ name: "改了名但图坏了", nodes: [] }) }),
  );
  eq("图坏了 → 明确拒绝(ok:false)", badRes.ok, false);
  check("拒绝的那句话说得清缺什么(不是「校验未通过」四个字)", String(badRes.error).length > 10, badRes.error);
  same("失败不广播(界面不该白重拉一次)", sent.length, 0);
  const after = obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_smoke" }));
  // **这是"半截状态"那一条**:写失败之后,磁盘上必须是**旧图**,不是半截新图,
  // 也不是空。`WorkflowRepo.save` 在底下一行 upsert,但校验在它之前 —— 这条断言
  // 钉的就是那个顺序。
  eq("失败之后磁盘上还是旧的那一份", obj(after.workflow).name, obj(before.workflow).name);
  eq("旧图的两个节点都还在", (obj(after.workflow).nodes as unknown[]).length, 2);
}

// 类型没装 → **不算硬错误**(分享来的图照样能存能看,只是那一步跑不了)。
{
  resetSent();
  const res = obj(
    await callAsync(IPC.WORKFLOW_SAVE, {
      workflow: goodDoc({
        id: "wf_shared",
        nodes: [
          ...goodDoc().nodes,
          { id: "n3", type: "别人家.没装", title: "跑不了的", params: {}, position: { x: 0, y: 240 } },
        ] as never,
        edges: [
          { id: "e_main__n2", from: "main", to: "n2" },
          { id: "e_n2__n3", from: "n2", to: "n3" },
        ] as never,
      }),
    }),
  );
  eq("引用了没装的类型 → 照样存得下去", res.ok, true);
  eq("存下去了就广播", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 1);
  const got = obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_shared" }));
  check("读回来那一份还在(没有因为认不出类型就丢掉)", got.workflow !== null, got);
}

/* ──────────────── 7b. ★ 契约外字段:保存不静默抹掉(WF-05,2026-10-18) ────────────────
 *
 * `WORKFLOW_SAVE` 的入参走 `WorkflowSaveSchema` → `WorkflowDocSchema`,而 zod 对契约外
 * 的键默认 **strip**。保存是**改写已有行**:渲染端从 `workflow.get` 拿到的文档里若带着
 * 这一版还不认识的字段(更新版本写出的档案、第三方节点自附的元数据),旧实现一次普通
 * 保存就把它们悄悄抹掉 —— 用户什么都没做,数据没了。判据立在**盘上那一行**上:
 * 未知字段(文档/节点/边/坐标各一层)存一次再读回来必须还在,已知字段以入参为准。
 */
{
  resetSent();
  const futureDoc = {
    ...goodDoc({ id: "wf_future", name: "未来版本档案" }),
    futureDocField: { keep: true },
    nodes: goodDoc().nodes.map((n, i) => i === 1
      ? { ...n, futureNodeField: "kept", position: { ...n.position, depth: 7 } }
      : n),
    edges: goodDoc().edges.map((e) => ({ ...e, futureEdgeField: [1, 2] })),
  } as unknown as WorkflowDoc;
  const saved = obj(await callAsync(IPC.WORKFLOW_SAVE, { workflow: futureDoc }));
  eq("带未知字段的文档照样存得下去", saved.ok, true);
  const afterSave = obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_future" }));
  const stored = obj(afterSave.workflow);
  check(
    "★ 保存后盘上的文档仍带未知文档字段(没有被 zod strip 掉)",
    JSON.stringify((stored as unknown as Record<string, unknown>).futureDocField) === JSON.stringify({ keep: true }),
    stored,
  );
  const storedNode = (stored.nodes as Array<Record<string, unknown>>).find((n) => n.id === "n2");
  check(
    "★ 节点级未知字段与坐标未知分量也还在",
    storedNode?.futureNodeField === "kept" &&
      (storedNode.position as Record<string, unknown>).depth === 7,
    storedNode,
  );
  check(
    "★ 边级未知字段也还在",
    JSON.stringify((stored.edges as Array<Record<string, unknown>>)[0]?.futureEdgeField) === JSON.stringify([1, 2]),
    stored.edges,
  );
  // 已知字段以**入参**为准:在带未知字段的同一份里改个名字,不能因为保真把旧名带回来。
  // 覆盖已有行要带 CAS 版本(界面从 `workflow.get` 的 revision 拿,这里同一条路)。
  const revision = String(afterSave.revision);
  const renamed = obj(await callAsync(IPC.WORKFLOW_SAVE, {
    workflow: { ...futureDoc, name: "改名了" } as unknown as WorkflowDoc,
    expectedRevision: revision,
  }));
  eq("同一份再存一次(改名)", renamed.ok, true);
  const afterRename = obj(obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_future" })).workflow);
  eq("已知字段以入参为准(名字改了)", afterRename.name, "改名了");
  check(
    "未知字段跨第二次保存仍在",
    JSON.stringify((afterRename as unknown as Record<string, unknown>).futureDocField) === JSON.stringify({ keep: true }),
    afterRename.futureDocField,
  );
  // 负面:干净文档保存后不该凭空长出未知字段(保真不是"把原文整个贴回去")。
  await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_clean", name: "干净档案" }) });
  const clean = obj(obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_clean" })).workflow);
  check(
    "干净文档保存后不凭空多出字段(与契约键集合一致)",
    // WorkflowRepo.parseWorkflowDoc canonicalizes the optional default engine to "mcode" on read.
    // That is a recognized contract field, not an unexpected or injected extension field.
    Object.keys(clean).sort().join(",") === [...Object.keys(goodDoc()), "engine"].sort().join(",") && clean.engine === "mcode",
    Object.keys(clean),
  );
}

/* ──────────────── 8. 删 / 恢复默认 ──────────────── */

console.log("\n删一份工作流");

// ⚠️ 这里**不断言**"删不存在的会 ok:false" —— 今天它返回 `{ok:true, wasBuiltin:false}`
// (存储层 DELETE 一行不存在的不报错)。这条记录在报告里,没在这里编一个应当的行为。
{
  resetSent();
  const builtinBefore = obj(await callAsync(IPC.WORKFLOW_GET, { id: "default" }));
  check("内置那份编辑前就在", builtinBefore.workflow !== null);

  const res = obj(await callAsync(IPC.WORKFLOW_REMOVE, { id: "wf_smoke" }));
  eq("删自建的说的是「不是内置」", res.wasBuiltin, false);
  eq("删完广播一次", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 1);
  eq("删完真的取不到了", obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_smoke" })).workflow, null);
}

/* ──────────────── 9. 守望模板:健康态、拒写与显式重建(MC-054) ──────────────── */

console.log("\n守望命令模板");

{
  // 存一份**好坏混在一起**的列表 —— 这正是用户手改过 setting 之后的样子。
  const mixed = [
    { id: "a", name: "好的", command: "echo 1" },
    { id: "b", name: "缺 command" },
    { id: "c" },
    { id: "d", name: "也好的", command: "echo 2" },
  ];
  SettingRepo.set("automation.watch.templates", JSON.stringify(mixed));
  const got = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same(
    "坏条目不进面板,好的照常显示",
    (got.templates as Array<{ id: string }>).map((t) => t.id),
    ["a", "d"],
  );
  // 【MC-054】返回值把**完整性**带出来了 —— 从前只有日志,界面拿不到。
  eq("★ MC-054:返回值带 health=partial(有一条读不出)", got.health, "partial");
  same(
    "★ MC-054:problems 列出坏了几条(界面能说「有几条读不出来」)",
    (got.problems as string[]).length,
    2,
  );

  // 丢掉的那几条同时要在日志里说话(这条以前就有,钉住别退化)。
  const before = logLines.length;
  SettingRepo.set("automation.watch.templates", JSON.stringify(mixed));
  obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  const newLines = logLines.slice(before);
  check(
    "丢掉坏条目时日志里说了话(以前一个字都不报)",
    newLines.some((l) => l.includes("命令模板") && l.includes("跳过")),
    newLines,
  );
  check(
    "而且说出了丢了几条(用户能对上自己改过的那几条)",
    newLines.some((l) => /里有 2 条读不了/.test(l)),
    newLines,
  );

  // 【MC-054】partial 状态下**普通全量保存被拒绝** —— 界面没看见那些坏条目,照写
  // 就是替用户把它们抹掉(台账点名的「新保存会覆盖原始设置」)。
  const refusedPartial = obj(
    await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
      templates: [{ id: "a", name: "好的", command: "echo 1" }],
      // 显式 null = "我知道自己在整表覆盖";这一条测的是**健康态守卫**先拒,
      // 不是 revision 缺失(后者是另一条断言)。
      expectedRevision: null,
    }),
  );
  eq("★ MC-054:partial 时普通保存被拒绝(不静默抹掉读不出的条目)", refusedPartial.ok, false);
  check(
    "★ MC-054:拒绝语点名了「读不出来的条目」与恢复路径",
    typeof refusedPartial.error === "string" &&
      refusedPartial.error.includes("读不出来的条目") &&
      refusedPartial.error.includes("备份并重建"),
    refusedPartial.error,
  );
  // 被拒后原值逐字节还在(没有被覆盖)。
  eq(
    "★ MC-054:被拒后原 setting 逐字节还在",
    SettingRepo.get("automation.watch.templates"),
    JSON.stringify(mixed),
  );

  // 整个 setting 是坏 JSON → health=corrupt,保存也被拒。
  SettingRepo.set("automation.watch.templates", "{坏 JSON");
  const corrupt = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same("整个 setting 是坏 JSON → 当没有模板,不抛", corrupt.templates, []);
  eq("★ MC-054:坏 JSON → health=corrupt", corrupt.health, "corrupt");
  const refusedCorrupt = obj(
    await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
      templates: [{ id: "a", name: "好的", command: "echo 1" }],
      expectedRevision: null,
    }),
  );
  eq("★ MC-054:corrupt 时普通保存被拒绝", refusedCorrupt.ok, false);
  eq(
    "★ MC-054:被拒后坏 JSON 原文逐字节还在",
    SettingRepo.get("automation.watch.templates"),
    "{坏 JSON",
  );

  // 存的是合法 JSON 但不是数组 → 同样 corrupt(一条都读不出来)。
  SettingRepo.set("automation.watch.templates", JSON.stringify({ 不是: "数组" }));
  const notArray = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same("存的是个对象不是数组 → 当没有模板", notArray.templates, []);
  eq("★ MC-054:不是数组 → health=corrupt", notArray.health, "corrupt");

  // 【MC-054】显式重建:备份原值 → 校验 → 重建(部分损坏的常用法:保住读得出的好条目)。
  SettingRepo.set("automation.watch.templates", JSON.stringify(mixed));
  // 【MC-054】真实隔离 SettingRepo 已有历史备份，模拟两个修复恰好发生在同一毫秒。
  // 旧实现仅用 Date.now() 作为键，会静默覆盖之前已有的不可逆坏档原文字节。
  const fixedBackupNow = 1760849999123;
  const priorBackupKey = "automation.watch.templates.corrupt-" + fixedBackupNow;
  const priorBackupBytes = "OLD_BACKUP_MUST_NOT_BE_OVERWRITTEN\\n{legacy raw bytes}";
  SettingRepo.set(priorBackupKey, priorBackupBytes);
  const restoreClock = Date.now;
  let rebuilt: Record<string, unknown>;
  try {
    Date.now = () => fixedBackupNow;
    rebuilt = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_REBUILD, {}));
  } finally {
    Date.now = restoreClock;
  }
  eq("★ MC-054:同毫秒已有备份不能被显式修复覆盖", SettingRepo.get(priorBackupKey), priorBackupBytes);
  check("★ MC-054:重建返回新且不与旧备份冲突的键", typeof rebuilt.backupKey === "string" && rebuilt.backupKey !== priorBackupKey, rebuilt.backupKey);
  eq("★ MC-054:显式重建成功", rebuilt.ok, true);
  check(
    "★ MC-054:重建返回备份键",
    typeof rebuilt.backupKey === "string" && rebuilt.backupKey.startsWith("automation.watch.templates.corrupt-"),
    rebuilt.backupKey,
  );
  eq(
    "★ MC-054:备份内容逐字节等于损坏原值",
    SettingRepo.get(rebuilt.backupKey as string),
    JSON.stringify(mixed),
  );
  eq("★ MC-054:重建保住了读得出的好条目(2 条)", rebuilt.kept, 2);
  const afterRebuild = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  eq("★ MC-054:重建后健康态翻回 valid", afterRebuild.health, "valid");
  same(
    "★ MC-054:重建后剩下的就是那两条好的",
    (afterRebuild.templates as Array<{ id: string }>).map((t) => t.id),
    ["a", "d"],
  );
  SettingRepo.delete(rebuilt.backupKey as string);
  SettingRepo.delete(priorBackupKey);

  // 没坏的时候「重建」要拒绝(不静默做用户没要的事)。
  const noNeed = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_REBUILD, {}));
  eq("★ MC-054:文件没坏时显式重建拒绝(不做多余动作)", noNeed.ok, false);

  // 【MC-054】首读遭临时 IO 错误，随后真实原件又能读到：这不等于原件真的
  // corrupt。旧代码把 read_error 也视作可重建，省略 templates 时清空整表。
  const healthyBeforeGlitch = JSON.stringify([{ id: "stable", name: "原健康模板", command: "echo keep" }]);
  SettingRepo.set("automation.watch.templates", healthyBeforeGlitch);
  const realGetBeforeGlitch = SettingRepo.get;
  let faultCount = 0;
  (SettingRepo as { get: (key: string) => string | null }).get = (key: string) => {
    if (key === "automation.watch.templates" && faultCount++ === 0) {
      throw new Error("MC054_TRANSIENT_READ_ERROR_TEST_ONLY");
    }
    return realGetBeforeGlitch(key);
  };
  let rebuildOnReadError: Record<string, unknown>;
  try {
    rebuildOnReadError = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_REBUILD, {}));
  } finally {
    (SettingRepo as { get: (key: string) => string | null }).get = realGetBeforeGlitch;
  }
  eq("★ MC-054:瞬时读错不能触发显式重建并清空原本健康模板", rebuildOnReadError.ok, false);
  eq("★ MC-054:读错之后现存健康模板原始字节不变", SettingRepo.get("automation.watch.templates"), healthyBeforeGlitch);

  // MC-054 并发窗口：先读到部分损坏旧数据，在备份前另一写入者已修成健康
  // 新版本；旧实现会备份新的原件，却根据旧 partial 列表回写，丢掉对方更新。
  const partialBeforeConcurrentUpdate = JSON.stringify(mixed);
  const concurrentHealthyRaw = JSON.stringify([{ id: "newer", name: "并发恢复的新模板", command: "echo newest" }]);
  SettingRepo.set("automation.watch.templates", partialBeforeConcurrentUpdate);
  const originalGetForConcurrent = SettingRepo.get;
  let matchedReads = 0;
  (SettingRepo as { get: (key: string) => string | null }).get = (key: string) => {
    if (key === "automation.watch.templates" && matchedReads++ === 1) {
      SettingRepo.set("automation.watch.templates", concurrentHealthyRaw);
    }
    return originalGetForConcurrent(key);
  };
  let rebuildWithStalePartial: Record<string, unknown>;
  try {
    rebuildWithStalePartial = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_REBUILD, {}));
  } finally {
    (SettingRepo as { get: (key: string) => string | null }).get = originalGetForConcurrent;
  }
  eq("★ MC-054:重建期间原模板被并发修改应拒绝过期快照", rebuildWithStalePartial.ok, false);
  eq("★ MC-054:过期快照被拒后并发更新的原始字节保持不变",
    SettingRepo.get("automation.watch.templates"), concurrentHealthyRaw);

  // 健康状态下正常保存照旧(没被上面的拒写卡死)。【MC-054 第十七轮】现在必须带
  // revision —— 否则连健康态也拒(那正是修复:旧调用方不再被静默放行)。
  const healthyRev = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES)).revision;
  const saveRes = obj(
    await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
      templates: [{ id: "a", name: "好的", command: "echo 1" }],
      expectedRevision: healthyRev,
    }),
  );
  eq("健康时存模板返回 ok", saveRes.ok, true);
  const back = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same("存进去的读得回来", (back.templates as Array<{ id: string }>).map((t) => t.id), ["a"]);
  eq("正常读的 health=valid", back.health, "valid");

  /* ── 【MC-054】原值版本检查:两端并发编辑不许静默丢更新 ──────────────────
     台账第十六轮红例:两个客户端都读了健康空表,各存 [A]、[B],两次都 ok:true,
     最后只剩 [B](第一个人的保存无声消失)。现在保存方带回读到的 revision,
     盘上已变 → 拒绝 + 带回 currentRevision,由界面重读。 */
  SettingRepo.set("automation.watch.templates", JSON.stringify([]));
  const readA = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  const readB = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  check("★ MC-054:读返回 revision", typeof readA.revision === "string" && (readA.revision as string).length > 0, readA.revision);
  eq("★ MC-054:同内容两次读 revision 相同(判的是内容)", readA.revision, readB.revision);
  const saveA = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "A", name: "甲", command: "echo A" }],
    expectedRevision: readA.revision,
  }));
  eq("客户端 A 用当前 revision 保存成功", saveA.ok, true);
  const saveB = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "B", name: "乙", command: "echo B" }],
    expectedRevision: readB.revision,
  }));
  eq("★ MC-054:A 已保存后,B 用旧 revision 保存被拒(不覆盖 A 的)", saveB.ok, false);
  eq("★ MC-054:拒绝标了 conflict", saveB.conflict, true);
  check("★ MC-054:带回盘上当前 revision 供界面重读", typeof saveB.currentRevision === "string", saveB.currentRevision);
  same(
    "★ MC-054:盘上仍是 A 的内容(第一个人的保存没有无声消失)",
    (JSON.parse(SettingRepo.get("automation.watch.templates") ?? "[]") as Array<{ id: string }>).map((t) => t.id),
    ["A"],
  );
  // 【MC-054 第十七轮复核】不带 expectedRevision 的旧调用方**必须被拒**:
  // 上一版把"没给 = 整表覆盖"当兼容,结果是两条旧快照各存 [A]/[B]、最后只剩 [B]。
  // 现在缺字段即冲突,并带回当前 revision 供调用方重读。
  const legacySave = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "L", name: "旧", command: "echo L" }],
  }));
  eq("★ MC-054:不带 revision 的旧调用方被拒(不再静默整表覆盖)", legacySave.ok, false);
  // ⚠️ 只看 ok:false 会假绿:把"缺字段"改成放行后,`undefined !== revision` 仍成立,
  // 同一笔调用会被**冲突分支**接住 —— 结果同样是 ok:false。判据必须落到**拒绝语**
  // 上:缺字段要明确说"没有带原值版本(revision)",而不是一句"已被别处改动"。
  check("★ MC-054:拒绝理由点明「没有带 expectedRevision」(不是冲突误报)",
    typeof legacySave.error === "string" && legacySave.error.includes("没有带原值版本"),
    legacySave.error);
  eq("★ MC-054:拒绝标了 conflict", legacySave.conflict, true);
  check("★ MC-054:拒绝带回当前 revision 供重读", typeof legacySave.currentRevision === "string", legacySave.currentRevision);
  // 盘上必须没有写进 [L] —— 拒绝是真的没写。
  const afterLegacy = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  check("★ MC-054:被拒后盘上没有 [L](拒绝真的不写)",
    !(afterLegacy.templates as Array<{ id?: string }>).some((t) => t.id === "L"), afterLegacy.templates);
  // 【MC-054】显式 null 也绝不能绕过普通保存的 CAS。重建有专用 RPC
  // 且原值先备份；普通 save 即使收到 "null" 也必须保留 A 已提交的数据。
  const beforeNull = SettingRepo.get("automation.watch.templates");
  const explicitNull = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "N", name: "显式覆盖", command: "echo N" }], expectedRevision: null,
  }));
  eq("★ MC-054:显式 null 不能绕过普通保存 CAS", explicitNull.ok, false);
  eq("★ MC-054:null 版本拒写仍有冲突诊断", explicitNull.conflict, true);
  eq("★ MC-054:null 版本被拒后原值逐字节保全", SettingRepo.get("automation.watch.templates"), beforeNull);
  // 复原成一条干净的健康表,后续断言按自己的路径继续。
  await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [], expectedRevision: obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES)).revision,
  });
  // 同一个版本连续保存两次(自撞):第二次必须用第一次之后的新 revision。
  const r1 = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  const s1 = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "X", name: "一", command: "echo 1" }], expectedRevision: r1.revision,
  }));
  eq("第一次保存成功", s1.ok, true);
  const staleAgain = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "Y", name: "二", command: "echo 2" }], expectedRevision: r1.revision,
  }));
  eq("★ MC-054:用旧 revision 再存一次被拒(自己撞自己也要挡)", staleAgain.ok, false);
  const r2 = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  const s2 = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
    templates: [{ id: "Y", name: "二", command: "echo 2" }], expectedRevision: r2.revision,
  }));
  eq("★ MC-054:重读后的新 revision 保存通过", s2.ok, true);
  // 顺序无关:同一批模板换顺序 → revision 不变(判内容,不判写法)。
  const ordered = [{ id: "a", name: "甲", command: "echo 1" }, { id: "b", name: "乙", command: "echo 2" }];
  const reversed = [...ordered].reverse();
  eq("★ MC-054:模板顺序不同但内容相同 → revision 相同", watchTemplatesRevision(ordered), watchTemplatesRevision(reversed));
  eq("★ MC-054:内容改一个字节 → revision 变", watchTemplatesRevision(ordered) === watchTemplatesRevision([{ ...ordered[0], command: "echo 1 " }, ordered[1]]), false);
}

/* ──────────────── 10. 自动化运行历史:存档坏掉的那些 ──────────────── */

console.log("\n自动化那一栏 · 历史从哪来");

{
  // 自动化跑过的运行落在**专用的隐藏会话**里(`kind: "automation"`,按 workflowId 找)。
  // 没跑过的时候**必须返回空**、而且不能现建一条空会话 —— 那会在会话列表里凭空多出
  // 一个没人用过的对话。
  same(
    "没跑过的自动化 → 历史是空的",
    obj(await callAsync(IPC.AUTOMATION_RUNS, { workflowId: "wf_从来跑过" })).runs,
    [],
  );
  eq(
    "没跑过的自动化 → 后台会话是 null(不是现建一条)",
    obj(await callAsync(IPC.AUTOMATION_SESSIONS, { workflowId: "wf_从来跑过" })).sessionId,
    null,
  );

  // 得造一条真的后台会话行才验得下去。形状照 `automationRunner` 里建会话那一段
  // (`kind: "automation"`、`providerId`、`composerMode` 存的是 workflowId ——
  // 那个列名在撒谎,见 `SessionRepo.findAutomationByWorkflow` 的注释)。真建一个项目,
  // 不填 `project_id` 会被外键/非空拦掉。
  const project = ProjectRepo.create({
    id: "prj_smoke",
    name: "烟测项目",
    path: DATA,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never) as unknown as { id: string } | void;
  const projectId = (project as { id: string } | undefined)?.id ?? "prj_smoke";
  SessionRepo.create({
    id: "s_smoke_auto",
    projectId,
    providerId: "claude",
    claudeSessionId: null,
    kind: "automation",
    parentSessionId: null,
    composerMode: "wf_hist",
    title: "自动化 · 烟测",
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "plan",
    workflowId: "wf_hist",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);
  // ⚠️ `create` 不返回行 —— 读回来验(`kind` 在落库时四值归一过一次,读回来还该是它)。
  eq(
    "建出来的会话 kind 读回来还是 automation",
    SessionRepo.findAutomationByWorkflow("wf_hist")?.kind,
    "automation",
  );
  // ⚠️ 归属那个值在**库里**住在 `composer_mode` 列(列名撒谎,`sessionSchema.ts` 里
  // 写着),而读出来挂到 Session 对象上叫 **`workflowId`**(`col.key` 是 workflowId)。
  // 两处名字不一样,这是本套逮到的第一个"名字与实现对不上"的地方。
  eq(
    "它记得自己属于哪个工作流(库里叫 composer_mode,对象上叫 workflowId)",
    SessionRepo.findAutomationByWorkflow("wf_hist")?.workflowId,
    "wf_hist",
  );
  eq(
    "按工作流找得到它",
    obj(await callAsync(IPC.AUTOMATION_SESSIONS, { workflowId: "wf_hist" })).sessionId,
    "s_smoke_auto",
  );

  // 写三条运行:**读不回来的**、**版本不认识的**、**完好但摘要很长而且有一个节点已经
  // 不在图里了的**。三条都要列出来 —— "这次运行存在过"这件事不该因为存档坏了就消失。
  WorkflowRunRepo.save({
    id: "r_broken",
    sessionId: "s_smoke_auto",
    workflowId: "wf_hist",
    status: "success",
    payload: "{这不是 json",
    awaiting: [],
  });
  WorkflowRunRepo.save({
    id: "r_future",
    sessionId: "s_smoke_auto",
    workflowId: "wf_hist",
    status: "success",
    payload: JSON.stringify({
      version: 9999,
      cwd: "/tmp",
      capturedAt: 1,
      prompt: "",
      state: { record: [], rounds: [], picks: [], outcomes: [], awaiting: [] },
    }),
    awaiting: [],
  });
  const longSummary = "第一行" + "很长".repeat(200) + "\n第二行不该出现";
  WorkflowRunRepo.save({
    id: "r_ok",
    sessionId: "s_smoke_auto",
    workflowId: "wf_hist",
    status: "failed",
    payload: JSON.stringify({
      cwd: "/tmp",
      capturedAt: 1,
      prompt: "",
      state: {
        record: [],
        rounds: [],
        picks: [],
        awaiting: [],
        outcomes: [
          ["gone", { status: "success", summary: "这个节点已经不在图里了" }],
          ["n_fail", { status: "failed", summary: longSummary, error: "命令挂了" }],
        ],
      },
    }),
    awaiting: [],
  });

  // 【ARC-016】这一条**记了运行时锁下的档案版本** —— 用来验「这一轮用了哪一版指令,
  // 现在还一样吗」的 readback。**用独立的会话与工作流**,不动上面那组"三条都在"的
  // 精确清单断言。两个档案:一个源没变(不该报落后)、一个源已变(该报)。
  // 档案文件写在**本次运行的临时数据根**下(agentProfileContentHash 走 dataRoot()),
  // 用**合法**的档案形状(version/id 都对),免得污染别处读目录的断言。
  {
    const agentsDir = join(DATA, "workflows", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const profileFile = (id: string, name: string): string =>
      JSON.stringify({ version: 1, id, name, type: "mcode.agent", params: {}, createdAt: 1, updatedAt: 1 });
    writeFileSync(join(agentsDir, "p_stable.json"), profileFile("p_stable", "稳定"), "utf-8");
    writeFileSync(join(agentsDir, "p_edited.json"), profileFile("p_edited", "改过"), "utf-8");
    SessionRepo.create({
      ...SessionRepo.get("s_smoke_auto")!,
      id: "s_cfg_drift", kind: "automation", workflowId: "wf_cfg_drift", title: "配置漂移 · 烟测",
    });
    // 运行当时锁下的是 p_edited 的**旧**哈希(与磁盘上刚写的不同)+ p_stable 的当前哈希。
    const stableNow = agentProfileContentHash("p_stable");
    WorkflowRunRepo.save({
      id: "r_cfg",
      sessionId: "s_cfg_drift",
      workflowId: "wf_cfg_drift",
      status: "success",
      payload: JSON.stringify({
        cwd: "/tmp",
        capturedAt: 1,
        prompt: "",
        state: { record: [], rounds: [], picks: [], awaiting: [], outcomes: [] },
        configSnapshot: {
          takenAt: 5,
          profiles: { p_stable: stableNow, p_edited: "sha256:当时那一版" },
          skills: [],
        },
      }),
      awaiting: [],
    });
  }

  const runs = obj(await callAsync(IPC.AUTOMATION_RUNS, { workflowId: "wf_hist" })).runs as Array<{
    runId: string;
    status: string;
    steps: Array<{ nodeId: string; title: string; status: string; summary: string; error?: string }>;
  }>;

  // 三条都在。**存档读不回来的照样列一条**,只是没有步骤 —— "历史里凭空少了一次"
  // 比"这一次没有步骤"更让人看不懂。
  same(
    "三条运行都列出来了(存档坏掉的那两条也没消失)",
    runs.map((r) => r.runId).sort(),
    ["r_broken", "r_future", "r_ok"],
  );
  eq("读不回来的那条:照样在,但 steps 是空的", runs.find((r) => r.runId === "r_broken")?.steps.length, 0);
  eq(
    "版本不认识的那条:同样当过期,不硬读(硬读会炸在更深处)",
    runs.find((r) => r.runId === "r_future")?.steps.length,
    0,
  );

  const ok = runs.find((r) => r.runId === "r_ok");
  eq("完好的那条:两步都在", ok?.steps.length, 2);
  // ⚠️ 节点的**标题**从图里取,取不到退回 id —— 只给 id 的话列表里没人认得出那是哪一步。
  // 这里那个工作流根本没存过,所以退回 id 是**对的行为**。
  eq(
    "图里没有那个工作流 → 标题退回节点 id(不是空白)",
    ok?.steps.find((s) => s.nodeId === "gone")?.title,
    "gone",
  );
  // 摘要是**整段文本**折出来的东西,不截的话会把一行列表撑成一屏。
  const sum = ok?.steps.find((s) => s.nodeId === "n_fail")?.summary ?? "";
  check("长约 400 字的摘要被截到 200 字以内", sum.length <= 201, sum.length);
  check("而且末尾标了省略号(用户知道被截了)", sum.endsWith("…"), sum.slice(-10));
  check("只留首行(第二行不在)", !sum.includes("第二行"), sum.slice(-30));
  eq("失败那一步带着 error 给人看", ok?.steps.find((s) => s.nodeId === "n_fail")?.error, "命令挂了");

  // ── 【Agent 可读面】失败分类、耗时、triggerKey、limit ──
  // 同一份保存档折出来,不另存:分类判据与调度器重试同一份(`retryable` 优先,
  // 缺席才按错误文本猜),耗时只在收尾态给,running 不算结束时刻。
  // **独立工作流与会话**:不污染上面那组按 wf_hist 精确清单的既有断言。
  {
    type Entry = {
      runId: string; status: string; startedAt: number; updatedAt: number;
      endedAt?: number; durationMs?: number; triggerKey?: string;
      failureClass?: string; error?: string;
    };
    const AGENT_WF = "wf_hist_agent";
    SessionRepo.create({
      id: "s_hist_agent",
      projectId,
      providerId: "claude",
      claudeSessionId: null,
      kind: "automation",
      parentSessionId: null,
      composerMode: AGENT_WF,
      title: "自动化 · Agent 可读面",
      status: "idle",
      model: "default",
      effort: "default",
      permissionMode: "plan",
      workflowId: AGENT_WF,
      customModelId: null,
      envMode: "local",
      worktreePath: null,
      archived: false,
      pinnedAt: null,
      contextSnapshot: null,
      todos: null,
      subagents: null,
      planDraft: null,
      turnFiles: null,
      usageHistory: null,
      bookmarks: null,
      subagentTranscripts: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    const saveAgentRun = (id: string, status: string, state: unknown): void => {
      WorkflowRunRepo.save({
        id, sessionId: "s_hist_agent", workflowId: AGENT_WF, status: status as never,
        payload: JSON.stringify({ cwd: "/tmp", capturedAt: 1, prompt: "", state }), awaiting: [],
      });
    };
    // 收尾的失败运行:首步瞬时故障(带 retryable:true)、末步终态失败。
    saveAgentRun("a_classes", "failed", {
      record: [], rounds: [], picks: [], awaiting: [],
      entry: { nodeId: "t_sched", summary: "到点了" },
      outcomes: [
        ["n_rate", { status: "failed", summary: "限流", error: "429 rate limit", retryable: true }],
        ["n_bad", { status: "failed", summary: "参数坏", error: "参数不合法" }],
      ],
    });
    // 健康运行(防空过):成功、有步骤,不带失败分类。
    saveAgentRun("a_ok", "success", {
      record: [], rounds: [], picks: [], awaiting: [],
      outcomes: [["n_done", { status: "success", summary: "做完了" }]],
    });
    // 进行中的运行:没有结束时刻、没有耗时。
    saveAgentRun("a_running", "running", { record: [], rounds: [], picks: [], awaiting: [], outcomes: [] });
    // 终态失败但错误文本像网络故障(执行器没表态 → 按文本猜成瞬时)。
    saveAgentRun("a_text", "failed", {
      record: [], rounds: [], picks: [], awaiting: [],
      outcomes: [["n_net", { status: "failed", summary: "断网", error: "fetch failed: ECONNRESET" }]],
    });

    const all = obj(await callAsync(IPC.AUTOMATION_RUNS, { workflowId: AGENT_WF, limit: 50 })).runs as Entry[];
    const byId = (id: string) => all.find((r) => r.runId === id);
    eq("★ 失败分类:retryable 优先,首个失败步是瞬时 → transient", byId("a_classes")?.failureClass, "transient");
    eq("★ 失败原因原样带回(首个 failed 步)", byId("a_classes")?.error, "429 rate limit");
    eq("★ 失败分类:执行器没表态时按错误文本猜(网络 → transient)", byId("a_text")?.failureClass, "transient");
    eq("★ 失败分类:成功运行不带分类", byId("a_ok")?.failureClass, undefined);
    check(
      "★ 耗时:收尾态给 endedAt 与 durationMs(>=0)",
      byId("a_ok")?.endedAt !== undefined && (byId("a_ok")?.durationMs ?? -1) >= 0,
      byId("a_ok"),
    );
    eq("耗时的值就是 endedAt - startedAt", byId("a_ok")?.durationMs, (byId("a_ok")?.endedAt ?? 0) - (byId("a_ok")?.startedAt ?? 0));
    eq("★ 进行中的运行没有 endedAt(不拿最后一次落盘冒充结束)", byId("a_running")?.endedAt, undefined);
    eq("进行中的运行没有 durationMs", byId("a_running")?.durationMs, undefined);
    eq("★ triggerKey 从存档 entry 折出来", byId("a_classes")?.triggerKey, `${AGENT_WF}:t_sched`);
    eq("没有 entry 的老运行不带 triggerKey", byId("a_ok")?.triggerKey, undefined);
    // 健康路径(防空过):普通成功运行仍在列表里、状态正确。
    check("★ 正常一条也在(成功运行照常列出)", byId("a_ok")?.status === "success" && all.length === 4, { len: all.length, ok: byId("a_ok") });

    // ── 限数分页 ──
    const limited = obj(await callAsync(IPC.AUTOMATION_RUNS, { workflowId: AGENT_WF, limit: 2 })).runs as Entry[];
    eq("★ limit 生效:只回 2 条", limited.length, 2);
    check("limit 回的是最新的那几条(按 updatedAt 倒序)", limited[0]?.runId === all[0]?.runId, { first: limited[0]?.runId, allFirst: all[0]?.runId });
    const over = await callAsync(IPC.AUTOMATION_RUNS, { workflowId: AGENT_WF, limit: 51 }).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
    check("★ limit 上限 50:超限显式拒绝(不是静默截断)", typeof over === "string" && over.length > 0, over);
  }
}

/* ──────────────── 11. 某个对话的图运行历史 ──────────────── */

console.log("\n对话里那张「跑过什么」");

{
  const rows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_smoke_auto" })) as Array<{
    runId: string;
    nodeCount: number;
    status: string;
    configDrift?: Array<{ assetId: string; kind: string; lockedHash: string | null; currentHash: string | null }>;
  }>;
  same(
    "同一个会话的三条都在",
    rows.map((r) => r.runId).sort(),
    ["r_broken", "r_future", "r_ok"],
  );
  // **一行列表不该拖着整份快照过 IPC** —— 折成 nodeCount 就够,取不到按 0 算。
  eq("完好的那条 nodeCount 是 2", rows.find((r) => r.runId === "r_ok")?.nodeCount, 2);
  eq(
    "读不回来的那条 nodeCount 按 0 算(不是 undefined)",
    rows.find((r) => r.runId === "r_broken")?.nodeCount,
    0,
  );
  check(
    "返回的是**裸数组**(渲染端按数组消费,包一层会让每个调用点多一次解构)",
    Array.isArray(rows),
    typeof rows,
  );
  same("不认识的那个会话 → 空数组,不抛", await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_没有这个" }), []);
}

/* 【ARC-016】readback:一次运行**当时**记下的档案版本,与**现在**源档案比,挑出落后项。 */
{
  const rows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_cfg_drift" })) as Array<{
    runId: string;
    configDrift?: Array<{ assetId: string; kind: string; lockedHash: string | null; currentHash: string | null }>;
  }>;
  const drift = rows.find((r) => r.runId === "r_cfg")?.configDrift;
  check("记了配置快照的那条带上落后项", Array.isArray(drift), drift);
  eq("只报改过的那一个档案(源没变的不报)", drift?.map((d) => d.assetId).join(","), "p_edited");
  eq("落后项性质是 changed", drift?.[0]?.kind, "changed");
  eq("不带档案正文,只带哈希差异 —— locked 是当时那一版", drift?.[0]?.lockedHash, "sha256:当时那一版");
  check(
    "没记配置快照的运行**不带** configDrift(不是空数组硬塞)",
    rows.length > 0 && rows.every((r) => r.configDrift === undefined || r.runId === "r_cfg"),
    rows.map((r) => r.runId),
  );
}

/* 存档读不回来的运行不该带 configDrift —— 没有快照就没有落后项。 */
{
  const rows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_smoke_auto" })) as Array<{
    runId: string;
    configDrift?: unknown;
  }>;
  check(
    "存档读不回来的那条不带 configDrift",
    rows.find((r) => r.runId === "r_broken")?.configDrift === undefined,
  );
}

/* 【ARC-016】变更计划:同一条运行走**声明式锁版**判定的口径 —— 把当时锁下的哈希当成一批
 * `PINNED`/`RUN_START` 的 ConfigBinding,经 `resolveConfigBinding` 解析出当时**生效**的那一版
 * 与它是否已落后,再由 `staleBindings` 挑出落后项。这是台账点名的「源档案比声明的 lock 新」的
 * 变更计划,也是这三个纯函数唯一一处真实生产调用端。 */
{
  const rows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_cfg_drift" })) as Array<{
    runId: string;
    configChangePlan?: Array<{
      assetId: string;
      effectiveHash: string | null;
      policy: string;
      stale: boolean;
    }>;
  }>;
  const plan = rows.find((r) => r.runId === "r_cfg")?.configChangePlan;
  check("记了配置快照的那条带上变更计划", Array.isArray(plan), plan);
  eq("变更计划只挑**落后**的那一个档案(源没变的不进计划)", plan?.map((p) => p.assetId).join(","), "p_edited");
  eq("LOCKED 的是当时生效的那一版哈希(锁版意义就是不随源变)", plan?.[0]?.effectiveHash, "sha256:当时那一版");
  eq("每条都是 PINNED 策略(运行起跑时锁下的)", plan?.[0]?.policy, "PINNED");
  eq("落后的那一条 stale 为真", plan?.[0]?.stale, true);
  // 没记配置快照 / 存档读不回来的运行**不带**这个字段(不是空数组硬塞)。
  check(
    "没记配置快照的运行不带 configChangePlan",
    rows.every((r) => r.configChangePlan === undefined || r.runId === "r_cfg"),
    rows.map((r) => r.runId),
  );
  const autoRows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_smoke_auto" })) as Array<{
    runId: string;
    configChangePlan?: unknown;
  }>;
  check(
    "存档读不回来的那条不带 configChangePlan",
    autoRows.find((r) => r.runId === "r_broken")?.configChangePlan === undefined,
  );
}


/* A workflow's history spans project-specific automation sessions, not chat runs. */
{
  ProjectRepo.create({ ...ProjectRepo.get("prj_smoke")!, id: "prj_hist_B", path: DATA + "/B" });
  SessionRepo.create({ ...SessionRepo.get("s_smoke_auto")!, id: "s_hist_B", projectId: "prj_hist_B", createdAt: 1, updatedAt: 1 });
  SessionRepo.create({ ...SessionRepo.get("s_smoke_auto")!, id: "s_hist_chat", kind: "chat" });
  for (const [id, sessionId, workflowId] of [
    ["r_project_B", "s_hist_B", "wf_hist"],
    ["r_other_workflow", "s_hist_B", "wf_other"],
    ["r_chat_not_automation", "s_hist_chat", "wf_hist"],
  ]) {
    WorkflowRunRepo.save({ id: id!, sessionId: sessionId!, workflowId: workflowId!, status: "success", payload: "{}", awaiting: [] });
  }
  getDb().run("UPDATE workflow_runs SET updated_at = 9000000000000 WHERE id = 'r_project_B'");
  const history = async (limit?: number): Promise<Array<{ runId: string }>> =>
    obj(await callAsync(IPC.AUTOMATION_RUNS, { workflowId: "wf_hist", ...(limit === undefined ? {} : { limit }) })).runs as Array<{ runId: string }>;
  same("跨项目历史保留 A/B 全部记录且排除普通对话和其他工作流", (await history()).map(r => r.runId).sort(), ["r_broken", "r_future", "r_ok", "r_project_B"]);
  eq("跨项目历史按运行更新时间排序", (await history())[0]?.runId, "r_project_B");
  eq("limit 作用于合并后的历史而非每个项目", (await history(2)).length, 2);
  eq("限制条数仍保留最新项目运行", (await history(1))[0]?.runId, "r_project_B");
  eq("后台会话入口认最近运行而非最近创建会话", obj(await callAsync(IPC.AUTOMATION_SESSIONS, { workflowId: "wf_hist" })).sessionId, "s_hist_B");
  same("会话入口包含所有项目且不含聊天会话", (obj(await callAsync(IPC.AUTOMATION_SESSIONS, { workflowId: "wf_hist" })).sessionIds as string[]).sort(), ["s_hist_B", "s_smoke_auto"]);
  // 【2026-10-17】`@renderer/lib/automationHistory.ts` 已删除:它唯一的消费方(旧自动化
  // 历史面板)已由 `automation.runs` 单通道取代,该模块在 src 里零 import。这里原先
  // 那一组 loadAutomationHistory 断言随之删除 —— 被测函数不存在了,留着只会测一个副本。
  // `runs.history` 通道本身仍被 `WorkflowBoardPanel` 使用,上一段的 handler 断言继续覆盖。

}

/* ──────────────── 12b. ★ 触发前只读预检(automation.preflight) ──────────────── */

// 真 handler + 真清单 + 真能力装配(plugin stub 返回空、engine 真注册了 command/code)。
// 三类问题各造一条,外加健康正控与"不产生任何副作用"的计数断言。
console.log("\n触发前只读预检");

{
  const { workflowReviewOf } = await import("@main/orchestration/workflowTrust.js");
  const { WorkflowRepo } = await import("@main/store/repositories.js");

  // 夹具:一条带触发器的自动化。节点清单用真内置(触发器 + 命令节点)。
  const preflightDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "wf_preflight",
    name: "预检夹具",
    prompt: "",
    builtin: false,
    updatedAt: 0,
    nodes: [
      { id: "main", type: "mcode.main", title: "入口", params: { instruction: "跑" }, position: { x: 0, y: 0 } },
      { id: "t1", type: "mcode.trigger", title: "触发器", params: { triggerKind: "manual", project: "prj_smoke", task: "手动跑" }, position: { x: 0, y: 100 } },
      { id: "c1", type: "mcode.command", title: "跑命令", params: { command: "echo hi" }, position: { x: 0, y: 200 } },
    ],
    edges: [],
    ...over,
  });
  WorkflowRepo.save(preflightDoc() as never);

  const preflight = async (raw: unknown): Promise<Record<string, unknown>> =>
    obj(await callAsync(IPC.AUTOMATION_PREFLIGHT, raw));
  const runCountBefore = (await (async () => {
    const { WorkflowRunRepo } = await import("@main/store/repositories.js");
    return WorkflowRunRepo.listForAutomationWorkflow("wf_preflight", 50).length;
  })());

  // ① 健康:ok、列出能力、problem 缺席。
  {
    const r = await preflight({ workflowId: "wf_preflight", triggerNodeId: "t1" });
    eq("★ 健康触发器 → ok", r.ok, true);
    eq("★ 健康触发器 → 没有 problem", r.problem, undefined);
    eq("★ 健康触发器 → problems 空数组", (r.problems as unknown[]).length, 0);
    eq("★ 健康触发器 → 列出 triggerKey", r.triggerKey, "wf_preflight:t1");
    const caps = r.capabilities as { required: string[]; available: string[] };
    check("★ 健康触发器 → 列出所需能力(空过防线:至少能读到结构)", Array.isArray(caps.required) && Array.isArray(caps.available), caps);
    check("★ 健康触发器 → 已满足能力是所需能力的子集", caps.available.every((c) => caps.required.includes(c)), caps);
  }

  // ② 缺执行器:造一个引用了没装节点类型的节点 → missing-executor 点名。
  {
    WorkflowRepo.save(preflightDoc({
      nodes: [
        { id: "c1", type: "ghost.node", title: "幽灵步骤", params: {}, position: { x: 0, y: 0 } },
        { id: "t1", type: "mcode.trigger", title: "触发器", params: { triggerKind: "manual", project: "prj_smoke", task: "跑" }, position: { x: 0, y: 100 } },
      ],
    }) as never);
    const r = await preflight({ workflowId: "wf_preflight", triggerNodeId: "t1" });
    eq("★ 缺执行器 → ok:false", r.ok, false);
    eq("★ 缺执行器 → problem.kind=missing-executor", (r.problem as { kind?: string })?.kind, "missing-executor");
    check(
      "★ 缺执行器 → 原因点名那个节点类型(可读)",
      String((r.problem as { reason?: string })?.reason ?? "").includes("ghost.node"),
      r.problem,
    );
  }

  // ③ 坏档:存储层把坏 payload 退化成空文档(id 对不上)→ corrupt,且不是"不存在"。
  {
    const origGet = WorkflowRepo.get;
    WorkflowRepo.get = ((id: string) => id === "wf_preflight"
      ? { id, name: "坏", description: null, icon: null, builtin: false, updatedAt: 0,
          doc: { id: "", name: "", nodes: [], edges: [], builtin: false, updatedAt: 0 } }
      : origGet.call(WorkflowRepo, id)) as typeof WorkflowRepo.get;
    try {
      const r = await preflight({ workflowId: "wf_preflight", triggerNodeId: "t1" });
      eq("★ 坏档 → ok:false", r.ok, false);
      eq("★ 坏档 → problem.kind=corrupt(不是谎报不存在)", (r.problem as { kind?: string })?.kind, "corrupt");
      check(
        "★ 坏档 → 原因可读(说存档损坏)",
        String((r.problem as { reason?: string })?.reason ?? "").includes("损坏"),
        r.problem,
      );
    } finally {
      WorkflowRepo.get = origGet;
    }
  }

  // ④ 需审查:标记为待审 → needs-grant,与 runNow 的拒绝同源。
  {
    WorkflowRepo.save(preflightDoc() as never);
    const { requireWorkflowReview } = await import("@main/orchestration/workflowTrust.js");
    requireWorkflowReview("wf_preflight", "import");
    const r = await preflight({ workflowId: "wf_preflight", triggerNodeId: "t1" });
    eq("★ 未审查 → problem.kind=needs-grant", (r.problem as { kind?: string })?.kind, "needs-grant");
    const { approveWorkflowRevision } = await import("@main/orchestration/workflowTrust.js");
    const { workflowRevision } = await import("@main/orchestration/workflowTrust.js");
    const doc = WorkflowRepo.get("wf_preflight")!.doc;
    approveWorkflowRevision(doc, workflowRevision(doc));
    const okAgain = await preflight({ workflowId: "wf_preflight", triggerNodeId: "t1" });
    eq("批准后预检恢复 ok(闸门没关过头)", okAgain.ok, true);
  }

  // ⑤ 不存在 / 触发器不在图里。
  {
    const missing = await preflight({ workflowId: "wf_根本不存在", triggerNodeId: "t1" });
    eq("不存在的工作流 → problem.kind=missing", (missing.problem as { kind?: string })?.kind, "missing");
    const noTrigger = await preflight({ workflowId: "wf_preflight", triggerNodeId: "nope" });
    eq("触发器不在图里 → problem.kind=missing", (noTrigger.problem as { kind?: string })?.kind, "missing");
  }

  // ⑥ **只读**:整个过程不产生任何运行记录、不建后台会话。
  {
    const { WorkflowRunRepo } = await import("@main/store/repositories.js");
    eq("★ 预检不产生任何运行记录(计数断言)", WorkflowRunRepo.listForAutomationWorkflow("wf_preflight", 50).length, runCountBefore);
    eq("★ 预检不建后台会话", SessionRepo.listAutomationsByWorkflow("wf_preflight").length, 0);
    eq("预检后 workflowReviewOf 仍是已审查(没有写审查记录)", workflowReviewOf(WorkflowRepo.get("wf_preflight")!.doc)?.pending, false);
  }
}

/* ──────────────── 12. 无参 handler 收到 undefined 时不能炸 ──────────────── */

console.log("\n不带参数地 invoke");

// 这一条是**踩过的坑**(见文件里那段注释):不带参数 invoke 时 handler 收到的是
// `undefined`,而 `z.object({}).parse(undefined)` 报 `invalid_type` —— toolchain 那边
// 真炸过一次,面板一打开就红。所以无参的那几条必须**不 parse raw**。
for (const [name, ch] of [
  ["工作流列表", IPC.WORKFLOW_LIST],
  ["节点类型清单", IPC.WORKFLOW_NODE_TYPES],
  ["代理档案列表", IPC.WORKFLOW_AGENT_PROFILES],
  ["全部触发器事实", IPC.AUTOMATION_STATUS_ALL],
  ["命令模板", IPC.AUTOMATION_WATCH_TEMPLATES],
] as Array<[string, string]>) {
  let err = "";
  try {
    await callAsync(ch);
  } catch (e) {
    err = (e as Error).message;
  }
  eq(`${name}:不带参数调不抛`, err, "");
}

/* ──────────────── 13. 带参 handler 收到坏入参时明确拒绝 ──────────────── */

console.log("\n坏入参");

// 这些是渲染端 bug / 手改过的 IPC 流量会送进来的形状。**必须明确报错**,不能悄悄
// 当成"空对象"往下走 —— 那样 `workflow:get` 会返回一个 null 让界面显示空白,而真正
// 的原因(参数没传对)一个字都没有。
for (const [name, ch, raw] of [
  ["取工作流:没给 id", IPC.WORKFLOW_GET, {}],
  ["取工作流:id 是空串", IPC.WORKFLOW_GET, { id: "" }],
  ["存工作流:整份文档缺了", IPC.WORKFLOW_SAVE, {}],
  ["删工作流:没给 id", IPC.WORKFLOW_REMOVE, {}],
  ["导出:没给 id", IPC.WORKFLOW_EXPORT, {}],
  ["自动化历史:没给 workflowId", IPC.AUTOMATION_RUNS, {}],
  ["自动化的后台会话:没给 workflowId", IPC.AUTOMATION_SESSIONS, {}],
  ["守望起跑:没给 sessionId", IPC.AUTOMATION_WATCH, {}],
  ["守望状态:没给 sessionId", IPC.AUTOMATION_WATCH_STATUS, {}],
  // 【MC-054】expectedRevision 现在必填 —— 这两条要测的是**别的**字段错,
  // 所以显式给 null,否则 Zod 先在 revision 上报错,断言测不到目标。
  ["存模板:templates 不是数组", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, { templates: "不是数组", expectedRevision: null }],
  ["存模板:模板里缺 command", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, { templates: [{ id: "a", name: "甲" }], expectedRevision: null }],
  ["存档案:没给 profile", IPC.WORKFLOW_SAVE_AGENT_PROFILE, {}],
  ["删档案:没给 id", IPC.WORKFLOW_REMOVE_AGENT_PROFILE, {}],
  ["岔路口:没给参数", IPC.WORKFLOW_CHOOSE, {}],
  ["重试:没给参数", IPC.WORKFLOW_RETRY, {}],
  ["跑一次:没给 workflowId", IPC.AUTOMATION_RUN, {}],
  ["历史:没给 sessionId", IPC.RUNS_HISTORY, {}],
  ["导入:没给 text", IPC.WORKFLOW_IMPORT, {}],
] as Array<[string, string, unknown]>) {
  let err = "";
  try {
    await callAsync(ch, raw);
  } catch (e) {
    err = (e as Error).message;
  }
  check(`${name} → 明确拒绝(抛错,不是当空对象往下走)`, err.length > 0, { err });
}

/* ──────────────── 14. 导入:两条路共用一段收尾 ──────────────── */

console.log("\n导入");

{
  resetSent();
  // 坏 JSON → 明确报错,而且**带上解析器那句原文**(用户得知道错在第几个字符)。
  const bad = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: "{这不是 json" }));
  eq("坏 JSON → ok:false", bad.ok, false);
  check(
    "报的是「不是合法的 JSON」并带上原因",
    String((bad.errors as string[])?.join(" ")).includes("JSON"),
    bad,
  );
  same("失败不广播", sent.length, 0);

  // 覆盖一个不存在的工作流 → 说清"覆盖不了不存在的一份",而不是顺手新建一个。
  const nomatch = obj(
    await callAsync(IPC.WORKFLOW_IMPORT, { text: JSON.stringify(goodDoc()), id: "wf_没这个" }),
  );
  eq("覆盖不存在的 → ok:false", nomatch.ok, false);
  check(
    "而且报文里说得清是「覆盖不了不存在的一份」",
    String((nomatch.errors as string[])?.join(" ")).includes("覆盖"),
    nomatch.errors,
  );

  // 重名要绕开的是**别的行**。
  //
  // ⚠️ 导进来的**文本里必须自带 id**:`importWorkflowDoc` 那一关按 `WorkflowDoc` 契约
  // 解析,而契约里 `id` 是必填。不带 `opts.id` 时,`importWorkflowInto` 会**丢掉文本里
  // 那个 id**、现生成一个新的(`opts.id ?? makeWorkflowId()`)—— 这就是"导入一份新的"。
  const srcText = JSON.stringify({ ...goodDoc(), id: "wf_别人分享来的" });
  const first = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: srcText }));
  eq("导入一份新的 → ok", first.ok, true);
  check("给了个新 id", String(first.id).startsWith("wf_"), first.id);
  check(
    "而且不是文本里那个 id(导入 = 新建一份,不是覆盖)",
    first.id !== "wf_别人分享来的",
    { textId: "wf_别人分享来的", got: first.id },
  );
  const again = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: srcText }));
  eq("再导一次同名 → ok", again.ok, true);
  check("第二次的名字被绕开了(不重名)", again.name !== first.name, {
    first: first.name,
    again: again.name,
  });
  check("两次的 id 不同(是两份东西)", again.id !== first.id, { first: first.id, again: again.id });
  eq(
    "两次导入各广播一次(共 2 次)",
    sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length,
    2,
  );

  // 【ARC-006】导入含未知节点类型与未知字段的档案 —— handler 必须把解析阶段的
  // 提醒**原样送到调用方**(渲染端 / Agent)。从前 `importWorkflowInto` 把
  // `parseWorkflowText` 算出的 warnings 丢了,`finishImport` 拿到的是空,界面看到的
  // 是一次"完整导入",而图里有一个这一版不认识的节点、外加一批被保留但没人告诉他的
  // 字段。判据立在**IPC 返回值**上:这是界面唯一能看见的那一份。
  const fidelitySrc = {
    ...goodDoc({ id: "wf_import_fidelity", name: "导入保真" }),
    futureDocField: { keep: true },
    nodes: [
      { id: "main", type: "mcode.main", title: "入口", params: { instruction: "把活分给下游" }, position: { x: 0, y: 0 } },
      {
        id: "n2",
        type: "acme.future-node",
        title: "未来节点",
        params: { instruction: "做点什么" },
        position: { x: 0, y: 120 },
        futureNodeField: ["keep"],
      },
    ],
  };
  const fidelity = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: JSON.stringify(fidelitySrc) }));
  eq("含未知节点/字段的档案 → 仍可导入", fidelity.ok, true);
  const fidelityWarnings = Array.isArray(fidelity.warnings) ? (fidelity.warnings as string[]) : [];
  check(
    "★ 导入成功时 warnings 随 IPC 结果回来(不再在 main 里丢掉)",
    fidelityWarnings.length > 0,
    fidelity,
  );
  check(
    "★ 而且点名未知节点类型与已保留的未知字段",
    fidelityWarnings.some((w) => w.includes("acme.future-node")) &&
      fidelityWarnings.some((w) => w.includes("futureNodeField")) &&
      fidelityWarnings.some((w) => w.includes("已原样保留")),
    fidelityWarnings,
  );
  // 落库之后再从 get 读一遍:未知节点与字段都还在(拒绝不算、没丢才算)。
  const fidelityBack = obj(await callAsync(IPC.WORKFLOW_GET, { id: fidelity.id }));
  const backDoc = (fidelityBack.workflow ?? {}) as Record<string, unknown>;
  const backNodes = (backDoc.nodes ?? []) as Array<Record<string, unknown>>;
  check(
    "★ 未知节点与未知字段在库里原样保留(get 读得回来)",
    backNodes.some((n) => n.id === "n2" && n.type === "acme.future-node" && JSON.stringify(n.futureNodeField) === JSON.stringify(["keep"])) &&
      JSON.stringify(backDoc.futureDocField) === JSON.stringify({ keep: true }),
    { nodes: backNodes.map((n) => n.type), futureDocField: backDoc.futureDocField },
  );

  // 从文件导入,两条路:**用户取消** / **真读到一个文件**。
  resetDialog();
  const cancelled = obj(await callAsync(IPC.WORKFLOW_IMPORT_FROM_FILE, {}));
  eq("从文件导入:选文件被取消 → ok:false", cancelled.ok, false);
  eq("标着 canceled(界面据此静默,不弹红框)", cancelled.canceled, true);

  // 真的挑到一个文件 —— 这条走的是 `readFile` 那一段,和上面那条是两码事。
  const pick = join(DATA, "导入源.json");
  writeFileSync(
    pick,
    JSON.stringify({ ...goodDoc(), id: "wf_从文件来的", name: "从文件来的" }),
    "utf8",
  );
  setOpenPaths([pick]);
  resetSent();
  const fromFile = obj(await callAsync(IPC.WORKFLOW_IMPORT_FROM_FILE, {}));
  eq("真的挑到文件 → ok", fromFile.ok, true);
  check("新 id 与文件里那个不同(从文件导入同样是新建)", fromFile.id !== "wf_从文件来的", fromFile.id);
  eq("成功也广播一次(和另一条入口走同一段收尾)", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 1);

  // 文件挑到了但**读不出来**(这里给一个目录)—— 报错而不是当空文本往下走。
  setOpenPaths([DATA]);
  const unreadable = obj(await callAsync(IPC.WORKFLOW_IMPORT_FROM_FILE, {}));
  eq("挑到的文件读不出来 → ok:false", unreadable.ok, false);
  eq("而且不是标成 canceled(那不是用户取消,该报错)", unreadable.canceled, undefined);
  check("报得出读失败的原因", String(unreadable.error).length > 0, unreadable.error);
  resetDialog();
}

/* ──────────────── 14b. 审查启用:主进程只批准当前保存版本 ──────────────── */

{
  const imported = obj(await callAsync(IPC.WORKFLOW_IMPORT, {
    text: JSON.stringify(goodDoc({ id: "wf_review_source", name: "审批冒烟" })),
  }));
  eq("审核夹具先导入成功", imported.ok, true);
  const id = String(imported.id);
  const before = obj(await callAsync(IPC.WORKFLOW_GET, { id }));
  check("从 IPC 读回的是待审查版本和准确摘要", before.review !== null && obj(before.review).pending === true && /^[a-f0-9]{64}$/.test(String(obj(before.review).revision)));
  const revision = String(obj(before.review ?? {}).revision);

  resetSent();
  eq("审批找不到的版本不启用", obj(await callAsync(IPC.WORKFLOW_APPROVE, { id: "wf_missing_review", revision })).ok, false);
  const stale = obj(await callAsync(IPC.WORKFLOW_APPROVE, { id, revision: "0".repeat(64) }));
  eq("旧摘要的审批不启用", stale.ok, false);
  eq("拒绝审批不广播变更", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 0);
  const approved = obj(await callAsync(IPC.WORKFLOW_APPROVE, { id, revision }));
  eq("审批当前保存版本可启用", approved.ok, true);
  eq("审批触发一次工作流重载广播", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 1);
  eq("刷新再看已不待审", obj(obj(await callAsync(IPC.WORKFLOW_GET, { id })).review).pending, false);

  const changed = { ...(before.workflow as WorkflowDoc), description: "这份图现在做另一件事" };
  const saveVersion = String(before.revision);
  check("工作流读取返回完整保存版本", /^[a-f0-9]{64}$/.test(saveVersion));
  eq("用户本地改图后能保存", obj(await callAsync(IPC.WORKFLOW_SAVE, { workflow: changed, expectedRevision: saveVersion })).ok, true);
  const updated = obj(await callAsync(IPC.WORKFLOW_GET, { id }));
  eq("同 id 改图撤销旧审批", obj(updated.review).pending, true);
  eq("拿旧摘要重新审批仍被拒", obj(await callAsync(IPC.WORKFLOW_APPROVE, { id, revision })).ok, false);
  resetSent();
  const staleSave = obj(await callAsync(IPC.WORKFLOW_SAVE, {
    workflow: { ...changed, description: "陈旧草稿不该盖掉新图" }, expectedRevision: saveVersion,
  }));
  eq("旧保存版本拒绝跨写者覆盖", staleSave.ok, false);
  check("冲突给出明确提示", String(staleSave.error).includes("修改"), staleSave.error);
  eq("冲突不广播", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 0);
  eq("冲突保留服务端新图", obj(obj(await callAsync(IPC.WORKFLOW_GET, { id })).workflow).description, "这份图现在做另一件事");
}

/* ──────────────── 15. 导出 ──────────────── */

console.log("\n导出");

{
  const missing = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "wf_没这个" }));
  eq("找不到那一份 → ok:false", missing.ok, false);
  // **静默写一个空文件比报错更坏**。报的那句话里要点得到是哪个 id。
  check("报的那句话里带得出 id", String(missing.error).includes("wf_没这个"), missing.error);

  // 取消:文件框返回"取消" → `{ok:false, canceled:true}`,界面据此静默。
  // 用内置那份(`default`)—— 取消只可能发生在**找得到工作流之后**,给个不存在的 id
  // 走的是上面那条"找不到"的路,根本到不了文件框。
  resetDialog();
  const cancelled = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "default" }));
  eq("用户取消 → ok:false", cancelled.ok, false);
  eq("标着 canceled", cancelled.canceled, true);

  // **真的写一个文件出去** —— 上面那条只走到文件框就回来了,这一段才是导出真正做的事。
  // 先建一份确定在库里的工作流(前面的节删过 `wf_smoke`)。
  resetDialog();
  await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_导出源", name: "导出源" }) });
  const target = join(DATA, "导出去的.json");
  setSavePath(target);
  const written = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "wf_导出源" }));
  eq("写盘成功 → ok", written.ok, true);
  eq("返回里给回写了哪个路径", written.path, target);
  check("那个文件真的在", existsSync(target), target);
  const onDisk = JSON.parse(readFileSync(target, "utf8")) as { id: string; name: string; nodes: unknown[] };
  eq("写出去的 JSON 里是那一份(self-describing:带着自己的 id)", onDisk.id, "wf_导出源");
  eq("名字也带着", onDisk.name, "导出源");
  eq("图的两个节点都在", onDisk.nodes.length, 2);

  // **文件名是洗过再交给文件框的**:用一个名字里带 `/` 的工作流存一次,看 defaultPath。
  // 桩不实现 defaultPath 的观测,所以这里断的是**能到达写盘**这件事 —— 名字里有非法
  // 字符不该让整条导出挂掉(那正是 `sanitizeFileBase` 存在的理由)。
  resetDialog();
  await callAsync(IPC.WORKFLOW_SAVE, {
    workflow: goodDoc({ id: "wf_斜杠", name: "文献综述 / 第一版" }),
  });
  const target2 = join(DATA, "斜杠导出去的.json");
  setSavePath(target2);
  const written2 = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "wf_斜杠" }));
  eq("名字里有路径分隔符也能导出去(没把路径拼坏)", written2.ok, true);
  check("第二个文件也在", existsSync(target2), target2);

  // 目标路径写不进去(给一个目录)→ 报错,不吞。
  setSavePath(DATA);
  const unwritable = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "wf_导出源" }));
  eq("目标写不进去 → ok:false", unwritable.ok, false);
  check("而且报得出原因", String(unwritable.error).length > 0, unwritable.error);
  resetDialog();
}

/* ──────────────── 16. 岔路口 / 重试:过期的卡片不是错误 ──────────────── */

console.log("\n过期的卡片");

// `ok: false` **不抛错**:点一张过期的卡片(运行早结束了)是正常会发生的事,给用户弹
// 一个错误框只会让他以为自己做错了什么。所以这里断的是"返回 false 而不是抛"。
{
  let thrown = "";
  let res: unknown;
  try {
    res = await callAsync(IPC.WORKFLOW_CHOOSE, {
      sessionId: "s_没有这个会话",
      runId: "r_没有这次运行",
      nodeId: "n1",
      edgeId: "e_没有这条边",
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  eq("岔路口:点过期的卡片不抛", thrown, "");
  eq("而是返回 ok:false", obj(res).ok, false);

  thrown = "";
  try {
    res = await callAsync(IPC.WORKFLOW_RETRY, {
      sessionId: "s_没有这个会话",
      runId: "r_没有这次运行",
      nodeId: "n1",
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  eq("重试:过期的卡片不抛", thrown, "");
  eq("而是返回 ok:false", obj(res).ok, false);

  eq(
    "全部触发器事实:没有自动化时是**裸空数组**(不是 {facts:[]})",
    JSON.stringify(await callAsync(IPC.AUTOMATION_STATUS_ALL)),
    "[]",
  );
}

/* ──────────────── 16b. 触发器诊断:Agent 读到的"现在还算不算失败" ──────────────── */

// 原始 `lastError` 是只增不改的旧账;`automation.statusAll` 现在对每条事实叠一层
// 判定后的诊断(`activeFailure` / `activeFailureAt` / `missedNotice`)—— 判据就是界面
// 用的 `latestFailureOf`/`missedNoticeOf`(同一份契约函数),Agent 经 app_api_call
// 拿到的是同一段 handler 的返回,不必自己重判。
console.log("\n★ 触发器诊断:旧账不冒充现状、健康行照常列出");

{
  const { automationRunner } = await import("@main/orchestration/automationRunner.js");
  const { AutomationFacts } = await import("@main/orchestration/automationStatus.js");
  type FactsHolder = { facts: InstanceType<typeof AutomationFacts> };
  const facts = (automationRunner as unknown as FactsHolder).facts;
  const seed = (workflowId: string, nodeId: string, title: string) => ({
    workflowId, nodeId, title, kind: "schedule" as const, enabled: true,
  });

  // ① 仍阻塞:失败之后没再跑过 → activeFailure + 时刻。
  facts.recordBlocked(seed("wf_health", "t_blocked", "被阻塞的"), "项目不在了(p_gone)", 1_000);
  // ② 健康:挂上且跑过、没有失败 → 照常列出,无 activeFailure(防空过)。
  facts.recordSetup(seed("wf_health", "t_healthy", "健康的"), true);
  facts.recordFired(seed("wf_health", "t_healthy", "健康的"), 2_000);
  // ③ 旧账:失败发生在起跑**之前** → 原始 lastError 还在,但现状不显示。
  facts.recordFired(seed("wf_health", "t_recovered", "已恢复的"), 3_000);
  facts.recordBlocked(seed("wf_health", "t_recovered", "已恢复的"), "上一次还在跑,这一次触发已跳过", 1_000);
  // ④ 错过:该提示 3 次。
  facts.recordMissed(seed("wf_health", "t_missed", "错过定时的"), 3, 4_000);

  const rows = (await callAsync(IPC.AUTOMATION_STATUS_ALL)) as Array<Record<string, unknown>>;
  const byKey = (k: string) => rows.find((r) => r.key === k);
  const blocked = byKey("wf_health:t_blocked");
  eq("★ 阻塞事实:只读方法带回原因(activeFailure)", blocked?.activeFailure, "项目不在了(p_gone)");
  eq("★ 阻塞事实:带回时刻(activeFailureAt)", blocked?.activeFailureAt, 1_000);
  const healthy = byKey("wf_health:t_healthy");
  check("★ 健康触发器也列出(防空过)", healthy !== undefined && healthy.armed === true, healthy);
  eq("健康行没有 activeFailure", healthy?.activeFailure, undefined);
  const recovered = byKey("wf_health:t_recovered");
  eq("★ 旧账不冒充现状:恢复过的行没有 activeFailure", recovered?.activeFailure, undefined);
  eq("原始 lastError 原样保留(判定是叠加不是替换)", recovered?.lastError, "上一次还在跑,这一次触发已跳过");
  eq("★ 错过提示带回来(missedNotice)", byKey("wf_health:t_missed")?.missedNotice, 3);

  // 清场:注入的事实别影响同一进程里后面的用例。
  facts.retainWorkflow("wf_health", new Set());
}

/* ──────────────── 17. 代理档案 ──────────────── */

console.log("\n代理档案");

{
  // 一份档案的 id 形状由契约管着(`p_[a-z0-9_]+`),不是随便起名 —— 因为它要当文件名。
  const good = {
    version: 1,
    id: "p_smoke_1",
    name: "烟测档案",
    type: "mcode.agent",
    params: { instruction: "整理文献" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  let thrown = "";
  let res: unknown;
  try {
    res = await callAsync(IPC.WORKFLOW_SAVE_AGENT_PROFILE, { profile: good });
  } catch (e) {
    thrown = (e as Error).message;
  }
  eq("存一份合法的档案不抛", thrown, "");
  eq("而且报的是存上了", obj(res).ok, true);

  const list = obj(await callAsync(IPC.WORKFLOW_AGENT_PROFILES));
  check(
    "列表里能读到刚存的那一份",
    (list.profiles as Array<{ id: string }>).some((p) => p.id === "p_smoke_1"),
    list,
  );
  same("干干净净读完 → problems 是空的", list.problems, []);

  // **坏档案显式报出来,不静默丢**(硬规矩第 3 条,`readAgentProfiles` 文件头也写着)。
  // 直接往那个目录里塞一份坏的 —— 用户手改就是这个样子。
  const dir = join(DATA, "workflows", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "p_坏了.json"), "{这不是 json", "utf8");
  const withBad = obj(await callAsync(IPC.WORKFLOW_AGENT_PROFILES));
  check(
    "坏档案:好的那份还在(没被连坐)",
    (withBad.profiles as Array<{ id: string }>).some((p) => p.id === "p_smoke_1"),
    withBad.profiles,
  );
  check(
    "坏档案:文件名和原因一起报出来(不是静默跳过)",
    JSON.stringify(withBad.problems).includes("p_坏了.json"),
    withBad.problems,
  );

  // 文件名和里面的 id 对不上 —— 这是手改最常见的一步,要说得清是"改名还是改 id"。
  // ⚠️ 两个 id 都得先**合法**(`p_[a-z0-9_]+`),否则会先被 schema 的 regex 挡下,
  // 走的是"id 形状不对"那条路,验不到"对不上"这一条。
  writeFileSync(
    join(dir, "p_mismatch.json"),
    JSON.stringify({ ...good, id: "p_other" }),
    "utf8",
  );
  const mismatch = obj(await callAsync(IPC.WORKFLOW_AGENT_PROFILES));
  check(
    "id 与文件名对不上 → 报的那句话说得清两个名字",
    JSON.stringify(mismatch.problems).includes("p_other") &&
      JSON.stringify(mismatch.problems).includes("p_mismatch"),
    mismatch.problems,
  );

  // 存一份**格式错的** → **在 handler 那一关就抛**(`AgentProfileSaveSchema.parse`),
  // 走不到 `saveAgentProfile` 自己的 `{ok:false}` 那条路。
  //
  // ⚠️ 这是本套逮到的第二处「同一个动作有两条形状」:`agentProfiles.ts` 里
  // `saveAgentProfile` 明明写了 `{ok:false, error}` 的返回,而 IPC 入口在它之前就被
  // zod 拦下抛错 —— 那条 `{ok:false}` 在界面上**永远走不到**。这里把**现状**钉住。
  let savedThrew = "";
  try {
    await callAsync(IPC.WORKFLOW_SAVE_AGENT_PROFILE, {
      profile: { id: "p_x", name: "缺一堆字段" },
    });
  } catch (e) {
    savedThrew = (e as Error).message;
  }
  check("存一份格式错的 → 抛错(zod 那一关拦的,不是 `{ok:false}`)", savedThrew.length > 0, savedThrew);
  check("而且那句话点得出错在哪个字段", savedThrew.includes("version"), savedThrew);

  // 删一个不存在的:同样不该抛(与 `workflow:remove` 一致)。
  // ⚠️ id 得是**合法形状**,否则 `AgentProfileRemoveSchema` 的 regex 先把中文挡在门外。
  thrown = "";
  try {
    res = await callAsync(IPC.WORKFLOW_REMOVE_AGENT_PROFILE, { id: "p_never_saved" });
  } catch (e) {
    thrown = (e as Error).message;
  }
  eq("删一个不存在的档案不抛", thrown, "");
  eq("而且说成是成功的(要的结局已经在了)", obj(res).ok, true);

  // 形状不对的 id → 明确拒绝,不当"没这个文件"往下走。
  thrown = "";
  try {
    await callAsync(IPC.WORKFLOW_REMOVE_AGENT_PROFILE, { id: "从来没存过" });
  } catch (e) {
    thrown = (e as Error).message;
  }
  check("删档案:id 形状不对 → 明确拒绝", thrown.includes("id"), thrown);
}

/* ──────────────── 17b. 【MC-030】目录**读不了** ≠ 资源不存在 ────────────────
 *
 * `nodeTypes.loadDir` / `agentProfiles.readAgentProfiles` 从前对 `readdirSync` 的**任何**
 * 异常都返回空 `{...,problems:[]}` —— 于是 ACL/硬盘错误(读不了)与 ENOENT(真没有)被合并成
 * "资源没配置",目录里明明有档案却因为暂时读不了而**静默消失**。修法:只有真·ENOENT 才是
 * 正常空,其它错误进 `problems`(字段本来就有,界面在消费)。这里用**真权限拒绝**造 EACCES。
 *
 * ⚠️ Windows 上手工恢复 ACL 不可靠(实测 `icacls /restore` 清不掉 `/deny` 留下的 ACE)。
 * 所以本段**只在隔离的一次调用上造 EACCES**,并在结束时**尽力撤销**;即便撤销失败,被拒的
 * 也只是本段自建的那个临时 agents 目录,不污染其它用例(它们在别的路径上)。 */
{
  const { execFileSync } = await import("node:child_process");
  const agentsDir = join(DATA, "workflows", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const user = process.env.USERNAME ?? process.env.USER ?? "";
  const isWin = process.platform === "win32";
  let madeDeny = false;
  try {
    if (isWin) { execFileSync("icacls", [agentsDir, "/deny", `${user}:(R)`], { stdio: "ignore" }); madeDeny = true; }
    else { execFileSync("chmod", ["000", agentsDir], { stdio: "ignore" }); madeDeny = true; }
  } catch { /* 造不出来就走跳过分支 */ }
  // 自证真读不了(否则断言会空过)。
  let reallyDenied = false;
  if (madeDeny) { try { readdirSync(agentsDir); } catch { reallyDenied = true; } }
  if (reallyDenied) {
    const denied = obj(await callAsync(IPC.WORKFLOW_AGENT_PROFILES));
    check(
      "★ MC-030:档案目录读不了(EACCES)→ 报进 problems(不是静默空)",
      JSON.stringify(denied.problems).includes(agentsDir) || JSON.stringify(denied.problems).includes("读不了"),
      denied.problems,
    );
    // 对照(ENOENT = 正常空、无 problem)已由本段开头那条「干干净净读完 → problems 是空的」覆盖:
    // 那条走的是"目录存在但没有坏文件"的正常路径。二者合起来证明判据**只对非 ENOENT 报**。
    // 尽力撤销(失败也不影响其它用例 —— 被拒的是本段自建的目录)。
    try {
      if (isWin) execFileSync("icacls", [agentsDir, "/remove:d", user], { stdio: "ignore" });
      else execFileSync("chmod", ["755", agentsDir], { stdio: "ignore" });
    } catch { /* 尽力 */ }
  } else {
    console.log("  (跳过:本环境造不出 EACCES 夹具)");
  }
}

/* ──────────────── 18. 同一个 "建节点" 的动作:界面与 AI 是不是同一条路 ──────────────── */

console.log("\n新建节点:两条路会不会分家");

// 任务是这么问的:「界面上点『新建』建节点」和「AI / 自动化建节点」是不是同一个函数。
// 答案在这个文件里不好直接断 —— 那条路在渲染端的 `settings/workflows/` 里。这里能断的是
// **主进程这一侧唯一的入口**:节点类型清单只有一份,两条路都得问它要。
{
  const catalog = obj(await callAsync(IPC.WORKFLOW_NODE_TYPES));
  const entries = catalog.entries as Array<{ id: string; manifest: { runner: { kind: string } } }>;
  check("IPC 清单带着含条件、模块能力与 Node-RED 的 10 种内置类型",
    entries.filter((e) => e.id.startsWith("mcode.")).length === 10 &&
      entries.some((e) => e.id === "mcode.condition" && e.manifest.runner.kind === "condition") &&
      entries.some((e) => e.id === "mcode.module-capability" && e.manifest.runner.kind === "module-capability") &&
      entries.some((e) => e.id === "mcode.node-red" && e.manifest.runner.kind === "node-red"), {
    got: entries.map((e) => e.id),
  });
  same("这一份读得干干净净 → problems 是空的", catalog.problems, []);

  // 每一种内置的 runner.kind 都得在 `IMPLEMENTED_RUNNER_KINDS` 里 —— 这就是任务里
  // 那条「种子里的每个类型都能被解析出来」在**主进程这一侧**的等价断言。
  const kinds = (IMPLEMENTED_RUNNER_KINDS as readonly string[]) ?? [];
  const bad = entries
    .filter((e) => e.id.startsWith("mcode."))
    .filter((e) => !kinds.includes(e.manifest.runner.kind))
    .map((e) => `${e.id}:${e.manifest.runner.kind}`);
  same("内置的每一种 runner.kind 都是「实现过的」(没有配得出来但跑不通的)", bad, []);
}

/* ──────────────── 18. 窗口没开着时,写操作照样成功 ──────────────── */

console.log("\n没有界面在听的时候");

{
  setWindow({ alive: false });
  resetSent();
  const res = obj(await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_nowindow" }) }));
  eq("窗口没开着:存照样成功", res.ok, true);
  same(
    "广播发不出去,但**不是错误**(一次已经写成功的操作不该因为没人听而报错)",
    sent.length,
    0,
  );
  eq(
    "而且真的存下去了",
    obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_nowindow" })).workflow !== null,
    true,
  );
  setWindow({ alive: true });
}

/* ──────────────── 19. 自带工作流的出厂版更新(2026-09-30) ──────────────── */

console.log("\n出厂版更新");

{
  const { WorkflowRepo } = await import("@main/store/repositories.js");
  const { BUILTIN_WORKFLOWS } = await import("@main/orchestration/builtins.js");
  type Entry = { id: string; shippedUpdate?: boolean };
  const list = async (): Promise<Entry[]> => obj(await callAsync(IPC.WORKFLOW_LIST)).workflows as Entry[];
  const flagOf = async (id: string) => (await list()).find((e) => e.id === id)?.shippedUpdate === true;
  const staleAck = (id: string) => {
    const raw = SettingRepo.get("workflow.shippedRevisions");
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[id] = "0".repeat(64);
    SettingRepo.set("workflow.shippedRevisions", JSON.stringify(map));
  };
  const alive = new Set((await list()).map((e) => e.id));
  // 出厂版更新现在能对上的**只剩按钮后端那几样**(可选内容外置后,库里播种的自带行
  // 只有 `default` / `watch` / `memory-*`)。挑一份**无节点**的和一份**带触发器**的
  // 来跑这套标记逻辑 —— `default` 无节点、`watch` 有触发器。(`default` 的 prompt 是
  // 空串,但下面用的是"改成一个非空值再比对",空串照样能区分出厂版与用户改动。)
  const promptOne = BUILTIN_WORKFLOWS.find((d) => d.nodes.length === 0 && alive.has(d.id));
  const withTrigger = BUILTIN_WORKFLOWS.find((d) => alive.has(d.id) && d.nodes.some((n) => n.type === "mcode.trigger"));
  check("找得到一份无节点的、一份带触发器的自带工作流", promptOne !== undefined && withTrigger !== undefined, [...alive]);

  if (promptOne && withTrigger) {
    const id = promptOne.id;
    eq("刚播种的自带行:没有更新标记", await flagOf(id), false);

    // 用户改过、出厂版没变 → 不提示(已记到当前出厂版)。
    WorkflowRepo.save({ ...promptOne, prompt: "用户自己改的一版", builtin: false, updatedAt: Date.now() });
    eq("用户改过但出厂版没变:不提示", await flagOf(id), false);

    // 出厂版变了(记录落后)而这一行不等于新版 → 提示。
    staleAck(id);
    eq("出厂版变了、这一行不是新版:提示有更新", await flagOf(id), true);

    // 忽略:标记消失,内容不动。
    resetSent();
    eq("忽略 → ok", obj(await callAsync(IPC.WORKFLOW_DISMISS_SHIPPED_UPDATE, { id })).ok, true);
    eq("忽略之后不再提示", await flagOf(id), false);
    eq("忽略不改内容", (obj(await callAsync(IPC.WORKFLOW_GET, { id })).workflow as WorkflowDoc).prompt, "用户自己改的一版");
    check("忽略也广播了(列表标记变了)", sent.length > 0, sent.length);

    // 应用:换成出厂版,标记消失。
    staleAck(id);
    eq("再次落后 → 又提示", await flagOf(id), true);
    eq("应用更新 → ok", obj(await callAsync(IPC.WORKFLOW_APPLY_SHIPPED_UPDATE, { id })).ok, true);
    eq("应用之后内容就是出厂版", (obj(await callAsync(IPC.WORKFLOW_GET, { id })).workflow as WorkflowDoc).prompt, promptOne.prompt);
    eq("应用之后不再提示", await flagOf(id), false);

    // 用户关掉的触发器,更新后保持关闭。
    const tid = withTrigger.id;
    const trig = withTrigger.nodes.find((n) => n.type === "mcode.trigger")!;
    WorkflowRepo.save({
      ...withTrigger,
      nodes: withTrigger.nodes.map((n) => (n.id === trig.id ? { ...n, params: { ...n.params, enabled: false } } : n)),
      description: "旧描述",
      builtin: false,
      updatedAt: Date.now(),
    });
    staleAck(tid);
    eq("带触发器的那份:提示有更新", await flagOf(tid), true);
    eq("应用更新 → ok", obj(await callAsync(IPC.WORKFLOW_APPLY_SHIPPED_UPDATE, { id: tid })).ok, true);
    const after = obj(await callAsync(IPC.WORKFLOW_GET, { id: tid })).workflow as WorkflowDoc;
    eq("更新后描述回到出厂版", after.description, withTrigger.description);
    eq("用户关掉的触发器保持关闭", after.nodes.find((n) => n.id === trig.id)?.params.enabled, false);
    eq("更新后不再提示(即便触发器开关与出厂版不同)", await flagOf(tid), false);

    // 删掉的自带工作流:不提示,也更新不回来。
    await callAsync(IPC.WORKFLOW_REMOVE, { id });
    staleAck(id);
    check("删掉的自带工作流不出现在列表里", !(await list()).some((e) => e.id === id));
    eq("删掉的更新不回来", obj(await callAsync(IPC.WORKFLOW_APPLY_SHIPPED_UPDATE, { id })).ok, false);
    eq("删掉的也不会被更新写回", obj(await callAsync(IPC.WORKFLOW_GET, { id })).workflow, null);
  }
  eq("不是自带的 id:应用被拒", obj(await callAsync(IPC.WORKFLOW_APPLY_SHIPPED_UPDATE, { id: "wf_nowindow" })).ok, false);
  eq("不是自带的 id:忽略被拒", obj(await callAsync(IPC.WORKFLOW_DISMISS_SHIPPED_UPDATE, { id: "wf_nowindow" })).ok, false);
}

/* ──────────────── 20. 自定义 UI 运行自动化:回收站不能当落点 ──────────────── */

/**
 * `targetMode: "context"`(文献导入那种「只定位不展开」)要拒绝**回收站分类**。
 *
 * ⚠️ 这道筛子曾经是死的:它读 `collection.isTrash`,而 `CollectionRepo.list()` 里那一格
 * 恒为 `false`(回收站标记是 `ipc/library.ts` 那层 `markTrashCollections` 事后贴的)。
 * 于是「回收站不能作为落点」永远不生效 —— 用户在回收站上右键「文献导入」,东西会被
 * 收进回收站。判据只能走 `allTrashCollectionIds`(回收站的唯一真相)。
 */
console.log("\n自定义 UI 运行自动化(回收站)");
{
  const trashId = ensureTrashCollection();
  const resTrash = obj(
    await callAsync(IPC.CUSTOM_UI_RUN_AUTOMATION, {
      workflowId: "wf_不存在", triggerNodeId: "t", target: { kind: "collection", collectionId: trashId },
      targetMode: "context",
    }),
  );
  eq("回收站分类不能当 context 落点", resTrash.error, "回收站不能作为落点");

  // 普通分类仍放行到「找触发器」那一步(证明被拒的是回收站身份,不是别的)。
  const normal = CollectionRepo.create("普通分类", null, "paper");
  const resNormal = obj(
    await callAsync(IPC.CUSTOM_UI_RUN_AUTOMATION, {
      workflowId: "wf_不存在", triggerNodeId: "t", target: { kind: "collection", collectionId: normal.id },
      targetMode: "context",
    }),
  );
  check("普通分类不当场被拒(继续去找触发器)", resNormal.error !== "回收站不能作为落点", resNormal);

  // `targetMode: "scope"`(默认,展开成条目批次)在**条目**目标上也要剔回收站。
  // 条目不是软删(回收站只是集合归属),`LibraryRepo.get` 照样捞得回来;这条路从前
  // 只查 get + shouldSkipItem,漏了回收站 —— 右键回收站里的一条就能对已删的东西跑自动化。
  const trashed = LibraryRepo.upsert({ title: "已被丢进回收站的一条" }).id;
  CollectionRepo.assign(trashId, [trashed], true);
  check("夹具:这条确实落进了回收站", LibraryRepo.listByCollection(trashId).some((i) => i.id === trashed));
  const resItemTrash = obj(
    await callAsync(IPC.CUSTOM_UI_RUN_AUTOMATION, {
      workflowId: "wf_不存在", triggerNodeId: "t", target: { kind: "item", itemId: trashed },
    }),
  );
  eq("回收站里的条目不能当 scope 目标", resItemTrash.error, "这一条在回收站里,先还原再运行");

  // 大类目标同样要查"大类还在不在":被删的大类会一路走到 roots 为空,报成
  // 「这个范围里没有条目」—— 那说的是另一回事,用户以为范围空,其实是大类没了。
  const resGroupGone = obj(
    await callAsync(IPC.CUSTOM_UI_RUN_AUTOMATION, {
      workflowId: "wf_不存在", triggerNodeId: "t", target: { kind: "group", groupId: "grp_已被删掉" },
    }),
  );
  eq("不存在的大类不当成空范围", resGroupGone.error, "这个大类已经不存在了");
}

/* ──────────────── 21. ★ MC-028:损坏的默认快照表不许当写入基准 ──────────────── */

/**
 * 「设为默认」是**读-改-写**:`loadPinnedDefaults()` → `map[id] = doc` → 整份写回。
 * 从前读坏数据时它返回 `{}`(塌成"没配过"),于是盘上已有的 A/B 两份快照被当成
 * "不存在",在写入那一刻**静默丢掉**。存储字符串被截断(断电 / 磁盘满 / 手改坏)
 * 正是这个形状。
 *
 * 判据立在**盘上的字节**上("旧快照有没有被抹掉")和**用户看到的那行字**上
 * ("有没有被告知"),不立在内部函数名上。写侧见到损坏必须 fail-closed(旧字节一个
 * 都不动),读侧仍降级成空表 —— 与 `secretMapStore.ts` 同一条纪律(硬规矩 3)。
 */
console.log("\n★ 损坏的自定默认表不能被静默覆盖");

{
  const KEY = "workflow.pinnedDefaults";

  // 夹具:先正常钉两份(A、B)—— 这就是"已有 A/B 快照"。
  for (const id of ["wf_pinA", "wf_pinB"]) {
    await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id, name: id }) });
    await callAsync(IPC.WORKFLOW_PIN_DEFAULT, { id });
  }
  const before = SettingRepo.get(KEY)!;
  check(
    "夹具:A / B 两份快照确实钉在盘上",
    before.includes("wf_pinA") && before.includes("wf_pinB"),
    before.slice(0, 80),
  );

  // 把存储字符串**截断** —— 正是 MC-028 的形状。
  const truncated = before.slice(0, Math.floor(before.length / 2));
  SettingRepo.set(KEY, truncated);
  const bytesOnDisk = SettingRepo.get(KEY)!;
  eq("夹具:盘上现在是一段截断的坏 JSON", bytesOnDisk, truncated);

  // 用户给 C 设默认 —— 从前这里会把 A/B 当成"不存在"、整份写回,把 A/B 抹掉。
  await callAsync(IPC.WORKFLOW_SAVE, { workflow: goodDoc({ id: "wf_pinC", name: "wf_pinC" }) });
  const pinBefore = logLines.length;
  const res = obj(await callAsync(IPC.WORKFLOW_PIN_DEFAULT, { id: "wf_pinC" }));

  eq("★ 坏表 → 拒绝设默认(不是默默成功)", res.ok, false);
  check(
    "★ 拒绝时说清了原因(不是空错误)",
    typeof res.error === "string" && (res.error as string).length > 10,
    res.error,
  );
  // ★ **判据立在盘上的字节上**:旧的那段坏字节一个都没动 —— 没被一个空表盖掉。
  eq("★ 盘上的字节一个都没变(旧快照没被抹掉)", SettingRepo.get(KEY), bytesOnDisk);
  check(
    "★ 而且日志里说了话(用户唯一的线索)",
    logLines.slice(pinBefore).some((l) => l.includes("workflow.pinnedDefaults")),
    logLines.slice(pinBefore),
  );

  // **区分「真·空表」与「损坏表」**:合法 JSON 的 `{}` 不是损坏,照样能钉。
  SettingRepo.set(KEY, "{}");
  const emptyOk = obj(await callAsync(IPC.WORKFLOW_PIN_DEFAULT, { id: "wf_pinA" }));
  eq("★ 合法的空表能钉(空 ≠ 坏)", emptyOk.ok, true);

  // 修好表(把 A/B 放回去)之后:设默认成功,而且 A/B 一个不丢。
  SettingRepo.set(KEY, before);
  const ok2 = obj(await callAsync(IPC.WORKFLOW_PIN_DEFAULT, { id: "wf_pinC" }));
  eq("修好后 → 设默认成功", ok2.ok, true);
  const after = SettingRepo.get(KEY)!;
  check(
    "而且 A/B 两份旧快照都还在(只新增了 C,没有丢)",
    after.includes("wf_pinA") && after.includes("wf_pinB") && after.includes("wf_pinC"),
    after.slice(0, 120),
  );
}

/* ──────────────── 22. ★ MC-007:出厂预设可发现、可导入 ──────────────── */

console.log("\n出厂预设");

// 这一段钉的是台账那条「孤岛」:内容外置到 `resources/presets/workflows.json` 之后,
// **没有任何运行时代码读它**、也没有构建配置把它打进安装包、更没有界面入口。
//
// 判据立在**用户能看到的那个结果**上:列表里有那七份、导入之后库里真的多了一行、
// 坏文件/缺文件时说得清是哪种坏 —— 而不是"函数返回了一个对象"。
{
  const { presetRootCandidates, readPresetCatalog, readPresetWorkflow } = await import(
    "@main/orchestration/presetWorkflows.js"
  );

  // 0) 预置文件本身**真的在这个仓库里**(不然下面全部会退化成"absent 也对")。
  const real = readPresetCatalog(presetRootCandidates());
  eq("仓库里的出厂预设读得到(health:ok)", real.health, "ok");
  check("读到了至少一份预设", real.presets.length >= 7, { count: real.presets.length, path: real.path });
  check(
    "七份都在(检索/精读/写作/评审/代码 + 两条自动化)",
    ["search", "read", "write", "review", "code", "wf_auto_download", "wf_auto_convert"].every((id) =>
      real.presets.some((p) => p.id === id),
    ),
    real.presets.map((p) => p.id),
  );
  check("每一条都带着可显示的名字", real.presets.every((p) => p.name.trim().length > 0), real.presets);
  // 分栏依据必须一路带到渲染端:两条自动化得能被分进「自动化」那一栏。
  eq("两条自动化的 trigger 字段反推得出来", real.presets.filter((p) => p.trigger !== undefined).length, 2);
  eq(
    "五个对话模式不是自动化",
    real.presets.filter((p) => p.trigger === undefined).length,
    5,
  );
  check("提示词型与图型都能分得出来", real.presets.every((p) => p.kind === "graph" || p.kind === "prompt"));
  eq("没有逐条问题(这份仓库文件是干净的)", real.problems.length, 0);

  // 1) **真实那条 IPC**:列表带着库里的同名提示。
  const listed = obj(await callAsync(IPC.WORKFLOW_LIST_PRESETS));
  eq("listPresets → health:ok", listed.health, "ok");
  const presets = listed.presets as Array<{ id: string; name: string; sameNameExists: boolean }>;
  check("IPC 返回的条数与文件里一致", presets.length === real.presets.length, {
    ipc: presets.length,
    file: real.presets.length,
  });
  // 先存一份与某条预设同名的,再列一次 —— 那个提示必须出现。
  const target = real.presets.find((p) => p.id === "code")!;
  await callAsync(IPC.WORKFLOW_SAVE, {
    workflow: goodDoc({ id: "wf_same_name", name: target.name }),
  });
  const listed2 = obj(await callAsync(IPC.WORKFLOW_LIST_PRESETS));
  const sameEntry = (listed2.presets as Array<{ id: string; sameNameExists: boolean }>).find((p) => p.id === "code");
  eq("库里已有同名时那条预设标了出来", sameEntry?.sameNameExists, true);
  const otherEntry = (listed2.presets as Array<{ id: string; sameNameExists: boolean }>).find((p) => p.id === "read");
  eq("别的条目没被误标", otherEntry?.sameNameExists, false);

  // 2) **按预置导入**:真的往库里多出一行,而且走的是同一个落库闸门。
  resetSent();
  const before = (obj(await callAsync(IPC.WORKFLOW_LIST)).workflows as Array<{ id: string }>).length;
  const imported = obj(await callAsync(IPC.WORKFLOW_IMPORT_PRESET, { id: "read" }));
  eq("导入一条预置 → ok", imported.ok, true);
  check("给回了一个新 id(不是预设自己的 id)", String(imported.id).startsWith("wf_") && imported.id !== "read", imported.id);
  const after = (obj(await callAsync(IPC.WORKFLOW_LIST)).workflows as Array<{ id: string }>).length;
  eq("库里真的多了一行", after, before + 1);
  eq(
    "导入广播了一次(与两条文本导入同一个收尾)",
    sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length,
    1,
  );
  // 名字重了要加后缀(前面刚存过一份同名的) —— 与「从文件导入」同一条去重规则。
  check("与库里同名时名字被绕开了", imported.name !== target.name, {
    imported: imported.name,
    existing: target.name,
  });
  // 导进来的是一份**完整文档**:节点图也真的在。
  const fetched = obj(await callAsync(IPC.WORKFLOW_GET, { id: imported.id }));
  const doc = obj(fetched.workflow) as { nodes?: unknown[]; prompt?: string };
  check(
    "导进来的文档带着它原本的内容(图或流程文字至少一样)",
    (doc.nodes?.length ?? 0) > 0 || String(doc.prompt ?? "").length > 0,
    { nodes: doc.nodes?.length, promptLen: String(doc.prompt ?? "").length },
  );

  // 3) **预设不存在** → 说清是哪一条,而不是"导入了一份空白"。
  const ghost = obj(await callAsync(IPC.WORKFLOW_IMPORT_PRESET, { id: "preset_没这个" }));
  eq("不存在的预设 → ok:false", ghost.ok, false);
  check("报文里点得到那个 id", String((ghost.errors as string[])?.join(" ")).includes("preset_没这个"), ghost.errors);

  // 4) **缺文件 / 坏文件** 是两种不同的可观测状态(硬规矩 3:不静默当空列表)。
  const absentRoot = mkdtempSync(join(tmpdir(), "mcode-preset-absent-"));
  try {
    const absent = readPresetCatalog([absentRoot]);
    eq("没有预置文件 → health:absent", absent.health, "absent");
    check("absent 带着原因(试过哪些位置)", String(absent.reason ?? "").length > 0, absent.reason);
    eq("absent 时列表为空", absent.presets.length, 0);

    const corruptRoot = mkdtempSync(join(tmpdir(), "mcode-preset-corrupt-"));
    try {
      mkdirSync(join(corruptRoot, "resources", "presets"), { recursive: true });
      writeFileSync(join(corruptRoot, "resources", "presets", "workflows.json"), "{这不是 json", "utf8");
      const corrupt = readPresetCatalog([corruptRoot]);
      eq("坏 JSON → health:corrupt(不是 absent,也不是空列表)", corrupt.health, "corrupt");
      check("corrupt 带着解析器的原话", String(corrupt.reason ?? "").includes("JSON"), corrupt.reason);

      // 形状对但**没有一条**解析得出来 → 同样是 corrupt(而不是"这个版本没带内容")。
      writeFileSync(
        join(corruptRoot, "resources", "presets", "workflows.json"),
        JSON.stringify({ workflows: [{ not: "a doc" }, { also: "not" }] }),
        "utf8",
      );
      const allBad = readPresetCatalog([corruptRoot]);
      eq("一条都解析不出来 → health:corrupt", allBad.health, "corrupt");
      check("逐条问题被列出来了(不静默丢弃)", allBad.problems.length >= 2, allBad.problems);

      // 部分坏:好的照常可用,坏的进 problems —— 这才是"其余条目照常可用"。
      writeFileSync(
        join(corruptRoot, "resources", "presets", "workflows.json"),
        JSON.stringify({
          workflows: [
            goodDoc({ id: "preset_good", name: "好的一条" }),
            { not: "a doc" },
          ],
        }),
        "utf8",
      );
      const partial = readPresetCatalog([corruptRoot]);
      eq("部分坏 → health 仍是 ok", partial.health, "ok");
      eq("好的那条在", partial.presets.length, 1);
      eq("坏的那条进 problems", partial.problems.length, 1);
      // 坏条目**不能**被导入(按 id 取不到它)。
      const badFetch = readPresetWorkflow("preset_good", [corruptRoot]);
      check("按 id 取得到好的那条", !("error" in badFetch), badFetch);
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(absentRoot, { recursive: true, force: true });
  }
}

/* ──────────────── 23. ★ MC-006:学术脚本按需落盘,不再对每个用户播种 ──────────────── */

console.log("\n随预设携带的脚本");

{
  const { existsSync, readFileSync } = await import("node:fs");
  const { scriptsDir } = await import("@main/workflows/seed.js");
  const { materializePresetScriptsFor, PRESET_BUNDLED_SCRIPTS } = await import(
    "@main/workflows/presetScripts.js"
  );
  const scriptFile = PRESET_BUNDLED_SCRIPTS.find((s) => s.fileName === "check_citations.py")!;
  check("清单里记着 check_citations.py", scriptFile !== undefined);

  // 0) 启动 seed 已经**不再**写它(前面 §22 之前 registerWorkflowHandlers 已跑过 ensureWorkflows)。
  const shipped = join(scriptsDir(), scriptFile.fileName);
  eq("启动落盘之后 scripts/ 里没有 check_citations.py", existsSync(shipped), false);

  // 1) 引用它的工作流导入 → 现在才落盘,内容与随包文件逐字节一致。
  const sample = {
    ...goodDoc({ id: "wf_uses_check_citations", name: "引用核对用户" }),
    prompt: "",
    nodes: [
      { id: "main", type: "mcode.main", title: "入口", params: { instruction: "核对引用" }, position: { x: 0, y: 0 } },
    ],
    edges: [],
  };
  // 把脚本名写进图里(真实形态是 agent 节点的 instruction 提到它)。
  (sample.nodes[0] as { params: Record<string, unknown> }).params.instruction =
    "必要时运行 check_citations.py refs.bib";
  const res = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: JSON.stringify(sample) }));
  eq("导入一份引用 check_citations.py 的工作流 → ok", res.ok, true);
  check("现在 scripts/ 里有了它", existsSync(shipped), shipped);
  const repoPreset = join(process.cwd(), "resources", "presets", "scripts", "check_citations.py");
  eq(
    "落下来的那份与 resources/presets/scripts/ 逐字节一致",
    readFileSync(shipped, "utf8"),
    readFileSync(repoPreset, "utf8"),
  );

  // 2) **不引用**它的工作流导入 → 不落盘(已经是它存在了,先删掉再验)。
  rmSync(shipped, { force: true });
  const plain = obj(await callAsync(IPC.WORKFLOW_IMPORT, { text: JSON.stringify({ ...goodDoc({ id: "wf_no_script", name: "不用脚本" }) }) }));
  eq("导入一份不引用它的工作流 → ok", plain.ok, true);
  eq("★ 不引用就不落盘(学术脚本不再对每个用户出现)", existsSync(shipped), false);

  // 3) 用户改过的脚本不会被一次导入覆盖(与 seed 同一规则)。
  materializePresetScriptsFor("check_citations.py");
  writeFileSync(shipped, "# 我的版本\n", "utf8");
  materializePresetScriptsFor("check_citations.py");
  eq("用户改过的脚本不被覆盖", readFileSync(shipped, "utf8"), "# 我的版本\n");
  rmSync(shipped, { force: true });
}

/* ──────────────── 24. 【MC-030】节点类型目录**读不了** ≠ 资源不存在 ──────────────── */

console.log("\n节点类型目录读不了 ≠ 不存在");

/* §17b 只钉了代理档案那一处;`loadDir` 是同一条判据的第二个消费者(台账点名三处)。
 * 这里补上节点类型这一支:目录存在但 `readdir` 被拒(EACCES/EPERM)时,清单必须
 * **照常给出内置类型**,同时把"读不了目录"如实报进 `problems` —— 而不是把它折叠成
 * "用户没写过自定义节点"。健康路径(能读时 `problems` 为空、自定义节点在)先断,
 * 证明判据只对非 ENOENT 报,不是"一律报"或"一律不报"。 */
{
  const { execFileSync } = await import("node:child_process");
  writeManifest("smoke-mc030-good.json", JSON.stringify(manifestFixture({ id: "smoke.mc030" })));
  {
    const c = await catalog();
    check(
      "正控:能读时自定义节点照常出现",
      c.entries.some((e) => e.id === "smoke.mc030"),
      c.entries.map((e) => e.id),
    );
    same("正控:能读时 problems 是空的", c.problems, []);
  }

  const user = process.env.USERNAME ?? process.env.USER ?? "";
  const isWin = process.platform === "win32";
  let madeDeny = false;
  try {
    // 只拒"列目录"(RD) —— 模拟 ACL 那类故障;文件本身仍在,只是这一轮看不见。
    if (isWin) { execFileSync("icacls", [dir, "/deny", `${user}:(RD)`], { stdio: "ignore" }); madeDeny = true; }
    else { execFileSync("chmod", ["000", dir], { stdio: "ignore" }); madeDeny = true; }
  } catch { /* 造不出来就走跳过分支 */ }
  let reallyDenied = false;
  if (madeDeny) { try { readdirSync(dir); } catch { reallyDenied = true; } }
  if (reallyDenied) {
    const denied = await catalog();
    check(
      "★ MC-030:节点类型目录读不了 → 报进 problems(不是静默空)",
      JSON.stringify(denied.problems).includes(dir) || JSON.stringify(denied.problems).includes("读不了目录"),
      denied.problems,
    );
    check(
      "★ MC-030:读不了时内置类型照常在(坏一个目录不连坐)",
      denied.entries.filter((e) => e.id.startsWith("mcode.")).length >= 7,
      denied.entries.map((e) => e.id),
    );
  } else {
    console.log("  (跳过:本环境造不出 EACCES 夹具)");
  }
  // 尽力撤销,并**自证读回来**(撤销不可靠时如实说跳过,不把环境问题记成代码红)。
  try {
    if (isWin) execFileSync("icacls", [dir, "/remove:d", user], { stdio: "ignore" });
    else execFileSync("chmod", ["755", dir], { stdio: "ignore" });
  } catch { /* 尽力 */ }
  let restored = false;
  try { readdirSync(dir); restored = true; } catch { /* 没恢复 */ }
  if (restored) {
    const back = await catalog();
    check(
      "★ MC-030 正控:恢复可读后自定义节点回来",
      back.entries.some((e) => e.id === "smoke.mc030"),
      back.entries.map((e) => e.id),
    );
    same("★ MC-030 正控:恢复可读后 problems 清空", back.problems, []);
  } else {
    console.log("  (跳过恢复断言:本环境撤不掉目录拒绝)");
  }
  removeManifest("smoke-mc030-good.json");
}

/* ──────────────── 收尾 ──────────────── */

console.log(`\norchestration-ipc-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
