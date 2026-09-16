/**
 * 页面元素定位 —— 适配器选择器**优先**，启发式**兜底**。
 *
 * 这一层决定了"通用"能做到什么程度：绝大多数网页版 LLM 的输入框就是页面里主体
 * 区那个 textarea（或 contenteditable），发送/停止/登录就是几个带特定字样的按钮。
 * 用启发式把它们找出来，站点适配器只需要在**差异处**覆盖 —— 于是新增一个站点往往
 * 只需一份声明式配置，不必写代码。
 *
 * 每次发送前重新探测（而不是缓存选择器）：网页是 SPA，路由切换会重建 DOM，缓存
 * 下来的 `nth-of-type` 路径一转页就失效；探测本身很便宜（一次 `evaluate`）。
 *
 * ️ 探测脚本的写法受 BrowserManager.evaluate 约束：它执行的是 `new Function(code)()`，
 * 所以这里生成的是**函数体**（末尾要 `return`），不是 IIFE。
 */
import type { SiteAdapter } from "./adapters/types.js";

/** 一次探测的结果。 */
export interface ElementProbe {
  url: string;
  title: string;
  /** 输入框选择器；null = 没找到（页面没加载完，或官方改版了）。 */
  input: string | null;
  inputKind: "textarea" | "contenteditable" | null;
  /** 发送按钮选择器（`submit: "click"` 时才需要）。 */
  send: string | null;
  /** 停止生成按钮选择器（中断时才需要）。 */
  stop: string | null;
  /** 页面上出现了登录类元素 → 视为未登录。 */
  loggedOut: boolean;
  /** 诊断信息：选择器失配时，这几项能直接告诉我们页面变成了什么样。 */
  diagnostics: {
    textareas: number;
    contentEditables: number;
    buttons: number;
    /** tap 桥是否可用（注入脚本活着的话就是 true）。 */
    hasBridge: boolean;
    /** tap 脚本的命中计数（注入生效且抓到过流的证据）。 */
    tapHits: number;
  };
}

/**
 * 生成探测脚本（函数体形式）。
 *
 * 返回的字段里**同时**包含"找到的选择器"和"页面上有多少候选"：失配时前者是 null、
 * 后者能说明是"页面还没渲染"（0 个）还是"选择器/启发式过时了"（有候选但没匹配上）。
 * 这两种故障的处理方式完全不同，日志里必须能区分。
 */
export function buildProbeScript(adapter: SiteAdapter): string {
  const cfg = JSON.stringify({
    input: adapter.selectors?.input ?? null,
    send: adapter.selectors?.send ?? null,
    stop: adapter.selectors?.stop ?? null,
    loginIndicator: adapter.selectors?.loginIndicator ?? null,
  });
  return `return (function () {
  var CFG = ${cfg};

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = window.getComputedStyle(el);
    if (!s) return true;
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function area(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width * r.height;
    } catch (e) {
      return 0;
    }
  }

  function textOf(el) {
    if (!el) return "";
    var t = el.innerText || el.textContent || "";
    if (!t) t = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    return String(t).trim();
  }

  function query(sel) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  /** 生成一个尽量短、且能在当前文档里唯一定位的选择器。 */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      try {
        return "#" + CSS.escape(el.id);
      } catch (e) {
        return "#" + el.id;
      }
    }
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      var tag = cur.tagName.toLowerCase();
      var parent = cur.parentNode;
      if (parent && parent.children) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === cur.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) tag += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(tag);
      cur = parent;
      depth++;
    }
    return parts.length ? parts.join(" > ") : null;
  }

  /** 主体区最大的可见 textarea / contenteditable —— 几乎总是聊天输入框。 */
  function biggestVisible(selector) {
    var list = [];
    try {
      list = Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (e) {
      list = [];
    }
    var visible = list.filter(isVisible);
    visible.sort(function (a, b) {
      return area(b) - area(a);
    });
    return visible.length ? visible[0] : null;
  }

  /** 按可见文字找按钮（发送/停止/登录这类）。 */
  function buttonByText(re) {
    var sel = 'button,[role="button"],input[type="submit"],a';
    var list = [];
    try {
      list = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      list = [];
    }
    for (var i = 0; i < list.length; i++) {
      if (!isVisible(list[i])) continue;
      var t = textOf(list[i]);
      if (t && re.test(t)) return list[i];
    }
    return null;
  }

  // ── 输入框：适配器选择器优先，失配则找主体区最大的那个 ──
  var input = query(CFG.input);
  if (!input || !isVisible(input)) {
    var ta = biggestVisible("textarea");
    if (ta) {
      input = ta;
    } else {
      input = biggestVisible('[contenteditable="true"],[contenteditable=""]');
    }
  }
  var inputKind = null;
  if (input) {
    inputKind = String(input.tagName).toUpperCase() === "TEXTAREA" ? "textarea" : "contenteditable";
  }

  var send = query(CFG.send) || buttonByText(/发送|send/i);
  var stop = query(CFG.stop) || buttonByText(/停止|中断|stop/i);
  var loginEl = query(CFG.loginIndicator) || buttonByText(/登录|登陆|sign\\s*in|log\\s*in/i);

  var tap = window.__mcodeTap;
  var stats = null;
  try {
    stats = tap && typeof tap.stats === "function" ? tap.stats() : null;
  } catch (e) {
    stats = null;
  }

  return {
    url: location.href,
    title: document.title,
    input: input ? cssPath(input) : null,
    inputKind: inputKind,
    send: send ? cssPath(send) : null,
    stop: stop ? cssPath(stop) : null,
    loggedOut: !!loginEl,
    diagnostics: {
      textareas: document.querySelectorAll("textarea").length,
      contentEditables: document.querySelectorAll('[contenteditable="true"]').length,
      buttons: document.querySelectorAll('button,[role="button"]').length,
      hasBridge: !!(window.mcodeBridge && window.mcodeBridge.dsTapEvent),
      tapHits: stats && typeof stats.hits === "number" ? stats.hits : -1
    }
  };
})();`;
}

/**
 * 从 `evaluate()` 的返回值解出探测结果。
 *
 * evaluate 给回来的 `result` 是**序列化后的字符串**（不是对象）—— 这个细节漏掉
 * 的话，`parseProbeResult` 会一直拿到一个字符串并返回 null，症状是"永远找不到
 * 输入框"，看起来像选择器失配，其实是这里少解了一层。
 */
export function parseProbeResultSerialized(raw: string | undefined): ElementProbe | null {
  if (!raw) return null;
  try {
    return parseProbeResult(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 校验探测结果（页面返回值不受我们控制，进主进程先过形状检查）。 */
export function parseProbeResult(raw: unknown): ElementProbe | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const inputKind = obj["inputKind"];
  const diag = obj["diagnostics"];
  if (typeof diag !== "object" || diag === null) return null;
  const d = diag as Record<string, unknown>;
  const num = (key: string): number => (typeof d[key] === "number" ? (d[key] as number) : 0);
  return {
    url: typeof obj["url"] === "string" ? obj["url"] : "",
    title: typeof obj["title"] === "string" ? obj["title"] : "",
    input: typeof obj["input"] === "string" ? obj["input"] : null,
    inputKind:
      inputKind === "textarea" || inputKind === "contenteditable" ? inputKind : null,
    send: typeof obj["send"] === "string" ? obj["send"] : null,
    stop: typeof obj["stop"] === "string" ? obj["stop"] : null,
    loggedOut: obj["loggedOut"] === true,
    diagnostics: {
      textareas: num("textareas"),
      contentEditables: num("contentEditables"),
      buttons: num("buttons"),
      hasBridge: d["hasBridge"] === true,
      tapHits: num("tapHits"),
    },
  };
}