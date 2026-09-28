/**
 * 工作流库:左边是库列表(内置六个 + 用户自建),中间是画布,右边是检查器。
 *
 * ## 数据从哪来
 *
 * `workflow.list` 只给**列表项**(不含 `nodes` / `edges`),选中之后才走
 * `workflow.get` 取完整文档 —— 库里可能有几十个工作流,把每张图的全部节点都塞进
 * 列表响应是白花带宽(见 `WorkflowListEntry` 的注释)。
 *
 * ## 两份文档:基线 + 编辑中
 *
 * `baseline` 是磁盘上那一份,`working` 是编辑中的那一份。**所有改动只动 `working`**,
 * 点「保存」才把它写回去,写回去之后再把基线推进一步。分开的理由是"脏"这件事需要一个
 * 参照物(`isDocDirty` 比的是这两个的引用),而把参照物混进编辑中的对象里就再也分不出
 * 来了。
 *
 * ## 保存是**点出来的**,不是自动的
 *
 * 早先这里是自动保存(改动 700ms 后静默写回)。改成显式保存是用户的要求,原话:
 * 「你的节点流程图得有保存键呀,不然容易误触,改变内容」—— 自动保存的那套里,手滑拖
 * 一下、误按一下 Delete,**700ms 之后就已经落盘了**,而画布上没有撤销,也没有任何
 * 一步能让人停下来想想。
 *
 * 所以规则改成:**只有点「保存」才写盘**。由此带出来的三条,缺一条这个模型就不成立:
 *
 *  - **草稿不会丢**(`stashDraft` + `DRAFTS`):切到别的工作流、切去别的设置页、再回来,
 *    改到一半的东西还在。丢掉草稿是自动保存唯一真正解决好的问题,不能因为改成手动就
 *    把它还回去。
 *  - **「放弃改动」**(`discard`):误触之后除了"存下去"还得有另一条出路 —— 否则用户被
 *    逼着把自己不想要的那一版落盘,而"我什么都没干它怎么变了"更难解释。
 *  - **状态行要说人话**:「有未保存的改动」摆在那颗按钮旁边(`saveState`),不能只有一个
 *    灰点 —— 用户看不见"没存",这套模型就变成了"改了但没生效"。
 *
 * ⚠️ **一次写回 = 一次整库落盘**(`WorkflowRepo.save` 里的 `persist()` 会把整个
 * sqlite 文件重写)。自动保存时这决定了防抖是必须的;改成手动之后**按一次存一次**,
 * 所以更要挡住重复发送:
 *   - **一次只发一次** —— 在飞的那次落地之前,别的 `flush` 都在等它(`inflight`);
 *   - **删除期间不发** —— `save` 是 upsert,晚到的那次会把刚删掉的行写回去(`removingRef`)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { makeAgentProfileId, profileFromParams, type AgentProfile } from "@contracts/agentProfile";
import { MAIN_NODE_TYPE_ID, TRIGGER_NODE_TYPE_ID, type NodeTypeCatalog } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowListEntry, WorkflowNode, WorkflowPosition, WorkflowReviewInfo } from "@contracts/workflow";
import { workflowDisplayName, workflowIcon } from "@renderer/lib/workflowLabels.js";
import { isEditableTarget } from "@renderer/lib/shortcuts.js";
import { IconLoader2, IconAlertTriangle, IconArrowsSplit, IconPlus, IconRefresh } from "@renderer/lib/icons.js";
import {
  isDocDirty,
  forSave,
  isNodeDeleteKey,
  isProtectedNode,
  missingRequiredName,
  purposeOf,
  removeActionOf,
  uniqueWorkflowName,
  type WorkflowPurpose,
} from "./workflowView.js";
import {
  addNode as addNodeTo,
  connect,
  makeWorkflowId,
  moveNode,
  newAutomationDoc,
  newWorkflowDoc,
  relayout,
  removeEdge,
  removeNode as removeNodeFrom,
  seedMainAgent,
  seedTrigger,
  setDependency,
  updateEdge,
  updateNode,
} from "./workflowEdit.js";
import { WorkflowBadge } from "./WorkflowBadge.js";
import { mergeSavedWorkflow, normalizeDraft, WorkflowEditHistory } from "./workflowDraftState.js";
import { WorkflowCanvas } from "./WorkflowCanvas.js";
import { NodeInspector } from "./NodeInspector.js";
import { SaveStateLine, type SaveState } from "./SaveStateLine.js";
import { WorkflowListRow } from "./WorkflowListRow.js";

/**
 * **还没保存的草稿**,按工作流 id 存。
 *
 * 放在**模块作用域**而不是组件的 state 里,因为它必须活过组件的卸载:用户改到一半切去
 * 别的设置页、再切回来,那半份改动得还在。手动保存最容易挨的一句就是"我刚改的东西去
 * 哪了",而只要草稿还在,这句话就问不出来。
 *
 * ⚠️ 它**在内存里,进程结束就没了** —— 这是"保存键"这个模型自带的代价:用户要的是
 * "不点就不落盘",那就不能拿"自动帮你存了"去抵消它。所以状态行必须说清楚(见
 * `saveState`),不能让人以为已经存过了。
 */
const DRAFTS = new Map<string, WorkflowDoc>();
/** Preserve the revision a draft actually branched from across panel remounts. */
const DRAFT_REVISIONS = new Map<string, string | null>();

/**
 * 两栏各自的文案。**做成一张表**,而不是在 JSX 里散落
 * `purpose === "automation" ? … : …` —— 同一个判断写五六遍,等第三种"谁把它跑起来"
 * 出现时必定漏掉其中一两处。
 */
const PURPOSE_LABELS: Record<
  WorkflowPurpose,
  { library: MessageId; empty: MessageId; create: MessageId; defaultName: MessageId }
> = {
  workflow: {
    library: "settings.workflows.tabLibrary",
    empty: "settings.workflows.listEmpty",
    create: "settings.workflows.newWorkflow",
    defaultName: "settings.workflows.newWorkflowName",
  },
  automation: {
    library: "settings.automation.tabLibrary",
    empty: "settings.automation.listEmpty",
    create: "settings.automation.newAutomation",
    defaultName: "settings.automation.newAutomationName",
  },
};

/** 一次保存的结局。**由点「保存」那一下驱动**(还有新建时那一次)——
 *  失败的原因由状态行说,`save` 只据此决定"要不要把草稿袋里那份撤掉"。 */
type FlushResult =
  /** 没东西可存,或者已经存下去了。 */
  | "ok"
  /** 名称空着 —— 发出去也会被 `WorkflowDocSchema` 的 `min(1)` 拒。 */
  | "blocked"
  /** 主进程拒了,或者 IPC 报错。原因已经由状态行说出来了。 */
  | "failed";

/**
 * 一个能从外面 resolve 的 promise,用来占住"这次保存还在飞"的位置。
 *
 * 为什么不是"保存函数返回的 promise":槽位必须**在发起之前**就占上。`api.workflow.save`
 * 在手机端的 web shim 上是**同步抛**的(见 `lib/webApi`),那种情况下异步函数体会在
 * 我们拿到它的返回值之前就跑完 `finally` —— 槽位先被清掉、再被赋成一个已经落地的
 * promise,下一个 `flush` 就会永远等在一个不会变化的值上。
 */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function WorkflowLibraryView({
  purpose,
  catalog,
  catalogError,
  onRetryCatalog,
  profiles,
  profileError,
  onSaveProfile,
  onRemoveProfile,
}: {
  /** 这一栏在编**工作流**还是**自动化**。两者共用这一整个视图 —— 同一张画布、同一个
   *  检查器、同一套保存与草稿,差别只有三处:列哪些、新建出来的带不带触发器、以及
   *  检查器里多不多那段「触发方式」。 */
  purpose: WorkflowPurpose;
  catalog: NodeTypeCatalog | null;
  /** 清单读失败的原因。**必须传下来** —— 画布画不出来时,这一页是唯一能解释为什么
   *  的地方(节点类型那页的解释在另一个页签里,而用户正卡在这一个上)。 */
  catalogError: string | null;
  onRetryCatalog: () => void;
  /** 代理档案。**由 `WorkflowsPanel` 传下来** —— 节点类型那一页的档案列表读的是同一
   *  份,两个页签同时挂载,各拉各的就会分家。 */
  profiles: AgentProfile[];
  profileError: string | null;
  onSaveProfile: (profile: AgentProfile) => Promise<boolean>;
  onRemoveProfile: (id: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const labels = PURPOSE_LABELS[purpose];

  /** `null` = 还没读回来。**不要用空数组当初始值** —— 那会让"加载中"和"库里是空的"
   *  显示成同一句话。 */
  const [entries, setEntries] = useState<WorkflowListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 磁盘上那一份。只有点「保存」时才会改到它。 */
  const [baseline, setBaseline] = useState<WorkflowDoc | null>(null);
  /** 编辑中的那一份。界面读的一律是它。 */
  const [working, setWorking] = useState<WorkflowDoc | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [review, setReview] = useState<WorkflowReviewInfo | null>(null);
  /** Exact saved version to display before approval, not an unsaved canvas draft. */
  const [reviewDoc, setReviewDoc] = useState<WorkflowDoc | null>(null);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [approving, setApproving] = useState(false);

  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 上一次保存成功时校验器给的提醒。只在"和磁盘一致"时显示(一改动就换成"有未保存的改动")。 */
  const [saveNotes, setSaveNotes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);

  /** 「设为默认」的确认框开关(非破坏性,但要把"覆盖之前的默认"这句话说出口)。 */
  const [pendingPin, setPendingPin] = useState(false);
  /** 最后发起的那次 `workflow.get`。用户连点两个工作流时两次请求会并发,回来顺序
   *  不保证 —— 只认最后一次发出的那个,否则详情面板会显示成上一个的内容。 */
  const docRequestRef = useRef<string | null>(null);
  const docReadVersion = useRef(0);
  const baselineRevision = useRef<{ id: string; value: string | null } | null>(null);
  const listReadVersion = useRef(0);
  const mounted = useRef(true);
  const editorRef = useRef<HTMLDivElement>(null);
  const history = useRef(new WorkflowEditHistory());
  const [compact, setCompact] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia?.("(max-width: 1199px)");
    const resize = () => { const small = media?.matches ?? false; setCompact(small); setLibraryOpen(!small); };
    resize(); media?.addEventListener("change", resize);
    return () => { mounted.current = false; docReadVersion.current++; docRequestRef.current = null; media?.removeEventListener("change", resize); };
  }, []);

  const loadList = useCallback(async () => {
    // 保存/外部变更/首次载入都可能重叠，晚回来的旧列表不能盖掉新列表。
    const version = ++listReadVersion.current;
    try {
      const res = await api.workflow.list();
      if (!mounted.current || version !== listReadVersion.current) return;
      setEntries(res.workflows);
      setListError(null);
    } catch (err) {
      if (!mounted.current || version !== listReadVersion.current) return;
      setListError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  /**
   * 工作流那一摊变了 —— **包括 AI 改的**(它走 `mcp__mcode-workflow__*` 那几个工具,
   * 见 `main/mcp/mcodeServer.ts`)。这份列表是渲染端自己缓存的,AI 改的是数据根里
   * 那份真相,不订阅的话它建好的工作流要等用户关掉设置页再打开才出现。
   *
   * ⚠️ **只重拉列表,不碰 `working` / `baseline`。** 画布上的改动有它自己的保存时机
   * (刚拖完、正在编辑),被一条外部广播冲掉的话,用户刚拖的那一下会凭空回去
   * —— 这正是 `WorkflowChangedMessage` 那条注释在说的事。
   *
   * 用 `?.` 调用:手机端的 web shim 对没列出的推送通道会同步抛错(见 webApi.ts 顶部)。
   */
  useEffect(() => {
    const off = window.api?.on?.workflowsChanged?.(() => void loadList());
    return off;
  }, [loadList]);

  /**
   * 打开一份图。
   *
   * `selectNodeId`（2026-09-22）—— **打开之后选中哪个节点**。
   *
   * 为什么需要它：自动化是"触发器 + 主代理"两个节点种出来的，而**触发器的参数
   * （触发方式 / 定时表达式 / 监听什么 / 立刻跑一次）全在右侧检查器里** ——
   * 检查器只画"当前选中的那个节点"。
   *
   * 从前这里恒为 `null`，于是新建一条自动化之后**谁都没选中**：用户看到的是一张
   * 有卡片的画布 + 一个空检查器，**根本找不到"触发方式在哪配、手动按钮在哪"**。
   * 用户的原话：「只有类型，具体怎么触发呢，还有手动，手动的按钮在哪里，这些都没有」。
   *
   * 点列表打开时仍然不传（那次是"回去接着改上次那张图"，不该替他选）。
   */
  const openWorkflow = useCallback(
    async (id: string, selectNodeId: string | null = null) => {
      const version = ++docReadVersion.current;
      history.current.clear();
      latest.current = null;
      setSelectedId(id);
      setSelectedNodeId(selectNodeId);
      setBaseline(null);
      baselineRevision.current = null;
      setWorking(null);
      setReview(null);
      setReviewDoc(null);
      setPendingApproval(false);
      setDocError(null);
      setSaveError(null);
      setSaveNotes([]);
      setDocLoading(true);
      docRequestRef.current = id;
      try {
        const res = await api.workflow.get({ id });
        if (!mounted.current || docReadVersion.current !== version) return;
        if (res.workflow) {
          baselineRevision.current = { id, value: DRAFTS.has(id)
            ? (DRAFT_REVISIONS.get(id) ?? null) : res.revision };
          setBaseline(res.workflow);
          setReview(res.review);
          setReviewDoc(res.workflow);
          // **有草稿就用草稿。** 基线仍然是磁盘上那一份,所以"脏"照样判得出来,状态行
          // 也照样会说"有未保存的改动" —— 用户切回来看到的就是他离开时那个样子。
          setWorking(normalizeDraft(DRAFTS.get(id) ?? res.workflow, res.workflow));
        } else {
          // 库里有这一行、却取不到文档:列表过期了(或者 payload 被外部改坏)。
          // 报一句 + 重新拉列表,而不是留一个空白面板。
          setDocError(t("settings.workflows.openFailed", { error: id }));
          void loadList();
        }
      } catch (err) {
        if (!mounted.current || docReadVersion.current !== version) return;
        setDocError(t("settings.workflows.openFailed", { error: (err as Error).message }));
      } finally {
        if (mounted.current && docReadVersion.current === version) setDocLoading(false);
      }
    },
    [loadList, t],
  );

  /* ── 保存 / 草稿 ── */

  /** `flush` 要读"此刻"的两份文档,而不是它被创建时闭包里的那两份 —— 保存是异步的,
   *  等它的这段时间里用户可能又改了,用闭包会存下一份过期的。 */
  const latest = useRef<{ baseline: WorkflowDoc; working: WorkflowDoc } | null>(null);
  latest.current = baseline && working ? { baseline, working } : null;

  /** 在飞的那一次保存。**一次只发一次** —— 每次保存都是一次整库落盘
   *  (`WorkflowRepo.save` 里的 `persist()` 重写整个 sqlite 文件),而连点两下「保存」、
   *  或者保存期间又去删这份文档,两次写会撞在一起。 */
  const inflight = useRef<{ promise: Promise<void> } | null>(null);
  /** 正在删这份文档。删除期间**不许再发保存** —— `WorkflowRepo.save` 是 upsert,
   *  晚到的那一次会把刚删掉的那一行写回去。 */
  const removingRef = useRef(false);

  const flush = useCallback(async (): Promise<FlushResult> => {
    const requestedId = latest.current?.working.id;
    // 上一次落地了再决定这一次,而且**是重新判、不是复用上一次的结论** —— 等它的
    // 这段时间里用户可能又改了。
    while (inflight.current) await inflight.current.promise;

    const current = latest.current;
    // 删除动作把这份文档放下了,它已经不该再被保存。
    if (!current || current.working.id !== requestedId || removingRef.current) return "blocked";
    if (!isDocDirty(current.working, current.baseline)) return "ok";
    // 名称空着就发不出去,别拿它去换主进程一句 zod 报错。
    if (missingRequiredName(current.working)) return "blocked";

    // 内置工作流的名称与说明在界面上是只读的,这里再还原一次是兜底(见 `forSave`)。
    // 在占位之前算好:它必须和**这次要存的那一份文档**绑定。
    const id = current.working.id;
    const payload = forSave(current.working, current.baseline);
    const gate = makeGate();
    inflight.current = gate;
    setSaving(true);
    setSaveError(null);
    setSaveNotes([]);
    try {
      const expectedRevision = baselineRevision.current?.id === id
        ? baselineRevision.current.value : null;
      const res = await api.workflow.save({ workflow: payload, expectedRevision });
      if (!res.ok) {
        // 报错也要看是哪一份文档的错 —— 用户已经切走的话,这句话不该挂到别人头上。
        if (latest.current?.working.id === id) {
          setSaveError(res.error ?? t("settings.workflows.unknownError"));
        }
        return "failed";
      }
      // 只推进基线,**不动 `working`** —— 保存期间用户敲的字要留着;留着的话
      // `isDocDirty` 仍为真,状态行会继续说"有未保存的改动",再点一次就能补上。
      //
      // ⚠️ 前提是**还是这份文档**。切走之后 `latest.current` 已经是另一份,拿这次的
      // 结果去当它的基线,会让新的那份永远判成脏,而 `forSave` 还会拿错的基线去判
      // "内置的名字该不该还原" —— 把别人的名字写进这份文档(见 `workflowView`)。
      // Read the canonical server document (derived trigger + review metadata).
      // A failed read must remain an error, not a false "saved" acknowledgement.
      const saved = await api.workflow.get({ id });
      if (!saved.workflow) throw new Error(t("settings.workflows.openFailed", { error: id }));
      const active = mounted.current && latest.current?.working.id === id ? latest.current : null;
      const draft = active?.working ?? DRAFTS.get(id) ?? current.working;
      const merged = normalizeDraft(mergeSavedWorkflow(draft, current.working, saved.workflow), saved.workflow);
      if (isDocDirty(merged, saved.workflow)) {
        DRAFTS.set(id, merged);
        DRAFT_REVISIONS.set(id, saved.revision);
      } else {
        DRAFTS.delete(id);
        DRAFT_REVISIONS.delete(id);
      }
      if (mounted.current && active) {
        baselineRevision.current = { id, value: saved.revision };
        latest.current = { baseline: saved.workflow, working: merged };
        setBaseline(saved.workflow);
        setWorking(merged);
        setReview(saved.review);
        setReviewDoc(saved.workflow);
      }
      if (mounted.current && latest.current?.working.id === id) setSaveNotes(res.warnings ?? []);
      void loadList();
      return "ok";
    } catch (err) {
      if (latest.current?.working.id === id) {
        setSaveError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
      }
      return "failed";
    } finally {
      if (inflight.current === gate) inflight.current = null;
      gate.release();
      if (mounted.current) setSaving(false);
    }
  }, [loadList, t]);

  const dirty = baseline !== null && working !== null && isDocDirty(working, baseline);
  /** 名称空着就存不下去 —— 判据与 `flush` 用的是同一个(见 `missingRequiredName`),
   *  否则会出现"状态说能存、实际发不出去"这种自相矛盾。 */
  const nameMissing = working !== null && missingRequiredName(working);

  /**
   * 把这半份改动收进草稿袋 —— **切工作流、新建之前都要叫一次**。
   *
   * 这里**不落盘**:那是「保存」按钮的事。早先这一步是 `flush()`(切走之前替你存掉),
   * 那样一来"没点保存"就没有意义了 —— 切一下就把误触坐实了。
   */
  const stashDraft = useCallback(() => {
    const current = latest.current;
    if (!current) return;
    if (isDocDirty(current.working, current.baseline)) {
      DRAFTS.set(current.working.id, current.working);
      if (!DRAFT_REVISIONS.has(current.working.id)) {
        DRAFT_REVISIONS.set(current.working.id, baselineRevision.current?.id === current.working.id
          ? baselineRevision.current.value : null);
      }
    } else {
      DRAFTS.delete(current.working.id);
      DRAFT_REVISIONS.delete(current.working.id);
    }
  }, []);

  /** 列表上那颗"未保存"的点要跟着草稿袋走。袋子的内容不是 state,所以得有人在改动之后
   *  叫一声 —— 三处调用(`stashDraft` / `save` / `discard`)各自紧跟一次,别漏。 */
  useEffect(() => () => stashDraft(), [stashDraft]);

  const [draftIds, setDraftIds] = useState<readonly string[]>(() => [...DRAFTS.keys()]);
  const refreshDrafts = useCallback(() => setDraftIds([...DRAFTS.keys()]), []);

  /**
   * 点「保存」—— **唯一一条把编辑落盘的路径**。
   *
   * 成功之后才把草稿从袋子里撤掉:失败(名称空着、主进程拒了)时它得留着,否则用户
   * 改的那一份就真的没地方找了,而状态行还在说"保存受阻"。
   */
  const save = useCallback(async (): Promise<void> => {
    await flush();
    if (mounted.current) refreshDrafts();
  }, [flush, refreshDrafts]);

  /**
   * 放弃这一份改动,回到磁盘上那一份。
   *
   * **没有它,"误触"就只剩一条出路 —— 把它存下去。** 而用户要的正好相反:拖错了、
   * 删错了,该有一个"算了"的出口。
   */
  const discard = useCallback(async (): Promise<void> => {
    const id = working?.id;
    if (!id) return;
    DRAFTS.delete(id);
    DRAFT_REVISIONS.delete(id);
    refreshDrafts();
    // 重新从磁盘读一遍 —— 顺手把基线也对齐(它本来就没动,读一遍最省心)。
    await openWorkflow(id);
  }, [working?.id, openWorkflow, refreshDrafts]);

  /** 保存状态是**算出来的**,不是另存一份状态机 —— 存一份就一定会和这几个值不同步。 */
  const saveState: SaveState = nameMissing
    ? { kind: "error", message: t("settings.workflows.nameRequired") }
    : saveError
      ? { kind: "error", message: saveError }
      : saving
        ? { kind: "saving" }
        : dirty
          ? { kind: "pending" }
          : saveNotes.length > 0
            ? { kind: "notice", messages: saveNotes }
            : { kind: "clean" };

  /* ── 动作 ── */

  const entry = entries?.find((e) => e.id === selectedId) ?? null;
  /** 这一栏该显示哪些。**过滤只写在这一处**(下面一律用它),否则自动化会从某个
   *  没改到的列表里漏进工作流那一栏。 */
  const visible = entries?.filter((e) => purposeOf(e) === purpose) ?? null;
  const displayName = entry ? workflowDisplayName(entry, locale) : "";
  /** 这颗按钮该叫「恢复默认」还是「删除」—— 确认框的标题、正文、按钮共用一个答案。 */
  const reset = entry !== null && removeActionOf(entry) === "reset";

  /** 改编辑中的那一份。**唯一一处写 `working` 的地方** —— 于是"哪些动作会让文档变脏"
   *  这个问题只有一个答案。 */
  const edit = (next: WorkflowDoc) => {
    const current = latest.current;
    if (!current || next.id !== current.working.id || !history.current.record(current.working, next)) return;
    const normalized = normalizeDraft(next, current.baseline);
    latest.current = { ...current, working: normalized };
    setWorking(normalized);
    setSaveError(null);
    setSaveNotes([]);
  };
  const travel = (direction: "undo" | "redo") => {
    const current = latest.current;
    if (!current) return;
    const next = history.current[direction](current.working);
    if (!next) return;
    const normalized = normalizeDraft(next, current.baseline);
    latest.current = { ...current, working: normalized };
    setWorking(normalized);
    setSaveError(null);
    setSaveNotes([]);
    if (!next.nodes.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null);
  };
  const travelRef = useRef(travel);
  travelRef.current = travel;

  const approve = async () => {
    setPendingApproval(false);
    if (!review?.pending || !reviewDoc || dirty || saving) return;
    const id = reviewDoc.id;
    setApproving(true);
    setSaveError(null);
    setSaveNotes([]);
    try {
      const result = await api.workflow.approve({ id, revision: review.revision });
      if (!result.ok) {
        const reason = result.error ?? t("settings.workflows.unknownError");
        // The graph may have changed while the confirmation was open. Reload
        // its contents so the user does not approve the wrong revision. The
        // reload clears saveError, so display the rejection AFTER it completes.
        if (docRequestRef.current === id) {
          await openWorkflow(id);
          if (docRequestRef.current === id) setSaveError(reason);
        }
        return;
      }
      if (docRequestRef.current === id) setReview(result.review ?? null);
    } catch (err) {
      if (docRequestRef.current === id) {
        setSaveError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
      }
    } finally {
      setApproving(false);
    }
  };

  const select = (next: WorkflowListEntry) => {
    if (compact) setLibraryOpen(false);
    if (next.id === selectedId) return;
    // **切走不落盘,只收草稿。** 早先这里会先 `flush()`(替你存掉再切,存不下去就不切),
    // 那样"没点保存"就成了空话 —— 切一下等于替用户确认了手上的改动。草稿袋保证它不会
    // 丢:回来的时候 `openWorkflow` 会把这份草稿放回画布,状态行照旧说"有未保存的改动"。
    stashDraft();
    refreshDrafts();
    if (compact) setLibraryOpen(false);
    void openWorkflow(next.id);
  };

  const create = async () => {
    // 新建会把 `working` 换成一张白纸 —— 手上那份先收进草稿袋(同上,不落盘)。
    stashDraft();
    refreshDrafts();
    setCreating(true);
    setSaveError(null);
    setSaveNotes([]);
    try {
      const id = makeWorkflowId();
      // 名字在**整个库**里唯一,不只是这一栏 —— 两栏共用一个表,而选择器、确认框
      // 里都只显示名字,重名会让"删的是哪一条"变成一个要猜的问题。
      const taken = (entries ?? []).map((e) => e.name);
      // 挑对应的构造器:`newAutomationDoc` 与 `newWorkflowDoc` 的差别只有那个
      // `trigger` 字段,而它正是"这条东西属于哪一栏"的判据。
      const construct = purpose === "automation" ? newAutomationDoc : newWorkflowDoc;
      /**
       * **自动化只种一个触发器，不种主代理**（用户 2026-09-22 的明确要求）。
       *
       * 理由：自动化是"到点/文件变了/事件来了就起一次运行" —— 它的起点**就是触发器**，
       * 而"谁去干活"是用户接下来自己摆的事（可以放主代理、可以放别的节点、也可以
       * 让触发器下游直接接一个「命令」）。硬塞一个主代理等于替用户决定了架构，
       * 而且他一进去看到的就是一个自己没要过的节点，还得先删掉。
       *
       * 原话：「自动化只要自动插入触发器就行了，**不要主代理**」。
       *
       * 工作流那一栏不变 —— 它没有触发器，仍然自带一个主代理（那是它的入口）。
       */
      const trigger =
        purpose === "automation"
          ? catalog?.entries.find((e) => e.id === TRIGGER_NODE_TYPE_ID)?.manifest
          : undefined;
      if (purpose === "automation" && !trigger) {
        setSaveError(t("settings.workflows.mainTypeMissing"));
        return;
      }
      let doc: WorkflowDoc;
      if (purpose === "automation") {
        // 「在哪个项目里跑」是触发器的必填项,而它是**用户环境里的事实**(工作目录),
        // 编不出来 —— 挑用户列表里的第一个当起点,用户在检查器里改。一个项目都没有时
        // 留空:存盘会拦下并说清原因,那比默认塞一个不存在的 id 好。
        const res = await api.project.list().catch(() => null);
        doc = seedTrigger(
          construct(id, uniqueWorkflowName(t(labels.defaultName), taken)),
          trigger!,
          res?.projects?.[0]?.id,
        );
      } else {
        // 新建出来的图**自带一个主代理**(见 `seedMainAgent` 的文件头)。清单没读进来时
        // 宁可**不建**、并把原因说出来 —— 建一份没有入口的图正好是要消灭的东西。
        const main = catalog?.entries.find((e) => e.id === MAIN_NODE_TYPE_ID)?.manifest;
        if (!main) {
          setSaveError(t("settings.workflows.mainTypeMissing"));
          return;
        }
        doc = seedMainAgent(construct(id, uniqueWorkflowName(t(labels.defaultName), taken)), main);
      }
      /**
       * 待会儿要选中的那个节点 = **触发器**（见 `openWorkflow` 的 `selectNodeId`）。
       *
       * 从**种完的 doc** 里现找，而不是让 `seedTrigger` 返回 id —— 那个函数是纯的、
       * 只吐 doc（文件头说过"每一处都返回新 doc"），为这一处改它的签名不值得。
       */
      const triggerNodeId =
        purpose === "automation"
          ? doc.nodes.find((n) => n.type === TRIGGER_NODE_TYPE_ID)?.id ?? null
          : null;
      // **这一下直接落盘,不算破坏"点了保存才写"的规矩**:它落的是**刚建出来的那份**,
      // 此刻它在内存里连草稿都还不是 —— 不写下去的话,这个工作流在库里根本不存在,
      // 用户关掉设置页再回来会以为自己刚才没建成。
      const res = await api.workflow.save({ workflow: doc, expectedRevision: null });
      if (!res.ok) {
        setSaveError(res.error ?? t("settings.workflows.unknownError"));
        return;
      }
      await loadList();
      // 直接打开它 —— 新建之后就落在画布上,不用再去左边找一遍。
      // 自动化**顺手选中触发器**:它的参数(触发方式 / 定时表达式 / 立刻跑一次)
      // 全在检查器里,不选中的话用户根本看不到那一套(见 `openWorkflow` 那段)。
      await openWorkflow(id, triggerNodeId);
    } catch (err) {
      setSaveError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    } finally {
      setCreating(false);
    }
  };

  const removeWorkflow = async () => {
    if (!entry) return;
    setRemoving(true);
    setSaveError(null);
    setSaveNotes([]);
    removingRef.current = true;
    try {
      // 在飞的那次**先等落地再删**:反过来的话 `WorkflowRepo.save` 的 upsert 会把刚
      // 删掉的那一行写回去。等完之后 `removingRef` 继续挡着 —— 下面两次 await
      // (删一次、列一次,各自都是一次整库落盘)期间还可能又点了一下保存。
      if (inflight.current) await inflight.current.promise;
      // 该说「已恢复默认」还是「已删除」,以**主进程的答复**为准(`wasBuiltin`)——
      // 那是这个动作唯一的权威说法,不应该在渲染端另算一遍。
      const res = await api.workflow.remove({ id: entry.id });
      // 草稿跟着一起走:这份文档已经不在了,留着它只会在下次新建出同 id 时诈尸。
      DRAFTS.delete(entry.id);
      refreshDrafts();
      setPendingRemove(false);
      await loadList();
      if (docRequestRef.current !== entry.id) return;
      if (res.wasBuiltin) {
        // 恢复默认之后把默认版**重新打开**,让用户直接看见回来了什么 —— 关掉面板
        // 只会让人怀疑"是不是没生效"。
        await openWorkflow(entry.id);
      } else {
        setSelectedId(null);
        setBaseline(null);
        setWorking(null);
        setSelectedNodeId(null);
        setReview(null);
        setReviewDoc(null);
      }
    } catch (err) {
      setSaveError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  /** 把当前**存盘的**版本钉成默认(见 NodeInspector 里那颗按钮:dirty 时不可点)。
   *  成功的话用 saveNotes 那条通知带说一句 —— 它不改列表也不改画布,没有别的可见变化,
   *  不说一声用户会怀疑"点了没反应"。 */
  const pinDefault = async () => {
    if (!entry) return;
    setPendingPin(false);
    setSaveError(null);
    setSaveNotes([]);
    try {
      const res = await api.workflow.pinDefault({ id: entry.id });
      if (res.ok) setSaveNotes([t("settings.workflows.pinDefaultDone")]);
      else setSaveError(res.error ?? t("settings.workflows.unknownError"));
    } catch (err) {
      setSaveError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    }
  };

  /**
   * 导入成功之后(新建或覆盖)交接一下。
   *
   * 两件事,少一件都会让用户觉得"导进来了但看不出来":
   *
   *  - **手上那份草稿先收进袋子** —— 导入成功意味着画布上原来那份未保存的改动已经
   *    无从谈起了(它属于旧的那一份),同「新建」那条路,这里不替用户保存,只收好;
   *  - **切到落库后的那个 id** —— 覆盖时 id 就是当前这个,`openWorkflow` 会重新读一遍
   *    (拿到的是文件里那份,草稿袋里那份已经不脏了),新建时则落到新的一行上。
   *
   * 覆盖那条路上还有一件必须做的事:**草稿袋里那份按 id 存着,得先扔掉** —— 否则
   * `openWorkflow` 会把刚被覆盖掉的旧草稿又放回画布,用户以为导入没生效。
   */
  const handleImported = useCallback(
    (id: string) => {
      stashDraft();
      DRAFTS.delete(id);
      refreshDrafts();
      void loadList();
      void openWorkflow(id);
    },
    [stashDraft, refreshDrafts, loadList, openWorkflow],
  );

  /* ── 画布动作 ── */

  const handleAddNode = (typeId: string, profileId?: string) => {
    if (!working || !catalog) return;
    const manifest = catalog.entries.find((e) => e.id === typeId)?.manifest;
    if (!manifest) return;
    // 档案找不到(刚好被删了 / 读坏了)**照样建一个空白的** —— 用户点的是"加一个这种
    // 节点",而档案只是让参数先填好。为了少一份档案而什么都不发生是最差的结果。
    const profile = profileId ? profiles.find((p) => p.id === profileId) : undefined;
    const next = addNodeTo(working, manifest, profile ? { profile } : undefined);
    edit(next);
    // 新节点立刻选中:用户加它就是为了配它,而画布上多一张卡片不会自己说明它是谁。
    const added = next.nodes[next.nodes.length - 1];
    setSelectedNodeId(added.id);
  };

  /**
   * 把当前选中的那个节点的参数存成一份档案。
   *
   * **存的是参数,不是节点** —— 标题、位置、连了谁都不进去。同一份档案可以用在好几个
   * 步骤上,而那几处的位置和依赖显然不一样(见 `@contracts/agentProfile` 文件头)。
   */
  const handleSaveProfile = async (name: string): Promise<boolean> => {
    const node = working?.nodes.find((n) => n.id === selectedNodeId);
    if (!node) return false;
    const now = Date.now();
    return onSaveProfile(
      profileFromParams({
        id: makeAgentProfileId(now),
        name,
        type: node.type,
        params: node.params,
        createdAt: now,
      }),
    );
  };

  const handleRemoveNode = (id: string) => {
    if (!working) return;
    // **入口节点删不掉** —— 工作流是主代理、自动化是触发器（见 `isProtectedNode`）。
    // **在这里拦**而不是在 `removeNode` 里:那个是纯粹的编辑操作("给我一份删掉这个
    // 节点的文档"),规矩属于界面这一层。检查器那个按钮和键盘的 Delete 都走这个处理
    // 函数,所以一道就够(检查器那边还会**不摆**那个按钮,理由见 NodeInspector)。
    const target = working.nodes.find((n) => n.id === id);
    if (!target || isProtectedNode(target, purpose, working.nodes, catalog ?? undefined)) return;
    edit(removeNodeFrom(working, id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  };

  /**
   * **⌘/Ctrl + S** —— 和那颗「保存」按钮同一件事。
   *
   * 有了按钮还得有它:这个组合是"我改完了"的肌肉记忆,而在这套模型里它正好就是那个
   * 提交动作。**在输入框里按也要生效**(改的常常正是某个参数),所以不挡可编辑目标 ——
   * `NoteEditor` 那条绑定也是这个判断(同一个习惯,两处别给出两种行为)。
   */
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!editorRef.current?.getClientRects().length || !(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") { e.preventDefault(); void saveRef.current(); return; }
      if (!isEditableTarget(e.target) && (key === "z" || key === "y")) {
        e.preventDefault();
        travelRef.current(key === "y" || e.shiftKey ? "redo" : "undo");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /**
   * **键盘删除**:选中一个节点之后按 Delete 或 Backspace 就删掉它。
   *
   * 该不该删那三条规矩在 `isNodeDeleteKey` 里(纯函数,可断言);这里只负责两件它管不了
   * 的事:**没选中就不挂这个监听**,以及在真要删的时候 `preventDefault`(Backspace 在
   * 有些环境下还兼着"后退")。
   *
   * `removeRef` 用的是这个文件里已有的写法(见下面保存那条快捷键的 `saveRef`):处理
   *  函数每次渲染都是新的,直接进依赖数组会让监听器每次渲染都重挂一遍(选中节点时,
   *  检查器里每敲一个字就是一次渲染)。
   */
  const removeRef = useRef(handleRemoveNode);
  removeRef.current = handleRemoveNode;
  useEffect(() => {
    if (selectedNodeId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!editorRef.current?.getClientRects().length || !isNodeDeleteKey(e, isEditableTarget(e.target))) return;
      e.preventDefault();
      removeRef.current(selectedNodeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNodeId]);

  const handleMoveNode = (id: string, position: WorkflowPosition) => {
    if (!working) return;
    edit(moveNode(working, id, position));
  };

  const handleUpdateNode = (id: string, patch: Partial<Omit<WorkflowNode, "id">>) => {
    if (!working) return;
    const current = latest.current?.working;
    if (!current || current.id !== working.id) return;
    edit(updateNode(current, id, patch));
  };

  const handleUpdateWorkflow = (patch: Partial<Omit<WorkflowDoc, "id">>) => {
    if (!working) return;
    const current = latest.current?.working;
    if (!current || current.id !== working.id) return;
    edit({ ...current, ...patch });
  };

  const handleSetDependency = (nodeId: string, depId: string, on: boolean) => {
    if (!working) return;
    edit(setDependency(working, nodeId, depId, on));
  };

  // 画布上拉出来的那条线。成环的拖拽在画布那边就被拦下了(目标会当场变红),
  // 所以走到这里的都是合法的。
  const handleConnect = (from: string, to: string) => {
    if (!working) return;
    edit(connect(working, from, to));
  };

  const handleRemoveEdge = (edgeId: string) => {
    if (!working) return;
    edit(removeEdge(working, edgeId));
  };

  // 分支节点的选项名 / 说明(见 `WorkflowEdge`)。改的是**边**,不是节点参数 ——
  // 选项住在出边上,所以它没有走 `handleUpdateNode`。
  const handleUpdateEdge = (edgeId: string, patch: { label?: string; note?: string }) => {
    if (!working) return;
    edit(updateEdge(working, edgeId, patch));
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>{t(labels.library)}</Button>
        <Button size="sm" variant="secondary" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>{t("settings.workflows.inspectorToggle")}</Button>
        <Button size="sm" variant="ghost" disabled={!history.current.canUndo} onClick={() => travel("undo")}>{t("settings.workflows.undo")}</Button>
        <Button size="sm" variant="ghost" disabled={!history.current.canRedo} onClick={() => travel("redo")}>{t("settings.workflows.redo")}</Button>
      </div>
      <div ref={editorRef} data-workflow-editor className="grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: libraryOpen ? "200px minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {/* ───────── 左:库列表 ───────── */}
        <aside className={cn("min-h-0 flex-col rounded-md border border-edge bg-surface/40", libraryOpen ? "flex" : "hidden")}>
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>{t(labels.library)}</span>
            <span className="tabular-nums">{visible ? visible.length : "…"}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {visible?.map((item) => (
              <WorkflowListRow
                key={item.id}
                entry={item}
                active={item.id === selectedId}
                unsaved={draftIds.includes(item.id)}
                onSelect={() => select(item)}
              />
            ))}
            {visible?.length === 0 && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t(labels.empty)}
              </div>
            )}
            {entries === null && listError === null && (
              <div className="flex items-center justify-center gap-2 py-4 text-[0.7143em] text-content-subtle">
                <IconLoader2 size={12} className="animate-spin" />
                {t("common.loading")}
              </div>
            )}
            {listError !== null && (
              <div className="px-2 py-3 text-[0.7143em] leading-relaxed text-danger">
                {t("settings.workflows.loadFailed", { error: listError })}
              </div>
            )}
          </nav>
          <div className="border-t border-edge p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void create()}
              disabled={creating}
              className="w-full justify-center gap-1"
            >
              <IconPlus size={12} />
              {t(labels.create)}
            </Button>
          </div>
        </aside>

        {/* ───────── 右:画布 + 检查器 ───────── */}
        <div className="flex min-h-0 min-w-0 flex-col">
          {/* 工具栏那一行之上再放一个工作流标题行:选中节点时检查器显示的是节点,
              这时"我在编辑哪个工作流"就没有别的地方说了。 */}
          {working && baseline && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 text-content-muted">
                {workflowIcon(working.id, 13)}
              </span>
              <span className="truncate text-[0.8571em] font-medium text-content">
                {workflowDisplayName(working, locale)}
              </span>
              {working.builtin && (
                <WorkflowBadge tone="info">{t("settings.workflows.badgeBuiltin")}</WorkflowBadge>
              )}
              {entry?.edited && (
                <WorkflowBadge tone="accent">{t("settings.workflows.badgeEdited")}</WorkflowBadge>
              )}
              {/* 保存 / 放弃 + 状态行。**摆在标题行,和"我在编辑哪个工作流"同一行** ——
                  这是这一页唯一一处"整份文档"的位置,而这两个动作正是文档级的。
                  自动保存那会儿没有这一块,因为没有什么可点的。
                  按钮**一直在**(不是有改动才冒出来):它同时是"现在存没存"这个问题的
                  答案,藏在 dirty 后面的话,用户没法从界面上看出"已经存好了"。 */}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <SaveStateLine state={saveState} />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void discard()}
                  disabled={!dirty || saving}
                >
                  {t("settings.workflows.discard")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void save()}
                  disabled={!dirty || nameMissing || saving}
                >
                  {t("common.save")}
                </Button>
              </span>
            </div>
          )}

          {review?.pending && baseline && (
            <section className="mb-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-[0.7857em] leading-relaxed text-content" role="alert">
              <div className="flex items-start gap-2">
                <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t("settings.workflows.reviewPending")}</p>
                  <p className="text-content-muted">{t(review.origin === "import" ? "settings.workflows.reviewImported" : "settings.workflows.reviewAi")}</p>
                  <details className="mt-2" open>
                    <summary className="cursor-pointer font-medium">{t("settings.workflows.reviewDetails")}</summary>
                    <pre className="mt-1 max-h-48 max-w-full overflow-auto rounded border border-edge bg-surface p-2 text-[0.9em] whitespace-pre-wrap break-all">{reviewDoc ? JSON.stringify({
                      prompt: reviewDoc.prompt,
                      trigger: reviewDoc.trigger,
                      nodes: reviewDoc.nodes.map(({ id, title, type, capability, params }) => ({ id, title, type, capability, params })),
                      edges: reviewDoc.edges,
                    }, null, 2) : t("settings.workflows.reviewUnavailable")}</pre>
                  </details>
                  {dirty && <p className="mt-1 text-content-muted">{t("settings.workflows.reviewSaveFirst")}</p>}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    disabled={dirty || saving || approving || reviewDoc === null}
                    onClick={() => setPendingApproval(true)}
                  >
                    {t("settings.workflows.reviewEnable")}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {/* 画布与检查器**横排**(检查器在右边,300px)。
              2026-09-15 一度改成竖排(画布在上、检查器在下),那是为了把整页压到和
              别的设置页一样宽 —— 结果工作流这一页太小了,用户当场看了出来,于是宽度
              回到 `PANEL_MAX_W.canvas`,排布也跟着回到横排(见 `panelWidth.ts` 文件头
              那笔账)。**别再为了对齐把它压窄**:画布宽 208px/节点、列间距 72px,
              这一页本来就该宽。 */}
          <div className="flex min-h-0 min-w-0 flex-1 gap-4">
            {docLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("common.loading")}
              </div>
            ) : docError !== null ? (
              <div className="flex flex-1 items-start gap-2 text-[0.7857em] leading-relaxed text-danger">
                <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
                {docError}
              </div>
            ) : working && baseline ? (
              catalog ? (
                <>
                  <WorkflowCanvas key={working.id}
                    doc={working}
                    catalog={catalog}
                    profiles={profiles}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(id) => { setSelectedNodeId(id); if (id !== null) setInspectorOpen(true); }}
                    onMoveNode={handleMoveNode}
                    onAddNode={handleAddNode}
                    onRelayout={() => edit(relayout(working))}
                    onConnect={handleConnect}
                    onRemoveEdge={handleRemoveEdge}
                  />
                  <div className={cn("min-h-0 shrink-0", inspectorOpen ? "flex" : "hidden")}>
                  <NodeInspector
                    doc={working}
                    savedDoc={baseline}
                    dirty={dirty || saving}
                    catalog={catalog}
                    profiles={profiles}
                    profileError={profileError}
                    selectedNodeId={selectedNodeId}
                    purpose={purpose}
                    onUpdateNode={handleUpdateNode}
                    onUpdateWorkflow={handleUpdateWorkflow}
                    onRemoveNode={handleRemoveNode}
                    onSetDependency={handleSetDependency}
                    onUpdateEdge={handleUpdateEdge}
                    onSaveProfile={handleSaveProfile}
                    onRemoveProfile={onRemoveProfile}
                    onRemoveWorkflow={() => setPendingRemove(true)}
                        onPinDefault={() => setPendingPin(true)}
                    onImported={handleImported}
                  />
                  </div>
                </>
              ) : catalogError !== null ? (
                // 清单读不进来的时候**必须在这一页说**:用户卡住的正是这一个页签,而
                // 解释与重试按钮在"节点类型"那一边 —— 他不会想到去那儿找一个画布的错。
                <div className="flex flex-1 flex-col items-start justify-center gap-2 text-[0.7857em] leading-relaxed text-danger">
                  <span className="flex items-start gap-2">
                    <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {t("settings.workflows.nodeTypesLoadFailed", { error: catalogError })}
                  </span>
                  <Button variant="secondary" size="sm" onClick={onRetryCatalog} className="gap-1">
                    <IconRefresh size={12} />
                    {t("common.retry")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 text-[0.7857em] text-content-subtle">
                  <IconLoader2 size={14} className="animate-spin" />
                  {t("common.loading")}
                </div>
              )
            ) : (
              <EmptyDetail />
            )}
          </div>
        </div>
      </div>

      {/* 破坏性操作先问一句。**两个名字背后是同一个动作**(见 `removeActionOf`),
          所以标题、正文、按钮三处共用一个判别 —— 各写一遍的话,改错一处就会出现
          「恢复默认」的标题配「删除」的按钮。 */}
      <ConfirmDialog
        open={pendingApproval && review?.pending === true}
        danger
        title={t("settings.workflows.reviewConfirmTitle")}
        description={t("settings.workflows.reviewConfirmDesc")}
        confirmText={t("settings.workflows.reviewEnable")}
        onOpenChange={(open) => { if (!open) setPendingApproval(false); }}
        onConfirm={() => void approve()}
      />
      <ConfirmDialog
        open={pendingRemove && entry !== null}
        danger
        title={reset ? t("settings.workflows.resetTitle") : t("settings.workflows.deleteTitle")}
        description={
          reset
            ? t("settings.workflows.resetDesc", { name: displayName })
            : t("settings.workflows.deleteDesc", { name: displayName })
        }
        confirmText={reset ? t("settings.workflows.reset") : t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(false);
        }}
        onConfirm={() => void removeWorkflow()}
      />
      {/* 「设为默认」不是破坏性操作,但**覆盖之前的默认(包括应用自带那份的地位)**
          这件事必须先说出口 —— 静默覆盖等用户下次「恢复默认」时才发现,晚了。 */}
      <ConfirmDialog
        open={pendingPin && entry !== null}
        title={t("settings.workflows.pinDefaultTitle")}
        description={t("settings.workflows.pinDefaultDesc", { name: displayName })}
        confirmText={t("settings.workflows.pinDefault")}
        onOpenChange={(open) => {
          if (!open) setPendingPin(false);
        }}
        onConfirm={() => void pinDefault()}
      />
    </>
  );
}

/** 右栏空状态 —— 还没选工作流。 */
function EmptyDetail() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center text-center">
      <IconArrowsSplit size={28} className="mb-2 text-content-subtle" />
      <p className="max-w-[280px] text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.workflows.selectHint")}
      </p>
    </div>
  );
}
