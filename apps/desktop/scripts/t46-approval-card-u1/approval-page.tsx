/**
 * T46 —— 审批卡**真 Electron U1** 的探针页面（跑在真 BrowserWindow 里）。
 *
 * ## 为什么另做一张页面而不是复用 E1 的 `approval-keyboard-safety-smoke/main.tsx`
 *
 * E1 那套是「隔离组件」证据：真 React + 真组件，但**没有 BrowserWindow、没有
 * 真 Electron 输入管线、没有窗口焦点语义**。T46 要验的恰恰是 E1 覆盖不到的三条：
 *
 *  1. 真窗口里的 `sendInputEvent` 键盘（Enter / Escape）；
 *  2. 多窗口焦点（另一个窗口抢焦点时审批卡的行为）；
 *  3. `settingsOpen` 暂停提示（设置面板打开时审批卡不抢焦点、不决策）。
 *
 * 挂的是**生产原件 `ApprovalPrompt`**（不是复制品）。只替换一个模块：
 * `@renderer/stores/sessionStore.js` → 可切换的 `settingsOpen` 选择器桩
 * （生产组件只读这一个字段，`ApprovalPrompt.tsx:83`）。其余
 * `useApprovalArming` / `hasTopmostForeignDialog` / `toolSummary` 全部是真模块。
 *
 * ## 探针接口（旅程从主进程 `executeJavaScript` 调用）
 *
 *  - `labMountApproval(cfg?)` —— 挂一张审批卡（默认 Bash / queue 1-of-1）。
 *  - `labUnmount()` —— 拆掉卡片。
 *  - `labSetStore({ settingsOpen })` —— 改选择器桩（不重挂卡片）。
 *  - `labOpenModal()` / `labCloseModal()` —— 真 Base UI `Dialog` 打开/关闭。
 *  - `labFocusOutside()` —— 把焦点移到卡片外（模拟另一窗口/用户点别处）。
 *  - `labProbe()` —— 当前页面事实：卡片/焦点/决策日志/焦点日志。
 */
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPrompt } from "@renderer/components/chat/ApprovalPrompt.js";
import { Dialog } from "@renderer/components/ui/index.js";

type Cfg = {
  active?: boolean;
  toolName?: string;
  input?: unknown;
  description?: string;
  queuePosition?: number;
  queueTotal?: number;
};

type Decision = { granted: boolean; always?: boolean; at: number };
/** 焦点日志条目带时间戳：旅程按「本场景开始时刻」切片，避免把上一组留下的
 *  条目算进本组（「卡有没有抢过焦点」这类否定判据必须按场景切片，否则会假红/假绿）。 */
type FocusEntry = { at: number; where: string };

const w = window as unknown as {
  labMountApproval?: (cfg?: Cfg) => void;
  labUnmount?: () => void;
  labSetStore?: (next: { settingsOpen?: boolean }) => void;
  labOpenModal?: () => void;
  labCloseModal?: () => void;
  labFocusOutside?: () => void;
  labProbe?: () => unknown;
  labFocusedSince?: (since: number) => string[];
  labDecisions: Decision[];
  labFocusLog: FocusEntry[];
  __mounted?: boolean;
};

w.labDecisions = [];
w.labFocusLog = [];

// 焦点日志：记「焦点是否进过审批卡」。只看最终 activeElement 会被 Base UI 的
// 焦点守卫「复原」掩盖，看不到中途那一抢（E1 变异验证踩过这个坑）。
window.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement;
  const inCard = !!t.closest?.("[role=alertdialog]");
  w.labFocusLog.push({
    at: Date.now(),
    where:
      `${inCard ? "card" : "out"}:${t.tagName}${t.id ? "#" + t.id : ""}` +
      `${t.getAttribute?.("role") ? `[role=${t.getAttribute("role")}]` : ""}`,
  });
  if (w.labFocusLog.length > 400) w.labFocusLog.splice(0, w.labFocusLog.length - 400);
});

/** 选择器桩的宿主：`stores/sessionStore` 的 stub 读写这个模块级对象。
 *  放在一个独立模块里，由 build 的 alias 指给 `stores/sessionStore.ts` —— 于是
 *  生产组件读到的 `settingsOpen` 与探针写的是**同一份**。 */
function ApprovalPage() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [mountKey, setMountKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [, forceStore] = useState(0);
  const decideRef = useRef<(granted: boolean, always?: boolean) => void>(() => undefined);

  decideRef.current = (granted: boolean, always?: boolean) => {
    w.labDecisions.push({ granted, always, at: Date.now() });
  };
  const decide = useCallback(
    (granted: boolean, always?: boolean) => decideRef.current(granted, always),
    [],
  );

  // 探针接口：挂载/卸载/改 store/开合模态。定义在组件里，才能触发重渲染。
  w.labMountApproval = (next?: Cfg) => {
    setCfg(next ?? {});
    setMountKey((k) => k + 1);
  };
  w.labUnmount = () => setCfg(null);
  w.labSetStore = (next) => {
    const store = (window as unknown as { __t46Store?: { settingsOpen: boolean } }).__t46Store;
    if (store && typeof next.settingsOpen === "boolean") store.settingsOpen = next.settingsOpen;
    forceStore((v) => v + 1);
  };
  w.labOpenModal = () => setModalOpen(true);
  w.labCloseModal = () => setModalOpen(false);
  w.labFocusOutside = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.getElementById("outside-focus-target")?.focus();
  };
  /** 自 `since`（epoch ms）以来落到过哪些元素 —— 场景切片用。 */
  w.labFocusedSince = (since: number) =>
    w.labFocusLog.filter((e) => e.at >= since).map((e) => e.where);
  w.labProbe = () => {
    const card = document.querySelector<HTMLElement>("[role=alertdialog]");
    const a = document.activeElement as HTMLElement | null;
    const allow = card
      ? [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim().endsWith("允许"))
      : null;
    const store = (window as unknown as { __t46Store?: { settingsOpen: boolean } }).__t46Store;
    return {
      card: card !== null,
      settingsOpen: store?.settingsOpen ?? null,
      modalOpen,
      active: a
        ? { tag: a.tagName, id: a.id, role: a.getAttribute?.("role") ?? null, inCard: !!a.closest?.("[role=alertdialog]") }
        : null,
      allowDisabled: allow ? allow.disabled : null,
      decisions: w.labDecisions.slice(),
      focusLog: w.labFocusLog.slice().map((e) => e.where),
    };
  };

  return (
    <>
      <button id="outside-focus-target" type="button" style={{ position: "absolute", left: 4, top: 4 }}>
        outside
      </button>
      {modalOpen && <ModalUnderTest />}
      <div id="card-host" style={{ maxWidth: 720, margin: "60px auto", padding: 16 }}>
        {cfg && (
          <ApprovalPrompt
            key={`approval-${mountKey}`}
            providerName="Agent A"
            active={cfg.active ?? true}
            toolName={cfg.toolName ?? "Bash"}
            input={cfg.input ?? { command: "echo audit" }}
            description={cfg.description}
            queuePosition={cfg.queuePosition ?? 1}
            queueTotal={cfg.queueTotal ?? 1}
            onDecide={decide}
          />
        )}
      </div>
    </>
  );
}

/** 真 Base UI Dialog（生产 `Dialog` 包装）—— 与 E1 同一份。 */
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

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => {
    console.error(
      "[t46-react-uncaught] " +
      (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      (info?.componentStack ?? ""),
    );
  },
}).render(<ApprovalPage />);
w.__mounted = true;
