/**
 * **计划治理视图**(MC-001 / MC-002)—— 把「场景部署」与「无人值守任务计划」两半挂进
 * **同一个设置分区**,各占一个子页签。
 *
 * 为什么要子页签而不是上下堆叠:`SceneDeployPanel` 与 `UnattendedPlanPanel` 各自是
 * `h-full overflow-y-auto` 的整屏面板(与设置页其余面板同形),叠加会互相挤没;而台账的
 * 要求是「并入**同一个治理视图**,不是另起一个新的导航项」——子页签满足这两条:导航项
 * 不增(`SettingsPage` 里仍是 `scene-deploy` 一项),两半仍在同一屏、同一个心算模型
 * (「写计划 → 本人批准 → 只递 grantId 执行」)。
 */
import { useState } from "react";
import { Segmented } from "@renderer/components/ui/cds/Segmented.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SceneDeployPanel } from "./SceneDeployPanel.js";
import { UnattendedPlanPanel } from "./UnattendedPlanPanel.js";

type GovernanceTab = "scene" | "unattended";

export function GovernancePanel(): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<GovernanceTab>("scene");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 子页签 —— 两半的导航;样式与设置页的 section 列表一致。 */}
      <div className="mb-3 shrink-0 border-b border-edge pb-2">
        <Segmented
          label={t("sceneDeploy.nav")}
          className="w-full max-w-80"
          value={tab}
          onChange={(next) => setTab(next as GovernanceTab)}
          items={[
            { id: "scene", label: t("sceneDeploy.nav") },
            { id: "unattended", label: t("unattended.title") },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{tab === "scene" ? <SceneDeployPanel /> : <UnattendedPlanPanel />}</div>
    </div>
  );
}
