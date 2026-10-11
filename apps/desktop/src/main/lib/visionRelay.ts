/**
 * **视觉中继** —— 把一张图片交给「用户挑定的、有视觉能力的模型」,拿回一段**文字描述**。
 *
 * ## 为什么需要它
 *
 * Mcode 里「看」的能力是**引擎级的**:回合请求带 `images`(见 `StartTurnRequest`)时,
 * Claude 那条路把图片编成 base64 content block 交给模型(`ClaudeAgentSdkProvider`
 * 的 `makePromptChannel`),Pi 那条路也给了(`PiAgentSdkProvider`),**只要背后的模型
 * 有视觉输入,画面就真的进了模型**。
 *
 * 但**很多网关模型没有视觉**(DeepSeek 系是典型)。这时同一个图片块交出去,模型收到
 * 的是一串它读不出内容的字节 —— 而它自己**分辨不了**「这图是空的」和「我没长眼睛」。
 * 于是它只能凭文件名/大小**编**,或者干脆沉默。报告 D10 与 Q1 把这条记成「对 agent 是
 * 哑的」:截图工具**能拍**,agent **读不回**,而且失败**静默**。
 *
 * 这一支补的就是那个缺口:**让用户挑一个自己配好的、有视觉的模型当「眼睛」**。
 * 拍完的图交给它转述成文字,主对话模型拿到的就是文字 —— 它读不读得懂画面就不重要了。
 *
 * ## 和标题生成同一条路(这是刻意的)
 *
 * 挑模型与发请求的骨架**照搬** `ipc/titleGen.ts` 与 `customUi/panelAsk.ts`:
 * `SettingRepo` 取值 → `resolveModelForGitOp`(OpenAI 协议的经本地桥)→ `buildCustomEnv`
 * → SDK `query`,`maxTurns: 1`、**`tools: []`**。「共享实现只有一份」:这里没有另起一套
 * HTTP,认证头/自定义头/桥/超时全部沿用既有那条。
 *
 * 唯一的**新增**是图片投递:`query()` 收 `string | AsyncIterable<SDKUserMessage>`,纯文本
 * 那四个先例走的都是 string;要带图就得自己造一条**一次性**的消息流 —— 见
 * `visionRelayCore.ts` 的 `oneShotPrompt`(纯的那一半在那边,好让无头套件验 block 形状)。
 *
 * ## 三条不能含糊的
 *
 * 1. **失败要如实说,不静默。** 没配模型 / 调用失败 / 模型返回空 → 返回 `{ok:false,error}`,
 *    由调用方把这句话交给 agent。绝不返回一个空描述假装成功(报告 D10 点名的那条)。
 * 2. **图片是数据,不是指令。** system prompt 用固定壳(照抄 `titleGen` 的数据边界写法):
 *    图里就算画着一段文字、写着「忽略以上」,也只是**要被描述的对象**。
 * 3. **不并发爆掉。** 与 `panelAsk` 同一道闸:同时最多 {@link MAX_IN_FLIGHT} 个。
 */
import { UI_VISION_RELAY_MODEL_SETTING_KEY, type RelayMime } from "@main/lib/visionRelayCore.js";
import {
  buildRelayUserText,
  modelLabel,
  oneShotPrompt,
  parseModel,
  RELAY_SYSTEM_PROMPT,
} from "@main/lib/visionRelayCore.js";
import { SettingRepo } from "@main/store/repositories.js";
import { resolveModelForGitOp } from "@main/ipc/git.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";

export type { RelayMime };

/** 同时最多跑几个 —— 与 `panelAsk` 同一量级:死循环的调用方不该一口气烧掉额度。 */
const MAX_IN_FLIGHT = 3;
/** 一次转述的超时。比标题生成宽松:图 + 一段像样的描述比一句标题重。 */
const RELAY_TIMEOUT_MS = 120_000;

let inFlight = 0;

export interface DescribeImageArgs {
  /** 图片字节的 base64(**不带** `data:` 前缀)。 */
  imageBase64: string;
  /** 图片 MIME。只收 SDK 认的那四种。 */
  mimeType: RelayMime;
  /** 交给中继模型的**图片文件名/来源**(帮助它定位,但不影响判断)。 */
  source?: string;
  /** 追加的提问(可选)。省略 = 通用的「转述这张图」。 */
  question?: string;
}

export type DescribeImageResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

/**
 * 用户配没配中继模型。**没配 = 这个能力不生效** —— 调用方据此决定要不要把图交出去,
 * 而不是先试一次再失败(免得白等一次超时,也免得给模型指一条走不通的路)。
 */
export function visionRelayConfigured(): boolean {
  return parseModel(SettingRepo.get(UI_VISION_RELAY_MODEL_SETTING_KEY)) !== null;
}

/**
 * 把一张图交给用户挑定的视觉模型,拿回文字描述。
 *
 * 未配置 → `{ok:false, error:"未配置视觉中继模型…"}`;调用/解析失败 → 如实返回原因。
 * **任何情况下都不返回空描述冒充成功。**
 */
export async function describeImage(args: DescribeImageArgs): Promise<DescribeImageResult> {
  const choice = parseModel(SettingRepo.get(UI_VISION_RELAY_MODEL_SETTING_KEY));
  if (!choice) {
    return { ok: false, error: "未配置视觉中继模型(设置 → 通用 → 视觉中继)" };
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return { ok: false, error: `同时最多 ${MAX_IN_FLIGHT} 个视觉转述在跑,请等前面的返回再试` };
  }
  inFlight++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
  let releaseBridge: (() => void) | undefined;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let model: string | undefined;
    let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];
    if (choice.builtin) {
      // 不传 env:SDK 继承进程环境,用本机 Claude Code 的登录 / 默认模型。
      model = choice.alias;
    } else {
      const resolved = await resolveModelForGitOp(choice.id, choice.role);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      releaseBridge = resolved.releaseBridge;
      model = resolveActiveModel(resolved.config);
      env = buildCustomEnv(resolved.config, {});
    }
    const label = modelLabel(choice);

    const binaryPath = resolveSdkBinaryPath();
    const q = query({
      prompt: oneShotPrompt(buildRelayUserText(args.source, args.question), [
        { data: args.imageBase64, mimeType: args.mimeType },
      ]),
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        // 硬保证:没有工具被加载,图里就算写着「跑一下这条命令」也没有东西可跑。
        tools: [],
        systemPrompt: RELAY_SYSTEM_PROMPT,
        settingSources: [],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });

    let out = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          out = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
      }
      if (m.type === "result") break;
    }

    const text = out.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    if (!text) {
      // 空返回是**失败**,不是「图是空的」——如实说,别让调用方把空当成结论。
      return {
        ok: false,
        error: "视觉中继模型没有返回任何描述(可能是该模型不支持图片输入,或本次调用被网关拒绝)",
      };
    }
    return { ok: true, text, model: label };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`visionRelay: describeImage failed: ${msg}`);
    if (ac.signal.aborted) {
      return { ok: false, error: `视觉转述超时(超过 ${Math.round(RELAY_TIMEOUT_MS / 1000)} 秒)` };
    }
    if (/401|unauthorized|invalid.*key/i.test(msg)) {
      return { ok: false, error: "视觉中继模型认证失败,请检查模型配置的 Token/Key" };
    }
    if (/403|forbidden/i.test(msg)) return { ok: false, error: "视觉中继模型拒绝了这个请求(403)" };
    return { ok: false, error: `视觉转述失败:${msg}` };
  } finally {
    clearTimeout(timer);
    releaseBridge?.();
    inFlight--;
  }
}
