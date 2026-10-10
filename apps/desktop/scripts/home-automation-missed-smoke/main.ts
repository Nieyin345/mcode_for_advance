/**
 * home-automation-missed-smoke — 首屏「正在守着的自动化」把**错过定时**的自动化
 * 画成一切正常(见 `.scholar_tmp/triage.md` P8)。
 *
 * ## 盯的是什么
 *
 * P8:「错过的触发无声无息,用户不知道这条自动化没跑」。主进程侧早已把这件事记成
 * 事实(`AutomationFacts.recordMissed` → `missedCount`),设置页那一栏也用
 * `missedNoticeOf` 说了出来。但**首屏**(`EmptyThreadWelcome` 的「正在守着的自动化」)
 * 只看了 `latestFailureOf`,**没看 `missedNoticeOf`** ——
 *
 *   - `recordMissed` 刻意**不碰** `armed`(错过不等于坏了),所以一条错过定时的自动化
 *     `armed` 仍是 `true`,照进首屏那块列表;
 *   - 它的 `lastFireAt` 停在上次成功那一刻(几天前),于是那行走的是「上次触发 3 天前」,
 *     左边一颗**绿色**健康点 —— 用户看到的是"一切正常"。
 *
 * 这正是契约自己那句注释警告的形状(见 `@contracts/ipc` `missedNoticeOf` 的 doc:
 * 「设置页说『漏了 3 次』、首屏说『一切正常』,而两边读的是同一条事实」)。
 *
 * ## 判据立在"用户看到的那行字"上
 *
 * 构造三条事实:一条**错过定时**(armed、有 lastFireAt、missedCount>0)、一条干净、
 * 一条失败。断言首屏那几条行里:
 *   - 错过那条的**文字里出现"错过 3 次"**,且不再只是"上次触发"的安稳口吻;
 *   - 干净那条照旧是"上次触发";失败那条照旧是"上次失败"(回归)。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `EmptyThreadWelcome.tsx` + 真 `useRpc` / 真 i18n / 真 sessionStore;
 * `react` 换极小 hooks 运行时(组件源码原样跑),`@renderer/lib/api.js` 换成本目录的
 * 替身,图标换空壳 barrel。`EmptyThreadWelcome` 把 `StartPoints` 当子组件渲染,
 * fakeReact 只存 `{type, props}` 不调用它 —— 所以先挂根组件拿到那个元素,再 `__mount`
 * 它的函数本体(`StartPoints` 无 props),让它的 hooks 在干净槽位里跑(同
 * `activity-console-count-smoke` 手动调 `SubagentsBody` 的做法)。不起浏览器、不写盘。
 *
 * Run: scripts/home-automation-missed-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes, __flush } from "./fakeReact.js";
import { setFacts, resetApi, type Fact } from "./api-stub.js";
import { EmptyThreadWelcome } from "@renderer/components/chat/EmptyThreadWelcome.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

useSessionStore.setState({ locale: "zh" } as never);

/** ReactNode → 文本(字符串 / 元素 / 数组都收)。 */
function textNode(n: unknown): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textNode).join(" ");
  if (typeof n === "object") return textNode((n as { props?: { children?: unknown } }).props?.children);
  return "";
}

/** 首屏那几条自动化行。`Row` 是子组件,fakeReact 只存 `{type, props}` **不调用它** ——
 *  所以那条 `data-home-row` 的 button 根本不存在,按它认会一条都找不到。改为按 `Row`
 *  自己的 **props 形状**认:`{id, label, meta, onClick}`(`label` 是字符串、`meta` 在、
 *  `onClick` 是函数 —— 首屏唯一的按钮行)。 */
function homeRows(): Array<{ id: string; label: string; meta: string }> {
  const out: Array<{ id: string; label: string; meta: string }> = [];
  for (const nd of __nodes()) {
    const p = nd.props as Record<string, unknown>;
    if (typeof p.label === "string" && "meta" in p && typeof p.onClick === "function" && typeof p.id === "string") {
      out.push({ id: p.id, label: textNode(p.label), meta: textNode(p.meta) });
    }
  }
  return out;
}

/** 挂上根组件,从树里摘出 `StartPoints` 那个元素,再原地挂它的函数本体并放完回包。 */
async function mountHome(): Promise<void> {
  __mount(() => EmptyThreadWelcome({ projectName: "演示项目" }));
  const sp = __nodes().find((nd) => typeof nd.type === "function");
  if (sp === undefined) throw new Error("找不到 StartPoints 元素(EmptyThreadWelcome 结构变了?)");
  const fn = sp.type as (props: Record<string, unknown>) => unknown;
  __mount(() => fn(sp.props));
  await __flush();
}

const DAY = 24 * 60 * 60_000;
const now = Date.now();

// 一条**错过定时**的自动化:`recordMissed` 不碰 armed,所以它照旧 armed、照旧有
// lastFireAt(三天前),只是 missedCount 记着那几天漏了几次。
const MISSED: Fact = {
  key: "wf_missed:T",
  workflowId: "wf_missed",
  nodeId: "T",
  title: "每天九点日报",
  kind: "schedule",
  enabled: true,
  armed: true,
  lastFireAt: now - 3 * DAY,
  missedCount: 3,
  lastMissedAt: now - DAY,
};
// 一条干净的(回归:别把它的正常口吻改坏)。
const OK: Fact = {
  key: "wf_ok:T",
  workflowId: "wf_ok",
  nodeId: "T",
  title: "每小时备份",
  kind: "schedule",
  enabled: true,
  armed: true,
  lastFireAt: now - 60_000,
};
// 一条失败的(回归:`latestFailureOf` 那一路不受影响)。
const FAILED: Fact = {
  key: "wf_fail:T",
  workflowId: "wf_fail",
  nodeId: "T",
  title: "同步笔记",
  kind: "file",
  enabled: true,
  armed: true,
  lastFireAt: now - 2 * DAY,
  lastError: "运行失败:模型不可用",
  lastErrorAt: now - DAY,
};

async function scenario(): Promise<void> {
  resetApi();
  setFacts([MISSED, OK, FAILED]);
  await mountHome();

  const rows = homeRows();
  const byId = (id: string) => rows.find((r) => r.id === id);
  check("三条自动化都画在首屏", rows.length === 3, rows.map((r) => r.id));

  const missed = byId("wf_missed:T");
  check("错过定时的那条出现在首屏", missed !== undefined, byId("wf_missed:T"));
  check(
    "★ 错过定时的自动化:那一行文字说出了「错过 3 次」",
    (missed?.meta ?? "").includes("错过 3 次"),
    missed,
  );

  const ok = byId("wf_ok:T");
  check(
    "干净的自动化照旧显示「上次触发」(回归:别把正常口吻改坏)",
    (ok?.meta ?? "").includes("上次触发") && !(ok?.meta ?? "").includes("错过"),
    ok,
  );

  const failed = byId("wf_fail:T");
  check(
    "失败的自动化照旧显示「上次失败」(回归)",
    (failed?.meta ?? "").includes("上次失败"),
    failed,
  );
}

await scenario();

console.log(`\nhome-automation-missed-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures > 0 ? 1 : 0);
