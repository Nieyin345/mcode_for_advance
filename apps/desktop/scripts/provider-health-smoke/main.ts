/**
 * 【MC-076】Provider 健康探测资源治理回归 —— 超时必须**真的**终止底层 SDK 工作。
 *
 * ## 为什么需要这一套(台账 §MC-076 的验收矩阵)
 *
 * `providerHealth.ts` 从前用 `Promise.race([provider.healthCheck(), timeout])` 包住探测:
 * 外层超时只**停止等待**,底层 SDK 查询流 / 子进程 / Pi 会话**不会被主动清理**,用户反复
 * force 会不断累积未归还的会话与进程(台账 E1:连续 7 次 force 留下 7 个未结束任务)。
 *
 * 本套件**驱动真的 provider 类**(不做生产代码改动),只在 SDK 边界换桩,断言立在
 * 「超时确实触发了资源释放」上:
 *
 *   - **探测服务(§1)**:假 SDK 永不返回时,超时进 `cancelling`;后续 force **不再另起**
 *     底层任务(全局同引擎在途预算 = 1);底层确认释放后才放行下一份。
 *   - **Claude(§2)**:`healthCheck` 超时(宿主 abort)时**确实调了** iterator `.return()`
 *     —— init 之前与 init 之后两条路径各测一次。
 *   - **Pi(§3)**:会话在超时后**迟到**建成时被 `dispose()`;彻底挂死时探测服务保持
 *     `cancelling` 不另起。
 *   - **Codex(§4)**:超时时**确实调了** `child.kill()` 终止版本命令子进程。
 *
 * 每条断言在"把修复撤掉"(变异)时必须真的变红 —— 见 run.sh 与提交说明。
 */
import { ClaudeAgentSdkProvider } from "@main/providers/claude-sdk/ClaudeAgentSdkProvider.js";
import { PiAgentSdkProvider } from "@main/providers/pi-sdk/PiAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
import { createProviderHealthProbe } from "@main/providers/providerHealth.js";

/* ── 断言助手(与其它 smoke 同款) ───────────────────────────── */
let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

interface ClaudeFake { iterators: Array<{ returned: number }>; returns: number; reset(): void }
interface PiFake { mode: string; createCount: number; disposeCount: number; reset(m: string): void }
interface KillFake { children: Array<{ killed: boolean }>; killCount: number; reset(): void }

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** 给一个可能**永不 settle**的 promise 加超时护栏 —— 撤掉修复(变异)时,底层挂死
 *  会让 `await` 永久 pending,那是一条"卡住"而不是"红";这里统一在超时后回归,
 *  让断言真的变红而不是把套件挂死。 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: string): Promise<T | string> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

/* ════════════════ §1 探测服务:超时真的 abort + 同引擎在途预算 ════════════════ */

/** §1a:假 SDK 永远 pending,连续 7 次 force 不得另起底层任务(台账 E1 核验点)。 */
async function probeServiceBudget(): Promise<void> {
  let started = 0;
  let aborts = 0;
  const unsettled = new Set<number>();
  const probe = createProviderHealthProbe(
    () => ({
      id: "fake",
      healthCheck: (ctx?: { signal?: { aborted: boolean; addEventListener: Function } }) => {
        const ticket = ++started;
        unsettled.add(ticket);
        ctx?.signal?.addEventListener("abort", () => { aborts += 1; unsettled.delete(ticket); }, { once: true });
        return new Promise<never>(() => { /* 永不返回 */ });
      },
    } as never),
    { timeoutMs: 8, ttlMs: 0 },
  );

  const statuses: string[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await probe("fake", { force: true })).code);
  await sleep(20);

  eq("§1a 连续 7 次 force 只起了 1 份底层任务(修前是 7)", started, 1);
  eq("§1a 超时真的触发了 1 次 abort(修前是 0)", aborts, 1);
  eq("§1a 底层假任务全部归还(修前留 7 个未结束)", unsettled.size, 0);
  eq("§1a 首次超时", statuses[0], "timeout");
  check("§1a 后续 6 次都是 cancelling(不把超时说成 SDK 不可用)",
    statuses.slice(1).every((s) => s === "cancelling"), statuses);
}

/** §1b:底层**缓慢释放**时,闸门保持 cancelling,确认释放后才放行下一份。 */
async function probeServiceReleaseGate(): Promise<void> {
  let started = 0;
  const rel: { fn: (() => void) | null } = { fn: null };
  const probe = createProviderHealthProbe(
    () => ({
      id: "slow",
      healthCheck: (ctx?: { signal?: { aborted: boolean; addEventListener: Function } }) => {
        started += 1;
        ctx?.signal?.addEventListener("abort", () => { /* 收到 abort 但故意不立刻 settle */ }, { once: true });
        return new Promise<{ ok: boolean }>((resolve) => { rel.fn = () => resolve({ ok: true }); });
      },
    } as never),
    { timeoutMs: 8, ttlMs: 0 },
  );

  const first = await probe("slow", { force: true });
  const duringCancel = await probe("slow", { force: true });
  const startedWhileCancelling = started;
  rel.fn?.();
  await sleep(20);
  const afterRelease = await probe("slow", { force: true });
  const startedAfterRelease = started;

  eq("§1b 首次超时", first.code, "timeout");
  eq("§1b 底层未释放时再探测 → cancelling", duringCancel.code, "cancelling");
  eq("§1b 取消阶段不另起底层任务(预算仍为 1)", startedWhileCancelling, 1);
  eq("§1b 释放确认后放行下一份(允许起第 2 份)", startedAfterRelease, 2);
}

/* ════════════════ §2 Claude:超时终止查询流(init 前/后) ════════════════ */

/** Claude 的 SDK 桩走动态 import,模块体在首次 `loadQuery()` 时才跑 —— 先热一次,
 *  让 `globalThis.__claudeFake` 存在,再 reset。 */
async function warmClaudeFake(): Promise<ClaudeFake> {
  const provider = new ClaudeAgentSdkProvider();
  const warmCtl = new AbortController();
  warmCtl.abort(); // 已取消:healthCheck 仍会走 loadQuery(加载桩)随后立刻释放
  await withTimeout(
    provider.healthCheck({ signal: warmCtl.signal, deadline: Date.now(), probeId: "warm-claude" }),
    60,
    "HUNG",
  ).catch(() => {});
  const cf = (globalThis as unknown as { __claudeFake?: ClaudeFake }).__claudeFake;
  if (!cf) throw new Error("provider-health-smoke: Claude 桩未加载(__claudeFake 缺失)");
  cf.reset();
  return cf;
}

async function claudeProbeReleasesQueryIterator(): Promise<void> {
  const cf = await warmClaudeFake();
  const provider = new ClaudeAgentSdkProvider();
  const controller = new AbortController();
  const p = provider.healthCheck({ signal: controller.signal, deadline: Date.now() + 8, probeId: "t-claude" });

  // 让 healthCheck 起来、拿到查询流(iterator 已被记录),再触发宿主超时 abort。
  await sleep(5);
  const iteratorsAfterStart = cf.iterators.length;
  controller.abort();
  await withTimeout(p, 50, "HUNG"); // 变异(撤修复)时底层挂死,护栏让断言变红而非卡死
  await sleep(5);

  check("§2 healthCheck 已创建查询流", iteratorsAfterStart >= 1, iteratorsAfterStart);
  eq("§2 超时(abort)时真的终止了查询流(iterator.return 被调 1 次)", cf.returns, 1);
  check("§2 那个 iterator 的 return 计数 ≥ 1", (cf.iterators[0]?.returned ?? 0) >= 1, cf.iterators.map((i) => i.returned));
}

/** 宿主在 healthCheck **拿到 iterator 之前**就已 abort(在途取消)。 */
async function claudeProbeAlreadyAborted(): Promise<void> {
  const cf = await warmClaudeFake();
  const provider = new ClaudeAgentSdkProvider();
  const controller = new AbortController();
  controller.abort(); // 探测开始前就已取消
  const result = await withTimeout(
    provider.healthCheck({ signal: controller.signal, deadline: Date.now(), probeId: "t-claude-pre" }),
    50,
    "HUNG",
  );
  eq("§2 已取消的探测如实报失败", (result as { ok: boolean }).ok, false);
  check("§2 已取消的探测仍关闭了它的查询流(不留挂起的流)", cf.returns >= 1, cf.returns);
}

/* ════════════════ §3 Pi:会话迟到建成要 dispose,挂死保持 cancelling ════════════════ */

/** Pi 的 SDK 桩是 `--external` 的相对文件,首次 `loadPiSdk()` 才加载 —— 先热一次。 */
async function warmPiFake(): Promise<PiFake> {
  const provider = new PiAgentSdkProvider();
  const ctl = new AbortController();
  // 默认 "ok" 模式:加载桩、建一个会话再释放。随后 reset 清掉这次计数。
  await provider.healthCheck({ signal: ctl.signal, deadline: Date.now() + 2000, probeId: "warm-pi" }).catch(() => {});
  const pf = (globalThis as unknown as { __piFake?: PiFake }).__piFake;
  if (!pf) throw new Error("provider-health-smoke: Pi 桩未加载(__piFake 缺失)");
  return pf;
}

async function piProbeDisposesLateSession(): Promise<void> {
  const pf = await warmPiFake();
  pf.reset("late");
  const provider = new PiAgentSdkProvider();
  const controller = new AbortController();
  const p = provider.healthCheck({ signal: controller.signal, deadline: Date.now() + 8, probeId: "t-pi" });
  await sleep(5);
  controller.abort(); // 会话还没建好就超时 —— 迟到的会话必须被回收,且如实报取消
  const result = await withTimeout(p, 200, "HUNG");
  await sleep(60); // 让迟到建成的会话被回收
  check("§3 会话确实被创建", pf.createCount >= 1, pf.createCount);
  eq("§3 超时后迟到的会话被 dispose(不留未归还会话)", pf.disposeCount, 1);
  eq("§3 取消期间建成的会话如实报取消(不宣称可用)", (result as { ok: boolean }).ok, false);
}

async function piProbeHangKeepsCancelling(): Promise<void> {
  const pf = await warmPiFake();
  pf.reset("hang");
  const provider = new PiAgentSdkProvider();
  const probe = createProviderHealthProbe(() => provider, { timeoutMs: 8, ttlMs: 0 });
  const first = await probe("pi-sdk", { force: true });
  const second = await probe("pi-sdk", { force: true });
  eq("§3 挂死时首次超时", first.code, "timeout");
  eq("§3 挂死(底层未 settle)时再探测 → cancelling,不另起", second.code, "cancelling");
  eq("§3 挂死时只起过 1 次底层探测(createAgentSession 未重复)", pf.createCount, 1);
}

/* ════════════════ §4 Codex:超时终止版本命令子进程 ════════════════ */

async function codexProbeKillsChild(): Promise<void> {
  const kf = (globalThis as unknown as { __codexKillFake: KillFake }).__codexKillFake;
  kf.reset();
  const provider = new CodexAgentSdkProvider();
  const controller = new AbortController();
  const p = provider.healthCheck({ signal: controller.signal, deadline: Date.now() + 8, probeId: "t-codex" });
  await sleep(5);
  controller.abort(); // 宿主超时
  const result = await withTimeout(p, 50, "HUNG"); // 变异(撤修复)时子进程永不回调,护栏让断言变红
  await sleep(5);
  eq("§4 healthCheck 起了版本命令子进程", kf.children.length, 1);
  eq("§4 超时时确实终止了子进程(child.kill 被调)", kf.killCount, 1);
  eq("§4 被 kill 的子进程标记为已终止", kf.children[0]?.killed, true);
  check("§4 取消不伪装成可用", (result as { ok: boolean }).ok === false, result);
}

/* ════════════════ 主流程 ════════════════ */

async function main(): Promise<void> {
  console.log("\n§1 探测服务:超时真的 abort + 同引擎在途预算");
  await probeServiceBudget();
  await probeServiceReleaseGate();

  console.log("\n§2 Claude:超时终止查询流");
  await claudeProbeReleasesQueryIterator();
  await claudeProbeAlreadyAborted();

  console.log("\n§3 Pi:会话释放与挂死闸门");
  await piProbeDisposesLateSession();
  await piProbeHangKeepsCancelling();

  console.log("\n§4 Codex:超时终止版本命令子进程");
  await codexProbeKillsChild();

  console.log(`\nprovider-health smoke: ${total - failures}/${total} 通过`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
