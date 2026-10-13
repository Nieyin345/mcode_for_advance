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

console.log(`\nscene-spec-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
