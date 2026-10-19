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
import { capOldest, EVENT_ITEM_FACT_KEYS, type EventItemFactKey, type FileChange, type HookEvent } from "@contracts/hook";

/** 列表最多列这么多项,剩下的折成一句"还有几个"。文件连着变(churn)时一串路径能上千,
 *  全塞进提示词纯属浪费 token —— 而模型要的是"变了些文件"这个事实,不是清单本身。 */
const MAX_LISTED = 20;

/**
 * 【MC-091】合并窗口里**事件条目**的容量上限。一件事最多带这么多条 `items` 进载荷 ——
 * 超出的丢最早的,丢了几条如实报进 `itemsOverflowDropped`。选 100 的理由:一次合并窗口
 * 里"要办的事"通常个位数;上百条已经远超"这一批"的语义,再往上只是让载荷无界膨胀、
 * 拖慢 `items.some` 的去重(那是随条目数线性上升的)。
 */
const MAX_EVENT_ITEMS = 100;

/** 一次触发的载荷。判别联合,与 `@contracts/nodeType` 的 `TriggerSpec` 一一对应。 */
export type TriggerInputValues = Readonly<Record<string, string | readonly string[]>>;

export type TriggerPayload =
  | { kind: "manual" }
  | { kind: "schedule"; at: number }
  | {
      kind: "file";
      files: readonly string[];
      /**
       * 【ARC-015①】结构化变更:`{ path, kind }` 列表,`kind` ∈ created/modified/deleted/
       * renamed/unknown。**与 `files` 并列而不是取代它** —— `files` 是"还在的、要办的
       * 文件"(排除删除、临时文件之后那一份),`changes` 是"这一批到底发生了什么变更"。
       *
       * 为什么要有它:`files` 只装得下"存在"的文件,**删除/改名方向根本没有地方说** ——
       * 模型拿到 `files` 时看不出"这个文件是被删了"还是"从没出现过"。`unknown` 是**刻意
       * 保留**的一档;`fs.watch` 只给事件类型 + 文件名,删除/改名方向不可靠,老实标
       * unknown(见 `@contracts/hook` 的 `classifyFileChange`)。
       *
       * ⚠️ 只在**真的分得出来**的时候给(攒着期间每个路径都有过观察)。空/缺省时不带这个键
       * (同 `overflowDropped`/`itemCount` 的口径:别多一个恒空的数组)。
       */
      changes?: readonly FileChange[];
      /**
       * 【ARC-015】这次载荷里**因为积压超限被丢掉**了多少条路径(未丢时为 undefined)。
       *
       * 一条长期抖动的目录会把攒着的队列顶到上限,实现只保留最近的若干条 —— 但**丢了
       * 几条必须说出来**,否则模型以为它办的是全部,少办的那些永远没人办、也不报错。
       * 与 `itemCount` 同一个立场(载荷里可选、不进「插入变量」菜单):它只在**真丢了**
       * 的时候才出现,列进菜单等于让用户插一个多半取不到的名字。
       */
      overflowDropped?: number;
      /** 自定义 UI「运行前输入」带来的值(见 `@contracts/customUi` 的 inputs)。 */
      input?: TriggerInputValues;
    }
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
      /**
       * 【MC-091】这次载荷里**因为合并窗口积压超限被丢掉**了多少条 `items`(未丢时 undefined)。
       *
       * 与 file 那一路的 `overflowDropped` 同一个立场:一条持续吐不同 `itemId` 的事件流
       * (例如一批并发下载被不断触发)会让合并窗口里的 `items` **只涨不落** —— 必须有个
       * 容量上限,且**丢了几条必须说出来**,否则模型以为它看到的是全部,少办的那些永远
       * 没人办、也不报错。同 `overflowDropped`/`itemCount` 的口径:只在**真丢了**的时候才出现。
       */
      itemsOverflowDropped?: number;
      /**
       * **这次运行的落点分类**(2026-09-28)。只有自定义 UI 的 `targetMode: "context"`
       * 那条路带得出:用户在某个分类上右键「文献导入」,意思是"收进**这个**分类"。
       *
       * 真正的资料库事件**没有**这一项 —— 一条条目可以同时在好几个分类里,事件说的是
       * "这一条变了",不是"哪个分类变了"。所以它不进 `TRIGGER_PAYLOAD_FACTS_OF` 的
       * 候选名单(同 `itemCount` 的理由:列一个多半取不到的名字只会害人)。
       */
      collectionId?: string;
      /** 自定义 UI「运行前输入」带来的值(见 `@contracts/customUi` 的 inputs)。 */
      input?: TriggerInputValues;
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
  /**
   * 【ARC-015①】结构化变更(`{ path, kind }`,kind ∈ created/modified/deleted/renamed/
   * unknown)。只有 file 有,**且只在真的分得出方向时才给键**(同 `overflowDropped` 口径)。
   *
   * ## 为什么它和 `files` 是两份而不是一份
   *
   * `files` 只装得下"存在、要办"的那些文件 —— 一次 `deleted` 在这份列表里**没有位置**,
   * 模型看到 `files` 时根本分不出"这个文件被删了"和"从没出现过"。`changes` 补的就是这条
   * 方向信息。`unknown` 是**刻意保留**的档(`fs.watch` 的 `rename` 对新建/删除/改名一律
   * 报同一个类型,方向不可靠),不是没做完。
   *
   * ## 为什么**故意不进「插入变量」菜单**
   *
   * 它是**数组套对象**,不是标量 —— `expandTriggerVars` 只按字面查一个键、把数组摊成
   * `a、b`,对一串对象毫无意义(同 `TriggerPayloadFacts.items` 的理由)。代码节点直接读
   * `data.trigger.changes[i].kind`;`{{trigger.changes}}` 这种写法解不出来,列进菜单等于
   * 诱人踩坑。
   */
  changes?: readonly FileChange[];
  /**
   * 【ARC-015】这次载荷里因积压超限**被丢掉**的条数(未丢时不出现)。只有 file 有。
   *
   * 与 `itemCount` 同一口径:只在**真丢了**的时候才给键 —— 消费方据此知道"这次输入
   * 不完整",而不是把一份被截断的列表当成全部。**故意不进「插入变量」菜单**(见
   * `TRIGGER_PAYLOAD_FACTS_OF`):它多半取不到,列出来只会诱使用户写一个一定解不出的名字。
   */
  overflowDropped?: number;
  /** 事件名(`@contracts/hook` 的 `HookEvent`)。只有 event 有。 */
  event?: HookEvent;
  toolName?: string;
  subjects?: readonly string[];
  /**
   * 「这件事是关于哪一条」—— 只有资料库那两个事件有(见 `TriggerPayload.items`)。
   *
   * 它在这里是**拍平**的(`itemId` / `itemTitle` / `pdfPath`),不是嵌一层
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
  itemTitle?: string;
  /** 库内**相对**路径 —— 绝对路径要消费方自己拼库根(同事件载荷里那个字段)。 */
  pdfPath?: string;
  /** Optional path supplied by generic document imports. */
  filePath?: string;
  /** 这次合并窗口里一共攒了几条(资料库那两个事件才有)。只有一条时不出现。 */
  itemCount?: number;
  /**
   * **这次窗口里的全部条目**(可能不止一条)。与上面那三个单数字段的差别是
   * **一个都不少**。
   *
   * ## 为什么非有它不可(2026-09-24 补)
   *
   * 上面那三个字段是**拍平的第一条** —— 那是给 `{{trigger.itemId}}` 这种**文本插值**
   * 用的(多条的情形写在 `describeTriggerPayload` 那段人话里,给读人话的模型看)。
   * 但**代码节点不读人话**:它的 stdin 收到的是这份事实对象本身(`data.trigger`),
   * 按字段取值。只给第一条的话,合并窗口里"两篇同时下完"时 **code 节点只会转第一篇,
   * 另一篇静默漏掉** —— 而那正是「下载完自动转 Markdown」这条自动化最常遇到的形状
   * (下载是并发跑的)。
   *
   * 所以这里再给一份**结构化的**完整列表。多出来的那点载荷是划算的:漏一条的代价是
   * 那篇**永远没人转**,而且不报错。
   *
   * 形状是**数组套对象**而不是几个平行数组:消费方(那段 Python)要按条取
   * `items[i]["itemId"]` / `items[i]["pdfPath"]`,而平行数组一旦哪个短了一截,
   * 就会取到别人那一条 —— 那种错位同样不报错,只是转错了论文。
   */
  items?: ReadonlyArray<Partial<Record<EventItemFactKey, string>>>;
  /**
   * 【MC-091】合并窗口积压超限时**被丢掉**的事件条目数(未丢时不给键)。
   *
   * 与 file 那一路的 `overflowDropped` 同一立场:`items` 现在有容量上限(见
   * `MAX_EVENT_ITEMS`),达到上限丢最早的。**丢了几条必须说出来** —— 模型读到一份
   * 不完整列表却以为它是全部,少办的那些永远没人办、也不报错。代码节点读
   * `data.trigger.itemsOverflowDropped` 就知道"这次看到的不是全部"。
   */
  itemsOverflowDropped?: number;
  /**
   * **用户手动起的这一次**(右键自定义 UI / 「立刻运行一次」)。`payloadFactsOf` 不产出它 ——
   * 载荷本身分不出手动与自动,是 `automationRunner.fire` 按 `manual` 选项补上的。
   */
  manual?: true;
  /**
   * 落点分类(见 `TriggerPayload` 的同名字段)。代码节点按 `trigger.collectionId` 取,
   * 拿它拼 `importFiles.collectionIds`。
   */
  collectionId?: string;
  /**
   * 运行前输入,**拍平**成 `input.<key>`(与 `itemId` 拍平同一个理由:
   * `expandTriggerVars` 按字面查一个键,而 `TRIGGER_REF_RE` 的键名允许点 ⟹
   * `{{trigger.input.doi}}` 直接可解,变量系统零改动)。files 类输入是路径数组,
   * 文本插值时按「、」连;代码节点从 `data.trigger` 按键取原值。
   */
  [key: `input.${string}`]: string | readonly string[] | undefined;
}

/**
 * 来自 SDK/Hook 的条目字段不是 JSON schema 已验证对象。
 * 只取 contracts 里列出的字符串事实，避免运行时多余字段（kind/event/
 * toolName/__proto__）经 {...first} 覆盖这一次真实的触发来源。
 */
function snapshotEventItem(item: Partial<Record<EventItemFactKey, string>>): Partial<Record<EventItemFactKey, string>> {
  const out: Partial<Record<EventItemFactKey, string>> = {};
  if (typeof item !== "object" || item === null || Array.isArray(item)) return out;
  for (const key of EVENT_ITEM_FACT_KEYS) {
    const value = Object.hasOwn(item, key) ? item[key] : undefined;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** input 值表 → 拍平的 `input.<key>` 键(空表 → 不加键,同 items 的口径)。 */
function inputFactsOf(input: TriggerInputValues | undefined): Record<string, string | readonly string[]> {
  if (input === undefined) return {};
  const out: Record<string, string | readonly string[]> = {};
  for (const [k, v] of Object.entries(input)) out[`input.${k}`] = Array.isArray(v) ? [...v] : v;
  return out;
}

/** 从载荷里取平面事实。**纯函数**:拷贝数组,调用方改不动原载荷。 */
export function payloadFactsOf(payload: TriggerPayload): TriggerPayloadFacts {
  switch (payload.kind) {
    case "manual":
      return { kind: "manual" };
    case "schedule":
      return { kind: "schedule", at: payload.at };
    case "file":
      return {
        kind: "file",
        files: [...payload.files],
        // 【ARC-015①】**有变更方向才给键**(同 overflowDropped/itemCount 的口径:别多一个
        // 恒空的数组,那会让"这次带没有带方向"多一个永远为假的答案)。深拷一层,
        // 调用方改不动原载荷里的对象。
        ...(payload.changes !== undefined && payload.changes.length > 0
          ? { changes: payload.changes.map((c) => ({ ...c })) }
          : {}),
        // **真丢了才给键**(同 `itemCount` 的口径)—— 一份没截断的列表不该多一个恒为 0 的
        // `overflowDropped`,那会让"这次输入完整吗"这个问题多一个永远为假的答案。
        ...(payload.overflowDropped !== undefined && payload.overflowDropped > 0
          ? { overflowDropped: payload.overflowDropped }
          : {}),
        ...inputFactsOf(payload.input),
      };
    case "event": {
      // 条目那几项**拍平进来**(见 `TriggerPayloadFacts.itemId` 上的说明)。合并窗口里
      // 攒了好几条时,take 第一条 —— 单数名字与 `describeTriggerPayload` 那段人话里的
      // "共 N 条"配套。
      const first = payload.items?.[0] === undefined ? undefined : snapshotEventItem(payload.items[0]);
      return {
        kind: "event",
        event: payload.event,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        ...(payload.subjects !== undefined ? { subjects: [...payload.subjects] } : {}),
        ...(first ?? {}),
        // **全部条目**都要给(见 `TriggerPayloadFacts.items`)—— 代码节点按它逐条办。
        // 只有一条时也给,让消费方不必写两套读法(单条在数组里就是一个元素)。
        //
        // ⚠️ **空数组不给键**,与 `itemCount` 同一口径:载荷里多一个恒空的 `items`
        // 会让「这次带得出哪几项」这个问题多一个永远为假的答案,而消费方还得为它写
        // 一个分支。
        ...(payload.items !== undefined && payload.items.length > 0
          ? { items: payload.items.map(snapshotEventItem) }
          : {}),
        ...(payload.items !== undefined && payload.items.length > 1 ? { itemCount: payload.items.length } : {}),
        // 【MC-091】合并窗口积压截断时,把"这次不完整"这件事实带进载荷 —— 与 file 那一路
        // 的 `overflowDropped` 同口径(只在真丢了时给键)。
        ...(payload.itemsOverflowDropped !== undefined && payload.itemsOverflowDropped > 0
          ? { itemsOverflowDropped: payload.itemsOverflowDropped }
          : {}),
        ...(payload.collectionId !== undefined ? { collectionId: payload.collectionId } : {}),
        ...inputFactsOf(payload.input),
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
  // 事件由 SDK/HookPort 异步交付；不能持有传入 item 对象的引用。
  // 合并窗口期间上游复用或修改了对象时，已经排队的事实必须保持当时快照。
  let items = prior?.kind === "event" ? (prior.items ?? []).map(snapshotEventItem) : [];
  let dropped = prior?.kind === "event" ? (prior.itemsOverflowDropped ?? 0) : 0;
  if (item !== undefined) {
    const safeItem = snapshotEventItem(item);
    const id = safeItem.itemId;
    const seen = id !== undefined && items.some((existing) => existing.itemId === id);
    if (!seen) items.push(safeItem);
  }
  // 【MC-091】合并窗口里的事件条目**必须有界**。从前 `items` 只 push 不设上限,一条持续
  // 吐不同 `itemId` 的事件流会让它只涨不落(实测 1500 个唯一 itemId → 保留 1500),而
  // 载荷要整个进 `data.trigger` 与运行历史。达到上限时丢**最早**的(与文件那一路同一取舍),
  // 并把丢的条数**如实累加**进 `itemsOverflowDropped` —— 静默截断是这一路最坏的坏法。
  // 截断走**唯一一份** `capOldest`(MC-091 统一截断原语,与 `addToFileBacklog` 同源)。
  const { kept, dropped: capDropped } = capOldest(items, MAX_EVENT_ITEMS);
  if (capDropped > 0) {
    items = kept;
    dropped += capDropped;
  }
  return {
    kind: "event",
    event,
    ...(facts.toolName !== undefined ? { toolName: facts.toolName } : {}),
    ...(facts.subjects !== undefined ? { subjects: [...facts.subjects] } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(dropped > 0 ? { itemsOverflowDropped: dropped } : {}),
  };
}

/** 把载荷渲染成一段平实的话(整段就是提示词里 `task` 之后那一半)。 */
function describeInput(input: TriggerInputValues | undefined): string {
  if (input === undefined) return "";
  const parts = Object.entries(input)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== ""))
    .map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join("、") : v}`);
  return parts.length === 0 ? "" : `带着输入:${parts.join(";")}`;
}

export function describeTriggerPayload(payload: TriggerPayload): string {
  switch (payload.kind) {
    case "manual":
      return "手动运行了一次。";
    case "schedule":
      return `到点了:${formatLocalMinute(payload.at)}。`;
    case "file": {
      const listed = capList(payload.files);
      const inputSaid = describeInput(payload.input);
      // 【ARC-015】被截断了就**明说**,别让模型把这份不完整的列表当成全部 —— 它得
      // 知道"可能还有文件没列出来",而不是以为办完这些就没事了。
      const overflow = payload.overflowDropped ?? 0;
      const overflowSaid = overflow > 0
        ? [`(输入被截断:因为有更多文件持续变化,更早的 ${overflow} 个没能带上 —— 这次看到的不是全部)`]
        : [];
      // 【ARC-015①】把**方向**也说出来:`files` 只列了"还在的",模型看不出"这个文件其实
      // 是被删了"。只列非 created/modified 的那些(那两类默认的"文件变了"已经覆盖),
      // 并且 `unknown` 老实说"看不出方向" —— 不编一个方向出来。
      const directionSaid = describeFileChanges(payload.changes);
      if (listed.shown.length === 0) {
        const head = inputSaid === "" ? "监听的文件有变化。" : "手动带着输入运行。";
        // 文件名可能因删除/过滤而为空，但手动运行提供的 input 仍是
        // 这次任务的真实参数；旧实现只说“带着输入”却漏了输入内容。
        return [head, ...directionSaid, ...overflowSaid, ...(inputSaid === "" ? [] : [inputSaid])].join("\n");
      }
      return [
        "有文件变了:",
        ...listed.shown.map((f) => `- ${f}`),
        ...(listed.rest > 0 ? [`(还有 ${listed.rest} 个没列出来)`] : []),
        ...directionSaid,
        ...overflowSaid,
        ...(inputSaid === "" ? [] : [inputSaid]),
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
      const inputSaid = describeInput(payload.input);
      // 【MC-091】条目被截断就**明说** —— 与 file 那一路的 overflowSaid 同一立场:
      // 让模型知道"这次看到的不是全部",而不是以为办完这些就没事了。
      const itemOverflow = payload.itemsOverflowDropped ?? 0;
      const itemOverflowSaid =
        itemOverflow > 0
          ? `(还有 ${itemOverflow} 条因为合并窗口积压没能带上 —— 这次看到的不是全部)`
          : "";
      const tail = [items, itemOverflowSaid, inputSaid].filter((s) => s !== "").join("\n");
      return tail === "" ? `${parts.join(",")}。` : `${parts.join(",")}。\n${tail}`;
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
  // （itemKind 随 kind 退役删除。）
  const bits = [
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

/** 【ARC-015①】变更方向上的人话。只列**非 created/modified** 的那些(那两类"文件变了"
 *  已经覆盖),把 `deleted` / `renamed` / `unknown` 说清楚 —— 尤其 `unknown` 要**明说
 * 看不出方向**,绝不编一个方向出来。没有这类变更时返回空数组(不硬塞一行)。 */
function describeFileChanges(changes: readonly FileChange[] | undefined): string[] {
  if (changes === undefined || changes.length === 0) return [];
  const label: Record<FileChange["kind"], string> = {
    created: "新增",
    modified: "修改",
    deleted: "删除",
    renamed: "改名",
    unknown: "看不出方向(可能是新增/删除/改名)",
  };
  const worthListing = changes.filter((c) => c.kind !== "created" && c.kind !== "modified");
  if (worthListing.length === 0) return [];
  const listed = capList(worthListing.map((c) => `${label[c.kind]}:${c.path}`));
  return [
    "另有变更(不只是内容修改):",
    ...listed.shown.map((s) => `- ${s}`),
    ...(listed.rest > 0 ? [`(还有 ${listed.rest} 项没列出来)`] : []),
  ];
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