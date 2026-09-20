/**
 * 集成终端(xterm.js + node-pty)的设置键与 RPC 入参。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── Integrated terminal (xterm.js + node-pty) ──
 *  PTY processes live in main. Renderer only sees opaque terminalIds and
 *  streams data over push channels. Every create is scoped to a known
 *  project root (cwd must resolve inside that root). */

/** Setting key for the user-preferred shell executable (absolute path or
 *  bare command name). Empty/absent → platform smart default. */
export const TERMINAL_SHELL_SETTING_KEY = "terminal.shell";

/** 一个终端是**谁开的** —— 终端列表靠它分组。
 *
 *  两种来源,而 `session` 这一支**不新造身份**:`sessionId` 就是会话表里的那一行,
 *  与左栏、看板、流程记录用的是同一个 id。代理/子代理/工作流节点/自动化要开终端时,
 *  把自己那条会话 id 传进来即可 —— 不需要一个平行的"代理 id"。
 *
 *  ⚠️ **为什么把 `kind` 装进一个对象再放进 create 出参,而不是直接给终端加个
 *  `ownerSessionId`**:两者的区别只在"以后要不要继续加字段"(比如加一个 `title`
 *  用来画界面),而 discriminated union 的判别式是**推不出来的** —— 一旦用可选字段,
 *  某天多一个来源就会出现在列表里既不显示"用户"也不显示会话名的那一档。写死它的形状,
 *  加一档时 typecheck 会把每一处 switch 都点出来。
 *
 *  `nodeSessionId` 是**可选**的:同一会话里的子代理要能说出自己是谁,但它不是另一条
 *  身份线,只是那一行下面的一个节点会话。 */
export const TerminalOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("session"),
    /** The session that opened it (`sessions.id` — same id the rest of the app uses). */
    sessionId: z.string().min(1),
    /** Display name captured at open time, so the list renders without a join. */
    title: z.string().optional(),
    /** Workflow-graph node session that opened it, when it wasn't the main turn. */
    nodeSessionId: z.string().optional(),
  }),
]);
export type TerminalOrigin = z.infer<typeof TerminalOriginSchema>;

/** "用户手点的" —— create 不传 `origin` 时就是它。 */
export const USER_TERMINAL_ORIGIN: TerminalOrigin = { kind: "user" };

/** 每条终端在主进程里**最多留这么多字符**的输出尾巴。
 *
 *  它是一个**环** —— 超了就从头部丢(按字符,不是按行),留下的永远是最近那一段。
 *  为什么要有它:渲染端拿到的输出是**纯推送**(`terminal:data`),而滚动缓冲活在哪
 *  一个 xterm 实例里。终端列表要能"切过去看某一条",那条终端多半**不是**这个面板
 *  创建的(它可能属于另一个项目、另一个会话),我们手上就什么都没有 —— 没有这段
 *  尾巴的话,切过去看到的是一个空白终端。 */
export const TERMINAL_BUFFER_CHARS = 20_000;

/** Snapshot of a live (or just-exited) terminal session. */
export interface TerminalInfo {
  terminalId: string;
  /** Absolute cwd the PTY was spawned with. */
  cwd: string;
  /** Resolved shell executable path/name. */
  shell: string;
  /** OS process id while alive; 0 after exit. */
  pid: number;
  /** Project root this terminal is bound to. */
  projectPath: string;
  /** 谁开的。**总是有值** —— 老调用方不传时落成 `{ kind: "user" }`。 */
  origin: TerminalOrigin;
  /** 输出尾巴(**只在 `terminal.list` 传了 `bufferFor` 带上这个 id 时才有**)。
   *
   *  平时为 undefined:列表轮询每几秒一次,把每条终端的输出都塞进结果里是白搬的
   *  字节。只有"用户正要接入这一条"时才要它 —— 见 {@link TERMINAL_BUFFER_CHARS}。 */
  buffer?: string;
}

/** Create a new PTY bound to a project. `cwd` defaults to `projectPath`. */
export const TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional(),
  /** 谁开的。**可选** —— 不传 = 用户手点的(`{ kind: "user" }`),所以既有的
   *  调用方一行都不用改,而界面上那一条照样说得出来历。 */
  origin: TerminalOriginSchema.optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateSchema>;

export const TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>;

export const TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>;

export const TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional(),
  /** 要**顺带把输出尾巴带回来**的那一条终端 id(见 {@link TerminalInfo.buffer})。
   *  只有正要接入某一条时才传 —— 列表轮询不传。 */
  bufferFor: z.string().min(1).optional(),
});
export type TerminalListInput = z.infer<typeof TerminalListSchema>;

/** Structured result for create — either success fields or ok:false + error. */
export type TerminalCreateResult =
  | {
      ok: true;
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
    }
  | { ok: false; error: string };

export interface TerminalOpResult {
  ok: boolean;
  error?: string;
}

