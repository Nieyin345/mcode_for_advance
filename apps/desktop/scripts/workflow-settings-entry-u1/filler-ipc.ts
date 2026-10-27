/**
 * W26 —— `/api-stub.js` 的替身？不。
 *
 * 本套件**不使用** `electron-u1/api-stub.js` 的 `window.labApi`：那条路会把
 * `renderer/lib/api.ts` 换成一个内存桩（见 `electron-u1/build.mjs` 的 `stubs`），
 * 从而 `api.documentView.open` / `api.workflowEngine.start` 全部打不到主进程 ——
 * **而本卡的判据恰恰是「视图真的开了」**。桩不出来。
 *
 * 真正的数据源在这里：页面用**产品真 preload**（`preload: "product"`）——
 * `window.api` 是真的 contextBridge 白名单实现，IPC 走真通道；
 * 主进程那一侧由 `harness.ts` 装配生产 `DocumentViewHost` + 生产
 * `workflowEngine` 注册表，其余域由本文件按契约形状补最小只读 handler（它们不参与
 * 本卡判据，只为让真 App 的启动水合不炸）。
 *
 * ## 为什么是「按契约形状的最小桩」而不是「全真 handler」
 *
 * 真 App 启动时 `sessionStore.init()` 会读 setting/project/session/provider…
 * 这些域的真 handler 各自拖入一大片与本卡无关的主进程代码（聊天运行时、原生音频、
 * TTS…），而本卡的判据**一条都不经过它们**。把它们换成「形状正确的空结果」，风险
 * 只剩「真 App 因为拿到空数据而渲染出别的界面」—— 那不影响本卡（本卡点的是左栏
 * 底部的「设置」按钮，它永远渲染），但只要渲染崩了，`window.__mounted` 与后续
 * DOM 断言会如实红。
 *
 * ⚠️ **`documentView` / `workflowEngine` 这两组绝不在此处补桩** —— 它们由
 * `harness.ts` 装配**生产实现**。`registerFillerHandlers` 在 `register` 之前检查
 * 通道名，撞上就报错（fail-closed，绝不静默覆盖真 handler）。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";

interface Filler {
  channel: string;
  /** 返回给渲染端的值。**形状必须与契约一致**，否则真 App 的消费方会抛错。 */
  value: () => unknown;
}

/**
 * 只读域的填充值。**每一个都对应一处真 App 的启动路径**（`sessionStore.init()`
 * 及其 `initDeferred()`），值是「一个刚装好、什么都没有的用户」会看到的形状。
 */
const FILLERS: Filler[] = [
  // 首屏设置：一个 key 都没有 = 全部走代码默认值（与全新安装一致）。
  { channel: IPC.SETTING_GET, value: () => ({ value: null }) },
  { channel: IPC.SETTING_GET_MANY, value: () => ({}) },
  // 写设置：真 App 的本地偏好回写（宽度/折叠/主题…）。落空即可 —— 探针不重开。
  { channel: IPC.SETTING_SET, value: () => ({ ok: true }) },
  { channel: IPC.THEME_GET, value: () => ({ theme: "light", effective: "light" }) },
  { channel: IPC.THEME_SET, value: () => ({ theme: "light", effective: "light" }) },
  // 没有任何项目/会话 —— 全新安装。
  { channel: IPC.PROJECT_LIST, value: () => ({ projects: [] }) },
  { channel: IPC.PROJECT_SESSIONS, value: () => ({ sessions: [], hasMore: false, total: 0 }) },
  { channel: IPC.SESSION_LIST_PINNED, value: () => ({ sessions: [] }) },
  { channel: IPC.SESSION_LIST_ALL, value: () => ({ sessions: [], total: 0, hasMore: false }) },
  { channel: IPC.SESSION_MESSAGES, value: () => ({ messages: [], hasMore: false }) },
  // 没有可用 provider（同 `provider:list` 在未配置任何 API key 时的形状）。
  { channel: IPC.PROVIDER_LIST, value: () => ({ providers: [] }) },
  { channel: IPC.PROVIDER_HEALTH_CHECK, value: () => ({ status: "unavailable" }) },
  { channel: IPC.PROVIDER_COMMANDS, value: () => ({ commands: [] }) },
  { channel: IPC.CUSTOM_MODEL_LIST, value: () => ({ models: [] }) },
  { channel: IPC.PI_MODELS_LIST_AVAILABLE, value: () => ({ models: [] }) },
  { channel: IPC.CODEX_MODELS_LIST, value: () => ({ providers: [] }) },
  { channel: IPC.RUNTIMES_LIST, value: () => ({ runtimes: [] }) },
  { channel: IPC.SKILLS_LIST, value: () => ({ skills: [] }) },
  { channel: IPC.LSP_LIST, value: () => ({ languages: [] }) },
  { channel: IPC.LSP_PREWARM, value: () => ({ ok: true }) },
  { channel: IPC.GIT_WORKTREE_LIST, value: () => ({ worktrees: [] }) },
  { channel: IPC.VOICE_MODEL_LIST, value: () => ({ models: [] }) },
];

/**
 * 注册填充 handler。`taken` 是已经被真实现占用的通道集合 —— 撞上就抛错。
 *
 * 为什么用 `taken` 而不是「先注册填充、真实现后注册覆盖」：`ipcMain.handle` 对同
 * 一通道第二次注册会**抛错**（Electron 的硬行为），而静默 `removeHandler` 再注册
 * 会把「有人不小心给真通道补了桩」变成一件没人看得见的事。撞名 = 组装错误，早失败。
 */
export function registerFillerHandlers(ipc: IpcMain, taken: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const registered: string[] = [];
  for (const filler of FILLERS) {
    if (taken.has(filler.channel)) {
      throw new Error(`W26 filler: 通道 ${filler.channel} 已有生产实现 —— 填充层不许覆盖它`);
    }
    if (seen.has(filler.channel)) {
      // 同一通道两个填充值 = 其中一个是死代码，写的人以为它生效了。
      throw new Error(`W26 filler: 通道 ${filler.channel} 在 FILLERS 里出现了两次`);
    }
    seen.add(filler.channel);
    ipc.handle(filler.channel, () => filler.value());
    registered.push(filler.channel);
  }
  return registered;
}

/** 供自检：填充层声明了哪些通道。 */
export function fillerChannels(): string[] {
  return FILLERS.map((f) => f.channel);
}
