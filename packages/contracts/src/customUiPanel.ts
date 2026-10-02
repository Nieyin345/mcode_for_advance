/**
 * 自定义 UI 的「自定义面板」(R41)—— 用户写一段 HTML / CSS / JS,在隔离的 iframe 里跑,
 * 通过一组受控接口(`window.mcode`)和 Mcode 打交道。
 *
 * ## 隔离怎么做
 *
 *   - 面板文档由主进程的 `mcode-panel://` 协议吐出(`main/customUi/panelProtocol.ts`),
 *     带**它自己的** CSP。不用 `srcdoc`:srcdoc / blob / data 文档会继承主窗口那条
 *     `script-src 'self'` 的 CSP,内联脚本一行都跑不起来。
 *   - iframe 带 `sandbox="allow-scripts allow-forms allow-modals"`,**没有** `allow-same-origin`
 *     —— 面板是不透明源:碰不到主窗口的 DOM、`window.api`、localStorage、cookie。
 *   - 默认不联网(CSP `connect-src 'none'`,图片 / 字体只收 data:)。条目上勾了 `network`
 *     才放开 https —— 而**导入别人的设置时这一格一律抹掉**(同 shell 的 confirm)。
 *   - 面板能做的事全在下面的 {@link PANEL_METHODS} 里,由渲染端 `PanelFrame` 逐个实现;
 *     有副作用的(跑自动化、写文件、跑命令)默认每次弹确认。
 *
 * 纯模块(不 import electron / DOM),smoke 直接 bundle。
 */
import { z } from "zod";

/** 面板协议名。主进程注册成 standard + secure;主窗口 CSP 的 frame-src 放行它。 */
export const PANEL_SCHEME = "mcode-panel";

/** 用户写的 HTML 上限。够塞一个内联的小图表库,又不至于把设置表撑爆。 */
export const PANEL_HTML_MAX = 400_000;
/** 包好 SDK 之后的整份文档上限(主进程 stage 时校验)。 */
export const PANEL_DOC_MAX = PANEL_HTML_MAX + 40_000;

export const CustomUiStagePanelSchema = z.object({
  html: z.string().min(1).max(PANEL_DOC_MAX),
  network: z.boolean().optional(),
});
export type CustomUiStagePanelInput = z.infer<typeof CustomUiStagePanelSchema>;
export type CustomUiStagePanelResult = { url: string };

/**
 * 面板里的 `mcode.ask()`:一次性问一个模型,拿回纯文本。**不带任何工具**(同标题生成),
 * 面板里的文字再怎么写也驱动不了文件 / 命令。
 *
 * `model`:`@claude` / `@claude:haiku|sonnet|opus`(本机 Claude Code 登录),或
 * `自定义模型id[:角色]`。不给 = 用「标题生成」里选的那个;那里也没选 = 本机 Claude。
 */
export const CustomUiPanelAskSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  system: z.string().max(20_000).optional(),
  model: z.string().max(300).optional(),
});
export type CustomUiPanelAskInput = z.infer<typeof CustomUiPanelAskSchema>;
export type CustomUiPanelAskResult = { ok: boolean; text?: string; error?: string };

/** 面板文档的 CSP。`network` = 允许面板自己联网(fetch / 外链脚本、样式、图片)。 */
export function panelCsp(network: boolean): string {
  const net = network ? " https:" : "";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    `connect-src ${network ? "https: wss:" : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * `window.mcode` 上的方法(也是 postMessage 桥上的 method 名)。设置页的说明照这张表写,
 * 渲染端的实现必须一个不落(`PanelFrame` 里有穷举检查)。
 */
export const PANEL_METHODS = [
  "context",
  "prompt",
  "ask",
  "automations",
  "runAutomation",
  "files.read",
  "files.list",
  "files.write",
  "library.list",
  "library.search",
  "library.read",
  "storage.get",
  "storage.set",
  "storage.remove",
  "copy",
  "openUrl",
  "openFile",
  "shell",
  "toast",
] as const;
export type PanelMethod = (typeof PANEL_METHODS)[number];

export function isPanelMethod(m: unknown): m is PanelMethod {
  return typeof m === "string" && (PANEL_METHODS as readonly string[]).includes(m);
}

/** 面板 → 主窗口的一条请求。 */
export interface PanelRequest {
  __mcode: 1;
  id: number;
  method: string;
  params: unknown;
}

export function isPanelRequest(d: unknown): d is PanelRequest {
  if (!d || typeof d !== "object") return false;
  const r = d as Partial<PanelRequest>;
  return r.__mcode === 1 && typeof r.id === "number" && Number.isFinite(r.id) && typeof r.method === "string";
}

/** 主题:颜色是 CSS 颜色串(`rgb(…)`),键名去掉前缀 —— SDK 设成 `--mc-<键>`。 */
export interface PanelTheme {
  mode: "light" | "dark";
  colors: Record<string, string>;
  fontSize?: string;
}

/** 从主窗口读哪些 CSS 变量(都是 `R G B` 三元组)。 */
export const PANEL_THEME_VARS = [
  "surface",
  "surface-muted",
  "surface-hover",
  "content",
  "content-muted",
  "content-subtle",
  "edge",
  "accent",
  "danger",
  "warning",
  "success",
] as const;

/** 面板默认样式。放在 `@layer` 里 —— 用户自己写的样式(不在 layer 里)永远压得过它。 */
export const PANEL_BASE_CSS = `@layer mcode-base{
:root{--mc-surface:rgb(255 255 255);--mc-surface-muted:rgb(240 242 246);--mc-surface-hover:rgb(226 229 235);--mc-content:rgb(9 9 11);--mc-content-muted:rgb(63 63 70);--mc-content-subtle:rgb(113 113 122);--mc-edge:rgb(213 216 222);--mc-accent:rgb(5 150 105);--mc-danger:rgb(220 38 38);--mc-warning:rgb(180 83 9);--mc-success:rgb(4 120 87);--mc-font-size:14px;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--mc-surface);color:var(--mc-content);font:var(--mc-font-size)/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:12px}
h1,h2,h3{margin:.2em 0 .5em;line-height:1.3}
h1{font-size:1.3em}h2{font-size:1.15em}h3{font-size:1em}
button{font:inherit;color:inherit;background:var(--mc-surface-muted);border:1px solid var(--mc-edge);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{background:var(--mc-surface-hover)}
button.primary{background:var(--mc-accent);border-color:var(--mc-accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
input,textarea,select{font:inherit;color:inherit;background:var(--mc-surface);border:1px solid var(--mc-edge);border-radius:6px;padding:4px 8px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--mc-accent)}
a{color:var(--mc-accent)}
pre,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
pre{background:var(--mc-surface-muted);padding:8px 10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.muted{color:var(--mc-content-subtle)}
.card{border:1px solid var(--mc-edge);border-radius:8px;padding:10px 12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
}`;

/**
 * 注入面板的 SDK。**ES5 写法、不用反引号和 `${`**(它本身就躺在一个模板串里)。
 *
 * - 请求按自增 id 配对;主窗口只认 `e.source === parent` 的回复。
 * - 主窗口推来的事件:`theme`(换主题)、`context`(工作区变了),`mcode.on()` 订阅。
 * - 面板里点 http(s) / mailto 链接 → 交给系统浏览器(iframe 自己导航会被主窗口 CSP 挡掉,
 *   用户只会看到一片空白)。
 */
export const PANEL_SDK_SOURCE = `(function(){
"use strict";
if (window.mcode) return;
var seq = 0, pending = {}, listeners = {};
function call(method, params){
  return new Promise(function(resolve, reject){
    var id = ++seq;
    pending[id] = { resolve: resolve, reject: reject };
    parent.postMessage({ __mcode: 1, id: id, method: method, params: params === undefined ? null : params }, "*");
  });
}
function applyTheme(t){
  if (!t || typeof t !== "object") return;
  var root = document.documentElement, colors = t.colors || {};
  Object.keys(colors).forEach(function(k){ root.style.setProperty("--mc-" + k, colors[k]); });
  if (t.fontSize) root.style.setProperty("--mc-font-size", t.fontSize);
  root.setAttribute("data-theme", t.mode === "dark" ? "dark" : "light");
  root.style.colorScheme = t.mode === "dark" ? "dark" : "light";
}
window.addEventListener("message", function(e){
  if (e.source !== parent) return;
  var d = e.data;
  if (!d || d.__mcode !== 1) return;
  if (typeof d.id === "number") {
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) p.resolve(d.result); else p.reject(new Error(String(d.error || "error")));
    return;
  }
  if (typeof d.event === "string") {
    if (d.event === "theme") applyTheme(d.data);
    (listeners[d.event] || []).slice().forEach(function(fn){ try { fn(d.data); } catch (err) { console.error(err); } });
  }
});
document.addEventListener("click", function(e){
  var el = e.target;
  while (el && el.nodeType === 1 && el.tagName !== "A") el = el.parentNode;
  if (!el || el.nodeType !== 1) return;
  var href = el.getAttribute("href") || "";
  if (/^(https?:|mailto:)/i.test(href)) { e.preventDefault(); call("openUrl", { url: href }); }
}, true);
function str(v){ return v === undefined || v === null ? "" : String(v); }
var mcode = {
  version: 1,
  call: call,
  on: function(event, fn){
    (listeners[event] = listeners[event] || []).push(fn);
    return function(){ listeners[event] = (listeners[event] || []).filter(function(f){ return f !== fn; }); };
  },
  context: function(){ return call("context"); },
  prompt: function(text){ return call("prompt", { text: str(text) }); },
  ask: function(prompt, opts){
    var o = opts || {};
    return call("ask", { prompt: str(prompt), system: o.system, model: o.model }).then(function(r){ return r.text; });
  },
  automations: function(){ return call("automations"); },
  runAutomation: function(workflowId, triggerNodeId){ return call("runAutomation", { workflowId: str(workflowId), triggerNodeId: triggerNodeId }); },
  files: {
    read: function(path){ return call("files.read", { path: str(path) }).then(function(r){ return r.content; }); },
    list: function(path){ return call("files.list", { path: str(path) }); },
    write: function(path, content){ return call("files.write", { path: str(path), content: str(content) }); }
  },
  library: {
    list: function(opts){ return call("library.list", opts || {}); },
    search: function(query, opts){ var o = opts || {}; return call("library.search", { query: str(query), limit: o.limit }); },
    read: function(id){ return call("library.read", { id: str(id) }).then(function(r){ return r.markdown; }); }
  },
  storage: {
    get: function(key){ return call("storage.get", { key: str(key) }); },
    set: function(key, value){ return call("storage.set", { key: str(key), value: value === undefined ? null : value }); },
    remove: function(key){ return call("storage.remove", { key: str(key) }); }
  },
  copy: function(text){ return call("copy", { text: str(text) }); },
  openUrl: function(url){ return call("openUrl", { url: str(url) }); },
  openFile: function(path){ return call("openFile", { path: str(path) }); },
  shell: function(command){ return call("shell", { command: str(command) }); },
  toast: function(message, kind){ return call("toast", { message: str(message), kind: kind || "info" }); }
};
window.mcode = mcode;
call("context").then(function(c){ if (c && c.theme) applyTheme(c.theme); }).catch(function(){});
})();`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 用户写的 HTML → 一份完整文档(SDK + 默认样式在最前面,用户的脚本跑起来时
 * `window.mcode` 已经在了)。
 *
 * 用户可以只写一个片段(最常见),也可以写整份 `<html>`:后者把 SDK 插进 `<head>` 开头。
 */
export function buildPanelDocument(userHtml: string, opts: { title?: string; locale?: string } = {}): string {
  const head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${PANEL_BASE_CSS}</style><script>${PANEL_SDK_SOURCE}</script>`;
  if (/<html[\s>]/i.test(userHtml)) {
    if (/<head[\s>]/i.test(userHtml)) return userHtml.replace(/<head(\s[^>]*)?>/i, (m) => m + head);
    return userHtml.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`);
  }
  const lang = opts.locale === "en" ? "en" : "zh-CN";
  const title = opts.title ? `<title>${escapeHtml(opts.title)}</title>` : "";
  return `<!doctype html><html lang="${lang}"><head>${head}${title}</head><body>${userHtml}</body></html>`;
}

/** 面板的 localStorage 配额(每个面板一份 JSON)。 */
export const PANEL_STORAGE_MAX = 1_000_000;

/** 只放行 http(s) / mailto(同 url 动作)。 */
export function isSafePanelUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

/** 设置页「插入示例」用的示例面板。演示读上下文、问模型、发到输入框、存东西。 */
export function panelExampleHtml(locale: "zh" | "en"): string {
  const zh = locale === "zh";
  const L = zh
    ? {
        title: "我的面板",
        project: "当前项目",
        none: "（没有打开项目）",
        placeholder: "写点什么，让模型帮你改写…",
        ask: "问模型",
        send: "放进输入框",
        notes: "便签（自动保存）",
        thinking: "思考中…",
        ctx: "上下文变量",
      }
    : {
        title: "My panel",
        project: "Project",
        none: "(no project open)",
        placeholder: "Type something for the model to rewrite…",
        ask: "Ask model",
        send: "Put in composer",
        notes: "Notes (auto-saved)",
        thinking: "Thinking…",
        ctx: "Context variables",
      };
  return `<h2>${L.title}</h2>
<p class="muted">${L.project}: <b id="proj"></b></p>

<div class="card">
  <textarea id="q" rows="3" style="width:100%" placeholder="${L.placeholder}"></textarea>
  <div class="row" style="margin-top:6px">
    <button class="primary" id="ask">${L.ask}</button>
    <button id="send">${L.send}</button>
  </div>
  <pre id="out" style="display:none"></pre>
</div>

<h3 style="margin-top:14px">${L.notes}</h3>
<textarea id="notes" rows="4" style="width:100%"></textarea>

<details style="margin-top:10px"><summary class="muted">${L.ctx}</summary><pre id="vars"></pre></details>

<script>
  const $ = (id) => document.getElementById(id);
  async function refresh() {
    const ctx = await mcode.context();
    $("proj").textContent = ctx.vars["project.name"] || ${JSON.stringify(L.none)};
    $("vars").textContent = JSON.stringify(ctx.vars, null, 2);
  }
  mcode.on("context", refresh);
  refresh();

  $("ask").onclick = async () => {
    const out = $("out");
    out.style.display = "block";
    out.textContent = ${JSON.stringify(L.thinking)};
    try {
      out.textContent = await mcode.ask($("q").value, { system: ${JSON.stringify(zh ? "用简洁的中文回答。" : "Answer concisely.")} });
    } catch (e) {
      out.textContent = String(e.message || e);
    }
  };
  $("send").onclick = () => mcode.prompt($("q").value);

  mcode.storage.get("notes").then((v) => { $("notes").value = v || ""; });
  let t;
  $("notes").oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => mcode.storage.set("notes", $("notes").value), 400);
  };
</script>
`;
}
