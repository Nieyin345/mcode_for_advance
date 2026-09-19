/**
 * 触发器**载荷文本** —— 被触发时那段"为什么现在跑"的话。
 *
 * 纯函数、无依赖,所以冒烟可以直接把每一种触发都断言一遍。它在这里而不是在
 * `automationRunner.ts` 里,是因为那个文件要真起会话、真起 `fs.watch` —— 混在一起
 * 两半都测不成(同 `hooks/runCommand.ts` 与 `HookRunner` 的分法)。
 *
 * 这段话的读者是**模型**:它接着 `task` 后面,告诉这次运行"是什么把它叫起来的"。所以
 * 用词要像人说话(「到点了:2026-09-16 09:00」),而不是把事件对象 JSON 塞进去 ——
 * 后者会让模型去猜字段含义,而它手里没有 schema。
 */
import type { HookEvent } from "@contracts/hook";

/** 列表最多列这么多项,剩下的折成一句"还有几个"。文件连着变(churn)时一串路径能上千,
 *  全塞进提示词纯属浪费 token —— 而模型要的是"变了些文件"这个事实,不是清单本身。 */
const MAX_LISTED = 20;

/** 一次触发的载荷。判别联合,与 `@contracts/nodeType` 的 `TriggerSpec` 一一对应。 */
export type TriggerPayload =
  | { kind: "manual" }
  | { kind: "schedule"; at: number }
  | { kind: "file"; files: readonly string[] }
  | { kind: "event"; event: HookEvent; toolName?: string; subjects?: readonly string[] };

/* ── 结构化事实(AUTO-10)── */

/**
 * 触发载荷的**平面事实形状** —— 给变量系统(VAR-06)消费的那一份。
 *
 * `TriggerPayload` 本身已经是结构化的,但它长在后台执行器手里;变量系统要的是
 * 「这次运行**为什么被触发、携带着什么**」的稳定命名:`kind` 是「为什么」,
 * 其余字段是「带了什么」。全部是标量与字符串数组 —— 能直接 JSON 化、能逐个映射成
 * `{{trigger.xxx}}` 一类的引用候选,**不掺实现细节**(绝对路径数组除外,那是文件
 * 触发天然的事实;相对化是消费方按自己的项目目录做的事)。
 *
 * 已经接进了 `NodeRunInput`:载荷事实经 `runner.entry.payload` 进 scheduler
 * (展开参数 + 注入 `data.trigger`),再由 `nodeInputBuilders.expandTriggerVars`
 * 在节点参数里展开 `{{trigger.*}}`(见那两处的接线)。
 */
export interface TriggerPayloadFacts {
  kind: TriggerPayload["kind"];
  /** 「到点了」那一刻(ms)。只有 schedule 有。 */
  at?: number;
  /** 触发时攒下的文件(绝对路径)。只有 file 有。 */
  files?: readonly string[];
  /** 事件名(`@contracts/hook` 的 `HookEvent`)。只有 event 有。 */
  event?: HookEvent;
  toolName?: string;
  subjects?: readonly string[];
}

/** 从载荷里取平面事实。**纯函数**:拷贝数组,调用方改不动原载荷。 */
export function payloadFactsOf(payload: TriggerPayload): TriggerPayloadFacts {
  switch (payload.kind) {
    case "manual":
      return { kind: "manual" };
    case "schedule":
      return { kind: "schedule", at: payload.at };
    case "file":
      return { kind: "file", files: [...payload.files] };
    case "event":
      return {
        kind: "event",
        event: payload.event,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        ...(payload.subjects !== undefined ? { subjects: [...payload.subjects] } : {}),
      };
  }
}

/** 把载荷渲染成一段平实的话(整段就是提示词里 `task` 之后那一半)。 */
export function describeTriggerPayload(payload: TriggerPayload): string {
  switch (payload.kind) {
    case "manual":
      return "手动运行了一次。";
    case "schedule":
      return `到点了:${formatLocalMinute(payload.at)}。`;
    case "file": {
      const listed = capList(payload.files);
      if (listed.shown.length === 0) return "监听的文件有变化。";
      return [
        "有文件变了:",
        ...listed.shown.map((f) => `- ${f}`),
        ...(listed.rest > 0 ? [`(还有 ${listed.rest} 个没列出来)`] : []),
      ].join("\n");
    }
    case "event": {
      const parts = [`发生了「${payload.event}」`];
      if (payload.toolName !== undefined) parts.push(`工具:${payload.toolName}`);
      const listed = capList(payload.subjects ?? []);
      if (listed.shown.length > 0) {
        parts.push(
          `涉及:${listed.shown.join("、")}${listed.rest > 0 ? `、…(还有 ${listed.rest} 项)` : ""}`,
        );
      }
      return `${parts.join(",")}。`;
    }
  }
}

/** 前 `MAX_LISTED` 项 + 剩下几项。 */
function capList(items: readonly string[]): { shown: string[]; rest: number } {
  return { shown: items.slice(0, MAX_LISTED), rest: Math.max(0, items.length - MAX_LISTED) };
}

/** `YYYY-MM-DD HH:mm`,**本地时间**。
 *
 *  不用 `toISOString()`:那是 UTC,而"到点了"这句话对的是**用户的表** —— 用户写
 *  `0 9 * * *` 想的是早上九点,cron 匹配也按本地时间算(见 `@contracts/cron`),这里显示
 *  成 UTC 的话会自相矛盾。也不引 `Intl`:一处格式化不值一个时区库。 */
function formatLocalMinute(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}