/**
 * DeepSeek 网页版**内部**的私有帧格式。
 *
 * ⚠️ 与 DeepSeek 开放 API（`api.deepseek.com`，那是标准 OpenAI 格式 + `[DONE]`）
 * 是完全不同的两套东西。这里是它的网页端内部接口：
 *
 *   {"p":"response/content","v":"你"}             正文增量
 *   {"p":"response/thinking_content","v":"想"}    思考链增量
 *   {"p":"response/status","v":"FINISHED"}        状态宣告
 *
 * `p` 是"这条增量属于哪一路"的信封字段；另有 `response/search_results`、
 * `response/search_status`（联网检索）。
 *
 * ️ 上述 `p` 取值来自第三方逆向项目的观察，**未在本机实测**（实施计划 W4）。
 *    真机抓到的样本若与预期不符，只需改这一个文件 —— 这是把站点差异收敛在
 *    parser 里的意义所在。
 */
import type { FrameParser, TapEvent } from "./types.js";
import { firstString, isRecord, tryParseJson } from "./jsonUtil.js";

export const deepseekWebParser: FrameParser = {
  strategy: "deepseek-web",

  parse(payload: string): TapEvent[] {
    const parsed = tryParseJson(payload);
    if (!isRecord(parsed)) return [{ kind: "unknown", raw: payload }];

    const p = typeof parsed["p"] === "string" ? parsed["p"] : undefined;
    if (p === undefined) return [{ kind: "unknown", raw: payload }];

    const out: TapEvent[] = [];
    const id = firstString(parsed, ["response_message_id", "message_id"]);
    if (id !== undefined) out.push({ kind: "message-id", id });

    const v = parsed["v"];

    if (p === "response/content") {
      if (typeof v === "string" && v.length > 0) out.push({ kind: "text", text: v });
      return out;
    }
    if (p === "response/thinking_content") {
      if (typeof v === "string" && v.length > 0) out.push({ kind: "thinking", text: v });
      return out;
    }
    if (p === "response/status") {
      if (typeof v === "string" && v.length > 0) out.push({ kind: "status", status: v });
      return out;
    }
    // 检索类：一期不呈现，但**不算 unknown** —— 它是认识的形状，只是我们不显示。
    // 记成 unknown 的话，用户每次联网搜索都会刷一片"未知帧"日志，把真正的改版
    // 信号淹掉。
    if (p.startsWith("response/search")) {
      out.push({ kind: "status", status: p });
      return out;
    }

    return [{ kind: "unknown", raw: payload }];
  },

  isEnd(event: TapEvent): boolean {
    // 大小写宽容：这类状态串在不同版本里出现过全大写与首字母大写两种写法。
    return event.kind === "status" && event.status.toUpperCase() === "FINISHED";
  },
};