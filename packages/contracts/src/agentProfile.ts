/**
 * 代理档案(Agent Profile)—— **一份保存下来的子 agent 配置**。
 *
 * ## 它解决什么
 *
 * 节点类型只有一种子 agent(`mcode.agent`),而"一个能读论文的子 agent"和"一个专门
 * 写测试的子 agent"用起来完全是两回事:指令、技能、引擎、能力都不一样。没有档案的话,
 * 每建一个节点就要把这些从头填一遍 —— 而填错的代价是那个节点跑出来的东西不对,不是
 * 报错。
 *
 * 所以档案是**参数的一份快照**:建节点的时候挑一份,参数就填好了,之后还能在节点上
 * 单独改(改了不影响档案)。
 *
 * ## 它不是"一种新的节点类型"
 *
 * 一个很自然的选择是把档案做成一种节点类型(往 `<数据根>/workflows/node-types/` 写一份
 * 清单)。那样插入菜单、参数表单、校验全都白拿。**不做**,有两个理由:
 *
 * 1. **语义不同**。节点类型回答的是"这一步是什么"(跑一个脚本 / 起一个子 agent),
 *    档案回答的是"这一个子 agent 怎么配"。混在一起之后,菜单里会出现二十个长得一模
 *    一样的"子 agent",而它们其实是同一个类型的二十种填法。
 * 2. **引用会碎**。工作流里的节点存的是**类型 id**。档案要是变成了类型 id,那么给档案
 *    改个名就等于删掉一种类型 —— 所有引用它的图都会变成"类型没装"。档案存的是**值**,
 *    删掉一份档案不会让任何已有的图跑不起来(节点身上已经有参数了)。
 *
 * 档案是**内容**,所以它和节点类型、钩子一样落在数据根下、由用户直接可读可改:
 * `<数据根>/workflows/agents/<id>.json`。
 *
 * ## id 是不透明的
 *
 * 不拿名字当文件名。名字是中文、带空格、随时会改;而文件名一旦跟着改,所有引用它的
 * 地方(还有用户自己写的那份分享文档)就都要跟着动。所以 id 是生成出来的
 * (`p_` + 时间戳 + 随机),名字随便改。
 */
import { z } from "zod";
import { NODE_PROMPT_PARAM_KEY, defaultParamsOf, type NodeTypeManifest } from "./nodeType.js";

/** 档案文件格式版本。 */
export const AGENT_PROFILE_VERSION = 1;

/**
 * id 的形状。**同时是文件名的形状** —— 所以这里排除掉路径分隔符和 Windows 上不合法的
 * 字符,而不是"看着像个 id 就行":这份文件是拿 id 去拼路径写的,一个带 `/` 或 `..` 的
 * id 能让它写到数据根外面去。
 */
export const AGENT_PROFILE_ID_RE = /^p_[a-z0-9_]+$/;

export const AgentProfileSchema = z.object({
  version: z.literal(AGENT_PROFILE_VERSION),
  id: z.string().regex(AGENT_PROFILE_ID_RE, "档案 id 必须形如 p_xxxx"),
  /** 列表和插入菜单里显示的名字。随便写,中文也行。 */
  name: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
  /**
   * 这份档案是给**哪个节点类型**用的。
   *
   * 现在只有 `mcode.agent` 一种,但存着它而不是写死:档案本质是"某个类型的一组参数",
   * 将来有第二种提示词节点时,同一个机制不用改。
   */
  type: z.string().min(1),
  /**
   * 那个类型的参数。**形状不在这里校验** —— 参数要满足的是**节点类型清单**的要求
   * (见 `@contracts/nodeType` 的 `validateNodeParams`),而清单是可以改的、也可以来自
   * 插件。在这里再写一遍就是同一套规则有两个地方,迟早分家。
   *
   * 所以档案只保证"这是一袋键值",能不能用由插入它的那一刻说了算
   * (见 {@link paramsForProfile}:缺失的键会被清单的默认值补上)。
   */
  params: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * 一次加载的结果:能用的 + 读得见但用不了的。
 *
 * **为什么 `problems` 必须一起返回**:一个格式错的文件如果被静默跳过,用户看到的现象
 * 是"我存的档案不见了",没有任何线索。界面要能把文件名和错误原样显示出来。
 *
 * 放在 contracts 而不是加载器里,是因为它是 `workflow.agentProfiles` 的**返回类型**,
 * 渲染端要按它渲染 —— 与 `NodeTypeCatalog` 同一个位置。
 */
export interface AgentProfileCatalog {
  profiles: AgentProfile[];
  problems: Array<{ file: string; error: string }>;
}

/** 一份档案配得对不对。和 `validateHook` / `validateNodeTypeManifest` 同一个位置:
 *  界面上存之前先过这一道,因为错的档案**不会报错**,它只会在插入之后表现成一个填错
 *  了的节点。 */export function validateAgentProfile(raw: unknown): { ok: true; profile: AgentProfile } | { ok: false; error: string } {
  const parsed = AgentProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}:` : "";
    return { ok: false, error: `档案校验失败(${where}${first?.message ?? "格式不对"})` };
  }
  return { ok: true, profile: parsed.data };
}

/**
 * 解析一份档案文件的正文。**纯函数**:不碰文件系统、不 import 主进程的任何东西。
 *
 * 放在契约里而不是存放的那一层,理由和 `parseHooksFile` 一样:这个文件是**用户直接改
 * 的**,所以"什么算合法"是一条对外承诺,不是实现细节;附带的好处是它能被无头脚本喂
 * 各种畸形输入。
 */
export function parseAgentProfile(text: string): { profile: AgentProfile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `不是合法的 JSON:${(err as Error).message}` };
  }
  const check = validateAgentProfile(raw);
  return check.ok ? { profile: check.profile } : { error: check.error };
}

/**
 * 生成一个档案 id。
 *
 * 不用名字做 slug:名字多半是中文(这个应用的用户就是),slug 出来会是空的;退而求其次
 * 拼时间戳的话,同一秒里建两份就撞了。id 只要求**互不相同、能当文件名**,那么时间戳
 * 加随机就是它该有的样子(和钩子的 `makeHookId` 同款)。
 */
export function makeAgentProfileId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `p_${now.toString(36)}_${rand}`;
}

/**
 * 把一份档案的参数套到一个节点上。
 *
 * 两步,顺序不能反:
 *
 * 1. **先铺清单的默认值**(`defaultParamsOf`)。档案是过去某一刻存的,之后清单可能
 *    加过参数 —— 直接拿档案的键覆盖,新参数就是缺失的,而缺失的参数在界面上是个看不
 *    出来的坑(节点能存、跑起来才发现必填项是空的)。
 * 2. **再用档案的值覆盖**。档案里存的键以它为准。
 *
 * 档案里**多余的键**(清单删过参数)原样留着:删掉它们等于替用户丢数据,而它们除了
 * 占一点空间没有别的影响(`validateNodeParams` 只看清单声明过的键)。
 */
export function paramsForProfile(
  manifest: NodeTypeManifest,
  profile: AgentProfile,
): Record<string, unknown> {
  return { ...defaultParamsOf(manifest), ...profile.params };
}

/* ── 档案用在**会话**上(不是节点上) ───────────────────────────────────────── */

/**
 * 会话能直接用的档案,必须是给这个类型的。
 *
 * ## 为什么单拎出来
 *
 * 档案的 `type` 原本只回答"这份参数是为哪种节点存的",而节点类型是**注册表**里的东西
 * (`main/orchestration/nodeTypes.ts` 的 `BUILTIN_NODE_TYPES`,插件还能自己加)。契约层
 * **看不到那张表** —— 也不该看到:契约不 import 实现,是这个仓库的结构。
 *
 * 但契约这边又要判一件事:「这份档案能不能当"一个有提示词的对话"建出来」。这件事的判据
 * 只有一个 —— **它是一个会走模型、且以提示词为主体的类型**。节点类型里符合这个描述的
 * 恰好就是内置的子 agent,而子 agent 的 id 在这里是一个**常量比较**,不是查表。
 *
 * 于是分两层:*这一层*只认得出"内置的子 agent",认不出插件的提示词类型(它们在
 * `applyAgentProfileToSession` 里过 `runner.kind === "prompt"` 那一关)。两层都过了才
 * 建得出来 —— 漏掉哪一层都只是**少列出几份**,不会拿一份不对的档案去建会话:参数在落
 * 地那一刻还要过一次 `validateNodeParams`。
 */
export const AGENT_PROFILE_PARAM_TYPE = "mcode.agent";

/** 这份档案能不能当会话的「角色」用(见 {@link AGENT_PROFILE_PARAM_TYPE})。 */
export function isSessionAgentProfile(profile: Pick<AgentProfile, "type">): boolean {
  return profile.type === AGENT_PROFILE_PARAM_TYPE;
}

/**
 * 档案里那条指令 —— **提示词节点的主参数**(键是 `NODE_PROMPT_PARAM_KEY`,值在
 * `params` 里,是字符串记录)。
 *
 * 拿不到时返回空串,而不是抛:档案是**用户手改的文件**,缺一个键、或者存了个数字,
 * 都是可能发生的。抛出去的结果是"这个会话发不出去消息",而空串的结果只是"这个对话没
 * 有角色提示词"—— 后者是能用的,前者不是。
 *
 * 拿不到就**什么都不带**:不编一句"你是一个助手"顶上。那句话会把一个本来只是"没填指令"
 * 的状态,伪装成"填过一句没用的指令",而用户看不出差别。
 */
export function agentProfileInstruction(profile: AgentProfile): string {
  const value = profile.params[NODE_PROMPT_PARAM_KEY];
  return typeof value === "string" ? value.trim() : "";
}

/** 会话行上 `agentProfile` 这一列的载荷(落盘形态)。 */
export interface SessionAgentProfileRef {
  /** 档案 id(`p_xxxx`);档案被删之后这个 id 认不出任何东西(见下)。 */
  id: string;
  /** **建会话那一刻**的档案名 —— 会话标题用它,之后档案改名不影响。 */
  name: string;
  /** **建会话那一刻**的指令原文。见 {@link agentProfileInstruction} 的"快照"说明。 */
  instruction: string;
}

/**
 * 从一份档案取出要写进**会话行**的那一份快照。
 *
 * ## 为什么是快照,不是"每轮回档案里现取"
 *
 * 档案是**内容**,用户可以随时改、随时删(`<数据根>/workflows/agents/<id>.json`)。
 * 每轮回读的话,同一个对话今天用第 2 版、明天用第 3 版 —— 而**上下文还是连续的**,
 * 于是"它昨天说过的话"和"它今天是谁"对不上,用户完全看不出发生过什么。
 *
 * 所以:**建会话那一刻取一份,之后这个对话就活在这一份上**。改了档案不影响已经开出去的
 * 对话(想用新的就再建一个子对话),删了档案也不影响(指令原文在这里)。
 *
 * 这也正是和**节点**那一侧刻意的不同:节点每轮现取档案(`paramsForProfile`),因为它
 * 本来就是"跑一次算一次"的东西。
 *
 * ⚠️ 代价写在这里:**改了档案,已经开着的子对话不会跟着变**。这不是疏忽,是上面那一段
 * 的选择 —— 而它有一个能看见的后果:建会话时若档案还没有指令,`instruction` 就是空串,
 * 于是这个对话**永远**没有角色提示词(即便用户后来补上了)。
 */
export function agentProfileRef(profile: AgentProfile): SessionAgentProfileRef {
  return { id: profile.id, name: profile.name, instruction: agentProfileInstruction(profile) };
}

/**
 * 从一份参数快照出一份档案。**调用方给 id 和时间戳** —— 这里不生成,因为"存一份新的"
 * 和"覆盖已有的那份"是两种意图,只有调用方知道。
 */
export function profileFromParams(args: {
  id: string;
  name: string;
  type: string;
  params: Record<string, unknown>;
  description?: string;
  createdAt: number;
  updatedAt?: number;
}): AgentProfile {
  return {
    version: AGENT_PROFILE_VERSION,
    id: args.id,
    name: args.name.trim(),
    type: args.type,
    params: { ...args.params },
    createdAt: args.createdAt,
    updatedAt: args.updatedAt ?? args.createdAt,
    ...(args.description ? { description: args.description } : {}),
  };
}
