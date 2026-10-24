/**
 * O1：**三家引擎各自驱动 GenOffice Docs AI 选区编辑** —— 证明「不是换了个
 * provider 就坏」。
 *
 * ## 这张卡要堵的缺口
 *
 * `genoffice-ai-ask-smoke` 的主链路已通，但它用的是**本地 mock `/chat/completions`**
 * ——只模拟了 OpenAI 兼容一种消息形状。而生产上文档 AI 走的是
 * `docsAiPorts`（`SUPPORTED = claude-sdk | pi-sdk | codex-sdk`）→ RuntimeManager
 * → 各家 provider 的**原生事件流**。三家在「流式 chunk 形状 / 工具调用协议 /
 * 错误与中断语义 / 取消行为」四点上完全不同。本套件用**每家的真实协议形状**
 * 驱动**每家的真实适配层与工具粘合**，断言「经过 docsAiPorts 之后，文档真的
 * 被改了」。
 *
 * ## 为什么不需要 API 凭据，验的仍然不是 mock
 *
 * 被测的是「我们的适配层吃不吃得下这家的形状」：
 *  - 真 `docsAiPorts.dispatchDocsAiTurn`（生产入口，含 `SUPPORTED` 校验、
 *    工作区围栏、prompt 构造、事件→DocsAiChunk 映射、取消闸）；
 *  - 真 `SdkMessageAdapter` / `PiMessageAdapter` / `CodexMessageAdapter`；
 *  - 真 `buildClaudeExternalSdkTools` / `buildPiExternalTools` /
 *    `dispatchCodexExternalToolCall`（三家的工具粘合）；
 *  - 真 `createNativeEditorToolBridge`（docsAiPorts 建的那座桥）；
 *  - 真 `createExternalToolDispatcher`（请求级白名单/取消闸，见 stubs/harnessEnv）。
 *
 * 替身只扮演两件事：各家 SDK 的**消息流**（`shapes/<provider>.ts`，三份互不
 * 相同的代码）与宿主仓储/窗口（`stubs/harnessEnv.ts`）。
 *
 * ## 判据结构（卡 §3.2）
 *
 * 每家 5 条：
 *  1. 正常流 → 文档被改 → 落盘；
 *  2. 流中途报错 → 不静默成功（error 到达渲染端，文档不变、不落盘）；
 *  3. 取消（abort）后不再写（**即使 SDK 竞争性地送达了 tool_use**）；
 *  4. 未知 providerId 被拒（负控）；
 *  5. 工作区外路径被拒（负控）。
 *
 * 第 4、5 同时配**正控**（三家合法 provider 都被接受）—— 否则负控在
 * `SUPPORTED` 退化成恒假时也会绿（本仓库栽过，「判据恒假时全体静默通过」）。
 *
 * ## 变异要求（卡 §5）
 *
 *  - 撤掉某家的工具粘合（`buildXxx` / `dispatchCodexExternalToolCall`）→
 *    **那一组**必须红（证明它真的走了这家）；
 *  - 把取消接线改成无效（harness 的 `interrupt` 不 abort）→ 每家的第 3 条必须红。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { docsAiPorts, resolveDocsAiSession } from "@main/document/docsAiPorts.js";
import type { DocsAiChunk, DocsAiRequest } from "@main/document/docsAiPorts.js";
import type { RuntimeEvent } from "@contracts/runtime";
import {
  ORIGINAL_DOCUMENT,
  FakeDocsRenderer,
  markerFor,
  replaceBlocksTool,
  toolInput,
  isToolUse,
  isToolResult,
  type ProviderProtocol,
} from "./shared.js";
import { claudeProtocol } from "./shapes/claude.js";
import { piProtocol } from "./shapes/pi.js";
import { codexProtocol } from "./shapes/codex.js";
import {
  projects,
  sessions,
  runtimeManager,
  resetTurnState,
  setDriver,
  state as harnessState,
  turnCalls,
  type HarnessSession,
  type HarnessDriver,
} from "./stubs/harnessEnv.js";

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const TMP_ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!TMP_ROOT) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这套只给无头脚本用");
const WORKSPACE = join(TMP_ROOT, "workspace");
const OUTSIDE = join(TMP_ROOT, "outside");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

const DOC_PATH = join(WORKSPACE, "doc.docx");
const OUTSIDE_DOC = join(OUTSIDE, "escape.docx");
const PROJECT_ID = "project-o1";

projects.set(PROJECT_ID, { id: PROJECT_ID, path: WORKSPACE });

function seedSession(providerId: string, model: string): HarnessSession {
  const session: HarnessSession = {
    id: `sess-o1-${providerId}`,
    projectId: PROJECT_ID,
    providerId,
    model,
    worktreePath: null,
  };
  sessions.push(session);
  return session;
}

function resetDocument(): FakeDocsRenderer {
  writeFileSync(DOC_PATH, ORIGINAL_DOCUMENT, "utf8");
  return new FakeDocsRenderer(DOC_PATH);
}

function docsRequest(session: HarnessSession, filePath = DOC_PATH): DocsAiRequest {
  return {
    requestId: randomUUID(),
    system: "润色当前选区。",
    messages: [{ role: "user", content: "编辑器：replace_blocks 可替换当前段落。" }],
    user: "把这一段改得更正式。",
    tools: [replaceBlocksTool],
    context: { sessionId: session.id, filePath },
  };
}

type RunOutcome = {
  chunks: DocsAiChunk[];
  error: unknown;
  events: RuntimeEvent[];
  renderer: FakeDocsRenderer;
  turnCount: number;
};

/**
 * Run one docsAiPorts turn for `driver` with everything reset first.
 * Returns what the group's assertions read; deliberately does NOT assert.
 */
async function runTurn(
  session: HarnessSession,
  driver: HarnessDriver,
  options: { abortAfterMs?: number | null; filePath?: string } = {},
): Promise<RunOutcome> {
  const renderer = resetDocument();
  resetTurnState();
  setDriver(driver);
  const chunks: DocsAiChunk[] = [];
  const events: RuntimeEvent[] = [];
  const stop = runtimeManager.subscribe((event) => events.push(event));
  const controller = new AbortController();
  const timer = options.abortAfterMs != null ? setTimeout(() => controller.abort(), options.abortAfterMs) : null;
  let error: unknown;
  try {
    await docsAiPorts.run(
      docsRequest(session, options.filePath),
      (chunk) => {
        chunks.push(chunk);
        // Vendor run-done handler: ai-docs-run-done → save(false, true).
        if (chunk.type === "done") renderer.save();
      },
      controller.signal,
      renderer.invoker,
    );
  } catch (caught) {
    error = caught;
  } finally {
    if (timer) clearTimeout(timer);
    stop();
    setDriver(null);
  }
  return { chunks, error, events, renderer, turnCount: turnCalls.length };
}

/** `tool.result.content` 的「本家形状」判据 —— 三家在这条上真的不同。 */
function resultMatchesShape(content: unknown, kind: ProviderProtocol["fingerprint"]["resultKind"]): boolean {
  switch (kind) {
    case "claude-content-array":
      // Claude: handleUser 原样透传 tool_result 的 content 块数组。
      return Array.isArray(content) && (content as Array<{ type?: string }>).some((block) => block?.type === "text");
    case "pi-result-object":
      // Pi: tool_execution_end 的 result 原样 —— {content:[{type:"text"}]} 对象。
      return (
        typeof content === "object" && content !== null && !Array.isArray(content) &&
        Array.isArray((content as { content?: unknown[] }).content) &&
        (content as { content: Array<{ type?: string }> }).content.some((block) => block?.type === "text")
      );
    case "codex-joined-text":
      // Codex: contentItems 的文本拼接成**字符串**（emitDynamicToolResult）。
      return typeof content === "string" && content.length > 0;
  }
}

async function providerGroup(provider: ProviderProtocol, session: HarnessSession): Promise<void> {
  const label = provider.id;
  const marker = markerFor(label);
  console.log(`\n── ${label} ────────────────────────────────────────────────`);

  // ── 1. 正常流 → 文档被改 → 落盘 ──────────────────────────────
  const normal = await runTurn(session, (turn) => provider.normal(turn, toolInput(marker)));
  const toolUses = normal.events.filter(isToolUse);
  const toolResults = normal.events.filter(isToolResult);
  const normalErrors = normal.chunks.filter((chunk) => chunk.type === "error");
  check(
    `[${label}] 正常流：docsAiPorts 发起且只发起一个 provider turn，替身真的被跑起来`,
    normal.turnCount === 1 && harnessState.driverRuns === 1,
    { turns: normal.turnCount, driverRuns: harnessState.driverRuns },
  );
  check(
    `[${label}] 正常流：适配层把工具调用翻译成 tool.use，名字带本家命名空间`,
    toolUses.length === 1 && toolUses[0].toolName === provider.fingerprint.toolUseName,
    { got: toolUses.map((event) => event.toolName), expected: provider.fingerprint.toolUseName },
  );
  check(
    `[${label}] 正常流：工具结果回到同一轮（tool.result，isError=false）`,
    toolResults.length === 1 && toolResults[0].isError === false,
    toolResults.map((event) => ({ id: event.toolCallId, isError: event.isError })),
  );
  check(
    `[${label}] 正常流：tool.result 走本家结果形状（${provider.fingerprint.resultKind}）`,
    toolResults.length === 1 && resultMatchesShape(toolResults[0]?.content, provider.fingerprint.resultKind),
    { kind: provider.fingerprint.resultKind, content: toolResults[0]?.content },
  );
  check(
    `[${label}] 正常流：渲染端真的执行了 replace_blocks（文档内存态被改）`,
    normal.renderer.toolCalls.length === 1 &&
      normal.renderer.toolCalls[0].name === "replace_blocks" &&
      String(normal.renderer.toolCalls[0].input.html).includes(marker),
    normal.renderer.toolCalls,
  );
  check(
    `[${label}] 正常流：run-done 落盘，盘上的字节就是编辑器内容`,
    normal.renderer.saved().includes(marker),
    { saved: normal.renderer.saved().slice(0, 120), marker },
  );
  check(
    `[${label}] 正常流：save 恰好被调用一次（"未落盘"负控的正控）`,
    normal.renderer.saveCalls === 1,
    { saveCalls: normal.renderer.saveCalls },
  );
  check(
    `[${label}] 正常流：渲染端收到 done、没有 error、run 不抛`,
    normal.chunks.some((chunk) => chunk.type === "done") && normalErrors.length === 0 && normal.error === undefined,
    { types: normal.chunks.map((chunk) => chunk.type), errors: normalErrors, thrown: String(normal.error ?? "") },
  );

  // ── 2. 流中途报错 → 不静默成功 ──────────────────────────────
  const midway = await runTurn(session, (turn) => provider.error(turn));
  const midwayErrors = midway.chunks.filter((chunk) => chunk.type === "error");
  check(
    `[${label}] 中途报错：渲染端收到 error（不静默成功）`,
    midwayErrors.length >= 1 && typeof midwayErrors[0].error === "string" && midwayErrors[0].error.length > 0,
    { types: midway.chunks.map((chunk) => chunk.type), errors: midwayErrors },
  );
  check(
    `[${label}] 中途报错：文档未改，且 save 从未被调用（不是"原样写回"）`,
    midway.renderer.toolCalls.length === 0 && midway.renderer.saveCalls === 0 &&
      midway.renderer.saved() === ORIGINAL_DOCUMENT,
    { calls: midway.renderer.toolCalls.length, saveCalls: midway.renderer.saveCalls, saved: midway.renderer.saved().slice(0, 80) },
  );

  // ── 3. 取消（abort）后不再写 ────────────────────────────────
  const aborted = await runTurn(session, (turn) => provider.lateWriteAfterAbort(turn, toolInput(marker)), {
    abortAfterMs: 60,
  });
  const cancelledResults = aborted.events.filter(isToolResult);
  check(
    `[${label}] 取消后不再写：渲染端一次 replace_blocks 都没执行`,
    aborted.renderer.toolCalls.length === 0,
    aborted.renderer.toolCalls,
  );
  check(
    `[${label}] 取消后不再写：文档盘上仍是原文，且 save 从未被调用`,
    aborted.renderer.saved() === ORIGINAL_DOCUMENT && aborted.renderer.saveCalls === 0,
    { saved: aborted.renderer.saved().slice(0, 80), saveCalls: aborted.renderer.saveCalls },
  );
  check(
    `[${label}] 取消后不再写：工具结果被明确标成错误/取消，不是 success`,
    cancelledResults.length >= 1 && cancelledResults.every((event) => event.isError === true),
    cancelledResults.map((event) => ({ isError: event.isError, content: String(event.content).slice(0, 60) })),
  );
}

/** 卡 §3.2 第 4、5 条：负控（配正控，证明判据不是恒假）。 */
async function negativeControls(byProvider: Map<string, HarnessSession>): Promise<void> {
  console.log("\n── 负控：未知 provider / 工作区外路径 ─────────────────────");

  // 正控先行：三家合法 provider 必须都被接受 —— 后面两条负控才有意义。
  const describes = [...byProvider.entries()].map(([id, session]) => ({
    id,
    result: docsAiPorts.describe({ sessionId: session.id, filePath: DOC_PATH }),
  }));
  check(
    "正控·三家合法 providerId 都被 describe 接受（负控不是靠恒假通过）",
    describes.length === 3 && describes.every((entry) => entry.result.ok === true),
    describes,
  );

  // 4. 未知 providerId。
  const bogus: HarnessSession = {
    id: "sess-o1-web-llm",
    projectId: PROJECT_ID,
    providerId: "web-llm",
    model: "web",
    worktreePath: null,
  };
  sessions.push(bogus);
  const bogusDescribe = docsAiPorts.describe({ sessionId: bogus.id, filePath: DOC_PATH });
  check(
    "负控·未知 providerId：describe 拒绝",
    bogusDescribe.ok === false && typeof bogusDescribe.error === "string",
    bogusDescribe,
  );
  check(
    "负控·未知 providerId：resolveDocsAiSession 返回 null",
    resolveDocsAiSession({ sessionId: bogus.id, filePath: DOC_PATH }) === null,
  );
  {
    const outcome = await runTurn(bogus, () => {
      throw new Error("负控：未知 provider 不应发起任何 turn");
    });
    check(
      "负控·未知 providerId：run 抛错且没有发起 provider turn",
      outcome.error instanceof Error && outcome.turnCount === 0 && outcome.chunks.length === 0,
      { threw: String(outcome.error), turns: outcome.turnCount, chunks: outcome.chunks },
    );
  }

  // 5. 工作区外路径 —— 三家一视同仁（换 provider 围栏不失效）。
  const outside = [...byProvider.entries()].map(([id, session]) => ({
    id,
    resolveNull: resolveDocsAiSession({ sessionId: session.id, filePath: OUTSIDE_DOC }) === null,
    describeFalse: docsAiPorts.describe({ sessionId: session.id, filePath: OUTSIDE_DOC }).ok === false,
  }));
  check(
    "负控·工作区外路径：三家都被 resolveDocsAiSession / describe 拒绝",
    outside.length === 3 && outside.every((entry) => entry.resolveNull && entry.describeFalse),
    outside,
  );
  check("负控·工作区外路径：外部文件从未被创建", !fileExists(OUTSIDE_DOC));
  {
    const session = byProvider.get("claude-sdk")!;
    const outcome = await runTurn(
      session,
      () => {
        throw new Error("负控：工作区外不应发起任何 turn");
      },
      { filePath: OUTSIDE_DOC },
    );
    check(
      "负控·工作区外路径：run 抛错且没有发起 provider turn（围栏位于 turn 之前）",
      outcome.error instanceof Error && /工作区|不可用/.test(outcome.error.message) && outcome.turnCount === 0,
      { threw: String(outcome.error), turns: outcome.turnCount },
    );
  }
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const claude = seedSession("claude-sdk", "claude-mock");
  const pi = seedSession("pi-sdk", "pi-mock");
  const codex = seedSession("codex-sdk", "codex-mock");
  const byProvider = new Map<string, HarnessSession>([
    ["claude-sdk", claude],
    ["pi-sdk", pi],
    ["codex-sdk", codex],
  ]);

  try {
    await providerGroup(claudeProtocol, claude);
    await providerGroup(piProtocol, pi);
    await providerGroup(codexProtocol, codex);
    await negativeControls(byProvider);
  } finally {
    rmSync(WORKSPACE, { recursive: true, force: true });
    rmSync(OUTSIDE, { recursive: true, force: true });
  }

  console.log(`\no1-three-provider-ai-smoke: ${total - failures}/${total} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("o1-three-provider-ai-smoke crashed:", error);
  process.exitCode = 1;
});
