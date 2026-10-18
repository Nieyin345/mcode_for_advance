/**
 * 【MC-054】真 Electron 下的**两端并发保存守望模板** U1 探针。
 *
 * ## 它验的是无头套件证明不了的那一半
 *
 * `orchestration-ipc-smoke` §9 用 `fakeIpc` 在**同一个进程**里按 channel 调 handler,
 * 已经钉住了 CAS 分支本身。台账 remaining 点名的两件事它证明不了：
 *
 *   1. **真渲染端 + 真 preload + 真 IPC**：一个客户端经 `window.api`（真 preload 桥、
 *      真 ipcRenderer.invoke → 真 ipcMain）把模板读出来、改完保存；
 *      另一个客户端是**主进程里的 Agent 通路**（`invokeAppTool("app_api_call")` →
 *      真 `callRpc` → 同一条 handler）。两边共用同一个**真 sql.js 库**（mktemp 数据根）。
 *   2. **`WatchSegment` 真组件**：冲突之后界面换成盘上的内容 —— 而"盘上的内容"不是
 *      测试自报的，是**从 `mcode.db` 文件字节直接查出来的**（关库后重开读 settings 表）。
 *
 * ## 步骤（每条都立在真实返回值与盘上事实上）
 *
 *   A 读到 revision X → B 读到 X → B 先存成功（revision 变 Y）→ A 用 X 存被拒
 *   （conflict + currentRevision）→ A 重读后按 Y 存成功 → 盘上最终是 A 的版本，
 *   B 的更新（B 写进去的那一条）**没丢**（它不可能是 A 的副本冒充的 —— 用逐字节比较
 *   与"B 的模板在 A 最终内容里"两条一起证明）。
 *
 * 之后再加一段 `WatchSegment` 真组件：面板从真 IPC 打开、建模板（同步围栏走真
 * handler），然后**模拟另一端**（Agent 通路）改盘；在面板里再点一次"存为模板"——
 * 围栏的冲突分支重读 + 重放，界面换成的正是盘上那一份（含另一端刚加的那条），
 * 且盘上最终 = 界面显示（两边逐条对得上）。
 *
 * ## 安全边界
 *
 * - 不碰用户数据根：electron-host.cjs 把 app 全部路径与 data-root 指针重指到
 *   `MCODE_WT_CAS_DIR`；探针还会先断言 `dataRoot()` 真的在套件目录下再往下走。
 * - 不联网：页面是 `file://` + CSP `connect-src 'none'`，不发任何外部请求。
 * - `sql.js` 的 `db.export()` 重写整个 `mcode.db` —— 这正是本套"盘上事实"的读法：
 *   先 `closeDb()`（它自己 durable 落盘），再用 sql.js 只读打开那个临时文件。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { IPC } from "@contracts/ipc";
import { watchTemplatesRevision, type WatchCommandTemplate } from "@contracts/ipc/workflow";
import { createDbGuardedIpc } from "@main/ipc/dbGuardedIpc.js";
import { registerWorkflowHandlers } from "@main/ipc/orchestration.js";
import { invokeAppTool } from "@main/appControl/tools.js";
import { closeDb, flushDb, initDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import type { ProviderContext, ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import type { IpcMain } from "electron";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

/** 真渲染端页：真 preload（window.api）之外只挂两样东西 ——
 *  `root`（React 挂载点）与 `testApi`（暴露给页面脚本的 api，供探针 executeJavaScript 调）。 */
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:">
<title>watch templates cas u1</title></head>
<body>
<div id="root"></div>
<script type="module" src="renderer.js"></script>
</body></html>`;

export async function runWatchTemplatesCasProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const checks: Check[] = [];
  let win: BrowserWindow | undefined;

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS WTCAS " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      throw error;
    } finally {
      await writeFile(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  const js = async <T = unknown>(expression: string): Promise<T> =>
    (await (win as BrowserWindow).webContents.executeJavaScript(expression, true)) as T;
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw new Error("Timed out: " + label);
      await delay(40);
    }
  }

  /* ── 两个"客户端"共用的底层 ───────────────────────────────────────────── */

  /** 真 IPC handler 的**唯一**取法：生产里 `ipc/index.ts` 用 `createDbGuardedIpc(ipcMain)`
   *  包一层再交给 `registerWorkflowHandlers`，这一层同时把同一个函数登记进
   *  `appControl/registry`（`app_api_call` 就是从这里取的）。套件照抄这段装配：
   *  真正的 `ipcMain` 用于渲染端/preload，另用**同一个包装器**把 handler 收进
   *  `recorded`（包装器只加 `awaitDb` + 幂等守卫，不换 handler）。 */
  const recorded = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const recordingTarget = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      recorded.set(channel, listener);
      (ipcMain as IpcMain).handle(channel, listener as never);
    },
  } as unknown as IpcMain;
  const bridgeIpc = createDbGuardedIpc(recordingTarget);

  /** 客户端 B：Agent 通路。真 `invokeAppTool("app_api_call")` → 真 `callRpc` → 真 handler。
   *  权限模式给"完全访问"，让写档不弹卡（审批闸本身不是本套的验收对象）；若真的被问，
   *  记下来让断言看见。 */
  const approvalsAsked: string[] = [];
  const agentCtx = {
    getPermissionMode: () => "bypassPermissions",
    isToolAlwaysAllowed: () => false,
    requestApproval: async (req: ApprovalRequest): Promise<ProviderApprovalDecision> => {
      approvalsAsked.push(req.toolName);
      return { allow: true };
    },
  } as unknown as ProviderContext;

  interface OpEnvelope {
    resultKind: string;
    reason?: string;
    code?: string;
  }
  /** `app_api_call` 的工具结果 → 它自己的正文（被调用方法的原始返回值）。 */
  const agentCall = async (method: string, input?: unknown): Promise<{ envelope?: OpEnvelope; raw: unknown; isError: boolean; text: string }> => {
    const res = await invokeAppTool("app_api_call", input === undefined ? { method } : { method, input }, "smoke-origin-session", agentCtx);
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    const envelope = (res.structuredContent as { operation_result?: OpEnvelope } | undefined)?.operation_result;
    return { envelope, raw: res, isError: res.isError === true, text };
  };

  /** 盘上事实：真 sql.js **只读重开**库文件，直接查 settings 表。关库前先 durable 落盘
   *  （`closeDb` 内部 persistNowOrThrow —— 与生产退出路径同一份实现）。 */
  const readTemplatesOnDisk = async (): Promise<{ raw: string | null; templates: WatchCommandTemplate[] }> => {
    flushDb();
    closeDb();
    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(await readFile(join(dir, "data", "mcode.db"))));
    try {
      const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
      stmt.bind(["automation.watch.templates"]);
      const found = stmt.step();
      const raw = found ? String((stmt.getAsObject() as { value: unknown }).value) : null;
      stmt.free();
      return { raw, templates: raw === null ? [] : (JSON.parse(raw) as WatchCommandTemplate[]) };
    } finally {
      db.close();
    }
  };
  /** 读盘之后库句柄已关；下一次需要主进程再写时重新打开同一个文件（initDb 幂等）。 */
  const reopenDb = async (): Promise<void> => {
    await initDb();
  };

  try {
    /* ── 0. 隔离前提 ──────────────────────────────────────────────────── */
    await check("数据根与 app 路径都重指在套件的 mktemp 目录下（不碰用户数据）", async () => {
      const root = dataRoot();
      assert(root.startsWith(dir), `dataRoot 不在套件目录:${root}`);
      assert(app.getPath("userData").startsWith(dir), `userData 不在套件目录:${app.getPath("userData")}`);
      assert(app.getPath("home").startsWith(dir), `home 不在套件目录:${app.getPath("home")}`);
    });

    await check("真 sql.js 库就绪，真 registerWorkflowHandlers 注册到真 ipcMain", async () => {
      await initDb();
      registerWorkflowHandlers(bridgeIpc);
      assert(recorded.has(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE), "真 IPC 上没有注册模板保存通道");
      assert(recorded.has(IPC.AUTOMATION_WATCH_TEMPLATES), "真 IPC 上没有注册模板读取通道");
    });

    /* ── 1. 真窗口 + 真 preload + 渲染端 bundle（WatchSegment）───────────── */
    win = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      webPreferences: {
        preload: join(dir, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const rendererErrors: string[] = [];
    win.webContents.on("console-message", (details) => {
      if (details.level === "error") rendererErrors.push(`${details.level}: ${details.message}`);
    });
    await win.loadFile(join(dir, "index.html"));

    await check("真 preload 桥在页面里：window.api.automation 的模板读/存/重建三件都是函数", async () => {
      const marker = await js<{ electron: boolean; api: string }>(
        "({ electron: window.mcodeElectron === true, api: typeof window.api })",
      );
      assert(marker.electron === true, "mcodeElectron 标记不在（不是真 preload 注入的窗口）");
      const shapes = await js<Record<string, string>>(
        "({ read: typeof window.api?.automation?.watchTemplates, save: typeof window.api?.automation?.saveWatchTemplates, rebuild: typeof window.api?.automation?.rebuildWatchTemplates })",
      );
      assert(shapes.read === "function" && shapes.save === "function" && shapes.rebuild === "function", JSON.stringify(shapes));
      // 页面脚本与 preload 走的是**真 ipcRenderer.invoke**——读一次，经真 IPC 回到真 handler。
      const read = await js<{ templates: WatchCommandTemplate[]; health: string; revision: string }>("window.api.automation.watchTemplates()");
      assert(typeof read.revision === "string" && read.revision.startsWith("watchtpl:fnv1a:"), `revision 形状不对:${read.revision}`);
      assert(read.health === "absent", `还没存过时应是 absent:${read.health}`);
    });

    await check("WatchSegment 真组件挂载成功（按钮出现在页面里，渲染端无未捕获错误）", async () => {
      await until(async () => (await js<number>("document.querySelectorAll('button').length")) > 0, "WatchSegment 按钮出现");
      const text = await js<string>("document.body.innerText");
      assert(text.includes("守望"), `面板触发段没渲染:${text.slice(0, 80)}`);
      assert(rendererErrors.length === 0, `渲染端有未捕获错误:${rendererErrors.join(" | ")}`);
    });

    /* ── 2. 两端并发：A 走真渲染端，B 走 Agent 通路 ─────────────────────── */

    interface ReadReply {
      templates: WatchCommandTemplate[];
      health: string;
      problems: string[];
      revision: string;
    }
    let revisionX = "";
    let aRead: ReadReply | undefined;

    await check("A（真渲染端）与 B（Agent 经 app_api_call）都读到同一个 revision X", async () => {
      aRead = await js<ReadReply>("window.api.automation.watchTemplates()");
      const b = await agentCall("automation.watchTemplates");
      assert(b.envelope?.resultKind === "SUCCEEDED", `B 读取没成功:${JSON.stringify(b.envelope)}`);
      // 正文就是被调用方法的原始返回（renderResult 的 JSON 文本）——解析它拿 revision。
      const parsed = JSON.parse(b.text) as ReadReply;
      revisionX = aRead.revision;
      assert(aRead.revision === parsed.revision, `两端读到的 revision 不同:A=${aRead.revision} B=${parsed.revision}`);
      assert(aRead.templates.length === 0, `起点应为空表:${JSON.stringify(aRead.templates)}`);
    });

    const bTemplates: WatchCommandTemplate[] = [
      { id: "tpl_b", name: "B 的模板", command: "echo B-wrote-this" },
    ];

    await check("B 先用 X 保存成功（经 app_api_call 高风险审批档），revision 变成 Y", async () => {
      const askedBefore = approvalsAsked.length;
      const saved = await agentCall("automation.watchTemplatesSave", { templates: bTemplates, expectedRevision: revisionX });
      assert(saved.envelope?.resultKind === "SUCCEEDED", `B 保存没成功:${JSON.stringify(saved.envelope)} text=${saved.text.slice(0, 200)}`);
      assert(
        approvalsAsked.slice(askedBefore).includes("mcode-app-danger:automation.watchTemplatesSave"),
        `Agent 保存模板应走高风险审批档:${JSON.stringify(approvalsAsked.slice(askedBefore))}`,
      );
      const b = (await agentCall("automation.watchTemplates")).text;
      const after = JSON.parse(b) as ReadReply;
      assert(after.revision !== revisionX, `B 保存后 revision 没变:${after.revision}`);
      assert(JSON.stringify(after.templates.map((t) => t.id)) === JSON.stringify(["tpl_b"]), `B 读回的不是自己刚存的:${JSON.stringify(after.templates)}`);
      // 老 revision X 现在已经是"盘上被别处改过"的状态。
      assert(watchTemplatesRevision(bTemplates) === after.revision, "revision 必须与两端共用的纯函数一致");
    });

    const aStaleTemplates: WatchCommandTemplate[] = [
      { id: "tpl_a", name: "A 的模板", command: "echo A-wrote-this" },
    ];
    let aConflict: { ok: boolean; conflict?: boolean; currentRevision?: string; error?: string } | undefined;

    await check("A 用旧 X 保存 → 真 IPC 拒绝：conflict + currentRevision，盘上仍是 B 的", async () => {
      const reply = await js<{ ok: boolean; conflict?: boolean; currentRevision?: string; error?: string }>(
        `window.api.automation.saveWatchTemplates(${JSON.stringify({ templates: aStaleTemplates, expectedRevision: revisionX })})`,
      );
      aConflict = reply;
      assert(reply.ok === false, `A 用旧 revision 竟然保存成功:${JSON.stringify(reply)}`);
      assert(reply.conflict === true, `拒绝没标 conflict:${JSON.stringify(reply)}`);
      assert(typeof reply.currentRevision === "string" && reply.currentRevision.length > 0, `没带回 currentRevision:${JSON.stringify(reply)}`);
      assert(typeof reply.error === "string" && reply.error.includes("已被别处改动"), `拒绝语没说清原因:${reply.error}`);
      const disk = await readTemplatesOnDisk();
      // 逐字节：handler 写的就是 `JSON.stringify(input.templates)`，盘上那份必须和 B 的入参
      // 一字不差（不是"内容差不多"）。
      assert(disk.raw === JSON.stringify(bTemplates), `A 被拒后盘上不是 B 的那份字节:${disk.raw}`);
      assert(JSON.stringify(disk.templates) === JSON.stringify(bTemplates), `A 被拒后盘上不是 B 的内容:${disk.raw}`);
      await reopenDb();
    });

    await check("A 重读拿到 Y，盘上确实只有 B 的那一条（A 的保存一行都没写进去）", async () => {
      const reread = await js<ReadReply>("window.api.automation.watchTemplates()");
      assert(reread.revision === aConflict?.currentRevision, `重读 revision 与拒绝带回的不一致:${reread.revision} vs ${aConflict?.currentRevision}`);
      assert(JSON.stringify(reread.templates) === JSON.stringify(bTemplates), `重读内容不是 B 的:${JSON.stringify(reread.templates)}`);
      const disk = await readTemplatesOnDisk();
      assert(!JSON.stringify(disk.templates).includes("tpl_a"), `A 被拒的那次仍留下了痕迹:${disk.raw}`);
      await reopenDb();
    });

    // A 重读后**基于盘上内容**改（保留 B 的一条 + 加自己一条）—— 这正是"不丢别人的更新"。
    const aFinalTemplates: WatchCommandTemplate[] = [
      ...bTemplates,
      { id: "tpl_a", name: "A 的模板", command: "echo A-wrote-this" },
    ];
    let aFinalRevision = "";

    await check("A 用 Y 保存成功，盘上最终是「B 的模板 + A 的模板」，B 的更新没丢", async () => {
      const reply = await js<{ ok: boolean; error?: string }>(
        `window.api.automation.saveWatchTemplates(${JSON.stringify({ templates: aFinalTemplates, expectedRevision: aConflict?.currentRevision })})`,
      );
      assert(reply.ok === true, `A 重读后的保存被拒:${JSON.stringify(reply)}`);
      const disk = await readTemplatesOnDisk();
      assert(disk.raw === JSON.stringify(aFinalTemplates), `盘上最终字节不对:${disk.raw}`);
      assert(JSON.stringify(disk.templates) === JSON.stringify(aFinalTemplates), `盘上最终内容不对:${disk.raw}`);
      // 逐字节：B 的那一条必须是 B 写进去的那份（名字/命令都和 B 一致，不是 A 复制的壳）。
      const bOnDisk = disk.templates.find((t) => t.id === "tpl_b");
      assert(bOnDisk !== undefined && bOnDisk.name === "B 的模板" && bOnDisk.command === "echo B-wrote-this", `B 的更新丢了或被改:${JSON.stringify(bOnDisk)}`);
      aFinalRevision = watchTemplatesRevision(disk.templates);
      await reopenDb();
    });

    await check("B 重读（Agent 通路）看到的就是 A 保存后的盘上内容，revision 等于两者共用的纯函数值", async () => {
      const b = JSON.parse((await agentCall("automation.watchTemplates")).text) as ReadReply;
      assert(JSON.stringify(b.templates) === JSON.stringify(aFinalTemplates), `B 重读内容不对:${JSON.stringify(b.templates)}`);
      assert(b.revision === aFinalRevision, `B 看到的 revision 与盘上事实不符:${b.revision} vs ${aFinalRevision}`);
    });

    await check("旧调用方（缺 expectedRevision 字段）经 Agent 通路保存 → 拒绝且盘上不动（不静默整表覆盖）", async () => {
      const diskBefore = (await readTemplatesOnDisk()).raw;
      await reopenDb();
      const legacy = await agentCall("automation.watchTemplatesSave", {
        templates: [{ id: "tpl_legacy", name: "旧调用方", command: "echo legacy" }],
      });
      // app_api_call 的领域解码对这条方法未登记「ok 信封」，正文里的 ok:false 原样返回。
      const body = JSON.parse(legacy.text) as { ok: boolean; conflict?: boolean; currentRevision?: string; error?: string };
      assert(body.ok === false, `缺字段的旧调用方竟然保存成功:${legacy.text.slice(0, 200)}`);
      assert(body.conflict === true, `拒绝没标 conflict:${legacy.text.slice(0, 200)}`);
      assert(typeof body.error === "string" && body.error.includes("没有带原值版本"), `拒绝语没点明缺 expectedRevision:${body.error}`);
      assert(body.currentRevision === aFinalRevision, `拒绝没带回盘上当前 revision:${body.currentRevision}`);
      const diskAfter = (await readTemplatesOnDisk()).raw;
      assert(diskAfter === diskBefore, `被拒的旧调用仍改了盘:${diskAfter}`);
      await reopenDb();
    });

    await check("★ MC-054:Agent 即使传显式 null 也不能跳过普通保存的 CAS", async () => {
      const before = (await readTemplatesOnDisk()).raw;
      await reopenDb();
      const overwrite = await agentCall("automation.watchTemplatesSave", {
        templates: [{ id: "tpl_null", name: "非法无条件覆盖", command: "echo null-bypass" }],
        expectedRevision: null,
      });
      const reply = JSON.parse(overwrite.text) as { ok?: boolean; conflict?: boolean; error?: string };
      assert(reply.ok === false && reply.conflict === true, "显式 null 绕过了 CAS:" + overwrite.text);
      assert(reply.error?.includes("不能用 null") === true, "拒绝没有点明 null 绕过:" + overwrite.text);
      const after = (await readTemplatesOnDisk()).raw;
      assert(after === before, "显式 null 的恶意普通保存改动了盘上原字节");
      await reopenDb();
    });

    /* ── 3. WatchSegment 真组件：冲突后界面换成盘上内容 ─────────────────── */

    /** 在页面里开面板、用现写输入框存一条模板 —— 走的是**真组件**的同步围栏
     *  （`watchTemplatesSync.mutate` → `window.api.automation.saveWatchTemplates` → 真 handler）。 */
    const panelOpen = async (): Promise<void> => {
      await js(`document.querySelector('button').click()`);
      await until(async () => (await js<boolean>("document.body.innerText.includes('命令模板')")), "面板打开");
    };
    const panelSaveTemplate = async (name: string, command: string): Promise<void> => {
      // 面板里两个 Input：命令框 + 模板名字框；"存为模板"按钮在两者都有值后启用。
      await js(`(() => {
        const inputs = [...document.querySelectorAll('input')];
        const command = inputs.find((el) => el.placeholder && el.placeholder.includes('要跑的命令'));
        const name = inputs.find((el) => el.placeholder && el.placeholder.includes('模板名字'));
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(command, ${JSON.stringify(command)});
        set(name, ${JSON.stringify(name)});
      })()`);
      await until(async () =>
        (await js<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '存为模板' && !b.disabled)`)),
      "「存为模板」按钮启用");
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '存为模板').click()`);
    };
    /** 面板里下拉框当前显示的全部模板名（选项在 Select 弹层里，需先展开）。 */
    const panelTemplateNames = async (): Promise<string[]> => {
      await js(`document.querySelector('[role=combobox]').click()`);
      await until(async () => (await js<number>("document.querySelectorAll('[role=option]').length")) > 0, "模板下拉展开");
      const names = await js<string[]>(`[...document.querySelectorAll('[role=option]')].map((el) => el.textContent.trim())`);
      await js(`document.querySelector('[role=combobox]').click()`);
      await delay(80);
      return names;
    };

    await check("WatchSegment 面板打开后读到的是盘上当前模板（真组件真 IPC 读）", async () => {
      await panelOpen();
      const names = await panelTemplateNames();
      assert(names.includes("B 的模板") && names.includes("A 的模板"), `面板没读到盘上两条:${JSON.stringify(names)}`);
    });

    await check("另一端（Agent 通路）在面板开着时改盘：面板里的旧 revision 已被别处改动", async () => {
      const current = JSON.parse((await agentCall("automation.watchTemplates")).text) as ReadReply;
      const bSecond = [...current.templates, { id: "tpl_b2", name: "B 后加的模板", command: "echo B-second-write" }];
      const saved = await agentCall("automation.watchTemplatesSave", { templates: bSecond, expectedRevision: current.revision });
      assert(saved.envelope?.resultKind === "SUCCEEDED", `另一端保存没成功:${JSON.stringify(saved.envelope)}`);
      const b = JSON.parse((await agentCall("automation.watchTemplates")).text) as ReadReply;
      assert(b.templates.some((t) => t.id === "tpl_b2"), `另一端没写进盘上:${JSON.stringify(b.templates)}`);
    });

    await check("★ 面板里点「存为模板」：围栏冲突 → 重读 + 重放，界面换成盘上内容（含另一端刚加的那条）", async () => {
      await panelSaveTemplate("A 面板加的模板", "echo A-panel-write");
      // 围栏冲突分支：重读权威 → 重放这一条 → 成功。等界面把三条都显示出来。
      await until(async () => {
        const names = await panelTemplateNames();
        return names.includes("B 的模板") && names.includes("A 的模板") && names.includes("B 后加的模板") && names.includes("A 面板加的模板");
      }, "冲突后界面换成盘上内容 + 本面板新增");
      const notice = await js<string>("document.body.innerText");
      assert(notice.includes("模板已被别处改动"), `冲突提示语没出现:${notice.slice(0, 300)}`);
    });

    await check("面板显示 = 盘上最终事实：四条逐条一致，另一端的两条一条不少", async () => {
      const disk = await readTemplatesOnDisk();
      const shown = await panelTemplateNames();
      const diskNames = disk.templates.map((t) => t.name);
      assert(disk.templates.length === 4, `盘上应正好四条:${JSON.stringify(disk.templates)}`);
      assert(JSON.stringify(diskNames.slice().sort()) === JSON.stringify(shown.filter((n) => n !== "不使用模板（现写）").sort()), `界面与盘上不一致:界面=${JSON.stringify(shown)} 盘上=${JSON.stringify(diskNames)}`);
      assert(disk.templates.filter((t) => t.id.startsWith("tpl_b")).length === 2, `另一端的两条没保住:${JSON.stringify(disk.templates)}`);
      for (const t of disk.templates) {
        assert(t.command.trim().length > 0, `盘上出现空命令模板:${JSON.stringify(t)}`);
      }
      await reopenDb();
    });

    /* 【MC-054】同一个真实 sql.js DB 下，模拟磁盘坏 JSON / 部分坏条目：
     * UI/preload 返回健康度；普通保存拒写；被拒后坏原文逐字节保留。
     * 无论断言成功与否，finally 都恢复 suite 之前的有效内容。 */
    await check("★ MC-054:真 Electron 坏 JSON 的健康度可见、拒绝普通写且保全原字节", async () => {
      const original = SettingRepo.get("automation.watch.templates");
      const broken = "{MC054 deliberately broken JSON";
      try {
        SettingRepo.set("automation.watch.templates", broken);
        await js("document.querySelector('div.fixed.inset-0.z-40')?.click()");
        await panelOpen();
        await until(async () => (await js<string>("document.body.innerText")).includes("备份并重建"), "损坏模板 UI 的重建按钮");
        const pageText = await js<string>("document.body.innerText");
        assert(pageText.includes("备份并重建"), "真实 WatchSegment 没展示损坏恢复入口");
        const health = await js<{ health?: string; problems?: string[] }>("window.api.automation.watchTemplates()");
        assert(health.health === "corrupt" && (health.problems?.length ?? 0) > 0,
          "损坏数据库没有向页面明确报告:" + JSON.stringify(health));
        const attempted = await js<{ ok?: boolean; error?: string }>(
          `window.api.automation.saveWatchTemplates(${JSON.stringify({ templates: [{ id: "evil", name: "覆盖", command: "echo" }], expectedRevision: "stale" })})`,
        );
        assert(attempted.ok === false, "坏 JSON 仍能被普通保存覆盖:" + JSON.stringify(attempted));
        assert(attempted.error?.includes("坏得读不出来") === true, "没有提供损坏诊断:" + JSON.stringify(attempted));
        assert(SettingRepo.get("automation.watch.templates") === broken, "坏档原字节被写坏");
      } finally {
        if (original !== null) SettingRepo.set("automation.watch.templates", original);
      }
    });
    await check("★ MC-054:真 Electron 部分损坏列表不得被整表保存抹掉", async () => {
      const original = SettingRepo.get("automation.watch.templates");
      const partial = JSON.stringify([
        { id: "good", name: "有效模板", command: "echo good" },
        { id: "broken", name: "未通过形状校验" },
      ]);
      try {
        SettingRepo.set("automation.watch.templates", partial);
        const health = await js<{ health?: string; problems?: string[]; templates?: unknown[] }>("window.api.automation.watchTemplates()");
        assert(health.health === "partial" && health.templates?.length === 1 && (health.problems?.length ?? 0) > 0,
          "部分坏档没有结构化暴露:" + JSON.stringify(health));
        const attempted = await js<{ ok?: boolean; error?: string }>(
          `window.api.automation.saveWatchTemplates(${JSON.stringify({ templates: [{ id: "good", name: "有效模板", command: "echo good" }], expectedRevision: "stale" })})`,
        );
        assert(attempted.ok === false && attempted.error?.includes("读不出来的条目") === true,
          "部分损坏时没拒绝丢失未知条目:" + JSON.stringify(attempted));
        assert(SettingRepo.get("automation.watch.templates") === partial, "部分坏档原字节被覆盖");
      } finally {
        if (original !== null) SettingRepo.set("automation.watch.templates", original);
      }
    });

    /* 【MC-048 边角复核】真组件上验"删除失败 + 紧接着新增":
     * 面板**先以健康状态打开**(四条都在),随后设置被写坏(模拟主进程写盘失败/读不动
     * → 普通保存被拒),再点删除、紧接点存为模板:
     *   - 两种操作都必须**可见地失败**,不能把删除画成成功;
     *   - 界面列表与选择保持原样(不乐观确认),盘上原字节一字不动;
     *   - 恢复后同一对操作都成功,面板 = 盘上。 */
    await check("★ MC-048 边角:真组件删除失败 + 紧接着新增 → 可见失败、列表/选择不动、盘上不动", async () => {
      const original = SettingRepo.get("automation.watch.templates");
      assert(original !== null, "起点应有前一步保存的模板");
      // 关掉再开面板:先以健康状态读到四条(上一步已恢复有效设置)。
      await js("document.querySelector('div.fixed.inset-0.z-40')?.click()");
      await panelOpen();
      const names0 = await panelTemplateNames();
      assert(names0.includes("A 面板加的模板"), `恢复后面板应读到四条:${JSON.stringify(names0)}`);
      // 选中要删的那条,确认删除按钮可用。
      await js(`document.querySelector('[role=combobox]').click()`);
      await until(async () => (await js<number>("document.querySelectorAll('[role=option]').length")) > 0, "下拉展开");
      await js(`[...document.querySelectorAll('[role=option]')].find((el) => el.textContent.trim() === 'A 面板加的模板').click()`);
      await until(async () => (await js<boolean>(`(() => { const b = document.querySelector('button[title="删除这个模板"]'); return !!b && !b.disabled; })()`)), "删除按钮可用");
      // 盘上被写坏 → 主进程对普通保存一律拒绝(先于 CAS 的健康分类分支)。
      SettingRepo.set("automation.watch.templates", "{MC048 broken");
      const beforeRaw = SettingRepo.get("automation.watch.templates");
      try {
        await js(`document.querySelector('button[title="删除这个模板"]').click()`);
        await until(async () => (await js<string>("document.body.innerText")).includes("坏得读不出来"), "删除失败的错误在面板上可见");
        // 紧接着新增(同一面板、同一围栏)。
        await panelSaveTemplate("失败后新增", "echo must-not-land");
        await until(async () => (await js<string>("document.body.innerText")).includes("坏得读不出来"), "新增失败的错误在面板上可见");
        // 等待围栏回到 idle,再核对界面:四条一条不少、选择仍是被点的那条。
        await until(async () => (await js<boolean>(`(() => { const b = document.querySelector('button[title="删除这个模板"]'); return !!b && !b.disabled; })()`)), "围栏回到 idle");
        const names = await panelTemplateNames();
        assert(names.includes("A 面板加的模板"), `删除失败后界面却把模板去掉了:${JSON.stringify(names)}`);
        const selected = await js<string>("document.querySelector('[role=combobox]').textContent.trim()");
        assert(selected.includes("A 面板加的模板"), `删除失败后选择被清空:${selected}`);
        assert(SettingRepo.get("automation.watch.templates") === beforeRaw, "被拒的删除/新增改动了盘上原字节");
        assert(!(await js<string>("document.body.innerText")).includes("失败后新增"), "新增失败却出现在界面列表里(乐观确认)");
      } finally {
        if (original !== null) SettingRepo.set("automation.watch.templates", original);
      }
    });

    await check("★ MC-048 边角:恢复后真组件连续删一条、加一条 → 两笔都落盘且面板 = 盘上", async () => {
      // 关掉再开:围栏重读恢复后的盘上内容。
      await js("document.querySelector('div.fixed.inset-0.z-40')?.click()");
      await panelOpen();
      const names0 = await panelTemplateNames();
      assert(names0.includes("A 面板加的模板"), `恢复后面板应读到盘上四条:${JSON.stringify(names0)}`);
      // 选中「A 面板加的模板」并删除(真组件下拉 + 回收站按钮)。
      await js(`document.querySelector('[role=combobox]').click()`);
      await until(async () => (await js<number>("document.querySelectorAll('[role=option]').length")) > 0, "下拉展开");
      await js(`[...document.querySelectorAll('[role=option]')].find((el) => el.textContent.trim() === 'A 面板加的模板').click()`);
      await until(async () => (await js<boolean>("!!document.querySelector('button[title=\"删除这个模板\"]') && !document.querySelector('button[title=\"删除这个模板\"]').disabled")), "删除按钮可用");
      await js(`document.querySelector('button[title="删除这个模板"]').click()`);
      // 紧接着新增一条(包围栏排队/串行)。
      await panelSaveTemplate("删除后新增", "echo after-delete");
      await until(async () => {
        const names = await panelTemplateNames();
        return names.includes("删除后新增") && !names.includes("A 面板加的模板");
      }, "界面显示删除 + 新增的结果");
      const disk = await readTemplatesOnDisk();
      await reopenDb();
      const ids = disk.templates.map((t) => t.id);
      assert(!disk.templates.some((t) => t.name === "A 面板加的模板"), `被删的模板仍在盘上:${JSON.stringify(ids)}`);
      assert(disk.templates.some((t) => t.name === "删除后新增"), `新增没落盘:${JSON.stringify(ids)}`);
      // 盘上其余三条一条不少(两笔不是互相覆盖,而是叠加)。
      assert(disk.templates.length === 4, `盘上应有四条(原四条 - 删 1 + 加 1):${JSON.stringify(disk.templates.map((t) => t.name))}`);
    });

    await check("收尾：渲染端全程没有未捕获错误，库在套件目录里（不联网、不碰用户数据）", async () => {
      assert(rendererErrors.length === 0, `渲染端错误:${rendererErrors.join(" | ")}`);
      const page = await readFile(join(dir, "index.html"), "utf8");
      assert(page.includes("connect-src 'none'"), "测试页 CSP 应禁网");
      assert((await readFile(join(dir, "data", "mcode.db"))).byteLength > 0, "mcode.db 不存在");
    });
  } finally {
    try { flushDb(); } catch { /* 尽力 */ }
    try { closeDb(); } catch { /* 已关 */ }
    if (win && !win.isDestroyed()) win.destroy();
    await writeFile(evidence, JSON.stringify(checks, null, 2));
  }
}
