import { MEMORY_WORKFLOWS } from "@main/orchestration/memoryWorkflows.js";
import { validateWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { scopedMemorySnapshot } from "@main/memory/retrieval.js";
import { memoryHistory, readHistory, restoreMemory, readMemoryFileWithRaw } from "@main/memory/store.js";
import { manageMemory } from "@main/memory/manage.js";
import { projectInstructions } from "@main/memory/instructions.js";
import { invokeMemoryTool, memoryToolDescriptors } from "@main/memory/engineTools.js";
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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  eq("真实工具可新建记忆", (await invoke("memory_write", base)).isError, undefined);
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
  const before = readMemoryFileWithRaw(own);
  saveMemoryFile({ path: own, content: "updated", expectedRevision: before.revision });
  const history = memoryHistory().find(h => h.path === own && h.reason === "before-update")!;
  eq("更新前归档保留原始字节", readHistory(history.id).raw, before.raw);
  let blocked = false; try { restoreMemory(history.id); } catch { blocked = true; }
  check("恢复不能覆盖现有记录", blocked);
  deleteMemoryFile(own, readMemoryFile(own).revision);
  restoreMemory(history.id);
  eq("恢复原字节与版本", readMemoryFileWithRaw(own).raw, before.raw);
  check("删除前有恢复点", memoryHistory().some(h => h.path === own && h.reason === "before-delete"));
  blocked = false; try { readHistory("../escape"); } catch { blocked = true; }
  check("归档编号不能穿越路径", blocked);
  blocked = false; try { saveMemoryFile({ path: "global/rules/secret.md", content: "sk-" + "a".repeat(40) }); } catch { blocked = true; }
  check("真实密钥样式拒绝落库", blocked);
  const preview = manageMemory({ action: "preview", source: `legacy:${legacy}` });
  check("旧记录可预览并带摘要", preview.ok && !!preview.digest && !!preview.content?.includes("legacy-private-needle"));
  const imported = manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, projectId: "p_memory", global: false, confirmed: true });
  check("明确归属后导入成功", imported.ok && !!imported.path?.startsWith("projects/p_memory/"));
  eq("导入不删除原记录", readMemoryFile(legacy).content.trim(), "legacy-private-needle");
  eq("重复导入不覆盖", manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, projectId: "p_memory", global: false, confirmed: true }).ok, false);
  saveMemoryFile({ path: legacy, content: "changed-source", expectedRevision: readMemoryFile(legacy).revision });
  eq("预览过期必须重新确认", manageMemory({ action: "import", source: `legacy:${legacy}`, digest: preview.digest!, global: true, confirmed: true }).ok, false);
  eq("任意文件不能作为导入源", manageMemory({ action: "preview", source: "../../secrets" }).ok, false);
  const nativeDir = join(homedir(), ".claude", "projects", "unknown-owner", "memory");
  mkdirSync(nativeDir, { recursive: true }); writeFileSync(join(nativeDir, "MEMORY.md"), "native-preserved");
  const sources = manageMemory({ action: "list" });
  check("发现原生来源但不推断归属", !!sources.sources?.some(s => s.id === ".claude/unknown-owner/MEMORY.md"));
  const np = manageMemory({ action: "preview", source: ".claude/unknown-owner/MEMORY.md" });
  check("原生来源可预览", np.content === "native-preserved");
  eq("未选项目不能导入", manageMemory({ action: "import", source: ".claude/unknown-owner/MEMORY.md", digest: np.digest!, global: false, confirmed: true }).ok, false);
  eq("确认原生导入成功", manageMemory({ action: "import", source: ".claude/unknown-owner/MEMORY.md", digest: np.digest!, global: true, confirmed: true }).ok, true);
  eq("原生文件原封不动", readFileSync(join(nativeDir, "MEMORY.md"), "utf8"), "native-preserved");
  const root = join(memoryRoot(), ".instruction-fixture"), child = join(root, "sub");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root-agents"); writeFileSync(join(root, "CLAUDE.md"), "root-claude-ignored");
  writeFileSync(join(child, "CLAUDE.md"), "child-fallback");
  const instructions = projectInstructions(root, child);
  check("AGENTS.md 优先且不拼重复CLAUDE", instructions.includes("root-agents") && !instructions.includes("root-claude-ignored"));
  check("子目录CLAUDE回退", instructions.includes("child-fallback"));
  check("越界 cwd 不读取外部", !projectInstructions(root, dirname(root)).includes("child-fallback"));
  eq("缺失项目无指令", projectInstructions(join(root, "missing"), child), "");
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

/* ────────────────────────── 汇总 ────────────────────────── */

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
