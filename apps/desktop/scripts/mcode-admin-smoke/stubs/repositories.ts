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
 * `session_read_log` 工具要用的两个 —— 2026-09-21 补。
 *
 * 那两条只**读**（按 id 取一条会话、列它的消息），而这个 suite 验的是工作流的
 * 归一化与校验，根本不会调到它们。这里给个"查不到"的最小实现就够：真被调到时
 * 返回空，而不是让打包炸掉。
 */
export const SessionRepo = {
  get(id: string): { id: string; title: string } | undefined {
    return id === "" ? undefined : undefined;
  },
};

export const MessageRepo = {
  listBySession(_sessionId: string): { messages: unknown[] } {
    return { messages: [] };
  },
};
