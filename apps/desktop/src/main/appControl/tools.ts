/**
 * **mcode-app 工具表** —— 本地 agent 完全控制 Mcode 的那组工具(Claude / Codex / Pi 共用)。
 *
 * ## 组成
 *
 *   - 通用通道(覆盖**全部**功能):`app_api_list` → `app_api_describe` → `app_api_call`。
 *     背后是 `ipc/index.ts` 登记的同一批 RPC handler —— 与界面按按钮走同一段代码。
 *   - 常用功能单独做成好用的工具:`app_ui_state` / `app_ui`(切对话、开文件/设置/面板、弹提示、
 *     改界面偏好)、`app_session_new` / `app_session_send`(像用户一样开对话、发消息)、
 *     `app_workflow_run`(立即运行自动化,或在对话里跑某个工作流)。
 *
 * ## 审批(见 `policy.ts`)
 *
 * 审批在**这里**做(与记忆工具同一个形状:各引擎的 canUseTool / 守卫对 `app_*` 直接放行,
 * 由 handler 自己 fail-closed 地问)。原因:同一个 `app_api_call` 里,读设置和删项目是两回事,
 * 只能看参数才分得清,引擎那一层按工具名放行做不到。
 *   - 「始终允许」按**具体方法**记(审批卡的 toolName 是 `mcode-app:<方法>`);
 *   - 高风险的卡 toolName 带 `APP_DANGER_APPROVAL_PREFIX`,不给「始终允许」、也不认。
 *
 * ## 不在这里的
 *
 * 只给本地三个引擎;浏览器扩展 / 公网 MCP 那条路(`webToolHost`)**不挂** —— 公网那条是
 * 免审批的,挂上去等于把整个软件交给拿到链接的人(用户 2026-10-02 明确选的)。
 */
import {
  ACTIONS_BY_SLOT,
  CUSTOM_UI_ICONS,
  CUSTOM_UI_SETTING_KEY,
  CUSTOM_UI_SLOTS,
  CustomUiConfigSchema,
  TEMPLATE_VARS_BY_SLOT,
  targetKindOfSlot,
} from "@contracts/customUi";
import { PANEL_METHODS, PANEL_THEME_VARS, type PanelLayoutSummary, type PanelMethod } from "@contracts/customUiPanel";
import { BROWSER_SCREENSHOT_DIR_SETTING_KEY } from "@contracts/ipc";
import { zodToJsonSchema } from "zod-to-json-schema";
import { notifyAppSettingWrite } from "@main/customUi/settingSync.js";
import { savePngArtifact } from "@main/lib/screenshotStore.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderContext } from "@contracts/provider";
import { APP_DANGER_APPROVAL_PREFIX, type AppUiCommand, type AppUiReply } from "@contracts/appControl";
import { fail, image, text, type McpToolSpec, type ToolResult } from "@main/mcp/sdk.js";
import { API_CATALOG, type ApiCatalogEntry } from "./apiCatalog.generated.js";
import { computePanelCaptureRect } from "./panelCaptureRect.js";
import { DOMAIN_LABELS, policyFor, type AppPolicy, type AppPolicyLevel } from "./policy.js";
import { registeredRpcChannels, rpcHandlerFor } from "./registry.js";
import { redactValue, renderResult, slimSessions } from "./redact.js";
import { runUiCommand } from "./uiBridge.js";

export const APP_APPROVAL_PREFIX = "mcode-app:";

/**
 * **密钥本体的设置键** —— `setting.get` / `setting.getMany` 一律不许把它们读给模型。
 *
 * ## 为什么需要这一条(它在补哪个洞)
 *
 * 密钥存在于设置表里(见 `main/lib/secretStore.ts`)。通向它们的那几条**专门**的路都被
 * 显式钉在 blocked 档 —— `customModel.getToken`、`piModels.getApiKey`、
 * `codexModels.getApiKey`,理由都写着「API Key / 令牌不给模型」。但 `setting.get` 是
 * `read` 档、**自动放行**,而它读的是**任意**键 —— 于是同一份密钥换条路就拿到了:
 * `app_api_call { method: "setting.get", input: { key: "customModelKeys" } }`。
 *
 * ## 为什么打码拦不住
 *
 * `renderResult` 的打码分两道:字段名像不像密钥、值的形态像不像密钥。而
 * `customModelKeys` 的**值**是一张 `id → base64(密文)` 的表 —— 键是随机串,值在
 * `safeStorage` 不可用的机器上也只是普通 base64(base64 字母表里没有 `-`/`_`,
 * 也不匹配 `sk-` 那类前缀),两道都绕过去了。所以这里必须按**键名**拦在调用之前,
 * 而不是指望结果打码。
 *
 * 将来再有"密钥存在设置表里"的键,加进这个集合(或让它匹配下面那条正则)。
 */
const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "customModelKeys",
  "customModels",
  // ⚠️ **下面这几条是同一种洞的另几个实例(2026-10-09)。** 它们同样把凭据存成**一整块
  //    JSON 字符串**、键名又**不含** `key`/`token`/`secret`/`password` 那几个词 ——
  //   于是 `SECRET_SETTING_KEY_RE` 和 `SECRET_SETTING_STORE_RE` 两道**都绕过去**,
  //   而它们的**值**里嵌着 `password` / `jwtSecret` / `secret` 这些字段。`setting.get`
  //   把整块 JSON 当**一个字符串**返回,`redactString` 只按值的**形态**认密钥
  //   (`sk-…`/`ghp_…`/40+ 位十六进制…),认不出 `"password":"S3cr3t-vps-pw!"` 这种 ——
  //   于是整段凭据原样交给模型。这与 #105/#106 是同一类"密钥换条路就漏",改法也一样:
  //   按键名拦在调用之前。判据来自同仓另两处**已经把这几条当密钥**的地方 ——
  //   `settings/transfer.ts` 的 `EXCLUDED_KEYS`(导出即分享,绝不带密钥)与
  //   `mobile/MobileHttpServer.ts` 的 `LAN_UNREADABLE_SETTING_KEYS`(局域网可读的手机端
  //   都不给)。照抄它们的名单,别让同一个事实在三处各写一遍还写岔。
  /** SSH 主机 + 用户 + **password**(见 `contracts/relay.ts` 的 `RelayVpsConfig`)。 */
  "relay.vpsConfig",
  /** 服务地址 + **JWT 签名密钥**(`jwtSecret`,能签发/伪造 OnlyOffice 令牌)。 */
  "onlyoffice.config",
  /** 每条项目链接的 `/mcp/<secret>` 明文密钥(见 `publicMcpSession.ts`)。 */
  "publicMcp.projectLinks",
  /** 已配对手机的 `{ deviceToken }`(bearer 令牌)。值是 64 位十六进制,现在**恰好**
   *  被"值的形态"那道拦住,但那条判据依赖令牌恰好是十六进制 —— 换一种编码就漏。按
   *  键名钉死(手机侧 `LAN_UNREADABLE_SETTING_KEYS` 也是这么钉的)。 */
  "mobile.pairedDevices",
  /** MCP 服务器的配置(每个 server 的 `env` / `headers`)。stdio server 的 `env` 里常放
   *  **API key**(如 `GITHUB_TOKEN`),http/sse server 的 `headers` 里常放 `Authorization`
   *  —— `contracts/ipc/mcp.ts` 明说 headers 原样保存。键名 `mcp.management` 两道正则
   *  (`SECRET_SETTING_KEY_RE` / `SECRET_SETTING_STORE_RE`)都不命中,而 `setting.get`
   *  是 read/自动批准、把整块 JSON 当一个字符串返回 → 凭据原样交给模型。与 #133 那四条
   *  同一种洞,改法一样:按键名拦在调用之前。 */
  "mcp.management",
]);
/** 兜底:名字里带密钥词的设置键也不给。宁可多拦一个键,也不漏一个。 */
const SECRET_SETTING_KEY_RE =
  /(api[-_.]?keys?|apikeys?|tokens?|secrets?|passw(or)?ds?|credentials?|cookies?|authorization|private[-_.]?keys?|cookieVault)/i;
/** 密钥本体的**结构性**名字(见 `settingsTransfer.ts` 里 `SECRET_STORE_KEY_RE` 那段:
 *  加密凭据 map 全仓都是 `<东西>+Keys/Tokens/Secrets` 收尾)。逐个往集合里加是追着漏,
 *  这里按键名的形状一次挡住 —— `customModelKeys` / `piProviderKeys` / `codexProviderKeys`
 *  都在内。
 *  ⚠️ 末尾的 `/i` **不能省**:`settingsTransfer.ts` 里那条同名规则带 `/i`(导出时按它剔),
 *  这里不带就会**判据漂开** —— 一个 `providerkeys` 这样的全小写键能在导出时被剔掉、
 *  却仍能经 `setting.get` 交给模型。两条判据必须逐字同形。 */
const SECRET_SETTING_STORE_RE = /(Keys|Tokens|Secrets|Credentials|Passwords)$/i;

/** 这个设置键是不是"密钥本体",不能经 `setting.get*` 交给模型。 */
export function isSecretSettingKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return (
    SECRET_SETTING_KEYS.has(key) ||
    SECRET_SETTING_KEY_RE.test(key) ||
    SECRET_SETTING_STORE_RE.test(key)
  );
}

/** `setting.get` / `setting.getMany` 的入参里,有没有踩到密钥键。 */
export function secretSettingRefusal(method: string, input: unknown): string | null {
  if (method !== "setting.get" && method !== "setting.getMany") return null;
  const o = (input ?? {}) as { key?: unknown; keys?: unknown };
  const keys: unknown[] = Array.isArray(o.keys) ? [...o.keys] : [o.key];
  const hit = keys.find((k) => isSecretSettingKey(k));
  return hit === undefined
    ? null
    : `设置键「${String(hit)}」是密钥本体,不读给模型(与 customModel.getToken / piModels.getApiKey 同一条规矩)。要改密钥请让用户在 设置 里操作。`;
}

const LEVEL_LABEL: Record<AppPolicyLevel, string> = {
  read: "只读·自动",
  ui: "界面·自动",
  write: "需批准",
  danger: "高风险·每次批准",
  blocked: "不开放",
};

/* ───────────────────────── 目录 ───────────────────────── */

export interface ApiEntry extends ApiCatalogEntry {
  policy: AppPolicy;
  registered: boolean;
}

function domainOf(method: string): string {
  const i = method.indexOf(".");
  return i < 0 ? method : method.slice(0, i);
}

/** 生成清单 ∪ 实际注册了 handler 的通道(清单没跟上的新通道也能调,只是没有说明)。 */
export function apiEntries(): ApiEntry[] {
  const registered = new Set(registeredRpcChannels());
  const known = new Set<string>();
  const out: ApiEntry[] = API_CATALOG.map((e) => {
    known.add(e.channel);
    const settingDoc = e.method === "setting.get" || e.method === "setting.set"
      ? ` 自定义 UI / custom UI: ${CUSTOM_UI_SETTING_KEY} 是旧版全局 UI JSON 配置。先 setting.get 读取并保留其他项; app_api_describe({method:"setting.set", setting_key:"${CUSTOM_UI_SETTING_KEY}"}) 获取 JSON schema。写入必须审批,不可直接修改运行中的 mcode.db。` : "";
    return { ...e, doc: e.doc + settingDoc, policy: policyFor(e.method), registered: registered.has(e.channel) };
  });
  for (const ch of registered) {
    if (known.has(ch)) continue;
    // 通道名形如 `domain:verb` —— 方法名就按 `domain.verb` 起。
    const method = ch.replace(/:/g, ".");
    out.push({ method, channel: ch, doc: "", input: "(清单里没有说明,按报错提示传参)", output: "unknown", policy: policyFor(method), registered: true });
  }
  return out;
}

/** 按方法名找到目录项(权限档 + 通道)。自定义面板的 `mcode.api.call` 与 agent 的
 *  `app_api_call` 共用这一份 —— 面板调什么、什么档,和 agent 完全一样。 */
export function findEntry(method: string): ApiEntry | undefined {
  const m = method.trim();
  return apiEntries().find((e) => e.method === m || e.channel === m);
}

/**
 * 「没有这个方法」时**猜一个最接近的**（报告 D3）。
 *
 * 报告的原话:工具名不可猜、无校验,agent 只能靠试错 —— 实测猜错 `session.list`
 * (真名 `session.listAll`)、`browser.list`、`usage.stats` 都只得到一句"没有这个方法",
 * 于是它**下一轮还是靠猜**。名字都在这张表里,给一句"你是不是要找 X"没有成本,却把
 * 试错从"再猜一次"变成"照着改一个字"。
 *
 * ## 判据
 *
 * 同一个域(`a.b` 的 `a`)里,方法名最接近的那个。距离用**编辑距离**,但先把两边都
 * 取小写、并去掉分隔符的意义不大(那会让 `list` 和 `listAll` 的距离看起来一样)——
 * 所以直接对**全名**算,再挑最小的;`: `通道名也算候选(agent 可能照目录里的 channel
 * 写)。**只给一个**,而且要求真的沾边(距离 ≤ 名字长度的一半,或前缀命中)——
 * 否则宁可不说,免得指错方向。
 */
export function suggestMethod(method: string): string | undefined {
  return nearestName(method, apiEntries().flatMap((e) => [e.method, e.channel]));
}

/**
 * 从一组候选里挑出和 `want` 最接近的那个。**挑不出就返回 undefined** —— 报错里
 * 宁可不说,也不要指错方向(指错比不说更费一轮)。
 *
 * 前缀命中排在最前(用户常常只漏了后半截,`session.list` vs `session.listAll`);
 * 其余按编辑距离,且要求距离真的小(≤ 名字长度的一半,至少 3)—— 差太远的不是"像",
 * 是"另一个东西"。
 */
export function nearestName(want: string, candidates: readonly string[]): string | undefined {
  const w = want.trim().toLowerCase();
  if (w === "") return undefined;
  let best: { name: string; d: number } | undefined;
  for (const raw of candidates) {
    const name = raw.toLowerCase();
    const prefixHit = name.startsWith(w) || w.startsWith(name);
    const score = prefixHit ? -1 : editDistance(w, name);
    if (best === undefined || score < best.d) best = { name: raw, d: score };
  }
  if (best === undefined) return undefined;
  const limit = Math.max(3, Math.ceil(w.length / 2));
  return best.d <= limit ? best.name : undefined;
}

/** 两个短串的编辑距离(Levenshtein)。方法名最长不过几十字符,朴素两行足够。 */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** 「没有这个方法」那一句 —— 附上最接近的一个名字(报告 D3),猜不出就只说没有。 */
function unknownMethodHint(method: string): string {
  const near = suggestMethod(method);
  return near === undefined
    ? `没有这个方法:${method}。用 app_api_list 查有哪些。`
    : `没有这个方法:${method}。你是不是要找「${near}」?用 app_api_list 看全部。`;
}

function clipLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** `read_panel` 一次给 agent 看的面板可见文本上限(与 renderResult 的尺度一致)。 */
const PANEL_TEXT_SHOWN = 40_000;
/** 版式摘要里最多给 agent 看几个元素 / 每行文字截多长(与契约的 SDK 侧上限对齐)。 */
const PANEL_LAYOUT_SHOWN = 60;
/** 版式「问题」清单最多摆几条 —— 溢出 / 超视口 / 重叠,太多就是一团噪声。 */
const PANEL_LAYOUT_PROBLEMS_SHOWN = 20;

/**
 * 把面板的**版式摘要**(报告 Q1)渲染成 agent 能读的几行字。
 *
 * 面板跑在 opaque origin 的沙箱 iframe,外层读不到它的 DOM,也没有 canvas 截图依赖出真
 * PNG —— 这一份是「看的降级」:矩形 / 字号 / 颜色 / 溢出 / 重叠,够 agent 判「元素重叠了
 * 吗 / 超出容器了吗 / 颜色字体对不对」。`layout` 缺(老 SDK / 面板脚本报错)时如实说一句,
 * 不假装看过。
 */
function renderPanelLayout(layout: PanelLayoutSummary | undefined): string {
  if (!layout || !layout.viewport) {
    return "\n\n— 版式 —\n(这个面板没有回版式摘要:面板脚本可能还没跑起来,或报错了;文本/HTML 仍按上面给出)";
  }
  const vp = layout.viewport;
  const ct = layout.content ?? vp;
  const roll = ct.width > vp.width + 1 || ct.height > vp.height + 1;
  const lines: string[] = [
    `视口 ${vp.width}×${vp.height}px;内容 ${ct.width}×${ct.height}px${roll ? "(有滚动)" : ""}`,
  ];
  const probs = layout.problems ?? [];
  if (probs.length > 0) {
    lines.push(`⚠️ 版式问题 ${probs.length} 条:`);
    for (const p of probs.slice(0, PANEL_LAYOUT_PROBLEMS_SHOWN)) lines.push(`  · ${p}`);
    if (probs.length > PANEL_LAYOUT_PROBLEMS_SHOWN) lines.push(`  …(还有 ${probs.length - PANEL_LAYOUT_PROBLEMS_SHOWN} 条未列)`);
  } else {
    lines.push("没发现溢出 / 超出视口 / 同层重叠。");
  }
  const els = layout.elements ?? [];
  if (els.length > 0) {
    lines.push(`关键元素(共扫描 ${layout.elementCount} 个,列前 ${Math.min(els.length, PANEL_LAYOUT_SHOWN)} 个):`);
    for (const e of els.slice(0, PANEL_LAYOUT_SHOWN)) {
      const sel = e.id ? `#${e.id}` : e.cls ? `.${e.cls.split(/\s+/)[0]}` : "";
      const box = `@(${e.x},${e.y}) ${e.w}×${e.h}`;
      const style = [e.fontSize, e.color].filter(Boolean).join("/");
      const txt = e.text ? ` 「${clipLine(e.text, 40)}」` : "";
      lines.push(`  <${e.tag}${sel}> ${box}${style ? ` ${style}` : ""}${e.overflow ? " [溢出]" : ""}${txt}`);
    }
    if (els.length > PANEL_LAYOUT_SHOWN) lines.push(`  …(还有 ${els.length - PANEL_LAYOUT_SHOWN} 个未列)`);
  } else {
    lines.push("(没有可视元素 —— 多半是空壳 / 还没渲染出来)");
  }
  return `\n\n— 版式 —\n${lines.join("\n")}`;
}

/* ─────────────────── 面板截图(报告 Q1,真出 PNG)─────────────────── */

/**
 * `app_ui action:screenshot_panel` —— 把一个正在渲染的自定义面板**截成真 PNG**。
 *
 * ## 为什么能做到(与 read_panel 的"看的降级"互补)
 *
 * 面板是**纯 React portal 到 `document.body`** 的(`CustomUiHost` 的 `Dialog.Portal`),
 * 不是独立 `BrowserWindow` / `WebContentsView` —— 所以它在主窗口 `webContents` 的渲染范围
 * 内,`mainWindow.webContents.capturePage(rect)` 能截到它。这是浏览器截图(`browser_screenshot`
 * 走 `WebContentsView`)之外**主窗口**的第一处 `capturePage`。
 *
 * ## 矩形从哪来
 *
 * `read_panel` 那条探测链只回**面板内部**的坐标(`customUiPanel` 的 `layout.viewport`,
 * 相对面板自己),**没有**面板在窗口里的位置。位置只能由**宿主**量:渲染端 `appControlHost`
 * 的 `panel_rect` op → `PanelFrame.rect()` 用 `getBoundingClientRect()` 量它那个 iframe
 * 元素。这里拿到的就是这个矩形,经 `computePanelCaptureRect` 裁到窗口可见区(滚动容器里的
 * 面板可能露出一半),再交给 `capturePage`。
 *
 * ## 为什么要把图也存盘 + 回路径
 *
 * **很多模型读不到图**(没有视觉输入)。`browser_screenshot` 给的是 image 内容块 + 存盘路径,
 * 让读不到图的模型能拿路径配 `agent_read_image {describe:true}` 走视觉中继。面板截图照同一条
 * 待遇(报告 D10):给 image 块,**也**给存盘路径,并在文案里点名那条退路。
 *
 * ## 失败一律如实报(D10:静默失败是病)
 *
 * 窗口最小化 / 隐藏 / 拿不到矩形 / 面板为 0 尺寸 —— 都返回**带原因的错**,绝不返回空图冒充成功。
 */
async function screenshotPanel(
  itemId: string | undefined,
  sessionId: string,
): Promise<ToolResult> {
  // 1) 问渲染端要矩形(同 read_panel 的探测链,只是取几何不是取文本)。拿不到 → 如实报。
  const reply = await ui({ op: "panel_rect", ...(itemId ? { itemId } : {}) });
  if (!reply.ok) return fail(reply.error ?? "拿不到面板的位置");
  const d = (reply.data ?? {}) as {
    label?: string; mode?: string;
    rect?: { x: number; y: number; width: number; height: number } | null;
    viewport?: { width: number; height: number } | null;
  };
  const computed = computePanelCaptureRect(d.rect, d.viewport);
  if (!computed.ok) return fail(`面板「${d.label ?? "?"}」${computed.reason}。`);

  // 2) 主窗口那一个 webContents 上截这块矩形(主窗口本来就可见,不需要 WebContentsView 那套
  //    "临时上屏";但最小化 / 隐藏时截不到,如实报)。
  const { getMainWindow } = await import("@main/window.js");
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return fail("主窗口没有打开,截不了面板。");
  }
  if (win.isMinimized() || !win.isVisible()) {
    return fail("主窗口已最小化 / 隐藏,截不到面板 —— 请先把窗口显示出来再截。");
  }
  const r = computed.rect;
  let img = await win.webContents.capturePage(r);
  // 空图 / 抛错重试一次(与 BrowserManager.screenshot 同一取向:合成器偶尔还没来得及画)。
  if (img.isEmpty() || img.toPNG().length === 0) {
    await new Promise((res) => setTimeout(res, 100));
    img = await win.webContents.capturePage(r);
  }
  if (img.isEmpty()) {
    return fail("截到的是空图(窗口可能被完全遮挡或正在最小化动画中),没有可用的面板截图。");
  }
  const data = img.toPNG().toString("base64");

  // 3) 存盘 + 回路径(读不到图的模型的退路)。
  const savedPath = await savePanelScreenshotToDisk(data, { sessionId, toolCallId: randomUUID() });
  const caption =
    `面板「${d.label ?? "?"}」(${d.mode ?? "?"})截图:${r.width}×${r.height}px @(${r.x},${r.y})。` +
    `${savedPath ? `\n已保存到:${savedPath}` : ""}` +
    "\n**很多模型读不到图** —— 读不到就用上面这个**路径**,配 `agent_read_image {describe: true}` 让视觉中继模型把面板长什么样转述成文字。";
  return image(data, "image/png", caption);
}

/**
 * 面板截图落盘 —— 复用浏览器截图那套"截图目录 + 每会话每轮"的规则(`savePngArtifact`),
 * 只是这里没有"一轮"的上下文,`turnNumber` 缺省 0(与浏览器截图一致)。
 *
 * `baseDir` 走 `setting.get` 那个 RPC(与界面读 `browser.screenshotDir` 同一份设置)—— **不**
 * 静态 import `repositories`(它 import electron,会顺着 esbuild 提到 bundle 顶部、坑掉无头
 * smoke,见 `screenshotStore` 的文件头)。设置读不到 / 没注册该 RPC 时回落到系统 Pictures
 * (同样经**动态** import `electron`,保持静态图干净)。全程 best-effort:存盘失败只丢文件,
 * 不影响"图已交给模型"这件事(返回 null,工具栏文案里自然就不带那行路径)。
 */
async function savePanelScreenshotToDisk(data: string, opts: { sessionId: string; toolCallId: string }): Promise<string | null> {
  if (!opts.sessionId || !data) return null;
  let baseDir: string | null = null;
  try {
    const entry = findEntry("setting.get");
    if (entry?.registered) {
      const r = (await callRpc(entry, { key: BROWSER_SCREENSHOT_DIR_SETTING_KEY })) as { value?: string | null };
      baseDir = r?.value?.trim() || null;
    }
  } catch {
    /* 设置读不到 —— 走 Pictures 回落 */
  }
  if (!baseDir) {
    try {
      const { app } = await import("electron");
      baseDir = app.getPath("pictures");
    } catch {
      return null; // 无头环境(没 electron)就不存盘,只损失那条退路
    }
  }
  return savePngArtifact(data, { baseDir, sessionId: opts.sessionId, turnNumber: undefined, toolCallId: opts.toolCallId });
}

/* ───────────────────────── 审批 ───────────────────────── */
const BYPASS_MODES = new Set(["bypassPermissions", "full-access"]);
const READONLY_MODES = new Set(["plan", "read-only"]);

/**
 * 按档位决定放不放行。返回 `null` = 放行;字符串 = 拒绝原因(原样给模型)。
 * 没有审批通道(无界面的环境)一律拒绝 —— fail-closed。
 */
export async function gateAppAction(
  ctx: ProviderContext,
  level: AppPolicyLevel,
  approvalKey: string,
  input: unknown,
  description: string,
  blockedReason?: string,
): Promise<string | null> {
  if (level === "read" || level === "ui") return null;
  if (level === "blocked") return `这个功能不开放给 agent:${blockedReason ?? "安全原因"}`;
  const mode = ctx.getPermissionMode?.() ?? undefined;
  if (mode && READONLY_MODES.has(mode)) {
    return "当前是只读/计划模式,不执行有副作用的操作。先把方案告诉用户,等他切换模式。";
  }
  const toolName = level === "danger" ? `${APP_DANGER_APPROVAL_PREFIX}${approvalKey}` : `${APP_APPROVAL_PREFIX}${approvalKey}`;
  if (level === "write") {
    if (mode && BYPASS_MODES.has(mode)) return null;
    if (ctx.isToolAlwaysAllowed?.(toolName)) return null;
  }
  if (mode === "dontAsk") return "当前权限模式不弹审批,这个操作没有被预先允许,未执行。";
  if (!ctx.requestApproval) return "当前环境没有可用的审批通道,为安全起见未执行。";
  const decision = await ctx.requestApproval({
    requestId: randomUUID(),
    toolName,
    input: redactValue(input),
    description: level === "danger" ? `⚠️ 高风险操作(每次都需要你本人批准):${description}` : description,
  });
  if (!decision.allow) return decision.reason ? `用户拒绝了:${decision.reason}` : "用户拒绝了这次操作,未执行。";
  return null;
}

/* ───────────────────────── 调用 RPC ───────────────────────── */

/**
 * 直接调 handler(不过审批 —— 调用方先 gate)。
 *
 * ⚠️ **`input === undefined` 要补成 `{}`。** `app_api_call` 的说明明写着「无参方法省略
 * `input`」,于是模型对 `project.list` / `session.listAll` / `runtimes.list` 这类方法会
 * **整个不传** —— 到了这里就是 `undefined`。而无参 handler 有的根本不接 `raw`(如
 * `workflow.list`,没问题),有的却照常 `schema.parse(raw)`;其中**入参全可选的 schema**
 * (`session.listAll` 的 limit/offset/projectIds/worktreeKey)`z.object({}).parse(undefined)`
 * 会报根级 `Required`——这个功能对 agent 就**永远调不通**,而报错里没有一个字提示"它其实
 * 不需要参数"。补一个空对象:全可选/空 schema 照常过,真缺必填参数的方法则拿到更准的
 * `字段 Required`(而不是根级一句 `(根) Required`)。与各 handler 里 `parse(raw ?? {})`
 * 同一条约定(见 `ipc/context.ts` / `ipc/mcp.ts`),只是收在这一层做,新加的无参方法
 * 不必各自记得补。
 */
export async function callRpc(entry: { channel: string }, input: unknown): Promise<unknown> {
  const handler = rpcHandlerFor(entry.channel);
  if (!handler) throw new Error(`这个功能在当前版本里没有注册(${entry.channel})`);
  return handler({}, input ?? {});
}

/**
 * 自定义面板的 `mcode.api.call` —— 调任意 Mcode 主进程方法。
 *
 * ## 与 agent 的 `app_api_call` 走**同一套**判据,只是审批闸换了个落点
 *
 * 分类(`findEntry` → `policyFor`)、密钥前置拦截(`secretSettingRefusal`)、执行
 * (`callRpc`)、结果打码(`redactValue`)全部复用 agent 那条路。**唯一**不同的是审批:
 * agent 的 `gateAppAction` 走 `ctx.requestApproval`(回合里的审批卡);面板没有"回合",
 * 它的用户交互就是那个 `confirm` 浮框 —— 所以这里**不发审批请求**,而是把
 * `needsApproval` 交回渲染端的桥,由它弹框;用户点头后桥**带 `approved: true` 重调**。
 *
 * `approved` 只由我们写的桥补(面板脚本发不出它 —— 它只会经 `handlePanelCall`)。
 * 与 `gateAppAction` 一样**fail-closed**:没有 `approved` 就不执行写档,交回给用户去点。
 *
 * 返回形状刻意**不抛**(除参数解析):面板脚本 `await mcode.api.call(...)` 拿到的是一个
 * 普通对象,失败读 `error`;`needsApproval` 由桥吃掉、对脚本透明(桥点头后重调)。
 */
export async function panelApiCall(
  method: string,
  input: unknown,
  approved: boolean,
  panelLabel: string,
): Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
  needsApproval?: boolean;
  level?: "write" | "danger";
  description?: string;
}> {
  const entry = findEntry(method);
  if (!entry) return { ok: false, error: unknownMethodHint(method) };
  if (!entry.registered) return { ok: false, error: `这个方法在当前版本里没有注册(${entry.channel})。` };
  const level = entry.policy.level;
  if (level === "blocked") {
    return { ok: false, error: `这个功能不开放:${entry.policy.reason ?? "安全原因"}` };
  }
  // 密钥设置键:在**调用之前**拦(见 `isSecretSettingKey` —— 结果打码拦不住它)。
  const secretRefusal = secretSettingRefusal(entry.method, input);
  if (secretRefusal) return { ok: false, error: secretRefusal };
  if ((level === "write" || level === "danger") && approved !== true) {
    const what = entry.policy.reason ?? entry.doc ?? entry.method;
    return {
      ok: false,
      needsApproval: true,
      level,
      description: `面板「${panelLabel}」要调用 ${entry.method} —— ${clipLine(what, 200)}`,
    };
  }
  try {
    const result = await callRpc(entry, input);
    // 结果打码 —— 与 agent 的 `renderResult` 同一份 `redactValue`。密钥类设置键上面已前置
    // 拦掉,这里是兜底(如返回值里嵌着别的凭据字段)。
    return { ok: true, result: redactValue(result) };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

function errText(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `参数不对:${err.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join(";")}。先用 app_api_describe 看参数格式。`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function ui(cmd: AppUiCommand): Promise<AppUiReply> {
  try {
    return await runUiCommand(cmd);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

function uiResult(reply: AppUiReply, okText: string): ToolResult {
  if (!reply.ok) return fail(reply.error ?? "界面操作失败");
  return text(reply.data === undefined ? okText : `${okText}\n${renderResult(reply.data)}`);
}

/* ───────────────────────── 工具表 ───────────────────────── */

const UI_ACTIONS = [
  "open_session",
  "select_project",
  "open_file",
  "open_settings",
  "close_settings",
  "panel",
  "open_url",
  "notify",
  "set_pref",
  "interrupt_session",
  "read_panel",
  "open_panel",
  "screenshot_panel",
] as const;

/** 只读 / 界面类工具名(引擎侧若要按名字预放行可以用;真正的闸门在 handler 里)。 */
export const APP_READONLY_TOOLS: ReadonlySet<string> = new Set(["app_api_list", "app_api_describe", "app_ui_state", "app_panel_api_list"]);

/* ─────────────────── 自定义面板/扩展的对外接口(给 agent 查)─────────────────── */

/**
 * 面板 `window.mcode` 每个方法的一句话说明。
 *
 * ## 为什么需要它
 *
 * `app_api_list` 只列**能被 `app_api_call` 调**的主进程方法 —— 面板的 `window.mcode`
 * 那套(读上下文、问模型、发到输入框、跑自动化、读写项目文件、读资料库……)不在其中。
 * 从前 agent 想知道面板能干什么,只能去 grep `app.asar` 里的源码。这张表 + 下面那个
 * `app_panel_api_list` 工具把那份接口变成**可查询**的。
 *
 * ## 数据从哪来
 *
 * 方法名从 `@contracts/customUiPanel` 的 `PANEL_METHODS` 来(那张表是权威清单,渲染端
 * `PanelFrame` 逐个实现);这里只补"一句说明"。类型钉成 `Record<PanelMethod, …>`:
 * `PANEL_METHODS` 加了方法而这里没补说明,**typecheck 就过不去** —— 与 `PanelFrame`
 * 里那个穷举 switch 是同一条约束,防止说明表悄悄漂在清单后面。
 *
 * ⚠️ 说明是**给人/模型看的散文**,判据只在 `PanelMethod` 这个类型上 —— 别把它当成
 * 又一份"实现",真正的行为在 `renderer/components/customUi/panelBridge.ts`。
 */
const PANEL_METHOD_DOCS: Record<PanelMethod, { doc: string; params?: string; returns?: string }> = {
  context: { doc: "读当前上下文(面板所属条目、语言、目标种类、模板变量 vars、项目路径、主题)", returns: "{ itemId, title, locale, target, vars, projectPath, theme }" },
  prompt: { doc: "把一段文字放进当前对话的输入框(不替你发送,用户先看一眼再发)", params: "text", returns: "{ ok }" },
  ask: { doc: "一次性问一个模型,拿回纯文本。**不带任何工具** —— 面板里的文字驱动不了文件/命令", params: "prompt, system?, model?(@claude[:haiku|sonnet|opus] 或 自定义模型id)", returns: "string(纯文本)" },
  "api.call": { doc: "调**任意** Mcode 主进程方法(与 agent 的 app_api_call 同一套权限分类与密钥拦截;写档每次弹确认;方法名去 app_api_list 查)", params: "method, input?", returns: "该方法的返回值(已打码)" },
  automations: { doc: "列出可运行的自动化(带触发器的)及其触发器" },
  runAutomation: { doc: "用指定的触发器手动跑一条自动化(默认每次弹确认)", params: "workflowId, triggerNodeId?", returns: "{ ok }" },
  "files.read": { doc: "读项目里的一个文件(相对路径按当前项目解析;越界拒绝)", params: "path", returns: "{ content, path }" },
  "files.list": { doc: "列项目里的一个目录(只收相对路径)", params: "path(相对,可省略=项目根)", returns: "[{ name, path, isDir, size? }]" },
  "files.write": { doc: "写项目里的一个文件(默认每次弹确认)", params: "path, content", returns: "{ ok, path }" },
  "library.list": { doc: "列/搜资料库条目(按标题或关键词,可分页)", params: "query?, collectionId?, limit?(1-200,默认50), offset?", returns: "{ total, items:[{ id, title, abstract?, url?, hasMarkdown, addedAt, updatedAt }] }" },
  "library.search": { doc: "全文检索资料库条目", params: "query, limit?(1-100,默认30)", returns: "[匹配项]" },
  "library.read": { doc: "读一条资料库条目的 Markdown 正文", params: "id", returns: "{ markdown, fileName }" },
  "storage.get": { doc: "读这个面板自己存的一个键(**按扩展隔离**,存在 `<数据根>/extensions/<扩展id>/store.json`,不是浏览器 localStorage)", params: "key", returns: "值 或 null" },
  "storage.set": { doc: "存一个键(值须能 JSON 序列化;**每个扩展一份、各 4MB 上限**,超了回 `{ ok:false, reason:'tooLarge' }`)", params: "key, value", returns: "{ ok, reason? }" },
  "storage.remove": { doc: "删掉一个键", params: "key", returns: "{ ok }" },
  "extension.readFile": { doc: "读**这个扩展自己数据目录**下的一份文件(路径相对该扩展目录,如 `notes/a.md`)。空文件与\"不存在\"分得开", params: "relPath(相对该扩展目录)", returns: "{ ok:true, content } 或 { ok:false, reason }" },
  "extension.writeFile": { doc: "写**这个扩展自己数据目录**下的一份文件(建父目录;默认每次弹确认;**每个扩展一份、各 4MB 上限**)", params: "relPath, content", returns: "{ ok:true, bytes } 或 { ok:false, reason }" },
  "extension.listFiles": { doc: "列**这个扩展自己数据目录**下某个子目录的内容(不递归)", params: "relPath(相对该扩展目录,可省略=根)", returns: "{ ok:true, entries:[{ name, relPath, isDir, size? }] } 或 { ok:false, reason }" },
  copy: { doc: "把文本复制到剪贴板", params: "text", returns: "{ ok }" },
  openUrl: { doc: "用系统浏览器打开一个链接(只放行 http(s)/mailto)", params: "url", returns: "{ ok }" },
  openFile: { doc: "在编辑器里打开一个文件(项目内)", params: "path", returns: "{ ok }" },
  shell: { doc: "在底部终端里跑一条命令(默认每次弹确认;用户看得见、可 Ctrl+C,不后台静默执行)", params: "command", returns: "{ ok }" },
  toast: { doc: "在界面右下角弹一条提示(标题用面板名)", params: "message, kind?(info|warning|error)", returns: "{ ok }" },
};

/** 面板方法里**会弹确认框**的那些 —— 判据与 `panelBridge.ts` 的 `gate(...)` 调用点
 *  同一份(写文件、跑自动化、跑终端命令;`api.call` 另按主进程回的 `needsApproval` 弹)。
 *  `app_panel_api_list({method})` 据此告诉作者"这一步要不要人点头"。 */
const PANEL_CONFIRM_METHODS: ReadonlySet<string> = new Set(["files.write", "runAutomation", "shell", "api.call"]);

/** 各挂载位的一句话说明(`app_panel_api_list({slot})` 与总览用)。 */
const SLOT_DOCS: Record<(typeof CUSTOM_UI_SLOTS)[number], string> = {
  "library.item": "资料库**条目行**右键(目标:一条条目)",
  "library.collection": "资料库**分类**(第三级:有父分类的那种)右键",
  "library.subcategory": "资料库**小类**(第二级:大类下直挂的根分类)右键",
  "library.group": "资料库**大类**标题行右键",
  "files.context": "右栏 Files 里的文件右键(目标:一个文件)",
  "rightPanel.tab": "右栏顶上那排页签(内置的文件/Git/浏览器……也在这里排)",
  toolbar: "主界面与右栏之间的竖向工具栏(右栏收起时在最右边)",
  "chat.message": "聊天里一条消息的「⋯」菜单",
  "text.selection": "选中文字:聊天里的选中浮条 + 代码编辑器的右键菜单",
  "composer.toolbar": "输入框下面那排工具按钮",
  "session.context": "左栏对话右键",
  "project.context": "左栏项目右键",
};

/**
 * `app_panel_api_list` —— 把**自定义面板/扩展的对外接口**报给 agent(只读)。
 *
 * 不带参数:总览(面板方法清单 + 挂载位清单)。带 method:展开说一个面板方法。
 * 带 slot:展开说一个挂载位(允许的 action 类型 + 可用模板变量 vars)。
 *
 * 数据一律来自 `@contracts` 的既有 constants(`PANEL_METHODS` / `ACTIONS_BY_SLOT` /
 * `TEMPLATE_VARS_BY_SLOT` / `CUSTOM_UI_SLOTS` / `targetKindOfSlot`),不另写一份 ——
 * 契约加了方法/槽位,这里自动跟上。
 */
function panelApiList(args: { method?: string; slot?: string }): ToolResult {
  const clean = (s: string) => s.replace(/^mcode\./, "").trim();
  const methodName = args.method ? clean(args.method) : undefined;
  const slotName = args.slot?.trim();

  if (methodName) {
    const known = (PANEL_METHODS as readonly string[]).includes(methodName);
    if (!known) {
      // 候选是**面板自己的**方法表(与 RPC 目录不同),所以另走一份名单。
      const near = nearestName(methodName, PANEL_METHODS as readonly string[]);
      return fail(
        `面板没有这个方法:${methodName}。${near ? `你是不是要找「${near}」?` : ""}不带参数调用看全部方法。`,
      );
    }
    const d = PANEL_METHOD_DOCS[methodName as PanelMethod];
    return text(
      [
        `面板方法:mcode.${methodName}()`,
        `说明:${d.doc}`,
        d.params ? `参数:${d.params}` : "参数:(无)",
        d.returns ? `返回:${d.returns}` : null,
        // 作者最常问的一句:「这一步会不会弹确认?」判据与 `panelBridge.ts` 的 `gate(...)`
        // 调用点同一份 —— 少了它作者得靠试(报告附录 Q2)。
        `是否需要确认:${PANEL_CONFIRM_METHODS.has(methodName) ? "是(每次弹确认框,用户点头才执行;动作上 confirm:false 的例外)" : "否(直接执行)"}`,
        `调用方式:面板脚本里 await mcode.${methodName}(…)(库风格的方法在 SDK 里已按子对象包好,如 mcode.files.read / mcode.api.call)。`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (slotName) {
    const known = (CUSTOM_UI_SLOTS as readonly string[]).includes(slotName);
    if (!known) return fail(`没有这个挂载位:${slotName}。不带参数调用看全部挂载位。`);
    const slot = slotName as (typeof CUSTOM_UI_SLOTS)[number];
    return text(
      [
        `挂载位:${slot}`,
        `位置:${SLOT_DOCS[slot]}`,
        `目标种类:${targetKindOfSlot(slot)}`,
        `允许的动作(action.type):${ACTIONS_BY_SLOT[slot].join(" / ")}`,
        `可用的模板变量({{…}}):${TEMPLATE_VARS_BY_SLOT[slot].join(" / ")}`,
      ].join("\n"),
    );
  }

  const methodLines = (PANEL_METHODS as readonly PanelMethod[]).map(
    (m) => `- mcode.${m} — ${clipLine(PANEL_METHOD_DOCS[m].doc, 90)}`,
  );
  const slotLines = (CUSTOM_UI_SLOTS as readonly (typeof CUSTOM_UI_SLOTS)[number][]).map(
    (s) => `- ${s} [目标:${targetKindOfSlot(s)}] 动作:${ACTIONS_BY_SLOT[s].join("/")} · 变量:${TEMPLATE_VARS_BY_SLOT[s].join("/")}`,
  );
  return text(
    [
      `自定义面板/扩展的对外接口。面板在隔离的 iframe 里跑,能做的事全在下面这份清单里。`,
      ``,
      `一、面板 API(window.mcode,共 ${PANEL_METHODS.length} 个方法)`,
      ...methodLines,
      ``,
      `二、挂载位(slot,共 ${CUSTOM_UI_SLOTS.length} 个挂载位)—— 自定义项放在哪里、能用哪些动作和变量`,
      ...slotLines,
      ``,
      `三、图标白名单(CUSTOM_UI_ICONS,共 ${CUSTOM_UI_ICONS.length} 个):${CUSTOM_UI_ICONS.join(" / ")}`,
      `四、主题变量(面板 --mc-<键>):${PANEL_THEME_VARS.join(" / ")}`,
      ``,
      `下一步:app_panel_api_list({method}) 看某个面板方法 → app_panel_api_list({slot}) 看某个挂载位。`,
      `要在面板里调主进程方法用 mcode.api.call(method, input),method 去 app_api_list 查。`,
    ].join("\n"),
  );
}

export function appMcpTools(): McpToolSpec[] {
  return [
    {
      name: "app_api_list",
      description:
        "列出 Mcode 的全部功能(主进程接口)。不带参数 = 按功能域列目录;带 domain = 列该域全部方法;" +
        "带 query = 按关键词搜方法名和说明。每个方法标了权限档:只读·自动 / 需批准 / 高风险·每次批准 / 不开放。" +
        "想做界面上能做的任何事(建项目、改设置、管理技能/插件/MCP、Git、终端、资料库、工作流……)先用它找到方法。",
      inputSchema: {
        domain: z.string().optional().describe("功能域,如 project / session / library / git / skills / mcp / setting"),
        query: z.string().optional().describe("关键词(方法名或说明里的字)"),
      },
      handler: async (args: { domain?: string; query?: string }) => {
        const all = apiEntries();
        if (!args.domain && !args.query) {
          const counts = new Map<string, number>();
          for (const e of all) counts.set(domainOf(e.method), (counts.get(domainOf(e.method)) ?? 0) + 1);
          const lines = [...counts.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([d, n]) => `- ${d}(${n}):${DOMAIN_LABELS[d] ?? ""}`);
          return text(
            `Mcode 共 ${all.length} 个功能,按域:\n${lines.join("\n")}\n\n` +
              "下一步:app_api_list({domain}) 看某个域的方法 → app_api_describe({method}) 看参数 → app_api_call 调用。\n" +
              // **几道门一次说清**(报告 D4)。这个软件有好几个调用入口,agent 从前得自己
              // 猜走哪道 —— 猜错的代价是"以为没有这个功能"(实测:在 app_api_list 里找不到
              // browser_*/agent_*,就以为截图这类能力不存在)。给它们各自的范围。
              "**不止一道门,各有各的范围 —— 别在一道门上找另一道的功能**:\n" +
              "  ① 通用门(这里):app_api_list → app_api_describe → app_api_call,覆盖主进程全部功能;\n" +
              "  ② 常用动作的专用工具:app_ui / app_ui_state(界面)、app_session_new / app_session_send(别的对话)、app_workflow_run(跑工作流)—— 它们**不是** app_api_call 的方法;\n" +
              "  ③ 浏览器与电脑操作:browser_* / agent_*(开网页、读 PDF/Office、跑命令、传文件)—— 自成一组,也不在这张表里;\n" +
              "  ④ 自定义面板/扩展的 window.mcode API、挂载位动作与变量:用 app_panel_api_list 查。\n" +
              "要找**有没有**某个能力,先 app_api_list({domain}) 或按关键词搜,别凭名字猜。",
          );
        }
        const q = args.query?.trim().toLowerCase();
        const picked = all.filter(
          (e) =>
            (!args.domain || domainOf(e.method) === args.domain.trim()) &&
            (!q || e.method.toLowerCase().includes(q) || e.doc.toLowerCase().includes(q)),
        );
        if (picked.length === 0) return text("没有匹配的方法。不带参数调用一次看全部功能域。");
        const lines = picked.map(
          (e) => `- ${e.method} [${LEVEL_LABEL[e.policy.level]}]${e.registered ? "" : "(未注册)"}${e.doc ? ` — ${clipLine(e.doc, 120)}` : ""}`,
        );
        return text(`${picked.length} 个方法:\n${lines.join("\n")}`);
      },
    },
    {
      name: "app_api_describe",
      description: "看某个 Mcode 方法的完整说明、参数格式、返回格式和权限档。调用 app_api_call 之前先看一眼。",
      inputSchema: {
        method: z.string().describe("方法名,如 session.rename(来自 app_api_list)"),
        setting_key: z.string().optional().describe("查看已知 JSON 设置的结构,例如 customUi.config.v1"),
      },
      handler: async (args: { method: string; setting_key?: string }) => {
        const e = findEntry(args.method);
        if (!e) return fail(unknownMethodHint(args.method));
        return text(
          [
            `方法:${e.method}`,
            `权限:${LEVEL_LABEL[e.policy.level]}${e.policy.reason ? `(${e.policy.reason})` : ""}`,
            e.registered ? null : "⚠️ 当前版本没有注册这个方法的处理函数",
            e.doc ? `说明:${e.doc}` : null,
            `参数:${e.input}`,
            `返回:${e.output}`,
            args.setting_key === CUSTOM_UI_SETTING_KEY && ["setting.get", "setting.set"].includes(e.method)
              ? `value 是 JSON 字符串;其解码后的结构为:\n${JSON.stringify(zodToJsonSchema(CustomUiConfigSchema, { target: "jsonSchema7", $refStrategy: "none" }))}\n条目 id 必须唯一,动作必须适用于相应插槽。保留未修改的条目与布局;先读再写。` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },
    {
      name: "app_panel_api_list",
      description:
        "列出**自定义面板/扩展的对外接口**(与 app_api_list 并列,但那份只列主进程方法)。面板跑在隔离 iframe 里," +
        "通过 window.mcode 和 Mcode 打交道 —— 这套 API、各挂载位(slot)能用的动作类型(action.type)、可用模板变量({{…}})、" +
        "图标白名单、主题变量都在这里。不带参数给总览;method= 看一个面板方法;slot= 看一个挂载位。" +
        "要在面板里调主进程方法,用 mcode.api.call(method, input),method 去 app_api_list 查。",
      inputSchema: {
        method: z.string().optional().describe("面板方法名,如 files.read / api.call / ask / runAutomation(带不带 mcode. 前缀都行)"),
        slot: z.string().optional().describe("挂载位,如 library.item / files.context / toolbar / rightPanel.tab"),
      },
      handler: async (args: { method?: string; slot?: string }) => panelApiList(args),
    },
    {
      name: "app_api_call",
      description:
        "调用一个 Mcode 方法(与界面上点按钮执行的是同一段代码)。只读的直接执行;有副作用的会弹审批卡;" +
        "高风险的每次都要用户本人批准;不开放的会直接拒绝。返回值里的密钥/令牌一律打码。",
      inputSchema: {
        method: z.string().describe("方法名(来自 app_api_list)"),
        input: z.unknown().optional().describe("参数对象,格式见 app_api_describe;无参方法省略"),
      },
      handler: async () => fail("内部错误:app_api_call 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_ui_state",
      description:
        "读 Mcode 界面当前状态:当前项目/对话、打开的标签页、哪些对话在运行、各面板开关、设置页、" +
        "输入框的权限模式和工作流、语言主题等。做界面操作前先看一眼。",
      inputSchema: {},
      handler: async () => uiResult(await ui({ op: "state" }), "界面状态:"),
    },
    {
      name: "app_ui",
      description:
        "操作 Mcode 界面。action:\n" +
        "- open_session {session_id}:切到某个对话\n" +
        "- select_project {project_id}:切到某个项目\n" +
        "- open_file {path, line?}:在编辑器里打开文件(当前项目内)\n" +
        "- open_settings {section?} / close_settings:打开/关闭设置页\n" +
        "- panel {panel: left|right|terminal|browser, open, tab?}:开关面板;右栏 tab 可选 files|git|browser|turns|preview|flow|tasks\n" +
        "- open_url {url}:在内置浏览器里打开网址\n" +
        "- notify {title, body?, kind?}:在界面右下角弹一条提示\n" +
        "- set_pref {key, value}:改界面偏好 —— locale(zh/en)、themeStyle(classic/sketch)、displayMode、chatFontSize、" +
        "chatDensity、workflowId(输入框的工作流)、permissionMode(输入框的权限模式,高风险)\n" +
        "- interrupt_session {session_id}:停止某个正在运行的对话(需批准)\n" +
        "- read_panel {item_id?}:读回一个**正在渲染的自定义面板**的渲染结果(可见文本 + 版式摘要 + 可选 HTML)。面板在沙箱 iframe 里,\n" +
        "  常规办法看不到它渲染成什么样;这条让 agent 能自验扩展 UI。返回里含**版式摘要**:视口/内容尺寸、关键元素的矩形+字号+颜色、\n" +
        "  以及「溢出 / 横向超出视口 / 同层元素重叠」的问题清单 —— 据此判「元素重叠了吗 / 超出容器了吗 / 颜色字体对不对」。item_id 省略 = 读当前在意的那个(浮窗 > 设置页预览 > 右栏页签)。\n" +
        "  要读**草稿**(还没保存)的面板:先在设置页点「预览」再读。没有面板挂着时如实报错并列出可读的。\n" +
        "- open_panel {item_id}:打开一个**已保存的**自定义面板(像用户右键那样弹浮窗),喂的是一份按挂载位造的**样例目标**。\n" +
        "  典型用法:open_panel → read_panel,开一个立即看它渲染成什么样(agent 自验扩展 UI 的闭环)。\n" +
        "- screenshot_panel {item_id?}:把一个**正在渲染的自定义面板**截成**真 PNG**(像浏览器截屏那样)。read_panel 给的是文本 + 版式摘要,\n" +
        "  看不到真实渲染(断行 / 对齐 / 颜色 / 字体)—— 要**看**它长什么样就用这条。返回一张图 + 一个**存盘路径**。\n" +
        "  **很多模型读不到图** —— 读不到就用返回的**路径**配 `agent_read_image {describe: true}` 让视觉中继模型把面板内容转述成文字。\n" +
        "  item_id 省略 = 与 read_panel 同口径(浮窗 > 设置页预览 > 右栏页签)。面板没挂着 / 窗口最小化 / 拿不到位置时**如实报错**,不返回空图。\n" +
        "界面类操作自动执行;set_pref 需批准,改 permissionMode 每次都要批准。",
      inputSchema: {
        action: z.enum(UI_ACTIONS),
        session_id: z.string().optional(),
        project_id: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        section: z.string().optional(),
        panel: z.enum(["left", "right", "terminal", "browser"]).optional(),
        open: z.boolean().optional(),
        tab: z.enum(["files", "git", "browser", "turns", "preview", "flow", "tasks"]).optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.enum(["info", "warning", "error"]).optional(),
        key: z.enum(["locale", "themeStyle", "displayMode", "chatFontSize", "chatDensity", "workflowId", "permissionMode"]).optional(),
        value: z.union([z.string(), z.number()]).optional(),
        item_id: z.string().optional().describe("read_panel / screenshot_panel:要读/要截的面板条目 id;省略 = 当前最该读的那个"),
        include_html: z.boolean().optional().describe("read_panel:默认只回可见文本;要连渲染后的 HTML 一起回(看结构/空壳)才传 true —— HTML 常有几万字符,不必要时别要(报告 R2)"),
      },
      handler: async () => fail("内部错误:app_ui 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_session_new",
      description:
        "像用户点「新对话」一样开一个对话,可选直接发出第一条消息。不传 project_id 用当前项目;" +
        "provider_id / model 不传就用输入框当前的选择;workflow_id 让这条消息按某个工作流跑。" +
        "background=true 时建完切回原来的对话,不把用户的视线带走。需批准。",
      inputSchema: {
        project_id: z.string().optional(),
        prompt: z.string().optional().describe("第一条消息;省略则只建对话"),
        provider_id: z.string().optional().describe("引擎:claude-sdk / codex-sdk / pi-sdk 等(provider.list 可查)"),
        model: z.string().optional(),
        workflow_id: z.string().optional(),
        background: z.boolean().optional(),
        title: z.string().optional().describe("新对话的标题;省略则用默认占位(之后按会话标题生成设置自动起名)"),
      },
      handler: async () => fail("内部错误:app_session_new 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_session_send",
      description:
        "像用户在输入框里打字一样,给某个对话发一条消息(对方正在运行时会插进那一轮)。" +
        "消息会出现在那个对话里,由那个对话的 agent 来回答。不能发给你自己所在的对话。需批准。",
      inputSchema: {
        session_id: z.string(),
        prompt: z.string(),
        workflow_id: z.string().optional().describe("让这条消息按某个工作流跑"),
        background: z.boolean().optional().describe("true = 发完切回原来的对话"),
      },
      handler: async () => fail("内部错误:app_session_send 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_workflow_run",
      description:
        "运行一个工作流。带触发器的自动化:立即跑一次(trigger_node_id 不传且只有一个触发器时自动选)。" +
        "普通工作流(没有触发器):在对话里按它跑 —— 需要 prompt;给 session_id 发到那个对话,不给就新开一个。需批准。",
      inputSchema: {
        workflow_id: z.string(),
        trigger_node_id: z.string().optional(),
        prompt: z.string().optional(),
        session_id: z.string().optional(),
        project_id: z.string().optional(),
      },
      handler: async () => fail("内部错误:app_workflow_run 必须经 invokeAppTool 调用"),
    },
  ];
}

/* ───────────────────────── 调度 ───────────────────────── */

type UiArgs = {
  action: (typeof UI_ACTIONS)[number];
  session_id?: string;
  project_id?: string;
  path?: string;
  line?: number;
  section?: string;
  panel?: "left" | "right" | "terminal" | "browser";
  open?: boolean;
  tab?: "files" | "git" | "browser" | "turns" | "preview" | "flow" | "tasks";
  url?: string;
  title?: string;
  body?: string;
  kind?: "info" | "warning" | "error";
  key?: "locale" | "themeStyle" | "displayMode" | "chatFontSize" | "chatDensity" | "workflowId" | "permissionMode";
  value?: string | number;
  item_id?: string;
  include_html?: boolean;
};

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === null || v === "") throw new Error(`缺少参数 ${name}`);
  return v;
}

async function runUiAction(a: UiArgs, ctx: ProviderContext, sessionId: string): Promise<ToolResult> {
  switch (a.action) {
    case "open_session":
      return uiResult(await ui({ op: "open_session", sessionId: need(a.session_id, "session_id") }), "已切到该对话。");
    case "select_project":
      return uiResult(await ui({ op: "select_project", projectId: need(a.project_id, "project_id") }), "已切到该项目。");
    case "open_file":
      return uiResult(await ui({ op: "open_file", path: need(a.path, "path"), line: a.line }), "已在编辑器里打开。");
    case "open_settings":
      return uiResult(await ui({ op: "open_settings", section: a.section }), "已打开设置页。");
    case "close_settings":
      return uiResult(await ui({ op: "close_settings" }), "已关闭设置页。");
    case "panel":
      return uiResult(await ui({ op: "panel", panel: need(a.panel, "panel"), open: a.open ?? true, tab: a.tab }), "面板已更新。");
    case "open_url": {
      const url = need(a.url, "url");
      if (!/^https?:\/\//i.test(url)) return fail("只支持 http(s) 网址");
      return uiResult(await ui({ op: "open_url", url }), "已在内置浏览器里打开。");
    }
    case "notify":
      return uiResult(await ui({ op: "notify", title: need(a.title, "title"), body: a.body, kind: a.kind }), "已弹出提示。");
    case "set_pref": {
      const key = need(a.key, "key");
      const value = need(a.value, "value");
      const level: AppPolicyLevel = key === "permissionMode" ? "danger" : "write";
      const denied = await gateAppAction(ctx, level, `ui.set_pref.${key}`, { key, value }, `把界面偏好 ${key} 改成 ${String(value)}`);
      if (denied) return fail(denied);
      return uiResult(await ui({ op: "set_pref", key, value }), `已把 ${key} 改成 ${String(value)}。`);
    }
    case "interrupt_session": {
      const sessionId = need(a.session_id, "session_id");
      const denied = await gateAppAction(ctx, "write", "ui.interrupt_session", { sessionId }, `停止对话 ${sessionId} 正在运行的那一轮`);
      if (denied) return fail(denied);
      return uiResult(await ui({ op: "interrupt", sessionId }), "已停止。");
    }
    case "read_panel": {
      // 只读(读渲染结果,不改任何东西)—— 不问批准,与 app_ui_state 同一档。
      const reply = await ui({ op: "read_panel", ...(a.item_id ? { itemId: a.item_id } : {}) });
      if (!reply.ok) return fail(reply.error ?? "读面板失败");
      const d = (reply.data ?? {}) as {
        label?: string; mode?: string; text?: string; textLength?: number; htmlLength?: number; html?: string;
        layout?: PanelLayoutSummary;
      };
      // 面板文本上限(契约 PANEL_PROBE_TEXT_MAX)比 agent 一次该看的量大得多 —— 这里再按
      // 与 renderResult 同一个尺度(40k)截一道,并说清完整长度,免得一个渲染出长列表的面板
      // 把上下文撑爆。
      const FULL = d.text ?? "";
      const textTrunc = FULL.length > PANEL_TEXT_SHOWN;
      const shown = textTrunc ? FULL.slice(0, PANEL_TEXT_SHOWN) : FULL;
      const head =
        `面板「${d.label ?? "?"}」(${d.mode ?? "?"})渲染结果:\n` +
        `— 可见文本${textTrunc ? `(已截断:完整 ${FULL.length} 字符,这里显示前 ${PANEL_TEXT_SHOWN})` : ""} —\n` +
        `${shown.trim() ? shown : "(没有可见文本)"}`;
      // 版式摘要(报告 Q1):外层窗口读不到面板 iframe 的 DOM,也出不了真 PNG(没有 canvas
      // 截图依赖)—— 但面板**自己**算得出元素的矩形 / 字号 / 颜色 / 溢出 / 重叠。让 agent
      // 据此判断「元素重叠 / 超出容器 / 颜色字体不对」。有问题先摆出来;没问题就只报尺寸。
      const layoutTail = renderPanelLayout(d.layout);
      // HTML 只在**确实想看结构**时才回一大坨:文本已经给了绝大多数答案,默认不塞 HTML。
      // 但"文本为空、多半是还没渲染出来"时,HTML 能告诉 agent 是空壳还是 DOM 在但没文字。
      // HTML 默认**不塞**(报告 R2:它常有几万字符,而文本已给了绝大多数答案)——
      // 除非:① agent 显式 `include_html: true`(想看结构);或 ② 可见文本为空
      // (多半还没渲染出来,HTML 能告诉它是空壳还是 DOM 在但没文字)。
      const wantHtml = a.include_html === true || shown.trim().length === 0;
      const tail = wantHtml && d.html && d.html.trim()
        ? `\n\n— HTML(共 ${d.htmlLength} 字符) —\n${d.html.slice(0, 20_000)}${(d.htmlLength ?? 0) > 20_000 ? "…(已截断)" : ""}`
        : d.html && d.html.trim()
          ? `\n\n(还有 HTML ${d.htmlLength} 字符未显示;需要看结构时用 include_html: true 再读一次)`
          : "";
      return text(head + layoutTail + tail);
    }
    case "open_panel": {
      // 打开一个已保存的面板(纯界面动作,与 `panel` 同一档,不问批准)。它跑起来后
      // 若调有副作用的 api.call,那道确认闸在渲染端 —— 这里只负责"开"。
      const reply = await ui({ op: "open_panel", itemId: need(a.item_id, "item_id") });
      return uiResult(reply, "面板已打开;用 read_panel 读它的渲染结果。");
    }
    case "screenshot_panel":
      // 真截一张 PNG(报告 Q1)。只读(读的是渲染结果,不改任何东西)—— 不问批准,与
      // read_panel / app_ui_state 同一档。item_id 省略 = 与 read_panel 同口径挑一个。
      return await screenshotPanel(a.item_id, sessionId);
  }
}

async function runWorkflow(
  args: { workflow_id: string; trigger_node_id?: string; prompt?: string; session_id?: string; project_id?: string },
  sessionId: string,
  ctx: ProviderContext,
): Promise<ToolResult> {
  const statusEntry = findEntry("automation.statusAll");
  let triggers: Array<{ nodeId: string; title: string; workflowId: string }> = [];
  if (statusEntry?.registered) {
    const all = (await callRpc(statusEntry, undefined)) as Array<{ nodeId: string; title: string; workflowId: string }>;
    triggers = Array.isArray(all) ? all.filter((t) => t.workflowId === args.workflow_id) : [];
  }
  if (triggers.length > 0) {
    let nodeId = args.trigger_node_id;
    if (!nodeId) {
      if (triggers.length > 1) {
        return fail(`这条自动化有 ${triggers.length} 个触发器,请用 trigger_node_id 指定:\n${triggers.map((t) => `- ${t.nodeId}(${t.title})`).join("\n")}`);
      }
      nodeId = triggers[0]!.nodeId;
    }
    const denied = await gateAppAction(ctx, "write", "workflow_run", args, `立即运行自动化 ${args.workflow_id}(触发器 ${nodeId})`);
    if (denied) return fail(denied);
    const runEntry = findEntry("automation.run");
    if (!runEntry) return fail("当前版本没有 automation.run");
    const r = (await callRpc(runEntry, { workflowId: args.workflow_id, triggerNodeId: nodeId })) as { ok: boolean; error?: string };
    return r.ok ? text(`已开始运行自动化 ${args.workflow_id}。运行记录用 app_api_call automation.runs 查。`) : fail(r.error ?? "启动失败");
  }
  // 普通工作流:在对话里按它跑。
  const prompt = args.prompt?.trim();
  if (!prompt) return fail("这个工作流没有触发器,要在对话里跑:请给 prompt(以及可选的 session_id / project_id)。");
  if (args.session_id === sessionId) return fail("不能让你自己所在的对话去跑,换一个对话或不传 session_id 新开一个。");
  const denied = await gateAppAction(
    ctx,
    "write",
    "workflow_run",
    args,
    args.session_id ? `在对话 ${args.session_id} 里按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}` : `新开对话,按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}`,
  );
  if (denied) return fail(denied);
  const reply = args.session_id
    ? await ui({ op: "send", sessionId: args.session_id, prompt, workflowId: args.workflow_id, background: true })
    : await ui({ op: "new_session", projectId: args.project_id, prompt, workflowId: args.workflow_id, background: true });
  return uiResult(reply, "已按工作流发出。");
}

/**
 * 唯一入口。引擎侧(Claude 进程内 MCP / Codex 动态工具 / Pi 扩展)都调它。
 */
export async function invokeAppTool(name: string, rawArgs: unknown, sessionId: string, ctx: ProviderContext): Promise<ToolResult> {
  const spec = appMcpTools().find((t) => t.name === name);
  if (!spec) return fail(`未知的 Mcode 控制工具:${name}`);
  try {
    const args = z.object(spec.inputSchema).parse(rawArgs ?? {}) as Record<string, unknown>;
    switch (name) {
      case "app_api_call": {
        const method = String(args.method ?? "");
        const entry = findEntry(method);
        if (!entry) return fail(unknownMethodHint(method));
        const denied = await gateAppAction(
          ctx,
          entry.policy.level,
          entry.method,
          args.input,
          `${entry.method}${entry.policy.reason ? `:${entry.policy.reason}` : entry.doc ? `:${clipLine(entry.doc, 160)}` : ""}`,
          entry.policy.reason,
        );
        if (denied) return fail(denied);
        // 密钥设置键:在**调用之前**拦(见 isSecretSettingKey —— 结果打码拦不住它)。
        const secretRefusal = secretSettingRefusal(entry.method, args.input);
        if (secretRefusal) return fail(secretRefusal);
        try {
          const result = await callRpc(entry, args.input);
          try {
            notifyAppSettingWrite(entry.method, args.input);
          } catch (error) {
            return fail(`操作已完成,但桌面刷新通知失败:${errText(error)}`);
          }
          return text(renderResult(slimSessions(result)));
        } catch (err) {
          return fail(errText(err));
        }
      }
      case "app_ui":
        return await runUiAction(args as UiArgs, ctx, sessionId);
      case "app_session_new": {
        const a = args as { project_id?: string; prompt?: string; provider_id?: string; model?: string; workflow_id?: string; background?: boolean; title?: string };
        const what = a.prompt ? `新开对话并发送:${clipLine(a.prompt, 200)}` : "新开一个对话";
        const denied = await gateAppAction(ctx, "write", "session_new", a, what);
        if (denied) return fail(denied);
        return uiResult(
          await ui({ op: "new_session", projectId: a.project_id, providerId: a.provider_id, model: a.model, prompt: a.prompt, workflowId: a.workflow_id, background: a.background, title: a.title }),
          "已新建对话。",
        );
      }
      case "app_session_send": {
        const a = args as { session_id: string; prompt: string; workflow_id?: string; background?: boolean };
        if (a.session_id === sessionId) return fail("不能给你自己所在的对话发消息。");
        const denied = await gateAppAction(ctx, "write", "session_send", a, `给对话 ${a.session_id} 发送:${clipLine(a.prompt, 200)}`);
        if (denied) return fail(denied);
        return uiResult(await ui({ op: "send", sessionId: a.session_id, prompt: a.prompt, workflowId: a.workflow_id, background: a.background }), "已发送。");
      }
      case "app_workflow_run":
        return await runWorkflow(args as { workflow_id: string }, sessionId, ctx);
      default:
        return await spec.handler(args, { sessionId });
    }
  } catch (err) {
    return fail(errText(err));
  }
}
