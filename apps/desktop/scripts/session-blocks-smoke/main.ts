/**
 * 会话消息列表**块级改写**的回归网（`renderer/stores/sessionStoreBlocks.ts`）。
 *
 * ## 为什么要有这一套
 *
 * 这个文件整体是从 `sessionStoreHelpers.ts` 拆出来的一整段纯函数：拿
 * `ChatMessage[]`，插入 / 改写 / 裁剪某一类**块**（计划块、回本文件块、回合卡、
 * 工作流节点卡、delta 分段），返回新数组。拆之前它在 `scripts/` 下的断言里
 * **一次都没出现过** —— `upsertLivePlanBlock` / `appendTurnCardBlock` /
 * `capNodeArchives` / `demotePreviousLatestTurnFiles` / `findOpenTurnTrailingAssistant`
 * 五个名字 grep 遍全部套件，零命中。于是这些函数算错只能靠人眼看长对话，
 * 而长对话正好是人看不完的那种。
 *
 * ## 判据立在哪
 *
 * 立在**用户看得见的东西**上：卡片插在第几条、有没有多出一张、原引用有没有被换掉
 * （换掉就等于整段列表重渲染）、空草稿会不会留下一张 0 字的空卡。
 *
 * ## 无头
 *
 * 被测文件的所有 import 都是 `import type`（编译期擦除），所以打包出来就是这几个
 * 纯函数，不起 Electron、不碰 store、不碰 DOM。
 *
 * Run: scripts/session-blocks-smoke/run.sh
 */
import {
  appendDelta,
  appendTurnCardBlock,
  capNodeArchives,
  demotePreviousLatestTurnFiles,
  findOpenTurnLastAssistant,
  findOpenTurnTrailingAssistant,
  freezeLatestTurnFilesBlock,
  freezeOrPrunePlanBlocks,
  LIVE_FILES_ID,
  LIVE_PLAN_ID,
  patchWorkflowNodeProgressBlock,
  removeLivePlanBlock,
  removeWorkflowNodeProgressBlock,
  upsertLivePlanBlock,
  upsertLiveTurnFilesBlock,
} from "../../src/renderer/stores/sessionStoreBlocks.js";
import type { Block, ChatMessage } from "../../src/renderer/stores/sessionStoreTypes.js";
// `DeltaEntry` 定义在 sessionStore.ts（delta 缓冲那一段），`TurnFileEntry` 从契约再导出。
import type { DeltaEntry } from "../../src/renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@contracts/runtime";

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

/* ── 造消息的夹具 ───────────────────────────────────────────────────── */

type PlanPhase = Extract<Block, { kind: "plan" }>["phase"];

let seq = 0;
function resetSeq(): void {
  seq = 0;
}

/** 一条助手消息。`endedAt` 给了就带 turnMeta（= 一个已经收场的回合的开头）。 */
function assistant(blocks: Block[], opts: { endedAt?: number; startedAt?: number; model?: string } = {}): ChatMessage {
  seq += 1;
  return {
    id: `a${seq}`,
    sessionId: "s1",
    role: "assistant",
    blocks,
    createdAt: seq,
    ...(opts.endedAt !== undefined || opts.startedAt !== undefined
      ? { turnMeta: { startedAt: opts.startedAt ?? opts.endedAt ?? 0, ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}), ...(opts.model ? { model: opts.model } : {}) } }
      : {}),
  };
}

function user(text: string): ChatMessage {
  seq += 1;
  return {
    id: `u${seq}`,
    sessionId: "s1",
    role: "user",
    blocks: [{ kind: "text", text }],
    createdAt: seq,
  };
}

function planBlock(plan: string, phase: PlanPhase): Block {
  return { kind: "plan", planId: LIVE_PLAN_ID, plan, phase };
}

function filesBlock(files: TurnFileEntry[], isLatestTurn = true, filesId = LIVE_FILES_ID): Block {
  return { kind: "turn-files", filesId, files, isLatestTurn } as Block;
}

function tf(path: string, adds: number, dels: number): TurnFileEntry {
  return { filePath: path, kind: "modified", adds, dels, before: "" };
}

/** 取出某条消息上的全部块（找不到消息就是空数组）。 */
function blocksOf(messages: ChatMessage[], id: string): Block[] {
  return (messages ?? []).find((m) => m.id === id)?.blocks ?? [];
}

/* ══ §1 `findOpenTurnTrailingAssistant` / `findOpenTurnLastAssistant` ══ */

console.log("\n[§1] 找「当前这一轮」的锚点消息");
{
  const closed = assistant([{ kind: "text", text: "上一轮" }], { endedAt: 100 });
  const open = assistant([{ kind: "text", text: "这一轮" }], { startedAt: 200 });
  const list = [user("问"), closed, open];

  eq("开着的那一轮认到它自己", findOpenTurnTrailingAssistant(list), 2);
  eq("没有开着的回合时返回 -1", findOpenTurnTrailingAssistant([user("问"), closed]), -1);

  // findOpenTurnLastAssistant：开着的回合后面还有同回合的后续消息时，认**最后**那条。
  const later = assistant([{ kind: "text", text: "后续叙述" }]); // 无 turnMeta
  const list2 = [user("问"), open, later];
  eq("同回合的后续消息没有 turnMeta，锚点仍是回合开头", findOpenTurnTrailingAssistant(list2), 1);
  eq("「最后一条助手消息」认到真正的最后一条（工具要追加在它后面）", findOpenTurnLastAssistant(list2), 2);
  eq("回合里只有开头那一条时，两者指同一条", findOpenTurnLastAssistant(list), 2);
  eq("没有开着回合时，最后一个也是 -1", findOpenTurnLastAssistant([user("问"), closed]), -1);
}

/* ══ §2 `upsertLivePlanBlock` ══════════════════════════════════════ */

console.log("\n[§2] 计划块的 upsert / 清空 / 空草稿");
{
  const open = assistant([], { startedAt: 10 });
  const base = [user("问"), open];

  // 2a 第一次插入：挂在开着那一轮的助手消息上，不新开消息。
  const one = upsertLivePlanBlock(base, "# 计划一", "drafting", false);
  eq("第一次 upsert 不新增消息（挂在已有回合上）", one.length, 2);
  eq("计划块插到了那条助手消息上", blocksOf(one, open.id).length, 1);
  eq("块带着 planId=current（下次 upsert 靠它认出来）", (blocksOf(one, open.id)[0] as { planId: string }).planId, LIVE_PLAN_ID);

  // 2b 第二次 upsert：**换掉**那一张，不是再插一张。
  const two = upsertLivePlanBlock(one, "# 计划二（改过）", "drafting", false);
  eq("再 upsert 一次不会多出一张卡", blocksOf(two, open.id).length, 1);
  eq("换上去的是新内容", (blocksOf(two, open.id)[0] as { plan: string }).plan, "# 计划二（改过）");

  // 2c 空草稿（EnterPlanMode 的占位 plan:""）等于"清掉"，不留 0 字空卡。
  const empty = upsertLivePlanBlock(two, "   \n  ", "drafting", false);
  eq("空草稿不画空卡（等于清掉）", blocksOf(empty, open.id).length, 0);

  // 2d phase "cleared" 走 remove 那条路。
  const cleared = upsertLivePlanBlock(two, "# 计划二（改过）", "cleared", false);
  eq("cleared 相位把活块摘掉", blocksOf(cleared, open.id).length, 0);

  // 2e 只有计划块的助手消息，摘掉之后整条消息也要消失（不留空行）。
  const planOnly = [user("问"), assistant([], { startedAt: 10 })];
  const withPlan = upsertLivePlanBlock(planOnly, "# 只有计划", "drafting", false);
  eq("先确认插上了", blocksOf(withPlan, withPlan[1].id).length, 1);
  const removed = removeLivePlanBlock(withPlan);
  eq("计划块是这条消息唯一的块 → 摘掉后整条消息不见", removed.length, 1);
  eq("留下的是用户那条", removed[0].role, "user");

  // 2f 计划卡要排在"本轮修改文件"卡**上面**（事件到达顺序反过来时也要）。
  const withFiles = [user("问"), assistant([filesBlock([tf("a.ts", 1, 0)])], { startedAt: 10 })];
  const ordered = upsertLivePlanBlock(withFiles, "# 计划", "ready", false);
  const kinds = blocksOf(ordered, withFiles[1].id).map((b) => b.kind);
  eq("计划卡排在文件卡前面", kinds.join(","), "plan,turn-files");

  // 2g 没有开着回合时新开一条，并带上发送时刻的锚（计时与"开始 · 用时"连续）。
  const newTurn = upsertLivePlanBlock([user("问")], "# 计划", "ready", false, 777, "m-x");
  eq("没有开着回合时才新开一条助手消息", newTurn.length, 2);
  eq("新开的这条带 turnMeta.startedAt = 发送锚", newTurn[1].turnMeta?.startedAt, 777);
  eq("并带上模型锚", newTurn[1].turnMeta?.model, "m-x");
}

/* ══ §3 计划块的冻结 / 剪枝 ═══════════════════════════════════════ */

console.log("\n[§3] 回合收场：核准的计划留住，草稿清掉");
{
  // 每一段自己造夹具、自己记 id —— 不靠「第几条是第几条」这种手数出来的序号
  // （上面几段的 `assistant()` 调用会把全局编号推着走，手数必错）。
  resetSeq();
  const closed = assistant([planBlock("# 上一轮定稿", "ready")], { endedAt: 100 });
  const draftMsg = assistant([planBlock("# 半截草稿", "drafting")], { endedAt: 501 });
  const readyMsg = assistant([planBlock("# 定稿", "ready")], { endedAt: 500 });
  const list = [user("问"), closed, user("又问"), draftMsg, readyMsg];

  const frozen = freezeOrPrunePlanBlocks(list, 500);
  eq("核准的计划卡留着（历史里还能翻到）", blocksOf(frozen, readyMsg.id).length, 1);
  eq("上一轮的卡不受影响（按 endedAt 只碰这一轮）", blocksOf(frozen, closed.id).length, 1);
  // 草稿那一轮是另一个 endedAt，得拿它自己的收场时刻来调
  const closedDraft = freezeOrPrunePlanBlocks(list, 501);
  eq("收场时还是草稿的 → 清掉", closedDraft.some((m) => m.id === draftMsg.id), false);

  // 只有计划块的助手消息，剪枝后要整条消失。
  const kept = freezeOrPrunePlanBlocks([user("问"), readyMsg], 500);
  eq("核准的留着 → 消息也留着", kept.length, 2);
  const pruned = freezeOrPrunePlanBlocks([user("问"), draftMsg], 501);
  eq("草稿被剪 → 只剩用户那条（不留空行）", pruned.length, 1);
  eq("留下的是用户那条", pruned[0].role, "user");
  // 剪枝只碰 endedAt 对得上的那一轮：别的轮次原样留着
  const otherTurn = freezeOrPrunePlanBlocks(list, 501);
  eq("只剪 endedAt 对得上的那一轮", otherTurn.map((m) => m.id).join(","),
     [list[0].id, closed.id, list[2].id, readyMsg.id].join(","));
}

/* ══ §4 回本文件块 ════════════════════════════════════════════════ */

console.log("\n[§4] 「本轮修改文件」卡：净零过滤 + 最新一轮的标记");
{
  resetSeq();
  const open = assistant([], { startedAt: 10 });
  const base = [user("问"), open];

  // 4a 增删都是 0 的文件是噪声（旧数据源可能带进来），不画。
  const noisy = upsertLiveTurnFilesBlock(base, [tf("a.ts", 3, 1), tf("b.ts", 0, 0)]);
  const shown = blocksOf(noisy, open.id)[0] as { files: TurnFileEntry[] };
  eq("净零的文件不上卡", shown.files.length, 1);
  eq("留下的是真改了那个", shown.files[0].filePath, "a.ts");

  // 4b 全是净零 → 整张卡不出现（连消息都不动）。
  const allNoise = upsertLiveTurnFilesBlock(base, [tf("c.ts", 0, 0)]);
  eq("全是净零 → 返回原引用（调用方靠它跳过重渲染）", allNoise, base);

  // 4c 再 upsert 一次换掉卡片内容，不多插一张。
  const two = upsertLiveTurnFilesBlock(noisy, [tf("a.ts", 9, 2)]);
  eq("重复 upsert 仍只有一张文件卡", blocksOf(two, open.id).length, 1);
  eq("卡片内容是新的增删数", (blocksOf(two, open.id)[0] as { files: TurnFileEntry[] }).files[0].adds, 9);

  // 4d 回合已经被本地停掉（没有开着回合）→ 挂到最近一条助手消息上，**不新开回合**。
  // 夹具要单独造一列：上面那几条 `assistant()` 调用都会推着全局编号走，
  // 直接数「第 1 条是助手」必错（这一列里 `[1]` 其实是上面留下的另一条）。
  const stopped = assistant([{ kind: "text", text: "被停掉那轮" }], { endedAt: 300 });
  const afterStop = upsertLiveTurnFilesBlock([user("问"), stopped], [tf("d.ts", 1, 1)]);
  eq("停掉那一轮：不新开消息（否则多出一行「开始 · 用时」的幽灵统计行）", afterStop.length, 2);
  eq("挂的确实是最新那条助手消息", afterStop[1].id, stopped.id);
  const stopFiles = blocksOf(afterStop, stopped.id).filter((b) => b.kind === "turn-files");
  eq("那条消息上多了一张文件卡", stopFiles.length, 1);
  eq("卡片仍标为最新一轮（可撤销）", (stopFiles[0] as { isLatestTurn?: boolean }).isLatestTurn, true);
}

/* ══ §5 最新一轮的升降 ═══════════════════════════════════════════ */

console.log("\n[§5] 只有最新那一轮的文件卡是可撤销的");
{
  resetSeq();
  const older = assistant([filesBlock([tf("a.ts", 1, 0)], true)], { endedAt: 100 });
  const newer = assistant([filesBlock([tf("b.ts", 1, 0)], true)], { endedAt: 200 });

  const demoted = demotePreviousLatestTurnFiles([user("问"), older, user("又问"), newer]);
  eq("降级把旧卡标成不可撤销", (blocksOf(demoted, older.id)[0] as { isLatestTurn?: boolean }).isLatestTurn, false);
  eq("新卡也降（调用方随后会把它自己那条标回来）", (blocksOf(demoted, newer.id)[0] as { isLatestTurn?: boolean }).isLatestTurn, false);

  // 没有卡需要降 → 返回原引用。
  const noCards = [user("问"), assistant([{ kind: "text", text: "x" }], { endedAt: 1 })];
  eq("没有卡可降时返回原引用", demotePreviousLatestTurnFiles(noCards), noCards);

  // 收场：只把这一轮（按 endedAt 认）的卡标回最新。
  const frozen = freezeLatestTurnFilesBlock([user("问"), older, user("又问"), newer], 200);
  eq("收场后这一轮的卡标回最新", (blocksOf(frozen, newer.id)[0] as { isLatestTurn?: boolean }).isLatestTurn, true);
  eq("早先那一轮仍是不可撤销", (blocksOf(frozen, older.id)[0] as { isLatestTurn?: boolean }).isLatestTurn, false);
  eq("按 endedAt 认轮次：条数不变（文件卡永远不剪）", frozen.length, 4);
}

/* ══ §6 归档封顶 `capNodeArchives` ═══════════════════════════════ */

console.log("\n[§6] 节点过程快照的封顶");
{
  resetSeq();
  const tr = (n: number): { kind: "text"; text: string }[] =>
    Array.from({ length: n }, () => ({ kind: "text" as const, text: "x" }));

  const nodeBlock = (transcript: unknown[]): Block =>
    ({ kind: "workflow-node-result", runId: "r", nodeId: "n", nodeType: "mcode.agent", title: "t", nodeTranscript: transcript }) as Block;

  // 6a 没超上限 → **原引用**（调用方靠它跳过重渲染）。
  const under = [user("问"), assistant([nodeBlock(tr(50))], { endedAt: 1 })];
  eq("没超上限时返回原数组（引用相等）", capNodeArchives(under), under);

  // 6b 超上限 → 丢掉**块数最多的那些**，保留最终顺序。
  const big = assistant([nodeBlock(tr(300))], { endedAt: 2 });
  const small1 = assistant([nodeBlock(tr(10))], { endedAt: 3 });
  const small2 = assistant([nodeBlock(tr(20))], { endedAt: 4 });
  const over = [user("问"), big, small1, small2];
  const capped = capNodeArchives(over);
  check("超上限时换了新数组", capped !== over);
  const transcriptOf = (list2: ChatMessage[], id: string): unknown[] | undefined => {
    const b = blocksOf(list2, id).find((x) => x.kind === "workflow-node-result");
    return (b as { nodeTranscript?: unknown[] } | undefined)?.nodeTranscript;
  };
  eq("卡片本身不删（一步一张卡是历史）", capped.length, over.length);
  eq("丢的是最大那张的过程快照", transcriptOf(capped, big.id), undefined);
  eq("小卡的过程快照照旧留着", transcriptOf(capped, small1.id)?.length, 10);
  eq("第二张小卡也留着", transcriptOf(capped, small2.id)?.length, 20);
  eq("消息顺序原样（不是重排，只是置空）", capped.map((m) => m.id).join(","), over.map((m) => m.id).join(","));

  // 6c 没有 nodeTranscript 的结果卡不算数（skipped / cancelled 的节点）。
  const plain = assistant([{ kind: "workflow-node-result", runId: "r", nodeId: "n", nodeType: "mcode.agent", title: "t" } as Block], { endedAt: 5 });
  const list3 = [user("问"), plain];
  eq("没有过程快照的卡不被计入、也不动数组", capNodeArchives(list3), list3);
}

/* ══ §7 工作流节点卡的替换 / 追加 ═══════════════════════════════ */

console.log("\n[§7] 工作流节点卡：同一格重跑换掉旧卡，不叠一张");
{
  resetSeq();
  const progress: Block = { kind: "workflow-node-progress", runId: "r1", nodeId: "n1", nodeType: "mcode.agent", title: "第一步" };
  const host = assistant([progress], { startedAt: 10 });
  const list = [user("问"), host];

  // 7a 同一 (runId, nodeId) 的第二轮 → 原地换，不加卡。
  const r2: Block = { kind: "workflow-node-progress", runId: "r1", nodeId: "n1", nodeType: "mcode.agent", title: "第一步（第 2 轮）", round: 2 } as Block;
  const patched = patchWorkflowNodeProgressBlock(list, r2 as Extract<Block, { kind: "workflow-node-progress" }>);
  eq("同一格重跑不叠卡", blocksOf(patched ?? [], host.id).length, 1);
  eq("卡换成了新一轮那张", (blocksOf(patched ?? [], host.id)[0] as { round?: number }).round, 2);

  // 7a2 找不到那一格时返回 null（调用方据此原样返回 state，不触发重渲染）。
  eq("那一格不在列表里 → 返回 null", patchWorkflowNodeProgressBlock(list, {
    kind: "workflow-node-progress", runId: "r9", nodeId: "n9", nodeType: "mcode.agent", title: "没这一步",
  }), null);

  // 7b 摘掉进度卡。**消息不删**（与 `removeLivePlanBlock` 不同）：这条路径的调用方
  // （`reduceWorkflowNodeChoice`）摘完之后紧接着往同一条消息上补一张分支选择卡，
  // 所以不存在留空行的问题 —— 这里把"只摘块、不删消息"钉住。
  const removed = removeWorkflowNodeProgressBlock(list, "r1", "n1");
  eq("进度卡被摘掉", blocksOf(removed, host.id).some((b) => b.kind === "workflow-node-progress"), false);
  eq("但消息本身留着（调用方马上会补一张分支选择卡上去）", removed.length, 2);
  eq("摘不掉不存在的那张时返回原引用", removeWorkflowNodeProgressBlock(list, "r9", "n9"), list);

  // 7c 追加回合卡：开着的回合就挂在它上面。
  const openHost = assistant([], { startedAt: 10 });
  const card: Block = { kind: "workflow-node-progress", runId: "r2", nodeId: "n2", nodeType: "mcode.agent", title: "第二步" };
  const appended = appendTurnCardBlock([user("问"), openHost], card, 10, "m1", "wfprogress");
  eq("挂在开着的回合上，不新开消息", appended.length, 2);
  eq("卡在这条消息末尾", blocksOf(appended, openHost.id).length, 1);

  // 7d 没有开着回合 → 新开一条**带 turnMeta** 的开头消息（不然它渲染不出"开始 · 用时"那一行）。
  const fresh = appendTurnCardBlock([user("问")], card, 4242, "m2", "wfprogress");
  eq("没有开着回合时新开一条", fresh.length, 2);
  eq("新开的带 startedAt 锚", fresh[1].turnMeta?.startedAt, 4242);
  eq("新开的带模型锚", fresh[1].turnMeta?.model, "m2");
  check("新开的 id 带上了调用方给的前缀（devtools 里能分清卡的种类）", fresh[1].id.startsWith("wfprogress_"));
}

/* ══ §8 delta 分段合并 ═══════════════════════════════════════════ */

console.log("\n[§8] 流式 delta 的分段合并");
{
  resetSeq();
  const entry: DeltaEntry = { sessionId: "s1", messageId: "m", segs: [] };

  appendDelta(entry, "text", "");
  eq("空串不进分段", entry.segs.length, 0);

  appendDelta(entry, "text", "你");
  appendDelta(entry, "text", "好");
  eq("同种连续块合并成一段", entry.segs.length, 1);
  eq("合并后的文本是接起来的", entry.segs[0].text, "你好");

  appendDelta(entry, "thinking", "想");
  appendDelta(entry, "text", "世界");
  eq("类型切换开新段（思考／正文各自成段）", entry.segs.length, 3);
  eq("切回来的正文是新的一段（不并回第一段）", entry.segs[2].text, "世界");
  eq("段的顺序保持原样", entry.segs.map((s) => s.k).join(","), "text,thinking,text");
}

console.log(`\nsession-blocks-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
