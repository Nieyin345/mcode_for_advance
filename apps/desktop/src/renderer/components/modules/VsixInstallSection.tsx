import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

/**
 * 【F006】从 `.vsix` 安装真实 VS Code 扩展。
 *
 * ## 为什么先把限制写在按钮上面
 *
 * 当前宿主只接受**可执行入口 ≤ 24 KiB** 的扩展（`SOURCE_LIMIT`），而真实市场扩展
 * 普遍 100 KB 以上 —— `rainbow-csv` 的 `extension.js` 是 136 KB。也就是说：
 * **用户从市场下载的绝大多数扩展，在这里会被拒绝。**
 *
 * 所以这段说明必须在**选文件之前**就可见。如果等他选完、转一圈、再看到一句
 * 「exceeds the L1 source limit」，那比没有入口更糟 —— 他会以为是 bug 或者自己
 * 选错了文件。**先说清楚，是他自己决定要不要试。**
 *
 * 这条不是临时的免责声明：它是这个宿主**当前的真实能力边界**。等哪天真能装下
 * 136 KB 的扩展了，这段文案要跟着改，而不是悄悄留着。
 */
export function VsixInstallSection({ onInstalled }: { onInstalled: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <section className="space-y-2 rounded border border-edge p-3" data-testid="module-vsix-install">
      <p className="text-body font-semibold">{t("ide.modules.vsixTitle")}</p>
      {/* ⚠️ 这段必须在按钮**之前** —— 见文件头。删掉它，套件的诚实性断言会红。 */}
      <p className="text-code text-content-muted" data-testid="module-vsix-limit-notice">
        {t("ide.modules.vsixLimitNotice")}
      </p>
      <Button disabled={busy} onClick={() => void pickAndInstall()}>
        {busy ? t("ide.modules.vsixInstalling") : t("ide.modules.vsixPick")}
      </Button>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}
