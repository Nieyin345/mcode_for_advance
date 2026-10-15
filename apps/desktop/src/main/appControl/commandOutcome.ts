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
import type { OperationResultKind, OperationWarning } from "@contracts/appControl";
import { OP_CODE, OP_WARNING_IMPORT_PARTIAL_FAILED } from "@contracts/appControl";
import { moduleRefusal } from "@contracts/modules";
import { policyFor, type AppPolicyLevel } from "./policy.js";

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
   *   - `file.writeFile`:落盘走**原子替换**(`ipc/files.ts` 的 `atomicReplaceFile`:临时文件
   *     → `fsync` → `rename`),并整段由 `withOsFileLease` 串行、提交点走 CAS —— 不存在
   *     "单次 `fs.writeFile` 写到一半把目标截断"这回事。仍归 `maybePartial` 是因为 ok:false
   *     可能落在**提交点之后**(租约内 CAS 失败),保守分类不诱导盲目重试;
   *   - `file.mkdir`:`mkdir recursive` 建到一半失败可能留下部分父目录 → `maybePartial`;
   *   - `file.copy`:`copyFile`(**非原子**,未走 `atomicReplaceFile`)中途失败可能留下半截
   *     目标 → `maybePartial`;
   *   - `file.rename`:`fs.rename` **原子**(同卷成功/失败二选一,跨卷 EXDEV 直接抛、不动),
   *     守卫拒绝也在动作之前 → `refusal`。 */
  ["file.writeFile", { falseMeans: "maybePartial" }],
  ["file.mkdir", { falseMeans: "maybePartial" }],
  ["file.copy", { falseMeans: "maybePartial" }],
  ["file.rename", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】automation.watch ─────────────────────────────────
   *
   * `automationRunner.startWatch` 的 `{ok:false,error}` 全是**起跑前的拒绝**:发起会话/
   * 项目不在了、上一次守望还在跑、内置模板没了、模板缺节点;唯一在 saveWorkflow 之后的
   * `!saved.ok` 也是**写前拒绝**(saveWorkflow 原子,其 ok:false 在落库之前)→ `refusal`。
   *
   * 同批**确认无需登记**的:`git.cancelGenerateCommitMessage` **恒返回 `{ok:true}`**(没有任何
   * ok:false 分支);`mcp.*` 除 `mcp.list`(返回 `{servers}` 数据对象、不是 ok/error 信封)
   * 外**全部被 policy 钉 BLOCKED**,agent 到不了。 */
  ["automation.watch", { falseMeans: "refusal" }],
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
  // agent profile 的存/删:save 走 temp + renameSync(**原子**)、validate 失败在写前;
  // remove 是 `rmSync`(删不掉就报错,没删成)。都不留半套 → refusal。
  // (`workflow.remove` 恒返回 `{ok:true,wasBuiltin:false}`,没有 ok:false 分支,不登记。)
  ["workflow.saveAgentProfile", { falseMeans: "refusal" }],
  ["workflow.removeAgentProfile", { falseMeans: "refusal" }],
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
  // `skills.enginesSetBulk` 走 `writeEnginesMap` → `atomicWrite`(temp + rename,失败时
  // 目标原样),抛错即"没写" → refusal。与上面的 presets 非原子写相反。
  ["skills.enginesSetBulk", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】onlyoffice 域 ─────────────────────────────────────
   *
   * `onlyoffice.forceSave`:`forceSave(sessionKey)` 的 `{ok:false,error}` 里有一条是
   * **已经向 DS 发出 forcesave 命令之后**才失败(HTTP 非 2xx / 命令被拒 / 等本地回写超时)——
   * 远端文档可能已经落了一部分,重试前要先查真实状态 → `maybePartial`(UNCERTAIN)。
   * `onlyoffice.close`:`closeSession` 返回 false 只表示「session 不存在」(没碰到任何东西)
   * → `refusal`。 */
  ["onlyoffice.forceSave", { falseMeans: "maybePartial" }],
  ["onlyoffice.close", { falseMeans: "refusal" }],
  /* ── 【MC-066 残余① 续】skills 写类域 ────────────────────────────────────
   *
   * `ipc/skills.ts` 的写类 handler 合法返回 `{ok:false,…}`(不抛异常),从前**没登记**
   * —— `decodeDomainOutcome` 落到「无 descriptor = accepted」,把「同名目录已占用 /
   * 技能不存在 / 仓库里一个技能都没导入 / 矩阵写不进去」这类**合法拒绝**报成 SUCCEEDED。
   * (先 grep `policy.ts` 确认可达:这些方法落在 DANGER/write 档、**无一条 BLOCKED** ——
   * danger 只是"每次弹卡",不是 blocked,`app_api_call` 到得了。)
   *
   * 逐条读 handler 源码判 `falseMeans`:
   *   - `skills.save`:`ok:false` 既有**写前拒绝**(项目路径无效 / 路径非法 / 同名目录已
   *     占用 / 新名占用),也有**已落一半**的情形 —— 无 `newName` 时先
   *     `fs.mkdir(targetDir,{recursive})` 建目录、再 `fs.writeFile(SKILL.md)`,建了目录而
   *     写文件失败会留一个**空技能目录**;有 `newName` 时**先 `fs.rename` 目录再写文件**,
   *     rename 成而 write 败则目录已挪走、内容是旧的 → 按最坏情况 `maybePartial`。
   *   - `skills.delete`:真删走 `fs.rm(skillDir,{recursive:true})`(递归、**非原子**)——
   *     中途失败可能已删掉一部分子项,不是"一个都没删" → `maybePartial`。
   *   - `skills.importGithub`:ok:false 的「一个技能都没导入(重名与非法名除外)」分支可在
   *     **某次 `fs.cp` 半成**(目标目录留了半截、`imported` 数组却仍为空)之后到达,且
   *     `.git` 过滤 + 逐目录 cp 本身非原子 → `maybePartial`。
   *   - `skills.engines.set`:写矩阵走 `writeEnginesMap` → `atomicWrite`(temp + rename,
   *     失败时目标保持原样),抛错即"没写" → `refusal`(与 `enginesSetBulk` 同款)。
   *
   * **本切片不登记**:`skills.import` / `skills.copyToProject` —— 它们返回的是聚合结果
   * (`{imported,skipped,errors}` / `{copied,skipped,failed}`),**没有 `ok` 字段**、
   * **不是 ok/error 信封**;登进来反而会把每次成功也判成 UNCERTAIN(合同被违反)。
   * 这两条判据在 `app-control-smoke` §3d-8 里被固化成断言(漏登 > 错登)。 */
  ["skills.save", { falseMeans: "maybePartial" }],
  ["skills.delete", { falseMeans: "maybePartial" }],
  ["skills.importGithub", { falseMeans: "maybePartial" }],
  ["skills.engines.set", { falseMeans: "refusal" }],
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
  /* ── 【MC-066 残余① 续】library 写类域 ────────────────────────────────────
   *
   * `ipc/library.ts` 的写类 handler 返回 `{ok:false,…}` 信封(不抛异常),从前**没登记**
   * —— `decodeDomainOutcome` 落到「无 descriptor = accepted」,把「找不到这篇笔记 /
   * 路径越界 / 分类已经不在了 / 这个位置不允许写入」这类**合法拒绝**报成 SUCCEEDED,
   * Agent 以为文件已写 / 关联已删 / 分类已移。逐条读 `main/library/*.ts` 的判据:
   *
   *  `library.writeNote` → `notesImport.writeNote`:四条 ok:false(找不到笔记 / 没有
   *   mdPath / **路径越界**(`isInsideLibrary` 守卫,刻意排在编辑权那道之前)/ 不是本条
   *   目自己的笔记文件)全在 `atomicWrite` **之前**;写入那一步是 `atomicWrite`(临时名 +
   *   rename,与 `engineTools.set` 的 `atomicWriteJson` 同款),写不成时目标保持原样 →
   *   `refusal`。
   *  `library.saveHighlights` → handler 先过两道守卫(路径不在已知工作区/库内 → 拒绝;
   *   文件不存在 → 拒绝),再 `writeHighlights`(纯临时名 + rename 的**原子**替换);
   *   两条拒绝都在写之前,失败时目标一个字节不动 → `refusal`。
   *  `library.linkRemove` → `LibraryLinkRepo.remove`:ok:false 只有一种 —— 关联 id 不存在
   *   (在 `DELETE` 之前 `SELECT` 判不存在就返回 false),没删任何行 → `refusal`。
   *   (它回的信封**只有 `{ok:false}`,没有 `error` 字段** —— 判定仍成立:见 `asEnvelope`
   *   只要求 `ok` 是布尔。)
   *  `library.groupsSave` → `groupRegistry.saveLibraryGroups`:ok:false 是
   *   `parseLibraryGroupsJson` 校验失败,发生在 `SettingRepo.set` **之前** → `refusal`。
   *  `library.suppressSave` → `suppress.saveSuppress`:同形,`parseSuppressJson` 失败在
   *   `SettingRepo.set` 之前 → `refusal`。
   *  `library.moveCollection` → `CollectionRepo.move`:全部 ok:false(分类已经不在了 /
   *   目标分类不在了 / 移到它自己下 / 移到自己的子分类下 / 目标位置重名)都发生在
   *   `BEGIN`/`UPDATE library_collections` **之前** —— 库里一个字节没动 → `refusal`。
   *  `library.adoptMarkdown` → `adoptMarkdownFile`:整包替换是**多步 rename**(拷暂存 →
   *   老包挪退路 → 暂存换上去)。ok:false 里有一条发生在**老包已被挪走、新包又没换上去、
   *   退路也挪不回原位**之后 —— 那时条目落点里的内容已被移走/错位,可能**已落了一部分**
   *   → `maybePartial`(UNCERTAIN,绝不默认可安全重试)。
   *  `library.attachToChat` → `manifest.attachToChat`:可达的拒绝里,抑制 / 回收站 /
   *   无法识别的键 / 找不到对象都在**写清单之前**;但**清单文件(`writeItemManifest` 的
   *   `writeFileSync`)先落盘**,之后 `pushAttach` 推 `composer:attach` 失败也会回
   *   `{ok:false, error:「窗口没开着,挂不上去」}` —— ok:false 时清单文件可能已经写了
   *   → `maybePartial`(不默认可安全重试)。
   *
   *  **本切片不登记(留待各自纵向切片 / 不适用)**:`library.writeHighlights`(写回 PDF
   *   本身,带干净底稿备份 + 原子替换的**多步**流程,ok:false 可能在底稿已存/文件已换之后,
   *   语义要单独核实);`library.deleteItems`(恒返回 `{items,failed}`,靠 `failed` 数组而
   *   非 ok:false 表达"哪几份没删成",**没有 ok:false 信封**);`library.convert` 等同形家族。 */
  ["library.writeNote", { falseMeans: "refusal" }],
  ["library.saveHighlights", { falseMeans: "refusal" }],
  ["library.linkRemove", { falseMeans: "refusal" }],
  ["library.groupsSave", { falseMeans: "refusal" }],
  ["library.suppressSave", { falseMeans: "refusal" }],
  ["library.moveCollection", { falseMeans: "refusal" }],
  ["library.adoptMarkdown", { falseMeans: "maybePartial" }],
  ["library.attachToChat", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① 续】skills 市场域 ────────────────────────────────────
   *
   * `ipc/skills.ts` 的 `skills:marketAdd/Remove/Refresh/Install` 落到
   * `main/lib/skillMarket.ts`,返回 `{ok:false,error}` 信封(Install 另带
   * `imported/skipped/errors` 聚合字段,但**有 `ok`**,仍是信封)。先 grep `policy.ts`
   * 确认可达:Add/Remove/Refresh/Install 都在 DANGER 档、**无一条 BLOCKED**(danger
   * 只是每次弹卡,不是 blocked)—— `app_api_call` 到得了。逐条读源码判:
   *
   *  `skills.marketAdd` → `addSkillMarket`:ok:false 前一半是**写前拒绝**(仓库地址
   *   不可识别 / 仓库或目录已在市场里 / 名称非法 / 同名已存在),但**后一半在副作用之后**:
   *   `fetchGitCatalog` 已把 catalog **落到 `skillMarketsRoot()/<name>`**(promote 是
   *   换目录,非原子语义),之后 `scanCatalog`/`writeRecords` 抛错也会回 ok:false ——
   *   那时 catalog 目录已留在盘上。按最坏情况 `maybePartial`(UNCERTAIN)。
   *  `skills.marketRemove` → `removeSkillMarket`:ok:false **只有**「市场不存在」/「内置
   *   市场不能移除」两条(都在 `writeRecords` 之前),而唯一的落盘点 `writeRecords` 走
   *   **temp + rename 原子**替换(写不成时 `markets.json` 一个字节不动),其后的
   *   `fs.rm` 也只 `.catch(()=>{})` 吞错 —— ok:false 时**没删任何东西** → `refusal`。
   *  `skills.marketRefresh` → `refreshSkillMarket`:git 分支先 `fetchGitCatalog`(把新
   *   catalog **换到盘上**、替换旧目录),**再** `writeRecords` 记 fetchedAt —— 后者抛错
   *   时 catalog 已经换过 → `maybePartial`(与 add 同款)。
   *  `skills.marketInstall` → `installSkillsFromMarket`:本地市场走 `fs.cp(dir,dest,
   *   {recursive})`(**非原子**),某次 cp 半成会留下**半截 dest 目录**,而 `imported`
   *   仍为空——此时 `ok = imported.length>0||skipped.length>0` 仍可回 false → `maybePartial`。
   *
   *  **本切片不登记** `skills.marketList`:它返回 `{markets:[...]}` 数据对象、**没有 `ok`
   *  字段**,不是 ok/error 信封;登进来会把每次成功也判成 UNCERTAIN(合同被违反)。
   *  判据在 `app-control-smoke` §3d-10 里固化成断言(漏登 > 错登)。 */
  ["skills.marketAdd", { falseMeans: "maybePartial" }],
  ["skills.marketRemove", { falseMeans: "refusal" }],
  ["skills.marketRefresh", { falseMeans: "maybePartial" }],
  ["skills.marketInstall", { falseMeans: "maybePartial" }],
  /* ── 【MC-066 残余① 续】library.writeHighlights ──────────────────────────
   *
   * `library:writeHighlights` handler(`ipc/library.ts`)返回 `{ok,error}` / `{ok:true,
   * written,skipped}` 信封。前三条 ok:false(路径不在已知工作区/库内 / 文件不在了 /
   * bytes 空)都在**任何落盘之前**;但**写回 PDF 的多步流程**里,`ensureOriginal` 会先把
   * **干净底稿**(`.X.mcode-original.pdf`)**存到盘上**,再做**原子替换** PDF。原子替换失败
   * 时回 `{ok:false}`,而此刻**底稿已经落盘**(后续重烤会以它为源)—— 已有一个持久产物
   * → `maybePartial`(UNCERTAIN,绝不默认可安全重试)。(索引那一步失败只 `log.warn`、
   * 不改 `ok`,不构成 ok:false 分支。) */
  ["library.writeHighlights", { falseMeans: "maybePartial" }],
  /* ── 【MC-058】场景部署执行端派发到的两个 ok/error 信封方法 ─────────────────
   *
   * `appServices/sceneDeploy.ts` 的 `applyScene` 逐步 `callRpc` 到既有服务,并**复用本解码器**
   * (`decodeDomainOutcome`)判「这一步的业务到底成没成」—— `workflow.save` / `skills.save`
   * 上面已登记,但场景映射表里还有两个 kind 落到**没登记**的方法:`mcp` → `mcp.save`、
   * `hook` → `hooks.save`。没登记时本解码器回 `accepted`,于是「合法返回 ok:false」会被场景
   * 执行端记成 `done`(正是 MC-058 点名的那个洞)。逐条读源码登记,判据与已登记项同一取向:
   *
   *  `hooks.save` → `ipc/hooks.ts` 的 `saveHook`(`main/hooks/store.ts`)合法回
   *   `{ok:true} | {ok:false,error}`(不抛)。两条 ok:false:① `validateHook` 校验不过(在
   *   **任何写入之前**);② `commitHooks` → `writeRaw`,走**临时文件 + 同目录改名**(原子),
   *   写不动 / 改名失败时目标 `hooks.json` **一个字节没动**(整份重写,要么旧完整、要么新完整)。
   *   故 ok:false 恒等于"没写" → `refusal`。
   *
   *  `mcp.save` → `ipc/mcp.ts` 的 `MCP_SAVE` handler(不抛,`catch` 里回 `{ok:false,error}`)。
   *   两条显式 ok:false(保留名 `mcode-` 前缀 / 同名 server 已存在)都在**写真相层之前**;
   *   但 `catch` 支路可能出现在 `saveMcpManagement`(真相层已写)之后 —— `materializeMcpViewsOrRollback`
   *   失败会回滚,回滚本身再失败就只 `log.error`,此刻真相层可能已落了一半(引擎视图与真相层
   *   不一致)→ 不能当"没执行",按最坏情况 `maybePartial`(UNCERTAIN,绝不默认可安全重试)。
   *
   *  **不登记 `modules.install`**:`ModuleHost.install` 返回的是 `{modules,capabilities,workflowTargets}`
   *  目录对象(**没有 `ok` 字段**),失败靠**抛异常**表达(见 `main/modules/ModuleHost.ts`)——
   *  登进来会把每次成功也判成 UNCERTAIN(合同被违反)。抛异常已由调用端的 catch 支路处置。 */
  ["hooks.save", { falseMeans: "refusal" }],
  ["mcp.save", { falseMeans: "maybePartial" }],
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

/* ─────────────────── 聚合结果合同(MC-011)───────────────────
 *
 * ## 它在补哪个洞
 *
 * 一批**批量导入**方法返回的是**聚合结果**：
 *
 *   - `skills.import`          → `{ imported: string[], skipped, errors: [{name,error}] }`
 *   - `skills.copyToProject`   → `{ copied: string[], skipped: string[], failed: [{name,reason}] }`
 *   - `library.importFiles`    → `{ items, added, skipped, errors: [{path,error}], converted }`
 *   - `library.importNotes`    → `{ items, added, skipped, errors }`
 *   - `library.importGeneric`  → `{ items, added, skipped, errors, converted }`
 *
 * 它们**没有 `ok` 字段**、**不是 ok/error 信封**，所以从前 `decodeDomainOutcome` 落到
 * 「无 descriptor = accepted」 → agent 拿到的 `resultKind` 恒为 **SUCCEEDED**。可真相可能
 * 是「10 个路径全都不存在、一个都没导进去」—— 那条 `errors` 只在正文里，agent 会照
 * `SUCCEEDED` 向用户报「已导入」(README 最高原则 6)。这正是 `ok:false` 类洞，只是这两族
 * 的"失败"藏在**聚合数组**里，不在信封里。
 *
 * ## 为什么不登记进 `EXACT`
 *
 * 因为 `isEnvelopeMethod` 读的就是 `outcomeDescriptor`，把聚合方法登进去会让
 * `asEnvelope` 拿到一个没有 `ok` 的对象 → 判「合同被违反」→ 把**每次都成功的导入**
 * 判成 UNCERTAIN(错登 > 漏登)。`app-control-smoke` §3d-8 就钉着「`skills.import` 不是信封
 * 方法」。所以聚合合同**另立一张表**，判据**另走一个解析口**(`resolveOperationOutcome`),
 * 不动信封那条路。
 *
 * ## 判据:成功数组 + 失败数组,按两者**同时**为空/非空分档
 *
 * 各 handler 的字段名不同(`imported`/`copied`/`items`/`added`;`errors`/`failed`),但语义
 * 一致:一类是"真的成了的项",一类是"真的失败了的项"。**只按这两类的数量判**,
 * 不把 `skipped`(=重复/已存在,不是失败)算进去 —— `skipped` 是计数器,不是失败数组。
 *
 * - 成功非空、失败空   → accepted(完全成功);
 * - 成功非空、失败非空 → SUCCEEDED_WITH_WARNINGS(部分成功,**已提交**);
 * - 成功空、失败非空   → FAILED(全失败,**什么都没进库** —— 这才是要修的那条);
 * - 两者都空           → accepted(**一个都没输入**,等价于空批次 no-op,不算失败)。 */
interface AggregateDescriptor {
  /** 从返回值里取「成功项数」与「失败项数」。取不到(形状变了)就返回 null(= 不判,安全落 accepted)。 */
  tally: (raw: Record<string, unknown>) => { succeeded: number; failed: number } | null;
}

/** `imported`/`copied`/`items`/`added` 里**任意一个**是非空数组/正数,即"有成功项"。 */
function anyNonEmpty(list: unknown): boolean {
  if (Array.isArray(list)) return list.length > 0;
  if (typeof list === "number") return list > 0;
  return false;
}
function anyNonEmptyAmong(raw: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => anyNonEmpty(raw[k]));
}
function anyFailedAmong(raw: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => Array.isArray(raw[k]) && (raw[k] as unknown[]).length > 0);
}

const AGGREGATE = new Map<string, AggregateDescriptor>([
  ["skills.import", { tally: (r) => ({ succeeded: anyNonEmptyAmong(r, ["imported", "added"]) ? 1 : 0, failed: anyFailedAmong(r, ["errors"]) ? 1 : 0 }) }],
  ["skills.copyToProject", { tally: (r) => ({ succeeded: anyNonEmptyAmong(r, ["copied", "added"]) ? 1 : 0, failed: anyFailedAmong(r, ["failed"]) ? 1 : 0 }) }],
  ["library.importFiles", { tally: (r) => ({ succeeded: anyNonEmptyAmong(r, ["items", "added"]) ? 1 : 0, failed: anyFailedAmong(r, ["errors"]) ? 1 : 0 }) }],
  ["library.importNotes", { tally: (r) => ({ succeeded: anyNonEmptyAmong(r, ["items", "added"]) ? 1 : 0, failed: anyFailedAmong(r, ["errors"]) ? 1 : 0 }) }],
  ["library.importGeneric", { tally: (r) => ({ succeeded: anyNonEmptyAmong(r, ["items", "added"]) ? 1 : 0, failed: anyFailedAmong(r, ["errors"]) ? 1 : 0 }) }],
]);

/** 这个方法是不是「用聚合数组表达业务结果」(与信封合同互斥)。 */
export function isAggregateMethod(method: string): boolean {
  return AGGREGATE.has(method);
}

/**
 * **唯一的结果解析口** —— 信封合同与聚合合同都从这里进,消费点(`tools.ts` 的三处)只调
 * 这一个,不各自 recall 两张表。返回 `null` = 这个方法没有登记任何结果合同,"返回即成功"
 * (void / 数据对象)。
 *
 * 之所以不让消费点先试 `decodeDomainOutcome` 再补聚合:那样每个消费点都要记得补第二刀,
 * 而 MC-011 的教训正是"漏一刀就静默报成功"。
 */
export interface OperationOutcome {
  kind: "accepted" | "rejected" | "partial" | "succeededWithWarnings" | "failed";
  reason?: string;
  code?: string;
  warnings?: OperationWarning[];
}

export function resolveOperationOutcome(method: string, raw: unknown): OperationOutcome | null {
  if (AGGREGATE.has(method)) {
    const agg = AGGREGATE.get(method)!;
    if (!raw || typeof raw !== "object") return null; // 形状不符 → 不判(安全)
    const t = agg.tally(raw as Record<string, unknown>);
    if (!t) return null;
    if (t.failed === 0) return { kind: "accepted" };
    if (t.succeeded === 0) {
      return { kind: "failed", code: OP_CODE.domainRejected, reason: `${method}:全部失败,一项都没成功。` };
    }
    return {
      kind: "succeededWithWarnings",
      warnings: [
        {
          code: OP_WARNING_IMPORT_PARTIAL_FAILED,
          message: `${method}:部分成功,有失败项(成功的已入库,失败的见正文 errors)。`,
          retryable: false,
        },
      ],
    };
  }
  if (isEnvelopeMethod(method)) {
    const outcome = decodeDomainOutcome(method, raw);
    if (outcome.kind === "accepted") return { kind: "accepted" };
    return { kind: outcome.kind, code: outcome.code, reason: outcome.reason };
  }
  return null;
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

/** 统一结果判定(信封 + 聚合) → OperationResult 分类。 */
export function resultKindOfOperationOutcome(outcome: OperationOutcome): OperationResultKind {
  switch (outcome.kind) {
    case "accepted":
      return "SUCCEEDED";
    case "rejected":
      return "REJECTED";
    case "partial":
      return "UNCERTAIN";
    case "failed":
      return "FAILED";
    case "succeededWithWarnings":
      return "SUCCEEDED_WITH_WARNINGS";
  }
}

/** 从统一结果判定取 `makeOp` 的附加字段(code / reason / warnings),消费点共用一份。 */
export function opExtraFromOutcome(outcome: OperationOutcome): {
  code?: string;
  reason?: string;
  warnings?: OperationWarning[];
} {
  return {
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.warnings !== undefined ? { warnings: outcome.warnings } : {}),
  };
}

/**
 * 副作用类别 —— 由**已收口的权限档**推导(read/ui = 只读;write/danger = 有副作用),
 * 不另立一套判据免得与 `policyFor` 漂开。blocked 走不到执行,按只读对待。
 */
export function sideEffectClassOf(method: string): "readonly" | "mutating" {
  const level = policyFor(method).level;
  return level === "write" || level === "danger" ? "mutating" : "readonly";
}

/**
 * 【MC-060】一次**抛错**该归成哪一态 —— 两条结果分类路(agent 的 `app_api_call` 与面板的
 * `panelApiCall`)**共用这一份**,不各写一遍 `level === "write" || "danger"` 的前缀判断。
 *
 * 关键分叉:ModuleHost 在 `action` 执行点拒绝一个**没执行**的调用时,抛的是带 `moduleRefusal`
 * 标记的 Error(审批被拒 / 无审批通道 / 越权,见 `@contracts/modules`)。这类"命令根本没执行"
 * 必须落 **REJECTED**(可安全重来),**不能**被按权限档一律当 UNCERTAIN —— 那会把一次**安全
 * 可重来**的拒绝说成「先查真实状态、别重试」,正是 ARC-009 要消灭的那种误分类。其余抛错维持
 * 既有判据:只读/界面档 → FAILED(可安全重试);写/高风险档**可能已部分提交** → UNCERTAIN。
 */
export function thrownResultKind(error: unknown, level: AppPolicyLevel): OperationResultKind {
  if (moduleRefusal(error)) return "REJECTED";
  return level === "write" || level === "danger" ? "UNCERTAIN" : "FAILED";
}
