# T101｜Orca ↔ Mcode Git Diff / 代码审查 / 交付闭环源码对照

## 1. 结论摘要

本报告是固定源码基线上的只读静态研究，不是功能实现或产品端到端验收。

- Orca 基线：ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560（版本字符串 1.4.214）。
- Mcode 调查 HEAD：35904aa56d8190b4b3ee101c8e050156aab21e32。
- 工作区保护：调查开始时 Mcode 已有未提交修改：.aoci/baseline.json、.gitignore、apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts、apps/desktop/scripts/orchestration-ipc-smoke/run.sh、apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs、apps/desktop/src/main/appControl/apiCatalog.generated.ts、apps/desktop/src/main/ipc/settingsTransfer.ts，以及一条 Git status 输出中显示为 `?? ['dev` 的未跟踪路径（路径输出含换行/格式异常，未进一步操作）。全部保留，未修改、暂存或清理；Orca 工作区干净。
- 核心结论：Mcode 已有 staged/unstaged diff、提交历史/提交文件差异、每轮文件快照回退、worktree 合并回主 checkout 和 Agent API 权限闸门；但本次源码中未找到 Orca 式 branch-vs-base 文件差异入口，也未找到 Mcode 的逐行本地审查批注/批量反馈 Agent 闭环。不能把 Mcode 的“回退一轮”或提交历史 diff 视为逐行审查的等价实现。
- 矩阵结论计数：等价已有 1；部分已有 5；真缺失 2；证据不足 2；与定位冲突 0。
- E2 表示固定 SHA 的源码调用链静态证据；E3 表示仅有搜索/间接线索。本文未运行测试、build、Electron 或真实 Agent 回合；没有 E1/U1 结论。

## 2. 源码调用链

### 链 A：Orca 分支基线 diff 与 HEAD 漂移防护（E2）

1. Orca 的 use-branch-compare.ts 中 runBranchCompare 调用 getRuntimeGitBranchCompare(..., compareBaseRef)，按 worktree owner 路由。刷新请求带 requestKey；git-branch-compare-actions.ts 的 setGitBranchCompareResult 拒绝旧 request key，并在 status HEAD 已变化且结果不匹配时拒收结果。
2. runtime-git-diff-client.ts:getRuntimeGitBranchCompare → 主进程 git:branchCompare（main/ipc/filesystem/git-remote/compare-handlers.ts）→ git/status.ts:getBranchCompare → git/source-control/branch-compare.ts:getBranchCompare。
3. resolveWorktreeAddBaseRef（shared/worktree/base-ref.ts）对短 ref 做命名空间消歧：带斜杠的远端展示名先试 refs/remotes/<remote>/<branch>，再试 refs/heads/<name>；不带斜杠时先试本地 heads。readBranchCompareHead 解析 compare ref、base ref、HEAD OID；getBranchCompare 求 mergeBase，changed-file entries 来自 mergeBase..headOid，ahead/behind 来自 baseOid...headOid。
4. fetch-combined-diff-section.ts 把 baseOid/headOid/mergeBase 原样传给 getRuntimeGitBranchDiff；git:branchDiff handler 校验 worktree 和相对路径，再进入 getBranchDiff。branch-diff.ts 使用固定 mergeBase/headOid 的 git show <oid>:<path> 读取两侧内容，不在读每个文件时重新解析移动中的分支名。
5. CI 辅助脚本 orca/config/scripts/git-pull-request-diff-base.mjs 在 GitHub pull_request merge ref 至少有两个 parent 时选择 HEAD^1。

边界：readBranchCompareHead 对 compareRef/baseRef/HEAD OID 的读取不是 Git 原子快照；分支切换夹在这些读取之间时，符号分支标签与捕获 OID 存在竞态窗口。UI 的 request-key/status-HEAD 守卫能拒绝部分旧结果，但本轮未运行竞态测试，不声称已完全排除此窗口。

### 链 B：Orca 本地逐行审查意见 → worktree 持久化 → 批量送回 Agent（E2）

1. DiffViewer.tsx:handleCreateComment 接收 lineNumber/startLine/body，调用 addDiffComment，传入 worktreeId、相对 filePath、source='diff'、行号和正文。
2. store/slices/diffComments.ts:createDiffCommentsSlice.addDiffComment 生成 id/时间并更新状态，随后 enqueueDiffCommentPersist 串行化同 worktree 写入。diff-comment-host-write.ts:writeDiffCommentsToHost 按 workspace owner 写入本地 worktrees.updateMeta、远程 worktree.set，或 folder workspace 更新接口；持久化失败会返回失败。
3. DiffNotesSendMenu.tsx 选择当前文件或全部未发送 notes；NotesSendMenu.tsx 将格式化后的批次 prompt 交给已有 Agent send-target UI。clearDeliveredDiffComments 只清掉与已发送快照仍一致的 note，发送期间修改过的 note 会保留。
4. 但本地 note 的锚点语义比文档描述弱：diff-comment-types.ts 虽声明可选的 scope、oldPath、diffIdentity，DiffViewer.tsx 创建 note 时并不填这些字段；useDiffCommentDecorator.tsx 只按 filePath + worktreeId 过滤，并把卡片放在固定的 c.lineNumber。在本次检索范围中，diffIdentity 只有类型声明，没有找到用于计算、校验、过期标记或重锚的消费者。

### 链 C：Orca PR 逐行评论 → commit SHA 关联 → 过期评论过滤（E2）

1. pull-request-page/files/combined-diff-viewer.tsx 的 entrySignature 纳入 repoId/prNumber/prRepo/sourceScope/headSha/baseSha/files；签名变化会递增 generation、丢弃旧 section load 状态。
2. section-loader.ts 以 headSha/baseSha 请求 PR 文件内容，缺 SHA 时显式显示 diff unavailable；line-comment.ts:addPullRequestLineComment 没有 headSha 就拒绝创建评论，调用 GitHub 评论接口时将 commitId=headSha、path 和 line range 一起提交。
3. inline-comments.ts:buildInlineReviewComments 对 isOutdated、无 path、无有效 line 的评论不做 inline 装饰，避免旧行号贴到当前无关代码上。
4. PR hosted review 与本地 AI note 是两条不同路径：PR 评论有明确 head/base SHA 上下文和 outdated gate；本地 AI note 没有同等内容身份绑定。

### 链 D：Mcode 工作区 diff / 提交历史 diff（E2）

1. GitDiffDialog.tsx:refreshStatus 调 api.git.status，以请求序号阻止切仓后的旧状态覆盖新状态；打开工作区文件时调用 api.git.diff({ repoPath, filePath, staged })，tab id 是绝对路径加 staged/work。
2. apps/desktop/src/main/ipc/git.ts 的 IPC.GIT_DIFF 通过 GitDiffSchema 校验后执行：staged 用 git diff --cached -- <path>（index vs HEAD），unstaged 用 git diff -- <path>（working tree vs index）。GitStatusResult.files 同时包含 staged、unstaged 和 untracked 状态。
3. GitDiffDialog.tsx:parsePatchToBeforeAfter 只解析 unified-diff hunk 的 + / - / context 行。未跟踪文件通常没有 git diff patch；该 UI 会把 after 留空，FileEditor.tsx:DiffPane 在 after 未提供时读取工作区文件，所以未跟踪文本文件仍可显示为“空旧侧 vs 磁盘新侧”。
4. 二进制文件没有 Orca 式 kind='binary' / MIME / 图片对照分支：Mcode 的工作区 patch parser 找不到文本 hunk 时会产出空 before/after；GitHistoryView.tsx:openFile 也注释了两侧都空通常意味着 binary/missing，并仍然打开空面板。
5. GitHistoryView.tsx:openCommit → api.git.showCommit → GitHistoryView.tsx:openFile → api.git.showFile；主进程 git.ts:git:showFile 用 showBlob(commitHash, path) 和 showBlob(commitHash + '^', oldPath) 得到提交前后内容。该路径以具体 commit hash 为锚，并有请求序号保护。

过期工作区 diff 风险（静态）：GitDiffDialog.tsx:openWorkingFile 的 tab id 不含 HEAD/index/文件内容身份；同 id tab 已存在时直接 setActive(tabId) 并返回，不重新请求 diff。文件在 tab 打开后继续改变，再次点击已开 tab 不会经这段函数刷新其捕获内容。

### 链 E：Mcode 每轮文件快照 / 回退与 worktree merge-back（E2）

1. apps/desktop/src/main/lib/fileSnapshot.ts:FileSnapshot.recordPre/freeze 捕获每轮文件修改前内容、轮末 afterHash 与 diff 计数；RuntimeManager.rewindTurn 以 restoreFiles(cwd, files) 回退。
2. restoreFiles 重新校验路径必须位于 cwd、拒绝重复目标；有 afterHash 时将当前文件字节与轮末 hash 比较，后续修改不被覆盖并列为 conflict；当前内容已经等于 before 时按幂等成功处理；旧快照无 hash 时保守拒绝自动回退。这是文件级恢复保护，不是 Git 分支 diff 或逐行审查批注。
3. WorktreeMergeBackParts.tsx:handleMerge 调 api.git.worktreeMergeBack；此前通过 worktreeList/mergePreview 读取预览。apps/desktop/src/main/ipc/git.ts 检查 repoPath 属于已添加项目，再进入 worktreeOps.ts:mergeBackWorktree。dirty 时 commitAll(wtGit, message) 自动提交，然后将 worktree HEAD 合并进主 checkout，并检查冲突与 HEAD 是否真的变化。
4. Agent API 权限：appControl/policy.ts 将 git.push、git.merge、git.worktreeMergeBack 放在 DANGER；policyEngine.ts 对 danger 要求用户本人每次新鲜批准。git.commit 是 write 档：gateAppAction 默认走用户审批，但在用户显式配置的 bypass permission mode / always-allowed grant 下可以不再逐次弹卡。因此，不能说 commit 与 push/merge 都是“每次新鲜确认”。
5. 安全边界：worktreeOps.ts:mergeBackWorktree 的 worktree 所属关系探测是 ownerGit.raw(['worktree','list','--porcelain']).then(...).catch(() => true)。如果所有权探测失败，代码把 ownsWorktree 当作 true 继续，随后可能对调用方传入的 worktreePath 执行 dirty probe / auto-commit。IPC 的 repoPath 有项目 containment guard，但 worktree 路径刻意位于项目 root 外；此 catch 的 fail-open 是静态风险，和审查台账的 fail-closed 原则相冲突。本轮未动态复现，未修改产品代码。

## 3. 能力对照矩阵

| 能力 | 分类 / 证据 | Orca 源码证据 | Mcode 源码证据与结论 |
|---|---|---|---|
| 以 start-from/base ref 为基线的 changed-files / branch diff | **真缺失（E2）** | use-branch-compare.ts → git:branchCompare → getBranchCompare，随后 git:branchDiff 读取固定 mergeBase/head OID。 | GitDiffDialog.tsx 只有 staged/unstaged 列表与 api.git.diff；git.ts 的 mergePreview 只统计 HEAD...source 的提交数。检索 apps/desktop/src 的 branchCompare/branchDiff 没有对应入口。 |
| staged / unstaged / untracked 的文本差异 | **部分已有（E2）** | source-control/file-diff.ts:getDiff 选择 HEAD/index/worktree 两侧，status-read.ts:getStatus 解析 staged/unstaged/untracked；combined view 可混合未提交和 branch entries。 | GitDiffDialog.tsx + git.ts:IPC.GIT_STATUS/GIT_DIFF 已区分 staged/unstaged，untracked 行也出现在列表；未跟踪新侧由 DiffPane 读取磁盘。没有统一 branch+uncommitted combined review 基线。 |
| 二进制、图片与大 diff | **部分已有（E2）** | git-blob-read.ts 做二进制检测和可预览 MIME base64；diff-result.ts:buildDiffResult 返回 binary/MIME 或 large-diff limit 元数据；PR section loader 显式识别 binary。 | GitDiffDialog.tsx:parsePatchToBeforeAfter 是文本 hunk parser；提交历史代码说明 binary/missing 时两侧可为空。未找到等价图片差异/MIME 预览与大 diff 元数据链。 |
| 指定提交的文件差异 | **等价已有（E2）** | getCommitCompare / getCommitDiff 固定 commitOid/parentOid，并由 git:commitCompare/commitDiff handler 校验完整 object ID 与相对路径。 | GitHistoryView.tsx:openCommit/openFile → git.ts:git:showCommit/showFile，对比 commit 与 parent blob，并以请求序号保护旧响应。 |
| 本地逐行批注并批量送回 Agent | **真缺失（E2 + E3 搜索）** | DiffViewer.tsx → addDiffComment → diffComments store/host write → DiffNotesSendMenu/NotesSendMenu 批量形成 Agent prompt。 | 在 apps/desktop/src 搜索 DiffComment/diffComment/review note/inline comment 未找到相应模型或 UI。已有 per-turn 文件回退，不是逐行反馈闭环。 |
| PR 行评论的 commit-SHA 关联、过期评论处理 | **证据不足（E3，Mcode 范围）** | Orca PR 路径为 E2：combined-diff-viewer.tsx 的 signature 包含 head/base SHA；line-comment.ts 将 headSha 作为 commitId；inline-comments.ts 隐藏 outdated 线程。 | 在 apps/desktop/src 检索 PR viewer、PR review comment API 与 pullRequest/reviewComment 未找到相应路径；Mcode 有 commit 历史差异，但没有本次可定位的 hosted PR inline review 链。 |
| 本地审查 note 的内容身份、过期与跨 diff/worktree 隔离 | **部分已有（E2）** | worktreeId 能隔离 workspace；PR hosted comments 有 head/base SHA 与 outdated gate。但本地 note 创建不写 scope/diffIdentity，装饰器只按 worktreeId/filePath，并按固定 lineNumber 放置。 | GitHistory commit diff 使用 commit hash，状态/打开请求有序号守卫；工作区 diff tab key 只有绝对路径 + staged/work，不含 HEAD/index/内容 hash，重复打开已存在 tab 直接激活。请求防旧回包不等于内容 SHA 绑定。 |
| 每轮 Agent 修改的文件快照与安全回退 | **部分已有（E2）** | 本次 Orca Git diff 链固定提交 OID、捕获 entries，但未找到与 Mcode turn rewind 同语义的 before + afterHash 文件级回退链。 | FileSnapshot.freeze + RuntimeManager.rewindTurn + restoreFiles 已支持历史回退、path guard、hash conflict 与幂等重试；但它不提供 Git branch review/批注或 PR 关联。 |
| 文件行级 AI / 人类归属 | **证据不足（E3）** | docs/site/content/docs/review/attribution.mdx 描述 per-line provenance，但在本次固定 SHA 的 diff/git 相关源码与文件名搜索中，未定位到“记录写入来源范围 → 持久化 → diff 行渲染”调用链。文档不能替代实现证据。 | 在 apps/desktop/src 的 attribution / AI-origin / line-origin 相关检索未找到 diff 行级 authorship 模型。session/turn 文件列表是文件级修改记录，不等于每行归属。 |
| 提交、合并、推送与用户审批 | **部分已有（E2）** | Orca 有显式 stage/commit/push/PR 流程与 push/force-push 单独动作；本轮未对 Orca 每条操作执行动态审批验证。 | Mcode UI 有明确的 commit/push/merge/merge-back 操作；Agent API 中 push/merge/worktreeMergeBack 是 danger、每次要用户本人批准，commit 是 write 且可使用用户显式设置的持久授权。另有 merge-back 所属关系探测 fail-open 风险。 |

## 4. 三条关键异常 / 权限 / 恢复边界（静态风险，不是已复现红例）

### 风险 1：本地审查 note 可能在 diff 变化后指向错误行

- 证据：DiffViewer.tsx:handleCreateComment 未填 scope/diffIdentity；useDiffCommentDecorator.tsx 只按 filePath + worktreeId 过滤，并使用 c.lineNumber；DiffComment.diffIdentity 只在类型中声明，没找到运行时消费者。
- 静态反例设计：在文件第 40 行新增 note；Agent 在同一文件顶部插入 15 行并再次打开 diff；原 note 的行号仍是 40，装饰器没有按 SHA 或上下文重新定位/标 stale 的路径，可能贴到另一段代码。本轮未运行测试，不能说已复现。
- 修复方向：先引入由实际 diff 两侧 OID 或内容指纹构成的 diff identity；note 明确带 scope 与身份。身份变化时做受约束的上下文重锚，不能唯一匹配则显示 stale 并要求用户确认，不静默把旧意见套到新行。

### 风险 2：Mcode merge-back 的 worktree 所属关系探测失败时 fail-open

- 证据：apps/desktop/src/main/lib/worktreeOps.ts:mergeBackWorktree 在 ownerGit.raw(['worktree','list','--porcelain']) 的 catch 中返回 true；后续 worktreeDirty(wtGit) 与 commitAll(wtGit, message) 使用传入的 worktreePath。IPC 的 repoPath 有项目 containment guard，但 worktree 本来位于项目 root 外，所有权 probe 是关键围栏。
- 静态反例设计：传入已受项目保护的 repoPath 和一个非其注册 worktree 的外部 Git 目录；让主仓库 git worktree list 失败；catch 将该目录视为拥有，若该目录 dirty 就可能 auto-commit 其中文件。没有执行该输入，也未触碰真实目录。
- 修复方向：所有权 probe 失败必须返回明确错误并 fail-closed；区分“确认不属于本仓库”和“无法验证”；在通过 ownership proof 之前不得创建 wtGit 后执行写操作。为此另立最小实现任务，覆盖主进程 IPC 与 Agent API 同一函数。

### 风险 3：Orca branch diff 的 blob 读取失败可能降级成空差异

- 证据：git-blob-read.ts:readGitBlobAtOidPath 对非“确知缺失”的错误会设置 failed: true；但 branch-diff.ts:loadBranchDiff 只取 leftBlob.content/rightBlob.content 调 buildDiffResult，没有检查两侧的 failed，而最外层 catch 也返回空 text diff。
- 静态反例设计：分支 compare 已得到 entries，随后在读取某一侧 OID blob 时触发非缺失读失败；返回内容为空且无 error metadata，UI 可能将其呈现为真实空差异。本轮未运行测试，不能称为已复现。
- 修复方向：把“真实新增/删除的已证明缺失”与“读取失败”在 branch diff 结果中区分；读取失败应返回显式 error/不可用状态并提供 retry，不能只靠空字符串表示。

## 5. Top 2 借鉴点 + 1 个不应照搬的设计

### Top 1｜借鉴 Orca 的固定 OID compare snapshot 与旧请求守卫

- 方案：在 Mcode 现有 Git IPC/contract 中增加最小 branch-vs-base read path：先确定 baseOid/headOid/mergeBase，再用固定 OID 读取 entries 和 per-file blobs；共享 request identity 至少包含 repo/worktree identity、baseOid、headOid 和路径。不要另造 Git 子系统，也不要把 branch diff 混进现有 git.diff 的 staged/unstaged 语义。
- 复杂度：**M**。
- 影响：packages/contracts + 现有 apps/desktop/src/main/ipc/git.ts + Git UI/History 的薄入口；read-only 能力应进入现有 app_api_list → app_api_describe → app_api_call 和统一审批/Provider 路由。读取差异仍是 read 权限，不把 commit/push/merge 塞进读取链。
- 建议完整回归门（本轮不运行）：两个不同 base refs、同名 local/remote ref、HEAD 在 compare 期间变化、旧响应晚到、rename oldPath、unborn/no-merge-base、untracked 与 staged/unstaged 混合、二进制/大文件/读失败、local/remote worktree owner 路由。

### Top 2｜借鉴“逐行批注 → 单批反馈”的用户旅程，不复制存储层

- 方案：用 Mcode 现有通用状态与 Provider/send 能力设计可复用 review-note contract：repo/worktree owner、filePath、scope、base/head 或 commit identity、行号、可选 selected text/context fingerprint、正文与 stale 状态。先做纯本地持久化与单次批量送入当前 Agent；后续再接 commit/PR 上下文。跨 Provider 仍走现有统一发送入口，不新增 agent loop。
- 复杂度：**L**（契约/存储、diff UI、跨 worktree 路由、Agent 反馈与状态恢复都需要一致性）。
- 影响：共享 contract、Git diff UI、当前 session/worktree owner 解析与 Agent send path；写 review note 与发送 prompt 的权限需按现有 policy 明确分类。批注保存/发送不能隐式触发 commit、merge 或 push。
- 建议完整回归门（本轮不运行）：不同 worktree 同路径互不串注、staged 与 unstaged 分区、插行/删除/rename 后 stale 与重锚、用户编辑 note 时异步发送完成、写盘失败回滚、远程 host 不可达、跨 Provider 发送、关闭/重开后恢复、无 SHA 或冲突 SHA 时 fail-closed。

### 不应照搬｜不要原样移植 Orca 本地 DiffComment 模型并假定它已具备 SHA-safe re-anchor

- 源码依据：DiffComment 有可选 diffIdentity/scope，但本地创建路径不填；useDiffCommentDecorator 按固定 lineNumber 展示；未找到 identity 计算/比较消费者。该实现可借鉴交互形态，但不能把其字段声明或文档文案当成可直接复用的安全锚定协议。
- 原因：直接复制会把“可选但未生效”的字段和行号漂移风险一起带入 Mcode；也会新增一套与现有 Git IPC、session file snapshots 和 Provider 路由平行的状态面。
- 更安全做法：先定义并测试内容身份/过期语义，再把批注接入 Mcode 现有的共享契约、存储与 Agent 发送入口。orca/LICENSE 为参考许可，不代表其全部依赖和内嵌资源均可直接复制；本任务没有复制任何 Orca 代码或资源。

## 6. 验证记录与剩余事项

| 命令 / 检查 | 结果 |
|---|---|
| git rev-parse HEAD | PASS，35904aa56d8190b4b3ee101c8e050156aab21e32 |
| git status --short --untracked-files=all | PASS，记录并保留上述既有 dirty 文件/未跟踪路径 |
| git -C orca rev-parse HEAD | PASS，ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560 |
| git -C orca status --short --untracked-files=all | PASS，输出为空；未改动 Orca |
| git -C orca describe --tags --always | PASS，ea60ec5d |
| 源码路径/符号搜索及只读读取 | PASS，完成本文列出的静态定位；apps/desktop/src/main/ipc/gitHistory.ts 线索实际不存在，历史 handler 位于 apps/desktop/src/main/ipc/git.ts:965-1000 |
| 测试 / build / Electron / U1 | **未运行（按只读任务边界）**；不宣称 E1/U1 PASS |

### 剩余风险

1. 本地 review-note SHA 绑定与 stale/re-anchor 尚未实现或无法由当前源码证明；这是建议后续单独实现的核心差距。
2. Mcode merge-back ownership probe fail-open 是静态高风险点，应单独立最小安全修复任务；本 T101 不修改产品代码。
3. Orca branch diff read failure 是否有上层 UI 的补偿提示未动态验证；当前函数返回值不足以在该路径显式区分读失败。
4. 行级 AI/human attribution 在 Orca 文档中有描述，但当前固定 SHA 的源调用链未定位到；本报告将其保留为 E3，不把文档宣称算作实现通过。
5. 本次不跑测试、不启动应用、不触碰用户数据库/远端；后续 PoC 必须用虚构 repo/isolated worktree 和假 Provider 完成测试门，再安排真实用户旅程验收。

## 7. 证据索引（固定基线可复核）

- Orca branch compare：orca/src/renderer/src/components/right-sidebar/source-control/sync/use-branch-compare.ts；orca/src/renderer/src/runtime/runtime-git-diff-client.ts；orca/src/main/ipc/filesystem/git-remote/compare-handlers.ts；orca/src/main/git/source-control/branch-compare.ts；orca/src/shared/worktree/base-ref.ts；orca/src/shared/git-branch-compare-head.ts。
- Orca branch/commit file diff：orca/src/renderer/src/components/editor/combined-diff/load-sections/fetch-combined-diff-section.ts；orca/src/main/ipc/filesystem/filesystem-git-diff-handlers.ts；orca/src/main/git/source-control/branch-diff.ts；orca/src/main/git/source-control/commit-compare.ts；orca/src/main/git/source-control/commit-diff.ts；orca/src/main/git/source-control/file-diff.ts；orca/src/main/git/source-control/git-blob-read.ts；orca/src/main/git/source-control/diff-result.ts。
- Orca local notes / persistence / delivery：orca/src/renderer/src/components/editor/DiffViewer.tsx；orca/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx；orca/src/shared/diff-comment-types.ts；orca/src/renderer/src/store/slices/diffComments.ts；orca/src/renderer/src/store/slices/diff-comment-persistence.ts；orca/src/renderer/src/store/slices/diff-comment-host-write.ts；orca/src/renderer/src/components/editor/DiffNotesSendMenu.tsx；orca/src/renderer/src/components/editor/NotesSendMenu.tsx。
- Orca PR review / docs：orca/src/renderer/src/components/pull-request-page/files/combined-diff-viewer.tsx；orca/src/renderer/src/components/pull-request-page/files/section-loader.ts；orca/src/renderer/src/components/pull-request-page/files/line-comment.ts；orca/src/renderer/src/components/pull-request-page/files/inline-comments.ts；orca/config/scripts/git-pull-request-diff-base.mjs；orca/docs/site/content/docs/review/diff-viewer.mdx；orca/docs/site/content/docs/review/annotate-ai-diff.mdx；orca/docs/site/content/docs/review/commit-push.mdx；orca/docs/site/content/docs/review/attribution.mdx。
- Mcode Git / history / diff：apps/desktop/src/renderer/components/ide/GitDiffDialog.tsx；apps/desktop/src/renderer/components/ide/FileEditor.tsx:DiffPane；apps/desktop/src/renderer/components/ide/GitHistoryView.tsx；apps/desktop/src/main/ipc/git.ts；packages/contracts/src/ipc/git.ts。
- Mcode snapshots / merge / approval：apps/desktop/src/main/lib/fileSnapshot.ts；apps/desktop/src/main/claude/RuntimeManager.ts:rewindTurn；apps/desktop/src/main/lib/worktreeOps.ts:mergeBackWorktree；apps/desktop/src/renderer/components/chat/WorktreeMergeBackParts.tsx；apps/desktop/src/main/appControl/policy.ts；apps/desktop/src/main/appControl/policyEngine.ts；apps/desktop/src/main/appControl/tools.ts:gateAppAction。
