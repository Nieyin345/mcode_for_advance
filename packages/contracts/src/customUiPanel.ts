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

/**
 * 面板渲染结果「读回」的上限(R41 / 报告 E10)。面板自己把 `document.body` 的文本与
 * HTML 各截到这么长再回给宿主 —— 一个渲染出大表格 / 长列表的面板,不截会把一整坨
 * DOM 塞进 agent 的上下文。
 */
export const PANEL_PROBE_TEXT_MAX = 200_000;
export const PANEL_PROBE_HTML_MAX = 400_000;
/** 宿主发起读回后,等面板回话的上限。超时 = 面板没在听(没加载好 / 脚本报错卡住)。 */
export const PANEL_PROBE_TIMEOUT_MS = 2_000;
/**
 * 「版式摘要」(报告 Q1)一次给多少元素、每个元素的文字截多长。一个渲染出大表格的面板
 * 若不设上限,摘要本身就会把上下文撑爆 —— 与文本 / HTML 的上限同一个理由。
 */
export const PANEL_LAYOUT_MAX_ELEMENTS = 120;
export const PANEL_LAYOUT_TEXT_MAX = 60;

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

/**
 * 面板的 `mcode.api.call(method, input)` —— 调**任意一个 Mcode 主进程方法**
 * (与界面点按钮、与 agent 的 `app_api_call` 走的是同一段 handler)。
 *
 * ## 为什么要有它
 *
 * 面板从前只能干那 19 件写死的事(读库、写项目文件、跑自动化……)。要做一个"新功能",
 * 数据却没处放、库里的条目改不了 —— 因为面板够不到别的能力。这条把它们全接上:
 * `library.saveNote`(把结果挂到那条论文)、`session.list`、`git.log`、`workflow.save`……
 * 都能调。
 *
 * ## 权限:复用 agent 那一套,不在这一层另判
 *
 * 面板的调用与 agent 的 `app_api_call` **共用同一个分类器**(`main/appControl/policy.ts`
 * 的 `policyFor`):只读 / 界面档直接执行;写档要先经用户确认;高风险档**每次**都确认;
 * 不开放档(密钥类、重置令牌、公网 MCP 开关……)一律拒绝。分类与执行都在**主进程**做
 * ——面板改不了 `approved` 这个位,它只能经 `PanelFrame` 的桥发出 `{method, input}`。
 */
export const CustomUiPanelApiSchema = z.object({
  /** 方法名,如 `library.saveNote` / `session.list`(点号形式,同 `app_api_call`)。 */
  method: z.string().min(1).max(200),
  /** 该方法的入参;无参方法省略。 */
  input: z.unknown().optional(),
  /**
   * 用户在确认框上点了头之后由**渲染端的桥**补上(面板自己发不出这个位 —— 它只能经
   * `handlePanelCall`,而那一层是我们写的)。只对 write/danger 档有意义。
   */
  approved: z.boolean().optional(),
  /** 面板的显示名 —— 只用于确认框正文(哪个面板要调什么),不参与任何判据。 */
  panelLabel: z.string().max(200).optional(),
  /**
   * 【MC-014】可选的幂等键 —— 与 Agent 的 `operation_id`、桌面 IPC 的
   * `__operationId`、手机 RPC 的 `operationId` 是**同一个概念**:面板脚本重试同一件
   * 写操作时原样带回,宿主保证**只执行一次**。省略 = 不去重(旧行为)。
   * 只对 write / danger 档生效;只读方法带键也不会进账本。
   */
  operationId: z.string().max(200).optional(),
});
export type CustomUiPanelApiInput = z.infer<typeof CustomUiPanelApiSchema>;
export type CustomUiPanelApiResult = {
  ok: boolean;
  /** 成功时的返回值(已打码)。 */
  result?: unknown;
  error?: string;
  /** 需要用户确认:渲染端的桥据它弹确认框,点头后带 `approved: true` 重调。 */
  needsApproval?: boolean;
  /** 需要的档位(write = 一次确认;danger = 每次确认、不记「总是允许」)。 */
  level?: "write" | "danger";
  /** 确认框正文(方法名 + 说明)。 */
  description?: string;
};

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
  "api.call",
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
  "extension.readFile",
  "extension.writeFile",
  "extension.listFiles",
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

/**
 * 「读回」时**单个元素**的版式摘要(报告 Q1)。
 *
 * 用户对 `read_panel` 的原始要求是「像给浏览器截屏一样看图」—— 真出一张 PNG。但面板跑在
 * **opaque origin** 的沙箱 iframe 里(没有 `allow-same-origin`):外层窗口读不到它的 DOM,
 * 而面板本身也没有 canvas 截图依赖;`capturePage` 只能截**整个 webContents**(主窗口),
 * 截不到这块 iframe。在没有新依赖的前提下,能给 agent 的**降级之「看」**就是把面板的
 * 版式结构化:**元素在哪儿、多大、什么颜色 / 字号、有没有溢出容器 / 横向超出视口** ——
 * agent 据此能判断「元素重叠了吗 / 超出容器了吗 / 颜色是不是错的」。
 */
export interface PanelLayoutElement {
  tag: string;
  id?: string;
  cls?: string;
  /** 该元素(叶子)直接可见文字的前若干字符 —— 判断「这块是什么」。 */
  text?: string;
  /** 相对面板视口的矩形(px,取整)。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 计算字号的 `font-size`(判断「太小 / 看不见」)。 */
  fontSize?: string;
  /** 计算前景色 `color`(判断「颜色是不是错的」)。 */
  color?: string;
  /** 内容比可视区大(scrollWidth/Height > clientWidth/Height)—— 被裁 / 需要滚动。 */
  overflow?: boolean;
}

/** 面板版式的结构化摘要(报告 Q1,见 {@link PanelLayoutElement})。 */
export interface PanelLayoutSummary {
  /** 面板视口(iframe 内容区)的 CSS 像素尺寸。 */
  viewport: { width: number; height: number };
  /** 整页内容尺寸 —— 比视口大 = 有滚动。 */
  content: { width: number; height: number };
  /** 关键元素的版式盒子(有 id / 有可见文字 / 溢出 / 横向超出视口 的才算),已按上限截断。 */
  elements: PanelLayoutElement[];
  /** 扫描到的元素总数(宿主据此说明「列出了多少 / 一共多少」)。 */
  elementCount: number;
  /** 人能读的问题清单:内容溢出、横向超出视口、兄弟元素重叠。空数组 = 没发现问题。 */
  problems: string[];
}

/**
 * 面板对「读回」probe 的回话(报告 E10)。SDK 收到 `probe` 事件后自己读 `document.body`
 * 的文本与整份 HTML,截到上限,再带 `probeId` 回给宿主。宿主侧 `PanelFrame` 按
 * `probeId` 配对,凑不齐(超时 / 面板没加载好)**如实说**,不静默。
 *
 * `layout`(报告 Q1)是同一段 SDK 顺手算出来的版式摘要 —— 让 agent「看」出版式而不只是
 * 读文本。老面板 / 老宿主缺这一段也不该失配,故为可选。
 */
export interface PanelProbeReply {
  __mcode: 1;
  /** 对应请求里的 probeId(SDK 原样带回)。 */
  probe: string;
  /** `document.body.innerText`(渲染出来的可见文字),已按上限截断。 */
  text: string;
  /** `document.documentElement.outerHTML`,已按上限截断。 */
  html: string;
  /** 截断前的**完整**字符数 —— 宿主据此说明「截了多少」。 */
  textLength: number;
  htmlLength: number;
  url: string;
  /** 版式摘要(报告 Q1)。面板算得出来就给,算失败(或老 SDK)则为空。 */
  layout?: PanelLayoutSummary;
}

export function isPanelProbeReply(d: unknown): d is PanelProbeReply {
  if (!d || typeof d !== "object") return false;
  const r = d as Partial<PanelProbeReply>;
  return r.__mcode === 1 && typeof r.probe === "string" && typeof r.text === "string" && typeof r.html === "string";
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
/* 「读回」(报告 E10):宿主发一个 probe 事件,面板把此刻**渲染出来的**文本与 HTML 回给它。
   iframe 是 opaque origin(没有 allow-same-origin),外面的窗口读不到它的 DOM —— 只能由
   面板**自己**读,所以这段必须活在 SDK 里。截到上限再回,免得一个大面板把整坨 DOM 传出去;
   同时把**完整长度**一并回,宿主据此说明「截了多少」。
   报告 Q1:再顺手算一份**版式摘要**(元素矩形 / 字号 / 颜色 / 溢出 / 重叠)—— 用户要的
   「像截屏那样看」在没有 canvas 依赖、外层又读不到 DOM 的约束下降级成这个。 */
function directText(el){
  var s = "", kids = el.childNodes || [], k;
  for (k = 0; k < kids.length; k++){ if (kids[k].nodeType === 3) s += kids[k].nodeValue || ""; }
  return s.replace(/\\s+/g, " ").trim();
}
function describeBox(b){
  var s = b.tag;
  if (b.id) s += "#" + b.id; else if (b.cls) s += "." + String(b.cls).split(/\\s+/)[0];
  if (b.text) s += ' "' + String(b.text).slice(0, 24) + '"';
  return s;
}
function collectLayout(){
  var out = { viewport: { width: 0, height: 0 }, content: { width: 0, height: 0 }, elements: [], elementCount: 0, problems: [] };
  try {
    var de = document.documentElement, body = document.body;
    var vw = de.clientWidth, vh = de.clientHeight;
    out.viewport = { width: vw, height: vh };
    var cw = (body && body.scrollWidth) || vw, ch = (body && body.scrollHeight) || vh;
    out.content = { width: cw, height: ch };
    if (cw > vw + 1) out.problems.push("内容宽 " + cw + " > 视口宽 " + vw + "(横向滚动)");
    if (ch > vh + 1) out.problems.push("内容高 " + ch + " > 视口高 " + vh + "(纵向滚动)");
    var all = de.getElementsByTagName("*"), i, el, r, cs, txt, id, tag, overflow, offX;
    out.elementCount = all.length;
    var boxes = [];
    for (i = 0; i < all.length; i++){
      el = all[i];
      tag = String(el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "head" || tag === "meta" || tag === "link" || tag === "title") continue;
      r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      cs = (window.getComputedStyle ? window.getComputedStyle(el) : null);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
      id = el.id || "";
      txt = directText(el);
      overflow = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      offX = r.left < -1 || r.right > vw + 1;
      if (!id && !txt && !overflow && !offX) continue;
      var box = { tag: tag, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      if (id) box.id = String(id);
      if (el.className && typeof el.className === "string") box.cls = el.className.slice(0, 120);
      if (txt) box.text = txt.slice(0, ${PANEL_LAYOUT_TEXT_MAX});
      if (cs){ if (cs.fontSize) box.fontSize = cs.fontSize; if (cs.color) box.color = cs.color; }
      if (overflow) box.overflow = true;
      if (offX) out.problems.push("元素 " + describeBox(box) + " 横向超出视口");
      boxes.push({ box: box, el: el, r: r });
      if (boxes.length >= ${PANEL_LAYOUT_MAX_ELEMENTS}) break;
    }
    var lim = Math.min(boxes.length, ${PANEL_LAYOUT_MAX_ELEMENTS}), a, b, ox, oy, j;
    for (i = 0; i < lim; i++){
      for (j = i + 1; j < lim; j++){
        if (boxes[i].el.parentNode !== boxes[j].el.parentNode) continue;
        a = boxes[i].r; b = boxes[j].r;
        ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) out.problems.push("同层元素重叠: " + describeBox(boxes[i].box) + " 与 " + describeBox(boxes[j].box));
      }
    }
    for (i = 0; i < boxes.length; i++) out.elements.push(boxes[i].box);
  } catch (e) { /* 拿不到版式就算了,文本 / HTML 照回 */ }
  return out;
}
function probeReply(data){
  var id = data && data.probeId;
  var text = "", html = "", textLen = 0, htmlLen = 0;
  try { text = (document.body && document.body.innerText) || ""; } catch (e) { text = ""; }
  try { html = (document.documentElement && document.documentElement.outerHTML) || ""; } catch (e) { html = ""; }
  textLen = text.length; htmlLen = html.length;
  if (textLen > ${PANEL_PROBE_TEXT_MAX}) text = text.slice(0, ${PANEL_PROBE_TEXT_MAX});
  if (htmlLen > ${PANEL_PROBE_HTML_MAX}) html = html.slice(0, ${PANEL_PROBE_HTML_MAX});
  var layout = null;
  try { layout = collectLayout(); } catch (e) { layout = null; }
  try {
    parent.postMessage({ __mcode: 1, probe: id, text: text, html: html, textLength: textLen, htmlLength: htmlLen, url: String(location.href || ""), layout: layout }, "*");
  } catch (e) { /* 宿主已经没了 */ }
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
    if (d.event === "probe") probeReply(d.data);
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
  api: {
    call: function(method, input){
      // 只解一层。call() 内部已经把回包的 result 解出来了
      // (if (d.ok) p.resolve(d.result)),所以这里拿到的是数据本身 ——
      // 从前这里又判了一次 r.ok !== true 并返回 r.result,等于多解一层:
      // 数据里当然没有 ok,于是永远抛 "api call failed"(面板读资料库全废)。
      // 与同文件的 files.read(它只取 r.content)对照即可看出。
      return call("api.call", { method: str(method), input: input === undefined ? null : input });
    }
  },
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
  /* 该扩展**自己目录**下的文件(报告附录 P):读写对称的另一半。
     storage 只装键值,大一点的东西(草稿 Markdown、导出 JSON、截图)得落成文件。
     路径是**该扩展目录下的相对路径**(如 "notes/a.md");绝对路径与双点段会被宿主拒。
     扩展 id 由桥注入 —— 面板脚本**指定不了**别的 id。 */
  extension: {
    readFile: function(relPath){ return call("extension.readFile", { relPath: str(relPath) }); },
    writeFile: function(relPath, content){ return call("extension.writeFile", { relPath: str(relPath), content: str(content) }); },
    listFiles: function(relPath){ return call("extension.listFiles", { relPath: relPath === undefined ? "" : str(relPath) }); }
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

/** 面板的 localStorage 配额(每个面板一份 JSON)。
 *
 *  ⚠️ **已被扩展专用数据区取代**(报告 E12):面板存储现在走
 *  `@contracts/extensionStore` 的 `<数据根>/extensions/<扩展 id>/store.json`,
 *  每个扩展各一份、配额 EXTENSION_STORE_MAX(4 MB)。这个常量只为兼容旧引用留着,
 *  新代码不要再用。 */
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
