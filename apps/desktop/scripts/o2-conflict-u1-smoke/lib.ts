/**
 * O2 —— 六格式保存冲突套件的**共用取证助手**（跑在探针主进程里）。
 *
 * ## 三条判据各自取证，互不代偿
 *
 * 卡 §五 变异 2 点名的设计约束：删掉冲突提示的 DOM 元素时，**只有 4c 该红，
 * 4a/4b 必须仍绿**。要让它成立，三条判据的**证据源必须不同**：
 *
 *   | 判据 | 证据源 | 本文件的入口 |
 *   |---|---|---|
 *   | 4a 保存被拒 | 主进程 IPC 回包（页面之外） | `observeSave` → `ipc-recorder.ts` |
 *   | 4b 盘上不变 | 磁盘字节 sha256 | `sha256Of` / `writeExternalEdit` |
 *   | 4c 用户看得见 | 页面 DOM（可见性 + 文案） | `probeNotice` |
 *
 * 任何一条改成「从 DOM 反推保存被拒」，都会让 4a 与 4c 变成同一件事。
 *
 * ## 触发保存为什么走三种不同形态
 *
 * 六格式的保存入口本来就不同（卡 §二）：docs/pdf/markdown/html 是页面自己的
 * Ctrl+S；slides 是页面里的 QAT 按钮（不可点时退回它调用的同一个桥）；sheets
 * 是 QAT 保存按钮（页面没有 Ctrl+S handler，快捷键归 shell 菜单）。三种都经
 * `triggerSave`，但触发后在主进程侧看到的**保存通道**不同 —— 这正是要被记录
 * 下来的事实（`observeSave` 会把实际命中的通道写进证据）。
 *
 * ## 外部改动（模拟 Agent/另一个编辑器）为什么按格式分两种写法
 *
 * OOXML / PDF 的夹具是二进制：在文件尾部追加��行标记既改变 sha256，又保持
 * 原格式能被解析（pdf-lib 对尾随字节是容忍的 —— 本套件的前置探针实测过）。
 * markdown / html 是纯文本，直接写一份合法的新文本（含标记）。
 *
 * 对**会静默覆盖**的格式（pdf/markdown/html/slides 的原生路线），外部内容必须
 * 是**合法可解析的**：否则保存会因「解析失败」而失败，4a 红的原因就变成了
 * 「坏档」而不是「没有版本校验」—— 那是「红了但红错地方」。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { KeyboardInputEvent, WebContents } from "electron";

import { recorderDiagnostics, recorderLastSeq, saveRepliesSince, type SaveReplyRecord } from "./ipc-recorder.js";

export type EditorKind = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

/** `launch.setup` 返回的 runtime（T7 `editorSetup` 的字段 + 本套件追加的账）。 */
export interface O2Runtime {
  harness: import("../t7-genoffice-u1/harness.js").GenofficeHarness;
  fixtures: import("../t7-genoffice-u1/fixtures.js").FixturePaths;
  kind: EditorKind;
  docId: string;
  webContentsId: number;
  /** 外部改动写入后的字节 sha256（4b 的期望值）。 */
  externalSha?: string;
  /** 负控触发前的盘上 sha256（判「保存真的写了盘」）。 */
  negativePreSha?: string;
  /** 冲突阶段的观察结果（trigger 步骤写、断言步骤读）。 */
  conflict?: SaveObservation;
  /** `conflict-verdicts` 采集的三条判断（4a/4b/4c），断言步骤从这里读。
   *  分成「采集」与「断言」两步是为了让 runner 的 fail-fast 不会吞掉事实。 */
  verdicts?: {
    "4a": { ok: boolean; detail?: string } & Record<string, unknown>;
    "4b": { ok: boolean; diskSha: string | null; externalSha: string | null };
    "4c": { ok: boolean; notice: NoticeProbe };
  };
  /** 负控阶段的观察结果。 */
  negative?: SaveObservation;
}

/** 一次「触发保存 → 等回包 → 取盘面 → 看提示」的完整观察。 */
export interface SaveObservation {
  /** 触发前取的记录器序号（只看比它大的回包）。 */
  seq: number;
  /** 命中的那条保存回包（通道 + 投影）；30s 内没有就是 null。 */
  record: SaveReplyRecord | null;
  /** 同窗口期内该视图发起的全部保存回包（诊断用）。 */
  allRecords: SaveReplyRecord[];
  /** **不分通道**的全部回包（诊断用）：4a 报「没有到达保存通道」时，
   *  这一栏说明「到底有没有回包经过记录器、走的哪个通道」。 */
  allChannelsSince: Array<{ channel: string; senderId: number | null; settled: boolean }>;
  /** 记录器自身的状态（装没装上、shadow 还在不在、累计见过几条）。 */
  recorder: ReturnType<typeof recorderDiagnostics> | null;
  /** 回包落定之后的盘面 sha256。 */
  diskSha: string | null;
  /** 回包落定后 DOM 上的冲突提示（最多再等 `noticeWaitMs`）。 */
  notice: NoticeProbe;
  /** 负控用的成功标记（状态栏「已保存」/pdf 的 `.tb-save-ok`）。 */
  success: NoticeProbe;
  at: number;
}

export interface NoticeProbe {
  /** 该格式的「冲突提示」是否真的出现在页面上（可见 + 文案匹配）。 */
  found: boolean;
  /** 原始观察（文案切片 / 可见性 / 命中元素）—— 红的时候这就是全部线索。 */
  evidence: Record<string, unknown>;
}

/** 每个格式的保存通道。slides 两条都记：生产原生视图走 vendor `slides:save`，
 *  Mcode 受限 preload 的降级路线走 `mcode:document-view:slides-save`。 */
export const SAVE_CHANNELS: Record<EditorKind, readonly string[]> = {
  docs: ["mcode:document-view:save"],
  sheets: ["workbook:save"],
  slides: ["slides:save", "mcode:document-view:slides-save"],
  pdf: ["pdf:save"],
  markdown: ["markdown:save"],
  html: ["html:save"],
};

/** 外部改动的标记文案（证据里能一眼看出「这是外部写的」）。 */
export function externalMarker(kind: EditorKind): string {
  return `O2-EXTERNAL-EDIT-${kind.toUpperCase()}-9f3c71`;
}

export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function wcOf(rt: O2Runtime): WebContents | null {
  return rt.harness.webContentsOf(rt.docId) as unknown as WebContents | null;
}

export async function js<T = unknown>(wc: WebContents, expression: string): Promise<T> {
  return (await wc.executeJavaScript(expression, true)) as T;
}

/** 轮询到 predicate 为真；返回最后一次观察。从不抛错（抛错会丢证据）。 */
export async function pollUntil<T>(predicate: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 150): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null | undefined | false = null;
    try { value = await predicate(); } catch { value = null; }
    if (value) return value as T;
    if (Date.now() > end) return null;
    await sleep(intervalMs);
  }
}

/* ───────────────────────────── 触发保存 ───────────────────────────── */

/** 把 Ctrl+S 派给页面（与用户按快捷键同一条 sendInputEvent 路径）。 */
export async function sendCtrlS(rt: O2Runtime): Promise<{ ok: boolean; detail?: string }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "视图 webContents 不存在" };
  try {
    rt.harness.win.focus();
    wc.focus();
  } catch { /* 窗口已不可用：让下面的事件自己失败 */ }
  const keyDown: KeyboardInputEvent = { type: "keyDown", keyCode: "s", modifiers: ["control"] };
  const keyUp: KeyboardInputEvent = { type: "keyUp", keyCode: "s", modifiers: ["control"] };
  wc.sendInputEvent(keyDown);
  wc.sendInputEvent(keyUp);
  return { ok: true };
}

/** 在页面里找元素、派**真鼠标事件**（与 runner 的 click 同一条路径）。 */
export async function clickInPage(wc: WebContents, selector: string): Promise<{
  ok: boolean;
  found: boolean;
  disabled?: boolean;
  rect?: { x: number; y: number };
  detail?: string;
}> {
  const probe = await js<{ found: boolean; disabled: boolean; x: number; y: number; text: string }>(wc, `(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const vis = all.filter((el) => el.getClientRects().length > 0);
    const el = vis[0] ?? null;
    if (!el) return { found: false, disabled: false, x: 0, y: 0, text: '' };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: (el.getAttribute('aria-label') || el.textContent || '').slice(0, 80),
    };
  })()`);
  if (!probe.found) return { ok: false, found: false, detail: `找不到可见元素 ${selector}` };
  if (probe.disabled) return { ok: false, found: true, disabled: true, detail: `${selector} 处于 disabled（页面还没有可保存的改动？）` };
  wc.sendInputEvent({ type: "mouseMove", x: probe.x, y: probe.y });
  wc.sendInputEvent({ type: "mouseDown", x: probe.x, y: probe.y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: probe.x, y: probe.y, button: "left", clickCount: 1 });
  return { ok: true, found: true, disabled: false, rect: { x: probe.x, y: probe.y } };
}

/** slides 的保存触发：QAT 按钮可点就点它，否则调用它 `onSave` 走的**同一个桥**。 */
export async function triggerSlidesSave(rt: O2Runtime): Promise<{ ok: boolean; observed: unknown; detail?: string }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, observed: null, detail: "slides 视图 webContents 不存在" };
  const result = await js<{ path: string; clicked: boolean; ok?: boolean; error?: string; reason?: string }>(wc, `(async () => {
    const all = [...document.querySelectorAll('button.qa-btn')];
    const save = all.find((b) => /保存|Save/.test(b.getAttribute('aria-label') || ''));
    if (save && !save.hasAttribute('disabled')) {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { path: 'qat-button', clicked: true };
    }
    const r = await Promise.race([
      window.slidesApi.save(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'bridge-timeout' }), 30000)),
    ]);
    return { path: 'bridge-save', clicked: false, ok: !!(r && r.ok), error: r && r.error };
  })()`);
  return { ok: true, observed: result };
}

/** 统一入口：按格式触发保存。返回时**保存可能还在飞**（回包由 observeSave 等）。 */
export async function triggerSave(rt: O2Runtime): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  switch (rt.kind) {
    case "docs":
    case "pdf":
    case "markdown":
    case "html": {
      const sent = await sendCtrlS(rt);
      return sent.ok ? { ok: true, observed: { via: "ctrl-s" } } : { ok: false, detail: sent.detail };
    }
    case "slides": {
      const r = await triggerSlidesSave(rt);
      return r.ok ? { ok: true, observed: r.observed } : { ok: false, detail: r.detail };
    }
    case "sheets": {
      const wc = wcOf(rt);
      if (wc === null) return { ok: false, detail: "sheets 视图 webContents 不存在" };
      const click = await clickInPage(wc, '.qa-btn[aria-label^="保存"], .qa-btn[aria-label^="Save"]');
      return click.ok ? { ok: true, observed: { via: "qat-button", ...click } } : { ok: false, detail: click.detail };
    }
  }
}

/* ───────────────────────────── 外部改动 ───────────────────────────── */

/**
 * 模拟「Agent / 另一个编辑器」改写磁盘上的同一个文件。
 *
 * - 二进制格式：在**当前字节**尾部追加一行标记（sha 变、原格式仍可解析 ——
 *   pdf-lib 对尾随字节容忍，本套件的前置探针实测过）。
 * - markdown / html：写一份合法的纯文本，正文里带标记。
 *
 * 返回写入后的 sha256 与标记（4b 的期望值 / 4c 的证据）。
 */
export function writeExternalEdit(rt: O2Runtime, editedText: string): { sha: string; bytes: number; marker: string; sample: string } {
  const path = rt.fixtures[rt.kind];
  const marker = externalMarker(rt.kind);
  const before = readFileSync(path);
  let external: Buffer;
  if (rt.kind === "markdown") {
    external = Buffer.from(`# O2 external edit\n\n${editedText}\n\n${marker}\n`, "utf8");
  } else if (rt.kind === "html") {
    external = Buffer.from(
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>O2 external</title></head>\n<body><h1>O2 external edit</h1><p>${editedText}</p><!-- ${marker} --></body></html>\n`,
      "utf8",
    );
  } else {
    external = Buffer.concat([before, Buffer.from(`\n${marker}\n`, "utf8")]);
  }
  writeFileSync(path, external);
  return {
    sha: createHash("sha256").update(external).digest("hex"),
    bytes: external.length,
    marker,
    sample: external.subarray(0, 0).length === 0 ? marker : marker,
  };
}

/* ───────────────────────────── 提示（4c） ───────────────────────────── */

/** 每个格式「冲突提示」的 DOM 探针（页面内表达式；返回 `{found, evidence}`）。
 *  只认**可见**元素（getClientRects > 0）：`display:none` 的提示不算用户看得见。 */
export function noticeExpression(kind: EditorKind): string {
  const status = (regex: string): string => `(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const msg = document.querySelector('.status-msg');
    const toast = document.querySelector('.app-toast.error');
    const msgText = ((msg && msg.textContent) || '').trim();
    const toastText = ((toast && toast.textContent) || '').trim();
    const re = new RegExp(${JSON.stringify(regex)});
    const hitMsg = vis(msg) && re.test(msgText);
    const hitToast = vis(toast) && re.test(toastText);
    return {
      found: hitMsg || hitToast,
      evidence: {
        probe: 'status-msg+toast',
        msgVisible: vis(msg),
        msgText: msgText.slice(0, 300),
        toastVisible: vis(toast),
        toastText: toastText.slice(0, 300),
      },
    };
  })()`;
  switch (kind) {
    case "docs":
    case "slides":
      return status("保存失败|Save failed");
    case "sheets":
      // sheets 的失败反馈有两条：状态栏 `setMessage(localizeSaveError(...) ?? appSaveFailed)`
      // 与 `showToast(..., 'error')`（`save-actions.ts` 的 catch）。状态栏可能被
      // 「正在流式加载…」之类的进度消息覆盖，所以两条都认；错误 toast（`.app-toast.error`）
      // 是更稳定的那一条。
      return status("另存为|Save As|磁盘上的改动|changed on disk|保存失败|Save failed");
    case "pdf":
      return `(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const chip = document.querySelector('.tb-save-error');
        const toast = document.querySelector('.pdf-toast-notice');
        const chipText = ((chip && chip.textContent) || '').trim();
        const toastText = ((toast && toast.textContent) || '').trim();
        const re = new RegExp(${JSON.stringify("保存失败|Save failed")});
        return {
          found: (vis(chip) && re.test(chipText)) || (vis(toast) && re.test(toastText)),
          evidence: {
            probe: 'pdf-save-error-chip+notice',
            chipVisible: vis(chip),
            chipText: chipText.slice(0, 300),
            toastVisible: vis(toast),
            toastText: toastText.slice(0, 300),
          },
        };
      })()`;
    case "markdown":
    case "html":
      return `(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const status = document.querySelector('.status-save');
        const cls = (status && status.getAttribute('class')) || '';
        const text = ((status && status.textContent) || '').trim();
        return {
          found: vis(status) && cls.split(/\\s+/).includes('status-failed'),
          evidence: { probe: 'status-save.failed', statusVisible: vis(status), statusClass: cls.slice(0, 160), statusText: text.slice(0, 200) },
        };
      })()`;
  }
}

/** 负控的**正控**：保存成功后同一条提示位上确实出现了「成功」标记。
 *  没有它，`found === false` 可能只是探针从来不工作（判据退化成恒假）。 */
export function successExpression(kind: EditorKind): string {
  const status = (regex: string): string => `(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const msg = document.querySelector('.status-msg');
    const text = ((msg && msg.textContent) || '').trim();
    return { found: vis(msg) && new RegExp(${JSON.stringify(regex)}).test(text), evidence: { probe: 'status-msg.success', msgVisible: vis(msg), msgText: text.slice(0, 300) } };
  })()`;
  switch (kind) {
    case "docs":
    case "slides":
    case "sheets":
      return status("已保存|Saved");
    case "pdf":
      return `(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const ok = document.querySelector('.tb-save-ok');
        const err = document.querySelector('.tb-save-error');
        return { found: vis(ok), evidence: { probe: 'pdf-save-ok', okVisible: vis(ok), okText: ((ok && ok.textContent) || '').trim().slice(0, 120), errorVisible: vis(err) } };
      })()`;
    case "markdown":
    case "html":
      return `(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const status = document.querySelector('.status-save');
        const cls = (status && status.getAttribute('class')) || '';
        return { found: vis(status) && cls.split(/\\s+/).includes('status-saved'), evidence: { probe: 'status-save.saved', statusVisible: vis(status), statusClass: cls.slice(0, 160), statusText: ((status && status.textContent) || '').trim().slice(0, 200) } };
      })()`;
  }
}

export async function probeNotice(rt: O2Runtime, expression: string): Promise<NoticeProbe> {
  const wc = wcOf(rt);
  if (wc === null) return { found: false, evidence: { error: "视图 webContents 不存在" } };
  try {
    const value = await js<{ found?: unknown; evidence?: unknown }>(wc, expression);
    return {
      found: value?.found === true,
      evidence: (value?.evidence !== null && typeof value?.evidence === "object" ? value.evidence : { value: value?.evidence }) as Record<string, unknown>,
    };
  } catch (error) {
    return { found: false, evidence: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/* ───────────────────────────── 观察回包 ───────────────────────────── */

export interface ObserveOptions {
  /** 等保存回包的上限（默认 30s）。 */
  replyTimeoutMs?: number;
  /** 回包落定后继续等提示出现的上限（默认 8s；负控传 0）。 */
  noticeWaitMs?: number;
  /** 负控额外等「成功标记」的上限（默认 0 = 不等）。 */
  successWaitMs?: number;
}

/** 触发之后的完整观察：等回包 → 读盘面 → 看提示（+ 负控的成功标记）。 */
export async function observeSave(rt: O2Runtime, seq: number, opts: ObserveOptions = {}): Promise<SaveObservation> {
  const channels = SAVE_CHANNELS[rt.kind];
  const wcId = rt.webContentsId;
  const replyTimeout = opts.replyTimeoutMs ?? 30_000;

  const record = await pollUntil(async () => {
    const settled = saveRepliesSince(seq).filter(
      (r) => channels.includes(r.channel) && (r.senderId === null || r.senderId === wcId) && (r.reply !== null || r.thrown !== null),
    );
    return settled.length > 0 ? settled[0]! : null;
  }, replyTimeout, 120);

  const allRecords = saveRepliesSince(seq).filter((r) => channels.includes(r.channel) && (r.senderId === null || r.senderId === wcId));
  const recorder = recorderDiagnostics();
  const allChannelsSince = saveRepliesSince(seq).map((r) => ({
    channel: r.channel,
    senderId: r.senderId,
    settled: r.reply !== null || r.thrown !== null,
  }));

  // 回包落定后才读盘：那时保存要么已写、要么已被拒。
  let diskSha: string | null = null;
  try { diskSha = sha256Of(rt.fixtures[rt.kind]); } catch { diskSha = null; }

  let notice: NoticeProbe = { found: false, evidence: { skipped: true } };
  if ((opts.noticeWaitMs ?? 8_000) > 0) {
    const expression = noticeExpression(rt.kind);
    const deadline = Date.now() + (opts.noticeWaitMs ?? 8_000);
    notice = await probeNotice(rt, expression);
    while (!notice.found && Date.now() < deadline) {
      await sleep(150);
      notice = await probeNotice(rt, expression);
    }
  }

  let success: NoticeProbe = { found: false, evidence: { skipped: true } };
  if ((opts.successWaitMs ?? 0) > 0) {
    const expression = successExpression(rt.kind);
    const deadline = Date.now() + (opts.successWaitMs ?? 0);
    success = await probeNotice(rt, expression);
    while (!success.found && Date.now() < deadline) {
      await sleep(120);
      success = await probeNotice(rt, expression);
    }
  }

  return { seq, record: record ?? null, allRecords, allChannelsSince, recorder, diskSha, notice, success, at: Date.now() };
}

/** trigger + observe 一步完成（触发前先取记录器序号）。 */
export async function triggerAndObserve(rt: O2Runtime, opts: ObserveOptions = {}): Promise<{ ok: boolean; observation?: SaveObservation; detail?: string; trigger?: unknown }> {
  const seq = recorderLastSeq();
  const trigger = await triggerSave(rt);
  if (!trigger.ok) return { ok: false, detail: trigger.detail ?? "保存触发失败", trigger: trigger.observed };
  const observation = await observeSave(rt, seq, opts);
  return { ok: true, observation, trigger: trigger.observed };
}

/* ───────────────────────────── 4a：冲突回包判据 ───────────────────────────── */

export interface ConflictJudgement {
  ok: boolean;
  observed: Record<string, unknown>;
  detail?: string;
}

/**
 * 「这次保存是被**版本冲突**拒的」的判据 —— 只看**主进程回包/异常**。
 *
 * 每个格式的真实拒绝形态不同（源码出处见各分支），所以判据也分开写：
 *  - docs：host `saveOpenedFile` 回 `{ok:false, reason:"conflict", currentRevision}`；
 *  - sheets：vendor 保存 handler **抛错**（`sheets-main.ts` 的 `errDiskChanged`）；
 *  - slides：设计上应由 `SlidesBridge` 的 `SLIDES_FILE_VERSION_CONFLICT` 拒绝
 *    （`slidesExecutor.ts`）—— 但生产原生视图走的是 vendor `slides:save` 直写，
 *    本判据会如实报告它**没有**拒绝（这正是卡要发现的事实）。
 *  - pdf/markdown/html：vendor 侧没有任何版本判据；本判据要求「回包是拒绝且
 *    理由属于冲突」，事实上会红 —— 红了就是数据丢失的证据。
 */
export function judgeConflictReply(rt: O2Runtime, observation: SaveObservation): ConflictJudgement {
  const { record, allRecords } = observation;
  const base = {
    channels: SAVE_CHANNELS[rt.kind],
    seq: observation.seq,
    allRecords,
  } as Record<string, unknown>;
  if (record === null) {
    return {
      ok: false,
      observed: { ...base, record: null },
      detail: `${Math.round((Date.now() - observation.at) / 1000)}s 窗口内没有收到任何保存回包（通道 ${SAVE_CHANNELS[rt.kind].join("/")}）—— 触发没有到达主进程`,
    };
  }
  const reply = record.reply ?? {};
  const thrown = record.thrown ?? "";
  const text = `${thrown} ${String(reply.error ?? "")} ${String(reply.reason ?? "")}`;
  switch (rt.kind) {
    case "docs": {
      const conflict = reply.ok === false && reply.reason === "conflict";
      const revisionMatches =
        typeof reply.currentRevision !== "string" || rt.externalSha === undefined
          ? true
          : reply.currentRevision === rt.externalSha;
      return {
        ok: conflict && revisionMatches,
        observed: { ...base, channel: record.channel, reply, thrown: record.thrown, externalSha: rt.externalSha ?? null },
        ...(conflict && !revisionMatches
          ? { detail: `冲突回包带了 currentRevision=${String(reply.currentRevision)}，但盘上外部内容的 sha 是 ${String(rt.externalSha)}` }
          : conflict
            ? {}
            : { detail: `保存没有被版本冲突拒绝（回包 ${JSON.stringify(reply)}${thrown ? `，抛出 ${thrown}` : ""}）` }),
      };
    }
    case "sheets": {
      const conflict = /changed on disk after it was opened|磁盘上的改动/.test(text);
      return {
        ok: conflict,
        observed: { ...base, channel: record.channel, reply, thrown: record.thrown },
        ...(conflict ? {} : { detail: `保存没有被「磁盘已改」判据拒绝（回包 ${JSON.stringify(reply)}${thrown ? `，抛出 ${thrown}` : ""}）` }),
      };
    }
    case "slides": {
      const conflict =
        reply.ok === false && (reply.reason === "conflict" || /FILE_VERSION_CONFLICT/.test(text) || /版本冲突/.test(text));
      return {
        ok: conflict,
        observed: { ...base, channel: record.channel, reply, thrown: record.thrown },
        ...(conflict
          ? {}
          : { detail: `保存没有被版本冲突拒绝（通道 ${record.channel} 回包 ${JSON.stringify(reply)}${thrown ? `，抛出 ${thrown}` : ""}）—— 外部内容已被覆盖` }),
      };
    }
    case "pdf":
    case "markdown":
    case "html": {
      const conflict = reply.ok === false && /conflict|版本冲突/.test(text);
      return {
        ok: conflict,
        observed: { ...base, channel: record.channel, reply, thrown: record.thrown },
        ...(conflict
          ? {}
          : { detail: `保存没有被版本冲突拒绝（通道 ${record.channel} 回包 ${JSON.stringify(reply)}${thrown ? `，抛出 ${thrown}` : ""}）—— 外部内容已被覆盖` }),
      };
    }
  }
}

/* ───────────────────────────── 变异：隐藏提示 ───────────────────────────── */

/** 本套件的运行时变异开关（`O2_MUTATION`）。
 *
 * 为什么用**页面内注入样式**而不是改 vendor 源码（hide-notice）：提示元素长在
 * 六个 vendor 渲染端里（每个都是独立构建产物），改源码要重建六份 renderer；
 * 而判据要证的是「4c 验的是用户看得见」—— 让提示不可见正是那个缺陷形态本身。
 *
 * negative-conflict 不是「让代码变差」，而是**把负控变成一次真冲突**（在保存前
 * 改盘）—— 它模拟的正是「不误报」这条判据要防的缺陷：如果产品永远报冲突，
 * 这条变异必须让它红。 */
export type O2Mutation = "hide-notice" | "negative-conflict";

export function mutationMode(): O2Mutation | null {
  const value = process.env.O2_MUTATION;
  return value === "hide-notice" || value === "negative-conflict" ? value : null;
}

export async function injectHideNotice(rt: O2Runtime): Promise<{ ok: boolean; observed: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, observed: { error: "no webContents" } };
  const result = await js<Record<string, unknown>>(wc, `(() => {
    if (document.getElementById('o2-mut-hide-notice')) return { already: true };
    const style = document.createElement('style');
    style.id = 'o2-mut-hide-notice';
    style.textContent = '.status-msg,.app-toast,.tb-save-error,.tb-save-ok,.status-save,.pdf-toast-notice{display:none!important;visibility:hidden!important}';
    document.head.appendChild(style);
    return { injected: true };
  })()`);
  return { ok: true, observed: result };
}
