/**
 * 【T18】安装卡片决策的**宿主侧收窄** —— 纯函数,不 import electron。
 *
 * 「始终允许」只能由坐在电脑前的用户亲手给出。渲染端那一层知道"用户点了卡片"，
 * 但渲染端可以发任意 IPC —— 所以主进程这里再用**发送方身份**兜底：
 *
 *   - 真实的 `IpcMainInvokeEvent` 带 `sender.id`（正整数 webContents id）；
 *   - Agent 的 `app_api_call`、扩展的 `core.app.call`、面板桥走的都是
 *     `callRpc(entry, input)`，event 是 `{}`，拿不到发送方。
 *
 * **没有发送方 → 不采信 `allow-always`**，收窄为 `allow-once`（本次运行有效）。
 * 这条判据是 fail-closed 方向：能伪造的越少，授权越短。它**不是**身份认证
 * （真正防的是"非窗口通道静默铸造跨重启授权"）；Agent 侧另有 `policy.ts` 的
 * danger 审批卡（每次必弹、不给"始终允许"），两层各管一段。
 *
 * 与 `ModuleHost.install` 的 `decision` 参数同一份值域（见那里的注释）。
 */
export type ModuleInstallDecision = "allow-once" | "allow-always" | "deny";

/** 从 IPC event 里取真实渲染端发送方 id；拿不到（无 event / 合成对象）返回 null。 */
export function desktopSenderId(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const sender = (event as { sender?: { id?: unknown } }).sender;
  const id = sender && typeof sender === "object" ? sender.id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 已校验入参 → 宿主决策（见文件头的收窄规则）。 */
export function resolveInstallDecision(
  input: { installConsent?: ModuleInstallDecision },
  event: unknown,
): ModuleInstallDecision {
  const decision = input.installConsent ?? "allow-once";
  if (decision === "deny") return "deny";
  if (decision === "allow-always" && desktopSenderId(event) === null) return "allow-once";
  return decision;
}
