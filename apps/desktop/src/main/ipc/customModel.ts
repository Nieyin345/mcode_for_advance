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
import { errText, describeInputError } from "@main/lib/ipcError.js";
import {
  IPC,
  SaveCustomModelSchema,
  DeleteCustomModelSchema,
  TestCustomModelSchema,
  GetCustomModelTokenSchema,
} from "@contracts/ipc";
import type { ApiConfig, PublicMcpTunnelConfig } from "@contracts/customModel";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import {
  bridgeStatus,
  ensureStarted,
  regenerateToken,
} from "@main/providers/bridge/extensionBridge.js";
import {
  addPublicMcpProjectLink,
  regeneratePublicMcpProjectLinkSecret,
  regeneratePublicMcpSecret,
  removePublicMcpProjectLink,
  setPublicMcpEnabled,
  setPublicMcpProject,
  setPublicMcpTunnelConfig,
  startPublicMcpTunnel,
  stopPublicMcpTunnel,
} from "@main/providers/bridge/publicMcpSession.js";
import { publicMcpStatus } from "@main/providers/bridge/publicMcpServer.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";

/** Probe timeout — a healthy endpoint should answer the init handshake within
 *  a few seconds. We abort the SDK query after this to avoid hanging the UI. */
const TEST_TIMEOUT_MS = 30_000;

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

  // 公网 MCP 端点（给 ChatGPT 的 Connector 用）。与扩展桥是两条独立的通路：那条
  // 只给浏览器扩展（回环 + 扩展来源），这条给互联网上的远程客户端（路径密钥）。
  // ⚠️ setEnabled(true) 之后，拿到链接的人拥有本机完全操作权（无审批闸门）——
  // 设置页那张卡片必须把这句话写在用户看得见的地方。
  ipcMain.handle(IPC.PUBLIC_MCP_STATUS, async () => publicMcpStatus());

  ipcMain.handle(IPC.PUBLIC_MCP_SET_ENABLED, async (_evt, raw) => {
    let enabled: boolean;
    try {
      enabled = z.object({ enabled: z.boolean() }).parse(raw).enabled;
    } catch (err) {
      throw new Error(errText(err));
    }
    return setPublicMcpEnabled(enabled);
  });

  ipcMain.handle(IPC.PUBLIC_MCP_REGENERATE_SECRET, async () =>
    regeneratePublicMcpSecret());

  // 公网隧道:Mcode 自己 spawn cloudflared,把公网域名捞回来给 UI。
  ipcMain.handle(IPC.PUBLIC_MCP_START_TUNNEL, async () => startPublicMcpTunnel());
  ipcMain.handle(IPC.PUBLIC_MCP_STOP_TUNNEL, async () => stopPublicMcpTunnel());

  // 改沙箱目录(公网来的文件工具能碰哪个项目)。每次工具调用现读这个设置,
  // 所以改完下一次调用就生效,不用重启任何东西。
  ipcMain.handle(IPC.PUBLIC_MCP_SET_PROJECT, async (_evt, raw) => {
    let projectId: string | null;
    try {
      projectId = z.object({ projectId: z.string().nullable() }).parse(raw).projectId;
    } catch (err) {
      throw new Error(errText(err));
    }
    return setPublicMcpProject(projectId);
  });

  // 隧道配置(模式 / 自有域名 / Tunnel Token / 固定端口)。
  // **token 不做 min(1) 校验** —— 空串是合法输入,语义是"沿用已存的那串"
  // (界面只显示尾 4 位,用户不改它时不该被迫整串重粘一遍)。
  ipcMain.handle(IPC.PUBLIC_MCP_SET_TUNNEL_CONFIG, async (_evt, raw) => {
    let input: PublicMcpTunnelConfig;
    try {
      input = z
        .object({
          mode: z.enum(["quick", "named", "external"]),
          token: z.string().max(4096).optional(),
          hostname: z.string().max(253).optional(),
          mobileHostname: z.string().max(253).optional(),
          fixedPort: z.number().int().min(0).max(65535).optional(),
          // ⚠️ 少了这一项,zod 会把界面传来的委派开关**静默剥掉** —— 开关怎么点都开不了。
          agentDelegate: z.boolean().optional(),
          clearToken: z.boolean().optional(),
        })
        .parse(raw);
    } catch (err) {
      throw new Error(errText(err));
    }
    return await setPublicMcpTunnelConfig(input);
  });

  // 多项目并行:每个项目一条自己的链接(密钥 / 合成会话 / 沙箱各自独立)。
  const ProjectLinkInput = z.object({ projectId: z.string().min(1).max(200) });
  const parseProjectLink = (raw: unknown): string => {
    try {
      return ProjectLinkInput.parse(raw).projectId;
    } catch (err) {
      throw new Error(errText(err));
    }
  };
  ipcMain.handle(IPC.PUBLIC_MCP_ADD_PROJECT_LINK, async (_evt, raw) =>
    addPublicMcpProjectLink(parseProjectLink(raw)));
  ipcMain.handle(IPC.PUBLIC_MCP_REMOVE_PROJECT_LINK, async (_evt, raw) =>
    removePublicMcpProjectLink(parseProjectLink(raw)));
  ipcMain.handle(IPC.PUBLIC_MCP_REGENERATE_PROJECT_LINK_SECRET, async (_evt, raw) =>
    regeneratePublicMcpProjectLinkSecret(parseProjectLink(raw)));

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
        // ⚠️ 这两句 `detail` **会画在设置页那一行绿字上**(`CustomModelsPanel.tsx` 的
        //   `testStatus.detail`,成功态原样渲染)—— 不是内部标记。所以用中文,和同一个
        //   catch 里其它给用户看的句子一条口径。
        sawInit = ver ? `连接成功（SDK v${ver}）` : "连接成功";
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
          return { ok: true, detail: sawInit ?? "连接成功" };
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
    // ⚠️ 这一句也是**用户会看到的那行字**(渲染端原样画在设置页红字上)。它与上面
    // `result` 分支里那句「没收到握手消息(...)」是同一个判断、同一件事,所以必须
    // 用**同一句中文** —— 从前的英文 "endpoint did not send an init message" 是从
    // 那条中文里截出来的一半,同一页面上两种情况的说法一个中一个英。
    return { ok: false, error: "没收到握手消息(endpoint did not send an init message)" };
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
