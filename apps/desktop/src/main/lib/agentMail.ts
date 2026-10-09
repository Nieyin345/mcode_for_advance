/**
 * **代理之间的消息投递** —— 一条会话找到另一条会话、把话递过去。
 *
 * ## 为什么需要它
 *
 * 工作流里每个 `mcode.agent` 节点跑在**独立的隐藏子会话**(`kind: "node"`),它们之间
 * 原本只有**沿图边的单向接力**(调度器的 `upstreamText` / `upstreamArtifacts`):A 的产出
 * 流到 B。**没有平级直接通信** —— 被派出去的一步没法回头问谁一句,两个互不相连的节点
 * 之间也没有任何通道。要"几个代理互相讨论",只能宿主自己加。
 *
 * ## 为什么不接 Claude Code 原生的 SendMessage / agent teams
 *
 * 查过官方文档:**SDK 会话里开不了 teammate**。原话是
 *
 *   "Spawning teammates also requires an interactive session. In non-interactive mode
 *    with the `-p` flag, **including Agent SDK sessions, Claude doesn't spawn teammates**"
 *
 * 所以这不是"另造一套",是那条路在 SDK 会话里**结构上不存在**。
 *
 * ## 四种投递结果(必须如实回报是哪一档)
 *
 *   - `injected` —— 对方**正在跑**一轮 → 塞进那一轮(不打断、不等、不丢)
 *   - `woke`     —— 对方空闲、且**此刻没有图在管它** → 已请求起轮;
 *                   收件箱要等提供方确认启动才清,启动失败仍能重试
 *   - `queued`   —— 对方空闲、但**有一张图正在管它**(或者引擎不支持插话)→ 存着,
 *                   等它下次开口带到
 *   - `failed`   —— 目标不在名册里 / 自己是自己 / 撞了条数上限 → **带原因**
 *
 * ### ⚠️ 为什么"被图管着的空闲会话"只能排队、不能叫醒
 *
 * 判据是**此刻有没有一张图在管它**,不是"它是不是节点" —— 见 {@link DeliveryPort.canWake}。
 * 图跑着的时候,节点会话的 `turn.done` 是**调度器的完成信号**:`runner.ts` 订阅它、拿它
 * 当"这一步跑完了"。宿主在调度器不知情时插一轮,那次 `turn.done` 会被当成节点的完成 ——
 * 一步的产出就废了,而且不报错。
 *
 * 两个边界都对得上这个判据:
 *   - 图**跑完了**、节点会话还留着 → 它就是"还能接着说下去的会话"(用户点看板卡片跟它
 *     说话走的也是这条路),这时替它起一轮不会踩到谁;
 *   - **主对话自己**在图跑着的时候 → 也被管着(`runs.has(mainId)` 为真),所以给它的消息
 *     也排队 —— 而不是替它开一轮去和正在跑的图抢。
 *
 * ## 无阻塞
 *
 * 这条通道上**没有任何一处等待**。`agent_ask` 也是发完就返回 —— 提问方这一轮照常结束,
 * 等对方**显式回信**时宿主要么插播、要么(提问方是用户驱动会话时)把它叫醒。所以
 * A 问 B、B 同时问 A 不会卡死:两边各自结束、各自被回信叫醒。
 *
 * ## 为什么放在 `lib/` 而不是 `mcp/` 或 `claude/`
 *
 * 写它的是 MCP 工具(`mcp/mcodeServer.ts`),读它的是运行时
 * (`claude/RuntimeManager.ts`)。而 `mcodeServer` **不能** import 运行时 ——
 * `toolRules.ts` 顶上记着那条:那条链会把 `electron` 拖进每一个无头 smoke。所以
 * 投递能力由运行时**注册进来**(见 {@link setDeliveryPort}),这一层谁都不 import。
 * 与 `pendingBackflow.ts` 放在同一层、同一条理由。
 */
import { SettingRepo, SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import type { Session } from "@contracts/session";

/* ────────────────────────── 投递端口(运行时注册进来) ────────────────────────── */

/**
 * 运行时那一侧的能力。**由 `RuntimeManager` 在启动时注册**(见 `main/index.ts`)——
 * 这一层不认识它,只认识这三个动词。
 */
export interface DeliveryPort {
  /** 这个会话此刻有没有一轮在跑。 */
  isRunning(sessionId: string): boolean;
  /** 往**正在跑**的那一轮里塞一段。没在跑 / 引擎不支持插话 → false。 */
  inject(sessionId: string, text: string): boolean;
  /**
   * **这个会话能不能由宿主替它起一轮**(在它空闲时)。
   *
   * 判据不是"它是不是节点",而是"**此刻有没有一张图正在管它**":
   *
   *   - 图**没在跑** → 能。这时的节点会话就只是个"还能接着说下去的会话"
   *     (用户点看板卡片跟它说话走的也是这条路),替它起一轮不会踩到谁。
   *   - 图**正在跑** → **不能**。节点会话是调度器在驱动的:它订阅该会话的 `turn.done`
   *     并拿它当"这一步跑完了"。宿主在调度器不知情时起一轮,那次 `turn.done` 会被
   *     当成节点的完成 —— 一步的产出就废了,而且不报错。这时只能排队等它下次开口。
   *
   * `side` 独立并发,不受主对话的图管理;`chat` 如果自己的图还在跑,
   * 同样只能排队(对话节点可能正在主会话里跑)。
   */
  canWake(sessionId: string): boolean;
  /** 替一个**空闲的**会话起一轮。text 是提示它读收件箱的短句,
   *  信本身由运行时拼进请求;直到提供方确认启动才从收件箱移除。 */
  wake(sessionId: string, text: string): boolean;
  /**
   * 把这封信**画给用户看**(收件会话的对话流里出现一条"代理消息")。可选 —— 测试里的
   * 假端口可以不实现。只管展示,不影响投递结果;失败自己吞掉。
   *
   * 为什么要有:插播 / 叫醒 / 排队这三档,信都是**拼进提示词**的,对话流里原本什么也
   * 不显示 —— 用户只看到某个代理突然开始干活、或者回答里冒出一句不知从哪来的话。
   */
  announce?(sessionId: string, notice: MailNotice): void;
}

/** 展示用的一封信(见 {@link DeliveryPort.announce})。 */
export interface MailNotice {
  fromName: string;
  fromId: string;
  kind: Envelope["kind"];
  text: string;
  re?: string;
  /** 这封信是怎么递过去的 —— 排队的要让用户知道"对方还没看到"。 */
  outcome: Exclude<DeliveryResult["outcome"], "failed">;
}

/** 展示用的一行抬头,例如「📨 来自代理「审稿人」的提问」。 */
export function mailNoticeText(n: MailNotice): string {
  const what = n.kind === "ask" ? "提问" : n.re !== undefined ? "回信" : "消息";
  const tail = n.outcome === "queued" ? "(对方正忙或被工作流管着,已排队,下次开口时带给它)" : "";
  return `📨 来自代理「${n.fromName}」的${what}${tail}\n\n${n.text}`;
}

function announce(peerId: string, env: Envelope, outcome: MailNotice["outcome"]): void {
  if (!port?.announce) return;
  try {
    port.announce(peerId, { fromName: env.fromName, fromId: env.fromId, kind: env.kind, text: env.text, re: env.re, outcome });
  } catch (err) {
    log.warn(`agentMail: 展示消息失败: ${(err as Error).message}`);
  }
}

let port: DeliveryPort | null = null;

/** 注册投递端口。传 `null` 撤掉(测试用)。 */
export function setDeliveryPort(next: DeliveryPort | null): void {
  port = next;
}

/* ────────────────────────────── 名册 ────────────────────────────── */

/** 名册上的一格。 */
export interface Peer {
  /** 会话 id —— 最稳的地址。 */
  id: string;
  /** 人对它和对模型都认得的名字(图上那格的名字 / 会话标题)。 */
  name: string;
  kind: Session["kind"];
  /** 图上哪一格(只有 node 有)。 */
  nodeId?: string;
  /** 此刻有没有一轮在跑。 */
  running: boolean;
}

/** 主对话在名册上的名字。它没有"标题"可用 —— 用户给它起的标题描述的是**话题**,
 *  而名册要的是**身份**("那个聊天窗口"),两者不是一回事。 */
const MAIN_NAME = "主对话";

/**
 * 当前主对话**底下的整棵会话树**。
 *
 * ## 为什么现查,不缓存
 *
 * 用户会在工作流跑的过程中**自己再添子代理**。开跑那一刻冻结一份名册的话,中途加的那些
 * 就不在,而它们恰恰是最该能被找到的(用户刚为这件事开了一个)。所以每次调用都重新查。
 *
 * ## 树的形状
 *
 * 根是**主对话**(`kind: "chat"`),孩子是图上的节点会话(`kind: "node"`)和 side chat
 * (`kind: "side"`)。从根看、从任一节点看,看到的是**同一棵树**,只是**不含自己**。
 *
 * ## 名字必须唯一且可寻址
 *
 * 两个节点可以起同一个标题(用户复制了一格)。名册直接给两个同名条目的话,模型写
 * `to: "评审"` 时投给谁是不确定的 —— 而它不会知道这件事,只会以为发对了。所以重名时
 * **退回 id**:名字是给人读的,id 才是地址,两者在同一条里都给出去。
 *
 * 自己**不在名册里**(`agent_send` 给自己是没意义的,而且会自己给自己排队 → 死循环)。
 */
export function peersOf(sessionId: string): Peer[] {
  const self = SessionRepo.get(sessionId);
  if (!self) return [];
  const root = rootOf(self);
  if (!root) return [];

  const raw: Session[] = [];
  if (root.id !== self.id) raw.push(root);
  // 根自己不是 node/side,所以这两个查询不会把 root 重复列进来。
  raw.push(...SessionRepo.listNodesByParent(root.id));
  raw.push(...SessionRepo.listSideByParent(root.id));

  const peers: Peer[] = [];
  for (const s of raw) {
    if (s.id === self.id) continue;
    peers.push({
      id: s.id,
      name: s.id === root.id ? MAIN_NAME : s.title.trim(),
      kind: s.kind,
      ...(s.nodeId !== null ? { nodeId: s.nodeId } : {}),
      // **逐个问端口** —— 只有运行时知道谁在跑。名册是几十格,不为它加一个批量接口
      // (那要运行时同步维护一份索引,而这份索引没有第二个消费者)。
      running: port?.isRunning(s.id) === true,
    });
  }
  return detangleNames(peers);
}

/**
 * **我自己**在名册上会用的那个名字与 id。
 *
 * 发信时要用它填信封的 `from` —— 缺了它,收信方既不知道谁在问、也不知道该往哪回,
 * 这条通道就成单向的了。主对话用 {@link MAIN_NAME}(它没有"身份名",标题描述的是话题)。
 */
export function selfPeerOf(sessionId: string): { id: string; name: string } {
  const self = SessionRepo.get(sessionId);
  if (!self) return { id: sessionId, name: sessionId };
  const isMain = self.kind === "chat" || self.parentSessionId === null;
  return { id: sessionId, name: isMain ? MAIN_NAME : self.title.trim() };
}

/** 名册上那一格找不到时给模型看的那句话(带上现在有谁)。**别让它自己去猜名字。** */
export function unknownPeerMessage(sessionId: string, asked: string): string {
  const names = peersOf(sessionId).map((p) => p.name);
  const have = names.length > 0 ? names.join("、") : "(这个对话底下没有别的代理)";
  return `名册上没有「${asked.trim()}」。当前有:${have}。用 agent_peers 看一眼再发。`;
}

/** 最多同时挂这么多条未答的提问。见 {@link recordAsk}。 */
const MAX_PENDING_ASKS = 50;

/** 这棵树的主对话。自己是主对话 → 自己;否则顺着 `parentSessionId` 上溯。
 *
 *  ⚠️ **带上深度上限。** `(parentSessionId, nodeId)` 的树关系是应用维护的,正常情况下
 *  不可能成环 —— 但一条被改坏的会话行(自引用、或者两条互指)就会让这个递归**无限转下去**,
 *  而它的表现是主进程**栈溢出崩掉**,不是一句报错。上限给得比任何真实的树都深,所以正常
 *  路径一次都不触发;真触发了就当作"找不到根",名册退化成空 —— 那比崩掉好。 */
function rootOf(self: Session, depth = 0): Session | undefined {
  if (self.kind === "chat") return self;
  if (self.parentSessionId === null) return undefined;
  if (depth >= 16) {
    log.warn(`agentMail: 会话 ${self.id} 的父链超过 16 层,当它没有根处理(数据可能坏了)`);
    return undefined;
  }
  const parent = SessionRepo.get(self.parentSessionId);
  if (!parent) return undefined;
  // 父是 node/side 的话(不该有,但别假设)继续上溯;主对话的父是 null。
  return rootOf(parent, depth + 1);
}

/**
 * 重名时给后来者补上 id 前缀,直到不再撞。
 *
 * 不改**第一个**(它是"正主",模型最可能指的就是它),只把后来者拆开。补的是 id 前缀
 * 而不是 `(2)` 这种序号 —— 序号在两次调用之间会变(节点按 `updated_at` 排),而模型
 * 手里那个名字是从**上一次**调用拿的,变了就对不上了。
 */
function detangleNames(peers: Peer[]): Peer[] {
  const used = new Set<string>();
  for (const p of peers) {
    let name = p.name;
    if (used.has(name)) {
      for (let n = 4; n <= p.id.length; n += 4) {
        const candidate = `${name}(${p.id.slice(0, n)})`;
        if (!used.has(candidate)) {
          name = candidate;
          break;
        }
      }
      // 极端情况:id 也分不开(不该发生)。加满 id 仍然撞的话就带上整条 id。
      if (used.has(name)) name = `${p.name}(${p.id})`;
    }
    used.add(name);
    p.name = name;
  }
  return peers;
}

/** 按名字或 id 找名册上那一格。找不到 → undefined(调用方负责给一句人话)。 */
export function resolvePeer(sessionId: string, to: string): Peer | undefined {
  const peers = peersOf(sessionId);
  const needle = to.trim();
  return peers.find((p) => p.name === needle) ?? peers.find((p) => p.id === needle);
}

/* ────────────────────────────── 信封 ────────────────────────────── */

/** 一封要递出去的信。 */
export interface Envelope {
  /** 谁发的 —— 名字 + id 都要有。**没有它对方回不了信**,这条通道就成单向的了。 */
  fromName: string;
  fromId: string;
  /** 通知(不等回)还是询问(要回)。 */
  kind: "notify" | "ask";
  /** 这一段话本身。 */
  text: string;
  /** 这是一条**回信**时,原提问的 id。 */
  re?: string;
}

/**
 * 渲染成落到对方提示词里的那一段(**带说明头**)。
 *
 * 那个头不能省,理由与 `backflowPrompt` 同源:这段文字是拼在**对方即将发出的那一轮**
 * 里,模型分不清"哪部分是新指令、哪部分是背景"时,最常见的反应是**去回复背景那一段** ——
 * 用户看到的是某一步莫名其妙地总结起一句跟它无关的话。
 *
 * 而且这里必须**说清是谁发的**:不说的话,对方收到一句没头没尾的话,既不知道谁在问,
 * 也不知道该往哪回。回信那条(`re`)同理 —— 带上它,对方的回信才落得回原提问方。
 */
export function envelopePrompt(env: Envelope): string {
  const how = env.kind === "ask" ? "向你提了一个问题" : "给你捎了一句话";
  const head = [
    `## 另一名代理${how}`,
    `发信人:${env.fromName}(id=${env.fromId})。`,
  ];
  if (env.kind === "ask") {
    head.push(
      `**这是要你回答的。** 答完之后用 agent_notify 发回去:`,
      `  to=${env.fromId}  re=${env.re ?? "(见下)"}  text=<你的答复>`,
      `带上 re 我才知道你在回哪一条。`,
    );
  } else if (env.re !== undefined) {
    head.push(`这是一条**回信**(针对 ${env.re})。`);
  } else {
    head.push("**这不是用户说的话**,是另一名代理捎来的 —— 知道这件事即可,不必回复。");
  }
  return [...head, "", env.text].join("\n");
}

/* ────────────────────────────── 收件箱 ────────────────────────────── */

/** sessionId → 还没被带进去的那几段。序号供 sendTurn 确认“只清本轮读到的前缀”。 */
const inbox = new Map<string, Array<{ serial: number; body: string }>>();
let nextInboxSerial = 0;

/** 拼进提示词时用的抬头 —— 与 `backflowPrompt` 同一个理由(别让对方去回复这一段)。 */
function inboxPrompt(text: string): string {
  const body = text.trim();
  if (body.length === 0) return "";
  return [
    "## 别的代理在你不在的时候捎来的话",
    "以下是这个对话里**其他代理**发给你(所在这一步)的消息。当作你已经知道了,不必逐条回复。",
    "",
    body,
  ].join("\n");
}

const WAKE_MAIL_PROMPT = "请处理刚收到的代理消息;需要回复对方时用 agent_notify 发回去。";

/** 同时取本轮要带的内容和它的收条,**不动队列**。等待引擎启动期间可能再来新信。 */
export function peekAgentMailBatch(sessionId: string): { text: string; through: number } {
  const list = inbox.get(sessionId);
  return list === undefined || list.length === 0
    ? { text: "", through: 0 }
    : { text: inboxPrompt(list.map((item) => item.body).join("\n\n")), through: list[list.length - 1].serial };
}

/** 只关心有没有信的读者无需处理收条(如图收尾处)。 */
export function peekAgentMail(sessionId: string): string {
  return peekAgentMailBatch(sessionId).text;
}

/** 回合真正起来后,只清它读过的那些;启动期间新收到的不能被顺手抹掉。 */
export function clearAgentMail(sessionId: string, through: number): void {
  if (through <= 0) return;
  const list = inbox.get(sessionId);
  if (list === undefined) return;
  let count = 0;
  while (count < list.length && list[count].serial <= through) count++;
  if (count === 0) return;
  if (count === list.length) inbox.delete(sessionId);
  else inbox.set(sessionId, list.slice(count));
  log.info(`agentMail: 已带进会话 ${sessionId}(${list.slice(0, count).reduce((n, item) => n + item.body.length, 0)} 字)`);
}

/** 会话没了 → 收件箱一起清掉(留着也永远没人取了)。 */
export function dropAgentMail(sessionId: string): void {
  inbox.delete(sessionId);
  counts.delete(sessionId);
  // ⚠️ **落盘的那份挂账也要收。** 收件箱是内存态的,挂账不是 —— 它写在设置键
  // `agentMail.pendingAsks` 里,而这里从前只清内存那两个 Map。会话一删,它名下(作
  // 提问方或回答方)的那些挂账行**永远留着**:既没人会来销账(两条会话可能都没了),
  // 又随着每一次删除越攒越多,而设置表每写一次都要重写整个 `mcode.db`。与收件箱同理。
  const asked = loadAsks();
  const kept = asked.filter((a) => a.fromSessionId !== sessionId && a.toSessionId !== sessionId);
  if (kept.length !== asked.length) saveAsks(kept);
}

/* ────────────────────── 图跑完之后的「叫醒」 ────────────────────── */

/**
 * 图收尾时,把收件箱里那些等着被叫醒的会话**此刻就**叫醒。
 *
 * ## 为什么必须由调度器在收尾那一刻调
 *
 * 图正在跑的时候,**不能**从外面替节点会话起一轮:那会插到调度器与它自己那个
 * `turn.done` 之间,把一步的产出弄废(见 {@link DeliveryPort.canWake} 那段)。所以投递
 * 那一刻只能排队。而图一旦收尾,那个节点会话就**再也没有下一轮**了 —— 收尾这一下是唯一
 * 的窗口,过了它那些消息就永远送不出去。
 *
 * ## 为什么做成同步、由调用方传会话行进来
 *
 * ⚠️ **早先这里是 `setTimeout(0)` 延后一把** —— 那是错的:调用方(`runner.ts` 的收尾)
 * 紧接着就会 `dispose` 那些会话的运行时,而延时回调跑的时候运行时已经没了,`wake` 内部的
 * `sendTurn` 会因为 `sessions.get(id)` 拿不到而**静默返回 null**。于是排队的消息**一条都
 * 送不出去**,而且看不出来。
 *
 * 现在**当场叫**,而调用方负责把叫成了的那个从 `dispose` 名单里拿掉(它马上要再跑一轮)。
 * 返回叫醒的那些 id,让调用方好做这件事。
 */
export function wakeQueued(
  targets: ReadonlyArray<{ session: Session; text: string }>,
): string[] {
  if (port === null) return [];
  const woken: string[] = [];
  for (const { session, text } of targets) {
    // text 是收件箱的 peek,只用来确认有信。sendTurn 自己会把整份收件箱
    // 拼进提示词;再把 text 当 prompt 传进去,同一封信会出现两遍。
    if (text.length === 0) continue;
    if (!port.canWake(session.id)) continue;
    if (port.wake(session.id, WAKE_MAIL_PROMPT)) woken.push(session.id);
  }
  return woken;
}

/* ────────────────────────── 防打转的条数上限 ────────────────────────── */

/**
 * 每个会话在一个**时间窗内**最多收这么多条代理消息。
 *
 * ## 为什么按**条数**、不按跳数
 *
 * 跳数要模型自己传(它得记住"我是第几跳")—— 而它不一定传,漏一次这道闸就没了。
 * 条数不需要模型配合:一个会话收到的条数由**投递侧**数,模型想绕也绕不过去。
 *
 * ## 为什么它真能挡住 A↔B 死循环
 *
 * A 问 B、B 回 A、A 又问……每绕一圈,两边各自**都**多收一条。所以不管从哪一头开始
 * 数,都会撞上限。撞上之后 `failed` 并**说清原因**,不会静默停 —— 用户看到的是一句
 * "超过上限",而不是"代理突然不说话了"。
 *
 * ## ⚠️ 为什么是**时间窗**而不是"一个会话一辈子只准收 24 条"
 *
 * 早先这里是个终生计数,只在 `dropAgentMail` 里清 —— 而生产代码**从不调它**。所以一个
 * 会话收满 24 条之后,在**整个进程的生命周期里**就再也收不到任何代理消息了,而且
 * 表现是静默的:从外面看不出它"聋了"(那三个工具照常返回,只是每次都 `failed`)。
 *
 * 长时间跑的工作流必然撞上这件事 —— 一张图跑一下午、几个节点来回讨论,24 条太少了。
 * 换成窗口之后语义也正好对上:**限的是"短时间内别打转"**,不是"一共只许说 24 句"。
 * 所以撞上限时那句话说的是"可能一直在循环,停下核对",而不是"你说话太多"。
 */
export const MAX_MESSAGES_PER_SESSION = 24;

/** 一窗有多长。10 分钟:足够挡住"几秒内来回几百次"的打转,又不至于让正常讨论被卡住。 */
export const MESSAGE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 当前生效的窗口长度。**可注入** —— 只给无头 smoke 用(见 `agent-mail-smoke` 里那条
 * "窗口过了它会自己恢复")。
 *
 * ## 为什么不做成 `const`,而要留一个注入口
 *
 * 这条路径**必须能被测到**:早先这里是个终生计数,谁也没想到它会永久失效(见上面那段),
 * 而它错了的表现是**静默**的。要锁住"窗口过后恢复"这件事,就只能把窗口调短到几十毫秒
 * —— 20 分钟的窗口没法在秒级的 smoke 里等。
 *
 * 不用"手动重置"那种口子(比如导出一个 `resetWindows()`):那测的是**另一个函数**,
 * 而生产走的是"时间到了自然过期"这条路 —— 两回事。
 */
let windowMs = MESSAGE_WINDOW_MS;

/** 改窗口长度(**测试用**)。`null` 恢复默认。 */
export function setMessageWindowMs(ms: number | null): void {
  windowMs = ms ?? MESSAGE_WINDOW_MS;
}

/** 收件方 sessionId → (这一窗里收了几条, 这一窗从什么时候开始)。 */
const counts = new Map<string, { count: number; since: number }>();

/** 读一个会话**当前这一窗**里的计数(过期的窗口当作 0,顺手把旧的换掉)。 */
function windowOf(sessionId: string, now: number): { count: number; since: number } {
  const cur = counts.get(sessionId);
  if (cur === undefined || now - cur.since >= windowMs) {
    const fresh = { count: 0, since: now };
    counts.set(sessionId, fresh);
    return fresh;
  }
  return cur;
}

/** 记下一条(窗口内 +1)。 */
function bumpCount(sessionId: string, now: number): void {
  const w = windowOf(sessionId, now);
  w.count += 1;
}

/* ────────────────────────── 未答的提问(挂账,落盘) ────────────────────────── */

/** 一条还没被回答的提问。 */
export interface PendingAsk {
  askId: string;
  fromSessionId: string;
  fromName: string;
  toSessionId: string;
  question: string;
  at: number;
}

const ASK_SETTING_KEY = "agentMail.pendingAsks";

/**
 * ## 为什么挂账要落盘,而收件箱不落
 *
 * 收件箱是**一次性**的(取走就没了),与 `pendingBackflow` 同一条理由:它要解决的那件
 * 事在重启之后本来就过期了。
 *
 * 挂账不一样 —— "**我问过一个还没被回答的问题**"这个事实跨重启依然成立。它丢了的话,
 * 对方的回信会找不到该投给谁,而提问方永远等不到;而且没有任何地方看得出这件事发生过。
 * 宁可存着,让它一直显示在名册上(#N 条未送达),也不要它无声消失。
 */
function loadAsks(): PendingAsk[] {
  const raw = SettingRepo.get(ASK_SETTING_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingAsk);
  } catch {
    // 坏 JSON → 当没有。**按最小损失处理**:挂账丢了的代价是那几条回信投不出去,而把
    // 整个设置键当致命错会让别的功能也跟着挂。
    log.warn("agentMail: 挂账不是合法 JSON,按没有处理");
    return [];
  }
}

function isPendingAsk(x: unknown): x is PendingAsk {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.askId === "string" &&
    typeof r.fromSessionId === "string" &&
    typeof r.fromName === "string" &&
    typeof r.toSessionId === "string" &&
    typeof r.question === "string" &&
    typeof r.at === "number"
  );
}

function saveAsks(asks: PendingAsk[]): void {
  SettingRepo.set(ASK_SETTING_KEY, JSON.stringify(asks));
}

/**
 * 记一条提问,返回它的 `askId`(回信要带着它)。
 *
 * ⚠️ **有上限。** 挂账是**落盘**的(整份 JSON 重写),而每条未答的提问都占一行。A 问 B、
 * B 问 A 这种来回会**无界增长** —— 每次投递都写一遍越来越大的 JSON,而且没有谁会自动清掉
 * 那些永远等不到答复的。所以封顶 {@link MAX_PENDING_ASKS}:满了就把**最早**那条挤出去。
 *
 * 挤出去的代价是那一条永远等不到答复(和现在一样 —— 它本来也可能永远等不到),而提问方
 * 那边有 `agent_peers` 里那句"有 N 条问了还没被回复"兜着,看得见。
 */
export function recordAsk(ask: Omit<PendingAsk, "askId" | "at">): PendingAsk {
  const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const full: PendingAsk = { ...ask, askId, at: Date.now() };
  const kept = [...loadAsks(), full];
  // 按时间留最近的那些(`loadAsks` 保持插入序,新的一定在末尾)。
  saveAsks(kept.length > MAX_PENDING_ASKS ? kept.slice(-MAX_PENDING_ASKS) : kept);
  return full;
}

/** 只看一眼挂账，不删除。回信要先验身份、确定投递成功，才能销账。 */
export function peekAsk(askId: string): PendingAsk | undefined {
  return loadAsks().find((a) => a.askId === askId);
}

/**
 * 按 `askId` **精确**取一条挂账并销账。
 *
 * ⚠️ **找不到就是找不到,绝不"随便挑一条"。** 挑错了的表现是把一段答复投给另一个
 * 提问方 —— 它会以为那是对它问题的回答,而两边都不报错。宁可不投,让它显示成未送达。
 */
export function takeAsk(askId: string): PendingAsk | undefined {
  const asks = loadAsks();
  const hit = asks.find((a) => a.askId === askId);
  if (hit === undefined) return undefined;
  saveAsks(asks.filter((a) => a.askId !== askId));
  return hit;
}

/**
 * 一条回信没带 `re` 时,按"最近一条**来自对方**的未答提问"匹配。
 *
 * 这是**尽力而为**的一档(模型可能忘了带 `re`),所以限定得很死:`toSessionId` 必须是
 * 我这个提问方、`fromSessionId` 必须是回信那个人。两边都对不上就返回 undefined,
 * 由调用方如实报错 —— **不猜**。
 */
export function takeLatestAskFrom(replierSessionId: string, askerSessionId: string): PendingAsk | undefined {
  const asks = loadAsks();
  const candidates = asks
    .filter((a) => a.fromSessionId === askerSessionId && a.toSessionId === replierSessionId)
    .sort((a, b) => b.at - a.at);
  const hit = candidates[0];
  if (hit === undefined) return undefined;
  saveAsks(asks.filter((a) => a.askId !== hit.askId));
  return hit;
}

/** 名册上要显式报出的"还没送达的回复"数(按目标会话)。不静默丢掉。 */
export function undeliveredCount(sessionId: string): number {
  return loadAsks().filter((a) => a.fromSessionId === sessionId).length;
}

/* ────────────────────────────── 投递 ────────────────────────────── */

export interface DeliveryResult {
  outcome: "injected" | "woke" | "queued" | "failed";
  /** 给人/模型看的一句话 —— 说清是哪一档、为什么。 */
  detail: string;
}

/**
 * 把一封信递给名册上那一格。
 *
 * ⚠️ **`to` 必须是名册上的名字或 id** —— 调用方先 `resolvePeer` 拿到 `Peer` 再传进来。
 * 这样"目标在不在树里"这件事只判一次,投递这一层不重复判(两处判会有两种真相)。
 */
export function deliver(peer: Peer, env: Envelope): DeliveryResult {
  // ① 条数上限 —— 最先判。它挡住的是**打转**,而打转的每一圈都该被挡在门外。
  const now = Date.now();
  const used = windowOf(peer.id, now).count;
  if (used >= MAX_MESSAGES_PER_SESSION) {
    return {
      outcome: "failed",
      detail:
        `「${peer.name}」在最近 ${Math.round(windowMs / 60000)} 分钟里已经收过 ${used} 条` +
        `代理消息(上限 ${MAX_MESSAGES_PER_SESSION}),不再递了 —— 这多半是几个代理在互相来回发。` +
        `请停下核对你的流程,别继续兜圈子;窗口过了它会自动恢复。`,
    };
  }

  const body = envelopePrompt(env);

  // ② **对方在跑** → 插播。插不进去(引擎不支持插话,Pi / Codex)就**排队** ——
  //    **绝不能落到"叫醒"那一档**:它已经在跑了,再"叫醒"是第二次开火。
  if (port !== null && port.isRunning(peer.id)) {
    if (port.inject(peer.id, body)) {
      bumpCount(peer.id, now);
      announce(peer.id, env, "injected");
      return { outcome: "injected", detail: `已插进「${peer.name}」正在跑的那一轮,它下一个安全点就会看到。` };
    }
    pushInbox(peer.id, body);
    bumpCount(peer.id, now);
    announce(peer.id, env, "queued");
    return {
      outcome: "queued",
      detail:
        `「${peer.name}」正在跑,而这个引擎不支持中途插话(Pi / Codex 就是这样)—— ` +
        `已存下,等它这一轮跑完、下次开口时带进去。`,
    };
  }

  // ③ 对方**空闲** —— 能不能替它起一轮,还要看图的管理状态/启动闸门(见 `canWake`)。
  //    管着的时候只能排队:节点会话的 `turn.done` 是调度器的完成信号,插一脚就废一步产出。
  if (port === null || !port.canWake(peer.id)) {
    pushInbox(peer.id, body);
    bumpCount(peer.id, now);
    announce(peer.id, env, "queued");
    return {
      outcome: "queued",
      detail:
        `「${peer.name}」现在不能从外面起新一轮:可能正被工作流管理(插队会影响步骤产出)、` +
        `上一轮还在启动,或运行闸门尚未就绪。已存下,等它下一次开口时带进去。` +
        `如果这张图已经跑完、它不会再动了,用 agent_peers 看它还在不在,或者直接跟用户说一声。`,
    };
  }

  // ④ 先存再叫醒:桥/引擎启动可能在 wake 返回 true **之后**才失败。
  //    本轮请求从收件箱读这段,拿到句柄后才确认它;失败则仍能重试。
  //    wake 只传提示词,不能再传 body,否则同一封信会在 prompt 里出现两遍。
  pushInbox(peer.id, body);
  let woke = false;
  try { woke = port.wake(peer.id, WAKE_MAIL_PROMPT); }
  catch (err) { log.warn(`agentMail: 叫醒 ${peer.id} 失败: ${(err as Error).message}`); }
  if (woke) {
    bumpCount(peer.id, now);
    announce(peer.id, env, "woke");
    return { outcome: "woke", detail: `已请求叫醒「${peer.name}」;消息已暂存,引擎成功启动后它会看到。` };
  }

  // ⑤ 起轮没成(运行时没绑上 / 配置失效)→ 信已经在收件箱,
  //    **如实说**是排队而不是直达。
  bumpCount(peer.id, now);
  announce(peer.id, env, "queued");
  return {
    outcome: "queued",
    detail: `没能替「${peer.name}」起轮(运行时未绑定、模型配置无效或状态刚好变化)—— 已存下,等它下次开口时带进去。`,
  };
}

function pushInbox(sessionId: string, body: string): void {
  const list = inbox.get(sessionId) ?? [];
  list.push({ serial: ++nextInboxSerial, body });
  inbox.set(sessionId, list);
}
