/**
 * T6 — 审批卡键盘/焦点/拒绝路径的隔离组件回归夹具。
 *
 * 挂的是**生产原件的两个组件**：`ApprovalPrompt`、`McpToolDecisionCard`。
 * 只替换四个「浏览器里跑不起来/会拖进整棵 store」的模块（见 build.mjs 的 stubs）：
 *   - `@renderer/stores/sessionStore.js` → 只读选择器桩（settingsOpen=false）
 *   - `@renderer/lib/i18n/index.js`       → 真 zh 词典 + 极简 t()
 *   - `@renderer/lib/icons.js`            → 空壳图标（判据从不落在图标上）
 *   - `@renderer/components/ui/index.js`  → 转发**真** Button / Dialog（不是替身）
 *
 * 判据全部落在真实 DOM / 真实按键 / 真实焦点上，由 verify.mjs 经 CDP 驱动。
 * 不起 Electron、不碰 IPC/网络/磁盘 —— 这是 E1 隔离组件证据，不是 U1。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPrompt } from "@renderer/components/chat/ApprovalPrompt.js";
import { McpToolDecisionCard } from "@renderer/components/chat/McpToolDecisionCard.js";
import { Dialog } from "@renderer/components/ui/index.js";

type Cfg = {
  kind?: "approval" | "mcp";
  active?: boolean;
  hidden?: boolean;
  toolName?: string;
  queuePosition?: number;
  queueTotal?: number;
  input?: unknown;
  description?: string;
  /** 真 Base UI Dialog（生产 `Dialog` 包装）打开着，审批卡在其下方挂载。 */
  modalOpen?: boolean;
  /** 非模态、流内的 role=dialog aria-modal=false（如 QuestionPrompt）—— 不应挡住审批卡焦点。 */
  neutralDialog?: boolean;
  /** 再挂一张隐藏的 B 卡（模拟后台 keep-alive 会话）。 */
  dual?: boolean;
  status?: "running" | "done" | "error";
  result?: string;
  showCard?: boolean;
};

type Decision = { card: "A" | "B"; granted: boolean; always?: boolean };

const w = window as unknown as {
  labDecisions: Decision[];
  labPropagation: number;
  labFocusLog: string[];
  labConfigure?: (next: Cfg, keepKey?: boolean) => void;
  labClear?: () => void;
  __ready?: boolean;
};

w.labDecisions = [];
w.labPropagation = 0;
w.labFocusLog = [];
// 每次焦点落到哪 —— 用来证明审批卡在模态打开期间**是否曾经**抢过焦点。
// 只看最终 activeElement 会被 Base UI 的焦点守卫"复原"掩盖，看不到中途那一抢。
window.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement;
  const mark = t.id === "card-a" || t.closest?.("#card-a") ? "card:" : "";
  w.labFocusLog.push(`${mark}${t.tagName}${t.id ? "#" + t.id : ""}${t.getAttribute?.("role") ? `[role=${t.getAttribute("role")}]` : ""}`);
});
// 冒泡到 window 的 keydown 计数：审批卡 Esc 处理器必须 stopPropagation，
// 否则同一次 Esc 会继续落到文档级监听（设置页/其它浮层）。
window.addEventListener("keydown", () => {
  w.labPropagation += 1;
});

function ModalUnderTest() {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup aria-label="modal-under-test">
          <Dialog.Title>Modal under test</Dialog.Title>
          <input id="modal-input" aria-label="modal input" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CardA({ cfg, decide }: { cfg: Cfg; decide: (granted: boolean, always?: boolean) => void }) {
  if (cfg.kind === "mcp") {
    return (
      <McpToolDecisionCard
        toolName={cfg.toolName ?? "mcp__srv__tool"}
        status={cfg.status ?? "running"}
        result={cfg.result ?? ""}
      >
        <div>mcp tool body</div>
      </McpToolDecisionCard>
    );
  }
  return (
    <ApprovalPrompt
      providerName="Agent A"
      active={cfg.active ?? true}
      toolName={cfg.toolName ?? "Bash"}
      input={cfg.input ?? { command: "echo audit" }}
      description={cfg.description}
      queuePosition={cfg.queuePosition ?? 1}
      queueTotal={cfg.queueTotal ?? 1}
      onDecide={decide}
    />
  );
}

function App() {
  // 两次 configure 之间用 key 重挂卡片 = 生产里新 requestId 换卡；
  // keepKey=true 时保持同一实例，验证队列换头时的**渲染期**复位。
  const [cfg, setCfg] = useState<Cfg>({});
  const [k, setK] = useState(0);

  const decideA = (granted: boolean, always?: boolean) => {
    w.labDecisions.push({ card: "A", granted, always });
  };
  const decideB = (granted: boolean, always?: boolean) => {
    w.labDecisions.push({ card: "B", granted, always });
  };
  w.labConfigure = (next, keepKey) => {
    setCfg(next);
    if (!keepKey) setK((v) => v + 1);
  };
  w.labClear = () => {
    w.labDecisions.length = 0;
  };

  return (
    <>
      {cfg.modalOpen && <ModalUnderTest />}
      {cfg.neutralDialog && (
        <div id="neutral-dialog" role="dialog" aria-modal="false">
          neutral in-flow dialog
        </div>
      )}
      <div id="card-a" style={cfg.hidden ? { display: "none" } : undefined}>
        {(cfg.showCard ?? true) && <CardA key={`a${k}`} cfg={cfg} decide={decideA} />}
      </div>
      {cfg.dual && (
        <div id="card-b" style={{ display: "none" }}>
          <ApprovalPrompt
            providerName="Agent B"
            active={false}
            toolName="Bash"
            input={{ command: "echo b" }}
            queuePosition={1}
            queueTotal={1}
            onDecide={decideB}
          />
        </div>
      )}
      <input id="elsewhere" aria-label="elsewhere" />
      <button id="outside">outside</button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
w.__ready = true;
