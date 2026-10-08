/**
 * Page-injection scripts for the agent browser tools, executed in the browser
 * view's page main world via `webContents.executeJavaScript()`.
 *
 * Like `pickerScript.ts`, these are string constants (NOT modules) because
 * executeJavaScript runs in the page's own context with no access to our
 * process's module scope. Each IIFE takes its arguments as JSON-stringified
 * slots (`%XXX_JSON%`) that `build*Script()` fills with {@link fillSlot} —
 * which produces a valid JS string literal, so quotes / backslashes /
 * newlines in selectors, texts and code can never break out of the script
 * syntax. Values are only ever consumed by `JSON.parse` / `querySelector`,
 * never interpolated into the source.
 *
 * ⚠️ **The fill must go through a replacer FUNCTION, not a plain string.** A
 * string replacement interprets `$$`, `` $` ``, `$&` and `$'` as replacement
 * patterns — so a model-supplied `browser_evaluate` script like
 * `` `Total: $${cost}` `` would silently lose a `$` (its literal-`$` escape
 * turned into real interpolation), and a selector/text/typed text containing
 * `` $` `` would throw a page-side SyntaxError. `fillSlot` passes
 * `() => json`, which disables that interpretation entirely.
 *
 * The IIFEs return plain JSON-serializable objects, which Electron
 * auto-marshals back across the process boundary as the awaited return value.
 */
import { SELECTOR_BUILDER_SNIPPET } from "./selectorBuilder.js";


/** Caps so a giant page can't blow up the agent's context window. */
export const SNAPSHOT_HTML_CAP = 20000;
export const SNAPSHOT_TEXT_CAP = 8000;
/** Cap the number of interactive elements collected from the page. */
export const SNAPSHOT_INTERACTIVE_CAP = 200;
/** Cap the number of interactive elements RENDERED into the tool result text
 *  (the collection cap above is larger so the index map stays useful deeper
 *  into the page; the text budget is what bounds the model's context). */
export const SNAPSHOT_DISPLAY_CAP = 80;

/**
 * Snapshot script. Returns `{ url, title, readyState, html, bodyText,
 * interactive }`. Each `interactive` entry carries a 1-based `index` (the
 * handle the model passes to `browser_click` / `browser_type` /
 * `browser_select`), the form state needed to understand the page (value /
 * checked / disabled / placeholder / href), an `inView` flag (element is
 * inside the viewport — false means the model should scroll before clicking),
 * and the stable `selector` as a fallback handle.
 */
export const SNAPSHOT_SCRIPT = `
(function () {
  var htmlCap = ${SNAPSHOT_HTML_CAP};
  var textCap = ${SNAPSHOT_TEXT_CAP};
  var intCap = ${SNAPSHOT_INTERACTIVE_CAP};

  function clip(s, n) {
    if (!s) return '';
    s = String(s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }
  ${SELECTOR_BUILDER_SNIPPET}


  // Best-effort accessible name: aria-label/aria-labelledby > associated
  // <label> > placeholder > visible inner text.
  function accName(el) {
    var labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      var targets = labelled.split(/\\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      if (targets.length) return clip(targets.map(function (t) { return t.textContent; }).join(' '), 80);
    }
    var al = el.getAttribute('aria-label');
    if (al) return clip(al, 80);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent) return clip(lbl.textContent, 80);
      }
      var ph = el.getAttribute('placeholder');
      if (ph) return clip(ph, 80);
    }
    return clip(el.textContent, 80);
  }

  // Current form state of an element, as human-readable annotations the model
  // can read directly (value / checked / disabled / placeholder / href).
  function stateAnnotations(el) {
    var parts = [];
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var v = '';
      if (el.type === 'checkbox' || el.type === 'radio') {
        parts.push(el.checked ? '[checked]' : '[unchecked]');
      } else {
        try { v = String(el.value || ''); } catch (e) { v = ''; }
        if (v) parts.push('value=' + JSON.stringify(clip(v, 40)));
      }
      if (el.disabled) parts.push('[disabled]');
      if (el.readOnly) parts.push('[readonly]');
    } else if (el.tagName === 'SELECT') {
      var sel = el.selectedOptions && el.selectedOptions[0];
      if (sel) parts.push('value=' + JSON.stringify(clip(sel.value, 40)));
      if (el.disabled) parts.push('[disabled]');
    }
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) parts.push('placeholder=' + JSON.stringify(clip(ph, 40)));
    if (el.tagName === 'A' && el.href) parts.push('href=' + JSON.stringify(clip(el.href, 80)));
    return parts;
  }

  var interactive = [];
  var selector = 'a, button, input, select, textarea, [role], h1, h2, h3, h4, h5, h6';
  var nodes = document.querySelectorAll(selector);
  var vw = window.innerWidth || 0;
  var vh = window.innerHeight || 0;
  for (var i = 0; i < nodes.length && interactive.length < intCap; i++) {
    var el = nodes[i];
    // Skip elements not visible in the layout (display:none / hidden ancestors).
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    }
    // inView: any part of the element's rect intersects the viewport. Elements
    // below the fold are still collected — the model scrolls to reach them.
    var inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    interactive.push({
      index: interactive.length + 1,
      role: role,
      name: accName(el),
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      text: clip(el.textContent, 60),
      inView: inView,
      state: stateAnnotations(el),
    });
  }

  var html = document.documentElement ? document.documentElement.outerHTML : '';
  var bodyText = document.body ? document.body.innerText : '';

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    html: clip(html, htmlCap),
    bodyText: clip(bodyText, textCap),
    interactive: interactive,
  };
})();
`;

/**
 * Click script (fallback path): locates an element by CSS selector and clicks
 * it programmatically. This triggers the DOM `click` event and framework
 * handlers, but NOT the full input pipeline (no hover/mousedown sequence), so
 * the primary click path is a real mouse event pair dispatched from the main
 * process at the element's center (see ELEMENT_CENTER_SCRIPT). This fallback
 * still works for hidden/zero-size elements that a programmatic click can
 * reach. Returns the post-click url + title so the caller can tell whether the
 * click triggered a navigation.
 */
export const CLICK_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'selector 不是合法的 JSON' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'selector 是空的' };
  var el = document.querySelector(sel);
  if (!el) return { error: '找不到选择器对应的元素: ' + sel };
  try {
    el.click();
  } catch (e) {
    return { error: 'browser_click 执行出错: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, url: location.href, title: document.title };
})(%SELECTOR_JSON%);
`;

/**
 * Element-center resolution for the real-mouse click path: scrolls the element
 * into view, computes its viewport-center coordinates (for
 * `webContents.sendInputEvent` mouse events — same CSS-pixel space as
 * getBoundingClientRect), and checks what actually sits at that point
 * (`document.elementFromPoint`) so an overlay covering the target can be
 * reported instead of silently click-jacked. Returns `{ fallback: true }` when
 * the element has no layout box (the caller should fall back to CLICK_SCRIPT).
 */
export const ELEMENT_CENTER_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'selector 不是合法的 JSON' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'selector 是空的' };
  var el = document.querySelector(sel);
  if (!el) return { error: '找不到选择器对应的元素: ' + sel };
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* detached */ }
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { fallback: true };
  var x = Math.round(r.left + r.width / 2);
  var y = Math.round(r.top + r.height / 2);
  var hit = null;
  try { hit = document.elementFromPoint(x, y); } catch (e) { /* noop */ }
  var obscured = null;
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    obscured = {
      tag: hit.tagName.toLowerCase(),
      text: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  }
  return { ok: true, x: x, y: y, obscured: obscured, url: location.href, title: document.title };
})(%SELECTOR_JSON%);
`;

/**
 * Type/fill script: locates an element by CSS selector and sets its value to
 * the given text. Handles <input>, <textarea> and contenteditable elements.
 *
 * Value-setting strategy: instead of assigning `el.value = text` directly
 * (which silently no-ops on React/Vue controlled inputs because the framework
 * owns the value via its own setter), we use the element prototype's native
 * value setter and then dispatch `input` + `change` events. React's onChange
 * listens to the native `input` event, so the framework's state updates and
 * the controlled value round-trips correctly.
 *
 * `clear=false` appends to the current value instead of replacing it.
 * The element is focused, so a follow-up browser_keys({keys:"Enter"}) acts on
 * it (form submission etc).
 */
export const TYPE_SCRIPT = `
(function (selectorJson, textJson, clearJson) {
  var sel, text, clear;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'selector 不是合法的 JSON' }; }
  try { text = JSON.parse(textJson); } catch (e) { return { error: 'text 不是合法的 JSON' }; }
  try { clear = JSON.parse(clearJson); } catch (e) { clear = true; }
  if (typeof sel !== 'string' || !sel) return { error: 'selector 是空的' };
  if (typeof text !== 'string') return { error: 'text 必须是字符串' };
  if (clear !== false) clear = true;
  var el = document.querySelector(sel);
  if (!el) return { error: '找不到选择器对应的元素: ' + sel };
  try {
    el.focus();
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // Contenteditable: replace/append text content directly.
      el.textContent = clear ? text : (el.textContent || '') + text;
    } else if (el.tagName === 'TEXTAREA') {
      var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      var current = clear ? '' : String(el.value || '');
      desc.set.call(el, current + text);
    } else if (el.tagName === 'INPUT') {
      var proto = Object.getPrototypeOf(el);
      var inputDesc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (!inputDesc || !inputDesc.set) return { error: '无法设置输入框的值(页面覆盖了 setter)' };
      if (el.type === 'checkbox' || el.type === 'radio') return { error: '这是复选框/单选框 —— 请改用 browser_click' };
      var cur = clear ? '' : String(el.value || '');
      inputDesc.set.call(el, cur + text);
    } else {
      return { error: '元素不是输入框、textarea 或 contenteditable: ' + sel };
    }
    // Dispatch change/input so framework state (React/Vue) picks the value up.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { error: 'browser_type 执行出错: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, value: String(el.value !== undefined ? el.value : ''), url: location.href, title: document.title };
})(%SELECTOR_JSON%, %TEXT_JSON%, %CLEAR_JSON%);
`;

/**
 * Scroll script: scrolls the window (or a specific element's scrollable box)
 * by a fraction of the viewport height. Returns the resulting scroll position
 * so the model can tell where it landed and whether more content remains.
 */
export const SCROLL_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: '参数不是合法的 JSON' }; }
  var dir = arg.dir === 'up' ? -1 : 1;
  var pages = typeof arg.pages === 'number' && isFinite(arg.pages) && arg.pages > 0 ? arg.pages : 1;
  var target = null;
  if (arg.selector) {
    target = document.querySelector(arg.selector);
    if (!target) return { error: '找不到选择器对应的元素: ' + arg.selector };
  }
  var amount = Math.round(pages * (target ? target.clientHeight : window.innerHeight));
  if (target) {
    target.scrollTop = target.scrollTop + dir * amount;
  } else {
    window.scrollBy(0, dir * amount);
  }
  return {
    ok: true,
    scrollY: Math.round(target ? target.scrollTop : window.scrollY),
    scrollHeight: target ? target.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0),
    viewport: target ? target.clientHeight : window.innerHeight,
    url: location.href,
    title: document.title,
  };
})(%ARG_JSON%);
`;

/**
 * One poll of the wait condition: element presence (optionally requiring a
 * non-zero layout box) and/or text presence in body innerText. The main
 * process loops this on an interval until it reports found or times out.
 */
export const WAIT_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: '参数不是合法的 JSON' }; }
  if (arg.selector) {
    var el = document.querySelector(arg.selector);
    if (!el) return { found: false, reason: 'selector 未出现' };
    if (arg.requireVisible !== false) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return { found: false, reason: 'selector 已出现但仍不可见' };
      }
    }
    return { found: true, url: location.href, title: document.title };
  }
  if (arg.text) {
    var body = document.body ? document.body.innerText : '';
    if (body.indexOf(arg.text) === -1) return { found: false, reason: '文本未出现' };
    return { found: true, url: location.href, title: document.title };
  }
  return { found: true, url: location.href, title: document.title };
})(%ARG_JSON%);
`;

/**
 * Native <select> dropdown: selects the option matching value or exact visible
 * text, and dispatches input/change so framework state updates. On no match,
 * returns the option list (value + text) so the model can retry with an exact
 * spelling instead of guessing. Custom (div-based) dropdown widgets are NOT
 * native selects — the error says to click them open instead.
 */
export const SELECT_SCRIPT = `
(function (selectorJson, valueJson) {
  var sel, value;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'selector 不是合法的 JSON' }; }
  try { value = JSON.parse(valueJson); } catch (e) { return { error: 'value 不是合法的 JSON' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'selector 是空的' };
  var el = document.querySelector(sel);
  if (!el) return { error: '找不到选择器对应的元素: ' + sel };
  if (el.tagName !== 'SELECT') {
    return { error: '元素不是原生 <select>(自定义下拉组件请用 browser_click 展开后再点击选项): ' + sel };
  }
  var opts = [];
  for (var i = 0; i < el.options.length && i < 60; i++) {
    var o = el.options[i];
    opts.push({ value: o.value, text: (o.text || '').trim(), selected: o.selected });
  }
  var v = String(value == null ? '' : value).trim();
  var target = null;
  for (var j = 0; j < el.options.length; j++) {
    var oj = el.options[j];
    if (oj.value === v || (oj.text || '').trim() === v) { target = oj; break; }
  }
  if (!target) {
    return { error: '没有匹配 "' + v + '" 的选项(注意大小写与空格)', options: opts };
  }
  try {
    el.focus();
    el.value = target.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { error: 'browser_select 执行出错: ' + (e && e.message ? e.message : String(e)) };
  }
  return {
    ok: true,
    selected: { value: target.value, text: (target.text || '').trim() },
    url: location.href,
    title: document.title,
  };
})(%SELECTOR_JSON%, %VALUE_JSON%);
`;

/**
 * Find/search script — the cheap alternative to dumping raw HTML:
 *  - selector mode: querySelectorAll under an optional scope, returning each
 *    element's tag/text plus a stable selector (so a found row can be clicked)
 *    and any requested attributes (href/src/class/…).
 *  - text mode: literal or regex search over the page text (optionally scoped)
 *    returning surrounding-context snippets.
 */
export const FIND_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: '参数不是合法的 JSON' }; }
  var maxResults = typeof arg.maxResults === 'number' && arg.maxResults > 0 ? Math.min(arg.maxResults, 100) : 25;
  function clip(s, n) {
    if (!s) return '';
    s = String(s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }
    ${SELECTOR_BUILDER_SNIPPET}
  var scope = document;
  if (arg.cssScope) {
    scope = document.querySelector(arg.cssScope);
    if (!scope) return { error: 'cssScope 未匹配到元素: ' + arg.cssScope };
  }
  if (arg.selector) {
    var attrs = Array.isArray(arg.attributes) ? arg.attributes.filter(function (a) { return typeof a === 'string'; }).slice(0, 8) : null;
    var out = [];
    var nodes = scope.querySelectorAll(arg.selector);
    for (var i = 0; i < nodes.length && out.length < maxResults; i++) {
      var el = nodes[i];
      var item = { tag: el.tagName.toLowerCase(), text: clip(el.textContent, 120), selector: buildSelector(el) };
      if (attrs && attrs.length) {
        var a = {};
        for (var k = 0; k < attrs.length; k++) {
          var name = attrs[k];
          var v = null;
          if (name === 'href' && el.href) v = el.href;
          else if (name === 'src' && el.src) v = el.src;
          else v = el.getAttribute(name);
          if (v) a[name] = clip(v, 300);
        }
        item.attributes = a;
      }
      out.push(item);
    }
    return { ok: true, total: nodes.length, matches: out, url: location.href, title: document.title };
  }
  if (arg.text) {
    var src = (scope === document ? (document.body ? document.body.innerText : '') : scope.innerText) || '';
    var flags = arg.caseSensitive ? 'g' : 'gi';
    var re;
    try {
      re = arg.regex ? new RegExp(arg.text, flags) : new RegExp(arg.text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), flags);
    } catch (e) {
      return { error: '无效的正则表达式: ' + e.message };
    }
    var matches = [];
    var m;
    while ((m = re.exec(src)) !== null && matches.length < maxResults) {
      var start = Math.max(0, m.index - (arg.contextChars || 150));
      var end = Math.min(src.length, m.index + m[0].length + (arg.contextChars || 150));
      matches.push({ snippet: src.slice(start, m.index) + '»' + m[0] + '«' + src.slice(m.index + m[0].length, end) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { ok: true, matches: matches, url: location.href, title: document.title };
  }
  return { error: '需要 selector 或 text 参数之一' };
})(%ARG_JSON%);
`;

/**
 * Evaluate script: runs arbitrary JS in the page's main world via
 * `new Function(code)()` and returns a JSON-serialized view of the result.
 * This is the "model can modify the page DOM directly" escape hatch —
 * anything reachable from the page (text nodes, styles, attributes, events)
 * can be changed. Result serialization: JSON.stringify succeeds for plain
 * data; DOM elements, functions and cyclic objects fall back to
 * String(result), and undefined reports "(undefined)".
 */
export const EVALUATE_SCRIPT = `
(function (scriptJson) {
  var code;
  try { code = JSON.parse(scriptJson); } catch (e) { return { error: 'script 不是合法的 JSON' }; }
  if (typeof code !== 'string' || !code) return { error: 'script 是空的' };
  var result;
  try {
    result = new Function(code)();
  } catch (e) {
    return { error: 'browser_evaluate 执行出错: ' + (e && e.message ? e.message : String(e)) };
  }
  var text;
  if (result === undefined) {
    text = '(undefined)';
  } else {
    try {
      text = JSON.stringify(result, null, 2);
      if (text === undefined) text = String(result);
    } catch (e) {
      text = String(result);
    }
  }
  return { ok: true, result: text, url: location.href, title: document.title };
})(%SCRIPT_JSON%);
`;

/**
 * File-input pre-check for browser_upload_file: verifies the selector hits an
 * enabled `<input type="file">` BEFORE the CDP round-trip, so the model gets a
 * readable error (CDP's own DOM.setFileInputFiles failure messages are
 * cryptic about which side failed). Read-only.
 */
export const CHECK_FILE_INPUT_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'selector 不是合法的 JSON' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'selector 是空的' };
  var el = document.querySelector(sel);
  if (!el) return { error: '找不到选择器对应的元素: ' + sel };
  if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') {
    return { error: '元素不是 <input type="file">' + (el.tagName === 'INPUT' ? '(type=' + el.type + ')' : '') + ': ' + sel };
  }
  if (el.disabled) return { error: '文件输入框已被禁用: ' + sel };
  return { ok: true, multiple: !!el.multiple };
})(%SELECTOR_JSON%);
`;

/* ── script builders ────────────────────────────────────────────────────
 * Each fills the JSON slots of its script constant. JSON.stringify output
 * is a valid JS string literal, so arbitrary model-supplied values are
 * injection-safe.
 *
 * ⚠️ **必须用替换函数 `() => json`,不能直接把 json 当替换串传。**
 * `String.prototype.replace` 会把替换**字符串**里的 `$$`/`` $` ``/`$&`/`$'`
 * 当替换模式解释,于是:
 *   - `` `Total: $${cost}` ``(模板字面量里转义一个字面 `$`)会静默变成
 *     `` `Total: ${cost}` `` —— 模型给的代码语义被悄悄改了;
 *   - 含 `` $` `` 的选择器/文本会直接抛 SyntaxError。
 * 换成函数就不会解释这些序列。
 * ────────────────────────────────────────────────────────────────────── */

/** 把一个 JSON 字符串安全地填进脚本的 `%XXX_JSON%` 槽。 */
export function fillSlot(script: string, slot: string, json: string): string {
  return script.replace(slot, () => json);
}

export function buildClickScript(selector: string): string {
  return fillSlot(CLICK_SCRIPT, "%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildCheckFileInputScript(selector: string): string {
  return fillSlot(CHECK_FILE_INPUT_SCRIPT, "%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildEvaluateScript(code: string): string {
  return fillSlot(EVALUATE_SCRIPT, "%SCRIPT_JSON%", JSON.stringify(JSON.stringify(code)));
}

export function buildElementCenterScript(selector: string): string {
  return fillSlot(ELEMENT_CENTER_SCRIPT, "%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildTypeScript(selector: string, text: string, clear = true): string {
  return fillSlot(
    fillSlot(fillSlot(TYPE_SCRIPT, "%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector))), "%TEXT_JSON%", JSON.stringify(JSON.stringify(text))),
    "%CLEAR_JSON%",
    JSON.stringify(JSON.stringify(clear)),
  );
}

export function buildScrollScript(arg: { selector?: string; direction: "up" | "down"; pages: number }): string {
  return fillSlot(
    SCROLL_SCRIPT,
    "%ARG_JSON%",
    JSON.stringify(JSON.stringify({ selector: arg.selector, dir: arg.direction, pages: arg.pages })),
  );
}

export function buildWaitScript(arg: { selector?: string; text?: string }): string {
  return fillSlot(
    WAIT_SCRIPT,
    "%ARG_JSON%",
    JSON.stringify(JSON.stringify({ selector: arg.selector, text: arg.text })),
  );
}

export function buildSelectScript(selector: string, value: string): string {
  return fillSlot(
    fillSlot(SELECT_SCRIPT, "%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector))),
    "%VALUE_JSON%",
    JSON.stringify(JSON.stringify(value)),
  );
}

export function buildFindScript(arg: {
  selector?: string;
  text?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextChars?: number;
  maxResults?: number;
  attributes?: string[];
  cssScope?: string;
}): string {
  return fillSlot(FIND_SCRIPT, "%ARG_JSON%", JSON.stringify(JSON.stringify(arg)));
}
