/**
 * 【MC-002】真 Electron 下的「崩溃后发现未完成部署 → 恢复 → 重新批准 → 续跑」UI U1 探针。
 *
 * ## 它验的是无头套件**证明不了**的那一半
 *
 * `scene-crash-resume-smoke` 已用真三进程证明主进程链路(跨场景列表 → 快照 → 重签授权 →
 * 只跑剩余步);`scene-deploy-view-smoke` 用纯函数验状态机。台账 remaining 是:真 Electron
 * 里**用户打开面板、亲眼看见那条记录、点「恢复到输入框」、重新批准、点续跑**这条渲染端
 * 路径没有验过 —— 而这条路径上只有真 DOM 才暴露的断点有两个候选:
 *
 *  1. 「未完成的部署」区整段挂在 `sceneIdForList !== null` 下 —— 查询本身在无 sceneId 时
 *     走跨场景,但**区块不渲染**。内存空 state 起步(崩溃重启后的真实起点)时
 *     `sceneIdForList === null`,用户依然看不到任何记录。
 *  2. 重启后从盘上记录恢复时只还原了**输入框文本**,没有还原「这是一次可续跑的部署」——
 *     状态机里 `apply` 仍为 `null`,于是预览 + 批准后 `canResume(state)` 为假,
 *     「续跑剩余步骤」按钮不出现。
 *
 * 本套件按用户真实操作顺序点真 DOM,断言用户可见文本/可点状态。若断点确实是缺陷,
 * 先修(最小改动,见 `sceneDeployView.ts` / `SceneDeployPanel.tsx` 里 MC-002 注释),
 * 再让本套件转绿;变异验证见 run 记录。
 *
 * ## 真 Electron + 真主进程 + 真渲染端
 *
 * - **主进程**:生产 `createDbGuardedIpc` + `registerSceneHandlers` + 少量
 *   `registerWorkflowHandlers` 子集(真 `workflow:save/get/remove` handler,含 Zod 校验
 *   与 CAS);数据根 = electron-host.cjs 指到的 mktemp 目录;
 * - **渲染端**:真 `BrowserWindow` + 套件打包的真 `SceneDeployPanel`;`window.api.scene.*`
 *   由 bridge.cjs 以与生产 preload 同形的薄桥注入;
 * - **派发序列**判据:主进程在 `workflow:save` 通道**外包一层计数器**(不替换 handler),
 *   续跑后断言「已 done 的步不再派发」。
 *
 * ## 安全边界
 *
 * - 不碰用户数据根(electron-host.cjs 重指所有 app 路径);
 * - 不联网;窗口隐藏;所有资源都是 mktemp 目录里的空工作流文档。
 */
import { BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDbGuardedIpc } from "@main/ipc/dbGuardedIpc.js";
import { registerSceneHandlers } from "@main/ipc/scene.js";
import { registerWorkflowHandlers } from "@main/ipc/orchestration.js";
import { recordRpcHandler, rpcHandlerFor } from "@main/appControl/registry.js";
import { initDb, awaitDb } from "@main/store/db.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { callRpc } from "@main/appControl/tools.js";
import { assembleGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { createDeployment, advanceDeployment } from "@contracts/sceneDeployment";
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import { saveDeployment, loadDeployment } from "@main/appServices/sceneDeploymentStore.js";
import { SceneDeploymentRepo } from "@main/store/repositories.js";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

/* ───────────────────────── 夹具 ───────────────────────── */

const SCENE = "scene_electron_resume";
const WF_DONE = "wf_electron_done"; // 崩溃前已完成(盘上记录里 done)
const AUTO_TODO = "auto_electron_todo"; // 崩溃时失败(盘上记录里 failed)
const DEP_ID = "dep_electron_resume";
const NO_SNAP_ID = "dep_electron_no_snapshot";
const NO_SNAP_SCENE = "scene_electron_no_snapshot";

/** 一条空工作流文档 —— `nodes: []` 过得了 `validateWorkflowDoc`(两条硬约束都只对有节点的图生效)。 */
function wfDoc(id: string): Record<string, unknown> {
  return { id, name: id, nodes: [], edges: [], builtin: false, updatedAt: 1 };
}

function specOf(sceneId: string, wfA: string, autoId: string): Record<string, unknown> {
  return {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId,
    goal: "真 Electron 下验崩溃续跑",
    capabilities: [],
    resources: [
      { kind: "workflow", id: wfA, spec: wfDoc(wfA) },
      { kind: "automation", id: autoId, spec: wfDoc(autoId), dependsOn: [wfA] },
    ],
    acceptance: { description: "资源都可见", expectResourceIds: [wfA, autoId] },
  };
}

function checked(raw: unknown): SceneSpec {
  const r = validateSceneSpec(raw);
  if (!r.ok) throw new Error("夹具不合法:" + JSON.stringify(r.problems));
  return r.spec;
}

export async function runSceneDeployProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const checks: Check[] = [];
  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS SDP " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.log("FAIL SDP " + name + " — " + String(error));
      throw error;
    } finally {
      writeFileSync(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  if (!isAbsolute(dataRoot())) throw new Error("数据根必须是绝对路径");
  assert(dataRoot().includes("scene-deploy-electron-"), "数据根必须指向套件临时目录,实际 " + dataRoot());

  /* ── 0. 主进程:真 DB + 真 handler + 真调用通路 ──
   *
   * 场景部署的每一步经 `callRpc` 派发 —— 它查的是 `appControl/registry` 里由
   * `createDbGuardedIpc` 登记的那一份,`ipcMain.handle` 层看不到。所以派发计数器必须
   * 包在**登记表**这一层:注册完成后取回真 handler,再登记一层计数转发(真 handler
   * 仍是同一个函数,不替换)。 */
  await initDb();
  await awaitDb();
  assembleGrantStore(dataRoot());

  const ipc = createDbGuardedIpc(ipcMain);
  registerWorkflowHandlers(ipc);
  registerSceneHandlers(ipc);

  const saves: string[] = [];
  const realSave = rpcHandlerFor("workflow:save");
  if (!realSave) throw new Error("workflow:save handler 没有注册上(接线断了)");
  recordRpcHandler("workflow:save", (event, raw) => {
    const wf = (raw as { workflow?: { id?: unknown } } | undefined)?.workflow;
    saves.push(typeof wf?.id === "string" ? wf.id : String(wf?.id));
    return realSave(event, raw);
  });

  /* ── 1. 盘上预置 ──
   * ① 先经**生产** `workflow:save` 建成「崩溃前已完成」的那条工作流(续跑的回读要查得到它);
   * ② 再写一条 partial 部署记录(已 done 的步 + 失败步,带 specSnapshot);
   * ③ 再写一条 failed、**无快照**的记录(旧存档形态)。
   */
  const seedSave = (await callRpc({ channel: "workflow:save" }, { workflow: wfDoc(WF_DONE) })) as { ok?: boolean };
  if (seedSave?.ok !== true) throw new Error("种子工作流没有建成:" + JSON.stringify(seedSave));
  saves.length = 0; // 种子不计入派发序列

  const spec = checked(specOf(SCENE, WF_DONE, AUTO_TODO));
  const plan = compileScenePlan(spec);
  let dep = createDeployment({
    deploymentId: DEP_ID,
    plan,
    actor: { actorKind: "user", actorId: "desktop" },
    now: Date.now(),
    specSnapshot: { spec, specDigest: plan.specDigest },
  });
  dep = advanceDeployment(dep, { actionId: WF_DONE, status: "done" }, Date.now());
  dep = advanceDeployment(dep, { actionId: AUTO_TODO, status: "failed", error: "崩溃前失败" }, Date.now());
  if (dep.status !== "partial") throw new Error("预置记录应为 partial,实际 " + dep.status);
  if (saveDeployment(dep, { durable: true }) !== true) throw new Error("partial 记录应 durable 落盘");

  const noSnapSpec = checked(specOf(NO_SNAP_SCENE, "wf_ns_a", "auto_ns_b"));
  const noSnapPlan = compileScenePlan(noSnapSpec);
  let noSnap = createDeployment({
    deploymentId: NO_SNAP_ID,
    plan: noSnapPlan,
    actor: { actorKind: "user", actorId: "desktop" },
    now: Date.now(),
  });
  noSnap = advanceDeployment(noSnap, { actionId: "wf_ns_a", status: "done" }, Date.now());
  noSnap = advanceDeployment(noSnap, { actionId: "auto_ns_b", status: "failed", error: "x" }, Date.now());
  if (noSnap.status !== "partial") throw new Error("无快照记录应为 partial,实际 " + noSnap.status);
  if (saveDeployment(noSnap, { durable: true }) !== true) throw new Error("无快照记录应落盘");
  if (loadDeployment(DEP_ID)?.specSnapshot === undefined) throw new Error("盘上记录应带快照");

  /* ── 2. 真窗口 + 真 SceneDeployPanel ── */
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(dir, "bridge.cjs"),
      backgroundThrottling: false,
    },
  });
  await win.loadFile(join(dir, "page.html"));
  const wc = win.webContents;

  async function js<T>(expr: string): Promise<T> {
    return (await wc.executeJavaScript(expr, true)) as T;
  }
  async function until(label: string, expr: string, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (true) {
      if (await js<boolean>(expr)) return;
      if (Date.now() - start > timeout) throw new Error("等待超时:" + label);
      await delay(100);
    }
  }
  const buttonExpr = (label: string): string =>
    `[...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})`;
  const clickButton = (label: string): Promise<void> =>
    js<void>(`(() => {
      const b = ${buttonExpr(label)};
      if (!b) throw new Error('找不到按钮: ' + ${JSON.stringify(label)});
      if (b.disabled) throw new Error('按钮被禁用: ' + ${JSON.stringify(label)});
      b.click();
    })()`);
  const rowButtonExpr = (id: string, label: string): string =>
    `(() => {
      const li = [...document.querySelectorAll('li')].find(x => x.textContent.includes(${JSON.stringify(id)}));
      if (!li) return null;
      return [...li.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(label)})) ?? null;
    })()`;
  const bodyText = (): Promise<string> => js<string>("document.body.innerText");
  const hasButton = (label: string): Promise<boolean> =>
    js<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent.includes(${JSON.stringify(label)}))`);

  // 页面级 run 结果先落盘(见 electron-host.cjs 文件头的「为什么必须由启动器判成败」:
  // 探针抛错时 Electron 退出,若失败断言只活在这个进程的内存里,启动器就只剩一条
  // `checks=0` —— 真实失败原因被吞掉)。`run()` 的异常由这里转成正文 + 退出码。
  const runBody = async (): Promise<void> => {
    /* ═══ ①-③ 重启后的起点:空输入框上用户就能看见记录 ═══ */
    await check("① 空输入框打开面板:用户看得到「未完成的部署」区", async () => {
      await until("未完成的部署标题出现", `document.body.innerText.includes('未完成的部署')`);
      const text = await bodyText();
      assert(text.includes("未完成的部署"), "缺少区块标题");
      assert(text.includes("可续跑"), "缺少「可续跑」徽章");
    });

    await check("② 记录行显示部署 id / 状态 / 更新时刻(不是空白)", async () => {
      const text = await bodyText();
      assert(text.includes(DEP_ID), "看不到部署 id " + DEP_ID + " —— 可见文本:" + text.slice(0, 600));
      assert(text.includes("部分完成"), "看不到「部分完成」状态词");
      assert(text.includes("更新于"), "看不到「更新于」时刻");
    });

    await check("③ 旧快照缺失的记录:行仍在列表里,点恢复后出现明确原因(不是空白)", async () => {
      const text = await bodyText();
      assert(text.includes(NO_SNAP_ID), "无快照行未被列出");
      const btn = await js<{ exists: boolean; disabled: boolean } | null>(`(() => {
        const b = ${rowButtonExpr(NO_SNAP_ID, "恢复到输入框")};
        return b ? { exists: true, disabled: b.disabled } : null;
      })()`);
      assert(btn?.exists === true, "无快照行没有恢复按钮");
      assert(btn?.disabled === false, "无快照行的恢复按钮不应禁用(它要能点出明确原因)");
      await js<void>(`(() => { const b = ${rowButtonExpr(NO_SNAP_ID, "恢复到输入框")}; b.click(); })()`);
      await until("无快照提示出现", `document.body.innerText.includes('没有声明快照')`);
      const after = await bodyText();
      assert(after.includes("没有声明快照"), "点恢复后没有出现「没有声明快照」的明确提示");
    });

    /* 【MC-002】真 Electron 读库失败必须给用户错误，而不是展示虚假的空部署列表。
     * 只替换本套隔离 sql.js Repo 的 listRecent，真 store + IPC + 组件全部照常工作。
     * 重载后恢复真正 Repo 并验证那两条历史记录仍可读取，不能污染用户数据。 */
    await check("③a 真 Electron：隔离 DB 读异常显示具体故障，不伪装成空记录", async () => {
      const original = SceneDeploymentRepo.listRecent;
      const fake = (..._args: Parameters<typeof original>): ReturnType<typeof original> => {
        throw new Error("MC002_FAKE_DB_READ_ERROR");
      };
      Object.assign(SceneDeploymentRepo, { listRecent: fake });
      try {
        await new Promise<void>((resolve) => {
          wc.once("did-finish-load", () => resolve());
          wc.reload();
        });
        await until("数据库读错误可见", "document.body.innerText.includes('MC002_FAKE_DB_READ_ERROR')");
        const text = await bodyText();
        assert(text.includes("MC002_FAKE_DB_READ_ERROR"), "界面没有透出错误原因");
        assert(!text.includes("暂无未完成的部署"), "读失败不能报空记录");
      } finally {
        Object.assign(SceneDeploymentRepo, { listRecent: original });
      }
    });
    await check("③b 故障解除后重载面板，原来的可恢复部署记录无损", async () => {
      await new Promise<void>((resolve) => {
        wc.once("did-finish-load", () => resolve());
        wc.reload();
      });
      await until("可恢复的历史记录重新出现", "document.body.innerText.includes(" + JSON.stringify(DEP_ID) + ")");
      assert((await bodyText()).includes(NO_SNAP_ID), "读异常后的其他原记录丢失");
    });

    /* ═══ ④-⑤ 点选恢复 → 原快照回到输入框;不自动恢复授权 ═══ */
    await check("④ 点「恢复到输入框」后原 specSnapshot 被填回可见的 textarea", async () => {
      await js<void>(`(() => {
        const b = ${rowButtonExpr(DEP_ID, "恢复到输入框")};
        if (!b) throw new Error('找不到可续跑行的恢复按钮');
        if (b.disabled) throw new Error('恢复按钮被禁用');
        b.click();
      })()`);
      await until(
        "textarea 填入快照",
        `(() => { const t = document.querySelector('textarea'); return !!t && t.value.includes(${JSON.stringify(SCENE)}); })()`,
      );
      const value = await js<string>("document.querySelector('textarea').value");
      const parsed = JSON.parse(value) as { sceneId?: string; resources?: unknown[] };
      assert(parsed.sceneId === SCENE, "还原的声明 sceneId 不对:" + String(parsed.sceneId));
      assert(Array.isArray(parsed.resources) && parsed.resources.length === 2, "还原的声明资源数不对");
      assert(saves.length === 0, "恢复动作不应派发任何 workflow:save,实际 " + JSON.stringify(saves));
    });

    await check("⑤ 恢复后状态回到「未授权」:没有旧授权,也没有可点的续跑按钮", async () => {
      const text = await bodyText();
      assert(!text.includes("已批准这一份计划"), "恢复后不应带着旧授权");
      assert(!text.includes("授权有效至"), "恢复后不应显示有效授权徽标");
      assert(!(await hasButton("续跑剩余步骤")), "未重新授权前就出现了续跑按钮");
    });

    /* ═══ ⑥-⑧ 重新预览 + 批准 ═══ */
    await check("⑥ 点「预览」后用户看到计划(两步都在,且标「会执行」)", async () => {
      await clickButton("预览");
      await until("变更计划出现", `document.body.innerText.includes('变更计划')`);
      const text = await bodyText();
      assert(text.includes(WF_DONE) && text.includes(AUTO_TODO), "计划里看不到两步 actionId");
      assert(text.includes("会执行"), "计划里看不到「会执行」");
    });

    await check("⑦ 预览后、批准前:「续跑剩余步骤」不出现(没有授权不许执行)", async () => {
      assert(!(await hasButton("续跑剩余步骤")), "未批准就出现续跑按钮");
      const text = await bodyText();
      assert(text.includes("没有授权不会执行任何一步"), "看不到「没有授权不会执行任何一步」的提示");
      assert(saves.length === 0, "预览/未批准阶段不应派发,实际 " + JSON.stringify(saves));
    });

    await check("⑧ 点「批准」后出现有效授权徽标,且「续跑剩余步骤」出现", async () => {
      await clickButton("批准");
      await until("授权徽标出现", `document.body.innerText.includes('授权有效至')`);
      await until("续跑按钮出现", `[...document.querySelectorAll('button')].some(b => b.textContent.includes('续跑剩余步骤'))`);
    });

    /* ═══ ⑨-⑪ 续跑只执行未完成步骤 ═══ */
    await check("⑨ 点续跑之前:盘上已 done 的步没有被重新派发(派发序列为空)", () => {
      assert(saves.length === 0, "批准阶段不应派发,实际 " + JSON.stringify(saves));
    });

    await check("⑩ 点「续跑剩余步骤」:只派发未完成的步(已完成的步不重跑)", async () => {
      await js<void>(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('续跑剩余步骤'));
        if (!b) throw new Error('找不到续跑按钮');
        if (b.disabled) throw new Error('续跑按钮被禁用');
        b.click();
      })()`);
      await until("部署结果出现", `document.body.innerText.includes('部署结果')`, 25000);
      assert(!saves.includes(WF_DONE), "已完成的步被重新派发:" + JSON.stringify(saves));
      assert(saves.includes(AUTO_TODO), "未完成的步没有被派发:" + JSON.stringify(saves));
    });

    await check("⑪ 续跑结果:整体已完成、验收通过,且盘上记录为 active", async () => {
      await until("已完成徽标出现", `document.body.innerText.includes('部署结果') && document.body.innerText.includes('已完成')`, 25000);
      const text = await bodyText();
      assert(text.includes("验收通过"), "看不到「验收通过」,可见文本:" + text.slice(0, 800));
      const onDisk = loadDeployment(DEP_ID);
      assert(onDisk !== null && onDisk.status === "active", "盘上记录应为 active,实际 " + String(onDisk?.status));
    });

    /* ═══ ⑫ 渲染端没有未捕获异常(React 整树卸载探针) ═══ */
    await check("⑫ 全程无渲染端未捕获异常:面板动作栏仍在 DOM 里", async () => {
      const err = await js<string | null>(`window.__sdp ? window.__sdp.renderError : 'no-probe-marker'`);
      assert(err === null, "渲染端出现未捕获异常:" + String(err));
      const still = await js<boolean>(`!!document.querySelector('[data-testid="scene-deploy-approval-bar"]')`);
      assert(still, "面板动作栏已从 DOM 消失(整树卸载?)");
    });
  };
  try {
    await runBody();
  } finally {
    win.destroy();
  }
}
