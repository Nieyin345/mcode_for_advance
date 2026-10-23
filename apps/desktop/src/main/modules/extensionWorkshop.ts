/**
 * 【T20】**扩展工坊** —— 「用户说一句 → AI 写出扩展 → 装进 Mcode」的**有闸门闭环**。
 *
 * ## 它补的是什么
 *
 * T18 给了安装那一刻的三态权限卡（允许一次 / 始终允许 / 拒绝），T19 把 danger 档扩展
 * RPC 改成逐次审批。但在此之前，AI 想给用户写一个扩展时没有一条**成型的路**：
 * 它只能自己拼清单、自己碰运气地 `modules.install`，没有「先静态校验、再真跑一次沙箱、
 * 失败自动回滚、修复次数有上限」这一整套。本模块就是那套流程的**唯一实现**。
 *
 * ## 闭环六步与谁负责
 *
 * ```
 *  ① draft（需求 → 清单草案）      AI —— 清单是声明式的；可执行部分只有 `program.source`
 *                                        这一个函数工厂（`ModuleProgramSchema` 的形状）。
 *  ② write（写进受控目录）         本模块 —— **只在静态校验通过后**才落盘；
 *                                        目录 = <工坊根>/<模块 id>/draft/
 *  ③ static（静态校验，不执行）     本模块 —— 清单 schema / 权限闭集 / 无 blocked 档 /
 *                                        程序可编译 / 入口文件确实写出来了。
 *  ④ sandbox（沙箱冒烟）           本模块 —— 用 `permissionedProcessRunner` 的
 *                                        `runPermissionedProcess` **真跑**一次最小调用；
 *                                        沙箱内失败 = 不装机、删掉草稿、记一次修复失败。
 *  ⑤ consent（用户确认）           **不在这里** —— 由 `ipc/modules.ts` 的
 *                                        `modules.install` 走 T18 卡片；本模块只产出
 *                                        「这个扩展要干什么 + 要什么权限」的**交接材料**，
 *                                        AI 无权代签（`extensionWorkshopInstallHandoff`）。
 *  ⑥ commit / rollback（装机与回滚） `modules.install` / `modules.remove` 的既有事务 +
 *                                        本模块的**对账**（`reconcileWorkshopStates`）：
 *                                        从宿主目录读出「真的装上了 / 真的被卸了」，
 *                                        记录可回滚点、清掉被卸模块的草稿。
 * ```
 *
 * ## 安全硬要求（每条都有回归断言，见 `extension-workshop-smoke`）
 *
 *  - **AI 不能自己批准安装**：本模块**从不**调用 `ModuleHost.install`，也没有任何
 *    「已批准」字段；交接材料里的 `installConsent` 永远是 `"allow-once"`（不铸造跨重启
 *    授权），`requiresUserApproval` 是字面类型 `true`。安装必须再走 `modules.install` 的
 *    用户卡片（Agent 通道的 `allow-always` 还会被 `installConsentPolicy` 降级为
 *    `allow-once`）。变异验证把交接材料改成 `allow-always` 时，套件必须变红。
 *  - **AI 不能在清单里声明 blocked 档能力**：`blocked` 是**方法**的档位（`policy.ts`
 *    的 BLOCKED / 凭据本体），不是权限名。本模块两道判：① 清单权限必须全在
 *    `MODULE_PERMISSION_NAMES` 闭集内（schema 层也会拒）；② 程序源码里**字面量**
 *    写到的任何 `mcode.api.call("…")` / `app_api_call("…")` 方法，若 `policyFor` 判
 *    `blocked` 或权限映射为 `null`（不可委托），**静态拒绝**。动态拼出来的方法名静态
 *    看不出来 —— 那由 T19 的运行期闸门兜底，这里如实说明「静态只识别字面量」而不假装。
 *  - **生成的代码在隔离进程里跑**：④ 走 `runPermissionedProcess`（独立子进程 +
 *    `--permission` 文件级 fs 围栏 + 网络拦截），不进主进程、不进渲染端；冒烟**从不**
 *    给写权限 / 网络权限。冒烟里唯一放行的 RPC 是 **read 档**（见
 *    {@link runWorkshopSandbox} 的桥）：write / danger 在冒烟阶段**一律拒绝** ——
 *    危险操作不能靠"先让沙箱跑通"预支用户的逐次批准。
 *  - **失败可回滚**：③④ 失败都会删掉草稿目录（`draft/`），状态文件留在模块目录；
 *    ⑥ 由 `install` / `remove` 的既有事务保证；工坊自己的对账会把「已装」记录成可回滚点，
 *    并在宿主目录里**看不到**该模块时把它标成 `rolledBack` 且清掉草稿。
 *  - **修复重试有上限**：`WORKSHOP_MAX_REPAIR_ATTEMPTS`；超限即 `repair_exhausted`，
 *    后续 `buildExtension` 一律拒绝，必须由**用户**重新发起。另有
 *    `WORKSHOP_MAX_DRAFTS` 限制工坊根下最多容纳的草稿目录数（换 id 也绕不过去）。
 *
 * ## 目录布局（为什么状态与草稿分开）
 *
 * ```
 * <工坊根>/<模块 id>/
 *   state.json     ← 修复预算 + 可回滚点（失败清理**不删它**，否则计数会被一起删掉）
 *   draft/         ← draft.json（AI 的完整草稿）+ extension.json（清单=入口）+ 样例文件
 * ```
 *
 * 沙箱失败时删的是 `draft/`，`state.json` 的 `attempts` 因此留得住 —— 这是修复上限
 * 真能生效的前提（曾经的布局把两者放在同一目录，`rm -rf` 会把计数一起抹掉）。
 *
 * ## 为什么本模块是纯模块
 *
 * `service.ts` 同级 —— 不 import electron / 不碰 DB。工坊根、沙箱工作区、沙箱 RPC 派发
 * 都由调用方注入，无头 smoke 直接 bundle 本文件、用临时目录当工坊根，把 ③④ 的失败路径
 * 逐条跑出来。
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Script } from "node:vm";
import {
  MODULE_PERMISSION_NAMES,
  MODULE_HIGH_RISK_PERMISSIONS,
  APP_METHOD_PERMISSIONS,
  type ModulePermission,
} from "@contracts/appPermission";
import {
  ModuleManifestSchema,
  extensionCapabilityShortName,
  type ModuleManifest,
} from "@contracts/modules";
import {
  WORKSHOP_STATE_FILE,
  WORKSHOP_DRAFT_FILE,
  WORKSHOP_ENTRY_FILE,
  WORKSHOP_SAMPLE_PREFIX,
  WORKSHOP_MAX_REPAIR_ATTEMPTS,
  WORKSHOP_MAX_DRAFTS,
  ExtensionWorkshopDraftSchema,
  ExtensionWorkshopStateSchema,
  type ExtensionWorkshopDraft,
  type ExtensionWorkshopState,
  type ExtensionWorkshopReport,
  type ExtensionWorkshopDiagnosis,
  type ExtensionWorkshopStatus,
  type ExtensionWorkshopInstallHandoff,
} from "@contracts/extensionWorkshop";
import { policyFor } from "@main/appControl/policy.js";
import { runPermissionedProcess } from "./permissionedProcessRunner.js";

/**
 * 修复重试的硬上限（与契约常量同一份 —— 这里是**检查点**，不是第二份定义）。
 * 超限的会话不再允许继续生成，只能由用户重新发起一次新的生成。
 */
export const MAX_REPAIR_ATTEMPTS = WORKSHOP_MAX_REPAIR_ATTEMPTS;

/** 一个扩展工坊实例的依赖。全部由调用方注入（生产在 `tools.ts` 的装配点）。 */
export interface ExtensionWorkshopOptions {
  /** 工坊根 —— 生产 = `<数据根>/extension-workshop`；smoke 传临时目录。 */
  workshopRoot: string;
  /** 沙箱冒烟用的工作区（真实文件）。**生产必须给**已知工作区里的一份文件；
   *  缺省 = 草稿目录里自动生成的一份样例文件（只用于无头 smoke / 没有工作区的极端场景）。 */
  sandboxWorkspace?(): { projectPath: string; path: string } | null;
  /** danger 档判定 —— 生产直接用 `policyFor`（同一份，T19 的唯一判据）。注入只为 smoke 可测。 */
  policy?: (method: string) => { level: string };
  /** 沙箱执行的超时（毫秒）。缺省 10 秒 —— 最小调用不该更久。 */
  sandboxTimeoutMs?: number;
  /** 沙箱里 **read 档** RPC 的派发端口。生产由 `tools.ts` 复用 `app_api_call` 的既有通道；
   *  不装配 = 程序一旦调用 RPC 就在沙箱里失败（fail-closed，不会静默放行）。 */
  sandboxAppCall?(method: string, input: unknown): Promise<unknown>;
}

/** 静态校验与沙箱冒烟共用的一份「这次要装什么」。 */
interface PreparedDraft {
  draft: ExtensionWorkshopDraft;
  manifest: ModuleManifest;
  /** 引用到的扩展能力短名（`module.<短名>` → `<短名>`）。 */
  capabilities: string[];
}

/** 权限 → 人类可读说明（与 T18 卡片同一口径；AI 回执里也用这一份）。 */
const PERMISSION_NOTES: Record<string, string> = {
  "files.read": "读取工作区里的文件",
  "files.write": "修改工作区里的文件",
  "resource.read": "读取调用时指定的资源",
  "resource.write": "修改调用时指定的资源",
  "network": "向外部地址发起网络请求",
  "terminal.run": "运行终端命令",
  "code.execute": "执行程序代码",
  "modules.install": "安装/卸载其他扩展",
  "git.write": "修改仓库",
  "session.send": "向对话发送内容",
  "setting.write": "修改应用设置",
};

/** 把清单里的权限转成「要什么」的一行行说明（AI 回执与用户卡片共同的事实来源）。 */
export function describeRequestedPermissions(manifest: ModuleManifest): string[] {
  return manifest.permissions.map((permission) =>
    `${permission}（${PERMISSION_NOTES[permission] ?? "扩展能力"}）`);
}

/** 模块目录：`<工坊根>/<模块 id>`。 */
function moduleDirOf(root: string, moduleId: string): string {
  return join(root, moduleId.replace(/[/\\]/g, "_"));
}
/** 草稿目录（失败清理只删这里，**不删**同级 state.json）。 */
function draftDirOf(root: string, moduleId: string): string {
  return join(moduleDirOf(root, moduleId), "draft");
}
/** 草稿目录是否存在（不跟随符号链接；坏路径按不存在处理）。 */
function draftDirExistsSync(root: string, moduleId: string): boolean {
  try {
    return lstatSync(draftDirOf(root, moduleId)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 【T20】**静态校验**（不执行任何用户代码）：
 *
 *  - 清单 schema（`ModuleManifestSchema`：id 前缀、权限闭集、贡献形状、程序形状）；
 *  - 权限必须都在 `MODULE_PERMISSION_NAMES` 内 —— schema 已拒，这里再显式点名，
 *    给 AI 一句能照抄的错误；
 *  - 程序源码必须能被**编译**（`node:vm` 的 `Script`，只编译不执行）—— 语法错在落盘前
 *    就报，不浪费一次沙箱；
 *  - **blocked 档能力**：程序里**字面量**出现的 RPC 方法，凡 `policyFor` 判 `blocked`，
 *    或权限映射为 `null`（不可委托），一律拒；
 *  - danger 档**不拒**：T19 的逐次审批会在运行期问用户；回执里如实提醒 AI。
 */
export function diagnoseExtensionDraft(
  raw: unknown,
  policy: (method: string) => { level: string } = policyFor,
): ExtensionWorkshopDiagnosis {
  const issues: string[] = [];
  const warnings: string[] = [];
  const forbidden: Array<{ method: string; reason: string }> = [];

  // ① 权限闭集（先于 schema，给更具体的点名）。
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const permissions = (raw as { permissions?: unknown }).permissions;
    if (Array.isArray(permissions)) {
      for (const value of permissions) {
        if (typeof value !== "string" || !(MODULE_PERMISSION_NAMES as readonly string[]).includes(value)) {
          issues.push(`权限 ${String(value)} 不存在（只允许 MODULE_PERMISSION_NAMES 的 ${MODULE_PERMISSION_NAMES.length} 个权限名）`);
        }
      }
    }
  }
  const manifest = ModuleManifestSchema.safeParse(raw);
  if (!manifest.success) {
    for (const error of manifest.error.issues) {
      const message = `${error.path.join(".") || "manifest"}: ${error.message}`;
      if (!issues.includes(message)) issues.push(message);
    }
    return { ok: false, issues, warnings, forbidden };
  }
  const parsed = manifest.data;
  if (!parsed.id.startsWith("user.")) issues.push("扩展 id 必须以 user. 开头");

  // ② 程序字面量调用的档位（blocked / 不可委托 = 拒；danger = 警告）。
  if (parsed.program !== undefined) {
    // 只编译、不执行 —— 语法错在落盘前拒绝（与 `extension_validate` 同一手法）。
    try {
      new Script("(" + parsed.program.source + ")", { filename: "extension-program.js" });
    } catch (error) {
      issues.push("程序源码无法编译：" + (error instanceof Error ? error.message : String(error)));
    }
    const literalCalls = [...parsed.program.source.matchAll(/(?:mcode\.api\.call|app_api_call)\s*\(\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!);
    for (const method of new Set(literalCalls)) {
      const level = policy(method).level;
      const mapped = Object.hasOwn(APP_METHOD_PERMISSIONS, method) ? APP_METHOD_PERMISSIONS[method] : undefined;
      if (level === "blocked") {
        forbidden.push({ method, reason: "blocked（这个功能不开放给扩展，任何权限都不能调用）" });
        issues.push(`程序调用了 blocked 档方法 ${method} —— AI 生成的扩展不能声明或调用 blocked 档能力`);
        continue;
      }
      if (mapped === null) {
        forbidden.push({ method, reason: "不可委托（结构性禁止，不是权限不足）" });
        issues.push(`程序调用了不可委托方法 ${method} —— 即使有权限也不允许扩展调用`);
        continue;
      }
      if (mapped === undefined) {
        warnings.push(`API ${method} 不在权限映射中，运行期会被拒（fail-closed）`);
        continue;
      }
      const missing = mapped.filter((permission) => !parsed.permissions.includes(permission as ModulePermission));
      for (const permission of missing) {
        warnings.push(`API ${method} 需要未声明权限 ${permission} —— 运行期会被拒，请在清单里补上或改成别的做法`);
      }
      // danger 档不拒：T19 的逐次审批会问用户。但要在回执里**如实告诉 AI**，
      // 让它知道这类调用装好后每次都会弹卡 —— 而不是硬写进程序里碰运气。
      if (level === "danger") warnings.push(`API ${method} 是高风险方法：每次调用都会要求用户本人批准（安装授权不能替代）`);
    }
    if (literalCalls.length === 0 && /mcode\s*\.\s*api\s*\.\s*call|app_api_call/.test(parsed.program.source)) {
      warnings.push("程序里有无法静态识别的方法名（动态拼接）—— 静态校验只认字面量，运行期由宿主逐次鉴权兜底");
    }
  }

  // ③ 高风险权限：不拒，但要显式列出（用户卡片会标红；AI 回执要让用户有心理准备）。
  const highRisk = parsed.permissions.filter((permission) => MODULE_HIGH_RISK_PERMISSIONS.has(permission));
  for (const permission of highRisk) warnings.push(`权限 ${permission} 属于高风险档（安装卡会标红，用户可能拒绝）`);

  return { ok: issues.length === 0, issues, warnings, forbidden };
}

/** 从一份未校验的草稿里**尽力**取出模块 id（修复预算的键；取不到返回 null）。 */
function looseModuleId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const manifest = (raw as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object") return null;
  const id = (manifest as { id?: unknown }).id;
  return typeof id === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id) && id.length <= 100 ? id : null;
}

/** 工坊根下已有的模块目录数（用于 `WORKSHOP_MAX_DRAFTS` 的全局上限）。 */
function countWorkshopModules(root: string): number {
  try {
    return readdirSync(root).length;
  } catch {
    return 0;
  }
}

/**
 * 把清单 + 草稿 + 一份**样例文件**写进草稿目录（**只在静态校验通过之后**调用）。
 *
 * 样例文件是沙箱冒烟的读取对象：扩展贡献声明的第一个扩展名（缺省 `.md`），
 * 内容固定。它让「能启动、能读一次、能返回 ModuleResult」这条冒烟有意义。
 */
async function writeDraftFiles(root: string, draft: ExtensionWorkshopDraft): Promise<{ dir: string; entry: string }> {
  const dir = draftDirOf(root, draft.manifest.id);
  await mkdir(dir, { recursive: true });
  const entry = join(dir, WORKSHOP_ENTRY_FILE);
  await writeFile(entry, JSON.stringify(draft.manifest, null, 2), "utf8");
  await writeFile(join(dir, WORKSHOP_DRAFT_FILE), JSON.stringify(draft, null, 2), "utf8");
  const info = lstatSync(entry);
  if (!info.isFile() || info.size === 0) throw Error("入口文件没有真正写出来");
  const sampleExtension = draft.manifest.contributions
    .flatMap((contribution) => (contribution.slot === "files.context" && contribution.extensions ? contribution.extensions : []))
    .find((extension) => /^\.[a-z0-9]{1,10}$/i.test(extension)) ?? ".md";
  await writeFile(join(dir, WORKSHOP_SAMPLE_PREFIX + sampleExtension), "Mcode extension workshop sample\nline 2\nline 3\n", { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { dir, entry };
}

/** 一次沙箱冒烟的输入：源、能力短名、资源、超时、是否允许网络、RPC 派发桥。 */
export interface WorkshopSandboxInput {
  source: string;
  capability: string;
  resource: { projectPath: string; path: string };
  timeoutMs: number;
  allowWrite: boolean;
  allowNetwork: boolean;
  signal: AbortSignal;
  /** read 档 RPC 的宿主派发口（沙箱内的 `mcode.api.call` 经它往返；非 read 一律在桥里拒）。 */
  onAppCall?(method: string, input: unknown): Promise<unknown>;
}

/** 沙箱执行端口（生产 = `runPermissionedProcess`；smoke 可注入替身验证「失败不装机」）。 */
export type WorkshopSandbox = (input: WorkshopSandboxInput) => Promise<{ [key: string]: unknown }>;

/**
 * 【T20】第 ④ 步：**沙箱冒烟**。
 *
 * 真跑一次最小调用：在独立受控子进程（`permissionedProcessRunner`）里求值工厂、调一个
 * 能力，确认它能启动、能返回一个符合 `ModuleResult` 的结果。**失败 = 不装机**，由调用方
 * 删草稿目录（见 `buildExtension`）。
 *
 * ## 沙箱里的 RPC 桥（唯一的放行面 = read 档）
 *
 * AI 写的扩展现实里多半要调 `mcode.api.call("project.list")` 之类的只读方法。冒烟桥
 * 逐层收紧：
 *   1. `policyFor(method).level !== "read"` → 拒（write/danger 在冒烟阶段**一律不跑**；
 *      危险操作不能在用户安装前被"试跑"一次，更不能被沙箱替用户批准）；
 *   2. 权限映射为 `null` / 未映射 → 拒（blocked 与不可委托）；
 *   3. 方法要求的权限不在**清单声明**里 → 拒（冒烟不能比清单更宽）；
 *   4. 派发端口未装配 → 拒（fail-closed）。
 *
 * 资源：`sandboxWorkspace()` 给了就用它，否则用草稿目录里 `writeDraftFiles` 写好的样例
 * 文件。冒烟**从不**给写 / 网络权限 —— 只证明「能启动、能读、能返回」。
 */
export async function runWorkshopSandbox(
  prepared: PreparedDraft,
  options: ExtensionWorkshopOptions,
  sandbox: WorkshopSandbox,
): Promise<{ ok: true; capability: string; result: { [key: string]: unknown } } | { ok: false; reason: string }> {
  const manifest = prepared.manifest;
  if (manifest.program === undefined) return { ok: false, reason: "扩展没有可执行程序，无法做沙箱冒烟" };
  const capability = prepared.capabilities[0];
  if (capability === undefined) return { ok: false, reason: "扩展没有声明任何 module.<短名> 能力，无法做沙箱冒烟" };
  const workspace = options.sandboxWorkspace?.() ?? null;
  const dir = draftDirOf(options.workshopRoot, manifest.id);
  const sampleExtension = manifest.contributions
    .flatMap((contribution) => (contribution.slot === "files.context" && contribution.extensions ? contribution.extensions : []))
    .find((extension) => /^\.[a-z0-9]{1,10}$/i.test(extension)) ?? ".md";
  const resource = workspace !== null
    ? workspace
    : { projectPath: dir, path: join(dir, WORKSHOP_SAMPLE_PREFIX + sampleExtension) };
  const declared = new Set<string>(manifest.permissions);
  const policy = options.policy ?? policyFor;
  const onAppCall = async (method: string, input: unknown): Promise<unknown> => {
    const level = policy(method).level;
    if (level !== "read") {
      throw Error(`沙箱冒烟只允许 read 档方法：${method} 是 ${level} 档，安装前的试跑不能预支用户批准`);
    }
    const mapped = Object.hasOwn(APP_METHOD_PERMISSIONS, method) ? APP_METHOD_PERMISSIONS[method] : undefined;
    if (mapped === undefined || mapped === null) {
      throw Error(`沙箱冒烟不允许调用 ${method}（${mapped === null ? "不可委托" : "权限映射不存在"}）`);
    }
    const missing = mapped.filter((permission) => !declared.has(permission));
    if (missing.length > 0) {
      throw Error(`扩展没有声明 ${missing.join(", ")} 权限，沙箱里不能调用 ${method}`);
    }
    if (!options.sandboxAppCall) throw Error("沙箱 RPC 通道未装配，已拒绝执行扩展的 mcode.api.call");
    return options.sandboxAppCall(method, input);
  };
  const controller = new AbortController();
  try {
    const result = await sandbox({
      source: manifest.program.source,
      capability,
      resource,
      timeoutMs: options.sandboxTimeoutMs ?? 10_000,
      allowWrite: false,
      allowNetwork: false,
      signal: controller.signal,
      onAppCall,
    });
    return { ok: true, capability, result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 默认沙箱 = 生产执行器（独立受控子进程 + read 档 RPC 桥）。smoke 可以换成替身。 */
export const defaultWorkshopSandbox: WorkshopSandbox = (input) => {
  return runPermissionedProcess({
    source: input.source,
    capability: input.capability,
    resource: input.resource,
    allowWrite: input.allowWrite,
    allowNetwork: input.allowNetwork,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    ...(input.onAppCall ? { onAppCall: input.onAppCall } : {}),
  });
};

/* ══════════════════════════════════════════════════════════════════════════
 * 【T20】修复会话状态（修复上限 + 可回滚点）—— 明确**不是授权**
 * ══════════════════════════════════════════════════════════════════════════ */

/** 读一个模块的工坊状态。不存在 / 坏档 / 符号链接 → `null`（fail-closed，不猜）。 */
export async function readWorkshopState(root: string, moduleId: string): Promise<ExtensionWorkshopState | null> {
  const path = join(moduleDirOf(root, moduleId), WORKSHOP_STATE_FILE);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const parsed = ExtensionWorkshopStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 写状态（非授权记录，只供工坊流程与 UI 展示；不参与 ModuleHost 的任何判定）。 */
export async function writeWorkshopState(root: string, state: ExtensionWorkshopState): Promise<void> {
  const dir = moduleDirOf(root, state.moduleId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, WORKSHOP_STATE_FILE), JSON.stringify(state, null, 2), "utf8");
}

/** 修复预算是否还没用完（状态不存在 = 新会话；`repair_exhausted` = 必须交还用户）。 */
export function canRepair(state: ExtensionWorkshopState | null): boolean {
  if (state === null) return true;
  if (state.status === "repair_exhausted") return false;
  return state.attempts < MAX_REPAIR_ATTEMPTS;
}

/** 把一次失败记成 `attempts + 1`；达到上限就标 `repair_exhausted`。 */
export function recordRepairFailure(
  moduleId: string,
  previous: ExtensionWorkshopState | null,
  reason: string,
): ExtensionWorkshopState {
  const attempts = (previous?.attempts ?? 0) + 1;
  const status: ExtensionWorkshopStatus = attempts >= MAX_REPAIR_ATTEMPTS ? "repair_exhausted" : "drafting";
  return {
    version: 1,
    moduleId,
    attempts,
    status,
    installed: previous?.installed ?? null,
    lastError: reason.slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
}

/** 一次失败后：清理草稿、写状态。清理失败不吞（写进返回的 issues）。 */
async function recordFailureAndCleanup(
  root: string,
  moduleId: string | null,
  reason: string,
): Promise<{ state: ExtensionWorkshopState | null; cleanupError: string | null }> {
  let cleanupError: string | null = null;
  if (moduleId !== null) {
    // 草稿目录清掉；**状态文件在模块目录**，不受影响（修复计数必须留得住）。
    try {
      await rm(draftDirOf(root, moduleId), { recursive: true, force: true });
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    const previous = await readWorkshopState(root, moduleId);
    const next = recordRepairFailure(moduleId, previous, reason);
    try {
      await writeWorkshopState(root, next);
    } catch {
      // 状态写入失败不改变"这次失败"的事实；调用方仍会收到可读错误。
    }
    return { state: next, cleanupError };
  }
  return { state: null, cleanupError };
}

/** `repair_exhausted` 时返回给 AI 的固定说明。 */
function exhaustedReport(state: ExtensionWorkshopState): ExtensionWorkshopReport {
  return {
    ok: false,
    stage: "budget",
    issues: [
      `修复次数已用完（${state.attempts}/${MAX_REPAIR_ATTEMPTS}）：这个扩展连续失败，已停止自动重试。`,
      `上次失败原因：${state.lastError ?? "(未记录)"}`,
      "请把剩下的问题和你的建议交给用户，由用户决定是否重新发起一次生成。",
    ],
    warnings: [],
    permissions: [],
    draft: null,
  };
}

/**
 * 【T20】**生成 → 校验 → 沙箱 → 落草稿**。这是 AI 侧唯一能触发的「写」动作。
 *
 * 顺序（每一步失败都**清除草稿**并记一次修复失败；不留半个扩展）：
 *
 *  1. 修复预算检查（`repair_exhausted` 直接拒，不再消耗沙箱）；
 *  2. 解析 `ExtensionWorkshopDraft` → 静态校验（`diagnoseExtensionDraft`）；
 *  3. 全局草稿数上限（`WORKSHOP_MAX_DRAFTS`）；
 *  4. 通过后写草稿文件（`draft/`：清单 + 草稿 + 样例文件）并核验入口；
 *  5. 沙箱冒烟（真跑）；
 *  6. 成功 → 返回清单全文 + 权限说明（**仍需用户安装卡确认**）。
 *
 * **它不安装。** 返回 `ok:true` 只表示「可以拿去给用户确认了」。安装必须由调用方
 * 带着清单再走 `modules.install`（T18 卡片）；本模块没有任何安装入口 —— 变异验证把
 * 「这里偷偷调 install」改进去时，套件必须变红。
 */
export async function buildExtension(
  rawDraft: unknown,
  options: ExtensionWorkshopOptions,
  sandbox: WorkshopSandbox = defaultWorkshopSandbox,
): Promise<ExtensionWorkshopReport> {
  const moduleId = looseModuleId(rawDraft);
  // ① 修复预算。
  if (moduleId !== null) {
    const state = await readWorkshopState(options.workshopRoot, moduleId);
    if (!canRepair(state)) return exhaustedReport(state!);
  }

  const fail = async (stage: "static" | "write" | "sandbox" | "budget", issues: string[], warnings: string[], permissions: string[]) => {
    const { state, cleanupError } = await recordFailureAndCleanup(options.workshopRoot, moduleId, issues.join("；"));
    const allIssues = [...issues];
    if (cleanupError !== null) allIssues.push("清理草稿目录失败：" + cleanupError);
    if (state !== null && state.status === "repair_exhausted") {
      allIssues.push(`已达到修复上限（${state.attempts}/${MAX_REPAIR_ATTEMPTS}）：请停下，把问题交给用户，不要继续自动重试。`);
    }
    return { ok: false, stage, issues: allIssues, warnings, permissions, draft: null } satisfies ExtensionWorkshopReport;
  };

  const parsed = ExtensionWorkshopDraftSchema.safeParse(rawDraft);
  if (!parsed.success) {
    return fail("static",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`),
      [], []);
  }
  const draft = parsed.data;
  const manifest = draft.manifest;
  const capabilityNames = [...new Set(manifest.contributions
    .map((contribution) => extensionCapabilityShortName(contribution.capability))
    .filter((name): name is string => name !== undefined))];
  const diagnosis = diagnoseExtensionDraft(manifest, options.policy);
  const permissions = describeRequestedPermissions(manifest);
  if (!diagnosis.ok) return fail("static", diagnosis.issues, diagnosis.warnings, permissions);

  // ② 全局草稿数上限（换模块 id 也绕不过去 —— 工坊根下的目录数有硬上限）。
  if (!draftDirExistsSync(options.workshopRoot, manifest.id)
    && countWorkshopModules(options.workshopRoot) >= WORKSHOP_MAX_DRAFTS) {
    return fail("budget", [
      `工坊里已有 ${WORKSHOP_MAX_DRAFTS} 个扩展目录，达到上限。请让用户先清理不再需要的草稿，再继续生成。`,
    ], diagnosis.warnings, permissions);
  }

  // ③ 落草稿（静态校验已过）。
  let written: { dir: string; entry: string };
  try {
    written = await writeDraftFiles(options.workshopRoot, draft);
  } catch (error) {
    return fail("write", ["写入草稿目录失败：" + (error instanceof Error ? error.message : String(error))], diagnosis.warnings, permissions);
  }

  // ④ 沙箱冒烟（真跑）。
  const sandboxed = await runWorkshopSandbox({ draft, manifest, capabilities: capabilityNames }, options, sandbox);
  if (!sandboxed.ok) {
    return fail("sandbox", ["沙箱冒烟失败：" + sandboxed.reason], diagnosis.warnings, permissions);
  }

  // 成功：修复预算归零（下一轮生成重新计数），但**保留**可回滚点（已装记录）。
  if (moduleId !== null) {
    const previous = await readWorkshopState(options.workshopRoot, moduleId);
    const reset: ExtensionWorkshopState = {
      version: 1,
      moduleId,
      attempts: 0,
      status: previous?.status === "installed" ? "installed" : "drafting",
      installed: previous?.installed ?? null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    await writeWorkshopState(options.workshopRoot, reset).catch(() => {});
  }
  return {
    ok: true,
    stage: "sandbox",
    issues: [],
    warnings: [
      ...diagnosis.warnings,
      "沙箱冒烟只证明扩展能启动并返回结果；安装仍需用户在本机确认权限（AI 无权代签）。",
    ],
    permissions,
    draft: { manifest, workspaceDir: written.dir, entryFile: written.entry, sandboxCapability: sandboxed.capability },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【T20】⑤ 安装交接 —— 只描述下一步，**不构成授权**
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 给 AI 的安装交接材料。**每一处都是收紧方向**：
 *
 *  - `installConsent: "allow-once"` —— 永远不写 `allow-always`。AI 通道拿不到跨重启授权；
 *    即便这段材料被篡改，`installConsentPolicy.resolveInstallDecision` 对没有真实
 *    渲染端发送方的调用也会把 `allow-always` 收窄成 `allow-once`（第二道闸）。
 *  - `grantedPermissions` = 清单**声明**的权限集 —— 用户卡片上展示的就是这一份；
 *    用户在桌面上还可以在勾选框里进一步收紧。
 *  - `confirmExecutableCode: true` —— `ModuleInstallSchema` 对带 `program` 的清单强制要求
 *    这个确认；它只是"这次安装包含可执行代码"的形状条件，不是用户同意本身。
 *  - `requiresUserApproval` 是字面类型 `true`，且本接口**没有任何**"已批准"字段 ——
 *    拿不到的东西伪造不出来。
 */
export function extensionWorkshopInstallHandoff(
  manifest: ModuleManifest,
  notes?: string,
): ExtensionWorkshopInstallHandoff {
  return {
    method: "modules.install",
    input: {
      manifest,
      confirmReadAccess: true,
      confirmExecutableCode: true,
      grantedPermissions: [...manifest.permissions],
      installConsent: "allow-once",
    },
    requiresUserApproval: true,
    instructions: [
      "下一步调用 app_api_call({ method: \"modules.install\", input: <上面的 input> })。",
      "这是 danger 档：用户必须在审批卡上本人确认；卡上会列出扩展 ID、申请权限与程序里静态可见的 API 调用。",
      "用户拒绝或没有审批通道 → 不会安装，未执行任何写盘；不要把拒绝重试成另一个 installConsent。",
      "安装成功后：模块出现在 modules.catalog 里，可经 modules.invoke 调用；卸载用 modules.remove（会撤销授权并删清单）。",
      ...(notes ? [`这个扩展要干什么（AI 自述，供用户阅读）：${notes}`] : []),
      "程序返回值必须是扁平的 ModuleResult（字段值只能 string/number/boolean/null，最多 32 个字段）。",
      "程序里调用 mcode.api.call 的高风险方法在安装后**每次**都会要求用户本人批准（T19），安装授权不能替代。",
    ],
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【T20】⑥ 可回滚点与对账（从宿主目录读事实；**不复制** ModuleHost 的事务）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  - **卸载**：用户点「一键卸载」→ 既有 `modules.remove`（撤销工作流授权、删清单、取消
 *    运行中任务）→ 下一次对账把工坊状态标成 `rolledBack` 并清掉草稿目录。
 *  - **换回上一版**：`modules.install` 的既有事务已保证「写盘失败 → 旧版仍在」（见
 *    ModuleHost.install 的事务顺序）；工坊这一层只记录版本号供 UI 展示，不另写回滚。
 */

export interface WorkshopInstalledRecord {
  version: string;
  installedAt: string;
  /** 装机前同 id 的旧版。`null` = 全新安装。 */
  previousVersion: string | null;
}

/** 记住一次成功装机（写状态文件；不触碰 ModuleHost 的任何存档）。 */
export async function rememberInstalled(
  root: string,
  moduleId: string,
  workspaceDir: string | null,
  record: WorkshopInstalledRecord,
): Promise<ExtensionWorkshopState> {
  const next: ExtensionWorkshopState = {
    version: 1,
    moduleId,
    attempts: 0,
    status: "installed",
    installed: {
      version: record.version,
      previousVersion: record.previousVersion,
      installedAt: record.installedAt,
      workspaceDir,
    },
    lastError: null,
    updatedAt: record.installedAt,
  };
  await writeWorkshopState(root, next);
  return next;
}

/** 卸载后把状态标成 `rolledBack`（幂等；状态不存在是 no-op）。 */
export async function markRolledBack(root: string, moduleId: string): Promise<ExtensionWorkshopState | null> {
  const previous = await readWorkshopState(root, moduleId);
  if (!previous) return null;
  const next: ExtensionWorkshopState = {
    ...previous,
    status: "rolledBack",
    installed: previous.installed
      ? { ...previous.installed, rolledBackAt: new Date().toISOString() }
      : null,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkshopState(root, next);
  return next;
}

/** 宿主目录里一个已装用户模块的最小事实（`ModuleCatalog.modules` 的投影）。 */
export interface InstalledModuleFact {
  id: string;
  version: string;
}

/**
 * 【T20】**对账** —— 工坊状态 vs 宿主目录。以**宿主目录为准**（它是安装事实的来源）。
 *
 *  - 模块在宿主里存在，且工坊记录缺失 / 版本旧 → 记一次 `installed`（保留上一版号做
 *    可回滚点）；
 *  - 模块**不在**宿主里而工坊记着已装 → 用户卸载了 → 标 `rolledBack` 并**删草稿目录**
 *    （卸载后无残留）；
 *  - `rolledBack` 但草稿目录还在（上次清理失败）→ 再删一次。
 *
 * 只处理**工坊自己记录过的**模块（有 `state.json` 的目录）—— 用户从别处装的扩展不归
 * 工坊管，不凭空造记录。任何一步失败写进 `errors`，不静默吞。
 */
export async function reconcileWorkshopStates(
  root: string,
  installed: ReadonlyArray<InstalledModuleFact>,
): Promise<{ applied: string[]; errors: string[] }> {
  const applied: string[] = [];
  const errors: string[] = [];
  const { states } = listWorkshopStates(root);
  const byId = new Map(installed.map((module) => [module.id, module]));
  for (const state of states) {
    const live = byId.get(state.moduleId);
    try {
      if (live) {
        const sameVersion = state.installed !== null && state.installed.version === live.version;
        if (!sameVersion || state.status !== "installed") {
          await rememberInstalled(root, state.moduleId, draftDirExistsSync(root, state.moduleId) ? draftDirOf(root, state.moduleId) : null, {
            version: live.version,
            installedAt: new Date().toISOString(),
            previousVersion: state.installed?.version ?? null,
          });
          applied.push(state.moduleId);
        }
      } else if (state.status === "installed") {
        await markRolledBack(root, state.moduleId);
        await rm(draftDirOf(root, state.moduleId), { recursive: true, force: true });
        applied.push(state.moduleId);
      } else if (state.status === "rolledBack" && draftDirExistsSync(root, state.moduleId)) {
        await rm(draftDirOf(root, state.moduleId), { recursive: true, force: true });
        applied.push(state.moduleId);
      }
    } catch (error) {
      errors.push(`${state.moduleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { applied, errors };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【T20】只读出口（工具面 / 渲染端共用）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 工坊目录的**只读清单**：扫 `<工坊根>/<id>/state.json`，返回每个模块的会话状态。
 * 只读、不建目录、不跟随符号链接；坏档不会让整份清单失败，但会在 `broken` 里点名。
 */
export interface WorkshopStateListing {
  states: ExtensionWorkshopState[];
  broken: string[];
}

export function listWorkshopStates(root: string): WorkshopStateListing {
  const states: ExtensionWorkshopState[] = [];
  const broken: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { states, broken };
  }
  for (const name of names) {
    const path = join(moduleDirOf(root, name), WORKSHOP_STATE_FILE);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const parsed = ExtensionWorkshopStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) states.push(parsed.data);
      else broken.push(name);
    } catch (error) {
      // 目录里没有 state.json 的（例如只是下载/手工放的目录）不算坏档。
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") broken.push(name);
    }
  }
  states.sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return { states, broken };
}

/** 工坊状态的一行只读投影：**以宿主目录为准**叠加「现在到底装没装」。 */
export interface WorkshopStatusEntry {
  moduleId: string;
  /** 叠加后的状态：宿主里有这个模块 → `installed`；状态说装过但宿主里没了 → `rolledBack`。 */
  status: ExtensionWorkshopStatus;
  attempts: number;
  /** 宿主目录里的当前版本（没装 = null）。 */
  installedVersion: string | null;
  /** 可回滚点（工坊记录的上一版）。 */
  rollbackPoint: { version: string; previousVersion: string | null; installedAt: string } | null;
  lastError: string | null;
  updatedAt: string;
}
export interface WorkshopStatusProjection {
  entries: WorkshopStatusEntry[];
  broken: string[];
  /** 宿主里已经没了、但草稿目录还在的模块 id（下次 `reconcileWorkshopStates` 会清理）。 */
  pendingRollbackCleanup: string[];
}

/** 纯只读投影 —— 不写盘、不建目录。工具 `extension_workshop_status` 用它。 */
export function projectWorkshopStatus(
  root: string,
  installed: ReadonlyArray<InstalledModuleFact>,
): WorkshopStatusProjection {
  const { states, broken } = listWorkshopStates(root);
  const byId = new Map(installed.map((module) => [module.id, module]));
  const entries: WorkshopStatusEntry[] = [];
  const pendingRollbackCleanup: string[] = [];
  for (const state of states) {
    const live = byId.get(state.moduleId);
    const status: ExtensionWorkshopStatus = live
      ? "installed"
      : state.status === "installed"
        ? "rolledBack"
        : state.status;
    if (!live && state.status === "installed" && draftDirExistsSync(root, state.moduleId)) {
      pendingRollbackCleanup.push(state.moduleId);
    }
    entries.push({
      moduleId: state.moduleId,
      status,
      attempts: state.attempts,
      installedVersion: live?.version ?? null,
      rollbackPoint: state.installed
        ? { version: state.installed.version, previousVersion: state.installed.previousVersion, installedAt: state.installed.installedAt }
        : null,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    });
  }
  return { entries, broken, pendingRollbackCleanup };
}

/** 读取一份已写好的草稿（诊断 / UI 用；不可用时返回 null，不抛）。 */
export async function readDraftFile(root: string, moduleId: string): Promise<ExtensionWorkshopDraft | null> {
  try {
    const parsed = ExtensionWorkshopDraftSchema.safeParse(JSON.parse(await readFile(join(draftDirOf(root, moduleId), WORKSHOP_DRAFT_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 清单指纹（与 ModuleHost 的指纹**不同**：这是工坊自己的展示摘要，不参与授权判定）。 */
export function workshopFingerprint(manifest: ModuleManifest): string {
  return createHash("sha256").update(JSON.stringify([manifest.id, manifest.version, [...manifest.permissions].sort()])).digest("hex").slice(0, 16);
}

/** 草稿目录绝对路径（测试 / UI 定位用）。 */
export function workshopDraftDir(root: string, moduleId: string): string {
  return resolve(draftDirOf(root, moduleId));
}

/** 一份只读的工坊回执摘要（给 AI 的回执文本用；不写盘、不授权）。 */
export function summarizeWorkshopReport(report: ExtensionWorkshopReport): string {
  const lines: string[] = [];
  lines.push(report.ok ? "可以安装（还差用户确认）" : `未通过（阶段：${report.stage}）`);
  if (report.permissions.length > 0) lines.push("申请的权限：");
  for (const permission of report.permissions) lines.push("  - " + permission);
  if (report.issues.length > 0) lines.push("问题：");
  for (const issue of report.issues) lines.push("  - " + issue);
  if (report.warnings.length > 0) lines.push("提醒：");
  for (const warning of report.warnings) lines.push("  - " + warning);
  return lines.join("\n");
}

/** 重新导出，让调用方不必从两个包各 import 一次（`z` 形状只在契约里定义一次）。 */
export { ExtensionWorkshopDraftSchema, ExtensionWorkshopStateSchema };
