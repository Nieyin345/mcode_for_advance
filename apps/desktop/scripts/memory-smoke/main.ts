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
 *
 * Run: scripts/memory-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MEMORY_CATEGORIES } from "@contracts/memory";
import type { NodeTypeManifest } from "@contracts/nodeType";
import {
  buildNodeInput,
  expandTriggerVars,
  triggerVarCandidates,
  type ModelInputScope,
  type RunnableNodeInput,
} from "@main/orchestration/nodeInputBuilders.js";
import {
  deleteMemoryFile,
  listMemoryFiles,
  memoryCategories,
  readMemoryFile,
  saveMemoryFile,
} from "@main/memory/store.js";
import { BODY_CAP, DEFAULT_LIMIT, SNAPSHOT_CAP, memorySnapshotFor } from "@main/memory/retrieval.js";
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
    userPrompt: "用户的话",
    upstream: "",
    upstreamArtifacts: [],
    upstreamOutputs: {},
    nodeId: "a",
    plan: [[{ id: "a", title: "第一步", isLast: true }]],
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

const t2 = saveMemoryFile({ path: "rules/引用规范.md", content: "更新后的正文。" }).updatedAt;
check("二次 save 的时间不减", t2 >= t1, { t1, t2 });
eq("二次 save 沿用旧标题", listMemoryFiles().find((m) => m.path === "rules/引用规范.md")?.title, "引用规范");
eq("正文已更新", readMemoryFile("rules/引用规范.md").content.trim(), "更新后的正文。");

saveMemoryFile({ path: "rules/引用规范.md", content: "再改。", title: "引用的新规范" });
eq("显式 title 覆盖旧标题", listMemoryFiles().find((m) => m.path === "rules/引用规范.md")?.title, "引用的新规范");

deep("categories 固定六类", memoryCategories(), [...MEMORY_CATEGORIES]);

deleteMemoryFile("rules/引用规范.md");
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
check(
  `整段超过 SNAPSHOT_CAP(${SNAPSHOT_CAP})后收手并注明`,
  memorySnapshotFor(undefined, DEFAULT_LIMIT + 6).includes("(记忆快照过长"),
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
deep(
  "候选按 key 排序",
  triggerVarCandidates({ files: 1, at: 2, kind: 3 }),
  ["{{trigger.at}}", "{{trigger.files}}", "{{trigger.kind}}"],
);
deep("无载荷候选为空", triggerVarCandidates(undefined), []);

const withTrigger = build(
  { instruction: "处理 {{trigger.toolName}}" },
  { trigger: { toolName: "mcp_a", kind: "manual" } },
);
check("buildNodeInput 展开进提示词", withTrigger.prompt.includes("处理 mcp_a"), withTrigger.prompt);
deep("载荷进 data.trigger", (withTrigger.data as unknown as Record<string, unknown>).trigger, { toolName: "mcp_a", kind: "manual" });
const noTrigger = build({ instruction: "做点事" });
check("手动跑 data 里没有 trigger 键", !("trigger" in noTrigger.data));
deep("候选(同载荷)可用于界面分组", triggerVarCandidates({ toolName: "mcp_a", kind: "manual" }), ["{{trigger.kind}}", "{{trigger.toolName}}"]);

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

/* ────────────────────────── 汇总 ────────────────────────── */

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
