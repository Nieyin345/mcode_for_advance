/**
 * 【W21】**`mcode-agent` 的 `capability` 在 Node-RED 生产路径上真的生效** ——
 * 与 `mcode-node-pack-ports-smoke`(W19)验的是两件事:
 *
 *   - W19 把 `RuntimeManager` 换成桩,验「生产端口按约定调了它什么」;
 *   - 本套**保留真的 `RuntimeManager` + `ApprovalBridge`**,只把**引擎实现**换假,
 *     验「节点声明的 capability → 真的改变了这一轮工具调用的审批行为」。
 *
 * ## 本卡要证的命题
 *
 * 缺陷是:原生节点表单上有 `capability: "read" | "write"`,而生产端口
 * (`nodePackProductionPorts.ts` 的 `runSelectedSession`)过去从头到尾没读它。
 * 「字段存在」≠「字段生效」—— 所以断言不能停在「`setPermissionMode` 被调了」,
 * 那还是一个参数。**要断言的是派发之后,一个写类工具调用到底弹不弹审批。**
 *
 * 整条链在真身里跨四个模块,本套一个都不换:
 *
 *     productionNodePackServices().execute("agent.run")
 *       → runSelectedSession(读 capability,定 permissionMode)
 *       → runtimeManager.sendTurn(真的)
 *       → provider.startTurn(req, ctx)      ← 只有这一段是假的
 *       → ctx.getPermissionMode()           ← 真 ApprovalBridge 的 Map
 *       → shouldAutoApprove(mode, tool)     ← 真判据(`mcp/toolRules.ts`)
 *
 * 假 provider 的 `startTurn` 照 `ClaudeAgentSdkProvider` 的 canUseTool 做同一件事:
 * 先问「始终允许」,再读**此刻活的** permission mode,再问 `shouldAutoApprove`;
 * 需要审批就把 `ctx.requestApproval` 发出去等真桥结算。这样「`read` → 写工具弹审批」
 * 和「`write` → 写工具直接放行」都是**行为**,不是参数。
 *
 * ## 判据 import 真身(硬规矩:别在套件里抄一份)
 *
 * `permissionModeForCapability`(映射)与 `shouldAutoApprove`(放行表)都从**生产代码**
 * import。生产端口为了不把 provider 图拉进 Node-RED 子进程 bundle,自己留了一份
 * 五行的映射表(见那边注释)—— 本套第 0 节用真身去比那张表,**两边一旦漂移就红**,
 * 这样生产里那份副本有真身守着,不是第二份真相。
 *
 * ## 验不了的(明说,不冒充)
 *
 *   - 真三家 SDK 的 canUseTool:三家 provider 的实现各自不同,本套只验宿主这一侧的
 *     闸门(ApprovalBridge → shouldAutoApprove),那正是 `permissionMode` 生效的落点;
 *   - SDK 自己的 `Options.permissionMode` 是否被 CLI 采纳:Claude 那条把 UI 的 `plan`
 *     翻成 SDK 的 `default`(`ClaudeAgentSdkProvider.ts:534`),安全性靠的**就是**本套
 *     验的这道宿主闸门;
 *   - 真人点审批卡的视觉:无头环境给不出;
 *   - Pi / Codex 各自的 `shouldAutoApproveForPi` / `normalizeCodexMode`:模式值经同一条
 *     `getPermissionMode` 到达,但三家的消费判据不在本套覆盖内(`requiresApproval` 的
 *     最终形态由各家 SDK 决定)。
 *
 * Run: bash scripts/mcode-agent-capability-smoke/run.sh
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { productionNodePackServices } from "@main/workflowEngines/nodePackProductionPorts.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { permissionModeForCapability } from "@main/orchestration/runner.js";
import { shouldAutoApprove, FILE_EDIT_TOOLS } from "@main/mcp/toolRules.js";
import { providerRegistry } from "@main/providers/registry.js";
import type { AgentProvider, ProviderContext, StartTurnRequest, TurnHandle } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { WorkflowCapability } from "@contracts/workflow";

/* ── 断言助手(与仓库其它 smoke 同款) ── */
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
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── 会话夹具(真库) ── */
const PROJECT_PATH = "D:\\smoke\\capability-project";
const NOW = Date.now();
// ⚠️ 假的引擎**必须挂在 `claude-sdk` 这个名字下**:生产端口只放行三个原生引擎 id
// (`runSelectedSession` 的 provider 守卫),换别的 id 会在到达 provider 之前被拒 ——
// 那样测到的是守卫,不是 capability。真身那三家在 `run.sh` 里被换成「本桩不预注册」,
// 于是这个名字下**只有**这一个假实现。
const FAKE_ENGINE = "claude-sdk";
function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p_cap",
    providerId: FAKE_ENGINE,
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: "capability 冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    // 会话自己的模式故意**不是** plan/acceptEdits 的任何一端:
    // 它只当"没人覆盖时该沿用它"的基准,断言能一眼看出节点覆盖发生了。
    permissionMode: "default",
    workflowId: "",
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

await initDb();
ProjectRepo.create({
  id: "p_cap", name: "capability 冒烟项目", path: PROJECT_PATH, archived: false,
  group: null, sortOrder: 0, pinnedAt: null, createdAt: NOW, updatedAt: NOW,
});
SessionRepo.create(makeSession({ id: "s_chat" }));
// 用户自己的模式不是 default 的那条:会话行明确是 acceptEdits,节点却声明 read ——
// 必须被节点覆盖成 plan(否则「节点说只读、会话说随便改」时写保护形同虚设)。
SessionRepo.create(makeSession({ id: "s_chat_accept", permissionMode: "acceptEdits" }));
// 生产里会话是**先被用户用过**(发过消息 → `ipc/claude.ts` 那句 `bindSession`)再被节点
// 引用的:`sendTurn` 对未绑定的会话返回 null(「session busy」),而 `bindSession` 幂等、
// 会把落盘的模式播种进 ApprovalBridge。这里照生产摆:先绑,再跑节点。
// ⚠️ 这也是一条**发现**:端口自己从不 `bindSession`(未绑定时 fail-closed 报错,
// 不是安全洞,但"新建没用过的会话直接跑节点"会报 busy)—— 见结果回写第 6 项。
for (const id of ["s_chat", "s_chat_accept"]) {
  const row = SessionRepo.get(id);
  if (!row) throw new Error(`smoke: 夹具会话 ${id} 没建出来`);
  runtimeManager.bindSession(row);
}

/* ── 假 provider:只有这一段是假的 ──
 *
 * 照 `ClaudeAgentSdkProvider` canUseTool 的判定顺序:
 *   1. 「始终允许」→ 放行(不弹卡);
 *   2. 读**此刻活的** permission mode(真 ApprovalBridge);
 *   3. `shouldAutoApprove(mode, toolName)` → 放行;
 *   4. 否则走 `ctx.requestApproval`(真桥,会 emit `approval.request` 并等结算),
 *      结算为拒绝时把结果如实交回。
 * 每次工具判定都记一行「当时读到的 mode + 判据结果」,断言直接看它。
 */
interface ToolProbe {
  toolName: string;
  modeBefore: string | undefined;
  autoApproved: boolean;
  /** 是否弹了审批卡(requestApproval 被调到)。 */
  prompted: boolean;
  /** 用户(脚本)给的答复;没弹卡时为 null。 */
  decidedAllow: boolean | null;
}
const probes: ToolProbe[] = [];
const startRequests: StartTurnRequest[] = [];
/** 每次 startTurn 时 `req.permissionMode` 的原样记录(引擎侧那一份)。 */
const reqModes: Array<string | undefined> = [];
/** 脚本摆的:每一次工具判定之后,审批卡该被怎么答。默认 allow。 */
let approvalAnswer: (toolName: string) => boolean = () => true;
/** 脚本摆的:这一轮交回给端口的文本(分支模型选路要数字)。默认 "done"。 */
let replyText = "done";

providerRegistry.register({
  id: FAKE_ENGINE,
  displayName: "Capability smoke provider",
  capabilities: {
    supportsApproval: true,
    supportsResume: false,
    supportsStreaming: true,
    supportsMcp: false,
    supportsAskUserQuestion: false,
  },
  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    startRequests.push(req);
    reqModes.push(req.permissionMode);
    let running = true;
    const done = (async () => {
      // 一轮里逐个试一个写类工具和一个只读工具 —— 两条判定都发生在**同一轮**里,
      // 用的必须是这一刻的活模式,而不是 startTurn 入口的快照。
      const writeTool = [...FILE_EDIT_TOOLS][0] ?? "Write";
      for (const toolName of [writeTool]) {
        const always = ctx.isToolAlwaysAllowed?.(toolName) === true;
        const modeBefore = ctx.getPermissionMode?.();
        const autoApproved = always || shouldAutoApprove(modeBefore, toolName);
        let prompted = false;
        let decidedAllow: boolean | null = null;
        if (!autoApproved) {
          prompted = true;
          if (!ctx.requestApproval) throw new Error("smoke: 需要审批但 provider 没有 requestApproval 通道");
          const decision = await ctx.requestApproval({
            requestId: `req-${probes.length}`,
            toolName,
            input: { file_path: "D:\\smoke\\capability-project\\a.txt" },
            description: "smoke: 写类工具审批",
          });
          decidedAllow = decision.allow;
        }
        probes.push({ toolName, modeBefore, autoApproved, prompted, decidedAllow });
        ctx.emit({
          type: "tool.use", sessionId: req.sessionId, toolCallId: `t-${probes.length - 1}`,
          toolName, input: {}, requiresApproval: prompted,
        } as RuntimeEvent);
      }
      ctx.emit({ type: "text.delta", sessionId: req.sessionId, messageId: "m1", text: replyText } as RuntimeEvent);
      running = false;
      ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "end_turn" } as RuntimeEvent);
    })();
    return { done, interrupt: () => { running = false; }, isRunning: () => running };
  },
  async listCommands() {
    return { supported: false as const, commands: [] };
  },
} satisfies AgentProvider);

/* ── 桥的答复端:真的 RuntimeManager.resolveApproval ──
 *
 * 审批卡是 `approval.request` 事件;脚本订阅那条事件,按 `approvalAnswer` 调
 * `runtimeManager.resolveApproval`,和渲染端点按钮走**同一个**函数。
 */
const approvalEvents: Array<{ requestId: string; toolName: string; sessionId: string }> = [];
const unsubscribeApprovals = runtimeManager.subscribe((e) => {
  if (e.type !== "approval.request") return;
  approvalEvents.push({ requestId: e.requestId, toolName: e.toolName, sessionId: e.sessionId });
  // 下一拍再结算:让 emit 先把卡发出去(与真渲染端的往返同形)。
  setTimeout(() => {
    runtimeManager.resolveApproval(e.requestId, approvalAnswer(e.toolName));
  }, 0);
});

function resetTurnRecords(): void {
  probes.length = 0;
  startRequests.length = 0;
  reqModes.length = 0;
  approvalEvents.length = 0;
  approvalAnswer = () => true;
  replyText = "done";
}

/* 服务构造:与 `registry.ts` 的生产装配同一个调用形状。 */
const services = () => productionNodePackServices(
  () => ({ state: "running", port: 1880, reason: null, engineId: "node-red", instanceEpoch: "ep-1" }),
  "tok-smoke",
  undefined,
);
const runAgent = (extra: Record<string, unknown>) =>
  services().execute("agent.run", { params: { sessionId: "s_chat" }, instruction: "做点事", ...extra });

/* ═════════════════════════ 0. 真身映射与生产副本不许漂移 ═════════════════════════
 *
 * 生产端口为了不让 provider 图进 Node-RED 子进程 bundle,自己留了五行映射。
 * 这里用**真身** `permissionModeForCapability` 逐值比对 —— 生产里那张表由真身守着,
 * 不是第二份真相。漂移时这条先红,下面的行为断言才有意义。
 */
console.log("\n0 · 生产副本 vs 真身:capability → permissionMode 不许漂移");
{
  const expected = {
    read: permissionModeForCapability("read" as WorkflowCapability),
    write: permissionModeForCapability("write" as WorkflowCapability),
  };
  eq("真身:read → plan(不是禁止写,是写类工具弹审批)", expected.read, "plan");
  eq("真身:write → acceptEdits", expected.write, "acceptEdits");

  // 行为读数:同一个会话、两种 capability,看引擎侧收到的 req.permissionMode。
  resetTurnRecords();
  const r1 = await attempt(() => runAgent({ capability: "read" }));
  check("前置:read 那一轮跑通", r1.ok, { error: r1.ok ? undefined : r1.error });
  const readMode = reqModes[0];
  resetTurnRecords();
  const r2 = await attempt(() => runAgent({ capability: "write" }));
  check("前置:write 那一轮跑通", r2.ok, { error: r2.ok ? undefined : r2.error });
  const writeMode = reqModes[0];

  eq("★ 生产端口给 read 的就是真身给的那个模式", readMode, expected.read);
  eq("★ 生产端口给 write 的就是真身给的那个模式", writeMode, expected.write);
  // 反过来也要钉:生产端口**不是**对两个值都给同一个模式(否则上面两条里
  // 只要真身恰好等于那个唯一值就双双通过)。这一条与真身无关,是关系断言。
  check("★ read 与 write 落到的模式不同(不是恒返回同一个)", readMode !== writeMode, { readMode, writeMode });
}

/* ═════════════════════════ 1. read:写类工具 → 弹审批(不是拒绝) ═════════════════════════ */
console.log("\n1 · read:写类工具弹审批,用户批准后**真的跑了**");
{
  resetTurnRecords();
  approvalAnswer = () => true; // 用户点「允许」
  const result = await attempt(() => runAgent({ capability: "read" }));
  check("read 那一轮收口正常", result.ok, { error: result.ok ? undefined : result.error });

  eq("★ read:写类工具没有自动放行(shouldAutoApprove 为假)", probes[0]?.autoApproved, false);
  eq("★ read:写类工具**弹了审批卡**", probes[0]?.prompted, true);
  eq("★ read:引擎在判定工具的那一刻读到的模式是 plan", probes[0]?.modeBefore, "plan");
  eq("★ read:用户批准后决定是 allow —— 是「看得见」,不是「禁止」", probes[0]?.decidedAllow, true);
  eq("read:发出的审批卡恰好一张", approvalEvents.length, 1);

  // 与「硬拒绝」的区分:如果实现把它做成 deny,这一条会红。
  // 卡上明确要求 read **不是**「禁止写」而是「让写变得可见」。
  eq("★ read 不是硬拒绝:同一轮结束原因为 end_turn(没有因审批被掐断)", startRequests.length >= 1 && (result.ok), true);

  // 用户拒绝时,决定如实是 deny —— 闸门是「等人」,不是「自动放行」。
  resetTurnRecords();
  approvalAnswer = () => false;
  const denied = await attempt(() => runAgent({ capability: "read" }));
  check("read + 用户拒绝:那一轮仍能收口(拒绝是工具结果,不是崩溃)", denied.ok,
    { error: denied.ok ? undefined : denied.error });
  eq("★ read:用户拒绝时决定如实是 deny", probes[0]?.decidedAllow, false);
}

/* ═════════════════════════ 2. write:写类工具直接放行(正控) ═════════════════════════ */
console.log("\n2 · write:写类工具直接放行,不弹卡(正控 —— 否则「永远 plan」也能过第 1 节)");
{
  resetTurnRecords();
  const result = await attempt(() => runAgent({ capability: "write" }));
  check("write 那一轮收口正常", result.ok, { error: result.ok ? undefined : result.error });

  eq("★ write:写类工具被自动放行", probes[0]?.autoApproved, true);
  eq("★ write:没有弹审批卡", probes[0]?.prompted, false);
  eq("★ write:引擎读到的模式是 acceptEdits", probes[0]?.modeBefore, "acceptEdits");
  eq("write:一张审批卡都没发", approvalEvents.length, 0);
}

/* ═════════════════════════ 3. 节点覆盖会话行:会话说 acceptEdits,节点说 read ═════════════════════════ */
console.log("\n3 · 节点声明压过会话行:会话是 acceptEdits、节点是 read → 仍要弹审批");
{
  resetTurnRecords();
  const result = await attempt(() => services().execute("agent.run", {
    params: { sessionId: "s_chat_accept" }, instruction: "做点事", capability: "read",
  }));
  check("该轮收口正常", result.ok, { error: result.ok ? undefined : result.error });
  eq("★ 会话行是 acceptEdits,但节点 read 仍然让写类工具弹卡", probes[0]?.prompted, true);
  eq("★ 这一轮引擎读到的是 plan(节点覆盖生效)", probes[0]?.modeBefore, "plan");
  // 两件"漏出去"要分开钉:
  //   (a) **落盘**没被改 —— 节点不持久化自己的模式,否则用户的聊天设置被一次工作流改掉;
  //   (b) **活闸门**被还原 —— 否则用户下一句普通消息仍在 plan 下跑。
  // (b) 只能靠**行为**验:再跑一轮不带 capability 的,看引擎此刻读到什么。
  // 只断言 (a) 是空的:我们本来就没写库,它恒绿。
  eq("★ 收口后会话行仍是自己的 acceptEdits(节点模式没被持久化)", SessionRepo.get("s_chat_accept")?.permissionMode, "acceptEdits");
  resetTurnRecords();
  const afterRestore = await attempt(() => services().execute("agent.run", {
    params: { sessionId: "s_chat_accept" }, instruction: "普通一句",
  }));
  check("收口后那一轮跑通", afterRestore.ok, { error: afterRestore.ok ? undefined : afterRestore.error });
  eq("★ 收口后活闸门还原成会话自己的 acceptEdits(不是残留 plan)", probes[0]?.modeBefore, "acceptEdits");
  eq("★ 还原后写类工具又被自动放行(行为证据,不是读库)", probes[0]?.autoApproved, true);

  // 反过来:会话是 default、节点 write → 自动放行。
  resetTurnRecords();
  const writeRun = await attempt(() => runAgent({ capability: "write" }));
  check("对照那一轮收口正常", writeRun.ok, { error: writeRun.ok ? undefined : writeRun.error });
  eq("对照:节点 write 时会话虽然是 default,写类工具仍自动放行", probes[0]?.autoApproved, true);
}

/* ═════════════════════════ 4. 缺省 / 非法值:沿会话自己的模式,不发明权限 ═════════════════════════ */
console.log("\n4 · 字段缺失 / 非法值:沿会话自己的模式(不把 null 当 read)");
{
  // 会话行是 default:没有 capability → 引擎读到 default,写类工具弹卡。
  resetTurnRecords();
  const missing = await attempt(() => runAgent({}));
  check("缺 capability 那一轮收口正常", missing.ok, { error: missing.ok ? undefined : missing.error });
  eq("★ 缺 capability:引擎读到会话自己的 default(不是被当成 read)", probes[0]?.modeBefore, "default");
  eq("缺 capability:default 下写类工具仍弹卡(既有行为不变)", probes[0]?.prompted, true);

  // 非法值(手写 flow 可能塞进来的)同样不能被猜成 read。
  resetTurnRecords();
  const bogus = await attempt(() => runAgent({ capability: "exec" }));
  check("capability=exec 那一轮收口正常", bogus.ok, { error: bogus.ok ? undefined : bogus.error });
  eq("★ 非法 capability(exec):沿用会话模式,不映射", probes[0]?.modeBefore, "default");

  resetTurnRecords();
  const wrongType = await attempt(() => runAgent({ capability: 123 }));
  check("capability=数字 那一轮收口正常", wrongType.ok, { error: wrongType.ok ? undefined : wrongType.error });
  eq("★ 非法 capability(数字):沿用会话模式", probes[0]?.modeBefore, "default");
}

/* ═════════════════════════ 5. params.capability 迁移兜底:顶层缺席时也认 ═════════════════════════ */
console.log("\n5 · params.capability(迁移器写在 x-mcode.params 的那份):顶层缺席时生效");
{
  resetTurnRecords();
  const result = await attempt(() => services().execute("agent.run", {
    params: { sessionId: "s_chat", capability: "read" }, instruction: "做点事",
    // 顶层**故意不给** —— 模拟未经原生编辑器规范化、只带 x-mcode.params 的老 flow
  }));
  check("params-only capability 那一轮收口正常", result.ok, { error: result.ok ? undefined : result.error });
  eq("★ params.capability=read 也生效(迁移兜底)", probes[0]?.modeBefore, "plan");

  // 顶层压过 params:两者冲突时原生表单字段赢(与 normalizeAgentConfig 同一条规矩)。
  resetTurnRecords();
  const conflict = await attempt(() => runAgent({ capability: "write", params: { sessionId: "s_chat", capability: "read" } }));
  check("顶层与 params 冲突那一轮收口正常", conflict.ok, { error: conflict.ok ? undefined : conflict.error });
  eq("★ 顶层 capability(write)压过 params 里的 read", probes[0]?.modeBefore, "acceptEdits");
}

/* ═════════════════════════ 6. conversation.run 不套用 agent 的 capability ═════════════════════════ */
console.log("\n6 · conversation.run:不读取 agent 表单的 capability(旧侧对 conversation 也不生效)");
{
  resetTurnRecords();
  const result = await attempt(() => services().execute("conversation.run", {
    params: { sessionId: "s_chat" }, instruction: "聊一句",
    // 手搭的 msg 也可以带这个字段;它不属于对话节点表单。
    capability: "read",
  }));
  check("conversation.run 那一轮收口正常", result.ok, { error: result.ok ? undefined : result.error });
  eq("★ conversation.run 不被 capability 改模式(沿会话 default)", probes[0]?.modeBefore, "default");
}

/* ═════════════════════════ 7. 分支模型选路:payload 里的 capability 不能借道 ═════════════════════════ */
console.log("\n7 · branch.decide(model):手搭的 capability 不能借模型选路改权限");
{
  resetTurnRecords();
  replyText = "1";
  const result = await attempt(() => services().execute("branch.decide", {
    portCount: 2, decider: "model",
    params: { sessionId: "s_chat", capability: "read" },
    capability: "read",
  }));
  check("branch 模型选路那一轮收口正常", result.ok, { error: result.ok ? undefined : result.error });
  eq("branch 模型选路真的起了一轮引擎 turn", startRequests.length, 1);
  eq("★ branch 模型选路不读 capability(沿会话 default)", probes[0]?.modeBefore, "default");
}

/* ── 收尾 ── */
unsubscribeApprovals();
// 一并释放本套绑过的运行时(bindSession 会占住会话;进程退出前让状态干净)。
for (const id of ["s_chat", "s_chat_accept"]) runtimeManager.dispose(id);

console.log(`\nmcode-agent-capability-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
