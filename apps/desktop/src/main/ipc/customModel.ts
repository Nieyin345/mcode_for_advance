/**
 * IPC handlers for user-defined custom-model configs (Anthropic-compatible
 * endpoints). The auth token is encrypted at rest via safeStorage and NEVER
 * sent to the renderer in cleartext — only a masked form is returned.
 *
 * - list   : return all configs (desensitized)
 * - save   : create or update (encrypts the token, returns the new list)
 * - delete : remove a config and its token
 * - test   : probe a (not-yet-saved) config by running one minimal SDK turn
 *            against that endpoint, so the user can verify before save
 */
import type { IpcMain } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  IPC,
  SaveCustomModelSchema,
  DeleteCustomModelSchema,
  TestCustomModelSchema,
  GetCustomModelTokenSchema,
} from "@contracts/ipc";
import type { ApiConfig } from "@contracts/customModel";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import {
  bridgeStatus,
  ensureStarted,
  regenerateToken,
} from "@main/providers/bridge/extensionBridge.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";

/** Probe timeout — a healthy endpoint should answer the init handshake within
 *  a few seconds. We abort the SDK query after this to avoid hanging the UI. */
const TEST_TIMEOUT_MS = 30_000;

/**
 * 把校验错翻译成**一行人话**，再交给渲染端。
 *
 * ⚠️ 不能直接把 `err.message` 交出去：zod 的 `ZodError.message` 是一整段 JSON 数组
 * 文本（`[{"code":"too_small","minimum":1,…,"path":["name"]}]`），而这条通道的 error
 * 会被渲染端**原样写进设置页那行红字**（`CustomModelsPanel.tsx` 的 `{error}`）。用户
 * 看到的就是一屏 JSON —— 那不是"报错说清楚了"，那是把内部错误对象的形状漏了出去。
 *
 * 格式与本仓库既有的那两处一致（`ipc/terminal.ts` 的 `describeInputError`、
 * `mcp/webToolHost.ts` 的 `describeIssues`）：`字段名: 那句话`。这里再补一件事 ——
 * schema 自己写的那几句中文（`网页端必须选择站点`、`不认识的网页端站点：…`）要**原样
 * 透出去**，它们本来就是给用户看的。
 *
 * 只取**第一条** issue：用户一次改一个地方，报第一条就够；把十几条串起来反而没人读。
 */
function describeInputError(err: z.ZodError): string {
  const first = err.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `入参不合法（${where}${first?.message ?? "没通过校验"}）`;
}

/** catch 里唯一的出口 —— zod 走人话，别的照原样（那些 message 本来就是人写的，
 *  比如「更新一个不存在的配置」和「新建时必须给密钥」）。 */
function errText(err: unknown): string {
  if (err instanceof z.ZodError) return describeInputError(err);
  return err instanceof Error ? err.message : String(err);
}

export function registerCustomModelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_MODEL_LIST, () => {
    return { models: CustomModelStore.listPublic() };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SAVE, (_evt, raw) => {
    try {
      const input = SaveCustomModelSchema.parse(raw);
      const models = CustomModelStore.save(input);
      log.info(`custom model saved: ${input.id ? `updated ${input.id}` : `new (${models.length} total)`}`);
      return { models };
    } catch (err) {
      // 「更新一个已经不存在的配置」也是一句给人看的话（用户在两个窗口里各删了一次
      // 就会撞上），所以统一在这里变成一句话再交出去。
      if (err instanceof z.ZodError) log.warn(`custom model save rejected: ${errText(err)}`);
      throw new Error(errText(err));
    }
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_DELETE, (_evt, raw) => {
    try {
      const input = DeleteCustomModelSchema.parse(raw);
      const models = CustomModelStore.remove(input.id);
      log.info(`custom model deleted: ${input.id} (${models.length} remaining)`);
      return { models };
    } catch (err) {
      throw new Error(errText(err));
    }
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_GET_TOKEN, (_evt, raw) => {
    try {
      const input = GetCustomModelTokenSchema.parse(raw);
      // resolveApiConfig already decrypts the token in main memory; we reuse it
      // rather than opening a second decryption path. The cleartext is returned
      // here ONLY because the user clicked the eye icon in the settings form.
      const cfg = CustomModelStore.resolveApiConfig(input.id);
      return { token: cfg?.authToken ?? null };
    } catch (err) {
      throw new Error(errText(err));
    }
  });

  // 扩展桥（网页端协议的传输层）：设置页显示桥地址 + 令牌 + 配对徽章。
  // status 会**顺带把服务拉起来** —— 用户打开设置页就该看到地址，而不是先去发一条
  // 消息把桥唤醒。服务只绑 127.0.0.1，listen(0) 拿一个空闲端口。
  ipcMain.handle(IPC.WEB_BRIDGE_STATUS, async () => {
    await ensureStarted();
    return bridgeStatus();
  });

  // 换令牌：旧令牌立刻失效，已连上的扩展会被断开（扩展侧应重新填入新令牌）。
  ipcMain.handle(IPC.WEB_BRIDGE_REGENERATE_TOKEN, async () => {
    await ensureStarted();
    return regenerateToken();
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_TEST, async (_evt, raw) => {
    // 校验错也走人话（同上面几条）：这条通道的失败会原样显示在设置页那行红字里。
    let input: z.infer<typeof TestCustomModelSchema>;
    try {
      input = TestCustomModelSchema.parse(raw);
    } catch (err) {
      throw new Error(errText(err));
    }
    // The probe tests ONE model (the user picks which model row in the UI).
    // Build a minimal ApiConfig whose flat list holds just the probed model
    // and selects it. supports1m is recorded on the entry so
    // resolveActiveModel / buildCustomEnv see the same 1M behavior a saved
    // config would produce — the probe then exercises the EXACT model string
    // a real turn would send via Options.model.
    const cfg: ApiConfig = {
      baseUrl: input.baseUrl,
      authToken: input.authToken,
      authMode: input.authMode ?? "auth_token",
      protocol: input.protocol ?? "anthropic",
      selectedModel: input.model,
      models: [{ id: input.model, ...(input.supports1m ? { supports1m: true } : {}) }],
      disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
      timeoutMs: input.timeoutMs,
      // Carried so the probe sends the same headers a live turn would — without
      // this, an endpoint that REQUIRES one (and answers 400 without it) could
      // never be verified before saving: the test would fail on a config that
      // works fine.
      customHeaders: input.customHeaders,
    };
    // BOTH protocols probe through the real live chain (binary + env builder +
    // settingSources) — never a shortcut fetch. OpenAI-format endpoints get a
    // throwaway bridge instance under a synthetic config id, mirroring what
    // RuntimeManager.sendTurn does for a live turn, so the probe exercises
    // translation + auth + model routing end-to-end: "测得过 = 保存后一定能用".
    // (The former direct-fetch shortcut skipped the bridge and sent the
    // `[1m]`-suffixed model id straight onto the OpenAI wire — which has no
    // such convention — so gateways read `model[1m]` as an unknown model and
    // answered 401, failing tests for configs that work fine live.)
    if (cfg.protocol === "openai") {
      const probeId = `probe:${randomUUID()}`;
      const handle = await BridgeRegistry.acquire(probeId, cfg);
      try {
        return await probeEndpoint({ ...cfg, baseUrl: handle.localUrl });
      } finally {
        BridgeRegistry.release(probeId);
      }
    }
    return probeEndpoint(cfg);
  });
}

/**
 * Verify a custom endpoint by spawning a minimal SDK query against it and
 * waiting until the probe knows whether the endpoint really serves the probed
 * model — i.e. until the model ANSWERS, or the turn fails. Aborts after
 * {@link TEST_TIMEOUT_MS}.
 *
 * ⚠️ The `system/init` handshake alone is NOT proof, even though it is what
 * this function used to return on. It is emitted before the prompt is sent, so
 * an endpoint that refuses the very first API call (wrong model name for that
 * gateway, no channel, bad credential) still streams `system/init` first — the
 * probe then reported a green "connected" for a config that could not send a
 * single request, and the user only found out on a live turn. The loop below
 * therefore checks a failed `result` BEFORE the init branch and requires a real
 * assistant answer. Verified against the real binary: with an endpoint that
 * answers `400 unknown model`, the message order is `… assistant(error,
 * empty) → system/init → assistant(error) → result(is_error)`, and with a live
 * endpoint it is `… assistant → system/init → assistant(text) → result`.
 *
 * Uses the SAME env-builder, SAME model resolver, AND SAME settingSources as a
 * live turn, so a passing test guarantees the saved config will work
 * end-to-end. OpenAI-format callers pass a cfg whose baseUrl has already been
 * rewritten to a live bridge's local URL (exactly the rewrite
 * RuntimeManager.sendTurn applies), so the probe is the live chain verbatim.
 * The probe resolves the model id via {@link resolveActiveModel}
 * and passes `settingSources: ['project','local']` — matching what
 * {@link ClaudeAgentSdkProvider} does — so the two paths can never drift. This
 * is critical: without matching settingSources, the binary would read whatever
 * cc switch left in ~/.claude/settings.json and the probe would test the wrong
 * endpoint (the original "test passes, live turn fails" bug).
 */
async function probeEndpoint(
  cfg: ApiConfig,
): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  /** The init handshake's detail string, remembered (NOT returned) so a later
   *  failed `result` can be reported with the upstream's own words instead of
   *  a false green — and so an endpoint that handshakes but never answers is
   *  described accurately. See the loop below. */
  let sawInit: string | null = null;
  /** Whether this turn actually produced content. A `result` message closes
   *  the turn either way (error or not), so this is what separates "the model
   *  answered" from "the endpoint handshook and said nothing". */
  let answered = false;

  try {
    // The probe mirrors a live turn: resolveActiveModel yields the exact model
    // string (with the lowercase `[1m]` suffix when supports1m) that
    // buildCustomEnv also places on ANTHROPIC_MODEL for a live turn — so the
    // probe exercises the same model id a real turn sends. The probe passes it
    // via the SDK `model` option (it doesn't set ANTHROPIC_MODEL because its
    // cfg binds only one role); the binary accepts either channel.
    // betas is intentionally NOT set — 1M is declared via the suffix, not via
    // the anthropic-beta header. Where the suffix ends up depends on protocol:
    // anthropic gateways parse it themselves (DeepSeek convention); for openai
    // configs the bridge strips it before the upstream sees the request (the
    // OpenAI wire has no such convention) — mirroring a live turn either way.
    const probedModel = resolveActiveModel(cfg);
    // Resolve the real on-disk binary path. Without this, the SDK resolves the
    // claude binary to a path INSIDE app.asar in a packaged app and spawn()
    // fails with ENOTDIR (asar is a file, not a directory). Dev returns null
    // and the SDK resolves node_modules itself. Same fix the provider applies.
    const binaryPath = resolveSdkBinaryPath();
    const q = query({
      prompt: "hi",
      options: {
        abortController: ac,
        maxTurns: 1,
        model: probedModel,
        env: buildCustomEnv(cfg),
        // MUST mirror the live-turn provider's settingSources (see
        // ClaudeAgentSdkProvider.ts). The bundled binary re-reads
        // ~/.claude/settings.json after spawn and overwrites the env we pass
        // here — so without this, the probe would be testing whatever cc
        // switch currently points at, NOT the config the user just typed in.
        // That divergence was the original "test passes, live turn fails"
        // mystery. ['project','local'] skips the user-level file (cc switch's
        // territory) while keeping CLAUDE.md / project settings working.
        settingSources: ["project", "local"],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });

    for await (const m of q) {
      // The system/init message means the subprocess booted and something on
      // the other end answered — but it is emitted *around* the first API call,
      // so on its own it does NOT mean this config works: an endpoint that
      // refuses the very first request (wrong model name for that gateway, no
      // channel, bad credential) still streams `system/init`. Remember it and
      // keep reading; nothing before the turn closes may return success.
      if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
        const ver = (m as { claude_code_version?: string }).claude_code_version;
        sawInit = ver ? `connected (SDK v${ver})` : "connected";
        continue;
      }
      // A real endpoint emits `assistant` frames carrying this turn's content
      // (a text block with the reply). Record it — but do NOT return yet: the
      // frames keep coming until the turn closes, and a refused request emits
      // one with an `error` flag whose content is the upstream's error text.
      if (m.type === "assistant") {
        if ((m as { error?: unknown }).error) continue;
        const content = (m as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content) && content.length > 0) answered = true;
        continue;
      }
      // The turn closed — the ONLY point where the probe actually knows:
      //   - answered (and not is_error)        → the endpoint serves this model
      //   - not answered, with the upstream's
      //     own words in `result`               → refused; those words are what
      //                                           the user needs to see
      //   - not answered, no words at all       → reachable but silent
      if (m.type === "result") {
        const text = (m as { result?: unknown }).result;
        const words = typeof text === "string" && text.trim() ? text.trim() : "";
        if (answered && !(m as { is_error?: boolean }).is_error) {
          return { ok: true, detail: sawInit ?? "model responded" };
        }
        if (words) return { ok: false, error: words };
        // ⚠️ 下面两句是**用户会看到的那行字**(渲染端把 `error` 原样画在设置页的红字上,
        // 见 `CustomModelsPanel.tsx` 的 setTest)。所以必须跟同一个 catch 里其它分支
        // (「认证失败:Token/Key 被拒绝 (401)」那几句)一样是中文 —— 别看着旁边
        // `detail` 那两句是英文就跟着写英文,那两句走的不是这条路。
        return {
          ok: false,
          error: sawInit
            ? "握手通了,但模型一句话都没答 —— 端点能连上,是这个模型名它不认"
            : "没收到握手消息(endpoint did not send an init message)",
        };
      }
    }
    // The stream ended without the model ever answering. When the handshake
    // DID come back we say exactly that instead of the misleading "no init
    // message" (which sends the user hunting for a transport problem that
    // doesn't exist — the endpoint is reachable, it just never produced an
    // answer for the probed model).
    if (sawInit) {
      return {
        ok: false,
        error: "握手通了,但模型一句话都没答 —— 端点能连上,是这个模型名它不认",
      };
    }
    return { ok: false, error: "endpoint did not send an init message" };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // Translate the most common failure modes into friendlier text, keeping a
    // short excerpt of the raw cause — bridge-relayed upstream errors embed
    // the gateway's own words (e.g. one-api's "无可用渠道"), which is often
    // the actual reason a 401/503 fired (token↔model binding, not bad auth).
    const excerpt = `;上游返回: ${msg.replace(/\s+/g, " ").slice(0, 160)}`;
    if (/401|unauthorized|invalid.*key|invalid_api_key|invalid.*token/i.test(msg)) {
      return { ok: false, error: `认证失败:Token/Key 被拒绝 (401) — 检查认证方式是否选对 (Bearer vs x-api-key)${excerpt}` };
    }
    if (/403|forbidden/i.test(msg)) {
      return { ok: false, error: `无权访问 (403) — 该 Token 无此模型权限${excerpt}` };
    }
    if (/503|no available channel|无可用渠道/i.test(msg)) {
      return { ok: false, error: `网关无此模型渠道 (503):确认「模型名」与「别名映射」是否匹配该网关${excerpt}` };
    }
    if (ac.signal.aborted || /abort/i.test(msg)) {
      return { ok: false, error: `连接超时(${TEST_TIMEOUT_MS / 1000}s),请检查 Base URL 或网络` };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
