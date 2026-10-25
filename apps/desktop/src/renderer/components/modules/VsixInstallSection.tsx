import { useState } from "react";
import { TheiaInstalledPanel } from "./TheiaInstalledPanel.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

/** F028: Mcode's single normal VSIX entry is the persistent Theia manager.
 * The old narrow L1 bridge remains available as an explicitly folded legacy
 * compatibility path, not as a second competing normal installer.
 * F025 preview IPC is retained for compatibility/test, not exposed in primary UI.
 */
export function VsixInstallSection({ onInstalled }: { onInstalled: () => void }) {
  const {t} = useI18n();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);

  const pickAndInstall = async () => {
    setError(null);
    // 文件选择走既有的 dialog 薄包装（`ipc/dialog.ts` 的 `pickFilesForUser`），
    // 不直接 import electron 的 dialog —— 那会绕过围栏与测试桩。
    const picked = await api.pickFiles({
      title: t("ide.modules.vsixTitle"),
      filters: [{ name: t("ide.modules.vsixFilter"), extensions: ["vsix"] }],
    });
    const path = picked.paths[0];
    if (!path) return; // 用户取消：不是错误，什么都不做

    setBusy(true);
    try {
      const result = await api.modules.installVsix({
        path,
        confirmReadAccess: true,
        // vsix 里的 `extension.js` 是要在本机跑的程序。这里的确认由下面的按钮
        // 承载（用户点「选择 .vsix 文件…」就等于同意安装它的可执行入口），
        // 与 `modules.install` 对 `program` 模块的处理是同一条规矩。
        confirmExecutableCode: true,
        installConsent: "allow-once",
      });
      useToastStore.getState().push({
        kind: "info",
        title: t("ide.modules.vsixInstalled", { id: result.moduleId ?? "" }),
      });
      // 【F012】**装上 ≠ 全都能用。** 真实扩展的 `menus` / `configuration` 等
      // 本宿主接受了但不会实现 —— 用户如果不知道，会以为自己装坏了，
      // 然后去查权限、查版本、重装。
      //
      // 两类**分开说**，因为对用户意味着不同的事：
      //   declarative → 「设置项改了没用」
      //   runtime     → 「菜单项不会出现」
      // 合并成一句会丢掉这个区分，而那个区分正是他判断「还要不要用」的依据。
      const ignored = result.ignoredContributions ?? [];
      const declarative = ignored.filter((c) => c.kind === "declarative").map((c) => c.section);
      const runtime = ignored.filter((c) => c.kind === "runtime").map((c) => c.section);
      if (declarative.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("ide.modules.vsixIgnoredDeclarative", { sections: declarative.join("、") }),
        });
      }
      if (runtime.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("ide.modules.vsixIgnoredRuntime", { sections: runtime.join("、") }),
        });
      }
      onInstalled();
    } catch (cause) {
      // 失败原因**原样显示**，尤其是「源码超 24 KiB」那条 —— 它是当前最可能的失败，
      // 而且用户需要知道那不是随机错误。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="module-vsix-install">
      <TheiaInstalledPanel />
      <details className="rounded border border-edge p-3" data-testid="module-vsix-legacy">
        <summary className="cursor-pointer text-code text-content-muted">旧版 L1 兼容安装（仅适用于受限的小型扩展）</summary>
        <div className="mt-3 space-y-2">
          <p className="text-code text-content-muted" data-testid="module-vsix-limit-notice">
            {t("ide.modules.vsixLimitNotice")}
          </p>
          <Button disabled={busy} onClick={() => void pickAndInstall()}>
            {busy ? t("ide.modules.vsixInstalling") : t("ide.modules.vsixPick")}
          </Button>
          {error !== null && <ErrorNote>{error}</ErrorNote>}
        </div>
      </details>
    </section>
  );
}
