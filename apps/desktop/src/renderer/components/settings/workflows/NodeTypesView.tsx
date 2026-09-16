/**
 * 节点类型(工作流面板的第二个页签)。
 *
 * ## 这一页回答三个问题
 *
 * 1. **现在有什么类型可用** —— 三种来源(内置 / 插件 / 本地)各带哪些。
 * 2. **每种类型要什么** —— 参数、能力、怎么跑。这几样决定了画布上那个节点长什么样,
 *    所以清单内容原样列出来,不加工。
 * 3. **哪些清单读不进来** —— 这是**非有不可**的一块:一个格式错的文件如果被静默跳过,
 *    用户看到的现象是"我写的类型没出现",而没有任何线索(见
 *    `main/orchestration/nodeTypes.ts` 文件头)。加载器把问题一起返回,这里原样显示。
 *
 * ## 为什么没有"编辑"按钮
 *
 * 清单是磁盘上的 JSON 文件(本地那份在数据根下的 `workflows/node-types/`,插件那份
 * 在插件目录里),真正的编辑器是用户的编辑器或 AI。这一页负责**看见**,不负责写 ——
 * 在设置里做一个 JSON 编辑器只会长成一个更差的文本编辑器。
 *
 * ⚠️ 类型认不出来**不算错误**:一份别人分享来的工作流引用了没装的类型,照样能存能看,
 * 只是跑不了。所以这一页也不把"某个工作流引用了缺失的类型"当问题列出来。
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import type { AgentProfile, AgentProfileCatalog } from "@contracts/agentProfile";
import {
  isRunnerImplemented,
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeSource,
} from "@contracts/nodeType";
import { IconAlertTriangle, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";
import { AgentProfilesView } from "./AgentProfilesView.js";
import { groupNodeTypes } from "./workflowView.js";
import { WorkflowBadge, type WorkflowBadgeTone } from "./WorkflowBadge.js";

const SOURCE_LABEL: Record<NodeTypeSource, MessageId> = {
  builtin: "settings.workflows.source.builtin",
  plugin: "settings.workflows.source.plugin",
  local: "settings.workflows.source.local",
};

/** 来源标签的色调。内置随应用发布(信息色)、插件是外面装进来的(强调色)、本地
 *  是自己写的(不抢眼)。 */
const SOURCE_TONE: Record<NodeTypeSource, WorkflowBadgeTone> = {
  builtin: "info",
  plugin: "accent",
  local: "muted",
};

/** 「这一组还没有东西 —— 怎么才能有」的那句话。内置那组不可能为空,所以只有两条;
 *  写成数组而不是 `Record`,是因为"哪些来源需要这句话"本身就是一个短名单。 */
const SOURCE_EMPTY_HINT: ReadonlyArray<{ source: NodeTypeSource; hint: MessageId }> = [
  { source: "plugin", hint: "settings.workflows.emptyPlugin" },
  { source: "local", hint: "settings.workflows.emptyLocal" },
];

export function NodeTypesView({
  catalog,
  loading,
  error,
  onRefresh,
  profiles,
  profileProblems,
  profileError,
  onSaveProfile,
  onRemoveProfile,
}: {
  /** 清单由 `WorkflowsPanel` 读一次往下传 —— 画布与检查器要的是同一份。 */
  catalog: NodeTypeCatalog | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** 代理档案。**同样由上面传下来** —— 画布那边的"添加节点"菜单和这里是同一份数据
   *  (两个页签同时挂载,各自拉一次就会分家)。 */
  profiles: AgentProfile[];
  profileProblems: AgentProfileCatalog["problems"];
  profileError: string | null;
  onSaveProfile: (profile: AgentProfile) => Promise<void>;
  onRemoveProfile: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const groups = catalog ? groupNodeTypes(catalog.entries) : [];

  return (
    <div className="pb-2">
      <div className="mb-3 flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[0.7857em] leading-relaxed text-content-subtle">
          {t("settings.workflows.nodeTypesIntro")}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 gap-1"
        >
          <IconRefresh size={12} className={cn(loading && "animate-spin")} />
          {t("common.refresh")}
        </Button>
      </div>

      {error !== null && (
        <div className="mb-3 flex items-start gap-2 rounded border border-edge p-2.5 text-[0.7857em] leading-relaxed text-danger">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t("settings.workflows.nodeTypesLoadFailed", { error })}
        </div>
      )}

      {loading && catalog === null && (
        <div className="flex items-center gap-2 py-8 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("common.loading")}
        </div>
      )}

      {catalog !== null && catalog.problems.length > 0 && (
        <div className="mb-3 rounded border border-warning/40 bg-warning/5 p-2.5">
          <div className="flex items-center gap-2 text-[0.7857em] font-medium text-content">
            <IconAlertTriangle size={13} className="shrink-0 text-warning" />
            {t("settings.workflows.problemsTitle", { n: catalog.problems.length })}
          </div>
          <p className="mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.workflows.problemsHint")}
          </p>
          <ul className="mt-1.5 space-y-1">
            {catalog.problems.map((problem) => (
              <li key={problem.file} className="text-[0.7143em] leading-relaxed">
                <code className="break-all text-content-muted">{problem.file}</code>
                <div className="text-danger">{problem.error}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {catalog !== null && groups.length === 0 && (
        <p className="py-6 text-center text-[0.7857em] text-content-subtle">
          {t("settings.workflows.nodeTypesEmpty")}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.source} className="mb-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
              {t(SOURCE_LABEL[group.source])}
            </span>
            <span className="tabular-nums text-[0.7143em] text-content-subtle">
              {group.entries.length}
            </span>
          </div>
          <ul className="space-y-1.5">
            {group.entries.map((entry) => (
              <NodeTypeCard key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ))}

      {/* 「怎么才能有」这几句只在**那一组不存在**时出现 —— 空组不画(见
          `groupNodeTypes`),所以提示挂在这里,不挂在那个不存在的组上。 */}
      {catalog !== null &&
        SOURCE_EMPTY_HINT.filter(
          (item) => !groups.some((g) => g.source === item.source),
        ).map((item) => (
          <p key={item.source} className="mb-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
            {t(item.hint)}
          </p>
        ))}

      {/* 代理档案挂在**同一页的下半部分**:它没有自己的类型,是"某个类型的一组参数",
          所以放在类型的旁边而不是另开一页(见 `AgentProfilesView` 文件头)。 */}
      <AgentProfilesView
        catalog={catalog}
        profiles={profiles}
        problems={profileProblems}
        error={profileError}
        onSave={onSaveProfile}
        onRemove={onRemoveProfile}
      />
    </div>
  );
}

function NodeTypeCard({ entry }: { entry: NodeTypeEntry }) {
  const { t } = useI18n();
  const m = entry.manifest;
  const runnable = isRunnerImplemented(m.runner.kind);
  return (
    <li className="rounded border border-edge bg-surface/40 p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[0.7857em] font-medium text-content">{m.name}</span>
        <code className="rounded bg-surface-muted px-1 text-[0.7143em] text-content-subtle">
          {m.id}
        </code>
        <WorkflowBadge tone={SOURCE_TONE[entry.source]}>
          {t(SOURCE_LABEL[entry.source])}
        </WorkflowBadge>
        {m.category && (
          <span className="text-[0.7143em] text-content-subtle">{m.category}</span>
        )}
        {/* 内置的 `from` 就是 "mcode",和上面那枚徽章说的是同一件事,不再重复。 */}
        {entry.source !== "builtin" && (
          <span className="text-[0.7143em] text-content-subtle">
            {t("settings.workflows.nodeTypeFrom", { from: entry.from })}
          </span>
        )}
      </div>

      {m.description && (
        <p className="mt-1 text-[0.7143em] leading-relaxed text-content-muted">
          {m.description}
        </p>
      )}

      {/* 参数 / 能力 / 执行方式都按清单里的原文显示(等宽):它们正是节点类型的作者
          在 README 里读到的写法,翻成界面词反而对不上。 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {m.params.length === 0 ? (
          <span className="text-[0.7143em] text-content-subtle">
            {t("settings.workflows.nodeTypeNoParams")}
          </span>
        ) : (
          m.params.map((p) => (
            <span
              key={p.key}
              className="flex items-center gap-1 rounded bg-surface-muted px-1 py-0.5 text-[0.7143em]"
            >
              <code className="text-content-muted">{p.key}</code>
              <span className="text-content-subtle">{p.kind}</span>
              {p.required && (
                <span className="text-warning">{t("settings.workflows.nodeTypeRequired")}</span>
              )}
            </span>
          ))
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7143em] text-content-subtle">
        <span>
          {t("settings.workflows.nodeTypeRunner")} <code className="text-content-muted">{m.runner.kind}</code>
        </span>
        <span>
          {t("settings.workflows.nodeTypeCapability")}{" "}
          <code className="text-content-muted">{m.capability}</code>
        </span>
      </div>

      {!runnable && (
        <p className="mt-1 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-warning">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t("settings.workflows.nodeTypeNotRunnable", { kind: m.runner.kind })}
        </p>
      )}
    </li>
  );
}
