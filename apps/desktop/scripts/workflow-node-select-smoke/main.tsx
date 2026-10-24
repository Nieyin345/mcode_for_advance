/**
 * 这套 smoke 的浏览器夹具：挂**真**的 `WorkflowLibraryView`（真 React 19、真 zustand
 * store、真 i18n 词典、真 UI 原语、真 Tailwind），只换掉四处跑不进浏览器 / 会碰真环境的
 * 模块（见 `build.mjs` 的 stubs）：
 *
 *   - `@renderer/lib/api.js` → 内存里一份工作流库（见 api-stub.ts）
 *   - `@renderer/stores/sessionStore.js` → 真 zustand store 的**最小切片**（见下）
 *   - `@renderer/lib/monacoSetup.js` → 空模块（本页永远走不到代码参数弹窗）
 *   - `@renderer/stores/libraryStore.js` → 一份空的分类表（检查器的 `collections` 引用源）
 *
 * ## 为什么不挂假 React 运行时
 *
 * 这套要证明的是「**用户点了节点 → 右侧换成那个节点的参数**」。点击是事件、重渲染是
 * state 落地 —— 这两件事只有在真 React + 真 DOM 上才是生产里那一条路。仓库里那几套
 * `fakeReact` 只渲染根组件、子组件以 `{type, props}` 留在树里不展开，`NodeInspector`
 * 永远拿不到 `selectedNodeId` 的新值（它也确实是子组件），于是「点击前/后」根本分辨不出来
 * —— 那正是 T45 之后这块一直没人发现的原因（原 `workflow-view-smoke` 直接喂
 * `selectedNodeId: "B"`，绕过了「怎么变成 B」）。
 *
 * ## `sessionStore` 为什么换最小切片
 *
 * 真 `sessionStore` 有 7000+ 行、模块求值时会 import 一堆领域 store，headless 浏览器里
 * 只会把整棵树拖进来。本页消费它的地方只有两类：
 *   - `useI18n` 读 `locale`（`useSessionStore((s) => s.locale)`）
 *   - 检查器里 `ref` 型参数读 `providers` / `skills` / `projects` / `customModels` 等
 *
 * 所以用**真 zustand**（本套件依赖里的那一份）建一个同形状的 store：`useSessionStore`
 * 本身是 hook + `.getState` / `.setState` / `.subscribe`，与生产同一套接口
 * （`WorkflowLibraryView` 里 `useSessionStore.setState(...)` 与 `useRpc` 的
 * `useSessionStore.getState()` 都真的可用）。**换的是 store 的内容，不是 hook 的语义。**
 */
import { create } from "zustand";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { WorkflowLibraryView } from "@renderer/components/settings/workflows/WorkflowLibraryView.js";
import type { NodeTypeCatalog } from "@contracts/nodeType";
import type { AgentProfile } from "@contracts/agentProfile";

/**
 * 真节点类型目录由 run.sh 生成（主进程内置清单），build.mjs 把它塞进 `window`
 * （见 build.mjs 的 `catalogGlobal`）。**不写成 `import catalogJson from "./x.json"`**：
 * 那个文件只在运行时存在，而 tsconfig 的 include 把 scripts 下的文件都纳入检查，
 * tsc 会按真实路径去解析它并报 TS2307。
 */
const catalog = (() => {
  const c = (window as unknown as { __LAB_CATALOG?: NodeTypeCatalog }).__LAB_CATALOG;
  if (!c) throw new Error("window.__LAB_CATALOG missing — run via run.sh");
  return c;
})();

/**
 * 真 zustand 的最小会话 store —— 字段与生产同名同形状（只列检查器会读的那几个）。
 * 缺的字段是 `undefined`，与"这台机器上还没加载过"同义（检查器对它们是可选的）。
 */
export interface LabSessionState {
  locale: "zh" | "en";
  providers: Array<{ id: string; displayName: string; capabilities: { builtinModels: Array<{ id: string; label: string }> } }>;
  skills: Array<{ name: string; description?: string; perEngine?: Record<string, boolean> }>;
  projects: Array<{ id: string; name: string; path: string }>;
  customModels: Array<{ id: string; models: Array<{ id: string }> }>;
  customModelId: string | null;
  providerId: string;
  piAvailableModels: Array<{ id: string; label: string }>;
  codexAvailableModels: Array<{ id: string; label: string }>;
  settingsFocusWorkflowId: string | null;
}

interface LabStore {
  state: LabSessionState;
}

const initial: LabSessionState = {
  locale: "zh",
  // 给"引擎"那一格一些真候选（`mcode.agent` 的 provider 参数是 ref 型）。
  providers: [{ id: "claude-sdk", displayName: "Claude", capabilities: { builtinModels: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } }],
  skills: [],
  projects: [],
  customModels: [],
  customModelId: null,
  providerId: "claude-sdk",
  piAvailableModels: [],
  codexAvailableModels: [],
  settingsFocusWorkflowId: null,
};

const useLabStore = create<LabStore>(() => ({ state: initial }));

/** 与生产 `useSessionStore(selector)` 同形状：订阅 + 选择器。 */
export function useSessionStore<T>(selector: (s: LabSessionState) => T): T {
  return useLabStore((s) => selector(s.state));
}
useSessionStore.getState = (): LabSessionState => useLabStore.getState().state;
useSessionStore.setState = (patch: Partial<LabSessionState>): void => {
  useLabStore.setState((s) => ({ state: { ...s.state, ...patch } }));
};
useSessionStore.subscribe = (fn: (s: LabSessionState) => void): (() => void) =>
  useLabStore.subscribe((s) => fn(s.state));
useSessionStore.getInitialState = (): LabSessionState => initial;

/**
 * 探针窗口：verify.mjs 全部经 `window.labXxx` 驱动。
 *
 * - `labReady`：`#root` 已提交第一帧之后才置真（verify 用它当就绪判据）；
 * - `labSetLocale`：切语言（本套只验 zh，en 的词典对齐由 `maint-m37-smoke` 管）；
 * - `labNodeRows`：左栏节点列表里每一行的 **DOM 信息**。判据要落在"用户看得见/点得到"
 *   的元素上，而不是源码字符串 —— 所以由这里按 `[data-workflow-node-list]` 现查。
 */
interface LabWindow extends Window {
  labReady?: boolean;
  labRemount?: () => void;
  labCatalogSize?: number;
}

const lab = window as LabWindow;
lab.labCatalogSize = catalog.entries.length;

function Harness() {
  // 重挂载开关：verify 需要在同一页里重置到"什么都没选中"。key 变化 = 整棵子树卸载
  // 重挂 —— 比"找个按钮点回去"更干净，且不会掩盖选中态没被清掉的真 bug（那条由 §3
  // 的「返回工作流本体」单独验）。
  const [epoch, setEpoch] = useState(0);
  lab.labRemount = () => setEpoch((n) => n + 1);
  return (
    <div className="flex h-screen flex-col bg-surface p-4 text-content">
      <div className="flex min-h-0 flex-1 flex-col" key={epoch}>
        <WorkflowLibraryView
          purpose="workflow"
          catalog={catalog}
          catalogError={null}
          onRetryCatalog={() => {}}
          profiles={[] as AgentProfile[]}
          profileError={null}
          onSaveProfile={async () => true}
          onRemoveProfile={async () => {}}
          onOpenNativeEditor={() => {}}
        />
      </div>
    </div>
  );
}

/**
 * `window.api` 由**前一个 `<script>`**（build.mjs 打的 `api-stub.js`）放好 —— 见文件头
 * 与 build.mjs 的两段构建注释。这个入口**不要** import `api-stub`：那会把它拖进本
 * bundle，重蹈"模块求值早于 stub 赋值"的坑。
 */

createRoot(document.getElementById("root")!).render(<Harness />);

queueMicrotask(() => {
  lab.labReady = true;
});
