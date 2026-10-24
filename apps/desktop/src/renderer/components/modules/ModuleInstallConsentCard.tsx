/**
 * 【T18】**安装权限卡** —— 「本次运行允许 / 始终允许 / 拒绝」，像手机装软件那样。
 *
 * ## 它是谁的入口
 *
 * 从前逐项权限勾选只存在于「设置 → 自定义 UI → 高级」那个清单粘贴面板里；
 * 别处（Agent 经 `app_api_call`、以后的工作台安装按钮）装扩展时用户看不到一张
 * 像样的卡片。这一份把「装之前先看清要什么权限」提升为**所有桌面入口共用的一张
 * 模态卡**：任何调用 `useInstallConsentCard().request(manifest, granted)` 的
 * 安装入口都会弹它，回答后才会真正调 `api.modules.install`。
 *
 * ## 三态与安全语义（与主进程分工）
 *
 *  - 「本次运行允许」→ 传 `installConsent: "allow-once"`；宿主把授权记成**会话级**
 *    （带 bootId），重启后同一扩展再激活会重新询问。
 *  - 「始终允许」→ 传 `"allow-always"`；宿主写持久决策，但仍绑定版本 + 执行
 *    指纹 —— 清单/权限集/程序任一变化都会重新询问。
 *  - 「拒绝」/ 关闭 / Esc → **根本不调安装**。拒绝 = 不写盘，不是"先装了再禁用"。
 *    卡片的关闭与拒绝走**同一条**路径（`decide("deny")`）。
 *
 * ## 键盘合同（与 `ApprovalPrompt` 同一套）
 *
 *  - 打开时焦点落在**卡片本身**（`initialFocus` 指到 popup），不落在任何授权按钮上
 *    —— 连击或开卡瞬间的回车没有可激活的动作。
 *  - Esc = 拒绝（也是关闭），绝不等同于允许。
 *  - 「本次运行允许 / 始终允许」两个按钮共用 `useApprovalArming` 的短延迟，开卡后
 *    500ms 内不可点；Tab 过去再回车才是显式同意。
 *  - 拒绝按钮永远立即可用（fail-closed 不该被延迟）。
 *
 * ## 为什么挂在根上
 *
 * 安装可能由**不在当前面板**的入口发起（设置页、Agent 回合）。卡片挂在
 * `App` 根部，并由 `useSuppressBrowserView` 收起内嵌浏览器视图（OS 级视图永远
 * 浮在 DOM 之上）。
 */
import { create } from "zustand";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModuleManifest, ModulePermission } from "@contracts/modules";
import type { ModuleInstallConsentDecision } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useApprovalArming } from "@renderer/hooks/useApprovalArming.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Button } from "@renderer/components/ui/index.js";
import { MODULE_HIGH_RISK_PERMISSIONS } from "@contracts/appPermission";

/** 一次待确认的安装。`install()` 由调用方提供 —— 卡片只负责收集三态决定，
 *  真正的 `api.modules.install` 留在调用方（它还要处理回包里的变更诊断）。 */
export interface PendingInstallConsent {
  manifest: ModuleManifest;
  /** 本次安装实际要授予的权限（清单子集；空数组合法）。 */
  granted: ModulePermission[];
  /** 已有同 id 已装版本 = 升级。 */
  upgrading: boolean;
  /** 发起入口，仅用于卡片上的来源说明。 */
  origin: "desktop" | "agent";
}

interface InstallConsentState {
  pending: PendingInstallConsent | null;
  resolve: ((decision: ModuleInstallConsentDecision) => void) | null;
  /** 打开卡片；返回用户的决定（关闭/Esc 一律 `deny`）。 */
  request: (pending: PendingInstallConsent) => Promise<ModuleInstallConsentDecision>;
  decide: (decision: ModuleInstallConsentDecision) => void;
}

/**
 * 单一挂起点。`request` 被并发调用（两个入口同时装）时，后者会**顶掉**前者并
 * 把前者按 `deny` 兑现 —— 绝不让一张卡静默消失、让一个安装永远挂着。
 */
const useInstallConsentStore = create<InstallConsentState>((set, get) => ({
  pending: null,
  resolve: null,
  request: (pending) => {
    const prior = get().resolve;
    if (prior) prior("deny");
    return new Promise<ModuleInstallConsentDecision>((resolve) => {
      set({
        pending,
        // 兑现后清空 state，避免下一张卡复用上一张的 resolver。
        resolve: (decision) => {
          set({ pending: null, resolve: null });
          resolve(decision);
        },
      });
    });
  },
  decide: (decision) => {
    const resolve = get().resolve;
    if (resolve) resolve(decision);
  },
}));

/** 安装入口用的 hook：`request(...)` 弹卡，拿到三态；`cancel()` 撤回（极少用）。 */
export function useInstallConsentCard() {
  const request = useInstallConsentStore((s) => s.request);
  return {
    /** 弹卡等用户回答。关闭 / Esc 返回 `"deny"`。 */
    request: useCallback(
      (pending: PendingInstallConsent) => request(pending),
      [request],
    ),
  };
}

/**
 * 根挂载的**唯一持有者**。`App` 挂它一次；`ModuleSurface` 也挂它一份（smoke 与
 * 独立面板夹具只挂 ModuleSurface、不挂 App）。两份同时在场时只有**持有者**渲染
 * 卡片 —— 否则同一张卡会出现两次、两个 `Dialog` 抢焦点。
 *
 * 持有权放在一个极小的 store 里（而非组件本地 state），这样持有者卸载后下一个
 * 挂载点能接手 —— 不能出现"两个都以为对方在画"的死角。
 */
const useConsentHostOwner = create<{ owner: symbol | null; claim: (owner: symbol) => void; release: (owner: symbol) => void }>((set, get) => ({
  owner: null,
  claim: (owner) => {
    if (get().owner === null) set({ owner });
  },
  release: (owner) => {
    if (get().owner === owner) set({ owner: null });
  },
}));
export function ModuleInstallConsentHost() {
  const [owner] = useState(() => Symbol("module-install-consent-host"));
  const isOwner = useConsentHostOwner((s) => s.owner === owner);
  const claim = useConsentHostOwner((s) => s.claim);
  const release = useConsentHostOwner((s) => s.release);
  useEffect(() => {
    claim(owner);
    return () => release(owner);
  }, [claim, release, owner]);
  if (!isOwner) return null;
  return <ModuleInstallConsentCard />;
}

/** 权限 → 人类可读说明。缺省按「相应功能域权限」显示，与指南同一口径。 */
const PERMISSION_LABELS: Record<string, { zh: string; en: string }> = {
  "files.read": { zh: "读取你选择的工作区文件", en: "Read workspace files you pick" },
  "files.write": { zh: "修改你选择的工作区文件", en: "Modify workspace files you pick" },
  "resource.read": { zh: "读取调用时指定的资源", en: "Read the resource given at call time" },
  "resource.write": { zh: "修改调用时指定的资源", en: "Modify the resource given at call time" },
  "network": { zh: "向外部地址发起网络请求", en: "Make outbound network requests" },
  "terminal.run": { zh: "在本机运行终端命令", en: "Run terminal commands on this machine" },
  "code.execute": { zh: "在本机执行程序代码", en: "Execute program code on this machine" },
  "modules.install": { zh: "安装/卸载其他扩展", en: "Install or remove other extensions" },
  "git.write": { zh: "修改仓库（提交、推送、切换分支）", en: "Modify repositories (commit, push, checkout)" },
  "session.send": { zh: "向对话发送内容", en: "Send content into chats" },
  "session.control": { zh: "控制对话（中断、归档、删除）", en: "Control chats (interrupt, archive, delete)" },
  "session.read": { zh: "读取对话记录", en: "Read chat history" },
  "setting.read": { zh: "读取应用设置", en: "Read app settings" },
  "setting.write": { zh: "修改应用设置", en: "Change app settings" },
  "workflow.run": { zh: "运行工作流", en: "Run workflows" },
  "workflow.read": { zh: "读取工作流", en: "Read workflows" },
  "workflow.write": { zh: "修改工作流", en: "Modify workflows" },
  "library.read": { zh: "读取资料库", en: "Read the library" },
  "library.write": { zh: "修改资料库", en: "Modify the library" },
  "memory.read": { zh: "读取记忆", en: "Read memory" },
  "memory.write": { zh: "写入记忆", en: "Write memory" },
  "ui.control": { zh: "操作界面", en: "Control the UI" },
  "ui.read": { zh: "读取界面状态", en: "Read UI state" },
  "modules.read": { zh: "读取扩展信息", en: "Read extension info" },
  "modules.write": { zh: "修改扩展的私有存储", en: "Modify an extension's private store" },
};

function permissionLabel(permission: string, locale: "zh" | "en"): string {
  const label = PERMISSION_LABELS[permission];
  if (label) return label[locale];
  // 形如 `git.read` → 「git.read」原样 + 域说明；不猜语义。
  return permission;
}

/**
 * 根挂载的安装卡。`App` 只渲染它一次；没有待确认安装时返回 null。
 *
 * 卡片的关闭（点 X / Esc / 点背板）**一律**按拒绝兑现 —— 与 `Dialog.Root` 的
 * `onOpenChange(false)` 同一条路径，不存在"关掉 = 默认同意"。
 */
export function ModuleInstallConsentCard() {
  const { t, locale } = useI18n();
  const pending = useInstallConsentStore((s) => s.pending);
  const decide = useInstallConsentStore((s) => s.decide);
  const popupRef = useRef<HTMLDivElement>(null);
  const open = pending !== null;
  useSuppressBrowserView(open);
  // 「允许」两钮共用短延迟（ARC-005 输入保护）。换一张卡（manifest id 变了）即复位。
  const armed = useApprovalArming(pending?.manifest.id ?? null);
  if (!pending) return null;
  const { manifest, granted, upgrading, origin } = pending;
  const requested = manifest.permissions;
  const highRisk = requested.filter((p) => MODULE_HIGH_RISK_PERMISSIONS.has(p));
  const title = manifest.title[locale] || manifest.title.zh;
  const grantSet = new Set(granted);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        // 关闭 = 拒绝。Esc / 背板 / X 都走这里，绝不放行。
        if (!next) decide("deny");
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup
          // 焦点落在**卡片本身**（内层 `popupRef`），不落在任何授权按钮上 ——
          // 连击或开卡瞬间的回车没有可激活的动作。`initialFocus` 接受 ref 对象,
          // 而 Popup 自身的 `ref` 不在其公开类型里,所以 ref 挂在内层 div 上。
          initialFocus={popupRef}
          className="max-h-[85vh] w-[min(92vw,560px)] space-y-4 overflow-auto p-5"
          data-testid="module-install-consent"
          aria-label={t("ide.modules.consentCard.aria")}
        >
          <div ref={popupRef} tabIndex={-1} className="space-y-4 outline-none" data-testid="module-install-consent-body">
          <Dialog.Title>{t("ide.modules.consentCard.title")}</Dialog.Title>
          <Dialog.Close aria-label={t("common.close")} />
          {/* 扩展名 + 版本 + 来源 */}
          <section className="space-y-1 rounded border border-edge p-3">
            <p className="text-body font-semibold">{title}</p>
            <p className="text-code text-content-muted">
              <code>{manifest.id}</code> · {manifest.version}
            </p>
            <p className="text-code text-content-muted">
              {origin === "agent" ? t("ide.modules.consentCard.originAgent") : t("ide.modules.consentCard.originDesktop")}
            </p>
            {upgrading && <p className="text-code text-warning">{t("ide.modules.consentCard.upgrading")}</p>}
          </section>
          {/* 逐条权限 */}
          <section className="space-y-2" data-testid="module-install-consent-permissions">
            <p className="text-body font-semibold">{t("ide.modules.consentCard.permissionsTitle")}</p>
            {requested.length === 0 ? (
              <p className="text-code text-content-muted">{t("ide.modules.consentCard.noPermissions")}</p>
            ) : (
              <ul className="space-y-1">
                {requested.map((permission) => {
                  const isHigh = MODULE_HIGH_RISK_PERMISSIONS.has(permission);
                  const isGranted = grantSet.has(permission);
                  return (
                    <li key={permission} className="flex items-start gap-2 text-code" data-permission={permission}>
                      <code className="shrink-0 rounded bg-surface-muted px-1 py-0.5">{permission}</code>
                      <span className="flex-1 text-content-muted">{permissionLabel(permission, locale)}</span>
                      {!isGranted && <span className="shrink-0 text-content-subtle">{t("ide.modules.consentCard.notGranted")}</span>}
                      {isHigh && <span className="shrink-0 text-warning">{t("ide.modules.highRisk")}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {highRisk.length > 0 && (
              <p role="alert" className="text-code text-warning">
                {t("ide.modules.consentCard.highRiskAlert")}
              </p>
            )}
          </section>
          {/* 可执行程序警示 */}
          {manifest.program !== undefined && (
            <p role="alert" data-testid="module-install-consent-program" className="rounded border border-warning/60 bg-warning/10 p-2 text-code text-warning">
              {t("ide.modules.consentCard.programAlert")}
            </p>
          )}
          {/* 三态按钮 */}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-edge pt-3">
            <Button variant="ghost" onClick={() => decide("deny")} data-testid="module-install-deny">
              {t("ide.modules.consentCard.deny")}
            </Button>
            <Button
              variant="secondary"
              disabled={!armed}
              aria-disabled={!armed}
              onClick={() => decide("allow-once")}
              data-testid="module-install-allow-once"
            >
              {t("ide.modules.consentCard.allowOnce")}
            </Button>
            <Button
              variant="primary"
              disabled={!armed}
              aria-disabled={!armed}
              onClick={() => decide("allow-always")}
              data-testid="module-install-allow-always"
            >
              {t("ide.modules.consentCard.allowAlways")}
            </Button>
          </div>
          <p className="text-[11px] text-content-subtle">{t("ide.modules.consentCard.footnote")}</p>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
