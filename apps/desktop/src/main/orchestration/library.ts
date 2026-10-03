import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
/**
 * 工作流库 —— **内置默认版 + 用户覆盖** 合并之后的那一层。
 *
 * ## 内置退役(2026-09-26):自带内容 = 播种进表的普通行
 *
 * 用户的原话:「不要设置为内置,可以删除,只不过是软件自带的」。于是:
 *
 * | 东西 | 在哪 |
 * |---|---|
 * | 软件自带工作流的**出厂版** | 代码(`builtins.ts`)—— 只作**播种源** |
 * | 播种进来的自带行 / 用户自建行 | `workflows` 表,一律普通行,可改可删 |
 * | 用户钉的**自定默认** | 设置表 `workflow.pinnedDefaults`(见 pinWorkflowDefault) |
 *
 * 首次读取把出厂版**播种**成表里的普通行,并在设置表记下"播过哪些 id"
 * (`workflow.seededShipped`)。删掉的自带行**不会复活**(升级也不装回来 ——
 * 用户拍板「删了就是删了」);将来新版本新增的自带 id 不在已播名单里,照常播进来。
 * 读取**只看表**,不再有"内置打底 + 用户覆盖合并"那一层。
 *
 * 「恢复默认」不再是"删行让出厂版回来":它只对钉过自定默认的工作流存在
 * ({@link restoreWorkflowDefault} 把快照写回);「删除」就是删除(顺手把钉的快照
 * 也带走,免得同 id 重建时诈尸)。`removeWorkflow` 返回值里的 `wasBuiltin` 从此
 * **恒为 false** —— 字段留着是契约兼容,mcodeServer 的措辞据此永远说"已删掉"。
 */

import { createHash } from "node:crypto";
import type { WorkflowDoc, WorkflowListEntry } from "@contracts/workflow";
import { makeWorkflowId, uniqueWorkflowName } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { parseTriggerSpec, WORKFLOW_TRIGGER_OF_TRIGGER_KIND } from "@contracts/nodeType";
import { SettingRepo, WorkflowRepo } from "@main/store/repositories.js";
import { BUILTIN_WORKFLOWS } from "./builtins.js";
import { loadNodeTypes } from "./nodeTypes.js";
import { workflowSaveIsStale, workflowSaveVersion } from "./workflowSaveVersion.js";
import { clearWorkflowReview, requireWorkflowReview, workflowReviewError, type WorkflowOrigin } from "./workflowTrust.js";
import { importWorkflowDoc as parseWorkflowText, validateWorkflowDoc, exportWorkflowDoc } from "./workflowValidation.js";

function summarize(doc: WorkflowDoc, pinned: boolean, shippedUpdate = false): WorkflowListEntry {
  return {
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.icon ? { icon: doc.icon } : {}),
    // 内置退役:这两个字段恒为 false,留着是契约兼容(见文件头),别再拿它们分叉行为。
    builtin: false,
    edited: false,
    ...(pinned ? { pinned: true } : {}),
    ...(shippedUpdate ? { shippedUpdate: true } : {}),
    kind: doc.nodes.length > 0 ? "graph" : "prompt",
    // 带过去,不然列表分不出"工作流"和"自动化"两栏(见 `WorkflowListEntry`)。
    ...(doc.trigger ? { trigger: doc.trigger } : {}),
    updatedAt: doc.updatedAt,
  };
}

/* ── 播种:软件自带的工作流就是表里的普通行 ── */

/** 已播过的自带 id 名单(设置表)。记**名单**而不是记"播过一次":将来新版本新增
 *  自带工作流时老用户也该收到 —— 名单里没有的才播,删掉的因此不会复活。 */
const WORKFLOW_SEEDED_SETTING_KEY = "workflow.seededShipped";

let seededThisRun = false;

/** 把出厂版播种成表里的普通行(幂等,进程内只跑一次)。三件事:
 *  - 名单里没有的自带 id:表里没行就写一行(`builtin` 压成 false —— 播进来的就是
 *    普通行),已有行(旧模型下用户改过的"覆盖行")就只记名单、不动内容;
 *  - 老行迁移:旧模型里覆盖行的 `doc.builtin` 为 true,渲染端拿它锁名称/挂角标,
 *    这里一次性压成 false;
 *  - DB 没就绪时静默跳过,下次读取入口再试(读取入口本该在 initDb 之后才被叫到,
 *    这条是兜底不是常态)。 */
function ensureShippedSeeded(): void {
  if (seededThisRun) return;
  try {
    const raw = SettingRepo.get(WORKFLOW_SEEDED_SETTING_KEY);
    let seeded: string[] = [];
    try {
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      if (Array.isArray(parsed)) seeded = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 坏名单当空名单 —— 重播是幂等的(只补缺行,不覆盖既有行)。
    }
    const seededSet = new Set(seeded);
    let changed = false;
    for (const doc of BUILTIN_WORKFLOWS) {
      if (seededSet.has(doc.id)) continue;
      seededSet.add(doc.id);
      changed = true;
      if (WorkflowRepo.get(doc.id) === null) {
        WorkflowRepo.save({ ...doc, builtin: false, updatedAt: Date.now() });
      }
    }
    for (const row of WorkflowRepo.list()) {
      if (row.doc.builtin) WorkflowRepo.save({ ...row.doc, builtin: false });
    }
    if (changed) SettingRepo.set(WORKFLOW_SEEDED_SETTING_KEY, JSON.stringify([...seededSet]));
    baselineShippedRevisions();
    seededThisRun = true;
  } catch {
    // DB 未就绪等瞬态问题:保持未播状态,下一次再试。
  }
}

/** 全部工作流 —— 就是表里的行(含播种进来的自带行)。 */
export function listWorkflows(): WorkflowListEntry[] {
  ensureShippedSeeded();
  const pinnedMap = loadPinnedDefaults();
  const rows = WorkflowRepo.list();
  const updates = shippedUpdatesOf(rows.map((row) => row.doc));
  return rows.map((row) => summarize(row.doc, pinnedMap[row.doc.id] !== undefined, updates.has(row.doc.id)));
}

/* ── 出厂版更新(2026-09-30) ──
 *
 * 播种之后自带工作流就是普通行,新版本改了出厂内容(`builtins.ts`)老用户也收不到 ——
 * 播种只补**缺**的行,从不覆盖。于是记一张「这一行跟到了哪一版出厂内容」的表
 * (设置表 `workflow.shippedRevisions`:`id → 出厂内容哈希`),出厂内容变了而这一行
 * 又不等于新版时,列表项带上 `shippedUpdate`,界面画「出厂版有更新」。
 *
 * - **更新** = 用新出厂版覆盖这一行(界面先确认:会丢掉对这份的修改),用户关掉的
 *   触发器保持关闭;
 * - **忽略** = 只把这一版记为已看过,内容不动;
 * - 删掉的自带工作流不提示(删了就是删了,与播种同一立场);
 * - 老安装第一次跑到这里时表是空的:行与当前出厂版一致 → 直接记上;不一致 → 分不清
 *   是用户改过还是出厂版变过,如实提示,由用户选「更新」或「忽略」。 */

const WORKFLOW_SHIPPED_REVISIONS_KEY = "workflow.shippedRevisions";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 出厂内容的指纹 —— 不看 `updatedAt` / `builtin`(存盘时间与兼容字段不是内容)。 */
export function shippedContentRevision(doc: WorkflowDoc): string {
  const content: Record<string, unknown> = { ...doc };
  delete content.updatedAt;
  delete content.builtin;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function loadShippedRevisions(): Record<string, string> {
  const raw = SettingRepo.get(WORKFLOW_SHIPPED_REVISIONS_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function markShippedRevision(id: string, revision: string): void {
  const map = loadShippedRevisions();
  map[id] = revision;
  SettingRepo.set(WORKFLOW_SHIPPED_REVISIONS_KEY, JSON.stringify(map));
}

/** 表里还没有记录、而行正好等于当前出厂版的,直接记上(新播的行、老安装里没动过的行)。 */
function baselineShippedRevisions(): void {
  const map = loadShippedRevisions();
  let changed = false;
  for (const doc of BUILTIN_WORKFLOWS) {
    if (map[doc.id] !== undefined) continue;
    const row = WorkflowRepo.get(doc.id);
    if (row === null) continue;
    const revision = shippedContentRevision(doc);
    if (shippedContentRevision(row.doc) === revision) {
      map[doc.id] = revision;
      changed = true;
    }
  }
  if (changed) SettingRepo.set(WORKFLOW_SHIPPED_REVISIONS_KEY, JSON.stringify(map));
}

function shippedUpdatesOf(rows: WorkflowDoc[]): Set<string> {
  const map = loadShippedRevisions();
  const byId = new Map(rows.map((doc) => [doc.id, doc]));
  const out = new Set<string>();
  for (const shipped of BUILTIN_WORKFLOWS) {
    const row = byId.get(shipped.id);
    if (row === undefined) continue;
    const revision = shippedContentRevision(shipped);
    if (map[shipped.id] === revision || shippedContentRevision(row) === revision) continue;
    out.add(shipped.id);
  }
  return out;
}

/** 用出厂版覆盖这一行。用户关掉的节点开关(`params.enabled === false`,即关掉的触发器)
 *  原样保留 —— 更新内容不等于替用户重新打开一条他关掉的自动化。出厂内容是可信的,
 *  所以顺手清掉这一行的待审阅标记。调用方负责广播与让执行器重读。 */
export function applyShippedWorkflowUpdate(id: string): { ok: boolean; error?: string } {
  const shipped = BUILTIN_WORKFLOWS.find((doc) => doc.id === id);
  if (shipped === undefined) return { ok: false, error: "这份工作流不是软件自带的,没有出厂版可以更新" };
  const current = getWorkflow(id);
  if (current === null) return { ok: false, error: "这份工作流已经删掉了 —— 删掉的自带工作流不会再装回来" };
  const disabled = new Set(current.nodes.filter((node) => node.params.enabled === false).map((node) => node.id));
  const nodes = shipped.nodes.map((node) =>
    disabled.has(node.id) ? { ...node, params: { ...node.params, enabled: false } } : node,
  );
  const others = listWorkflows().filter((w) => w.id !== id).map((w) => w.name);
  WorkflowRepo.save({ ...shipped, nodes, name: uniqueWorkflowName(shipped.name, others), builtin: false, updatedAt: Date.now() });
  clearWorkflowReview(id);
  markShippedRevision(id, shippedContentRevision(shipped));
  return { ok: true };
}

/** 「忽略这次更新」:记下当前出厂版,内容不动。出厂内容再变时会重新提示。 */
export function dismissShippedWorkflowUpdate(id: string): { ok: boolean; error?: string } {
  const shipped = BUILTIN_WORKFLOWS.find((doc) => doc.id === id);
  if (shipped === undefined) return { ok: false, error: "这份工作流不是软件自带的,没有出厂版可以更新" };
  markShippedRevision(id, shippedContentRevision(shipped));
  return { ok: true };
}

/** 取一份工作流 —— 只看表(内置退役后没有"代码里的默认版"这一层)。找不到返回 null。 */
export function getWorkflow(id: string): WorkflowDoc | null {
  ensureShippedSeeded();
  return WorkflowRepo.get(id)?.doc ?? null;
}

/** 取工作流的提示词正文 —— 供 `RuntimeManager` 在每轮拼系统提示词时调。
 *
 *  没有提示词(图型工作流、或"默认"那个空提示词)返回 undefined,调用方据此跳过
 *  注入。**这是把提示词解析从 provider 搬到 host 的那一步**(见方案),provider
 *  从此只负责 append 一段字符串。 */
export function getWorkflowPrompt(id: string): string | undefined {
  const doc = getWorkflow(id);
  // A direct provider turn can bypass the graph runner (e.g. a prompt-only
  // workflow). Never inject unreviewed instructions into such a turn.
  if (doc === null || workflowReviewError(doc) !== null) return undefined;
  const text = doc.prompt;
  return text && text.length > 0 ? text : undefined;
}

/** `warnings`:校验器的**提醒**(能存、能跑,但多半画错了 —— 断链、不会被走到的回头线…)。
 *  原来算完就扔了,界面和 AI 都看不到;现在随成功结果带回去,由调用方决定怎么说。 */
export type SaveResult = { ok: true; warnings?: string[] } | { ok: false; error: string };

/** 存一份工作流。**存盘前必须过校验闸门**(`workflowValidation.ts`):
 *
 *  环(且环上要有"决定权给用户"的岔路口)、悬空边、断链、分支无出路、每个节点对它
 *  那份**类型清单**的参数合规、以及 `{{...}}` 引用存在性 —— 错误码与检查清单见那边。
 *  这些错等到执行时才发现就太晚了(用户已经画完一整张图,或者 Agent 已经交了一份
 *  跑不动的图)。
 *
 *  ⚠️ **类型认不出来不算错。** 一份别人分享来的工作流,在这台机器上可能引用了没装的
 *  节点类型(见 `@contracts/workflow` 文件头)。那种节点只记 warning、跳过参数校验,
 *  图照样能存能看 —— 只是跑不了。把"类型缺失"做成硬错误会让工作流没法分享。 */
export async function saveWorkflow(
  doc: WorkflowDoc,
  opts: { untrustedOrigin?: WorkflowOrigin; expectedRevision?: string | null } = {},
): Promise<SaveResult> {
  const types = new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]));

  // **质量闸门(WF-09)**:整份文档先过一遍结构化校验(见 `workflowValidation.ts` 的
  // 检查清单)。它把原来这里的 `validateDag` + `validateNodeParams` +
  // `validateOutputRules` 三道合成一份带稳定错误码的报告,并新增了三类原来要等到
  // 执行时才炸的检查:断链(无入边且非起点)、分支无出路、`{{...}}` 引用存在性
  // (引用不到 = 那一步跑起来必失败,见 `@contracts/nodeTemplate`)。
  //
  // 两条从旧代码原样继承的规矩:
  //  - **取类型必须在闸门之前** —— 判"环上有没有岔路口"靠的就是这份类型表;
  //  - **类型认不出来不算硬错误**(见 `@contracts/workflow` 文件头):存盘这一关走
  //    `unknownTypeSeverity: "warning"`,分享来的工作流照样能存能看。import 是另一条
  //    门(那边默认 error)—— 环、参数、引用这些**硬错误**两处都拦。
  const report = validateWorkflowDoc(doc, { types, unknownTypeSeverity: "warning", locale: SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh" });
  if (!report.ok) {
    const first = report.errors[0];
    return { ok: false, error: first ? first.message : "校验未通过" };
  }

  const derived = deriveTrigger(doc, types);
  if (!derived.ok) return derived;

  // ── 名字唯一 ──
  //
  // ⚠️ 这一步原来只在**导入**那条路上做(`importWorkflowInto`),而 `saveWorkflow`
  // 是**三条路共用的那一道闸门**:界面「保存」、AI 的 `workflow_save`、导入。
  // 于是"把 B 改名成和 A 一样"直接存下去,库里就有了两行同名 —— 而工作流选择器
  // 上只显示名字(`uniqueWorkflowName` 自己的注释就是为这件事写的:"选择器、确认框
  // 里都只显示名字,重名会让'删的是哪一条'变成一个要猜的问题")。
  //
  // 放在闸门里而不是各调用点:调用点将来还会加(AI 那边就是后加的),而这里的
  // **入参已经归一**(deriveTrigger 返回的是一份新 doc),错过这一步的地方会静默出问题。
  //
  // 去重要绕开的是**别的行**,不含它自己 —— 保存一份没改名的图,它的名字当然和
  // 库里这一行现在叫的一样,那不是重名。
  const others = listWorkflows()
    .filter((w) => w.id !== doc.id)
    .map((w) => w.name);

  // No awaits between this CAS check and the synchronous repository write.
  // A renderer draft based on an old GUI/AI/import revision must not silently
  // overwrite the newer document (including canvas-only changes or deletes).
  if (opts.expectedRevision !== undefined && workflowSaveIsStale(getWorkflow(doc.id), opts.expectedRevision)) {
    return { ok: false, error: "工作流已被其他写者修改或删除；请保留草稿并重新打开最新版本后再合并" };
  }
  const saved = { ...derived.doc, name: uniqueWorkflowName(derived.doc.name, others), updatedAt: Date.now() };
  // The marker is written first: even a crash after this point cannot leave
  // an imported/AI-edited executable doc trusted by default. Validation has
  // already finished, so rejected imports do not disarm the previous version.
  if (opts.untrustedOrigin) requireWorkflowReview(saved.id, opts.untrustedOrigin);
  WorkflowRepo.save(saved);
  const warnings = report.warnings.map((w) => w.message);
  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

/**
 * 把 `trigger` 那个字段从**触发器节点**反推出来。
 *
 * ## 为什么要有这一步
 *
 * `trigger` 在这一版**降级成了一个开关**(见 `@contracts/workflow` 的文件头):它不再有
 * 独立的真相 —— 列表分栏、MCP、i18n 那些照旧读它,而它的值一律从图上的触发器节点推。
 * 两处都能写的话,迟早出现"图上是个定时任务、列表里显示成事件触发"。
 *
 * ## 三条规则,每条都挡一个真问题
 *
 *  - **一个触发器都没有** → 删掉这个字段。它就是个普通工作流了,列表该分到另一栏。
 *  - **触发器有入边** → 报错。触发器是这次运行的**起点**(见 `scheduler.ts` 的 `entry`),
 *    它上游那些节点永远不会跑 —— 用户会以为图坏了,而图上看起来一切正常。
 *  - **参数不过 {@link parseTriggerSpec}** → 原样把那个错报出去。存下一份**永远不响**的
 *    自动化是最难查的一类问题:cron 写错、glob 写空都不会当场报错,只会安安静静地不跑。
 *
 * 一条自动化可以有多个触发器(它们在后台各听各的),而 `trigger` 只有一个值,所以按
 * **文档顺序取第一个** —— 分栏只需要知道"它是不是自动化、大概是哪一种"。
 *
 * 返回的是一份**新的 doc**(不修改入参):`saveWorkflow` 存的就是这一份。写成纯函数是为了
 * 冒烟能直接断言它,而不必去碰数据库(它也就因此不 import `automationRunner`,那个会拉到
 * electron —— 见 `main/ipc/orchestration.ts` 那处 reload 的注释)。
 */
export function deriveTrigger(
  doc: WorkflowDoc,
  types: Map<string, NodeTypeManifest>,
): { ok: true; doc: WorkflowDoc } | { ok: false; error: string } {
  const triggers = doc.nodes.filter((n) => types.get(n.type)?.runner.kind === "trigger");

  if (triggers.length === 0) {
    if (doc.trigger === undefined) return { ok: true, doc };
    const cleared: WorkflowDoc = { ...doc };
    delete cleared.trigger;
    return { ok: true, doc: cleared };
  }

  const first = triggers[0];
  const where = `触发器「${first.title || first.id}」`;

  // 触发器是这次运行的起点,上面不该有东西。判据是**边**,不是节点上的字段(依赖的
  // 真相是 `edges`,见 `@contracts/workflow` 的说明)。
  if (doc.edges.some((e) => e.to === first.id)) {
    return {
      ok: false,
      error: `${where}有上游节点 —— 触发器是这次运行的起点,它等的那件事发生时整张图就从它开始跑,所以它前面不能接别的步骤`,
    };
  }

  const manifest = types.get(first.type);
  if (manifest === undefined) return { ok: true, doc }; // 认不出的类型不算错(同上面那条)
  const check = parseTriggerSpec(manifest, first.params);
  if (!check.ok) return { ok: false, error: `${where}:${check.error}` };

  return { ok: true, doc: { ...doc, trigger: WORKFLOW_TRIGGER_OF_TRIGGER_KIND[check.spec.kind] } };
}

/**
 * 删掉工作流 —— 自带的与自建的**同一种删除**(内置退役后不再有"删行 = 恢复默认"
 * 的双关;「恢复默认」是钉过快照才有的另一个动作,见 restoreWorkflowDefault)。
 */
export function removeWorkflow(id: string): { ok: boolean; wasBuiltin: boolean } {
  WorkflowRepo.remove(id);
  clearWorkflowReview(id);
  // 钉过的自定默认**跟着删** —— 留着的话,将来重建同 id(或导入成同 id)时那份
  // 旧快照会诈尸成"可恢复的默认"。
  const map = loadPinnedDefaults();
  if (map[id] !== undefined) {
    delete map[id];
    SettingRepo.set(WORKFLOW_PINNED_DEFAULTS_KEY, JSON.stringify(map));
  }
  // `wasBuiltin` 恒为 false:字段留着是契约兼容(mcodeServer 据此永远说"已删掉")。
  return { ok: true, wasBuiltin: false };
}

/* ── 「设为默认」(自定默认) ── */

/** 自定默认的存储键:值是 `Record<内置工作流 id, WorkflowDoc>` 的 JSON。
 *  存**设置表**而不是 workflows 表 —— 它不是一份"生效的"工作流,只是「恢复默认」
 *  的回落目标;放 workflows 表会被 listWorkflows 当成覆盖行列出来。 */
const WORKFLOW_PINNED_DEFAULTS_KEY = "workflow.pinnedDefaults";

/** 读自定默认表。存坏(JSON 坏/形状不对)按**空表**处理 —— 与屏蔽规则同一条纪律:
 *  坏数据退回"没配过"(恢复默认落回出厂),不反过来把用户挡死。 */
function loadPinnedDefaults(): Record<string, WorkflowDoc> {
  const raw = SettingRepo.get(WORKFLOW_PINNED_DEFAULTS_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, WorkflowDoc>;
  } catch {
    return {};
  }
}

/**
 * 把 `id` **当前存盘的版本**钉成它的默认。之后「恢复默认」(restoreWorkflowDefault)
 * 回到这一版 —— 之前钉的被覆盖,这正是用户要的:「相当于是把之前的默认覆盖掉」。
 * 内置退役后**对所有工作流开放**(自带的与自建的都只是普通行)。
 *
 * 两道闸:找不到 → 报错;**等待审阅的不许钉** —— 恢复时快照直接落库、不再过审,
 * 所以进来的必须已经是可信的版本。
 */
export function pinWorkflowDefault(id: string): { ok: boolean; error?: string } {
  const doc = getWorkflow(id);
  if (doc === null) return { ok: false, error: "找不到这份工作流" };
  if (workflowReviewError(doc) !== null) {
    return { ok: false, error: "这一版还在等待审阅 —— 先在审阅里启用,再把它设为默认" };
  }
  const map = loadPinnedDefaults();
  map[id] = doc;
  SettingRepo.set(WORKFLOW_PINNED_DEFAULTS_KEY, JSON.stringify(map));
  return { ok: true };
}

/**
 * 「恢复默认」= 把钉住的快照写回表里(覆盖当前行)。没钉过就没有这个动作 ——
 * 界面只在 `WorkflowListEntry.pinned` 为真时画那颗按钮,这里的报错是防绕过 UI
 * 的调用方。快照钉的时候过过审阅闸、最初保存时过过存盘闸,这里直接落库不重跑校验。
 */
export function restoreWorkflowDefault(id: string): { ok: boolean; error?: string } {
  const pinned = loadPinnedDefaults()[id];
  if (pinned === undefined) {
    return { ok: false, error: "这份工作流没有钉过默认 —— 先「设为默认」,才谈得上恢复" };
  }
  WorkflowRepo.save({ ...pinned, builtin: false, updatedAt: Date.now() });
  return { ok: true };
}

/* ── 导入 / 导出(WF-08) ── */

/** 导入失败的形状。**整份拒绝** —— 过不了闸门的图不写库,库里一个字节都没变。 */
export type WorkflowImportOutcome =
  | { ok: true; id: string; name: string }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * 收下一份导出的 JSON 文本。
 *
 * ## 两道关,分别由两个已经存在的函数把守
 *
 * 1. **文本 → 文档**:`workflowValidation.importWorkflowDoc`(纯函数,JSON 解析 +
 *    契约形状 + schemaVersion + DAG 校验);
 * 2. **文档 → 库**:{@link saveWorkflow} —— **和用户点「保存」走的是同一道闸门**。
 *
 * 第 2 条是刻意复用的:导入能进来的东西,必须是当初存得下去的。另写一份校验就会出现
 * "导进来的图存不回去"这种自相矛盾,而且往往过一阵子才发现(用户后来点保存时才被拒)。
 *
 * ## 类型认不出来只是 warning
 *
 * 别人分享来的图引用了你没装的节点类型是常态 —— `saveWorkflow` 那一关的档位是
 * `unknownTypeSeverity: "warning"`,所以那种图照样收得下、画得出来,只是跑不了。
 *
 * ## id 与名字在这两层定下来
 *
 * 导入 JSON 自身必须带 `doc.id`(契约必填,从已有导出文件可以直接取得);
 * 调用参数 `opts.id` 决定是否覆盖,不是拿 JSON 的 id 覆盖本机数据:
 * - **不给 `opts.id`** → 新建:现生成一个 `wf_` id,名字重了自动加后缀。
 * - **给 `opts.id`** → 覆盖:那个 id **必须已经在库里**。给一个不存在的 id 会报错而不是
 *   悄悄新建一份 —— 界面上那条路叫「覆盖当前工作流」,id 拼错时静默造出一份新的,
 *   用户会以为他覆盖的是原来那一份。
 *
 * 名字的去重规则与界面上「新建」那颗按钮**共用** `uniqueWorkflowName`(它住在
 * `settings/workflows/workflowView.ts`,两边都 import 得到)。两处各写一份迟早会分家,
 * 而用户看到的都是"库里多了一行"。
 */
export async function importWorkflowInto(
  text: string,
  opts: { id?: string } = {},
): Promise<WorkflowImportOutcome> {
  // 导入的第一道闸也要用本机真实类型表:「自动化有没有触发器」和
  // `{{trigger.pdfPath}}` 是否可用都依赖清单。不给 types 时校验器无法认出
  // mcode.trigger,会把一张正确的事件自动化误判成「没有触发器」。
  // 缺失的第三方类型仍按分享语义给 warning,与 saveWorkflow 同一档。
  const types = new Map((await loadNodeTypes()).entries.map((entry) => [entry.id, entry.manifest]));
  const parsed = parseWorkflowText(text, { types, unknownTypeSeverity: "warning", locale: SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh" });
  if (!parsed.ok) {
    return { ok: false, errors: parsed.report.errors.map((e) => e.message), warnings: [] };
  }
  const doc = parsed.doc;

  const overwrite = opts.id !== undefined;
  const previous = overwrite ? getWorkflow(opts.id!) : null;
  if (overwrite && previous === null) {
    return {
      ok: false,
      errors: [`库里没有 id 为「${opts.id}」的工作流,覆盖不了不存在的一份`],
      warnings: [],
    };
  }

  const id = opts.id ?? makeWorkflowId();
  // 重名要绕开的是**别的行**,不含它自己 —— 覆盖时文件里那个名字正好和这一行现在
  // 叫的一样,那是常态,不该被改成「名字 2」。
  const others = listWorkflows()
    .filter((w) => w.id !== id)
    .map((w) => w.name);
  const name = uniqueWorkflowName(doc.name, others);

  const res = await saveWorkflow({ ...doc, id, name, builtin: false }, {
    untrustedOrigin: "import",
    expectedRevision: previous === null ? null : workflowSaveVersion(previous),
  });
  if (!res.ok) return { ok: false, errors: [res.error], warnings: [] };
  return { ok: true, id, name };
}
