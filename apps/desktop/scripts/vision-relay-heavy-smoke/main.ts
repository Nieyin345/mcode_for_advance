/**
 * Headless smoke for **视觉中继的重那半** —— `main/lib/visionRelay.ts`。
 *
 * ## 为什么需要这一套（补的是哪里）
 *
 * `vision-relay-smoke` 覆盖**零依赖的那半** `visionRelayCore.ts`（挑模型 / 提示词 / 一次性
 * 消息块形状）。`visionRelay.ts`（读设置、走既有 SDK 链路、发 query、兜失败）**一套都没覆盖**
 * —— 而它身上有报告 D10 点名的那条最会静默的语义：
 *
 *   **空描述绝不能冒充成功。** 模型返回空 / 调用失败 / 没配模型 → 必须 `{ok:false,error}`，
 *   由调用方把这句话交给 agent；绝不返回一个空字符串假装"图是空的"。
 *
 * ## 这一套怎么驱动真的 `describeImage`
 *
 * 只在 SDK 边界换桩（`--alias:@anthropic-ai/claude-agent-sdk`）—— 换桩点就是引擎真正收东西
 * 的那一句 `query({ prompt, options })`。于是"转述请求真的带了 `tools:[]`（图里写着'跑一下
 * 这条命令'也没有东西可跑）/ 图真的进了消息流的 content block / 复用既有链路"变成**可断言的
 * 真实入参**，而不是靠读注释相信。
 *
 * ## 覆盖的判据
 *   ① 未配置 → `{ok:false}`（不拿空模型名去请求，也不是静默成功）；
 *   ② 正常 → 拿到文字描述，`model` 标签正确，`options.tools` 为空、`maxTurns:1`、真传了 abortController；
 *   ③ 图片**真的**进了消息流的 base64 image block（形状对，不是只有一段文字）；
 *   ④ 模型返回空 → **`{ok:false}`**（D10 那条，别把空当成功）；
 *   ⑤ 抛错 → 如实转述（认证 / 超时 / 403 / 其它各自成句）；
 *   ⑥ 并发上限：同时超过 MAX_IN_FLIGHT 时后续调用被**明确拒绝**（不排队烧额度）。
 *
 * ## 诚实边界
 *   桩按 SDK 的**公开形状**复刻 query 的入参/消息序列；本套证的是"宿主交给 SDK 的入参"与
 *   "失败是否如实"。**真** claude 二进制读到图之后如何看、闭源网关是否支持视觉，仍须活会话验收。
 *
 * Run: scripts/vision-relay-heavy-smoke/run.sh
 */
import { describeImage, visionRelayConfigured } from "@main/lib/visionRelay.js";
import { UI_VISION_RELAY_MODEL_SETTING_KEY } from "@main/lib/visionRelayCore.js";
import { SettingRepo } from "@main/store/repositories.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

interface VisionDelivery {
  calls: number;
  options: Record<string, unknown> | null;
  promptIsIterable: boolean | null;
  contentBlocks: unknown[] | null;
}
const g = globalThis as unknown as { __visionDelivery?: VisionDelivery };
function reset(): VisionDelivery {
  g.__visionDelivery = { calls: 0, options: null, promptIsIterable: null, contentBlocks: null };
  return g.__visionDelivery;
}
delete process.env["MCODE_SMOKE_VISION_MESSAGES"];
delete process.env["MCODE_SMOKE_VISION_THROW"];

const PNG = "iVBORw0KGgoAAAANSUhEUg=="; // 一小段 base64（内容不重要，形状才重要）

try {
  /* ═════════════ §A 未配置 → 能力不存在，不拿空模型名去请求 ═════════════ */
  console.log("\n§A 未配置视觉中继模型");
  {
    (SettingRepo as unknown as { __reset?: () => void }).__reset?.();
    check("未配 → visionRelayConfigured() = false", visionRelayConfigured() === false);
    const d = reset();
    const r = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 未配 → ok:false（不是静默成功）", r.ok === false, r);
    check("★ 未配 → 根本没起 query（没白等一次超时）", d.calls === 0, d.calls);
    check("未配 → 错误文案提示去哪配", !r.ok && /视觉中继/.test(r.error), r);
  }

  /* ═════════════ §B 正常 → 入参 + 图真的进去了 ═════════════ */
  console.log("\n§B 配了自定义模型 → 走既有链路，图进消息流");
  {
    SettingRepo.set(UI_VISION_RELAY_MODEL_SETTING_KEY, "cfg-1:vision");
    check("配了 → visionRelayConfigured() = true", visionRelayConfigured() === true);
    const d = reset();
    const r = await describeImage({ imageBase64: PNG, mimeType: "image/png", source: "shot.png" });
    check("★ 正常 → ok:true 且拿到文字描述", r.ok === true && r.text.includes("猫"), r);
    check("★ model 标签 = 配的那个端点:role", r.ok && r.model === "cfg-1:vision", r.ok ? r.model : r);
    check("★ options.tools = []（图里写着'跑命令'也没有东西可跑）",
      Array.isArray(d.options?.["tools"]) && (d.options?.["tools"] as unknown[]).length === 0, d.options?.["tools"]);
    check("★ options.maxTurns = 1（一次性转述，不接着跑）", d.options?.["maxTurns"] === 1, d.options?.["maxTurns"]);
    check("★ 真传了 abortController（超时能中断底层工作）", !!d.options?.["abortController"], typeof d.options?.["abortController"]);
    check("★ prompt 是消息流（带图必须走一次性流，不是纯文本 string）", d.promptIsIterable === true, d.promptIsIterable);
    const blocks = d.contentBlocks ?? [];
    const img = blocks.find((b) => (b as { type?: string }).type === "image");
    check("★ 图真的进了 content block（D10：不是只有一段文字）", !!img, blocks);
    const src = (img as { source?: { type?: string; media_type?: string; data?: string } } | undefined)?.source;
    check("★ image block 形状对：source.type=base64 / media_type / data",
      src?.type === "base64" && src?.media_type === "image/png" && typeof src?.data === "string",
      src);
    check("★ 媒体类型字段名是 media_type（不是 mediaType —— 写错图就静默丢了）",
      src !== undefined && !("mediaType" in (src as object)), src);
  }

  /* ═════════════ §C 模型返回空 → 必须如实失败（D10 核心）═════════════ */
  console.log("\n§C 模型返回空描述");
  {
    SettingRepo.set(UI_VISION_RELAY_MODEL_SETTING_KEY, "cfg-1:vision");
    process.env["MCODE_SMOKE_VISION_MESSAGES"] = JSON.stringify([
      { type: "assistant", message: { content: [{ type: "text", text: "   " }] } },
      { type: "result", subtype: "success", is_error: false, result: "" },
    ]);
    reset();
    const r = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 空描述 → ok:false（绝不返回空串假装'图是空的'）", r.ok === false, r);
    check("★ 空描述 → 错误文案说明可能不支持图片/被网关拒", !r.ok && /视觉中继模型/.test(r.error), r);
    delete process.env["MCODE_SMOKE_VISION_MESSAGES"];
  }

  /* ═════════════ §D 抛错 → 如实转述 ═════════════ */
  console.log("\n§D 调用抛错");
  {
    SettingRepo.set(UI_VISION_RELAY_MODEL_SETTING_KEY, "cfg-1:vision");
    process.env["MCODE_SMOKE_VISION_THROW"] = "401 Unauthorized: invalid api key";
    reset();
    const r = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 认证失败 → ok:false 且文案点名 Token/Key", r.ok === false && /Token\/Key/.test(r.error), r);
    process.env["MCODE_SMOKE_VISION_THROW"] = "some random transport failure";
    reset();
    const r2 = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 其它失败 → ok:false 且带回原始原因（不吞）",
      r2.ok === false && /视觉转述失败/.test(r2.error), r2);
    process.env["MCODE_SMOKE_VISION_THROW"] = "403 Forbidden";
    reset();
    const r3 = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 403 → ok:false 且单独成句", r3.ok === false && /403/.test(r3.error), r3);
    delete process.env["MCODE_SMOKE_VISION_THROW"];
  }

  /* ═════════════ §E 内置模型（不传 env，继承本机登录态）═════════════ */
  console.log("\n§E 内置模型");
  {
    SettingRepo.set(UI_VISION_RELAY_MODEL_SETTING_KEY, "@claude:sonnet");
    const d = reset();
    const r = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 内置 → ok:true", r.ok === true, r);
    check("★ 内置 → model 标签是 @claude:sonnet", r.ok && r.model === "@claude:sonnet", r.ok ? r.model : r);
    check("★ 内置 → 不传 env（继承本机登录态）", d.options?.["env"] === undefined, d.options?.["env"]);
  }

  /* ═════════════ §F 并发上限 ═════════════ */
  console.log("\n§F 并发上限（不排队烧额度）");
  {
    SettingRepo.set(UI_VISION_RELAY_MODEL_SETTING_KEY, "cfg-1:vision");
    reset();
    // 桩的 query 会立即 yield，但 describeImage 里 inFlight 直到 finally 才减。
    // 先发 3 个**不 await** 的调用把 inFlight 占满，第 4 个应被拒。
    const inflight = [0, 1, 2].map(() => describeImage({ imageBase64: PNG, mimeType: "image/png" }));
    const over = await describeImage({ imageBase64: PNG, mimeType: "image/png" });
    check("★ 超过并发上限 → 明确拒绝（不静默排队）", over.ok === false && /最多/.test(over.error), over);
    const settled = await Promise.all(inflight);
    check("○ 上限内的三个都正常返回（上限没误伤）", settled.every((s) => s.ok === true), settled.map((s) => s.ok));
  }

  /* ═════════════ §G 诚实边界 ═════════════ */
  console.log("\n§G 边界（仍需活模型验收，不在本套件）");
  check("○ 本套件只证「宿主交给 SDK 的入参」与失败是否如实；真二进制如何看图/网关是否支持视觉 = 活会话验收", true);
} finally {
  (SettingRepo as unknown as { __reset?: () => void }).__reset?.();
}

console.log(`\nvision-relay-heavy-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
