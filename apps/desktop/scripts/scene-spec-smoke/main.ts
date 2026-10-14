/**
 * Headless smoke for **SceneSpec 声明 + 校验**(ARC-002 / MC-058 的第一片)。
 *
 * 纯契约、纯函数:只验「一份场景声明的形状」与「什么样的声明不合法」。**不碰执行** ——
 * 编译(ScenePlan)与部署是后续切片。
 *
 * ## 它钉死的判据
 *
 *  - 一份合法声明(代码巡检场景:workflow + automation 依赖它)通过,且解析出的 spec 保真;
 *  - **一次报全**:多类错误同时给,不是遇到第一个就停(否则模型要来回试很多轮);
 *  - 引用完整性:资源 id 重复、依赖不存在的 id、依赖成环、验收期望回读的资源不在 resources
 *    里 —— 各自被拒;
 *  - **纯数据**:解析出的 spec 里**没有**任何密钥/绝对路径字段(形状上就不存在这些字段)。
 *
 * Run: scripts/scene-spec-smoke/run.sh
 */
import {
  validateSceneSpec,
  SCENE_SPEC_SCHEMA_VERSION,
  type SceneSpec,
} from "@contracts/sceneSpec";
import { compileScenePlan, sceneSpecDigest } from "@contracts/scenePlan";
import {
  compileSceneCommands,
  serviceForKind,
  adaptScenePayload,
  sceneResourceIdentity,
  SCENE_KIND_SERVICE_MAP,
} from "@contracts/sceneCommands";
// 各 kind 的**真实** RPC 入参 schema —— 断言「投影后的入参真能过下游契约」(MC-058)。
import { WorkflowSaveSchema, HooksSaveSchema } from "@contracts/ipc/workflow";
import { SkillsSaveSchema } from "@contracts/ipc/skills";
import { McpSaveSchema } from "@contracts/ipc/mcp";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { EXAMPLE_MODULE } from "@contracts/modules";
import { sceneCapabilityPreflight } from "@contracts/scenePreflight";
import {
  projectInitToSceneSpec,
  sceneSpecToProjectInitDraft,
  sceneIdFromName,
} from "@contracts/sceneProjectInit";
import type { ProjectInitDraft } from "@contracts/ipc/projectInit";
import type { CapabilityDescriptor } from "@contracts/capability";
import { planScene } from "../../src/main/appServices/scenePlanning.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 一份合法的「代码巡检」场景:定时触发器依赖巡检工作流,验收要回读两者。 */
function goodSpec(): unknown {
  return {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId: "code-inspect-daily",
    goal: "每天检查代码、执行测试,失败后通知我",
    projectId: "prj_demo",
    preferredProviderId: "claude-sdk",
    capabilities: [
      { kind: "plugin", id: "research-pack", version: "1.2.0", required: true },
      { kind: "mcp", id: "coverage", required: false },
    ],
    resources: [
      { kind: "workflow", id: "wf_inspect", spec: { name: "代码巡检" } },
      { kind: "automation", id: "auto_daily", spec: { cron: "0 9 * * *" }, dependsOn: ["wf_inspect"] },
    ],
    acceptance: {
      description: "工作流与定时触发器都可见,且触发器能跑一次",
      expectResourceIds: ["wf_inspect", "auto_daily"],
    },
  };
}

/* ── 1. 合法声明通过,且保真 ── */
{
  const r = validateSceneSpec(goodSpec());
  check("★ 合法的代码巡检场景通过", r.ok, r.ok ? undefined : r.problems);
  if (r.ok) {
    const s: SceneSpec = r.spec;
    eq("schemaVersion 保留", s.schemaVersion, SCENE_SPEC_SCHEMA_VERSION);
    eq("sceneId 保留", s.sceneId, "code-inspect-daily");
    eq("两条资源都在", s.resources.length, 2);
    eq("automation 依赖 workflow 保留", s.resources[1].dependsOn?.[0], "wf_inspect");
    eq("可选能力 required=false 保留", s.capabilities[1].required, false);
    eq("验收期望回读列表保留", s.acceptance.expectResourceIds.join(","), "wf_inspect,auto_daily");
  }
}

/* ── 2. 一次报全:多类错误同时给 ── */
{
  const bad = {
    schemaVersion: 999,
    sceneId: "BAD ID!",
    goal: "  ",
    capabilities: [{ kind: "tool", id: "" }],
    resources: [
      { kind: "workflow", id: "dup", spec: {} },
      { kind: "workflow", id: "dup", spec: {} },
      { kind: "automation", id: "a1", spec: {}, dependsOn: ["ghost"] },
    ],
    acceptance: { description: "", expectResourceIds: ["not_a_resource"] },
  };
  const r = validateSceneSpec(bad);
  check("★ 非法声明被拒", !r.ok);
  if (!r.ok) {
    const paths = r.problems.map((p) => p.path);
    check("一次报全:同时报出 schemaVersion 与 sceneId", paths.includes("schemaVersion") && paths.includes("sceneId"), paths);
    check("报出 goal 空", paths.includes("goal"), paths);
    check("报出重复资源 id", r.problems.some((p) => p.message.includes("重复")), r.problems);
    check("报出依赖不存在的资源", r.problems.some((p) => p.message.includes("ghost")), r.problems);
    check("报出验收期望的回读资源不在 resources", r.problems.some((p) => p.message.includes("not_a_resource")), r.problems);
    check("问题总数 >= 6(不是只报第一个)", r.problems.length >= 6, r.problems.length);
  }
}

/* ── 3. 依赖成环被拒 ── */
{
  const cyc = {
    ...(goodSpec() as Record<string, unknown>),
    resources: [
      { kind: "workflow", id: "a", spec: {}, dependsOn: ["b"] },
      { kind: "workflow", id: "b", spec: {}, dependsOn: ["a"] },
    ],
    acceptance: { description: "x", expectResourceIds: ["a"] },
  };
  const r = validateSceneSpec(cyc);
  check("★ 依赖成环被拒", !r.ok, r.ok);
  if (!r.ok) check("报出环", r.problems.some((p) => p.message.includes("环")), r.problems);
  // 自环也拒。
  const self = {
    ...(goodSpec() as Record<string, unknown>),
    resources: [{ kind: "workflow", id: "a", spec: {}, dependsOn: ["a"] }],
    acceptance: { description: "x", expectResourceIds: ["a"] },
  };
  check("★ 自环被拒", !validateSceneSpec(self).ok);
}

/* ── 4. 纯数据:解析出的 spec 没有密钥/路径字段(形状上就不存在) ── */
{
  const r = validateSceneSpec(goodSpec());
  if (r.ok) {
    const keys = Object.keys(r.spec);
    check("spec 顶层没有 secret/apiKey/token 之类字段", !keys.some((k) => /secret|key|token|password/i.test(k)), keys);
    // 即使原始输入里塞了 secret 字段,也不会被透传(校验器只挑已知字段)。
    const smuggled = validateSceneSpec({ ...(goodSpec() as Record<string, unknown>), apiKey: "sk-live-should-not-pass", secret: "x" });
    check(
      "输入里偷塞的 apiKey/secret 不会被解析进 spec",
      smuggled.ok && !Object.prototype.hasOwnProperty.call(smuggled.spec, "apiKey") && !Object.prototype.hasOwnProperty.call(smuggled.spec, "secret"),
      smuggled.ok ? Object.keys(smuggled.spec) : smuggled.problems,
    );
  } else {
    check("合法声明通过(前提前置)", false);
  }
}

/* ── 5. 非对象输入不炸 ── */
{
  for (const v of [null, undefined, 42, "hello", []]) {
    const r = validateSceneSpec(v);
    check(`非对象输入被拒(不炸):${JSON.stringify(v)}`, !r.ok);
  }
}

/* ── 6. ScenePlan 编译器:拓扑排序 + 稳定 digest ── */
{
  const r = validateSceneSpec(goodSpec());
  check("编译前提前置:spec 合法", r.ok);
  if (r.ok) {
    const plan = compileScenePlan(r.spec);
    eq("计划步骤数 = 资源数", plan.steps.length, 2);
    // ★ 承重:automation 依赖 workflow,故 workflow 必须排在**前**(order 0)。
    eq("★ 依赖的 workflow 排在依赖它的 automation 之前", plan.steps[0].resourceId, "wf_inspect");
    eq("automation 是第二步", plan.steps[1].resourceId, "auto_daily");
    eq("order 从 0 起严格递增", plan.steps.map((s) => s.order).join(","), "0,1");
    eq("第二步记下它依赖第一步", plan.steps[1].dependsOn.join(","), "wf_inspect");
    // ★★ 承重(真能区分):把**依赖者写在前面**(automation 在前、它依赖的 workflow 在后),
    // 拓扑排序必须把顺序掉过来 —— 只按书写顺序排会漏判(实测:夹具若把 workflow 写在前面,
    // 「按书写顺序排」的变异不变红,属假绿)。
    const reversed = validateSceneSpec({
      ...(goodSpec() as Record<string, unknown>),
      resources: [
        { kind: "automation", id: "auto_daily", spec: {}, dependsOn: ["wf_inspect"] },
        { kind: "workflow", id: "wf_inspect", spec: {} },
      ],
      acceptance: { description: "x", expectResourceIds: ["auto_daily", "wf_inspect"] },
    });
    if (reversed.ok) {
      const rp = compileScenePlan(reversed.spec);
      eq("★ 依赖者写在前面时,拓扑排序把它移到被依赖者之后", rp.steps[0].resourceId, "wf_inspect");
      eq("automation 仍排最后", rp.steps[1].resourceId, "auto_daily");
    } else check("reversed 前置合法", false);
    check("每步都有回读判据(verifier)", plan.steps.every((s) => s.verifier.kind === "exists" && s.verifier.resourceId === s.resourceId), plan.steps);
    check("本地资源默认可补偿", plan.steps.every((s) => s.compensable === true), plan.steps);
    eq("计划带 specDigest", plan.specDigest, sceneSpecDigest(r.spec));

    // ★ 稳定 digest:同一 spec 重复编译 -> 同一个 plan.digest;改一处 -> 变。
    const again = compileScenePlan(validateSceneSpec(goodSpec()).ok ? (validateSceneSpec(goodSpec()) as { ok: true; spec: SceneSpec }).spec : r.spec);
    eq("★ 同一 spec 重复编译 -> 相同的 plan.digest", again.digest, plan.digest);
    const changed = validateSceneSpec({ ...(goodSpec() as Record<string, unknown>), goal: "改了目标" });
    check("改 spec 内容 -> specDigest 变", changed.ok && sceneSpecDigest(changed.spec) !== plan.specDigest);

    // ★ 键序不影响:把同一份 spec 的键顺序打乱(JSON 往返)仍是同一个 digest。
    const reordered = JSON.parse(JSON.stringify(goodSpec())) as Record<string, unknown>;
    const r2 = validateSceneSpec(reordered);
    check("★ spec 键序打乱 -> 同一个 specDigest(稳定)", r2.ok && sceneSpecDigest(r2.spec) === plan.specDigest);

    // compensable 显式 false:声明后该步不可补偿。
    const nonComp = validateSceneSpec({
      ...(goodSpec() as Record<string, unknown>),
      resources: [{ kind: "workflow", id: "wf", spec: { compensable: false } }],
      acceptance: { description: "x", expectResourceIds: ["wf"] },
    });
    if (nonComp.ok) {
      eq("spec.compensable===false -> 该步不可补偿", compileScenePlan(nonComp.spec).steps[0].compensable, false);
    } else check("nonComp 前置合法", false);

    // 同层(互不依赖)保持书写顺序。
    const sameLevel = validateSceneSpec({
      ...(goodSpec() as Record<string, unknown>),
      resources: [
        { kind: "workflow", id: "b", spec: {} },
        { kind: "workflow", id: "a", spec: {} },
        { kind: "workflow", id: "c", spec: {} },
      ],
      acceptance: { description: "x", expectResourceIds: ["a"] },
    });
    if (sameLevel.ok) {
      eq("同层资源保持书写顺序(不被重排)", compileScenePlan(sameLevel.spec).steps.map((s) => s.resourceId).join(","), "b,a,c");
    } else check("sameLevel 前置合法", false);
  }
}

/* ── 7. scene.plan 服务:校验 + 编译的真实入口(给纯函数接首个生产调用方) ── */
{
  // 合法 spec → ok + plan。
  const good = planScene({ spec: goodSpec() });
  check("★ scene.plan 合法声明 → ok", good.ok, good.ok ? undefined : good.problems);
  if (good.ok) {
    eq("scene.plan 计划步骤数 = 资源数", good.plan.steps.length, 2);
    eq("scene.plan 依赖的 workflow 在前", good.plan.steps[0].resourceId, "wf_inspect");
    check("scene.plan 带 planDigest", typeof good.plan.digest === "string" && good.plan.digest.length > 0);
  }
  // 非法 spec → problems 一次报全,不抛。
  const bad = planScene({ spec: { schemaVersion: 999, sceneId: "X", goal: "", capabilities: [], resources: [], acceptance: {} } });
  check("★ scene.plan 非法声明 → 不抛,返回 problems", !bad.ok);
  if (!bad.ok) check("scene.plan 一次报全(>=3 条)", bad.problems.length >= 3, bad.problems);
  // 非对象输入不炸。
  check("scene.plan 非对象输入 → problems 不炸", !planScene({ spec: 42 }).ok);
}

/* ── 8. 部署前的能力预检:声明的能力在本机在不在(ARC-002 / MC-058 点名缺口) ── */
{
  // 一份清单:有 research-pack 插件(带一个细粒度能力),没有别的。
  const inventory: CapabilityDescriptor[] = [
    { kind: "plugin", id: "research-pack", source: "plugin:research-pack", capabilities: ["hooks"] },
    { kind: "mcp", id: "coverage", source: "mcp:coverage" },
  ];

  // goodSpec 要 research-pack(必需,存在)+ coverage(可选,存在)→ 全就位。
  const good = validateSceneSpec(goodSpec());
  check("预检前提前置:spec 合法", good.ok);
  if (good.ok) {
    const r = sceneCapabilityPreflight(good.spec, inventory);
    eq("★ 能力全就位 → 预检通过", r.ok, true);
    eq("全就位 → 无缺口", r.gaps.length, 0);
    eq("预检条数 = 声明的能力数", r.checkedCapabilities, 2);

    // 缺一个**必需**能力 → 预检不通过(挡部署)。
    const missingRequired = sceneCapabilityPreflight(
      { ...good.spec, capabilities: [{ kind: "plugin", id: "ghost-pack" }, { kind: "mcp", id: "coverage", required: false }] },
      inventory,
    );
    eq("★ 缺必需能力 → 预检不通过", missingRequired.ok, false);
    eq("缺必需能力 → 进 requiredGaps", missingRequired.requiredGaps.length, 1);
    eq("缺的是 ghost-pack", missingRequired.requiredGaps[0].id, "ghost-pack");
    eq("缺口 reason = missing", missingRequired.requiredGaps[0].reason, "missing");

    // 缺一个**可选**能力 → 预检仍通过(gaps 有、requiredGaps 没有)。
    const missingOptional = sceneCapabilityPreflight(
      { ...good.spec, capabilities: [{ kind: "plugin", id: "research-pack" }, { kind: "mcp", id: "ghost", required: false }] },
      inventory,
    );
    eq("★ 缺可选能力 → 预检仍通过(不挡部署)", missingOptional.ok, true);
    eq("缺可选能力 → gaps 里有它", missingOptional.gaps.length, 1);
    eq("缺可选能力 → requiredGaps 为空", missingOptional.requiredGaps.length, 0);
    eq("gap.required = false", missingOptional.gaps[0].required, false);

    // incompatible:清单里有该插件,但要的细粒度能力它没有 → 不算 missing,算不适用。
    const incompat = sceneCapabilityPreflight(
      { ...good.spec, capabilities: [{ kind: "plugin", id: "research-pack", version: "1.2.0" }] },
      // 清单里换成没有 hooks 能力的同名插件 → 若声明要 hooks 才算 incompatible;
      // 这里声明没带 capabilities,故仍 available —— 用另一份声明验证细粒度。
      [{ kind: "plugin", id: "research-pack", source: "p", capabilities: [] }],
    );
    eq("清单有该插件(无细粒度要求)→ 就位", incompat.ok, true);

    // provider 适用性:带 providers 约束的能力,引擎不匹配 → 不适用(进缺口)。
    const scoped = sceneCapabilityPreflight(
      { ...good.spec, preferredProviderId: "codex", capabilities: [{ kind: "skill", id: "cov-skill" }] },
      [{ kind: "skill", id: "cov-skill", source: "skill", providers: ["claude-sdk"] }],
    );
    eq("★ 能力限定别的引擎 → 不适用(缺)", scoped.ok, false);
    eq("不适用 reason = incompatible", scoped.gaps[0].reason, "incompatible");

    // module 类声明映射到清单的 builtin 类。
    const moduleCheck = sceneCapabilityPreflight(
      { ...good.spec, capabilities: [{ kind: "module", id: "core.file.inspect" }] },
      [{ kind: "builtin", id: "core.file.inspect", source: "host" }],
    );
    eq("★ module 声明映射到清单 builtin 类(就位)", moduleCheck.ok, true);
  } else {
    check("预检前置:spec 合法", false);
  }
}

/* ── 9. ARC-010:项目初始化模板 → SceneSpec(可编译的脚手架资源)+ 逆投影(纯脚手架才成功) ── */
{
  /** 一份纯脚手架模板:目录有嵌套(父目录要排在文件前)、文件、记忆、AI 生成说明文件。 */
  const draft: ProjectInitDraft = {
    name: "survey-project",
    description: "调查项目骨架",
    directories: ["data/raw", "notes"],
    files: [
      { path: "notes/README.md", content: "# notes" },
      { path: "data/raw/.gitkeep", content: "" },
    ],
    memories: [
      { category: "project", filename: "overview.md", title: "概览", content: "内容", pinned: true },
    ],
    agentFile: { enabled: true, filename: "AGENTS.md", focus: "研究项目" },
  };

  // ★ 承重:模板 → SceneSpec,每条条目成一条 scaffold 资源,且能过校验。
  const r = projectInitToSceneSpec(draft);
  check("★ 模板 → SceneSpec 成功", r.ok, r.ok ? undefined : r.problems);
  if (r.ok) {
    const spec = r.spec;
    eq("资源数 = 目录2 + 文件2 + 记忆1 + 说明文件1", spec.resources.length, 6);
    check("全部资源都是 scaffold 类", spec.resources.every((x) => x.kind === "scaffold"), spec.resources.map((x) => x.kind));
    eq("sceneId 由名字 slug", spec.sceneId, "survey-project");
    check("id 形如 dir:/file:/memory:/agentFile", spec.resources.map((x) => x.id).join(",")
      === "dir:data/raw,dir:notes,file:notes/README.md,file:data/raw/.gitkeep,memory:project/overview.md,agentFile",
      spec.resources.map((x) => x.id));
    // 文件对**显式声明过的**祖先目录记依赖(notes/README.md → notes)。
    eq("文件依赖显式祖先目录", spec.resources[2].dependsOn?.join(","), "dir:notes");
    eq("未声明父目录不凭空造依赖(data 未声明 → dir:data/raw 无依赖)", (spec.resources[0].dependsOn ?? []).length, 0);
    eq("嵌套文件依赖它显式声明的祖先(data/raw/.gitkeep → dir:data/raw)", spec.resources[3].dependsOn?.join(","), "dir:data/raw");
    eq("记忆 spec.entry = memory", spec.resources[4].spec.entry, "memory");
    eq("说明文件 spec.entry = agentFile", spec.resources[5].spec.entry, "agentFile");

    // 校验一次报全地通过,且能编译成计划。
    const v = validateSceneSpec(spec);
    check("★ 投影出的 SceneSpec 通过 validateSceneSpec", v.ok, v.ok ? undefined : v.problems);
    if (v.ok) {
      const plan = compileScenePlan(v.spec);
      eq("计划步骤数 = 资源数", plan.steps.length, 6);
      check("★ 父目录排在用它做路径的文件之前", plan.steps.findIndex((s) => s.resourceId === "dir:notes") < plan.steps.findIndex((s) => s.resourceId === "file:notes/README.md"), plan.steps.map((s) => s.resourceId));
      eq("验收期望回读全部资源", v.spec.acceptance.expectResourceIds.length, 6);
    }

    // ★ 确定性:同一模板投影两次 → 逐字节相同的 specDigest(重复部署幂等)。
    const again = projectInitToSceneSpec(draft);
    check("★ 同一模板两次投影 → 同一 sceneSpecDigest", again.ok && sceneSpecDigest(again.spec) === sceneSpecDigest(spec));

    // 启用=false 的说明文件不产出任何资源(没有语义可丢)。
    const noAgent = projectInitToSceneSpec({ ...draft, agentFile: { enabled: false, filename: "AGENTS.md", focus: "" } });
    check("关闭的说明文件不翻成资源", noAgent.ok && noAgent.spec.resources.every((x) => x.spec.entry !== "agentFile"), noAgent.ok ? noAgent.spec.resources.map((x) => x.spec.entry) : noAgent.problems);
  } else {
    check("模板 → SceneSpec 前置成功", false);
  }

  // sceneId 推不出的名字(全非 ASCII)不硬造 —— 报问题。
  const noId = projectInitToSceneSpec({ name: "研究", description: "", directories: ["notes"], files: [], memories: [] });
  check("★ 名字推不出 sceneId → 报问题(不硬造)", !noId.ok, noId.ok);
  if (!noId.ok) check("报的是 sceneId 问题", noId.problems.some((p) => p.path === "sceneId"), noId.problems);
  // 显式给合法 sceneId 则通过。
  const withId = projectInitToSceneSpec({ name: "研究", description: "", directories: ["notes"], files: [], memories: [] }, { sceneId: "research" });
  check("显式 sceneId 覆盖 → 通过", withId.ok && withId.spec.sceneId === "research", withId.ok ? undefined : withId.problems);
  // 模板本身不合法(空模板)→ 报问题,不产出假 spec。
  const empty = projectInitToSceneSpec({ name: "x", description: "", directories: [], files: [], memories: [] });
  check("★ 空模板(无可建条目)被拒", !empty.ok, empty.ok);

  /* ── 逆投影:纯脚手架才成功,且逐类不可还原的东西都报出来 ── */

  // ★ 承重:往返 —— ASCII 名的模板 → spec → draft,关键字段保真。
  const rt = projectInitToSceneSpec({ ...draft, description: "调查项目骨架" });
  if (rt.ok) {
    const back = sceneSpecToProjectInitDraft(rt.spec);
    check("★ 纯脚手架 spec → draft 成功", back.ok, back.ok ? undefined : back.problems);
    if (back.ok) {
      eq("目录保真", back.draft.directories.join(","), "data/raw,notes");
      eq("文件路径保真", back.draft.files.map((f) => f.path).join(","), "notes/README.md,data/raw/.gitkeep");
      eq("记忆保真", back.draft.memories[0].category + "/" + back.draft.memories[0].filename, "project/overview.md");
      eq("说明文件保真", back.draft.agentFile?.filename, "AGENTS.md");
      eq("description 取 goal", back.draft.description, "调查项目骨架");
      eq("name 往返经 sceneId(ASCII 名保真)", back.draft.name, "survey-project");
    }
  } else check("往返前置成功", false);

  // 非脚手架资源 → 报出来(不静默丢)。
  const withWorkflow = projectInitToSceneSpec({ name: "p", description: "", directories: ["a"], files: [], memories: [] });
  if (withWorkflow.ok) {
    const mixed = { ...withWorkflow.spec, resources: [...withWorkflow.spec.resources, { kind: "workflow" as const, id: "wf", spec: {} }], acceptance: { description: "x", expectResourceIds: [...withWorkflow.spec.acceptance.expectResourceIds, "wf"] } };
    const back = sceneSpecToProjectInitDraft(mixed);
    check("★ 含 workflow 资源 → 逆投影被拒", !back.ok, back.ok);
    if (!back.ok) check("报出非 scaffold 资源", back.problems.some((p) => p.message.includes("workflow")), back.problems);
  }
  // 能力声明 / projectId / 引擎偏好 / lock 杂项 → 各自被点名。
  if (withWorkflow.ok) {
    const withCaps = { ...withWorkflow.spec, capabilities: [{ kind: "plugin" as const, id: "x" }] };
    const b1 = sceneSpecToProjectInitDraft(withCaps);
    check("★ capabilities 非空 → 逆投影被拒并点名", !b1.ok && b1.problems.some((p) => p.path === "capabilities"), b1.ok ? b1 : b1.problems);
    const b2 = sceneSpecToProjectInitDraft({ ...withWorkflow.spec, projectId: "p1" });
    check("★ projectId 非空 → 逆投影被拒并点名", !b2.ok && b2.problems.some((p) => p.path === "projectId"), b2.ok ? b2 : b2.problems);
    const b3 = sceneSpecToProjectInitDraft({ ...withWorkflow.spec, lock: { a: "1" } });
    check("★ lock 非空 → 逆投影被拒并点名", !b3.ok && b3.problems.some((p) => p.path === "lock"), b3.ok ? b3 : b3.problems);
  }
  // 脚手架条目多出无法还原的字段 → 报出来。
  const smuggled = validateSceneSpec({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION, sceneId: "p", goal: "g",
    capabilities: [], resources: [{ kind: "scaffold", id: "dir:a", spec: { entry: "directory", path: "a", chmod: "755" } }],
    acceptance: { description: "x", expectResourceIds: ["dir:a"] },
  });
  check("scaffold 夹带额外字段的前置合法", smuggled.ok);
  if (smuggled.ok) {
    const back = sceneSpecToProjectInitDraft(smuggled.spec);
    check("★ 脚手架夹带额外字段 → 逆投影被拒", !back.ok, back.ok);
    if (!back.ok) check("报出额外字段 chmod", back.problems.some((p) => p.message.includes("chmod")), back.problems);
  }
  // 未知 entry 类型 → 报出来。
  const badEntry = validateSceneSpec({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION, sceneId: "p", goal: "g",
    capabilities: [], resources: [{ kind: "scaffold", id: "x", spec: { entry: "symlink", path: "a" } }],
    acceptance: { description: "x", expectResourceIds: ["x"] },
  });
  if (badEntry.ok) {
    const back = sceneSpecToProjectInitDraft(badEntry.spec);
    check("★ 未知 entry 类型 → 逆投影被拒", !back.ok, back.ok);
  }
  // 逆投影出的 draft 若含非法路径(.git)会被 ProjectInitDraftSchema 挡回(路径守卫仍然生效)。
  const dotGit = validateSceneSpec({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION, sceneId: "p", goal: "g",
    capabilities: [], resources: [{ kind: "scaffold", id: "dir:.git", spec: { entry: "directory", path: ".git" } }],
    acceptance: { description: "x", expectResourceIds: ["dir:.git"] },
  });
  if (dotGit.ok) {
    const back = sceneSpecToProjectInitDraft(dotGit.spec);
    check("★ 逆投影仍受 safeInitPath 守卫(.git 路径被拒)", !back.ok, back.ok);
  }
  // sceneIdFromName 直接判据。
  eq("sceneIdFromName 折叠非法字符", sceneIdFromName("My Project!!"), "my-project");
  eq("sceneIdFromName 全非 ASCII 得空", sceneIdFromName("研究"), "");
}

/* ── 10. SceneCompiler:把 ScenePlan 翻成对现有服务的命令(纯描述符,不执行)(ARC-002 / MC-058) ── */
{
  // 一份覆盖**全部 9 种 kind** 的声明;automation 写在它的依赖 wf 前面,强制拓扑排序重排。
  const eachKind = (): unknown => ({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId: "all-kinds",
    goal: "每种资源各建一个",
    capabilities: [],
    resources: [
      { kind: "automation", id: "auto", spec: { cron: "0 9 * * *" }, dependsOn: ["wf"] },
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "skill", id: "sk", spec: { name: "coverage", content: "x" } },
      { kind: "plugin", id: "pl", spec: { source: "marketplace", name: "research-pack" } },
      { kind: "mcp", id: "mc", spec: { name: "coverage", config: { url: "http://x" } } },
      { kind: "hook", id: "hk", spec: { event: "post-save", command: "echo" } },
      { kind: "module", id: "md", spec: { manifest: { id: "core.file.inspect" } } },
      { kind: "panel", id: "pn", spec: { html: "<div>面板</div>" } },
      { kind: "scaffold", id: "sc", spec: { entry: "directory", path: "data" } },
    ],
    acceptance: {
      description: "每种资源各回读一次",
      expectResourceIds: ["auto", "wf", "sk", "pl", "mc", "hk", "md", "pn", "sc"],
    },
  });

  const v = validateSceneSpec(eachKind());
  check("编译命令前提前置:9 种 kind 声明合法", v.ok, v.ok ? undefined : v.problems);
  if (v.ok) {
    const spec: SceneSpec = v.spec;
    const plan = compileScenePlan(spec);
    const compiled = compileSceneCommands(plan, spec);

    // ★ 承重:每种 kind 各产出一条命令(9 种 = 9 条,一条不落)。
    eq("★ 9 种 kind 各产出一条命令", compiled.commands.length, 9);
    const kinds = new Set(compiled.commands.map((c) => c.kind));
    check(
      "★ 每种资源 kind 都被发射(workflow/automation/skill/plugin/mcp/hook/module/panel/scaffold)",
      ["workflow", "automation", "skill", "plugin", "mcp", "hook", "module", "panel", "scaffold"].every((k) => kinds.has(k as never)),
      [...kinds],
    );

    // ★ 顺序取自计划(automation 写在前面,但计划按拓扑重排 → 命令也这样)。
    eq("★ 命令顺序 = 计划顺序", compiled.commands.map((c) => c.actionId).join(","), plan.steps.map((s) => s.actionId).join(","));
    eq("★ 依赖的 wf 命令排第一", compiled.commands[0].actionId, "wf");
    eq("命令 order 从 0 起严格递增", compiled.commands.map((c) => c.order).join(","), "0,1,2,3,4,5,6,7,8");
    // 依赖者(dependsOn 非空)必定排在被依赖者之后 —— 按 actionId 查,不靠下标。
    const autoCmd = compiled.commands.find((c) => c.actionId === "auto")!;
    const wfCmd = compiled.commands.find((c) => c.actionId === "wf")!;
    check("★ 依赖 auto 的 wf 排在它之前", wfCmd.order < autoCmd.order, { wf: wfCmd.order, auto: autoCmd.order });
    eq("命令保留依赖信息", autoCmd.dependsOn.join(","), "wf");

    // ★ 载荷逐字:每条命令的 payload 就是 spec 里那条资源的 spec(键完全一致)。
    const resourceById = new Map(spec.resources.map((r) => [r.id, r] as const));
    check(
      "★ 每条命令的 payload 逐字等于该资源的 spec",
      compiled.commands.every((c) => JSON.stringify(c.payload) === JSON.stringify(resourceById.get(c.resourceId)!.spec)),
      compiled.commands.map((c) => ({ id: c.actionId, p: c.payload, s: resourceById.get(c.resourceId)?.spec })),
    );
    eq("automation 命令带原 cron 载荷", autoCmd.payload.cron, "0 9 * * *");
    eq("scaffold 命令带原 entry 载荷", compiled.commands.find((c) => c.kind === "scaffold")!.payload.entry, "directory");

    // ★ 服务映射是**声明**:确定的 kind 给确定标签,不确定的显式 needsResolution。
    eq("workflow → workflow.save", SCENE_KIND_SERVICE_MAP.workflow.serviceLabel, "workflow.save");
    eq("automation → workflow.save(自动化是带 trigger 的工作流)", SCENE_KIND_SERVICE_MAP.automation.serviceLabel, "workflow.save");
    eq("skill → skills.save", SCENE_KIND_SERVICE_MAP.skill.serviceLabel, "skills.save");
    eq("mcp → mcp.save", SCENE_KIND_SERVICE_MAP.mcp.serviceLabel, "mcp.save");
    eq("hook → hooks.save", SCENE_KIND_SERVICE_MAP.hook.serviceLabel, "hooks.save");
    eq("module → modules.install", SCENE_KIND_SERVICE_MAP.module.serviceLabel, "modules.install");
    // ★ 无法把**单条命令**稳妥派到单一入口的 kind:needsResolution 显式置真(不猜)。
    //   plugin 连服务都无单一入口(installLocal/Git/Marketplace)→ label 为 null;
    //   panel / scaffold 有归属服务,但入口吃整份配置 / 整份模板,也要决议。
    check("★ plugin 无单一入口 → needsResolution 且无标签", SCENE_KIND_SERVICE_MAP.plugin.needsResolution && SCENE_KIND_SERVICE_MAP.plugin.serviceLabel === null, SCENE_KIND_SERVICE_MAP.plugin);
    check("★ panel 需并入整份配置 → needsResolution(标签指向归属服务 setting.set)", SCENE_KIND_SERVICE_MAP.panel.needsResolution && SCENE_KIND_SERVICE_MAP.panel.serviceLabel === "setting.set", SCENE_KIND_SERVICE_MAP.panel);
    check("★ scaffold 需先归模板再提交 → needsResolution(标签指向归属服务 projectInit.apply)", SCENE_KIND_SERVICE_MAP.scaffold.needsResolution && SCENE_KIND_SERVICE_MAP.scaffold.serviceLabel === "projectInit.apply", SCENE_KIND_SERVICE_MAP.scaffold);
    check("非决议 kind 一律 needsResolution=false(workflow/skill/mcp/hook/module)", [SCENE_KIND_SERVICE_MAP.workflow, SCENE_KIND_SERVICE_MAP.automation, SCENE_KIND_SERVICE_MAP.skill, SCENE_KIND_SERVICE_MAP.mcp, SCENE_KIND_SERVICE_MAP.hook, SCENE_KIND_SERVICE_MAP.module].every((e) => !e.needsResolution));
    eq("需决议的 3 类进入 unresolved", compiled.unresolved.length, 3);
    check("unresolved 指名 plugin/panel/scaffold 三条命令", compiled.unresolved.every((id) => compiled.commands.some((c) => c.commandId === id && c.service.needsResolution)), compiled.unresolved);
    check("每条命令都带 commandId(部署绑定用)", compiled.commands.every((c) => typeof c.commandId === "string" && c.commandId.length > 0), compiled.commands.map((c) => c.commandId));

    // ★ 稳定:同一 plan + 同一 spec 重复编译 → 逐字节相同的 digest 与每条 commandId。
    const again = compileSceneCommands(compileScenePlan(v.spec), v.spec);
    eq("★ 重复编译 → 相同的命令集 digest", again.digest, compiled.digest);
    check("★ 重复编译 → 每条 commandId 相同", again.commands.map((c) => c.commandId).join(",") === compiled.commands.map((c) => c.commandId).join(","), again.commands.map((c) => c.commandId));
    eq("命令集带 planDigest", compiled.planDigest, plan.digest);

    // ★ 不静默丢:绕开校验塞进一个枚举外的 kind,仍产出一条带 needsResolution 的命令。
    const bogusSpec = {
      schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
      sceneId: "bogus-kind",
      goal: "g",
      capabilities: [],
      resources: [{ kind: "teleporter", id: "tp", spec: { beam: "up" } }],
      acceptance: { description: "x", expectResourceIds: ["tp"] },
    } as unknown as SceneSpec;
    const bogusPlan = compileScenePlan(bogusSpec);
    const bogusCmd = compileSceneCommands(bogusPlan, bogusSpec);
    eq("★ 未知 kind 不静默丢:仍产出一条命令", bogusCmd.commands.length, 1);
    check("★ 未知 kind → needsResolution 且无服务标签", bogusCmd.commands[0].service.needsResolution && bogusCmd.commands[0].service.serviceLabel === null, bogusCmd.commands[0].service);
    eq("未知 kind 进 unresolved", bogusCmd.unresolved.length, 1);
    eq("serviceForKind(枚举外) 显式报无法映射", serviceForKind("teleporter").needsResolution, true);
    eq("serviceForKind(workflow) 给确定标签", serviceForKind("workflow").serviceLabel, "workflow.save");

    // ★★ MC-058 残余②③:每个 kind 的**服务侧稳定身份**在声明正文里的点分路径(identityPath),
    //    以及 `sceneResourceIdentity` 从声明正文取值的行为。判据逐个对照各服务**真实返回形状**
    //    (workflow.get→WorkflowDoc.id、skills.list→SkillInfo.name、mcp.list→McpServerEntry.name、
    //    hooks.list→HookSpec.id、modules.catalog→ModuleManifest.id)。
    //    拿场景内 id 去查一个按服务身份索引的列表会永远匹配不上 —— 故身份必须逐 kind 显式钉死。
    eq("workflow 身份 = doc.id", SCENE_KIND_SERVICE_MAP.workflow.identityPath, "id");
    eq("automation 身份 = doc.id(自动化即工作流)", SCENE_KIND_SERVICE_MAP.automation.identityPath, "id");
    eq("skill 身份 = name(skills.list 的 SkillInfo.name)", SCENE_KIND_SERVICE_MAP.skill.identityPath, "name");
    eq("mcp 身份 = name(mcp.list 的 McpServerEntry.name)", SCENE_KIND_SERVICE_MAP.mcp.identityPath, "name");
    eq("hook 身份 = id(HookSpec.id)", SCENE_KIND_SERVICE_MAP.hook.identityPath, "id");
    eq("module 身份 = manifest.id(ModuleManifest.id)", SCENE_KIND_SERVICE_MAP.module.identityPath, "manifest.id");
    // ★ 无稳定身份的 kind:identityPath 显式为 null(绝不编一个永远匹配不上的字段)。
    check("★ plugin 无稳定身份(插件名来自 manifest,声明时未知)→ identityPath=null", SCENE_KIND_SERVICE_MAP.plugin.identityPath === null, SCENE_KIND_SERVICE_MAP.plugin.identityPath);
    check("★ panel 无稳定身份(落整块配置)→ identityPath=null", SCENE_KIND_SERVICE_MAP.panel.identityPath === null, SCENE_KIND_SERVICE_MAP.panel.identityPath);
    check("★ scaffold 无稳定身份(整份模板落盘)→ identityPath=null", SCENE_KIND_SERVICE_MAP.scaffold.identityPath === null, SCENE_KIND_SERVICE_MAP.scaffold.identityPath);
    // `sceneResourceIdentity` 逐 kind 从声明正文取服务身份(点分路径;非空字符串才算)。
    eq("sceneResourceIdentity(workflow) 取 spec.id", sceneResourceIdentity("workflow", { id: "wf1", name: "x" }), "wf1");
    eq("sceneResourceIdentity(skill) 取 spec.name(不是 spec.id)", sceneResourceIdentity("skill", { name: "coverage", source: "global" }), "coverage");
    eq("sceneResourceIdentity(mcp) 取 spec.name", sceneResourceIdentity("mcp", { name: "srv" }), "srv");
    eq("sceneResourceIdentity(hook) 取 spec.id", sceneResourceIdentity("hook", { id: "h_1" }), "h_1");
    eq("sceneResourceIdentity(module) 走点分路径 spec.manifest.id", sceneResourceIdentity("module", { manifest: { id: "user.x" }, confirmReadAccess: true }), "user.x");
    // ★ 取不到时**返回 null**(绝不退化成拿别的字段冒充、也不用场景 id 顶替)。
    eq("★ 声明缺身份字段 → null(不冒充)", sceneResourceIdentity("workflow", { name: "只有名字没有 id" }), null);
    check("★ 无稳定身份的 kind → 恒 null(plugin)", sceneResourceIdentity("plugin", { source: "local" }) === null);
    eq("★ module 声明缺 manifest 里的 id → null", sceneResourceIdentity("module", { manifest: {} }), null);
    eq("★ 空串不算身份 → null", sceneResourceIdentity("skill", { name: "" }), null);

    // 计划与 spec 不匹配(不同版本)→ 显式抛错,不产出缺斤少两的命令集。
    let threw = false;
    try {
      const otherSpec = validateSceneSpec({ ...(eachKind() as Record<string, unknown>), goal: "改了目标" });
      if (otherSpec.ok) compileSceneCommands(plan, otherSpec.spec);
    } catch { threw = true; }
    check("★ 计划与 spec 的 specDigest 不一致 → 抛错(不静默)", threw);
  } else {
    check("每种 kind 声明前置合法", false);
  }
}

/* ── 11. 载荷适配:命令携带的 RPC 入参真能过**真实** schema(MC-058 缺陷) ── */
{
  // ★ 承重(MC-058):这五类过去把声明正文**逐字**当 RPC 载荷,实测被真实 handler 的 Schema.parse
  //   全数拒绝。适配器 `adaptScenePayload` 把它投影成真实入参 —— 这里逐类拿**生产 schema** 验。
  const schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {
    workflow: WorkflowSaveSchema as never,
    hook: HooksSaveSchema as never,
    skill: SkillsSaveSchema as never,
    mcp: McpSaveSchema as never,
    module: ModuleInstallSchema as never,
  };

  // ① workflow:声明正文 = WorkflowDoc(含 id/name/nodes/edges/builtin/updatedAt);投影后包一层 `workflow`。
  {
    const doc = { id: "wf1", name: "巡检", nodes: [], edges: [], builtin: false, updatedAt: 1 };
    const a = adaptScenePayload("workflow", doc);
    check("★ workflow 声明 → 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) {
      check("★ workflow 投影后的入参过 WorkflowSaveSchema", WorkflowSaveSchema.safeParse(a.input).success, a.input);
      check("投影出 { workflow } 包一层(不是裸 doc)", typeof a.input.workflow === "object" && a.input.workflow !== null, a.input);
      eq("workflow.id 保真", (a.input.workflow as Record<string, unknown>).id, "wf1");
    }
    // ★ 承重:把**裸声明**当入参喂真实 schema 必被拒(证明这层不是多余) —— 复现台账那条负例。
    check("★ 裸声明 {name} 直接喂 WorkflowSaveSchema 被拒(复现缺陷)", !WorkflowSaveSchema.safeParse({ name: "巡检" }).success);
  }

  // ② automation:声明正文 = 带 trigger 的 WorkflowDoc,同一入口同一形状。
  {
    const doc = { id: "auto1", name: "每日", trigger: "schedule", nodes: [], edges: [], builtin: false, updatedAt: 1 };
    const a = adaptScenePayload("automation", doc);
    check("automation 声明 → 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) check("automation 投影后的入参过 WorkflowSaveSchema", WorkflowSaveSchema.safeParse(a.input).success, a.input);
  }

  // ③ workflow expectedRevision:给了要透传,没给不必造(schema 视 null)。
  {
    const withRev = adaptScenePayload("workflow", { id: "wf", name: "x", nodes: [], edges: [], builtin: false, updatedAt: 1, expectedRevision: "a".repeat(64) });
    check("expectedRevision 合法哈希 → 通过", withRev.ok, withRev.ok ? undefined : withRev.problems);
    if (withRev.ok) eq("expectedRevision 透传", withRev.input.expectedRevision, "a".repeat(64));
    // 非法 expectedRevision(不是 64 hex)→ 明确问题,不静默。
    const badRev = adaptScenePayload("workflow", { id: "wf", name: "x", nodes: [], edges: [], builtin: false, updatedAt: 1, expectedRevision: "short" });
    check("★ 非法 expectedRevision → 明确问题(不静默)", !badRev.ok, badRev.ok ? badRev.input : badRev.problems);
  }

  // ④ hook:声明正文 = HookSpec;投影出 { hook }。
  {
    const hook = { id: "hk1", name: "保存后", event: "turn.done", command: "echo hi", enabled: true };
    const a = adaptScenePayload("hook", hook);
    check("hook 声明 → 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) {
      check("hook 投影后的入参过 HooksSaveSchema", HooksSaveSchema.safeParse(a.input).success, a.input);
      check("投影出 { hook } 包一层", typeof a.input.hook === "object" && a.input.hook !== null, a.input);
    }
    check("★ 裸 hook {id} 直接喂 HooksSaveSchema 被拒(缺 hook 包装)", !HooksSaveSchema.safeParse({ id: "hk1" }).success);
  }

  // ⑤ skill:声明正文 = SkillsSave 入参(source/name/content)。
  {
    const a = adaptScenePayload("skill", { source: "global", name: "coverage", content: "---\nname: coverage\n---\n" });
    check("skill 声明 → 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) check("skill 投影后的入参过 SkillsSaveSchema", SkillsSaveSchema.safeParse(a.input).success, a.input);
    // ★ 承重:缺 `source` → 明确问题(SCENE_KIND_SERVICE_MAP 说 skills.save 要 SkillsSaveInput)。
    const missingSource = adaptScenePayload("skill", { name: "coverage", content: "x" });
    check("★ skill 缺 source → 明确问题(不产半成品)", !missingSource.ok && missingSource.problems.some((p) => p.path.includes("source")), missingSource.ok ? missingSource.input : missingSource.problems);
  }

  // ⑥ mcp:声明正文 = McpSave 入参(name + config)。
  {
    const a = adaptScenePayload("mcp", { name: "coverage", config: { type: "http", url: "https://x/mcp" } });
    check("mcp 声明 → 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) check("mcp 投影后的入参过 McpSaveSchema", McpSaveSchema.safeParse(a.input).success, a.input);
    // ★ 仅给 name(无 config)→ 明确问题。
    const noConfig = adaptScenePayload("mcp", { name: "coverage" });
    check("★ mcp 缺 config → 明确问题", !noConfig.ok && noConfig.problems.some((p) => p.path.includes("config")), noConfig.ok ? noConfig.input : noConfig.problems);
    // 非法服务器名(带路径分隔符)→ 明确问题。
    const badName = adaptScenePayload("mcp", { name: "../evil", config: { type: "http", url: "https://x" } });
    check("★ mcp 非法服务器名 → 明确问题", !badName.ok, badName.ok ? badName.input : badName.problems);
  }

  // ⑦ module:声明正文 = { manifest, confirmReadAccess:true };须显式给确认。
  {
    const a = adaptScenePayload("module", { manifest: EXAMPLE_MODULE, confirmReadAccess: true });
    check("module 声明(带 confirmReadAccess)→ 投影成功", a.ok, a.ok ? undefined : a.problems);
    if (a.ok) check("module 投影后的入参过 ModuleInstallSchema", ModuleInstallSchema.safeParse(a.input).success, a.input);
    // ★ confirmReadAccess 缺 → 明确问题(**绝不**自动置真:那是冒充用户已批准读取权限)。
    const noConfirm = adaptScenePayload("module", { manifest: EXAMPLE_MODULE });
    check("★ module 缺 confirmReadAccess → 明确问题(不替用户确认)", !noConfirm.ok, noConfirm.ok ? noConfirm.input : noConfirm.problems);
    // manifest 形状不全(只给 id)→ 明确问题。
    const badManifest = adaptScenePayload("module", { manifest: { id: "core.file.inspect" }, confirmReadAccess: true });
    check("★ module manifest 形状不全 → 明确问题", !badManifest.ok, badManifest.ok ? badManifest.input : badManifest.problems);
  }

  // ⑧ 需先决议的 kind → 明确问题(不猜）。
  for (const k of ["plugin", "panel", "scaffold"] as const) {
    const a = adaptScenePayload(k, { any: "thing" });
    check(`★ ${k} 无单条确定性入参 → 明确问题(不投影)`, !a.ok && a.problems.length > 0, a.ok ? a.input : a.problems);
  }
  // ⑨ 未知 kind(绕过校验)→ 明确问题,不抛。
  {
    const a = adaptScenePayload("teleporter" as never, { beam: "up" });
    check("★ 未知 kind → 明确问题(不抛)", !a.ok && a.problems.length > 0, a.ok ? a.input : a.problems);
  }

  // ⑩ 端到端:compileSceneCommands 产出的命令携带的 rpcInput 真能过真实 schema。
  //    一份**填了真实必需字段**的声明(workflow/skill/mcp/hook/module 五类)。
  {
    const good = validateSceneSpec({
      schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
      sceneId: "real-payload",
      goal: "五类真实载荷",
      capabilities: [],
      resources: [
        { kind: "workflow", id: "wf", spec: { id: "wf", name: "巡检", nodes: [], edges: [], builtin: false, updatedAt: 1 } },
        { kind: "skill", id: "sk", spec: { source: "global", name: "coverage", content: "---\nname: coverage\n---\n" } },
        { kind: "mcp", id: "mc", spec: { name: "coverage", config: { type: "http", url: "https://x/mcp" } } },
        { kind: "hook", id: "hk", spec: { id: "hk", name: "保存后", event: "turn.done", command: "echo", enabled: true } },
        { kind: "module", id: "md", spec: { manifest: EXAMPLE_MODULE, confirmReadAccess: true } },
      ],
      acceptance: { description: "五类各回读一次", expectResourceIds: ["wf", "sk", "mc", "hk", "md"] },
    });
    check("真实载荷声明合法", good.ok, good.ok ? undefined : good.problems);
    if (good.ok) {
      const compiled = compileSceneCommands(compileScenePlan(good.spec), good.spec);
      eq("五类各产出一条命令", compiled.commands.length, 5);
      // ★★ 承重:每条命令都带非空 rpcInput,且**过它那个 kind 的真实 schema**(与 §11 的 schemas 同源)。
      for (const c of compiled.commands) {
        check(`★${c.kind} 命令带非空 rpcInput`, c.rpcInput !== null, c);
        if (c.rpcInput !== null && schemas[c.kind]) {
          check(`★${c.kind} 命令的 rpcInput 过真实 schema(${c.service.serviceLabel})`, schemas[c.kind].safeParse(c.rpcInput).success, { input: c.rpcInput, kind: c.kind });
        }
        eq(`${c.kind} 命令无投影问题`, c.payloadProblems.length, 0);
        // payload 仍是**逐字声明**(记账/digest 的真相),与 rpcInput 分开。
        check(`${c.kind} payload 仍是原声明正文`, JSON.stringify(c.payload) === JSON.stringify(good.spec.resources.find((r) => r.id === c.resourceId)!.spec), c.payload);
      }
    }
  }

  // ⑪ 端到端:声明**缺必需字段**时命令明确带 payloadProblems、rpcInput 为 null(不静默产半成品)。
  {
    const bad = validateSceneSpec({
      schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
      sceneId: "bad-payload",
      goal: "缺字段",
      capabilities: [],
      resources: [
        // workflow 只给 name(缺 workflow doc 必需字段)。
        { kind: "workflow", id: "wf", spec: { name: "只有名字" } },
        // skill 缺 source。
        { kind: "skill", id: "sk", spec: { name: "coverage", content: "x" } },
      ],
      acceptance: { description: "x", expectResourceIds: ["wf", "sk"] },
    });
    check("缺字段声明在 SceneSpec 层仍合法(形状自洽)", bad.ok, bad.ok ? undefined : bad.problems);
    if (bad.ok) {
      const compiled = compileSceneCommands(compileScenePlan(bad.spec), bad.spec);
      const wf = compiled.commands.find((c) => c.kind === "workflow")!;
      const sk = compiled.commands.find((c) => c.kind === "skill")!;
      eq("★ workflow 缺必需字段 → rpcInput 为 null", wf.rpcInput, null);
      check("★ workflow 缺必需字段 → 带明确 payloadProblems", wf.payloadProblems.length > 0, wf.payloadProblems);
      eq("★ skill 缺 source → rpcInput 为 null", sk.rpcInput, null);
      check("★ skill 缺 source → 明确点名 source", sk.payloadProblems.some((p) => p.path.includes("source")), sk.payloadProblems);
    }
  }
}

console.log(`\nscene-spec-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);