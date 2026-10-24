/**
 * O1：三家引擎驱动 Docs AI 的**共享脚手架**（不含任何一家的协议形状）。
 *
 * 三家各自的替身在 `shapes/claude.ts` / `shapes/pi.ts` / `shapes/codex.ts`，
 * 三份**互不相同的代码**，各自 import 该 provider 的真实工具粘合层并把该家原生
 * 事件序列喂给该家的真实 MessageAdapter。这里只有：
 *
 *  - 渲染端替身（`FakeDocsRenderer`）：执行 `replace_blocks` 并把「文档」落盘 ——
 *    对应 vendor 页面里 `AgentSkill.executeTool` + run-done 时的 `save(false,true)`；
 *  - 工具契约（与 GenOffice docs skill 的 `replace_blocks` 同形）；
 *  - 轮询/等待小工具。
 *
 * ⚠️ 这里**没有**任何 provider 事件构造函数 —— 那是三家各自的事。把三家接到
 * 同一套事件上，这张卡就只验了一家（见卡 §3.3）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { GenOfficeNativeToolDefinition, GenOfficeNativeToolInvoker, GenOfficeNativeToolResult } from "@main/document/nativeEditorToolTransport.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { HarnessTurn } from "./stubs/harnessEnv.js";

/** GenOffice docs skill 的 `replace_blocks`（与 genoffice-ai-ask-smoke 的 mock 同形）。 */
export const replaceBlocksTool: GenOfficeNativeToolDefinition = {
  name: "replace_blocks",
  description: "Replace a block range in the open document with restricted HTML.",
  inputSchema: {
    type: "object",
    properties: {
      startBlockIndex: { type: "integer", minimum: 0 },
      endBlockIndex: { type: "integer", minimum: 0 },
      html: { type: "string", minLength: 1 },
    },
    required: ["startBlockIndex", "endBlockIndex", "html"],
  },
};

/** 每组用**自己的** marker：文档里出现哪一段，就说明那一组真的走通了。 */
export function markerFor(providerId: string): string {
  return `o1-${providerId}-edit-ok`;
}

export function toolInput(marker: string): Record<string, unknown> {
  return { startBlockIndex: 0, endBlockIndex: 0, html: `<p>${marker}</p>` };
}

export const ORIGINAL_DOCUMENT = "<p>原始段落。</p>";

/**
 * 渲染端替身：**只做两件真实的事** ——
 *  1. 执行 `replace_blocks`（把 html 写进「文档」的内存态）；
 *  2. 收到 run-done（`DocsAiChunk{type:"done"}`）时落盘（vendor `save(false,true)`）。
 *
 * 工具调用记录（`toolCalls`）是「取消后不再写」的判据：文档被改的**因**是这里被
 * 调用，不是最终文件（文件只在 done 时写，取消后连 done 都没有）。
 */
export class FakeDocsRenderer {
  document: string;
  readonly toolCalls: Array<{ name: string; input: Record<string, unknown>; definition: string }> = [];
  /**
   * `save()` 真正执行写入的次数 —— 「未落盘」的**直接记录**，不是拿「盘上字节没变」当代理。
   * 后者在「save 把同一份内容原样写回」时也成立（rule 28：代理指标失效的那类输入）。
   */
  saveCalls = 0;
  /** `save()` 被**请求**的次数（含被脏检查挡下的）。done 出现几次就请求几次。 */
  saveRequests = 0;
  private readonly initial: string;

  constructor(private readonly file: string) {
    this.document = readFileSync(file, "utf8");
    this.initial = this.document;
  }

  /** vendor 的脏检查（`anyDirtyRef.current`）：AI 跑完但文档没变，就不是脏文档。 */
  get dirty(): boolean {
    return this.document !== this.initial;
  }

  readonly invoker: GenOfficeNativeToolInvoker = async (call, definition): Promise<GenOfficeNativeToolResult> => {
    this.toolCalls.push({
      name: call.name,
      input: (call.input ?? {}) as Record<string, unknown>,
      definition: definition.name,
    });
    if (call.name !== "replace_blocks") {
      return { status: "error", output: `renderer: unknown tool ${call.name}` };
    }
    const html = typeof call.input.html === "string" ? call.input.html : "";
    this.document = html;
    return { status: "success", output: `已修改 1 个段落（${html.length} 字符）` };
  };

  /**
   * vendor 的静默首存：run-done → App.tsx 的 handler 先查
   * `!cur.doc || cur.doc.filePath || !anyDirtyRef.current` 才 `save(false, true)`。
   * 这里保留同一道脏检查 —— 否则「中途报错 → 未落盘」会被一条「把原文原样写回」
   * 的 save 弄成恒真（那个假绿正是本套件自己抓出来的）。
   */
  save(): void {
    this.saveRequests++;
    if (!this.dirty) return;
    this.saveCalls++;
    writeFileSync(this.file, this.document, "utf8");
  }

  saved(): string {
    return readFileSync(this.file, "utf8");
  }
}

/** 一家引擎的「协议级替身」：不同文件、不同原生事件、同一套对外方法。 */
export interface ProviderProtocol {
  readonly id: "claude-sdk" | "pi-sdk" | "codex-sdk";
  /**
   * This provider's fingerprint in the RuntimeEvent stream. Asserted per group so
   * "this group really ran through THIS provider's glue" is observable even before
   * the mutation runs (the mutation is the second, stronger proof).
   */
  readonly fingerprint: {
    /** The tool name the model called, as the provider's SDK names it. */
    toolUseName: string;
    /** How the adapter surfaces the tool result payload. */
    resultKind: "claude-content-array" | "pi-result-object" | "codex-joined-text";
  };
  /** Normal flow: streamed text/thinking → tool call → result → terminal done. */
  normal(turn: HarnessTurn, input: Record<string, unknown>): Promise<void>;
  /** Stream fails midway, before any document write. */
  error(turn: HarnessTurn): Promise<void>;
  /** User cancels; the SDK then still delivers a (racing) late tool call. */
  lateWriteAfterAbort(turn: HarnessTurn, input: Record<string, unknown>): Promise<void>;
}

export const ERROR_MESSAGE = "上游连接中断(HTTP 502)";

/**
 * Wait for the per-turn abort, bounded. The bound matters for the **abort
 * mutation**: with the production cancel wiring removed, this signal never
 * aborts, and the driver must still proceed (slowly) so the suite observes the
 * forbidden late write instead of hanging forever.
 */
export async function waitForTurnAbort(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (signal.aborted) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

export type EventSink = { events: RuntimeEvent[]; stop: () => void };

export function isToolUse(event: RuntimeEvent): event is Extract<RuntimeEvent, { type: "tool.use" }> {
  return event.type === "tool.use";
}

export function isToolResult(event: RuntimeEvent): event is Extract<RuntimeEvent, { type: "tool.result" }> {
  return event.type === "tool.result";
}
