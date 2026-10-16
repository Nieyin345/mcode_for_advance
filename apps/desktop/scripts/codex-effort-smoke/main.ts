/**
 * 【思考强度映射 · Codex 半条链】回归 —— 驱动**真的** `CodexAgentSdkProvider`，
 * 断言「映射翻译之后，`turn/start` 真正发出去的 `effort` 到底是什么」（2026-10-17 加）。
 *
 * ## 为什么需要这一套
 *
 * 三引擎功能对齐里，Pi / Claude 的「思考强度档位 → 发什么」都已经有回归网
 * （`custom-model-smoke` 的 `resolveMappedEffort` 段、契约层 `thinkingMap` 的
 * 全部单测），**Codex 这一格此前完全没有** —— 契约里连字段都没有。这条链有两个
 * 半场：
 *
 *   - **存储半场**（`ipc/codexModels.ts` + `lib/codexModelsStore.ts`）：映射存得进、
 *     读得回 —— 那条钉在 `memory-codex-smoke`（它本来就驱动真的 save/list handler）。
 *   - **发送半场**（`CodexAgentSdkProvider` 的 `turn/start`）：本套件。只在 SDK 边界
 *     换桩（`CodexAppServerClient` / `codexModelsStore` / 叶子 @main 模块），其余
 *     全部是真的 provider 代码。
 *
 * ## 判据立在哪
 *
 * 立在**真实交付**上：`globalThis.__codexTurnCapture` 记的是假 client 收到的
 * `turn/start` 入参原样。特别是那条最容易写错、也最该被钉死的规则 ——
 *
 *   ⚠️ **codex 的 effort 是二进制的封闭枚举**（`CODEX_EFFORT_VALUES`，抠自
 *   codex.exe）。用户在映射里填了枚举外的值（如 `reasoning_high`）时**不许静默
 *   发**：按 `isCodexEffortValue` 拦下、记一条 warn（模型 id + 用户填的值 + 枚举），
 *   然后**不传 effort**（用模型默认）。
 *
 * §A 先钉纯函数（`resolveCodexEffort`）的档位 × 映射 × kind 全矩阵；§B 再驱动真的
 * `startTurn`，断言发出去的键与值。两层都过，才算「翻译规则对」且「调用点接对了」。
 *
 * Run: scripts/codex-effort-smoke/run.sh
 */
import {
  CodexAgentSdkProvider,
  resolveCodexEffort,
} from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
import type { ThinkingLevelBinding, ThinkingLevelMap } from "@contracts/thinkingMap";

/* ── 断言助手（与其它 smoke 同款） ── */
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
/** `Object.is` 比不了数组 —— 断"正好是这几个"用 `same`（与其它 smoke 同款）。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 记事件 + 日志的宿主 ctx 桩（本套不进工具执行，只收 emit/log）。 */
function makeCtx() {
  const warns: string[] = [];
  const infos: string[] = [];
  const events: unknown[] = [];
  const ctx = {
    emit: (e: unknown) => {
      events.push(e);
    },
    onProviderSessionId: () => {},
    onResumeOutcome: () => {},
    requestApproval: async () => ({ decision: "deny" as const }),
    requestUserInput: async () => ({ answers: [] }),
    requestPlanApproval: async () => ({ decision: "reject" as const }),
    isToolAlwaysAllowed: () => false,
    getPermissionMode: () => "default" as const,
    log: {
      info: (m: unknown) => {
        infos.push(String(m));
      },
      warn: (m: unknown) => {
        warns.push(String(m));
      },
      error: () => {},
    },
  };
  return { ctx, warns, infos, events };
}

/** 纯函数档的日志收口（§A 直接把这一份喂给 `resolveCodexEffort`）。 */
function makeLogSink() {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    log: {
      info: (m: string) => infos.push(String(m)),
      warn: (m: string) => warns.push(String(m)),
    },
  };
}

const S = (value: string): ThinkingLevelBinding => ({ kind: "string", value });
const MAP = (entries: Partial<Record<string, ThinkingLevelBinding>>): ThinkingLevelMap =>
  entries as ThinkingLevelMap;

/* ════════════════════ §A 纯函数：会话档位 × 映射 → 该发什么 ════════════════════ */

console.log("\n§A resolveCodexEffort：档位 × 映射 → 该发什么（含防御性 kind 的落点）");

{
  eq("A1 档位 default → 不传", resolveCodexEffort("default", undefined), undefined);
  eq("A2 档位 undefined → 不传", resolveCodexEffort(undefined, undefined), undefined);
  eq("A3 没配映射 → 档位名原样发（枚举内）", resolveCodexEffort("high", undefined), "high");
  same(
    "A4 codex 自己的大档位（ultra/persistent）也在枚举内 → 原样发",
    [resolveCodexEffort("ultra", undefined), resolveCodexEffort("persistent", undefined)],
    ["ultra", "persistent"],
  );
  eq("A5 映射命中（枚举内）→ 发映射值", resolveCodexEffort("high", MAP({ high: S("xhigh") })), "xhigh");
  eq("A6 该档没配（配的是别的档）→ 档位名原样发", resolveCodexEffort("medium", MAP({ high: S("xhigh") })), "medium");

  {
    const w = makeLogSink();
    eq(
      "★ A7 映射值在枚举外 → 不传（绝不发一个 codex 不认的值）",
      resolveCodexEffort("high", MAP({ high: S("reasoning_high") }), { modelLabel: "demo/gpt", log: w.log }),
      undefined,
    );
    check(
      "★ A7 ...且记了一条 warn：模型 id、用户填的值、枚举都写清",
      w.warns.length === 1 &&
        w.warns[0]!.includes("demo/gpt") &&
        w.warns[0]!.includes("reasoning_high") &&
        w.warns[0]!.includes("minimal") &&
        w.warns[0]!.includes("codex 只认"),
      w.warns,
    );
  }

  {
    const w = makeLogSink();
    eq("A8 off → 不传（用模型默认）", resolveCodexEffort("high", MAP({ high: { kind: "off" } }), { log: w.log }), undefined);
    eq("A8b off 是明说「这档不支持」，不是错 → 没有 warn", w.warns.length, 0);
  }

  eq(
    "A9 passthrough → 档位名原样发（枚举内）",
    resolveCodexEffort("high", MAP({ high: { kind: "passthrough" } })),
    "high",
  );

  {
    const w = makeLogSink();
    eq(
      "A10 number 在 codex 上没有落点 → 等同 passthrough（原样发档位名）",
      resolveCodexEffort("high", MAP({ high: { kind: "number", value: 3 } }), { log: w.log }),
      "high",
    );
    check(
      "A10b ...info 日志说明了原因（number）",
      w.infos.some((m) => m.includes("number")) && w.warns.length === 0,
      { infos: w.infos, warns: w.warns },
    );
    const w2 = makeLogSink();
    eq(
      "A11 budget 同理 → 等同 passthrough",
      resolveCodexEffort("high", MAP({ high: { kind: "budget", tokens: 8192 } }), { log: w2.log }),
      "high",
    );
    check("A11b ...info 里说明的是 budget", w2.infos.some((m) => m.includes("budget")), w2.infos);
  }

  {
    const w = makeLogSink();
    eq(
      "A12 会话档位本身在枚举外 + 没配映射 → 不传",
      resolveCodexEffort("reasoning_high", undefined, { log: w.log }),
      undefined,
    );
    check(
      "A12b ...同样 warn（UI 之外灌进来的档位名也拦）",
      w.warns.length === 1 && w.warns[0]!.includes("reasoning_high"),
      w.warns,
    );
  }

  {
    const w = makeLogSink();
    eq(
      "A13 空白映射值 = 没配（与 Claude 侧同一处理）→ 不传，不 warn",
      resolveCodexEffort("high", MAP({ high: S("   ") }), { log: w.log }),
      undefined,
    );
    eq("A13b 空白值不算数也不报错", w.warns.length, 0);
  }
}

/* ════════════════════ §B 真实交付：驱动真 provider 的 startTurn ════════════════════ */

console.log("\n§B 真实交付：真的 startTurn 之后，turn/start 收到的 effort");

interface TurnCapture {
  turnStarts: Array<Record<string, unknown>>;
  calls: string[];
  reset(): void;
}
interface ModelsStub {
  set(list: Array<Record<string, unknown>>): void;
}
const capture = (globalThis as unknown as { __codexTurnCapture: TurnCapture }).__codexTurnCapture;
const modelsStub = (globalThis as unknown as { __codexModelsStub: ModelsStub }).__codexModelsStub;

/** 装一个虚构端点（id = cx），模型列表按用例给。 */
function setModels(models: Array<Record<string, unknown>>): void {
  modelsStub.set([{ id: "cx", hasApiKey: true, apiKey: "sk-fake", models }]);
}

interface DriveResult {
  turnStart: Record<string, unknown>;
  warns: string[];
  infos: string[];
}

/** 起一轮真的 provider，回合跑完（假 client 派一次 turn/completed）。 */
async function driveTurn(opts: { effort?: string; model?: string }): Promise<DriveResult> {
  capture.reset();
  const { ctx, warns, infos } = makeCtx();
  const provider = new CodexAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "cx-effort", cwd: process.cwd(), prompt: "hi", effort: opts.effort, model: opts.model } as never,
    ctx as never,
  );
  await handle.done;
  check("驱动一轮真的走到了 turn/start（否则下面的断言是空过）", capture.calls.includes("turn/start"), capture.calls);
  return { turnStart: capture.turnStarts[capture.turnStarts.length - 1] ?? {}, warns, infos };
}

{
  // B1 正控：没配映射、档位名在枚举内 → 原样发出。这条成立，后面「没发出」的断言才不是空过。
  setModels([{ id: "gpt-a" }]);
  {
    const r = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    eq("★ B1 没配映射 → effort 原样发出（正控：捕获机制真的看得见这个键）", r.turnStart["effort"], "high");
  }

  // B2 档位 default（UI 的「Default」）→ 不传。
  {
    const r = await driveTurn({ effort: "default", model: "cx/gpt-a" });
    check("B2 档位 default → turn/start 里没有 effort 键", !("effort" in r.turnStart), r.turnStart);
  }

  // B3 映射命中（枚举内）→ 发映射值。
  setModels([{ id: "gpt-a", thinkingLevelMap: { high: { kind: "string", value: "xhigh" } } }]);
  {
    const r = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    eq("★ B3 映射命中 → 发出的是映射值 xhigh，不是档位名", r.turnStart["effort"], "xhigh");
  }

  // B4 ⭐ 枚举外的映射值：必须拦下 + warn + 不发出。
  setModels([{ id: "gpt-a", thinkingLevelMap: { high: { kind: "string", value: "reasoning_high" } } }]);
  {
    const r = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    check("★ B4 映射值在枚举外 → turn/start **没有** effort 键（不静默发）", !("effort" in r.turnStart), r.turnStart);
    check(
      "★ B4 ...整份入参里都没有那个 codex 不认的值",
      !JSON.stringify(r.turnStart).includes("reasoning_high"),
      r.turnStart,
    );
    check(
      "★ B4 ...且记了 warn：模型 id、用户填的值、枚举都写清",
      r.warns.some((m) => m.includes("cx/gpt-a") && m.includes("reasoning_high") && m.includes("codex 只认")),
      r.warns,
    );
  }

  // B5 off → 不传，且不是错（不 warn）。
  setModels([{ id: "gpt-a", thinkingLevelMap: { high: { kind: "off" } } }]);
  {
    const r = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    check("B5 off → 不传 effort（用模型默认）", !("effort" in r.turnStart), r.turnStart);
    check("B5b off 是明说「这档不支持」→ 没有 warn", r.warns.length === 0, r.warns);
  }

  // B6 会话档位本身在枚举外（防 UI 之外的输入）→ 拦下 + warn。
  setModels([{ id: "gpt-a" }]);
  {
    const r = await driveTurn({ effort: "reasoning_high", model: "cx/gpt-a" });
    check(
      "★ B6 会话档位本身在枚举外 → 不传 + warn",
      !("effort" in r.turnStart) && r.warns.length === 1 && r.warns[0]!.includes("reasoning_high"),
      { turnStart: r.turnStart, warns: r.warns },
    );
  }

  // B7 逐模型隔离：映射只作用于配了它的那个模型。
  setModels([
    { id: "gpt-a", thinkingLevelMap: { high: { kind: "string", value: "xhigh" } } },
    { id: "gpt-b" },
  ]);
  {
    const a = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    const b = await driveTurn({ effort: "high", model: "cx/gpt-b" });
    eq("★ B7 映射只作用于配了它的模型（a → xhigh）", a.turnStart["effort"], "xhigh");
    eq("★ B7 ...同一供应商的另一个模型不受影响（b → 档位名原样）", b.turnStart["effort"], "high");
  }

  // B8 number 防御：codex 没有这条落点 → 等同 passthrough + info 说明。
  setModels([{ id: "gpt-a", thinkingLevelMap: { high: { kind: "number", value: 3 } } }]);
  {
    const r = await driveTurn({ effort: "high", model: "cx/gpt-a" });
    eq("B8 number 落不到 codex → 等同 passthrough（原样发档位名）", r.turnStart["effort"], "high");
    check("B8b ...info 日志说明了原因", r.infos.some((m) => m.includes("number")), r.infos);
  }
}

console.log(`\ncodex-effort-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
