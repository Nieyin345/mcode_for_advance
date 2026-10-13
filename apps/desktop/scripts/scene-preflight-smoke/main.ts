/**
 * Headless smoke for **场景预检服务**(`appServices/scenePreflight.ts` —— ARC-002 / MC-058)。
 *
 * 纯契约的 `sceneCapabilityPreflight` 已有 `scene-spec-smoke` 覆盖。本套验的是**服务那一层**:
 * 装配宿主清单 + 把纯判定接上,让「预检」在**真实入口**下也能回答「缺什么」。
 *
 * ## 它钉死的判据
 *
 *  - 校验失败 → 返回全部问题(与规划同一形状,不抛);
 *  - 合法 + 能力齐 → `ok:true` 且 `preflight.ok:true`;
 *  - 合法 + **缺必需能力** → `preflight.ok:false`、`requiredGaps` 非空(**部署该被挡住**);
 *  - 合法 + 缺**可选**能力 → `preflight.ok:true` 但 `gaps` 里有它(不挡部署、如实报);
 *  - 计划真的被编译出来(digest 非空)+ 清单真的来自宿主(宿主内置能力查得到)。
 *
 * 三个宿主依赖(provider 注册表 / 已启用插件 / 执行器注册表)走 stub,不碰磁盘、不起 Electron。
 *
 * Run: scripts/scene-preflight-smoke/run.sh
 */
import { preflightScene } from "../../src/main/appServices/scenePreflight.js";

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

/** 一份合法声明:研究插件(必需)+ 可选的 coverage MCP,建两个资源。 */
function spec(): unknown {
  return {
    schemaVersion: 1,
    sceneId: "code-inspect-daily",
    goal: "每天检查代码、执行测试,失败后通知我",
    preferredProviderId: "claude-sdk",
    capabilities: [
      { kind: "plugin", id: "research-pack", version: "1.2.0", required: true },
      { kind: "mcp", id: "coverage", required: false },
    ],
    resources: [
      { kind: "workflow", id: "wf_inspect", spec: { name: "代码巡检" } },
      { kind: "automation", id: "auto_daily", spec: { cron: "0 9 * * *" }, dependsOn: ["wf_inspect"] },
    ],
    acceptance: { description: "工作流与触发器都可见", expectResourceIds: ["wf_inspect", "auto_daily"] },
  };
}

async function main(): Promise<void> {
  /* ── 1. 非法声明 → 全问题,不抛 ── */
  {
    const r = await preflightScene({ spec: { schemaVersion: 999, sceneId: "X", goal: "", capabilities: [], resources: [], acceptance: {} } });
    check("★ 非法声明 → 不抛,返回 problems", !r.ok);
    if (!r.ok) check("非法声明一次报全(>=3 条)", r.problems.length >= 3, r.problems);
    check("非对象输入 → problems 不炸", !(await preflightScene({ spec: 42 })).ok);
  }

  /* ── 2. 合法 + 缺必需能力 → 预检不通过 ── */
  {
    // research-pack 在清单里;但声明一个清单里没有的必需插件 → 挡部署。
    const bad = spec() as Record<string, unknown>;
    bad.capabilities = [{ kind: "plugin", id: "ghost-pack", required: true }];
    const r = await preflightScene({ spec: bad });
    check("★ 合法声明 → ok(校验过)", r.ok, r.ok ? undefined : r.problems);
    if (r.ok) {
      eq("★ 缺必需能力 → preflight.ok=false(部署该被挡住)", r.preflight.ok, false);
      eq("缺必需能力 → requiredGaps 非空", r.preflight.requiredGaps.length >= 1, true);
      eq("计划仍编译出来(预检不阻断规划)", typeof r.plan.digest === "string" && r.plan.digest.length > 0, true);
      eq("缺口点名 ghost-pack", r.preflight.requiredGaps[0].id, "ghost-pack");
    }
  }

  /* ── 3. 合法 + 缺可选能力 → 预检仍通过,但如实报缺口 ── */
  {
    const s = spec() as Record<string, unknown>; // research-pack 必需(在)+ coverage 可选(不在)
    const r = await preflightScene({ spec: s });
    check("★ 合法声明 → ok", r.ok);
    if (r.ok) {
      eq("★ 缺可选能力 → preflight.ok=true(不挡部署)", r.preflight.ok, true);
      eq("缺可选能力 → gaps 里有它(coverage)", r.preflight.gaps.some((g) => g.id === "coverage"), true);
      eq("缺可选能力 → requiredGaps 为空", r.preflight.requiredGaps.length, 0);
      eq("gaps 里 coverage 的 required=false", r.preflight.gaps.find((g) => g.id === "coverage")?.required, false);
      // ★ 清单真的来自宿主:宿主内置能力 core.file.inspect 查得到(声明它 → 就位)。
      const hostCheck = spec() as Record<string, unknown>;
      hostCheck.capabilities = [{ kind: "module", id: "core.file.inspect", required: true }];
      const hr = await preflightScene({ spec: hostCheck });
      check("★ 宿主内置能力(module→builtin)在清单里 → 就位", hr.ok && hr.preflight.ok, hr.ok ? hr.preflight : hr);
      eq("预检条数 = 声明的能力数", r.preflight.checkedCapabilities, 2);
    }
  }

  console.log(`\nscene-preflight-smoke: ${total - failures}/${total} 通过`);
  if (failures > 0) process.exit(1);
}

void main();
