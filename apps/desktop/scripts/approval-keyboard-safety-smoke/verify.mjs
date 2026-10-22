/**
 * T6 — 审批卡键盘/焦点/拒绝路径的隔离动态断言（真 Chromium，E1）。
 *
 * 每条判据都建立在用户看到/按键感受到的那一层：真实 DOM、真实焦点
 * (document.activeElement)、CDP 派发的真 keyDown/keyUp、真 Base UI Dialog。
 * 不读源码字符串，不用假 React 运行时。
 *
 * 已确认安全、本次无需修改的路径也写成正控断言 —— 它们保护现有行为不被将来改坏。
 */
import { withAuditPage } from "./browser.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];

await withAuditPage(here, async (page) => {
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`);
  };
  const test = async (name, fn) => {
    try { await fn(); } catch (e) { check(`${name} (no exception)`, false, String(e)); }
    check(`${name} / no uncaught page errors`, page.exceptions.length === 0, page.exceptions.slice());
  };
  const sleep = (ms) => page.sleep(ms);
  const configure = async (cfg, keepKey = false) => {
    await page.eval(`labConfigure(${JSON.stringify(cfg)}, ${keepKey})`);
    await sleep(80);
  };
  const decisions = () => page.eval("labDecisions.slice()");
  const clearDecisions = () => page.eval("labClear()");
  const key = async (k, vk, text) => {
    const base = { key: k, code: k, windowsVirtualKeyCode: vk };
    // Enter 必须带 text——CDP 不带 text 时只派发 raw keydown，浏览器不会执行
    // 「按钮的 Enter 默认激活」；那样"主动聚焦后 Enter 批准"的正控会永远空过。
    await page.send("Input.dispatchKeyEvent", text ? { type: "keyDown", ...base, text, unmodifiedText: text } : { type: "keyDown", ...base });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(60);
  };
  const Enter = () => key("Enter", 13, "\r");
  const Escape = () => key("Escape", 27);
  const focusOn = (sel) => page.eval(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);
  const activeInfo = () =>
    page.eval(`(()=>{const a=document.activeElement;return {tag:a?.tagName??null,id:a?.id??null,role:a?.getAttribute?.("role")??null,text:(a?.textContent??"").trim().slice(0,24),disabled:!!a?.disabled}})()`);
  const focusCard = async (sel = "[role=alertdialog]") => {
    await page.eval(`document.querySelector(${JSON.stringify(sel)})?.focus()`);
    await sleep(30);
  };
  /** 按**精确**按钮文字点击（"始终允许 …"含"允许"，不能用 includes 找「允许」）。 */
  const clickExact = async (sel, text) => {
    const rect = await page.eval(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>(e.textContent||"").trim()===${JSON.stringify(text)});if(!b)return null;b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if (!rect) throw Error(`missing button: ${sel} / ${text}`);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect });
    await sleep(80);
  };
  const buttonTexts = (sel = "[role=alertdialog] button") =>
    page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>(e.textContent||"").trim())`);
  const allowDisabled = () =>
    page.eval(`(()=>{const b=[...document.querySelectorAll("[role=alertdialog] button")].find(e=>(e.textContent||"").trim()==="允许");return b?b.disabled:null;})()`);
  const mcpOutcome = () =>
    page.eval(`document.querySelector("section[data-mcp-tool-status]")?.getAttribute("data-mcp-tool-status") ?? null`);

  await page.goto("", "window.__ready===true && document.querySelector('#elsewhere')");

  // ─────────────────────────────────────────────────────────────────────
  // A. 无意 Enter 不授权
  // ─────────────────────────────────────────────────────────────────────
  await test("initial-focus-not-on-allow", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    const info = await activeInfo();
    check("★ 开卡后焦点不在「允许」按钮上(乱回车不会批准)", info.text !== "允许" && info.role === "alertdialog", info);
    check("开卡后「允许」处于短延迟禁用态", (await allowDisabled()) === true);
    check("开卡后「拒绝」立即可用(fail-closed 不延迟)", await page.eval(`(()=>{const b=[...document.querySelectorAll("[role=alertdialog] button")].find(e=>(e.textContent||"").trim()==="拒绝");return !!b && !b.disabled;})()`));
  });

  await test("stray-enter-during-arming", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await Enter();
    await Enter();
    check("★ 开卡瞬间连按 Enter 不产生任何审批决策", (await decisions()).length === 0, await decisions());
  });

  await test("enter-after-arming-requires-deliberate-focus", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await sleep(650); // > APPROVAL_ARM_DELAY_MS
    await Enter();
    check("★ 武装到期后、焦点仍在卡片上时 Enter 不批准(必须主动把焦点移到按钮)", (await decisions()).length === 0, await decisions());
    // 用户主动把焦点移到「允许」再 Enter —— 这才是明确同意，且只批一次。
    await page.eval(`(()=>{const b=[...document.querySelectorAll("[role=alertdialog] button")].find(e=>(e.textContent||"").trim()==="允许");b.focus();})()`);
    await sleep(30);
    await Enter();
    const ds = await decisions();
    check("主动聚焦「允许」后 Enter 恰好批准一次且不带 always", ds.length === 1 && ds[0].granted === true && ds[0].always !== true, ds);
  });

  // ─────────────────────────────────────────────────────────────────────
  // B. Esc = 拒绝（现状合同：Esc 是拒绝，不是"悄悄关掉"）
  // ─────────────────────────────────────────────────────────────────────
  await test("escape-denies-while-arming", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await focusCard();
    await Escape();
    const ds = await decisions();
    check("★ 开卡延迟期内 Esc 立即产生拒绝(fail-closed 不等武装)", ds.length === 1 && ds[0].granted === false && ds[0].always === undefined, ds);
  });

  await test("escape-does-not-leak-to-window", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await page.eval("labPropagation=0");
    await focusCard();
    await Escape();
    check("★ 卡上 Esc 被 stopPropagation，不再落到窗口级监听(不会顺带关掉别的东西)", (await page.eval("labPropagation")) === 0, await page.eval("labPropagation"));
  });

  await test("escape-outside-card-is-ignored", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await page.eval(`document.querySelector("#elsewhere").focus()`);
    await Escape();
    check("焦点在卡外时 Esc 不替用户做拒绝决定(键盘决策是本卡局部的)", (await decisions()).length === 0, await decisions());
  });

  // ─────────────────────────────────────────────────────────────────────
  // C. IME 合成不得误触拒绝
  // ─────────────────────────────────────────────────────────────────────
  await test("ime-composition-escape-is-not-a-denial", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await focusCard();
    // 真实 CDP 无法稳定构造 IME 合成态 —— 用**同形**的合成事件驱动生产守卫
    // （它读的就是 e.nativeEvent.isComposing / keyCode===229，这是唯一入口）。
    await page.eval(`(()=>{const c=document.querySelector("[role=alertdialog]");const e=new KeyboardEvent("keydown",{key:"Escape",code:"Escape",isComposing:true,bubbles:true,cancelable:true});c.dispatchEvent(e);})()`);
    check("★ 输入法合成中的 Esc(取消候选词)不得被当成拒绝", (await decisions()).length === 0, await decisions());
    await page.eval(`(()=>{const c=document.querySelector("[role=alertdialog]");const e=new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true,cancelable:true});Object.defineProperty(e,"keyCode",{value:229});c.dispatchEvent(e);})()`);
    check("keyCode=229 的 Esc 同样不得被当成拒绝", (await decisions()).length === 0, await decisions());
    // 对照：非合成 Esc 仍必须拒绝（防上面两条空过）。
    await Escape();
    check("非合成 Esc 仍正常拒绝(正控)", (await decisions()).filter((d) => d.granted === false).length === 1, await decisions());
  });

  // ─────────────────────────────────────────────────────────────────────
  // D. 隐藏 / 非活动卡不抢焦点、不吃键
  // ─────────────────────────────────────────────────────────────────────
  await test("hidden-card-does-not-steal-focus", async () => {
    await configure({ kind: "approval", toolName: "Bash", hidden: true });
    await page.eval(`document.querySelector("#elsewhere").focus()`);
    await sleep(40);
    check("★ 隐藏(display:none)的后台审批卡挂载后不抢当前焦点", await focusOn("#elsewhere"), await activeInfo());
    await clearDecisions();
    await Escape();
    check("隐藏卡在场时前台 Esc 不产生后台审批决策", (await decisions()).length === 0, await decisions());
  });

  await test("inactive-card-cannot-decide", async () => {
    await configure({ kind: "approval", toolName: "Bash", active: false });
    await clearDecisions();
    await focusCard();
    await Escape();
    await clickExact("[role=alertdialog] button", "拒绝");
    check("★ 非活动会话的审批卡：Esc 与点「拒绝」都不产生决策", (await decisions()).length === 0, await decisions());
  });

  // ─────────────────────────────────────────────────────────────────────
  // E. 模态打开时卡不抢焦点（真实缺陷 #1）
  // ─────────────────────────────────────────────────────────────────────
  await test("modal-open-blocks-card-autofocus", async () => {
    // 生产顺序：模态**已经开着**（用户打开了设置/命令面板），审批卡随后到达
    // （新一轮 approval.request 推来）。先只开弹窗、等它拿到焦点，再挂卡片。
    await configure({ modalOpen: true, showCard: false });
    await page.waitFor(`document.activeElement === document.querySelector("#modal-input")`);
    await page.eval("labFocusLog=[]");
    await configure({ modalOpen: true, showCard: true, kind: "approval", toolName: "Bash" });
    await sleep(150);
    const inModal = await page.eval(`(()=>{const p=document.querySelector('[aria-label="modal-under-test"]');return !!p && p.contains(document.activeElement);})()`);
    const info = await activeInfo();
    // 只看最终 activeElement 不够：Base UI 的焦点守卫会在 focusin 时把焦点
    // 抢回弹窗，最终态永远"正确"，中途那一抢却被掩盖。焦点日志能证明审批卡
    // **从未**在模态打开期间把焦点拉到自己身上。
    const log = await page.eval("labFocusLog.slice()");
    check("★ 模态已打开时，后到的审批卡不得把焦点从弹窗里抢走(焦点从未落到卡片)", inModal && !log.some((e) => e.startsWith("card:")), { inModal, log, active: info });
  });

  await test("neutral-aria-modal-false-does-not-block-autofocus", async () => {
    await configure({ kind: "approval", toolName: "Bash", neutralDialog: true });
    await sleep(120);
    check("流内 role=dialog aria-modal=false(如提问卡)不阻止审批卡获得初始焦点(正控)", await focusOn("[role=alertdialog]"), await activeInfo());
  });

  // ─────────────────────────────────────────────────────────────────────
  // F. 队列换头立即重新武装（渲染期复位，不留一帧可点）
  // ─────────────────────────────────────────────────────────────────────
  await test("queue-shift-rearms-in-render-phase", async () => {
    await configure({ kind: "approval", toolName: "Bash", queuePosition: 1, queueTotal: 2 });
    await sleep(650);
    check("第一张卡武装到期后「允许」可点(正控)", (await allowDisabled()) === false);
    // 保持同一组件实例、只换队列头：arming 必须在渲染阶段复位，不留可点的一帧。
    await configure({ kind: "approval", toolName: "Bash", queuePosition: 2, queueTotal: 2 }, true);
    check("★ 队列换头的同一帧「允许」立即回到禁用(不继承上一张的武装)", (await allowDisabled()) === true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // G. 危险方法：没有「始终允许」，授权也不能升级为 always
  // ─────────────────────────────────────────────────────────────────────
  await test("danger-tool-has-no-always-allow", async () => {
    await configure({ kind: "approval", toolName: "mcode-app-danger:terminal.exec" });
    await sleep(650);
    const texts = await buttonTexts();
    check("★ danger 卡没有「始终允许」按钮", !texts.some((t) => t.includes("始终允许")), texts);
    check("★ danger 卡连勾选框一起消失（文案栏直接声明每次本人批，不是留个死复选框）", await page.eval(`(()=>{
      const card=document.querySelector("[role=alertdialog]");
      const text=(card?.textContent||"");
      return !card?.querySelector("input[type=checkbox]") && text.includes("每次都需要你本人批准");
    })()`), await page.eval(`document.querySelector("[role=alertdialog]")?.textContent?.slice(0,80)`));
    await clearDecisions();
    await clickExact("[role=alertdialog] button", "允许");
    const ds = await decisions();
    check("★ danger 卡点「允许」只产生一次性授权，always 绝不置 true", ds.length === 1 && ds[0].granted === true && ds[0].always === undefined, ds);
  });

  await test("mcp-allow-once-never-sets-always", async () => {
    await configure({ kind: "approval", toolName: "mcp__srv__write_file" });
    await sleep(650);
    const texts = await buttonTexts();
    check("普通 MCP 卡具备 always-allow 入口(正控，防本组空过)", texts.some((t) => t.includes("始终允许")), texts);
    await clearDecisions();
    await page.eval(`(()=>{const b=[...document.querySelectorAll("[role=alertdialog] button")].find(e=>(e.textContent||"").trim()==="允许");b.click();})()`);
    await sleep(60);
    const ds = await decisions();
    check("★ MCP「允许一次」= granted:true 且 always 不为 true", ds.length === 1 && ds[0].granted === true && ds[0].always !== true, ds);
  });

  // ─────────────────────────────────────────────────────────────────────
  // H. McpToolDecisionCard 只读、状态只来自 props（真实缺陷 #2）
  // ─────────────────────────────────────────────────────────────────────
  await test("mcp-card-is-read-only", async () => {
    await configure({ kind: "mcp", toolName: "mcp__srv__read", status: "running", result: "" });
    await sleep(120);
    check("MCP 结果卡里没有可点的授权控件(授权只归 ApprovalPrompt)", (await page.eval(`document.querySelectorAll("section[data-mcp-tool-status] button").length`)) === 0);
    check("运行中的 MCP 卡显示 running", (await mcpOutcome()) === "running", await mcpOutcome());
    const before = await mcpOutcome();
    await sleep(700);
    const after = await mcpOutcome();
    check("★ 卡不靠定时器自己改成终态(status 只来自 props)", before === after, { before, after });
  });

  await test("mcp-card-turn-ended-is-not-success", async () => {
    // 真实现场：turn.done 把仍在 running 的 tool 收成 status:"done" +
    // result "(no result — turn ended)"（sessionStore.ts 的 turn.done 分支）。
    // 用户中断回合、或有审批尚未决定时，工具从未真正执行 —— 这不是成功。
    await configure({ kind: "mcp", toolName: "mcp__srv__read", status: "done", result: "(no result — turn ended)" });
    await sleep(120);
    const outcome = await mcpOutcome();
    check("★ 回合结束仍无结果的 MCP 工具不得显示为「已完成」", outcome !== "success" && outcome !== "running", { outcome });
  });

  await test("mcp-card-error-not-success", async () => {
    await configure({ kind: "mcp", toolName: "mcp__srv__read", status: "error", result: "用户拒绝了这次操作,未执行。" });
    await sleep(120);
    const outcome = await mcpOutcome();
    check("★ 被拒绝/失败的 MCP 调用不得显示为成功", outcome !== "success", { outcome });
  });

  await test("mcp-card-success-positive-control", async () => {
    await configure({ kind: "mcp", toolName: "mcp__srv__read", status: "done", result: "file content ok" });
    await sleep(120);
    check("真成功仍是 success(正控，防上面两条空过)", (await mcpOutcome()) === "success", await mcpOutcome());
  });

  // ─────────────────────────────────────────────────────────────────────
  // I. 拒绝后仍可继续操作
  // ─────────────────────────────────────────────────────────────────────
  await test("after-deny-focus-is-free", async () => {
    await configure({ kind: "approval", toolName: "Bash" });
    await clearDecisions();
    await focusCard();
    await Escape();
    check("拒绝决策已产生", (await decisions()).length === 1, await decisions());
    await page.eval(`document.querySelector("#elsewhere").focus()`);
    await Escape();
    check("拒绝之后焦点可移出卡片，且后续 Esc 不重复产生拒绝", (await decisions()).length === 1 && (await focusOn("#elsewhere")), await decisions());
  });

  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`approval-keyboard-safety-smoke: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) throw Error(`${failed.length} assertions failed; artifacts: ${here}`);
});
