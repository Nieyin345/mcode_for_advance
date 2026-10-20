/**
 * 自定义面板的 `mcode.ask()`(R41):一次性问一个模型,返回纯文本。
 *
 * 和标题生成走同一条路(`ipc/titleGen.ts`):Claude Agent SDK 的 `query`,`maxTurns: 1`,
 * **`tools: []`** —— 面板里的文字再怎么写,也驱动不了文件 / 命令 / 网络。
 *
 * 模型:`@claude[:haiku|sonnet|opus]` = 本机 Claude Code 登录;`自定义模型id[:角色]` = 自定义
 * 模型(OpenAI 协议的经本地桥)。不指定 → 「标题生成」里选的那个(用户已经挑过一个便宜的);
 * 那里也没选 → 本机 Claude。
 *
 * 同时最多跑 {@link MAX_IN_FLIGHT} 个:面板脚本写出一个死循环时,不至于一口气烧掉一堆额度。
 */
import { UI_TITLE_GEN_MODEL_SETTING_KEY } from "@contracts/ipc";
import { parseModel } from "@main/lib/visionRelayCore.js";
import type { CustomUiPanelAskInput, CustomUiPanelAskResult } from "@contracts/customUiPanel";
import { SettingRepo } from "@main/store/repositories.js";
import { resolveModelForGitOp } from "@main/ipc/git.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";
import { safeErrorMessage } from "@main/lib/safeErrorMessage.js";

const MAX_IN_FLIGHT = 3;
const TIMEOUT_MS = 180_000;
let inFlight = 0;

const DEFAULT_SYSTEM =
  "You are a helpful assistant embedded in a user-built panel inside the Mcode desktop app. Reply with plain text (Markdown allowed). You have no tools.";

export async function panelAsk(input: CustomUiPanelAskInput): Promise<CustomUiPanelAskResult> {
  if (inFlight >= MAX_IN_FLIGHT) {
    return { ok: false, error: `同时最多 ${MAX_IN_FLIGHT} 个请求,请等前面的返回再问` };
  }
  inFlight++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let releaseBridge: (() => void) | undefined;
  try {
    // Reading settings can throw before DB startup or after an I/O error.
    // Keep it within the finally that releases the concurrency slot.
    const requestedModel = input.model?.trim() || SettingRepo.get(UI_TITLE_GEN_MODEL_SETTING_KEY);
    const choice = requestedModel?.trim() ? parseModel(requestedModel) : { builtin: true as const, alias: undefined };
    if (!choice) return { ok: false, error: "指定的模型或 Claude 别名无效，请重新选择模型" };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let model: string | undefined;
    let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];
    if (choice.builtin) {
      model = choice.alias;
    } else {
      const resolved = await resolveModelForGitOp(choice.id, choice.role);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      releaseBridge = resolved.releaseBridge;
      model = resolveActiveModel(resolved.config);
      env = buildCustomEnv(resolved.config, {});
    }
    const binaryPath = resolveSdkBinaryPath();
    const q = query({
      prompt: input.prompt,
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        tools: [],
        systemPrompt: input.system?.trim() ? input.system : DEFAULT_SYSTEM,
        settingSources: [],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });
    let text = "";
    let resultError: string | undefined;
    let completed = false;
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          const part = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
          if (part) text = text ? `${text}\n${part}` : part;
        }
      }
      if (m.type === "result") {
        const r = m as { is_error?: boolean; subtype?: string; result?: unknown };
        if (r.is_error) resultError = typeof r.result === "string" && r.result ? r.result : (r.subtype ?? "error");
        else completed = true;
        break;
      }
    }
    // Failed final SDK result overrides any earlier assistant text. The
    // earlier text may itself be an API diagnostic, not a user answer.
    if (resultError) return { ok: false, error: resultError };
    if (!completed) return { ok: false, error: "模型流已中断，未收到 SDK 成功结果" };
    if (!text.trim()) return { ok: false, error: resultError ?? "模型没有返回内容" };
    return { ok: true, text: text.trim() };
  } catch (err) {
    const msg = ac.signal.aborted ? "超时了(3 分钟)" : safeErrorMessage(err);
    log.warn(`customUi.panelAsk failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
    try {
      releaseBridge?.();
    } catch (err) {
      // Closing a gateway bridge can fail after an otherwise successful
      // response. Report cleanup trouble without corrupting the answer or
      // permanently consuming a panel concurrency slot.
      log.warn(`customUi.panelAsk bridge cleanup failed: ${safeErrorMessage(err)}`);
    } finally {
      inFlight--;
    }
  }
}
