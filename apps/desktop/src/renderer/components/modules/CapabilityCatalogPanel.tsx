import type { ModuleCatalog } from "@contracts/modules";
import { resolvedContributionCapability } from "@contracts/modules";
import type { ModuleCapabilityDescriptor, ModuleCapabilityMetadata, ModuleWorkflowTarget } from "@contracts/moduleCapability";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Badge, Button, EmptyState, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { CapabilitySchemaView } from "./CapabilitySchemaView.js";

type CapabilityKind = ModuleCapabilityDescriptor["kind"];
type Permission = ModuleCapabilityMetadata["permissions"][number];

/** `Record<…>` tables: a new kind/permission in the contract fails to compile
 * here instead of silently rendering an unlabeled row. */
const KIND_LABEL: Record<CapabilityKind, MessageId> = {
  query: "ide.modules.kindQuery",
  task: "ide.modules.kindTask",
  action: "ide.modules.kindAction",
};
const KIND_HINT: Record<CapabilityKind, MessageId> = {
  query: "ide.modules.kindQueryHint",
  task: "ide.modules.kindTaskHint",
  action: "ide.modules.kindActionHint",
};
const KIND_BADGE: Record<CapabilityKind, "neutral" | "accent" | "warning"> = {
  query: "neutral",
  task: "accent",
  action: "warning",
};
const PERMISSION_LABEL: Partial<Record<Permission, MessageId>> = {
  "resource.read": "ide.modules.permissionResourceRead",
  "resource.write": "ide.modules.permissionResourceWrite",
  // 【MC-035】网络是显式权限 —— 用户必须在安装/查看能力时看到"这个扩展要联网",
  // 而不是等它悄悄出站。没有这一条,`t(undefined)` 会渲染成空串。
  "network": "ide.modules.permissionNetwork",
};

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Label of a host-published workflow target, resolved against the same
 * catalog snapshot. Unresolvable targets fall back to their raw IDs. */
export function workflowTargetLabel(catalog: ModuleCatalog, target: ModuleWorkflowTarget, locale: "zh" | "en"): string {
  const module = catalog.modules.find((m) => m.id === target.moduleId);
  const contribution = module?.contributions.find((c) => c.id === target.contributionId);
  return module && contribution
    ? `${module.title[locale]} · ${contribution.title[locale]}`
    : `${target.moduleId} / ${target.contributionId}`;
}

/**
 * Read-only view of what the host has registered, shown inside the existing
 * "UI extensions" window (not a second management surface).
 *
 * Everything rendered here comes from the host catalog snapshot. Nothing is
 * inferred from IDs (a `core.` prefix is NOT treated as trusted): workflow
 * usability is exactly the host's `workflowTargets`, and a capability without
 * metadata is shown as explicitly unknown — permissions, schemas and limits
 * are never invented for display.
 */
export function CapabilityCatalogPanel({
  catalog,
  loading,
  error,
  onRetry,
}: {
  catalog: ModuleCatalog | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const targets = catalog?.workflowTargets ?? [];
  const usedBy = (capabilityId: string): string[] =>
    catalog?.modules.flatMap((module) =>
      module.contributions
        // 【MC-035】扩展包的贡献写的是 `module.<短名>`，实际能力 id 是宿主分配的
        // `module.<slug>.<短名>`。从前这里拿清单原文直接比 —— 扩展能力永远显示
        // "没有扩展使用"，而用户模块包一层内置能力时却照常显示，两行字互相矛盾。
        // 与宿主/契约用同一份映射（`resolvedContributionCapability`）。
        .filter((contribution) => resolvedContributionCapability(module.id, contribution.capability) === capabilityId)
        .map((contribution) => `${module.title[locale]} · ${contribution.title[locale]}`),
    ) ?? [];
  return (
    <section data-testid="capability-catalog" aria-labelledby="capability-catalog-title" className="space-y-2">
      <h3 id="capability-catalog-title" className="text-body font-semibold">{t("ide.modules.catalogTitle")}</h3>
      <p className="text-code text-content-muted">{t("ide.modules.catalogHint")}</p>
      {loading && !catalog && (
        <div data-testid="capability-catalog-loading"><LoadingNote label={t("common.loading")} /></div>
      )}
      {error && (
        <div data-testid="capability-catalog-error">
          <ErrorNote
            title={t("ide.modules.catalogError")}
            action={<Button size="sm" disabled={loading} onClick={onRetry}>{t("common.retry")}</Button>}
          >
            {error.message}
          </ErrorNote>
        </div>
      )}
      {catalog && catalog.capabilities.length === 0 && (
        <div data-testid="capability-catalog-empty">
          <EmptyState title={t("ide.modules.catalogEmpty")} desc={t("ide.modules.catalogEmptyDetail")} />
        </div>
      )}
      {catalog && catalog.capabilities.length > 0 && (
        <>
          {targets.length === 0 && (
            <p data-testid="capability-workflow-none" className="text-code text-content-muted">
              {t("ide.modules.workflowNone")}
            </p>
          )}
          <ul className="space-y-2">
            {catalog.capabilities.map((capability) => {
              const users = usedBy(capability.id);
              const workflow = targets.filter((target) => target.capabilityId === capability.id);
              const meta = capability.metadata;
              return (
                <li
                  key={capability.id}
                  data-testid="capability-entry"
                  data-capability-id={capability.id}
                  className="space-y-1.5 rounded border border-edge p-2 text-code"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {meta && <span data-testid="capability-title" className="font-medium text-content">{meta.title[locale]}</span>}
                    <code className="break-all font-mono text-content-subtle">{capability.id}</code>
                    <Badge data-testid="capability-kind" variant={KIND_BADGE[capability.kind]}>
                      {t(KIND_LABEL[capability.kind])}
                    </Badge>
                    {meta && <span data-testid="capability-version" className="text-content-subtle">{t("ide.modules.version", { version: meta.version })}</span>}
                  </div>
                  <p className="text-content-muted">{t(KIND_HINT[capability.kind])}</p>
                  {meta ? (
                    <div className="space-y-1.5">
                      <p data-testid="capability-description" className="whitespace-pre-line break-words text-content">{meta.description[locale]}</p>
                      <p data-testid="capability-permissions">
                        <span className="text-content-subtle">{t("ide.modules.permissions")}</span>
                        {meta.permissions.length > 0
                          ? meta.permissions.map((permission) => PERMISSION_LABEL[permission] ? t(PERMISSION_LABEL[permission]!) : permission).join(" / ")
                          : t("ide.modules.permissionsNone")}
                      </p>
                      <p data-testid="capability-cancellation" className="text-content-subtle">
                        {t(meta.supportsCancellation ? "ide.modules.cancellable" : "ide.modules.notCancellable")}
                      </p>
                      <p data-testid="capability-limits">
                        <span className="text-content-subtle">{t("ide.modules.limits")}</span>
                        {[
                          meta.limits?.maxFileBytes !== undefined ? t("ide.modules.limitMaxFileBytes", { size: formatBytes(meta.limits.maxFileBytes) }) : null,
                          meta.limits?.taskTimeoutMs !== undefined ? t("ide.modules.limitTaskTimeout", { seconds: meta.limits.taskTimeoutMs / 1000 }) : null,
                        ].filter((v): v is string => v !== null).join(" / ") || t("ide.modules.limitsNone")}
                      </p>
                      <CapabilitySchemaView testId="capability-input-schema" label={t("ide.modules.inputSchema")} schema={meta.inputSchema} />
                      <CapabilitySchemaView testId="capability-output-schema" label={t("ide.modules.outputSchema")} schema={meta.outputSchema} />
                    </div>
                  ) : (
                    <p data-testid="capability-metadata-missing" className="text-warning">
                      {t("ide.modules.metadataMissing")}
                    </p>
                  )}
                  <p data-testid="capability-used-by" className="break-words text-content-subtle">
                    {users.length > 0
                      ? t("ide.modules.usedBy", { list: users.join(" / ") })
                      : t("ide.modules.usedByNone")}
                  </p>
                  <p data-testid="capability-workflow" data-usable={workflow.length > 0 ? "true" : "false"} className={workflow.length > 0 ? "text-success" : "text-content-subtle"}>
                    {workflow.length > 0
                      ? t("ide.modules.workflowUsable", { list: workflow.map((target) => workflowTargetLabel(catalog, target, locale)).join(" / ") })
                      : t("ide.modules.workflowNotUsable")}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
