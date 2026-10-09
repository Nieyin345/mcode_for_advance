import { loadAutomationHistory } from "@renderer/lib/automationHistory.js";
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IpcMain } from "electron";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";

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
const { SessionRepo, SettingRepo, ProjectRepo, WorkflowRunRepo, CollectionRepo } = await import(
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

/* ──────────────── 1. 28 条 handler 一条不少、一条不多 ──────────────── */

console.log("\n注册面");

// 28 这个数字是**数出来的**(下面按名字逐条对),不是抄的。少一条 = 渲染端某个按钮
// 点了没反应;多一条 = 白名单那边没跟上(renderer 根本调不到,但说明有人改了这里
// 却没改契约那一份)。
const registered = [...handlers.keys()].sort();
check(
  `注册了 28 条 handler(实际 ${registered.length})`,
  registered.length === 28,
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
  ["代理档案列表", IPC.WORKFLOW_AGENT_PROFILES],
  ["存代理档案", IPC.WORKFLOW_SAVE_AGENT_PROFILE],
  ["删代理档案", IPC.WORKFLOW_REMOVE_AGENT_PROFILE],
  ["岔路口选路", IPC.WORKFLOW_CHOOSE],
  ["失败重试", IPC.WORKFLOW_RETRY],
  ["立刻跑一次", IPC.AUTOMATION_RUN],
  ["自动化运行历史", IPC.AUTOMATION_RUNS],
  ["自动化的后台会话", IPC.AUTOMATION_SESSIONS],
  ["全部触发器事实", IPC.AUTOMATION_STATUS_ALL],
  ["某个对话的图运行历史", IPC.RUNS_HISTORY],
  ["守望起跑", IPC.AUTOMATION_WATCH],
  ["守望活跃状态", IPC.AUTOMATION_WATCH_STATUS],
  ["命令模板(读)", IPC.AUTOMATION_WATCH_TEMPLATES],
  ["命令模板(存)", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE],
  ["钉住默认工作流", IPC.WORKFLOW_PIN_DEFAULT],
  ["恢复默认", IPC.WORKFLOW_RESTORE_DEFAULT],
  ["应用出厂版更新", IPC.WORKFLOW_APPLY_SHIPPED_UPDATE],
  ["忽略出厂版更新", IPC.WORKFLOW_DISMISS_SHIPPED_UPDATE],
  ["自定义 UI 运行自动化", IPC.CUSTOM_UI_RUN_AUTOMATION],
];
const missing = expectedChannels.filter(([, ch]) => !handlers.has(ch)).map(([name]) => name);
same("剩下那条名叫「命令模板(读)」在内的 28 条一条不缺", missing, []);

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
  same("内置节点类型精确包含模块能力、条件及原有类型", builtinIds, [
    "mcode.agent",
    "mcode.branch",
    "mcode.code",
    "mcode.command",
    "mcode.condition",
    "mcode.conversation",
    "mcode.main",
    "mcode.module-capability",
    "mcode.trigger",
  ]);
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

/* ──────────────── 8. 删 / 恢复默认 ──────────────── */

console.log("\n删一份工作流");

// ⚠️ 这里**不断言**"删不存在的会 ok:false" —— 今天它返回 `{ok:true, wasBuiltin:false}`
// (存储层 DELETE 一行不存在的不报错)。这条记录在报告里,没在这里编一个应当的行为。
{
  resetSent();
  const builtinBefore = obj(await callAsync(IPC.WORKFLOW_GET, { id: "search" }));
  check("内置那份编辑前就在", builtinBefore.workflow !== null);

  const res = obj(await callAsync(IPC.WORKFLOW_REMOVE, { id: "wf_smoke" }));
  eq("删自建的说的是「不是内置」", res.wasBuiltin, false);
  eq("删完广播一次", sent.filter((s) => s.channel === IPC.WORKFLOW_CHANGED).length, 1);
  eq("删完真的取不到了", obj(await callAsync(IPC.WORKFLOW_GET, { id: "wf_smoke" })).workflow, null);
}

/* ──────────────── 9. 守望模板:坏条目去哪了(已知问题,断言记录现状) ──────────────── */

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

  // **半截状态**:存一份坏的里面混着好的,读回来时好的那些不能被顺手丢了。
  // (`loadWatchTemplates` 逐条 safeParse,坏的丢掉 —— 这是刻意的,注释里写了理由。)

  // ✅ **丢掉的那几条要在日志里说话。** 判据立在**用户能看到的那行字**上:用户手改
  // setting 之后模板不见了,他唯一的线索就是日志。这条断言抓的是**桩打到 stderr 上的
  // 那几行**(见 `stubs/logger.ts` 的文件头:它故意不静默)。
  const before = logLines.length;
  SettingRepo.set("automation.watch.templates", JSON.stringify(mixed));
  obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  const newLines = logLines.slice(before);
  check(
    "★ 丢掉坏条目时日志里说了话(以前一个字都不报)",
    newLines.some((l) => l.includes("命令模板") && l.includes("跳过")),
    newLines,
  );
  check(
    "而且说出了丢了几条(用户能对上自己改过的那几条)",
    newLines.some((l) => /里有 2 条读不了/.test(l)),
    newLines,
  );

  // 整个 setting 是坏 JSON → 同样要说话(这一条以前就有,钉住别退化)。
  const before2 = logLines.length;
  SettingRepo.set("automation.watch.templates", "{坏 JSON");
  const empty = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same("整个 setting 是坏 JSON → 当没有模板,不抛", empty.templates, []);
  check(
    "而且是坏 JSON 时也要说话",
    logLines.slice(before2).some((l) => l.includes("命令模板")),
    logLines.slice(before2),
  );

  // 存的是合法 JSON 但**不是数组**(用户手改成一个对象)—— 这条以前是**静默返回 []**,
  // 现在也要说话。
  const before3 = logLines.length;
  SettingRepo.set("automation.watch.templates", JSON.stringify({ 不是: "数组" }));
  same(
    "存的是个对象不是数组 → 当没有模板",
    obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES)).templates,
    [],
  );
  check(
    "★ 而且这种形状也要说话(以前是静默返回 [])",
    logLines.slice(before3).some((l) => l.includes("命令模板")),
    logLines.slice(before3),
  );

  // 存回一份好的,确认这条链没被坏数据卡死(坏了的不该让_写_也坏掉)。
  const saveRes = obj(
    await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, {
      templates: [{ id: "a", name: "好的", command: "echo 1" }],
    }),
  );
  eq("存模板返回 ok", saveRes.ok, true);
  const back = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  same("存进去的读得回来", (back.templates as Array<{ id: string }>).map((t) => t.id), ["a"]);

  // ⚠️ **仍然没修的那半条(断言只记录现状)**:返回值里只有 `templates` 一个键,
  // 界面拿不到"有几条读不了"。`nodeTypes.ts` 那条路是带 `problems` 的;这里要带就得改
  // 契约 `automation.watchTemplates` 的返回类型(那个文件不在我分到的两个文件里)。
  // 所以今天**只有日志**,界面上一句都没有 —— 修法见报告。
  const silent = obj(await callAsync(IPC.AUTOMATION_WATCH_TEMPLATES));
  eq("⚠️ 返回值里仍然没有说明(只有 templates 一个键,界面看不到)", Object.keys(silent).length, 1);
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
}

/* ──────────────── 11. 某个对话的图运行历史 ──────────────── */

console.log("\n对话里那张「跑过什么」");

{
  const rows = (await callAsync(IPC.RUNS_HISTORY, { sessionId: "s_smoke_auto" })) as Array<{
    runId: string;
    nodeCount: number;
    status: string;
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
  const port = {
    sessions: ((input) => callAsync(IPC.AUTOMATION_SESSIONS, input)) as RpcMap["automation.sessions"],
    history: ((input) => callAsync(IPC.RUNS_HISTORY, input)) as RpcMap["runs.history"],
  };
  const detailed = await loadAutomationHistory("wf_hist", port);
  same("真实历史面板加载器保留全部项目且过滤其他工作流", detailed.map(r => r.runId).sort(), ["r_broken", "r_future", "r_ok", "r_project_B"]);
  eq("历史面板跨项目排序", detailed[0]?.runId, "r_project_B");
  eq("历史面板全局限制条数", (await loadAutomationHistory("wf_hist", port, 2)).length, 2);
  eq("旧版单会话响应仍可读取", (await loadAutomationHistory("wf_hist", { ...port, sessions: async () => ({ sessionId: "s_smoke_auto" }) })).length, 3);
  eq("尚无会话时历史面板为空", (await loadAutomationHistory("wf_hist", { ...port, sessions: async () => ({ sessionId: null }) })).length, 0);
  let reads = 0;
  await loadAutomationHistory("wf_hist", { ...port, sessions: async () => ({ sessionId: "s_hist_B", sessionIds: ["s_hist_B", "s_hist_B"] }), history: async (input) => { reads++; return port.history(input); } });
  eq("重复会话 id 只查询一次", reads, 1);

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
  ["存模板:templates 不是数组", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, { templates: "不是数组" }],
  ["存模板:模板里缺 command", IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, { templates: [{ id: "a", name: "甲" }] }],
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
  // 用内置那份(`search`)—— 取消只可能发生在**找得到工作流之后**,给个不存在的 id
  // 走的是上面那条"找不到"的路,根本到不了文件框。
  resetDialog();
  const cancelled = obj(await callAsync(IPC.WORKFLOW_EXPORT, { id: "search" }));
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

/* ──────────────── 18. 同一个 "建节点" 的动作:界面与 AI 是不是同一条路 ──────────────── */

console.log("\n新建节点:两条路会不会分家");

// 任务是这么问的:「界面上点『新建』建节点」和「AI / 自动化建节点」是不是同一个函数。
// 答案在这个文件里不好直接断 —— 那条路在渲染端的 `settings/workflows/` 里。这里能断的是
// **主进程这一侧唯一的入口**:节点类型清单只有一份,两条路都得问它要。
{
  const catalog = obj(await callAsync(IPC.WORKFLOW_NODE_TYPES));
  const entries = catalog.entries as Array<{ id: string; manifest: { runner: { kind: string } } }>;
  check("IPC 清单带着含条件和模块能力的 9 种内置类型",
    entries.filter((e) => e.id.startsWith("mcode.")).length === 9 &&
      entries.some((e) => e.id === "mcode.condition" && e.manifest.runner.kind === "condition") &&
      entries.some((e) => e.id === "mcode.module-capability" && e.manifest.runner.kind === "module-capability"), {
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
  const promptOne = BUILTIN_WORKFLOWS.find((d) => d.nodes.length === 0 && alive.has(d.id) && (d.prompt ?? "").length > 0);
  const withTrigger = BUILTIN_WORKFLOWS.find((d) => alive.has(d.id) && d.nodes.some((n) => n.type === "mcode.trigger"));
  check("找得到一份提示词型、一份带触发器的自带工作流", promptOne !== undefined && withTrigger !== undefined, [...alive]);

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
}

/* ──────────────── 收尾 ──────────────── */

console.log(`\norchestration-ipc-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
