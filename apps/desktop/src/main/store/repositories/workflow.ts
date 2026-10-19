/**
 * 工作流文档 —— workflows 表的文档读写。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import { WorkflowDocSchema, type WorkflowDoc } from "@contracts/workflow";
import { getDb, persist } from "../db.js";
import { v, type BindValue } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

/* ──────────────────────────────── 工作流 ───────────────────────────────── */

/** 工作流表里的一行。
 *
 * **这一层只管存储** —— 与代码里那六个内置工作流的合并、以及「恢复默认」的语义,
 * 都在 `main/orchestration/` 里做。放在这里会让"删一行"这种存储操作背上业务含义,
 * 而调用方会以为自己在做存储。 */
export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  /** true = 这一行是对某个内置工作流的覆盖(不是用户新建的)。 */
  builtin: boolean;
  doc: WorkflowDoc;
  updatedAt: number;
}

function rowToWorkflow(r: Record<string, BindValue>): WorkflowRow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description === null ? null : String(r.description),
    icon: r.icon === null ? null : String(r.icon),
    builtin: Number(r.builtin) === 1,
    // A corrupt row is not a new, empty workflow. Never feed a synthetic
    // blank document into import/edit/save or overwrite its original bytes.
    doc: parseWorkflowDoc(String(r.payload), String(r.id)),
    updatedAt: Number(r.updated_at),
  };
}

function parseWorkflowDoc(raw: string, rowId: string): WorkflowDoc {
  const invalid = (reason: string): never => {
    // Never log the raw payload; graph node params can contain user secrets.
    throw new Error(`工作流「${rowId}」存档损坏（${reason}），已拒绝伪造空文档或覆盖原记录；请先备份后修复。`);
  };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return invalid("JSON 解析失败");
  }
  const checked = WorkflowDocSchema.safeParse(decoded);
  if (!checked.success) return invalid("文档结构不符合工作流契约");
  if (checked.data.id !== rowId) return invalid("持久行 ID 与文档 ID 不匹配");
  // Preserve unknown fields on read. The workflow import/export layer owns
  // their round-trip policy; using checked.data here would silently strip them.
  return decoded as WorkflowDoc;
}

function getWorkflowRow(id: string): WorkflowRow | null {
  const stmt = getDb().prepare("SELECT * FROM workflows WHERE id = ?");
  return withStatement(stmt, (query) => {
    query.bind([v(id)]);
    const found = query.step();
    const row = found ? (query.getAsObject() as Record<string, BindValue>) : null;
    return row ? rowToWorkflow(row) : null;
  });
}

export const WorkflowRepo = {
  /** 全部行(用户对内置的覆盖 + 用户自建的)。内置的默认版不在这个表里。 */
  list(): WorkflowRow[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM workflows ORDER BY sort_order ASC, created_at ASC",
    );
    return withStatement(stmt, (query) => {
      const out: WorkflowRow[] = [];
      while (query.step()) out.push(rowToWorkflow(query.getAsObject() as Record<string, BindValue>));
      return out;
    });
  },

  get: getWorkflowRow,

  /** 写入或覆盖一行。`doc.id` 就是主键 —— 对内置工作流来说,写一行就是"覆盖它的默认版"。 */
  save(doc: WorkflowDoc): void {
    const db = getDb();
    // 用局部函数而不是 `this.get` —— 对象字面量的方法一旦被解构,`this` 就断了。
    const existing = getWorkflowRow(doc.id);
    // 新建的排在最后(和 projects 的 sort_order 同一条规则);覆盖时保持原位。
    let sortOrder = 0;
    if (existing === null) {
      const stmt = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM workflows");
      sortOrder = withStatement(stmt, (query) => {
        query.step();
        return Number((query.getAsObject() as { next: BindValue }).next);
      });
    }
    const now = Date.now();
    db.run(
      `INSERT INTO workflows (id, name, description, icon, builtin, payload, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         icon        = excluded.icon,
         payload     = excluded.payload,
         updated_at  = excluded.updated_at`,
      [
        v(doc.id),
        v(doc.name),
        v(doc.description ?? null),
        v(doc.icon ?? null),
        v(doc.builtin),
        v(JSON.stringify(doc)),
        v(sortOrder),
        v(now),
        v(now),
      ],
    );
    persist();
  },

  /** 删掉一行。**删掉对某个内置工作流的覆盖,就等于「恢复默认」** —— 代码里的
   *  默认版立刻回来,不需要在表里另存一份原版。 */
  remove(id: string): void {
    getDb().run("DELETE FROM workflows WHERE id = ?", [v(id)]);
    persist();
  },
};
