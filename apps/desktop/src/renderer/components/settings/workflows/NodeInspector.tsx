/**
 * 右栏检查器:选中的是**节点**就编辑那个节点,什么都没选就编辑**工作流本体**。
 *
 * ## 参数表单是**按清单生成的**
 *
 * 这里没有任何一个字段是写死的。每个节点类型在它的清单里声明自己有哪些参数
 * (`params: NodeParamSpec[]`),这个文件只负责把 `kind` 映射成控件 ——
 * `text` / `longtext` / `number` / `boolean` / `select` / `file` / `dir` / `ref`。
 *
 * 唯一一类**候选不来自清单**的是 `ref`:它要的是"这台机器上有什么"(配了哪些模型、
 * 装了哪些技能……)。那一份列表在 `useRefOptions.ts` 里,而**加一种来源改的是那个
 * 文件**,不是这里 —— 见 `@contracts/nodeType` 的 `NODE_PARAM_REF_SOURCES`。
 *
 * 于是**第三方带着一份 JSON 进来就能有界面**,这也是"节点引用类型"那条设计
 * (见 `@contracts/nodeType`)在渲染端的落点:加一种参数控件是往那个封闭集合里加
 * 一个值,而不是给每个新类型写一遍表单。
 *
 * ## 依赖:画布上拉线为主,这里勾选是等价路径
 *
 * 两种都留着,而且**共用同一个 `setDependency`**(边的 id 怎么算只有一份实现)。
 * 这里那组勾选框不是历史遗留:拉线没有键盘等价物,勾选框有 —— 去掉它,不用鼠标的人
 * 就配不出依赖。反过来,拉线解决的是"图上直接连更顺手",以及拖到会成环的目标时当场
 * 变红(见 `旧版画布`)。
 * 两条路都会挡住成环的那一条,并在原地说明原因(`wouldCycle`),不用等到存盘被拒。
 */
import { useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select } from "@renderer/components/ui/index.js";
import { paramsForProfile, type AgentProfile } from "@contracts/agentProfile";
import {
  NODE_FLOW_RECORD_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  isModelDecider,
  isNodeRunnable,
  showsNodeCapability,
  validateNodeParams,
  type NodeTypeCatalog,
  type NodeTypeEntry,
} from "@contracts/nodeType";
import { validateOutputRules, NODE_OUTPUT_VARS_KEY } from "@contracts/outputConstraint";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";
import { insertableGroups } from "./insertVariable.js";
import {
  WORKFLOW_CAPABILITIES,
  buildForwardAdjacency,
  nodesOnLoopOf,
  nodesWithDownstream,
  type WorkflowCapability,
  type WorkflowDoc,
  type WorkflowNode,
} from "@contracts/workflow";
import {
  IconAlertTriangle,
  IconArrowsSplit,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import {
  findNodeType,
  isIdentityLocked,
  isLoopGate,
  isProtectedNode,
  nodeTitle,
  removeActionOf,
  type WorkflowPurpose,
} from "./workflowView.js";
import { wouldCycle } from "./workflowEdit.js";
import { Field, GrowingTextarea, ParamField } from "./ParamField.js";
import { MODULE_CALL_PARAM_KEYS, ModuleCapabilityFields } from "./ModuleCapabilityFields.js";
import { workflowDisplayDescription, workflowDisplayName } from "@renderer/lib/workflowLabels.js";
import { WorkflowBadge } from "./WorkflowBadge.js";
import { AutomationRunSection } from "./AutomationRunSection.js";
import { displayedParam, visibleNodeParams } from "./workflowPresentation.js";
import { TransferSection } from "./TransferSection.js";
import { NodeSection, WorkflowSection } from "./NodeInspectorParts.js";

export function NodeInspector({
  doc,
  savedDoc = doc,
  dirty = false,
  catalog,
  profiles,
  profileError,
  selectedNodeId,
  purpose,
  onUpdateNode,
  onUpdateWorkflow,
  onRemoveNode,
  onSetDependency,
  onUpdateEdge,
  onSaveProfile,
  onRemoveProfile,
  onRemoveWorkflow,
  onPinDefault,
  onRestoreDefault,
  pinned = false,
  onImported,
}: {
  doc: WorkflowDoc;
  savedDoc?: WorkflowDoc;
  dirty?: boolean;
  catalog: NodeTypeCatalog;
  /** 保存下来的子 agent 配置(见 `@contracts/agentProfile`)。 */
  profiles: AgentProfile[];
  /** 上一次存/删档案失败的原因。**由外面持有** —— 因为它不是"这个节点"的状态。 */
  profileError: string | null;
  selectedNodeId: string | null;
  /** 在编的是工作流还是自动化 —— 只影响"工作流本体"那一块(自动化多一段触发方式)。
   *  节点那一块完全一样:同一个节点类型库、同一个参数表单。 */
  purpose: WorkflowPurpose;
  onUpdateNode: (id: string, patch: Partial<Omit<WorkflowNode, "id">>) => void;
  /** 改工作流本体的字段(名称/说明/流程文字/触发方式)。内置工作流的名称与说明走
   *  i18n,界面上是只读的 —— 那只读态由 `isIdentityLocked` 决定,这里不重复判断。 */
  onUpdateWorkflow: (patch: Partial<Omit<WorkflowDoc, "id">>) => void;
  onRemoveNode: (id: string) => void;
  onSetDependency: (nodeId: string, depId: string, on: boolean) => void;
  /** 改一条出边上的选项名 / 说明。只有**分支节点**用得上(见 `WorkflowEdge`)。 */
  onUpdateEdge: (edgeId: string, patch: { label?: string; note?: string }) => void;
  onSaveProfile: (name: string) => Promise<boolean>;
  onRemoveProfile: (id: string) => Promise<void>;
  onRemoveWorkflow: () => void;
  /** 把当前版本钉成「默认」(内置退役后对**所有**工作流开放)。 */
  onPinDefault: () => void;
  /** 「恢复默认」= 回到钉住的那版。只在 `pinned` 为真时画按钮。 */
  onRestoreDefault: () => void;
  /** 这份工作流钉过自定默认吗(来自 `WorkflowListEntry.pinned`)。 */
  pinned?: boolean;
  /** 导入成功之后叫一声(参数是落库后的 id)—— 见 `TransferSection`。 */
  onImported: (id: string) => void;
}) {
  const node = doc.nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto rounded-md border border-edge bg-surface/40 p-3">
      {node ? (
        <NodeSection
          doc={doc}
          node={node}
          purpose={purpose}
          catalog={catalog}
          profiles={profiles}
          profileError={profileError}
          onUpdateNode={onUpdateNode}
          onRemoveNode={onRemoveNode}
          onSetDependency={onSetDependency}
          onUpdateEdge={onUpdateEdge}
          onSaveProfile={onSaveProfile}
          onRemoveProfile={onRemoveProfile}
        />
      ) : (
        <WorkflowSection
          doc={doc}
          savedDoc={savedDoc}
          dirty={dirty}
          catalog={catalog}
          purpose={purpose}
          onUpdateWorkflow={onUpdateWorkflow}
          onRemoveWorkflow={onRemoveWorkflow}
          onPinDefault={onPinDefault}
          onRestoreDefault={onRestoreDefault}
          pinned={pinned}
          onImported={onImported}
        />
      )}
    </aside>
  );
}

/* ────────────────────────── 工作流本体 ────────────────────────── */
