/**
 * 「模块能力调用」节点(`runner.kind === "module-capability"`)的配置控件。
 *
 * ## 候选只来自宿主
 *
 * 下拉里的每一项都是 `modules.catalog` 返回的 **`workflowTargets`** —— 宿主按真实的内置
 * 登记与只读 query/task 生成的那份。这里**不按 ID 前缀**(`core.`)自己判可信,也不把
 * 用户导入的模块列进来:目录里没有 targets(旧宿主、加载失败、空目录)就是"没有可选
 * 目标",而不是"全部都能选"。执行时宿主还会再校验一次(见 interface-v2 §2/§6),
 * 这里的下拉只是配置入口,**不是授权**。
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
 * 目录变化后(模块被移除、贡献改名),已保存的 moduleId/contributionId 不再是一个
 * 可选目标。此时**保持原值**并显示"已失效",绝不自动换成另一个能力。
 *
 * ## 路径可以是变量
 *
 * 路径沿用检查器既有的「插入变量」机制;含 `{{...}}` 时它只是一段模板,运行时由
 * 调度器的变量解析展开后再交宿主做真实路径校验 —— 这里不把它当成本地文件处理。
 */
import { ModuleWorkflowCallSchema, type ModuleWorkflowTarget } from "@contracts/moduleCapability";
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
