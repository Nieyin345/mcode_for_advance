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
import type { EventItemFactKey, HookEvent } from "@contracts/hook";

/** 列表最多列这么多项,剩下的折成一句"还有几个"。文件连着变(churn)时一串路径能上千,
 *  全塞进提示词纯属浪费 token —— 而模型要的是"变了些文件"这个事实,不是清单本身。 */
const MAX_LISTED = 20;

/** 一次触发的载荷。判别联合,与 `@contracts/nodeType` 的 `TriggerSpec` 一一对应。 */
export type TriggerPayload =
  | { kind: "manual" }
  | { kind: "schedule"; at: number }
  | { kind: "file"; files: readonly string[] }
  | {
      kind: "event";
      event: HookEvent;
      toolName?: string;
      subjects?: readonly string[];
      /**
       * **这件事是关于哪一条** —— 只有资料库那两种事件带得出(见
       * `@contracts/hook` 的 `HOOK_EVENT_ITEM_FACT_FIELDS`)。
       *
       * ## 为什么它非有不可
       *
       * 一条「下载完自动转 Markdown」的自动化,被叫起来时**必须知道是哪一条下完了**。
       * 没有它,那条指令只能让模型去查"库里最新的一条" —— 而下载是**并发**的、失败的
       * 那条也会发事件,于是它转的可能压根不是触发它的那一篇,而且**不报错**。
       *
       * ## 为什么是**一串**而不是一条
       *
       * 触发器有个「合并窗口」(默认 2 秒):窗口里连着来的事件**合成一次运行**。而下载
       * 是并发跑的 —— 两篇论文同时下完,落在同一个窗口里,于是这次运行要办的是**两条**。
       *
       * 早先这里只留"最后那一条"(同一格反复覆盖),表现是**第二条静默顶掉第一条**:
       * 载荷里只有一条,模型只办一条,另一篇**再也没人管** —— 而它明明已经下完了。
       * 文件那一路本来就没这毛病(`files` 是往里 push 的),事件这一路漏了。
       *
       * ## 为什么不塞进 `subjects`
       *
       * `subjects` 是 `matcher` 拿去比的东西,而这两个事件**没有可筛的维度**
       * (`hookSubjectOf` 对它们返回 null,`validateTrigger` 也据此拒掉写了筛选规则的
       * 配置)。塞进去等于告诉模型"可以拿它筛",而用户照着配会被当场拦下。
       */
      items?: readonly Partial<Record<EventItemFactKey, string>>[];
    };

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
  /**
   * 「这件事是关于哪一条」—— 只有资料库那两个事件有(见 `TriggerPayload.items`)。
   *
   * 它在这里是**拍平**的(`itemId` / `itemKind` / `itemTitle` / `pdfPath`),不是嵌一层
   * 对象:变量系统认的是**平面**的 `{{trigger.<key>}}`(同 `kind` / `at` / `files`),
   * 嵌一层的话用户得写 `{{trigger.item.itemId}}`,而 `expandTriggerVars` 只按字面查一个
   * 键,解不出来。名字带 `item` 前缀正是为了不和 `kind` 撞(见 `HOOK_EVENT_ITEM_FACT_FIELDS`)。
   *
   * ⚠️ **合并窗口里进来好几条时,这里只带得出第一条**(与 `files` 那种"全都在"不同):
   * 这个名字是单数,而 `expandTriggerVars` 把数组摊成 `a、b` —— 一个 `{{trigger.itemId}}`
   * 写出"两个 id 用顿号连着"对模型毫无意义(它没法拿它调工具)。多条的情形写在
   * `describeTriggerPayload` 那段人话里,指令让模型看的是**那一段**。
   * 计数看 {@link TriggerPayloadFacts.itemCount}。
   */
  itemId?: string;
  itemKind?: string;
  itemTitle?: string;
  /** 库内**相对**路径 —— 绝对路径要消费方自己拼库根(同事件载荷里那个字段)。 */
  pdfPath?: string;
  /** 这次合并窗口里一共攒了几条(资料库那两个事件才有)。只有一条时不出现。 */
  itemCount?: number;
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
    case "event": {
      // 条目那几项**拍平进来**(见 `TriggerPayloadFacts.itemId` 上的说明)。合并窗口里
      // 攒了好几条时,take 第一条 —— 单数名字与 `describeTriggerPayload` 那段人话里的
      // "共 N 条"配套。
      const first = payload.items?.[0];
      return {
        kind: "event",
        event: payload.event,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        ...(payload.subjects !== undefined ? { subjects: [...payload.subjects] } : {}),
        ...(first ?? {}),
        ...(payload.items !== undefined && payload.items.length > 1 ? { itemCount: payload.items.length } : {}),
      };
    }
  }
}

/**
 * 合并窗口里又来了一条事件 → 攒成**下一次要跑的那个载荷**。纯函数,执行器只管调。
 *
 * ## 为什么单独成函数
 *
 * 这段逻辑压在 `automationRunner.onEvent` 里,而那个文件要真起 `fs.watch`、真起会话
 * —— 里面写错了验不出来(同 `describeTriggerPayload` 被从这个文件拆出去的理由:
 * `hooks/runCommand.ts` 与 `HookRunner` 的分法)。而它**已经错过一次**:
 *
 *   早先这里是 `pending.event = {…}` —— **直接赋值**。触发器有合并窗口(默认 2 秒),
 *   而下载是并发跑的:两篇论文同时下完,两条 `library.item.downloaded` 落在同一个窗口
 *   里,于是**后一条静默顶掉前一条**。载荷里只剩一条,模型只转一条,另一篇**再也没人
 *   管**,而且不报错。文件那一路(`pending.files` 是 push 的)本来就没这毛病。
 *
 * ## 谁覆盖、谁累加
 *
 * - **事件名 / 工具名 / 主语**:覆盖。它们描述的是"这是个什么事件",窗口里最后那一条
 *   说的就是这次运行的样子(同一格只留一个计时器,本来也只会跑一次)。
 * - **条目**:累加。它描述的是"**有几件事要办**",少一件就是少干一件活。
 *
 * 去重按 `itemId`:同一条被重复通知(重试、两次 `finalize`)时不该办两遍。
 */
export function mergeEventPayload(
  prior: TriggerPayload | undefined,
  event: HookEvent,
  facts: { toolName?: string; subjects?: readonly string[] },
  item: Partial<Record<EventItemFactKey, string>> | undefined,
): TriggerPayload {
  const items = prior?.kind === "event" ? [...(prior.items ?? [])] : [];
  if (item !== undefined) {
    const id = item.itemId;
    const seen = id !== undefined && items.some((existing) => existing.itemId === id);
    if (!seen) items.push(item);
  }
  return {
    kind: "event",
    event,
    ...(facts.toolName !== undefined ? { toolName: facts.toolName } : {}),
    ...(facts.subjects !== undefined ? { subjects: facts.subjects } : {}),
    ...(items.length > 0 ? { items } : {}),
  };
}

/** 把载荷渲染成一段平实的话(整段就是提示词里 `task` 之后那一半)。 */export function describeTriggerPayload(payload: TriggerPayload): string {
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
      const items = itemBlock(payload.items);
      return items === "" ? `${parts.join(",")}。` : `${parts.join(",")}。\n${items}`;
    }
  }
}

/**
 * 「是哪一条」那几行的渲染。
 *
 * ## 为什么单独成块、而且明写标题
 *
 * 这一段是**模型接着 `task` 读到的东西**。资料库事件的那条指令要说的事("把这一条转成
 * Markdown 挂回去")全靠它 —— 光把 id 串在事件名后面(`发生了「library.item.downloaded」,
 * itemId=lib_xx`)的话,模型得自己反应过来那个 id 是"该处理的那一条";而条目 id 在
 * 整个库里到处都是,它不是个一眼认得出的东西。
 *
 * 写成 **`条目:✕✕✕(id=…,类型 paper)`** 是让人和模型都一眼看懂:哪一篇、拿哪个 id 去调
 * 工具。`pdfPath` 单独一行,而且照实说它是**库内相对路径** —— 外部的转录工具要的是绝对
 * 路径,而把它错当成绝对路径喂出去,报的是一句"文件不存在",看不出是路径的问题。
 *
 * ## 为什么可以有好几条
 *
 * 合并窗口里进来的几条**全都是这次运行要办的**(见 `TriggerPayload.items`)。所以这里
 * 一条一行地列出来,并且**明说一共几条** —— 模型读到一条时不会想到还有第二条;而少办
 * 一条的表现是那篇论文**永远没人转**,不报错。
 */
function itemBlock(
  items: readonly Partial<Record<EventItemFactKey, string>>[] | undefined,
): string {
  if (items === undefined || items.length === 0) return "";
  // 单条时(绝大多数)不加序号:序号会让模型以为那是个编号,而它没有含义。
  const many = items.length > 1;
  const head = many ? [`一共有 ${items.length} 条,这次都要办:`] : [];
  return [...head, ...items.map((item, i) => oneItem(item, many ? i + 1 : undefined))].join("\n");
}

/** 一条的几行(见 {@link itemBlock})。 */
function oneItem(item: Partial<Record<EventItemFactKey, string>>, ordinal?: number): string {
  const bits = [
    item.itemKind !== undefined ? `类型 ${item.itemKind}` : "",
    item.itemId !== undefined ? `id=${item.itemId}` : "",
  ].filter(Boolean);
  const head = item.itemTitle !== undefined ? item.itemTitle : "(没给标题)";
  const lines = [`条目${ordinal !== undefined ? `${ordinal}` : ""}:${head}${bits.length > 0 ? `(${bits.join(",")})` : ""}`];
  if (item.pdfPath !== undefined) {
    lines.push(`PDF(库内相对路径):${item.pdfPath}`);
  }
  return lines.join("\n");
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