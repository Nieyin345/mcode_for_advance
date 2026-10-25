/**
 * T16 —— U1 旅程执行器（跑在**真 Electron 主进程**里的探针）。
 *
 * 与 ARC-005 visual baseline 的分工（写死，别混）：
 *  - baseline：摆场景 → capturePage ×39 → 静态比对；不点击、不输入、不重开；
 *  - 本执行器：真 BrowserWindow + 真 `sendInputEvent` 鼠标点击 + 真 `insertText`
 *    键入 + 真 OS 子进程重开 + 三档断言（dom / visual / sideEffect），每一步
 *    都落证据，失败保留现场。
 *
 * ## 断言的判定只有一处
 *
 * 所有断言最终都走 {@link assertionStatus} —— 变异验证（`--mutation=unconditional-pass`）
 * 只替换这一行，第三条「故意失败」旅程就必须由真失败变全绿。别把这个判断散到
 * 各处，否则变异验证就证明不了「之前真的在判」。
 *
 * ## 重开协议（与 build.mjs 的约定）
 *
 * 旅程里出现 `relaunch` 步骤时：先把 `state.json`（已完成到第几步、已有证据、
 * 副作用快照、截图哈希、PID）原子写盘，再 `app.exit(RELAUNCH_EXIT=77)`。启动器
 * 看到 77 就换一个**新 OS 进程**，带着同一份 state 从下一步继续。证据里的
 * `pid`/`generation` 因此能证明「真的换了进程」，而不是页内刷新。
 */
// @smoke-covers src/preload/index.ts
// ↑ 【T153】本套件通过 build.mjs:215 的 esbuild `entryPoints` 直接打包产品 preload，
//   那条覆盖边不是 import，依赖图看不见。声明是它唯一能被记录的途径。
import { app, BrowserWindow, nativeTheme, screen, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stepName } from "./steps.js";
import { classifyJourney, literalStatus } from "./verdict.js";
import type { SideEffectRecord, U1Evidence, U1Journey, U1JourneyResult, U1SetupResult, U1Step, U1StepRuntime } from "./types.js";

/** 启动器看到这个退出码 = 「还要再来一代进程」。 */
export const RELAUNCH_EXIT = 77;

/**
 * 断言判定的**唯一**出口。变异验证会把这行替换成 `return "PASS";` ——
 * 于是所有断言无条件通过、第三条故意失败旅程不再失败。改这里之前先读文件头。
 */
export function assertionStatus(ok: boolean): "PASS" | "FAIL" {
  return ok ? "PASS" : "FAIL";
}

interface State {
  journeyIndex: number;
  generation: number;
  stepOffset: number;
  pids: number[];
  evidence: U1Evidence[];
  sideEffects: Record<string, SideEffectRecord>;
  screenshots: Record<string, { file: string; sha256: string }>;
  done: boolean;
  failedStep: string | null;
  startedAt: number;
  /** Armed synchronously before SIGKILL; supervisor must observe abnormal exit. */
  crashArmed?: { pid: number; generation: number; stepOffset: number };
  /** Set only by the supervisor after checking the OS child really died. */
  confirmedCrash?: { pid: number; generation: number; status: number | null; signal: string | null };
}

interface Ctx {
  dir: string;          // 本旅程证据根目录
  buildDir: string;
  runDir: string;
  dataDir: string;
  projectDir: string;
  docPath: string;
  state: State;
  stateFile: string;
  journey: U1Journey;
  win: BrowserWindow | null;
  wc: WebContents | null;
  defaultTimeoutMs: number;
  /** `launch.setup` 的返回值（没有钩子时为 null）。 */
  setupResult: U1SetupResult | null;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** 旅程文件里的 `@doc` / `@db` / `@projectDir` / `@home` 占位符 → 真实临时路径。 */
export function resolveFixturePath(value: string, env: { docPath: string; dataDir: string; projectDir: string; homeDir: string }): string {
  return value
    .replaceAll("@doc", env.docPath)
    .replaceAll("@db", join(env.dataDir, "mcode.db"))
    .replaceAll("@projectDir", env.projectDir)
    .replaceAll("@home", env.homeDir);
}

/* ─────────────────────────── Electron 交互助手 ─────────────────────────── */

async function js<T>(wc: WebContents, expression: string): Promise<T> {
  return (await wc.executeJavaScript(expression, true)) as T;
}

/** 找元素（可带文本过滤），返回几何 + 命中数；点击坐标取第一个可见命中中心。 */
async function probeElement(wc: WebContents, selector: string, text?: string): Promise<{
  count: number;
  visible: number;
  /** 可见且文本匹配的命中数（无文本过滤时等于 visible）。 */
  matched: number;
  found: boolean;
  x: number;
  y: number;
  textSlice: string | null;
  attrs: Record<string, string | null>;
}> {
  return js(
    wc,
    `(() => {
      const sel = ${JSON.stringify(selector)};
      const want = ${JSON.stringify(text ?? null)};
      let all = [];
      try { all = [...document.querySelectorAll(sel)]; } catch { return { count: -1, visible: 0, matched: 0, found: false, x: 0, y: 0, textSlice: null, attrs: {} }; }
      const vis = all.filter((el) => el.getClientRects().length > 0);
      const pool = (want === null ? vis : vis.filter((el) => (el.textContent || "").includes(want)));
      const el = pool[0] ?? null;
      if (!el) return { count: all.length, visible: vis.length, matched: pool.length, found: false, x: 0, y: 0, textSlice: null, attrs: {} };
      const r = el.getBoundingClientRect();
      return {
        count: all.length, visible: vis.length, matched: pool.length, found: true,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        textSlice: (el.textContent || "").slice(0, 200),
        attrs: {
          "aria-selected": el.getAttribute("aria-selected"),
          "aria-current": el.getAttribute("aria-current"),
          class: (el.getAttribute("class") || "").slice(0, 160),
          "data-testid": el.getAttribute("data-testid"),
        },
      };
    })()`,
  );
}

/** 轮询直到 predicate 成立或超时。返回 true/false，从不抛错（抛错会丢掉证据）。 */
async function until(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await predicate(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() > end) return false;
    await sleep(120);
  }
}

/** 保证窗口真的有 OS 焦点（sendInputEvent 的键盘事件依赖它；鼠标一般不需要，
 *  但沿用 settings-focus-electron-smoke 的纪律：先证明，再派事件）。 */
async function ensureFocus(ctx: Ctx): Promise<boolean> {
  if (!ctx.win || !ctx.wc) return false;
  const has = await js<boolean>(ctx.wc, "document.hasFocus()").catch(() => false);
  if (has) return true;
  ctx.win.focus();
  return until(() => js<boolean>(ctx.wc!, "document.hasFocus()"), 3000);
}

/** DOM 快照摘要 + 完整 HTML 落盘（失败现场尤其需要）。 */
async function captureDomSnapshot(ctx: Ctx, step: string): Promise<unknown> {
  if (!ctx.wc) return null;
  // T7：`WebContentsView` 可能已被**上一步**关闭（生产 `documentView:close`）。
  // 对已销毁的 webContents 调 `executeJavaScript` 不 reject 而是永久挂起 ——
  // relaunch 的证据抓取因此把整个进程拖到 150s 超时。`isDestroyed()` 对
  // 「`webContents.close()` 之后」的 view 仍返回 false（实测），所以**再加一层
  // 有界超时**：JS 表达式 5s 内不回来就当没有 DOM 快照。
  if (ctx.wc.isDestroyed()) return { destroyed: true };
  const summary = await Promise.race([
    js<Record<string, unknown>>(
      ctx.wc,
      `(() => {
        const html = document.documentElement ? document.documentElement.outerHTML : "";
        return {
          title: document.title,
          url: location.href,
          nodes: document.querySelectorAll("*").length,
          bodyText: (document.body ? document.body.innerText : "").slice(0, 400),
          htmlSha256: null,
          htmlLength: html.length,
        };
      })()`,
    ).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (!summary) return null;
  const html = await Promise.race([
    js<string>(ctx.wc, "document.documentElement ? document.documentElement.outerHTML : ''").catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
  ]);
  const htmlFile = join(ctx.dir, "dom", `${step}-g${ctx.state.generation}.html`);
  mkdirSync(join(ctx.dir, "dom"), { recursive: true });
  writeFileSync(htmlFile, html);
  return { ...summary, htmlSha256: sha256(html), htmlFile: htmlFile.slice(ctx.dir.length + 1) };
}

async function takeScreenshot(ctx: Ctx, name: string): Promise<{ file: string; sha256: string } | null> {
  if (!ctx.wc) return null;
  try {
    const image = await ctx.wc.capturePage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    mkdirSync(join(ctx.dir, "shots"), { recursive: true });
    const file = join(ctx.dir, "shots", `${name}.png`);
    writeFileSync(file, png);
    return { file: file.slice(ctx.dir.length + 1), sha256: sha256(png) };
  } catch (e) {
    // T7：`WebContentsView` 的 webContents 在窗口完全离屏时可能 capturePage 失败
    //（实测 `Failed to capture screenshot`）。退一步抓宿主窗口 —— 编辑器的
    // 子视图会一起入画（它是 contentView 的子视图），证据仍然成立。
    console.log(`U1 screenshot fallback (${name}): ${e instanceof Error ? e.message : String(e)}`);
    if (ctx.win && !ctx.win.isDestroyed()) {
      try {
        const image = await ctx.win.webContents.capturePage();
        if (!image.isEmpty()) {
          const png = image.toPNG();
          mkdirSync(join(ctx.dir, "shots"), { recursive: true });
          const file = join(ctx.dir, "shots", `${name}.png`);
          writeFileSync(file, png);
          return { file: file.slice(ctx.dir.length + 1), sha256: sha256(png) };
        }
      } catch { /* 两处都失败 = 没有截图证据 */ }
    }
    return null;
  }
}

/* ───────────────────────────── 副作用（磁盘） ───────────────────────────── */

function snapshotFile(path: string): SideEffectRecord {
  const at = new Date().toISOString();
  try {
    const buf = readFileSync(path);
    return { path, sha256: sha256(buf), bytes: buf.length, at };
  } catch {
    return { path, sha256: null, bytes: null, at };
  }
}

/* ───────────────────────────── 判定与证据 ───────────────────────────── */

interface AssertionOutcome {
  ok: boolean;
  observed?: unknown;
  detail?: unknown;
}

async function evaluateStep(ctx: Ctx, s: U1Step, index: number): Promise<{
  status: "PASS" | "FAIL";
  action: string;
  assertion: string | null;
  kind: U1Evidence["kind"];
  observed?: unknown;
  detail?: unknown;
  screenshot?: string | null;
  domSnapshot?: unknown | null;
  skip?: boolean;
}> {
  const wc = ctx.wc;
  const timeout = (ms?: number): number => ms ?? ctx.defaultTimeoutMs;
  const needWc = (): AssertionOutcome | null =>
    (wc && !wc.isDestroyed() ? null : { ok: false, detail: wc ? "窗口/WebContents 已销毁" : "窗口/WebContents 不存在" });

  const finish = (kind: U1Evidence["kind"], action: string, assertion: string | null, out: AssertionOutcome, extra: { screenshot?: string | null; dom?: unknown | null } = {}) => {
    // 分档开关：关掉的档只取证不断言（实际结果仍写进 observed.actualStatus，
    // 便于复核「本来会是红/绿」）。动作步骤不受开关影响。
    const sw = ctx.journey.launch?.assertions;
    const kindEnabled = kind === "action" || !sw || sw[kind] !== false;
    if (!kindEnabled) {
      return {
        status: "PASS" as const,
        action, assertion, kind,
        observed: { ...(out.observed !== null && typeof out.observed === "object" ? out.observed as object : {}), ...(out.observed === undefined ? {} : { value: out.observed }), actualStatus: assertionStatus(out.ok) },
        ...(out.detail === undefined ? {} : { detail: `[该档断言已关闭，仅取证] ${typeof out.detail === "string" ? out.detail : JSON.stringify(out.detail)}` }),
        screenshot: extra.screenshot ?? null,
        domSnapshot: extra.dom ?? null,
        skipped: true,
      };
    }
    return {
      status: assertionStatus(out.ok),
      action,
      assertion,
      kind,
      observed: out.observed,
      detail: out.detail,
      screenshot: extra.screenshot ?? null,
      domSnapshot: extra.dom ?? null,
    };
  };

  const resolve = (p: string): string => resolveFixturePath(p, {
    docPath: ctx.docPath,
    dataDir: ctx.dataDir,
    projectDir: ctx.projectDir,
    homeDir: join(ctx.runDir, "home"),
  });

  switch (s.op) {
    case "navigate": {
      const miss = needWc();
      if (miss) return finish("action", `navigate ${s.url}`, null, miss);
      try {
        await ctx.win!.loadURL(s.url);
        return finish("action", `navigate ${s.url}`, null, { ok: true, observed: s.url });
      } catch (e) {
        return finish("action", `navigate ${s.url}`, null, { ok: false, detail: String(e) });
      }
    }

    case "click": {
      const miss = needWc();
      if (miss) return finish("action", `click ${s.selector}`, null, miss);
      const target = await probeElement(wc!, s.selector, s.text);
      if (!target.found) {
        return finish("action", `click ${s.selector}`, null, {
          ok: false, observed: target,
          detail: `点击目标不存在或不可见（count=${target.count}, visible=${target.visible}${s.text ? `, text=${s.text}` : ""}）`,
        });
      }
      await ensureFocus(ctx);
      const button = s.button ?? "left";
      wc!.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
      wc!.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button, clickCount: 1 });
      wc!.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button, clickCount: 1 });
      return finish("action", `click ${s.selector}${s.text ? ` [text=${s.text}]` : ""}`, null, {
        ok: true, observed: { x: target.x, y: target.y, textSlice: target.textSlice },
      });
    }

    case "type": {
      const miss = needWc();
      if (miss) return finish("action", `type ${s.selector}`, null, miss);
      const target = await probeElement(wc!, s.selector);
      if (!target.found) {
        return finish("action", `type ${s.selector}`, null, { ok: false, detail: "输入目标不存在或不可见", observed: target });
      }
      await ensureFocus(ctx);
      const focused = await js<boolean>(wc!, `(() => {
        const el = document.querySelector(${JSON.stringify(s.selector)});
        if (!el) return false;
        el.focus();
        ${s.clear ? `(() => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value").set; setter.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })();` : ""}
        return document.activeElement === el || el.contains(document.activeElement);
      })()`).catch(() => false);
      if (!focused) return finish("action", `type ${s.selector}`, null, { ok: false, detail: "无法聚焦输入目标" });
      wc!.insertText(s.text);
      return finish("action", `type ${s.selector} "${s.text.slice(0, 40)}"`, null, { ok: true, observed: { text: s.text } });
    }

    case "press": {
      const miss = needWc();
      if (miss) return finish("action", `press ${s.key}`, null, miss);
      await ensureFocus(ctx);
      const mods = s.modifiers ?? [];
      wc!.sendInputEvent({ type: "keyDown", keyCode: s.key, modifiers: mods });
      wc!.sendInputEvent({ type: "keyUp", keyCode: s.key, modifiers: mods });
      return finish("action", `press ${s.key}${mods.length ? `+${mods.join("+")}` : ""}`, null, { ok: true });
    }

    case "waitFor": {
      const miss = needWc();
      if (miss) return finish("action", `waitFor ${s.selector}`, null, miss);
      const ok = await until(async () => (await probeElement(wc!, s.selector, s.text)).found, timeout(s.timeoutMs));
      const last = await probeElement(wc!, s.selector, s.text);
      return finish("action", `waitFor ${s.selector}${s.text ? ` [text=${s.text}]` : ""}`, null, {
        ok, observed: last,
        ...(ok ? {} : { detail: `等待超时（${timeout(s.timeoutMs)}ms）` }),
      });
    }

    case "waitForGone": {
      const miss = needWc();
      if (miss) return finish("action", `waitForGone ${s.selector}`, null, miss);
      const ok = await until(async () => !(await probeElement(wc!, s.selector)).found, timeout(s.timeoutMs));
      return finish("action", `waitForGone ${s.selector}`, null, { ok, ...(ok ? {} : { detail: `元素在超时后仍然存在（${timeout(s.timeoutMs)}ms）` }) });
    }

    case "sleep": {
      await sleep(s.ms);
      return finish("action", `sleep ${s.ms}ms`, null, { ok: true });
    }

    case "eval": {
      const miss = needWc();
      if (miss) return finish("action", `eval`, null, miss);
      try {
        const value = await js(wc!, s.expression);
        return finish("action", `eval`, null, { ok: true, observed: value });
      } catch (e) {
        return finish("action", `eval`, null, { ok: false, detail: String(e) });
      }
    }

    case "assertDom": {
      const miss = needWc();
      if (miss) return finish("dom", `assertDom ${s.selector}`, s.selector, miss);
      const check = async (): Promise<AssertionOutcome> => {
        // `count` 统计的是**经过文本过滤后的可见命中数**：`count:0` +
        // `textContains` 因此能表达「带该文本的行已不在可见 DOM」。
        const el = await probeElement(wc!, s.selector, s.text ?? s.textContains);
        if (s.exists === false) {
          const ok = el.matched === 0;
          return ok
            ? { ok: true, observed: { matched: 0, visible: el.visible, count: el.count } }
            : { ok: false, observed: { matched: el.matched, visible: el.visible, count: el.count, textSlice: el.textSlice }, detail: `断言元素不存在，但实际找到了 ${el.matched} 个可见匹配` };
        }
        if (s.count !== undefined) {
          if (el.matched !== s.count) {
            return { ok: false, observed: { matched: el.matched, visible: el.visible, count: el.count }, detail: `可见匹配数 ${el.matched} ≠ 期望 ${s.count}` };
          }
          // count 命中：其余条件（文本/属性）在 count:0 时没有意义，跳过。
          if (s.count === 0) return { ok: true, observed: { matched: 0, visible: el.visible, count: el.count } };
        }
        if (!el.found) return { ok: false, observed: el, detail: "元素不存在或不可见" };
        const extra = await js<{ text: string; attr: string | null }>(wc!, `(() => {
          const el = document.querySelector(${JSON.stringify(s.selector)});
          return { text: el ? (el.textContent || "") : "", attr: el && ${JSON.stringify((s.attribute?.name ?? null))} !== null ? el.getAttribute(${JSON.stringify(s.attribute?.name ?? "")}) : null };
        })()`);
        if (s.text !== undefined && extra.text.trim() !== s.text) {
          return { ok: false, observed: { text: extra.text.slice(0, 400) }, detail: `文本不等于期望` };
        }
        if (s.textContains !== undefined && !extra.text.includes(s.textContains)) {
          return { ok: false, observed: { text: extra.text.slice(0, 400) }, detail: `文本不包含 "${s.textContains}"` };
        }
        if (s.attribute && s.attribute.value !== undefined && extra.attr !== s.attribute.value) {
          return { ok: false, observed: { attr: extra.attr }, detail: `属性 ${s.attribute.name} 的值不是期望值` };
        }
        return { ok: true, observed: { visible: el.visible, text: extra.text.slice(0, 200), ...(s.attribute ? { attr: extra.attr } : {}) } };
      };
      let out: AssertionOutcome = { ok: false, detail: "未执行" };
      await until(async () => { out = await check(); return out.ok; }, timeout(s.timeoutMs));
      if (!out.ok) out = await check();
      const shot = await takeScreenshot(ctx, `assert-${index + 1}-${out.ok ? "pass" : "fail"}`);
      return finish("dom", `assertDom ${s.selector}`, JSON.stringify({
        selector: s.selector, ...(s.exists !== undefined ? { exists: s.exists } : {}),
        ...(s.text !== undefined ? { text: s.text } : {}),
        ...(s.textContains !== undefined ? { textContains: s.textContains } : {}),
        ...(s.count !== undefined ? { count: s.count } : {}),
        ...(s.attribute ? { attribute: s.attribute } : {}),
      }), out, { screenshot: shot ? shot.file : null });
    }

    case "assertEvaluated": {
      const miss = needWc();
      if (miss) return finish("dom", "assertEvaluated", s.expression, miss);
      let actual: unknown = undefined;
      const ok = await until(async () => {
        actual = await js(wc!, s.expression).catch(() => undefined);
        return JSON.stringify(actual) === JSON.stringify(s.expected);
      }, timeout(s.timeoutMs));
      return finish("dom", "assertEvaluated", s.expression, {
        ok, observed: actual,
        ...(ok ? {} : { detail: `实际值与期望值不一致` }),
      });
    }

    case "screenshot": {
      const shot = await takeScreenshot(ctx, s.shot);
      if (!shot) return finish("visual", `screenshot ${s.shot}`, null, { ok: false, detail: "capturePage 返回空图" });
      ctx.state.screenshots[s.shot] = shot;
      return finish("visual", `screenshot ${s.shot}`, null, { ok: true, observed: shot }, { screenshot: shot.file });
    }

    case "assertScreenshotChanged": {
      const baseline = ctx.state.screenshots[s.baseline];
      if (!baseline) return finish("visual", `assertScreenshotChanged ${s.shot} vs ${s.baseline}`, null, { ok: false, detail: `基准截图 "${s.baseline}" 尚未拍过` });
      const shot = await takeScreenshot(ctx, s.shot);
      if (!shot) return finish("visual", `assertScreenshotChanged ${s.shot} vs ${s.baseline}`, null, { ok: false, detail: "capturePage 返回空图" });
      ctx.state.screenshots[s.shot] = shot;
      const ok = shot.sha256 !== baseline.sha256;
      return finish("visual", `assertScreenshotChanged ${s.shot} vs ${s.baseline}`, `两帧截图必须不同`, {
        ok, observed: { now: shot.sha256, baseline: baseline.sha256 },
        ...(ok ? {} : { detail: "两次截图逐字节相同 —— 界面没有变化" }),
      }, { screenshot: shot.file });
    }

    case "recordSideEffect": {
      const path = resolve(s.file);
      const rec = snapshotFile(path);
      const key = s.key ?? path;
      ctx.state.sideEffects[key] = rec;
      return finish("sideEffect", `recordSideEffect ${s.file}`, null, { ok: true, observed: rec });
    }

    case "assertSideEffect": {
      const path = resolve(s.file);
      const exists = existsSync(path);
      const observed: Record<string, unknown> = { path, exists };
      let ok = true;
      let detail: string | undefined;
      let rec: SideEffectRecord | null = null;
      if (exists) {
        rec = snapshotFile(path);
        observed.sha256 = rec.sha256;
        observed.bytes = rec.bytes;
      }
      if (s.exists !== undefined && exists !== s.exists) {
        ok = false; detail = `exists=${exists} ≠ 期望 ${s.exists}`;
      }
      if (ok && s.contains !== undefined) {
        const text = exists ? readFileSync(path, "utf8") : "";
        if (!text.includes(s.contains)) { ok = false; detail = `文件内容不包含 "${s.contains}"`; observed.textSlice = text.slice(0, 300); }
      }
      if (ok && s.notContains !== undefined) {
        const text = exists ? readFileSync(path, "utf8") : "";
        if (text.includes(s.notContains)) { ok = false; detail = `文件内容仍包含 "${s.notContains}"`; }
      }
      if (ok && s.sha256Equals !== undefined) {
        if (!rec || rec.sha256 !== s.sha256Equals) { ok = false; detail = "sha256 与期望值不一致"; }
      }
      if (ok && s.sha256ChangedFrom !== undefined) {
        const before = ctx.state.sideEffects[s.sha256ChangedFrom];
        if (!before) { ok = false; detail = `找不到 recordSideEffect "${s.sha256ChangedFrom}" 的记录`; }
        else if (!rec || rec.sha256 === before.sha256) { ok = false; detail = `sha256 没有变化（${before.sha256}）`; }
        else observed.changedFrom = before.sha256;
      }
      if (ok && s.sha256UnchangedFrom !== undefined) {
        const before = ctx.state.sideEffects[s.sha256UnchangedFrom];
        if (!before) { ok = false; detail = `找不到 recordSideEffect "${s.sha256UnchangedFrom}" 的记录`; }
        else if (!rec || rec.sha256 !== before.sha256) {
          ok = false;
          detail = `sha256 变了（期望不变：记录 ${before.sha256}，实际 ${rec?.sha256 ?? "缺失"}）`;
        } else observed.unchangedFrom = before.sha256;
      }
      return finish("sideEffect", `assertSideEffect ${s.file}`, JSON.stringify(s), { ok, observed, ...(detail ? { detail } : {}) });
    }

    case "relaunch":
    case "crashRelaunch": {
      // 由 runGeneration 的主循环处理（它要退出进程），这里只占位保证 switch 穷尽。
      return finish("action", `relaunch ${s.reason ?? ""}`, null, { ok: false, detail: "relaunch 不应到达 evaluateStep" });
    }

    case "run": {
      // T7：主进程内的任意装配/取证。`fn` 由旅程文件给出（会被 build.mjs 打进
      // journeys.cjs，在真 Electron 主进程里执行）。
      const runtime: U1StepRuntime = {
        projectDir: ctx.projectDir,
        dataDir: ctx.dataDir,
        evidenceDir: ctx.dir,
        generation: ctx.state.generation,
        runtime: ctx.setupResult?.runtime,
        win: ctx.win,
      };
      let value: unknown;
      try {
        value = await s.fn(runtime);
      } catch (e) {
        return finish(s.assert === true ? "sideEffect" : "action", "run", s.assert === true ? "run 断言" : null, {
          ok: false, detail: `run 步骤抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        });
      }
      if (s.assert !== true) {
        return finish("action", "run", null, { ok: true, observed: value });
      }
      const shaped = (value !== null && typeof value === "object" ? value : null) as { ok?: unknown; observed?: unknown; detail?: unknown } | null;
      if (shaped === null || typeof shaped.ok !== "boolean") {
        return finish("sideEffect", "run", "run 断言", {
          ok: false, observed: value,
          detail: "assert:true 的 run 步骤必须返回 { ok, observed?, detail? }",
        });
      }
      return finish("sideEffect", "run", "run 断言", {
        ok: shaped.ok === true,
        observed: shaped.observed,
        ...(shaped.ok === true ? {} : { detail: shaped.detail ?? "run 断言失败" }),
      });
    }
  }
}

/** 组装本趟旅程的结果（evidence 已包含本进程刚追加的部分）。 */
function buildResult(ctx: Ctx): U1JourneyResult {
  const { journey, state } = ctx;
  const literal = literalStatus(state.evidence);
  const verdict = classifyJourney(journey, state.evidence);
  const failed = state.evidence.find((e) => e.status === "FAIL") ?? null;
  return {
    name: journey.name,
    expect: journey.expect ?? "pass",
    literalStatus: literal,
    status: verdict.expectation === "all-pass" || verdict.expectation === "expected-failure" ? "PASS" : "FAIL",
    failedStep: failed ? failed.step : null,
    expectation: verdict.expectation,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    steps: state.evidence,
    evidenceDir: ctx.dir,
    durationMs: Date.now() - state.startedAt,
    generations: state.pids.length,
    pids: state.pids,
  };
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

interface GenerationEnv {
  stateFile: string;
  journeyIndex: number;
  dir: string;
  buildDir: string;
  runDir: string;
  dataDir: string;
  projectDir: string;
  docPath: string;
}

function loadState(env: GenerationEnv): State {
  const existing = readJson<State>(env.stateFile);
  if (existing) return existing;
  return {
    journeyIndex: env.journeyIndex,
    generation: 1,
    stepOffset: 0,
    pids: [],
    evidence: [],
    sideEffects: {},
    screenshots: {},
    done: false,
    failedStep: null,
    startedAt: Date.now(),
  };
}

/**
 * 宿主窗口放哪。
 *
 * 条件：`WebContentsView.capturePage()` 要求窗口**落在某个显示器的坐标空间内**。
 * 屏外的窗口（哪怕 `show:true`）拿不到 display surface，`capturePage()` 一直抛
 * `Current display surface not available for capture`，截图永远是空图。
 * **位置的这条约束是硬的；`opacity` 不是**（见下面的实测出处）。
 *
 * 优先级：
 *   1. 有副屏 → 放副屏（用户偏好：别在主屏弹窗）。
 *   2. 没副屏 → **主屏工作区内**。单屏机器上没有「屏外还能合成」的位置，所以
 *      「用户看不见」改由 `opacity: 0` 保证，不是由位置保证。
 *   3. `screen` 尚不可用 → (0,0) 兜底（见 catch）。
 *
 * 出处（W24，2026-10-25，本机单屏 1463x823，探针在 `.tmp/w24-display-probe*.cjs`）：
 *   `WebContentsView.capturePage()` 的三格 ——
 *   屏外 (1543,855)（旧无副屏分支的逐字坐标）→ 永不成功，load 完也不行；
 *   主屏内 + `opacity: 0` → +122ms 成功；主屏内 + `opacity: 1` → +93ms 成功。
 *   旧注释「不能 opacity:0」是把 `BrowserWindow.capturePage`（不受位置影响）与
 *   `WebContentsView.capturePage`（受位置影响）混成了一件。
 *   **副屏分支的 `opacity` 没有测过**（探针全程单屏，副屏分支不存在、无法测）——
 *   要往副屏窗口加 `opacity`，得先自己测一遍 `capturePage()` 仍然成功。
 *
 * 返回值的 `note` 会打日志 —— 下次有人查「窗口为什么在那」时不用猜。
 * 调用方按需取字段，**不要整个摊进 BrowserWindow 的构造参数**：`note` 不是窗口
 * 选项；`opacity` 是**分支相关**的（兜底路径是 1），摊进 `createWindow` 会让
 * 「screen 不可用」时那个本该隐身的窗口变成可见。
 */
export interface HostWindowPlacement {
  x: number;
  y: number;
  /** 窗口不透明度：由位置分支决定（主屏内 → 0；副屏 / 兜底 → 1，保持旧行为）。理由见调用点。 */
  opacity: number;
  note: string;
}

/** `chooseHostWindowPlacement` 需要的 display 形状 —— `Electron.Display` 结构上满足它。 */
export interface PlacementDisplay {
  id: number;
  bounds: { width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

/**
 * `pickHostWindowPlacement` 的纯算术内核：不读 `screen`、不碰 Electron ——
 * 无头套件（`u1-placement-smoke`）直接 import 它断言坐标，变异（把坐标改回屏外）
 * 必须让它红。判定逻辑只放在这里，别再往调用方抄一份。
 */
export function chooseHostWindowPlacement(
  primary: PlacementDisplay,
  others: readonly PlacementDisplay[],
): HostWindowPlacement {
  if (others.length > 0) {
    const target = others[0];
    return {
      x: target.workArea.x + 60,
      y: target.workArea.y + 60,
      // 副屏分支的 opacity 保持 1（不透明）：这里用户本来就不看，而
      // 「副屏 + opacity 0」没有测过 —— 未验证的组合不进这个文件（见函数注释）。
      opacity: 1,
      note: `secondary display (id=${target.id}, ${target.bounds.width}x${target.bounds.height})`,
    };
  }
  const wa = primary.workArea;
  return {
    x: wa.x + 20,
    y: wa.y + 20,
    // 主屏内必须靠 opacity 隐身：「主屏 + opacity 0」是 W24 实测成功的组合
    // （+122ms），而屏外位置会让 `WebContentsView.capturePage()` 永不成功。
    opacity: 0,
    note: `inside primary work area (invisible) ${wa.width}x${wa.height} (no secondary display)`,
  };
}

function pickHostWindowPlacement(size: { width: number; height: number }): HostWindowPlacement {
  try {
    const primary = screen.getPrimaryDisplay();
    const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
    return chooseHostWindowPlacement(primary, others);
  } catch (error) {
    // `screen` 在 ready 之前不可用；这里只是位置，不该让整趟旅程失败。
    console.log(`U1 placement probe failed, falling back to 0,0: ${String(error)}`);
    return { x: 0, y: 0, opacity: 1, note: "fallback (screen unavailable)" };
  }
}

/** `{ x, y }` 部分 —— 直接摊进 BrowserWindow 构造参数时用这个，别摊 `note`。 */
function hostWindowXY(size: { width: number; height: number }): { x: number; y: number } {
  const { x, y } = pickHostWindowPlacement(size);
  return { x, y };
}

async function createWindow(ctx: Ctx, pageHtml: string, preload?: string): Promise<void> {
  const size = ctx.journey.launch?.size ?? { width: 1280, height: 800 };
  mkdirSync(join(ctx.runDir, "home"), { recursive: true });
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    // 与 settings-focus-electron-smoke 相同的取舍：窗口必须「存在且可聚焦」
    //（隐藏窗口 document.hasFocus() 恒 false，真键盘事件不可观测）。
    // 用户看不见由 `opacity: 0` 保证，不是由位置保证 —— 单屏机器上位置在主屏
    // 工作区内（屏外会拿不到 display surface，见 `pickHostWindowPlacement`）。
    show: true,
    opacity: 0,
    ...hostWindowXY(size),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      ...(preload ? { preload } : {}),
    },
  });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`RENDERER[${level}] ${String(message).slice(0, 1200)}`);
  });
  ctx.win = win;
  ctx.wc = win.webContents;
  win.focus();
  // 查询串给旅程页面用（journey-2 用它拿文档绝对路径 + 判断是不是重开后的那一趟）。
  await win.loadFile(pageHtml, {
    query: { doc: ctx.docPath, phase: ctx.state.generation > 1 ? "reopen" : "" },
  });
  await sleep(400);
}

/** 入口：由生成的 runner-entry 调用，一次调用 = 一个 Electron 进程 = 一趟。 */
export async function runGeneration(journeys: U1Journey[]): Promise<void> {
  const env: GenerationEnv = {
    stateFile: process.env.MCODE_U1_STATE ?? "",
    journeyIndex: Number(process.env.MCODE_U1_JOURNEY ?? "0"),
    dir: process.env.MCODE_U1_DIR ?? "",
    buildDir: process.env.MCODE_U1_BUILD ?? "",
    runDir: process.env.MCODE_U1_RUN ?? "",
    dataDir: process.env.MCODE_U1_DATA ?? "",
    projectDir: process.env.MCODE_U1_PROJECT ?? "",
    docPath: process.env.MCODE_U1_DOC ?? "",
  };
  if (!env.dir || !isAbsolute(env.dir) || !env.buildDir || !env.runDir) {
    throw new Error("U1 runner: MCODE_U1_DIR / MCODE_U1_BUILD / MCODE_U1_RUN 必须是绝对路径");
  }
  const journey = journeys[env.journeyIndex];
  if (!journey) throw new Error(`U1 runner: journeyIndex ${env.journeyIndex} 越界（共 ${journeys.length} 条）`);

  const state = loadState(env);
  state.generation = state.generation + (state.pids.length === 0 ? 0 : 1);
  state.pids.push(process.pid);
  writeJson(env.stateFile, state);

  let dbHandle: typeof import("@main/store/db.js") | null = null;
  let repos: typeof import("@main/store/repositories.js") | null = null;
  const ipcMain = (await import("electron")).ipcMain;
  if (journey.launch?.useRealDb) {
    // 真数据库：initDb 走 dataRoot 指针（electron-host 已把它指到 runDir）。
    dbHandle = await import("@main/store/db.js");
    repos = await import("@main/store/repositories.js");
    await dbHandle.initDb();
    // 真 IPC：journey-2 的「保存」走产品同一条 `file:writeFile` 通道
    // （pathGuard → osFileLease → CAS → atomicReplaceFile）。这里只注册这一组
    // handler，不引入 claude/RuntimeManager 那条会拖入原生音频模块的链。
    const { registerFileHandlers } = await import("@main/ipc/files.js");
    registerFileHandlers(ipcMain);
    // theme：真 App 的 useTheme 启动即订阅；给同形状的真 handler。
    const { nativeTheme: theme } = await import("electron");
    const eff = (): "dark" | "light" => (theme.shouldUseDarkColors ? "dark" : "light");
    ipcMain.handle("theme:get", () => ({ theme: "light", effective: eff() }));
    ipcMain.handle("theme:set", () => ({ theme: "light", effective: eff() }));
    // 夹具：一个指向临时项目目录的项目行（file:* 的守卫要它才放行）。
    if (state.generation === 1) {
      if (!repos.ProjectRepo.get("proj_u1_fixture")) {
        const now = Date.now();
        repos.ProjectRepo.create({
          id: "proj_u1_fixture",
          name: "U1 临时项目",
          path: env.projectDir,
          archived: false,
          pinnedAt: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (!existsSync(env.docPath)) writeFileSync(env.docPath, "U1 alpha\n");
      dbHandle.persistNowOrThrow();
    }
  }

  const finish = (result: U1JourneyResult): void => {
    writeJson(join(env.dir, "journey-result.json"), result);
    writeJson(env.stateFile, state);
    try { ctx.win?.destroy(); } catch { /* already gone */ }
    if (ctx.setupResult && typeof ctx.setupResult.dispose === "function") {
      try {
        const maybe = ctx.setupResult.dispose() as unknown;
        if (maybe && typeof (maybe as Promise<unknown>).then === "function") void maybe;
      } catch (e) { console.error("U1 runner: setup dispose failed", e); }
    }
    if (dbHandle) {
      try { dbHandle.closeDb(); } catch (e) { console.error("U1 runner: closeDb failed", e); }
    }
    // 退出码只表达「这趟旅程按它自己的声明算不算通过」；套件级三档语义
    // （0 全绿 / 1 预期红 / 2 意外红）由启动器按 journey-result.json 汇总。
    // app.exit() 立即结束进程、不会返回。
    app.exit(result.status === "PASS" ? 0 : 1);
  };

  const ctx: Ctx = {
    dir: env.dir,
    buildDir: env.buildDir,
    runDir: env.runDir,
    dataDir: env.dataDir,
    projectDir: env.projectDir,
    docPath: env.docPath,
    state,
    stateFile: env.stateFile,
    journey,
    win: null,
    wc: null,
    defaultTimeoutMs: journey.launch?.defaultTimeoutMs ?? 10_000,
    setupResult: null,
  };

  // ── 重开后的第一件事：证明数据库副本真的还在（fixture 完整性自检） ──
  if (dbHandle && repos && state.generation > 1) {
    const project = repos.ProjectRepo.get("proj_u1_fixture");
    const ok = !!project && project.path === env.projectDir;
    const now = new Date().toISOString();
    state.evidence.push({
      journey: journey.name,
      step: "db-reopen-project-row",
      action: "reopen mcode.db",
      assertion: "重开进程后，mcode.db 副本里的项目行仍然存在",
      kind: "sideEffect",
      status: assertionStatus(ok),
      observed: project ? { id: project.id, name: project.name, path: project.path } : null,
      ...(ok ? {} : { detail: "ProjectRepo.get('proj_u1_fixture') 在重开后读不到 —— 数据库没有持久化" }),
      screenshot: null,
      domSnapshot: null,
      at: now,
      pid: process.pid,
      generation: state.generation,
    });
    ctx.state.sideEffects["db-reopen"] = snapshotFile(join(env.dataDir, "mcode.db"));
    writeJson(env.stateFile, state);
  }

  // ── 页面：bundle（真 App）或旅程自带页面 ──
  // `launch.window === false`（T7 的 GenOffice 视图旅程）不建宿主页：`step.*` 的
  // 作用对象由 `launch.setup` 返回的 `pageFromView` 决定。
  let pageHtml = join(env.buildDir, "page.html");
  let preload: string | undefined;
  const pageSpec = journey.launch?.page ?? "bundle";
  if (typeof pageSpec === "object" && "file" in pageSpec) pageHtml = join(env.buildDir, pageSpec.file);
  if (journey.launch?.preload === "product") preload = join(env.buildDir, "product-preload.cjs");

  const wantWindow = journey.launch?.window !== false;
  let setupResult: U1SetupResult | null = null;
  if (wantWindow) {
    await createWindow(ctx, pageHtml, preload);
  } else {
    // 没有宿主窗口时也留一个最小窗口给 WebContentsView 使用 ——
    // `win.contentView.addChildView(view)` 需要一个活窗口；GenOffice 的宿主
    // （DocumentViewHost）恰恰从 `getMainWindow()` 取它。
    const size = journey.launch?.size ?? { width: 1280, height: 900 };
    mkdirSync(join(ctx.runDir, "home"), { recursive: true });
    // 条件：`WebContentsView.capturePage()` 要求窗口落在某个显示器的坐标空间内
    //   （屏外 → `Current display surface not available for capture`，永不成功）。
    // 出处：W24 2026-10-25 的探针矩阵，见 `pickHostWindowPlacement` 上方注释。
    // 后果：位置由 `pickHostWindowPlacement` 决定 —— 有副屏放副屏；没副屏放
    //   主屏工作区内，用户看不见由 `opacity` 保证（`chooseHostWindowPlacement`
    //   跟着位置一起给出，理由见下方 `opacity` 一行）。
    // 判据只读 DOM/磁盘，截图只是证据；窗口本身几秒内就会被关掉。
    const placement = pickHostWindowPlacement(size);
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      // 窗口必须真实存在且有 display surface（否则 `WebContentsView.capturePage()` 抛错）。
      // 位置由 `pickHostWindowPlacement` 决定（有副屏走副屏）。
      //
      // `skipTaskbar`：副屏窗口不该在任务栏占一格 —— 那会让用户在**主屏**的任务栏上
      // 看到测试窗口的图标，看起来像「又弹了一个」。
      //
      // `opacity` 跟着**位置分支**走，不写死：
      //   - 主屏内（无副屏分支）→ 0。「主屏 + `opacity: 0` + `WebContentsView.capturePage()`
      //     成功（+122ms）」是 W24 实测过的组合；单屏机器上这是唯一能既不挡用户
      //     又不失败的位置。
      //   - 副屏（有副屏分支）→ 1（不透明，与此前行为一致）。「副屏 + `opacity: 0`」
      //     **没有测过**（W24 的探针全程单屏，副屏分支不存在）—— 要改成 0，
      //     得先在有多块屏的机器上验一次 capturePage 仍然成功。
      show: true,
      skipTaskbar: true,
      opacity: placement.opacity,
      x: placement.x,
      y: placement.y,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    console.log(`U1 host window: ${placement.note} (x=${placement.x}, y=${placement.y})`);
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) console.log(`RENDERER[${level}] ${String(message).slice(0, 1200)}`);
    });
    ctx.win = win;
    ctx.wc = null;
    // 不要 `focus()`：副屏上的窗口被 focus 时，Windows 会把它的任务切到前台，
    // 用户在**主屏**上看就是「又弹了一个窗口」。
    // `showInactive()` 让窗口存在且可合成（`capturePage` 需要 surface），但不抢焦点。
    win.showInactive();
  }

  // ── 主进程装配钩子（T7 起）──
  // 必须在建窗口**之后**（GenOffice 宿主需要活窗口）与执行步骤**之前**调用。
  // 重开后本函数会被新进程再次调用，钩子必须可重入。
  if (typeof journey.launch?.setup === "function") {
    setupResult = await journey.launch.setup({
      evidenceDir: env.dir,
      runDir: env.runDir,
      projectDir: env.projectDir,
      dataDir: env.dataDir,
      generation: state.generation,
      win: ctx.win,
    });
    ctx.setupResult = setupResult;
    if (setupResult && setupResult.pageFromView) {
      ctx.wc = setupResult.pageFromView;
      await ensureFocus(ctx);
    } else if (!ctx.wc && ctx.win) {
      ctx.wc = ctx.win.webContents;
    }
  }

  // ── 逐步执行 ──
  for (let i = state.stepOffset; i < journey.steps.length; i++) {
    const s = journey.steps[i];
    const name = stepName(s, i);
    const startedAt = Date.now();
    const at = new Date().toISOString();

    if (s.op === "relaunch" || s.op === "crashRelaunch") {
      const crash = s.op === "crashRelaunch";
      const entry: U1Evidence = {
        journey: journey.name, step: name,
        action: `${crash ? "SIGKILL + relaunch" : "relaunch"}（${s.reason ?? "无说明"}）`,
        assertion: null, kind: "action", status: assertionStatus(true),
        observed: { fromPid: process.pid, generation: state.generation, abrupt: crash },
        screenshot: null,
        domSnapshot: await captureDomSnapshot(ctx, name),
        at, pid: process.pid, generation: state.generation,
        durationMs: Date.now() - startedAt,
      };
      state.evidence.push(entry);
      state.stepOffset = i + 1;
      if (crash) {
        // No graceful app.exit, BrowserWindow destroy, document host dispose,
        // renderer close guard or database teardown. The supervisor MUST
        // observe this exact PID and an abnormal OS exit before relaunch.
        state.crashArmed = { pid: process.pid, generation: state.generation, stepOffset: i + 1 };
        writeJson(env.stateFile, state);
        // Negative control: intentionally exit normally after arming. The
        // parent must reject it because no supervisor SIGKILL occurred.
        if (process.env.MCODE_U1_MUTATE_CRASH_TO_NORMAL_EXIT === "1") {
          app.exit(0);
          return;
        }
        const token = process.env.MCODE_U1_CRASH_TOKEN;
        if (!token) throw new Error("U1 hard-kill supervisor challenge absent");
        // Only the external Node launcher may terminate this owned Electron
        // process. This process does NOT run editor teardown or app.exit().
        process.stdout.write("MCODE_U1_CRASH_READY:" + token + "\n");
        await new Promise<void>(() => undefined);
      }
      writeJson(env.stateFile, state);
      // T7：装配了 setup 钩子时，重开前先释放视图/会话（新进程会重新装配）。
      if (ctx.setupResult && typeof ctx.setupResult.dispose === "function") {
        try {
          const maybe = ctx.setupResult.dispose() as unknown;
          if (maybe && typeof (maybe as Promise<unknown>).then === "function") await maybe;
        } catch (e) { console.error("U1 runner: setup dispose before relaunch failed", e); }
      }
      try { ctx.win?.destroy(); } catch { /* gone */ }
      if (dbHandle) {
        try { dbHandle.flushDb(); dbHandle.closeDb(); } catch (e) { console.error("U1 runner: flush before relaunch failed", e); app.exit(1); }
      }
      app.exit(RELAUNCH_EXIT);
      return;
    }

    const out = await evaluateStep(ctx, s, i);
    const entry: U1Evidence = {
      journey: journey.name,
      step: name,
      action: out.action,
      assertion: out.assertion,
      kind: out.kind,
      status: out.status,
      observed: out.observed,
      ...(out.status === "FAIL" ? { detail: out.detail ?? "断言失败" } : {}),
      screenshot: out.screenshot ?? null,
      domSnapshot: out.domSnapshot ?? null,
      at,
      pid: process.pid,
      generation: state.generation,
      durationMs: Date.now() - startedAt,
    };
    state.evidence.push(entry);
    state.stepOffset = i + 1;
    writeJson(env.stateFile, state);

    if (out.status === "FAIL") {
      // 保留现场：失败额外抓一张截图 + DOM（即使该步本身没配 screenshot）。
      const shot = await takeScreenshot(ctx, `failure-${name}`);
      entry.screenshot = entry.screenshot ?? (shot ? shot.file : null);
      entry.domSnapshot = entry.domSnapshot ?? (await captureDomSnapshot(ctx, `failure-${name}`));
      state.failedStep = name;
      state.done = true;
      writeJson(env.stateFile, state);
      finish(buildResult(ctx));
      return;
    }
  }

  state.done = true;
  writeJson(env.stateFile, state);
  finish(buildResult(ctx));
}

/** 供 electron-host 使用的探测（窗口系统可用性自检）。 */
export function nativeProbe(): string {
  return `${process.versions.electron}|${nativeTheme.shouldUseDarkColors ? "dark" : "light"}`;
}
