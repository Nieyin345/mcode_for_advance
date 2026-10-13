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

console.log(`\nscene-spec-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);