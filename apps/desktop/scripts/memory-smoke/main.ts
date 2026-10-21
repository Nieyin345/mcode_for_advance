import { MEMORY_WORKFLOWS } from "@main/orchestration/memoryWorkflows.js";
import { MEMORY_LAYER_INSTRUCTIONS } from "@main/memory/policy.js";
import { validateWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { scopedMemorySnapshot } from "@main/memory/retrieval.js";
import { memoryHistory, readHistory, restoreMemory, readMemoryFileWithRaw } from "@main/memory/store.js";
import { manageMemory } from "@main/memory/manage.js";
import { projectInstructions } from "@main/memory/instructions.js";
import { invokeMemoryTool, memoryToolDescriptors } from "@main/memory/engineTools.js";
import { invokeAppTool } from "@main/appControl/tools.js";
import { recordRpcHandler, clearRpcHandlers } from "@main/appControl/registry.js";
import type { ProviderContext } from "@contracts/provider";
import { homedir } from "node:os";
import { memoryMcpTools } from "@main/mcp/memoryServer.js";
import { z } from "zod";
/**
 * Headless smoke for 记忆系统三件套(MEM-01 存储 / MEM-02 检索注入 / MEM-03 维护),
 * 以及 `buildNodeInput` 的两个新能力:触发器变量(`{{trigger.*}}`)与记忆注入。
 *
 * 真的写文件、真的读文件 —— 但脚下那个数据根换成临时目录(见 `run-store-smoke/stubs/
 * dataRoot.ts` 那句"没设就抛")。**人工可直接编辑是硬要求**,所以场景 3 用 node:fs
 * 手写带 frontmatter 的 markdown(不走 saveMemoryFile),验证的就是"手写的文件读得回来"。
 *
 * 覆盖六块:
 *   1. CRUD + frontmatter(title 沿用 / 覆盖、updatedAt 盖章、删后读抛)。
 *   2. 路径逃逸拒绝(四道闸,含反斜杠写法、绝对路径、子目录、点开头)。
 *   3. 快照聚合(类目分组次序、类目内新的在前、categories 过滤、limit、
 *      单条截断、整段截断提示、空库空串)。
 *   4. 触发器变量(展开 / 数组连接 / 未知 key 与无载荷的两种抛 / 非字符串参数不动 /
 *      候选名单 / data.trigger 进出)。
 *   5. 记忆注入开/关两态("on" / "true" / true 开;"off" / 不传 / 空库不开)。
 *   6. 维护纯函数(findStale 过期线、suggestDedup 标题相等与近似正文)。
 *   7. 按相关度检索(MEM-04)—— 相关的**旧**条目要压过不相关的**新**条目。
 *
 * Run: scripts/memory-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MEMORY_CATEGORIES, MEMORY_PARAM_KEY } from "@contracts/memory";
import type { NodeTypeManifest } from "@contracts/nodeType";
import {
  buildNodeInput,
  expandTriggerVars,
  type ModelInputScope,
  type RunnableNodeInput,
} from "@main/orchestration/nodeInputBuilders.js";
import {
  deleteMemoryFile,
  listMemoryFiles,
  memoryCategories,
  memoryRoot,
  readMemoryFile,
  saveMemoryFile,
} from "@main/memory/store.js";
import {
  BODY_CAP,
  DEFAULT_LIMIT,
  SNAPSHOT_CAP,
  memorySnapshotFor,
  queryTerms,
  searchMemory,
} from "@main/memory/retrieval.js";
// 5b 段要断言的是**真货**的参数表(内置清单那六种),手抄一份测的是抄本。
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import { findStale, suggestDedup, type DedupCandidate } from "@main/memory/maintenance.js";

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

function deep(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, a === b ? undefined : { actual, expected });
}

/** 调 `fn` 必须抛;给了 `needle` 的话,错误消息里还得有它。 */
function throws(name: string, fn: () => unknown, needle?: string): void {
  total++;
  try {
    fn();
    failures++;
    console.log(`  FAIL ${name} — 没抛`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (needle !== undefined && !message.includes(needle)) {
      failures++;
      console.log(`  FAIL ${name} — 抛了,但消息里没有「${needle}」:${message}`);
    } else {
      console.log(`  ok   ${name}`);
    }
  }
}

/** 取 `app_api_call` 返回里的结构化 OperationResult(与 app-control-smoke 同源)。 */
function opResultOf(r: { structuredContent?: Record<string, unknown> }): Record<string, unknown> | undefined {
  return r.structuredContent?.operation_result as Record<string, unknown> | undefined;
}

/** `app_api_call` 返回正文拼成一段文本(断言密钥/标记是否出现在**返回给模型的文本**里)。 */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
}

/** 手写一个"人工直接编辑"形态的记忆文件:markdown + 两行 frontmatter。 */
function handWrite(root: string, relPath: string, title: string, updatedAt: number, body: string): void {
  const abs = join(root, "memory", ...relPath.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, [`---`, `title: "${title}"`, `updatedAt: ${updatedAt}`, `---`, ``, body, ``].join("\n"), "utf8");
}

/* ────────────────────────── fixtures ────────────────────────── */

const AGENT: NodeTypeManifest = {
  id: "mcode.agent",
  manifestVersion: 1,
  name: "子 agent",
  runner: { kind: "prompt" },
  capability: "read",
  params: [{ key: "instruction", kind: "longtext", label: "指令", required: true }],
};


function scopeOf(extra: Partial<ModelInputScope> = {}): ModelInputScope {
  return {
    memorySnapshot: () => memorySnapshotFor(), // Explicit test port; production binds session scope.
    userPrompt: "用户的话",
    upstream: "",
    upstreamArtifacts: [],
    upstreamOutputs: {},
    nodeId: "a",
    plan: [[{ id: "a", title: "第一步", isLast: true }]],
    // 这一条 fixture 是**一步图**,所以它这一格就是根(计划第 0 层)。根节点在提示词
    // 里带「用户的请求」,回主对话时也就不回声那条指令 —— 两个事实同源,见 `isRootOf`。
    root: true,
    terminal: true,
    contextLines: () => [],
    ...extra,
  };
}

function build(params: Record<string, unknown>, extra: Partial<ModelInputScope> = {}): RunnableNodeInput {
  const ctrl = new AbortController();
  return buildNodeInput(params, AGENT, scopeOf(extra), ctrl.signal);
}

/* run.sh 导出的第一个数据根:场景 1/2/5(注入开态)用它 */
const DATA1 = process.env.MCODE_SMOKE_DATA_ROOT;
if (!DATA1) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 必须经 run.sh 跑");
const DATA2 = mkdtempSync(join(tmpdir(), "mcode-memory-snap-"));
const DATA3 = mkdtempSync(join(tmpdir(), "mcode-memory-empty-"));
const DATA4 = mkdtempSync(join(tmpdir(), "mcode-memory-inject-"));
// 【MC-092/093 真实入口】两块各自一份**干净**数据根:A/B 两条项目记忆只在 DATA5 里;历史的
// 敏感旧文件只在 DATA6 里 —— 不与前面场景的残留互相干扰。
const DATA5 = mkdtempSync(join(tmpdir(), "mcode-memory-real-"));
const DATA6 = mkdtempSync(join(tmpdir(), "mcode-memory-real-inject-"));

/* ────────────────────────── 1. CRUD + frontmatter ────────────────────────── */

console.log("场景 1:CRUD + frontmatter");

const t1 = saveMemoryFile({ path: "rules/引用规范.md", content: "引用一律用 APA。", title: "引用规范" }).updatedAt;
eq("save 返回时间戳", typeof t1, "number");

const listed = listMemoryFiles();
const meta = listed.find((m) => m.path === "rules/引用规范.md");
check("list 找得到刚存的那条", meta !== undefined, listed.map((m) => m.path));
eq("类目对", meta?.category, "rules");
eq("title 用传入的", meta?.title, "引用规范");
eq("updatedAt 是 save 盖的章", meta?.updatedAt, t1);
eq("读回正文", readMemoryFile("rules/引用规范.md").content.trim(), "引用一律用 APA。");

const t2 = saveMemoryFile({ path: "rules/引用规范.md", expectedRevision: readMemoryFile("rules/引用规范.md").revision, content: "更新后的正文。" }).updatedAt;
check("二次 save 的时间不减", t2 >= t1, { t1, t2 });
eq("二次 save 沿用旧标题", listMemoryFiles().find((m) => m.path === "rules/引用规范.md")?.title, "引用规范");
eq("正文已更新", readMemoryFile("rules/引用规范.md").content.trim(), "更新后的正文。");

saveMemoryFile({ path: "rules/引用规范.md", expectedRevision: readMemoryFile("rules/引用规范.md").revision, content: "再改。", title: "引用的新规范" });
eq("显式 title 覆盖旧标题", listMemoryFiles().find((m) => m.path === "rules/引用规范.md")?.title, "引用的新规范");

deep("categories 固定六类", memoryCategories(), [...MEMORY_CATEGORIES]);

deleteMemoryFile("rules/引用规范.md", readMemoryFile("rules/引用规范.md").revision);
throws("删后读要抛", () => readMemoryFile("rules/引用规范.md"), "读不到");
// ★ 读失败给用户/模型的是一句**中文**,不是 `ENOENT: no such file or directory, open
//   'C:\Users\…\memory\rules\引用规范.md'` —— 那句里还带着用户机器的绝对路径。面板
//   (`memory:read` → 「读不出来:{error}」)与 MCP 工具(`memory_read` 的 fail)两条都原样
//   透出 message,所以判据立在 message 本身上:是中文、且没有 OS 原文的形状。
{
  let msg = "";
  try { readMemoryFile("rules/引用规范.md"); } catch (err) { msg = (err as Error).message; }
  check("★ 读不到记忆时是中文人话,不是原始 ENOENT/绝对路径", msg.includes("读不到") && msg.includes("不存在") && !/ENOENT|no such file|[A-Za-z]:\\/.test(msg), msg);
}
// ★ 同一条判据的写侧:记忆位置存在但读不出来(EISDIR —— 一个目录被命名成 `x.md` 那种
//   半同步形态;EACCES —— 没权限)时,`currentRaw` 从前把 OS 原文原样 rethrow,经
//   `saveMemoryFile`/`deleteMemoryFile` 摆进面板的 `{ ok:false, error }` 与 MCP 的 `fail`。
{
  mkdirSync(join(memoryRoot(), "rules", "trap.md"), { recursive: true });
  let saveMsg = "", delMsg = "";
  try { saveMemoryFile({ path: "rules/trap.md", content: "hi", expectedRevision: null }); } catch (err) { saveMsg = (err as Error).message; }
  try { deleteMemoryFile("rules/trap.md", "0".repeat(64)); } catch (err) { delMsg = (err as Error).message; }
  check("★ 记忆位置读不出来时写/删报的是中文人话,不是原始 EISDIR 英文",
    /读不出来|不是一个文件/.test(saveMsg) && !/EISDIR|illegal operation/.test(saveMsg) &&
    /读不出来|不是一个文件/.test(delMsg) && !/EISDIR|illegal operation/.test(delMsg), { saveMsg, delMsg });
  rmSync(join(memoryRoot(), "rules", "trap.md"), { recursive: true, force: true });
}
// ★ 建目录/写文件阶段失败(`mkdirSync` 撞到同名**文件** → `EEXIST: …, mkdir 'C:\…'`)
//   同样从前把 OS 原文漏给用户 —— 判据:中文、且没有 OS 原文的形状。
{
  // `rules/` 此刻已被上面清空(引用规范.md 删了、trap.md 删了),腾出那个目录名,
  // 用一个**同名文件**顶替它 —— 这样 `mkdirSync('…/rules')` 才会以 OSError 失败。
  rmSync(join(memoryRoot(), "rules"), { recursive: true, force: true });
  writeFileSync(join(memoryRoot(), "rules"), "not a dir", "utf8");
  let saveMsg = "";
  try { saveMemoryFile({ path: "rules/blocked.md", content: "hi", expectedRevision: null }); } catch (err) { saveMsg = (err as Error).message; }
  check("★ 建目录失败(同名文件挡路)时是中文人话,不是原始 EEXIST/绝对路径",
    /已存在|失败/.test(saveMsg) && !/EEXIST|mkdir|[A-Za-z]:\\/.test(saveMsg), saveMsg);
  rmSync(join(memoryRoot(), "rules"), { force: true });
}
check("删后列表里没有", listMemoryFiles().every((m) => m.path !== "rules/引用规范.md"));

/* ────────────────────────── 2. 路径逃逸拒绝 ────────────────────────── */

console.log("场景 2:路径逃逸拒绝");

const EVIL = [
  "../evil.md", // 类目位置是 ..
  "rules/../../evil.md", // 三段 + 穿越
  "nope/x.md", // 类目不在白名单
  "/abs/evil.md", // 绝对路径
  "rules\\..\\evil.md", // 反斜杠(Windows 分隔符写法)
  "rules/.hidden.md", // 点开头
  "rules/sub/x.md", // 子目录(布局只允许一层)
] as const;
for (const p of EVIL) {
  throws(`save 拒绝「${p}」`, () => saveMemoryFile({ path: p, content: "x" }));
}
throws("read 也拒绝穿越", () => readMemoryFile("../evil.md"), "不是合法的记忆路径");
throws("delete 也拒绝穿越", () => deleteMemoryFile("../evil.md"), "不是合法的记忆路径");
check("构造的路径一个都没落盘", listMemoryFiles().length === 0, listMemoryFiles());

/* ────────────────────────── 3. 快照聚合 ────────────────────────── */

console.log("场景 3:快照聚合");

process.env.MCODE_SMOKE_DATA_ROOT = DATA2;
const T0 = 1_700_000_000_000;
// 手写,不走 saveMemoryFile —— 验"人直接编辑的文件读得回来",顺便把 updatedAt 钉死。
handWrite(DATA2, "rules/旧规则.md", "旧规则", T0, "最老的一条。");
handWrite(DATA2, "project/项目现状.md", "项目现状", T0 + 2_000, "项目正文。");
handWrite(DATA2, "experiences/最新经验.md", "最新经验", T0 + 3_000, "新的经验。");
handWrite(DATA2, "experiences/更早经验.md", "更早经验", T0 + 1_000, "旧的经验。");

const snap = memorySnapshotFor();
const at = (needle: string) => snap.indexOf(needle);
check("三个有内容的类目都在", ["## 记忆 · 规则", "## 记忆 · 项目", "## 记忆 · 经验"].every((h) => at(h) >= 0), snap);
check(
  "分组按固定类目次序(规则→项目→经验)",
  at("## 记忆 · 规则") < at("## 记忆 · 项目") && at("## 记忆 · 项目") < at("## 记忆 · 经验"),
);
check("类目内新的在前", at("【最新经验】") < at("【更早经验】"));
check("没用到的类目不出现", !snap.includes("偏好") && !snap.includes("教训") && !snap.includes("决定"));

const onlyProject = memorySnapshotFor(["project"]);
check("categories 过滤:有 project", onlyProject.includes("【项目现状】"));
check("categories 过滤:没有别的类目", !onlyProject.includes("【最新经验】") && !onlyProject.includes("## 记忆 · 规则"));
eq("全不合法的类目名 → 空串", memorySnapshotFor(["nope"]), "");

const limit2 = memorySnapshotFor(undefined, 2);
eq("limit=2 只两条", (limit2.match(/【/g) ?? []).length, 2);
check("limit 取的是最新的两条", limit2.includes("【最新经验】") && limit2.includes("【项目现状】") && !limit2.includes("【旧规则】"));

handWrite(DATA2, "decisions/长文.md", "长文", T0 + 4_000, "很长。".repeat(BODY_CAP)); // BODY_CAP*3 字
check("超长单条正文被截断并说出口", memorySnapshotFor().includes("…(已截断)"));

for (let i = 1; i <= 12; i += 1) {
  handWrite(DATA2, `failures/积条目${String(i).padStart(2, "0")}.md`, `积条目${i}`, T0 + 10_000 + i, "条目正文一二三四五六七。".repeat(120));
}
const cappedSnapshot = memorySnapshotFor(undefined, DEFAULT_LIMIT + 6);
check(
  `整段超过 SNAPSHOT_CAP(${SNAPSHOT_CAP})后收手并注明`,
  cappedSnapshot.includes("(记忆快照过长"),
);
check("整段输出严格不超过 SNAPSHOT_CAP", cappedSnapshot.length <= SNAPSHOT_CAP, cappedSnapshot.length);
const beforeCapNotice = cappedSnapshot.split("\n\n(记忆快照过长")[0] ?? "";
check(
  "整段截断只发生在完整记忆条目之间(不把正文从中间劈开)",
  beforeCapNotice.trimEnd().endsWith("…(已截断)"),
  beforeCapNotice.slice(-100),
);

process.env.MCODE_SMOKE_DATA_ROOT = DATA3;
eq("空库 → 空串", memorySnapshotFor(), "");

/* ────────────────────────── 4. 触发器变量 ────────────────────────── */

console.log("场景 4:触发器变量");

deep("展开字符串值", expandTriggerVars({ instruction: "查 {{trigger.kind}} 的 {{trigger.event}}" }, { kind: "文献", event: "新增" }), {
  instruction: "查 文献 的 新增",
});
deep("字符串数组用「、」连", expandTriggerVars({ instruction: "文件:{{trigger.files}}" }, { files: ["a.md", "b.md"] }), {
  instruction: "文件:a.md、b.md",
});
throws("未知 key 列出可用的", () => expandTriggerVars({ instruction: "{{trigger.nope}}" }, { kind: "x" }), "可用的有:{{trigger.kind}}");
throws("无载荷明确失败", () => expandTriggerVars({ instruction: "{{trigger.kind}}" }, undefined), "不是触发器起的");
const untouched = expandTriggerVars({ count: 3, list: ["{{trigger.kind}}"], flag: true }, { kind: "x" });
eq("非字符串参数原样(数字)", untouched.count, 3);
eq("非字符串参数原样(数组)", (untouched.list as string[])[0], "{{trigger.kind}}");

const withTrigger = build(
  { instruction: "处理 {{trigger.toolName}}" },
  { trigger: { toolName: "mcp_a", kind: "manual" } },
);
// **`expandTriggerVars` 是纯函数,单独试过了(上面那几条);这里不试它。**
//
// `buildNodeInput` 从前会自己再跑一遍它兜底,所以拿"`{{trigger.*}}` 进了提示词没有"
// 当 `buildNodeInput` 的断言是成立的。2026-09-20 那遍兜底删了 —— 参数**到这儿时已经
// 解完了**(调度器的 `expandParams` 是唯一解参数的地方,`{{trigger.*}}` 只是 `{{...}}`
// 的一种,见 `@contracts/nodeTemplate` 的 `resolveOne`)。所以这一条不再是它该管的事,
// 留着就是一条**测着别人职责的**断言 —— 哪天有人把兜底加回来,它会绿着通过而问题还在。
// 解算那一段的断言在 `scheduler-smoke`(解算器)与那边调度器一级的用例里。
//
// 这一格现在只剩一件事要管:**载荷原样进 `data`**(节点自己读 `data.trigger`),就是下面那条。
deep("载荷进 data.trigger", (withTrigger.data as unknown as Record<string, unknown>).trigger, { toolName: "mcp_a", kind: "manual" });
const noTrigger = build({ instruction: "做点事" });
check("手动跑 data 里没有 trigger 键", !("trigger" in noTrigger.data));
// 候选名单(`triggerVarCandidates`)那两条断言搬走了(2026-09-19):那个导出**从来没人
// 真的用过** —— 它注释里写"渲染端的「插入变量」用它拼触发器那一组",而渲染端够不到
// `@main`。真正拼那一组的是渲染端自己抄的六个字段,判据只有"挂着触发器吗",于是定时
// 触发器里也摆着「涉及哪些对象」,点一下插进指令、下次到点必炸。现在候选按**触发方式**
// 算,判据在 `@contracts/nodeType` 的 `triggerFactKeysOf`,断言在 `automation-smoke`
// 与 `workflow-view-smoke`(那两处能同时看到契约与菜单)。

/* ────────────────────────── 5. 记忆注入开/关 ────────────────────────── */

console.log("场景 5:记忆注入开/关");

process.env.MCODE_SMOKE_DATA_ROOT = DATA4;
saveMemoryFile({ path: "rules/规则一.md", content: "引用一律用 APA,期刊名用全称。", title: "规则一" });
saveMemoryFile({ path: "preferences/输出偏好.md", content: "输出尽量简短。", title: "输出偏好" });

const on = build({ instruction: "做点事", memory: "on" });
check("on → 注入记忆节", on.prompt.includes("## 长期记忆"), on.prompt);
check("记忆正文在场", on.prompt.includes("引用一律用 APA") && on.prompt.includes("## 记忆 · 规则"));
check("记忆节在提示词末尾", on.prompt.lastIndexOf("## 长期记忆") > on.prompt.indexOf("做点事"));
check("true 字符串也开", build({ instruction: "做点事", memory: "true" }).prompt.includes("## 长期记忆"));
check("布尔 true 也开", build({ instruction: "做点事", memory: true }).prompt.includes("## 长期记忆"));
check("off 不注入", !build({ instruction: "做点事", memory: "off" }).prompt.includes("## 长期记忆"));
check("不传不注入", !build({ instruction: "做点事" }).prompt.includes("## 长期记忆"));

process.env.MCODE_SMOKE_DATA_ROOT = DATA3;
check("空库 + on → 整节不出现", !build({ instruction: "做点事", memory: "on" }).prompt.includes("## 长期记忆"));

/* ────────────────────────── 5b. 「注入记忆」摆没摆到参数表上 ────────────────────────── */

/**
 * ## 为什么这一段非有不可
 *
 * 读取那一端(`memoryEnabled` / `memorySectionOf`)2026-09 就写好了,上面那段也在
 * 验它 —— **但那时参数表里根本没有这一格**。界面上没有控件 → `params` 里永远没有
 * `memory` 这个键 → `memoryEnabled` 恒为 false。一整条功能**等于不存在**,而且不报错。
 *
 * ⚠️ 所以上面那一整段断言**证明不了任何事**:它是拿手写的 `{ memory: "on" }` 喂进去
 * 的,而那个键**用户永远填不出来**。这里的判据必须立在不同的一层上 —— **用户看得见
 * 的那个控件在不在**。这正是 `smokes-for` 那个"套件跑绿但根本没覆盖到"的老形状。
 */
console.log("场景 5b:参数表里有没有「注入记忆」这一格");

const KEY = MEMORY_PARAM_KEY;
/** 某一格在不在那张表里(按 key)。 */
const hasKey = (id: string): boolean => {
  const m = builtinManifestById(id);
  if (!m) return false;
  return m.params.some((p) => p.key === KEY);
};
/** 那一格的形状 —— 摆错种类的话(比如摆成了文本框)用户填不出 `"on"`。 */
const specOf = (id: string) => builtinManifestById(id)?.params.find((p) => p.key === KEY);

for (const id of ["mcode.agent", "mcode.main", "mcode.conversation"]) {
  check(`★ ${id} 的参数表里有「${KEY}」这一格(界面才有那个开关)`, hasKey(id), builtinManifestById(id)?.params.map((p) => p.key));
  eq(`${id} 那一格是开关(布尔)`, specOf(id)?.kind, "boolean");
}
check("★ 而且它有中文标签(用户看到的那行字)", (specOf("mcode.agent")?.label ?? "").length > 0, specOf("mcode.agent"));

/**
 * **`code` / `command` 不给这一格** —— 它们不走模型,整段 `prompt` 拼好了也没人读。
 * 摆上去就是一个填了不生效的控件,那正是这一格当初被漏掉时犯的同一个错,方向反过来。
 * `branch` 的模型那一轮只做一件事(照判据从几条出路里挑一条),把整本记忆塞进一个
 * 选路问题里既没用又白花一份上下文。
 */
for (const id of ["mcode.code", "mcode.command", "mcode.branch"]) {
  check(`★ ${id} 不给这一格(它那一段没有模型在读)`, !hasKey(id), builtinManifestById(id)?.params.map((p) => p.key));
}

/* ────────────────────────── 6. 维护纯函数 ────────────────────────── */

console.log("场景 6:维护纯函数");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const staleItems = [
  { path: "project/老.md", category: "project", title: "老", updatedAt: NOW - 100 * DAY },
  { path: "project/新.md", category: "project", title: "新", updatedAt: NOW - 10 * DAY },
  { path: "rules/无时间.md", category: "rules", title: "无时间", updatedAt: 0 },
];
deep(
  "findStale:100 天前的与没时间的过期,10 天前的不算",
  findStale(staleItems, NOW, 90).map((m) => m.path),
  ["project/老.md", "rules/无时间.md"],
);

const dupItems: DedupCandidate[] = [
  { path: "rules/a.md", title: "引用规范!", content: "完全不同的一句话甲。" },
  { path: "rules/b.md", title: "引用规范", content: "另一句毫不相干的话乙。" },
  { path: "rules/c.md", title: "别的标题", content: "引用一律用 APA 格式,期刊名要写全称,作者在前年份在后。" },
  { path: "rules/d.md", title: "又一个标题", content: "引用一律用 APA 格式,期刊名要写全称,作者在前年份在后吧。" },
  { path: "rules/e.md", title: "孤立的一条", content: "风马牛不相及的一段文字。" },
];
const pairs = suggestDedup(dupItems);
const titlePair = pairs.find((p) => (p.a === "rules/a.md" && p.b === "rules/b.md") || (p.a === "rules/b.md" && p.b === "rules/a.md"));
eq("同标题判重 score=1", titlePair?.score, 1);
eq("a 在传入序列前", titlePair !== undefined && titlePair.a === "rules/a.md", true);
const contentPair = pairs.find((p) => p.a === "rules/c.md" && p.b === "rules/d.md");
check("近似正文过 0.85 线", contentPair !== undefined && contentPair.score >= 0.85, pairs);
check("无关的两条不判重", !pairs.some((p) => p.a === "rules/e.md" || p.b === "rules/e.md"));

/* ────────────────────────── 7. 按相关度检索(MEM-04) ────────────────────────── */

// 这一段测的是**模型那一侧**要用的检索:从前唯一的取法是 `updatedAt` 倒序,
// 记忆库一大,「用户三年前说过引用用 APA」那条永远不会出现在前 12 条里 ——
// 而它恰恰是最该看的那条(记忆的价值就在"不用重复说第二遍")。
//
// ⚠️ 时间戳要**拉开**:这一段的判据是"相关的旧条目要压过不相关的新条目",
// 两条挨着的话按时间排也能过,那条断言就是空的(变异验证会抓不到)。

console.log("场景 7:按相关度检索");

// 先把前面场景留下的文件清干净,免得被干扰
process.env.MCODE_SMOKE_DATA_ROOT = DATA4;
for (const m of listMemoryFiles()) deleteMemoryFile(m.path, readMemoryFile(m.path).revision);

const OLD = 1_500_000_000_000; // 很旧
const NEW = 1_700_000_000_000; // 很新
saveMemoryFile({
  path: "rules/引用规范.md",
  title: "引用规范",
  content: "引用一律用 APA 格式,期刊名写全称。",
});
// 这条**更新**,但内容和"引用"毫无关系 —— 用来证明排序不是按时间
saveMemoryFile({
  path: "project/某项目.md",
  title: "某项目",
  content: "这个仓库用 pnpm 管依赖,测试跑 run-all-smokes.sh。",
});
// 把时间戳压出差距(store 每次写都会盖 now,所以手改 frontmatter 的 updatedAt)
const ruleFile = join(memoryRoot(), "rules", "引用规范.md");
writeFileSync(ruleFile, readFileSync(ruleFile, "utf8").replace(/updatedAt: \d+/, `updatedAt: ${OLD}`));
const projFile = join(memoryRoot(), "project", "某项目.md");
writeFileSync(projFile, readFileSync(projFile, "utf8").replace(/updatedAt: \d+/, `updatedAt: ${NEW}`));

// 查询为空 → 退回按时间(这是"列一下记忆"那条合理请求,不是 bug)。
// ⚠️ 这条要**紧跟在钉过时间戳之后**:`saveMemoryFile` 每次都盖 `now`,下面再写几条
// 新的,「最新的」就换人了 —— 第一版把它放在最后,拿到的是刚写的 乙.md。
eq("空查询退回按时间:最新的在前", searchMemory("")[0]?.meta.path, "project/某项目.md");

const hits = searchMemory("引用格式");
eq("命中条数 = 1", hits.length, 1);
eq("命中的是那条规则(不是更新的项目条)", hits[0]?.meta.path, "rules/引用规范.md");
check(
  "★ 相关的**旧**条目压过不相关的**新**条目(判据立在时间戳真的拉开了上)",
  hits[0]?.meta.updatedAt === OLD,
  { hitAt: hits[0]?.meta.updatedAt, OLD, NEW },
);

/**
 * ⚠️ **上面那三条是空的,如果只有一条命中。**
 *
 * 变异验证抓到了这一点:把排序改成纯按时间,这三条**照样绿** —— 因为候选只有一个,
 * 怎么排都是它。「相关度排序」这件事只有当**两条都命中、而相关度与新旧相反**时才被
 * 真的测到。所以下面补一组。
 *
 * ⚠️ **`rules/引用规范.md` 也会命中** —— 它的正文里就有「引用」和「格式」两个字
 * (`引用一律用 APA 格式`)。所以不是"两条",是三条;判据只能立在**谁排第一**上,
 * 不能立在总数上。
 */
saveMemoryFile({
  path: "rules/引用与格式.md",
  title: "引用与格式",
  content: "引用格式这件事说三遍:引用格式要统一,引用格式别两套。",
});
saveMemoryFile({
  path: "project/顺带提到.md",
  title: "顺带提到",
  content: "正文里顺带提了一次引用格式,就一次。",
});
const twoHits = searchMemory("引用格式");
check("三条都命中(否则下面的排序断言是空的)", twoHits.length === 3, twoHits.map((h) => h.meta.path));
eq("★ 同样命中时,更相关的那条排第一(不是更新的那条)", twoHits[0]?.meta.path, "rules/引用与格式.md");
check(
  "★ 而且它确实是靠打分赢的:分数严格高于第二名",
  (twoHits[0]?.score ?? 0) > (twoHits[1]?.score ?? 0),
  twoHits.map((h) => [h.meta.path, h.score]),
);

// 标题命中要比正文命中的值钱 —— 标题是这条记忆的自我描述
saveMemoryFile({ path: "rules/甲.md", title: "无关标题", content: "正文里提到 变量 一次。" });
saveMemoryFile({ path: "rules/乙.md", title: "变量 命名", content: "和那个词没有别的关系。" });
const byTitle = searchMemory("变量");
eq("标题命中排在正文命中前面", byTitle[0]?.meta.path, "rules/乙.md");

// 打分看完整正文，但返回结果仍受 BODY_CAP 保护；命中在深处时预览要移到命中附近。
saveMemoryFile({
  path: "experiences/long-tail.md",
  title: "unrelated long body",
  content: "x".repeat(BODY_CAP + 80) + " deep_tail_keyword",
});
const tailHits = searchMemory("deep_tail_keyword");
eq("长正文 BODY_CAP 之后的关键词仍能搜到", tailHits[0]?.meta.path, "experiences/long-tail.md");
check(
  "深处命中时返回预览包含关键词,而不是只给无关开头",
  (tailHits[0]?.body ?? "").includes("deep_tail_keyword") && (tailHits[0]?.body ?? "").startsWith("…(前文已截断)"),
  tailHits[0]?.body,
);
check("搜索正文预览严格不超过 BODY_CAP", (tailHits[0]?.body.length ?? Infinity) <= BODY_CAP, tailHits[0]?.body.length);

// 正文词频只计前 5 次：既防重复词霸榜，也验证优化后的 indexOf 计数没有改语义。
saveMemoryFile({
  path: "experiences/repeat-cap.md",
  title: "unrelated repetition",
  content: "repeat_cap_token ".repeat(20),
});
const repeated = searchMemory("repeat_cap_token");
eq("正文同一词重复很多次时分数封顶为 5", repeated[0]?.score, 5);

// 空查询按时间列最近记忆时，空正文不能先占掉 limit 再被过滤。
handWrite(DATA4, "failures/empty-newest.md", "空但最新", 9_000_000_000_000, "");
const recentOne = searchMemory("", { limit: 1 });
eq("空查询 limit=1 仍能返回一条有效记忆", recentOne.length, 1);
check("空正文不会吃掉空查询的 limit 名额", recentOne[0]?.meta.path !== "failures/empty-newest.md", recentOne[0]?.meta.path);

// 有查询但一条都不命中 → **空数组**(不许拿无关的凑数)
eq("不命中就返回空", searchMemory("量子纠缠拓扑绝缘体").length, 0);
// 类目过滤
eq("限定类目时只搜那一类", searchMemory("变量", { category: "project" }).length, 0);
// 查词切分:中文按双字切,所以「引用格式」这种短语能命中「引用一律用 APA 格式」;
// 整句当一个词的话第一条早就命不中了。
check("中文双字切词:「引用格式」切出「引用」", queryTerms("引用格式").includes("引用"));
check("西文按非字母数字切", queryTerms("APA cite").includes("apa"));
// ★ 「单字查询才退回单字」—— 整条查询就一个字时才把那个字当词;多字查询里的孤立单字
//   (「写 引用规范」的「写」)不该进来当命中词(否则给所有含「写」字的记忆加噪声分,
//   把不相关记忆顶进结果)。从前判的是"任何长度为 1 的汉字段",与文档相反。
check("整条查询就一个字 → 那个字是命中词", queryTerms("写").includes("写"));
check("★ 多字查询里的孤立单字不当命中词", !queryTerms("写 引用规范").includes("写"), queryTerms("写 引用规范"));
check("…而它里面的双字词照常切出", queryTerms("写 引用规范").includes("引用"));

// ★ 项目 id 的形状判据**只有一份**(契约 `MEMORY_PROJECT_ID_RE`)。主进程 `memory/paths.ts`
//   与 `MemoryManageSchema.projectId` 从前各写一份字面量,改一处漏一处会让"导入成功但
//   AI 永远搜不到"。这条钉住两处用的是同一个对象。
{
  const { MEMORY_PROJECT_ID_RE } = await import("@contracts/memory.js");
  const { MEMORY_PROJECT_ID } = await import("@main/memory/paths.js");
  check("★ 记忆项目 id 正则两处同一份(paths 直接用契约那个)", MEMORY_PROJECT_ID === MEMORY_PROJECT_ID_RE, {
    paths: String(MEMORY_PROJECT_ID),
    contracts: String(MEMORY_PROJECT_ID_RE),
  });
}

/* ────────────────────────── 入口节点:那一段不进聊天框 ────────────────────────── */

// 主代理(`mcode.main`)跑在主对话里,拿到的那段 `prompt` 是**代码拼的脚手架**
// (流程位置 + 用户的请求 + 产出要求)。它回主对话时**不回声** —— 用户打的那句原话
// 由 `startWorkflowRun` 回声,两边都发就是聊天里两条一样的提问。
//
// 两个断言是一件事的两面:**同一份 scope,根与非根给出的答案相反**。只钉一边的话,
// 把这一行写成常量 `false` 也能过,而那会让下游的对话节点不说话。
console.log("\n入口节点 · 回声开关");
{
  const rootInput = build({ instruction: "拆活" });
  eq("根节点不回这条指令", rootInput.echoUserMessage, false);
  // 那一句话得真的在:不是把它从提示词里删掉,而是只不发回声。
  check("但提示词里照样带着用户的请求", rootInput.prompt.includes("用户的话"), rootInput.prompt);

  const midInput = build({ instruction: "按刚才聊定的改" }, {
    nodeId: "b",
    plan: [
      [{ id: "a", title: "第一步", isLast: false }],
      [{ id: "b", title: "第二步", isLast: true }],
    ],
    root: false,
  });
  eq("(对照)中段的节点照常回声", midInput.echoUserMessage, undefined);
}

/* ────────────── 流程记录:这一层的职责边界 ──────────────
 *
 * 「谁该读整条流程的记录」**不在这里判** —— 那个默认值由调度器按图的结构算
 * (`scheduler.ts` 的 `readsRecord`:`flowRecordOf(params) ?? onLoop.has(id)`),渲染也在
 * 那边(`flowRecordSection`)。这一层只做一件事:**给了就原样放进去,没给就不给**。
 *
 * 钉这三条是因为它挡着一个很容易做反的改法:这一层够不着「其它步骤的产出」——
 * `ModelInputScope` 里只有**直接上游**那一段(`upstream`),没有整条流程的日志。想在这
 * 一层"顺手让线性图的节点也读记录",能造出来的只有**把上游那一段套个 `## 流程记录`
 * 的标题** —— 那不是记录(没有「本流程」、没有用户最初的要求、没有更早的步骤),是一份
 * 长得像记录的假东西。下面第 ① 条就是这个改法的钉子。
 */
console.log("\n流程记录:这一层只负责照搬,不自己判谁该读");
{
  // 一条线性链:上游(第一步)已经跑完。`upstream` 是**直接上游**那一段,记录没给 ——
  // 线性图的默认就是这样(它不在环上)。
  const MID = {
    nodeId: "b",
    plan: [
      [{ id: "a", title: "第一步", isLast: false }],
      [{ id: "b", title: "第二步", isLast: true }],
    ],
    root: false,
    upstream: "### 第一步\n第一步的结果",
  };

  // ① 调度器没给记录 → 给的是**直接上游**那一段,而且**不能**凭空冒出一个记录节。
  const noRecord = build({ instruction: "做点事" }, MID);
  check("线性下游拿到的是「上游步骤的产出」", noRecord.prompt.includes("## 上游步骤的产出"), noRecord.prompt);
  check("★ 而且没有「流程记录」那一段(它不在环上,默认不该读)", !noRecord.prompt.includes("## 流程记录"), noRecord.prompt);
  check("直接上游的正文在里面", noRecord.prompt.includes("第一步的结果"), noRecord.prompt);

  // ② 调度器给了记录 → 它**替代**上游那一段(见 `composeNodePrompt`:两段都给就是同一
  //    份内容出现两遍)。「替代」是**全程 vs 直接上游**这两条互斥取法的另一半,所以
  //    这里也要钉住 —— 只钉"给了就出现"的话,把两段都塞进去的改法会绿着通过。
  const RECORD = "## 流程记录\n**本流程**:测试流程\n\n### 第一步\n第一步的结果";
  const withRecord = build({ instruction: "做点事" }, { ...MID, record: RECORD });
  check("给了记录就一定进提示词", withRecord.prompt.includes("## 流程记录"), withRecord.prompt);
  check("★ 记录替代了「上游步骤的产出」", !withRecord.prompt.includes("## 上游步骤的产出"), withRecord.prompt);
  check("记录原文照给(不重排、不截断)", withRecord.prompt.includes(RECORD), withRecord.prompt);
  // 这一层**不认识「本流程」是谁** —— 那两行是调度器渲染记录时写进去的(它才拿得到
  // 图与文档名)。没给记录时,这一层不该凭空造出一行「**本流程**:…」来。
  // (注意别拿"本流程"三个字当判据:流程位置那一节开头就是「本流程共 N 步」。)
  const blank2 = build({ instruction: "做点事" }, MID);
  check("没给记录时不凭空写「本流程」那一行", !blank2.prompt.includes("**本流程**"), blank2.prompt);

  // ③ 空白记录等于没给。记录只有两行表头时摆出来是纯噪音(同 `readsRecord` 里那条
  //    "记录还是空的时候一律不给"),所以判据是**trim 过之后有没有东西**。
  const blank = build({ instruction: "做点事" }, { ...MID, record: "   " });
  check("空白记录等于没给", !blank.prompt.includes("## 流程记录"), blank.prompt);
  check("那时上游产出照给", blank.prompt.includes("## 上游步骤的产出"), blank.prompt);
}

/* Concurrent dialogs must not silently replace a newer memory. */
{
  const path = "rules/concurrent-dialogs.md";
  type VersionedInput = Parameters<typeof saveMemoryFile>[0] & { expectedRevision?: string | null };
  const readVersion = (): string => {
    try { return (readMemoryFile(path) as { revision?: string }).revision ?? "0".repeat(64); }
    catch { return "0".repeat(64); } // A broken stale delete must fail assertions, not abort the suite.
  };
  saveMemoryFile({ path, content: "base", expectedRevision: null } as VersionedInput);
  const revision = readVersion();
  check("读取返回完整原文的SHA256版本", revision !== "0".repeat(64) && /^[a-f0-9]{64}$/.test(revision));
  // Four callers all read the same old version before any of them writes.
  let successes = 0, conflicts = 0;
  for (const text of ["A", "B", "C", "D"]) {
    try { saveMemoryFile({ path, content: text, expectedRevision: revision } as VersionedInput); successes++; }
    catch { conflicts++; }
  }
  eq("四个旧版本写者只有一个成功", successes, 1);
  eq("另外三个写者明确得到冲突", conflicts, 3);
  eq("第一个写者内容不被后续静默覆盖", readMemoryFile(path).content.trim(), "A");
  throws("旧客户端不带版本也不得覆盖已有记忆", () => saveMemoryFile({ path, content: "blind" }));
  throws("新建同名记忆不得覆盖旧内容", () => saveMemoryFile({ path, content: "duplicate", expectedRevision: null } as VersionedInput));
  const current = readVersion();
  // Same updatedAt/mtime cannot hide a manual body/frontmatter edit.
  const file = join(memoryRoot(), path);
  writeFileSync(file, readFileSync(file, "utf8") + "manual edit\n", "utf8");
  throws("人工改文件后旧版本保存必须拒绝", () => saveMemoryFile({ path, content: "stale", expectedRevision: current } as VersionedInput));
  const remove = deleteMemoryFile as (path: string, expectedRevision?: string) => { ok: true };
  throws("旧版本删除不得删掉人工更新", () => remove(path, current));
  throws("无版本删除不得删掉现有文件", () => remove(path));
  const latest = readVersion();
  remove(path, latest);
  throws("删后旧编辑器不得复活文件", () => saveMemoryFile({ path, content: "resurrect", expectedRevision: latest } as VersionedInput));
  saveMemoryFile({ path, content: "recreated", expectedRevision: null } as VersionedInput);
  throws("旧删除确认不得删掉同名新文件", () => remove(path, latest));
  remove(path, readVersion());
}

/* Failed atomic replacement leaves the old file intact and no temporary tail. */
{
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const path = "rules/atomic-failure.md";
  saveMemoryFile({ path, content: "must survive" });
  const original = readFileSync(join(memoryRoot(), path), "utf8");
  const revision = readMemoryFile(path).revision;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected rename failure"); };
  syncBuiltinESMExports();
  try { throws("替换失败明确报错而非回退截断原文件", () => saveMemoryFile({ path, content: "lost", expectedRevision: revision }), "injected rename failure"); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  eq("替换失败后完整原文不变", readFileSync(join(memoryRoot(), path), "utf8"), original);
  eq("失败后清理自己的临时文件", fs.readdirSync(join(memoryRoot(), "rules")).filter(n => n.endsWith(".mcode-tmp")).length, 0);
  deleteMemoryFile(path, revision);
}

/* Exercise the actual shared MCP specs/handlers, with no SDK or real model. */
{
  const specs = memoryMcpTools();
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const spec = specs.find(s => s.name === name)!;
    return spec.handler(z.object(spec.inputSchema).parse(input), { sessionId: "isolated-memory-test" });
  };
  const path = "projects/p_memory/rules/tool-cas.md";
  const base = { category: "rules", path, title: "Tool CAS", content: "v1" };
  const w1 = await invoke("memory_write", base);
  eq("真实工具可新建记忆", w1.isError, undefined);
  // ★ 回报里的日期必须是**本地日期**,不是 UTC。写这句的人从一开始就懂这个坑
  //   (文件头为它单开了 `localDate`,理由写在 `mcp/memoryServer.ts:42`),可 write 的
  //   回报偏偏用了 `new Date(updatedAt).toISOString()` —— 东八区凌晨 0–8 点会显示成
  //   "昨天"。判据:回报文本里那个 `YYYY-MM-DD` 必须等于本地日期。
  {
    const txt = w1.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const shown = /(\d{4}-\d{2}-\d{2})/.exec(txt)?.[1];
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    eq("★ 写入回报的日期是本地日期(不是 UTC)", shown, local);
  }
  const firstRead = await invoke("memory_read", { path });
  const text = firstRead.content.map(c => c.type === "text" ? c.text : "").join("\n");
  const revision = /revision: ([a-f0-9]{64})/.exec(text)?.[1];
  check("真实读取工具提供版本", !!revision);
  eq("真实工具带读版本可更新", (await invoke("memory_write", { ...base, content: "v2", expectedRevision: revision })).isError, undefined);
  eq("真实工具旧版本写入如实返回错误", (await invoke("memory_write", { ...base, content: "stale", expectedRevision: revision })).isError, true);
  eq("真实工具省略版本不能覆盖", (await invoke("memory_write", { ...base, content: "blind" })).isError, true);
  eq("真实工具过期删除确认不能误删", (await invoke("memory_forget", { path, expectedRevision: revision })).isError, true);
  eq("被拒绝的操作不改变最新正文", readMemoryFile(path).content.trim(), "v2");
  const latest = readMemoryFile(path).revision;
  eq("真实工具最新版本删除成功", (await invoke("memory_forget", { path, expectedRevision: latest })).isError, undefined);

  // T62: 从模型的 MCP 入口写入，经面板所用的真实 IPC 列表可见，再由新一轮
  // snapshot/关键词检索取回；删除后新一轮 snapshot 不再含有这条用户长期偏好。
  {
    const title = "引用格式偏好";
    const memoPath = "projects/p_memory/preferences/引用格式偏好.md";
    const content = "用户要求以后引用都用 APA 格式。";
    const saved = await invoke("memory_write", { category: "preferences", title, content });
    eq("T62 AI 写入 APA 偏好成功", saved.isError, undefined);
    const { registerMemoryHandlers } = await import("@main/ipc/memory.js");
    const handlers = new Map<string, (evt: unknown, raw: unknown) => unknown>();
    registerMemoryHandlers({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never);
    const panelList = handlers.get("memory:list")!(null, {}) as { files: Array<{ path: string; title: string }> };
    check("T62 面板通过真实 IPC 列表看到模型写入的条目", panelList.files.some(f => f.path === memoPath && f.title === title));
    check("T62 新对话快照包含 APA 长期偏好", memorySnapshotFor(["preferences"]).includes(content));
    const found = await invoke("memory_search", { query: "APA 引用格式", limit: 12 });
    check("T62 关键词可搜到刚写的 APA 条目", textOf(found).includes(memoPath));
    eq("T62 删除成功", (await invoke("memory_forget", { path: memoPath, expectedRevision: readMemoryFile(memoPath).revision })).isError, undefined);
    check("T62 删除后新快照不再出现 APA 偏好", !memorySnapshotFor(["preferences"]).includes(content));
    check("T62 删除后面板 IPC 列表也无此条", !(handlers.get("memory:list")!(null, {}) as { files: Array<{ path: string }> }).files.some(f => f.path === memoPath));
  }

  // 源码合同：无头验证不需要真实模型，但硬要求「与面板共用 saveMemoryFile」
  // 和写入纪律必须位于真系统提示词里，不能只写在工具描述上。
  {
    const server = readFileSync("src/main/mcp/memoryServer.ts", "utf8");
    const policy = readFileSync("src/main/memory/policy.ts", "utf8");
    const ui = readFileSync("src/renderer/components/chat/MessageBlocks.tsx", "utf8");
    check("T62 memory_write 必须显式调用共享 saveMemoryFile", /saveMemoryFile\(\{\s*path,\s*content:\s*args\.content/.test(server));
    check("T62 系统提示词确实包含角色/项目背景/不可从代码读出三类长期记忆", MEMORY_LAYER_INSTRUCTIONS.includes("角色、专长与偏好") && MEMORY_LAYER_INSTRUCTIONS.includes("项目长期背景") && MEMORY_LAYER_INSTRUCTIONS.includes("无法从代码和项目文件重新读出来") && policy.includes("MEMORY_LAYER_INSTRUCTIONS"));
    check("T62 系统提示词明确排除代码模式、git 历史与临时状态", MEMORY_LAYER_INSTRUCTIONS.includes("不记代码模式") && MEMORY_LAYER_INSTRUCTIONS.includes("不记 git 历史") && MEMORY_LAYER_INSTRUCTIONS.includes("不记本次任务的临时状态"));
    check("T62 对话工具卡存在成功后可跳往记忆面板的轻量入口", ui.includes('block.toolName.endsWith("__memory_write")') && ui.includes('setSettingsOpen(true, "memory")') && ui.includes('block.status === "done"'));
  }

  // ★ **读出来的正文必须能原样存回去(「读→存」不动点)。** 存盘时正文前面带着
  //   frontmatter 分隔行留下的换行,而 `saveMemoryFile` 只收尾、不收首 —— 若 `memory_read`
  //   把那个前导换行一起交给模型,模型照工具说明里写死的「先读 → 改 → 同一个 path 覆盖」
  //   走一遍就会被写回,每读存一轮文件多一个空行。面板那条读通路(`main/ipc/memory.ts`)
  //   早就按同一条判据收口,这里从前漏了 —— 同一个不动点在 MCP 这条路上不成立。判据钉行为:
  //   工具读出的正文再存回去,**正文一个字符都不变**(时间戳每次盖章,比正文不比 raw)。
  {
    const rtPath = "projects/p_memory/rules/tool-roundtrip.md";
    await invoke("memory_write", { category: "rules", path: rtPath, title: "RT", content: "round-trip body" });
    // 比**正文**,不比整份 raw —— 存储层每次写都把 `updatedAt` 盖成现在,那份时间戳本来就会变。
    const bodyBefore = readMemoryFile(rtPath).content;
    const read = await invoke("memory_read", { path: rtPath });
    const readText = read.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const shown = readText.slice(readText.indexOf("\n\n") + 2);
    eq("★ memory_read 读出的正文不含 frontmatter 分隔行留下的前导换行", shown, "round-trip body");
    await invoke("memory_write", { category: "rules", path: rtPath, title: "RT", content: shown, expectedRevision: readMemoryFile(rtPath).revision });
    eq("★ 读出的正文原样存回,正文不再长胖(`读→存` 不动点)", readMemoryFile(rtPath).content, bodyBefore);
    await invoke("memory_forget", { path: rtPath, expectedRevision: readMemoryFile(rtPath).revision });
  }

  // ★ **`memory_forget` 的幂等不能只停在说明里。** 工具说明写着"不存在的路径也算成功",
  //   存储层对不存在的路径也直接回 `{ ok: true }`,面板那条删除同样幂等 —— 从前这里却拿
  //   **会抛的** `readMemoryFile` 当前置,删一条本来就不在的路径反成 `fail`,且回的是一句
  //   英文 `ENOENT: no such file...`(与本仓"给模型的话说中文"的约定也对不上)。
  {
    const gone = await invoke("memory_forget", { path: "projects/p_memory/rules/never-existed.md", expectedRevision: "0".repeat(64) });
    eq("★ 删一条本来就不存在的记忆也算成功(与说明/面板一致的幂等)", gone.isError, undefined);
    const goneText = gone.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    check("★ 幂等删除报的是中文成功句,不是原始 ENOENT 英文", goneText.includes("已删掉") && !/ENOENT/.test(goneText), goneText);
  }

  /* ── 【MC-031 同族】MCP 读口(`memory_list` / `memory_search`)的漏读诊断 ──
   *
   * 从前两个读口不传 `onUnreadable`:`listMemoryFiles` 把读不出来的条目静静丢掉,工具却
   * 照常回「这一类还是空的」/「没有一条对得上」—— 模型无法区分**真的没有**与**有但读不出来**。
   * 现在:结构化字段 `unreadable {directories, files, paths}` + 正文一句 ⚠️;零命中时
   * 两种事实同时说清。夹具用**真 junction**(`symlinkSync` + `lstat` 自证)造目录级漏读,
   * 并**前置断言**:同一个数据根里放一条**可读**记忆 —— 否则"零命中"可能只是因为库是空的,
   * 断言会空过。 */
  {
    const { symlinkSync, unlinkSync, lstatSync, existsSync, renameSync } = await import("node:fs");
    const outside = join(dirname(memoryRoot()), "mc031-mcp-outside");
    mkdirSync(outside, { recursive: true });
    /** 把真实存在的目录**改名让位**,再用 junction 顶上 —— Windows 的 junction 不允许
     *  链接路径已存在。返回还原函数:拆 junction、把原目录改回来(一条都不丢,后续块不受污染)。 */
    const replaceDirWithJunction = (at: string): (() => void) | null => {
      const aside = `${at}.mc031-aside`;
      let hadReal = false;
      try {
        if (existsSync(at)) { renameSync(at, aside); hadReal = true; }
        mkdirSync(dirname(at), { recursive: true });
        symlinkSync(outside, at, process.platform === "win32" ? "junction" : "dir");
        if (!lstatSync(at).isSymbolicLink()) throw new Error("不是链接");
      } catch {
        try { if (lstatSync(at).isSymbolicLink()) unlinkSync(at); } catch { /* 尽力 */ }
        if (hadReal) { try { renameSync(aside, at); } catch { /* 尽力 */ } }
        return null;
      }
      return () => {
        try { unlinkSync(at); } catch { /* 尽力 */ }
        if (hadReal) { try { renameSync(aside, at); } catch { /* 尽力 */ } }
      };
    };
    const structuredOf = (r: { structuredContent?: Record<string, unknown> }): Record<string, unknown> | undefined =>
      r.structuredContent;

    // 健康基线(防空过正控):库里有可读记录时两个读口**都不**出现 unreadable 字段。
    saveMemoryFile({ path: "projects/p_memory/rules/mcp-healthy.md", content: "HEALTHY_MCP_BODY 可读记录。" });
    const healthyList = await invoke("memory_list", {});
    const healthySearch = await invoke("memory_search", { query: "HEALTHY_MCP_BODY" });
    check("★ MC-031 MCP:健康库 memory_list 不带 unreadable 诊断(不误报)", structuredOf(healthyList) === undefined, structuredOf(healthyList));
    check("★ MC-031 MCP:健康库 memory_search 不带 unreadable 诊断(不误报)", structuredOf(healthySearch) === undefined, structuredOf(healthySearch));
    check("★ MC-031 MCP:健康库检索真的命中(证明上面两条不是因为空库)", textOf(healthySearch).includes("HEALTHY_MCP_BODY"));

    // ① 本项目 rules 目录整体读不出来:零命中检索、列表两个读口都要说清「漏了」。
    const restoreSelf = replaceDirWithJunction(join(memoryRoot(), "projects", "p_memory", "rules"));
    if (!restoreSelf) {
      console.log("  (跳过:本环境造不出目录链接夹具)");
    } else {
      try {
        // ① 零命中 + 本项目目录读不出来 → 两种事实同时说清,不再只回「没有一条对得上」。
        const missSearch = await invoke("memory_search", { query: "绝对不存在的关键词_qzx" });
        const missText = missSearch.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        check("★ MC-031 MCP:零命中时正文**同时**说「未命中」与「读不出来」",
          missText.includes("没有一条记忆") && missText.includes("读不出来"), missText.slice(0, 300));
        const missDiag = (missSearch.structuredContent as { unreadable?: { directories?: number; files?: number; paths?: string[] } } | undefined)?.unreadable;
        check("★ MC-031 MCP:零命中时结构化字段带 unreadable(目录计数)", (missDiag?.directories ?? 0) >= 1, missDiag);
        check("★ MC-031 MCP:诊断点名的目录就是本项目读不出来的那个",
          (missDiag?.paths ?? []).includes("projects/p_memory/rules"), missDiag);

        // ② memory_list 同理:整类目录读不出来时也带结构化诊断 + 正文 ⚠️。
        const missList = await invoke("memory_list", {});
        const missListDiag = (missList.structuredContent as { unreadable?: { directories?: number } } | undefined)?.unreadable;
        check("★ MC-031 MCP:memory_list 在整类目录读不出来时带结构化 unreadable", (missListDiag?.directories ?? 0) >= 1, missListDiag);
        const missListText = missList.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        check("★ MC-031 MCP:memory_list 的正文里有 ⚠️ 披露(模型看得见)", missListText.includes("⚠️") && missListText.includes("读不出来"), missListText.slice(0, 300));
      } finally { restoreSelf(); }

      // ③ 作用域:别的项目整个目录读不出来时,本项目读口的诊断**不泄露**它的名字。
      const restoreOther = replaceDirWithJunction(join(memoryRoot(), "projects", "p_other"));
      if (!restoreOther) {
        console.log("  (跳过:本环境造不出项目级目录链接夹具)");
      } else {
        try {
          const scoped = await invoke("memory_search", { query: "HEALTHY_MCP_BODY" });
          const scopedDiag = (scoped.structuredContent as { unreadable?: { paths?: string[] } } | undefined)?.unreadable;
          check("★ MC-031 MCP:别项目目录漏读不出现在本项目诊断里", !(scopedDiag?.paths ?? []).some((p) => p.includes("p_other")), scopedDiag);
          const scopedText = scoped.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          check("★ MC-031 MCP:别项目的存在与名字也不借正文泄露", !scopedText.includes("p_other"), scopedText.slice(0, 300));
        } finally { restoreOther(); }
      }
    }
    rmSync(join(memoryRoot(), "projects", "p_memory", "rules", "mcp-healthy.md"), { force: true });
  }
}

/* Scope, recovery, preview-confirm import and the real neutral engine dispatcher. */
{
  const own = "projects/p_memory/rules/own.md", other = "projects/p_other/rules/other.md";
  const global = "global/rules/shared.md", legacy = "rules/unclassified.md";
  for (const [path, content] of [[own, "own-needle"], [other, "other-private-needle"], [global, "shared-needle"], [legacy, "legacy-private-needle"]]) {
    saveMemoryFile({ path: path!, content: content!, pinned: path === own });
  }
  const snapshot = scopedMemorySnapshot("p_memory", "needle");
  check("项目快照包含本项目", snapshot.includes("own-needle"));
  check("项目快照包含显式全局", snapshot.includes("shared-needle"));
  check("项目快照绝不包含别项目", !snapshot.includes("other-private-needle"));
  check("项目快照绝不包含未归属旧记录", !snapshot.includes("legacy-private-needle"));
  check("快照有来源和版本", snapshot.includes(own) && snapshot.includes("revision="));
  check("快照遵守总体预算", snapshot.length <= SNAPSHOT_CAP);
  check("置顶元信息可回读", listMemoryFiles().find(m => m.path === own)?.pinned === true);
  check("检索作用域不泄漏", searchMemory("other-private-needle", { projectId: "p_memory" }).every(hit => hit.meta.path !== other && hit.meta.path !== legacy));
  const ctx: ProviderContext = { emit() {}, log: { info() {}, warn() {}, error() {} } };
  const invoke = (name: string, args: unknown, context = ctx, session = "isolated-memory-test") => invokeMemoryTool(name, args, session, context);
  eq("未知会话失败关闭", (await invoke("memory_list", {}, ctx, "unknown")).isError, true);
  eq("伪造 projectId 不能越权读", (await invoke("memory_read", { path: other, projectId: "p_other" })).isError, true);
  eq("旧记录不能被模型直接读取", (await invoke("memory_read", { path: legacy })).isError, true);
  eq("本项目只读不需要审批桥", (await invoke("memory_read", { path: own })).isError, undefined);
  const args = { category: "rules", title: "Approved only", content: "approved-memory" };
  eq("无审批桥禁止写入", (await invoke("memory_write", args)).isError, true);
  const deny = { ...ctx, requestApproval: async () => ({ allow: false }) } as ProviderContext;
  eq("拒绝审批不写入", (await invoke("memory_write", args, deny)).isError, true);
  let approvals = 0;
  const allow = { ...ctx, requestApproval: async () => { approvals++; return { allow: true }; } } as ProviderContext;
  eq("审批后可写入", (await invoke("memory_write", args, allow)).isError, undefined);
  eq("写入只审批一次", approvals, 1);
  check("默认新记录落本项目", listMemoryFiles().some(m => m.title === args.title && m.projectId === "p_memory"));
  eq("共享描述表与真实处理器同名", memoryToolDescriptors().map(t => t.name).join(), memoryMcpTools().map(t => t.name).join());
  eq("非法参数由共享 zod 拒绝", (await invoke("memory_write", { ...args, category: "invalid" }, allow)).isError, true);
  eq("非法参数不请求审批", approvals, 1);
  const listed = await invoke("memory_list", {});
  check("模型列表不泄漏别项目路径", !JSON.stringify(listed).includes(other));
  eq("显式别项目写入在审批后仍拒绝", (await invoke("memory_write", { ...args, path: other }, allow)).isError, true);
  eq("别项目删除即使版本正确也拒绝", (await invoke("memory_forget", { path: other, expectedRevision: readMemoryFile(other).revision }, allow)).isError, true);
  eq("跨项目操作不改变记录", readMemoryFile(other).content.trim(), "other-private-needle");

  eq("全局需显式scope", (await invoke("memory_write", { ...args, title: "Shared approved", scope: "global" }, allow)).isError, undefined);
  check("显式共享路径", listMemoryFiles().some(m => m.title === "Shared approved" && m.scope === "global"));
  // The approval must describe the same canonical scope used by the writer.
  for (const [title, extra] of [
    ["Whitespace global path", { path: " global/rules/whitespace-scope.md " }],
    ["Blank global path", { path: "   ", scope: "global" }],
  ] as const) {
    const requests: Array<{ input: unknown; description?: string }> = [];
    const capture: ProviderContext = { ...ctx, requestApproval: async (request) => {
      requests.push(request); return { allow: true };
    } };
    const result = await invoke("memory_write", { ...args, title, ...extra }, capture);
    eq(`${title}: write succeeds after approval`, result.isError, undefined);
    check(`${title}: approval describes global scope`, requests[0]?.description?.includes("全局（所有项目共享）") === true);
    const presented = requests[0]?.input as { path?: string } | undefined;
    check(`${title}: approval receives the normalized path`, !presented?.path || presented.path === presented.path.trim());
    check(`${title}: actual record has that global scope`, listMemoryFiles().some(m => m.title === title && m.scope === "global"));
  }
  const before = readMemoryFileWithRaw(own);
  saveMemoryFile({ path: own, content: "updated", expectedRevision: before.revision });
  const history = memoryHistory().entries.find(h => h.path === own && h.reason === "before-update")!;
  eq("更新前归档保留原始字节", readHistory(history.id).raw, before.raw);
  let blocked = false; try { restoreMemory(history.id); } catch { blocked = true; }
  check("恢复不能覆盖现有记录", blocked);
  deleteMemoryFile(own, readMemoryFile(own).revision);
  restoreMemory(history.id);
  eq("恢复原字节与版本", readMemoryFileWithRaw(own).raw, before.raw);
  check("删除前有恢复点", memoryHistory().entries.some(h => h.path === own && h.reason === "before-delete"));
  // ★ 恢复点列表截断要**报出来**。归档目录只增不减(不自动清理),而"恢复记忆"的下拉框只吃
  //   这里的返回 —— 静默 `.slice(0,200)` 会让用户以为更早的恢复点不存在。与 `truncatedSources`
  //   同一口径。这里直接断言返回值带 `truncated` 字段(0 也带),界面据此决定显不显示那句话。
  {
    const h = memoryHistory();
    check("memoryHistory 报出被 200 上限挡掉的条数(即使为 0 也带这个字段)", typeof h.truncated === "number" && h.truncated >= 0, h.truncated);
    const listed = manageMemory({ action: "list" });
    check("list 动作把 historyTruncated 一起返回", listed.ok && typeof listed.historyTruncated === "number", listed);
    check("…且和 memoryHistory 的口径一致", listed.historyTruncated === h.truncated, { list: listed.historyTruncated, direct: h.truncated });
  }
  blocked = false; try { readHistory("../escape"); } catch { blocked = true; }
  check("归档编号不能穿越路径", blocked);
  // ★ 恢复点读失败(不存在 / 内容坏掉)经 `manage.ts` 的 history/restore 原样摆进设置
  //   面板的「读不出来:{error}」—— 从前这里把 `lstatSync`/`JSON.parse` 的**原始英文**
  //   (`ENOENT: no such file…lstat 'C:\…'` / `Expected property name…`)漏给用户看。
  {
    const missing = manageMemory({ action: "history", id: "1700000000000-cafebabe" });
    check("★ 恢复点不存在时是中文人话,不是原始 ENOENT/绝对路径",
      missing.ok === false && /不存在|已损坏/.test(missing.error ?? "") && !/ENOENT|no such file|[A-Za-z]:\\/.test(missing.error ?? ""), missing);
    const archiveDir = join(memoryRoot(), ".history");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "1700000000000-deadbeef.json"), "{ not json", "utf8");
    const corrupt = manageMemory({ action: "history", id: "1700000000000-deadbeef" });
    check("★ 恢复点内容坏掉时是中文人话,不是原始 JSON.parse 英文",
      corrupt.ok === false && /损坏/.test(corrupt.error ?? "") && !/Expected property|position/.test(corrupt.error ?? ""), corrupt);
  }
  blocked = false; try { saveMemoryFile({ path: "global/rules/secret.md", content: "sk-" + "a".repeat(40) }); } catch { blocked = true; }
  check("真实密钥样式拒绝落库", blocked);
  // ★ 截断/畸形的私钥块(只有 BEGIN、没有 END)同样拒收。
  //   两个理由:① 本模块的裁剪会制造这种形状;② 这是**保存闸门与面向模型的遮蔽漂开**
  //   的地方 —— 从前闸门只认 BEGIN(会拒)、遮蔽要求完整 BEGIN…END(会漏)。现在两处共用
  //   同一份判据(`secretShape.ts`),所以闸门与遮蔽对同一条内容给出同样的答案。
  blocked = false; try { saveMemoryFile({ path: "global/rules/secret.md", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA" }); } catch { blocked = true; }
  check("★ 只有 BEGIN 的残块也拒绝落库(与遮蔽同一份判据)", blocked);
  // ★ **带前缀的令牌也要拒**(报告附录 F 的 M2)。GitHub / Slack / 公网 MCP 链接里的
  //   明文密钥,应用自己的打码器(`appControl/redact.ts` 的 `SECRET_VALUE_PREFIXED`)
  //   早就认得 —— 而记忆这边从前只认 `sk-…`/`AKIA…`,于是"往记忆里存一条 GitHub token"
  //   成了**漏网**。判据立在这几种形状上,与打码器那份逐支对齐。
  //
  // ⚠️ **每种形状存到各自的、全新的路径**。存到同一个路径会在第二次撞 `MemoryConflictError`
  //   (没带 expectedRevision),那是**另一个理由的抛** —— 断言会假绿(实测踩过:变异时
  //   一条都不红)。全新路径没有冲突可言,唯一能抛的就是"内容像密钥"。同一条内容另存一份
  //   到另一个新路径必须成功,反证"抛的是内容、不是路径"。
  for (const [name, sample] of [
    ["GitHub PAT(ghp_)", "ghp_" + "A".repeat(36)],
    ["Slack token(xoxb-)", "xoxb-" + "1".repeat(12) + "-" + "a".repeat(24)],
    ["公网 MCP 链接密钥(/mcp/)", "https://x.example/mcp/" + "Z".repeat(40)],
  ] as const) {
    const slug = name.replace(/[^a-z0-9]/gi, "_");
    let blockedByToken = false;
    try { saveMemoryFile({ path: `global/rules/${slug}-a.md`, content: `我的 ${name}: ${sample}` }); } catch { blockedByToken = true; }
    // 反证:同样的路径形状、正常内容 → 存得进去(所以上面那次抛只可能来自内容)。
    let plainOk = true;
    try { saveMemoryFile({ path: `global/rules/${slug}-b.md`, content: "普通内容" }); } catch { plainOk = false; }
    check(`★ 带前缀的令牌被拒:${name}`, blockedByToken && plainOk, { blockedByToken, plainOk });
  }
  // 反证:普通的十六进制串不该被误拒(别把判据放宽成"什么都拦")。
  {
    let ok = true;
    try { saveMemoryFile({ path: "global/rules/plain.md", content: "提交哈希 abc123def456,窗口大小 40" }); } catch { ok = false; }
    check("普通内容不被误拒(判据没有放成什么都拦)", ok);
    let sha = true;
    try { saveMemoryFile({ path: "global/rules/sha.md", content: "pdf_sha256 = " + "a".repeat(64) }); } catch { sha = false; }
    check("裸 64 位 sha256 不被误拒(它不是令牌形状)", sha);
  }
  // ★ 【MC-093】闸门要对**整份待保存内容**统一判定,不只正文 —— 标题、以及从旧文件
  //   继承来的 frontmatter 元数据里的密钥同样不能落库。标题会进记忆列表、也会随自动注入
  //   进模型上下文;元数据会原样留在文件的 frontmatter 里。从前只查 `input.content`,
  //   于是这两条路都是**漏网**。
  {
    // ① 正文干净、**标题**里带密钥 → 拒。
    let titleBlocked = false;
    try { saveMemoryFile({ path: "global/rules/title-secret.md", content: "这段正文完全正常。", title: "我的密钥 ghp_" + "A".repeat(36) }); } catch { titleBlocked = true; }
    check("★ 标题里的密钥也被拒(不只查正文)", titleBlocked);
    // 反证:同样形状的路径、正常标题 → 存得进去(所以上面那次抛只可能来自标题内容)。
    let titleOk = true;
    try { saveMemoryFile({ path: "global/rules/title-plain.md", content: "正常正文。", title: "正常标题" }); } catch { titleOk = false; }
    check("标题正常时不被误拒", titleOk);
    // ② 已存在的文件 frontmatter 里带着密钥,更新时继承进 `extra` → 拒。
    //   路径与内容都干净,唯一能触发的是**继承来的元数据**。
    const metaPath = "global/rules/inherit-secret.md";
    // 手写一份带密钥 frontmatter 的文件(绕过 saveMemoryFile 的闸门,模拟历史/人工文件)。
    const memRoot = memoryRoot();
    const absMeta = join(memRoot, metaPath);
    mkdirSync(dirname(absMeta), { recursive: true });
    writeFileSync(absMeta, ["---", "title: 旧的", "updatedAt: 1", `note: my key AKIA${"A".repeat(16)}`, "---", "", "旧正文", ""].join("\n"), "utf8");
    // ⚠️ **必须带上真实 revision** —— 否则抛的是 `MemoryConflictError`(无版本覆盖已有文件),
    // 那是**另一个理由的抛**,断言会**假绿**(实测:变异撤掉判据后这条仍绿)。带版本后,
    // 唯一能抛的就是"继承来的元数据像密钥"。
    const metaRev = readMemoryFile(metaPath).revision;
    let metaBlocked = false;
    try { saveMemoryFile({ path: metaPath, content: "新正文,没有任何密钥。", expectedRevision: metaRev }); } catch { metaBlocked = true; }
    check("★ 从旧文件继承的元数据里的密钥也被拒", metaBlocked);
    // 被拒之后文件**原样不变**(没有半写)。
    check("被拒后文件内容未被改动", readMemoryFile(metaPath).content.trim() === "旧正文");
  }
  const preview = manageMemory({ action: "preview", source: `legacy:${legacy}` });
  check("旧记录可预览并带摘要", preview.ok && !!preview.digest && !!preview.content?.includes("legacy-private-needle"));  const imported = manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, category: "rules", projectId: "p_memory", global: false, confirmed: true });
  check("明确归属和类别后导入成功", imported.ok && !!imported.path?.startsWith("projects/p_memory/rules/"));
  eq("导入正文不混入迁移元数据", readMemoryFile(imported.path!).content.trim(), "legacy-private-needle");
  eq("导入不删除原记录", readMemoryFile(legacy).content.trim(), "legacy-private-needle");
  eq("重复导入不覆盖", manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, category: "rules", projectId: "p_memory", global: false, confirmed: true }).ok, false);
  saveMemoryFile({ path: legacy, content: "changed-source", expectedRevision: readMemoryFile(legacy).revision });
  eq("预览过期必须重新确认", manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, category: "project", global: true, confirmed: true }).ok, false);
  eq("任意文件不能作为导入源", manageMemory({ action: "preview", source: "../../secrets" }).ok, false);
  const nativeDir = join(homedir(), ".claude", "projects", "unknown-owner", "memory");
  mkdirSync(nativeDir, { recursive: true }); writeFileSync(join(nativeDir, "MEMORY.md"), "native-preserved");
  const sources = manageMemory({ action: "list" });
  check("发现原生来源但不推断归属", !!sources.sources?.some(s => s.id === ".claude/unknown-owner/MEMORY.md"));
  const np = manageMemory({ action: "preview", source: ".claude/unknown-owner/MEMORY.md" });
  check("原生来源可预览", np.content === "native-preserved");
  eq("未选项目不能导入", manageMemory({ action: "import", source: ".claude/unknown-owner/MEMORY.md", digest: np.digest!, category: "project", global: false, confirmed: true }).ok, false);
  eq("确认原生导入成功", manageMemory({ action: "import", source: ".claude/unknown-owner/MEMORY.md", digest: np.digest!, category: "project", global: true, confirmed: true }).ok, true);
  eq("原生文件原封不动", readFileSync(join(nativeDir, "MEMORY.md"), "utf8"), "native-preserved");
  // ★ 扫描上限挡掉的来源数必须**报出来**,不能静默少列。
  //   每个项目下的 .md 有上限(100),超出的从前凭空不在列表里 —— 用户以为那份记忆不存在。
  //   判据:多摆 >100 个文件,list 必须给出 truncatedSources>0,而不是沉默地只列 100 个。
  {
    const before = manageMemory({ action: "list" });
    eq("未超上限时截断数为 0", before.truncatedSources, 0);
    for (let i = 0; i < 130; i += 1) writeFileSync(join(nativeDir, `bulk-${String(i).padStart(3, "0")}.md`), `x${i}`);
    const after = manageMemory({ action: "list" });
    check("★ 超过单项目文件上限时如实报出被挡掉的数(不静默)", (after.truncatedSources ?? 0) > 0, after.truncatedSources);
    for (let i = 0; i < 130; i += 1) rmSync(join(nativeDir, `bulk-${String(i).padStart(3, "0")}.md`), { force: true });
  }
  const root = join(memoryRoot(), ".instruction-fixture"), child = join(root, "sub");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root-agents"); writeFileSync(join(root, "CLAUDE.md"), "root-claude-ignored");
  writeFileSync(join(child, "CLAUDE.md"), "child-fallback");
  const instructions = projectInstructions(root, child);
  check("AGENTS.md 优先且不拼重复CLAUDE", instructions.includes("root-agents") && !instructions.includes("root-claude-ignored"));
  check("子目录CLAUDE回退", instructions.includes("child-fallback"));
  check("越界 cwd 不读取外部", !projectInstructions(root, dirname(root)).includes("child-fallback"));
  eq("缺失项目无指令", projectInstructions(join(root, "missing"), child), "");
  // 【MC-070】Windows/macOS 上同一项目仅改路径字母大小写,子目录指令**不得**漏注入;
  // Linux 大小写敏感:大小写不同 = 不同目录,也不得误合并。
  const ciFS = process.platform === "win32" || process.platform === "darwin";
  check("前缀相近的兄弟目录不误判为子目录", !projectInstructions(root, join(root + "x", "sub")).includes("child-fallback"));
  if (ciFS) {
    check("cwd 全大写仍注入子目录指令(MC-070)", projectInstructions(root, child.toUpperCase()).includes("child-fallback"));
    check("cwd 全小写仍注入子目录指令(MC-070)", projectInstructions(root, child.toLowerCase()).includes("child-fallback"));
    check("root 大小写变体仍注入子目录指令(MC-070)", projectInstructions(root.toUpperCase(), child).includes("child-fallback"));
  } else {
    check("Linux 大小写不同不算子目录(不误合并)", !projectInstructions(root, child.toUpperCase()).includes("child-fallback"));
  }
}

console.log("\n分层工作流复用与记忆注入所有权");
{
  const types = new Map(["mcode.main", "mcode.agent", "mcode.trigger"].map(id => [id, builtinManifestById(id)!]));
  eq("复用引擎的三个手动模板", MEMORY_WORKFLOWS.length, 3);
  for (const doc of MEMORY_WORKFLOWS) {
    const report = validateWorkflowDoc({ ...doc, nodes: doc.nodes.map(n => n.type === "mcode.trigger" ? { ...n, params: { ...n.params, project: "p_memory" } } : n) }, { types });
    check(`${doc.id} 通过真实工作流质量闸门`, report.ok, report.errors);
    check(`${doc.id} 仅点击触发，无后台监听`, doc.trigger === "manual" && doc.nodes.filter(n => n.type === "mcode.trigger").every(n => n.params.triggerKind === "manual"));
    check(`${doc.id} 只使用现有触发器/代理节点`, doc.nodes.every(n => types.has(n.type)));
  }
  let reads = 0;
  const snapshot = () => { reads++; return "unique-layer-memory"; };
  const off = build({ instruction: "work", memory: "off" }, { memorySnapshot: snapshot });
  check("关闭开关不读共享记忆", reads === 0 && !off.prompt.includes("unique-layer-memory"));
  const on = build({ instruction: "work", memory: "on" }, { memorySnapshot: snapshot });
  eq("打开开关仅获取一次快照", reads, 1);
  eq("打开开关仅注入一次", on.prompt.split("unique-layer-memory").length - 1, 1);
  check("未提供可信回调不隐式读库", !build({ instruction: "work", memory: "on" }, { memorySnapshot: undefined }).prompt.includes("## 长期记忆"));
  const path = "projects/p_memory/rules/source-attribution.md";
  const spec = memoryMcpTools().find(s => s.name === "memory_write")!;
  const result = await spec.handler({ category: "rules", path, title: "source", content: "verified", origin: { sessionId: "forged" } }, { sessionId: "isolated-memory-test" });
  check("来源记录写入成功", !result.isError);
  const raw = readMemoryFileWithRaw(path).raw;
  check("来源为宿主会话不是模型伪造的值", raw.includes('"sessionId":"isolated-memory-test"') && !raw.includes("forged"));
  check("来源附带执行上下文种类", raw.includes('"kind":"chat"'));
  const before = readMemoryFile(path);
  saveMemoryFile({ path, content: "manual edit", expectedRevision: before.revision });
  check("人工编辑保留来源记录", readMemoryFileWithRaw(path).raw.includes("mcodeLastWriter:"));
}

/* ── 【MC-092】agent 经通用 app_api_call 调 memory.* 时必须绑会话项目身份 ── */
{
  // 用一个录下来的 ipcMain 起真 handler;作用域用 `runWithAgentMemoryScope` 注入(与
  // tools.ts 的接线同源)。断言:agent 作用域下**本项目 + 全局**可读写,跨项目/旧布局被拒;
  // 无作用域(桌面用户)保留全局管理权限。
  const { registerMemoryHandlers } = await import("@main/ipc/memory.js");
  const { runWithAgentMemoryScopeForSession } = await import("@main/memory/agentScope.js");
  const handlers = new Map<string, (evt: unknown, raw: unknown) => unknown>();
  const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
  registerMemoryHandlers(fakeIpc);
  const call = (ch: string, raw: unknown): unknown => handlers.get(ch)!(null, raw);

  const projPath = "projects/p_memory/rules/项目内.md";
  const otherPath = "projects/p_other/rules/别的项目.md";
  const globalPath = "global/rules/全局.md";

  // 预置三份记忆文件(不走 handler,直接 store,保证内容在)。
  saveMemoryFile({ path: projPath, content: "本项目内容" });
  saveMemoryFile({ path: otherPath, content: "别的项目内容" });
  saveMemoryFile({ path: globalPath, content: "全局内容" });

  // ① agent 作用域(p_memory):本项目 + 全局可读,别的项目**拒**。
  runWithAgentMemoryScopeForSession("isolated-memory-test", () => {
    let selfOk = true;
    try { call("memory:read", { path: projPath }); } catch { selfOk = false; }
    check("★ MC-092:agent 读**本项目**记忆可以", selfOk);
    let globalOk = true;
    try { call("memory:read", { path: globalPath }); } catch { globalOk = false; }
    check("★ MC-092:agent 读**全局**记忆可以", globalOk);
    let crossOk = true;
    try { call("memory:read", { path: otherPath }); } catch { crossOk = false; }
    check("★ MC-092:agent 读**别的项目**记忆被拒", crossOk === false);
    // list 只列本项目 + 全局,别的不出现。
    const listed = (call("memory:list", {}) as { files: Array<{ path: string }> }).files.map((f) => f.path);
    check("★ MC-092:agent list 不含别的项目", !listed.includes(otherPath), listed);
    check("★ MC-092:agent list 含本项目与全局", listed.includes(projPath) && listed.includes(globalPath), listed);
    // 写别的项目被拒。
    let writeCross = true;
    try { call("memory:save", { path: "projects/p_other/rules/新.md", content: "x" }); } catch { writeCross = false; }
    check("★ MC-092:agent 写**别的项目**记忆被拒", writeCross === false);
    // 删别的项目被拒(契约是 {ok:false,error},不抛)。⚠️ 必须带**正确 revision**,
    // 否则抛/失败的是「缺版本」这个**别的理由**,撤掉作用域闸它也不会变红(假绿)。
    const otherRev = readMemoryFile(otherPath).revision;
    const delRes = call("memory:delete", { path: otherPath, expectedRevision: otherRev }) as { ok: boolean };
    check("★ MC-092:agent 删**别的项目**记忆被拒(版本正确也拒)", delRes.ok === false, delRes);
    // 旧布局(legacy)也被拒 —— 不属于任何项目。⚠️ 文件必须**真存在**,否则 read 抛的是
    // 「读不到」而不是「不属于本项目」(又一个假绿理由)。
    saveMemoryFile({ path: "rules/旧布局.md", content: "旧布局内容" });
    let legacyOk = true;
    try { call("memory:read", { path: "rules/旧布局.md" }); } catch { legacyOk = false; }
    check("★ MC-092:agent 读旧布局记忆被拒(文件存在也拒)", legacyOk === false);
  });

  // ② 无作用域(桌面用户):全局管理权限,别的项目也能读。
  let desktopCrossOk = true;
  try { call("memory:read", { path: otherPath }); } catch { desktopCrossOk = false; }
  check("★ MC-092:桌面用户(无作用域)仍能读任意项目记忆(保留全局管理权限)", desktopCrossOk);

  // ③ 缺失身份保守拒绝:对无效会话,读记忆时解析身份会抛错。
  let noSessionThrew = false;
  try { runWithAgentMemoryScopeForSession("不存在的会话", () => call("memory:read", { path: projPath })); } catch { noSessionThrew = true; }
  check("★ MC-092:agent 会话身份缺失/无效时**保守拒绝**(不是降级成全权限)", noSessionThrew);

  // ④ **接线不变量(源码断言)**:光有作用域闸还不够 —— `app_api_call` 那一条路必须**真的**
  //    在 `memory.*` 调用外层装上作用域,否则上面的闸永远拿不到身份(等于没修)。这里读
  //    `tools.ts` 源码,断言那段 `scoped` 分派与 `runWithAgentMemoryScopeForSession` 都在。
  //    (剥注释后看,免得被注释里的同名字符串骗过。)
  {
    const src = readFileSync(join(process.cwd(), "src/main/appControl/tools.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("★ MC-092:app_api_call 对 memory.* 真的装了宿主会话作用域(调用点)",
      /entry\.method\.startsWith\("memory\."\)[\s\S]*?runWithAgentMemoryScopeForSession\(sessionId/.test(src));
  }

  // ⑤ 【MC-092 续】manage / review / reviewDelete 也纳入同一道闸。
  //
  //    manage 的 import/preview/history/restore 能读写任意路径的记忆;**review** 会扫全库;
  //    **reviewDelete** 能按指纹删任意一条 —— 这三条从前**没纳入闸门**,agent 借 `app_api_call`
  //    就能跨项目读/写/删。这里逐入口钉住。
  //
  //    ⚠️ 断言必须用**正确指纹 / 真实历史 id** —— 否则失败的是「指纹不符」「历史不存在」这些
  //    **别的理由**,撤掉闸门也不会变红(仓库踩过两次假绿)。所以先用**桌面(无作用域)**这一路
  //    拿到基线:能扫到、能预览出摘要;那正是 agent 该被拦下的同一个目标。
  {
    // 造一条**别的项目**、旧到进 `review` stale 的记忆;整块内不再改它 → 一直是 stale。
    // ⚠️ 用**当前活动数据根**(`memoryRoot()` 的父目录),不是固定某个 DATA —— 本块执行时
    //    活动根已切到别处,写错根会让 review 根本扫不到这条(试剂静默失效)。
    const liveRoot = dirname(memoryRoot());
    const crossPath = "projects/p_other/rules/stale-cross.md";
    handWrite(liveRoot, crossPath, "别的项目旧条", 1000, "别的项目正文");
    const fullReview = call("memory:review", {}) as { stale: Array<{ path: string; digest: string }>; totalFiles: number };
    const crossEntry = fullReview.stale.find((e) => e.path === crossPath);
    check("★ MC-092:桌面用户 review 能扫到别的项目(基线,另有 agent 侧反例)", crossEntry !== undefined, fullReview.stale.map((e) => e.path));
    const crossDigest = crossEntry?.digest ?? "";
    // 【MC-092 诊断】review 的 `unreadable` 诊断清单也在**整棵树**上收集(listMemoryFiles 的
    //    onUnreadable 会走过每个 `projects/<id>/…`)—— 从前**不过可见谓词**,于是 agent 能借它读到
    //   **不可见项目的路径名**(它能读到的清单里没有该项目,诊断里却点名了它的路径 = 泄露存在与名字)。
    //   造两条"不可读"试剂(**目录占着 `*.md` 的名字**,listMemoryFiles 把它当不可读项,不递归进去):
    //   一条在**别的项目**下(agent 该看不见),一条在**本项目**下(agent 该看见 —— 正控,否则
    //   "unreadable 恒为空"也会让断言假绿)。
    const blockedOther = "projects/p_other/rules/blocked-dir.md";
    const blockedSelf = "projects/p_memory/rules/blocked-dir.md";
    mkdirSync(join(memoryRoot(), ...blockedOther.split("/")), { recursive: true });
    mkdirSync(join(memoryRoot(), ...blockedSelf.split("/")), { recursive: true });
    const desktopUnreadable = (call("memory:review", {}) as { unreadable: string[] }).unreadable;
    check("★ MC-092:桌面 review 诊断含不可读的**别的项目**路径(基线)", desktopUnreadable.includes(blockedOther), desktopUnreadable);
    check("★ MC-092:桌面 review 诊断含不可读的**本项目**路径(基线)", desktopUnreadable.includes(blockedSelf), desktopUnreadable);
    // 造两条历史:一条可见(全局),一条不可见(别的项目)—— 各带真实 revision 更新一版即归档。
    saveMemoryFile({ path: globalPath, content: "v1", expectedRevision: readMemoryFile(globalPath).revision });
    saveMemoryFile({ path: otherPath, content: "v2", expectedRevision: readMemoryFile(otherPath).revision });
    const globalHist = memoryHistory().entries.find((e) => e.path === globalPath);
    const otherHist = memoryHistory().entries.find((e) => e.path === otherPath);
    check("★ MC-092:两条历史都归档成功(基线)", globalHist !== undefined && otherHist !== undefined);
    // import 的 legacy 源:桌面这一路先预览拿到**正确 digest** —— 否则 agent 侧撤掉闸门后仍会因
    // 「来源已改变」而拒,断言假绿。判据:带正确 digest 时,唯一能拒它的就是作用域。
    const legacyPreview = manageMemory({ action: "preview", source: "legacy:rules/旧布局.md" });
    check("★ MC-092:legacy 导入源可预览并带摘要(基线)", legacyPreview.ok && !!legacyPreview.digest, legacyPreview);

    // 【MC-092 诊断】manage list 的 `truncatedSources` 也是**扫描**产物:native 来源(旧记忆 /
    //   别 owner 的项目记忆)经可见谓词对 agent 一律不可见 —— 若还把整棵树的截断数摆出来,agent 会
    //   看到「sources 空、却报 N 个来源被截断」= 知道本机存在它看不见的记忆源。造一个超上限的原生
    //   项目(>100 个 .md)当试剂:桌面看到真实截断数,agent 必须看到 0。
    const bulkMemDir = join(homedir(), ".claude", "projects", "reagent-truncated", "memory");
    mkdirSync(bulkMemDir, { recursive: true });
    for (let i = 0; i < 130; i += 1) writeFileSync(join(bulkMemDir, `bulk-${String(i).padStart(3, "0")}.md`), `x${i}`);
    const deskTrunc = (call("memory:manage", { action: "list" }) as { truncatedSources?: number }).truncatedSources;
    check("★ MC-092:桌面 manage list 报出原生来源的真实截断数(基线)", (deskTrunc ?? 0) > 0, deskTrunc);
    // `historyTruncated` 同理:归档超过 200 上限的数是**全局**的(含不可见项目的历史),不该透给 agent。
    // 造 >200 条合法归档当试剂(桌面侧的真实值 >0,agent 侧必须 0)。
    const archiveDir2 = join(memoryRoot(), ".history");
    mkdirSync(archiveDir2, { recursive: true });
    for (let i = 0; i < 205; i += 1) {
      const at = 1600000000000 + i;
      const id = `${at}-${String(i).padStart(8, "0")}-0000-0000-000000000000`;
      writeFileSync(join(archiveDir2, `${id}.json`), JSON.stringify({ version: 1, id, path: "global/rules/x.md", at, reason: "before-update", raw: "x" }), "utf8");
    }
    const deskHistTrunc = (call("memory:manage", { action: "list" }) as { historyTruncated?: number }).historyTruncated;
    check("★ MC-092:桌面 manage list 报出真实的历史截断数(基线)", (deskHistTrunc ?? 0) > 0, deskHistTrunc);

    const isVisiblePath = (p: string): boolean => p.startsWith("global/") || p.startsWith("projects/p_memory/");
    runWithAgentMemoryScopeForSession("isolated-memory-test", () => {
      // manage:list —— 来源与历史都按同一份可见集合滤过。
      const ml = call("memory:manage", { action: "list" }) as {
        ok: boolean; sources?: Array<{ id: string }>; history?: Array<{ id: string; path: string }>;
        projects?: Array<{ id: string; name: string }>;
      };
      check("★ MC-092:agent manage list 不列 legacy 来源", ml.ok && !(ml.sources ?? []).some((s) => s.id.startsWith("legacy:")), ml.sources);
      check("★ MC-092:agent manage list 的项目只含自己那个", (ml.projects ?? []).every((p) => p.id === "p_memory"), ml.projects);
      check("★ MC-092:agent manage list 的 history 不含别的项目", !(ml.history ?? []).some((h) => h.path === otherPath), ml.history?.map((h) => h.path));
      check("★ MC-092:agent manage list 的 history 含全局", (ml.history ?? []).some((h) => h.path === globalPath), ml.history?.map((h) => h.path));
      // manage list 的 `truncatedSources` 也过可见谓词:agent 看到 0(不泄露"存在看不见的来源")。
      check("★ MC-092:agent manage list 的截断数为 0(不泄露不可见来源的存在)",
        (ml as { truncatedSources?: number }).truncatedSources === 0, (ml as { truncatedSources?: number }).truncatedSources);
      // `historyTruncated` 同理:agent 看不到全局归档的截断数。
      check("★ MC-092:agent manage list 的历史截断数为 0(不泄露不可见历史的存在)",
        (ml as { historyTruncated?: number }).historyTruncated === 0, (ml as { historyTruncated?: number }).historyTruncated);
      // manage:history —— 读不可见路径的历史被拒;可见的照常。
      const histOther = call("memory:manage", { action: "history", id: otherHist!.id }) as { ok: boolean };
      check("★ MC-092:agent 读**别的项目**历史被拒", histOther.ok === false, histOther);
      const histGlobal = call("memory:manage", { action: "history", id: globalHist!.id }) as { ok: boolean };
      check("★ MC-092:agent 读**全局**历史可以", histGlobal.ok === true, histGlobal);
      // manage:import —— 来源不可见(legacy/别的 owner)即拒(带**正确 digest** 也拒)。
      const imp = call("memory:manage", {
        action: "import", source: "legacy:rules/旧布局.md", digest: legacyPreview.digest!,
        category: "rules", global: true, confirmed: true,
      }) as { ok: boolean };
      check("★ MC-092:agent 导入 legacy 来源被拒(digest 正确也拒)", imp.ok === false, imp);
      // review —— 只扫可见集合:别的项目的条目既不进 stale,也不进计数。
      const rev = call("memory:review", {}) as { stale: Array<{ path: string }>; totalFiles: number };
      check("★ MC-092:agent review 不含别的项目", !rev.stale.some((e) => e.path === crossPath), rev.stale.map((e) => e.path));
      check("★ MC-092:agent review 里每一条都可见", rev.stale.every((e) => isVisiblePath(e.path)), rev.stale.map((e) => e.path));
      check("★ MC-092:agent review 计数不含不可见项(少于桌面)", rev.totalFiles < fullReview.totalFiles, { agent: rev.totalFiles, desktop: fullReview.totalFiles });
      // review 的**诊断清单**也不能泄露不可见项目:不可读项经同一份可见谓词,别的项目那条被滤掉,
      // 本项目那条保留(正控 —— 否则"unreadable 恒空"也会让负例假绿)。
      const revDiag = (call("memory:review", {}) as { unreadable: string[] }).unreadable;
      check("★ MC-092:agent review 诊断不含**别的项目**的不可读路径", !revDiag.includes(blockedOther), revDiag);
      check("★ MC-092:agent review 诊断仍含**本项目**的不可读路径(正控)", revDiag.includes(blockedSelf), revDiag);
      // 【MC-031 同族】诊断过滤从前只调文件版 `visibleMemory` —— 目录级漏读(整类目录
      //   被链接替换/读不动)没有 `.md` 文件地址,被整批丢掉,agent 看不到「这一整类没扫到」。
      //   现在诊断那条走 `visibleMemoryDiagnostic`(文件仍走文件版,目录走目录版)。夹具:
      //   本项目与别的项目各把一个**空类目目录**(experiences)换成 junction —— store 上报的
      //   路径是 `projects/<id>/experiences`(不带 `.md`,文件版谓词一律 false)。本项目那条
      //   agent 必须看到(正控);别项目那条必须仍被挡住(不泄露)。
      {
        const outsideDir = join(dirname(memoryRoot()), "mc031-review-outside");
        mkdirSync(outsideDir, { recursive: true });
        const makeJunction = (rel: string): boolean => {
          const at = join(memoryRoot(), ...rel.split("/"));
          try {
            mkdirSync(dirname(at), { recursive: true });
            symlinkSync(outsideDir, at, process.platform === "win32" ? "junction" : "dir");
            return lstatSync(at).isSymbolicLink();
          } catch { return false; }
        };
        const selfJ = makeJunction("projects/p_memory/experiences");
        const otherJ = makeJunction("projects/p_other/experiences");
        if (!selfJ || !otherJ) {
          console.log("  (跳过:本环境造不出目录链接夹具)");
        } else {
          const dirSelf = "projects/p_memory/experiences";
          const dirOther = "projects/p_other/experiences";
          const revDirDiag = (call("memory:review", {}) as { unreadable: string[] }).unreadable;
          check("★ MC-031:agent review 诊断含**本项目**的目录级漏读(正控)",
            revDirDiag.includes(dirSelf), revDirDiag);
          check("★ MC-031:agent review 诊断不含**别的项目**的目录级漏读",
            !revDirDiag.includes(dirOther), revDirDiag);
        }
        for (const rel of ["projects/p_memory/experiences", "projects/p_other/experiences"]) {
          const at = join(memoryRoot(), ...rel.split("/"));
          try { if (lstatSync(at).isSymbolicLink()) unlinkSync(at); } catch { /* 清理尽力而为 */ }
        }
        rmSync(outsideDir, { recursive: true, force: true });
      }
      // reviewDelete —— 带**正确指纹**删别的项目也被拒(与 memory:delete 同一道闸)。
      const rd = call("memory:reviewDelete", { path: crossPath, digest: crossDigest }) as { ok: boolean };
      check("★ MC-092:agent reviewDelete 别的项目被拒(指纹正确也拒)", rd.ok === false, rd);
    });

    // ⑥ 反证:桌面(无作用域)用**同一路径 + 同一指纹**删得掉 —— 证明上面拒的是**作用域**,
    //    不是指纹。删掉也顺手清理这条试剂。
    const rdDesk = call("memory:reviewDelete", { path: crossPath, digest: crossDigest }) as { ok: boolean };
    check("★ MC-092:桌面用户 reviewDelete 同一路径+指纹可以(反证拒的是作用域不是指纹)", rdDesk.ok === true, rdDesk);
    // 清理诊断试剂目录(它们占着 `*.md` 名,不清理会挡住后续同路径的真实文件)。
    rmSync(join(memoryRoot(), ...blockedOther.split("/")), { recursive: true, force: true });
    rmSync(join(memoryRoot(), ...blockedSelf.split("/")), { recursive: true, force: true });
    rmSync(bulkMemDir, { recursive: true, force: true });
    // 清理历史截断试剂(只删本块刚造的 205 条,别碰别处真实归档)。
    for (let i = 0; i < 205; i += 1) {
      const id = `${1600000000000 + i}-${String(i).padStart(8, "0")}-0000-0000-000000000000`;
      rmSync(join(archiveDir2, `${id}.json`), { force: true });
    }
  }
}

/* ── 【MC-093 读侧】注入/检索前遮蔽历史记录里的密钥 ──
 *
 * 保存闸门只挡**新写入**;历史/人工编辑的旧记录可能本就含密钥。此前 `retrieval.ts` 直接
 * `readMemoryFile(...).content` 拼进注入快照/检索预览 —— 读侧不遮 = 把旧密钥送进模型上下文。
 * 判据与保存闸门同一份(`redactSecrets` → `secretShape.ts`)。 */
{
  // 手写一份**含密钥**的记忆文件(绕过 saveMemoryFile 的闸门,模拟历史/人工文件)。
  const secretPath = "global/rules/legacy-secret.md";
  const abs = join(memoryRoot(), secretPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, ["---", "title: 旧规则", "updatedAt: 1", "---", "", "原来的密钥是 sk-" + "a".repeat(40) + ",别外传。"].join("\n"), "utf8");

  // 注入快照(拼进模型上下文的那份)里不能出现明文密钥。
  const snap = scopedMemorySnapshot("p_memory", "密钥");
  check("★ MC-093:注入快照里历史密钥被遮蔽(不是明文)", !snap.includes("sk-" + "a".repeat(40)), snap.slice(0, 120));
  // 检索预览里也不能出现。
  const hit = searchMemory("密钥").find((h) => h.meta.path === secretPath);
  check("★ MC-093:检索预览里历史密钥也被遮蔽", hit !== undefined && !hit.body.includes("sk-" + "a".repeat(40)), hit?.body?.slice(0, 120));
  // 反证:普通内容不被误遮(判据没放成"什么都遮")。
  saveMemoryFile({ path: "global/rules/plain-read.md", content: "普通内容,没有密钥。" });
  const snap2 = scopedMemorySnapshot("p_memory", "普通");
  check("普通内容照常出现在快照里(未被误遮)", snap2.includes("普通内容"), snap2.slice(0, 120));
  rmSync(abs, { force: true });
}

/* ── 【MC-092 真实入口】两个项目 A/B,走**真** `app_api_call`(invokeAppTool)经记忆 RPC ──
 *
 * 上面那条(§MC-092)是**手装作用域**直调 handler。这一条不同:它调 `invokeAppTool`
 * (`app_api_call` 的真实执行体),由 `tools.ts` 自己按 `entry.method.startsWith("memory.")`
 * 给 `callRpc` 外层装宿主会话作用域 —— 也就是**接线本身**被测,不是替身。两个入口都验:
 *   ① 主读写 = `memory.read` / `memory.list` / `memory.save`;
 *   ② 诊断/整理 = `memory.review`(只读扫描)与 `memory.manage`(列表型,写档);
 * 项目 A 的会话见 A、项目 B 的会话见 B,**互相看不见**;无可信会话身份**拒**,而不是降级看全部。 */
{
  process.env.MCODE_SMOKE_DATA_ROOT = DATA5;
  for (const m of listMemoryFiles()) { try { deleteMemoryFile(m.path, readMemoryFile(m.path).revision); } catch { /* 残留 */ } }

  // 真 handler 进 appControl 的登记处 —— 与生产 `createDbGuardedIpc` 同一步(`recordRpcHandler`)。
  // app_api_call 的 `entry.registered` 就取自这张表,所以必须真登记,不能只喂直调 map。
  const { registerMemoryHandlers } = await import("@main/ipc/memory.js");
  clearRpcHandlers();
  const fakeIpc = { handle: (ch: string, fn: unknown) => recordRpcHandler(ch, fn as (e: unknown, r: unknown) => unknown) } as never;
  registerMemoryHandlers(fakeIpc);

  const PATH_A = "projects/p_memory/rules/a.md";
  const PATH_B = "projects/p_other/rules/b.md";
  const PATH_G = "global/rules/g.md";
  saveMemoryFile({ path: PATH_A, title: "A 条", content: "A_ONLY_MARKER 只属于项目 A。" });
  saveMemoryFile({ path: PATH_B, title: "B 条", content: "B_ONLY_MARKER 只属于项目 B。" });
  saveMemoryFile({ path: PATH_G, title: "G 条", content: "GLOBAL_MARKER 全局共享。" });

  // 真实 ProviderContext(与 app-control-smoke 的 ctxWith 同形):读档自动放行,写档要审批 → 一律点头。
  const ctx = {
    getPermissionMode: () => undefined,
    requestApproval: async () => ({ allow: true }),
  } as unknown as ProviderContext;
  const SESSION_A = "isolated-memory-test"; // → p_memory
  const SESSION_B = "memory-session-b"; // → p_other
  const realCall = (method: string, input: unknown, session: string): ReturnType<typeof invokeAppTool> =>
    invokeAppTool("app_api_call", { method, input }, session, ctx);
  const succeeded = (r: { structuredContent?: Record<string, unknown> }): boolean =>
    opResultOf(r)?.resultKind === "SUCCEEDED";

  // ① 主读写入口 —— 本项目可读、跨项目拒。
  {
    const readA = await realCall("memory.read", { path: PATH_A }, SESSION_A);
    check("★ MC-092 真实入口:会话 A 经 app_api_call 读**本项目 A** 记忆成功",
      succeeded(readA) && textOf(readA).includes("A_ONLY_MARKER"), textOf(readA).slice(0, 160));
    const readCrossA = await realCall("memory.read", { path: PATH_B }, SESSION_A);
    check("★ MC-092 真实入口:会话 A 读**项目 B** 记忆被拒(返回里没有 B 正文)",
      !succeeded(readCrossA) && !textOf(readCrossA).includes("B_ONLY_MARKER"), textOf(readCrossA).slice(0, 160));

    const readB = await realCall("memory.read", { path: PATH_B }, SESSION_B);
    check("★ MC-092 真实入口:会话 B 读**本项目 B** 记忆成功",
      succeeded(readB) && textOf(readB).includes("B_ONLY_MARKER"), textOf(readB).slice(0, 160));
    const readCrossB = await realCall("memory.read", { path: PATH_A }, SESSION_B);
    check("★ MC-092 真实入口:会话 B 读**项目 A** 记忆被拒(返回里没有 A 正文)",
      !succeeded(readCrossB) && !textOf(readCrossB).includes("A_ONLY_MARKER"), textOf(readCrossB).slice(0, 160));

    // 全局对两个项目都可见(显式共享)。
    const readGlobalA = await realCall("memory.read", { path: PATH_G }, SESSION_A);
    check("★ MC-092 真实入口:会话 A 读**全局**记忆成功", succeeded(readGlobalA) && textOf(readGlobalA).includes("GLOBAL_MARKER"));

    // list 只列本项目 + 全局。
    const listA = await realCall("memory.list", {}, SESSION_A);
    check("★ MC-092 真实入口:会话 A 的 memory.list 含本项目与全局、不含项目 B",
      succeeded(listA) && textOf(listA).includes(PATH_A) && textOf(listA).includes(PATH_G) && !textOf(listA).includes(PATH_B),
      textOf(listA).slice(0, 200));

    // 写别的项目 → 拒(带正确 revision 也拒)。
    const revCross = readMemoryFile(PATH_B).revision;
    const saveCross = await realCall("memory.save",
      { path: PATH_B, content: "试图篡改 B", expectedRevision: revCross }, SESSION_A);
    check("★ MC-092 真实入口:会话 A 经 app_api_call 写**项目 B** 记忆被拒",
      !succeeded(saveCross) && !textOf(saveCross).includes("试图篡改"), textOf(saveCross).slice(0, 160));
    check("★ MC-092 真实入口:被拒后项目 B 文件内容原样不变",
      readMemoryFile(PATH_B).content.includes("B_ONLY_MARKER"));
  }

  // ② 诊断/整理入口 —— review(扫描)与 manage(列表型)。
  {
    const reviewA = await realCall("memory.review", {}, SESSION_A);
    check("★ MC-092 真实入口:会话 A 的 memory.review 不含项目 B 的条目",
      succeeded(reviewA) && !textOf(reviewA).includes("projects/p_other/"), textOf(reviewA).slice(0, 200));

    const manageA = await realCall("memory.manage", { action: "list" }, SESSION_A);
    check("★ MC-092 真实入口:会话 A 的 memory.manage list 项目只含自己那个",
      succeeded(manageA) && textOf(manageA).includes("p_memory") && !textOf(manageA).includes("p_other"),
      textOf(manageA).slice(0, 200));
  }

  // ③ 无可信身份 —— 拒(绝不降级成"看全部")。`tools.ts` 照样装作用域,但那个会话 id
  //    在宿主里解析不出项目身份 → 记忆 handler 解析身份时抛 → FAILED。
  {
    const noScope = await realCall("memory.read", { path: PATH_A }, "no-such-session");
    check("★ MC-092 真实入口:无可信会话身份时经 app_api_call 读记忆被拒(不降级看全部)",
      !succeeded(noScope) && !textOf(noScope).includes("A_ONLY_MARKER"), textOf(noScope).slice(0, 160));
    const noScopeList = await realCall("memory.list", {}, "no-such-session");
    check("★ MC-092 真实入口:无可信身份时 memory.list 也被拒(不是列全部)",
      !succeeded(noScopeList) && !textOf(noScopeList).includes(PATH_B), textOf(noScopeList).slice(0, 160));
  }

  // 清掉本块登记,免得多套之间串味。
  clearRpcHandlers();
}

/* ── 【MC-093 真实入口 · E1】人工/历史旧文件的敏感原文不得进入**模型上下文** ──
 *
 * 上面的 §MC-093 是直接调 `scopedMemorySnapshot` / `searchMemory`。这一条走**生产接线**:
 * `runner.ts` 把 `memorySnapshot` 绑成 `(query) => scopedMemorySnapshot(session.projectId, …)`,
 * `buildNodeInput` 拿它的输出拼进提示词 —— 那就是真正送进模型的那段文本。先把含密钥的文件
 * **直接写到磁盘**(绕过 saveMemoryFile 的写侧闸门,模拟人工编辑 / 恢复的旧文件),再走这条
 * 真实注入链 + 真实 MCP `memory_search` 工具,断言密钥**不出现在任何一处返回/注入文本里**;
 * 同一条记录里的非密钥标记仍照常出现(反证:不是"什么都遮")。 */
{
  process.env.MCODE_SMOKE_DATA_ROOT = DATA6;
  for (const m of listMemoryFiles()) { try { deleteMemoryFile(m.path, readMemoryFile(m.path).revision); } catch { /* 残留 */ } }

  const SECRET = "sk-" + "b".repeat(40); // 命中 ACCESS_KEY_RE(≥24 位),redactSecrets 会遮
  const secretPath = "projects/p_memory/rules/legacy-s.md";
  const absSecret = join(memoryRoot(), ...secretPath.split("/"));
  mkdirSync(dirname(absSecret), { recursive: true });
  writeFileSync(absSecret,
    ["---", 'title: "旧规则"', "updatedAt: 9999999999999", "---", "",
      `这是人工编辑留下的记录:密钥是 ${SECRET},但工艺标记 CRAFT_MARKER 仍要看得到。`].join("\n"), "utf8");
  // 纯普通记录(负控):内容里没有密钥,必须原样出现。
  saveMemoryFile({ path: "projects/p_memory/rules/plain.md", title: "普通", content: "PLAIN_MARKER 普通内容,不含密钥。" });

  // 真实注入链:与 runner.ts 的 `memorySnapshot` 绑定逐字同形。
  const injected = build(
    { instruction: "沿用旧规则", memory: "on" },
    { memorySnapshot: (query?: string) => scopedMemorySnapshot("p_memory", query ?? "旧规则 密钥 工艺") },
  ).prompt;
  check("★ MC-093 真实入口:注入提示词里历史密钥被遮蔽(不是明文)", !injected.includes(SECRET), injected.slice(0, 160));
  check("★ MC-093 真实入口:注入提示词里密钥占位符已就位", injected.includes("[已隐藏疑似密钥]"));
  check("★ MC-093 真实入口:同一记录的**非密钥**标记仍照常注入(反证未误遮)", injected.includes("CRAFT_MARKER"));
  check("★ MC-093 真实入口:普通记录照常注入(负控)", injected.includes("PLAIN_MARKER"));

  // 真实 MCP 检索工具:模型调 memory_search 拿回的那段文本同样不得含密钥。
  const searchCtx: ProviderContext = { emit() {}, log: { info() {}, warn() {}, error() {} } } as unknown as ProviderContext;
  const searchRes = await invokeMemoryTool("memory_search", { query: "规则 密钥 工艺" }, "isolated-memory-test", searchCtx);
  const searchText = textOf(searchRes as unknown as { content: Array<{ type: string; text?: string }> });
  check("★ MC-093 真实入口:memory_search 工具返回里历史密钥被遮蔽", !searchText.includes(SECRET), searchText.slice(0, 160));
  check("★ MC-093 真实入口:memory_search 命中里非密钥标记仍可见(反证)", searchText.includes("CRAFT_MARKER"));

  rmSync(absSecret, { force: true });
}

/* ────────────────────────── 汇总 ────────────────────────── */

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
