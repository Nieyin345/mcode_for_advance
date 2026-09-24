/**
 * `@main/store/repositories.js` 的替身 —— 一个内存版的 `WorkflowRepo`。
 *
 * 真的那一个要 sql.js + electron 的 `app`,无头脚本给不出来。这个 suite 要验的是
 * **归一化 + 校验**这一段(`mcodeServer.ts` → `library.ts` 的 `saveWorkflow`),
 * 而"存进表里"那一步的真相在 `repositories.ts`,不是这里要验的东西 —— 换掉它,
 * 断言"存进去了没有"照样成立,还顺带避开了拿真 `mcode.db` 跑 `initDb()` 的风险
 * (sql.js 会整份重写文件)。
 *
 * 只实现 `library.ts` 真正用到的四个方法。别的 repo 这里没有:用到了就会在打包时
 * 炸出来,而那正说明图的形状变了,该回来看一眼。
 *
 * ⚠️ `SettingRepo` 是统一资料库后**被迫**进来的:`nodeTypes.ts`(mcodeServer 的
 * "有哪些节点类型"要走)读类型注册表(`kindRegistry`)做「资料」下拉,注册表真身
 * 在 settings 表里。给一个内存版即可 —— 注册表读不到就退出厂表,正是我们要的兜底。
 */
import type { WorkflowDoc } from "@contracts/workflow";

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  builtin: boolean;
  doc: WorkflowDoc;
  updatedAt: number;
}

const rows = new Map<string, WorkflowRow>();

export const WorkflowRepo = {
  list(): WorkflowRow[] {
    return [...rows.values()];
  },

  get(id: string): WorkflowRow | null {
    return rows.get(id) ?? null;
  },

  save(doc: WorkflowDoc): void {
    const existing = rows.get(doc.id);
    rows.set(doc.id, {
      id: doc.id,
      name: doc.name,
      description: doc.description ?? null,
      icon: doc.icon ?? null,
      // 与真表一致:**对内置 id 写的这一行就是"覆盖内置"**。
      builtin: existing?.builtin ?? false,
      doc,
      updatedAt: doc.updatedAt,
    });
  },

  remove(id: string): void {
    rows.delete(id);
  },
};

/** Smoke 专用:清空,让每段断言从同一张白纸开始。 */
export function __resetWorkflowRepo(): void {
  rows.clear();
}

const settings = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return settings.get(key) ?? null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = settings.get(k) ?? null;
    return out;
  },
  set(key: string, value: string): void {
    settings.set(key, value);
  },
};

/**
 * `session_read_log` / `session_list` 工具要用的三个 —— 2026-09-21 补，2026-09-24 扩。
 *
 * **默认全空**（查不到会话、列不出消息）—— 这样本 suite（验工作流归一化，根本不会
 * 调到它们）的行为一个字没变。想验那两个工具本身时，用下面导出的 `__seedSessionLogs`
 * 灌夹具（`mcp-endpoint-smoke` 就是这么用的）。
 */
type StubSession = {
  id: string;
  title: string;
  projectId: string;
  archived: boolean;
  /** 置顶标记 —— `listPinned` 用（session_list 的活跃档要把置顶补回去）。 */
  pinnedAt?: number | null;
  updatedAt: number;
};
type StubMessage = { role: "user" | "assistant"; content: unknown };

let __sessions: StubSession[] = [];
let __messages: Record<string, StubMessage[]> = {};
let __projects: { id: string; name: string; path: string; archived: boolean }[] = [];

/** 灌一套夹具。不传的字段保持原样；传空数组 = 清干净。 */
export function __seedSessionLogs(f: {
  sessions?: StubSession[];
  messages?: Record<string, StubMessage[]>;
  projects?: { id: string; name: string; path: string; archived: boolean }[];
}): void {
  if (f.sessions) __sessions = f.sessions;
  if (f.messages) __messages = f.messages;
  if (f.projects) __projects = f.projects;
}

export const SessionRepo = {
  get(id: string): StubSession | undefined {
    return __sessions.find((s) => s.id === id);
  },
  /** `session_list` 用：一个项目一趟。⚠️ 活跃档（archived===false）**要滤置顶**
   *  —— 与真实现的口径一致（真实现加 `pinned_at IS NULL`），工具侧靠
   *  `listPinned` 把置顶补回来；桩不滤的话，工具补回那步会把置顶列两遍。 */
  listByProject(projectId: string, opts?: { archived?: boolean }): StubSession[] {
    return __sessions.filter(
      (s) =>
        s.projectId === projectId &&
        (opts?.archived === undefined || s.archived === opts.archived) &&
        (opts?.archived === false ? s.pinnedAt == null : true),
    );
  },
  /** 跨项目取置顶（真实现按 `pinned_at DESC`）。 */
  listPinned(): StubSession[] {
    return __sessions.filter((s) => !s.archived && s.pinnedAt != null);
  },
};

export const MessageRepo = {
  listBySession(sessionId: string): { messages: StubMessage[] } {
    return { messages: __messages[sessionId] ?? [] };
  },
};

/**
 * `agent_context` 要"我在什么环境里" —— 它经 `providers/envPrompt.js` 读这两个 repo。
 * 无头给不了真库(sql.js + electron),这里返回**空**,于是那个工具"没项目、空库"
 * 那条支路被走到 —— 正是我们要的兜底(smoke 正好能验它在空环境下不炸)。
 */
export const ProjectRepo = {
  list(): { id: string; name: string; path: string; archived: boolean }[] {
    return __projects;
  },
};

export const LibraryRepo = {
  list(_filter?: unknown): { items: unknown[]; total: number } {
    return { items: [], total: 0 };
  },
};
