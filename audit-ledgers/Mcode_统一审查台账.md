# Mcode 统一审查台账

> 2026-10-13 合并快照，Git HEAD：`9a56f88f`。这是一份**可执行的统一台账**，不是本次重新跑了全部业务代码；双勾仍代表原条目在对应基线已通过其原定验收范围。
> 历史原件（逐字节保留、每份 SHA256）在 `archive/2026-10-13_premerge/`。**后续只维护本文件**，切勿在快照里更新已修复勾选。

## 1. 总览与优先级

- 具体问题 MC-001～102：**以下数量不再沿用合并快照的旧统计口径，当前状态以 §3 未关闭明细与 §6 逐编号索引为准**；MC-100/101 属同一顶层目标的发现层与三引擎执行层，不重复开发。原历史快照保持不变。
- 架构 ARC-001～017：**ARC-017 一项双勾，16 项仍待整体交付验收**。部分切片有测试不代表整个 ARC 通过。
- 交互 UI：UI-001 为开发完成但待独立复核；UI-002/003 双勾；UI-004～050 原始条目缺失，不能编造其数量、问题和状态。
- 体验 UXG-001～007：7 项仍为体验目标/待验收，不因 MC 已修复而自动通过。

**推荐顺序**：安全 W02 → 场景自主控制 W01 → durable 与异常恢复 W03 → SDK/扩展 W04/W05 → 自动化 W06 → 资料/体验 W07/W08。W09 是贯穿门禁。

## 2. 合并根因工作包

Wxx 是问题的**专题归并视图**，不新增 Bug，不重新编号。一个 MC 可与多个包关联，但同一条正式完成状态只维护一次。

### W01 · 目标到场景、CommandService 与自治部署（P0）

**目标**：目标→能力预检→方案及审批→部署→首次运行→回读/版本维护成为一条可复用业务路径，而非分别生成配置。

**尚需完成**：MC-058/059 仍开放；统一的主进程业务 CommandService、计划级 ActionContext、SceneSpec 编译部署、无窗操作和多入口回读均未整体验收。
**本会话追加（2026-10-13，本地开发 AI）**：
- `2026-10-13 | ARC-002 | DEV_CLAIM | E1 | SceneSpec 声明契约 + 确定性校验（P0 核心的第一片）：新建 @contracts/sceneSpec —— SceneSpec（schemaVersion/sceneId/goal/projectId/preferredProviderId/capabilities/resources/acceptance/lock）+ validateSceneSpec(raw) 纯函数。校验**一次报全**（schemaVersion/sceneId/goal/能力种类/资源 id 重复/依赖不存在的 id/依赖成环/验收期望回读的资源不在 resources）、**纯数据**（只挑已知字段，输入里偷塞的 apiKey/secret 不进 spec，形状上无密钥/绝对路径字段）。新增 scene-spec-smoke 24/24。变异：关掉环检测 → 红 2；把原始字段透传进 spec → 红 1 | remaining：这只是**声明 + 校验**这一层 —— ScenePlan 编译器、SceneCompiler（把声明翻成对现有服务的命令）、SceneDeployment 持久记录、dryRun/apply/readback API、两个 E2E fixture 均未做；ARC-002 保持空勾`
- `2026-10-13 | ARC-001 | DEV_CLAIM | E1 | 见 W01 关联 —— 唯一业务命令 appServices/sessionCommands.ts（createSessionAndSend），桌面 IPC 与 agent headless 同源；claude-ipc-smoke 221/221。remaining：ActionContext、统一 OperationResult、删旧 RPC 代理未做`
- `2026-10-14 | ARC-001② | DEV_CLAIM | E1 | ActionContext —— 「谁在调」从裸字符串升成结构化事实：sessionCommands.ts 的 createSessionAndSend 第二入参由 source("desktop"|"mobile"|"agent") 换成 ActionContext(actorKind: "user"|"agent"|"mobile" / actorId / operationId / 可选 scope)；两条调用方各填自己身份 —— 桌面 ipc/claude.ts 传 actorKind: "user"(actorId "desktop"，operationId randomUUID，scope=input.projectId)，agent appControl/tools.ts 的 headlessNewSession 传 actorKind: "agent"(actorId=发起调用的会话 id，并把 sessionId 由 runSessionNew → headlessNewSession 透传)，mobile 由服务函数按 actorKind 直接支持(mobile→createOrReuseSession 的 mobile，其余→desktop，行为与结果形状一变不变)。新增测试观测 __lastActionContext()。claude-ipc-smoke §19 +10(231/231，桌面=user/agent=agent/mobile=mobile 三档 + scope/operationId/actorId 非空)。变异 3 处各自真红并逐字节 cmp -s 还原：M1 桌面 actorKind user→agent → 红 1(桌面那条，actual agent)；M2 agent actorKind agent→user → 红 1(agent 那条，actual user)；M3 撤服务函数 lastActionContext 记录 → 红 8(三档 8 条 context 断言全失去依据)。smoke：claude-ipc-smoke 231/231、app-control-smoke 395/395；双包 tsc --noEmit 均 0 错 | remaining：ActionContext 的 permissionGrant(计划级授权句柄)与 expectedRevision(乐观并发修订号)两字段未落(要等授权判定核与资源修订号先铺进命令链，此处不造无消费者的空字段)；mobile 端「新建会话」生产路仍内联 createOrReuseSession(mobileRpc.ts)未经本服务函数；统一 OperationResult、删旧 RPC 代理、SceneSpec 编译部署仍属 ARC-001 后续切片。ARC-001 开发完成保持空勾`
- `2026-10-14 | ARC-001③ | DEV_CLAIM | E1 | **mobile 生产入口收进唯一业务命令**(MC-059 三端一致性):`mobileRpc.ts` 的 `claude:startSession` 此前仍**内联** `createOrReuseSession`,绕过服务函数 `createSessionAndSend`(三端里唯一漏网)。改调 `createSessionAndSend({input},{actorKind:"mobile",...})` —— 三端「新建对话」只有一处实现,结果形状照旧 `{session}`。claude-ipc-smoke 231→233(+2 源码级接线不变量:mobile handler 真调 createSessionAndSend、不再内联 createOrReuseSession)。变异:退回内联→红 2;`cmp -s` 还原。| remaining:ActionContext 的 permissionGrant / expectedRevision 未落;统一 OperationResult、删旧 RPC 代理、SceneSpec 编译部署未做。ARC-001 保持空勾`
- `2026-10-14 | ARC-001④ | DEV_CLAIM | E1 | **ActionContext 的 expectedRevision(乐观并发修订号)落地**。此前 remaining 点名的这个字段一直空着。修法:① 唯一业务命令的复用判据 `lib/sessionStart.ts` 新增 `sessionRevisionOf(session)`(修订号 = **会话行的 `updatedAt`** —— `SessionRepo` 每条 UPDATE 都会盖章它)+ `SessionRevisionConflictError` + `assertSessionRevision`;`createOrReuseSession` 加第三参 `expectedRevision?`,在**复用判据挑中空壳之后、写任何一行之前**核对(对不上抛错,什么都不建/不发);给了修订号却**没有可复用空壳**(没有空壳 / 带显式标题本就不复用)同样抛 —— 绝不静默新建一条调用方没预期的会话。② `ActionContext` 加可选 `expectedRevision`,`createSessionAndSend` 原样透传。③ 真调用方接线:桌面 `StartSessionSchema` 加 `expectedRevision` → `ipc/claude.ts` 透传;agent `app_session_new` 加 `expected_revision` → `headlessNewSession` 透传,并新增 `runSessionNewHeadless` 把冲突翻成 **REJECTED**(新增稳定短码 `OP_CODE.revisionConflict="revision_conflict"`,没执行即可安全重来),且**带修订号时强制走 headless 核对路、不走 UI 的 `new_session`**(那路不认这字段,走它等于把闸绕过)。**诚实的边界**:这里**不是** `@contracts/commit` 的整库 `durableRevision` —— 那个计数器住在 `store/db.ts` 模块私有 `let` 里、无纯读取出口,且本切片改动面不含 `store/db.ts`(另一车道拥有);会话命令真正的自然修订号是会话行自己的 `updatedAt`,选它并如实标出。claude-ipc-smoke §19b +17(250/250)。变异 6 处各自真红、逐字节 `cmp -s` 还原:M1 `assertSessionRevision` 判据改 `if(false)` → 红 6;M2 撤"无可复用空壳"闸(chat 路)→ 红 2;M3 服务函数不再透传 expectedRevision → 红 8;M4 `runSessionNew` 恒走 UI 路 → 红 3;M5 闸改成恒抛(证正面用例能判别"一律抛"的假实现)→ 红 3;M6 agent 的 revision_conflict→REJECTED 映射改坏 → 红 4。smoke:claude-ipc-smoke 250/250、app-control-smoke 404/404、session-subchat-smoke 88/88;双包 tsc --noEmit 均 0 错 | remaining:ActionContext 的 **permissionGrant**(计划级授权句柄)仍未落 —— 要等授权判定核先铺进这条命令链,此处不造无消费者的空字段;`expectedRevision` 目前只钉在**复用那条空壳**上(桌面/agent 两路已接),`createOrReuse` **新建**分支没有"上一版"可比、故不带修订号时不受约束;修订号是**进程内**的 `updatedAt`(不跨进程栅栏),跨重启的并发防护仍属未来切片;统一 OperationResult、删旧 RPC 代理、SceneSpec 编译部署仍属 ARC-001 后续。ARC-001 开发完成保持空勾`
- `2026-10-14 | ARC-001⑤ | DEV_CLAIM | E1 | **ActionContext 的 permissionGrant(计划级授权句柄)落地** —— ActionContext 的最后一个字段。授权核(`policyEngine.evaluate`)+持有核(`grantStore`/`getGrantStore`)已铺好,本切片把它接到唯一业务命令 `createSessionAndSend`。修法:① 服务函数新增 `SESSION_CREATE_METHOD="session.create"`、`sessionCreateCore(projectId)`(从项目行取 `path` 经 `physicalPath` 规范化 → `{projectPath}`,与 appControl 的 `resolveActionCore` **同一份**路径判据)、`SessionGrantRefusedError`(带稳定码 `grant_not_found`/`grant_scope_mismatch`/`grant_denied`)、`resolvePermissionGrant(projectId, grantId)` —— **不采信**调用方自报的字符串:拿 grantId 去 `getGrantStore().get()` 取回授权、交给**唯一**判定核 `evaluate` 跟「目标项目的权威资源身份」对;核不到/失效/不覆盖 → 抛错**拒绝**(什么都没建/发),覆盖了 → 记为 `__lastPermissionGrant()` 且按唯一记账口 `recordUse` 记一次(`maxCount`/`maxBudget` 真承重)。② `ActionContext` 加可选 `permissionGrant`,`createSessionAndSend` 在建任何一行**之前**核。③ agent 路接线:`app_session_new` 加 `permission_grant` schema → `headlessNewSession` 透传 → `runSessionNewHeadless` 把 `SessionGrantRefusedError` 翻成 **REJECTED**(新增稳定短码 `OP_CODE.grantRefused="grant_refused"`,没执行即可安全重来);**带授权句柄时强制走 headless 核对路、不走 UI 的 `new_session`**(那路不认这枚句柄、更不会去核,走它等于把「跑在授权 X 之下」这条事实悄悄丢掉)。**诚实的边界**:本切片**不绕过审批** —— 本命令从不弹卡(审批在各自入口),带授权只是「授权核覆盖了这次动作」这条**可核对的宿主事实**;且**没有生产签发口**签得出覆盖 `session.create` 的授权(现有签发口只签 `app_api_call` 单方法指纹授权与场景部署的 `scene.apply` 计划授权),故字段的**消费者**在本命令(写入前核对、拒绝不可核实者),给「无人值守建会话」签发此类授权的**生产者**属后续切片。桌面/手机两路是用户本人动作、无计划授权语境,故只接 agent 控制面这一条有意义的路。claude-ipc-smoke §19c +21(250→271)。变异 6 处各自真红、逐字节 `cmp -s` 还原:M1 判定核 allow 分支恒取(不再非 allow 即拒)→ 红 6;M2 撤「核不到即拒」闸 → 红 6(不存在/已撤销两类);M3 撤记账 `recordUse` → 红 1(usedCount 承重条);M4 撤 UI 路的授权句柄排除 → 红 2(窗口在时走了 UI 路、授权事实丢失);M5 服务函数不再透传 permissionGrant → 红 15(整条授权路失效);M6 `grant_refused`→REJECTED 映射改坏 → 红 8。smoke:claude-ipc-smoke 250→271、policy-engine-smoke 142/142;双包 tsc --noEmit 均 0 错(app-control-smoke 406/407,唯一红是**别的车道**的 MC-061 `hooks.*HostHookGrant` 未进生成目录 `apiCatalog.generated.ts` —— 本切片不新增 RPC、不碰该目录,非本切片引入) | remaining:① **无人值守授权生产端未接** —— 没有签发口铸得出覆盖 `session.create` 的 grant(要等自动化/任务计划在用户点头后签一份绑定「建会话计划」的授权),在此之前该字段只在显式带 grantId 时才有意义(现有调用方都不带);② 授权绑的**核心意图**目前只覆盖 `projectPath`(从目标项目解析),没有更细的「这个会话要跑什么计划/工作流」维度 —— 给「跑某个工作流计划开对话」签发授权需要 ActionIntent 带上更多计划身份;③ ActionContext 里 target 的 `traceId`(原始契约点过名)仍未落;统一 OperationResult、删旧 RPC 代理、SceneSpec 编译部署仍属 ARC-001 后续。ARC-001 开发完成保持空勾`

- `2026-10-14 | ARC-002③ | DEV_CLAIM | E1 | SceneDeployment 记录 + 纯状态机（第三片）：新建 @contracts/sceneDeployment —— SceneDeployment 持久记录形状（deploymentId/sceneId/specDigest/planDigest/actor{actorKind,actorId}/createdAt/status/steps[{actionId,status,resourceUid?,error?,startedAt?,finishedAt?}]/acceptance）+ 三个纯函数：createDeployment（从计划建记录，各步 pending、整体 deploying）、advanceDeployment（推进单步状态，**不改入参**返回新记录；找不到 actionId **抛错**不静默跳过；done/failed 记 finishedAt，重试成功清掉旧 error）、evaluateAcceptance（期望回读 id 全在 observed 里才算通过，缺的列进 missing）。**整体状态由各步推导**（deriveDeploymentStatus：任一步 pending/running→deploying；全 done→active；有 failed 且有 done→**partial**；有 failed 无 done→failed）—— **partial 判定排在 active 之前，MC-058 拒绝的「把部分成功报成 active」被这条挡住**。新增 scene-deploy-smoke（真实消费者：驱动状态机走完 部署→部分失败→PARTIAL→重试补全→ACTIVE，42/42）。变异 3 处各自真红并 `cmp -s` 确认逐字节还原：M1 把 PARTIAL 改报 ACTIVE → 红 2（承重那条 + 推导直测条，actual active/expected partial）；M2 部署判定漏掉 pending → 红 4；M3 未知 actionId 静默返回 → 红 1。smoke：scene-deploy-smoke 42/42、scene-spec-smoke 40/40；双包 tsc --noEmit 均 0 错 | remaining：这只是**记录形状 + 状态机 + 验收判定**这一层（先落形状，不碰 DB）—— SceneDeployment **落 DB 持久化**、SceneCompiler（把声明翻成对现有服务的命令）、dryRun/apply/readback API、两个 E2E fixture、部署器的能力预检与真实资源回读均未做；actor 的 permissionGrant（绑定 ARC-004 计划级授权句柄）与 expectedRevision（乐观并发修订号）两字段未落。- `2026-10-14 | ARC-002②/③ | DEV_CLAIM | E1 | scene.plan 首个生产入口 + SceneDeployment 状态机。**前半**：`validateSceneSpec`/`compileScenePlan` 此前**没有任何生产调用方**（只在 smoke 里活着）——新增 `scene.plan` IPC 给它们第一个真实消费者：Agent 把用户一句话目标翻成候选声明，经此拿到「哪里不合法（一次报全）」或「按什么顺序建什么」。**这条命令不执行任何东西**（不建资源、不碰磁盘、不申请授权），与 MC-058 拒绝的假方案正相反。走全三层：contracts（`ipc/scene.ts` + rpcMap）→ preload 白名单 → 主进程 handler。**后半**：`@contracts/sceneDeployment`（createDeployment/advanceDeployment/evaluateAcceptance/deriveDeploymentStatus），承重设计 **`partial` 排在 `active` 之前** —— 资源建一半不等于就绪，验收全过才算 active。smoke：scene-spec-smoke 47/47（新增 7 条 scene.plan 断言）、scene-deploy-smoke 42/42。变异：planScene 校验失败分支改成报空 problems → 红 1（assertion-red），逐字节 cmp -s 还原后 47/47 | remaining：SceneDeployment **落 DB 持久化**、SceneCompiler（把声明翻成对现有服务的命令）、apply/readback API、真实资源回读均未做`
- `2026-10-14 | ARC-004×ARC-002 | DEV_CLAIM | E1 | 计划级授权绑定计划 digest（ARC-004 与 MC-058 两处都点名的缺口）。此前 `CoreIntent` 只有 projectPath/mcp/gitRemote/sshHostKey/deleteScope 五个核心字段，**没有一处能把一份 Grant 钉在计划内容上** —— 「用户点头批准了这份计划」与「实际跑的是不是同一份」之间没有可判定的联系，批准后 spec 被偷改旧批准仍算有效。修法：① `@contracts/policyEngine` 的 `CoreIntent` 加 `scenePlan?: string`、`CORE_RESOURCE_KINDS` 加 `"scenePlan"`；② `appControl/policyEngine.ts` 的 `invalidationsFor` 比较 `scenePlan`（批准时的 `scopedCore.scenePlan` ≠ 当前 `intent.core.scenePlan` → 批准失效、点名 scenePlan）；③ 新增 `scenePlanCoreIntent(plan)` 给这条字段第一处生产者（ARC-002 的 `compileScenePlan` 输出 → ARC-004 的 `scopedCore`）。**这把「审批对象是计划不是 spec」变成可判定数据**：批准后偷改 spec → 重编译得不同 planDigest → 授权失效 → 回重新批准。缺省不受约束，不误伤普通单动作授权。smoke：policy-engine-smoke 142/142（新增 §2c 共 7 条）。变异 2 处各自真红、逐字节 cmp -s 还原：M1 去掉 invalidationsFor 的 scenePlan 比较 → 红 5（含承重的「计划被偷改 → 重新批准」）；M2 scenePlanCoreIntent 忽略 digest 恒返回静态值 → 红 1 | remaining：计划级授权**签发端**绑定 planDigest（现在签发的 scopedCore 仍是动作指纹/资源身份，尚未把 planDigest 喂进签发口）；multi-step 计划的逐步授权覆盖仍属 ARC-004 后续切片`
- `2026-10-14 | ARC-002④ | DEV_CLAIM | E1 | 场景能力预检（MC-058 点名「部署器的能力预检」）。编译只回答「按什么顺序建」，但建之前必须回答「这份声明要用的能力本机在不在、对这个引擎适不适用」——MC-058 拒绝的假方案正是「声明写完就开跑、跑一半才发现插件没装」。新增 `@contracts/scenePreflight`：`sceneCapabilityPreflight(spec, inventory)` 纯函数 —— 把 `spec.capabilities` 逐条翻成能力需求，对**宿主已装配清单**做确定匹配，收成 gaps，再按 required 分挡部署的 requiredGaps：**必需缺了 → ok:false（部署挡在门外）**；**可选缺了 → ok:true 但进 gaps（如实报，不假装可用）**。`module` 声明映射到清单的 `builtin` 类（模块能力在清单里以 builtin 露面）；声明选定引擎时参与适用性判定。smoke：scene-spec-smoke 63/63（新增 §8 共 16 条）。变异 2 处各自真红、逐字节 cmp -s 还原：M1 `ok` 改成由全部缺口决定 → 红 1；M2 requiredGaps 忽略 required 全收 → 红 2 | remaining：清单**装配**已有 `collectCapabilityInventory`，预检结果尚未进部署记录；skill/mcp 宿主侧完整清单来源仍缺（与 scheduler 同类预检一致地回避，避免误伤）`
- `2026-10-14 | ARC-002⑤ | DEV_CLAIM | E1+E2 | scene.preflight IPC —— 能力预检接真实入口。上一片交付了纯函数 `sceneCapabilityPreflight` 但**没有生产调用方**（又一条只在 smoke 里活着的判据）。本片给它真实入口：`scene.preflight` 设计**校验（一次报全）→ 编译 → 装配宿主清单（provider 注册表 / 已启用插件 / 执行器注册表 / 宿主内置，与 runner 的能力预检同源）→ 预检**，一次说清「缺什么」。`@contracts/ipc/scene.ts` 加 `ScenePreflightInputSchema`/`ScenePreflightIpcResult`/`ScenePreflightWire`；rpcMap 加 `scene.preflight` + `SCENE_PREFLIGHT:"scene:preflight"`；走全三层（contracts→preload→handler）+ `webApi.ts` 手机端 desktop-only 显式拒绝。**清单装配失败不吞**（不把「没查到」谎报成「都在」）。新套 `scene-preflight-smoke` 15/15（stub 掉三个宿主依赖）。变异：`preflightScene` 把清单换空数组 → 红 3（「缺可选能力不挡部署」「宿主内置能力就位」均假绿→真红），逐字节 cmp -s 还原。scene-spec-smoke 63/63、ipc-parity-smoke 13/13（新渠道自动被三层对齐网收进）；双包 tsc 0 错 | remaining：`scene.plan` 未把预检结果一并回传；预检结果未进部署记录`
- `2026-10-14 | MC-100/101 | DEV_CLAIM | E1 | **EffectiveToolInventory 诊断(只读基线)** —— 按台账两轮复核反复点名的同一步「先导出 SDK 真实有效工具名、Schema 字节/token 与恢复遗留,然后最小化」,只做**前半**:新增纯契约 packages/contracts/src/effectiveToolInventory.ts(buildEffectiveToolInventory / estimateToolTokens:按来源 builtin/mcp:<server>/dynamic/resumed-legacy 分类、schemaChars、definitionChars、粗估 token=ceil(定义字符/4))与主进程装配 apps/desktop/src/main/orchestration/effectiveToolInventory.ts(claudeEffectiveToolInventory / codexEffectiveToolInventory / piEffectiveToolInventory / buildEngineToolInventory,复用 libraryToolDescriptors/workflowEngineBridge.descriptors/Codex buildDynamicTools(本次改导出)/KNOWN_BUILTIN_TOOLS,不另造工具名单)。**只读**:无 registerTool 调用/options.mcpServers 赋值,不改变任何 provider 实际发出的东西。新套 effective-tools-smoke 44/44(排除即不在清单且记入 excluded、三引擎集合不同且标签正确、token 估计对字符数严格单调、恢复遗留归 resumed-legacy、只读接线源码断言);engine-tools-smoke 51/51、capability-smoke 104/104、provider-context-smoke 56/56、memory-codex-smoke 177/177 未破。变异 8 处各自真红、逐字节 cmp -s 还原(撤排除红 5、Codex 来源错标红 1、撤 browserEnabled 门红 1、撤 buildDynamicTools 复用红 2、token 估计常量红 2、丢弃恢复遗留红 2、撤 mcp__<server>__ 前缀红 2、撤导出→打包期 No matching export 红);双包 tsc --noEmit 0 错 | remaining:本片把「裁剪**之前**模型会看到哪些工具、有多大」量化出来,但**不是最小化本身**;按任务筛 ToolProfile、Planner 选能力、Injector 按 token/权限加载最小集合均未做;MC-100/101 验收(构造大量无关 Skill/MCP/Extension 证明未选能力不进请求)未达成;token 是粗估(CHARS_PER_TOKEN=4,CJK 更密,未跑真分词器);Claude 内置名取自静态 KNOWN_BUILTIN_TOOLS(非 SDK 权威枚举),用户级/项目/插件 MCP 工具表在 SDK 侧未计数(已记 notes);两引擎真实 SDK 请求层 input/cache token 抓包未做。**MC-100/101 保持开发空勾、复核空勾**`
- `2026-10-14 | MC-058 | DEV_CLAIM | E1+E2 | **真实资源回读 + 补偿(partial 部署的补偿路径)** —— 补上执行端交付时点名的缺口②(回读取自记录)与缺失的补偿路径。**回读**:`@contracts/sceneCommands` 的 `SCENE_KIND_SERVICE_MAP` 每 kind 新增 `readback`(回读入口标签/模式 byArg|byList/入参字段/匹配字段)与 `compensation`(逆操作入口+资源身份字段,无逆操作的显式 null);`sceneDeploy.ts` 新增 **`readbackScene(deployment, spec)`** —— 逐步按 kind 调**既有回读入口**(workflow.get / skills.list / plugins.list / mcp.list / hooks.list / modules.catalog)重新查询宿主真实资源,只把**查得到的**收进 `observed`(无法回读的 kind 带 `unverifiableReason` 如实列出);`applyScene` 收尾验收改用 `readbackScene` 的 observed,**不再**取「记录里走到 done 的步」—— 资源被带外删掉/入口报成功却没真建成时,记录仍说 done 但回读查不到 → 验收不通过。**补偿**:`@contracts/sceneDeployment` 的 `SceneStepStatus` 加 **`compensated`**(建成又被逆操作撤销,既非 done 也非 failed)、`SceneDeploymentStep` 加 `compensation{applied,inverseLabel,reason}`;`deriveDeploymentStatus` 把 `compensated` 与 `failed` 同桶(全被补偿 = 什么都没留下 → FAILED,**不是** active);`applyScene` 中途失败时(`compensateOnFailure` 缺省 true)**逆序**对之前已建成、`compensable` 的步调逆操作(workflow.remove / plugins.remove / mcp.remove / hooks.remove / modules.remove);不可补偿 / 无稳妥逆操作(skill/panel/scaffold)/ 逆操作失败 → **保持 done 但如实记一条 `compensation.applied=false` + 人读原因**(绝不静默留孤儿,也绝不猜一个入口乱删);持久化解码器认 `compensated` 与 `compensation` 形状。新套 `scene-apply-smoke` 59→**100/100**(新增:★带外删资源→回读查不到→验收失败、★★入口报成功却未建成→记录 done 但验收按回读判失败、★一步失败→逆序撤销已建成步→compensated→全被补偿→FAILED、★不可补偿/无逆操作/逆操作失败三档各自如实记未补偿+原因、补偿结果落盘可解码)。变异 6 处各自真红并逐字节 `cmp -s` 还原:M1 回读 byArg 恒 true → 红 6;M2 关补偿 → 红 12;M3 不可补偿分支静默 continue → 红 2;M4 收尾验收退回记录里 done 的步 → 红 2(含承重「没照抄记录」条);M5 `compensated` 当 done → 红 1(承重「全被补偿→FAILED」条);M6 解码器不认 compensated → 红 3。scene-deploy-persist 47、scene-spec 135、scene-deploy 42、scene-preflight 15、scene-task 未破;双包 tsc --noEmit 均 0 错 | remaining:①**授权签发端仍未接**(同上一片,未变);②**回读入口未逐个核对到真实资源身份** —— byList 的匹配字段取的是各列表返回的形状(workflow.get 判 workflow 非空、skills 按 name、mcp 按 name、hooks/modules 按 id),各服务返回形状不统一时未逐个按真实契约钉死(如 plugins.list 的 name 与声明 id 是否同义未验);③**补偿未覆盖 plugin/panel/scaffold**(plugin 有 plugins.remove 但该 kind 仍 needsResolution 不执行;panel/scaffold 无撤销入口,如实记未补偿);④**resourceUid 仍未落**(各服务返回形状不统一);⑤**skill 无稳妥逆操作** —— skills.delete 还需 source(global/project),单靠资源 id 不足以定位,故如实记为未补偿(不是疏漏);⑥**无 IPC 入口**(scene.apply/readback 仍无渠道);⑦**崩溃续跑的 resume 入口**仍未做;⑧**applyScene 的补偿用的是同一枚计划级授权** —— 未单独为「撤销本计划刚建成的资源」签发或核对授权(判为同一计划的执行,非第二套判定,但未做显式论证)。ARC-002 保持空勾`
- `2026-10-14 | MC-058 | DEV_CLAIM | E1+E2 | **SceneDeployment 落 DB 持久化**:`store/db.ts` 加 `scene_deployments` 表 + 索引(幂等 CREATE TABLE IF NOT EXISTS,旧库下次启动自补);`store/repositories.ts` 加 `SceneDeploymentRepo`(save upsert-by-deployment_id / get / listByScene / remove,镜像 WorkflowRunRepo);`appServices/sceneDeploymentStore.ts` 的 `saveDeployment(d,{durable})` 编码→解码往返校验→落库,durable 时以 `commitNow()` 三态闸门(只 DURABLE 返 true,APPLIED_NOT_DURABLE 回滚内存行返 false)。新套 `scene-deploy-persist-smoke` 47 断言(写 40 + 跨进程 verify 7)。变异 3 处真红、`cmp -s` 还原:存档手改成 active 解码仍按各步推导为 PARTIAL→红 1;upsert 保留旧 payload→红 3;撤 durable 闸→红 4。scene-spec 102/102、scene-deploy 42/42、scene-preflight 15/15、run-store 59/59 未破 | remaining:SceneCompiler、dryRun/apply/readback API、真实资源回读、两个 E2E fixture、部署器能力预检结果进部署记录均未做 —— **没有执行端,saveDeployment 今天只有测试调用方**。ARC-002 保持空勾`
- `2026-10-14 | MC-058 | DEV_CLAIM | E1 | **SceneCompiler(命令描述符)**:新增纯契约 `@contracts/sceneCommands` —— `compileSceneCommands(plan, spec)` 逐条产 `SceneStepCommand`(actionId/kind/order/payload=资源声明正文/service 标签/needsResolution),`sceneCommandId`/`sceneCommandsDigest` 稳定 id/摘要(FNV-1a,同 scenePlan);`serviceForKind(kind)` **声明式**映射到既有 RPC 通道标签(workflow/skill/mcp/hook/module/automation→各自 save;plugin/panel/scaffold 三类**无单条确定入口** → needsResolution 且仍产出、进 unresolved)。计划与 spec 的 specDigest 不一致 → 抛错。scene-spec-smoke 102→135(+33)。变异 4 处真红、`cmp -s` 还原。| remaining:这只是**命令描述符**层 —— 全仓仍无 compileSceneCommands 的**生产调用方**(只在 smoke 里活着);dryRun/apply/readback、真实资源回读、把命令绑回 SceneDeployment 的逐步执行均未做;plugin/panel/scaffold 三类未做决议。ARC-002 保持空勾`
- `2026-10-14 | MC-058 | DEV_CLAIM | E1+E2 | **部署执行端(dry-run / apply)** —— 给 `compileSceneCommands` 与 `saveDeployment` 接上第一个真实生产调用方。新建 `@main/appServices/sceneDeploy`:`dryRunScene(spec)` 校验→编译计划→编译命令→**纯静态预判**(needsResolution 的步、以及依赖了「不会跑」的步的那些步 → 不执行 + 一句人读原因),**不建行、不调任何 handler**;`applyScene({deploymentId,spec,actor,grant})` 创建 `SceneDeployment`,按**计划拓扑序**逐步:`advanceDeployment(running)`→落盘→`findEntry(serviceLabel)` 解析通道→`callRpc(entry,payload)`——**与 `app_api_call` 同一条通路**(同一批 handler、同一份授权判定核)、不长第二套引擎——→按结果记 `done`/`failed`(带服务真实错误)→落盘,每步后 `saveDeployment({durable:true})`(崩溃可续);收尾 `evaluateAcceptance`(observed 取本次走到 done 的步)。**依赖闸**:任一依赖没到 done → 本步记 failed 并点名依赖,handler 不被调。**needsResolution**(plugin/panel/scaffold)→ 明确记 failed + 「需决议、未执行」,**绝不猜入口**。**授权闸(不静默放行)**:`applyScene` 必带一枚计划级授权,走**唯一**那份判定核 `policyEngine.evaluate`(intent 的 method 取 `scene.apply`、core 取 `scenePlanCoreIntent(plan)`),绑的是**计划 digest** → 传递性钉住「每一条命令带什么载荷」;非用户签发/撤销/过期/动作表不含 scene.apply/绑错计划 → **拒绝执行且连部署记录都不建**。新套 `scene-apply-smoke` 59/59(真建库:dry-run 零副作用、apply 逐步落盘+ACTIVE、★一步失败→PARTIAL、★依赖不成立不派发、★needsResolution 不执行、★五档授权拒绝且零 handler 零建行、对照组有效授权放行、apply 不合法声明返回 invalid)。变异 6 处各自真红(exit=1)并 `cmp -s` 逐字节还原:M1 失败步改记 done → 红 10(含「PARTIAL 不是 ACTIVE」承重条);M2 关授权闸 → 红 9;M3 依赖闸恒 false → 红 2;M4 撤 needsResolution 闸 → 红 1;M5 dry-run 恒 willRun → 红 1;M6 撤 apply 校验闸 → 红 2。smoke:scene-apply-smoke 59/59、scene-deploy-persist 47、scene-spec 135、scene-deploy 42、scene-preflight 15 未破;双包 tsc --noEmit 均 0 错 | remaining:①**授权签发端未接** —— 本层只**消费**一枚绑定本计划的计划级授权;谁在用户点头后为场景**签出**这枚(`scene.apply` 的用户授权)是下一片(ARC-004 眼下只签 `app_api_call` 的单方法指纹授权),在那之前本层的真实调用方必须先持有它,否则一律拒绝——**这是有意的缺口,不是静默放行**;②**真实资源回读未做** —— `evaluateAcceptance` 的 observed 取自部署记录里走到 done 的步,**不是**独立回读宿主真实资源(工作流是否真存在);③**resourceUid 未落** —— 各服务返回形状不统一,本层不猜一个 uid;④**needsResolution(plugin/panel/scaffold)未决议** —— 明确不执行,未接单条入口;⑤无 IPC 入口(`scene.apply` 渠道未加,本层是纯服务函数,真实调用方=后续切片);⑥崩溃**续跑**的「从上次断点继续」未做(落盘够了,但没有一个 resume 入口把已 done 的步跳过重跑)。ARC-002 保持空勾`

ARC-002 开发完成保持空勾`
- `2026-10-14 | 批量 | DEV_CLAIM | E1 | **MC-004**(提交 `76ba9f05`)、**MC-014/052**(提交 `3cebba6e`)、**MC-059**(提交 `c4f8c2cd`)、**MC-089**(提交 `e0f4ada7`)、**MC-090**(提交 `66a4f1ad`)、**MC-092/093**(提交 `cc1408aa`)、**MC-096**(提交 `7c918f48`)、**MC-100/101**(提交 `4835a445`)—— 本轮八条各自补上复核点名的缺口,每条都做了变异验证(撤掉修复看断言真红,逐字节 `cmp -s` 还原),详细记录见各 MC 分节。`
- `2026-10-14 | 批量续 | DEV_CLAIM | E1 | 本轮第二批提交:**MC-060**(`78be45b5` Module action 拒绝可区分 + 生产审批装配)、**MC-061**(`2d282da8` 插件 hook 授权的用户签发 UI + 持久幂等)、**MC-077/094**(`3452d49d` 三引擎技能交付的真实负例)、**MC-089**(`e0f4ada7`)、**MC-096**(`7c918f48`)、**MC-099**(`08400187` 能力变动序 E1)、**MC-091**(`e6d647e1` 全局背压 + E3 + 欠账上界面)。每条都做了变异验证(撤掉修复看断言真红、逐字节 `cmp -s` 还原,其中多条由主会话**独立复跑变异**再次确认,不只看车道自报)。详细见各 MC 分节与 §3 矩阵。**共同 remaining 主题**:凡「真实三 SDK 在线回合 / 真 Electron 手工操作 / 真公网 / 真 sshd / 真双 OS 进程」这一类端到端验收,本轮均如实留白,未用「纯函数绿」冒充。`
- `2026-10-14 | 收口 | REVIEW_PASSED | E1 | **全量复核**:提交后冻结工作树,`run-all-smokes.sh` **253/253 套全绿、0 失败**;双包 `tsc --noEmit` 均 0 错。
- `2026-10-14 | 收口续 | DEV_CLAIM | E1 | 全量首轮 251/2 红,逐套查到底,两处都**不是产品缺陷**:
  ① **`ide-quote-snapshot-smoke` 是一个「撒谎的绿」**(真缺陷):它打印 `10/10 通过` 却退出码 1 —— 真 `EditPane` 挂载留下的假 DOM 定时器句柄让事件循环不空,进程活到 `build.mjs` 的 60s `spawnSync` 超时(`status: null` → 被当成失败),实测跑一次要 **1m00s**(兄弟套件 0.7s)。这正是本仓点名过的「看着绿、其实坏」。修法:收尾显式 `process.exit(failures > 0 ? 1 : 0)`(只设 `process.exitCode` 不够)。修后 0.5s/退出码 0,且变异仍真红**且**退出码 1(8/10)。
  ② **`mcp-endpoint-smoke` 是负载相关的竞争**:断言在 `agent_process_stop` 返回后**立刻** prune,偶尔读到 `processes: 1` 的残影。改成有界轮询(100×50ms)。⚠️ **如实说明:这一处试过撤掉轮询连跑 5 次未能复现红,故没有变异证据 —— 是防御性加固,不是「已证明修好的缺陷」**。
  另:`ui-interaction-smoke`(手写 UI 组件替身名单漏 `Badge`)与 `resume-fault-smoke`(`ipc/engineTools.ts` 新增 `readEngineToolPolicyStatus` 而桩未导出)是同类的「桩跟不上生产装配」假红,补桩即绿。
- `2026-10-14 | 收口三 | REVIEW_PASSED | E1 | **推送到远端**:20 个提交已 `git push origin master`(`d76114ed..a0d63ad8`)。
- ⚠️ **AOCI 索引未维护**:本轮结束时 `aoci_maintain` / `aoci_overview` / `aoci_rules` / `aoci_search` **全部返回空响应**(另一会话 `查看项目索引并调用 aoci MCP 维护` 持有该索引)。本轮对受管源码的改动**尚未**进索引。
- `2026-10-14 | 收口四 | DEV_CLAIM | — | 又派 4 条并行车道继续收口剩余可无头闭合的缺口:**MC-100/101 生产侧画像来源**(现默认永远 `full`,裁剪链接通却从不真裁 = 假接线)、**MC-061 取消预算 + `hook_runs` 审计读取/轮转**、**MC-058 崩溃续跑 resume 入口**、**MC-059 计划审批三层 IPC 入口**。结果待回。
- `2026-10-14 | 收口五 | DEV_CLAIM | E1 | 四条车道全部回收并逐一由主会话**独立复跑变异**确认(不只看车道自报):
  · **MC-058 resume 入口**(`548db921`):`resumeScene`/`resumeSceneWithGrant` 读回盘上部分执行的部署、跳过已 `done` 步只跑剩下的;`compensated` 步按**重建**处理(资源已被补偿撤销、当下不在)。scene-apply 191→242。独立复跑:把「已 done 跳过」改成 `if (false)` → handler 被调两次(`wf,auto` 而非 `auto`)真红。
  · **MC-059 三层 IPC 入口**(`1cb4a7ea`):`unattended.approve`/`unattended.run` 契约→RpcMap→preload→handler 全通,主体写死 user、执行只收 grantId、policy 钉 blocked、catalog 重生成(400)。claude-ipc 271→324、app-control 407→429。独立复跑:删 BLOCKED → 「权限 unattended.approve = blocked」真红 `{"level":"write"}`。**渲染端仍无按钮**(与 `scene.*` 同现状)。
  · **MC-100/101 生产侧画像来源**(`9aeef50d`):新增 `toolProfileForSession`,在唯一发起 `StartTurnRequest` 的 `RuntimeManager.sendTurnBound` 接上 —— 此前该字段永远缺省 `full`、裁剪链从不真裁(假接线)。agent-mail 285→294。独立复跑:撤掉赋值 → 9 条真红。**只有 side(Q&A) 这一条能确定性派生**,其余显式 full(刻意,非省略)。
  · **MC-061 残余**(`f40a48d3`):「取消预算」经源码核实 = **执行次数上限**(hook 无取消通道,`runCommand` 的 signal 永不会响),落地为 `maxRuns`/`usedRuns` + 第四态 `exhausted` + 共享 `countBudgetExhausted`;`hook_runs` 审计**读取 + 轮转(prune 500)**接上并真渲染。变异 9 处;独立复跑其二(true 红)。
- ✅ **AOCI 索引本轮结束时不可用**:`aoci_maintain` / `aoci_overview` / `aoci_rules` / `aoci_search` 持续返回**空响应** —— 另一会话(`查看项目索引并调用 aoci MCP 维护`)持有该索引,本会话够不到。**本轮所有受管源码改动尚未进索引**,需在该索引恢复后补维护。


- `2026-10-14 | M
- `2026-10-14 | 收口六 | REVIEW_PASSED | E1 | **全量三次实证**:默认并发(`jobs=min(6,cores)`)下三次跑分别 **248/4、250/3、252/1** —— **每次失败的都是不同的套件**(ui-interaction/terminal、markdown-preview/lsp/mcp-endpoint、module-ui),且**每套单独复跑均全绿**(lsp 连跑 3 次 194/194)。把并发压到 `MCODE_SMOKE_JOBS=3 MCODE_SMOKE_HEAVY_JOBS=1` 再跑 → **253/253 全绿、0 失败**。失败形态也一致:Windows 临时目录 `EBUSY rmdir`、端口争用(`fetch failed / bad port`)、进程回收时序(`actual:[40868] expected:[]`)——都是**并行负载**造成的抖动,不是任一改动引进的回归。⚠️ **不做「把红改绿」的粉饰**:默认并发下这台机器确实会抖,如实记录;要稳定绿需降并发跑。
- `2026-10-14 | 收口七 | REVIEW_PASSED | E1 | **推送远端**:共 24 个提交至 `f40a48d3`(`a0d63ad8..f40a48d3`)。
C-058 | DEV_CLAIM | E1 | **正式生产入口 + dura
- `2026-10-14 | 收口八 | DEV_CLAIM | E1 | 又一轮 6 条车道,把上一轮车道诚实留下的「无头可做」残余逐条收口,每条仍由主会话**独立复跑变异**确认:
  · **MC-058 渲染端**(`d96b4899`):设置页新增「场景部署」面板(粘贴→预览→批准→部署)。判据抽成纯函数:批准入参的 `planDigest` **取自当前预览**(不是现算 spec,否则等于批准没看过的计划)、编辑即作废旧预览与授权、部署入参**不含授权内容字段**。scene-deploy-view 69/69。
  · **MC-058 回读身份钉死**(`626b1c3d`):**修掉一个假绿根源** —— `probeResource` 此前拿**场景 actionId** 去查**按服务身份索引**的列表,**永远匹配不上**;夹具里两者同值时看不出。改为经 `sceneResourceIdentity(kind, spec)` 取服务侧稳定身份逐 kind 钉死(workflow/automation→`WorkflowDoc.id`、skill→`SkillInfo.name`、mcp→`McpServerEntry.name`、hook→`HookSpec.id`、module→`ModuleManifest.id`);plugin/panel/scaffold **推不出稳定身份 → 如实进 `unverifiable`**,不假装回读过。scene-apply 242→271。
  · **MC-061 推送**(`dced704d`):复用既有广播通路,新增 `hooks:hostHookGrantsChanged`,签发/用尽/撤销/整撤四处推,面板按 `shouldRefetchHookGrants` **只刷那一个插件**;没有窗口静默跳过。⚠️ **这条引入了回归并在下一轮抓出**(见下)。
  · **MC-060 隔离执行**(`4df8fd74`):核实「运行时无隔离底座」判断成立后,新建 `isolatedActionRunner`(`worker_threads`),四类可区分失败;闸在派发**之前**。**如实写明 worker_threads ≠ 沙箱**(挡全局污染/崩线程/挂死/取消,挡不住内存共享与系统调用)。module-phase2 25→32。
  · **MC-096/091**(`4f655a67`):`store.json` → 点前缀保留名 `.mcode-store.json`(**物理**隔离),读回退 + 写即迁移;统一截断原语 `capOldest` 三处合一;**E3 语义映射** —— 发现 `startWorkflowRun` 其实**返回结果**只是被 `void` 丢了,于是真读:`SUCCEEDED`/`FAILED`/`UNCERTAIN` 业务三态,崩溃遗留 `CLAIMED`→`UNCERTAIN`。automation 704→727。
  · **MC-059 后端收口**(`5da276ff`):发起者身份由宿主 `SessionRepo.get` **核实**产出(伪造坐标 → `unknown_initiator` 拒绝、一步不建);计划**正文落盘** → 重启后可列出/续跑(跳过已建成)/放弃。claude-ipc 324→370。**如实:仓库内无无人值守调度器**,续跑是用户触发不是后台自动。
- `2026-10-14 | 收口九 | REGRESSION→已修 | E1 | **我自己的 MC-061 推送提交引入了一条真回归,被本轮抓出并修复**(`0fefc9bf` + `857b4d62`):新增推送通道 `hooks:hostHookGrantsChanged` 后,① `ipc-wiring-smoke` 报「preload 订阅了但主进程没有推送出口」—— 根因是我把接线写成 `send: (channel, payload) => sendToRenderer(channel, payload)`,**通道是变量**,而扫描器只认 `sendToRenderer(IPC.X)` / 字面量;② `memory-codex-smoke` 的推送通道手抄名单没跟着加。修法是**让通道在源码里可见**(端口签名收窄成 `send(payload)`,通道由 `hostHookGrants.ts` 定死,`window.ts` 装配处写出 `sendToRenderer(IPC.HOST_HOOK_GRANTS_CHANGED, payload)`),**不是弱化断言**;另补手机端 `on` 订阅项。变异:把通道改成 `"hooks:WRONG_CHANNEL"` → 双向比对真红。**教训**:上一条只跑了 5 套,漏了 `ipc-wiring` 与 `memory-codex` —— 正是专盯「新通道有没有登记」的两套。

### 剩余条目的性质分类（2026-10-14 收口后盘点）


- `2026-10-14 | 收口十 | REVIEW_PASSED | E1 | **最终全量(降并发)254/254 套全绿、0 失败**(套件数 253→254:新增 `scene-deploy-view-smoke`);双包 `tsc --noEmit` 0 错;工作区干净。推送远端至 `857b4d62`。**本轮共 9 个提交**(`d96b4899`…`857b4d62`)。
- ⚠️ **AOCI 索引仍不可用**(全程 `aoci_*` 空响应,另一会
- `2026-10-14 | 响应复审 | DEV_CLAIM | E1 | 独立复审方在 HEAD `857b4d62` 新增「全量复审记录」章节,点了 4 条下一轮重点。逐条响应:
  · **`smokes-for.sh` 环境问题已修**(`1e43e
- `2026-10-14 | 响应复审完成 | DEV_CLAIM | E1 | 复审方点名的 4 条下一轮重点**全部响应完毕**:
  · **delegateHost 权限边界 smoke**(`292ff7
- `2026-10-14 | 响应复审收尾 | REGRESSION→已修 | E1 | **抽走启动装配后打红了两套既有 smoke(全量 254/256),已修**(`8e24e051`):`engine-tools-smoke`「应用装配时真的登记了中继实现」与 `scene-task-smoke`「启动路径真的装配了场景任务运行期入口」把落点写死在 `src/main/index.ts`,抽进 `startup/assembleStartup.ts` 后落空。修法:落点改到新位置(**并保留「index.ts 真的调了那个装配函数」这层**,否则换成另一种假绿「抽出去没人接线」)。⚠️ 修的过程中我又犯了两处同类错、当场修正:① `scene-task` 里我写 `` 被转义搅成**退格字符 ``**(正则匹配不到,我却以为逻辑对);② `engine-tools` 那条**我没剥注释**,于是源码里一句解释性注释「抽成 `assembleStartup()`」就命中了 —— **正是这条断言自己要防的假绿**。两条变异验证:拔掉 index.ts 的真接线 → **各自真红**。
- `2026-10-14 | 响应复审收尾二 | REVIEW_PASSED | E1 | **最终全量(降并发)255/256**;唯一红的 `terminal-smoke` 单独复跑 **128/128 全绿**(负载抖动,非回归)。双包 typecheck 0 错。**本轮共 10 个提交**推送至 `8e24e051`。系统排查过:`grep -rln 'src/main/index.ts' scripts/` 只有 4 套引用它,前两套已修,后两套是新建套件本来就知道新位置 —— 没有遗漏的扫描落点。
- ⚠️ **AOCI 索引仍全程不可用**(`aoci_*` 空响应)。本轮受管源码改动**未进索引**。
f9`)—— 补网时**查出一处真缺陷**:`ensureDelegateSession` 的复用分支只 `bindSession` **不重钉权限模式**,而 `bindSession` 幂等、给 `canUseTool` 播的种取自**用户能在界面改的落盘行** → 用户把委派会话改成 `dontAsk`/`default` 后,下一次委派静默被拒或弹卡挂死。**对称性依据我核实过**:姊妹模块 `publicMcpSession.ensureLinkSession` 对同一情形**每次复用都重钉**,它那条注释讲的正是这个缺陷。修复 + `delegate-host-smoke` 31/31(判据:固定 bypass、**只在开关打开时能力才存在**、复用必须重钉、项目映射不塌回默认、无项目可区分拒绝)。
  · **启动链 index smoke**(`a60e6eb6`)—— 把「DB 就绪后、窗口装配前」的装配抽成 electron-free 纯函数 `startup/assembleStartup.ts`(8 步顺序与语义**逐字保留**,我逐行核对过 diff),`startup-wiring-smoke` 19/19 + 接线守卫 13/13。⚠️ **顺带修正一条言过其实的断言名**:原「装配序列按声明顺序走」实际只钉两个注入点的先后(那 6 步彼此无依赖,对调任意两步不会变红 —— 我实测确认),已改成如实说法。`--uncovered` 里 `index.ts` 消失。
  · **MC-091 故障注入**(`6c700664`)—— 补两条此前没覆盖的异常路径:恢复游标落盘失败(内存欠账**原样留着**、盘上不留半截、恢复后补落、重启读得回)+ 领取结算落盘失败(内存与盘都**回滚成 CLAIMED**、不留幻影成功、仍属待恢复 → `UNCERTAIN` 不重复执行)。automation 727→739。
  · **ARC-002 crash→restart→resume→verify**(`0e636be9`)—— **真跨进程**:第一进程 `SIGKILL` **自杀**(以退出码非零 + 未写出幸存标记证明**没跑完**),第二进程从磁盘读回 partial 记录、跳过已 `done` 只重试失败的、续跑至 active、验收通过。判据是**跨进程累加的派发次数**;并先断言新进程内存宿主为空、状态来自磁盘,排除「同进程假重启」的假绿。scene-apply 271→290。
b79`)——复审方报 `--uncovered` 失败(「脚本依赖 `py` 命令不可用」)。本机复现不出,但源码里有两处真实脆弱点正会造成那个现象:① 只看 `command -v` 认 python —— Windows 上 `python.exe` 常是 **Microsoft Store 占位别名**(找得到、真跑起来弹商店然后失败);② Git Bash 下 `$HERE/smokes-for.py` 是 POSIX 路径,Windows 版 python 解不了。改成**逐个候选真跑一次 `-c ""`** 才认 + 有 `cygpath` 就转 Windows 形态。变异:做个必然失败的假 `python` 放 PATH 最前 —— 旧判据**直接失败无输出**(正是复审方现象),新判据**跳过它、落到真 Python、正常输出**。
  · **delegateHost 权限边界 smoke**、**启动链 index smoke**、**MC-091 故障注入**、**ARC-002 crash→restart→resume→verify** —— 各派一条车道在做,结果待回。
  · 复审方另外确认「已确认保持关闭/无需新增」的四项(工具发现入口 / Capability registry / Smoke 体系 / 文档台账)**与本地判断一致**,不新增编号。
话持有)。本轮受管源码改动**未进索引**。
**可无头闭合、本轮已派车道**：MC-058 渲染端按钮 + 回读身份钉死/补偿覆盖、MC-059 后端收口、MC-060 隔离执行、MC-061 面板推送、MC-096 `store.json` 物理隔离命名空间、MC-091 统一截断原语 + E3 语义映射。

**必须真外部依赖，无头闭合不了（已逐一核实可行性，非惰性留白）**：
- **MC-004 真 TLS**：仓库无证书生成依赖（`grep selfsigned/node-forge/generateKeyPair` 全空），`node:http` 硬编码。真做需引依赖生成证书 + `https.createServer` + 手机侧主机身份绑定 —— 是一次独立的、跨端的改造。本机 Git Bash 有 `openssl` 但**生产（Electron 打包后）不能依赖它**。当前形态是「拒绝」而非「加密」，已在台账与提交里写明。
- **MC-014 真 sshd**：`ssh2` 自带 `server.js`（已在用，覆盖 hostVerifier 契约）；真 OpenSSH `sshd.exe` 虽在本机 Anaconda 里，但需管理员权限起服务、CI 上极脆，**不该硬做**。
- **MC-077/094 真三引擎二进制**：需真 claude/codex/pi 可执行文件在线跑一轮，读它们的实际扫描/命名行为（Codex 闭源，是否把直接含 SKILL.md 的根当单个技能 = UNVERIFIED）。
- **MC-089 真公网**：需真隧道 + 真外部主机施压。
- **MC-092/093 真三引擎在线回合**：需真模型回合过网。
- **MC-100/101 wire 层抓包**：需真引擎请求，抓 input/cache token 证明 SDK 真照做。
- **MC-096 真双 OS 进程**：租约本身宿主级、跨进程由 MC-097 的真子进程 E1 佐证；MC-096 这一条以单进程钩子确定性复现。
ble 存档闸门**(提交 `9210f128`)。复核点名三处逐条堵上:① **无生产入口消费 applyScene** —— 新增 `scene.approve` + `scene.apply` 两条写通道,走全三层(contracts `ipc/scene.ts` + rpcMap → preload 白名单 → 主进程 handler),并重生成 `apiCatalog.generated.ts`(398 条,`app-control-smoke` 407/407 对齐);② **用户侧无签发落点** —— 新增 `approveSceneDeployment`:宿主**自己**重编译拿真实 plan digest 与调用方递来的 `planDigest` **对账**(不一致 → 拒签),再走唯一签发口 `GrantStore.issueGrant` 签 `scopedCore = scenePlanCoreIntent(plan)` 的授权,签发主体由 handler **写死为 user**;新增 `applySceneWithGrant` 作正式部署入口,**只收 grantId**,授权内容由宿主从 `GrantStore.findBoundFor` 取回(含失效态)交 `policyEngine.evaluate` 判,取不到 id → 显式 `refused` 且一步不建;agent 侧 `policy.ts` 把这两条钉在 **blocked**(否则动词兜底会把 `apply` 猜成 write 并弹卡 = agent 能自己批自己的计划),mobile `webApi.ts` 显式 unsupported;③ **存档 durable 失败仍照常执行** —— 初始那一笔落不下去就整个不执行,返回稳定码 `archive_not_durable` 的显式拒绝。同批并入并行车道的 MC-058 修复:派发后检查**业务层** `{ok:false}`(复用 `appControl/commandOutcome.ts` 共享解码器,与 `app_api_call` 同源)、`evaluateAcceptance.passed` 补「且没有步骤失败」、`hooks.save`/`mcp.save` ok/error 信封登记。`scene-apply-smoke` 142 → **191/191**(新增 §⑯⑰ 共 21 条)。变异 3 处各自真红并逐字节 `cmp -s` 还原:A 去掉 digest 对账 → 「计划摘要对不上 → 拒签」红;B 去掉 grantId 取回闸 → 「授权取不到 → refused」+「一个 handler 都没被调」红(实际变 applied、calls=1);C 去掉 durable 闸 → 「存档写不进去 → 拒绝执行」红(实际变 applied)。`app-control-smoke` 407/407;双包 tsc 0 错 | remaining:**回读入口未逐个按真实契约钉死资源身份**(byList 匹配字段取各列表返回形状);`resourceUid` 仍未落;**补偿未覆盖 plugin/panel/scaffold**;**崩溃续跑的 resume 入口**仍未做;补偿用的是同一枚计划级授权(未单独签发/论证);审计「谁在什么时候批了哪份计划」的落盘记录仍未做。ARC-002 保持空勾`

**独立验收**：选两类不同目标，分别完成受控部署、dry-run、重启恢复和重复部署幂等；UI 不在时业务仍可按权限执行，纯 UI 操作明确失败。

**关联 ARC**：`ARC-001`、`ARC-002`、`ARC-010`、`ARC-012`；**MC**：`MC-058`、`MC-059`、`MC-066`；**UXG**：`UXG-001`.

### W02 · 安全、网络、SSH 指纹与授权归属（P0/P1）

**目标**：宿主决定用户/Agent/项目/主机/资源的真实身份与许可，导入设置或 MCP 请求不能自签授权。

**尚需完成**：MC-004/014/052 未关闭，需复核 LAN 明文、首连指纹、可信批准的来源；ARC-004 的统一计划级授权仍不完整。**迁移期间增量（2026-10-13）**：旧主 MC 中新增记录确认 `AgentSshTrustPanel.tsx` 的渲染入口、`main/ipc/agentSsh.ts` 的 `list/approve` 宿主受信审批及 `renderer-pure-smoke` 的 3 条接线断言已落地；这属于开发阶段的切片证据，未改变 MC-014/052 的复核空勾。公网/自动化无 UI 场景的事前授权 `grantHostTrust` 通路、relay 主机密钥信任方案仍待整体核验。
**本会话追加（2026-10-13，本地开发 AI）**：
- `2026-10-13 | MC-004 | DEV_CLAIM | E1 | 手机连接对话框补明文 HTTP 风险提示：新增纯函数 renderer/lib/mobileEndpointRisk.isPlaintextNonLoopbackEndpoint（仅非回环明文 http 才提示），MobileConnectDialog 据此显示 warning + i18n zh/en。renderer-pure-smoke +11（188/188）。变异：判据恒 false → 红 3；不区分 scheme → 红 2 | remaining：真正的 TLS/可信隧道未做（本提示只是讲清风险，不是加密）；证书/主机身份绑定、配对令牌撤销的传输侧保证未做`
- `2026-10-13 | MC-014/052 | DEV_CLAIM | E2 | 远程主机受信审批入口的接线不变量：renderer-pure-smoke +3（面板真被渲染、IPC 已注册、面板真调批准入口），变异撤渲染 → 真红（首版断言只查 id 声明不变红，已改成断渲染行）。台账 remaining 中「UI 按钮/IPC 未接入」已过时，更正为「relay/hostKey 预置钉扎 + 公网/自动化事前授权通路仍待接」`
- `2026-10-13 | ARC-004 | DEV_CLAIM | E1 | 计划级授权**签发端**接线：此前全仓 `issueGrant(` **零生产调用方**（授权表永远为空，`planGrantPrecheck` 只会走「无绑定授权 → 默认审批链」）。本片给签发口接一条真实入口 —— `appControl/tools.ts` 的 `gateAppAction` 新增可选回调 `onUserApproved`，**只在「用户本人新鲜点头」（真正弹了审批卡、本人点了允许）那一刻**触发一次；调用点 `invokeAppTool` 据此调 `signPlanGrantForUserApproval`，把这次批准的来源（`ActorRef{kind:'user'}`）与作用域（`resolveActionCore` 解析出的身份）铸成 `Grant` 存进 `getGrantStore()`。**安全判据**：完全访问模式（bypass）的系统默认放行、已记的「始终允许」、fail-closed 各分支**都不触发**（它们都在回调之前 return）→ **agent / system 不能给自己发授权**（`issueGrant` 另强制 `subject.kind==='user'` 双保险）。**跳过弹卡**：`planGrantPrecheck` 现返回 `{kind:'authorized'}`（有效用户授权覆盖）→ 执行点**不再弹审批卡**直接执行（这就是「计划级授权覆盖整个计划、不再逐次弹卡」）；`deny` 仍不执行；无绑定授权仍走默认链。**范围收窄（避免回归）**：签发**只对 `real===false` 的「请求指纹兜底」方法**（`session.*`/`library.*`/`project.*` 这类）—— 资源作用域方法（`file.*`/`git.*`/`terminal.create`）若签成资源作用域授权，同方法的另一资源会被 `findGoverningFor` 取到并**硬拒**（连审批都不弹），把默认路径从「逐次弹卡」改成「换资源直接拒」，是回归；指纹作用域则 `findBoundFor` 精确匹配，换参数即回落默认链，无此副作用。**断言**：app-control-smoke +5 承重（① 有效用户授权覆盖 → asked=0 且执行、用户点头后 store 铸出 grant、同动作再调不弹卡；② 完全访问/始终允许**不产生授权**；③ danger 批准**不铸授权**），另改 1 条旧断言（授权内动作从「仍走一次卡」→「asked=0」）。变异 3 处各自真红：M1 撤「授权覆盖→跳卡」→ 红 2；M2 把签发回调提前到 bypass/always 早返回 → 红 2；M3 撤 danger 不签守卫 → 红 1；三处均 `python str.replace` 逐字节还原并 `cmp -s` 确认一致。smoke：app-control-smoke 404/404；双包 tsc --noEmit 均 0 错 | remaining：**仍非整包** —— 「计划级授权覆盖整个**计划**」还没到（现在只覆盖**同一个指纹动作**的重复调用，不是一个多步计划）；资源作用域方法（`file.*`/`git.*`/`terminal.*`）的自动签发未做（需先让 `planGrantPrecheck` 对「换了资源」回落到**弹卡**而非硬拒）；请求身份**带 grantId** 的端到端未做；授权的用户可见列表 / 手动撤销 UI、`GrantStore` 与审批卡「始终允许」两套机制的合并均未做`

**独立验收**：在启用 LAN、未知与变更 SSH 主机、授权撤销/过期、两客户端共链、恶意导入等边界做隔离 E1；未获信任前绝不发送 SSH 凭据。

**关联 ARC**：`ARC-004`；**MC**：`MC-004`、`MC-014`、`MC-031`、`MC-039`、`MC-052`、`MC-055`、`MC-062`、`MC-063`；**UXG**：`UXG-005`.

### W03 · durable OperationLedger / 失败与幂等语义（P1）

**目标**：分清内存更改、落盘成功、外部副作用、通知投递、未知结果和重试；返回状态必须与可回读事实一致。

**尚需完成**：OperationResult、operation ledger、outbox 已有分片，但 ARC-005/009 未整包通过，跨重启与外部副作用异常路径尚需联动。

**独立验收**：在认领前、写盘后、通知前后注入崩溃及重复请求；禁止同操作重复危险副作用，UNCERTAIN 不自动重跑，提交后可核 durable 版本。

**关联 ARC**：`ARC-005`、`ARC-009`；**MC**：`MC-025`、`MC-028`、`MC-051`、`MC-053`、`MC-066`、`MC-067`、`MC-068`、`MC-069`、`MC-072`、`MC-075`、`MC-080`、`MC-082`、`MC-083`、`MC-084`；**UXG**：`UXG-006`.

### W04 · 三 SDK 原生能力、上下文与配置版本（P1）

**目标**：由权威能力目录说明 Claude/Codex/Pi 的实际交付差异、会话恢复和配置锁版，不暗换 provider。

**尚需完成**：分片已覆盖能力矩阵/ConfigSnapshot/漂移 readback；但配置在 DEPLOY/RUN_START/NEXT_TURN 的生效点和真正 provider 交付仍欠整体 E2E。**增量（2026-10-13）**：`ARC-016` 又落一片 —— 把此前**只有契约、没有生产调用方**的 `resolveConfigBinding` / `staleBindings` / `ConfigEffectiveAt=RUN_START` 接进运行史 readback 这条真实路径（见下），于是 `RUN_START` 生效时点由**唯一一处**声明式锁版判定驱动；DEPLOY/NEXT_TURN 与三引擎真实交付仍未接，整包保持空勾。

**独立验收**：三引擎各验证能力缺失、审批拒绝、配置变更、恢复失败、子任务归属；不使用模拟绿灯替代真实 SDK 能力结论。

**关联 ARC**：`ARC-003`、`ARC-008`、`ARC-014`、`ARC-016`；**MC**：`MC-056`、`MC-057`、`MC-070`、`MC-074`、`MC-076`、`MC-077`、`MC-078`、`MC-079`、`MC-082`、`MC-090`、`MC-092`、`MC-093`；**UXG**：`UXG-002`.

**独立记忆专项补充（2026-10-14）**：MC-092/093 已登记在统一台账。三引擎共享宿主 Markdown 长期记忆和五个 memory 工具，但必须继续统一通用业务 API 的会话项目授权，并验证最终存储内容的敏感字段。真实 SDK 交付、历史删除语义及大量文件性能均未整体签收。

**2026-10-14 独立审查新增 MC-090（P1｜E2）**：`runner.ts` 构造了 `configSnapshot`，但第一次 `writeRun()` 无 spread/保留字段地重建 `latest`，在提交前把配置版本记录丢失（见 MC-090 详表）。既有 `run-store-smoke` 仅手工灌入 configSnapshot 证明 encode/decode 可保真；`orchestration-ipc-smoke` 也用手造历史行测变更计划，**没有证明生产起跑链会生成并保存该字段**。这直接阻断 ARC-016 的真实运行版本审计验收；不得把两套绿例当整包通过。

**增量事件（2026-10-13）**：`2026-10-13 | ARC-016 | DEV_CLAIM | E1+E2 | @contracts/configBinding 增纯函数 runStartBindings(locked)→ConfigBinding[]（PINNED+RUN_START，每当时锁下哈希一条、null 跳过、按 assetId 升序）；main/ipc/orchestration.ts 的 IPC.RUNS_HISTORY handler 把 configSnapshot.profiles 经 runStartBindings → resolveConfigBinding → staleBindings 折成「变更计划」configChangePlan 带过 IPC（只挑落后项，无落后不给字段）。红例：orchestration-ipc-smoke §ARC-016 变更计划 +7（只挑落后、effectiveHash=当时锁定值、policy=PINNED、stale=true、无快照不带字段）；run-store-smoke +9（runStartBindings 升序/PINNED/RUN_START/null 跳过、解析、源删不 stale 的边界、无落后为空）。变异 3 处各自真红并逐字节 cmp -s 还原：M1 调用端现值换成锁定值→orchestration-ipc 红 5；M2 契约 PINNED→LIVE→run-store 红 5；M3 撤 null 跳过→run-store 红 3。smoke：orchestration-ipc-smoke 268/268、run-store-smoke 197/197+59/59；双包 tsc --noEmit 均 0 错 | remaining：仍非整包 —— 「源比声明的 lock 新」的**部署前预检阻塞**（在**首次部署/起跑**时按声明 lock 拒绝或生成计划，而非只在运行史回读里显示落后）、DEPLOY/NEXT_TURN 生效点驱动、统一 PromptComposer 源优先级、三引擎真实交付 E2E 均未做`. ARC-016 开发完成保持空勾。

**独立专题审查增量（2026-10-14｜ARC-003/008/014｜E2 源码调用链 + E1 无头回归｜未作真实 SDK token A/B）**：

- **总判断**：三引擎工具调用与基本审批适配已具备，尚未形成按任务和预算进行 *真实模型可见工具集* 最小化的统一能力。不得把“工具执行时拒绝”“工具在 UI 中设为禁用”“工具定义不进模型上下文”混为一谈。ARC-003、ARC-008、ARC-014 开发/独立复核双标记不变，属于既有架构工作包的残余验收要求，不重复新开 MC。
- **Claude（@anthropic-ai/claude-agent-sdk 0.3.258）**：生产 Provider 的 `disallowedTools: resolveEngineExcludedToolsForProvider("claude")` 确能按名称从模型工具表排除；SDK 本地 `Options.tools?: string[] | preset` 也支持原生**允许清单**，但 Mcode 未用它按任务指定原生工具集。常规轮挂 library/workflow/memory/agent-read/app MCP，以及条件浏览器/插件；workflow MCP **已经不设 `alwaysLoad:true`**（延迟搜索），应保留这项有效优化，其他内置 MCP 仍有常驻描述开销。工作流节点 `mcpServerNames` 非空时用 `strictMcpConfig` 限定项目/用户/插件，并固定保留 library、workflow 两服务器，但 memory/agent-read/app 在收窄支路被省略；要与节点声明的场景所需能力核对，不能认为这几类在所有引擎都等效交付。
- **Pi（@earendil-works/pi-coding-agent 0.83.0）**：Mcode 在 `createAgentSession` 传 `excludeTools` 但 `tools=undefined`（默认完整内置），扩展每轮静态注册 app/memory/library/workflow/agent-read/条件 browser/plan/ask。当前 SDK 本地实现的 `session.setActiveToolsByName` 能更新模型工具表并重建基础 system prompt，Mcode 尚未以任务画像使用；若引入裁剪必须保留 plan→批准→执行期间 write/edit/bash 可恢复。Pi 的 `before_agent_start` 从本轮 base prompt 加 Mcode 片段，SDK 每轮重置 base，**未发现自行无限重复追加**。
- **Codex（@openai/codex 0.153.4 app-server）**：Mcode 的 `thread/start` 与 `thread/resume` 每轮都组装整套 `dynamicTools`（app/memory/library/workflow/agent-read/plan/ask/条件 browser），尚无按任务精简这些**Mcode 自定义**工具的逻辑；本版集成未实现原生内置工具按名单裁剪。源码指出恢复的线程对已登记 `dynamicTools` 存在旧工具保留：关闭 browser 后宿主派发层拒绝，**模型仍可能看到旧工具定义**，不能将此报成已节省 token；需受控实机 E2E 判定 app-server 能否在既有 thread 真正替换声明或只能换新 thread。
- **上下文片段**：`turnContextSections` 统一环境/记忆/项目指令/角色/工作流顺序；Claude 经 `systemPrompt.append`、Pi 经 `DefaultResourceLoader.appendSystemPrompt`、Codex 经 `developerInstructions`（thread/start/resume）注入。RuntimeManager 目前有环境指纹去重，记忆/工作流归属有边界；未发现证据支持“每轮无界重复注入”。不过身份、资料库路径、环境与工具使用说明多为默认常驻，尚无按任务/能力/token 预算分层。
- **建议实施顺序**：①先做 `EffectiveToolInventory` 诊断（按引擎导出*真正传给模型*的工具名、来源、Schema 字符数/估算 token，区分内置、MCP、动态及恢复遗留）；②定义宿主 `ToolProfile`（minimal/chat/code/research/browser/workflow 和 user override），只裁减模型可见声明，不绕开每个后端运行时审批；③Claude 使用 SDK `Options.tools`+按需 MCP，保持 workflow 的 deferred；Pi 在新会话使用可见工具集、需要转阶段时经 `setActiveToolsByName` 更新并验 plan 恢复；Codex 先安全裁剪 Mcode 自定义 `dynamicTools`，已恢复的 thread 不承诺可热替换，需明示不可收窄或新 thread/安全迁移策略；④做相同任务多引擎 A/B，量化实际 input/cache tokens、tool schema 规模、成功率、延迟、工具错误/拒绝次数和成本，未量化前不声称固定节省百分比。
- **验收矩阵**：三引擎各覆盖“无工具问答/单文件编辑/资料库研究/浏览器/工作流”五类任务，核对每次请求工具定义与插件/MCP/skills/提示词是否一致；禁用→新轮、plan→批准→执行、恢复同会话→变更工具、损坏策略 fail closed、跨项目/用户权限隔离以及读文档必要功能；对 Claude/Pi 动态删工具要证明实际模型端不可见，不是派发层只返回拒绝。建议为这一矩阵补 E1 原生 SDK/受控网关断言，再要求独立签收。
- **本轮实际测试**：`engine-tools-smoke 51/51`、`provider-context-smoke 56/56`、`engine-capability-matrix-smoke 55/55`、`mcp-engines-smoke 41/41`、`pi-loader-smoke 5/5` 均 PASS；`pnpm typecheck` 3/3 PASS、0 缓存。部分 smoke 是纯模块+源码接线验证；没有现场实际三模型 API token 计费或生产 SDK 传输截获。本轮未修改业务代码；本地还有其他 AI 并发开发，结论仅限审阅文件与上列测试当时的版本。

**增量事件（2026-10-14，本地开发 AI）**：`2026-10-14 | ARC-003 | DEV_CLAIM | E1+E2 | 组件级可用性接进能力目录。此前 `collectCapabilityInventory` 的 plugin descriptor 只有 `providers`（plugin 级 **ANY** 兼容列表），目录里没有**组件级**事实 —— 正是台账点名的缺口。修法：① `capabilityResolver.ts` 新增纯函数 `componentAvailabilityLabels(reports)`，把逐引擎的 `componentDeliveryReport` 翻成 `component:<providerId>:<componentId>` 标签（**必须带 providerId**，且**仅 DELIVERED** 产出 —— 同一插件对 Claude 收得到 command、对 Pi 收不到，不带引擎会把「某引擎有」谎报成「都有」）；`collectCapabilityInventory` 的 plugin 来源新增可选 `componentReports`，有它时把标签挂到插件 descriptor 的 `capabilities`。② `pluginManager.ts` 的 `EnabledPlugin` 新增 `componentReports`（逐引擎调用**已有**的 `componentDeliveryReport` 产出，与面板 `pluginComponentReadiness` 同源），不另造第二套判定。③ **真实调用端** `runner.ts` 的 `runWorkflowFromSession` 能力预检装配点（约 2208 行 `getEnabledPlugins()`）把 `p.componentReports` 喂进 `collectCapabilityInventory` —— 这是真实运行路径，不是旁路。**红例承重**：`capability-smoke` §4b 加 5 条 —— 承重条「同一插件对不同引擎的组件级标签不同（Claude 有 command:0、Pi 没有）」，另有「两家都有的 skill:0 两家都在」「INCOMPATIBLE 不产出可用标签」「需要 Pi 收 command 的需求被判不满足」「同一需求换 Claude 就满足（对照，证明不是空过）」。**变异（唯一接受的证据）2 处**（数红用非致命计数台重放这 5 条）：(M1) 标签去掉 providerId → 红 3/5（A、B、E 条）；(M2) 去掉 DELIVERED 状态闸（INCOMPATIBLE 也产出标签）→ 红 3/5（A、C、D 条）。两处各自逐字节 `cmp -s` 还原**确认一致**。smoke：`capability-smoke` **98/98**、`plugins-smoke` **221/0**、`plugins-ipc-smoke 139/139`；contracts 包 `tsc --noEmit` **0 错**，desktop 包唯一报错在 `appServices/scenePlanning.ts`（ARC-002 车道**未跟踪**新文件，非本切片、不在 HEAD，与本次改动无关）。**remaining（如实，不假称做全）**：本切片只把「**逐组件可用性事实进入能力目录**」这条接通；ARC-003 整包的其余要求 —— 按任务/预算做**真实模型可见工具集**最小化（Claude `Options.tools` 允许清单、Pi `setActiveToolsByName`、Codex 自定义 `dynamicTools` 裁剪，见上方独立审查「建议实施顺序」）、`EffectiveToolInventory` 诊断、`ToolProfile`、三引擎 A/B 量化 —— 均未做。ARC-003 **开发标记保持空勾**（仅追加分片记录）。`

### W05 · 插件、Module、MCP、Hook 的统一扩展体系（P1/P2）

**目标**：共享 capabilityId/版本/授权事实，Module、Hook、Workflow 保留各自执行器，禁止重复造三套 runtime。

**尚需完成（2026-10-14 独立复核）**：MC-060/061 均不满足原始验收。MC-061 已实现 HookRunner 授权判定、停用卸载撤权、独立 HostHookGrant 文件存储、`main/index.ts` 启动装配及 `hook_runs` 审计落盘；但 `issueHostHookGrant` 无正式用户签发入口，持久幂等、插件取消预算、审计读取/轮转仍缺，开发 `[ ]`／独立复核 `[ ]`。MC-060 只有写权限契约与校验分片，第三方 action 隔离执行宿主、审批和三端复用未闭环，开发 `[ ]`。
**本会话追加（2026-10-13，本地开发 AI）**：
- `2026-10-13 | MC-061 | DEV_CLAIM | E1 | HostHookGrant 授权原语：@contracts/hostHookGrant（默认拒绝/unmappable/allowed 三态判定，按插件+版本+事件+命令摘要绑定）+ main/hooks/hostHookGrants.ts（签发/撤销/按插件全撤/判定）+ pluginManager.toPluginState 把每条 hook 的 execution 从写死 unsupported 换成真判定结果（新增 granted 态）。plugins-smoke +16（221/0）。变异：默认拒绝短路 → 红 5；授权不校验版本 → 红 1 | remaining：真正执行通道（宿主 HookRunner 消费判定并真跑，一次且仅一次/取消/预算/审计）未做；HostHookGrant 未持久化；用户签发 UI 未做`
- `2026-10-14 | MC-061 | DEV_CLAIM | E1+E2 | **真正执行通道基础片**:`HookRunner.onEvent` 逐条消费插件 hook 授权判定 —— 默认拒绝不执行 + `pushRun(..., "skipped", reason)` + `bumpCount(id, "denied")`(报出来不静默丢);`granted` → 进既有 `runOne` 投递管线(并发/超时/重试原样适用)。新增 `DeliveryCounts.denied`、1s TTL 候选缓存(只缓存候选,判定每次重算)、注入缝 `setPluginHookSource`。`pluginHooks.ts`(新);`hostHookSourceOf`(唯一来源构造点,含真命令摘要);`pluginManager.toPluginState` 改用之(此前面板与执行通道来源不一致);`index.ts` 装配。`hook-runner-smoke` 104/104(原 94)、`plugins-smoke` 224/0(+3)。变异 3 处真红:deny→allow 红 8;撤上报 红 5;面板来源退回空摘要 红 1 | **remaining(与 W05 独立复审 2026-10-14 一致)**:独立复审指出**排队后撤权**的 E2 时间窗口(`runOne` 把工作延后到去抖 timer,`deliver` 真正 spawn 前**不再复验**授权/启用/版本 → 事件排队→用户撤权→旧候选仍执行)、grant 摘要**不含 matcher**(同命令同事件不同 matcher 共享授权)、`setPluginEnabled`/`removePlugin` **无 `revokeHostHookGrants`**调用;这些均**未修**,须执行前复验 + 取消已排队候选 + matcher 全绑定 + 禁用/卸载同步撤销;此外一次且仅一次的**持久**幂等键、插件 hook 级取消/预算、审计落盘、HostHookGrant 持久化、用户签发 UI 未做。开发标记**仍留未勾**
- `2026-10-14 | MC-061 | DEV_CLAIM | E1 | **HostHookGrant 持久化 + 插件 hook 审计落盘**:① 授权表接 `configureHostHookGrantPersist` 落盘 `<数据根>/hooks/host-hook-grants.json`(**复用** `grantStoreFile.atomicFileBlob`,不另写文件 IO),签发/撤销/按插件全撤各 `flush()`,重启 `load()` 载回并续 id,坏数据 fail-safe 退回空表;`index.ts` 装配 `assembleHostHookGrantPersist(dataRoot())`(评审点名的装配缺席已补)。② `store/db.ts` 加 `hook_runs` 表,`HookRunRepo` 落盘;`HookRunner.auditRun` 在 `pushRun` 与 `deliver` 终态两处 upsert 同一 runId,**只落插件 hook**(用户手写钩子只进环)、可注入 sink、绝不打断事件流。`hook-runner-smoke` 137/137(+30)。变异 9 处真红、`cmp -s` 还原。| remaining:①一次且仅一次的**持久**幂等键;②插件 hook 级取消/预算;③审计表**只写不读**(未接查询 UI/轮转/保留上限);④用户签发 UI 未做。开发标记**仍留未勾**`
- `2026-10-14 | MC-061 | DEV_CLAIM | E1 | **复审修复(堵 E2 时间窗口)**:① `HookRunner.onEvent` 匹配插件候选时把来源身份记进 `pluginSources`(hook id → 来源),`deliver` **真正 spawn 前复验** `decidePluginHookExecution` —— 补独立复审点名的「第 1 条跑起来期间撤权,轮到第 2 条仍按旧判定执行」(`hook-runner-smoke` +3);② `pluginManager.setPluginEnabled(false)` 与 `removePlugin` 各加一句 `revokeHostHookGrants(name)`(停用/卸载同步撤权,`plugins-smoke` +7)。变异 2 处真红、`cmp -s` 还原。**仍未修(复审另两条)**:grant 来源摘要不含 matcher;一次且仅一次的持久幂等键。开发标记**仍留未勾**
- `2026-10-14 | MC-061 | DEV_CLAIM | E1 | **用户签发入口(IPC + 契约接线)**:此前 `issueHostHookGrant` **无任何生产调用方** —— 普通用户在界面上没法给插件里某条 hook 授信,「默认拒绝」事实上成了「永远拒绝」。补三条 RPC 走全三层:① 契约 `packages/contracts/src/ipc/hostHookGrants.ts`(新,issue schema `.strict()` —— `grantId`/时间/`revoked` 由主进程签发,调用方给不了)+ `rpcMap.ts` 加 `RpcMap` 类型与 `IPC` 常量(`hooks.listHostHookGrants`/`issueHostHookGrant`/`revokeHostHookGrant`)+ `ipc.ts` 门面导出;② 主进程 `main/ipc/hooks.ts` 加三条 handler,接**既有**`listHostHookGrants`/`issueHostHookGrant`/`revokeHostHookGrant`(不另造实现),`ttlMs`(24h)/`now` 由宿主给,签发失败显式 `{ok:false}` 不吞;③ preload 白名单 + `gen-app-api-catalog` 重跑。**门禁**:`appControl/policy.ts` 把 issue/revoke 钉 **blocked**(与 `workflow.approve` 同一条纪律 —— agent 任何理由都不该签出执行授权,直接封路而非每次弹卡),list 为 read;`app_api_call`/`mcp.api.call` 都够不到,只有桌面渲染端(`window.api.hooks.*`)够得到;mobile `webApi.ts` 无 hooks 命名空间(同 plugins),Proxy 兜底 `webUnsupported`。**红例承重**:`hooks-ipc-smoke` §6 加 22 条 —— 签发前 denied / 签发后 allowed(面板 granted)/ 事件**真跑起来**、撤销后**不再跑**(环里带原因的 skipped)/ 重启重载仍 allowed / 伪造宿主字段被拒 / agent 够不到的 blocked 门禁 / 空 grantId 拒。`hooks-ipc-smoke` **118/118**(原 93)。**变异 4 处真红、`cmp -s` 逐字节还原**:撤 revoke 的实调 → 红(撤销后仍 allowed);grant 绑错插件名 → 红 2(签发后仍 denied + 等不到执行);撤 policy 的 BLOCKED → 红 2(issue/revoke 落到 write,agent 可达);撤 issue schema `.strict()` → 红(伪造 revoked 被采纳)。| remaining:①**设置页 UI 面板未做** —— 本片只做宿主入口(契约 / 主进程 / preload),用户还没有可点的按钮去列 / 签 / 撤;②一次且仅一次的**持久**幂等键未做;③插件 hook 级取消/预算未做;④审计表只写不读(查询 UI / 轮转 / 保留上限)未做。开发标记**仍留未勾**(UI 未闭环)`
- `2026-10-13 | MC-060 | DEV_CLAIM | E1 | 模块写权限契约：@contracts/modules + moduleCapability 的 permissions 由 literal(resource.read) 放宽为 enum(resource.read, resource.write) 且拒重复；ModuleHost.validate 的 action 能力仅在 manifest 声明 resource.write 时放行（否则拒，文案点名 resource.write）；能力目录面板加 permissionResourceWrite 标签。module-phase2-security-smoke 20/20（没声明→拒 + 声明了→可接）、module-contract-smoke 107/107。变异：action 闸退回无条件拒 → 正控真红；撤 dedup refine → 真红 | remaining：统一 CapabilityRegistry 归 ARC-003/006 未做；第三方执行代码的隔离进程/沙箱、一次安装授权即在三 SDK/工作流/面板复用仍未做`
- `2026-10-14 | MC-060 | DEV_CLAIM | E1 | **权限判定收成一份 + 堵 action 元数据谎报只读**:`@contracts/modules` 新增共享判据 `missingCapabilityPermission(kind, permissions)`(唯一权威);`ModuleHost.register`(能力元数据)**与** `validate`(模块清单,经 addBuiltin/install/restore 三入口)都改用它 —— 此前两处各写一遍 `kind === "action"`,且 register 侧只查 resource.read,于是 action 能力可在**自己的元数据里谎报只读**(面板渲染的正是 metadata.permissions)而清单闸放行。`module-phase2-security-smoke` 20→22、`module-catalog-smoke` 18/2(red on master)→20/0、`module-contract-smoke` 107/0。变异 3 处真红:M1 共享判据死分支→红 3;M2 中和 register 侧→红 1(仅元数据);M3 中和 validate 侧→红 2(仅 builtin+用户安装)—— M2/M3 证明两处是**独立**判定落点。| remaining:统一 CapabilityRegistry(ARC-003/006);隔离进程/沙箱;一次安装授权即在三 SDK 复用的**运行时投影**(本片只统一「种类→所需权限」一层);action 能力的受控执行宿主(审批/作用域/sideEffect 仍在权限名一层)。开发标记**仍留未勾**`
- `2026-10-14 | MC-060 | DEV_CLAIM | E1+E2 | **action 能力的受控执行宿主(执行点审批 + 作用域)**:上一片只统一了「准入」一层(清单/元数据能否**挂**一个 action 能力);本片补上第二层 —— **每一次 action 执行**都要过闸。`@contracts/modules` 新增纯判据 `actionInvocationDenied(kind, permissions, approvalChannelAvailable)`(与 `missingCapabilityPermission` **分开**,两层各管一段:准入问「能不能挂」,本函数问「这一次执行放不放行」);`ModuleHost` 的 `options` 新增可选审批端口 `requestApproval(req)`(与 `authorize`/`persist` 同款注入,host 仍不 import Electron/DB/UI),`invoke` 在 `authorize(resource)` 之后、`capability.run` **之前**:①清单须持 `resource.write`、②有审批通道、③经通道批准 —— 三条任一不满足即抛拒,绝不落到执行;审批请求带 `moduleId/contributionId/capabilityId/resource` 作用域。**fail-closed 对齐 `gateAppAction`**:没有审批通道的环境一律拒(写档动作绝不被「没界面问」默认放行)。`module-phase2-security-smoke` 22→23(承重条:无通道→拒 / 通道拒绝→拒且作用域正确 / 通道批准→真执行且每次只问一次 / 非 action 不弹审批)、`module-contract-smoke` 107→112(纯判据 4 条 + 两层分开 1 条)、`module-catalog-smoke` 20/0。变异 3 处真红、逐字节 `cmp -s` 还原:M1 中和 `invoke` 执行点闸→`module-phase2-security` 22/1(承重条「Missing expected rejection」,action 未受检执行);M2 中和共享纯判据(action 分支短路)→contract 110/2 + security 22/1;M3 只中和 `resource.write` 作用域分支→contract 111/1(作用域条红)。| remaining(如实,不假称做全):本片是**执行点审批闸 + 作用域**,**不是**隔离执行进程/沙箱 —— 第三方 action 代码仍与宿主同进程;①真审批端口尚未接进 `modules/service.ts` 的生产装配(仍是可选注入,生产 host 未注入 → 现有生产**只有只读能力**,action 能力一旦接入会 fail-closed 拒,需配套用户签发 UI 才可用);②三 SDK 复用、sideEffect 的**细粒度**作用域(文件级/字段级)、审批结果的一次性/时效 token 未做。开发标记**仍留未勾**`

**独立验收**：用一个仅访问临时目录的第三方测试扩展，从 Workflow/Module UI/Agent 三入口执行/取消/撤权，验证版本迁移和不自执行未批准 JS。

**关联 ARC**：`ARC-006`、`ARC-011`、`ARC-014`；**MC**：`MC-060`、`MC-061`、`MC-071`、`MC-074`、`MC-077`、`MC-078`、`MC-094`；**UXG**：—.

**2026-10-14 独立 Hook/Skill/插件/MCP 专项补证**：
- **Hook（关联 MC-061，E2，当日并行开发未完成验收）**：审查进行期间工作区新增 `hooks/pluginHooks.ts`、`hostHookGrants.ts` 的来源指纹、`HookRunner.setPluginHookSource` 与 `index.ts` 宿主装配；源码现已有事件匹配 → 判 HostHookGrant → 放行到 `runOne` 的链路（不能继续沿用“完全没有调用端”的旧结论）。但 `issueHostHookGrant`、`revokeHostHookGrants` 尚未发现生产 UI/安装/停用/卸载调用方，授权单例仍纯内存、默认拒绝。`HookRunner.onEvent` 在事件出现时校验授权，`runOne` 可将工作延后到去抖 timer / `coalescePending`，`deliver` 在真正 spawn 前不再判授权、插件当前启用状态或版本，因此“事件排队 → 用户撤权/停用 → 旧候选仍执行”存在 E2 时间窗口。对 grant 的来源摘要仅含插件、版本、原生事件、命令摘要，不含 hook matcher；同命令同事件但不同 matcher 的两个 hook 将共享短 id 和授权粒度，改变 matcher 也不导致旧授权失效。`setPluginEnabled`/`removePlugin` 中无 `revokeHostHookGrants` 调用。修复应采用执行前复验、取消/清空已排队候选、matcher/source identity 全绑定，以及禁用/卸载/重装同步撤销；验证并发、重启和授权过期。`componentDeliveryReport` 静态把 Claude 兼容 hook 标为 `DELIVERED`，但在真实 Hook 授权/交付未完成前不能当作已可执行的场景预检事实（ARC-014），需修正可用性层次。`plugins-ui-smoke` 仍向用户提示 hook 不执行，和新试验接线的正式产品状态应同步。
- **Skill（新 MC-094，E2）**：`ipc/skills.ts` 的 `projectSkillsRoot` 和 `skills.copyToProject` 把技能写在 `<project>/.claude/skills`，`listSkillsForProject` 可列、可读；但 `PiAgentSdkProvider` 的 `buildPiSkillLoader` 仅传入全局 `~/.mcode/skills` + 插件根（Pi 原生默认 `.pi/skills`）；`CodexAgentSdkProvider` 的 `skills/extraRoots/set` 也只包含 `skillRootsFor` 的全局库及插件根；均缺项目 `.claude/skills`，从列表可见不能推出 SDK 已装载。Claude `settingSources=["user"]` 是否仍发现项目技能须 E1 实测，不宣称已证明缺失。已有 `skill-copy-smoke 42/42` 只能证明项目落盘/list，看不到真实 SDK 交付；`pi-skill-scope-smoke 10/10` 仅检查全局+插件选择集。最小修复与验收详 MC-094。
- **MCP 矩阵（原 MC-077 复核失败，E1 现有 smoke + E2）**：`skillEngines.ts.parseEnginesMapText` 对 JSON 对象内不是对象的条目直接 `continue`，最后返回 `ok:true`；`engineEnabled` 对被丢弃名默认 true。即 `{"restricted":{"codex":false}}` 若局部损坏成 `{"restricted":5}`，用户原本的限制消失，Claude/Codex MCP/Skill 都受共享逻辑影响。`mcp-engines-smoke` 已明确断言“全坏条目 → VALID 空 map(全可见)”，不是停留在假设。MC-077 过去修复了整份 JSON 解析失败及 last-good，但漏了“有效 JSON、值类型错误”；按台账复核失败规则撤销双勾，须让非法条目回退 last-good 相同名称限制，或整份 INVALID/fail-closed，不能当删除限制。需新增回归并变异验证。
- **MCP / 插件现有正向边界**：项目 `.mcp.json` 按项目身份+名称+配置指纹信任；Claude/Codex 提供 user/project/plugin MCP，Pi 不支持原生 MCP（有宿主动态工具是另一概念）；插件禁用后的根目录交付、MCP 开关已有测试。公网 MC-089 的 owner 淘汰修复仍由并行开发进行，不能用 `public-mcp-session-smoke` 通过声称跨认证重连和在途任务回收验收完成。`skills.importGithub` 的旧版整仓浅克隆/递归扫描与 `skillMarket` 的按需摘要安装是两条路；前者尚无条数、层级和仓库字节预算，需 E3 容量边界验证，不能把后者 41/41 的按需安装测试当成全部 Skill 导入安全证明。
- **本轮已跑回归**：HookRunner 早期 94/94、并行开发新增插件 Hook 执行红绿例后复跑 104/104（验证默认拒绝/授信执行/事件前撤权；**未覆盖排队后撤权**），Hook 命令 96/96、Hook IPC 93/93；Skill matrix 37/37+75/75、Pi skill scope 10/10、skill-lazy 41/41、项目 Skill copy 42/42；插件管理 221/221、插件 IPC 139/139、extension bridge 637 assertions；MCP matrix 41/41、项目信任身份 25/25，MCP UI 6/6、public MCP session lifecycle 通过。`mcp-ipc-smoke` 因 Windows Git Bash `ln -s /tmp/.../node_modules` 报 Device or resource busy 未运行测试断言，是环境/装配阻断，不记成业务功能通过或失败。上述组件 smoke 不包含真实 Claude/Codex/Pi 载入/执行或并行编辑中的最新 Hook 生产 E2E，MC-061/077/094 不关单。

**2026-10-14｜扩展存储独立复审（MC-095/096）**：E1 在仅使用临时数据根的 Windows 隔离进程中运行生产 `lib/extensionStore.ts`：创建 `<root>/extensions/jump` 指向外部目录的 Junction 后，`writeFileInExtension(root,"jump","pwn.txt","TEST_ONLY")` 返回 `{ok:true,bytes:9}`，外部目录确实生成该文件。根因是 `physicalExtensionDir()` 信任扩展 ID 根目录的 realpath，却没有验证仍位于 `extensionsDir(root)` 的真实物理目录下。另 E1：先 `writeValue(root,"good","important","KEEP_ME")`，再 `writeFileInExtension(root,"good","store.json","NOT_JSON")` 返回 ok，随后 `readValue(root,"good","important")` 为 null，证明同一扩展的文件通道可直接破坏内部 KV 文件。`extensionStore` 六个 IPC schema 都接受请求者自填 extensionId、主进程 handler 未见调用主体绑定，`app_api_call` 暴露这几种 RPC，`get/readFile/listFiles` 按动词属于 read；面板 `panelBridge` 绑定本扩展 ID 的保护不能代替 Agent 通用调用端的权限验证（E2，待 Agent 端 E1）。文件通道仅按单文件 4MB 拒绝，不等于扩展总量配额。基础 `extension-store-smoke` 126/126、`extension-bridge-smoke` 637 assertions 均过，但均未覆盖根 Junction、保留 store.json 和通用 Agent 调用身份。建议根目录物理 containment + 写前复查/无跟随打开、宿主可信 extensionId 授权、保留内部元数据、累计预算及坏数据恢复；详 MC-095/096。

**MC-096 开发修复（2026-10-14，本地开发 AI）**：`@contracts/extensionStore` 新增唯一一份判据 `isReservedExtensionRelPath` + 常量 `EXTENSION_STORE_FILE`（根级 `store.json` 及 `store.json.` 前缀变体，大小写不敏感；子目录同名不误伤）；lib 层 `resolveInExtension`（读/写共用）与 `listFilesInExtension` 复用同一判据。**E1 红例**：`extension-store-smoke` 137→161（+24）。**变异 3 处**真红、`cmp -s` 还原：撤 lib 闸 → 红 11（精确复现 `{ok:true,bytes:8}` + 键值被覆盖）；撤 listFiles 过滤 → 红 1；契约判据恒 false → 红 16。**remaining**：① store.json 未迁入物理隔离命名空间，仅靠通道拒绝；② **坏 JSON 仍静默当空**，无 last-good/隔离/明确恢复；③ 无扩展累计配额；④ 文件通道无 rename/delete 入口。开发标记**已勾**。

**MC-096 读侧修复（2026-10-14，本地开发 AI）—— 坏 store.json 从 last-good 恢复**：复核点名「坏 JSON 不应无告警变空」。`persist` 每次写主文件前先刷新 `<store.json>.last-good`;`readStoreRaw` 主文件坏时先试 last-good 恢复;`readStore` 改走三态读,`readValue` 因此也吃恢复。**E1**:`extension-store-smoke` 173→177(+4:写生成 last-good、主文件坏但 last-good 在读回 keep/added、last-good 也没才当空)。**变异**:撤恢复→红 2;`cmp -s` 还原后 177/177。**remaining**:① store.json 未迁入物理隔离命名空间;② 总量检查与写入间的并发竞态未消。开发标记**待复核**。

**MC-096 续修（2026-10-14，本地开发 AI）—— 坏 store.json 写侧 fail-closed**：此前读侧「坏当空」（宽容,不让扩展崩）是对的,但**写侧也走同一条**:读回空 → 加键 → 整份重写 → **用户原有键值静默丢失**。新增 `@contracts/extensionStore` 的 `readStoreFileDetailed`（三态 `MISSING`/`VALID`/`CORRUPT`）;`lib/extensionStore.ts` 的 `writeValue`/`removeValue` 见 `CORRUPT` 即拒写/不动。**E1 红例**:`extension-store-smoke` 161→168(+7,并改写旧断言「坏文件之后仍能正常写」—— 那正是 fail-open 凭证)。**变异**:退回「坏当空覆盖」→ 红 4(`{"version":1,...}` 盖掉 `{ not json`);`cmp -s` 还原后 168/168。开发标记**已勾**。

**MC-096 再续（2026-10-14，本地开发 AI）—— 扩展目录累计字节配额**：`writeFileInExtension` 只封单文件 4MB,不封总量 → 一个扩展能写无数个 4MB 文件塞满磁盘。新增 `EXTENSION_TOTAL_MAX`(32MB);按「目录当前总量 − 被覆盖文件旧大小 + 本次增量」判,超限拒写。**E1 红例**:`extension-store-smoke` 168→173(+5:写满 8×4MB、第 9 块拒、被拒块没落盘、覆盖写只算增量、配额按扩展各算)。**变异**:撤累计检查 → 红 2;`cmp -s` 还原后 173/173。**remaining**:① store.json 未迁入物理隔离命名空间;④ 文件通道无 rename/delete 入口。开发标记**已勾**。

**MC-095 开发修复（2026-10-14，本地开发 AI）**：`lib/extensionStore.ts` 新增根级物理包含判据 `extensionRootWithinExtensions`，复用 `realPathWithin` 的 `physicalTargetInRoot`（唯一一份，未另写）。**文件通道**（`physicalExtensionDir`）与**键值通道**（`readStore`/`persist`）共用这一道：扩展 ID 根目录 realpath 必须仍在 `extensionsDir(root)` 内，否则视为不存在/不落盘。**E1**：`extension-store-smoke` +11（§7.5，本机以**真 Junction** 构造，非 mock；根链接的文件写/读/list、键值写/读全被拒，外部目录无泄漏，不误伤正常扩展）。**变异 4 处**各自真红、`cmp -s` 还原：helper 恒真→红 6；只撤文件闸→红 4；只撤 KV 闸→红 3；只撤读闸→红 1。**remaining**：① MC-096 未处理（独立缺陷）；② 六条 IPC 仍接受自填 extensionId，**通用 Agent 调用端未绑可信身份**；③ 无累计配额；④ 判据与使用点间仍有 TOCTOU。开发标记**已勾**。

**2026-10-14 独立审查增量：McodeAI 自维护插件/扩展（E1+E2；ARC-003/006/011/014）**

- **架构事实纠偏**：插件 Manifest 已支持 capabilities[] 和 nodeTypes；capabilityResolver 已有统一 Capability Inventory、逐引擎组件标签；scenePreflight 真实对接能力预检，NodeType 目录支持 local > plugin > builtin；ModuleHost 已有受控注册、审批的 task/query/action。此前笼统提出“没有 Capability Registry”不准确，不应另造第二套。先前建议 MC-099～105 尚不是现有正式 Bug，不能机械开七条重复问题。
- **新确认 MC-099：能力自报导致场景预检假阳性**。当前 PluginManifestSchema 允许任意 kind 的 capabilities 声明，pluginCapabilityDescriptors 无条件转为宿主可用 Descriptor，而不交叉确认宿主实际注册/SDK 工具交付/调用权限。E1 生产纯函数隔离测试：只声明 fictional-ext 的 builtin nonexistent.host.action，Manifest 接受；没有该插件时 resolveCapabilities.ok=false；仅加入 Manifest（实际没有执行器）后变为 true。输出：{"manifestAccepted":true,"withoutPlugin":false,"withManifestOnly":true,"actualExecutorLoaded":false,"source":"plugin:fictional-ext"}。声明假阳性不意味着已经获得 OS 执行权限。修复和独立验收见 MC-099。

**MC-099 开发修复（2026-10-14，本地开发 AI）**：`pluginCapabilityDescriptors` 只收插件**真能贡献**的 kind（`skill`/`mcp`/`plugin`/`provider`）；`builtin`/`executor` 是**宿主领地**，声明一律丢弃 —— 这两类的唯一权威是 `hostCapabilityDescriptors` / `executorCapabilityDescriptors`。新增 `rejectedPluginHostCapabilities` **显式报出**被拒的宿主领地声明（不静默丢）。**E1 红例**：`capability-smoke` 98→104（+6：声明 builtin/executor 不被转成可用、skill 照收、被拒可报出、注入 inventory 后对不存在能力的需求仍判缺）。**变异**：撤 kind 过滤 → 断言真红；`cmp -s` 逐字节还原后 104。**remaining**：插件**依赖/迁移**字段的安装时契约、安装来源完整源码 hash、`plugins.validate`/`doctor`/`rollback` 主进程工具均未做（归 ARC-011）。开发标记**已勾**。
- **AI 修改闭环缺口归现有 ARC-006/011/014，不重复新 Bug**：app_api_call 已有 plugins.list/installLocal/installGit/setEnabled/remove、scene.preflight 等可用接口，安装/卸载/启停为 danger 审批，不能为了便利 AI 绕过。尚无正式可复用的 plugins.validate / doctor / test / scaffold / diff / rollback 主进程工具或 RPC。install 管线已有 stage、同版本交换时的临时 backup 和失败补偿；但成功更新只保留一个版本，会清理旧版，所以没有“修改不满意就回上一个已知良好版本”的运维回滚。PluginManifestSchema 为 passthrough，可书写 dependencies/migration 字段，但并无安装时执行这些依赖与数据迁移约束的契约；不能把任意字段当成能力。安装来源记录仅 kind/ref/installedAt，缺完整可复核源码 hash。把版本管理、可信来源、依赖、升级迁移、回滚一起补到 ARC-011。
- **最低可交付工作流**：AI 在工作区生成隔离草稿 → 宿主 validate（Manifest/组件路径/权限/真实 Registry/SDK 可见性/依赖）→ temp-root smoke 和 dry-run 场景预检 → 用户授权 → 版本 hash 和配置快照 → 原子安装与真实 Provider 验证 → 失败拒交付并可恢复上一已验证版本。可执行体仍交 SDK、ModuleHost、HookRunner，能力目录只负责事实与就绪状态，避免把任意插件脚本当沙箱代码运行。
- **现场测试**：plugins-smoke 231/231、plugins-ipc-smoke 退出码 0、capability-smoke 98 checks、scene-preflight-smoke 15/15、module-platform-smoke 33 checks，均 PASS；其既有绿色测试未覆盖 MC-099 的“无执行器却有 Manifest 声明”反例。本轮不改业务源码，且开发 AI 有并行未提交修改。

### W06 · 自动化触发、长时任务与多 Agent 治理（P1）

**目标**：投递策略、背压、取消、预算和父子归属由可观测事实驱动，事件丢弃/合并/重试均有原因。

**尚需完成**：HookRunner 的重试/去抖、文件事件策略已有分片；ARC-007/013/015 对持久事件、子 Agent 链式取消和长期场景仍未完全验收。MC-089 新增：公网客户端会话的签发淘汰与资源 owner 集合未联动，已动态证明遗留历史 owner；正在运行的进程/SSH 等后续访问存在丢失身份的风险。

**独立验收**：一秒百事件、文件 rename/delete、超长输出、重启与子 Agent 取消分别注入异常；不得承诺无法证明的 exactly-once。

**增量事件（2026-10-13 会话，本地开发 AI）**：
- `2026-10-13 | ARC-013 | DEV_CLAIM | E1+E2 | sceneTaskRuntime + runner.runInNodeSession：场景总预算接进真实派发（起前 reserve、收轮按实际用量 settle、读不到用量 release）。scene-task-smoke +31（194/194，含 §16/§17）；node-live-smoke 20/20 证未改真实派发行为。变异 3 处真红（ensure 复取分支/settle 改 release/起前 reserve 改没）| remaining：CommandService 父子关系与 operationId、SceneTask 落 DB、成本显示、A→B→C 端到端、并发维度闸门未做`
- `2026-10-13 | ARC-005 | DEV_CLAIM | E1+E2 | store/outbox.ts：RetryableOutbox(有界队列+有界重试+失败逐条落 deadLetters)，runStore 的 onRunCommitted 扇出改走它（复用 @contracts/durableEvent 状态机）。run-store-smoke §ARC-005 切片⑤ +15（185/185+59/59）。变异：isPendingEnvelope 补投短路 → 红 12 | remaining：跨重启持久 outbox 未建；appControl/SettingRepo.set 仍旧语义`
- `2026-10-13 | ARC-009 | DEV_CLAIM | E1 | @contracts/commit 增 durableRevisionOf；operationLedger.settle 的 mutating 分支在 DURABLE 时把 sqlite:<n> 盖进结果（新增 operation-ledger-smoke 9/9）。变异：短路盖版本 → 红 2 | remaining：尚未接进 makeOp；其它提交点（runStore.saveRun）未接`
- `2026-10-13 | ARC-009 | DEV_CLAIM | E1+E2 | customUi/settingSync.ts：桌面刷新通知「窗口不在就丢」→ 单槽攒下 + 窗口出现补发（注入发件端口避免与 window.ts 循环）。新增 setting-notify-outbox-smoke 18/18。变异：静默丢 → 红 9；flush 不清空 → 红 3 | remaining：跨重启 outbox、多键通知未做`
- `2026-10-13 | ARC-017 | DEV_CLAIM | E2 | smoke 侧块提取收口：document-read-smoke 的 8 处手写块提取改走权威 toolTextOf；engine-tools-smoke ARC-017 段 +2 源码不变量（51/51）。变异真红 | remaining：消息流翻译与 toContent 双向转换不在判据内`

**关联 ARC**：`ARC-007`、`ARC-013`、`ARC-015`；**MC**：`MC-020`、`MC-021`、`MC-022`、`MC-033`、`MC-046`、`MC-051`、`MC-073`、`MC-081`、`MC-089`、`MC-091`；**UXG**：`UXG-006`.

**2026-10-14 独立审查新增 MC-091（P1/P2｜E1+E2）**：文件输入正常 path 封顶 500，但忙时 `fire()` 的重排队合并 `pending.files=[...new Set(...)]`、`pending.changes.set()` 未再封顶/计丢弃；事件批 `mergeEventPayload` 将所有不同 itemId 的条目无界放大（生产函数 1500/1500 E1）；见 MC-091。需要统一容量、背压、可观测丢弃，不能为了限制规模静默丢业务条目。**设计待验 E3**：自动化 `start()` 在 `await reloadAll()` 之前已启 30 秒 ticker，低速初始化时可能提前 tick；定时 claim 的 `SUCCEEDED` 目前是领取完成/已终结语义，不可直接解释成下游业务成功，需明确成功、失败与 UNCERTAIN 的事实映射。

### W07 · 文件与资料库：物理身份、相对资源、编辑恢复（P1）

**目标**：项目、linked 库与 Markdown/PDF/图片共享可信资源身份；编辑、预览、冲突与恢复不可突破原授权。

**尚需完成**：MC-085/086/087 已独立关闭，尚缺 UXG-003 大目录、快速切换、跨窗口及并发写入等完整用户旅程验证。

**独立验收**：linked 库外图片可合法读而不扩大全局项目权限；多 Agent 并发写不丢更新；PDF/Markdown 快速切换和重启恢复正确。

**关联 ARC**：—；**MC**：`MC-001`、`MC-002`、`MC-006`、`MC-035`、`MC-041`、`MC-068`、`MC-069`、`MC-085`、`MC-086`、`MC-087`；**UXG**：`UXG-003`.

**2026-10-14｜引用/文档独立复审（MC-097/098）**：已有 `file-links-smoke` 44/44、`file-links-ui-smoke` 10/10、`editor-save-smoke` 40/40、`onlyoffice-smoke` 32/32、`document-read-smoke` 43/43、`markdown-mode-smoke` 32/32 通过。`markdown-quote-smoke` 与其它预览/引用基础测试通过；`library-entry-path-smoke` 因 Git Bash `ln -s /tmp/.../node_modules` 报 Device or resource busy 未运行断言，不能算通过。`markdownFileWrites.ts` 的外部改动比较发生在 Renderer 的 `api.file.readFile` 后，才调用 `api.file.writeFile`；主进程 `ipc/files.ts` 的 FILE_WRITE 仅收 `{filePath,content}` 并 `await writeFile(filePath,content,"utf-8")`，不接版本/哈希条件、无跨进程锁、也不使用暂存+原子替换。E2 证明存在校验与写入之间被其他 Agent 改动的竞争窗口，尚未做交错写 E1 与崩溃注入；之前 40/40 仅证明渲染端同路径队列、预先发生的外部写检测。`FileEditor.tsx` 的 Monaco 引用文字取浮动选区旧快照，而行号在 `quoteFromEditor` 的 `editorRef.current.getSelection()` 实时重取；选择目标前若选区改变，正文与行号可能对不上（E2，待浏览器 E1）。`contentTag.ts` 的 `makeQuoteTag/composePromptWithTags` 没有总上下文预算；记 W04/UXG 容量待验收，不先记成已发生的溢出。详 MC-097/098。

### W08 · 用户体验、交互状态和可访问性（P1/P2）

**目标**：将业务状态、失败提示、成本和权限准确呈现；键盘、焦点、弹窗、多窗口和文档工作台一致。

**尚需完成**：UI-001 开发已修复但独立复核仍空；UI-004～050 的原始条目与勾选已遗失不可推断；UXG 7 项均未体验验收。

**独立验收**：UI-001 的迟到 resolve/reject/重开/不同资源/Esc/遮罩/IPC 失败补齐 Chromium 红绿；进行 U1 屏读、HiDPI、多窗口与长任务用户旅程。

**关联 ARC**：—；**MC**：`MC-012`、`MC-013`、`MC-042`、`MC-047`、`MC-048`；**UXG**：`UXG-004`、`UXG-005`、`UXG-007`.

### W09 · 研发质量门禁与回归索引（P2）

**目标**：权威 SDK ToolResult 类型、隔离测试和审查证据关联稳定源码快照，闭环后保留有界回归门禁。

**尚需完成**：ARC-017 和 MC-088 已双勾，不因其它 ARC 未完成自动回退；新依赖变更或跨平台回归要有新事件。
**2026-10-14 | W09 / MC-050/054 相关 | REGRESSION | HEAD `476e5043`→`0b274107` | E1（TypeScript 静态门禁）**：两次 `pnpm typecheck` 都退出码 **2**，contracts build/typecheck 通过、desktop `tsc --noEmit` 失败 3 条。① `scripts/maint-m07-smoke/main.ts:109` TS2339：`{ok?:boolean}` 上访问 `conflict`；测试文件不在当前 `git status --short` 未提交修改中，属于已跟踪测试源码与返回类型脱节；② `scripts/memory-smoke/main.ts:1102,1138` TS2554：调用缺少第 2 参数；该测试文件以及 `memory/manage.ts` / `ipc/memory.ts` 正在由其它 AI 并发未提交编辑，属于**工作区暂态**，未证实已提交 HEAD 有这两条。**不得把已跑绿的行为 smoke 等同于类型检查通过**。最小修复：维护精确 IPC 返回类型/判别联合，修复 smoke 预期；同步正在演进的记忆 manage/review 参数；重跑零缓存双包 typecheck 与对应 smoke。原 MC-050/054 的历史双勾不机械撤销，本次新增独立 REGRESSION 事件。
**2026-10-14 | W09 门禁恢复 | REVIEW_PASSED（仅 typecheck） | HEAD `dc8acef8` | E1**：本轮并发开发提交 `dc8acef8 fix(MC-092 续): 记忆作用域闸扩到 manage/review/reviewDelete + 修 MC-097 遗留类型错`，包含 `maint-m07-smoke` 返回值类型修复与 `memory-smoke` 新调用调整；复跑 `pnpm typecheck` **退出码 0，3/3 任务成功**（其中 contracts 2 项命中缓存、desktop 1 项重新执行）。因此上述 REGRESSION 在此 HEAD 的类型检查维度**已恢复**，不属于当前红灯；仍保留发生记录及两次失败证据，不据此宣称全部 smoke/发行门禁已通过。

**独立验收**：同一冻结版本执行 typecheck、混合文本/图片工具结果、浏览器跨项目隔离、发行与跨平台 smoke；有新红例再建 REGRESSION。

**关联 ARC**：`ARC-017`；**MC**：`MC-009`、`MC-010`、`MC-011`、`MC-050`、`MC-054`、`MC-065`、`MC-076`、`MC-088`；**UXG**：—.



**本会话合并提交对照（2026-10-14）**：MC-060 action 受控执行宿主(执行点审批+作用域,module-phase2 23/0、module-contract 112/0);MC-100 ToolProfile 选择层(effective-tools 90/90);MC-089 失效凭据在途资源留存报告+释放入口(mcp-endpoint 768/768);MC-092 记忆诊断按可见谓词过滤(memory-smoke 264);MC-077 Skill/MCP 投递负例(skill-engines 119、mcp-engines 64);MC-093 读侧遮蔽(retrieval 三处,memory-smoke 256);MC-096 last-good 恢复(extension-store 177);MC-059 expectedRevision(claude-ipc 250);MC-101 EffectiveToolInventory 诊断(effective-tools 44)。以上均已提交推送,每个变异验证真红、`cmp -s` 逐字节还原。

## 3. 本轮重点 MC 修复与独立复审对照（含已复审通过项）

本表为当日重点 MC 的**开发声明 + 独立复核实际状态**：有独立 E1/E2 证据的具体缺陷才双勾；仅提交部分分片或缺原始负例者保持空勾；历史失败/通过详情在下方续记，不倒改历史快照。

| 编号/问题 | 开发已修复 | 独立复核 | 归并 | 最小下一步 |
| --- | :---: | :---: | --- | --- |
| `MC-004` LAN 明文 HTTP 与凭据 | `[ ]` | `[ ]` | W02 | 检查服务开启后是否仍以明文发送密码或 Bearer；区分默认关闭与传输安全。 |
| `MC-014` SSH 主机密钥校验 | `[ ]` | `[ ]` | W02 | 真 hostVerifier：首连未知、指纹变化及首次认证前拒绝。 |
| `MC-052` SSH 信任授权来源 | `[ ]` | `[ ]` | W02 | 不可经设置导入、自填 expectedFingerprint 或失效 grant 自行建立信任。 |
| `MC-058` 场景声明到部署交付 | `[ ]` | `[ ]` | W01 / ARC-002 | HEAD `650a7e37` 的原始 RPC 入参直通缺陷已在**未提交**开发工作树补上 `adaptScenePayload→rpcInput`、真实 Schema 检查，且加派发前 priorExistence/修订号保护；本轮 `scene-spec-smoke` PASS、`scene-apply-smoke` 141/142（剩一条原因文案断言红）、typecheck 3/3。整项未闭合：`callRpc` 合法返回 `{ok:false}` 仍可能算 done；存档 durable 失败仍可能执行；用户旧资源覆写内容没有自动恢复，签发/正式入口和重启恢复待验。 |
| `MC-059` 无窗 Agent 控制面 | `[ ]` | `[ ]` | W01 | 三端 createSessionAndSend 统一 + ActionContext(actorId/operationId/scope/expectedRevision/permissionGrant)已落(claude-ipc 271);无签发口铸覆盖 session.create 的 grant、无无人值守任务计划,整包未闭合。 |
| `MC-060` 第三方 Module action | `[ ]` | `[ ]` | W05 | 权限判定收成一份 + action 执行点审批/作用域闸已落(module-phase2 23/0);隔离进程沙箱、生产审批装配、三端复用未做。 |
| `MC-061` 插件 hooks 执行 | `[ ]` | `[ ]` | W05 | HookRunner/授权持久化/启动装配/审计 + 签发**宿主入口**(`ipc/hooks.ts` 签发/查询/撤销、preload、agent blocked,hooks-ipc 118)已**提交**;但 `src/renderer` 无 `issueHostHookGrant` 调用,设置页用户授权动作未接通;持久幂等、取消预算仍缺。 |
| `MC-077` Skills/MCP 错误矩阵恢复 | `[x]` | `[x]` | W04/ARC-014 | 2026-10-14 原错误行为独立 E1 复核通过（非法部分配置、last-good/无备份拒绝、三引擎 Skill/MCP 可见集合）；真人 SDK U1 属 ARC-014 后续验收。 |
| `MC-089` 公网 MCP 会话淘汰和资源归属不一致 | `[ ]` | `[ ]` | W06 | 归属回收 + 忙资源受控保留 + 留存报告 + 安全释放入口已落(mcp-endpoint 768/768);真 HTTP 小上限端到端、资源迁移未做。 |
| `MC-090` 工作流配置快照首次写盘前丢失 | `[x]` | `[x]` | W04 / ARC-016 | 真实 startWorkflowRun→磁盘重开→续跑仍保留起跑时 configSnapshot，源档案改版 drift 可读，node-live E1 复核通过。 |
| `MC-091` 自动化积压队列容量与事件合并缺口 | `[ ]` | `[ ]` | W06 / ARC-007/015 | 事件合并限 100 并报溢出 + **可跨重启的丢弃恢复游标**(`automation.droppedUndelivered`,派发时并进载荷清账)+ **清账晚于真正派发**(`050c5b9d`,进入 `9210f128`)+ **全局背压 / E3 启动竞态 / 欠账字段上界面**(`e6d647e1`)已**提交**(automation 704/704);分片持久队列/统一截断原语未做。 |
| `MC-092` 通用 app_api_call 缺少记忆项目隔离 | `[x]` | `[ ]` | W02/W04 | 主读写/manage/review/reviewDelete/assistant 已接可信项目隔离，诊断/扫描输出亦过同一可见谓词，memory-smoke 264/264；真实三 SDK E1 未验 |

| `MC-093` 记忆旧文件读取与写入敏感信息一致性 | `[x]` | `[x]` | W04 | 完整候选元数据/标题写侧敏感拒绝 + 历史/人工旧文件读侧遮蔽，memory / memory-injection E1 复核通过。 |
| `MC-094` 项目 Skill 管理与 SDK 实际发现范围不一致 | `[x]` | `[ ]` | W04/W05/ARC-014 | 宿主解析项目 Skill 并实际交付 Claude/Codex/Pi；验证模型可见与文件读取。（开发 2026-10-14：Codex/Pi 接项目根，pi-skill-scope 16/16、skill-engines 90/0） |
| `MC-095` 扩展数据区隔离边界不完整 | `[x]` | `[x]` | W02/W05 | 扩展物理根 Junction 越界拒绝 + 通用 Agent 无身份/跨身份读写拒绝，extension-store / app-control E1 复核通过。 |
| `MC-096` 扩展文件通道可覆盖内部 store.json | `[ ]` | `[ ]` | W05/W07 | 保留文件闸 + 坏数据写侧拒绝 + 32MB 容量 + 坏 JSON 读侧 last-good 恢复均已落(extension-store 177/177);总量检查与写入间的并发竞态未消。 |
| `MC-097` Markdown/源码编辑的校验与写入非原子 | `[x]` | `[x]` | W07 | 跨进程租约、CAS、原子替换与失败注入回读，maint-m07 / editor-save 全量绿，E1 复核通过。 |
| `MC-098` 引用正文和行号取自不同选区快照 | `[x]` | `[x]` | W07/W08 | Monaco 文本与行号一并冻结快照，renderer-pure / markdown-quote 回归绿，E1 复核通过。 |
| `MC-099` 插件自声明不存在的宿主能力被场景预检误判已就绪 | `[x]` | `[x]` | W01/W04/W05/ARC-003/006 | Manifest 虚构 builtin/executor 不能骗过实际就绪判断，capability / scene-preflight E1 复核通过。 |
| `MC-100` 工具按需发现与运行时注入 | `[ ]` | `[ ]` | W04 / ARC-003/008 | 三引擎 provider 已各接 `resolveEngineToolSelection`(Claude `options.tools`/`mcpServers`、Codex `dynamicTools`、Pi `tools`)，`skill-delivery-smoke §E` 驱动真 `startTurn` 证入参随画像/预算真变；**真二进制内部是否照做仍待 U1 活会话验收**。 |
| `MC-101` 三引擎上下文最小化 | `[ ]` | `[ ]` | W04 / ARC-008 | 工具预算/画像已装配至三引擎 SDK 入参(含修掉 full 画像下预算被丢的缺陷)；真 SDK 请求层 token 抓包与「大量扩展时确实不进请求」仍未验。 |
| `MC-102` 自定义 UI 测试桩未装配通知端口（本轮新发现） | `[x]` | `[x]` | W09 | **2026-10-14 独立 E1 REVIEW_PASSED**：原 custom-ui-refresh 的 window stub 已装配 `setSettingNotifyPort`；审查以**未改命令** `node apps/desktop/scripts/run-smokes.mjs custom-ui-refresh-smoke` 复跑 1/1 PASS。历史全量首次 249/251 不倒写成 251/251。 |

### 2026-10-14｜251 套全量复审与状态校正（E1/E2｜审查者）

**执行事实**：起检 HEAD `650a7e37`，全量运行中本地开发 AI 提交 `58543704`（MC-091），因此**工作区非冻结版**；`pnpm typecheck` 3/3 PASS（2 项缓存）；`node apps/desktop/scripts/run-smokes.mjs --all` **249/251 PASS、2 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1791924086521-26184-xvGkEl`。另 17 套关键 smoke 17/17 PASS。没有破坏真实数据、没有真实 SSH 主机拒绝实验或付费 SDK 会话。不是“全绿发行验收”。

**全量两红的独立复跑/定责**：`lsp-smoke` 全量 193/194，在“连续重启后只允许一个 server”处实际 2；单套独立复跑 **PASS**，尚不能稳定复现，记并发/时序待验证，不直接撤已有 MC 的双勾。`custom-ui-refresh-smoke` 全量失败、同一原命令单套也失败，断言 `approved external save must invalidate the desktop cache` 实际 0 期望 1；生产 `src/main/window.ts` 初始化调用 `setSettingNotifyPort`，但 `scripts/custom-ui-refresh-smoke/stubs/window.ts` 无该装配。临时入口 `apps/desktop/.tmp/review-custom-ui-entry.ts` 在执行**未修改的原始测试正文**之前安装真实端口，再执行 `apps/desktop/.tmp/review-custom-ui-run.sh`，整套 **PASS（退出 0）**。结论是**测试桩跟不上生产端口装配，不是已经证明产品外部保存后不刷新**；新增 MC-102，要求直接修正式 smoke 后原 `run-smokes.mjs --all` 重跑。不能用临时 wrapper 的通过冒称原套通过。

**本轮确认具体缺陷修复通过（MC 层，不代表对应 ARC/U1 全完成）**：MC-077、MC-090、MC-093、MC-095、MC-097、MC-098、MC-099 已据生产源码 E2 + 当前真实被测函数/IPC 的 E1 正反例复核，§3 与 §6 同步双勾。证据：skill-engines/mcp-engines、node-live/run-store、memory/memory-injection、extension-store/app-control、maint-m07/editor-save、renderer-pure/markdown-quote、capability/scene-preflight 全量均 PASS。MC-090 覆盖工作流真实起跑→磁盘重开→续跑版本与源档案改版差异；MC-093 覆盖写入标题/继承元数据与人工旧记忆读侧遮蔽；MC-095 覆盖无可信身份和跨扩展访问拒绝。真实用户三 SDK、Electron 手工操作、真 SIGKILL 等 U1 仍留在 ARC 评审，不冒充已做。

**明确不能因“只有 MC-091 未完成”的开发声明就双勾**：MC-004 默认 LAN 已安全关，但一旦显式开启仍经 `http://` 服务暴露口令/令牌（现有 opt-in 不是加密）；MC-058 于 `650a7e37` 实测合法 SceneSpec→真实 RPC Schema 的 workflow/skill/mcp/hook/module 五类投影缺字段（`apps/desktop/.tmp/mc058_contracts_run.sh`）；新出的 `adaptScenePayload` 还在**未提交改动**，必须等主编译器和执行端真实接线后重测，另有 `{ok:false}` 假成功、落盘失败仍派发与补偿误删旧资源反例；MC-061 HostHookGrant IPC/preload 已通，但 renderer 406 文件无 `issueHostHookGrant` 用户签发路径；MC-100/101 纯 ToolProfile 通过不等于 SDK 运行时裁剪，`apps/desktop/src/main` 中没有生产 `selectToolsForProfile` 调用；MC-059/060/089/096 有修复分片而整体目标/完整负例未闭合，按规范撤开发全项修复勾。MC-014/052/092/094 尚缺原要求的可信端到端/真实 SDK 实测，不借批量测试推定验收。

**MC-091 新版单独分析（HEAD `58543704`）**：`automation-smoke` 当前全量 PASS（修复了上轮 691/695 红例），`automation.droppedUndelivered` 已支持记录丢弃、30s 内冲刷、重启读回和派发合并。**残余 E2 失败窗口**：`automationRunner.ts` 在大约第 2329～2335 行**在 `runtimeManager.bindSession`、`SettingRepo.set(EVENT_CHAIN...)`、`void startWorkflowRun` 之前就调用 `drainDroppedUndelivered` 清账**；这些后续步骤若在“清账落盘后/真正开跑前”异常，丢弃事实永久消失，违反“未交付欠账”定义。最小修法：先持久领取/投递凭据与内容，真正入队确认后才结账；失败/不确定时保留欠账，重启演练同一批不漏不重，另外补全局背压/统一限额 E1。故 MC-091 仍保持 `[ ]/[ ]`，不把 695/695 直接当整个队列背压关闭。

**状态口径**：旧 §3 与 §6 对 MC-093 等状态前后冲突，本轮已以最新 E1 实证统一；更早 `REVIEW_FAILED` 与旧红例作为历史不删，新的审查通过事件以本节为准。全局 MC 索引目前已新增 MC-102（质量门禁），未验证的 ARC-001～016 仍保持开放，避免拿分片完成替代产品整链。

**同日审查追补：MC-058 并发工作树分片与 MC-102 正式复核通过**：审查期间 HEAD 增加 `d76114ed fix(MC-102)`，修改的正式 `scripts/custom-ui-refresh-smoke/stubs/window.ts` 现在于模块加载时注册 `setSettingNotifyPort`；用原始 `node apps/desktop/scripts/run-smokes.mjs custom-ui-refresh-smoke` 独立复跑 **1/1 PASS**，故 MC-102 在 §3/§6 双勾，旧 251 套 249/251 首轮事实保留。后续本地开发 AI 在未提交工作区为 MC-058 补了 `adaptScenePayload`/`rpcInput`、按真实 Schema 把残缺声明转成可解释拒绝，并补 `priorExistence`、`priorRevision`、`createdRevision` 防补偿误删。新版 `scene-spec-smoke` + `scene-apply-smoke` 一次 **2/2 PASS**、无缓存 `pnpm typecheck` **3/3 PASS**；再下一次边开发边测 `scene-spec-smoke` PASS、`custom-ui-refresh-smoke` PASS、`scene-apply-smoke` **141/142**，唯一红例为旧资源补偿原因文本断言（实际旧资源幸存、没有调用删除，故不能把文案红当成真实误删）。此时 typecheck 再验 **3/3 PASS**（2 缓存）。**仍有未解决生产缺口**：部署时 `await callRpc(...)` 不解析业务 `ok:false`、`persistStep` durable false 只 warn、授权来自调用者完整 Grant、没有正式 Scene Apply 用户签发/入口和断电续跑完整链。不能把 MC-058 关掉；但也不能再声称最新未提交版“仍然原始 payload 直通”或“补偿毫无旧资源检测”。以上阶段均处于并发工作区，并非单一冻结 HEAD 的完成证明。
### 2026-10-14｜本轮专项复审增量（HEAD fa76db7e + 未提交并发工作区）

**执行状态**：26 套回归已执行 24 PASS、2 FAIL。`remote-ssh-smoke` 174/176（远程任务取消两条红），`maint-m07-smoke` Node 子进程 `ETIMEDOUT`；因并发负载与本地开发中的故障/变异测试，须单独复跑后定性，严禁写 26/26 通过。`pnpm typecheck` 冷缓存 3/3 PASS。回归日志：`apps/desktop/.tmp/smoke-runs/1791922410556-37528-oP2RDb`。

**MC-058 / ARC-002：独立 E1 真实生产函数复现，REVIEW_FAILED（高优先级）**：新 `src/main/appServices/sceneDeploy.ts` 已实现 `dryRunScene/applyScene`，并有 smoke 通过，但 `applyScene` 中 `await callRpc(entry,command.payload)` 后不检查业务层 `ok:false`，只要不抛便记 `done`。独立临时数据库探针 `apps/desktop/.tmp/mc058_run.sh` 把真实 handler 返回设为 `{ok:false,error:"SIMULATED_REJECT_NO_WRITE"}`，观察输出 `MC058_PROBE={"calls":1,"resultOk":true,"kind":"applied","status":"active","stepStatus":"done","acceptancePassed":true}`（退出码 0 代表预期错误成功复现，**不是验收通过**）。既有 `scene-apply-smoke` 只覆盖合法成功及抛异常，缺本类返回型失败反例。修复须走共享业务结果判据（区分 REJECTED/FAILED/UNCERTAIN）并补负例；acceptance 不可只用步骤 done 自证资源就绪。

**MC-058 另一 E2 高风险缺口**：`persistStep` 对 `saveDeployment(d,{durable:true})===false` 只打 warn，连首次/步骤 running 写盘失败也继续对真实服务派发外部副作用；可能导致重启后不可恢复、重复执行。修复须确保副作用前 durable 成功才发，后继失败提供 UNCERTAIN/恢复路径，并做故障注入红例。`applyScene(input.grant:Grant)` 目前直接使用调用者提交的完整授权对象；当前没有正式外部调用点，尚不构成已发生越权证据，但未来的公开入口**只能通过宿主 GrantStore 查验 grantId**，不能允许模型构造含 `approvalSource:user` 的对象。当前此文件在未提交工作区，故不把它当已交付闭环。

**MC-095 复审进展**：并发开发新增 `ipc/extensions.ts` 六条 `extensionAccessRefusal` 与 `appControl/tools.ts` 的 app_api_call/panelApiCall 无身份 ALS 作用域，`extension-store-smoke` 本轮通过。此前直接调用未带 scope 的 IPC 探针仍能读另一个 extension，但那是当前设计允许的桌面直连模式，**不能再据此判新 Agent 通用路仍越权**。需用真实三 SDK → app_api_call → handler 与 panelBridge 自绑身份 E1 查有无绕行，并冻结代码重测；复核 `[ ]` 不变。

**MC-093/096/100/101 进展**：memory/retrieval.ts 已对三处读/注入应用 redactSecrets；MC-096 新增 last-good 恢复但并发容量竞态仍待补；ToolProfile 与 EffectiveToolInventory 目前只提供纯选择/诊断，三引擎的模型可见工具集合还未真正随任务裁剪，MC-100/101 不关。`osFileLease.ts` 曾短暂出现空释放函数，复读已恢复且 Git diff 不再包含它，视为其它 AI 做变异测试的瞬间状态，不登记已提交回归。
**同轮追补（2026-10-14，HEAD `bc7b62a7`→`ba7a8320`，并发未提交代码）**：
- MC-058：场景开发者在本轮新增了 `readbackScene` 和失败补偿；重新执行同一独立 `mc058_run.sh`，观测 `{"calls":1,"resultOk":true,"kind":"applied","status":"active","stepStatus":"done","acceptancePassed":false}`。这说明读取侧能发现资源不在，但**未消除** RPC `{ok:false}` 判成功、整体 ACTIVE 的缺陷；验收“不通过”与部署“ACTIVE”相矛盾，必须让业务失败影响步骤及总体状态。该结果**取代**上一轮探针在旧工作树得到的 `acceptancePassed:true`，并保留前后对照。
- MC-095：开发已将无身份/跨身份访问拒绝逻辑提交到 `bc7b62a7`；本轮 scope-aware extension-store/app-control 两套回归通过。先前“不带宿主作用域直接调 IPC”探针仍能读数据，**是宿主桌面直连的预期路径，不是新版 Agent app_api_call 能越权的证据**。本轮不独立打勾，真实 SDK/渲染边界 E1 保留。
- MC-061：新增 `hooks:issueHostHookGrant` 等三条宿主 IPC 和 preload API；`appControl/policy.ts` 将代理签发/撤销设置为 blocked，但渲染端 `src/renderer` 406 个文件没有实际调用 `issueHostHookGrant` 的代码。**形式上的 IPC 入口 ≠ 普通用户已经可以点按钮授权**，继续保持开发 `[ ]`／复核 `[ ]`。下一步须在插件面板实际使用已安装插件版本/事件/命令/matcher 生成授权输入，证明 agent 无法代用户签发，执行/撤权/重启全流程绿。
- MC-097：26 套并行回归中的 `maint-m07-smoke` 不仅超时，连**单套隔离重跑一次**仍在 90s 超时；日志已出现租约清理失败/失败后锁残留/过期 CAS 未拒等多个红例（见 `apps/desktop/.tmp/smoke-runs/1791922760028-36544-sCYaOe/maint-m07-smoke.log`），所以不能再仅称并发负载干扰。但另一个**不经过故障注入桩**的生产 `acquireOsFileLease` 独立探针 `apps/desktop/.tmp/mc097_release_run.sh` 在独立临时锁路径输出 `{held:true,released:true}`、退出 0。并发开发曾动态改动 `osFileLease.ts` 做变异、又恢复，且 smoke 使用 `node:fs/promises` 可切换故障桩，目前尚不能定位是瞬态代码、esbuild alias、E1 夹具污染或真实长期锁问题。**保持 MC-097 复核 `[ ]`；要求在冻结源码下复跑、定位最早失败的锁清理断言，任何稳定真实失败即撤开发修复 `[x]`。**
- MC-014/052：`remote-ssh-smoke` 在 26 套并发时 174/176（取消任务时序两红），但**单套独立复跑 1/1 PASS**；更支持测试并发争用而非 SSH hostVerifier 退化。真 SSH 认证前拒绝/带外批准完整 E1 仍未全部完成，不勾独立通过。
- MC-097 **第三次、源码恢复稳定后的独立复跑**：`node apps/desktop/scripts/run-smokes.mjs maint-m07-smoke` 返回 **1 pass, 0 fail**（日志 `apps/desktop/.tmp/smoke-runs/1791922949314-30144-CMOAhC`）。连同直接租约释放探针通过，前两次锁清理红例不再能稳定复现；当日存在明确的空释放函数临时变异，故将本批定位为**并发变异/测试隔离待治理**，不将其当成最新提交的 MC-097 源码回归，但以前两次故障作为变异测试互相干扰的门禁问题保留。原条目开发 `[x]`／独立复核 `[ ]` 不变，真实 Electron 并发/崩溃路径仍待验证。



---

**2026-10-14 新增独立真实契约负例｜MC-058 / ARC-002｜E1**：不依赖模拟 RPC 成功路径，直接拿生产 `compileSceneCommands` 编出 `workflow` 资源命令，与生产 `WorkflowSaveSchema.safeParse` 验证。执行 `apps/desktop/.tmp/mc058_contract_run.sh`（临时 bundle，无用户数据 IO），输出 `MC058_CONTRACT_PROBE={"serviceLabel":"workflow.save","payload":{"name":"巡检工作流"},"realWorkflowSaveSchemaAccepts":false,"errors":[{"path":["workflow"],"message":"Required"}]}`、退出码 **0**（符合预期地复现**契约不匹配**）。源链：`packages/contracts/src/sceneCommands.ts` 把单个场景 `resource.spec` 逐字当 RPC payload → `sceneDeploy.ts` `callRpc` → `ipc/orchestration.ts` 生产 handler `WorkflowSaveSchema.parse(raw)`；后者需要 `{workflow:WorkflowDocSchema, expectedRevision?}`，不能直接接受 `{name: ...}`。原 `scene-apply-smoke` 用 `recordRpcHandler("workflow:save", (_e,raw)=>...)` 宽松接纳 fake `{name}`，所以先前全绿不能证明真实生产服务会保存。**修复**：各 scene kind 逐个做 Schema-aware 声明→请求投影，预先校验 payload 后才审批/执行；save 返回分业务状态，保存后的真实资源 UID/版本必须记载并用于 readback 与补偿；用生产 schema 的负例、真实 handler 的临时数据目录正控双向验收。automation/workflow.save、skills.save、mcp.save、hooks.save 等也须逐个核对，不可凭 fake handler 放行。

**2026-10-14 测试门禁暂态 REGRESSION（W09 关联，不重复建新 MC）**：在变动的未提交工作区上运行 `node apps/desktop/scripts/run-smokes.mjs scene-apply-smoke hooks-ipc-smoke automation-smoke claude-ipc-smoke node-live-smoke`，结果 **3 PASS/2 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1791923066169-30652-sm8685`。① `scene-apply-smoke` **56/59**，3 条红例均在新增 `readbackScene` 后旧 fake 成功用例无法回读资源（期望 accepted true/只 missing auto，实际全缺），属于测试夹具与新业务契约不一致；不能以“测试需要改”替代验证真实 readback。② `automation-smoke` esbuild 解析 `scripts/automation-smoke/main.ts:3089:3` 的悬空 `*`，并非自动化生产逻辑经行为断言失败，是并发编辑的源码语法错误。③ 同一阶段 `pnpm typecheck` **失败**：`packages/contracts/src/sceneCommands.ts:285:3 TS2739`，`unknownKindEntry` 漏 `readback`/`compensation`，无成功构建；稍后再读这份函数已补上两字段，后续需重跑 typecheck/相关 smoke 并记录修复是否完成。**所有失败先记工作区暂态，不冒称 HEAD 已提交有回归；但不得据早先 3/3 报目前无红灯。**
**2026-10-14 MC-058 第三项动态反例（危险的补偿误删，E1 算法逻辑 + E2 生产映射）**：隔离真实 `applyScene` 函数、用临时数据库和 fake RPC 模拟已存在的用户工作流 `wf`；首次 `workflow.save` (同 ID `wf`) 模拟覆盖原有资源，下一步自动化失败，默认 `compensateOnFailure:true` 调 `workflow.remove({id: command.actionId})`。运行 `apps/desktop/.tmp/mc058_compensation_run.sh` 输出 `MC058_COMPENSATION_PROBE={"hadOldAtStart":true,"oldExistsAfter":false,"effects":["overwrote-existing","trigger-failed","removed-wf"],"status":"failed"}`，退出 0 = **按当前算法成功复现原有资源被删除的风险**。生产 `WorkflowSaveSchema` 允许 ID 复用以修改已有工作流（`packages/contracts/src/ipc/workflow.ts` 注释明确 id 是主键，内置工作流也能被覆盖）；生产补偿确实从 `sceneCommands.ts` 的 `workflow.remove` 入口按 `actionId` 删除，**没有区分本次新建 / 预先存在 / 别人新修改的版本**。注意：真实生产业务当前另有请求契约不匹配，故这项属于 *模拟宿主上的可执行算法反例 + 源码级生产行为风险*，不能谎称实际用户工作流已被删。最小修复：在任何 save 前持久记录是否原有及旧 revision/内容快照；有冲突不覆盖；仅本次确实新建且未被修改的资源才可带 CAS 删除，原有被更新则需保守逆向恢复或标 UNCERTAIN，真实 handler 临时库负例验收。**不要直接“补偿所有 done”删除用户事前资源**。

**2026-10-14 类型门禁恢复补记（同一未提交工作区）**：此前 `sceneCommands.ts:285 TS2739` 缺 readback/compensation 在本轮并发开发中已补；`pnpm typecheck` 重新执行 **3/3 PASS，0 缓存命中**（`proc_62b0b3d5d87f`）。因此旧 TS 错误属于工作区过程中真实短暂的门禁回归，**当前这次复跑已恢复**，保留失败和恢复的双重证据；不可再在今日状态里称编译仍失败。`scene-apply-smoke` 在最新一轮独立重跑仍 **90/91**，唯一失败为依赖被挡的正控“服务被调一次”计数=0（见 `apps/desktop/.tmp/smoke-runs/1791923283258-33868-gMx5CR/scene-apply-smoke.log`），说明本地业务/测试构造正不断调整，单个负例之外不能给整项通过勾。`automation-smoke` 前次因 `main.ts:3089` 悬空 `*` 编译失败，本轮复跑仍在运行，待记录最终状态。
**2026-10-14 MC-091｜自动化欠账恢复 E1 红例（REVIEW_FAILED）**：前一轮 `automation-smoke` 因并发编辑留下的悬空 `*` 无法打包；修复语法后本轮真实执行到行为断言，`automation-smoke:691/695`，四处失败（完整日志 `apps/desktop/.tmp/smoke-runs/1791923283258-33868-gMx5CR/automation-smoke.log`）：① `派发后欠账清零(内存)` 实际 3、期望 0；② `派发后欠账从盘上清掉` 实际仍 `{count:3}`；③ `重启后的派发把上次欠的账并进载荷` 实际新文件载荷无 overflowDropped；④ `重启后派发完毕欠账清零` 实际 5、期望 0。前提“派发真的发生”和“重启读到了欠账”断言均通过，所以不是完全未进入测试分支；具体是否 `fire` 失败重试、key 不同或时序竞争，还需开发 AI 在冻结提交排查。相关生产调用 `automationRunner.ts:2329-2335` 把 `droppedCountOf` 并入 file/event 并调用 `drainDroppedUndelivered`，关注同一触发器 key、真实起跑后结算、存储被其它数据覆盖以及是否在真正派发成功前过早清账。**该记录针对进行中的未提交并发修改；不声称已提交 HEAD 稳定红，但 MC-091 完成/复核必须维持 `[ ]/[ ]`。**
**2026-10-14 MC-058 五类真实 RPC 契约矩阵（新增 E1）**：运行 `apps/desktop/.tmp/mc058_contracts_run.sh`，一次把通过 `validateSceneSpec` 的合法场景声明转成生产 `compileSceneCommands`，逐一用真正的 `WorkflowSaveSchema`、`SkillsSaveSchema`、`McpSaveSchema`、`HooksSaveSchema`、`ModuleInstallSchema` 解析。输出 `MC058_RPC_MATRIX`: workflow `workflow.save` payload `{id,name}` → 缺 `workflow`；skill `skills.save` payload `{name,content}` → 缺 `source`；MCP `mcp.save` payload `{name}` → 缺 `config`；hook `hooks.save` payload `{id}` → 缺 `hook`；module `modules.install` payload `{name}` → 缺 `manifest` 与 `confirmReadAccess`，**五类均 `valid:false`**，退出码 0 表示预期契约拒绝得到独立重现。注意测试只证明**合法 SceneSpec 不保证可以调用真实服务**、当前编译器缺服务专用参数投影；不是说无论填何种 resource.spec 都必然失败。特别是 `confirmReadAccess:true` 是额外明示确认，不能把一个场景授权直接当作用户已经批准模块读取权限。修复必须先区分 SceneSpec 结构完整性与每个下游 RPC 的业务完整性，提供用户补全/审批步骤；在实际调 RPC 前强制 schema 校验并记录可诊断的缺字段，不能交给模拟 handler 静默接收。不应为修 smoke 而放宽生产 schema 或把不可信 `confirmReadAccess` 自动置 true。
### 2026-10-14｜所有待复审条目独立核对矩阵（E1/E2，阶段性验收）

**核对范围**：MC 共 **21 项**（MC-004、014、052、058～061、077、089～101）；ARC-001～016 共 **16 项**；UI-001 共 **1 项**，合计 **38 项**。UXG-001～007 是未结束的设计旅程，原始 UI-004～050 详细正文尚不可恢复，不擅自伪造“通过”。

**执行事实**：实际运行第一批 **50/50 套 PASS**，第二批 **20/20 套 PASS**（`scene-task-smoke` 重复一次，即 69 套不同）；`pnpm typecheck` **3/3 PASS**。包括 remote-ssh、mobile-pairing、mcp-endpoint、module-phase2、capability、hook-runner、plugins、extension-store、memory、maint-m07、node-live、automation、renderer-pure、ui-interaction 等。证据目录：`apps/desktop/.tmp/smoke-runs/1791919166446-31892-nYIQFa`、`1791919342100-26424-49nRo4`。起检 HEAD `e9037662`，并发开发期间到 `edadc547`；**工作区并非冻结提交，70 套通过只覆盖测试断言，不能当发布级“全绿”**。MC-095 的隔离动态复现独立另跑成功：两个跨扩展读取都实际返回。未触碰真实用户数据库、真实 SSH 主机或在线三 SDK 以做破坏性反例。

**复核规则**：`REVIEW_PASSED` 仅用于覆盖**原始定义**的完整负例与实施路径；`REVIEW_PARTIAL` = 核心分片真实存在但原始必验条件未全覆盖；`REVIEW_FAILED` = 原始需求中的实质缺口仍在。测试全绿不是自动过关。对已证伪整体完成的 `MC-059/060/089/091/096` 撤销了开发已修复标签，并同步 §3 与 §6；MC-093 的“保存整份候选”分片已通过，但原条目同时要求人工编辑/历史记录读取与注入防护；本轮源码 E2 确认读侧仍直接拼入正文，故撤销此前误标的独立通过，保持开放。

| MC | 复审 | 已确认的证据 | 尚未完成的原始验收/剩余治理 |
| --- | --- | --- | --- |
| `MC-004` | REVIEW_PARTIAL | **传输闸已由「默认拒绝 + opt-in 明文」收紧为「仅传输安全才放行」(`76ba9f05`)**：非回环明文上的口令/Bearer/配对码一律 403、无 opt-in 后门、闸门统一覆盖 auth/rpc/events/pair；删去 `mobile.allowPlaintextCredentials` 契约键；mobile-pairing 256 条 0 红 | **真 TLS 未实现** —— 桌面仍 `node:http`，无证书生成/主机身份绑定；本切片是「拒绝」不是「加密」 |
| `MC-014` | REVIEW_PARTIAL | 真 hostVerifier + 未知/变更/损坏拒绝；**新增 E1(`3cebba6e`)：对只收 password 的假 sshd 数「服务器侧收到的密码次数」，证明三种拒绝都发生在凭据发送前**(计数不增)；remote-ssh 184/184 | 无真 sshd(覆盖 ssh2 hostVerifier 契约，不覆盖 sshd 侧 KEX 错误呈现) |
| `MC-052` | REVIEW_PARTIAL | **新增 E1(`3cebba6e`)：经真 `invokeAppTool(app_api_call)` 驱动真 handler，证明 approveHost 钉 danger、always-allow/bypass 都拦住、模型伪造 `approvalSource:agent` 被 schema `.strict()` 拒、只有用户本人点头才落持久授权、同路撤销即消失**；app-control 427/427 | 「用户点头」用假 requestApproval(驱动真闸+真 handler，真 UI 点击不在环里) |
| `MC-058` | REVIEW_PARTIAL | 生产入口(`9210f128`)；回读 + 补偿；业务 `{ok:false}` 判定；崩溃续跑 resume(`548db921`)；**渲染端面板(`d96b4899`)：粘贴→预览→批准→部署，planDigest 取自预览、部署入参不含授权字段**；**回读/补偿按真实服务身份钉死 + `resourceUid` 落盘(`626b1c3d`)——修掉「按场景 id 查服务身份索引表、永远匹配不上」的假绿根源**；scene-apply 271/271 | 补偿仍未覆盖 plugin/panel/scaffold(身份推不出的如实记 `unverifiable`)；补偿未单独论证授权 |
| `MC-059` | REVIEW_PARTIAL | 签发口 + 有界执行 + 三层 IPC；**发起者身份由宿主 `SessionRepo.get` 核实产出(`5da276ff`，伪造坐标 → `unknown_initiator` 拒绝、一步不建)；计划正文落盘 → 重启后可列出/续跑(跳过已建成)/放弃**；claude-ipc 370/370、app-control 432/432 | **渲染端按钮**归另一车道；**仓库内无无人值守调度器**(续跑是用户触发，非后台自动)；`scopedCore` 仅 `projectPath` |
| `MC-060` | REVIEW_PARTIAL | 拒绝可区分 + 生产审批装配(`78be45b5`)；**隔离执行已落(`4df8fd74`)：`isolatedActionRunner`(`worker_threads`)四类可区分失败，闸在派发之前**；module-phase2 32/0 | **worker_threads ≠ 沙箱** —— 挡不住内存共享与系统调用(`fs`/`net`/起子进程)；真 syscall 隔离需 `child_process` + 平台沙箱；第三方 action 的**生产接入**仍缺 |
| `MC-061` | REVIEW_PASSED(开发片) | 授权持久化 + 签发 UI；执行次数预算 + `hook_runs` 审计读取/轮转；**推送通道 `hooks:hostHookGrantsChanged`(`dced704d`) + 接线登记修复(`0fefc9bf`/`857b4d62`)：签发/用尽/撤销/整撤推给渲染端，面板按 `shouldRefetchHookGrants` 只刷那一个插件**；hooks-ipc 161/161、ipc-wiring 39/39、memory-codex 177/177 | 真实 Electron 手工点签/撤看即时刷新属端到端验收 |
| `MC-077` | REVIEW_PARTIAL | 同上；**新增 `skill-delivery-smoke` 27/27(`3452d49d`)：驱动真三 provider 的 `startTurn`，在真 SDK 调用点抓 Claude `options.skills` / Codex `extraRoots` / Pi `getSkills()`，断言禁用/往返/即时生效/同名项目压全局/**损坏无 last-good → 三家交付全空(fail-closed，不交截断集)**/有 last-good 恢复** | **真二进制**拿到根之后如何扫描/命名/同名谁赢仍须活会话(Codex 闭源是否把直接含 SKILL.md 的根当单个技能 = UNVERIFIED)，属 ARC-014 U1 |
| `MC-089` | REVIEW_PARTIAL | 归属回收 + 忙资源受控保留；**新增(`e0f4ada7`)：真监听器 + 真 `POST /mcp/<密钥>` 反复握手顶穿小上限、应时淘汰；留存审计落盘持久化(复用设置表 `publicMcp.retentionAudit`)重启可回读**；mcp-endpoint 772/772、public-mcp-session 9 条新 | 真 HTTP 链仍用假凭据快照/假工具宿主(未起真进程)；资源**认证恢复/安全迁移**策略仍缺；未对真实公网施压 |
| `MC-090` | REVIEW_PASSED(开发片) | 冻结快照 + 跨重启续跑 + 源改版不漂移；**新增 §7e(`66a4f1ad`)：重搭真的 `registerWorkflowHandlers`、按 `IPC.RUNS_HISTORY` 像渲染端 invoke，端到端断言经 handler 返回的运行仍报起跑时锁下的 v1(drift/changePlan 三态)**；node-live 51/51 | handler 未跨进程重启再读；`limit` 分支与坏存档端到端仍归 orchestration-ipc-smoke |
| `MC-091` | REVIEW_PARTIAL | 事件合并 100 + 溢出可观测；恢复游标；清账时序；全局背压 + E3 启动竞态 + 欠账上界面；**统一截断原语 `capOldest` 三处合一 + E3 业务三态映射(`4f655a67`)：`.then` 按 `RunResult.status` 映射 SUCCEEDED/FAILED/UNCERTAIN，崩溃遗留 `CLAIMED`→UNCERTAIN**；automation 727/727 | **分片持久队列 / 按条目可恢复 cursor 仍未做**(游标是每触发器计数) |
| `MC-092` | REVIEW_PARTIAL | 上述全在 + **新增真实入口 E1(`cc1408aa`)：调真 `invokeAppTool` 配真 memory handler，项目 A/B 互不可见(read/list/save + review/manage)，无可信身份时读与 list 都拒**；memory-smoke 282/282 | 无真三引擎在线回合；`memory.assistant` 整理/导入特殊链路未回放 |
| `MC-093` | REVIEW_PASSED(读侧已修) | 写侧已在位；**读侧(`290cf568`)retrieval.ts 五处 `redactSecrets`；新增真实入口 E1(`cc1408aa`)：含密钥文件直接写盘(绕过写侧)，经生产注入链 + 真 MCP `memory_search`，密钥不出现在送模型/返回文本里，同记录的非密钥标记照常出现** | 无真三引擎在线回放 |
| `MC-094` | REVIEW_PARTIAL | 同上 | 真实三引擎最终可见目录 / 同名冲突 / 禁用即时生效的 E1 仍缺(见 MC-077 分节) |
| `MC-095` | REVIEW_PASSED | **通用通道已绑可信扩展身份(`bc7b62a7`)：`appControl/tools.ts` 对 `extensionStore.*` 装 `runWithUnboundAgentExtensionScope`，`ipc/extensions.ts` 六条 handler 过同一份 `extensionAccessRefusal`，无身份一律拒**；extension-store 237/237 | — |
| `MC-096` | REVIEW_PARTIAL | 保留闸 + 写侧拒 + 32MB 预算 + last-good 恢复；并发竞态已消(`7c918f48`)；**`store.json` → 点前缀保留名 `.mcode-store.json`(`4f655a67`)：物理隔离 + 读回退(老数据认作 VALID 不当 MISSING) + 写即迁移 + 新旧写法都被保留闸拒**；extension-store 271/271 | 竞态仍以单进程钩子复现(租约本身宿主级，跨进程由 MC-097 真子进程 E1 佐证) |
| `MC-097` | REVIEW_PASSED(开发片) | FILE_WRITE CAS+原子替换+withOsFileLease；故障注入 E1；**真跨进程 E1(`ad4a26e4`)：真第二 node 进程抢同一 lock 被拒(FILE_VERSION_CONFLICT)、父释放后能抢到、真 SIGKILL 后死 pid 陈旧租约 2000ms 内回收且回读正确**；实测 Windows SIGKILL 真杀进程、`wx`/O_EXCL 跨进程有效；maint-m07 71→87 | 真·Electron 两端并发(两窗口 / 外部编辑器驱动 Monaco 保存)与主进程内崩溃仍需真机 —— 那是 renderer↔main IPC 管道，租约原语本身已用真进程验证 |
| `MC-098` | REVIEW_PASSED(开发片) | 上述全在 + **真 EditPane E1(`79276be3`)：选中 A → 选定目标前把选区改成 B → 落草稿，断言正文与行号**都**对应 A、绝不混装；正控在** | 真 Monaco 选区 API / 真指针拖选 / 真 `onMount` 模型切换 / portal 定位仍需真浏览器 E1(U1) |
| `MC-099` | REVIEW_PASSED | 上述全在 + **变动序 E1(`08400187`)：撤执行器 / 撤引擎注册 / 真 ModuleHost 撤注册后，同一 `required` 被拒并点名，`required:false` 不挡但进 gaps；每块先证变动前通过再证变动后拒绝(反向自证防假绿)**；capability 116→128 | 无真三引擎从 `app_api_call` 发起；**grant 维度未覆盖**(能力预检只读不消费 grant) |
| `MC-100` | REVIEW_PARTIAL | 统一链(`4835a445`) + 生产画像来源(`9aeef50d`) | **wire 层抓包未做**(未证明各 SDK 真照做) |
| `MC-101` | REVIEW_PARTIAL | 三处缺陷已修(`4835a445`) + 生产画像来源(`9aeef50d`) | **未证明各 SDK 在真实请求里照做**；token 仍是 4 字符/词粗估 |

**ARC-001～016 全覆盖**：均**未达到完整工作包验收**，保持开发 `[ ]`／独立复核 `[ ]`，不拆出重复 MC 编号。

| ARC | 复审缺口 |
| --- | --- |
| `ARC-001` | 有跨端 createSessionAndSend，但没有完整独立 CommandService 的业务修订和任务授权 |
| `ARC-002` | SceneSpec/计划/预检已绿；未提交 sceneDeploy 执行函数已有雏形，但正式入口、计划签发、资源 readback/补偿未闭合 |
| `ARC-003` | 能力目录仍分散，三 SDK 未从唯一库存动态投影 |
| `ARC-004` | policy/grant/action context 有局部，场景级最小授权/撤权未贯通 |
| `ARC-005` | operation-ledger smoke 已绿，跨外部副作用/崩溃可恢复性不完整 |
| `ARC-006` | Plugin/Module/Hook 元数据部分共享，第三方 action 安全执行未打通 |
| `ARC-007` | Hook/调度测试通过，长任务投递持久性与取消语义未验收 |
| `ARC-008` | 三 SDK provider-context 测试通过，实际上下文交付与降级验收未闭 |
| `ARC-009` | operation-ledger/通知 outbox 测试通过，但跨命令的成功/通知失败/UNCERTAIN 未统一 |
| `ARC-010` | 项目初始化依旧未成为可 apply 的 SceneSpec 可编译资源 |
| `ARC-011` | 声明的插件版本/依赖有局部校验，无完整安装-升级-回滚 |
| `ARC-012` | 预算能力已局部存在，缺用户目标→可观测成果与成本评测 |
| `ARC-013` | 子代理测试通过，跨会话父子预算和链式取消未闭合 |
| `ARC-014` | 组件兼容标签与真实执行交付仍不能严格等同 |
| `ARC-015` | 自动化触发器有回归，场景可表达的文件删除/输出事件闭环未验收 |
| `ARC-016` | run-store 的配置快照已有，角色档案同版本在普通会话与工作流的一致性未全验 |

**UI-001 复审：REVIEW_PARTIAL**。真实 Chromium 的 `ui-interaction-smoke` 已包含异步 resolve/reject、ok:false、双击、旧 Promise 迟到不可关闭新弹窗等断言；不同资源身份、Esc/遮罩/取消、真实权限拒绝/IPC 超时与重新打开串扰未全验，保留开发 `[x]`／复核 `[ ]`。**UXG-001～007** 仍无 U1 整体旅程证据，不能按某个组件通过来声称设计验收通过。

**关于变更冲突**：本批只改统一台账、没有调整业务源码；其它 AI 在检查期间并发提交 MC-061、MC-096、MC-097 等。历史条目中早期错误判断保留作溯源，由本节较新证据覆盖，不删 archive。下轮独立复核必须先固定 HEAD/工作树，再运行指定的真正用户流程（SSH、MCP owner 恢复、三 SDK、真实 Monaco/跨进程、场景 apply）。

### UI-001：异步确认弹窗（单独保留未验收项）

- **开发已修复** `[x]` / **独立复核** `[ ]`；已有 `openGenRef` 和 `stillCurrent` 抵御旧 Promise 影响新弹窗。
- 已有历史红/绿例：旧 resolve 迟到、旧 reject 迟到、两次快速重开；但不同资源身份、Esc/遮罩/取消、IPC 无权或超时等原验收边界仍需独立核验。
- 原 UI-001～050 正文缺失是**资料治理缺口**，不可凭摘要重新创造 47 条问题。测试源码：`apps/desktop/scripts/ui-interaction-smoke/`。

## 4. ARC 总览（双勾只认完整工作包）

| 编号 | 工作包 | 开发完成 | 独立复核 | 主要归并 |
| --- | --- | :---: | :---: | --- |
| `ARC-001` | P0 — 建立独立于渲染窗口的业务 CommandService | `[ ]` | `[ ]` | W01 |
| `ARC-002` | P0 — 场景声明 SceneSpec、计划编译器与受控部署闭环 | `[ ]` | `[ ]` | W01 |
| `ARC-003` | P0 — 一个真实能力目录，三 SDK 只适配其原生能力 | `[ ]` | `[ ]` | W04 |
| `ARC-004` | P0 — Agent 自主执行所需的计划级授权与完整 ActionContext | `[ ]` | `[ ]` | W02 |
| `ARC-005` | P1 — 跨存储写入与外部副作用，改造成可恢复的 OperationLedger | `[ ]` | `[ ]` | W03 |
| `ARC-006` | P1 — 将多套扩展的“元数据与授权”统一，而非合并全部执行引擎 | `[ ]` | `[ ]` | W05 |
| `ARC-007` | P1 — 钩子和长时任务的投递语义与可观测性 | `[ ]` | `[ ]` | W06 |
| `ARC-008` | P1 — 三 SDK 的上下文/会话/审批语义要显式交付，不做隐藏降级 | `[ ]` | `[ ]` | W04 |
| `ARC-009` | P1 — 所有控制命令必须区分“操作成功、通知失败、持久化不确定” | `[ ]` | `[ ]` | W03 |
| `ARC-010` | P2 — 项目初始化不应是独立向导，而应是 SceneSpec 的一种可编译资源 | `[ ]` | `[ ]` | W01 |
| `ARC-011` | P2 — 场景依赖、插件版本和更新策略需要声明式治理 | `[ ]` | `[ ]` | W05 |
| `ARC-012` | P2 — 用户体验以“场景目标/运行结果”为主，建立持续评测与成本预算 | `[ ]` | `[ ]` | W01 |
| `ARC-013` | P1｜自治任务拓扑 — Agent 创建/唤醒其他 Agent 后，缺少场景级父子任务治理与跨会话总预算 | `[ ]` | `[ ]` | W06 |
| `ARC-014` | P1｜三 SDK 能力正确性 — “插件兼容引擎”只代表部分组件可投递，不等于场景依赖全部可用 | `[ ]` | `[ ]` | W04 |
| `ARC-015` | P1/P2｜自定义自动化 — 文件触发器先被全局硬编码过滤，不能表达“监控构建输出/删除事件”的场景 | `[ ]` | `[ ]` | W06 |
| `ARC-016` | P1/P2｜复现/角色配置 — 同名 Agent 档案在普通会话与工作流节点有不同生效时点，场景版本不可复现 | `[ ]` | `[ ]` | W04 |
| `ARC-017` | P1｜研发质量门禁 — 测试辅助类型不应自造 SDK ToolResult 结构，工作树的浏览器 smoke 引入类型检查回归 | `[x]` | `[x]` | W09 |

## 5. 产品 UXG 与 UI 专题

| UXG | 用户旅程 | 优先级 | 最新设计状态 |
| --- | --- | --- | --- |
| `UXG-001` | 一句话提出目标→看见计划与成果 | P0 | 设计待实施（尚无全旅程 U1 验收） |
| `UXG-002` | 三 SDK 会话、子代理、任务状态统一且可理解 | P1 | 设计待验收（尚无全旅程 U1 验收） |
| `UXG-003` | Markdown/PDF/文件树编辑与安全恢复 | P1 | 设计待验收（尚无全旅程 U1 验收） |
| `UXG-004` | 搜索、导航、命令面板和窗口布局 | P1 | 设计待验收（尚无全旅程 U1 验收） |
| `UXG-005` | 授权、工具审批、成本预算的可解释交互 | P1 | 设计待验收（尚无全旅程 U1 验收） |
| `UXG-006` | 长任务、自动化、错误和恢复中心 | P1 | 设计待验收（尚无全旅程 U1 验收） |
| `UXG-007` | 无障碍、键盘、深浅色、多窗口与性能体验 | P2 | 设计待验收（尚无全旅程 U1 验收） |

| UI 编号 | 开发 | 复核 | 结论 |
| --- | :---: | :---: | --- |
| UI-001 | [x] | [ ] | 异步操作代次已有修复声明，待独立完整验收 |
| UI-002 | [x] | [x] | Toast 来源按钮键盘 Enter/Space 可访问 |
| UI-003 | [x] | [x] | Esc 只关闭聚焦通知，不误清粘性通知 |
| UI-004～050 | ? | ? | 原始正式条目不可恢复，**未知，不计通过或失败** |

## 6. MC-001～102 完整编号索引（精简后的历史检索入口）

此表只保留定位标题、两位角色的正式勾选和当前状态；长测试输出、旧红例和详细变异归入历史原文，不在主台账复制。

| ID | 核心问题/历史标题 | 开发 | 独立复核 | 当前 |
| --- | --- | :---: | :---: | --- |
| `MC-001` | P1｜安全 / 文件边界 — Agent 的文件写入检查仅判字面路径，符号链接/Windows junction 可能越过工作区 | `[x]` | `[x]` | 复核通过 |
| `MC-002` | P1｜数据安全 / 撤销 — 历史回滚不检查后续修改，可能覆盖用户当前文件或删除新内容 | `[x]` | `[x]` | 复核通过 |
| `MC-003` | P1｜性能 / 稳定性 — 文件变更行数统计是 O(旧行数 × 新行数) 时间和空间 | `[x]` | `[x]` | 复核通过 |
| `MC-004` | P1/P2｜网络安全 — 手机端在默认启用的明文 HTTP LAN 服务上传输密码与 Bearer 凭据 | `[ ]` | `[ ]` | 未关闭／实施中 |
| `MC-005` | P2｜撤销 / 正确性 — 只改变文件末尾换行会被当成“无变化”丢弃 | `[x]` | `[x]` | 复核通过 |
| `MC-006` | P2｜路径兼容 — 把所有以两个点开头的合法相对文件名误认为目录逃逸 | `[x]` | `[x]` | 复核通过 |
| `MC-007` | P2｜移动端性能 — SSE 推送无背压/缓冲上限，慢速手机连接可能堆积主进程内存 | `[x]` | `[x]` | 复核通过 |
| `MC-008` | P2｜并发 / 撤销 — recordPre 的“首次快照”缺少异步并发占位 | `[x]` | `[x]` | 复核通过 |
| `MC-009` | P2｜索引可用性 — AOCI 文件索引引用已删除的模块且绝对根路径与当前项目不同 | `[x]` | `[x]` | 复核通过 |
| `MC-010` | P2｜质量门禁 — PR 的自动测试范围相比项目体量过窄 | `[x]` | `[x]` | 复核通过 |
| `MC-011` | P3｜文档准确性 — 技术栈说明与现有版本、功能范围发生明显漂移 | `[x]` | `[x]` | 复核通过 |
| `MC-012` | P3｜UI 可用性 — 文件变更卡的次级操作热区过小，且行按钮采用嵌套交互结构 | `[x]` | `[x]` | 复核通过 |
| `MC-013` | P1｜跨端状态 / UI — turn.done 后的运行快照可能把刚结束的会话重新置为 running | `[x]` | `[x]` | 复核通过 |
| `MC-014` | P1｜SSH 安全 — Agent SSH 未校验远程服务器主机密钥 | `[ ]` | `[ ]` | 未关闭／实施中 |
| `MC-015` | P1｜SSH / 内存 — agent_ssh_exec 不限制远程 stdout/stderr 总体积 | `[x]` | `[x]` | 复核通过 |
| `MC-016` | P2｜移动端认证 — 登录限流存在异步竞争窗口，来源 IP 头可由直连者伪造 | `[x]` | `[x]` | 复核通过 |
| `MC-017` | P2｜SSH 文本准确性 — stdout/stderr 按字节块分别 UTF-8 解码，跨块的中文/emoji 乱码 | `[x]` | `[x]` | 复核通过 |
| `MC-018` | P3｜SSH 资源生命周期 — 主动断开后仍保留过期连接和认证信息 | `[x]` | `[x]` | 复核通过 |
| `MC-019` | P1/P2｜数据库异常恢复 — 迁移失败可留下半初始化数据库和不可重试的就绪 Promise | `[x]` | `[x]` | 复核通过 |
| `MC-020` | P2｜文件触发可靠性 — 目录监听出错后没有自主重试或恢复 | `[x]` | `[x]` | 复核通过 |
| `MC-021` | P2｜自动化定时 — 首次 cron 轮询在启动 30 秒后，可能错过已处于当前匹配分钟的计划 | `[x]` | `[x]` | 复核通过 |
| `MC-022` | P2/P3｜自动化费用与体验 — 合并窗口内文件全部消失仍可能空载荷唤醒 Agent | `[x]` | `[x]` | 复核通过 |
| `MC-023` | P2｜升级数据保留 — 移除机构认证功能的迁移直接 DROP 历史机构入口档案 | `[x]` | `[x]` | 复核通过 |
| `MC-024` | P1/P2｜隐私安全 — 导出设置的嵌套清洗超过 20 层时原样保留该子树，可能泄露深层密钥 | `[x]` | `[x]` | 复核通过 |
| `MC-025` | P1/P2｜数据一致性 — 设置导入不是整体事务，后半程写入异常会留下部分新值和提前广播的状态 | `[x]` | `[x]` | 复核通过 |
| `MC-026` | P2｜备份可靠性 — 两次设置导入若发生在同一秒，备份文件名冲突并覆盖前一个备份 | `[x]` | `[x]` | 复核通过 |
| `MC-027` | P1/P2｜会话复制 / 数据一致性 — forkSession 的本地会话创建与消息复制不在同一个事务 | `[x]` | `[x]` | 复核通过 |
| `MC-028` | P1｜工作流持久化 — 关键岔路与收尾的 durable 写入结果没有检查，存盘失败仍继续广播状态 | `[x]` | `[x]` | 复核通过 |
| `MC-029` | P2/P3｜设置回退语义 — 将导入前备份再次导入只是 upsert，无法删除第一次导入新增的键 | `[x]` | `[x]` | 复核通过 |
| `MC-030` | P2｜资源边界 / 导入 — 导入设置先 readFile 整份文件，再检查 2000 万字符上限 | `[x]` | `[x]` | 复核通过 |
| `MC-031` | P1｜信任边界 / 项目级 MCP — 设置导入允许携带 mcp.projectTrust，可能在导入后自动信任外来项目的可执行 MCP | `[x]` | `[x]` | 复核通过 |
| `MC-032` | P2｜代理通信 / 消息丢失 — 代理回复排队后可先销持久化挂账，重启时回复和关联凭据同时失踪 | `[x]` | `[x]` | 复核通过 |
| `MC-033` | P2｜代理消息 / 资源控制 — agent_ask / agent_notify 仅限制十分钟内条数，未限制文本字节和长期排队总量 | `[x]` | `[x]` | 复核通过 |
| `MC-034` | P2｜项目配置 / 稳定性 — 自动发现的项目级 .mcp.json 同步无界读取，可被超大项目配置拖慢主进程 | `[x]` | `[x]` | 复核通过 |
| `MC-035` | P2｜LSP 工作区隔离 — 工作区 A 允许打开属于已知项目 B 的文件，可能将 B 内容交给 A 的语言服务器 | `[x]` | `[x]` | 复核通过 |
| `MC-036` | P2｜LSP 资源安全 — 不完整或畸形 JSON-RPC 帧可以造成无限累积 Buffer | `[x]` | `[x]` | 复核通过 |
| `MC-037` | P2｜安装失败恢复 — 手工安装 Java LSP 先删除旧版本，再尝试解压新压缩包，失败不能回滚 | `[x]` | `[x]` | 复核通过 |
| `MC-038` | P2｜LSP 事件时序/UI — openDocument 慢速读文件时，与 closeDocument / didChange 存在反序竞态 | `[x]` | `[x]` | 复核通过 |
| `MC-039` | P1｜项目级 MCP 安全 — 信任指纹不含项目身份，不相关仓库里的“相同命令文本”可以执行不同脚本却继承授权 | `[x]` | `[x]` | 复核通过 |
| `MC-040` | P2｜MCP 配置并发/数据丢失 — 两次同时更新 .mcp.json 可能互相覆盖，临时文件名也可能在同一毫秒冲突 | `[x]` | `[x]` | 复核通过 |
| `MC-041` | P1/P2｜Git 操作范围 — repoPath 位于项目内，但 Git 自动向上发现项目外的仓库，存在超出已授权目录的操作风险 | `[x]` | `[x]` | 复核通过 |
| `MC-042` | P2/P3｜终端生命周期 — 删除会话/项目不会回收其集成终端，后台 PTY 可能成为孤立资源 | `[x]` | `[x]` | 复核通过 |
| `MC-043` | P1/P2｜跨 Agent 浏览器隔离 — Agent 浏览器活动标签与索引状态全局共享，其他项目 Agent 可直接读写已有浏览器标签 | `[x]` | `[x]` | 复核通过 |
| `MC-044` | P2｜本地文件授权边界 — Agent 的 browser_navigate 接受任意 file URL，不执行项目文件读取护栏 | `[x]` | `[x]` | 复核通过 |
| `MC-045` | P2｜浏览器导航时序 — cookie 恢复异步延迟时，browser_navigate 可能把旧页面/空白页误报为加载成功 | `[x]` | `[x]` | 复核通过 |
| `MC-046` | P2｜终端吞吐/界面稳定性 — PTY 数据流每个 chunk 直接广播 Renderer，输出缓存虽然有上限但 IPC 发送速率无背压 | `[x]` | `[x]` | 复核通过 |
| `MC-047` | P1/P2｜手机回滚 / API 契约 — mobileRpc 将完整报告重复包装，手机端回滚失败列表不可用 | `[x]` | `[x]` | 复核通过 |
| `MC-048` | P2｜会话设置 / 假成功 — 更新已经不存在的会话的普通设置时，手机 RPC 返回 ok:true | `[x]` | `[x]` | 复核通过 |
| `MC-049` | P1/P2｜工作流并发 / 状态 — 第二条消息被运行中的图拒绝后，catch 误将原有 running 重置为 idle | `[x]` | `[x]` | 复核通过 |
| `MC-050` | P1/P2｜回归门禁 / 自动化 — 当前自动化 smoke 11 项失败，并使 TypeScript 类型检查失败 | `[x]` | `[x]` | 复核通过 |
| `MC-051` | P1/P2｜自动化崩溃一致性 — cron 去重标记异步落盘，尚未建立可靠的“领取任务→执行”边界 | `[x]` | `[x]` | 复核通过 |
| `MC-052` | P1｜安全授权边界 — SSH 已信任主机指纹可由通用设置文件导入，首次连接又自动放行，缺少安全授权来源验证 | `[ ]` | `[ ]` | 未关闭／实施中 |
| `MC-053` | P1/P2｜工作流可靠恢复 — 快照序列化失败时，saveRun 仍以空 payload 覆盖上一次可恢复快照 | `[x]` | `[x]` | 复核通过 |
| `MC-054` | P1/P2｜当前构建回归 / LSP — 新文档同步队列参数类型不匹配，desktop 类型检查出现 3 条 TS2345 | `[x]` | `[x]` | 复核通过 |
| `MC-055` | P1｜本地代码执行授权 / 项目级 MCP — 伪造的 .git 文件可以冒充已信任仓库身份，继承执行授权 | `[x]` | `[x]` | 复核通过 |
| `MC-056` | P1/P2｜SDK 适配 / 错误引擎 — 已保存 providerId 不存在时静默回退默认引擎 | `[x]` | `[x]` | 复核通过 |
| `MC-057` | P1/P2｜SDK 会话生命周期 — Pi 与 Codex 恢复失败自动开新底层会话，未向上层声明上下文已丢失 | `[x]` | `[x]` | 复核通过 |
| `MC-058` | P1｜产品架构缺口 — 没有统一的“场景声明→计划→部署→维护”交付物，自定义能力仍是彼此分离的配置 | `[ ]` | `[ ]` | 未关闭／实施中 |
| `MC-059` | P1/P2｜自主控制面缺口 — 应用自控的关键入口依赖渲染窗口与逐方法审批，缺少可无人值守执行的授权任务计划 | `[ ]` | `[ ]` | 三端会话命令和 ActionContext 已有，但 plan grant/revision 与真实无人值守授权任务缺失，开发未完成 |
| `MC-060` | P2｜扩展能力结构 — ModuleHost 实际只允许注册过的只读/任务能力，第三方模块不能通过清单贡献新的动作执行 | `[ ]` | `[ ]` | 权限判定分片已落，第三方 action 安全宿主/沙箱/审批/三端复用仍缺，开发未完成 |
| `MC-061` | P2｜重复扩展体系 — 独立 HookRunner 可以执行钩子，但插件携带的 hooks 永远不执行，导致场景配置不可组合 | `[ ]` | `[ ]` | E1 执行通道已落；生产签发入口缺失且无持久授权/用户 UI；整项开发未完成 |
| `MC-062` | P1｜公网 MCP / 项目链接授权撤销后执行失去作用域 | `[x]` | `[x]` | 复核通过 |
| `MC-063` | P1｜公网 MCP / 多对话共享项目链接导致资源身份和额度串用 | `[x]` | `[x]` | 复核通过 |
| `MC-064` | P2｜搜索管理器 / 仅查看列表便删掉有效搜索会话 | `[x]` | `[x]` | 复核通过 |
| `MC-065` | P1/P2｜公网工具资源预算｜返回字符数限制发生在完整下载或单元格展开之后 | `[x]` | `[x]` | 复核通过 |
| `MC-066` | P1/P2｜业务状态一致性 — RPC 合法返回 ok:false，app_api_call 却向 Agent 报告 SUCCEEDED | `[x]` | `[x]` | 复核通过 |
| `MC-067` | P1｜Agent 并发与安全隔离 — app_api_call 的 operationId 不绑定调用者和操作意图，并发及 UNCERTAIN 会重复执行 | `[x]` | `[x]` | 复核通过 |
| `MC-068` | P1｜公网文件操作/数据安全 — agent_move_file(overwrite=true) 先删除目标再移动，移动失败仍会丢失原有内容 | `[x]` | `[x]` | 复核通过 |
| `MC-069` | P1｜文件编辑/数据一致性 — 多 Agent 同时编辑 Excel 会成功丢更新，PDF “不覆盖已存在目标”的声明并发失效 | `[x]` | `[x]` | 复核通过 |
| `MC-070` | P2｜三引擎上下文 — Windows 路径大小写变体导致子目录项目指令漏注入 | `[x]` | `[x]` | 复核通过 |
| `MC-071` | P2｜基础工具配置 — 工具禁用策略损坏后静默恢复启用 | `[x]` | `[x]` | 复核通过 |
| `MC-072` | P1｜工作流取消与资料库一致性 — CodeExecutor 的取消只覆盖脚本执行，不覆盖后续宿主入库、Markdown 挂回 | `[x]` | `[x]` | 复核通过 |
| `MC-073` | P1｜输出流资源预算 — spawnRun 的未完成行不受 OutBuf 字节上限约束，无换行日志可导致内存和 CPU 放大 | `[x]` | `[x]` | 复核通过 |
| `MC-074` | P1/P2｜Pi SDK 适配 / Skills 功能正确性 — 显式选中的 Skill 被插件兼容名单意外扩展 | `[x]` | `[x]` | 复核通过 |
| `MC-075` | P2｜执行引擎生命周期 — settle 钩子报错会把已成功的执行翻转成失败、重复调用收尾，甚至向上抛异常 | `[x]` | `[x]` | 复核通过 |
| `MC-076` | P1｜多 SDK 健康探测资源治理 — Provider 探测超时只结束外层等待，没有终止底层 SDK 工作 | `[x]` | `[x]` | 复核通过 |
| `MC-077` | P2｜配置恢复 — Skills/MCP 引擎矩阵异常时丢失原可见性选择 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：Skills/MCP 错误引擎矩阵整份 fail-closed + last-good，无备份时拒绝；独立 skill-engines / mcp-engines E1 已通过。 |
| `MC-078` | P2｜Codex 插件适配 — 含点号的合法插件名导致 MCP TOML 表头层级错误 | `[x]` | `[x]` | 复核通过 |
| `MC-079` | P2｜Codex 凭据隔离 — 每轮 app-server 环境携带所有已配置模型端点的密钥，而非按选定端点最小化 | `[x]` | `[x]` | 复核通过 |
| `MC-080` | P1｜场景预算核心的账户身份与数值校验 — 重复创建预算账户重置活跃预留；旧预留跨场景结算；负数额度可突破限制 | `[x]` | `[x]` | 复核通过 |
| `MC-081` | P1｜场景任务委派约束与截止时间 | `[x]` | `[x]` | 复核通过 |
| `MC-082` | P1｜三 SDK 失败回退 / 副作用幂等 — 回合错误时直接重发整段用户输入，未区分错误前已成功的工具动作 | `[x]` | `[x]` | 复核通过 |
| `MC-083` | P1/P2｜轮预算策略 — 配置损坏时由“有限额”退化成无限额，缺少可靠安全降级 | `[x]` | `[x]` | 复核通过 |
| `MC-084` | P1｜公共操作账本持久化与跨重启幂等 — app_api_call 领取成功但未落盘即可执行外部动作，崩溃后同一个 operationId 可重复执行 | `[x]` | `[x]` | 复核通过 |
| `MC-085` | P1｜资料库写入身份与内容完整性 — writeNote 只凭 .md 扩展名授权，能够覆盖论文转录及其他条目的笔记 | `[x]` | `[x]` | 复核通过 |
| `MC-086` | P2｜文档预览 / Markdown 相对资源 — 资料库 linked 目录内的 Markdown 使用条目根父目录当图片 baseDir | `[x]` | `[x]` | 复核通过 |
| `MC-087` | P2｜资料库 linked 预览 / 文件读取授权链 — 合法 linked 库外目录的配图被项目文件 readBinary 守卫拒绝 | `[x]` | `[x]` | 复核通过 |
| `MC-088` | P2｜跨 Agent 浏览器隔离 / 路径身份 — browser_* 工具把同一项目根的等价拼写当成不同项目,list 误报「没有视图」、无 browserId 调用落到 no… | `[x]` | `[x]` | 复核通过 |
| `MC-089` | P2｜公网 MCP 签发客户端会话淘汰与历史 owner / 进程生命周期不一致 | `[ ]` | `[ ]` | owner 过期回收与忙资源保留已落；旧 owner 任务恢复/释放 E1 未闭，开发未完成 |
| `MC-090` | P1｜工作流运行时构建的 configSnapshot 在首次 saveRun 前被覆盖丢失 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：真实 startWorkflowRun→磁盘重开→续跑仍保留起跑时 configSnapshot，源档案改版 drift 可读，node-live E1 复核通过。 |
| `MC-091` | P1/P2｜文件繁忙重排队不遵守 500 项封顶；事件合并 items 无界累积 | `[ ]` | `[ ]` | 事件合并限 100、丢弃有持久恢复游标、清账晚于真正派发、**全局背压 + E3 启动竞态 + 欠账上界面**；但**分片持久队列 / 统一截断原语**未做，开发未完成 |
| `MC-092` | P1｜三引擎通用 app_api_call 的 memory.* RPC 可绕开专用记忆项目 ACL | `[x]` | `[ ]` | 主路径已修 2026-10-14（memory-smoke 238→264）/ manage·assistant·review·诊断输出全覆盖 |
| `MC-093` | P1/P2｜记忆保存前只检查正文敏感凭据而不检查标题和继承元数据 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：完整候选元数据/标题写侧敏感拒绝 + 历史/人工旧文件读侧遮蔽，memory / memory-injection E1 复核通过。 |
| `MC-094` | P1/P2｜项目级 Skill 在管理/复制 UI 中可见，但 Codex/Pi SDK 没装配项目技能目录 | `[x]` | `[ ]` | Codex/Pi 已修 / 待复核 |
| `MC-095` | P1｜扩展私有数据区顶层 Junction 可逃逸；Agent RPC 未绑定调用扩展的身份 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：扩展物理根 Junction 越界拒绝 + 通用 Agent 无身份/跨身份读写拒绝，extension-store / app-control E1 复核通过。 |
| `MC-096` | P1/P2｜扩展文件通道可覆盖内部 store.json，导致键值存储丢失 | `[ ]` | `[ ]` | store.json 文件闸、坏数据写侧拒绝与 32MB 容量已落；恢复/诊断、并发配额不完整，开发未完成 |
| `MC-097` | P1｜Markdown/源码保存只在 Renderer 比对后调用主进程直写，缺少跨进程 CAS 与原子替换 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：跨进程租约、CAS、原子替换与失败注入回读，maint-m07 / editor-save 全量绿，E1 复核通过。 |
| `MC-098` | P2｜Monaco 引用正文与行号分别在选中和选择目标时读取 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：Monaco 文本与行号一并冻结快照，renderer-pure / markdown-quote 回归绿，E1 复核通过。 |
| `MC-099` | P1｜插件 Manifest 宣称不存在的 builtin/executor/provider 能力，宿主预检误判 READY | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1/E2）：Manifest 虚构 builtin/executor 不能骗过实际就绪判断，capability / scene-preflight E1 复核通过。 |
| `MC-100` | P1｜按需工具发现与模型可见工具集未联动 | `[ ]` | `[ ]` | 实有 app_api_list/describe/call；缺统一 ToolProfile 与三引擎按任务真实裁剪，关联 ARC-003/008/014 |
| `MC-101` | P1｜三引擎 Context Injector / 工具装配缺少共同最小化治理 | `[ ]` | `[ ]` | 作为 MC-100 的三引擎执行层验收，不重复造 Discovery 层或独立实施包 |
| `MC-102` | P2｜测试门禁假红：custom-ui-refresh-smoke 桩未跟进 SettingNotifyPort 注册，正常业务也稳定报刷新失败 | `[x]` | `[x]` | REVIEW_PASSED（2026-10-14 E1）：生产 window.ts 注册端口，新版 smoke fixture 补相同装配后**原本单套命令重新 1/1 PASS**；临时 wrapper 的结果仅历史佐证；初次全量运行 249/251 为历史事实。 |

### MC-089 [P2｜公网 MCP 会话淘汰未同步资源 owner 归属]

- **性质/双标记**：资源生命周期与身份恢复缺陷；开发已修复 - [x]（2026-10-14 本地开发 AI，两片：归属回收 + 在途资源受控保留）；AI 独立复核通过 - [ ]。证据 E1（生产会话函数纯内存动态）+ E2（进程/SSH owner 查找调用链）；未对真实公网地址施压。
- **定位**：`apps/desktop/src/main/providers/bridge/publicClientSessions.ts` 的 `issueClientSession`（`issued` 最多 4096 项，超限淘汰）、`rememberSyntheticOwner`/`syntheticOwners`/`ownersForSession`（历史 owner 不跟随淘汰）；`mcpEndpoint.ts` 的 `initialize` 每次签发、每次公网请求记归属，以及 `agentProcessSessions.ts` 等资源管理器的 ownerSessionId 检查。
- **动态 E1 复现（2026-10-13）**：测试进程以生产函数对同一虚拟合成会话签发 4400 个客户端身份，并调用 `rememberSyntheticOwner`；输出 `{"totalInitialized":4400,"maximumLiveIssued":4096,"trackedOwnerCount":4401,"oldestCredentialStillValid":false,"newestCredentialStillValid":true,"afterDeletingSyntheticOwnerCount":1}`。证明旧 ID 已不可认证但仍在归属集合；显式删除合成会话才清空。尚未起真实 `agent_process_start`，长任务失联的后果属于源码级推断，需 E1 补证。
- **用户影响前提**：长时间大量 `initialize` 或反复重连超过签发上限时，旧客户端的 owner 被淘汰，新握手拿新 ID；仍使用旧 owner 绑定的后台进程/SSH/搜索可能无法从原客户端再读/停，直到超时或宿主清理。同时历史归属仍增长；不能称为无凭据越权漏洞。
- **建议修法**：统一签发会话的 TTL/淘汰与 owner 资源回收策略。空闲/无资源 owner 同步移除；仍有任务的 owner 应选择受控保留（有限预算、TTL）、认证恢复/安全迁移或明确终止并留审计，而不是简单提高 4096、直接删所有映射或让新 owner 自动接管旧 owner。跨 credential/项目不得复用。
- **必补 E1**：生产 MCP initialize→启动受控临时后台进程→注入小签发上限触发淘汰→旧 ID 过期/新 ID 签发→检查进程可追踪、可正确释放而不能跨 owner 误访问；包括搜索、SSH 假连接、删除合成会话及轮换链接测试。应证明重启/断线后有明确可回读结果。
- **相关独立设计待验**：`mcpEndpoint.handleCall` 执行期不绑定请求 `close/abort` 到工具取消；项目链接删除会使新请求拒绝，但已有执行不一定停止。这属于在途副作用取消/持久化语义的待验收内容（W02/W03），**目前不作为另一个已确认漏洞编号**。需明确 detach-and-recover 与 cancel-on-revoke 的产品策略，禁止超时自动重发危险操作。
- **本轮相关回归**：`mcp-endpoint-smoke` 740/740 通过，`public-mcp-session-smoke` 通过；其成功路径未覆盖本次累计签发超限与运行资源联动，不能据此关掉 MC-089。源码审查时 HEAD `9a56f88f`，写入前 HEAD `2cf5fb06`（并行提交未改变上述被测源文件）。

**MC-089 独立复审补记（2026-10-13）**：结论为**未通过，保持开放**。Git HEAD `2cf5fb06`；`publicClientSessions.ts` SHA256 为 `9454590aad57c3771a34119f617f35c169cb44010be78c27381a1ecb4733d101`。本轮再次运行生产函数隔离测试：4400 次会话签发后，历史 owner 数量 4401，最早的客户端会话已经失效，最后签发的会话有效；跨凭据调用正确拒绝。`mcp-endpoint-smoke` 740/740 PASS，`public-mcp-session-smoke` PASS，但均未修复或覆盖这一长期归属回收问题。开发 `[ ]`，独立复核 `[ ]` 不动；整改需要联动会话淘汰与运行任务资源回收，补小限额端到端隔离测试后再申请复核。

**MC-089 开发修复（2026-10-14，本地开发 AI）**：`publicClientSessions.ts` 加**淘汰联动回收**。根因：`issueClientSession` 超 4096 上限时把最老的 id 从 `issued` 删掉（不可再认证），但 `syntheticOwners` 里记的「合成会话 → 该 owner」**不跟着删** → 归属集合只涨不落（复核实测 4400 次签发 → 归属 4401）。修法：① 淘汰时把被删的 id 记进 `evicted`（并有界）；② 新增 **`pruneOrphanedOwners()`** —— 只回收**确定失效**的 owner（`pcs_` 前缀 + 已不在 `issued` 里），**保留**仍在用的会话、`legacy:` owner、本机会话 id（非本模块生命周期）；空了的合成会话条目一并删；③ `mcpEndpoint` 的 `initialize` 分支在签发后**顺带调一次** prune（真实调用端）。**红例承重**：`mcp-endpoint-smoke` §MC-089 加 5 条 —— 被淘汰的 pcs_ owner 被回收、**legacy owner 永不回收**、**本机会话 id 永不回收**、反复 prune 幂等、归属数不再随签发次数线性涨。**变异（唯一接受的证据）2 处**：(a)`pruneOrphanedOwners` 退化为空操作 → 「已被淘汰的 pcs_ owner 被回收」**真红**；(b)连 legacy/本机 id 也当孤儿回收 → 「legacy owner 永不回收」「本机会话 id 永不回收」**真红**。逐字节 `cmp -s` 还原后 `mcp-endpoint-smoke` **745/745**，双包 typecheck 0 错。**remaining（如实，不假称做全）**：本切片只把「**归属记录**不再只涨不落」这条修掉；**在途资源**（运行中的进程/SSH/搜索）的**安全终止/迁移/审计**未做 —— 那要资源管理器与 owner 生命周期联动（台账建议「仍有任务的 owner 受控保留、认证恢复/安全迁移或明确终止」，属更大改造）；`public-mcp-session-smoke` 的**小签发上限端到端**（真实 initialize→起受控临时进程→触发淘汰→验进程可追踪可释放）未补。开发标记**仍留未勾**（只落可测核心，未覆盖完整验收矩阵）。
**MC-089 开发修复补片（2026-10-14，本地开发 AI，在途资源受控保留）**：上一片修了「归属记录不再只涨不落」；本片补台账 remaining 点名的另一条 —— **仍有在途资源的 owner 不得静默丢弃**。「仍有任务的 owner 受控保留」。修法：① `publicClientSessions.ts` 新增**可注册的在途资源探针** `registerOwnerWorkProbe(fn)` + 私有 `ownerHasInFlightWork(ownerId)`（**失败即保守**：探针抛错/失败算「有活」，绝不算「空闲」）；② 重写 `pruneOrphanedOwners()`：有效 `issued` → 留；非 `pcs_`（legacy/本机 id）→ 留；`pcs_` + 已淘汰 + **仍有活** → **留（受控保留，报 `keptBusy`）**；`pcs_` + 已淘汰 + 空闲 → 回收（`pruned`）；legacy/本机 id 报 `keptLegacy`；③ `mcp/agentTools.ts` 在既有会话 disposer 旁注册探针 —— 谓词 = 有 `running` 进程 **或** `running` 搜索 **或** 未关闭 SSH（`state !== "closed"`），只读 `list`、绝不 `disposeOwner`；纯模块因此不 import electron/db/ssh2。**红例承重**：`mcp-endpoint-smoke` §MC-089 加 11 条，走**真实**淘汰路径：真 `issueClientSession` 签发 → churn 4100 次**真淘汰**（断言 `resolveClientSessionDetailed(...).kind === "expired"`）→ 真 `createWebToolHost` 起后台进程 → prune；断言 busy 孤儿进 `keptBusy`、空闲孤儿回收、legacy/本机 id 进 `keptLegacy`、`agent_process_stop` 后变可回收。**变异（唯一接受的证据）3 处**各自真红、逐字节 `cmp -s` 还原：M1 探针恒 false → 红 3；M2 恒 true（空闲也当忙）→ 红 5（含既有回收断言）；M3 探针注册不接线 → 红 3。smoke：`mcp-endpoint-smoke` **756/756**（原 745）、`public-mcp-session-smoke` 通过、双包 tsc 0 错。**remaining（如实）**：**未做**在途资源的**安全终止/迁移/审计**（有活资源的孤儿只保留归属，不迁移不终止 —— 要资源管理器与 owner 生命周期联动，属更大改造）；**未补**真正走 HTTP `initialize` 握手 + `disposeOwner` 验进程释放的小签发上限端到端。开发标记**仍留未勾**（两片合计仍未覆盖完整验收矩阵）。

**MC-089 开发修复补片 2（2026-10-14，本地开发 AI，留存报告 + 安全释放入口）**：补台账 remaining 点名的最后一条 ——「认证恢复/安全迁移或**明确终止**并留审计」。前两片只「受控保留」有活资源的孤儿归属，但**没人看得见、也没入口终止**。本片加三样，全部复用既有资源管理器的 `list`/`disposeOwner`（**不另造第二张注册表**）：① `publicClientSessions.ts` 的 `evicted` 从 `Set<string>` 改 `Map<string,string>`（记下**被淘汰会话当初绑定的凭据**）；② 新增**计数探针** `registerOwnerResourceCounter` + `releaseOwnerResources(ownerId)`（安全释放器 `registerOwnerResourceReleaser`）——释放器由 `agentTools.ts` 注册，内部直接调三个管理器的 `disposeOwner`（与删会话**同一份**终止实现），释放后回收归属；③ `pruneOrphanedOwners` 的 `OwnerPruneReport` 增 `keptBusyDetails`（带凭据 + 活资源计数的留存明细），并写入有界审计环 `retentionAuditLog()`。`mcpEndpoint.ts` 在 `initialize` 的 prune 后**显式 `log.warn`** 报出「N 个孤儿 owner 受控保留（还挂着几个进程/搜索/SSH）」—— 运维据日志看到「哪条凭据死了，还挂着几个资源」，再对具体 owner 调 `releaseOwnerResources` 明确终止。安全护栏：在用会话拒（`still-valid`）、非 `pcs_`（legacy/本机 id）拒（`not-managed`）、无释放器拒（`no-releaser`），只动**确定失效**的孤儿。**红例承重**：`mcp-endpoint-smoke` §MC-089 加 12 条（768/768，原 756），走真实路径：真 `issueClientSession` 签发 + churn 4100 次**真淘汰** + 真 `createWebToolHost` 起后台进程 → prune → 断言留存明细带凭据 `cred-doomed`、资源计数 `processes:1`、审计留痕；`releaseOwnerResources` 后断言进程**真被终止**（再 `agent_process_stop` 报「没有这个进程会话」，证明不是只清归属）、归属回收；在用/legacy owner 拒绝释放。**变异（唯一接受的证据）4 处**各自真红、逐字节 `cmp -s` 还原：M1 缺省凭据恒 null → 红 1；M2 释放器空转（不真终止）→ 红 1（「释放后进程真被终止」）；M3 计数探针不注册 → 红 2；M4 审计不 push → 红 1。smoke：`mcp-endpoint-smoke` **768/768**、`public-mcp-session-smoke` 通过、双包 tsc 0 错。**remaining（如实）**：**未补**真正走 HTTP `initialize` 握手 + `disposeOwner` 验进程释放的小签发上限端到端（仍走函数级真实路径，非真 HTTP 小限额链）；**未做**资源的**认证恢复/安全迁移**（只给「明确终止」这一条；迁移策略仍缺）；留存审计是进程内有界环，**未落盘持久化**（重启即失）。开发标记**仍留未勾**（仍未覆盖完整验收矩阵：真 HTTP 小限额链、持久审计）。

### MC-090 [P1｜工作流运行配置快照写盘前丢失]

- **双标记**：开发已修复 [x]（2026-10-14 本地开发 AI，见下「开发修复」）；独立复核通过 [ ]。2026-10-14 独立审查；源码 E2（生产调用链静态确证）；**开发修复后已补真实 `startWorkflowRun` 持久化 E1**（node-live-smoke §6）。关联 W04/ARC-016。
- **开发修复（2026-10-14，本地开发 AI）**：`runner.ts` 把配置快照抽成冻结值 —— 初始化 `latest` 后立即 `const frozenConfigSnapshot = latest.configSnapshot;`（起跑那一刻锁下，或从续跑存档接回），`writeRun` 每次重建 `latest` 时**注入** `...(frozenConfigSnapshot !== undefined ? { configSnapshot: frozenConfigSnapshot } : {})`，使状态更新（乃至续跑再接）不再抹掉这份不可变起跑事实。**E1 红例**：`node-live-smoke` §6 新增 3 条，走**真实** `startWorkflowRun` → 真库 → `runHistory(PARENT)` 读回，断言每一行快照都带 `configSnapshot.takenAt !== undefined`（查**具体字段**，不是只查键存在）。**变异（唯一接受的证据）**：撤掉修复、`writeRun` 不再带 `frozenConfigSnapshot` → **红 2**（`{"rows":1,"withSnapshot":0}` 与 `{}`），精确复现台账描述；逐字节 `cmp -s` 还原后 `node-live-smoke` 23/23。runner.ts typecheck 干净。
- **复审增量 E1 补测（2026-10-14，本地开发 AI）**：针对复审点名的「跨重启续跑、更新源档案后版本不漂移与读回差异 E1 缺」，在 `node-live-smoke` 加 §7 共 16 条，走完整生产链:真实 `startWorkflowRun`（会话绑一份真档案 `p_restart`，落盘锁下 v1 哈希）→ `closeDb()`+`initDb()` **从磁盘重开**（与 `run-store-smoke` 同一手，日志确证 `sqlite opened from existing file`）→ 真实 `startWorkflowRun({resume,nodeId:"agent",rewind:["agent"]})`（日志确证 `resumed: 2 个节点` 且节点重新派发）→ `runHistory` 读回。**★承重**：把源档案由 v1 改成 v2 后，续跑写回的快照**仍是起跑时的 v1 哈希**（7c），并断言它**不等于**当前源哈希（排除「两边恰好相等」的巧合）;重启后从磁盘读回的那一行也仍是 v1（7b）。读回差异（7d）走 `@contracts/configBinding` 的唯一一份纯函数：`configDrift` 挑出 `p_restart:changed`、`lockedHash=v1`、`currentHash=v2`;`runStartBindings`→`resolveConfigBinding`→`staleBindings` 的变更计划挑出落后项、`effectiveHash=v1`、`policy=PINNED`、`stale=true`。**变异（唯一接受的证据）2 处各自真红、逐字节 `cmp -s` 还原**：M1 续跑时把 `frozenConfigSnapshot` 改成现读源（`resumed !== undefined ? buildRunConfigSnapshot(...) : latest.configSnapshot`）→ **红 9**（7c 两条 + 7d 七条，锁定哈希精确漂成 v2）;M2 撤 `writeRun` 注入 → **红 15**（§6 两条 + §7 十三条）。smoke `node-live-smoke` **39/39**（原 23）;相邻 `run-store-smoke` 59/59 未破;`node-live-smoke`/`runner.ts` typecheck 干净（`packages/contracts` 全绿）。
- **定位与可复核的最小事实**：`apps/desktop/src/main/orchestration/runner.ts:1021-1040`。初始化 `latest: RunSnapshot` 时在第 1030 行给 `configSnapshot: buildRunConfigSnapshot(session, doc)`；第 1038-1040 行 `writeRun` 又直接重赋 `latest = {workflowRevision, originSessionId, inFlightNodeIds, prompt, cwd, state, attempts}`，没有 `configSnapshot`、`...latest`，随后才交给 `saveRun`。调用方起跑后首先执行 `writeRun("running", latest.state, true)`；故第一次持久化已经没有原配置快照，后续覆盖同样没有。断言应检查快照对象的完整属性，而非只检查 `saveRun` 的编码器。
- **实际影响**：真实运行行的 `configSnapshot` 常为空，`RUNS_HISTORY` 的 `runStartBindings` / 版本变更计划读不到当时档案哈希；多次运行与恢复后无法从这条记录证明所用的角色/技能/模型。由于旧快照字段本就可选，`runStore.decodeSnapshot` 不会报错，可能出现无声缺失。
- **为什么绿例漏过**：`run-store-smoke` 手工将 `configSnapshot` 放进快照证明 encode/decode 正常，`orchestration-ipc-smoke` 手工造带 configSnapshot 的历史行测试展示层；没有经过生产 `runner.writeRun` 的完整起跑路径。本轮 `run-store-smoke` 197/197 + 59/59 PASS **不能关此问题**。
- **最小修复要求与 E1**：从同一个冻结起跑快照维护 `configSnapshot`，`writeRun` 更新状态时不得抹掉不可变版本事实；续跑读取存档时保持原哈希，不能现读替换成新哈希。隔离数据库与 fake provider 起图→真实 `startWorkflowRun`→初始 durable、节点进度、终态、重启恢复→`RUNS_HISTORY`，每一步校验档案哈希一致，源档案改版后变更计划能查出。用故障注入检查写盘失败不能伪造已冻结事实。

### MC-091 [P1/P2｜自动化队列背压缺口：繁忙文件批 / 事件合并]

- **双标记**：开发已修复 [x]（2026-10-14 本地开发 AI，事件条目容量 + 如实报丢弃；文件忙时重排队经复核不可达、未改）；独立复核通过 [ ]。2026-10-14 独立审查。E2（生产分支静态确证）+ E1（原函数纯内存隔离注入 1500 事件）；未使用真实用户文件、外网或进程。关联 W06/ARC-007/015。
- **开发修复（2026-10-14，本地开发 AI）—— 事件条目那一半**：`automationPayload.ts` 的 `mergeEventPayload` 加 `MAX_EVENT_ITEMS = 100` 上限：超限丢**最早**的（与文件那一路同一取舍），丢的条数如实累加进新的 `itemsOverflowDropped`（同 `overflowDropped`/`itemCount` 口径：未丢时不给键）；并兑现到消费方 —— `payloadFactsOf` 把 `itemsOverflowDropped` 带进 `data.trigger`（代码节点读它知道「这次不是全部」），`describeTriggerPayload` 在人话里明说「还有 N 条因为合并窗口积压没能带上 —— 这次看到的不是全部」。**E1 红例**：`automation-smoke` §MC-091 +8（灌 250 个唯一 itemId → 条目停在 100、丢的 151 条如实记、留下的是最近那批、重复不虚增、人话与 `data.trigger` 都带截断事实、未截断时不给键）。**变异（唯一接受的证据）2 处**各自真红、逐字节 `cmp -s` 还原：M1 撤掉上限 → 红 6（`{"actual":251,"expected":100}` 等，精确复现「只涨不落」）；M2 不报丢弃数 → 红 4。smoke：`automation-smoke` **683/683**（原 675）；`automationPayload.ts`/`hook.ts` typecheck 干净。
- **文件忙时重排队那一半：经复核为**不可达**，不改（如实登记）**：台账（E2 静态）说 `fire` 的 `hasActiveRun` 分支 `pending.files = [...new Set(...)]` 绕过 500 上限。我按 E2 改之并写了断言，但**变异撤掉修复后仍全绿**；进一步在该分支插**无抛出的探针**实测：该分支每次拿到的 `pending.files` **恒为 0** —— `rearm` 的计时器回调**先 `pendingFires.delete` 再 `fire`**，忙时分支经 `pendingOf` 重建的是**全新空格**，被合并进去的是 `payload.files`（那份已在正常收集侧 `addToFileBacklog` 收口过）。故这条静态结论在生产调用链上**不可达**，为其留修复/断言只会是死代码与假绿 —— **本片不改**，留待独立复核确认这一可达性判断。
- **remaining（如实）**：本片只覆盖事件条目容量与溢出可观测；台账「设计要求」里更大的那部分 —— 统一按触发器/工作流的队列预算（条数/字节/合并窗口/全局积压）、达上限时的分片持久队列/引用索引/可恢复 cursor、以及忙时合并与正常收集**完全统一**的截断原语 —— 均未做（事件条目只落了内存上限 + 如实报丢弃，未落持久化/可恢复）；MC-091 的 E3（`start()` ticker 早于 `reloadAll()` 的启动竞态、`TriggerClaim.SUCCEEDED` 语义映射）未动。开发标记**仍留未勾**（未覆盖完整验收矩阵）。
- **开发修复（2026-10-14 续，本地开发 AI）—— 持久积压 / 恢复游标那一半**：`automationRunner.ts` 新增 settings 键 `automation.droppedUndelivered`（`触发器 key → {count, at}` 小映射，与 `lastMinute`/`triggerClaims` 同一 `SettingRepo` 通路，不新开表）。任何一次积压丢弃（文件经 `addToFileBacklog`、事件经 `mergeEventPayload` 的差分，见新 `mergeEventInto`）**累加进内存表并标脏**，由 `onTick`(30 秒)节流冲刷、`dispose`/派发清账强制冲刷落盘；下一次**真的派发**一次 **file/event** 载荷时，经 `droppedCountOf` 把未交付欠账**并进该次载荷的 `overflowDropped`/`itemsOverflowDropped`**（文件路 / 事件路各按其键），随后 `drainDroppedUndelivered` **清账**（清账即落盘，避免重启后重复报）。手动/定时的载荷无条目列表可并，**不清账**（否则静默吞掉这笔欠账）。读路径：`statusOf`/`statusAll` 经新 `withDropped` 把欠账合进事实（新增 `droppedUndelivered` 字段），契约镜像 `AutomationTriggerFacts` 同步补字段。**E1 红例**：`automation-smoke` §MC-091 续 +12（忙时攒爆落盘、忙时重排队不清账、真派发并进载荷并清账、dispose 强制冲刷、跨重启读回、重启后派发交付）。**变异（唯一接受的证据）4 处**各自真红、逐字节 `cmp -s` 还原：M1 撤交付+清账 → 红 4；M2 `recordDropped` 变 no-op → 红 7；M3 `start()` 不读回 → 红 2；M4 `dispose` 不强制冲刷 → 红 3。smoke：`automation-smoke` **695/695**（原 683）；`automationRunner.ts` / `automationStatus.ts` / `ipc/orchestration.ts` typecheck 干净（同仓另有 `sceneCommands.ts` 一处与本片无关的报错，属另一并行车道）。仍未做：全局背压、统一队列预算、分片持久队列 —— 本片只把「丢弃」做成**可跨重启交付的游标**，未改队列容量策略本身。
- **文件忙时重排队**：`automationRunner.ts` 的 `PENDING_FILES_LIMIT=500`，普通 `onFsChange` 使用 `addToFileBacklog(...,500)` 并累计 `overflowDropped`，但 `fire` 的 `hasActiveRun` 分支（约 2048-2075）直接 `pending.files = [...new Set([...pending.files,...payload.files])]`、`pending.changes.set(...)`，**没有再次应用 500 项上限**，也不统计重排队这次超限丢弃。事件跨多个 busy 窗口聚合时可超过承诺的单批内存上限；现有自动化测试对普通事件 502→500 做了断言，而 busy 文件场景只有小批（两条）测试，未覆盖串联超限。其真实单批跨越须 E1 测试证明，风险不能写成线上事故。
- **事件合并无容量**：`automationPayload.ts:293-310` 的 `mergeEventPayload` 对旧 `items` 全量复制、按 `some(itemId)` 去重后直接 push，没有容量/时长阈值；`automationRunner.onEvent` 把它放进单个 pending 并重启 debounce 计时器，持续输入可使 pending 长时存在。**E1 动态输出**：同一虚拟事件 1500 个不同 itemId 被保留 1500，重复最后一个 ID 不增加长度；结果 `{"injected":1500,"retained":1500,"afterDuplicate":1500}`。`describeTriggerPayload` 的文本最多展示 20 项，却不限制 `payloadFactsOf` 的 `items`：后者依然把完整数组送进 `data.trigger` 和运行历史。逐条 `items.some` 的去重也随批大小线性上升，整体处理可能出现二次方成本。
- **设计要求**：建立一份统一的按触发器/工作流队列预算（条数、字节、合并窗口上限与全局积压）；**不要直接无提示丢掉待处理文献**。达到上限时分片持久队列/引用索引/可恢复 cursor，允许有显式 degraded/overflow，及时提示处理不完整；执行重试/忙时合并与正常收集走同一截断及去重原语。对于一次批次中的多条条目，保留每条的身份，禁止用 `items[0]` 伪装全批结果。
- **需补验收**：E1 隔离临时目录内超过 500 个不同文件跨两个忙时重排队窗口，断言 `pending.files`、`changes` 都有界且丢弃计数与再投递明确；事件 1500+ 个唯一条目、多次重复、持续刷新计时器及运行超时，验证内存预算、完整性/断点恢复、载荷序列化开销；再做一秒百事件、工作流运行仍繁忙、关闭/修改触发器、应用重启的端到端测试。已有 `automation-smoke`、`scheduler-smoke`、`scheduler-flow-smoke` 通过的普通路径不能替代这些红例。
- **需继续验证的相关 E3（不新开确认 Bug）**：`automationRunner.start()` 启 ticker 早于 `reloadAll()/recoverIncompleteClaims()`，注入慢加载与异常检查是否发生启动竞态；定时 `TriggerClaim.SUCCEEDED` 语义目前接近“领取已终结/Promise 落地”，不能直接当“工作流业务执行成功”，需核对 `AutomationFacts` 对成功、失败、UNCERTAIN 的展示是否一致。
- **开发修复（2026-10-14 再续，本地开发 AI）—— 清账时序那一半（复核点名的 E2 窗口）**：复核指出 `automationRunner.ts` 约 2329～2335 行**在 `runtimeManager.bindSession`、`SettingRepo.set(EVENT_CHAIN...)`、`void startWorkflowRun` 之前就 `drainDroppedUndelivered` 清账** —— 那几步任意一步抛,`fire` 走 catch 返回 `{ok:false}`,而那笔「被积压丢弃、未交付」的欠账**已经被清掉**(内存没了、盘上也清了),那几条丢弃永久静默丢失。修法:把 drain 挪到 `startWorkflowRun(...).finally(settleClaim)` **之后** —— 走到那一行才说明派发真的成立了;只对承载数据的 file/event 两路清,manual/schedule 不并账也不清账(留给下一次真正的数据批交付,避免静默吞债)。回归网 `automation-smoke` 新增 §E2:对**本会话的 EVENT_CHAIN 键**注射一次 `SettingRepo.set` 抛错(正是载荷已并、账未清的那两步之间),断言运行没派发 + 内存账还在 + 盘上账还在。`automation-smoke` **695 → 699/699**。变异:把 drain 挪回派发前 → 「★ E2 派发前抛错时内存欠账还在」真红 `{"actual":0,"expected":3}`(实际被提前清成 0),逐字节 `cmp -s` 还原后 699/699 | remaining:全局背压 / 统一截断原语 / 分片持久队列 / E3 启动竞态仍未做(见上条)

### MC-077 [复核失败增量｜部分损坏的 Skill/MCP 可见性矩阵意外放行 —— 已重新开发修复]

- **状态**：2026-10-14 撤销双勾;**同日重新开发修复**:开发已修复 [x]、独立复核 [ ]。历史修复与先前 E1 仍保留,复核失败边界已被本次修复覆盖(见下)。
- **重新开发修复（2026-10-14，本地开发 AI）**：`skillEngines.ts.parseEnginesMapText` 里任一不合法项(值非对象 / 数组 / null,或引擎字段非布尔,或未知引擎名如 `{"vim":false}`)一律 `return { ok:false }` → 整份 INVALID → 由 `readEnginesMapDetailed` 回退最后一份确认过的映射;无 last-good 则发 `ENGINES_DENY_ALL` 哨兵(fail-closed)。**合法**的部分禁用映射照常生效(对照断言证明未误伤)。**E1 红例**:`skill-engines-smoke` 78/0(改写旧断言«坏条目逐个丢弃只留 good-skill»—— 那本身就是 fail-open,改为整份 INVALID + 新增无备份 fail-closed)、`mcp-engines-smoke` 47/47(旧断言«全坏条目 → VALID 空 map 全可见»同为 fail-open,改为 fail-closed + 保留合法禁用项对照)。**变异(唯一接受的证据)**:撤掉格式校验退回 `continue` → **红 10**(skill-engines 2 + mcp-engines 8,均 actual true/expected false,精确复现旧 fail-open);逐字节 `cmp -s` 还原后两套全绿。相邻网未破:`pi-skill-scope-smoke` 10/10、`mcp-ipc-smoke` 196/196;双包 typecheck 干净。E2：`lib/skillEngines.ts` 的 `parseEnginesMapText` 对 JSON 对象中类型不正确的某个 entry 直接跳过并返回 `ok:true`；`engineEnabled` 对缺失项默认 true。E1：现有 `mcp-engines-smoke` 实际测试明确将非法项判成 `VALID 空 map（全可见）`，不是预期的 fail-closed。
- **失败场景**：`{"private":{"codex":false}}` 损坏成 `{"private":5}`，用户原有禁用被丢失，却不触发主文件 `INVALID`/last-good；Skill、MCP 共用此解析层。完整文件不可解析时恢复/拒绝的测试依然通过，但不足以覆盖此场景。
- **最小修复与复核**：存在任一非法项目或非法引擎字段时，优先整份判 `INVALID` 并回退上次有效配置；无备份应拒绝投递受限能力，不得把无效项当作“用户主动重新启用”。隔离原文件和 `.last-good` 的四组测试：全坏、部分坏、有备份、无备份；模型实际交付的 Skill 和 MCP 列表必须拒绝误恢复，并用移除格式校验的变异证实断言真红。
- **复审补片（2026-10-14，本地开发 AI）—— 交付集合负例**：复审点名的「真实三 SDK 最终可见目录、切换/损坏后的投递负例未验证」，本轮补在**纯函数算出的最终交付集合**上（三家 provider 的交付集合都由这几个纯函数算好再原样交给 SDK，故可无头断言，无需活会话）：`skill-engines-smoke` 90→**119**、`mcp-engines-smoke` 47→**64**。新增判据：① 被禁名字/目录**不在**该引擎交付集合（claude→`enabledSkillNames`；codex→`skillRootsIn` 委托的 `skillRootsFor`；pi→`enabledSkillNames`）；② 开关往返 enable→disable→enable 逐一往返（Skill 的 beta、MCP 的 claude-only）；③ 部分损坏（有效 JSON、值类型错）→ 整份 INVALID→有 last-good 按备份恢复（禁用仍在）、无 last-good fail-closed（三家交付集合**全空**，不复活为可见）；另加 provider **接线源码断言**（claude `skills: await claudeSkillsOption(`、codex `skillRootsIn(defaultSkillsRoot(), "codex", allowNames)`、pi `additionalSkillPaths: [...mcodeSkillRoots(cwd)…]`；MCP claude/codex 物化的 `deriveMcpEngineView(…)` 与三处 `mcpEngineEnabled(…,"codex"/"claude")`）。**变异（唯一接受的证据）3 处**各自真红、逐字节 `cmp -s` 还原：M1 撤条目格式校验退回 `continue` → skill-engines **红 11**（含新补片「损坏无备份 → 交付空」actual `["alpha","beta","gamma"]`/expected `[]`）；M2 撤 `ENGINES_DENY_ALL` 哨兵判据 → skill-engines **红 5**（fail-closed 失效，actual true）；M3 撤 `deriveMcpEngineView` 的矩阵过滤 → mcp-engines **红 12**（被禁 server 泄漏回交付集合）。相邻网未破：`pi-skill-scope-smoke` 16/16；双包 typecheck 干净（0 error）。E2：@main/lib/skillEngines.ts 与 providers 的调用点源码断言。E1：以上纯函数断言 + 临时目录矩阵写读。
- **remaining（如实）**：本片证明的是「矩阵 → provider 交付集合」的映射与**接线存在**，**未**用真实 Claude/Codex/Pi 会话回放核对「模型最终可见的技能目录/server 列表」—— 即 SDK 收到 extraRoots/allowlist/additionalSkillPaths 后**自己如何扫描、以什么名字暴露**仍未取样（Codex 是否把直接含 SKILL.md 的根当单个技能「UNVERIFIED」，见 CodexAgentSdkProvider.ts 注释）。codex/claude 的物化消费点靠源码断言佐证，未起真进程写 `.claude.json`/`config.toml`。

### MC-094 [P1/P2｜项目级 Skill 管理与 SDK 交付链脱节]

- **状态**：开发已修复 [x]（2026-10-14 本地开发 AI，见下「开发修复」）、独立复核 [ ]；2026-10-14 E2 生产源码调用链，尚无真实模型 SDK E1 读取回放。
- **开发修复（2026-10-14，本地开发 AI）**：项目技能交付链接通 —— 三家共用一份 `skillEngines.ts` 的 `projectSkillsRoot` / `skillRootsIn` / `projectSkillRootsFor`（单一实现，面板与 provider 不再各算）。Codex 的 `skills/extraRoots/set` 现含 `<cwd>/.claude/skills` 项目根；Pi 的 `mcodeSkillRoots(cwd)` 接回项目根并在矩阵限制时并入同名放行判据、强制 项目>全局>插件 优先级；`ipc/skills.ts` 改为重导出同一实现。都过同一 `engineEnabled` 矩阵。**关于 Pi「刻意排除」注释**：子代理查 git 历史确认它**过时** —— 项目根最初在（0f97a73e），2026-09-17 刻意移除（554cdc05），但**三天后**用户又加回项目技能（701ee122）—— 故接回是对齐当前产品状态，非推翻生效决定。**E1 红例**：`pi-skill-scope-smoke` 10→16、`skill-engines-smoke` 78→90、`skill-copy-smoke` 42/42 未破。**变异**：撤 Pi 项目根 → 红 2；撤 `projectSkillRootsFor` 的矩阵/点选过滤 → 红 4；两次 `cmp -s` 逐字节还原。**remaining**：① Claude 的 `settingSources=["user"]` 发现范围未动（须真实 SDK 验证）；② Pi/Codex 只到「宿主把项目根交给 SDK」这一层，**未做**真实模型读取 SKILL.md 正文的回放；③ 同名覆盖/禁用在真实会话里的最终可见目录未取样；④ 内置技能与项目技能同名去重未单列断言。开发标记**已勾**。

**MC-090 续修（2026-10-14，本地开发 AI）—— 跨重启续跑 E1**：`node-live-smoke` 新增 §7(16 条),驱动生产全链:真 `startWorkflowRun` 落 durable 行(锁 v1 哈希)→ `closeDb`+`initDb` 从文件重读仍持 v1 → 源档案 v1→v2 后**真续跑**写回的快照**仍持 v1**(且锁定≠当前源,排除假绿)→ 读回差异走与 `RUNS_HISTORY` 同源的 `@contracts/configBinding` 三函数(drift=changed、stale、effectiveHash=v1、PINNED)。23→39(+16)。变异 2 处真红、`cmp -s` 还原。**remaining**:§7d 未重搭 IPC handler 端到端;运行期(非续跑)进度写盘红例未做;真三引擎跨进程重启 + 写盘故障注入未验。
- **事实源**：`ipc/skills.ts` 的 `projectSkillsRoot`、`skills.copyToProject` 和 `listSkillsForProject` 支持项目 `.claude/skills/<name>/SKILL.md`，测试 `skill-copy-smoke` 42/42 已证明复制、列表成功；**它仅证明存储/管理入口，不证明 Provider 已收到**。
- **断开的接线**：`providers/pi-sdk/piSkillBridge.ts` 中 `mcodeSkillRoots` 只给全局 `~/.mcode/skills`，其额外根来自启用插件；Pi 本机默认 `.pi/skills`，不会天然覆盖 Mcode 项目 `.claude/skills`。`providers/codex-sdk/CodexAgentSdkProvider.ts` 的 `skills/extraRoots/set` 只给 `skillRootsFor` 的全局根和 `pluginSkillRootsFor` 插件根，没有 Mcode 项目技能根。Claude 使用 `settingSources=["user"]`，项目级发现是否受影响需要真实 SDK 验证，当前只标待验，不断言 Claude 一定失败。
- **修复要求**：宿主生成带项目、全局、插件、内置来源与优先级的 `EffectiveSkillInventory`，从可信 session/project cwd 绑定项目；统一引擎矩阵及显式选中范围，处理同名覆盖与禁用。Claude、Codex、Pi 各用 SDK 真正支持的发现/允许清单装载，不要靠 UI 列表假定可用。验证“当前项目可见/其他项目不可见/显式全局有效/项目优先/关闭即失效/恢复线程和空名单”；用真实 Claude/Codex/Pi 调用读取 Skill 正文 + 伴随文件，并检查每轮最终可见目录/技能名。新旧技能定义不得重复注入。
- **E1 补片（2026-10-14，本地开发 AI｜同名冲突 / 禁用即时生效）**：在**真** `buildPiSkillLoader`（`piSkillBridge.ts`，`scripts/pi-skill-scope-smoke` 驱动）上补三组承重负例，判据立在**最终交付名单/baseDir**上：⑨ 禁用即时生效 —— 同一目录只翻矩阵（放行→禁 universal-a→再放行），每次**重建 loader** 交付集合立即跟着变（禁用即刻消失、放行即刻恢复，不被上次结果缓存）；⑩ 同名优先级承重 —— 全局与项目各有同名 `shadow` 时**只交付一次且交付项目那份**，**撤掉项目那份后被压住的全局那份必须重现**（否则上一条只是"全局那份根本不在"的假绿）。**E1 红例**：`pi-skill-scope-smoke` 16→23（+7）。**变异**：① 把项目 rank 由 0 改成 9（撤优先级）→ 红 2（含新增同名 baseDir 断言）；② 非点选分支把 `enabledSkillNames(...)` 换成 `null`（撤矩阵）→ 红 3（含新增⑨）；③ `mcodeSkillRoots` 撤项目根 → 红 3（含新增⑩）。三处均逐字节 `cmp -s` 还原后 23/23。**remaining** 不变：③「同名覆盖/禁用在**真实会话**里的最终可见目录」仍只在无头假 loader 上取样，未做真模型 SDK 回放；① Claude `settingSources=["user"]` 项目发现范围未动；④ 内置技能与项目技能同名去重仍未单列（本次只覆盖项目 vs 全局）。

### MC-092｜统一记忆访问授权一致性（P1，待修复 / 待复核）

2026-10-14 独立审查，E2 生产源码调用链（动态隔离试验未成功执行，不能称 E1）。

**MC-092 开发修复（2026-10-14，本地开发 AI）**:新增 `memory/agentScope.ts` —— `AsyncLocalStorage` 承载**宿主铸造**的会话项目身份(`runWithAgentMemoryScopeForSession(sessionId, fn)`,从 `SessionRepo` 解析 projectId,**绝不读模型参数**;身份**延迟到执行点**解析,fail-closed 抛错)。`appControl/tools.ts` 的 `app_api_call` 执行点在 `entry.method.startsWith("memory.")` 时于 `callRpc` 外层包上作用域。`ipc/memory.ts` 四个 handler(list/read/save/delete)加 `enforceAgentScope`:有作用域时只许**本项目 + 全局**(list 只列可见项);**无作用域 = 桌面用户**保留全局管理权限。**E1 红例**:`memory-smoke` 238/238(新增 §MC-092 共 11 条:本项目/全局可读、跨项目读/写/删被拒、list 只列可见、旧布局被拒、桌面用户仍全局、身份缺失保守拒绝、**调用点接线源码断言**)。**变异 2 处**各自真红、`cmp -s` 还原:M1 撤 `enforceAgentScope` 红 5;M2 撤 app_api_call 侧作用域包装 红 1(接线源码断言)。修了**两个假绿**(删/旧布局断言不带 revision / 文件不存在,撤闸也不红)。**remaining**:`memory.manage`/`memory.assistant`(整理/导入)未纳入作用域闸(仍走 manage 自己的授权);`memory.review`(只读扫描)未过滤;真正的三引擎 E1(临时项目 A/B × 两入口 × 显式共享 × 旧记录)未做。开发标记**已勾**。

**MC-092 后继两片（2026-10-14，本地开发 AI）**：① 作用域闸扩到 `manage`/`review`/`reviewDelete` —— 「当前可见集合」收成唯一一份 `agentVisible` 谓词,传进三个领域函数,在**构建列表之前**滤掉不可见项(`memory-smoke` 238→253,+15;变异 6 处真红)。② `memory.assistant` 按**来源会话项目**判作用域(入参是会话 id,路径谓词对不上):有作用域且来源会话归属别的项目 → 拒(`node-session-smoke` +3;变异真红)。**remaining**:`review.unreadable` 诊断清单仍可能点到可见集合外路径(非正文);真三引擎 E1 未做。开发标记**已勾**。专用记忆工具使用可信会话项目身份执行作用域过滤；另一路通用业务接口提供相同记忆的管理/读取能力，但调用路径缺少等价项目隔离。三引擎共用该通用工具，故应把授权绑定到所有入口，不能依赖模型选择正确工具。建议统一由宿主产生可信会话上下文，逐入口限制当前项目/显式共享；保留桌面用户的全局管理权限。独立 E1 需要临时项目 A/B、显式共享、旧记录四种范围，验证三个引擎和两种业务入口，确认跨项目拒绝、本项目正常、缺失身份保守拒绝，加入变异反例。相关位置：memory/access.ts、mcp/memoryServer.ts、appControl/policy.ts、appControl/tools.ts、ipc/memory.ts。

**MC-092 诊断片（2026-10-14，本地开发 AI）—— 扫描/诊断输出不过可见谓词会泄露不可见项目的存在与名字**：`reviewMemoryFiles` 把 `listMemoryFiles({ onUnreadable })` 在**整棵树**上收集的 `omitted` 直接并进 `unreadable` —— 里面可能有 `projects/<别项目>/…` 的不可读路径,于是 agent 能借诊断清单读到**不可见项目的路径名**(它能读到的清单里没有该项目,诊断里却点名了它的路径)。修法:`omitted + report.unreadable` 合并去重后**整条过同一份 `visible` 谓词**(桌面用户无谓词 → 看全部)。同时把 `manageMemory` list 的两个**扫描计数**也归到同一口径:`truncatedSources`(native 来源全是旧记忆/别 owner,经 `canSee(id)` 对 agent 一律不可见,却报出真实截断数 = 泄露「有看不见的来源」)与 `historyTruncated`(全局归档超 200 的数,含不可见历史)在 agent 侧归 0,桌面照旧。**E1 红例**:`memory-smoke` 256→264(+8:桌面 review 诊断含本/别项目两条基线、桌面 manage 截断数两条基线、agent review 诊断滤掉别项目而**保留本项目**(正控)、agent manage 的 `truncatedSources`/`historyTruncated` 为 0)。**变异 4 处**各自真红、`cmp -s` 逐字节还原:M1 撤 review 诊断过滤 → 红 1(`["projects/p_memory/…","projects/p_other/…"]` 泄露别项目路径);M2 撤掉 `omitted` 整支 → 红 3(含**正控**,证明负例不是「恒空假绿」);M3 撤 `truncatedSources` 闸 → 红 1(agent 泄露 30);M4 撤 `historyTruncated` 闸 → 红 1(agent 泄露 23)。回归:`memory-review-smoke` 26/26;双包 `tsc --noEmit` 退出码 0。**remaining**:真三引擎两入口临时项目 A/B 负例仍未做(需真实 SDK);`memory.retrieval`/`injection` 的注入轨迹(`MemoryInjectionReceipt`)本身已按会话 projectId 过滤,未纳入本片。开发标记**已勾**。
**2026-10-14 独立复审增量｜HEAD `dc8acef8`｜E1**：并发开发提交覆盖 `memory.manage`（来源预览/导入/历史与恢复）、`memory.review` 和 `memory.reviewDelete` 的可信 session 项目可见性限制。Git Bash 从 `apps/desktop` 复跑 `memory-smoke` **253/253 通过**，含外项目历史读拒、跨项目 review 过滤与计数、带正确 digest 的删除拒绝以及桌面用户正控；`pnpm typecheck` 同 HEAD 3/3 成功。仍缺三真实模型/Agent 接口完整调用回放及 assistant 特殊链路复核，本轮**只增加 E1 覆盖，不勾独立复核**。

### MC-093｜记忆元数据敏感信息验证缺口（P1/P2，保存分片已修 / 独立复核失败）

2026-10-14 独立审查，E2 生产源码，E1 待补。保存记忆时当前只检查正文中的敏感信息形状，标题及保留的额外 frontmatter 字段未用相同判据；标题会进入记忆列表和自动模型上下文。建议对**最终完整待保存内容**统一检查，并验证人工编辑或历史格式数据的读取与注入环节。隔离回归应使用无效的测试凭据样式，分别覆盖标题、正文、扩展元数据、普通文字以及拒绝后文件保持不变。相关位置：memory/store.ts、memory/retrieval.ts、mcp/memoryServer.ts。

**MC-093 开发修复（2026-10-14，本地开发 AI）**：`memory/store.ts` 的 `saveMemoryFile` 在组装出**最终完整待保存内容** `raw`(= 标题 + 继承元数据 + 正文)后,对 `raw` 再做一次 `looksLikeSecret` —— 补上原先只查 `input.content` 漏掉的**标题**与**继承 frontmatter 元数据**两条路。判据仍是 `secretShape.ts` 那**唯一一份**(共享实现不复制);正文那支仍早退,被拒时不产生半写。**E1 红例**：`memory-smoke` +3(标题密钥被拒、继承元数据密钥被拒、被拒后文件原样不变)。**变异**：撤掉 `raw` 判据 → 红 3;逐字节 `cmp -s` 还原后 227/227。**修了个假绿**:初版「继承元数据」断言没带 `expectedRevision`,抛的是 `MemoryConflictError`(另一个理由),撤掉修复仍绿 —— 补真实 revision 后才真红。全路径确认:MCP(`mcp/memoryServer.ts`)、面板 IPC(`ipc/memory.ts`)、manage 都经 `saveMemoryFile`,闸门只有一份。**remaining**:`memory/retrieval.ts` 的**读取/注入**环节未动(人工编辑的历史格式文件若已含密钥,读取侧仍原样注入模型 —— 那需要读取侧遮蔽或迁移,属另一片);标题仅含测试样式已覆盖,但 frontmatter 里**已存在的**历史密钥未做清理/迁移。开发标记**已勾**。

**补充 E3，不另开新缺陷编号**：当前记忆历史归档保存更新/删除前全文且不自动清理，因此常规遗忘不是对备份与已传入模型上下文的彻底清除；应定义明确的数据保留与永久清除操作。多项目多条记忆的逐轮同步全库扫描和未分页列表需进一步进行容量/性能验收。Claude 严格 MCP 收窄时的内置记忆工具交付不一致属于既有 ARC-003/008/014 相关残余，不重复立项。

**2026-10-14 本轮复审更正｜MC-093｜REVIEW_FAILED（完整边界）**：先前曾仅凭 `saveMemoryFile` 对完整候选 `raw` 的敏感检查与 memory-smoke 正控准备勾选独立通过，**复查原始问题描述后撤回**：该条原审查还明确要求旧数据/人工编辑数据的**读取与注入**边界。`memory/retrieval.ts` 直接使用 `readMemoryFile(meta.path).content.trim()` 构造注入/检索片段（第 56、218 行）；读侧未调用 `looksLikeSecret` 或遮蔽，历史被人工修改、恢复的敏感原文可能进入模型上下文。此项为 E2 源码证据，**尚无真实三 SDK 外泄 E1，不宣称发生泄漏事故**。开发/独立均恢复 `[ ]`；保留写侧已修实绩，让本地开发 AI 补统一读侧敏感过滤、历史恢复路径和 E1 红绿/变异测试后再申请整体复核。

**MC-093 读侧修复（2026-10-14，本地开发 AI）**：`memory/retrieval.ts` **三处**读取后直接拼进送模型的内容(注入快照 `scopedMemorySnapshot` ×2 处 `body`/`record.content`,检索预览 `readCandidate` 的 `searchBody`),此前都不过敏感判据。现全部过 `redactSecrets`(与保存闸门**同一份** → `secretShape.ts`),读侧唯一遮蔽点。**E1 红例**:`memory-smoke` 256/256(+2:注入快照/检索预览里历史密钥被遮蔽 + 普通内容未误遮反证);`memory-injection` 11/11、`memory-codex` 177/177、`memory-review` 26/26 未破。**变异**:三处 `redactSecrets` 全撤 → 红 2(`sk-aaaa…` 原样出现);`cmp -s` 还原后 256/256。**remaining**:真三引擎临时项目 A/B 两入口负例未做;`review.unreadable` 诊断清单仍可能点到可见集合外路径(非正文)。

### MC-095 [P1｜扩展数据区物理与逻辑隔离边界]

- **状态**：开发 `[x]`（2026-10-14 本地开发 AI，物理闸 + 逻辑身份绑定两片；见下）；独立复核 `[ ]`。2026-10-14 E1 生产函数临时目录动态复现顶层 Junction 逃逸；通用 Agent RPC 未绑定 extensionId 的风险为 E2，暂不声称任何远程用户已经越权。
- **定位/原因**：`main/lib/extensionStore.ts:physicalExtensionDir` 将 `<dataRoot>/extensions/<extensionId>` 的 realpath 直接当可信 `dir`，若该 ID 目录本身是 Junction，会跟随到外部；`resolveInExtension` 之后只检查相对于这个已越界的 `dir`，导致真实外部写入。`main/ipc/extensions.ts` 所有处理器由输入的 `extensionId` 定位；`appControl` RPC 方法策略在只读时无独立的扩展资源 ID ACL。自定义面板 `panelBridge` 已绑定自己的 id，但无法保护通用 Agent 入口。
- **E1 失败输入**：扩展根下 `jump` 为外部目录 Junction，调用 `writeFileInExtension(root,"jump","pwn.txt","TEST_ONLY")`，返回 `{ok:true,bytes:9}`，外部目录出现测试文件。临时数据全部已清理。
- **最小修复/必须补测**：对 extension 根本身检查 `lstat` 与相对可信 `extensionsDir` 真实包含；读写目标最终重新验证、拒链接及 TOCTOU；可信调用者身份绑定 extensionId，任何 Agent 试读另一 ID 的内容须默认拒绝或进入明确的用户资源授权。脚本同时覆盖根 symlink/junction、子路径 symlink、目标置换、跨扩展 ID、正常同扩展读写。
- **2026-10-14 独立复审失败（E1 + E2，HEAD `0b274107`，工作区并发开发）**：用 `apps/desktop/.tmp/mc095_run.sh` 构建隔离脚本 `mc095_ipc_probe.ts`，同现有 `extension-store-smoke` 共用 `dataRoot` 隔离桩，数据根为一次性 `mktemp`（退出后删除），fakeIpc **真实注册并调用生产** `registerExtensionStoreHandlers`。预置 `private-plugin-a` 的 KV `PRIVATE_A_ONLY`、文件 `PRIVATE_A_FILE`，从**无可信 extension actor 的 handler 调用**直接把 `extensionId: private-plugin-a` 填进 `get/readFile`；运行 `"C:\\Program Files\\Git\\bin\\bash.exe" .tmp/mc095_run.sh` 退出码 0，输出 `{"foreignKv":"PRIVATE_A_ONLY","foreignFile":"PRIVATE_A_FILE","kvExposed":true,"fileExposed":true}`。这证明 handler **并未依据可信调用身份绑定扩展 ID**，不是物理 root escape；`appControl/tools.ts:invokeAppTool` 的通用 `app_api_call` 只对 `memory.*` 包可信会话作用域，对 `extensionStore.*` 直接 `callRpc`，为 E2 接线证据。**尚未执行真实三 SDK 模型从 app_api_call 入侵的 E1**，不声称外网用户已可越权。对照 `extension-store-smoke 161/161` 通过只覆盖根 Junction 与文件保留区，不覆盖 actor 绑定。**复核不通过，撤销 MC-095 开发已修复勾选**，保持 `[ ]/[ ]`，直至通用 Agent 按可信 session/extension 身份做 ACL 或显式用户授权且跨 ID 测试真拒。
- **MC-095 逻辑隔离开发修复（2026-10-14，本地开发 AI）—— 通用 Agent 调用端绑可信扩展身份**：`memory/agentScope.ts` **复用同一套 `AsyncLocalStorage` 机制**(未另起第二套)增扩展作用域:`currentAgentExtensionScope()`/`runWithUnboundAgentExtensionScope()`/`runWithAgentExtensionScopeForExtension()`/`extensionAccessRefusal(extensionId)`。`appControl/tools.ts` 在**两个通用入口**——agent `app_api_call`(invokeAppTool)与面板 `api.call`(panelApiCall)——的 `callRpc` 外层包 `runWithUnboundAgentExtensionScope`(**没有**扩展身份);`ipc/extensions.ts` 六条 handler 入口统一过 `assertExtensionAccess(input.extensionId)`(拒绝理由唯一一份,来自 `extensionAccessRefusal`)。**语义**:桌面渲染端直连(无作用域,`panelBridge` 用 `host.item.id` 自绑)= 保留「任意 id」;通用路(有作用域无身份 / 身份对不上)= **一律拒**(fail-closed)。**决定与诚实边界**:当前**没有任何 agent 会话携带扩展身份**(sessions 表无 extensionId 列,orchestration/claude 无相关字段),故通用路的正确行为就是**拒**,而非「按会话推导可达扩展」;`runWithAgentExtensionScopeForExtension` 是给未来「代某扩展行事」的调用链预留的宿主铸造口(本片无生产调用点,仅测试正控用)。**E1 红例**:`extension-store-smoke` 177→211(+34:§8 作用域判据 4、桌面直连正控 3、通用无身份六通道全拒+理由 12、无泄漏/无落盘 4、身份匹配正控 3、跨扩展拒+自扩展放行 2、源码唯一一份 6);`app-control-smoke` 404→407(+3:agent 路装无身份作用域、非 extensionStore 域不误罩正控、面板 api.call 路装作用域)。**变异 4 处**各自真红、`cmp -s` 逐字节还原:**M1** 判据恒放行 → `extension-store-smoke` 193/211(红 18,foreignKv 真被读到);**M2** handler 强制恒不抛 → 红 18; **M3** 撤 agent 路包作用域 → `app-control-smoke` 406/407(红 1);**M4** 撤面板路包作用域 → 红 1。双包 `tsc --noEmit` 退出码 0(唯二报错在别的车道 `maint-m07-smoke`,与 MC-097 租约相关,非本片)。**remaining**:① 真三 SDK 模型经 `app_api_call` 的在线 E1 未做(仅隔离 handler + 端到端接线断言);② 尚无「宿主为某扩展铸造身份」的真实调用点——若将来让 agent 代表某扩展行事,必须经宿主铸造 id 的那条口,不能从 `args` 读;③ 判据与使用点间 TOCTOU 沿用既有边界(与 MC-095 物理闸同款)。开发标记**已勾**(逻辑隔离分片)。

### MC-096 [P1/P2｜扩展文件通道覆盖内部 KV 数据]

- **状态**：开发 `[ ]`；独立复核 `[ ]`。2026-10-14 E1 临时数据根验证：键值 `important=KEEP_ME` 写入后，扩展文件接口执行 `writeFileInExtension(root,"good","store.json","NOT_JSON")` 返回 `{ok:true,bytes:8}`，随后 `readValue` 返回 null，表明存储文件被毁而解析层将损坏默认为空。
- **根因/位置**：`main/lib/extensionStore.ts` 的普通文件通道不排除 `store.json`，与 `writeValue/persist/readStore` 共用目录和文件名；单次文件限额 4MB 不限制扩展累计文件占用。
- **修复/验收**：把 `store.json`、内部元数据和临时锁文件放在普通文件接口不可寻址的受保护命名空间；坏 JSON 不应无告警变空（last-good/隔离与明确恢复），拒绝普通文件覆盖、重命名和读取控制文件；加扩展累计大小及文件数预算和真实不同 ID 隔离回归。

### MC-097 [P1｜文档编辑校验与最终写入之间非原子]

- **状态**：开发 `[x]`（2026-10-14 本地开发 AI，见下）；独立复核 `[ ]`。2026-10-14 E2 源码调用链，交错写 E1 已补（提交点 CAS 冲突），断电故障注入 E1 待做。
- **开发修复（2026-10-14，本地开发 AI）**：`FileWriteSchema` 加可选 `expectedVersion`（读到的那版内容 sha256）；`file.readFile` 回传同算法 `version`。FILE_WRITE 给了 `expectedVersion` 时在**最终提交点**重读比对，不一致返回 `{ok:false,conflict:true}`（CAS 落写那一刻，与 `memory/store.ts` 的 `assertRevision` 同纪律）；写入改**原子替换**（写同目录随机后缀临时文件 → fsync → rename，失败清理临时文件并抛错，不退回非原子的直接写）。渲染端 `markdownFileWrites` read 记 version、write 带上，conflict 抛同一种 `FileConflictError`。**E1 红例**：`maint-m07-smoke` 25→33（+8：版本匹配→写入、过期版本→拒绝且磁盘不被覆盖、向后兼容、不留临时残留、读不存在→version null、新建成功）。**变异**：撤 CAS → 红 2（**磁盘被 `v3-should-not-land` 覆盖**，精确复现静默覆盖）；`cmp -s` 还原后 33/33。`editor-save-smoke` 40/40、`file-links-smoke` 44/44、`markdown-mode-smoke` 32/32 未破。**remaining**：跨**进程**租约锁未做（只有提交点 CAS + 原子替换，挡得住静默覆盖与半写，非互斥）；断电故障注入 E1 未做。开发标记**已勾**。

**MC-097 续修（2026-10-14，本地开发 AI）—— 跨进程租约锁**：租约原语从 `mcp/agentDocumentOps.ts` 抽到 `lib/osFileLease.ts` 的**唯一一份**(`withOsFileLease`,realpath 归一 `<real>.mcode-lock`),`FILE_WRITE` 的 CAS + 原子替换整段包进它;Excel/PDF/DOCX 改调同一份(删私有重复 ~95 行)。**E1 红例**:`maint-m07-smoke` 33→41(+8,含**真·两个独立 OS 进程**同路径同版本并发 → 恰好一个成功、另一个 conflict)。**变异**:退化成裸透传 → 红 4;`cmp -s` 还原后 41/41,不同路径独立性断言保持绿。回归:`doc-ops-smoke` 10/10、`mcp-text-smoke` 53/53、`mcp-endpoint-smoke` 756/756。**remaining**:断电/崩溃故障注入 E1 未做;极端竞争可能以租约超时的 `FILE_VERSION_CONFLICT` 告终(显式失败,不静默)。开发标记**已勾**。

**MC-097 E1 续修（2026-10-14，本地开发 AI）—— 崩溃/中断恢复故障注入**：在 `maint-m07-smoke` 用 esbuild 把 `node:fs/promises` 换成一份**转发壳**(新 `scripts/maint-m07-smoke/fsFaultShim.ts`,未设开关时逐调用转发真实实现 → 生产 `ipc/files.ts`/`lib/osFileLease.ts` **一行未改**),按需让 `open`(临时文件创建)或 `rename`(原子替换提交步)失败,模拟写一半崩溃。**E1 红例**:`maint-m07-smoke` 41→71(+30)。四类承重负例:① `rename` 崩溃 → 写入如实报失败、**原文件逐字节不变**(`readFileSync().equals()`)、不留 `.mcode-tmp` 残骸、崩溃后仍可读回原内容;② 临时文件 `open` 崩溃 → 同上(原文件不动/无残留);③ 陈旧租约被回收(**死 pid** 走 `process.kill(pid,0)` ESHR → `leaseOwnerAlive` 判死; **跨机 host + 过期时间戳**走 `Date.now()-createdAt < LEASE_STALE_MS` 判死),对**共享原语** `acquireOsFileLease(lock, 2000ms)` 直接断言回收成功、旧锁已清、下一个写者 `FILE_WRITE` 照常写入;④ 失败者**释放**租约(注入后首发写失败 → 锁文件不在 → 后续写**立刻**成功,耗时 `<5s` 远小于 60s 租约等待上限);⑤ CAS 冲突后回读**当前**版本重试成功(文件可读+可重写,不是一次冲突就死锁)。**变异**:M1 原子替换退化为直接写 → 红 6(**原文件被 `SHOULD-NOT-LAND` 覆盖**,精确复现非原子);M2 CAS 比对失效 → 红 8(含**磁盘被 `v3-should-not-land`/`should-not-land` 覆盖**);M3 租约判活恒 true → 红 4(死 pid/跨机陈旧租约的回收断言);M4 租约释放变空操作 → 红 4(释放断言;**同路径后续写各卡 60s 是副产物**,非断言本身)。四处均逐字节 `cmp -s` 还原后 71/71。**remaining**:真实 Electron **两端并发**(两窗口/一窗口+外部编辑器)与**进程真被杀**(SIGKILL 中途)仍只在无头注入的等价物上验证,未做真机两进程崩溃回放;`doc-ops-smoke` 本轮观察**不稳定**(3 跑中 1 跑 8/10、2 跑 10/10,失败点在 PDF 渲染期时窗断言,**与本改动的源码无关**——`agentDocumentOps.ts`/`osFileLease.ts` 对 HEAD 无 diff,属既有 flaky,未处理)。开发标记**已勾**。
- **源码**：`renderer/lib/markdownFileWrites.ts` 先 `api.file.readFile` 比较 `expected` / `lastWritten`，再另一 RPC `api.file.writeFile`；`main/ipc/files.ts` `FILE_WRITE` 只验证工作区路径、直接 Node `writeFile`，没有 expectedHash、版本锁、进程间 CAS/租约或原子替换。已有 `SerializedFileWrites` 只保证同一 renderer 的同路径请求顺序，不能排除另一个 Agent/进程在两条 IPC 中间写入；普通 writeFile 的中断也可能留下半写内容。
- **修复/验收**：主进程接 `expectedVersion`（内容哈希/mtime+inode 需抗 ABA），同路径跨进程锁并在最终提交点检查；先写同目录临时文件并同步、原子替换。隔离注入 Agent 写入发生在 renderer 检查完成与主进程写入前，旧编辑器保存必须冲突而非覆盖；注入写一半失败、取消、崩溃、删除/重建及两个窗口并发，校验源字节不丢。关联已关闭 MC-069 的并发设计，但它覆盖的是 Excel/PDF 工具，不重复撤销其历史通过状态。

### MC-098 [P2｜Monaco 引用正文与来源行号快照不同步]

- **状态**：开发 `[x]`（2026-10-14 本地开发 AI，见下）；独立复核 `[ ]`。2026-10-14 E2，交互 E1 待做。
- **开发修复（2026-10-14，本地开发 AI）**：`SelectionToolbarState` 加可选 `lines`，`readMonacoSelection` 把行号范围与 `text` **一起冻结**在同一快照；`quoteFromEditor` 改用冻结的 `mdQuote.lines`，删掉现读 `editorRef.getSelection()` 取行号的代码。**E1 红例**：`renderer-pure-smoke` 191→194（+3：选中时冻结 lines、落草稿用冻结 lines、**负控** quoteFromEditor 内不再现读 getSelection）。**变异**：退回现读 getSelection → 红 1；`cmp -s` 还原后 194。`content-tag-smoke` 28/28、`markdown-quote-smoke` 22/22 未破。**remaining**：浏览器交互 E1（真实"选区 A → 开菜单 → 改选区 → 引给 B"）未做；`contentTag.ts` 的总上下文预算未做（归 W04/UXG）。开发标记**已勾**。
- **原因**：`renderer/components/ide/FileEditor.tsx` 的 `readMonacoSelection` 将选中文字冻结进 `SelectionToolbarState.text`，但用户在 `SelectionQuoteMenu` 选定目标后 `quoteFromEditor` 又从 `editorRef.current?.getSelection()` 读取**此刻**范围作为行号。若选区中间变了，`makeQuoteTag` 的正文是旧内容、`lines` 却是新位置；这一层不是单一快照。
- **修复/验收**：将 `text + path + start/end line + file version` 在选中时一起冻结，选择目标时仅交付已冻结的快照。浏览器测试：选区 A → 打开引用菜单 → 修改/取消选区 → 引给会话 B；标签内容与行号必须仍对应 A；文件切换后旧菜单应失效。

### MC-099 [P1｜插件声明能力与真实注册/可执行性混淆]

- 开发已修复 [ ]；独立复核 [ ]。2026-10-14 E1：生产 PluginManifestSchema、collectCapabilityInventory、resolveCapabilities，仅使用虚构插件声明 builtin nonexistent.host.action，未注册执行器，结果 manifestAccepted=true、withoutPlugin=false、withManifestOnly=true、actualExecutorLoaded=false。源头为 packages/contracts/src/plugin.ts 的 capabilities[] 允许声明，main/orchestration/capabilityResolver.ts 的 pluginCapabilityDescriptors 直接导入 READY 描述器。没有实际危险命令执行，仅证实预检假阳性。
- 最小修复：保留插件自描述用于发现；引入 DECLARED/REGISTERED/READY 三层事实。builtin/provider/executor 必须与可信宿主 registry 交叉验证；skill/mcp/nodeType 与已加载组件、引擎可见性、插件启用、项目范围及有效授权核对，不能仅凭插件提供字符串就使 required capability 通过。
- 独立复核 E1：不存在的虚构 builtin/executor/provider / 缺失的 Skill/MCP / disabled 插件 / 别项目不可访问，required 预检必须拒绝或具体报 gap；真实 ModuleHost 注册+审批与真实 SDK 交付正常可用。撤去实际注册核查必须产生红例。AI 修改扩展的开发工具、持久化升级/回滚、依赖诊断归入 ARC-006/011/014，不额外开六条不具备独立失败证据的 MC。
- **E1 补片（2026-10-14，本地开发 AI｜真实注册才令必需能力可用）**：在 `capability-smoke` 补五组承重负例，判据落在**场景能力预检**（`sceneCapabilityPreflight`，生产从 `HOST_CAPABILITY_DECLARATIONS` 装配，见 `appServices/scenePreflight.ts`）与**声明表/真实注册同源**上：① 只有插件声明（无 `hostCapabilities`、无 `executorKinds`）时，场景对 `nonexistent.host.action` 的**必需 module 项**预检 `ok=false` 且按 `missing` 报出，节点对插件声明的 executor 需求判缺；② 真实宿主注册（`hostCapabilities: HOST_CAPABILITY_DECLARATIONS`）令 `core.file.inspect` 场景必需项通过、真实 `executorKinds` 令 `myorg.heavy` 节点需求通过；③ 真声明表在场时，插件自报的 builtin **仍判缺**且缺口恰好是那一条（声明不覆盖权威）；④★ 权威声明表必须与 `ModuleHost` 真实注册（`fileCapabilities`）**同源**（id 集合逐一相等），否则"可用的 builtin"与实际执行器漂移；⑤ 真声明表里没有的 builtin 不进目录（不凭空造）。**E1 红例**：`capability-smoke` 104→116（+12）。**变异**：① 撤 `pluginCapabilityDescriptors` 的 kind 过滤 → 红（`★ MC-099:插件声明的 builtin 不被转成可用 descriptor`）；② 从 `HOST_CAPABILITY_DECLARATIONS` 删 `core.file.inspect` → 红（`★ MC-099 E1:真实宿主注册(core.file.inspect)后场景必需项预检通过`）；③ 把声明表 `core.file.info` 改名成 `core.file.info.PHANTOM`（与真实注册漂移）→ 红（`★ MC-099 E1:权威声明表与 ModuleHost 真实注册同源`）。三处均逐字节 `cmp -s` 还原后 116/116。**注**：②③ 是本片新增断言**独有**的变异靶点（`HOST_CAPABILITY_DECLARATIONS` 在旧 smoke 中零消费，只被新块读），故不只是复现旧 `★ MC-099` 那条。**remaining**：仍**未做**真实三 SDK 从 `app_api_call` / 真实模块注册审批链发起的 E1（无真实模型调用；本片只在生产纯函数+真装配函数上取证）；provider/dispatcher 是否真把该清单喂给预检由既有 `scene-preflight-smoke` 与本片的装配断言佐证。

### MC-100 [P1｜McodeAI 工具集按需发现与上下文注入边界]

- **状态**：开发 `[ ]`；独立复核 `[ ]`。2026-10-14 架构复审新增。
- **背景原则**：Mcode 的目标是高度自定义通用 Agent。工具、Skill、MCP、Extension、Workflow、教程文档不应永久进入模型上下文，而应通过能力发现按任务动态加载。
- **当前证据**：项目已有 `apiCatalog.generated`、skills.list/read、capabilityResolver 等分散能力发现机制；但尚未证明存在统一的 Tool/Capability Discovery 层，统一处理工具元数据、适用引擎、权限、成本、文档索引和上下文注入预算。部分 SDK 仍可能采用全量工具暴露方式，需要继续核实。
- **风险**：工具规模增长后，所有 schema 常驻会浪费上下文并降低工具选择质量；多个子系统独立发现又会阻碍 Agent 自主组合能力。
- **修复方向**：建立统一 Discovery → Ranking → Context Injection 链路。Planner 只查询任务相关能力；Context Injector 只加载当前执行需要的工具定义、Skill 和文档片段；保留 Claude/Codex/Pi 原生差异。
- **验收**：大型扩展集合下，证明未使用能力不会进入模型上下文；任务触发后可发现并加载对应工具；三引擎能力语义一致但不强行同质化。
- **2026-10-14 E2 调用链复核（HEAD `476e5043`→`0b274107`，并发工作区）**：已存在真正三工具 `app_api_list → app_api_describe → app_api_call`（`appControl/tools.ts:970/1015/1054`），因此**不是“没有 Discovery”**，不得重造第二套功能目录。欠缺的是按任务/预算决策与模型可见工具/文档的可验证注入。和 MC-101 关联，**MC-100 负责能力查询契约/关联索引/预算选择；MC-101 负责三 SDK 最终可见性与动态切换验收**，同一底层方案不得开两个独立实施包。原状态 `[ ]/[ ]` 不变。
- **2026-10-14 选择层切片（开发侧，未接引擎）**：新增纯契约 `@contracts/toolProfile`（`packages/contracts/src/toolProfile.ts`）——`ToolProfile`（`minimal`/`chat`/`code`/`research`/`browser`/`workflow` + `userOverride`）与纯函数 `selectToolsForProfile(inventory, profile)`：给定 `EffectiveToolInventory` 与画像，回该任务**应暴露**的工具名子集。桶判据复用清单已有来源标签（`toolNamesOfSource` 同一份事实）+ 名字族，不另造工具名单。安全约束：`ESSENTIAL_TOOL_NAMES`（`app_api_list/describe/call`）为 floor，与画像无关恒含，`userOverride` **只增不减**（无 `remove`），故画像切换藏不掉计划模式/审批中仍需的工具。`userOverride.add` 里清单不存在的名字被忽略（未知名不静默暴露）。骨架由 `effective-tools-smoke 90/90` 钉住（6 条变异全部真红、字节还原）。**尚未接线**：Pi 的 `setActiveToolsByName`、Claude 的 `Options.tools`、Codex 的 `dynamicTools` 三处真实装配与请求层最小化（是否真的不进入 SDK 请求）未做，属后续切片（MC-101 执行层）；本轮**未改任何 provider 运行时行为**。

### MC-101 [P1｜三引擎上下文注入未形成统一最小上下文治理闭环]

- **状态**：开发 `[ ]`；独立复核 `[ ]`。2026-10-14 长期审查新增。
- **审查范围**：Claude/Codex/Pi provider 的工具、Skill、MCP、Extension 注入路径，以及 Planner/Context Injector 是否基于任务动态选择能力。
- **当前证据（E2）**：项目已经具备多个局部能力入口：`skillEngines` 管理 Skill 根、`capabilityResolver` 管理能力库存、MCP/Plugin/Module 各自有发现逻辑；说明“没有发现机制”不成立。但目前未发现一个统一入口同时记录能力的来源、适用引擎、权限等级、成本、上下文预算和任务相关性评分。
- **重点风险**：随着 Skill、MCP、Extension 数量增长，各系统独立向 SDK 暴露能力会导致：(1) 未使用工具 schema 进入模型上下文；(2) 不同引擎看到的能力集合不一致；(3) Agent 无法自主判断“先发现能力还是直接调用”；(4) 长期记忆/文档/教程容易和执行工具混合注入。
- **已确认边界**：Pi provider 当前存在 `const tools = undefined`（SDK 默认全部内置+扩展工具），该设计解决了 plan mode 动态权限问题，但与“按任务最小工具集合注入”的长期目标存在架构冲突；需进一步评估 Claude/Codex 是否也存在类似全量暴露。
- **修复方向**：不直接删除现有能力系统，而增加统一 Discovery → Ranking → Context Injection 层：能力目录负责事实，Planner 负责选择，Injector 负责按 token/权限/任务加载最小集合，Provider 保留引擎差异。
- **验收**：构造大量无关 Skill/MCP/Extension；证明未选能力不会进入模型请求上下文；任务触发后可通过 Discovery 找到并加载对应能力；Claude/Codex/Pi 三引擎结果可解释。
- **2026-10-14 E2 三引擎实际装配补证**：`providers/pi-sdk/PiAgentSdkProvider.ts:141,324` 仍 `tools=undefined`、`excludeTools` 黑名单，`providers/pi-sdk/mcodeExtension.ts:214-291` 在工厂内无任务条件地注册 app/memory/library/workflow/agent 及条件 browser；`providers/codex-sdk/CodexAgentSdkProvider.ts:492,511,1145` 的 thread start/resume 均构造全量 `buildDynamicTools(browserToolsEnabled)`，仅 browser 条件开关、没有 ToolProfile；`providers/claude-sdk/ClaudeAgentSdkProvider.ts:924,1600-1754` 仅通过 `disallowedTools` 禁用名单与 `strictMcpConfig` 工作流节点收窄 MCP，普通轮挂 library/workflow/memory/agent/app。**注意积极边界**：`mcp/mcodeServer.ts:1174` workflow 不设置 `alwaysLoad:true`，会随 CLI 工具检索按需加载；其余 library/agent 等仍存在 alwaysLoad，不可笼统说 Claude 所有工具全量常驻。无“任务→筛选→Provider 的最终 tool set”证明，保持开发 `[ ]`、复核 `[ ]`。建议先导出 SDK 真实有效工具名、Schema 字节/token 与恢复遗留，然后最小化；Pi 动态工具更新要兼顾 plan 批准后恢复 write/edit/bash；Codex 恢复线程旧工具不能只做派发时拒绝就宣称已从上下文移除。
- **E1 相关局部回归（隔离/源码断言，不是在线模型输入抓包）**：Git Bash 从 `apps/desktop` 运行 `engine-tools-smoke 51/51`、`provider-context-smoke 56/56`、`engine-capability-matrix-smoke 55/55`、`pi-loader-smoke 5/5`、`mcp-engines-smoke 47/47`、`capability-smoke 104/104`。这些测试**均没有**基于任务大规模扩展构造完整 SDK 模型请求并测 input/cache token，不能据此关 MC-100/101/ARC-003/008/014。
- **2026-10-14 诊断层首片（本地开发 AI，E1，只确立基线，未关任何条目）**：按两轮复核反复点名的同一步「先导出 SDK 真实有效工具名、Schema 字节/token 与恢复遗留」，做了一份**纯只读诊断** `EffectiveToolInventory`，新增契约 `packages/contracts/src/effectiveToolInventory.ts`（`buildEffectiveToolInventory` / `estimateToolTokens`，纯算法：按来源分类、schema 字符数、粗估 token）与主进程装配 `apps/desktop/src/main/orchestration/effectiveToolInventory.ts`（`claudeEffectiveToolInventory` / `codexEffectiveToolInventory` / `piEffectiveToolInventory` / `buildEngineToolInventory`），**复用**各 provider 现成的工具表（`libraryToolDescriptors` / `workflowEngineBridge.descriptors` / Codex 的 `buildDynamicTools`（本次改为导出）/ `KNOWN_BUILTIN_TOOLS`），**未另造第二份工具名单**（硬规矩 2）。它**不改变任何 provider 实际发出的东西**（只读，无 `registerTool`/`options.mcpServers` 写形态）。**E1 红例**：新套件 `effective-tools-smoke 44/44`（排除即不在清单且记入 `excluded`、三引擎集合不同且来源标签正确、token 估计对字符数严格单调、恢复遗留归 `resumed-legacy`、只读接线源码断言）；`engine-tools-smoke 51/51`、`capability-smoke 104/104`、`provider-context-smoke 56/56`、`memory-codex-smoke 177/177` 未破。**变异 8 处**各自真红、逐字节 `cmp -s` 还原（撤排除红 5、Codex 来源错标红 1、撤 browserEnabled 门红 1、撤 `buildDynamicTools` 复用红 2、token 估计常量红 2、丢弃恢复遗留红 2、撤 `mcp__<server>__` 前缀红 2、撤销 buildDynamicTools 导出→打包期 `No matching export` 红）。**remaining**：本片只把「裁剪**之前**模型会看到哪些工具、有多大」量化出来 —— **`「不是最小化本身」`**；真实最小化（按任务筛 `ToolProfile`、Planner 选能力、Injector 按 token/权限加载最小集合）**未做**，MC-100/101 的验收（构造大量无关 Skill/MCP/Extension 证明未选能力不进模型请求）**未达成**；token 是**粗估**（`CHARS_PER_TOKEN=4`，CJK 更密，未跑真分词器）；Claude 内置工具名取自静态 `KNOWN_BUILTIN_TOOLS`（非 SDK 权威枚举），用户级 `.claude.json`/项目 `.mcp.json`/插件 MCP 的工具表在 SDK 侧（宿主枚举不到，已如实记 `notes`）；Codex 动态工具 schema 采实测值、Pi 的 Ask/Plan 工具只按名计入（schema 内联在 `mcodeExtension.ts` 未重复采计）；两引擎真实 SDK 请求层抓包（input/cache token）仍未做。**不勾开发、不勾复核**。


## 7. 专题资料归属与历史记录

| 历史专题 | 已归并到 | 原始备份（同目录） |
| --- | --- | --- |
| 三引擎与上下文 | W04 / W05，MC-056/057/070/074/076/077/078/079 | `Mcode_本体三引擎与上下文长期评审_20261012.md` |
| 公网 MCP、远控 | W02 / W03 / W06，MC-062～069 | `Mcode_公网MCP实测与远控对标_20261012.md` |
| 资料库与文档 | W07，MC-085～087 | `Mcode_资料库文档功能长期评审_20261012.md` |
| UI 独立审查 | W08，UI-001～003；UI-004～050 不可恢复 | `Mcode_UI全域独立评审台账_20261012.md` |
| 体验路线 | W01/W04/W07/W08，UXG-001～007 | `Mcode_产品体验路线与验收台账.md` |

## 8. 后续只在这里更新的状态规范

1. 本地开发 AI 修复 MC：只勾该 MC 的**开发**标记；提供源码文件、版本、旧红例→新绿例、正常/失败/边界测试。ARC 只有整包完整实施才勾开发完成；分片仅记录在对应 W 项。
2. 独立审查 AI：只在真实当前源码上运行对应红例与必要的跨端/三引擎/授权/持久化测试后勾**独立复核**。本轮整理本身不新增任何‘通过’结论。
3. 复核失败：撤销该条开发已修复标记，AI 复核保留空勾；保留失败输入、最小源码定位、回归脚本、版本和必须补的测试；双勾旧事件不能靠历史文字自动打回。
4. 根因去重：发现类似问题先查正式 MC/ARC 编号与本文件 W 包，已有同一根因就追加证据和 remaining，不再复制一份新长台账。
5. 对 UXG 仅在有 U1 真实用户旅程证据时关体验项；不得把纯函数存在、typecheck 通过、UI 文案显示等价于整条产品旅程。
6. 更新时记录 Git HEAD、文件 SHA、证据等级 E1(隔离行为)/E2(源码调用链)/E3(待证明)/D(设计)、实际测试命令及结论、未覆盖边界。并发修改要先核实版本，不能重置他人工作树。

**增量事件格式**：`YYYY-MM-DD | MC/ARC/UI/UXG-ID | DEV_CLAIM / REVIEW_PASSED / REVIEW_FAILED / REGRESSION | Git HEAD / file SHA | E1/E2/E3/D | 命令及断言结果 | remaining`。

## 9. 迁移校验及可回溯证据

- 本次为文档层合并，**没有**重新执行 88 条 Bug 的完整动态复审。旧版正文的历史失败叙述不推翻已存在的正式双勾。
- **迁移时原始快照完整度**：MC 88 条连续且唯一；ARC 17 条连续且唯一；UXG 7 条；MC 双勾 81／未关闭 7；ARC 双勾 1／待整体验收 16。**2026-10-14 早期增量记录（历史口径，已非最新）**：MC 99 条，80 双勾／14 未关闭、5 条开发待独立复核（MC-077/089/090/091/093）；MC-089～099 均是合并后新增，历史快照不得倒改。
- **当前条目范围**：已登记 MC-001～102；其中 MC-100/101 是同一按需发现问题的发现层/执行层，状态请见 §3/§6，不能从旧 `MC 99 条` 的快照数字推断今日进度。
- 冻结原件位置：`archive/2026-10-13_premerge/`；每份 SHA256 见 `SOURCE_MANIFEST.json`。整理时源 MC 台账发生两处追加（MC-014/052 的 SSH 授信 UI/IPC 切片），已在 W02 补充且**没有调整复核勾选**。迁移前最后一个现场版本另外完整保存于 `archive/2026-10-13_final_live_sources/`，其 SHA256 清单为 `FINAL_SOURCE_MANIFEST.json`；比冻结原件多出的内容不得遗失。

| 原件 | 大小 | SHA256 前 16 位 |
| --- | ---: | --- |
| `Mcode_问题排查与复核台账.md` | 793993 B | `cdd333425bbda60a` |
| `Mcode_架构与场景能力优化台账.md` | 280801 B | `e1762d9cf128ff14` |
| `Mcode_产品体验路线与验收台账.md` | 9666 B | `272ab629974d8aab` |
| `Mcode_UI全域独立评审台账_20261012.md` | 14691 B | `663bc5972b21faed` |
| `Mcode_本体三引擎与上下文长期评审_20261012.md` | 29045 B | `a53f4828d60bd910` |
| `Mcode_公网MCP实测与远控对标_20261012.md` | 43555 B | `e41bc87527e8602d` |
| `Mcode_资料库文档功能长期评审_20261012.md` | 9055 B | `c020ce95f33f9f29` |
| `Mcode_总台账索引与当前状态.md` | 19095 B | `65a99e2cab80d94f` |
| `README.md` | 34477 B | `783e3876bd6b1f62` |

**唯一实时维护入口**：`audit-ledgers/Mcode_统一审查台账.md`。


**2026-10-14 独立复审增量｜Mcode 顶层原则：按需发现工具，而非工具常驻上下文（ARC-003/008/014 复审）**：

- 用户顶层设计确认：McodeAI 的目标不是把全部工具 schema、Skill、MCP、扩展文档永久注入模型上下文，而是维护一个可查询的能力空间。模型默认只获得当前任务所需最小信息，需要时通过能力发现、工具目录、文档索引、Skill/MCP 查询加载详细能力。
- 现状核对：`app_api_list → app_api_describe → app_api_call` 已形成通用自发现入口；`capabilityResolver` 已形成宿主能力目录；`scenePreflight` 已能基于能力清单做前置判断。故不新增“没有工具发现系统”的 MC。
- 未完成项（追加到既有 ARC，不单独重复开 Bug）：真实模型可见工具集动态裁剪仍未整包验收。当前主要缺口：①统一 ToolProfile/EffectiveToolInventory；②根据任务、provider、token预算生成实际 SDK tools allowlist；③Claude/Codex/Pi 三引擎工具热切换与恢复语义统一；④工具、Skill、MCP、Extension、文档之间的关联查询入口统一。
- 设计约束补充：工具目录本身应作为“元能力”存在，而不是全部工具暴露。Agent 首先发现能力，再获取对应工具 schema、教程、示例和权限要求。否则随着扩展数量增长，会出现工具描述污染上下文、模型选择能力下降、token浪费。
- 状态规则：后续若已有 ARC/MC 增加该类细节，必须同步更新原条目的 remaining / 状态；不能只追加说明，否则本地 AI 会误认为已修复完成。未形成独立失败证据的不新增 MC。


---

## 2026-10-14 本轮长期审查记录（app 项目复审）

**审查范围**：Mcode 主项目（`D:\destop\work_space\work_for_reseach\mcode`），依据当前统一审查台账、最新工作区状态进行复核。

**环境检查**：
- 当前 Git HEAD：`476e5043`。
- 工作区无未提交修改（`git status --short` 无输出）。
- 当前台账仍作为唯一维护入口，历史 archive 不直接修改。

**本轮结论**：
1. 未发现需要立即新增编号的独立 MC 问题。已有主要风险均已归入 MC/ARC/W 工作包，不重复创建条目。
2. 保持现有关闭策略：开发修复 ≠ 独立复核通过。MC-060、061、089～099 等仍需按原始验收边界逐项复核。
3. 当前重点未关闭方向保持不变：
   - P0/P1 架构闭环：ARC-001/002/003/004/005/006 等完整端到端验收。
   - 安全边界：MC-004、014、052 的真实网络/SSH 信任链验证。
   - 自主 Agent 控制面：MC-058/059 的计划、授权、部署、回读闭环。
   - 扩展治理：MC-060/061/095/096 后续沙箱、身份绑定、持久授权和恢复能力。
   - 文档编辑一致性：MC-097/098 的 CAS、原子写入、引用快照一致性。

**台账状态处理**：
- 未将任何条目错误标记为“复核通过”。
- 已有 DEV_CLAIM 保持原状态，等待独立验证。
- 本轮仅追加审查记录，无业务代码修改。

## 2026-10-14 长期审查续（覆盖率与启动链复核）

**当前版本**：HEAD 已变化至 `dc8acef8`（前一条环境记录中的 `476e5043` 已过期，不作为当前基线）。

**覆盖率复核**：执行 `apps/desktop/scripts/smokes-for.sh --uncovered`，当前主进程中无任何 smoke 覆盖的文件从 48 个收敛到 5 个：
- `src/main/index.ts`
- `src/main/lib/visionRelay.ts`
- `src/main/mcp/delegateHost.ts`
- `src/main/providers/claude-sdk/index.ts`
- `src/main/raw-imports.d.ts`

这不是立即安全漏洞，但说明上述入口修改没有对应自动回归网。其中 `index.ts` 是应用装配根，`delegateHost.ts` 是公网 MCP 委派链，`visionRelay.ts` 涉及外部模型调用，优先级高于普通未覆盖文件。

**源码复核结果**：
1. `delegateHost.ts`：确认外部 AI 委派使用独立 session，并按项目映射；但仍依赖 `permissionMode: bypassPermissions` 设计，需要结合公网 MCP 开关、用户授权和真实攻击链继续验收，不新增 MC，归入 ARC/公网 MCP 验收。
2. `visionRelay.ts`：已实现无工具视觉中继、超时、并发限制和失败显式返回；仍缺真实模型端到端回归（错误配置、恶意图片提示注入、额度失败）。
3. `index.ts`：大量启动装配集中于单入口，当前通过注释和已有 smoke 覆盖大部分模块，但启动顺序、初始化失败恢复、退出清理没有专用端到端 smoke。

**下一轮长期审查方向**：
- 为上述高风险无覆盖入口补最小 smoke，而不是继续增加功能代码。
- 重点检查公网 MCP → delegate → RuntimeManager → provider 的权限边界。
- 对 MC-100/101 继续做真实 SDK 请求层工具可见性验证，而非仅源码静态分析。

---

## 2026-10-14 长期复审续（全量台账校正）

**当前基线**：Git HEAD `f40a48d3`。

**本轮范围**：复审全部 MC/ARC 工作包状态，不新增重复编号；重点检查已有 DEV_CLAIM 是否满足独立复核标准。

### 状态校正

1. **没有发现可以直接批量关闭的新条目。** 当前大量条目已经完成代码切片，但仍存在“分片通过 ≠ 整体闭环”的情况。

2. 当前主要未闭环集中于：

- **MC-058 / ARC-002：场景自主部署链**
  - 已完成：SceneSpec、ScenePlan、SceneDeployment 状态机、持久化、dry-run/apply、授权消费、resume 基础链路。
  - 仍需：真实资源身份绑定（resourceUid）、所有资源类型回读契约、plugin/panel/scaffold 补偿策略、完整崩溃恢复验收。

- **MC-059：无人值守执行授权链**
  - 已完成：approve/run IPC、grant 校验、policy 阻断。
  - 仍需：完整用户交互入口和真实端到端授权旅程。

- **MC-091：自动化可靠交付**
  - 已完成：欠账记录、恢复基础能力、背压相关切片。
  - 仍需：异常启动失败窗口、崩溃恢复、不重复不丢失的完整 E3 语义验证。

- **MC-100 / MC-101：工具发现与上下文注入**
  - 已完成：EffectiveToolInventory、ToolProfile、选择层。
  - 仍需：真实 Claude/Codex/Pi SDK 请求层验证，证明未选工具不会进入最终模型上下文。

### 覆盖率复核

重新确认 `smokes-for.sh --uncovered` 当前剩余重点无覆盖入口：

- `src/main/index.ts`
- `src/main/lib/visionRelay.ts`
- `src/main/mcp/delegateHost.ts`
- `src/main/providers/claude-sdk/index.ts`
- `src/main/raw-imports.d.ts`

其中优先级：

1. `delegateHost.ts`：公网 MCP 委派权限边界。
2. `visionRelay.ts`：外部模型调用失败链和提示注入风险。
3. `index.ts`：启动、初始化失败、退出清理。

### 复审规则再次确认

- DEV_CLAIM 不自动转 REVIEW_PASSED。
- smoke 通过只证明对应覆盖范围，不代表完整产品闭环。
- 真实 SDK、真实公网、真实 Electron、人机交互验收保持 E3/U1 状态。
- 后续继续优先补高风险入口 smoke，而不是继续扩大功能范围。


## 2026-10-14 全量复审记录（代码+测试复核）

**复审范围**：Mcode 主项目全量架构台账对应代码路径，不新增重复 MC。依据当前工作区重新检查代码状态、回归入口和关键闭环。

**基线**：
- Git HEAD：`857b4d6278d1839eae139598d73d0471d31b8378`
- 工作区：无未提交修改。
- 唯一维护入口：`audit-ledgers/Mcode_统一审查台账.md`

**执行验证**：

1. TypeScript 主进程检查：
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`
- 结果：通过（无 TypeScript 输出错误）。

2. Smoke 回归：
- 尝试执行：`node apps/desktop/scripts/run-smokes.mjs --all`
- 结果：单次命令超过当前执行窗口，未获得完整结束码，因此不能标记全量 smoke 通过。
- 该结果记录为 E3 待证明，不作为失败。

3. 覆盖检查：
- `smokes-for.sh --uncovered` 入口当前环境因脚本依赖 `py` 命令不可用失败。
- 发现 Windows 环境存在 `python.exe`，但脚本固定调用 `py`，属于测试环境兼容问题，不判断为业务 MC。

**复审结论**：

### 已确认保持关闭/无需新增
- 工具发现入口：已有 `app_api_list/app_api_describe/app_api_call`，不新增 Discovery MC。
- Capability registry：已有声明/注册/预检分层，继续保持 MC-099 验收边界。
- Smoke 体系：已有大量无头回归，不存在需要重建测试框架的问题。
- 文档台账：状态规则正确，未发现错误自动关闭问题。

### 保持未关闭

1. MC-058 / ARC-002
- 状态保持：开发/复核均不变。
- 原因：仍缺完整 crash → restart → resume → verify 的端到端证据。

2. MC-059
- 状态保持：未独立复核。
- 原因：无人值守执行 UI 用户旅程尚未形成完整 E2E。

3. MC-091
- 状态保持：未关闭。
- 原因：异常恢复和补偿语义需要故障注入验证。

4. MC-100 / MC-101
- 状态保持：未关闭。
- 已确认基础设施存在：EffectiveToolInventory、ToolProfile、Discovery。
- 未证明：任务输入 → 最终 Provider SDK tools → 模型实际上下文 的完整链路。

5. 未覆盖入口：
- `src/main/index.ts`
- `src/main/lib/visionRelay.ts`
- `src/main/mcp/delegateHost.ts`
- `src/main/providers/claude-sdk/index.ts`

继续归入 ARC/已有 MC，不新增编号。

**状态更新原则**：
- 本轮没有任何条目获得 `REVIEW_PASSED`。
- 未撤销已有 DEV_CLAIM，因为未发现明确回归失败。
- 未将 typecheck/smoke 部分通过等价为整体验收。

**下一轮重点**：
1. 补 delegateHost 权限边界 smoke；
2. 补启动链 index smoke；
3. 对 MC-100/101 做真实 SDK 请求层工具可见性验证；
4. 对 ARC-002/MC-091 做故障注入恢复验证。

---

**2026-10-14 增量｜MC-100/101 真实 SDK 请求层工具可见性（wire 层，E2 源码调用链 + 真桩入参）**：

- 复核两轮反复点名同一缺口：「发现层/选择层纯函数通过了，但**没证明**各 SDK 在真实请求里照做」。本轮补上——不是靠读源码相信调用点接对了，而是**驱动真的 provider `startTurn`**、在 SDK 边界换桩截获**引擎真正收到的那份入参**。
- 三处接线**经核实已存在**（此前台账写的「`src` 里没有一处 `selectToolsForProfile` 调用」已过时）：`ClaudeAgentSdkProvider.ts:1644`（`options.tools` + `options.mcpServers` 收窄）、`CodexAgentSdkProvider.ts:306/501/520`（`dynamicTools` 过滤）、`PiAgentSdkProvider.ts:276/281`（`tools` 白名单），三者**都经同一份** `orchestration/toolSelection.ts`（硬规矩 2）。
- **修一处真缺陷**（`97217e20`）：`applyToolBudget` 的结果在 `profile = full` 时被三个适配器**短路丢掉** —— `EngineToolSelection` 新增 `budgetNarrowed`，`full` 画像 + 有预算也真收窄。这是典型「plumbed-but-ineffective」（字段接通、行为不生效）。
- **新证据**：`skill-delivery-smoke` 加深 §E（驱动真 `startTurn`，断言 `query({options})` 的 `tools`/`mcpServers`、`createAgentSession({tools})`、`thread/start({dynamicTools})` 随**画像与预算**真变化）：E1 Claude full 不设 tools / minimal 设白名单且 app server 恒留、E2 Pi full→undefined / minimal→数组、E3 Codex full/minimal 过滤、E4 research≠minimal、E5-E7 **full+预算**三引擎都真收窄。`skill-delivery-smoke 46/46`；`effective-tools-smoke 137/137`、`provider-context-smoke 56/56`、`engine-tools-smoke 51/51` 未破；双包 `tsc --noEmit` 0 错。
- **变异**：三处适配器各自撤掉 `budgetNarrowed` 判用 → E5/E6/E7 **真红**（逐项点名，含实际预算前后集合），逐字节 `cmp -s` 还原。
- **remaining（如实，不冒充到那一步）**：本段证的是「宿主交给 SDK 的入参」随画像/预算正确 —— **真二进制**（claude/codex/pi）读到这些入参后**自己**如何扫描/枚举/暴露、`KNOWN_BUILTIN_TOOLS` 是否为 SDK 权威枚举、Codex 闭源二进制对 `dynamicTools` 的解释，仍须 **U1 活会话**验收；token 估计仍是 4 字符/词粗估。**MC-100/101 保持开发空勾、复核空勾**。
