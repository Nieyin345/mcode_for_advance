/**
 * **领域结果解码(MC-066)** —— 把「RPC 的原始返回」解码成「业务到底成没成」,而不是把
 * 「Promise resolve 了」当成「操作成功」。
 *
 * ## 它在补哪个洞(源码可确认的旧行为)
 *
 * `callRpc` 只要 Promise 正常 resolve,就 `makeOp(「SUCCEEDED」)`。可若干 IPC **合法返回**
 * 业务拒绝、不抛异常 —— 例如 `ipc/browser.ts` 的 `browser:create` 对未知 `projectPath`
 * 返回 `{ok:false,error:「未知项目路径,拒绝创建浏览器」}`。于是业务明确拒绝,`app_api_call`
 * 却向 Agent 报 `SUCCEEDED`(isError=false),Agent 以为浏览器已创建。
 *
 * ## 判据不能靠猜
 *
 * 不同 IPC 的合法返回有 void、数据对象、`{ok:true|false}`、判别联合等多种语义。**不在任意
 * JSON 上做字符串规则推断** —— 每个可由 Agent 调用的方法族在**这里显式登记**它的结果合同
 * (okError 家族 + ok:false 的语义),没登记的方法按「返回即成功」处理(void / 数据结果)。
 */
import type { OperationResultKind } from "@contracts/appControl";
import { OP_CODE } from "@contracts/appControl";
import { policyFor } from "./policy.js";

/** 领域结果的三种判定。 */
export type DomainOutcome =
  /** 业务已接受 / 已落定(含「后台已接收执行」)。 */
  | { kind: "accepted" }
  /** 业务**明确拒绝**,命令没执行(无副作用)→ REJECTED。 */
  | { kind: "rejected"; reason: string; code: string }
  /** 可能已**部分提交**,无法确认 → UNCERTAIN(绝不默认安全重试)。 */
  | { kind: "partial"; reason: string; code: string };

/**
 * 一个方法(或方法族)的结果合同。`falseMeans` 说明 `ok:false` 的权威语义:
 *   - `refusal` —— 一定是「没执行」的明确拒绝(如未知项目路径);
 *   - `maybePartial` —— 副作用可能已部分落定(重试前必须先查真实状态)。
 */
export interface CommandOutcomeDescriptor {
  falseMeans: "refusal" | "maybePartial";
}

/** 按**精确方法名**登记的结果合同(逐个显式,不靠前缀猜)。 */
const EXACT = new Map<string, CommandOutcomeDescriptor>([
  // 内置浏览器:`{ok:true;browserId}|{ok:false;error}` 判别联合。ok:false 一律是**执行之前**
  // 的拒绝(未知项目路径 / 参数解析失败 / 找不到 browserId)—— 没有浏览器被建出来。
  ["browser.create", { falseMeans: "refusal" }],
  ["browser.loadUrl", { falseMeans: "refusal" }],
  ["browser.goBack", { falseMeans: "refusal" }],
  ["browser.goForward", { falseMeans: "refusal" }],
  ["browser.reload", { falseMeans: "refusal" }],
  ["browser.setBounds", { falseMeans: "refusal" }],
  ["browser.setPickMode", { falseMeans: "refusal" }],
  ["browser.show", { falseMeans: "refusal" }],
  ["browser.hide", { falseMeans: "refusal" }],
  ["browser.close", { falseMeans: "refusal" }],
  ["browser.bookmarkAdd", { falseMeans: "refusal" }],
  ["browser.bookmarkRemove", { falseMeans: "refusal" }],
  ["browser.setDevice", { falseMeans: "refusal" }],
  ["browser.clearCache", { falseMeans: "refusal" }],
  ["browser.clearCookies", { falseMeans: "refusal" }],
  ["browser.historyRemove", { falseMeans: "refusal" }],
  ["browser.historyClear", { falseMeans: "refusal" }],
  ["browser.downloadAction", { falseMeans: "refusal" }],
  // 自动化立即运行:`AutomationRunResult` 形如 `{ok:false;error}` —— ok:false 表示触发器
  // 找不到 / 还没存过(见 orchestration.ts),没有运行被起。
  ["automation.run", { falseMeans: "refusal" }],
  // 自定义模型试连:`{ok:boolean;error?;detail?}` —— ok:false 是握手/鉴权失败的探测结果,
  // 只读探测、不落任何持久副作用。
  ["customModel.test", { falseMeans: "refusal" }],
  /* ── 【MC-066 / 第 46.1 节】Git 域 ───────────────────────────────────────
   *
   * `git.*` 的写操作都返回 `GitOpResult`/`GitMergeResult` 形如 `{ok:false;error}`
   * —— 从前**没登记**,于是 `decodeDomainOutcome` 落到「无 descriptor = accepted」,
   * 把「仓库不属于任何已添加项目」这种**合法拒绝**报成 SUCCEEDED(第 45 轮 §46.1 的 E1)。
   *
   * 分类:纯本地、失败即"没执行"的写 → `refusal`;而 push / pull / merge /
   * worktreeMergeBack 的 ok:false 可能**已经在远端或工作树里落了一部分**(推送一半、
   * 合并冲突未清、worktree 已污染),重试前必须先查真实状态 → `maybePartial`(UNCERTAIN)。
   * 这样"没执行"的拒绝被如实报 REJECTED,"可能部分落定"的不被当安全可重试。 */
  ["git.stage", { falseMeans: "refusal" }],
  ["git.unstage", { falseMeans: "refusal" }],
  ["git.commit", { falseMeans: "refusal" }],
  ["git.discard", { falseMeans: "refusal" }],
  ["git.checkout", { falseMeans: "refusal" }],
  ["git.deleteBranch", { falseMeans: "refusal" }],
  ["git.mergeAbort", { falseMeans: "maybePartial" }],
  ["git.mergePreview", { falseMeans: "refusal" }],
  ["git.push", { falseMeans: "maybePartial" }],
  ["git.pull", { falseMeans: "maybePartial" }],
  ["git.merge", { falseMeans: "maybePartial" }],
  ["git.worktreeMergeBack", { falseMeans: "maybePartial" }],
  ["git.worktreeRemove", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① / §5.6】terminal / relay 域 ─────────────────────────
   *
   * `ipc/terminal.ts` 的 `terminal:create` 对未知项目路径 / cwd 越界、`terminal:write` /
   * `terminal:resize` 对不存在或已退出的终端,都**合法返回** `{ok:false,error}`(不抛异常)
   * —— 从前**没登记**,`decodeDomainOutcome` 落到「无 descriptor = accepted」,把业务拒绝
   * 报成 SUCCEEDED,Agent 以为终端已建 / 命令已写入。全是本地进程操作、失败即"没执行"
   * → `refusal`。**按方法逐个登记**(不用 `terminal.` 前缀族:`terminal.list` 返回的是
   * `{terminals}` 数据对象、不是 ok/error 信封,前缀族会把它误判成 UNCERTAIN)。
   *
   * `ipc/relay.ts`:`relay.saveConfig` 的 ok:false 是 zod 解析失败、没写任何设置 → `refusal`;
   * `relay.connect` 的 ok:false 可能是**握手前的拒绝**(没配置 / 缺指纹 / 移动端没起),
   * 也可能是**已建 SSH、forwarder 已部署、forwardIn 失败**之后才返回——后者可能已经在
   * VPS 上落了部分内容,重试不保证安全 → `maybePartial`(UNCERTAIN,绝不默认可安全重试)。
   * (`setting.exportToFile`/`importFromFile` 同形,但被 `policy.ts` 钉在 blocked、
   * agent 经 `app_api_call` 到不了,不登记。) */
  ["terminal.create", { falseMeans: "refusal" }],
  ["terminal.write", { falseMeans: "refusal" }],
  ["terminal.resize", { falseMeans: "refusal" }],
  ["relay.saveConfig", { falseMeans: "refusal" }],
  ["relay.connect", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① 续】memory 域 ────────────────────────────────────────
   *
   * `ipc/memory.ts` 的 `memory:save` / `memory:delete` / `memory:reviewDelete` 的
   * `{ok:false,error}` 都是**写盘前的拒绝**:save 的 `{}` 是路径非法 / 含疑似密钥 /
   * revision 冲突(冲突时**还没写**,文件保持原样)、`mkdir(wx)` 撞 EEXIST(别人先建了);
   * delete 是 revision 缺失/不匹配(删前先 `assertRevision`,不匹配就抛,**没删**);
   * reviewDelete 是"记忆不存在"或"内容指纹已变"(同样在 delete 之前返回)。
   * 三者都**没提交任何副作用** → `refusal`(失败即"没执行",可安全重试)。 */
  ["memory.save", { falseMeans: "refusal" }],
  ["memory.delete", { falseMeans: "refusal" }],
  ["memory.reviewDelete", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】library 只读域 ────────────────────────────────────
   *
   * `library.readMarkdown` / `library.readPdf` 是**纯读**:ok:false(条目不存在 /
   * 没有转换产物 / 文件不在了)不改任何东西 → `refusal`。**只登记这两条只读**:
   * `library.writeNote`/`adoptMarkdown`/`saveHighlights` 等**写**类同形但语义要逐条
   * 核实是否可能部分提交,留待各自纵向切片。 */
  ["library.readMarkdown", { falseMeans: "refusal" }],
  ["library.readPdf", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】engineTools 域 ──────────────────────────────────
   *
   * `engineTools.set` 的 ok:false 是 zod 校验失败(没写)或 `writeEngineToolPolicy`
   * 抛错 —— 那条走 `atomicWriteJson`(`writeFileSync` 临时名 + `renameSync`),写不成时
   * 目标文件保持原样、**没有半套** → `refusal`。 */
  ["engineTools.set", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】file 域 ──────────────────────────────────────────
   *
   * `ipc/files.ts` 的 file 写操作都返回裸 `{ok:boolean}`(没有 error 字段),ok:false
   * 既可能是「root 守卫拒绝」(在任何动作之前),也可能是 catch 到写入抛错。**逐条按
   * 最坏情况分类**:
   *   - `file.writeFile`:落盘走单次 `fs.writeFile`(**非原子**)—— 写到一半失败可能把目标
   *     截断 → `maybePartial`;
   *   - `file.mkdir`:`mkdir recursive` 建到一半失败可能留下部分父目录 → `maybePartial`;
   *   - `file.copy`:`copyFile`(**非原子**)中途失败可能留下半截目标 → `maybePartial`;
   *   - `file.rename`:`fs.rename` **原子**(同卷成功/失败二选一,跨卷 EXDEV 直接抛、不动),
   *     守卫拒绝也在动作之前 → `refusal`。 */
  ["file.writeFile", { falseMeans: "maybePartial" }],
  ["file.mkdir", { falseMeans: "maybePartial" }],
  ["file.copy", { falseMeans: "maybePartial" }],
  ["file.rename", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】git.generateCommitMessage ────────────────────────
   *
   * 这条是**纯计算**(让模型从 staged diff 生成一句提交信息),ok:false(模型没返回
   * 有效内容 / 认证失败 / 网关无渠道)不改仓库、不提交任何东西 → `refusal`。 */
  ["git.generateCommitMessage", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】workflow 域 ───────────────────────────────────────
   *
   * `ipc/orchestration.ts` 的工作流 handler 逐方法读(handler 很薄,判据落到
   * `main/orchestration/library.ts` / `runner.ts` 的被调函数):
   *
   *  `workflow.save` → `saveWorkflow`:三条 ok:false(结构化校验不过 / `deriveTrigger`
   *   失败 / expectedRevision 不是当前版)全都发生在 `WorkflowRepo.save` **之前**
   *   —— 库里一个字节没动 → `refusal`。
   *  `workflow.import` / `workflow.importFromFile` → `finishImport(importWorkflowInto)`:
   *   ok:false(文本解析失败 / 要覆盖的 id 不在库里 / `saveWorkflow` 拒绝 / 选文件被
   *   取消 / 读文件失败)同样都在任何落库**之前** → `refusal`。import 能进来的东西必须
   *   是当初存得下去的(同一道 `saveWorkflow` 闸),那道闸的失败也是写前拒绝。
   *  `workflow.pinDefault` → `pinWorkflowDefault`:ok:false("找不到" / "还在等审阅")
   *   在 `SettingRepo.set` 之前 → `refusal`。
   *  `workflow.restoreDefault` → `restoreWorkflowDefault`:ok:false 只有"没钉过默认"
   *   一种,在 `WorkflowRepo.save` 之前 → `refusal`。
   *  `workflow.retry` → `resolveWorkflowRetry`:全部 `{ok:false}`(会话不在 / 正有运行在跑 /
   *   存档读不回 / 换过工作流 / 续跑被拦)都 return 在 `launchContinuation` **之前**
   *   —— 没有运行被起 → `refusal`。
   *  `workflow.applyShippedUpdate` / `workflow.dismissShippedUpdate`:ok:false("不是自带
   *   的" / "已经删了")在 `WorkflowRepo.save` / `markShippedRevision` 之前 → `refusal`。
   *
   *  **不登记 `workflow.remove`**:`removeWorkflow` 恒返回 `{ok:true,wasBuiltin:false}`,
   *  根本没有 ok:false 分支可被误报(没有"合法拒绝被报成成功"的洞)。**不登记
   *  `workflow.export` 为 refusal**:它有三条 ok:false —— 找不到 id / 用户取消(**这两条是
   *  写前拒绝**)、以及 `writeFile` 落盘失败。最后那条走的是**非原子** `fs.writeFile`
   *  (先截断再写),失败时目标文件可能已被截断成半截 → 不能当"没执行",故整体
   *  `maybePartial`(UNCERTAIN,不默认可安全重试)。 */
  ["workflow.save", { falseMeans: "refusal" }],
  ["workflow.import", { falseMeans: "refusal" }],
  ["workflow.importFromFile", { falseMeans: "refusal" }],
  ["workflow.pinDefault", { falseMeans: "refusal" }],
  ["workflow.restoreDefault", { falseMeans: "refusal" }],
  ["workflow.retry", { falseMeans: "refusal" }],
  ["workflow.applyShippedUpdate", { falseMeans: "refusal" }],
  ["workflow.dismissShippedUpdate", { falseMeans: "refusal" }],
  ["workflow.export", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① 续】skills 预设域 ─────────────────────────────────────
   *
   * `ipc/skills.ts` 的 `skills.presetsSave` / `skills.presetsDelete` 共用
   * `writePresets`,而它走的是**非原子** `await fs.mkdir(...); await fs.writeFile(...)`
   * —— 中途失败(磁盘满 / 权限)会把 `.skill-presets.json` **截断成半截 JSON**,
   * 而不是保持原样。所以 ok:false 不能当"没写",整体 `maybePartial`(UNCERTAIN);
   * 与 `engineTools.set` 的 `atomicWriteJson`(临时名 + rename,失败时目标原样)不同。
   * (**只登记这两个**:`skills.save`/`delete`/`import` 等写类同形,但语义要逐条核实是否
   * 可能部分提交 —— 如 `skills.save` 会先 `fs.rename` 目录再写 SKILL.md,留待各自切片。) */
  ["skills.presetsSave", { falseMeans: "maybePartial" }],
  ["skills.presetsDelete", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① 续】extensionStore 域 ─────────────────────────────────
   *
   * `ipc/extensions.ts` 的四条,结果信封是 `{ok:true,…} | {ok:false;reason;limit?}`
   * (键值 `set` + 文件通道 `readFile`/`writeFile`/`listFiles`)。逐条读
   * `main/lib/extensionStore.ts` 的判据:
   *
   *  `extensionStore.set` → `writeValue`:ok:false 只有两种 —— id 非法、或整份存储超过
   *   `EXTENSION_STORE_MAX`(`withStoreValue` 返回 null)。两条都在 `persist`(唯一落盘点)
   *   **之前**,目标 `store.json` 一个字节没动 → `refusal`。
   *  `extensionStore.readFile` / `listFiles` 是**纯读**(`resolveInExtension` 传
   *   `createDir:false`,绝不建目录):ok:false(invalidPath / notFound / notAFile /
   *   notADir)不改任何东西 → `refusal`。
   *  `extensionStore.writeFile` → `writeFileInExtension`:ok:false 是 `tooLarge`(在
   *   `resolveInExtension` **之前**返回,没建任何目录)或 `notAFile`/`invalidPath`。
   *   `notAFile` 只可能在目标子目录**已存在**时出现 —— 那时扩展目录必然早已存在,
   *   `resolveInExtension` 的建目录分支不会触发;真正的落盘走 `atomicWrite`(临时名 +
   *   rename),写不成时是**抛异常**而非回 ok:false,所以 ok:false 从不等同于"写了半截"
   *   或"建了目录又失败"。三者都落在文件写入之前 → `refusal`。 */
  ["extensionStore.set", { falseMeans: "refusal" }],
  ["extensionStore.readFile", { falseMeans: "refusal" }],
  ["extensionStore.writeFile", { falseMeans: "refusal" }],
  ["extensionStore.listFiles", { falseMeans: "refusal" }],
]);

/** 按**方法族前缀**登记的结果合同(整个域共用同一形状时用)。 */
const FAMILIES: Array<{ prefix: string; descriptor: CommandOutcomeDescriptor }> = [
  // 整个 `browser.*` 域都返回 `BrowserOpResult` / 判别联合。
  { prefix: "browser.", descriptor: { falseMeans: "refusal" } },
];

/** 这个方法的 ok:false 语义描述符(没登记返回 undefined = 不是 ok/error 信封)。 */
export function outcomeDescriptor(method: string): CommandOutcomeDescriptor | undefined {
  const exact = EXACT.get(method);
  if (exact) return exact;
  return FAMILIES.find((f) => method.startsWith(f.prefix))?.descriptor;
}

/** 这个方法是不是「用 `{ok,error}` 信封表达业务结果」。 */
export function isEnvelopeMethod(method: string): boolean {
  return outcomeDescriptor(method) !== undefined;
}

/**
 * 严格判定:返回的对象是不是 `{ok: boolean, error?: unknown}` 信封。**逐字段查**,不做
 * 字符串规则推断 —— 只有显式登记过的方法才会走到这里,再补一层形状自证。
 */
function asEnvelope(raw: unknown): { ok: boolean; error?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ok !== "boolean") return null;
  return { ok: o.ok, error: typeof o.error === "string" ? o.error : undefined };
}

/**
 * 唯一入口:把原始 RPC 返回解码成 {@link DomainOutcome}。**RPC 未抛异常**时调用。
 *
 * - 显式登记为 ok/error 信封的方法:解析信封 → `ok:true` = accepted;`ok:false` 按
 *   `falseMeans` 落 REJECTED / UNCERTAIN;信封形状对不上(合同被违反) = `partial`
 *   (无法确认,保守标 UNCERTAIN,绝不默认成功)。
 * - 其余方法:返回即成功 = accepted(void / 数据对象都算)。
 */
export function decodeDomainOutcome(method: string, raw: unknown): DomainOutcome {
  const descriptor = outcomeDescriptor(method);
  if (!descriptor) return { kind: "accepted" };
  const envelope = asEnvelope(raw);
  if (!envelope) {
    // 登记过信封合同的方法却没回信封 —— 合同被违反,无法确认业务结果。
    return {
      kind: "partial",
      code: OP_CODE.rpcUncertain,
      reason: `${method} 的结果不符合它声明的 {ok,error} 合同,无法确认业务是否落定。`,
    };
  }
  if (envelope.ok) return { kind: "accepted" };
  const reason = envelope.error ?? `${method} 业务层拒绝了这次操作。`;
  if (descriptor.falseMeans === "maybePartial") {
    return { kind: "partial", code: OP_CODE.rpcUncertain, reason };
  }
  return { kind: "rejected", code: OP_CODE.domainRejected, reason };
}

/** 领域判定 → OperationResult 分类。 */
export function resultKindOfOutcome(outcome: DomainOutcome): OperationResultKind {
  switch (outcome.kind) {
    case "accepted":
      return "SUCCEEDED";
    case "rejected":
      return "REJECTED";
    case "partial":
      return "UNCERTAIN";
  }
}

/**
 * 副作用类别 —— 由**已收口的权限档**推导(read/ui = 只读;write/danger = 有副作用),
 * 不另立一套判据免得与 `policyFor` 漂开。blocked 走不到执行,按只读对待。
 */
export function sideEffectClassOf(method: string): "readonly" | "mutating" {
  const level = policyFor(method).level;
  return level === "write" || level === "danger" ? "mutating" : "readonly";
}
