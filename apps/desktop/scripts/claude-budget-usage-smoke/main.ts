/**
 * Claude 轮预算的 token 口径(审查 Z3)。
 *
 * 中途快照的 `totalProcessedTokens` 只是**当前这一次 API 调用**的量。一轮里调十几次工具、
 * 每次把几万上下文重处理一遍,按它比 `maxTotalTokens` 永远比不到 —— 预算要到轮末才看见
 * 真实累计,那时回合已经结束,停不了。适配器另发 `turnProcessedTokens`(本轮各次调用累计)
 * 给预算用,这里钉住:
 *   1. 多次调用会累加;
 *   2. 同一次调用的 message_delta 与随后几帧 assistant 消息只算一次(按 message id 去重);
 *   3. 界面口径 `totalProcessedTokens` 不变(仍是单次调用);
 *   4. 网关不带 message id 时也能按流式序号归账,不重复计。
 * 只用真实适配器 + 假 ProviderContext,不起模型、不碰数据库。
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import type { ProviderContext } from "@contracts/provider";
import type { ContextSnapshot, RuntimeEvent } from "@contracts/runtime";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, actual?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
}

function makeAdapter(): { adapter: SdkMessageAdapter; snaps: () => ContextSnapshot[] } {
  const events: RuntimeEvent[] = [];
  const ctx: ProviderContext = {
    emit: (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const adapter = new SdkMessageAdapter(ctx, "budget-usage", false, process.cwd(), new FileSnapshot());
  const snaps = (): ContextSnapshot[] =>
    events.flatMap((e) => (e.type === "token-usage.updated" ? [e.snapshot] : []));
  return { adapter, snaps };
}

const usage = (input: number, output: number, cacheRead = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
});

function stream(event: unknown): unknown {
  return { type: "stream_event", event, parent_tool_use_id: null, session_id: "s", uuid: "u" };
}

function assistant(id: string | undefined, u: ReturnType<typeof usage>): unknown {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `a-${id ?? "anon"}-${Math.random()}`,
    message: {
      ...(id !== undefined ? { id } : {}),
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "ok" }],
      usage: u,
    },
  };
}

/** 转发的**子代理** assistant 消息(带 `parent_tool_use_id`)。它的 usage 该记账、
 *  但不该发布占用快照。 */
function subagentAssistant(id: string, u: ReturnType<typeof usage>, parent = "toolu_parent"): unknown {
  return { ...(assistant(id, u) as Record<string, unknown>), parent_tool_use_id: parent };
}

/** 一次带流式事件的调用:message_start → message_delta(带用量)→ 两帧 assistant(同一 id)。 */
async function call(adapter: SdkMessageAdapter, id: string | undefined, u: ReturnType<typeof usage>): Promise<void> {
  await adapter.dispatch(stream({ type: "message_start", message: id !== undefined ? { id } : {} }) as never);
  await adapter.dispatch(stream({ type: "message_delta", usage: u }) as never);
  await adapter.dispatch(assistant(id, u) as never);
  await adapter.dispatch(assistant(id, u) as never);
}

async function main(): Promise<void> {
  console.log("\n多次调用累加,同一次调用去重");
  {
    const { adapter, snaps } = makeAdapter();
    // 三次调用,每次 5 万上下文(大部分走缓存)+ 一点输出。
    await call(adapter, "msg_1", usage(1_000, 200, 49_000));
    await call(adapter, "msg_2", usage(1_500, 300, 50_000));
    await call(adapter, "msg_3", usage(2_000, 400, 51_000));
    const all = snaps();
    const last = all[all.length - 1];
    const perCall = [50_200, 51_800, 53_400];
    check("发出了快照", all.length > 0, all.length);
    check(
      "turnProcessedTokens = 三次调用之和(每次调用只算一次)",
      last?.turnProcessedTokens === perCall[0] + perCall[1] + perCall[2],
      last?.turnProcessedTokens,
    );
    check("界面口径 totalProcessedTokens 仍是当前这一次调用", last?.totalProcessedTokens === perCall[2], last?.totalProcessedTokens);
    check(
      "累计只增不减(预算计数不会倒退)",
      all.every((s, i) => i === 0 || (s.turnProcessedTokens ?? 0) >= (all[i - 1].turnProcessedTokens ?? 0)),
      all.map((s) => s.turnProcessedTokens),
    );
  }

  console.log("\n同一次调用的用量后到更大:取大的,不叠加");
  {
    const { adapter, snaps } = makeAdapter();
    await adapter.dispatch(stream({ type: "message_start", message: { id: "msg_a" } }) as never);
    await adapter.dispatch(assistant("msg_a", usage(10_000, 1)) as never);
    await adapter.dispatch(assistant("msg_a", usage(10_000, 500)) as never);
    const last = snaps().at(-1);
    check("同一 id 两次上报 → 只记较大的 10500", last?.turnProcessedTokens === 10_500, last?.turnProcessedTokens);
  }

  console.log("\n网关不带 message id:按流式序号归账");
  {
    const { adapter, snaps } = makeAdapter();
    await call(adapter, undefined, usage(20_000, 100));
    await call(adapter, undefined, usage(21_000, 100));
    const last = snaps().at(-1);
    check("两次匿名调用 → 41200(既不漏也不重复)", last?.turnProcessedTokens === 41_200, last?.turnProcessedTokens);
  }

  console.log("\n子代理消息:记账,但不覆盖主线程的占用环");
  {
    // 主线程一次大调用 → 环 150k(75%)。
    const { adapter, snaps } = makeAdapter();
    await adapter.dispatch(assistant("main_1", usage(150_000, 10)) as never);
    const beforeSub = snaps().at(-1);
    check("主线程先报出大占用", beforeSub?.usedTokens === 150_000, beforeSub?.usedTokens);
    const countBefore = snaps().length;
    // 转发的子代理消息:**小得多的** usage(它有自己的窗口)。
    await adapter.dispatch(subagentAssistant("sub_1", usage(5_000, 10)) as never);
    // ★ 环不许退步 —— 子代理的占用不是主线程的占用。
    const afterSub = snaps().at(-1);
    check(
      "★ 子代理消息不发布占用快照(条数不变)",
      snaps().length === countBefore,
      { before: countBefore, after: snaps().length },
    );
    check("★ 主线程占用环未被拉低", afterSub?.usedTokens === 150_000, afterSub?.usedTokens);
    // 但**记账照旧**:子代理的 processed tokens 该进本轮吞吐/预算。
    // 下一次主线程快照的 turnProcessedTokens 才把它算进去(150010 + 5010 = 155020)。
    await adapter.dispatch(assistant("main_2", usage(152_000, 10)) as never);
    const afterNextMain = snaps().at(-1);
    check(
      "★ 子代理的吞吐仍被记入(下一次主线程快照含它)",
      (afterNextMain?.turnProcessedTokens ?? 0) >= 150_010 + 5_010,
      afterNextMain?.turnProcessedTokens,
    );
  }

  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
