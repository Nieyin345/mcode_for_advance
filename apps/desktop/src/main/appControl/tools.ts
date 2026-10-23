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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { notifyAppSettingWrite } from "@main/customUi/settingSync.js";
import { savePngArtifact } from "@main/lib/screenshotStore.js";
import { safeErrorMessage } from "@main/lib/ipcError.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderContext } from "@contracts/provider";
import {
  APP_DANGER_APPROVAL_PREFIX,
  formatOperationResult,
  isOperationCommitted,
  OP_CODE,
  OPERATION_ID_MAX_BYTES,
  OP_WARNING_UI_REFRESH_FAILED,
  type AppUiCommand,
  type AppUiReply,
  type OperationIntent,
  type OperationRecord,
  type OperationResult,
  type OperationWarning,
} from "@contracts/appControl";
import { fail, image, text, textBlocksOf, type McpToolSpec, type ToolResult } from "@main/mcp/sdk.js";
import { API_CATALOG, type ApiCatalogEntry } from "./apiCatalog.generated.js";
import { decodeDomainOutcome, resolveOperationOutcome, resultKindOfOutcome, resultKindOfOperationOutcome, opExtraFromOutcome, sideEffectClassOf, thrownResultKind } from "./commandOutcome.js";
import {
  getOperationLedger,
  intentFingerprint,
  operationIdWithinLimit,
  requestDigestOf,
  setOperationLedger,
} from "./operations.js";
import {
  beginChannelOperation,
  idempotencyApplies,
  usableOperationId,
  type ChannelIdempotencyDecision,
} from "./channelIdempotency.js";
import { computePanelCaptureRect } from "./panelCaptureRect.js";
import {
  APP_POLICY_LEVEL_LABEL,
  DOMAIN_LABELS,
  domainOfMethod,
  domainsMatchingTaskWord,
  policyFor,
  type AppPolicy,
  type AppPolicyLevel,
} from "./policy.js";
import { guideFor, guideOverview, guideTopics } from "./guide.js";
import { validateExtension } from "./extensionValidate.js";
// 【T20】扩展工坊：AI 写扩展的六步闭环（draft → 静态校验 → 沙箱 → 交接用户确认）。
// 只在工具 handler 内做**动态 import** —— 工坊模块会拉 `permissionedProcessRunner`
// （子进程执行器），把它静态带进 tools.ts 的 import 图会让无头套件在打包时把它整条
// 拖进来；这里只要类型与一个纯函数，按需取即可。
import type { ExtensionWorkshopReport, ExtensionWorkshopInstallHandoff } from "@contracts/extensionWorkshop";
// 类型只在编译期存在（`import type` 被 esbuild 原样擦除），不会把工坊模块带进 bundle。
import type { ExtensionWorkshopOptions } from "@main/modules/extensionWorkshop.js";
import { APP_API_TUTORIALS, tutorialsMatchingWord } from "./appApiTutorials.js";
import {
  describeWorkflowToolParams,
  publishedToolsWithDocs,
  publishedToolMethodName,
  publishWorkflowTool,
  renderWorkflowParams,
  unpublishWorkflowTool,
  validateWorkflowParams,
} from "@main/orchestration/publishedTools.js";
import { getWorkflow } from "@main/orchestration/library.js";
import { evaluate } from "./policyEngine.js";
import { getGrantStore } from "./grantStoreRuntime.js";
import type { GrantDecision } from "./grantStore.js";
import type { ActionIntent, ActorRef, CoreIntent, PolicyCompatibilityLevel } from "@contracts/policyEngine";
import { physicalPath } from "@main/lib/realPathWithin.js";
// 【MC-004】密钥设置键判据 —— 全仓唯一一份(见 @main/lib/secretKeys 文件头)。
import { isSecretSettingKey as isSharedSecretSettingKey } from "@main/lib/secretKeys.js";
import {
  runWithAgentMemoryScopeForSession,
  runWithUnboundAgentExtensionScope,
} from "@main/memory/agentScope.js";
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
 * ## 判据不再写在这里
 *
 * 【MC-004】名单与两条正则从前写在**本文件**、`settings/settingsTransfer.ts`、
 * `mobile/MobileHttpServer.ts` **三处**,而且已经漂开(一处认 `cookieVault`、另一处认
 * `paireddevices`)。现已收成 `@main/lib/secretKeys` 的**唯一一份** `isSecretSettingKey`,
 * 三个消费方共享 —— 往下看那份文件头的三层判据,新增密钥键加在那里。
 *
 * ⚠️ **这一侧(agent 读设置)在共享判据之上多挡一个键**(见 {@link READ_SIDE_EXTRA_SECRET_KEYS}):
 * 共享判据只收真密钥,而这侧的防线是 `redactValue` 的按字段名打码(仓库记录过它脆弱)。
 */

/**
 * 【MC-004】本侧(agent 经 `setting.get*` 读设置)**额外**要挡的键。
 *
 * `customModels` 的值是**公开元数据**(地址 / 名字 / 模型 id),共享判据不收它 —— 导出
 * 设置那条路有 `scrubSecrets` 深度清洗(把 `customHeaders` 里的鉴权头删掉、元数据照常
 * 导出),所以导出侧显式豁免、保持可导出。但**这一侧**只有 `redactValue` 的按**字段名**
 * 打码,而用户配在 `customHeaders` 上的网关密钥字段名任取(`x-api-key` / `Authorization`
 * / 自定义名),按名打码正是仓库反复记录的洞(「打码靠键名、换个字段名就漏」)。判据不一
 * 对等:拒绝多读一个键的代价是模型看不到一段公开元数据,放行的代价是网关密钥明文进上下文。
 */
const READ_SIDE_EXTRA_SECRET_KEYS: ReadonlySet<string> = new Set(["customModels"]);

/** 这个设置键是不是"密钥本体",不能经 `setting.get*` 交给模型。 */
export function isSecretSettingKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return READ_SIDE_EXTRA_SECRET_KEYS.has(key) || isSharedSecretSettingKey(key);
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

/**
 * 【MC-036】**工作流运行授权**的写保护不在本文件:授权落在一份**独立文件**
 * (`<数据根>/ui-modules/workflow-grants.json`,理由见 `@contracts/moduleCapability`),
 * 不经 `setting.set`,所以没有可被 Agent 整行改写的设置键。签发 / 撤销的唯一通道是
 * `modules.issueWorkflowGrant` / `modules.revokeWorkflowGrant` —— 那两条在
 * `appControl/policy.ts` 的 `BLOCKED` 表里,`app_api_call` 与面板桥都够不到;
 * 真正够得到的只有桌面设置页里用户本人的点击。文件本身用 tmp+rename 原子写,
 * 坏存档整表拒读拒写(见 `classifyModuleWorkflowGrants`)。
 */

const LEVEL_LABEL = APP_POLICY_LEVEL_LABEL;

/* ───────────────────────── 目录 ───────────────────────── */

export interface ApiEntry extends ApiCatalogEntry {
  policy: AppPolicy;
  registered: boolean;
}

function domainOf(method: string): string {
  return domainOfMethod(method);
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
    out.push({
      method,
      channel: ch,
      doc: "",
      input: "(清单里没有说明,按报错提示传参)",
      // 【MC-040】没进生成清单的通道没有深展开版 —— full 与浅版一致(见 describe handler)。
      inputFull: "(清单里没有说明,按报错提示传参)",
      output: "unknown",
      policy: policyFor(method),
      registered: true,
    });
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

/** 计划级授权的有效期(从用户本人点头那一刻起算)。够覆盖一整套计划,又不至于永久生效。 */
const PLAN_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * 按档位决定放不放行。返回 `null` = 放行;字符串 = 拒绝原因(原样给模型)。
 * 没有审批通道(无界面的环境)一律拒绝 —— fail-closed。
 *
 * ## `onUserApproved` —— **只有「用户本人新鲜点头」那一刻**才触发(ARC-004 签发端的接入点)
 *
 * 这个可选回调是计划级授权**唯一的签发触发点**:它只在这条真正**弹了审批卡、用户本人
 * 点了允许**的路径上被调一次。下面这些**都没有**用户本人的新鲜批准,故**一律不触发**
 * (于是什么都签不出):
 *   - `read` / `ui`:直接放行,从不弹卡;
 *   - `blocked`:直接拒;
 *   - 只读 / 计划模式:直接拒;
 *   - **完全访问(bypass)模式的系统默认放行** —— 没人点头,是系统替用户放的行;
 *   - **已记的「始终允许」**(`isToolAlwaysAllowed`)—— 是**之前**某次批准的复用,不是这次
 *     本人点头(它的授权在**当初那次**点头时早已签出)。
 * 这正是 ARC-004 的硬判据:**agent / system 不能给自己发授权** —— 只有真人在卡上点的
 * 「允许」才铸得出 grant。
 */
/**
 * T51: install approval card must be intelligible BEFORE consent. Never grants
 * rights: the existing danger gate still requires the user's fresh decision.
 */
export function extensionInstallApprovalSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "\n扩展清单：未提供";
  const manifest = (input as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object") return "\n扩展清单：未提供";
  const m = manifest as { id?: unknown; permissions?: unknown; program?: { source?: unknown } };
  const permissions = Array.isArray(m.permissions)
    ? m.permissions.filter((p): p is string => typeof p === "string").slice(0, 41)
    : [];
  const source = typeof m.program?.source === "string" ? m.program.source : "";
  const calledApis = [...new Set([...source.matchAll(/(?:mcode\.api\.call|app_api_call)\s*\(\s*["']([^"']+)["']/g)].map(v => v[1]!))].slice(0, 20);
  return "\n扩展 ID：" + (typeof m.id === "string" ? m.id.slice(0, 100) : "(缺失)") +
    "\n清单申请权限：" + (permissions.join(", ") || "(无)") +
    "\n程序静态 API 调用（仅识别字面量，动态调用无法列尽）：" + (calledApis.join(", ") || "(未识别出)") +
    "\n批准后将安装上述扩展；取消则不安装。";
}

export async function gateAppAction(
  ctx: ProviderContext,
  level: AppPolicyLevel,
  approvalKey: string,
  input: unknown,
  description: string,
  blockedReason?: string,
  onUserApproved?: () => void,
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
  // ★ 用户本人**新鲜**点头 —— 唯一的签发触发点(上面每一条"系统替用户放行"的路径都已 return)。
  onUserApproved?.();
  return null;
}

/**
 * 【ARC-004 步④ · **签发端**】用户在审批卡上**本人点头**后,把这次批准的**来源与作用域**
 * 铸成一份 `Grant` 存进 `getGrantStore()` —— 之后同一资源上的同一动作**不再逐次弹卡**。
 *
 * ## 为什么签发口是**这里**
 *
 * 全仓此前 `issueGrant(` **零生产调用方** —— 授权表永远是空的,`planGrantPrecheck` 只会走
 * 「无绑定授权 → 默认审批链」。本函数补上那条**真实的签发口**:被 `gateAppAction` 的
 * `onUserApproved` 回调调起,只在**用户本人新鲜批准**的那一刻执行。
 *
 * ## 安全判据(ARC-004 明令)
 *
 *   - **只有用户本人能签发**:本函数只由「新鲜审批通过」触发,agent / system 的放行
 *     (完全访问模式的系统默认、已记的「始终允许」)到不了这里 —— 它们**不产生授权**;
 *   - 另有一道由 `GrantStore.issueGrant` 强制的 `subject.kind === "user"` 兜底(双保险);
 *   - **danger 不签**:高风险动作每次都要本人批,受限授权不能替代;
 *   - **read / ui 不签**:它们从不弹卡。
 *
 * ## 作用域 —— **只签「请求指纹兜底」的方法**(`real === false`)
 *
 * 作用域 = 这次动作**解析出的身份**(与 `planGrantPrecheck` 共用同一份 `resolveActionCore`)。
 * 但这里**只签 `real === false` 的方法**(核心意图是**请求指纹** = 会话 + 方法 + 参数摘要)。
 * 理由(源码可确认):`planGrantPrecheck` 对 `real === true` 的方法(`file.*` / `git.*` /
 * `terminal.create`)会退到 `findGoverningFor` —— **不看资源**、按动作取回那枚授权,交给
 * `evaluate` 判「核心意图被换」。若这里给这类方法签一枚**资源作用域**的授权,那么**同一方法**
 * 的**另一个资源**(如先批 `terminal.create(C:/a)`、再调 `terminal.create(C:/b)`)会被
 * `findGoverningFor` 取到这枚授权 → `evaluate` 判 `projectPath` 变了 → **硬拒绝**(连审批都
 * 不弹)—— 这把默认路径从「逐次弹卡」**改成**「换资源直接拒」,是**回归**。
 *
 * 签**指纹作用域**的授权没有这个副作用:`findBoundFor` 按会话+方法+参数摘要精确匹配 ——
 * 同一件事(同会话/同方法/同参数)→ 命中 → 跳过弹卡;换其一 → 匹配不到 → 回到默认审批链
 * (弹卡),不会被误判成「越权」硬拒。故本切片只签指纹方法(`session.*` / `library.*` /
 * `project.*` 这类尚无宿主解析出真实资源身份的),对资源作用域方法的自动签发**留待后续**
 * (需先让 `planGrantPrecheck` 对「换了资源」回落到弹卡而非硬拒,那是判定口径的另一切片)。
 */
function signPlanGrantForUserApproval(entry: ApiEntry, args: unknown, sessionId: string): void {
  // 只给 write 档签(danger 每次要本人批;read/ui 从不走到审批)。
  if (entry.policy.level !== "write") return;
  const store = getGrantStore();
  const input = (args as { input?: unknown }).input ?? null;
  const { core, real } = resolveActionCore(entry.method, input, sessionId);
  // 只签**指纹作用域**的方法(见文件头):资源作用域方法若签成资源作用域授权,同方法的另一
  // 资源会被 `findGoverningFor` 取到并硬拒 —— 那是回归,故这里不签。
  if (real) return;
  const decision: GrantDecision = {
    verdict: "allow",
    reason: "用户在审批卡上本人批准了这次操作。",
    compatibilityLevel: "write",
    sceneId: "app_api_call",
    allowedActions: [entry.method],
    scopedCore: core,
    // `planGrantPrecheck` 侧构造的 intent 不携带 configHash,故这里的占位值不参与判定。
    configHash: "",
    ttlMs: PLAN_GRANT_TTL_MS,
  };
  const subject: ActorRef = { kind: "user", id: "app_api_call.approval" };
  try {
    store.issueGrant(decision, subject, Date.now());
  } catch {
    // 签发失败不该反过来把一次**已经批准**的调用判成失败 —— 静默跳过,退化成「逐次弹卡」的
    // 旧行为(只是不省这一步),不改变这次调用的结果。
  }
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
 *
 * ## 结果形状与 agent 那条路同源(ARC-009)
 *
 * 从前这里把**三种事实**糊成同一个 `{ok:false,error}`:参数 ZodError(命令**没执行**)、
 * 只读方法执行抛错(**没副作用**)、写 / 高风险档执行途中抛错(**可能已部分提交**)——
 * 面板作者读到同样一句 error,会对一个**可能已落定**的非幂等写操作再调一次(与 agent
 * `app_api_call` 当年那个洞同款)。这里补上 `operation` 字段(与 agent 同源的
 * `OperationResult`,复用 `decodeDomainOutcome` / `makeOp`):ZodError → **REJECTED**;
 * 只读档抛错 → **FAILED**(可安全重试);写 / 高风险档抛错 → **UNCERTAIN**
 * (`retryable=false`,文本提醒先查真实状态)。同时对 RPC 的合法返回跑
 * `decodeDomainOutcome` —— 登记过 `{ok:false}` 合同的方法(如 `git.push` / `browser.create`)
 * 的业务拒绝不再被报成 `ok:true`(MC-066 那个洞,面板这条路从前没堵)。
 * ⚠️ 只加结构,不改既有 `ok`/`error`/`needsApproval` 字段的形状 —— 桥与面板脚本照旧。
 */
export async function panelApiCall(
  method: string,
  input: unknown,
  approved: boolean,
  panelLabel: string,
  /**
   * 【MC-014】可选幂等键（面板脚本重试同一件写操作时原样带回）。与 Agent 的
   * `operation_id`、桌面 IPC 的 `__operationId`、手机 RPC 的 `operationId` 走
   * **同一份**操作账本。只在 write / danger 档执行路径上生效；只读不带账。
   */
  operationId?: string,
): Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
  needsApproval?: boolean;
  level?: "write" | "danger";
  description?: string;
  /**
   * ARC-009:结构化结果(与 agent `app_api_call` **同源** —— 复用 `makeOp` /
   * `decodeDomainOutcome` / `resultKindOfOutcome` / `formatOperationResult`)。成功系列带
   * `ok:true`,REJECTED / FAILED / UNCERTAIN 带 `ok:false`。只**新增**这一个字段,既有
   * `ok` / `error` / `needsApproval` 的形状不变(桥与面板脚本照旧读旧字段)。
   */
  operation?: OperationResult;
}> {
  const entry = findEntry(method);
  if (!entry) {
    const reason = unknownMethodHint(method);
    return { ok: false, error: reason, operation: makeOp("REJECTED", method, randomUUID(), { code: OP_CODE.methodNotFound, reason }) };
  }
  if (!entry.registered) {
    const reason = `这个方法在当前版本里没有注册(${entry.channel})。`;
    return { ok: false, error: reason, operation: makeOp("REJECTED", entry.method, randomUUID(), { code: OP_CODE.notRegistered, reason }) };
  }
  const level = entry.policy.level;
  if (level === "blocked") {
    const reason = `这个功能不开放:${entry.policy.reason ?? "安全原因"}`;
    return { ok: false, error: reason, operation: makeOp("REJECTED", entry.method, randomUUID(), { code: OP_CODE.blocked, reason }) };
  }
  // 密钥设置键:在**调用之前**拦(见 `isSecretSettingKey` —— 结果打码拦不住它)。
  const secretRefusal = secretSettingRefusal(entry.method, input);
  if (secretRefusal) {
    return { ok: false, error: secretRefusal, operation: makeOp("REJECTED", entry.method, randomUUID(), { code: OP_CODE.secretKeyRefused, reason: secretRefusal }) };
  }
  if ((level === "write" || level === "danger") && approved !== true) {
    // 等用户点头 —— 这是个**暂停**(交回界面去问),不是"命令没执行"的终结性判定,故不挂
    // `operation`(挂了会把一次待批准的调用说成 REJECTED,误导面板作者以为已经失败了)。
    const what = entry.policy.reason ?? entry.doc ?? entry.method;
    return {
      ok: false,
      needsApproval: true,
      level,
      description: `面板「${panelLabel}」要调用 ${entry.method} —— ${clipLine(what, 200)}`,
    };
  }
  // ── 真正执行 RPC(到这里一定被调一次)──────────────────────────────
  // 【MC-014】面板通道的幂等:带 operationId 且是写/高风险档时,先过共享账本再执行。
  // 领取失败(冲突/在途/上次不确定/领取没落盘)一律**不执行**,按既有形状返回。
  const opId = usableOperationId(operationId);
  let idem: ChannelIdempotencyDecision | null = null;
  // 【MC-014】按**方法**判副作用(不是档位):blocked-but-mutating 的方法由面板
  // 走不到(level blocked 已在上面拒),这里保持一致入口、不另判一次。
  if (opId !== null && idempotencyApplies(entry.method)) {
    idem = beginChannelOperation({
      operationId: opId,
      ownerId: `panel:${panelLabel || "custom-ui"}`,
      sessionId: `panel:${panelLabel || "custom-ui"}`,
      sceneId: "custom-ui-panel",
      method: entry.method,
      input: input ?? null,
      grantRevision: "custom-ui-panel",
    });
    if (idem.kind === "replay") {
      const op = idem.record;
      return { ok: true, result: op, operation: op };
    }
    if (idem.kind !== "execute") {
      const op = makeOp("REJECTED", entry.method, opId, {
        code: `operation_${idem.kind}`,
        retryable: false,
        reason: idem.reason,
      });
      return { ok: false, error: formatOperationResult(op), operation: op };
    }
  }
  let result: unknown;
  try {
    // 【MC-095】面板的 `api.call` 与 agent 的 `app_api_call` 走同一条 `callRpc`,同样**不带**
    // 宿主铸造的扩展身份 —— 面板脚本能借它填别人的 `extensionId` 读另一个扩展的数据区
    // (与 E1 同源)。这里同样包「没有扩展身份」的作用域 → handler 一律拒。面板要用**自己**
    // 的存储走 `mcode.storage.*` / `mcode.extension.*`(桥用 `host.item.id` 自绑,不经这里)。
    result = entry.method.startsWith("extensionStore.")
      ? await runWithUnboundAgentExtensionScope(() => callRpc(entry, input))
      : await callRpc(entry, input);
  } catch (err) {
    // ZodError = 参数在**执行之前**就被挡下 → 命令没跑 → REJECTED(可安全改参数重来)。
    if (err instanceof z.ZodError) {
      const op = makeOp("REJECTED", entry.method, randomUUID(), { code: OP_CODE.rpcFailed, reason: errText(err) });
      idem?.kind === "execute" && idem.settle(op);
      return { ok: false, error: formatOperationResult(op), operation: op };
    }
    // 其余抛错:只读 / 界面档不可能有副作用 → FAILED(可安全重试);写 / 高风险档**可能已
    // 部分提交** → UNCERTAIN(`retryable=false`,文本提醒先查真实状态)—— 与 agent 那条路
    // 同判据。这一条正是 ARC-009 对 `panelApiCall` 点名的"失败分支":旧代码把它和"没执行"
    // 糊成同一个 `{ok:false,error}`,面板作者会对一个可能已落定的非幂等写操作再调一次。
    // 【MC-060】但 `ModuleHost` 执行点拒绝一个**没执行**的 action 调用时抛的带 `moduleRefusal`
    // 标记 Error 必须落 REJECTED(命令没执行,可安全重来),与 agent 那条路共用 `thrownResultKind`。
    const kind = thrownResultKind(err, level);
    const op = kind === "REJECTED"
      ? makeOp("REJECTED", entry.method, randomUUID(), { code: OP_CODE.approvalDenied, reason: errText(err) })
      : kind === "UNCERTAIN"
        ? makeOp("UNCERTAIN", entry.method, randomUUID(), {
            code: OP_CODE.rpcUncertain,
            reason: `执行途中出错,无法确认副作用是否已落定:${errText(err)}`,
          })
        : makeOp("FAILED", entry.method, randomUUID(), { code: OP_CODE.rpcFailed, reason: errText(err) });
    if (idem?.kind === "execute") idem.settle(op);
    return { ok: false, error: formatOperationResult(op), operation: op };
  }
  // ── 领域结果解码(MC-066):RPC resolve ≠ 业务成功 ───────────────────
  // 登记过 `{ok,error}` 合同的方法(如 `browser.*` / `git.push`),ok:false 是业务**明确
  // 拒绝**或**可能已部分提交** —— 从前这条路**没跑解码**,把业务拒绝也当 `ok:true` 交回
  // 面板(与 agent 那条路 MC-066 修的是同一个洞)。这里补齐,按登记语义落 REJECTED /
  // UNCERTAIN。
  const outcome = resolveOperationOutcome(entry.method, result);
  if (outcome && outcome.kind !== "accepted") {
    const op = makeOp(resultKindOfOperationOutcome(outcome), entry.method, randomUUID(), opExtraFromOutcome(outcome));
    if (idem?.kind === "execute") idem.settle(op);
    return { ok: false, error: formatOperationResult(op), operation: op };
  }
  // 聚合结果**完全成功**时也带上(可能为空的)warnings/码 —— 用 opExtraFromOutcome 收口。
  const extra = outcome ? opExtraFromOutcome(outcome) : {};
  // 结果打码 —— 与 agent 的 `renderResult` 同一份 `redactValue`。密钥类设置键上面已前置
  // 拦掉,这里是兜底(如返回值里嵌着别的凭据字段)。
  const successOp = makeOp("SUCCEEDED", entry.method, opId ?? randomUUID(), extra);
  if (idem?.kind === "execute") {
    let body: string | undefined;
    try {
      body = JSON.stringify(successOp);
    } catch {
      body = undefined;
    }
    idem.settle(successOp, body);
  }
  return { ok: true, result: redactValue(result), operation: successOp };
}

function errText(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `参数不对:${err.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join(";")}。先用 app_api_describe 看参数格式。`;
  }
  return safeErrorMessage(err);
}

async function ui(cmd: AppUiCommand): Promise<AppUiReply> {
  try {
    return await runUiCommand(cmd);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/**
 * 【MC-059】纯业务动作的**无窗口**路径 —— 新建对话 / 往对话发消息**不该**因为渲染窗口
 * 没开或没准备好就失败。它们的状态(会话行、消息、运行时)本来就归主进程;只有"切换用户
 * 视线"那部分属于界面。所以当 UI 桥报告"窗口没开 / 界面没准备好"时,这里改走**主进程的
 * 同一套服务**(`createOrReuseSession` + `runtimeManager.sendTurn`),与桌面 IPC 走的是同一份
 * 实现(硬规矩 2)。真正 UI 专属的动作(开文件、切标签、截图)仍走 UI 桥。
 *
 * 返回 `null` 表示"不是 UI 不可用,该走原路"(例如 UI 报的是别的业务错误)。
 */
/**
 * 【ARC-001 步③】headless 路把 `expectedRevision` 透传给唯一业务命令时,它抛出的
 * `SessionRevisionConflictError` **原样往外抛**(由 {@link runSessionNew} 接住并翻成
 * REJECTED)。这里不吞、不改写 —— 判据只有一份(`lib/sessionStart.ts`)。
 */
async function headlessNewSession(a: {
  project_id?: string; prompt?: string; provider_id?: string; model?: string; workflow_id?: string; title?: string; expected_revision?: string; permission_grant?: string;
}, actorId: string): Promise<string | null> {
  // 【ARC-001】建会话 + 发首条是**唯一一份业务命令** —— 桌面 `claude:startSession` IPC 与这条
  // headless 路都调 `appServices/sessionCommands.ts` 的 `createSessionAndSend`(硬规矩 2)。
  // 这里只剩它那条路独有的两件事:① 挑项目(不传就取第一个);② 把 `sendError` 翻成 agent
  // 那条路原先那句「对话已建好…但第一条消息没发出去」(结果形状不变)。
  const { createSessionAndSend } = await import("@main/appServices/sessionCommands.js");
  const { ProjectRepo } = await import("@main/store/repositories.js");
  const project = a.project_id
    ? ProjectRepo.get(a.project_id)
    : ProjectRepo.list()[0];
  if (!project) return "没有可用的项目,请给 project_id";
  const { session, sendError } = await createSessionAndSend({
    input: {
      projectId: project.id,
      kind: "chat",
      effort: "default",
      permissionMode: "default",
      ...(a.provider_id ? { providerId: a.provider_id } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.title ? { title: a.title } : {}),
    },
    prompt: a.prompt ?? "",
    ...(a.workflow_id ? { workflowId: a.workflow_id } : {}),
  }, {
    // 【ARC-001 步②】agent 路 = 结构化的「谁在调」:actorKind 是 agent,actorId 是**发起
    // 这次调用的会话 id**(传进来那一个)—— 不再是裸字符串 "agent"。
    actorKind: "agent",
    actorId,
    operationId: randomUUID(),
    scope: project.id,
    // 【ARC-001 步③】Agent 若带了乐观并发修订号,原样交给服务函数核对;核对失败它会抛,
    // 由 `runSessionNew` 翻成 REJECTED(没执行)。缺席 = 不启用。
    ...(a.expected_revision ? { expectedRevision: a.expected_revision } : {}),
    // 【ARC-001 步④】Agent 若带了一枚计划授权句柄,原样交给服务函数 —— 由**宿主**从目标项目
    // 解析权威资源身份、去 `getGrantStore()` 取回授权、交唯一判定核 `evaluate` 核对(不是
    // 采信这个字符串)。核不过会抛 `SessionGrantRefusedError`,由 `runSessionNew` 翻成 REJECTED。
    ...(a.permission_grant ? { permissionGrant: a.permission_grant } : {}),
  });
  if (sendError !== null) return `对话已建好(${session.id}),但第一条消息没发出去(上一轮还在运行)`;
  return null;
}

async function headlessSend(sessionId: string, prompt: string, workflowId?: string): Promise<string | null> {
  const { SessionRepo, ProjectRepo } = await import("@main/store/repositories.js");
  const { runtimeManager } = await import("@main/claude/RuntimeManager.js");
  const session = SessionRepo.get(sessionId);
  if (!session) return `找不到对话 ${sessionId}`;
  const project = ProjectRepo.get(session.projectId);
  const cwd = session.worktreePath ?? project?.path;
  if (!cwd) return `对话 ${sessionId} 没有可用的工作目录`;
  const handle = await runtimeManager.sendTurn(session, {
    prompt,
    cwd,
    ...(workflowId ? { workflowId } : {}),
  });
  return handle === null ? "上一轮还在运行,消息没发出去" : null;
}

/** UI 桥报的"窗口没开 / 界面没准备好"这一类 —— 只有这些才该转无窗口路径。 */
function uiUnavailable(reply: AppUiReply): boolean {
  return !reply.ok && /窗口没有打开|界面还没准备好|界面.*没有回应/.test(reply.error ?? "");
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
export const APP_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "app_api_list", "app_api_describe", "app_api_tutorial", "app_guide", "app_ui_state",
  "app_panel_api_list", "extension_validate",
  // 【T20】工坊状态是**只读投影**（不写盘、不对账）；`extension_build` 会写草稿目录，
  // 故意**不**在这里 —— 它走 write 档审批（见 hostMcpServer 的 approvalTierOf 兜底）。
  "extension_workshop_status",
  // 【T24】文档工具面的发现/只读半边（写操作在 invokeAppTool 里按工具分档弹卡）。
  "document_apps", "document_tools_list", "document_tool_describe", "document_md_read", "document_render",
]);

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

/* ───────────────────【T24】文档工具面的端口装配 ───────────────────
 *
 * `document_*` 六个工具与 `document.*` IPC 调**同一个**业务模块
 * （`documentToolRuntime`），区别只在端口从哪来：
 *
 *   - CLI 路径：与 `ipc/document.ts` 同一份 `resolveGenofficeCliPath(documentRepoRoot())`；
 *   - 工作区围栏：与 file/document IPC 同一份 `findContainingWorkspaceRoot`；
 *   - 渲染端绑定：只能来自 T0 的请求级登记簿（`documentToolRendererBinding`）——
 *     agent 侧没有“当前文件是否开着”的会话事实，所以按 filePath 查登记簿，
 *     没有活跃绑定就走 CLI；有就走受信 ACK（定义必须是请求声明的原件）。
 *   - 临时输出：`<dataRoot>/docs/export-tmp/t24-render`（与文档导出的临时根同一处）。
 */
function documentRuntimePortsSync():
  | { ok: true; ports: import("@main/document/documentToolRuntime.js").DocumentSurfacePorts }
  | { ok: false; reason: string } {
  // 动态 require：这些模块要么带 Electron/DB 依赖（pathGuard → repositories），要么只在
  // 真调用时才需要；本文件顶层不能把它们拉进无头套件的 bundle。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { documentRepoRoot } = require("@main/ipc/document.js") as typeof import("@main/ipc/document.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveGenofficeCliPath } = require("@main/document/genofficeCli.js") as typeof import("@main/document/genofficeCli.js");
  const cliPath = resolveGenofficeCliPath(documentRepoRoot());
  if (cliPath === null) {
    return { ok: false, reason: "没有找到仓库内的 GenOffice CLI 快照（genoffice/packages/cli/dist/genoffice.cjs）。请先在 genoffice/ 下构建 CLI。" };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { findContainingWorkspaceRoot } = require("@main/lib/pathGuard.js") as typeof import("@main/lib/pathGuard.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dataRoot } = require("@main/lib/dataRoot.js") as typeof import("@main/lib/dataRoot.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require("@main/document/documentToolRendererBinding.js") as typeof import("@main/document/documentToolRendererBinding.js");
  const sole = () => registry.soleActiveRendererBinding();
  const ports = {
    cliPath,
    withinWorkspace: (path: string) => findContainingWorkspaceRoot(path) !== null,
    renderTempRoot: () => {
      const dir = join(dataRoot(), "docs", "export-tmp", "t24-render");
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    // 只有**恰好一个**活跃文档 AI 请求时才借渲染端通道；多开或无绑定都退回 CLI。
    rendererOpen: (_filePath: string) => sole().ok,
    invokeRendererTool: (call, definition) => {
      const binding = sole();
      if (!binding.ok) return Promise.resolve({ status: "error", output: binding.reason });
      return binding.invoke(call, definition);
    },
    rendererToolDefinition: (tool) => {
      const binding = sole();
      return binding.ok ? binding.definitionOf(tool) : null;
    },
  } satisfies import("@main/document/documentToolRuntime.js").DocumentSurfacePorts;
  return { ok: true, ports };
}

/** 目录里某个工具名可能出现在哪些编辑器（审批分档用；不触盘）。 */
function documentCatalogAppsFor(tool: string): Array<"docs" | "sheets" | "slides" | "pdf" | "markdown" | "html"> {
  // 静态目录在 `.generated.ts` 里；这里只按名字查 app，不 import runtime（避免把 IO 拉进来）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DOCUMENT_TOOL_CATALOG } = require("@main/document/documentToolCatalog.generated.js") as typeof import("@main/document/documentToolCatalog.generated.js");
  return DOCUMENT_TOOL_CATALOG.filter((entry) => entry.name === tool).map((entry) => entry.app);
}

/** `document_apps` 用的无文件端口：不触盘，只回目录事实。 */
function documentCliPortsFor(): import("@main/document/documentToolRuntime.js").DocumentSurfacePorts {
  const resolved = documentRuntimePortsSync();
  if (resolved.ok) return resolved.ports;
  return {
    cliPath: "",
    withinWorkspace: () => false,
    rendererOpen: () => false,
    renderTempRoot: () => "",
  };
}

/* ───────────────────【T20】扩展工坊的运行时装配 ───────────────────
 *
 * 工坊模块（`modules/extensionWorkshop.ts`）是纯模块：根目录、沙箱工作区、沙箱 RPC 派发
 * 全部注入。这里是**生产装配点**，与 `documentRuntimePortsSync` 同一手法用动态 require ——
 * 数据根（`dataRoot` 拉 electron）、宿主（`service` 拉 sql.js）都不能静态进本文件的
 * import 图，否则无头套件打包时就炸。
 */

/** 工坊的一次运行时装配：根目录 + 注入的选项。失败抛出可读原因（调用方转成 fail）。 */
async function workshopRuntime(): Promise<{ root: string; options: ExtensionWorkshopOptions }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dataRoot } = require("@main/lib/dataRoot.js") as typeof import("@main/lib/dataRoot.js");
  const root = join(dataRoot(), "extension-workshop");
  return {
    root,
    options: {
      workshopRoot: root,
      // 沙箱里的 read 档 RPC 走**与 app_api_call 同一条**既有通道（`callRpc` 直接调
      // 登记过的 handler，不经过审批 —— 审批在这里是多余的：read 档本来就不弹卡，且
      // 沙箱桥自己先按 policyFor 把非 read 的方法拒掉了）。这样扩展在安装前就能验证
      // 「它真的能读到 project.list」而不是装完才发现。
      sandboxAppCall: async (method, input) => {
        const entry = findEntry(method);
        if (!entry || !entry.registered) throw Error(`沙箱里没有这个方法：${method}`);
        return callRpc(entry, input);
      },
    },
  };
}

/** 宿主目录里的已装用户模块（`modules.catalog` 的投影）。宿主不可用 → `null`（不猜）。 */
async function installedModuleFacts(): Promise<Array<{ id: string; version: string }> | null> {
  try {
    const { getModuleHost } = await import("@main/modules/service.js");
    const catalog = (await getModuleHost()).catalog();
    return catalog.modules
      .filter((module) => module.id.startsWith("user."))
      .map((module) => ({ id: module.id, version: module.version }));
  } catch {
    return null;
  }
}

export function appMcpTools(): McpToolSpec[] {
  return [
    {
      // 【T24】文档 AI 工具面：**发现**而不是全量注入。139 个原生工具整批 JSON-Schema
      // 约 138 KB 上下文；这里按 app_api_list→describe→call 同构收成四层，每个编辑器只
      // 常驻 ≤2 个高频读工具。执行走 `document.toolCall`（受围栏的 CLI 或 T0 受信渲染端）。
      name: "document_apps",
      description:
        "列出 Mcode 能编辑的文档编辑器（docs / sheets / slides / pdf / markdown / html）：各自的常驻读工具、" +
        "工具总数、CLI 能承载的工具名、编辑后强制跑的 QA 门禁。改 Word/PPT/Excel/PDF 之前先调一次。" +
        "下一步：document_tools_list({app, query}) 找工具 → document_tool_describe({tool}) 看参数 → document_tool_call 执行。",
      inputSchema: {},
      handler: async () => {
        const { documentApps } = await import("@main/document/documentToolRuntime.js");
        return text(JSON.stringify(documentApps(documentCliPortsFor()), null, 2));
      },
    },
    {
      name: "document_tools_list",
      description:
        "列出某个编辑器（或全部六个）的原生工具；query 按名称/说明检索。共 139 个，**不会**一次性进上下文。" +
        "route=cli 的工具在文件没开在编辑器里时也能用；route=editor 的要求文件已在 Mcode 编辑器里打开。",
      inputSchema: {
        app: z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]).optional().describe("编辑器；省略 = 全部"),
        query: z.string().max(200).optional().describe("关键词（工具名或说明里的字），如 chart / comment / 表格 / 批注"),
        cliOnly: z.boolean().optional().describe("只看文件没开在编辑器里时也能用的工具"),
      },
      handler: async (args: { app?: "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html"; query?: string; cliOnly?: boolean }) => {
        const { documentToolsList } = await import("@main/document/documentToolRuntime.js");
        return text(JSON.stringify(documentToolsList(args), null, 2));
      },
    },
    {
      name: "document_tool_describe",
      description:
        "看某个文档工具的完整参数与示例（CLI 承载的 op 直接取 genoffice guide 的原文，永远是校验器那一份）。" +
        "返回里的 withheld 说明该工具超出模型请求级 schema 子集、只能由编辑器自己执行。",
      inputSchema: {
        tool: z.string().min(1).max(120).describe("工具名（来自 document_tools_list），可带 app. 前缀"),
        app: z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]).optional(),
      },
      handler: async (args: { tool: string; app?: "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html" }) => {
        const { documentToolDescribe } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        return text(JSON.stringify(await documentToolDescribe(ports.ports, args), null, 2));
      },
    },
    {
      // 【T47】设计方法论就是 CLI 的 `guide <domain> <topic>` 原文。不接这个入口，
      // `build_deck` 的「先读规范」就永远执行不到 —— 模型只能凭感觉摆 px。
      name: "document_guide",
      description:
        "取 GenOffice 的**方法论文档**原文（不是工具参数表，那是 document_tool_describe）。" +
        "做 PPT 之前**必须先调** document_guide({app:\"slides\", topic:\"design\"})：它给出 style.md / outline.json 的写法、" +
        "18 种布局名、CJK 与拉丁的排版数值、以及一份明写「treat as defects」的反模式清单" +
        "（每张卡片左侧的细竖条、彩虹卡片、封面只有标题加副标题、用 emoji 等）。" +
        "页面规格字段调 topic:\"spec\"；省略 topic 取该域的顶层目录（先看有什么再取）。" +
        "docs / sheets 也有各自的 guide。返回正文不截断，按 chars 判断要不要分段读。",
      inputSchema: {
        app: z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]).optional()
          .describe("编辑器；省略时用 domain"),
        domain: z.string().min(1).max(32).optional()
          .describe("CLI 的 guide 域：slides / docs / sheets（省略时由 app 推）"),
        topic: z.string().min(1).max(64).optional()
          .describe("子域：design / spec，或一个 group / op 名；省略 = 该域顶层目录"),
      },
      handler: async (args: { app?: "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html"; domain?: string; topic?: string }) => {
        const { documentGuide } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        const result = await documentGuide(ports.ports, args);
        if (!result.ok) {
          return fail(result.reason + (result.suggestions && result.suggestions.length > 0
            ? `\n可选的 topic：${result.suggestions.join(" | ")}`
            : ""));
        }
        return text(
          `# ${result.domain} guide${result.topic ? ` · ${result.topic}` : ""}（${result.chars} 字符，原文未截断）\n\n` +
          result.text,
        );
      },
    },
    {
      name: "document_tool_call",
      description:
        "执行一个文档原生工具（只读的直接执行）。编辑类工具**执行后强制跑 check/audit**，把 detail.issues 原样带回；" +
        "文件开在 Mcode 编辑器里时走受信渲染端（能改实时视图、可撤销），否则走 CLI 等价命令（改盘上文件）。" +
        "路径必须在已知工作区内。改 Word 的格式/批注用 apply_ops + 对应 op，别拿整篇重写去顶。" +
        "**新建 PPT 用 slides 的 build_deck**（设计流水线：先 document_guide({app:\"slides\",topic:\"design\"}) " +
        "拿规范 → 写 style.md + outline.json + pages/NN.json → build_deck 带 render:true,audit:true → 看 PNG 与 audit → 最多两轮修）。" +
        "新建 docx/xlsx/pdf 用 create_document（input.source 是源文件；docx 接受受限 HTML fragment）。",
      inputSchema: {
        tool: z.string().min(1).max(120).describe("工具名（先 document_tools_list / document_tool_describe）"),
        app: z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]).optional(),
        filePath: z.string().min(1).max(4096).describe("绝对路径（必须在工作区内）"),
        input: z.record(z.string(), z.unknown()).optional().describe("工具参数（形状见 document_tool_describe）"),
        dryRun: z.boolean().optional().describe("只演练不写盘（CLI apply --dry-run）"),
        track: z.boolean().optional().describe("把编辑记成 Word 修订，默认 true（可逐条接受/拒绝）"),
      },
      handler: async (args: {
        tool: string; app?: "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";
        filePath: string; input?: Record<string, unknown>; dryRun?: boolean; track?: boolean;
      }) => {
        const { documentToolCall } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        const result = await documentToolCall(ports.ports, args);
        return result.ok ? text(result.text) : fail(result.reason);
      },
    },
    {
      name: "document_md_read",
      description:
        "把 Word 文档读成**带定位符的 Markdown**：每个块前有 `<!-- b3 -->` 锚点，改写时直接引用它，不必自己数块索引。" +
        "这是编辑 Word 的首选读法（比 read_blocks 的 JSON 摘要更省上下文）。",
      inputSchema: {
        filePath: z.string().min(1).max(4096).describe("绝对路径（必须在工作区内）"),
        range: z.string().max(32).optional().describe("只读这些块（0-based，形如 \"3-7\"）"),
      },
      handler: async (args: { filePath: string; range?: string }) => {
        const { documentMarkdownRead } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        const result = await documentMarkdownRead(ports.ports, args);
        if (!result.ok) return fail(result.reason);
        return text(
          `共 ${result.blocks} 块；定位符就是每行前的 <!-- bN -->。改写用 document_md_edit。\n\n${result.markdown}`,
        );
      },
    },
    {
      name: "document_md_edit",
      description:
        "用 Markdown 编辑 Word：insert（在 afterBlock 之后插入，-1 = 文首）、append（文末续写）、replace（替换块区间）、" +
        "delete（删除块区间）。Markdown 片段经 CLI 转 restricted HTML 后交给 docs apply；默认记成 Word 修订（可逐条接受/拒绝）。" +
        "编辑后强制跑 docs check，问题在返回的 qa 里。",
      inputSchema: {
        filePath: z.string().min(1).max(4096).describe("绝对路径（必须在工作区内）"),
        operations: z.array(z.object({
          op: z.enum(["insert", "append", "replace", "delete"]),
          afterBlock: z.number().int().min(-1).optional().describe("insert：插在第几块之后（-1 = 文首）"),
          startBlock: z.number().int().min(0).optional().describe("replace/delete：起始块（0-based）"),
          endBlock: z.number().int().min(0).optional().describe("replace/delete：结束块（含）"),
          markdown: z.string().min(1).max(200_000).optional().describe("insert/append/replace 的 Markdown 片段"),
        })).min(1).max(20),
        track: z.boolean().optional().describe("记成 Word 修订，默认 true"),
        dryRun: z.boolean().optional().describe("只演练不写盘"),
      },
      handler: async (args: {
        filePath: string;
        operations: Array<{ op: "insert" | "append" | "replace" | "delete"; afterBlock?: number; startBlock?: number; endBlock?: number; markdown?: string }>;
        track?: boolean; dryRun?: boolean;
      }) => {
        const { documentMarkdownEdit } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        const normalized: Array<
          | { op: "insert"; afterBlock: number; markdown: string }
          | { op: "append"; markdown: string }
          | { op: "replace"; startBlock: number; endBlock: number; markdown: string }
          | { op: "delete"; startBlock: number; endBlock: number }
        > = [];
        for (const operation of args.operations) {
          if (operation.op === "append") {
            if (typeof operation.markdown === "string") normalized.push({ op: "append", markdown: operation.markdown });
          } else if (operation.op === "insert") {
            if (typeof operation.markdown === "string") normalized.push({ op: "insert", afterBlock: operation.afterBlock ?? -1, markdown: operation.markdown });
          } else if (operation.op === "replace") {
            if (typeof operation.markdown === "string") {
              normalized.push({ op: "replace", startBlock: operation.startBlock ?? 0, endBlock: operation.endBlock ?? operation.startBlock ?? 0, markdown: operation.markdown });
            }
          } else {
            normalized.push({ op: "delete", startBlock: operation.startBlock ?? 0, endBlock: operation.endBlock ?? operation.startBlock ?? 0 });
          }
        }
        if (normalized.length !== args.operations.length) return fail("操作缺字段：insert/append/replace 需要 markdown，replace/delete 需要 startBlock。");
        const result = await documentMarkdownEdit(ports.ports, {
          filePath: args.filePath, operations: normalized,
          ...(args.track !== undefined ? { track: args.track } : {}),
          ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        });
        return result.ok ? text(result.text) : fail(result.reason);
      },
    },
    {
      name: "document_render",
      description:
        "把文档渲染成逐页 PNG 并返回图片路径 —— **改完必须亲眼看一遍**（这是解决「丑」的关键）。" +
        "图落在受控临时目录；读不到图的模型可用 agent_read_image 转述。",
      inputSchema: {
        filePath: z.string().min(1).max(4096).describe("绝对路径（必须在工作区内）"),
        page: z.number().int().min(1).max(2000).optional().describe("只出这一页（1-based）；省略 = 整份"),
        scale: z.number().min(0.5).max(4).optional().describe("缩放，默认 1"),
      },
      handler: async (args: { filePath: string; page?: number; scale?: number }) => {
        const { documentRender } = await import("@main/document/documentToolRuntime.js");
        const ports = documentRuntimePortsSync();
        if (!ports.ok) return fail(ports.reason);
        const result = await documentRender(ports.ports, args);
        if (!result.ok) return fail(result.reason);
        // 【T24】**真正把图交到模型手里**：路径只对读得到图的模型有意义，而有视觉输入
        // 的模型需要的是 image 块本身。与 `browser_screenshot` 同一待遇：image 块 +
        // 路径说明；读不到图的模型用 agent_read_image 转述。
        const head = text(`${result.note}\n${result.files.map((file) => `- ${file}`).join("\n")}`);
        const images: ToolResult[] = [];
        for (const file of result.files.slice(0, 8)) {
          try {
            images.push(image(readFileSync(file).toString("base64"), "image/png"));
          } catch {
            // 读失败不改变“已渲染”这个事实；路径仍在下面的正文里。
          }
        }
        if (images.length === 0) return head;
        return { content: [...head.content, ...images.flatMap((item) => item.content)] };
      },
    },
    {
      name: "extension_validate",
      description: "只检查扩展清单、权限、贡献点和隔离程序工厂。不会安装/落盘/调用扩展业务能力；可安装不等于已授予权限。受控核验进程不可用时明确返回不可安装。",
      inputSchema: {
        manifest: z.unknown().describe("ModuleManifest 完整 JSON 对象"),
        programSource: z.string().max(64 * 1024).optional().describe("可选，覆盖 manifest.program.source"),
      },
      handler: async (args: { manifest: unknown; programSource?: string }) => {
        const result = await validateExtension(args.manifest, args.programSource);
        return text(JSON.stringify({ status: result.installable ? "可以安装" : "不可安装", ...result }, null, 2));
      },
    },
    {
      // 【T20】AI 写扩展的**闭环入口**。六步里本工具做 ①—④：清单草案 → 静态校验（不执行）
      // → 写进受控草稿目录 → 隔离沙箱真跑一次最小调用。**它不安装**（⑤ 用户确认、⑥ 安装
      // 与回滚都在 `modules.install` / `modules.remove` 的既有事务上）：成功时返回的
      // `handoff` 只是「下一步该调什么、带哪些字段」，`requiresUserApproval` 恒为 true，
      // `installConsent` 永远是 `allow-once` —— AI 拿不到、也构造不出代签。
      //
      // 为什么是工具而不是新 RPC：见 `@contracts/extensionWorkshop` 文件头（新 RPC 会强制
      // 重生成 `apiCatalog.generated.ts` 与 `appPermission.ts`，后者会把 10 条未归类的
      // 方法一次性收进委托面 —— 放宽方向，且两者是他人卡的边界）。
      name: "extension_build",
      description:
        "AI 写扩展的闭环（写出清单 + 程序 → 静态校验 → 隔离沙箱真跑一次最小调用）。" +
        "**不安装**：成功返回的是安装交接材料（handoff），必须再调 app_api_call({method:\"modules.install\", input:handoff.input}) " +
        "由用户在审批卡上本人确认；AI 无权代签。沙箱里只允许 read 档 RPC，write/danger 一律不跑。" +
        "失败返回可照抄的 issues（stage 说明卡在哪步）；同一扩展连续失败 3 次后会被拒绝，须交还用户。",
      inputSchema: {
        draft: z.unknown().describe(
          "ExtensionWorkshopDraft：{ manifest: ModuleManifest, notes?: string }。" +
          "manifest 是声明式清单（权限必须是 MODULE_PERMISSION_NAMES 里的 36 个之一；" +
          "可执行部分是 program.source —— 一个返回 { [能力短名]: async (resource) => ModuleResult } 的函数工厂）。",
        ),
      },
      handler: async (args: { draft: unknown }) => {
        const runtime = await workshopRuntime();
        const {
          buildExtension, summarizeWorkshopReport, extensionWorkshopInstallHandoff, reconcileWorkshopStates,
        } = await import("@main/modules/extensionWorkshop.js");
        // ⑥ 对账（best-effort）：以宿主目录为准修正工坊状态（用户装了/卸了都会在这里对齐）。
        const installed = await installedModuleFacts();
        const reconciled = installed === null
          ? { applied: [] as string[], errors: ["宿主目录不可用，本次没有对账（工坊状态可能与实际安装不一致）"] }
          : await reconcileWorkshopStates(runtime.root, installed);
        const report = await buildExtension(args.draft, runtime.options);
        const notes = args.draft && typeof args.draft === "object"
          ? (args.draft as { notes?: unknown }).notes
          : undefined;
        const payload: { report: ExtensionWorkshopReport; handoff: ExtensionWorkshopInstallHandoff | null; reconciled: typeof reconciled } = {
          report,
          handoff: report.ok && report.draft !== null
            ? extensionWorkshopInstallHandoff(report.draft.manifest, typeof notes === "string" ? notes : undefined)
            : null,
          reconciled,
        };
        return text(summarizeWorkshopReport(report) + "\n\n" + JSON.stringify(payload, null, 2));
      },
    },
    {
      // 【T20】只读状态投影：工坊记录的修复预算/可回滚点，叠加「宿主目录里现在装没装」。
      // 不写盘、不对账（对账发生在 extension_build 里）——`pendingRollbackCleanup` 告诉
      // 调用方哪些目录下次会被清理。
      name: "extension_workshop_status",
      description:
        "列出扩展工坊里的草稿/已装扩展：每个模块的修复次数、可回滚点（上一版）、宿主里当前的版本，" +
        "以及哪些已卸载模块的草稿还在等待清理。只读；安装状态以宿主目录 modules.catalog 为准。",
      inputSchema: {},
      handler: async () => {
        const runtime = await workshopRuntime();
        const { projectWorkshopStatus } = await import("@main/modules/extensionWorkshop.js");
        const installed = await installedModuleFacts();
        if (installed === null) {
          return fail("宿主目录不可用，无法确认哪些扩展真的装着（工坊状态不作数）。");
        }
        return text(JSON.stringify(projectWorkshopStatus(runtime.root, installed), null, 2));
      },
    },
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
              "  ⑤ 某个域/已发布工作流工具/扩展能力**怎么用、什么权限、怎么调**:用 app_guide({topic}) 查(不带参数列全部 topic)。\n" +
              "要找**有没有**某个能力,先 app_api_list({domain}) 或按关键词搜,别凭名字猜。",
          );
        }
        const q = args.query?.trim().toLowerCase();
        // 【MC-039】查询除了方法名/说明的**字面子串**,再走一层"任务词 → 域":
        // agent 拿用户原话(「创建自动化」)查得到,不必先知道内部术语。域命中的
        // 返回该域**全部**方法(候选列表;细节交给 app_api_describe)。
        const taskDomains = q ? domainsMatchingTaskWord(q) : new Set<string>();
        const picked = all.filter(
          (e) =>
            (!args.domain || domainOf(e.method) === args.domain.trim()) &&
            (!q ||
              e.method.toLowerCase().includes(q) ||
              e.doc.toLowerCase().includes(q) ||
              taskDomains.has(domainOf(e.method))),
        );
        // 【MC-041】动态实例(用户发布的派生工具)并入同一份索引 —— 查询与目录
        // 走的就是这条路,没有第二套。纯派生工具命中且静态目录为空时,直接回它。
        let derivedHeader = "";
        if (!args.domain) {
          const published = publishedToolsWithDocs();
          const hits = published.filter(
            (p) =>
              q &&
              (p.name.toLowerCase().includes(q) ||
                p.docName.toLowerCase().includes(q) ||
                publishedToolMethodName(p.tool).toLowerCase().includes(q) ||
                (p.tool.description ?? "").toLowerCase().includes(q)),
          );
          if (hits.length > 0) {
            const lines = hits.map(
              (p) =>
                `- ${publishedToolMethodName(p.tool)} [需批准] — 用户发布的工作流「${p.docName}」${p.tool.description ? `:${p.tool.description}` : ""}` +
                `\n  参数:${describeWorkflowToolParams(p.workflowId)}\n  调用:app_workflow_run({workflow_id:"${p.workflowId}", params:{…}})${
                  (() => {
                    const s = getWorkflow(p.workflowId)?.inputSchema;
                    return Array.isArray(s?.required) && (s!.required as unknown[]).length > 0 ? `(必填:${(s!.required as unknown[]).join(" / ")})` : "";
                  })()
                }`,
            );
            const header = text(
              `匹配「${args.query!.trim()}」的用户派生工具(共 ${hits.length} 个;这些是工作流发布出来的,不在静态 RPC 目录里):\n${lines.join("\n")}`,
            );
            // 静态结果为空:照旧只回派生工具(格式不变)。
            if (picked.length === 0) return header;
            // 静态也命中:两段**一起**返回 —— 派生工具不能被任务词命中吞掉。
            derivedHeader = textBlocksOf(header).join("");
          }
        }
        if (picked.length === 0) return text("没有匹配的方法。不带参数调用一次看全部功能域。");
        const lines = picked.map(
          (e) => `- ${e.method} [${LEVEL_LABEL[e.policy.level]}]${e.registered ? "" : "(未注册)"}${e.doc ? ` — ${clipLine(e.doc, 120)}` : ""}`,
        );
        // 任务词命中(而非字面命中)时把口径说清:返回的是"可能是你要的功能域下的全部方法",
        // 免得 agent 以为每个都是精确匹配。
        const hitDomains = [...taskDomains].filter((d) => all.some((e) => domainOf(e.method) === d));
        const viaTasks = q && hitDomains.length > 0 ? `(「${args.query!.trim()}」按任务词命中功能域:${hitDomains.join(" / ")},下面是这些域的全部方法)` : "";
        const staticSection = `${picked.length} 个方法${viaTasks}:\n${lines.join("\n")}`;
        return text(derivedHeader ? `${derivedHeader}\n\n${staticSection}` : staticSection);
      },
    },
    {
      name: "app_api_describe",
      description:
        "看某个 Mcode 方法的完整说明、参数格式、返回格式和权限档。调用 app_api_call 之前先看一眼。" +
        "参数里嵌套结构显示成 {…} 时,加 detail=\"full\" 拿**逐层展开**的完整结构(嵌套到若干层;" +
        "仍然截断处会给字段名提示)。",
      inputSchema: {
        method: z.string().describe("方法名,如 session.rename(来自 app_api_list)"),
        setting_key: z.string().optional().describe("查看已知 JSON 设置的结构,例如 customUi.config.v1"),
        // 【MC-040】浅展开(常驻清单)只到第一层,`workflow.save` 这类"入参是一棵树"的
        // 方法嵌套层全在省略号里 —— full 按需展开(嵌套多层 + 字段注释),不常驻上下文。
        detail: z
          .enum(["compact", "full"])
          .optional()
          .describe("full = 参数按完整嵌套结构展开;默认 compact(第一层,给清单用的那份)"),
      },
      handler: async (args: { method: string; setting_key?: string; detail?: "compact" | "full" }) => {
        // 【MC-041】派生工具的描述走同一入口:`workflow.run.<名字>`。
        if (args.method.startsWith("workflow.run.")) {
          const p = publishedToolsWithDocs().find((x) => publishedToolMethodName(x.tool) === args.method);
          if (!p) return fail(`没有发布过名为「${args.method.slice("workflow.run.".length)}」的派生工具。用 app_api_list({query:"<工作流名>"}) 查已发布的。`);
          const doc = getWorkflow(p.workflowId);
          return text(
            [
              `方法:${args.method}(用户发布的工作流派生工具)`,
              `权限:需批准(执行时弹审批卡;发布/撤销本身也是)`,
              `说明:${p.tool.description ?? `运行工作流「${p.docName}」`}`,
              `workflow_id:${p.workflowId}`,
              `参数:${describeWorkflowToolParams(p.workflowId)}`,
              doc?.outputSchema && Object.keys(doc.outputSchema).length > 0 ? `产出声明:${JSON.stringify(doc.outputSchema)}` : null,
              `调用:app_workflow_run({workflow_id:"${p.workflowId}", params:{…}})(参数按上面的 schema 校验,不符会在执行前拒绝)`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        const e = findEntry(args.method);
        if (!e) return fail(unknownMethodHint(args.method));
        const inputText = args.detail === "full" ? e.inputFull : e.input;
        const noteFull = args.detail === "full" && e.inputFull !== e.input ? "(完整嵌套结构)" : "";
        return text(
          [
            `方法:${e.method}`,
            `权限:${LEVEL_LABEL[e.policy.level]}${e.policy.reason ? `(${e.policy.reason})` : ""}`,
            e.registered ? null : "⚠️ 当前版本没有注册这个方法的处理函数",
            e.doc ? `说明:${e.doc}` : null,
            `参数${noteFull}:${inputText}`,
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
      // 【MC-040】按任务查步骤 —— 「创建自动化」这类事是多个方法按顺序调,
      // 单看任何一个方法的说明都拼不出来。不带参数列全部教程主题。
      name: "app_api_tutorial",
      description:
        "按**任务**查「该按什么顺序调哪些方法」(创建自动化 / 自定义面板 / 工作流 / 导入论文 / 引擎模型配置 / 记忆交接)。" +
        "app_api_list 解决「有没有这个功能」,这里解决「这件事怎么串起来做」。不带参数列出全部主题。",
      inputSchema: {
        query: z.string().optional().describe("任务关键词,如 创建自动化 / 面板 / 交接"),
      },
      handler: async (args: { query?: string }) => {
        const q = args.query?.trim();
        if (!q) {
          return text(
            `共 ${APP_API_TUTORIALS.length} 篇教程:\n` +
              APP_API_TUTORIALS.map((t) => `- ${t.id}:${t.title}(关键词:${t.keywords.slice(0, 6).join(" / ")})`).join("\n") +
              `\n\n下一步:app_api_tutorial({query:"<关键词>"}) 看某篇的步骤。方法细节用 app_api_describe。`,
          );
        }
        const hits = tutorialsMatchingWord(q);
        if (hits.length === 0) {
          return text(`没有匹配「${q}」的教程。不带参数看全部主题;或 app_api_list({query:"${q}"}) 直接按词搜方法。`);
        }
        return text(
          hits
            .map((t) => {
              const steps = t.steps.map((s, i) => `  ${i + 1}. ${s.method} —— ${s.note}`).join("\n");
              const pitfalls = t.pitfalls?.length ? `\n  常见坑:\n${t.pitfalls.map((p) => `   · ${p}`).join("\n")}` : "";
              return `## ${t.title}(${t.id})\n${steps}${pitfalls}`;
            })
            .join("\n\n"),
        );
      },
    },
    {
      // 【ARC-002】统一教程入口 —— 「这个功能域 / 已发布工作流工具 / 扩展能力怎么用、
      // 要什么权限、参数长什么样」。
      //
      // **为什么是独立工具而不是把 `app_api_describe` 扩成支持 `topic`**(二选一,台账
      // 设计目标第 2 条叫 `guide(topic)`,这里照做):describe 的键是**方法名**,它的合同
      // 是"参数格式 / 返回格式 / 权限档";而 guide 的键横跨三种对象 —— 功能域(如
      // `library`)、用户发布的工作流工具(`workflow.run.<名字>`)、扩展能力
      // (`module.<slug>.<短名>` / `core.file.inspect`)。塞进 describe 会让同一个
      // `method` 参数既可能是方法名又可能是域/能力 id,`unknownMethodHint` 的
      // "你是不是要找 X" 也会对着域报错 —— 两个分类混在一个合同里,调用方无从判断
      // 自己拿到的是哪种。独立工具还能整体追加而不改 describe 的既有行为(它不是
      // 兼容性变更的落点)。
      //
      // 内容**全部从权威源现场派生**(见 guide.ts 文件头):方法的目录与权限、已发布
      // 工具、扩展能力目录三类各一条 topic,没有第二份手写清单。
      name: "app_guide",
      description:
        "按主题查指南:这个功能/工作流工具/扩展能力**怎么用、要什么权限、有哪些参数**。" +
        "不带参数列出全部 topic(功能域 / 用户发布的工作流工具 / 已装扩展能力);带 topic 返回该主题的方法清单、" +
        "权限档(哪些会弹审批)与可复制的 app_api_call 示例。与 app_api_tutorial 的分工:教程讲「按什么顺序做一串」," +
        "guide 讲「这个主题有什么、什么权限、怎么调」。",
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe("主题 id:功能域名(如 library / workflow)、workflow.run.<名字>、或扩展能力 id(如 core.file.inspect)"),
      },
      handler: async (args: { topic?: string }) => {
        const topic = args.topic?.trim();
        if (!topic) {
          const overview = await guideOverview();
          const topics = overview.topics;
          const domains = topics.filter((t) => t.kind === "domain");
          const tools = topics.filter((t) => t.kind === "workflow-tool");
          const caps = topics.filter((t) => t.kind === "extension-capability");
          const authoring = topics.filter((t) => t.kind === "authoring-guide");
          // 扩展目录取不到时**如实说**(硬规矩 3):此刻列不出已装扩展能力,不是"没有扩展"。
          const sources = caps.length === 0 && overview.moduleCatalogError
            ? `(扩展能力目录此刻取不到:${overview.moduleCatalogError};功能域与工作流工具不受影响)`
            : "";
          return text(
            [
              `共 ${topics.length} 个 topic(功能域 ${domains.length} / 已发布工作流工具 ${tools.length} / 扩展能力 ${caps.length} / 开发指南 ${authoring.length}):`,
              "",
              "一、功能域(方法目录 + 权限档)",
              ...domains.map((t) => `- ${t.id}:${t.summary}`),
              "",
              "二、用户发布的工作流工具",
              ...(tools.length > 0 ? tools.map((t) => `- ${t.id}:${t.summary}`) : ["(还没有发布过工作流工具;发布用 app_workflow_publish)"]),
              "",
              "三、已装扩展能力",
              ...(caps.length > 0
                ? caps.map((t) => `- ${t.id}:${t.summary}`)
                : [sources || "(没有已装的扩展能力;宿主内置能力会列在这里)"]),
              "",
              "四、扩展开发指南",
              ...authoring.map((t) => `- ${t.id}:${t.summary}`),
              "",
              `下一步:app_guide({topic:"<主题 id>"}) 看该主题的权限档与示例;方法级细节用 app_api_describe。`,
            ].join("\n"),
          );
        }
        const guide = await guideFor(topic);
        if (!guide) {
          const topics = await guideTopics();
          const near = nearestName(topic, topics.map((t) => t.id));
          const all = topics.map((t) => t.id).join(" / ");
          return fail(
            `没有这个 topic:${topic}。${near ? `你是不是要找「${near}」?` : ""}现有 topic 共 ${topics.length} 个:${all}`,
          );
        }
        return text(guide.body);
      },
    },
    {
      name: "app_api_call",
      description:
        "调用一个 Mcode 方法(与界面上点按钮执行的是同一段代码)。只读的直接执行;有副作用的会弹审批卡;" +
        "高风险的每次都要用户本人批准;不开放的会直接拒绝。返回值里的密钥/令牌一律打码。" +
        "返回值带结构化的 OperationResult(resultKind = SUCCEEDED / SUCCEEDED_WITH_WARNINGS / REJECTED / FAILED / UNCERTAIN):" +
        "SUCCEEDED_WITH_WARNINGS 表示**业务已提交**、只是界面刷新等后续步骤有警告 —— **不要因为它重复执行**;" +
        "REJECTED 表示命令没执行(可安全重来);UNCERTAIN 表示副作用是否落定无法确认(**不要盲目重试**)。" +
        "重试同一件事时**带上上次返回的 operationId**(operation_id 参数),宿主会去重,不会重复执行已提交的操作。",
      inputSchema: {
        method: z.string().describe("方法名(来自 app_api_list)"),
        input: z.unknown().optional().describe("参数对象,格式见 app_api_describe;无参方法省略"),
        operation_id: z
          .string()
          .optional()
          .describe("幂等键:重试同一操作时原样带回上次返回的 operationId,宿主据此去重、不重复执行已提交的操作。首次调用可省略。"),
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
        expected_revision: z.string().optional().describe(
          "乐观并发修订号(可选)。要在「复用项目里那条还没发言的『新对话』空壳」上做并发保护时带上它:" +
          "先从 session.list* 读到那条空壳的 updatedAt,原样填在这里;主进程复用前会核对它还是不是那一版," +
          "对不上就拒绝(什么都没建),不会静默复用/新建一条你没预期的对话。省略 = 不做这个保护(照旧)。",
        ),
        permission_grant: z.string().optional().describe(
          "计划授权句柄(可选 grantId)。要在**某个已批准的计划/任务**之下开这个对话时带上它:" +
          "主进程会自己去跟授权库核对这枚授权是否存在、仍有效、且覆盖这次建会话(方法 session.create + 目标项目对得上);" +
          "核不过就拒绝(什么都没建)—— 绝不采信你自报的字符串。省略 = 不按计划授权开(照旧)。",
        ),
        operation_id: z.string().optional().describe("幂等键(可选):重试同一次建对话时原样带回上次返回的 operationId,宿主据此去重、不会建出第二条。"),
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
        operation_id: z.string().optional().describe("幂等键(可选):重试同一条消息时原样带回,宿主据此去重、不会把同一句话发两遍。"),
      },
      handler: async () => fail("内部错误:app_session_send 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_workflow_run",
      description:
        "运行一个工作流。带触发器的自动化:立即跑一次(trigger_node_id 不传且只有一个触发器时自动选)。" +
        "普通工作流(没有触发器):在对话里按它跑 —— 需要 prompt;给 session_id 发到那个对话,不给就新开一个。需批准。" +
        "【派生工具】用户发布过的工作流也可以带 params 结构化调用:params 按该工作流的 inputSchema 校验," +
        "不符会在执行前拒绝。发布的工具用 app_api_list({query}) 查,app_api_describe 看参数。",
      inputSchema: {
        workflow_id: z.string(),
        trigger_node_id: z.string().optional(),
        prompt: z.string().optional(),
        session_id: z.string().optional(),
        project_id: z.string().optional(),
        // 【MC-041】结构化实参:按工作流 inputSchema 校验后渲染进正文。
        params: z.record(z.string(), z.unknown()).optional().describe("结构化实参(按工作流 inputSchema 校验;见 app_api_describe workflow.run.<名字>)"),
        operation_id: z.string().optional().describe("幂等键(可选):重试同一次运行/发布时原样带回,宿主据此去重。"),
      },
      handler: async () => fail("内部错误:app_workflow_run 必须经 invokeAppTool 调用"),
    },
    {
      // 【MC-041】把用户自建工作流发布为带参数的派生工具(检索/描述/结构化调用的入口)。
      name: "app_workflow_publish",
      description:
        "把一份工作流**发布为派生工具**(它是复用入口:发布后可按名字被 app_api_list 检索到、" +
        "app_api_describe 看参数、app_workflow_run 带 params 结构�化调用)。发布要真人批准;" +
        "撤销用 app_workflow_unpublish。参数 schema 来自工作流自己的 inputSchema(没声明就无参)。",
      inputSchema: {
        workflow_id: z.string().describe("要发布的工作流 id(workflow.list 查)"),
        name: z.string().describe("派生工具名(用户可读的短名,如「文献整理」;检索按它匹配)"),
        description: z.string().optional().describe("一句话说明它做什么"),
        operation_id: z.string().optional().describe("幂等键(可选):重试同一次发布时原样带回,宿主据此去重。"),
      },
      handler: async () => fail("内部错误:app_workflow_publish 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_workflow_unpublish",
      description: "撤销一个已发布的派生工具(从检索索引里移除;工作流本体不动)。需批准。",
      inputSchema: {
        workflow_id: z.string(),
        operation_id: z.string().optional().describe("幂等键(可选):重试同一次撤销时原样带回,宿主据此去重。"),
      },
      handler: async () => fail("内部错误:app_workflow_unpublish 必须经 invokeAppTool 调用"),
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

/**
 * 【ARC-009】`app_workflow_run` 的结果按**业务是否真的落定**分派,而不是旧的「成功 / 失败」
 * 两态。这是 ARC-009 remaining 点名的入口之一(`app_session_new` / `app_session_send` /
 * `app_workflow_run` / `panelApiCall` 仍走旧形状)——复用已有 `decodeDomainOutcome` /
 * `resultKindOfOutcome` / `makeOp` / `operationToolResult`,不另造结果形状。
 *
 * 从前这里一律 `fail(...)`,把所有情形糊成"失败":
 *   - `automation.run` 合法回 `{ok:false}`(触发器找不到 / 没存过)= 命令**没执行** ——
 *     从前报失败,Agent 会照着"失败可重试"再调一遍;现按 `decodeDomainOutcome` 判 **REJECTED**;
 *   - `automation.run` **执行途中抛错** = 可能已经起了运行 —— 从前的普通失败会诱导重复启动,
 *     现判 **UNCERTAIN**(`retryable=false`,文本点明"先查真实状态再决定");
 *   - 普通工作流经渲染端 `new_session` 时 "对话已建好,但第一条消息没发出去" = **已落一半** ——
 *     从前的失败会让 Agent 重开一个新对话;现判 **UNCERTAIN**。
 * 旧成功文案(不带状态行)保持原样,只多挂一个 `structuredContent.operation_result`。
 */
/** 【MC-041】发布工作流为派生工具 —— 走既有审批链(发布是用户可见的能力面变化,真人批准)。 */
async function runWorkflowPublish(
  args: { workflow_id: string; name: string; description?: string; operationId?: string },
  ctx: ProviderContext,
  finish?: (r: OperationResult, body?: string, note?: string) => ToolResult,
): Promise<ToolResult> {
  const method = "app_workflow_publish";
  const operationId = args.operationId ?? randomUUID();
  const emitResult = finish ?? ((r: OperationResult, body?: string, note?: string) => operationToolResult(r, body, note));
  const denied = await gateAppAction(ctx, "write", "workflow_publish", args, `把工作流 ${args.workflow_id} 发布为派生工具「${args.name}」`);
  if (denied) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
    );
  }
  // 审批之后才发布:审批被拒 = 什么都没发生(REJECTED,可改条件重来)。
  const r = publishWorkflowTool({ workflowId: args.workflow_id, name: args.name, description: args.description });
  if (!r.ok) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.rpcFailed, reason: r.error ?? "发布失败" }),
    );
  }
  return emitResult(
    makeOp("SUCCEEDED", method, operationId),
    undefined,
    `已发布「${args.name}」。现在 app_api_list({query:"${args.name}"}) 能检索到它,app_workflow_run({workflow_id:"${args.workflow_id}", params:{…}}) 可结构化调用。`,
  );
}

/** 【MC-041】撤销发布(幂等)。 */
async function runWorkflowUnpublish(
  args: { workflow_id: string; operationId?: string },
  ctx: ProviderContext,
  finish?: (r: OperationResult, body?: string, note?: string) => ToolResult,
): Promise<ToolResult> {
  const method = "app_workflow_unpublish";
  const operationId = args.operationId ?? randomUUID();
  const emitResult = finish ?? ((r: OperationResult, body?: string, note?: string) => operationToolResult(r, body, note));
  const denied = await gateAppAction(ctx, "write", "workflow_unpublish", args, `撤销工作流 ${args.workflow_id} 的派生工具发布`);
  if (denied) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
    );
  }
  const r = unpublishWorkflowTool(args.workflow_id);
  if (!r.ok) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.rpcFailed, reason: r.error ?? "撤销失败" }),
    );
  }
  return emitResult(
    makeOp("SUCCEEDED", method, operationId),
    undefined,
    r.existed ? "已撤销发布(工作流本体未动)。" : "这份工作流本来就没有发布过(目标状态已达成)。",
  );
}

async function runWorkflow(
  args: { workflow_id: string; trigger_node_id?: string; prompt?: string; session_id?: string; project_id?: string; params?: Record<string, unknown>; operationId?: string },
  sessionId: string,
  ctx: ProviderContext,
  finish?: (r: OperationResult, body?: string, note?: string) => ToolResult,
): Promise<ToolResult> {
  const method = "app_workflow_run";
  const operationId = args.operationId ?? randomUUID();
  const emitResult = finish ?? ((r: OperationResult, body?: string, note?: string) => operationToolResult(r, body, note));
  // 【MC-041】结构化实参:按工作流 inputSchema **执行前**校验;不符即拒,不执行。
  let paramsNote = "";
  if (args.params !== undefined) {
    const doc = getWorkflow(args.workflow_id);
    if (!doc) {
      return emitResult(
        makeOp("REJECTED", method, operationId, {
          code: OP_CODE.methodNotFound,
          reason: `工作流 ${args.workflow_id} 不存在(先 app_api_call workflow.list 查 id)。`,
        }),
      );
    }
    const verdict = validateWorkflowParams(doc, args.params);
    if (!verdict.ok) {
      return emitResult(
        makeOp("REJECTED", method, operationId, { code: OP_CODE.rpcFailed, reason: `参数校验未通过(未执行):${verdict.error}` }),
      );
    }
    paramsNote = renderWorkflowParams(doc, verdict.normalized);
  }
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
        // 参数不足:**没有运行被起** → REJECTED(可改条件重来)。
        return emitResult(
          makeOp("REJECTED", method, operationId, {
            code: OP_CODE.rpcFailed,
            reason: `这条自动化有 ${triggers.length} 个触发器,请用 trigger_node_id 指定:\n${triggers.map((t) => `- ${t.nodeId}(${t.title})`).join("\n")}`,
          }),
        );
      }
      nodeId = triggers[0]!.nodeId;
    }
    const denied = await gateAppAction(ctx, "write", "workflow_run", args, `立即运行自动化 ${args.workflow_id}(触发器 ${nodeId})`);
    if (denied) {
      return emitResult(
        makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
      );
    }
    const runEntry = findEntry("automation.run");
    if (!runEntry) {
      return emitResult(
        makeOp("REJECTED", method, operationId, { code: OP_CODE.methodNotFound, reason: "当前版本没有 automation.run" }),
      );
    }
    let r: unknown;
    try {
      r = await callRpc(runEntry, { workflowId: args.workflow_id, triggerNodeId: nodeId });
    } catch (err) {
      // 起自动化是**有副作用**的动作(可能已经起了运行)→ 抛错不能当"失败可重试"。
      return emitResult(
        makeOp("UNCERTAIN", method, operationId, {
          code: OP_CODE.rpcUncertain,
          reason: `启动自动化途中出错,无法确认运行是否已经起:${errText(err)}`,
        }),
      );
    }
    const outcome = decodeDomainOutcome("automation.run", r);
    if (outcome.kind !== "accepted") {
      return emitResult(
        makeOp(resultKindOfOutcome(outcome), method, operationId, { code: outcome.code, reason: outcome.reason }),
      );
    }
    return emitResult(
      makeOp("SUCCEEDED", method, operationId),
      undefined,
      `已开始运行自动化 ${args.workflow_id}。运行记录用 app_api_call automation.runs 查。`,
    );
  }
  // 普通工作流:在对话里按它跑。
  // 【MC-041】结构化实参渲染进正文(paramsNote 由上面的校验路径生成);
  // 没有 prompt 但有 params 时,params 本身就当正文(派生工具调用不必再手写 prompt)。
  const prompt = [args.prompt?.trim(), paramsNote].filter(Boolean).join("\n\n");
  if (!prompt) {
    return emitResult(
      makeOp("REJECTED", method, operationId, {
        code: OP_CODE.rpcFailed,
        reason: "这个工作流没有触发器,要在对话里跑:请给 prompt(以及可选的 session_id / project_id),或给 params(按 inputSchema 的结构化实参)。",
      }),
    );
  }
  if (args.session_id === sessionId) {
    return emitResult(
      makeOp("REJECTED", method, operationId, {
        code: OP_CODE.rpcFailed,
        reason: "不能让你自己所在的对话去跑,换一个对话或不传 session_id 新开一个。",
      }),
    );
  }
  const denied = await gateAppAction(
    ctx,
    "write",
    "workflow_run",
    args,
    args.session_id ? `在对话 ${args.session_id} 里按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}` : `新开对话,按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}`,
  );
  if (denied) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
    );
  }
  const reply = args.session_id
    ? await ui({ op: "send", sessionId: args.session_id, prompt, workflowId: args.workflow_id, background: true })
    : await ui({ op: "new_session", projectId: args.project_id, prompt, workflowId: args.workflow_id, background: true });
  // 【MC-059 / ARC-001 步⑤】跑工作流也是**纯业务**动作(会话行 + 起一轮工作流运行本就在主进程),
  // 不该因为渲染窗口没开就失败。UI 桥报"窗口没开/界面没准备好/超时"时,改走主进程**同一份**
  // headless 路径(createOrReuseSession + sendTurn,带 workflowId),与 app_session_new/send 同源。
  // 其它业务错误(校验失败等)照原样回,不吞。
  if (uiUnavailable(reply)) {
    if (args.session_id) {
      // 发送路径:消息没发出去 = 没落任何东西 → REJECTED。
      const msg = await headlessSend(args.session_id, prompt, args.workflow_id);
      if (msg !== null) {
        return emitResult(
          makeOp("REJECTED", method, operationId, { code: OP_CODE.rpcFailed, reason: msg }),
        );
      }
      return emitResult(makeOp("SUCCEEDED", method, operationId), undefined, "已按工作流发出(无渲染窗口,走主进程)。");
    }
    // 新会话路径:headless 报错时**会话行可能已经落库**,只是第一条消息没起 → 无法确认 → UNCERTAIN。
    const msg = await headlessNewSession({ project_id: args.project_id, prompt, workflow_id: args.workflow_id }, sessionId);
    if (msg !== null) {
      return emitResult(
        makeOp("UNCERTAIN", method, operationId, { code: OP_CODE.rpcUncertain, reason: msg }),
      );
    }
    return emitResult(makeOp("SUCCEEDED", method, operationId), undefined, "已按工作流发出(无渲染窗口,走主进程)。");
  }
  if (!reply.ok) {
    // UI 桥回了一个**业务失败**:可能是"对话已建好…但第一条消息没发出去"这种**已落一半**,
    // 不能当"没执行"诱使 Agent 重开一个新对话 → UNCERTAIN。
    return emitResult(
      makeOp("UNCERTAIN", method, operationId, {
        code: OP_CODE.rpcUncertain,
        reason: `按工作流发出未成功,可能已在对话里落了一部分:${reply.error ?? "界面操作失败"}`,
      }),
    );
  }
  return emitResult(
    makeOp("SUCCEEDED", method, operationId),
    reply.data === undefined ? undefined : renderResult(reply.data),
    "已按工作流发出。",
  );
}

/* ─────────────── ARC-009:app_session_new / app_session_send 统一结果 ─────────────── */

type SessionNewArgs = {
  project_id?: string;
  prompt?: string;
  provider_id?: string;
  model?: string;
  workflow_id?: string;
  background?: boolean;
  title?: string;
  /** 【ARC-001 步③】乐观并发修订号(可选);见工具描述与 `ActionContext.expectedRevision`。 */
  expected_revision?: string;
  /** 【ARC-001 步④】计划授权句柄(可选 `grantId`);见工具描述与 `ActionContext.permissionGrant`。 */
  permission_grant?: string;
};
type SessionSendArgs = { session_id: string; prompt: string; workflow_id?: string; background?: boolean };

/**
 * 【ARC-009】`app_session_new` 按**业务是否落定**分派(与 `runWorkflow` 同源形状),不再
 * 用旧的两态 `uiResult` / `fail` —— 那会把「没执行」和「已落一半」糊成同一句失败:
 *   - 审批被拒 = **没执行** → REJECTED(可安全重来);
 *   - 渲染端 `new_session` 回业务失败 —— 渲染端那条 `new_session` 是**先建会话、再发首条**,
 *     任一步失败都可能**会话行已落库、只是首条没发出**(与 `appControlHost` 的
 *     `"对话已建好…但第一条消息没发出去"` 同一事实)→ **UNCERTAIN**。旧的两态会把它当
 *     "没建起来",诱导 Agent 重开一个新对话、留下一个**没人管的空会话**;
 *   - 无窗口 headless 回退:建会话(可能已落库)+ 发首条,`headlessNewSession` 报错时同样
 *     **会话可能已建好** → UNCERTAIN。
 */
async function runSessionNew(
  a: SessionNewArgs & { operationId?: string },
  sessionId: string,
  ctx: ProviderContext,
  /** 【MC-014】带幂等键时由账本守卫提供:每次返回都必须走它(它负责 settle)。 */
  finish?: (r: OperationResult, body?: string, note?: string) => ToolResult,
): Promise<ToolResult> {
  const method = "app_session_new";
  const operationId = a.operationId ?? randomUUID();
  // 【MC-014】带幂等键时所有返回都经 finish(它负责 settle;否则账本永远停在 CLAIMED)。
  const emitResult = finish ?? ((r: OperationResult, body?: string, note?: string) => operationToolResult(r, body, note));
  const what = a.prompt ? `新开对话并发送:${clipLine(a.prompt, 200)}` : "新开一个对话";
  const denied = await gateAppAction(ctx, "write", "session_new", a, what);
  if (denied) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
    );
  }
  // 【ARC-001 步③】走了乐观并发修订号 → **必须**经会真核对它的那条路(headless 经唯一业务
  // 命令 `createSessionAndSend`)。UI 桥那条渲染端 `new_session` **不认** `expected_revision`
  // 这个字段 —— 先走它等于把闸悄悄绕过去,那正是本切片要堵的口子。所以带修订号时**不**走 UI。
  if (a.expected_revision === undefined && a.permission_grant === undefined) {
    const reply = await ui({ op: "new_session", projectId: a.project_id, providerId: a.provider_id, model: a.model, prompt: a.prompt, workflowId: a.workflow_id, background: a.background, title: a.title });
    // 【MC-059】窗口没开 → 走主进程同一套服务,不因界面缺失而失败。
    if (uiUnavailable(reply)) return runSessionNewHeadless(a, sessionId, method, operationId);
    if (!reply.ok) {
      // UI 桥回了**业务失败**:会话可能**已经建好**,只是首条没发出(见函数头)→ UNCERTAIN。
      return emitResult(
        makeOp("UNCERTAIN", method, operationId, {
          code: OP_CODE.rpcUncertain,
          reason: `新开对话未成功,无法确认是否已经建好(可能留下一个空会话):${reply.error ?? "界面操作失败"}`,
        }),
      );
    }
    return emitResult(
      makeOp("SUCCEEDED", method, operationId),
      reply.data === undefined ? undefined : renderResult(reply.data),
      "已新建对话。",
    );
  }
  // 带了预期修订号 → 直接走 headless 核对路径。
  return runSessionNewHeadless(a, sessionId, method, operationId);
}

/**
 * `app_session_new` 的**无窗口 / 带修订号 / 带授权句柄**那条分支:经唯一业务命令 `createSessionAndSend`。
 *   - 修订号对不上 → `createSessionAndSend` 抛 `SessionRevisionConflictError`,**什么都没执行**
 *     → **REJECTED**(`revision_conflict`,可安全重来:重读状态再试),**绝不**像别的失败那样
 *     报 UNCERTAIN(那会诱导 Agent 以为"可能已建一半"而放弃重试);
 *   - 【ARC-001 步④】带了授权句柄却核不过(不存在 / 失效 / 不覆盖)→ 抛 `SessionGrantRefusedError`,
 *     **什么都没执行** → **REJECTED**(`grant_refused`,可安全重来:取一枚有效授权再来);
 *   - 其它失败 → 会话行**可能已经落库**(createOrReuseSession 已跑)、只是首条没起 → UNCERTAIN。
 */
async function runSessionNewHeadless(
  a: SessionNewArgs,
  sessionId: string,
  method: string,
  operationId: string,
): Promise<ToolResult> {
  let err: string | null;
  try {
    err = await headlessNewSession(a, sessionId);
  } catch (thrown) {
    // 修订号冲突:调用方断言的那一版空壳已不在/已变。没建、没发 → REJECTED(与
    // `REJECTED` 的默认语义一致:没执行,重读当前状态后再来即可,故不覆写 retryable)。
    const code = (thrown as { code?: unknown })?.code;
    if (code === "revision_conflict") {
      return operationToolResult(
        makeOp("REJECTED", method, operationId, {
          code: OP_CODE.revisionConflict,
          reason: errText(thrown),
        }),
      );
    }
    // 【ARC-001 步④】授权句柄核不过:授权被宿主从 `getGrantStore()` 取回后交 `evaluate` 判,
    // 不存在 / 失效 / 不覆盖这次动作 → 拒绝。**没建、没发** → REJECTED(可安全重来:取一枚
    // 有效授权再来)。绝不报 UNCERTAIN —— 会话行一行都没写。
    if (code === "grant_refused") {
      return operationToolResult(
        makeOp("REJECTED", method, operationId, {
          code: OP_CODE.grantRefused,
          reason: errText(thrown),
        }),
      );
    }
    throw thrown;
  }
  if (err !== null) {
    // headless 报错时**会话行可能已经落库**(createOrReuseSession 已跑)、只是首条没起 →
    // 无法确认 → UNCERTAIN(绝不报成"没执行"让 Agent 重开一个新对话)。
    return operationToolResult(
      makeOp("UNCERTAIN", method, operationId, { code: OP_CODE.rpcUncertain, reason: err }),
    );
  }
  return operationToolResult(makeOp("SUCCEEDED", method, operationId), undefined, "已新建对话(无界面模式)。");
}

/**
 * 【ARC-009】`app_session_send` 按**业务是否落定**分派(与 `runSessionNew` / `runWorkflow` 同源):
 *   - 给自己发 = **明确拒绝,没执行** → REJECTED;
 *   - 审批被拒 = **没执行** → REJECTED;
 *   - 渲染端 `send` 回业务失败 —— 渲染端那条 `send` **先切会话、发消息、再切回**,
 *     任一后续步骤抛错都可能在**消息已经发出之后** → 无法确认是否已发出 → **UNCERTAIN**
 *     (旧的两态会让 Agent 当成"没发出去"而**重发一条**,也就是把同一句话发两遍);
 *   - 无窗口 headless 回退:消息没发出去 = 没落任何东西 → REJECTED。
 */
async function runSessionSend(
  a: SessionSendArgs & { operationId?: string },
  sessionId: string,
  ctx: ProviderContext,
  finish?: (r: OperationResult, body?: string, note?: string) => ToolResult,
): Promise<ToolResult> {
  const method = "app_session_send";
  const operationId = a.operationId ?? randomUUID();
  const emitResult = finish ?? ((r: OperationResult, body?: string, note?: string) => operationToolResult(r, body, note));
  if (a.session_id === sessionId) {
    return emitResult(
      makeOp("REJECTED", method, operationId, {
        code: OP_CODE.rpcFailed,
        reason: "不能给你自己所在的对话发消息。",
      }),
    );
  }
  const denied = await gateAppAction(ctx, "write", "session_send", a, `给对话 ${a.session_id} 发送:${clipLine(a.prompt, 200)}`);
  if (denied) {
    return emitResult(
      makeOp("REJECTED", method, operationId, { code: OP_CODE.approvalDenied, reason: denied }),
    );
  }
  const reply = await ui({ op: "send", sessionId: a.session_id, prompt: a.prompt, workflowId: a.workflow_id, background: a.background });
  if (uiUnavailable(reply)) {
    // 无窗口路径:消息没发出去 = 没落任何东西 → REJECTED。
    const err = await headlessSend(a.session_id, a.prompt, a.workflow_id);
    if (err !== null) {
      return emitResult(
        makeOp("REJECTED", method, operationId, { code: OP_CODE.rpcFailed, reason: err }),
      );
    }
    return emitResult(makeOp("SUCCEEDED", method, operationId), undefined, "已发送(无界面模式)。");
  }
  if (!reply.ok) {
    // UI 桥回了**业务失败**:渲染端可能在**消息已发出之后**才出错(见函数头)→ UNCERTAIN。
    return emitResult(
      makeOp("UNCERTAIN", method, operationId, {
        code: OP_CODE.rpcUncertain,
        reason: `发送未确认成功,消息可能已经发出(界面在之后出错):${reply.error ?? "界面操作失败"}`,
      }),
    );
  }
  return emitResult(
    makeOp("SUCCEEDED", method, operationId),
    reply.data === undefined ? undefined : renderResult(reply.data),
    "已发送。",
  );
}

/* ─────────────────── ARC-009 / MC-067:结构化 OperationResult + 可信操作账本 ─────────────────── */

/**
 * 幂等不再靠"结束后按字符串缓存":改走 {@link getOperationLedger} 的**可信操作账本**
 * (意图绑定 + 原子领取 + 全态结算),见 `appControl/operations.ts` 的文件头。
 *
 * 为什么必须换掉旧 Map(源码可确认的旧行为):旧 `operationLog` 只按 `operationId` 字符串
 * 缓存已完成结果 —— 换会话 / 换方法 / 换参数复用同一 id 会命中旧结果;两个并发请求都能穿过
 * 缓存各执行一次;RPC 抛错(UNCERTAIN)没记入 Map,同 id 再试仍会真调一次。
 */
/** 测试 / 重置用 —— 每个用例前清一次,免得跨用例串味。 */
export function __clearOperationLog(): void {
  setOperationLedger(null);
}

/** 造一条 OperationResult,补上按 kind 推导的 `retryable`(已提交 / 不确定 → 不可重试)。 */
function makeOp(
  kind: OperationResult["resultKind"],
  method: string,
  operationId: string,
  extra: Partial<OperationResult> = {},
): OperationResult {
  return {
    resultKind: kind,
    operationId,
    method,
    retryable: kind === "REJECTED" || kind === "FAILED",
    warnings: [],
    resources: [],
    ...extra,
  };
}

/**
 * 【MC-014】**自带工具**(`app_session_new` / `app_session_send` / `app_workflow_run` /
 * `app_workflow_publish` / `app_workflow_unpublish`)的幂等守卫 —— 与 `app_api_call` 共用
 * **同一份** {@link getOperationLedger} 账本(意图绑定 + 原子领取 + 全态结算),不另造一套。
 *
 * 台账洞:从前幂等只挂在 `app_api_call` 这一条垂直切片上;三个自带工具在 Agent 重试时
 * **没有去重** —— `app_session_new` 重试可能建出两条会话、`app_session_send` 重试可能把
 * 同一句话发两遍(它们对 UI 桥失败已经归 UNCERTAIN 不诱导重试,但"重试本身"不去重)。
 *
 * 语义与 `app_api_call` 逐字对齐(同一份 `begin` 裁决):
 *   - `conflict`(同 id 不同意图)→ REJECTED `operation_id_conflict`,不回放旧成功;
 *   - `claim-not-durable` → REJECTED `claim_not_durable`,**不执行**;
 *   - `in-progress` → UNCERTAIN `operation_in_progress`,**不双执行**;
 *   - `replay` / `uncertain` → 回放旧结算(同 id 同意图,不再执行第二次);
 *   - `claimed` → 可执行;调用方**必须在每条返回前** {@link settle} —— 否则该 id 永远
 *     停在 CLAIMED,之后同 id 只能看到"在途"。为此把结算包成 `finish()` 一次返回。
 *
 * ⚠️ **只对带了 `operation_id` 的调用生效**:Agent 不传 = 每次都是一次新动作(与
 * `app_api_call` 一致),不让每个匿名调用都写一行账 + 一次整库 fsync。
 */
function withSelfToolIdempotency(
  method: string,
  args: Record<string, unknown>,
  sessionId: string,
  run: (operationId: string, finish: (r: OperationResult, body?: string, note?: string) => ToolResult) => Promise<ToolResult>,
): Promise<ToolResult> | null {
  const providedId =
    typeof args.operation_id === "string" && args.operation_id.trim() !== "" ? args.operation_id.trim() : undefined;
  if (!providedId) return null; // 无幂等键 → 走原路(operationId 由 run 自生成)
  const ledger = getOperationLedger();
  const intent: OperationIntent = {
    operationId: providedId,
    ownerId: sessionId,
    sessionId,
    sceneId: method,
    method,
    requestDigest: requestDigestOf(args),
    effectKind: sideEffectClassOf(method),
    grantRevision: "default",
  };
  const begin = ledger.begin(intent);
  if (begin.begin === "conflict") {
    return Promise.resolve(operationToolResult(makeOp("REJECTED", method, providedId, {
      code: OP_CODE.operationIdConflict,
      retryable: false,
      reason: `operation_id「${providedId}」之前被用在另一个不同的操作(方法/参数/会话不同)。复用同一个幂等键到别的操作上会被拒;换一个 operation_id。`,
    })));
  }
  if (begin.begin === "claim-not-durable") {
    return Promise.resolve(operationToolResult(makeOp("REJECTED", method, providedId, {
      code: OP_CODE.claimNotDurable,
      reason: "这次操作的幂等领取无法同步落盘(磁盘写入失败),为避免重启后重复执行,本次**没有执行**。请确认磁盘可写后再重试。",
    })));
  }
  if (begin.begin === "in-progress") {
    return Promise.resolve(operationToolResult(makeOp("UNCERTAIN", method, providedId, {
      code: OP_CODE.operationInProgress,
      reason: "同一 operationId 的这次操作正在执行中,本次没有重复执行;等它结束后再回来看结果。",
    })));
  }
  if (begin.begin === "replay" || begin.begin === "uncertain") {
    const replayed = begin.record.result;
    if (replayed) {
      return Promise.resolve(operationToolResult(replayed, begin.record.body, "(重放:同一 operationId 的同一操作之前已结算,本次**未重复执行**)"));
    }
    return Promise.resolve(operationToolResult(makeOp("UNCERTAIN", method, providedId, {
      code: OP_CODE.rpcUncertain,
      reason: "同幂等键的操作之前已登记但没有可回放的结果,无法确认;不要盲目重试。",
    })));
  }
  return run(providedId, (r, body, note) => {
    ledger.settle(providedId, { status: r.resultKind, result: r, ...(body !== undefined ? { body } : {}) });
    return operationToolResult(r, body, note);
  }).then(
    (r) => r,
    (err: unknown) => {
      // 【MC-014】抛错路径**也必须结算** —— 否则这条 id 永远停在 CLAIMED,之后同 id
      // 只能看到"在途",既不能重试也拿不到可读的失败(实测:发布路径 getDb 未就绪时
      // 就是这样卡死的)。分类用共享的 thrownResultKind(写档抛错可能已部分提交 →
      // UNCERTAIN,只读档 → FAILED),与 app_api_call 的抛错分类同一份判据。
      const kind = thrownResultKind(err, policyFor(method).level);
      const op = makeOp(kind, method, providedId, { code: OP_CODE.rpcFailed, reason: errText(err) });
      ledger.settle(providedId, { status: kind, result: op });
      return operationToolResult(op);
    },
  );
}

/**
 * 把结构化结果落成 ToolResult:
 *   - **成功系列**(SUCCEEDED / SUCCEEDED_WITH_WARNINGS)带 `isError=false`(不设);
 *   - 其余三态带 `isError=true`(与旧断言一致 —— 拒绝 / 失败仍是"错误返回")。
 * `structuredContent.operation_result` 与正文是同一件事实的两种投影。
 */
function operationToolResult(r: OperationResult, body?: string, note?: string): ToolResult {
  const committed = isOperationCommitted(r.resultKind);
  const lines = [formatOperationResult(r), note, body].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const out: ToolResult = {
    content: [{ type: "text", text: lines.join("\n\n") || "完成(无返回值)" }],
    structuredContent: { operation_result: r },
  };
  if (!committed) out.isError = true;
  return out;
}

/**
 * 历史结果回放的**授权复核**(MC-067 改造要点 4):同 id 的同一操作已结算、要回放旧结果
 * 之前,先按**当前**授权状态再看一眼 —— 方法收成 blocked、密钥设置键被拦、或只读/计划
 * 模式收紧了有副作用操作,就不复述原结果(返回一句拒绝原因)。
 *
 * 幂等**不是权限豁免**:授权撤销后,过去成功的那次不该再被复述给 Agent。
 */
function replayRevokedReason(
  entry: ApiEntry,
  ctx: ProviderContext,
  effectKind: "readonly" | "mutating",
): string | null {
  if (entry.policy.level === "blocked") {
    return `这个功能不开放给 agent:${entry.policy.reason ?? "安全原因"}(历史结果也不复述)。`;
  }
  const mode = ctx.getPermissionMode?.();
  if (effectKind === "mutating" && mode && READONLY_MODES.has(mode)) {
    return "当前是只读/计划模式,不再复述这个有副作用操作的历史结果。";
  }
  return null;
}

/**
 * 【ARC-004 步③ 之二】把 `app_api_call` 的 `ActionIntent.core` 从**请求指纹**升级为**宿主
 * 解析出的真实资源身份**。
 *
 * ## 它补的是哪条洞(源码可确认)
 *
 * 上一片把 `evaluate` 接进执行点,但 `core` 用的是**请求指纹**(`appApiBindingId` = 会话 +
 * 方法 + 参数摘要)承载「资源身份」。指纹对**时间/会话/字面参数**敏感,对**资源本身**无感:
 * 「批准写项目 A、却来写项目 B」在指纹模型下只是「另一份参数」,而 `findBoundFor` 按资源身份
 * 精确匹配时**根本匹配不到**(指纹不同),于是直接落到「无授权 → 走默认审批链」—— `evaluate`
 * 里那条 `invalidationsFor` 分支(核心意图变更 → 批准失效)**永远不可达**。
 *
 * 本函数让执行点从**调用的入参**里解析出真实的**权威资源身份**(路径经 `physicalPath`
 * 规范化:resolve + 折叠大小写,与 `pathGuard` 同一套判据),填进 `intent.core` 对应的**语义
 * 维度**。于是「批准 A、调 B」→ `core` 里那是**不同的路径** → `evaluate` 判 `projectPath` 变了
 * → `require-approval` → 不执行。这正是本切片要钉的行为。
 *
 * ## 覆盖哪些方法(只覆盖语义确实对得上的;其余如实兜底)
 *
 *   - **file.*** —— 目标路径的规范化身份。`file.writeFile`/`readFile`/`readBinary` 取
 *     `filePath`,`mkdir` 取 `dirPath`,`rename` 取 `oldPath`,`copy` 取 `srcPath`,
 *     `listDir`/`search`/`grep` 取 `projectPath`(后三者的 `projectPath` **本就是根**,语义与
 *     `CoreIntent.projectPath` 完全一致;前几者把**目标文件路径**放进同一个**路径类**维度 ——
 *     CoreIntent 没有更细的「file」槽,而判据要的是「换了路径 = 批准失效」)。
 *   - **git.*** —— `repoPath` 的规范化身份 → `projectPath`(`gitRemote` 需 `git remote get-url`
 *     才能得到,本层拿不到,**故不用它**,如实向下兜底)。
 *   - **terminal.create** —— `projectPath` 的规范化身份 → `projectPath`。
 *
 * **明确不覆盖(保持请求指纹兜底,并如实注释原因):**
 *   - `mcp.*` —— 全是 **danger** 档,`planGrantPrecheck` 对 danger **根本不跑**(见
 *     `invokeAppTool`:`entry.policy.level !== "danger"` 才预判),故在此解析 `mcp` 身份是
 *     **死代码**,不做。
 *   - `project.*` —— `project.delete`/`archive`/`pin`/`rename` 等收的是**项目 id**(非路径),
 *     `CoreIntent` 没有「id」维度;`create` 收 `path` 但属新建(无「已被批准的同资源」语义)。
 *     一律兜底。
 *   - `library.*` —— 收的是**条目 id**(宿主内部标识),非路径;`sshHostKey` / `deleteScope`
 *     在本层(`app_api_call`)没有携带权威身份的入参(SSH 走 danger 的 `agentSsh.*`;删除的
 *     「是否递归」由宿主在 trash 里定,不在入参)。一律兜底。
 *
 * @returns `core` 填好的核心意图;`real` = 这次是否用了**真实资源身份**(true 时执行点才允许
 *   退到「按动作取授权」`findGoverningFor` —— 见 `planGrantPrecheck`;指纹兜底时绝不退,否则会把
 *   「另一件事」误当「越权」硬拒)。
 */
const FILE_PATH_ARG: Record<string, string> = {
  "file.writeFile": "filePath",
  "file.readFile": "filePath",
  "file.readBinary": "filePath",
  "file.mkdir": "dirPath",
  "file.rename": "oldPath",
  "file.copy": "srcPath",
  "file.listDir": "projectPath",
  "file.search": "projectPath",
  "file.grep": "projectPath",
};

export function resolveActionCore(
  method: string,
  input: unknown,
  sessionId: string,
): { core: CoreIntent; real: boolean } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pathIdentity = (raw: unknown): string | null => {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return physicalPath(raw); // resolve + 跟真实目的地 + 折叠大小写;拿不到返回 null
  };
  // ① file.*:目标路径的规范化身份。
  const fileArg = FILE_PATH_ARG[method];
  if (fileArg) {
    const id = pathIdentity(o[fileArg]);
    if (id) return { core: { projectPath: id }, real: true };
  }
  // ② git.*:repoPath 的规范化身份(本层拿不到 gitRemote,不用它)。
  if (method.startsWith("git.")) {
    const id = pathIdentity(o.repoPath);
    if (id) return { core: { projectPath: id }, real: true };
  }
  // ③ terminal.create:projectPath 的规范化身份。
  if (method === "terminal.create") {
    const id = pathIdentity(o.projectPath);
    if (id) return { core: { projectPath: id }, real: true };
  }
  // ④ 兜底:请求指纹承载「资源身份」(换会话 / 换方法 / 换参数 = 换了一件事 = 该绑另一枚授权)。
  return { core: { sshHostKey: appApiBindingId(sessionId, method, input) }, real: false };
}

/**
 * 【ARC-004 步③】`app_api_call` **执行动作之前**的计划级授权预判 —— 把唯一判定核
 * `policyEngine.evaluate` 接到真实执行点上。
 *
 * ## 它补的是哪条洞(源码可确认)
 *
 * 步①②④ 交付了判定核 `evaluate`、持有核 `GrantStore`、启动装配 `getGrantStore()`,但
 * **没有任何执行点调用过 `evaluate`** —— 判定核是**只声明不兑现**的死代码。本函数是第一个
 * 生产调用点:动作真正跑之前,先看它有没有落在一份受限授权里。
 *
 * ## 为什么用 `findBoundFor` 而不是 `findFor`(本步最关键的取舍)
 *
 * `findFor` 只回**仍有效**的授权 —— 撤销 / 过期 / 非用户签发的会被它**藏成 `null`**。若这里写
 * `evaluate(intent, store.findFor(intent, now), ctx)`,`evaluate` 的三条 deny 分支(撤销 / 过期 /
 * 来源非用户)**永远不可达**:要么拿到有效授权放行、要么拿 null 去「重新批准」—— 硬拒绝成了
 * 死代码,**变异也变不红**。故这里用 `findBoundFor`:它把**治理该动作的那枚原始授权(含失效态)**
 * 交出来,`evaluate` 才真去判它死活。
 *
 * ## 判定守卫(为什么不是「一律拒」)
 *
 * 真实执行点**已经**有 `gateAppAction` 在管每一次调用的审批。本预判**只在真的存在一枚绑定授权
 * 时**才施加:**有绑定授权 → 必须 `evaluate` 判 `allow` 才继续**;任何非 `allow` 都不执行、如实报
 * 拒绝原因。理由是:一枚绑定授权意味着「这个动作本就是要在它之下跑的」,它说 `deny`(撤销 / 过期 /
 * 非用户签发)或 `require-approval`(超次数 / 超预算 / 核心意图被换)都是「在这个计划下**不准**」。
 * 而**没有**绑定授权时(`findBoundFor` 为 null)→ 一律放行给 `gateAppAction`:app_api_call 的默认
 * 路径就是「无 grant、按方法分级 + 每次审批」,不能因为「没授权」把整套功能全拒了。
 *
 * ## 三种结果怎么落(与 evaluate 的 verdict 一一对应)
 *
 *   - `bound === null`(没有授权管这个动作)→ `null`,放行给 `gateAppAction` 既有审批链;
 *   - `bound !== null` 且 `allow`(在有效授权内)→ `{ kind: "authorized" }` —— 这枚用户签发的
 *     有效授权**就是**这次的授权,执行点据此**不再弹审批卡**(ARC-004 的「计划级授权覆盖整个
 *     计划、不再逐次弹卡」);随后**派发前原子领取一次额度**(`claimGrantUseForDispatch`),
 *     按结构化结果结算(MC-021);
 *   - `bound !== null` 且 `deny` / `require-approval`(撤销 / 过期 / 非用户 / 超次数 / 超预算 / 核心
 *     意图被换)→ `{ kind: "deny" }`,**不执行**。这样 `evaluate` 的每一条非 allow 分支(含最容易
 *     成死代码的三条 deny)都真的承重、可被变异测红。
 *
 * ## 只有 write 档会拿到 `{ kind: "authorized" }`
 *
 * 调用点对 `danger` 档**根本不跑**本预判(见 `invokeAppTool`:`entry.policy.level !== "danger"`
 * 才预判),`read` / `ui` 档在 `gateAppAction` 里从不弹卡 —— 故「凭授权跳卡」实际只作用于 write。
 *
 * @returns `null` = 无绑定授权(走默认审批链);`{ kind: "authorized" }` = 有效用户授权覆盖,
 *   可**跳过审批卡**直接执行;`{ kind: "deny", reason }` = 在这个计划下**不准**,不执行。
 */
export function planGrantPrecheck(
  entry: ApiEntry,
  args: unknown,
  sessionId: string,
): { kind: "deny"; reason: string } | { kind: "authorized" } | null {
  const store = getGrantStore();
  const input = (args as { input?: unknown }).input ?? null;
  const { core, real } = resolveActionCore(entry.method, input, sessionId);
  const intent: ActionIntent = { method: entry.method, core };
  const now = Date.now();
  // ── 取「绑定的那枚授权」:真实资源身份 vs 请求指纹,两条**不同**的取回口 ──────────
  //
  // 【真资源身份】先按「资源身份 + 动作」精确找(命中 = 这正是那枚授权管的事);**找不到
  // 再按动作**取回管这个动作的授权(`findGoverningFor`,**不看**资源)—— 交给 `evaluate`
  // 用 `invalidationsFor` 判「核心意图被换」。这是本切片要钉的行为:**批准了项目 A、却来写
  // 项目 B** → `findBoundFor` 按资源 A 匹配不到,`findGoverningFor` 交出那枚授权,`evaluate`
  // 判 `projectPath` 变了 → `require-approval` → 不执行。
  //
  // 【请求指纹兜底】尚无宿主解析出的资源身份的方法(如 `session.rename`):核心意图**就是**
  // 请求本身,换参数 = 换了一件事 = 不绑这枚授权 = 走默认审批链 —— 故用 `findBoundFor`
  // 精确匹配,绝不退到 `findGoverningFor`(否则「另一件事」会被误判成「越权」而硬拒)。
  const bound = real
    ? (store.findBoundFor(intent, now) ?? store.findGoverningFor(intent, now))
    : store.findBoundFor(intent, now);
  // 没有绑定授权 → 不是授权下的动作,`null` = 放行给 gateAppAction 的既有审批链(默认路径)。
  if (!bound) return null;
  const decision = evaluate(intent, bound, {
    now,
    requester: { kind: "agent", id: sessionId },
    approver: { kind: "user", id: "app_api_call" },
    compatibilityLevel: entry.policy.level as PolicyCompatibilityLevel,
  });
  // 有效用户授权覆盖这次动作 → **凭授权跳过审批卡**(计划级授权的目的:不再逐次弹卡)。
  if (decision.verdict === "allow") return { kind: "authorized" };
  // 有绑定授权、但它说 deny / require-approval → 在这个计划下**不准**,不执行。
  return { kind: "deny", reason: `${decision.reason}(绑定授权 ${bound.grantId}:方法 ${entry.method})` };
}

/**
 * 【MC-021】两条**本地**的授权结算 warning 短码 —— 只由 `app_api_call` 的领取 / 结算路径
 * 产出,故不放进 `@contracts/appControl` 的 `OP_WARNING_*`(那组是跨端共享的稳定码);
 * 消费者若需分流,按字符串匹配即可(与 `OP_WARNING_UI_REFRESH_FAILED` 同一形状)。
 */
const OP_WARNING_GRANT_USE_RETAINED = "grant_use_retained";
const OP_WARNING_GRANT_REFUND_FAILED = "grant_refund_failed";

/**
 * 【MC-021】**派发前原子领取**一枚绑定授权的额度 —— 「先检查后记账」改成「领取 → 派发 → 结算」
 * 的第一半。
 *
 * ## 它补的是哪条洞(源码可确认)
 *
 * 旧时序(连同其记账函数 `recordPlanGrantUse` 一并删除):`planGrantPrecheck` 用 `evaluate`
 * **检查**额度通过 → gate → `await callRpc` 派发 → **之后**才 `recordUse` 记一次。两个缺口都在
 * 这个时序里:
 *   ① `maxCount: 1` 的授权两条**并发**操作在**任何** recordUse 之前都通过了检查 → 各执行
 *      一次副作用(额度被并发穿透);`await` 横在检查与记账之间是根因;
 *   ② 记账在 `resolveOperationOutcome`(业务结果解码)**之前**跑 —— `callRpc` 合法返回
 *      `{ok:false}`(业务**明确拒绝**、没执行)也被计为已用。
 *
 * ## 新时序(本函数 = 第一步)
 *
 *   ① 预判(`planGrantPrecheck`)仍先跑 —— 撤销 / 过期 / 非用户 / 核心意图被换等**硬拒**
 *      由它在弹卡之前拦下(那是判定,不是计账);
 *   ② **派发之前**(还在同步路径上、`await` 之前)调本函数:`claimUse` 在**同一个同步临界区**
 *      里检查(有效 / 未用尽 / 未超预算)并 `usedCount` +1、走 `commit` 同步落盘 —— 第二个并发
 *      调用在这一步就看到已用尽、拿不到授权(而不是"都通过检查各自执行");
 *   ③ 派发后按**结构化结果**(`resolveOperationOutcome` / `decodeDomainOutcome` / 抛错分类)
 *      结算:确定成功 → 保留;**确定拒绝(没执行)→ 退还**({@link releaseGrantUseForSettlement});
 *      UNCERTAIN → 保留(宁可多记不可少记,并在结果文本里说明)。
 *
 * ## 领取失败 = 不执行,如实报拒绝
 *
 * `claimUse` 抛(已用尽 / 失效 / 落盘失败)→ 返回一句拒绝原因,调用方**连 gate 都不进**、
 * 不执行,按 `policy_denied` 落账。这与"预判拒绝"同一条纪律:拿不到额度就别跑。
 *
 * @returns `null` = 没绑定授权(不是授权下的动作,无需领取,照走默认审批链);
 *   `{ claimed }` = 领取成功(带回 grantId 供结算退还);`{ denied }` = 有绑定授权但领取失败,
 *   必须不执行。
 */
function claimGrantUseForDispatch(
  entry: ApiEntry,
  args: unknown,
  sessionId: string,
): { claimed: { grantId: string } } | { denied: string } | null {
  const store = getGrantStore();
  const input = (args as { input?: unknown }).input ?? null;
  const { core, real } = resolveActionCore(entry.method, input, sessionId);
  const intent: ActionIntent = { method: entry.method, core };
  const bound = real
    ? (store.findBoundFor(intent, Date.now()) ?? store.findGoverningFor(intent, Date.now()))
    : store.findBoundFor(intent, Date.now());
  if (!bound) return null;
  try {
    store.claimUse(bound.grantId, 0, Date.now());
  } catch (err) {
    return {
      denied: `授权额度领取失败:${err instanceof Error ? err.message : String(err)}(授权 ${bound.grantId}:方法 ${entry.method})`,
    };
  }
  return { claimed: { grantId: bound.grantId } };
}

/**
 * 【MC-021】**按结构化结果结算**领取过的那笔额度 —— 第二半。
 *
 * 判据:
 *   - **没有领取过**(本次不在授权之下)→ 不结算,返回 null;
 *   - 结果确定为 **REJECTED**(业务明确拒绝 / 命令没执行)→ **退还**(`releaseUse`,回滚
 *     `usedCount`/`budgetUsed`)—— 没执行就不占额度,额度还能再用;
 *   - 其余(SUCCEEDED / SUCCEEDED_WITH_WARNINGS / FAILED / UNCERTAIN / 任何抛错路径)→ **保留**
 *     —— 尤其 UNCERTAIN(可能已部分执行):**宁可多记不可少记**,由调用方在结果文本里说明;
 *   - 退还是账本修正,失败(落盘失败)不翻案已落定的执行结果,只返回一句说明由调用方挂到
 *     warning / reason 上 —— 但那会留下「领取在、退还在」的偏差(计数偏多),必须显式报告
 *     (硬规矩 3,不静默)。
 */
function releaseGrantUseForSettlement(
  claimed: { grantId: string } | null,
  resultKind: OperationResult["resultKind"],
): string | null {
  if (!claimed || resultKind !== "REJECTED") return null;
  try {
    getGrantStore().releaseUse(claimed.grantId);
    return null;
  } catch (err) {
    return `授权额度退还失败(${err instanceof Error ? err.message : String(err)});这次没执行的调用仍占用了 1 次授权额度。`;
  }
}

/**
 * `app_api_call` 的**授权绑定身份** —— 会话 + 方法 + 规范化参数摘要。同一件事(同会话 / 同
 * 方法 / 同参数)恒得同一 id;换其一即换身份(该绑另一枚授权)。用 `|` 分隔,避免摘要嵌 NUL
 * 在展示里看不见。
 *
 * **导出是为了让断言与生产共用同一份身份格式**(硬规矩 2:共享实现只有一份)—— 测试据此
 * 造出与该动作真正绑定的那枚授权,不另抄一份格式字符串。
 */
export function appApiBindingId(sessionId: string, method: string, input: unknown): string {
  return `app_api_call|${sessionId}|${method}|${requestDigestOf(input)}`;
}

/**
 * 唯一入口。引擎侧(Claude 进程内 MCP / Codex 动态工具 / Pi 扩展)都调它。
 */
/** Host-only injected extension check; not part of the model/tool argument schema. */
type TrustedExtensionCall = {
  authorize(method: string): Promise<void>;
  acceptResult(result: unknown): void;
};
export async function invokeAppTool(
  name: string, rawArgs: unknown, sessionId: string, ctx: ProviderContext,
  trustedExtension?: TrustedExtensionCall,
): Promise<ToolResult> {
  const spec = appMcpTools().find((t) => t.name === name);
  if (!spec) return fail(`未知的 Mcode 控制工具:${name}`);
  try {
    const args = z.object(spec.inputSchema).parse(rawArgs ?? {}) as Record<string, unknown>;
    switch (name) {
      case "app_api_call": {
        const method = String(args.method ?? "");
        // 幂等键:Agent 可带 `operation_id` 重试同一件事;不带就本次生成一个。
        const providedId =
          typeof args.operation_id === "string" && args.operation_id.trim() !== ""
            ? args.operation_id.trim()
            : undefined;
        const operationId = providedId ?? randomUUID();

        // 模型自选的幂等键要有长度上限(限制键字节长度,别让一次调用塞进一个巨型字符串)。
        if (providedId && !operationIdWithinLimit(providedId)) {
          return operationToolResult(
            makeOp("REJECTED", method, operationId, {
              code: OP_CODE.operationIdTooLong,
              reason: `operation_id 太长(超过 ${OPERATION_ID_MAX_BYTES} 字节)。换一个短一点的幂等键。`,
            }),
          );
        }

        const entry = findEntry(method);
        if (!entry) {
          // 没有这个方法 → 命令**根本没执行** → REJECTED(可安全重试/改名重来)。没有副作用,
          // 不占账本(幂等键留给真正会执行的操作)。
          return operationToolResult(
            makeOp("REJECTED", method, operationId, {
              code: OP_CODE.methodNotFound,
              reason: unknownMethodHint(method),
            }),
          );
        }
        if (!entry.registered) {
          return operationToolResult(
            makeOp("REJECTED", entry.method, operationId, {
              code: OP_CODE.notRegistered,
              reason: `这个方法在当前版本里没有注册(${entry.channel})。`,
            }),
          );
        }

        if (trustedExtension) await trustedExtension.authorize(entry.method);

        // ── 可信操作账本(MC-067):先原子领取,再执行副作用 ────────────────
        // 幂等去重只对**模型自选的幂等键**有意义(不带 operation_id 时每次都是随机唯一 id,
        // 不存在撞 id 去重的诉求)。所以只在带了 operation_id 时才动用账本 —— 既不漏掉
        // "同 id 复用/并发/UNCERTAIN 重试"三种危险场景,也不让每次匿名调用都写一行账。
        // 意图身份(owner/session/method/摘要)由**宿主**产生,模型只能自选 operationId。
        // 同 id 换会话 / 换方法 / 换参数 = 变了意图 → CONFLICT,绝不回放旧成功;同意图并发
        // → 只执行一次;上一进程领了没结算 → 在途,绝不双执行。
        const ledger = providedId ? getOperationLedger() : null;
        const intent: OperationIntent = {
          operationId,
          ownerId: sessionId,
          sessionId,
          sceneId: "app_api_call",
          method: entry.method,
          requestDigest: requestDigestOf(args.input ?? null),
          effectKind: sideEffectClassOf(entry.method),
          grantRevision: ctx.getPermissionMode?.() ?? "default",
        };
        const settle = (status: OperationResult["resultKind"], op: OperationResult, body?: string): void => {
          ledger?.settle(operationId, { status, result: op, ...(body !== undefined ? { body } : {}) });
        };
        if (ledger) {
          const begin = ledger.begin(intent);
          if (begin.begin === "conflict") {
            // 同 id 被复用在不同意图上(换会话/方法/参数)—— **绝不回放旧成功**。
            return operationToolResult(
              makeOp("REJECTED", entry.method, operationId, {
                code: OP_CODE.operationIdConflict,
                retryable: false,
                reason:
                  `operation_id「${operationId}」之前被用在另一个不同的操作(方法/参数/会话不同)。` +
                  "复用同一个幂等键到别的操作上会被拒;换一个 operation_id。",
              }),
            );
          }
          if (begin.begin === "claim-not-durable") {
            // 领取成功但**没能同步落盘**(磁盘只读 / fsync 失败)。**绝不执行副作用** ——
            // 否则崩溃重启后同一 id 会再次领取并重复执行外部动作(MC-084)。这里返回
            // REJECTED(命令**一次都没执行**:副作用严格在 `claimed` 之后才发生,而这次
            // 领取已被回滚),可安全重试;给一个**区别于普通拒绝**的稳定短码 claim_not_durable,
            // 让 Agent 知道是磁盘可写性问题、稍后重试即可。
            return operationToolResult(
              makeOp("REJECTED", entry.method, operationId, {
                code: OP_CODE.claimNotDurable,
                reason: "这次操作的幂等领取无法同步落盘(磁盘写入失败),为避免重启后重复执行,本次**没有执行**。请确认磁盘可写后再重试。",
              }),
            );
          }
          if (begin.begin === "in-progress") {
            // 同意图同 id 正在执行中 —— 绝不双执行。
            return operationToolResult(
              makeOp("UNCERTAIN", entry.method, operationId, {
                code: OP_CODE.operationInProgress,
                reason: "同一 operationId 的这次操作正在执行中,本次没有重复执行;等它结束后再回来看结果。",
              }),
            );
          }
          if (begin.begin === "replay" || begin.begin === "uncertain") {
            // 同意图(同主体 + 同方法 + 同参数)已完成结算 → 回放,**不再执行**。
            // 历史回放**也要校验授权**:方法若已 blocked / 只读模式收紧了 mutating 操作,
            // 就不复述原结果。
            const revoked = replayRevokedReason(entry, ctx, intent.effectKind);
            if (revoked) {
              return operationToolResult(
                makeOp("REJECTED", entry.method, operationId, { code: OP_CODE.policyDenied, reason: revoked }),
              );
            }
            const replayed = begin.record.result;
            if (replayed) {
              return operationToolResult(
                replayed,
                begin.record.body,
                "(重放:同一 operationId 的同一操作之前已结算,本次**未重复执行**)",
              );
            }
            // 账本里有行却没有结果(理论不该发生):保守当 UNCERTAIN,绝不重跑。
            return operationToolResult(
              makeOp("UNCERTAIN", entry.method, operationId, {
                code: OP_CODE.rpcUncertain,
                reason: "同幂等键的操作之前已登记但没有可回放的结果,无法确认;不要盲目重试。",
              }),
            );
          }
        }

        // ── 【ARC-004 步③/④】计划级授权预判:动作执行**之前**,先按绑定的受限授权判死活 ──
        // 提在 `gateAppAction` **之前**:一枚被撤销 / 过期 / 非用户的绑定授权 = 这个计划已明说
        // 「不准」,连审批都不该弹(硬拒绝,不问用户);而一枚**有效、用户签发**的绑定授权 =
        // 这次动作**已被覆盖** → **跳过审批卡**直接执行(这就是「计划级授权不再逐次弹卡」)。
        // ⚠️ **danger 除外** —— 高风险动作本来就「每次都要用户本人批、受限授权不能替代」
        // (见 policyEngine 的 danger 分支),故仍走既有审批卡,不被这里的计划预判改道。
        let grantAuthorized = false;
        if (entry.policy.level !== "danger") {
          const pre = planGrantPrecheck(entry, args, sessionId);
          if (pre?.kind === "deny") {
            const op = makeOp("REJECTED", entry.method, operationId, {
              code: OP_CODE.policyDenied,
              reason: pre.reason,
            });
            settle(op.resultKind, op);
            return operationToolResult(op);
          }
          grantAuthorized = pre?.kind === "authorized";
        }

        // 领到了(或没带幂等键)→ 现在执行。此后**每一条 return 前都要 settle**(仅在带键时),
        // 否则这条 id 会永远停在 CLAIMED,同 id 之后永远只能看到"在途"。
        //
        // ★ 有**有效用户授权**时(`grantAuthorized`)不再弹审批卡 —— 授权本就是"这次不用再问"。
        // 否则走 `gateAppAction`;它只会在**用户本人新鲜点头**那一刻回调
        // `signPlanGrantForUserApproval`,把这次批准的来源与作用域铸成 grant(ARC-004 签发端)。
        // 完全访问的系统默认放行 / 已记的「始终允许」**不**触发签发 —— agent / system 不能给自己发授权。
        const denied = trustedExtension || grantAuthorized
          ? null
          : await gateAppAction(
              ctx,
              entry.policy.level,
              entry.method,
              args.input,
              `${entry.method}${entry.policy.reason ? `:${entry.policy.reason}` : entry.doc ? `:${clipLine(entry.doc, 160)}` : ""}${entry.method === "modules.install" ? extensionInstallApprovalSummary(args.input) : ""}`,
              entry.policy.reason,
              () => signPlanGrantForUserApproval(entry, args, sessionId),
            );
        if (denied) {
          // 审批被拒 / 只读模式 / 不开放 / 无审批通道 → 命令**没执行** → REJECTED。
          const op = makeOp("REJECTED", entry.method, operationId, {
            code: entry.policy.level === "blocked" ? OP_CODE.blocked : OP_CODE.approvalDenied,
            reason: denied,
          });
          settle(op.resultKind, op);
          return operationToolResult(op);
        }
        // 密钥设置键:在**调用之前**拦(见 isSecretSettingKey —— 结果打码拦不住它)。
        const secretRefusal = secretSettingRefusal(entry.method, args.input);
        if (secretRefusal) {
          const op = makeOp("REJECTED", entry.method, operationId, {
            code: OP_CODE.secretKeyRefused,
            reason: secretRefusal,
          });
          settle(op.resultKind, op);
          return operationToolResult(op);
        }

        // ── 【MC-021】派发前**原子领取**授权额度(领取 → 派发 → 结算)──────────────────
        // 从此处到 `callRpc` 之间**不得出现 `await`** —— `claimUse` 的「检查 + 递增 + 落盘」
        // 必须在同一同步临界区内完成:两个并发调用因此不可能都通过检查、再各自执行(旧的
        // 「先检查后记账」把 `await callRpc` 横在检查与记账之间,`maxCount=1` 的授权被并发
        // 穿透)。领取失败(已用尽 / 失效 / 落盘失败)→ **连执行都不执行**,如实报 policy_denied。
        let claimedGrant: { grantId: string } | null = null;
        if (entry.policy.level !== "danger") {
          const claim = claimGrantUseForDispatch(entry, args, sessionId);
          if (claim && "denied" in claim) {
            const op = makeOp("REJECTED", entry.method, operationId, {
              code: OP_CODE.policyDenied,
              reason: claim.denied,
            });
            settle(op.resultKind, op);
            return operationToolResult(op);
          }
          claimedGrant = claim?.claimed ?? null;
        }
        // 结算口(在**每一条**派发之后的 return 前调):确定没执行(REJECTED)→ 退还额度;
        // UNCERTAIN(可能已部分执行)→ 保留并在结果里说明;其余(成功系列 / FAILED)→ 保留。
        // 退还是账本修正,失败本身不翻案已落定的执行结果,只把偏差写进结果文本 / warning。
        const settleGrant = (op: OperationResult): void => {
          const refundNote = releaseGrantUseForSettlement(claimedGrant, op.resultKind);
          if (claimedGrant && op.resultKind === "UNCERTAIN") {
            op.warnings.push({
              code: OP_WARNING_GRANT_USE_RETAINED,
              message: "本次执行结果不确定(可能已部分执行),授权额度按「已使用」保留,不退还(宁可多记不可少记)。",
              retryable: false,
            });
          }
          if (refundNote) {
            op.reason = op.reason ? `${op.reason}(${refundNote})` : refundNote;
            op.warnings.push({ code: OP_WARNING_GRANT_REFUND_FAILED, message: refundNote, retryable: false });
          }
        };

        // ── 真正执行 RPC(到这里一定被调一次)──────────────────────────────
        let result: unknown;
        try {
          if (trustedExtension) await trustedExtension.authorize(entry.method);
          // 【MC-092】记忆这类**按项目隔离**的方法,agent 走通用 `app_api_call` 时也要绑上
          // 宿主铸的会话项目身份 —— 否则模型能带 `projects/<别的项目>/…` 读写任意项目记忆,
          // 或 `list` 出全部(专用记忆工具本来就有这道隔离,通用路从前没有)。作用域只包
          // 这一次 `callRpc`,桌面渲染端走真实 IPC(不经这里)不受影响,保留全局管理权限。
          //
          // 【MC-095】扩展数据区同理:`extensionStore.*` 收请求者自填的 `extensionId`,通用
          // 路从前不绑调用主体 —— 模型能填别人的扩展 id 读写其键值/文件。这里包一层**没有
          // 扩展身份**的作用域(同一个 `agentScope` 机制,`runWithUnboundAgentExtensionScope`),
          // handler 见「有作用域但身份对不上」即**一律拒**(fail-closed)。当前无任何 agent
          // 会话带扩展身份,故通用路的正确行为就是拒。桌面面板走渲染端直连(不经这里)不受影响。
          if (entry.method.startsWith("memory.")) {
            result = await runWithAgentMemoryScopeForSession(sessionId, () => callRpc(entry, args.input));
          } else if (entry.method.startsWith("extensionStore.")) {
            result = await runWithUnboundAgentExtensionScope(() => callRpc(entry, args.input));
          } else {
            result = await callRpc(entry, args.input);
          }
        } catch (err) {
          // ZodError = 参数在**执行之前**就被挡下 → 命令没跑 → REJECTED。
          if (err instanceof z.ZodError) {
            const op = makeOp("REJECTED", entry.method, operationId, {
              code: OP_CODE.rpcFailed,
              reason: errText(err),
            });
            settleGrant(op);
            settle(op.resultKind, op);
            return operationToolResult(op);
          }
          // 其余抛错:只读/界面档不可能有副作用 → FAILED(可安全重试);
          // 写/高风险档**可能已部分提交** → UNCERTAIN(绝不标成功,也绝不默认重试)。
          // 【MC-060】ModuleHost 在执行点拒绝一个**没执行**的 action 调用时抛带 `moduleRefusal`
          // 标记的 Error(审批被拒 / 无审批通道 / 越权)—— 那是"命令没执行",按 REJECTED 归类,
          // 绝不能因为权限档是 write 就误报成 UNCERTAIN。共用 `thrownResultKind`,不在这里重写判据。
          const kind = thrownResultKind(err, entry.policy.level);
          const op = kind === "REJECTED"
            ? makeOp("REJECTED", entry.method, operationId, { code: OP_CODE.approvalDenied, reason: errText(err) })
            : kind === "UNCERTAIN"
              ? makeOp("UNCERTAIN", entry.method, operationId, {
                  code: OP_CODE.rpcUncertain,
                  reason: `执行途中出错,无法确认副作用是否已落定:${errText(err)}`,
                })
              : makeOp("FAILED", entry.method, operationId, {
                  code: OP_CODE.rpcFailed,
                  reason: errText(err),
                });
          // ★ UNCERTAIN 也**落账** —— 同 id 再试会被回放成 UNCERTAIN,**不再盲发第二次 RPC**。
          settleGrant(op);
          settle(op.resultKind, op);
          return operationToolResult(op);
        }

        // ── 领域结果解码(MC-066):RPC resolve ≠ 业务成功 ───────────────────
        // 不同 IPC 的合法返回有 void / 数据对象 / {ok:true|false} / 判别联合等多种语义。
        // 显式登记过结果合同的方法(如 browser.* 的 {ok,error} 信封)在这里判:ok:false 是
        // 业务**明确拒绝**(没执行)→ REJECTED,而不是 SUCCEEDED。
        //
        // 【MC-021】结算**就挂在解码结果上**:成功 → 保留领取的那笔计数;确定拒绝(没执行)
        // → 退还(额度还能再用);其余(UNCERTAIN / 部分成功等)→ 保留(宁可多记不可少记)。
        const body = renderResult(slimSessions(result));
        const outcome = resolveOperationOutcome(entry.method, result);
        // `accepted` = 完全成功(含空批次);`null` = 没登记合同(返回即成功)。两种都往下走。
        // 失败/部分成功/无法确认在这里提前返回,**不**降级成失败成功混杂。
        if (outcome && outcome.kind !== "accepted") {
          const op = makeOp(resultKindOfOperationOutcome(outcome), entry.method, operationId, opExtraFromOutcome(outcome));
          settleGrant(op);
          settle(op.resultKind, op, body);
          return operationToolResult(op, body);
        }

        // ★★ **RPC 已经提交。此后任何一步失败都不能把结果降级成失败** ——
        //    那正是 ARC-009 要修的洞:失败的返回值会把 Agent 推去重复执行一个已落定的
        //    非幂等操作。通知失败 → SUCCEEDED_WITH_WARNINGS,并**保留可观测的 warning**。
        let op: OperationResult;
        if (trustedExtension) {
          await trustedExtension.authorize(entry.method);
          trustedExtension.acceptResult(redactValue(slimSessions(result)));
        }
        try {
          notifyAppSettingWrite(entry.method, args.input);
          op = makeOp("SUCCEEDED", entry.method, operationId);
        } catch (error) {
          const warning: OperationWarning = {
            code: OP_WARNING_UI_REFRESH_FAILED,
            // 不吞异常:把原因写进**可观测**的 warning(字段 + 文本两层都带上)。
            message: `业务已提交,但桌面刷新通知失败:${errText(error)}`,
            retryable: true,
          };
          op = makeOp("SUCCEEDED_WITH_WARNINGS", entry.method, operationId, { warnings: [warning] });
        }
        settleGrant(op);
        settle(op.resultKind, op, body);
        return operationToolResult(op, body);
      }
      case "extension_build": {
        // 【T20】卡面验收 1：**不经确认不写盘**。工坊的草稿目录也是写盘，而且接下来
        // 要在隔离进程里真跑一次 AI 生成的代码 —— 这一步必须在用户点头之后。审批卡展示
        // 清单的权限与静态可见的 API 调用（与 `modules.install` 同一份说明函数）。
        const manifestLike = args.draft && typeof args.draft === "object"
          ? (args.draft as { manifest?: unknown }).manifest
          : undefined;
        const denied = await gateAppAction(
          ctx, "write", "extension_build", args,
          "让 AI 在受控目录写出一个扩展草稿并在隔离沙箱里试跑一次" +
            (manifestLike !== undefined ? extensionInstallApprovalSummary({ manifest: manifestLike }) : ""),
        );
        if (denied) {
          return operationToolResult(makeOp("REJECTED", "extension_build", randomUUID(), { code: OP_CODE.approvalDenied, reason: denied }));
        }
        return await spec.handler(args, { sessionId });
      }
      case "document_tool_call":
      case "document_md_edit": {
        // 【T24】文档编辑与 `document.edit` 同一条审批判据：**写档门禁在 handler 里**
        // （与 app_api_call 同一手法）。只读工具自动放行；会把文件改掉的每次弹卡。
        // 判据只看“这个工具会不会写”，不看模型自报的 dryRun —— dryRun 只是少写一次盘，
        // 但调用方仍可能在同一轮里再发一次真实编辑。
        const { documentToolCall, documentMarkdownEdit } = await import("@main/document/documentToolRuntime.js");
        const { isMutatingDocumentTool } = await import("@main/document/documentToolSurface.js");
        const scope = z.object({
          tool: z.string().optional(),
          app: z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]).optional(),
          filePath: z.string().optional(),
          operations: z.array(z.unknown()).optional(),
          dryRun: z.boolean().optional(),
          track: z.boolean().optional(),
          input: z.record(z.string(), z.unknown()).optional(),
        }).passthrough().parse(args);
        if (typeof scope.filePath !== "string" || scope.filePath.trim() === "") return fail("缺少参数 filePath");
        // 审批判据不能信模型自报的 app：缺省 app 时按**目录**解析该工具的真实 app
        // （同一工具名可能在多个编辑器里存在——任一 app 会写就按写档处理），
        // 未知工具直接算写档。否则省略 app 就能把一次编辑降级成“只读、自动放行”。
        const resolvedApp = scope.app ?? (typeof scope.tool === "string"
          ? (documentCatalogAppsFor(scope.tool).find((app) => isMutatingDocumentTool(app, scope.tool!)) ?? documentCatalogAppsFor(scope.tool)[0])
          : undefined);
        const mutating = name === "document_md_edit"
          || (typeof scope.tool === "string" && (resolvedApp === undefined || isMutatingDocumentTool(resolvedApp, scope.tool)));
        const denied = await gateAppAction(
          ctx, mutating ? "danger" : "read",
          mutating ? `document.write.${scope.tool ?? "markdown"}` : "document.read",
          args,
          mutating
            ? `修改文档 ${scope.filePath}${typeof scope.tool === "string" ? `（工具 ${scope.tool}）` : "（Markdown 编辑）"}`
            : `读取文档 ${scope.filePath}`,
        );
        if (denied) return operationToolResult(makeOp("REJECTED", `document.${name}`, randomUUID(), { code: OP_CODE.approvalDenied, reason: denied }));
        const portsResolved = documentRuntimePortsSync();
        if (!portsResolved.ok) return fail(portsResolved.reason);
        if (name === "document_md_edit") {
          const result = await documentMarkdownEdit(portsResolved.ports, {
            filePath: scope.filePath,
            operations: (scope.operations ?? []) as never,
            ...(scope.track !== undefined ? { track: scope.track } : {}),
            ...(scope.dryRun !== undefined ? { dryRun: scope.dryRun } : {}),
          });
          return result.ok ? text(result.text) : fail(result.reason);
        }
        const result = await documentToolCall(portsResolved.ports, {
          tool: String(scope.tool ?? ""),
          ...(scope.app !== undefined ? { app: scope.app } : {}),
          filePath: scope.filePath,
          ...(scope.input !== undefined ? { input: scope.input } : {}),
          ...(scope.dryRun !== undefined ? { dryRun: scope.dryRun } : {}),
          ...(scope.track !== undefined ? { track: scope.track } : {}),
        });
        return result.ok ? text(result.text) : fail(result.reason);
      }
      case "app_ui":
        return await runUiAction(args as UiArgs, ctx, sessionId);
      // 【MC-014】五条自带工具也过**同一份**操作账本(只在带 operation_id 时)。
      // 守卫返回非 null = 已经在账本层裁决掉(冲突/在途/回放/未落盘),不执行;
      // null = 没带幂等键,走原路(operationId 由各 run 自生成)。
      case "app_session_new":
        return (await withSelfToolIdempotency("app_session_new", args, sessionId, (id, finish) =>
          runSessionNew({ ...(args as SessionNewArgs), operationId: id }, sessionId, ctx, finish))) ??
          await runSessionNew(args as SessionNewArgs, sessionId, ctx);
      case "app_session_send":
        return (await withSelfToolIdempotency("app_session_send", args, sessionId, (id, finish) =>
          runSessionSend({ ...(args as SessionSendArgs), operationId: id }, sessionId, ctx, finish))) ??
          await runSessionSend(args as SessionSendArgs, sessionId, ctx);
      case "app_workflow_run":
        return (await withSelfToolIdempotency("app_workflow_run", args, sessionId, (id, finish) =>
          runWorkflow({ ...(args as { workflow_id: string }), operationId: id }, sessionId, ctx, finish))) ??
          await runWorkflow(args as { workflow_id: string }, sessionId, ctx);
      case "app_workflow_publish":
        return (await withSelfToolIdempotency("app_workflow_publish", args, sessionId, (id, finish) =>
          runWorkflowPublish({ ...(args as { workflow_id: string; name: string; description?: string }), operationId: id }, ctx, finish))) ??
          await runWorkflowPublish(args as { workflow_id: string; name: string; description?: string }, ctx);
      case "app_workflow_unpublish":
        return (await withSelfToolIdempotency("app_workflow_unpublish", args, sessionId, (id, finish) =>
          runWorkflowUnpublish({ ...(args as { workflow_id: string }), operationId: id }, ctx, finish))) ??
          await runWorkflowUnpublish(args as { workflow_id: string }, ctx);
      default:
        return await spec.handler(args, { sessionId });
    }
  } catch (err) {
    return fail(errText(err));
  }
}

/** Host-owned ModuleHost identity -> the existing invokeAppTool dispatch and policy. */
export async function invokeExtensionAppCall(
  moduleId: string, method: string, input: unknown, signal: AbortSignal,
): Promise<unknown> {
  const { getModuleHost } = await import("../modules/service.js");
  const host = await getModuleHost();
  let accepted = false;
  let payload: unknown;
  const authorize = async (requested: string): Promise<void> => {
    if (signal.aborted) throw Error("扩展 RPC 已取消");
    host.authorizeAppMethod(moduleId, requested);
  };
  const reply = await invokeAppTool(
    "app_api_call", { method, input }, "extension:" + moduleId, {} as ProviderContext,
    { authorize, acceptResult(result) { accepted = true; payload = result; } },
  );
  if (signal.aborted) throw Error("扩展 RPC 已取消");
  if (!accepted) throw Error(textBlocksOf(reply).join("\n") || "扩展 RPC 被拒绝");
  return payload;
}
