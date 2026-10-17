/**
 * 「模块能力调用」节点(`runner.kind === "module-capability"`)的配置控件。
 *
 * ## 候选只来自宿主
 *
 * 下拉里的每一项都是 `modules.catalog` 返回的 **`workflowTargets`** —— 宿主按真实的内置
 * 登记与只读 query/task 生成的那份；【MC-036】其中用户模块那几项是**有宿主核验工作流
 * 授权**的（绑定模块版本/贡献/能力/工作区）。这里**不按 ID 前缀**(`core.`)自己判可信,
 * 也不把未授权的用户模块列进来:目录里没有 targets(旧宿主、加载失败、空目录)就是"没有
 * 可选目标",而不是"全部都能选"。执行时宿主还会再校验一次(见 interface-v2 §2/§6),
 * 这里的下拉只是配置入口,**不是授权**。
 *
 * ## 授权入口(MC-036)
 *
 * 用户模块列表(含尚未授权的)来自 `workflowGrantCandidates`,**只有**它才驱动授权按钮;
 * 点「授权」= 以用户本人的身份调用 `modules.issueWorkflowGrant`（同一文件里可选工作区，
 * 因为授权绑定资源范围）。Agent 侧同一对方法钉 blocked —— 这条 UI 是唯一签发入口。
 * 授权表损坏时 `workflowGrantStatus` 为 `corrupt`:所有用户模块目标不可用，面板显式报
 * 原因并禁止写（与 MC-051/053 同协议：坏表不当空表、不覆盖）。
 *
 * ## 只写三个参数
 *
 * 节点参数只有 `moduleId` / `contributionId` / `path`(`ModuleWorkflowCallSchema`)。
 * `capabilityId` 由宿主按贡献查,`requestId` 由宿主按执行尝试生成,`projectPath`
 * 来自可信的运行上下文 —— 三者都**不能**由用户填。旧文档里若带着这些键,在原地标出来
 * 并给一个移除按钮,而不是悄悄删掉或带着去存盘。
 *
 * ## 失效的选择要看得见
 *
 * 目录变化后(模块被移除、贡献改名、授权被撤销/版本变化),已保存的 moduleId/contributionId
 * 不再是一个可选目标。此时**保持原值**并显示"已失效",绝不自动换成另一个能力。
 *
 * ## 路径可以是变量
 *
 * 路径沿用检查器既有的「插入变量」机制;含 `{{...}}` 时它只是一段模板,运行时由
 * 调度器的变量解析展开后再交宿主做真实路径校验 —— 这里不把它当成本地文件处理。
 */
import { useState } from "react";
import { ModuleWorkflowCallSchema, type ModuleWorkflowGrantCandidate, type ModuleWorkflowTarget } from "@contracts/moduleCapability";
import type { NodeParamSpec } from "@contracts/nodeType";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote, Select } from "@renderer/components/ui/index.js";
import { workflowTargetLabel } from "@renderer/components/modules/CapabilityCatalogPanel.js";
import type { InsertableGroup } from "./insertVariable.js";
import { Field, ParamField } from "./ParamField.js";

/** 这三个键由本控件接管;检查器的通用参数表跳过它们。 */
export const MODULE_CALL_PARAM_KEYS: readonly string[] = ["moduleId", "contributionId", "path"];

/** 调用身份/授权相关、绝不能来自节点参数的键(interface-v2 §4)。 */
const FORBIDDEN_PARAM_KEYS = ["projectPath", "requestId", "capabilityId", "trusted", "source", "script"] as const;

const targetKey = (moduleId: string, contributionId: string): string => JSON.stringify([moduleId, contributionId]);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** 【MC-036】授权按钮点击的那一刻要交给宿主的完整键（含版本与能力）—— 全部取自目录
 *  的候选，节点参数里的 `moduleId/contributionId` 只是用来对齐"这一项"。 */
const grantRequestOf = (candidate: ModuleWorkflowGrantCandidate, projectPath: string) => ({
  moduleId: candidate.moduleId,
  moduleVersion: candidate.moduleVersion,
  contributionId: candidate.contributionId,
  capabilityId: candidate.capabilityId,
  projectPath,
});

export function ModuleCapabilityFields({
  params,
  onChange,
  insertables,
}: {
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  insertables?: InsertableGroup[];
}) {
  const { t, locale } = useI18n();
  const catalog = useRpc(() => api.modules.catalog(), [], { toastOnError: false });
  // 工作区候选:授权绑定资源范围,下拉里只给已登记的项目根(与执行端 `context.cwd` 同源)。
  const projects = useRpc(() => api.project.list(), [], { toastOnError: false });
  const [grantBusy, setGrantBusy] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const moduleId = str(params.moduleId);
  const contributionId = str(params.contributionId);
  const path = str(params.path);
  const targets: ModuleWorkflowTarget[] = catalog.data?.workflowTargets ?? [];
  const selectedKey = moduleId !== "" && contributionId !== "" ? targetKey(moduleId, contributionId) : "";
  const current = targets.find((target) => targetKey(target.moduleId, target.contributionId) === selectedKey);
  const stale = selectedKey !== "" && catalog.data !== undefined && current === undefined;
  const capability = current ? catalog.data?.capabilities.find((c) => c.id === current.capabilityId) : undefined;
  const forbidden = FORBIDDEN_PARAM_KEYS.filter((key) => Object.hasOwn(params, key));
  const hasVariable = path.includes("{{");
  // 形状校验与存盘/执行用的是同一份 schema;变量模板本身就是合法字符串。
  const shape = selectedKey !== "" && path !== ""
    ? ModuleWorkflowCallSchema.safeParse({ moduleId, contributionId, path })
    : null;
  const grantStatus = catalog.data?.workflowGrantStatus;
  const grantCandidates = catalog.data?.workflowGrantCandidates ?? [];
  const projectPaths = (projects.data?.projects ?? []).map((project) => project.path);
  // 节点上当前选中的贡献若在候选里,优先用它所在的模块;否则列出全部候选(未授权的
  // 用户模块也在这里 —— 那正是可授权的对象)。每个候选行用 <projectPath> 选择范围。
  const showGrantPanel = grantCandidates.length > 0 || grantStatus?.archive === "corrupt";

  const grantFor = async (candidate: ModuleWorkflowGrantCandidate, projectPath: string, kind: "issue" | "revoke"): Promise<void> => {
    const key = `${targetKey(candidate.moduleId, candidate.contributionId)}|${projectPath}|${kind}`;
    setGrantBusy(key); setGrantError(null);
    try {
      const request = grantRequestOf(candidate, projectPath);
      if (kind === "issue") await api.modules.issueWorkflowGrant(request);
      else await api.modules.revokeWorkflowGrant(request);
      await catalog.refetch();
    } catch (error) {
      setGrantError(error instanceof Error ? error.message : String(error));
    } finally {
      setGrantBusy(null);
    }
  };

  const label = (key: string): string => {
    if (key === "") return t("settings.workflows.moduleTargetPick");
    const target = targets.find((item) => targetKey(item.moduleId, item.contributionId) === key);
    if (target && catalog.data) return workflowTargetLabel(catalog.data, target, locale);
    return t("settings.workflows.moduleTargetStaleValue", { id: `${moduleId} / ${contributionId}` });
  };

  const pathSpec: NodeParamSpec = {
    key: "path",
    kind: "text",
    label: t("settings.workflows.modulePath"),
    help: t("settings.workflows.modulePathHelp"),
    required: true,
  };

  return (
    <div data-testid="module-capability-fields" className="flex flex-col">
      <Field label={t("settings.workflows.moduleTarget")} required help={t("settings.workflows.moduleTargetHelp")}>
        <Select.Root
          value={selectedKey}
          disabled={targets.length === 0}
          onValueChange={(value) => {
            const target = targets.find((item) => targetKey(item.moduleId, item.contributionId) === value);
            if (!target) return;
            // 只写两处标识;capabilityId 永远不进节点参数。
            onChange({ ...params, moduleId: target.moduleId, contributionId: target.contributionId });
          }}
        >
          <Select.Trigger data-testid="module-target-trigger" className="w-full">
            <Select.Value>{(value: string) => label(value)}</Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  {targets.map((target) => {
                    const key = targetKey(target.moduleId, target.contributionId);
                    return (
                      <Select.Item key={key} value={key} data-testid="module-target-option">
                        <Select.ItemText>{label(key)}</Select.ItemText>
                      </Select.Item>
                    );
                  })}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </Field>

      {catalog.loading && !catalog.data && (
        <div data-testid="module-target-loading"><LoadingNote label={t("common.loading")} className="py-2" /></div>
      )}
      {catalog.error && (
        <div data-testid="module-target-error" className="mb-3">
          <ErrorNote
            title={t("settings.workflows.moduleCatalogError")}
            action={<Button size="sm" disabled={catalog.loading} onClick={() => void catalog.refetch()}>{t("common.retry")}</Button>}
          >
            {catalog.error.message}
          </ErrorNote>
        </div>
      )}
      {catalog.data && targets.length === 0 && (
        <p data-testid="module-target-none" className="mb-3 text-[0.7143em] leading-relaxed text-warning">
          {t("settings.workflows.moduleTargetNone")}
        </p>
      )}
      {stale && (
        <p data-testid="module-target-stale" role="alert" className="mb-3 text-[0.7143em] leading-relaxed text-warning">
          {t("settings.workflows.moduleTargetStale", { id: `${moduleId} / ${contributionId}` })}
        </p>
      )}
      {current && (
        <p data-testid="module-target-summary" className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          <code className="break-all">{current.capabilityId}</code>
          {" · "}
          {capability?.metadata ? capability.metadata.description[locale] : t("settings.workflows.moduleTargetNoMetadata")}
        </p>
      )}

      {showGrantPanel && (
        <div data-testid="module-grant-panel" className="mb-3 flex flex-col gap-2 rounded border border-edge p-2">
          <p className="text-[0.7143em] leading-relaxed text-content-subtle">{t("settings.workflows.moduleGrantHelp")}</p>
          {grantStatus?.archive === "corrupt" && (
            <div data-testid="module-grant-corrupt">
              <ErrorNote title={t("settings.workflows.moduleGrantCorrupt")}>
                {grantStatus.reason ?? t("settings.workflows.moduleGrantCorruptDetail")}
              </ErrorNote>
            </div>
          )}
          {grantError && (
            <div data-testid="module-grant-error">
              <ErrorNote title={t("settings.workflows.moduleGrantError")}>{grantError}</ErrorNote>
            </div>
          )}
          {grantCandidates.map((candidate) => {
            const grantedPaths = new Set(candidate.grants.map((grant) => grant.projectPath));
            const candidateLabel = catalog.data ? workflowTargetLabel(catalog.data, candidate, locale) : `${candidate.moduleId} / ${candidate.contributionId}`;
            return (
              <div key={targetKey(candidate.moduleId, candidate.contributionId)} data-testid="module-grant-candidate" className="flex flex-col gap-1">
                <span className="text-[0.7143em] font-medium text-content">{candidateLabel}</span>
                {projectPaths.length === 0 && <span className="text-[0.7143em] text-content-subtle">{t("settings.workflows.moduleGrantNoWorkspace")}</span>}
                {projectPaths.map((projectPath) => {
                  const granted = grantedPaths.has(projectPath);
                  const busy = grantBusy === `${targetKey(candidate.moduleId, candidate.contributionId)}|${projectPath}|${granted ? "revoke" : "issue"}`;
                  return (
                    <div key={projectPath} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 break-all text-[0.7143em] text-content-subtle">{projectPath}</span>
                      <Button
                        size="sm"
                        data-testid={granted ? "module-grant-revoke" : "module-grant-issue"}
                        disabled={busy || grantStatus?.archive === "corrupt"}
                        onClick={() => void grantFor(candidate, projectPath, granted ? "revoke" : "issue")}
                      >
                        {granted ? t("settings.workflows.moduleGrantRevoke") : t("settings.workflows.moduleGrantIssue")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <ParamField
        spec={pathSpec}
        value={path}
        onChange={(value) => onChange({ ...params, path: typeof value === "string" ? value : "" })}
        {...(insertables ? { insertables } : {})}
      />
      {hasVariable && (
        <p data-testid="module-path-variable" className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.modulePathVariable")}
        </p>
      )}
      {shape && !shape.success && (
        <p data-testid="module-call-invalid" role="alert" className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-warning">
          {t("settings.workflows.moduleCallInvalid", { detail: shape.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ") })}
        </p>
      )}
      {forbidden.length > 0 && (
        <div data-testid="module-forbidden-params" className="mb-3">
          <ErrorNote
            tone="warning"
            action={
              <Button
                size="sm"
                onClick={() => onChange(Object.fromEntries(Object.entries(params).filter(([key]) => !(FORBIDDEN_PARAM_KEYS as readonly string[]).includes(key))))}
              >
                {t("settings.workflows.moduleForbiddenRemove")}
              </Button>
            }
          >
            {t("settings.workflows.moduleForbiddenParams", { keys: forbidden.join(", ") })}
          </ErrorNote>
        </div>
      )}
    </div>
  );
}
