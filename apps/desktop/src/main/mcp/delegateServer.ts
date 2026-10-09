/**
 * **mcode-agent** —— 把 mcode 这个 agent 本身包成 MCP 工具,交给外面的 AI 调。
 *
 * ## 这组工具和别的工具不是一回事
 *
 * 表里别的工具(`agent_read` / `agent_bash` / `workflow_save` …)给的是**原子能力**:
 * 外面那个模型自己想步骤,一步一个工具地做。这一组给的是**整件事**:
 * 「把这个仓库的 README 按最新接口改一遍」丢进来,跑的是**本机 mcode 自己的一轮** ——
 * 它的技能、它的工作流、它的记忆、它的模型、它的工作目录,全在。
 *
 * 换句话说:外面的 AI 从「远程操作这台机器的文件」升级成「指挥这台机器上的 agent」。
 * 这正是用户要的那一句「把 mcode 这个 agent 包成 MCP 服务供外面的 AI 控制」。
 *
 * ## ⚠️ 为什么默认**关着**,而且只认一条白名单会话
 *
 * `webToolHost.ts` 里有一段刻意的取舍:公网那条路是**免审批**的(合成会话跑
 * `bypassPermissions`),所以 `agent_notify` / `agent_ask` 那组「能叫醒本机会话、替它
 * 起一轮」的工具**被摘掉了**。这组工具干的恰恰是同一类事,而且更彻底 —— 不摆明这一点
 * 就等于绕过那个决定。
 *
 * 于是三道约束,一道都不能省:
 *
 *  1. **默认关**。要用户在「远程控制」里亲手打开(那里的措辞是警告,不是提示)。
 *     没开时工具**连报都不报**(不是报了再拒)—— 报出来的工具就是攻击面的一部分,
 *     外面的模型看不见它,就不会有人去试。
 *  2. **跑在一条专用会话里**,不碰用户正在聊的任何一条。理由不是整洁:会话是闸门与
 *     上下文的单位,借用户的会话跑 = 把那条会话攒下的「始终允许」与权限模式一并借走。
 *  3. **一次一轮,不排队**。那条会话忙着就直说忙(`busy`),不堆积。外面的 AI 重试
 *     一次的代价远小于本机被一串看不见的委派任务淹掉。
 *
 * 仍然要说清楚的残余风险:开了之后,拿到那条公网链接的人就能让本机 agent 替他干活,
 * 而 agent 手上有 bash。这组工具的闸门是**那个开关本身**,不是逐次审批 —— 因为外面
 * 的 AI 是在无人值守的时刻调过来的,逐次弹卡只会变成一串没人点的通知。
 *
 * ## 为什么是「起任务 / 取结果」两步,而不是一个同步工具
 *
 * 一轮 mcode 可能跑好几分钟,而 MCP 客户端(ChatGPT 那头)的单次调用等不了那么久 ——
 * 同步工具的结局是**客户端超时断开,而这边还在跑**:外面以为失败了,本机却在动文件,
 * 这是最糟的一种不一致。所以:
 *
 *   `mcode_agent_start` 立刻回一个 jobId → `mcode_agent_result` 想等多久等多久
 *   (自带上限,到点先回 `running`,再问就是了)。
 *
 * `mcode_agent_result` 允许短暂**阻塞**而不是纯轮询,是为了常见的快活儿:十几秒能跑完
 * 的事,外面一次调用就拿到答案,不用来回三趟。
 *
 * ## 依赖为什么是注入的
 *
 * 真正跑一轮要 `RuntimeManager` + `SessionRepo` + `ProjectRepo`,那条链拉进 db → electron。
 * 这张表会被 `publicMcpSession` 引到,而它活在几个无头 smoke 的打包图里 —— 直接 import
 * 会在 **esbuild 阶段**就红(本轮已经因为 `MobileHttpServer` 吃过一次,见那边的注释)。
 * 所以这里只留接口,实现由 `delegateHost.ts` 在主进程装配时塞进来。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpToolSpec } from "@main/mcp/sdk.js";

/** 一次委派的生命周期。`cancelled` 与 `failed` 分开:前者是这边喊停,后者是那一轮自己坏了。 */
export type DelegateJobStatus = "running" | "done" | "failed" | "cancelled";

export interface DelegateJob {
  id: string;
  sessionId: string;
  /** 发起这次委派的**公网合成会话**(哪条链接进来的)。取结果 / 打断只认同一条链接 ——
   *  多项目并行时,A 项目的链接不该看见或打断 B 项目的任务。 */
  callerSessionId: string | null;
  prompt: string;
  status: DelegateJobStatus;
  /** agent 这一轮说的话(累加)。`running` 时也给 —— 外面的 AI 能看到进展,不至于干等。 */
  text: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * 跑一轮所需要的全部外部能力。实现在 `delegateHost.ts`。
 *
 * `runTurn` 的约定:**resolve 即这一轮收场**(正常说完 / 出错 / 被打断),把最终文本
 * 带回来。中途的增量经 `onText` 给 —— 不是为了好看,是为了 `result` 在 `running` 时
 * 也有东西可回。
 */
export interface DelegateDeps {
  /** 那条专用会话(没有就建),返回 id 与工作目录。 */
  /**
   * 备好**这次调用该用的**委派会话。`callerSessionId` 是进来那条链接的合成会话 ——
   * 宿主据此决定在哪个项目里跑(一个项目一条委派会话,项目之间可以并行)。
   */
  ensureSession(callerSessionId: string | null): Promise<{ sessionId: string; cwd: string }>;
  isBusy(sessionId: string): boolean;
  runTurn(args: {
    sessionId: string;
    cwd: string;
    prompt: string;
    onText(chunk: string): void;
  }): Promise<{ text: string; error?: string }>;
  interrupt(sessionId: string): void;
  /** 用户在设置里开了没有。每次调用都现问 —— 开关关掉之后在跑的那一轮不受影响,但新的起不来。 */
  enabled(): boolean;
}

let deps: DelegateDeps | null = null;

/** 主进程装配时调用一次。传 `null` 可以摘掉(测试用)。 */
export function configureDelegateDeps(next: DelegateDeps | null): void {
  deps = next;
}

/** 这组工具现在报不报得出来 —— 没装配 or 用户没开 = 不报(见文件头第 1 条)。 */
export function delegateAvailable(): boolean {
  return deps !== null && deps.enabled();
}

/**
 * 跑过的任务。**有上限**:一个长期开着的桌面端,不设上限就是一条慢慢变大的内存。
 * 淘汰只动已经收场的 —— 在跑的那条无论多老都留着,否则 `result` 会查无此人。
 */
const jobs = new Map<string, DelegateJob>();
const MAX_JOBS = 40;

function evictOldFinished(): void {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(j.id);
  }
}

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const bad = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** 给外面看的一份,`text` 截断 —— 一轮可能很长,而 MCP 的返回要塞进对方的上下文。 */
const MAX_TEXT = 24_000;
function render(job: DelegateJob): string {
  const head = [
    `任务 ${job.id}`,
    `状态:${job.status}`,
    `会话:${job.sessionId}`,
    job.error ? `错误:${job.error}` : "",
  ]
    .filter(Boolean)
    .join("  ");
  const body =
    job.text.length > MAX_TEXT
      ? `（前 ${MAX_TEXT} 字，后面略）\n${job.text.slice(0, MAX_TEXT)}`
      : job.text || "（这一轮还没说话）";
  return `${head}\n\n${body}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 只有**同一条链接**起的任务才看得见(别的链接拿到任务号也当不存在,不透露它有过)。
 *
 *  ⚠️ **两边都得带链接身份才算"同一条"(fail closed）。** 从前只在**两边都非空**时
 *  才比较,于是 `job.callerSessionId === null` 的任务(`mcode_agent_start` 被直接以空
 *  会话调、绕过了 `webToolHost` 那道会话闸时)对**任何**链接都可见 —— 别的项目能取到它
 *  的结果、也能打断它。`callTool` 那条路会先挡掉没有会话的调用,所以这是**第二道**:
 *  直接驱 handler 的调用方、或将来放宽了那道门,都不能借一个 null 越界。任一边为 null
 *  一律当作"对不上",宁可让合法调用拿一句"没有这个任务号",也不 fail open。 */
function visibleJob(jobId: string, callerSessionId: string | null): DelegateJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.callerSessionId === null || callerSessionId === null) return undefined;
  return job.callerSessionId === callerSessionId ? job : undefined;
}

export const DELEGATE_MCP_TOOLS = [
  "mcode_agent_start",
  "mcode_agent_result",
  "mcode_agent_cancel",
] as const;

/**
 * 这组工具。**用户没开就返回空表** —— 调用方(`webToolHost`)照常展开,什么都不会多出来。
 */
export function delegateMcpTools(): McpToolSpec[] {
  if (!delegateAvailable()) return [];
  const d = deps as DelegateDeps;

  return [
    {
      name: "mcode_agent_start",
      description:
        "把一整件事交给这台机器上的 mcode agent 去做(它有自己的技能、工作流、记忆和工作目录)," +
        "立刻返回一个任务号。**这不是普通工具调用** —— 它会真的在用户机器上跑一轮,可能读写文件、执行命令。" +
        "适合「把 X 做完」这种成件的活儿;只想读一个文件就用 `agent_read`,别走这里。" +
        "跑多久不一定(常见十几秒到几分钟),拿结果用 `mcode_agent_result`。" +
        "同一个项目同一时刻只接一个:上一个还在跑就会告诉你 busy,等它完再来(不同项目的链接之间互不影响,可以并行)。",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe(
            "交代给 mcode agent 的任务,**当面跟人说话那样写全**:要做什么、在哪个目录、做到什么程度算完。" +
              "它看不到你和用户的对话,你不写的前提它就没有。",
          ),
      },
      handler: async (args: { prompt: string }, ctx: { sessionId?: string | null } = {}) => {
        const callerSessionId = ctx.sessionId ?? null;
        const { sessionId, cwd } = await d.ensureSession(callerSessionId);
        if (d.isBusy(sessionId)) {
          const running = [...jobs.values()].find((j) => j.status === "running" && j.sessionId === sessionId);
          return bad(
            `busy:这台机器上的 mcode agent 正忙${running ? `(任务 ${running.id})` : ""}。` +
              `等它收场再起新的 —— 用 mcode_agent_result 看进展。`,
          );
        }
        const job: DelegateJob = {
          id: `job_${randomUUID().slice(0, 8)}`,
          sessionId,
          callerSessionId,
          prompt: args.prompt,
          status: "running",
          text: "",
          startedAt: Date.now(),
        };
        jobs.set(job.id, job);
        evictOldFinished();

        // ⚠️ 这里**故意不 await**:起任务要立刻回(见文件头「为什么是两步」)。
        // 因此这个 promise 的失败必须在这儿吃掉 —— 漏出去就是一次
        // unhandledRejection,在 Electron 主进程里那是会把人吓一跳的崩溃日志。
        void d
          .runTurn({
            sessionId,
            cwd,
            prompt: args.prompt,
            onText: (chunk) => {
              job.text += chunk;
            },
          })
          .then((res) => {
            if (job.status === "cancelled") return; // 喊过停就不改写状态
            job.text = res.text || job.text;
            job.status = res.error ? "failed" : "done";
            job.error = res.error;
            job.endedAt = Date.now();
          })
          .catch((err: unknown) => {
            if (job.status === "cancelled") return;
            job.status = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.endedAt = Date.now();
          });

        return ok(
          `已交给 mcode agent。任务号 ${job.id}(会话 ${sessionId},工作目录 ${cwd})。\n` +
            `用 mcode_agent_result 取结果:传 wait_seconds 可以等一会儿再回,省一次来回。`,
        );
      },
    },

    {
      name: "mcode_agent_result",
      description:
        "取一次委派的进展或结果。可以让它**等**一会儿(wait_seconds)—— 任务在这期间收场就直接给你最终答案," +
        "没收场就先回 running 和已经说出来的那部分,再问一次即可。轮询请留间隔,别连打。",
      inputSchema: {
        job_id: z.string().min(1).describe("mcode_agent_start 给的任务号。"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(55)
          .optional()
          .describe(
            "最多等几秒再返回(默认 20,上限 55)。上限是按 MCP 客户端的单次调用超时留的余量 ——" +
              "等过头会变成对方断线,而这边还在跑。",
          ),
      },
      handler: async (args: { job_id: string; wait_seconds?: number }, ctx: { sessionId?: string | null } = {}) => {
        const job = visibleJob(args.job_id, ctx.sessionId ?? null);
        if (!job) return bad(`没有这个任务号:${args.job_id}(可能太旧被清掉了)。`);
        const deadline = Date.now() + (args.wait_seconds ?? 20) * 1000;
        while (job.status === "running" && Date.now() < deadline) {
          await sleep(500);
        }
        return ok(render(job));
      },
    },

    {
      name: "mcode_agent_cancel",
      description:
        "打断一次还在跑的委派。注意:**已经做过的事不会回滚** —— 文件改了就是改了,命令跑了就是跑了。",
      inputSchema: {
        job_id: z.string().min(1).describe("要打断的任务号。"),
      },
      handler: async (args: { job_id: string }, ctx: { sessionId?: string | null } = {}) => {
        const job = visibleJob(args.job_id, ctx.sessionId ?? null);
        if (!job) return bad(`没有这个任务号:${args.job_id}。`);
        if (job.status !== "running") return ok(`任务 ${job.id} 已经是 ${job.status},不用打断。`);
        job.status = "cancelled";
        job.endedAt = Date.now();
        d.interrupt(job.sessionId);
        return ok(`已打断任务 ${job.id}。已经做过的改动不会回滚。`);
      },
    },
  ];
}

/** 测试用:清空任务表。 */
export function __resetDelegateJobs(): void {
  jobs.clear();
}
