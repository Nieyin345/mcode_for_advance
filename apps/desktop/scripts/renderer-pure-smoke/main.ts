/**
 * 渲染端**纯逻辑**三件的回归网。
 *
 * 这三个文件此前**一套覆盖都没有**,而它们都不是"薄壳"—— 每一个都有能算错的真逻辑,
 * 且都是**无头可测**的纯件(不碰 DOM / store,只 import type):
 *
 *  1. `ide/commitGraph.ts` —— git 历史图的泳道排布。算错的形状是"连线接错格子、
 *     泳道数不对、合并提交画得跟普通提交一样",而这些**只靠眼睛看不出来**(图密的时候)。
 *  2. `lib/lineDiff.ts` —— 行级 LCS diff。算错的形状是"+N -M"徽标数字不对、
 *     编辑前后的行对错了位。
 *  3. `ide/turnFlowModel.ts` —— Turn Flow 面板的派生:回合分组、用量记录匹配、
 *     工具分类、计数、token 派生。它决定那一屏显示的**是不是真事**。
 *
 * 判据尽量立在"用户看到什么":泳道数、连线两端、+N/-M、分组索引、分类桶。
 *
 * Run: scripts/renderer-pure-smoke/run.sh
 */
import "./prelude.js";
import {
  layoutCommitGraph,
} from "../../src/renderer/components/ide/commitGraph.js";
import { lineDiff, diffSummary, type DiffLine } from "../../src/renderer/lib/lineDiff.js";
import { setLastCursor, getLastCursor } from "../../src/renderer/lib/editorNav.js";
import {
  fnv1a,
  LRUCache,
  CachedString,
  codeCacheKey,
} from "../../src/renderer/lib/markdownCache.js";
import { convertHtmlTables } from "../../src/renderer/lib/htmlTable.js";
import { isPathWithin } from "../../src/renderer/lib/path.js";
import { collectCommands } from "../../src/renderer/lib/commands.js";
import type { SessionState } from "../../src/renderer/stores/sessionStore.js";
import { partitionClosable, ideDirtyTracker } from "../../src/renderer/lib/ideDirty.js";
import {
  buildTurnGroups,
  buildFlowRows,
  matchUsageRecords,
  findSubagentSnapshot,
  stepAccent,
  toolCategory,
  countActions,
  userMessagePreview,
  turnFilesTotals,
  usageInputTokens,
  cacheHitRate,
  imageCountsByToolCall,
  fmtClockTime,
  fmtDuration,
  QUESTION_TOOLS,
  SUBAGENT_TOOLS,
  PLAN_TOOLS,
} from "../../src/renderer/components/ide/turnFlowModel.js";
import type { Block, ChatMessage } from "../../src/renderer/stores/sessionStore.js";
import type { SubagentSnapshot, TurnUsageRecord } from "@contracts/runtime";
import type { GitCommitInfo } from "@contracts/ipc";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(t: string): void {
  console.log(`\n${t}`);
}

/* ─────────────────────── 1. commitGraph ─────────────────────── */

section("1. git 历史图:泳道排布");

/** 造一条提交。`parents` 省略 = 根提交。 */
function commit(hash: string, ...parents: string[]): GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: hash,
    author: "s",
    authoredAt: "2026-01-01T00:00:00Z",
    parents,
  };
}
/** 把"每一行的连线"压成可读形状:`lane >toLane,toLane`。 */
function connsOf(rows: ReturnType<typeof layoutCommitGraph>["rows"], i: number): string {
  return rows[i]!.connections.map((c) => `${c.fromLane}>${c.toLane}`).join(",");
}

{
  // 一条直线:A → B → C(topological order,子在前)。
  const g = layoutCommitGraph([commit("A", "B"), commit("B", "C"), commit("C")]);
  eq("直线:三行", g.rows.length, 3);
  eq("直线:只用一条泳道", g.laneCount, 1);
  eq("直线:每行都在泳道 0", g.rows.map((r) => r.lane).join(","), "0,0,0");
  eq("直线:首行没有进来的线", g.rows[0]!.incoming, false);
  eq("直线:第二行有进来的线(上一行指向它)", g.rows[1]!.incoming, true);
  eq("直线:下一行是直连(0>0)", connsOf(g.rows, 0), "0>0");
  eq("直线:没有合并提交", g.rows.some((r) => r.isMerge), false);
}

{
  // 分叉 + 汇合:
  //   M(merge, parents B、C) → B → C → D
  // M 是合并提交:第一个父 B 继承自己的泳道,第二个父 C 开一条新泳道。
  const g = layoutCommitGraph([
    commit("M", "B", "C"),
    commit("B", "D"),
    commit("C", "D"),
    commit("D"),
  ]);
  check("合并提交被标出来", g.rows[0]!.isMerge, g.rows[0]);
  eq("合并提交有两条连线(两个父)", g.rows[0]!.connections.length, 2);
  eq("第一个父继承本行泳道(0>0)", `${g.rows[0]!.connections[0]!.fromLane}>${g.rows[0]!.connections[0]!.toLane}`, "0>0");
  check(
    "第二个父开了另一条泳道",
    g.rows[0]!.connections[1]!.toLane !== 0,
    g.rows[0]!.connections,
  );
  check("至少两条泳道", g.laneCount >= 2, g.laneCount);
  // B 与 C 都指向 D:D 到达时,那两条泳道都该收进 D 自己的泳道。
  const dIdx = 3;
  eq("D 落在泳道 0(两条支路汇到主干)", g.rows[dIdx]!.lane, 0);
  check(
    "D 的行首有进来的线",
    g.rows[dIdx]!.incoming,
    g.rows[dIdx],
  );
}

{
  // 分页边界 / 排序缺口:某个提交的上文不在本页里 —— 它不该被当成"有进来的线",
  // 而要退到一条空闲泳道(不然连线会从页面顶端凭空画下来)。
  const g = layoutCommitGraph([commit("X", "not-in-page")]);
  eq("孤零零一条:落在泳道 0", g.rows[0]!.lane, 0);
  eq("它没有进来的线(上文不在本页)", g.rows[0]!.incoming, false);
  eq("但它自己指向父的一条线(0>0)", connsOf(g.rows, 0), "0>0");
}

{
  // 空输入:不该抛,也不该报出负的泳道数。
  const g = layoutCommitGraph([]);
  eq("空输入:零行", g.rows.length, 0);
  eq("空输入:泳道数至少 1(不留 0 让调用方除零)", g.laneCount, 1);
}

/* ─────────────────────── 2. lineDiff ─────────────────────── */

section("2. 行级 diff");

const ops = (d: readonly DiffLine[]): string => d.map((x) => `${x.op[0]}:${x.text}`).join("|");

{
  eq("相同文本:全是 equal", ops(lineDiff("a\nb\nc", "a\nb\nc")), "e:a|e:b|e:c");
  eq("相同文本:+0 -0", JSON.stringify(diffSummary(lineDiff("a\nb", "a\nb"))), '{"adds":0,"dels":0}');
}

{
  // 改一行:a→x。
  //
  // ⚠️ **顺序钉的是"现状",而现状与文件头的自述不符** —— 见本节末尾那段说明。
  //    现在的输出是**新行在前、旧行在后**(`i:x|d:b`)。
  const d = lineDiff("a\nb\nc", "a\nx\nc");
  eq("改一行:新行在前、旧行在后(见下方现状说明)", ops(d), "e:a|i:x|d:b|e:c");
  const s = diffSummary(d);
  eq("改一行:+1", s.adds, 1);
  eq("改一行:-1", s.dels, 1);
}

{
  // 纯插入。
  const d = lineDiff("a\nc", "a\nb\nc");
  eq("插入:b 是 insert", ops(d), "e:a|i:b|e:c");
  eq("插入:+1 -0", JSON.stringify(diffSummary(d)), '{"adds":1,"dels":0}');
}

{
  // 纯删除。
  const d = lineDiff("a\nb\nc", "a\nc");
  eq("删除:b 是 delete", ops(d), "e:a|d:b|e:c");
  eq("删除:+0 -1", JSON.stringify(diffSummary(d)), '{"adds":0,"dels":1}');
}

{
  // 末尾换行:一个以 \n 结尾的文件不该多出一条"幽灵空行"。
  const d = lineDiff("a\nb\n", "a\nb\n");
  eq("末尾换行:两个都带 \\n,仍是纯 equal", ops(d), "e:a|e:b");
  // 空 ↔ 空。
  eq("空对空:零行", lineDiff("", "").length, 0);
  eq("空 → 一行:是插入", ops(lineDiff("", "x")), "i:x");
  eq("一行 → 空:是删除", ops(lineDiff("x", "")), "d:x");
}

{
  // 中间的空行是**真实的一行**,不是可折叠的空白。
  const d = lineDiff("a\n\nb", "a\nb");
  eq("中间空行删掉算一行 delete", ops(d), "e:a|d:|e:b");
}

/*
 * ⚠️ **一个"现状 vs 自述"的偏离,本套件钉现状、不动行为**（2026-10-07）。
 *
 * `lineDiff.ts` 文件头写着输出是 `old-then-new order`,而那在"改一行"时**不成立**:
 * `lineDiff("a\nb\nc","a\nx\nc")` 给出的是 `e:a | i:x | d:b | e:c` —— **新行在前**。
 * `DiffView` 按 op 上色(− 红 / + 绿),所以用户在编辑工具卡上看到的是:
 *
 *     a
 *   + x
 *   − b
 *     c
 *
 * 而 git / 大多数 diff 工具的惯例是**删在前**(`− b` 再 `+ x`)。两者都不算"错",
 * 但和文件头那句话对不上。
 *
 * **为什么不顺手改**:`-` 在上是既定观感,改顺序会让所有编辑卡的 diff 上下调个个儿 ——
 * 那是**改行为**,不是改 bug,得你拍板。所以这里**钉现状**(谁以后改动了它会看见),
 * 并把偏离记在 `docs/planning/优化方向.md`。判据立在"用户看到的那三行"上。
 */
{
  const d = lineDiff("b", "x");
  const rendered = d.map((l) => (l.op === "insert" ? "+" : l.op === "delete" ? "−" : " ") + l.text);
  check(
    "单行替换的呈现是「+ 新 / − 旧」(与 git 的「− 旧 / + 新」相反 —— 现状,非本次修改)",
    rendered.join(" ") === "+x −b",
    rendered,
  );
}

/* ─────────────────────── 3. turnFlowModel ─────────────────────── */

section("3. Turn Flow 派生");

const B = (x: unknown): Block => x as Block;
let seq = 0;
const msg = (
  role: "user" | "assistant",
  blocks: Block[],
  turnMeta?: { startedAt: number; endedAt?: number },
): ChatMessage =>
  ({ id: `m${seq++}`, sessionId: "s", role, blocks, createdAt: seq, ...(turnMeta ? { turnMeta } : {}) }) as ChatMessage;
const text = (t: string): Block => B({ kind: "text", text: t });
const toolUse = (id: string, name: string): Block =>
  B({ kind: "tool_use", toolCallId: id, toolName: name, input: {}, status: "done" });

/* 3a. buildTurnGroups */
{
  const groups = buildTurnGroups([
    msg("user", [text("第一问")]),
    msg("assistant", [text("答一")], { startedAt: 100 }),
    msg("assistant", [text("答一续")]),
    msg("user", [text("第二问")]),
    msg("assistant", [text("答二")], { startedAt: 200, endedAt: 300 }),
  ]);
  eq("两次提问 → 两组", groups.length, 2);
  eq("索引从 1 起", groups.map((g) => g.index).join(","), "1,2");
  eq("第一组:一条提问两条答", groups[0]!.assistantMessages.length, 2);
  eq("第一组的提问文本", (groups[0]!.userMessage?.blocks[0] as { text: string }).text, "第一问");
  eq("第二组只有一条答", groups[1]!.assistantMessages.length, 1);
}

{
  // turnMeta 只在**第一条**带它的 assistant 上取;running = 有 meta 且没 endedAt。
  const g = buildTurnGroups([
    msg("user", [text("问")]),
    msg("assistant", [text("a")], { startedAt: 1 }),
    msg("assistant", [text("b")], { startedAt: 999, endedAt: 999 }),
  ]);
  eq("running:取第一条的 meta(没 endedAt)→ 还在跑", g[0]!.running, true);
  eq("turnMeta.startedAt 是第一条那个", g[0]!.turnMeta?.startedAt, 1);
  check("后面那条的 endedAt 不影响(取的是第一条)", g[0]!.turnMeta?.endedAt === undefined, g[0]!.turnMeta);
}

{
  // 开头的 assistant 没有前面的 user(旧数据 / 压缩边界)—— 单独成组,userMessage 为 null。
  const g = buildTurnGroups([msg("assistant", [text("凭空一段")], { startedAt: 1 })]);
  eq("前面没提问的 assistant 自成一组", g.length, 1);
  eq("它的 userMessage 是 null(不编一个出来)", g[0]!.userMessage, null);
}

{
  eq("空消息列表 → 零组", buildTurnGroups([]).length, 0);
}

/* 3b. matchUsageRecords — 从**尾部**对齐,窗口外不硬绑 */
{
  // ⚠️ **两个回合要在同一次 buildTurnGroups 里建** —— index 是"本次窗口内第几个",
  // 分两次调用的话两组都会拿到 index 1(那正是本套第一版写错的夹具)。
  const groups = buildTurnGroups([
    msg("user", [text("q1")]),
    msg("assistant", [text("a1")], { startedAt: 1, endedAt: 1000 }),
    msg("user", [text("q2")]),
    msg("assistant", [text("a2")], { startedAt: 2, endedAt: 2000 }),
  ]);
  const rec = (endedAt: number): TurnUsageRecord =>
    ({ endedAt, durationMs: 1, totalProcessedTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }) as TurnUsageRecord;

  eq("两次提问 → 两组", groups.length, 2);
  const m = matchUsageRecords(groups, [rec(1000), rec(2000)]);
  eq("两条历史各绑一个回合", m.size, 2);
  eq("第一组绑到 endedAt=1000 那条", m.get(1)?.endedAt, 1000);
  eq("第二组绑到 endedAt=2000 那条", m.get(2)?.endedAt, 2000);

  // 时间戳差得远(>30s)→ 宁可不显示,也不绑错的数。
  const m2 = matchUsageRecords([groups[0]!], [rec(9_999_999)]);
  eq("时间戳对不上 → 不绑(宁可没有,不给错的数)", m2.size, 0);

  // 历史比回合多:从**尾部**对齐 —— 每个回合对到"末尾那几条"里对应的那条,
  // 而**能不能绑**还要看时间戳差(窗口 30s)。
  //   turn1↔rec[1](2000, 差 1000ms → 窗口内,绑上)
  //   turn2↔rec[2](999999, 差太远 → 不绑,宁可空着)
  const m3 = matchUsageRecords(groups, [rec(1000), rec(2000), rec(999_999)]);
  eq("历史多一条时:turn1 按尾对齐绑到 rec[1]", m3.get(1)?.endedAt, 2000);
  eq("…turn2 对到 rec[2] 但时间差 >30s → 不绑", m3.has(2), false);
}

/* 3c. buildFlowRows — 同一 assistant 消息里的 tool_use 合成一个并行行 */
{
  const m1 = msg("assistant", [text("先说一句"), toolUse("t1", "Read"), toolUse("t2", "Grep"), text("再说一句")]);
  const rows = buildFlowRows([m1]);
  eq("四个块 → 三行(两个工具合成一行)", rows.length, 3);
  eq("第一行是那句文本(单)", rows[0]!.parallel, false);
  eq("第二行是两个工具(并行)", rows[1]!.parallel, true);
  eq("并行行里两步", rows[1]!.steps.length, 2);
  eq("第三步的 batchIndex 是 1", rows[1]!.steps[1]!.batchIndex, 1);
  eq("第三步的 batchTotal 是 2", rows[1]!.steps[1]!.batchTotal, 2);
  eq("最后一行又是单的文本", rows[2]!.parallel, false);

  // 单独一个工具 → 不标并行。
  const rows2 = buildFlowRows([msg("assistant", [toolUse("t9", "Read")])]);
  eq("只有一个工具时不标并行", rows2[0]!.parallel, false);
  eq("…它的 batchTotal 是 1", rows2[0]!.steps[0]!.batchTotal, 1);
}

/* 3d. 工具分类 */
{
  eq("Read → read", toolCategory("Read"), "read");
  eq("Write → write", toolCategory("Write"), "write");
  eq("Grep → search", toolCategory("Grep"), "search");
  eq("Bash → terminal", toolCategory("Bash"), "terminal");
  eq("Task → subagent", toolCategory("Task"), "subagent");
  eq("mcp__ 前缀 → web", toolCategory("mcp__foo__bar"), "web");
  eq("不认识的 → other", toolCategory("SomethingWeird"), "other");
  eq("Pi 小写别名:read → read", toolCategory("read"), "read");
}

/* 3e. stepAccent — 该被注意到的两步 */
{
  eq("error 块是 danger", stepAccent(B({ kind: "error", message: "x" })), "danger");
  eq("提问工具是 attention", stepAccent(toolUse("t", "AskUserQuestion")), "attention");
  eq("ExitPlanMode 是 attention", stepAccent(toolUse("t", "ExitPlanMode")), "attention");
  eq("普通工具没有 accent", stepAccent(toolUse("t", "Read")), null);
  eq("普通文本没有 accent", stepAccent(text("hi")), null);
}

/* 3f. countActions — 几种工具各归各的桶 */
{
  const c = countActions([
    text("x"),
    toolUse("1", "Read"),
    toolUse("2", "Write"),
    toolUse("3", "AskUserQuestion"),
    toolUse("4", "Task"),
    toolUse("5", "EnterPlanMode"),
    B({ kind: "thinking", text: "想" }),
  ]);
  eq("普通工具数 2(Read/Write)", c.tools, 2);
  eq("提问数 1", c.questions, 1);
  eq("子代理数 1", c.subagents, 1);
  eq("thinking 数 1", c.thinking, 1);
  check("计划工具**不进** tools 桶", c.tools === 2, c);
}

/* 3g. userMessagePreview / turnFilesTotals / imageCountsByToolCall */
{
  const p = userMessagePreview({
    ...msg("user", [B({ kind: "image", dataUrl: "d", mime: "image/png" }), text("  正文  "), text("第二段")]),
  });
  eq("预览取第一段非空文本并 trim", p.text, "正文");
  eq("附件(图)数 1", p.attachments, 1);

  const totals = turnFilesTotals([
    B({ kind: "turn-files", files: [{ filePath: "a.ts", adds: 3, dels: 1 }] }),
    B({ kind: "turn-files", files: [{ filePath: "b.ts", adds: 2, dels: 5 }, { filePath: "c.ts", adds: 0, dels: 0 }] }),
  ]);
  eq("文件数 3", totals.files, 3);
  eq("+ 总数 5", totals.adds, 5);
  eq("- 总数 6", totals.dels, 6);

  const imgs = imageCountsByToolCall([
    B({ kind: "image", toolCallId: "t1" }),
    B({ kind: "image", toolCallId: "t1" }),
    B({ kind: "image", toolCallId: "t2" }),
    B({ kind: "image" }),
  ]);
  eq("t1 有两张", imgs.get("t1"), 2);
  eq("t2 有一张", imgs.get("t2"), 1);
  eq("没有 toolCallId 的不计数", imgs.size, 2);
}

/* 3h. 用量派生 */
{
  const r = {
    endedAt: 1,
    durationMs: 1,
    totalProcessedTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
  } as TurnUsageRecord;
  eq("输入 = 总 - 输出 - 缓存读 - 缓存写 = 200", usageInputTokens(r), 200);
  const rate = cacheHitRate(r);
  check("缓存命中率 = 500 / (1000-200) = 0.625", rate !== null && Math.abs(rate - 0.625) < 1e-9, rate);
  const noInput = { ...r, totalProcessedTokens: 200, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 } as TurnUsageRecord;
  eq("没有输入侧 token → 命中率 null(不编一个 0)", cacheHitRate(noInput), null);
}

/* 3i. 格式化 */
{
  eq("时长 <1 分钟:12s", fmtDuration(12_000), "12s");
  eq("时长 63s:1m 03s", fmtDuration(63_000), "1m 03s");
  eq("时长 1h2m:1h 02m", fmtDuration(3_720_000), "1h 02m");
  const d = new Date(2026, 0, 2, 9, 5);
  eq("时钟:补零成 09:05", fmtClockTime(d.getTime()), "09:05");
}

/* 3j. 常量集合防漂移 */
{
  check("AskUserQuestion 是问题工具", QUESTION_TOOLS.has("AskUserQuestion"), [...QUESTION_TOOLS]);
  check("Task 是子代理工具", SUBAGENT_TOOLS.has("Task"), [...SUBAGENT_TOOLS]);
  check("两个计划模式工具都在", PLAN_TOOLS.has("EnterPlanMode") && PLAN_TOOLS.has("ExitPlanMode"), [...PLAN_TOOLS]);
}

/* ─────────────────────── 4. editorNav（LRU 光标表） ─────────────────────── */

section("4. 编辑器导航:每文件的光标 LRU");

{
  // 用了哪个文件就提到队尾:常来常往的不该被一次大范围浏览挤掉。
  setLastCursor("a.ts", { line: 1, column: 1 });
  setLastCursor("b.ts", { line: 2, column: 2 });
  eq("存进去能读回来", getLastCursor("b.ts")?.line, 2);
  eq("没存过的读回 undefined", getLastCursor("never.ts"), undefined);

  // 覆盖写:同一个文件再设一次,读到的是新值。
  setLastCursor("a.ts", { line: 9, column: 9 });
  eq("再次写入覆盖旧值", getLastCursor("a.ts")?.line, 9);

  // 封顶 200:塞 250 个不同的文件,最早的应当被挤掉。
  for (let i = 0; i < 250; i++) setLastCursor(`f${i}.ts`, { line: i, column: 0 });
  eq("最早那批被 LRU 挤掉了(a.ts 已不在)", getLastCursor("a.ts"), undefined);
  eq("最近写入的还在(f249)", getLastCursor("f249.ts")?.line, 249);

  // ★ **读也提位**:先塞满 200 条(x0..x199,插入序),读一次最旧的 x0 把它提到队尾,
  //    再塞一条新的 x200 —— 该被挤掉的是 x1(现在的队头),不是刚读过的 x0。
  let k = 0;
  const KEYS: string[] = [];
  for (; k < 200; k++) {
    const key = `x${k}.ts`;
    KEYS.push(key);
    setLastCursor(key, { line: k, column: 0 });
  }
  getLastCursor(KEYS[0]!); // 读 x0 → 提到队尾
  setLastCursor("x200.ts", { line: 200, column: 0 }); // 这一下挤掉队头
  check("★ 读过的 x0 被提到队尾,没被挤掉", getLastCursor(KEYS[0]!) !== undefined, "x0 应保留");
  eq("★ 该被挤掉的是它后面那个 x1", getLastCursor(KEYS[1]!), undefined);
}

/* ─────────────────────── 5. markdownCache（哈希 + LRU） ─────────────────────── */

section("5. markdown 缓存:FNV-1a 哈希与 LRU 双限淘汰");

{
  // 哈希:确定性、定长 8 位 hex;内容变一位哈希就得变(否则缓存串味)。
  eq("哈希定长 8 位", fnv1a("hello").length, 8);
  check("同内容同哈希", fnv1a("abc") === fnv1a("abc"), fnv1a("abc"));
  check("改一个字符 → 哈希变", fnv1a("abc") !== fnv1a("abd"), [fnv1a("abc"), fnv1a("abd")]);
  eq("空串也有值(不是空串)", fnv1a("").length, 8);

  // **缓存键含主题** —— 换主题要作废旧 HTML,否则 shiki 会拿旧配色的 HTML 当新的渲染。
  check(
    "★ 同一段代码、换主题 → 键不同",
    codeCacheKey("x=1", "ts", "dark") !== codeCacheKey("x=1", "ts", "light"),
    "主题变了键必须变",
  );
  check("同代码同语言同主题 → 键相同", codeCacheKey("x=1", "ts", "dark") === codeCacheKey("x=1", "ts", "dark"));
  check("换语言 → 键不同", codeCacheKey("x=1", "ts", "dark") !== codeCacheKey("x=1", "py", "dark"));
}

{
  // LRU:计数上限淘汰最久未用的。
  const c = new LRUCache<{ byteSize: () => number; v: string }>(3, Infinity);
  const mk = (v: string) => ({ byteSize: () => 1, v });
  c.set("a", mk("A"));
  c.set("b", mk("B"));
  c.set("c", mk("C"));
  eq("三条都在", c.size, 3);
  // 读一下 a → 它变成最近使用;再塞 d,被淘汰的应是 b(而不是刚读过的 a)。
  eq("读到 a", c.get("a")?.v, "A");
  c.set("d", mk("D"));
  eq("超上限后 size 仍为 3", c.size, 3);
  check("★ 刚读过的 a 还在", c.has("a"), "a 应保留");
  check("★ 被淘汰的是最久未用的 b", !c.has("b"), "b 应被淘汰");
}

{
  // 字节上限(软限):按值的大小淘汰,而不是条数。
  const c = new LRUCache<CachedString>(100, 10);
  c.set("k1", new CachedString("12345")); // 5 bytes
  c.set("k2", new CachedString("67890")); // 5 bytes → 共 10,刚好
  eq("刚好压线时两条都在", c.size, 2);
  c.set("k3", new CachedString("x")); // 再加 1 → 超 10,淘汰队尾
  check("★ 超字节上限 → 淘汰最久未用的", !c.has("k1"), "k1 应被淘汰");
  eq("剩下的条数", c.size, 2);

  // 覆写同一个键:**不该把旧值的字节重复计入**。
  const c2 = new LRUCache<CachedString>(100, 1000);
  c2.set("k", new CachedString("12345"));
  eq("覆写前字节 = 5", c2.totalBytes, 5);
  c2.set("k", new CachedString("1234567890"));
  eq("★ 覆写后字节是新值的(没有把旧的叠上去)", c2.totalBytes, 10);
  eq("覆写不新增条目", c2.size, 1);

  // clear
  c2.clear();
  eq("clear 后归零", c2.size, 0);
  eq("clear 后字节归零", c2.totalBytes, 0);
}

/* ────────────────── 6. htmlTable（围栏保护 + 早退，无 DOM） ────────────────── */

section("6. HTML 表格转换:围栏里的代码**不许被改写**");

{
  // 没有 `<table` 时原样返回(不做任何解析)。
  eq("无表格 → 原样返回", convertHtmlTables("# 标题\n\n正文"), "# 标题\n\n正文");

  // ★ 核心:**围栏代码块里的 `<table>` 不被转换** —— 否则一篇讲 HTML 的笔记里那段
  //   示例代码会被就地改写(那是"好心帮倒忙")。这条不碰 DOMParser:围栏段整段跳过。
  const fenced = "```html\n<table><tr><td>a</td></tr></table>\n```";
  eq("★ 围栏里的 HTML 表格原样保留", convertHtmlTables(fenced), fenced);

  // 波浪号围栏同样保护。
  const tilde = "~~~\n<table><tr><td>x</td></tr></table>\n~~~";
  eq("波浪号围栏也保护", convertHtmlTables(tilde), tilde);
}

/* ──────────── 7. ideDirty：未保存文件不在"关闭"里被静默丢掉 ──────────── */

section("7. ideDirty:关闭守卫(未保存的标签不许被关掉)");

{
  // 真值表:一批里哪些脏、哪些干净。
  const dirty = new Set(["/p/b.ts", "/p/d.ts"]);
  const isDirty = (p: string) => dirty.has(p);

  const r1 = partitionClosable(["/p/a.ts", "/p/b.ts", "/p/c.ts"], isDirty);
  eq("干净的照关", r1.closed.join(","), "/p/a.ts,/p/c.ts");
  eq("脏的被拦下", r1.blocked.join(","), "/p/b.ts");

  const r2 = partitionClosable(["/p/a.ts", "/p/c.ts"], isDirty);
  eq("全干净时没人被拦", r2.blocked.length, 0);
  eq("全干净时都关掉", r2.closed.length, 2);

  const r3 = partitionClosable(["/p/b.ts", "/p/d.ts"], isDirty);
  eq("全脏时一个都不关", r3.closed.length, 0);
  eq("全脏时全数拦下", r3.blocked.length, 2);

  eq("空请求 → 空结果", partitionClosable([], isDirty).closed.length, 0);

  // ★ force:文件已经不在了(删除路径)。那时"未保存"没有意义,必须放行 ——
  //   否则删掉一个正在编辑的文件后,它的标签会永远留在标签栏上指向空气。
  const r4 = partitionClosable(["/p/b.ts", "/p/d.ts"], isDirty, true);
  eq("★ force 时脏文件也照关", r4.closed.join(","), "/p/b.ts,/p/d.ts");
  eq("★ force 时无人被拦", r4.blocked.length, 0);
}

{
  // 登记表本身:同一文件重复置脏只通知一次(避免每次击键都换快照重渲染)。
  const seen: number[] = [];
  const unsub = ideDirtyTracker.subscribe(() => seen.push(1));
  ideDirtyTracker.set("/p/x.ts", true);
  ideDirtyTracker.set("/p/x.ts", true); // 已经是脏 → 不该再通知
  eq("重复置脏只通知一次", seen.length, 1);
  eq("has 反映当前状态", ideDirtyTracker.has("/p/x.ts"), true);
  ideDirtyTracker.set("/p/x.ts", false);
  eq("清脏后再通知一次", seen.length, 2);
  eq("清脏后 has 为假", ideDirtyTracker.has("/p/x.ts"), false);
  // 快照必须是新引用(useSyncExternalStore 靠 Object.is 判变化)。
  const snapA = ideDirtyTracker.snapshot();
  ideDirtyTracker.set("/p/y.ts", true);
  const snapB = ideDirtyTracker.snapshot();
  check("★ 变更后快照换新引用", snapA !== snapB, "同一引用会让重渲染迟到");
  eq("新快照含新条目", snapB.has("/p/y.ts"), true);
  eq("旧快照不变", snapA.has("/p/y.ts"), false);
  unsub();
  ideDirtyTracker.set("/p/y.ts", false);
}

/* ──────────── 8. path.isPathWithin:项目根包含性(分隔符无关) ──────────── */

section("8. path.isPathWithin:分隔符无关 + Windows 大小写");

{
  // ★ 核心:项目根来自 OS 目录选择器,**Windows 上是反斜杠**(`D:\proj`),
  //   而 LSP / 文件树 / 命令面板给出的路径也是反斜杠。旧实现只给 root 尾部补一个
  //   `/` 再 startsWith,于是 `D:\proj` 对 `D:\proj\src\a.ts` 判 false —— 水合时把
  //   **每一个** IDE 打开标签 / 展开目录都当成"不在项目里"丢掉。这条钉住它。
  const BS = "\\";
  const winRoot = "D:" + BS + "proj";
  check("★ Windows 反斜杠根:文件在项目里", isPathWithin(winRoot, "D:" + BS + "proj" + BS + "src" + BS + "a.ts"));
  check("★ Windows 反斜杠根:目录在项目里", isPathWithin(winRoot, "D:" + BS + "proj" + BS + "src"));
  eq("Windows 反斜杠根:根自身算在里", isPathWithin(winRoot, winRoot), true);
  check("分隔符混用也算在里(主进程按分隔符无关比较)", isPathWithin(winRoot, "D:/proj/src/a.ts"));
  eq("同级前缀目录**不**算在里", isPathWithin(winRoot, "D:" + BS + "project-evil" + BS + "x.ts"), false);
  eq("项目外绝对路径不算在里", isPathWithin(winRoot, "C:" + BS + "other" + BS + "x.ts"), false);
  eq("★ 盘符大小写不同也算在里(main 的 norm 会 lowercase)", isPathWithin("d:" + BS + "proj", "D:" + BS + "proj" + BS + "a.ts"), true);

  // POSIX:区分大小写(与主进程的 Linux 语义一致),分隔符只有 `/`。
  eq("POSIX 根:文件在项目里", isPathWithin("/home/u/proj", "/home/u/proj/src/a.ts"), true);
  eq("POSIX 根:同级前缀不算在里", isPathWithin("/home/u/proj", "/home/u/project-evil/x.ts"), false);
  eq("POSIX 根:大小写不同**不**成立(Linux 大小写敏感)", isPathWithin("/Home/u/proj", "/home/u/proj/a.ts"), false);
  eq("正斜杠 Windows 根:仍然算在里", isPathWithin("D:/proj", "D:/proj/src/a.ts"), true);
  eq("尾部多余分隔符的根也认", isPathWithin("D:/proj/", "D:/proj/src/a.ts"), true);
  eq("空根一律拒绝(拒绝优先于放行)", isPathWithin("", "/x/y.ts"), false);
}

/* ──────────── 9. commands:右栏类命令必须把右栏打开 ──────────── */

section("9. 命令:右栏类动作都得把右栏露出来");

{
  // 兄弟命令(`view.right-panel.files` / `.git` / `.turns`)都是"切 tab + 打开右栏"。
  // `layout.toggle-browser` 只切了 tab、**没调 setRightOpen(true)** —— 右栏关着时按
  // 快捷键 / 命令面板选它,右栏仍关着,用户看不到浏览器面板(以为按键坏了)。
  const run = (id: string, initial: Partial<SessionState>) => {
    const calls: string[] = [];
    const state = {
      locale: "zh",
      activeProjectId: "p1",
      sessionsByProject: {},
      // 这些 setter 是命令真正会调的那几个;其余用不到。
      setRightPanelTab: (t: string) => calls.push(`tab:${t}`),
      setRightOpen: (b: boolean) => calls.push(`open:${b}`),
      ...initial,
    } as unknown as SessionState;
    const cmd = collectCommands(state).find((c) => c.id === id);
    if (!cmd) throw new Error(`command ${id} not found`);
    cmd.perform(state);
    return calls;
  };

  // ★ 右栏关着 + 停在别的 tab → 切到 browser,**而且要打开右栏**。
  const closed = run("layout.toggle-browser", { rightOpen: false, rightPanelTab: "files" } as Partial<SessionState>);
  check("右栏关着切到 browser:切了 tab", closed.includes("tab:browser"), closed);
  check("★ 右栏关着切到 browser:右栏被打开", closed.includes("open:true"), closed);

  // 右栏开着、已经停在 browser → 退回 files(不重复 setRightOpen(true),无妨)。
  const back = run("layout.toggle-browser", { rightOpen: true, rightPanelTab: "browser" } as Partial<SessionState>);
  check("已停在 browser 时退到 files", back.includes("tab:files"), back);

  // 兄弟命令的正控:它们本来就打开右栏,别被这次改动带偏。
  for (const [id, tab] of [["view.right-panel.files", "files"], ["view.right-panel.git", "git"], ["view.right-panel.turns", "turns"]] as const) {
    const c = run(id, { rightOpen: false, rightPanelTab: "files" } as Partial<SessionState>);
    check(`正控 ${id}:切到 ${tab} 且打开右栏`, c.includes(`tab:${tab}`) && c.includes("open:true"), c);
  }
}

console.log(`\nrenderer-pure-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;