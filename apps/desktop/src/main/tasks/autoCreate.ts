/**
 * 【T100】让任务真的被建出来、真的走完 —— 消息 → 任务 → 状态 → 产物。
 *
 * ## 这张卡要解决的问题
 *
 * T99 把 `tasks` 表、契约、IPC 三层都立起来了，但**没有任何生产路径写它**。
 * 一张只有 handler、没有调用方的表，和一个只有 handler、没有调用方的 API 是同一件事：
 * 它对用户没有任何作用。路线图 §3 说「任务是一级对象」，而一级对象必须**被真的创建**。
 *
 * ## 三个判断（卡上要求论证）
 *
 * ### ① 不是每条用户消息都建任务
 *
 * 「任务」和「消息」不是一回事。用户问一句「这个函数干什么的」是一条消息，
 * 但没有目标、没有产物、没什么可验收 —— 把它建成任务会让任务列表变成**聊天记录的副本**，
 * 而路线图要的是「任务中心能追踪状态、失败、审批、产物与证据」（§5）。
 *
 * 判据用**主进程已经知道的事实**，不用猜意图：
 *
 *   - 会话 `kind` 必须是 `chat`。`side`（右侧问答）/ `node`（工作流节点）/
 *     `automation`（自动化触发）都是**用户没在看着**的会话，它们产出的是中间结果，
 *     不是用户要验收的东西。给它们建任务会让「我的任务」里塞满看不见来源的条目。
 *   - 这一轮必须**真的产出了文件**（`turn.files` 非空），或者**失败了**（`turn.done`
 *     reason 非 end_turn / interrupted）。纯问答什么都不产出 → 不建。
 *
 * **为什么要等到回合结束才建**：会话开始时我们还不知道这一轮会不会产出东西。
 * 先建再删会留下 `rejected` / `failed` 的残骸，而用户从没要求过；等结束再建，
 * 「建了」这件事本身就带着「确实发生了」的含义。
 *
 * 这也意味着任务是 `pending → running → done` 一次走完的：回合结束那一刻，
 * 建 + 置状态两件事一起发生。**这是刻意的** —— 中间态（`pending` / `running`）在这里
 * 没有观察者，凭空造它们只会让「状态」变成装饰。`pending` / `running` 的用途是
 * **未来的执行路径**（用户显式建任务、Agent 认领任务），那条路现在还没有。
 *
 * ### ② 任务与消息的关联：`origin` + `links` 双轨
 *
 * `origin = { kind: "session", ref: sessionId, projectPath }` 记**谁发起的**；
 * 产物进 `artifacts`。**不把消息 id 塞进任务** —— 任务要能脱离聊天活着（§3 第一条），
 * 把它绑死在某条消息上就是「依附聊天」。
 *
 * `kind: "session"` 是新增的取值（`TaskOriginSchema` 原本只有
 * `user` / `agent` / `workflow` / `automation`）。语义上它是「用户在这个会话里发起的」，
 * 而 `user` 那条留给「用户从任务中心 UI 直接建的」。两者的区别是**发起时用户是否坐在
 * 一个对话里**，而这决定了任务的 `projectPath` 与 `ref`。
 *
 * ### ③ 状态流转：这一轮只做 `pending → done` / `failed`
 *
 * ```
 * 回合结束、有产物  → 建 pending → 立刻 done（带 artifacts）
 * 回合结束、失败    → 建 pending → 立刻 failed（带 failureReason）
 * ```
 *
 * `accepted` / `rejected` 只有用户能写（T99 的硬边界），而**UI 入口是下一张卡**。
 * 本卡不假装它已经能用：`task.accept` / `task.reject` 的 IPC 已经就绪，缺的是界面。
 *
 * ## 这一层为什么是订阅者而不是改 `RuntimeManager`
 *
 * `RuntimeManager` 是共享文件（三个 Provider、图调度器、通知都要它）。往里面加
 * 「建任务」是在给核心事件流加业务分支。`runtimeManager.subscribe()` 是现成的挂载点
 * （`HookRunner` / `automationRunner` / `NotificationManager` 都用它），订阅者拿到的是
 * **同一个事件流**，而且订阅者抛错不会把事件流带下去（见 `notifySubscribers`）。
 *
 * ## 事件顺序
 *
 * `turn.files` 在 `turn.done` **之前**发出（`RuntimeManager` 的 handler 里，`turn.files`
 * 落库后紧接着 notify）。所以订阅者不能「收到 turn.done 就用当前缓冲建任务」——
 * 必须等到 `turn.done` 那一刻，此时 `turn.files` 已经到齐。
 */

import { randomUUID } from "node:crypto";
import type { RuntimeEvent, TurnFileEntry } from "@contracts/runtime";
import type { TaskArtifact } from "@contracts/ipc";
import { SessionRepo } from "@main/store/repositories.js";
import { transitionTaskAsExecutor } from "./executor.js";
import { TaskRepo } from "@main/store/repositories/task.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastRuntimeEvent } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

/** 每个会话这一轮攒的产物。`turn.files` 先到，`turn.done` 才结算。 */
const bufferedFiles = new Map<string, TurnFileEntry[]>();

/** 一轮的最大产物条数。与 `TaskSchema.artifacts` 的 `.max(512)` 对齐。 */
const MAX_ARTIFACTS = 512;

/**
 * 从这一轮的文件快照里提炼产物。
 *
 * **只算真的产出了东西的**：`created` 一定是产物；`modified` 只有在 deltas 为正
 * （净增了内容）时才算 —— 一个只删了几行、或者只改了末尾换行的文件不是「产物」，
 * 它是「修改」。这条判断的价值在于**用户看到的任务产物列表不会变成一份 diff 清单**。
 */
function artifactsOf(files: TurnFileEntry[]): TaskArtifact[] {
  const now = Date.now();
  const out: TaskArtifact[] = [];
  for (const f of files) {
    if (out.length >= MAX_ARTIFACTS) break;
    const isNew = f.kind === "created";
    const grew = f.kind === "modified" && f.adds - f.dels > 0;
    if (!isNew && !grew) continue;
    out.push({
      path: f.filePath,
      description: isNew ? `新建文件（+${f.adds} 行）` : `扩充内容（+${f.adds} / −${f.dels} 行）`,
      createdAt: now,
    });
  }
  return out;
}

/**
 * 这一轮算不算一次「任务」—— 判据见文件头 ①。
 *
 * 单独抽出来是为了让套件能直接验它：如果判据长在订阅者的闭包里，套件只能整段模拟，
 * 而模拟出来的闭包和生产不是同一份实现（这个仓库栽过）。
 */
export function classifyTurn(args: {
  sessionKind: string;
  reason: string;
  artifacts: TaskArtifact[];
}): { create: boolean; failed: boolean; why: string } {
  if (args.sessionKind !== "chat") {
    return { create: false, failed: false, why: `会话类型 ${args.sessionKind} 不是用户面对的对话` };
  }
  if (args.reason === "interrupted") {
    return { create: false, failed: false, why: "用户主动停止的回合不算任务" };
  }
  if (args.reason === "error") {
    return { create: true, failed: true, why: "回合失败，记成 failed 任务（用户要能看见失败）" };
  }
  if (args.artifacts.length === 0) {
    return { create: false, failed: false, why: "这一轮没有产出文件，是问答不是任务" };
  }
  return { create: true, failed: false, why: `产出 ${args.artifacts.length} 个文件` };
}

/** 任务目标：拿会话标题当人话目标。标题就是首条消息的前 40 字（见 claude.ts 的 auto-title）。 */
function goalOf(sessionId: string): string | null {
  const session = SessionRepo.get(sessionId);
  if (!session) return null;
  const title = (session.title ?? "").trim();
  if (title.length === 0 || title === "New session") return null;
  return title;
}

/**
 * 回合结束时结算 —— **唯一一条建任务的路**。
 *
 * `reason` 必须由调用方传（`turn.done` 的 `reason`），因为判据要区分
 * `end_turn` / `error` / `interrupted` 三种收尾。**不能在这里写死 `"end_turn"`**：
 * 那样失败回合就只能走另一个函数，而两份建任务逻辑迟早会漂开（这个仓库栽过，
 * 硬规矩 2「共享实现只有一份」）。第一版就是两份，`interrupted` 判据在
 * `settleTurn` 那条路上因此走不到 —— 变异验证时它只红了一条，露了底。
 *
 * 返回值给套件用（生产路径不看它）：显式返回让「没做」和「做了但失败」分得开。
 */
export function settleTurn(args: {
  sessionId: string;
  files: TurnFileEntry[];
  reason: string;
}): { created: boolean; taskId?: string; status?: "done" | "failed"; why: string } {
  const session = SessionRepo.get(args.sessionId);
  if (!session) return { created: false, why: "会话已不存在" };
  const artifacts = artifactsOf(args.files);
  const verdict = classifyTurn({ sessionKind: session.kind, reason: args.reason, artifacts });
  if (!verdict.create) return { created: false, why: verdict.why };
  const goal = goalOf(args.sessionId);
  if (goal === null) return { created: false, why: "会话还没有可用的标题" };

  const id = `task_${randomUUID()}`;
  TaskRepo.create({
    id,
    task: {
      goal,
      origin: {
        kind: "session",
        ref: args.sessionId,
        ...(session.projectId ? { projectPath: session.projectId } : {}),
      },
      dependsOn: [],
    },
  });
  // 状态走完整条链：`pending → running → done / failed`。
  //
  // ## 为什么不在建完时直接置 done
  //
  // 第一版是直接 `pending → done`，**被迁移表当场拒掉**（`done` 只能从 `running` 来）。
  // 那条拒绝是对的：`pending` 的含义是「建出来了，还没开始」，直接跳到 `done` 意味着
  // 这条任务的 `running` 从来没有过 —— 而迁移表存在的意义就是「每个状态都真的发生过」。
  //
  // 这里的三步不是摆设：它们对应**同一瞬间**发生的三件事（回合结束 → 判定该建
  // → 执行方接手 → 收尾），只是宿主没有中间的观察者。**状态记录的是事实，不是动画**：
  // `running` 确实发生过（接收这一轮的产物那一刻），所以它该被写下来。
  //
  // 走 `transitionTaskAsExecutor` 而不是 `TaskRepo.setStatus`：多一道
  // `TASK_EXECUTOR_STATUSES` 白名单 —— 那是「执行方不能写 accepted」这条授权规则所在。
  // 绕过它，这条自动记账路径就成了唯一一处没有那道防线的地方。
  transitionTaskAsExecutor({ id, status: "running" });
  const next = transitionTaskAsExecutor({
    id,
    status: verdict.failed ? "failed" : "done",
    ...(verdict.failed
      ? { failureReason: `这一轮执行失败（${args.reason}）` }
      : { artifacts }),
  });
  broadcastRuntimeEvent({ type: "task.changed", sessionId: args.sessionId, task: next });
  return { created: true, taskId: next.id, status: next.status as "done" | "failed", why: verdict.why };
}

/** 这一轮的事件分发。同步、不 await —— 与 `HookRunner` / `automationRunner` 同型。 */
function onEvent(e: RuntimeEvent): void {
  if (e.type === "turn.files") {
    bufferedFiles.set(e.sessionId, e.files);
    return;
  }
  if (e.type !== "turn.done") return;
  const files = bufferedFiles.get(e.sessionId) ?? [];
  bufferedFiles.delete(e.sessionId);
  try {
    // 所有收尾原因都走同一条结算 —— 判据在 `classifyTurn` 里，不在这里分岔。
    // `turn.done` 的四个 reason 都可能带产物（失败前可能已经写了文件）。
    settleTurn({ sessionId: e.sessionId, files, reason: e.reason });
  } catch (err) {
    log.warn(`[task] 结算任务失败（${e.sessionId}）:${(err as Error).message}`);
  }
}

let unsubscribe: (() => void) | null = null;

/** 起订阅。幂等 —— 重复调用不会挂两个。 */
export function startTaskAutoCreate(): void {
  if (unsubscribe !== null) return;
  unsubscribe = runtimeManager.subscribe((e) => {
    try {
      onEvent(e);
    } catch (err) {
      log.warn(`[task] 事件分发失败:${(err as Error).message}`);
    }
  });
  log.info("[task] 消息 → 任务自动创建已启动");
}

/** 停订阅（套件收尾 / 主进程关停用）。 */
export function stopTaskAutoCreate(): void {
  unsubscribe?.();
  unsubscribe = null;
  bufferedFiles.clear();
}
