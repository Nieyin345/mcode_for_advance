/**
 * 【MC-048】守望模板的**单一异步事务围栏** —— 所有增 / 删 / 改共用一条串行队列。
 *
 * ## 它补的洞（第十六轮复核的 E1）
 *
 * 从前 `removeTemplate` 与 `saveTemplate` 各自乐观改本地列表、各自 await 保存、各自
 * 失败回滚。两笔并发时（删除 A 与新增 C），**后完成的响应**覆盖先完成的：服务器先
 * 完成新增、后完成删除 → UI=[B,C]、盘上=[B]、`notice=null` —— 两笔都"成功"，界面与
 * 持久化却分了岔。给每个按钮单独补 catch 挡不住这个：问题不在单笔的错误处理，而在
 * **多笔之间没有顺序与共同基准**。
 *
 * ## 协议（台账系统性修复的原话逐条对应）
 *
 *   - **共同基准**：每条变换收到的是「上一条确认之后」的列表（`transform(current)`），
 *     不是按钮按下那一刻的快照 —— 排队的两条不会互相覆盖。
 *   - **串行 + 重复提交围栏**：同一时刻最多一笔在飞；后来的排队。`pending` 随
 *     `onChange` 发出，组件据此禁用按钮。
 *   - **只有确认才生效**：不做乐观确认 —— 保存返回 `ok` 之后才发出新列表。界面上的
 *     "变了"就是盘上真的变了。
 *   - **原值版本 CAS**：每笔带 `expectedRevision`（与 MC-054 同一条判据）。
 *   - **冲突 → 重载 + 重放一次**：盘上被别处改过时先重读权威，再把**这一条变换**
 *     重放到重读后的列表上重试一次；仍冲突则如实报错并停止（不无限重试）。
 *   - **失败 → 丢弃排队**：一笔失败后，后续变换建立在未成功的状态上，一律作废并各自
 *     收到失败（不静默丢、也不假装成功）。
 *   - **关闭取消**：`close()` 后不再回调组件状态，排队清空；在飞的那笔结果被忽略 ——
 *     面板已关，不能事后把状态改回去。
 *
 * 纯模块（只 import 契约），便于无头断言；组件只做"把 onChange 投影成 setState"。
 */
import type { WatchCommandTemplate } from "@contracts/ipc";
import { watchTemplatesRevision } from "@contracts/ipc/workflow";

export type WatchTemplatesHealth = "absent" | "valid" | "partial" | "corrupt" | "read_error";

/** 面板要展示的权威状态（`revision` 是保存时要带回的原值版本）。 */
export interface WatchTemplatesSnapshot {
  templates: WatchCommandTemplate[];
  health: WatchTemplatesHealth;
  problems: string[];
  revision: string | null;
}

/** 一次变换：在**当前确认状态**上算出下一份列表。用函数而不是现成数组，正是为了让
 *  排队的两条各自基于"上一条完成之后"的列表（台账红例的根因）。 */
export type WatchTemplatesTransform = (current: readonly WatchCommandTemplate[]) => WatchCommandTemplate[];

export interface WatchTemplatesSyncPorts {
  read(): Promise<{
    templates: WatchCommandTemplate[];
    health?: WatchTemplatesHealth;
    problems?: string[];
    revision?: string;
  }>;
  save(input: { templates: WatchCommandTemplate[]; expectedRevision: string | null }): Promise<{
    ok: boolean;
    error?: string;
    conflict?: boolean;
  }>;
  /** 每次权威状态变化（含 pending）与提示语的投影。组件据此 setState。 */
  onChange(snapshot: WatchTemplatesSnapshot & { pending: boolean }, notice: string | null): void;
}

export type WatchTemplatesMutationResult =
  | { ok: true; templates: WatchCommandTemplate[] }
  | { ok: false; notice: string };

export interface WatchTemplatesSync {
  /** 读/重读权威状态（打开面板、重建之后）。 */
  load(): Promise<WatchTemplatesSnapshot>;
  /** 排一条变换；resolve 表示"这一条最终成没成"（与它在队列里的位置无关）。 */
  mutate(transform: WatchTemplatesTransform): Promise<WatchTemplatesMutationResult>;
  /** 面板关闭：停止回调、清空排队（在飞的那笔结果被忽略）。 */
  close(): void;
}

interface QueueEntry {
  transform: WatchTemplatesTransform;
  resolve(result: WatchTemplatesMutationResult): void;
}

export function createWatchTemplatesSync(ports: WatchTemplatesSyncPorts): WatchTemplatesSync {
  let confirmed: WatchTemplatesSnapshot = { templates: [], health: "valid", problems: [], revision: null };
  const queue: QueueEntry[] = [];
  let running = false;
  let closed = false;

  const emit = (notice: string | null): void => {
    if (closed) return;
    ports.onChange({ ...confirmed, templates: [...confirmed.templates], pending: running || queue.length > 0 }, notice);
  };

  const snapshotFrom = (loaded: Awaited<ReturnType<WatchTemplatesSyncPorts["read"]>>): WatchTemplatesSnapshot => ({
    templates: loaded.templates,
    health: loaded.health ?? "valid",
    problems: loaded.problems ?? [],
    revision: loaded.revision ?? null,
  });

  /** 用"当前确认状态"保存一份列表；返回主进程的原始回包。
   *
   *  【MC-054 第十七轮】`expectedRevision` 现在是**必填**的(主进程缺字段即拒)。
   *  读口没给 revision 的旧宿主(理论上不存在,但防御式处理)用显式 `null`:
   *  那是"我知道自己在整表覆盖"的唯一合法写法 —— 与"没带字段"在契约里是两个值。
   *  正常路径永远带真实 revision。 */
  const save = (templates: WatchCommandTemplate[]): ReturnType<WatchTemplatesSyncPorts["save"]> =>
    ports.save({ templates, expectedRevision: confirmed.revision });

  const flush = async (): Promise<void> => {
    if (running) return;
    running = true;
    emit(null);
    try {
      while (queue.length > 0 && !closed) {
        const entry = queue[0]!;
        // 共同基准：变换作用在**当前确认状态**上（不是按钮按下时的快照）。
        let next = entry.transform(confirmed.templates);
        let reply = await save(next);
        if (!reply.ok && reply.conflict === true) {
          // 外部改动：重读权威，再按重读后的列表重放**这一条**一次。
          const reloaded = snapshotFrom(await ports.read());
          confirmed = reloaded;
          next = entry.transform(confirmed.templates);
          reply = await save(next);
          if (reply.ok) {
            queue.shift();
            confirmed = { ...confirmed, templates: next, revision: watchTemplatesRevision(next), health: "valid", problems: [] };
            entry.resolve({ ok: true, templates: next });
            emit("模板已被别处改动，已重新加载并保留了你这次的修改。");
            continue;
          }
        }
        if (reply.ok) {
          queue.shift();
          // 保存成功后的权威状态：内容就是 next；revision 用与主进程**同一个**函数算。
          confirmed = { ...confirmed, templates: next, revision: watchTemplatesRevision(next) };
          entry.resolve({ ok: true, templates: next });
          emit(null);
          continue;
        }
        // 失败：这一条与它之后的排队都建立在未成功的状态上 —— 全部作废并如实告知。
        const notice = reply.error ?? "保存命令模板失败。";
        for (const pending of queue.splice(0)) pending.resolve({ ok: false, notice });
        emit(notice);
        break;
      }
    } catch (error) {
      const notice = error instanceof Error ? error.message : String(error);
      for (const pending of queue.splice(0)) pending.resolve({ ok: false, notice });
      emit(notice);
    } finally {
      running = false;
      if (!closed) emit(null);
    }
  };

  return {
    async load(): Promise<WatchTemplatesSnapshot> {
      const snapshot = snapshotFrom(await ports.read());
      if (!closed) confirmed = snapshot;
      emit(null);
      return snapshot;
    },
    mutate(transform: WatchTemplatesTransform): Promise<WatchTemplatesMutationResult> {
      if (closed) return Promise.resolve({ ok: false, notice: "面板已关闭。" });
      return new Promise<WatchTemplatesMutationResult>((resolve) => {
        queue.push({ transform, resolve });
        emit(null);
        void flush();
      });
    },
    close(): void {
      closed = true;
      for (const pending of queue.splice(0)) pending.resolve({ ok: false, notice: "面板已关闭。" });
    },
  };
}
