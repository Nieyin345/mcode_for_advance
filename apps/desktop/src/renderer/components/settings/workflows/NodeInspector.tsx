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
 * 变红(见 `WorkflowCanvas`)。
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
import { insertableGroups } from "./insertVariable.js";
import {
  WORKFLOW_CAPABILITIES,
  WORKFLOW_TRIGGERS,
  buildForwardAdjacency,
  nodesOnLoopOf,
  nodesWithDownstream,
  type WorkflowCapability,
  type WorkflowDoc,
  type WorkflowNode,
  type WorkflowTrigger,
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
import { workflowDisplayDescription, workflowDisplayName } from "@renderer/lib/workflowLabels.js";
import { WorkflowBadge } from "./WorkflowBadge.js";
import { AutomationRunSection } from "./AutomationRunSection.js";
import { RunHistorySection } from "./RunHistorySection.js";
import { TransferSection } from "./TransferSection.js";

/** 内置工作流的名称与说明走 i18n,界面上是只读的 —— 这一条样式就是那个只读态。 */
const readOnlyCls = "cursor-default bg-surface-muted/40 text-content-muted focus:border-edge";

export function NodeInspector({
  doc,
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
  onImported,
}: {
  doc: WorkflowDoc;
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
  onSaveProfile: (name: string) => Promise<void>;
  onRemoveProfile: (id: string) => Promise<void>;
  onRemoveWorkflow: () => void;
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
          catalog={catalog}
          purpose={purpose}
          onUpdateWorkflow={onUpdateWorkflow}
          onRemoveWorkflow={onRemoveWorkflow}
          onImported={onImported}
        />
      )}
    </aside>
  );
}

/* ────────────────────────── 工作流本体 ────────────────────────── */

/**
 * 触发方式的两张表:下拉里那四个词,以及选中之后那句解释。
 *
 * `WorkflowDoc.trigger` 是一个**开关**(见 `@contracts/workflow`):它不再能在这儿被改
 * —— 它的值由**触发器节点**反推写回(见 `main/orchestration/library.ts` 的
 * `deriveTrigger`)。所以这两张表现在读的是"这条自动化是哪种触发"的**结果**,而用户改
 * 那件事的地方是画布上那个触发器节点的参数。`Record<WorkflowTrigger, …>` 的完整性照样
 * 有用:契约里多一个值,这两处就编译不过。
 */
const TRIGGER_LABELS: Record<WorkflowTrigger, MessageId> = {
  manual: "settings.automation.trigger.manual",
  schedule: "settings.automation.trigger.schedule",
  file: "settings.automation.trigger.file",
  event: "settings.automation.trigger.event",
  webhook: "settings.automation.trigger.webhook",
};

const TRIGGER_HINTS: Record<WorkflowTrigger, MessageId> = {
  manual: "settings.automation.triggerHint.manual",
  schedule: "settings.automation.triggerHint.schedule",
  file: "settings.automation.triggerHint.file",
  event: "settings.automation.triggerHint.event",
  webhook: "settings.automation.triggerHint.webhook",
};

/**
 * 参数值里那一段**文本**,给级联用(见 `NodeParamSpecSchema.fromParam`)。
 *
 * 参数是自由数据,存成数字、存成 null 都可能,而级联要的只是一个"选的是哪个" ——
 * 认不出就当没选(空串),让它退回"跟着主对话走"那一档。**不是数组就是空**这条规矩
 * 和 `ParamField` 里的 `stringListOf` 同源:一个脏值不该让整张表单崩掉。
 */
function asParamText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function WorkflowSection({
  doc,
  catalog,
  purpose,
  onUpdateWorkflow,
  onRemoveWorkflow,
  onImported,
}: {
  doc: WorkflowDoc;
  /** 节点类型表 —— 「立刻运行一次」要靠它认出**哪一格是触发器**(见 `AutomationRunSection`)。 */
  catalog: NodeTypeCatalog;
  purpose: WorkflowPurpose;
  onUpdateWorkflow: (patch: Partial<Omit<WorkflowDoc, "id">>) => void;
  onRemoveWorkflow: () => void;
  /** 导入成功(新建或覆盖)之后叫一声 —— 让画布切到刚导进来的那一份。 */
  onImported: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const locked = isIdentityLocked(doc);
  const name = workflowDisplayName(doc, locale);
  /** 这颗按钮该叫「恢复默认」还是「删除」—— 标题与文字共用一个答案。 */
  const reset = removeActionOf(doc) === "reset";
  const isAutomation = purpose === "automation";
  // 自动化一定有 trigger(那是它之所以是自动化的判据),但类型上它是可选的 ——
  // 兜一个 manual 只是为了下拉有个值可显示。
  const trigger = doc.trigger ?? "manual";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[0.8571em] font-medium text-content">{name}</span>
        {doc.builtin && (
          <WorkflowBadge tone="info">{t("settings.workflows.badgeBuiltin")}</WorkflowBadge>
        )}
      </div>
      <div className="mb-3 mt-0.5 flex items-center gap-2">
        <code className="rounded bg-surface-muted px-1 text-[0.7143em] text-content-subtle">
          {doc.id}
        </code>
      </div>

      {/* 触发方式排在最前面:对一条自动化来说,"它怎么跑起来"比它叫什么重要得多。

          ⚠️ **它是只读的**,虽然长得像个下拉。这个值由**触发器节点上的参数**反推写回
          (见 `main/orchestration/library.ts` 的 `deriveTrigger`),能改那件事的地方是画布
          上那个触发器节点的参数面板 —— 所以这里显示的是**结果**,不是输入。做成可点的话,
          用户在这里选一个、存盘时被反推覆盖掉,而界面上不会有任何解释。 */}
      {isAutomation && (
        <>
          <Field label={t("settings.automation.fieldTrigger")}>
            <Select.Root value={trigger} disabled>
              <Select.Trigger className="w-full">
                <Select.Value>
                  {(value: string) => t(TRIGGER_LABELS[value as WorkflowTrigger])}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner className="z-50">
                  <Select.Popup>
                    <Select.List>
                      {WORKFLOW_TRIGGERS.map((kind) => (
                        <Select.Item key={kind} value={kind}>
                          <Select.ItemText>{t(TRIGGER_LABELS[kind])}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </Field>
          <p className="-mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
            {t(TRIGGER_HINTS[trigger])}
          </p>
          {/* 这一句是给"下拉点不动"的人的:值的真相在触发器节点的参数上(见
              `main/orchestration/library.ts` 的 `deriveTrigger`)。 */}
          <p className="text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.automation.triggerDerived")}
          </p>
          <AutomationRunSection doc={doc} catalog={catalog} />
          {/* 运行历史(带节点数、可展开看节点级信息)跟在自动化状态旁边:读的是同一个
              后台会话,一份答"结果"、一份答"过程"。它从 `automation.sessions` 拿会话 id
              —— 那是自动化专属的通道,普通工作流(跟着对话跑)没有这个会话,不挂。 */}
          {isAutomation && <RunHistorySection workflowId={doc.id} />}
        </>
      )}

      <Field label={t("settings.workflows.fieldName")}>
        <Input
          type="text"
          // 锁住时显示界面上真正的名字(词条),而不是数据里的兜底中文。
          value={locked ? name : doc.name}
          readOnly={locked}
          maxLength={60}
          spellCheck={false}
          onChange={(e) => onUpdateWorkflow({ name: e.target.value })}
          // 收尾去空格放**失焦**而不是每次按键:`isDocDirty` 比的是引用与字面值,
          // 边打字边 trim 会让"草稿"和"刚存下去的那份"永远差一点,于是**一直显示有未保存的改动**。
          onBlur={locked ? undefined : () => onUpdateWorkflow({ name: doc.name.trim() })}
          className={cn(locked && readOnlyCls)}
        />
      </Field>
      <Field label={t("settings.workflows.fieldDescription")}>
        <Input
          type="text"
          value={locked ? workflowDisplayDescription(doc, locale) : (doc.description ?? "")}
          readOnly={locked}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => onUpdateWorkflow({ description: e.target.value })}
          onBlur={
            locked
              ? undefined
              : () => {
                  // 清空写成 `undefined` 而不是空串:空串是"有一条空说明",`undefined`
                  // 才是"没有说明",而 schema 里这个字段是可选的。
                  const trimmed = (doc.description ?? "").trim();
                  onUpdateWorkflow({ description: trimmed.length > 0 ? trimmed : undefined });
                }
          }
          className={cn(locked && readOnlyCls)}
        />
      </Field>
      {locked && (
        <p className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.lockedHint")}
        </p>
      )}

      <Field label={t("settings.workflows.fieldPrompt")}>
        <textarea
          value={doc.prompt ?? ""}
          spellCheck={false}
          placeholder={t("settings.workflows.promptPlaceholder")}
          onChange={(e) => onUpdateWorkflow({ prompt: e.target.value })}
          className="min-h-[160px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </Field>
      <p className="-mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("settings.workflows.promptAutoSaveHint")}
      </p>

      <TransferSection doc={doc} onImported={onImported} />

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          onClick={onRemoveWorkflow}
          title={
            reset
              ? t("settings.workflows.resetDesc", { name })
              : t("settings.workflows.deleteDesc", { name })
          }
        >
          {reset ? t("settings.workflows.reset") : t("common.delete")}
        </Button>
      </div>
    </div>
  );
}

/* ────────────────────────── 代理档案 ────────────────────────── */

/**
 * 节点上的「档案」那一行:**套用一份存好的配置 / 把现在这份存下来 / 删掉一份**。
 *
 * ## 节点不记住自己是从哪份档案来的
 *
 * 这一行是个**动作**,不是一个绑定:套用之后节点和档案就没有关系了(改节点不影响档案,
 * 改档案也不影响这个节点)。所以没有"当前选中的档案"这种状态 —— 有的话就得回答"用户
 * 改了一个参数之后,它还算是那份档案吗",而那个问题的答案一点也不直观。
 *
 * 用 Menu 而不是 Select 也是同一个理由:Select 是有选中态的控件,而这里没有"选中"
 * 可言,只有"执行一次套用"。
 */
function ProfileRow({
  profiles,
  error,
  onApply,
  onSave,
  onRemove,
}: {
  profiles: AgentProfile[];
  error: string | null;
  onApply: (profile: AgentProfile) => void;
  onSave: (name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  /** 非 null = 正在问名字。空串是合法中间态(还没打字)。 */
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitName = async (): Promise<void> => {
    const name = (naming ?? "").trim();
    if (name.length === 0) return;
    setBusy(true);
    await onSave(name);
    setBusy(false);
    setNaming(null);
  };

  return (
    <div className="mb-3 flex flex-col gap-1">
      <span className="text-[0.7143em] font-medium text-content-muted">
        {t("settings.workflows.fieldProfile")}
      </span>
      <div className="flex items-center gap-1.5">
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Menu.Trigger
            className={cn(
              "flex flex-1 items-center justify-between gap-1 rounded border border-edge bg-surface px-2 py-1 text-[0.7857em]",
              "text-content-muted transition-colors hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            <span className="truncate">{t("settings.workflows.applyProfile")}</span>
            <IconChevronDown size={11} className="shrink-0 opacity-70" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
              <Menu.Popup className="max-h-[260px] min-w-[240px] overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-2xl">
                {profiles.length === 0 ? (
                  <div className="px-3 py-1.5 text-[0.7143em] leading-snug text-content-subtle">
                    {t("settings.workflows.profileEmpty")}
                  </div>
                ) : (
                  profiles.map((profile) => (
                    <div key={profile.id} className="flex items-center">
                      <Menu.Item
                        onClick={() => {
                          onApply(profile);
                          setMenuOpen(false);
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-1.5 text-left outline-none select-none",
                          "data-[highlighted]:bg-surface-muted",
                        )}
                      >
                        <span className="truncate text-[0.8571em] font-medium text-content">
                          {profile.name}
                        </span>
                        {profile.description && (
                          <span className="truncate text-[0.7143em] text-content-subtle">
                            {profile.description}
                          </span>
                        )}
                      </Menu.Item>
                      {/* 删除放在菜单里而不是别处:档案没有自己的页面,而"我想删掉的那份"
                          正是在这里看见的。 */}
                      <button
                        type="button"
                        title={t("settings.workflows.removeProfile")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRemove(profile.id);
                        }}
                        className="mr-1 shrink-0 rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-danger"
                      >
                        <IconTrash size={11} />
                      </button>
                    </div>
                  ))
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <Button
          variant="ghost"
          size="sm"
          disabled={naming !== null}
          onClick={() => setNaming("")}
          className="shrink-0 gap-1"
        >
          <IconPlus size={11} />
          {t("settings.workflows.saveAsProfile")}
        </Button>
      </div>

      {naming !== null && (
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            autoFocus
            value={naming}
            maxLength={60}
            spellCheck={false}
            placeholder={t("settings.workflows.profileNamePlaceholder")}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitName();
              if (e.key === "Escape") setNaming(null);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || naming.trim().length === 0}
            onClick={() => void submitName()}
          >
            <IconCheck size={12} />
          </Button>
        </div>
      )}
      {error !== null && (
        <p className="text-[0.7143em] leading-relaxed text-danger">{error}</p>
      )}
    </div>
  );
}

/* ────────────────────────── 单个节点 ────────────────────────── */

function NodeSection({
  doc,
  node,
  catalog,
  profiles,
  profileError,
  onUpdateNode,
  onRemoveNode,
  onSetDependency,
  onUpdateEdge,
  onSaveProfile,
  onRemoveProfile,
}: {
  doc: WorkflowDoc;
  node: WorkflowNode;
  catalog: NodeTypeCatalog;
  profiles: AgentProfile[];
  profileError: string | null;
  onUpdateNode: (id: string, patch: Partial<Omit<WorkflowNode, "id">>) => void;
  onRemoveNode: (id: string) => void;
  onSetDependency: (nodeId: string, depId: string, on: boolean) => void;
  /** 改一条出边上的选项名 / 说明(只有分支节点用得上)。 */
  onUpdateEdge: (edgeId: string, patch: { label?: string; note?: string }) => void;
  onSaveProfile: (name: string) => Promise<void>;
  onRemoveProfile: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const entry = findNodeType(catalog.entries, node.type);
  // **分支节点**(见 `@contracts/nodeType` 的 `runner.kind`)。判据是**清单**而不是类型
  // id —— 第三方可以带自己的分支类型进来,而它的选项一样住在出边上。
  const isBranch = entry?.manifest.runner.kind === "branch";
  /** **触发器节点**:整条自动化的起点 —— 那次运行就是从它开始的。它**不能有上游**
   *  (存盘那一关会拒,见 `library.deriveTrigger`),所以这句话要在画的时候就说出来,
   *  而不是等用户画完一条线再被拒。 */
  const isTrigger = entry?.manifest.runner.kind === "trigger";
  /** **决定权给了模型的分支**(见 `@contracts/nodeType` 的 `isModelDecider`):
   *  它自己跑一轮,跑完按自己交出来的「出路」挑一条出边(见
   *  `@contracts/outputConstraint` 的 `DECIDE_VAR_NAME`)。判据是**清单 + 参数** ——
   *  「决定权」长在分支的参数上,选了「模型选」才走这一档。 */
  const isDecide = entry !== undefined && isModelDecider(entry.manifest, node.params);
  /** 它的出路。顺序即文档顺序 = 卡片上按钮的先后(见 `outgoingEdgesOf`)。 */
  const outEdges = doc.edges.filter((e) => e.from === node.id);
  const paramsCheck = entry ? validateNodeParams(entry.manifest, node.params) : null;
  // 产出约束那几个键**不是** `validateNodeParams` 管的(它只看清单声明过的形状),所以
  // 要单独查一次 —— 否则"选了 JSON 数组又填了必备字段"这件事,用户只会在**存盘被拒**
  // 或者某一步跑完之后才知道。
  const rulesCheck = entry ? validateOutputRules(entry.manifest, node.params) : null;
  // 这一步的指令里能插入哪些变量。**每次改图都要重算**(依赖一改,能引用的东西就变了),
  // 而 `doc` 的引用在每次编辑时都是新的,所以这个 memo 实际上就是"跟着图走"。
  const vars = useMemo(() => insertableGroups(doc, node.id, catalog), [doc, node.id, catalog]);
  /**
   * 图上**在环里**的那些节点 —— 「读流程记录」那一格的默认值来自它(在环上的默认开,
   * 见 `@contracts/workflow` 的 `nodesOnLoopOf`)。
   *
   * ⚠️ **必须和调度器共用同一个函数**:这里画的是开关的默认态,而主进程按同一个判据
   * 拼提示词。各算一遍的话,会出现"界面上显示关着、实际按开着跑" —— 那不报错,只在某
   * 一步悄悄多带或少带一大段上下文时才看得出来。
   */
  const loopNodes = useMemo(
    () => nodesOnLoopOf(doc.nodes, doc.edges, (id) => isLoopGate(catalog, doc, id)),
    [doc, catalog],
  );
  const others = doc.nodes.filter((n) => n.id !== node.id);
  // ⚠️ **要 `buildForwardAdjacency`,不是 `buildAdjacency`(2026-09-19)。**
  //
  // 两者只差回边,而这一处的两半都会被回边弄错,方向还相反:回边从**环的出口指回入口**,
  // 于是环上的节点会把**自己的下游**显示成「依赖」(它明明在我的下游),同时把**环的
  // 出口**(那才是正经理当的下一站)从「下游」那一行里去掉 —— 两者都直接显示在界面上。
  // 调度器(`scheduler.deps`)与存盘校验用的都是不含回边的那一份。
  const adjacency = buildForwardAdjacency(doc.nodes, doc.edges);
  // 这一步后面还有没有别的步骤。**判据和调度器共用同一个函数**(`nodesWithDownstream`)
  // —— 这里提示的和提示词里那句"你是最后一步"必须是同一件事。终末节点不摆变量表
  // (见 `scheduler.ts` 的 `withOutputCheck`),所以这里要说明白,不然用户填了表却没反应。
  const isTerminal = !nodesWithDownstream(doc).has(node.id);
  const deps = new Set(adjacency.deps.get(node.id) ?? []);
  const dependents = (adjacency.dependents.get(node.id) ?? [])
    .map((id) => doc.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => n !== undefined);

  return (
    <div className="flex flex-col">
      <div className="mb-3 flex flex-col gap-0.5">
        <span className="text-[0.8571em] font-medium text-content">
          {t("settings.workflows.nodeInspectorTitle")}
        </span>
        <div className="flex items-center gap-1.5">
          <code className="rounded bg-surface-muted px-1 text-[0.7143em] text-content-subtle">
            {node.type}
          </code>
          {entry && <WorkflowBadge tone="muted">{entry.manifest.name}</WorkflowBadge>}
          {/* 来源只在不是内置的时候说 —— 内置的就是随应用来的,再说一句是废话;
              而"这个类型是哪个插件装的"在排查时是要问的第一个问题。 */}
          {entry && entry.source !== "builtin" && (
            <span className="truncate text-[0.7143em] text-content-subtle">
              {t("settings.workflows.nodeTypeFrom", { from: entry.from })}
            </span>
          )}
        </div>
      </div>

      {/* 类型没装:一份别人分享来的工作流会走到这里。**不是错误**,但这个节点画不出
          也跑不了,得说出来(见 `@contracts/workflow` 文件头)。 */}
      {!entry && (
        <div className="mb-3 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-warning">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t("settings.workflows.nodeTypeMissing")}</span>
            <span>{t("settings.workflows.nodeTypeMissingDetail")}</span>
          </span>
        </div>
      )}
      {entry && !isNodeRunnable(entry.manifest) && (
        <p className="mb-3 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-warning">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t("settings.workflows.nodeTypeNotRunnable", { kind: entry.manifest.runner.kind })}
        </p>
      )}

      <Field label={t("settings.workflows.nodeTitle")}>
        <Input
          type="text"
          value={node.title}
          maxLength={80}
          spellCheck={false}
          placeholder={entry?.manifest.name ?? node.type}
          onChange={(e) => onUpdateNode(node.id, { title: e.target.value })}
        />
      </Field>

      {entry && (
        <ProfileRow
          // 只列**同类型**的档案:一份给别的类型存的参数套到这个节点上只会留下一堆
          // 它不认识的键(而 `validateNodeParams` 看不出问题 —— 它只看清单声明过的)。
          profiles={profiles.filter((p) => p.type === node.type)}
          error={profileError}
          onApply={(profile) =>
            onUpdateNode(node.id, { params: paramsForProfile(entry.manifest, profile) })
          }
          onSave={onSaveProfile}
          onRemove={onRemoveProfile}
        />
      )}

      {entry?.manifest.params.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          value={
            // 「读流程记录」**没表过态时显示的是按图算出来的那个值** —— 直接读 `params`
            // 的话,画一个环之后那一步明明会读记录,开关却显示关着,而用户只会以为自己没开。
            // (一旦他手动拨过,值就落到参数里,从此以那个为准 —— 见 `flowRecordOf`。)
            spec.key === NODE_FLOW_RECORD_PARAM_KEY && node.params[spec.key] === undefined
              ? loopNodes.has(node.id)
              : node.params[spec.key]
          }
          onChange={(value) =>
            onUpdateNode(node.id, { params: { ...node.params, [spec.key]: value } })
          }
          // **只有「指令」给「插入变量」的候选。** 别的文本参数(「期望产出」那段说明)
          // 解算器其实也认 `{{...}}`,但把菜单摊到每一处,只会让人以为哪儿都得插变量。
          {...(spec.key === NODE_PROMPT_PARAM_KEY ? { insertables: vars } : {})}
          // 清单写了 `fromParam` 的参数,候选要跟着**它指的那个参数此刻的值**收窄 ——
          // 今天只有「模型」用它(跟着「引擎」走,见 `NodeParamSpecSchema.fromParam`)。
          // 读的是 `node.params` 里那个值本身:顺序在 `params[]` 里已经保证了引擎排在
          // 模型前面,所以这里读到的就是用户在上一格刚选的那个。
          {...(spec.fromParam !== undefined
            ? { resolvedFrom: asParamText(node.params[spec.fromParam]) }
            : {})}
        />
      ))}
      {entry && isTerminal && entry.manifest.params.some((p) => p.key === NODE_OUTPUT_VARS_KEY) && (
        // 摆在参数表**之后**:它说的是"上面那张表用不上",读完表再读它才是那个顺序。
        <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.outputVarsTerminal")}
        </p>
      )}
      {isTrigger && (
        // 触发器是**起点**:它上面不该有线(有的话存盘会被拒 —— 见 `deriveTrigger`),
        // 而一条自动化可以放好几个(它们的项目和请求各管各的)。这两句都不是这一格参数
        // 的事,所以摆在参数表之后。
        <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.nodeTriggerHint")}
        </p>
      )}
      {entry && entry.manifest.params.length === 0 && !isTrigger && !isBranch && (
        // ⚠️ **分支节点不摆这一句。** 它清单里确实是空的,但空空如也的右上角会让用户
        // 以为"这个节点没什么可配的" —— 而它的参数长在**出边**上(选项名 + 说明,
        // 就在下面那一段)。写了这一句,下面那段就长得像另一种东西了。
        <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.nodeTypeNoParams")}
        </p>
      )}
      {paramsCheck && !paramsCheck.ok && (
        <p className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-warning">
          {paramsCheck.error}
        </p>
      )}
      {/* 两条校验的错**不合并**:参数缺了和产出约束配矛盾了,用户要改的是表单上不同的
          两处。合成一句话他就得自己猜是哪一处。 */}
      {rulesCheck && !rulesCheck.ok && (
        <p className="-mt-1 mb-3 text-[0.7143em] leading-relaxed text-warning">
          {rulesCheck.error}
        </p>
      )}

      {/* 能力:**只在它真的算数时才摆这一个下拉框**(见 `showsNodeCapability`)。
          另外四种跑法上它是占位 —— 摆出来就等于承诺了一件做不到的事:用户在这里把
          `read` 改成 `write`,行为一点不变(子 agent 的那条路根本走不到),而画布上的
          卡片还会继续显示原来那个值。 */}
      {showsNodeCapability(entry?.manifest) && (
        <Field label={t("settings.workflows.nodeCapability")}>
          <Select.Root
            value={node.capability ?? ""}
            onValueChange={(value) =>
              onUpdateNode(node.id, {
                capability: value === "" ? undefined : (value as WorkflowCapability),
              })
            }
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(value: string) =>
                  value === ""
                    ? t("settings.workflows.nodeCapabilityDefault", {
                        fallback: entry?.manifest.capability ?? "read",
                      })
                    : value
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner className="z-50">
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="">
                      <Select.ItemText>
                        {t("settings.workflows.nodeCapabilityDefault", {
                          fallback: entry?.manifest.capability ?? "read",
                        })}
                      </Select.ItemText>
                    </Select.Item>
                    {WORKFLOW_CAPABILITIES.map((capability) => (
                      <Select.Item key={capability} value={capability}>
                        <Select.ItemText>{capability}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </Field>
      )}

      {/* 依赖:勾一个上游。成环的那条当场禁用并说明(见文件头)。 */}
      <div className="mb-1 mt-1 text-[0.7857em] font-medium text-content-muted">
        {t("settings.workflows.nodeDeps")}
      </div>
      {others.length === 0 ? (
        <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.nodeDepsAlone")}
        </p>
      ) : (
        <div className="mb-2 max-h-[180px] space-y-0.5 overflow-y-auto rounded border border-edge bg-surface p-1">
          {others.map((other) => {
            const on = deps.has(other.id);
            const blocked = !on && wouldCycle(doc, node.id, other.id, (id) => isLoopGate(catalog, doc, id));
            return (
              <button
                key={other.id}
                type="button"
                disabled={blocked}
                title={blocked ? t("settings.workflows.nodeDepsCycle") : undefined}
                onClick={() => onSetDependency(node.id, other.id, !on)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[0.7857em] transition-colors",
                  on ? "text-content" : "text-content-muted",
                  blocked
                    ? "cursor-not-allowed opacity-40"
                    : "hover:bg-surface-hover/60 hover:text-content",
                )}
              >
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                    on ? "border-accent bg-accent/15 text-accent" : "border-edge",
                  )}
                >
                  {on && <IconCheck size={10} />}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {nodeTitle(other, findNodeType(catalog.entries, other.type))}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {dependents.length > 0 && (
        <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.nodeDependents", {
            // 分隔符走词典 —— 往界面上拼一个中文顿号,英文界面里就会看到
            // `Downstream: A、B`(见 AGENTS.md 的文案规则)。
            names: dependents
              .map((n) => nodeTitle(n, findNodeType(catalog.entries, n.type)))
              .join(t("settings.workflows.listSeparator")),
          })}
        </p>
      )}

      {/* 出路 —— **每个分支都有**,因为选项住在出边上(见 `@contracts/workflow` 的
          `WorkflowEdgeSchema`):图上有几根线就是几个选项。不在这里另开一张"选项表",
          因为那会有两种真相 —— 表里填了三个、图上只拉了两根线,而"用户能选什么"要读
          哪一份就说不清了。

          所以这一段做的是**给已有的线起名字**(外加一句给下一步的说明),而不是定义
          选项本身;要加一个选项,去画布上从它拉一根线。

          **「决定权」说了算谁来挑**:给用户,岔路口挂起等他点;给模型,它自己判、把
          选中的那条的名字交在「出路」这个产出变量里(见 `@contracts/outputConstraint`
          的 `DECIDE_VAR_NAME`)。所以下面那句提示只在模型选的分支上出现 —— 对"等你
          点"的分支说"名字就是你要交的值"是错的。 */}
      {isBranch && (
        <>
          <div className="mb-1 mt-1 text-[0.7857em] font-medium text-content-muted">
            {isDecide ? t("settings.workflows.decideOptions") : t("settings.workflows.branchOptions")}
          </div>
          {outEdges.length === 0 ? (
            // 没有出路的岔路口是**坏图**:等用户的分支会永远停在那儿(而用户看到的只是
            // 一张没有按钮的卡片),模型选的根本没法挑(调度器会以"没有出路"明确失败)。
            // 两边的说法不同,所以是两条词条。
            <p className="mb-3 text-[0.7143em] leading-relaxed text-warning">
              {isDecide
                ? t("settings.workflows.decideNoOptions")
                : t("settings.workflows.branchNoOptions")}
            </p>
          ) : (
            <div className="mb-3 space-y-2">
              {outEdges.map((edge) => {
                const target = doc.nodes.find((n) => n.id === edge.to);
                return (
                  <div key={edge.id} className="rounded border border-edge bg-surface p-1.5">
                    <div className="mb-1 flex items-center gap-1 text-[0.7857em] text-content-muted">
                      <IconArrowsSplit size={11} className="shrink-0 text-content-subtle" />
                      <span className="min-w-0 flex-1 truncate">
                        {t("settings.workflows.branchOptionTo", {
                          name: target
                            ? nodeTitle(target, findNodeType(catalog.entries, target.type))
                            : edge.to,
                        })}
                      </span>
                    </div>
                    {/* 选项名 = 按钮上那几个字(用户选)/ 它要交出来的那个值(模型选)。
                        **留空就用目标节点的标题**(调度器那边兜底),所以框里空着不是错,
                        只是没起名字 —— 模型选那边匹配时也会拿标题兜一次(见
                        `matchDecisionOption`)。 */}
                    <Input
                      value={edge.label ?? ""}
                      placeholder={t("settings.workflows.branchOptionLabel")}
                      onChange={(ev) => onUpdateEdge(edge.id, { label: ev.target.value })}
                    />
                    <div className="mt-1">
                      {/* 选了这条之后给**下一步**的一句说明(拼进它的提示词)。和用户
                          在选择时临时写的那句话并存 —— 这句对这条路上的每一步都成立,
                          那句只对这一次成立(见调度器里的 `Arrival`)。 */}
                      <GrowingTextarea
                        value={edge.note ?? ""}
                        placeholder={t("settings.workflows.branchOptionNote")}
                        onChange={(text) => onUpdateEdge(edge.id, { note: text })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {isDecide && (
            <p className="mb-3 text-[0.7143em] leading-relaxed text-content-subtle">
              {t("settings.workflows.decideOptionsHint")}
            </p>
          )}
        </>
      )}

      {/* **入口节点删不掉**（见 `isProtectedNode`）—— 工作流护主代理、自动化护触发器。
          **不摆一个按了没反应的按钮** —— 那看起来像坏了；把原因写在这儿,
          和画布卡片上那颗星对得上。

          判据用**不传 purpose 的 `isProtectedNode`** —— 它这时两种入口都护着
          （`mcode.main` / `mcode.trigger`），正是这里要的：`NodeSection` 拿不到
          "这是工作流还是自动化"（那是画布那一层的知识）。而**真正的拦截**
          （`handleRemoveNode`）那边是知道 purpose 的，所以多护一个也不会漏删。 */}
      {isProtectedNode(node) ? (
        <p className="mt-1 text-[0.7857em] leading-snug text-content-subtle">
          {t(isTrigger ? "settings.automation.triggerNodeHint" : "settings.workflows.mainNodeHint")}
        </p>
      ) : (
        <Button
          variant="danger"
          size="sm"
          className="mt-1 self-start gap-1"
          onClick={() => onRemoveNode(node.id)}
        >
          <IconTrash size={12} />
          {t("settings.workflows.nodeRemove")}
        </Button>
      )}
    </div>
  );
}
