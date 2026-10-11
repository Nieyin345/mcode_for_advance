/**
 * Headless smoke for **面板截图**(`app_ui action:screenshot_panel`,报告 Q1)。
 *
 * ## 能验什么 / 验不了什么
 *
 * 真截屏要起 Electron(`webContents.capturePage` → 真实合成器),无头验不了"像素对不对"。
 * 所以这套验**能验的那部分**:
 *   1. 矩形纯函数 `computePanelCaptureRect` —— iframe 屏幕矩形 → `capturePage` rect 的
 *      裁剪逻辑(与窗口可见区求交、四舍五入、退化时报原因);
 *   2. `screenshot_panel` 拿到矩形后**确实把裁剪过的 rect 交给 `capturePage`**、返回的是
 *      image 内容块 + 存盘路径;
 *   3. **拿不到矩形 / 窗口最小化 / 窗口没开时如实报错**,而不是返回一张空图冒充成功
 *      (仓库硬规矩 3:坏东西显式报出来)。
 *
 * 主窗口用 `stubs/window.ts` 换掉(可控的假窗 + 假 NativeImage);真窗那套 `capturePage`
 * 只有上机才能验。
 *
 * Run: scripts/panel-screenshot-smoke/run.sh
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_CONTROL_RENDERER_GLOBAL } from "@contracts/appControl";
import { computePanelCaptureRect } from "@main/appControl/panelCaptureRect.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { invokeAppTool } from "@main/appControl/tools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import { savePngArtifact } from "@main/lib/screenshotStore.js";
import { registerPanelProbe } from "@renderer/components/customUi/panelReadback.js";
import { installAppControlHost } from "@renderer/lib/appControlHost.js";
import { setMainWindow, type FakeWindow } from "./stubs/window.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

/* ── 1. 纯函数:iframe 矩形 → capturePage rect ──
 *
 * 判据立在**用户能看到的结果**上:面板被滚动容器裁掉一半时,截到的就该是露出来的那半,
 * 而不是整块(那会把面板外的界面也截进来)、也不是空图。 */

// 伪 PNG 头,只为让 base64 非空、能被 ContentBlock 携带。
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

console.log("面板截图:矩形裁剪(纯函数)");
{
  const vp = { width: 800, height: 600 };

  // 正常:完全在视口内,原样。
  const inside = computePanelCaptureRect({ x: 10, y: 20, width: 100, height: 50 }, vp);
  check("完全在视口内 = 原样", inside.ok && inside.rect.x === 10 && inside.rect.y === 20 && inside.rect.width === 100 && inside.rect.height === 50, inside);

  // 上/左被裁:preview / tab 在滚动容器里,面板可能部分滚出视口左/上。
  const clippedTL = computePanelCaptureRect({ x: -30, y: -10, width: 100, height: 50 }, vp);
  check("★ 左/上被滚出 → 裁到可见的那块", clippedTL.ok && clippedTL.rect.x === 0 && clippedTL.rect.y === 0 && clippedTL.rect.width === 70 && clippedTL.rect.height === 40, clippedTL);

  // 右/下被裁:面板底边超出视口底部。
  const clippedBR = computePanelCaptureRect({ x: 750, y: 570, width: 100, height: 50 }, vp);
  check("★ 右/下超出视口 → 裁到底边/右边", clippedBR.ok && clippedBR.rect.x === 750 && clippedBR.rect.y === 570 && clippedBR.rect.width === 50 && clippedBR.rect.height === 30, clippedBR);

  // 四舍五入:小数矩形(CSS 可能给 .5)。契约是"输出整数 px",不是"对浮点减法精确取整"
  // —— 20.6+49.5-20.6 在二进制浮点里是 49.4999…,round 到 49 是正确行为。所以这里断言
  // 四个字段都是整数、且与输入值相差 ≤ 1。
  const frac = computePanelCaptureRect({ x: 10.4, y: 20.6, width: 99.5, height: 49.5 }, vp);
  const allInt = frac.ok && [frac.rect.x, frac.rect.y, frac.rect.width, frac.rect.height].every((n) => Number.isInteger(n));
  const near = frac.ok && Math.abs(frac.rect.x - 10) <= 1 && Math.abs(frac.rect.y - 21) <= 1 && Math.abs(frac.rect.width - 100) <= 1 && Math.abs(frac.rect.height - 50) <= 1;
  check("小数矩形四舍五入为整数 px(输出四字段都是整数)", allInt && near, frac);

  // 整个滚出视口右边 → 不 ok(截了会把窗口别处内容冒充面板)。
  const outside = computePanelCaptureRect({ x: 900, y: 0, width: 100, height: 50 }, vp);
  check("★ 整块滚出视口 → 不 ok(如实报,不截窗口别处)", !outside.ok && typeof outside.reason === "string", outside);

  // 尺寸为 0 → 不 ok。
  const zero = computePanelCaptureRect({ x: 10, y: 20, width: 0, height: 0 }, vp);
  check("面板尺寸为 0 → 不 ok", !zero.ok, zero);

  // 拿不到矩形(没挂上 / 没布局好)→ 不 ok。
  const none = computePanelCaptureRect(null, vp);
  check("量不到矩形 → 不 ok", !none.ok, none);

  // 窗口尺寸非法 → 不 ok(不能拿一个坏视口去求交)。
  const badVp = computePanelCaptureRect({ x: 10, y: 20, width: 100, height: 50 }, { width: 0, height: 0 });
  check("窗口可见区尺寸为 0 → 不 ok", !badVp.ok, badVp);
}

/* ── 2. 存盘核(零依赖,共用给浏览器截图)── */
console.log("\n面板截图:存盘核");
{
  const dir = process.env.MCODE_SMOKE_SHOT_DIR;
  if (!dir) throw new Error("MCODE_SMOKE_SHOT_DIR 没设 —— 本套拒绝写到真实目录");
  const p = savePngArtifact(FAKE_PNG, { baseDir: dir, sessionId: "sess-1", turnNumber: 3, toolCallId: "call-9" });
  check("★ 存盘返回路径且文件真的在", typeof p === "string" && existsSync(p), p);
  check("★ 目录按 会话/轮 组织", typeof p === "string" && p.includes(join("sess-1", "turn-3")), p);
  check("没有 sessionId → 不存(返回 null)", savePngArtifact(FAKE_PNG, { baseDir: dir, toolCallId: "x" }) === null);
  check("空数据 → 不存(返回 null)", savePngArtifact("", { baseDir: dir, sessionId: "s", toolCallId: "x" }) === null);
  const sanitized = savePngArtifact(FAKE_PNG, { baseDir: dir, sessionId: "a/b:c", turnNumber: 0, toolCallId: "c/d" });
  check("★ 会话 id / 调用 id 里的非法字符被消毒(不写出目录)", typeof sanitized === "string" && existsSync(sanitized) && !sanitized.includes("a/b"), sanitized);
}

/* ── 3. screenshot_panel 端到端(假窗 + 假 NativeImage)── */
console.log("\n面板截图:screenshot_panel 端到端");
{
  const shotDir = process.env.MCODE_SMOKE_SHOT_DIR!;
  // 设置里给了截图目录 → 存盘走它(不起 electron 的 Pictures 回落)。
  clearRpcHandlers();
  recordRpcHandler("setting:get", async (_e: unknown, raw: unknown) => {
    const k = (raw as { key?: string }).key;
    return { value: k === "browser.screenshotDir" ? shotDir : null };
  });

  // 假窗:记下每次 capturePage 的 rect。
  const capturedRects: unknown[] = [];
  const makeWindow = (): FakeWindow => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    webContents: {
      isDestroyed: () => false,
      capturePage: async (rect?: unknown) => {
        capturedRects.push(rect);
        return { isEmpty: () => false, toPNG: () => Buffer.from(FAKE_PNG, "base64") };
      },
    },
  });

  // 渲染端的假应答:回一个面板矩形 + 视口。
  let panelRectReply: unknown = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "float", rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 } } };
  const win: Record<string, unknown> = {
    [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
      const cmd = JSON.parse(raw) as { op: string };
      if (cmd.op === "panel_rect") return JSON.stringify(panelRectReply);
      return JSON.stringify({ ok: true });
    },
  };
  (globalThis as Record<string, unknown>).window = win;
  setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });

  // ① 正常:拿到裁剪过的 rect,交 capturePage,回 image 块 + 路径。
  {
    setMainWindow(makeWindow());
    capturedRects.length = 0;
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel", item_id: "p1" }, "sess-1", {} as never);
    const img = r.content.find((c) => c.type === "image") as { data?: string; mimeType?: string } | undefined;
    check("★ 拿到矩形后返回 image 内容块", !r.isError && img?.mimeType === "image/png" && (img?.data ?? "").length > 0, textOf(r).slice(0, 120));
    check("★ 交给 capturePage 的是裁剪后的整数 rect", JSON.stringify(capturedRects.at(-1)) === JSON.stringify({ x: 10, y: 20, width: 100, height: 50 }), capturedRects.at(-1));
    check("★ 文案带面板名 + 尺寸", textOf(r).includes("我的面板") && textOf(r).includes("100×50"), textOf(r));
    check("★ 文案带存盘路径", /已保存到:.*\.png/.test(textOf(r)), textOf(r));
    // 落盘目录里确实多了一个 png。
    const sessDir = join(shotDir, "sess-1");
    const pngs = existsSync(sessDir) ? readdirSync(join(sessDir, "turn-0")) : [];
    check("★ 图真的落了盘(turn-0 下有 png)", pngs.some((f) => f.endsWith(".png")), pngs);
    // ★ D10:读不到图的模型必须有退路 —— 文案要点名路径 + agent_read_image。
    check("★ 文案点名「读不到图就用路径 + agent_read_image {describe:true}」", textOf(r).includes("agent_read_image") && textOf(r).includes("describe"), textOf(r));
  }

  // ② 拿不到矩形(null):**如实报错**,不是返回空图。
  {
    setMainWindow(makeWindow());
    capturedRects.length = 0;
    panelRectReply = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "float", rect: null, viewport: { width: 800, height: 600 } } };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "sess-1", {} as never);
    check("★ 量不到矩形 → 如实报错(不返回空图)", r.isError === true && textOf(r).includes("失败"), textOf(r));
    check("★ 拿不到矩形时**没有**去调 capturePage", capturedRects.length === 0, capturedRects);
  }

  // ③ 面板被滚出视口 → 报错。
  {
    setMainWindow(makeWindow());
    capturedRects.length = 0;
    panelRectReply = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "tab", rect: { x: 5000, y: 0, width: 100, height: 50 }, viewport: { width: 800, height: 600 } } };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "sess-1", {} as never);
    check("★ 面板滚出视口 → 如实报错", r.isError === true, textOf(r));
    check("★ 滚出视口时没有去调 capturePage", capturedRects.length === 0);
  }

  // ④ 渲染端说没有这个面板(id 不存在)→ 原样把原因带回。
  {
    setMainWindow(makeWindow());
    panelRectReply = { ok: false, error: "没有正在渲染 id 为「nope」的面板。" };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel", item_id: "nope" }, "sess-1", {} as never);
    check("★ 面板不存在 → 原样带回渲染端的原因", r.isError === true && textOf(r).includes("nope"), textOf(r));
  }

  // ⑤ 窗口最小化 → 如实报错,不截空图。
  {
    setMainWindow({ ...makeWindow(), isMinimized: () => true });
    capturedRects.length = 0;
    panelRectReply = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "float", rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 } } };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "sess-1", {} as never);
    check("★ 窗口最小化 → 如实报错(不返回空图)", r.isError === true && textOf(r).includes("最小化"), textOf(r));
    check("★ 最小化时没有去调 capturePage", capturedRects.length === 0);
  }

  // ⑥ 主窗口没开 → 如实报错。
  {
    setMainWindow(null);
    panelRectReply = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "float", rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 } } };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "sess-1", {} as never);
    check("★ 主窗口没开 → 如实报错", r.isError === true && textOf(r).includes("窗口"), textOf(r));
  }

  // ⑦ 空图(截了个纯空 NativeImage)→ 如实报错,不冒充成功。
  {
    let calls = 0;
    setMainWindow({
      ...makeWindow(),
      webContents: {
        isDestroyed: () => false,
        capturePage: async () => {
          calls++;
          return { isEmpty: () => true, toPNG: () => Buffer.alloc(0) };
        },
      },
    });
    panelRectReply = { ok: true, data: { itemId: "p1", label: "我的面板", mode: "float", rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 } } };
    const r = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "sess-1", {} as never);
    check("★ 截到空图 → 如实报错(不冒充成功)", r.isError === true && textOf(r).includes("空图"), textOf(r));
    check("空图会重试一次(共 2 次 capturePage)", calls === 2, calls);
  }

  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  setMainWindow(null);
}

/* ── 3b. 渲染端 `panel_rect` 分支(真 handler,不只是 stub)──
 *
 * `appControlHost.ts` 是"界面那半"的 mcode-app —— 从前没有套件覆盖它。这里把**真的**
 * `installAppControlHost()` 挂上,直接走 `panel_rect` 那条分支:验它从注册表挑到面板后,
 * 回的是 `{rect, viewport}` 且 `rect` 与 handle 量的一致;没面板 / rect 为 null 时如实。 */
console.log("\n面板截图:渲染端 panel_rect 分支");
{
  const w: Record<string, unknown> = { innerWidth: 800, innerHeight: 600 };
  (globalThis as Record<string, unknown>).window = w;
  installAppControlHost();
  const call = async (cmd: unknown): Promise<{ ok: boolean; error?: string; data?: { rect?: unknown; viewport?: unknown } }> => {
    const fn = (w[APP_CONTROL_RENDERER_GLOBAL] as (raw: string) => Promise<string>);
    return JSON.parse(await fn(JSON.stringify(cmd)));
  };

  // 没挂面板 → 如实报错(且不谎报有面板)。
  const none = await call({ op: "panel_rect" });
  check("★ 没有面板时 panel_rect 如实报错", none.ok === false && String(none.error).includes("没有正在渲染"), none);

  // 挂了带 rect 的 handle → 回 rect + viewport。
  const off = registerPanelProbe({
    itemId: "p1", label: "L", mode: "float",
    probe: async () => ({ __mcode: 1 as const, probe: "x", text: "", html: "", textLength: 0, htmlLength: 0, url: "" }),
    rect: () => ({ x: 5, y: 6, width: 100, height: 50 }),
  });
  const hit = await call({ op: "panel_rect", itemId: "p1" });
  check("★ panel_rect 回注册表里量的 rect", hit.ok === true && JSON.stringify(hit.data?.rect) === JSON.stringify({ x: 5, y: 6, width: 100, height: 50 }), hit);
  check("★ panel_rect 连同量 rect 的那个视口一起回(坐标自洽)", JSON.stringify(hit.data?.viewport) === JSON.stringify({ width: 800, height: 600 }), hit.data?.viewport);
  off();

  // rect() 返回 null → 原样回 null(不编假矩形),ok 仍为 true(让 main 侧去判断能不能截)。
  const off2 = registerPanelProbe({
    itemId: "p2", label: "L2", mode: "tab",
    probe: async () => ({ __mcode: 1 as const, probe: "x", text: "", html: "", textLength: 0, htmlLength: 0, url: "" }),
    rect: () => null,
  });
  const n = await call({ op: "panel_rect", itemId: "p2" });
  check("★ rect() 为 null 时原样回 null(不编假矩形)", n.ok === true && n.data?.rect === null, n);
  off2();

  delete (globalThis as Record<string, unknown>).window;
}

/* ── 4. 接线:screenshot_panel 在 UI_ACTIONS 里,描述点名退路 ── */
console.log("\n面板截图:接线");
{
  const { appMcpTools } = await import("@main/appControl/tools.js");
  const uiTool = appMcpTools().find((t) => t.name === "app_ui");
  check("app_ui 工具在", uiTool !== undefined);
  // 描述里必须点名 screenshot_panel + 那条"读不到图"的退路(D10)。
  const desc = uiTool?.description ?? "";
  check("★ 描述里有 screenshot_panel", desc.includes("screenshot_panel"), desc.slice(0, 80));
  check("★ 描述点名「很多模型读不到图」的退路", desc.includes("读不到图") && desc.includes("agent_read_image"), desc.slice(0, 80));
}

/* ── 5. Codex 出口不许把 image 块静默拍成文本 ──────────────────────────────
   面板截图(以及 browser_screenshot)返回的是一张**图**。Codex 的动态工具返回没有
   MCP 的 content 多态,要自己把块转成它的形状 —— 从前 app 工具那一支把每个块一律拍成
   `inputText`,**image 块被静默丢掉**:截图在 Codex 上白截,而且和 browser_* 待遇不一致
   (报告 D10 的"静默失败"原样)。这一条**读实现源码**验两支共用同一份转换,而不是各写一份
   —— 因为"两处应当一致"正是它坏掉的方式(改一处忘一处)。
   ⚠️ 这是源码级断言(该转换函数是 Codex provider 内的私有函数,整套打它的 bundle 太重);
   真正的行为验要靠起 Codex 引擎,不在无头范围。 */
console.log("\n面板截图:Codex image 块出口");
{
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const src = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8");
  // app 工具那一支必须走 `toContent`(会把 image → inputImage),不能自己 map 成 inputText。
  // ⚠️ 判据要**具体到那一行代码**,不能用切片后 includes 模糊判断 —— 注释里也会出现
  // `inputText` 字样,切片一长/一短就会误判(这条断言自己就先踩过一次)。
  const start = src.indexOf("if (isAppToolName(name)) {");
  check("找得到 app 工具分支", start >= 0);
  const branch = src.slice(start, src.indexOf("\n  }", start));
  check(
    "★ app 工具出口走共享的 toContent(不再把 image 块拍成 inputText)",
    branch.includes("toContent(result)") && !branch.includes('type: "inputText"'),
    branch.replace(/\s+/g, " ").slice(0, 200),
  );
  // 而且那份转换真的认 image → inputImage(别是空壳)。
  check(
    "★ toContent 真的把 image 块转成 inputImage",
    /b\.type === "image"[\s\S]{0,160}inputImage/.test(src),
  );
}

console.log(`\n${passed}/${passed + failures.length} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
