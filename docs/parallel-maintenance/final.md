# MAINT-2026-09 · 最终交付（final）

生成：2026-09-27 · Arena/MAINT-REVERIFY-9ec50b（M38）

> 注意：本文件原 §1–§5 是修复前的历史冻结记录；2026-09-27 后续 P1 修复改变了候选，不能将旧 151/151 当作现状。现状是文末 §7 的 **155/155**。

## 1. 冻结候选（历史，非当前候选）
- 基线 HEAD：`5937eaf05fd3a91a8bc12d590f69e213e8666b64`（`fix(maint): land B-group M28 and M31`）。
- 候选 = HEAD + 工作树未提交改动（17 文件 +74/−22，另 6 个新增目录/文件），完整清单与 SHA-256 manifest：`apps/desktop/.tmp/m38-candidate-20260927223844/`。
- 全量运行期间 manifest 漂移 0。

## 2. 原冻结门禁结果（修复前历史证据）
| 门禁 | 结果 |
|---|---|
| `run-smokes.mjs --all`（动态发现 151 套） | **151 pass / 0 fail**，`smoke-runs/1790519925874-31876-RVU4qC` |
| `tsc --noEmit -p apps/desktop/tsconfig.json` | 0 |
| `tsc --noEmit -p packages/contracts/tsconfig.json` | 0 |
| `git diff --check` | 0 |
| `node --test scripts/run-smokes.test.mjs` | 10/10 |

## 3. 计划完成度
- M01～M38 共 38 行，**全部 `已完成`**；38 份报告齐全。
- P0（均已修并有红→绿）：M10 `git:worktreeRemove` 任意目录递归删除；M13 插件清单 version 用作目录名；M18 内核安装 version 用作目录名；M21 提权执行用户可写目录脚本。（M08 表内 `P0svXJ` 为临时目录名，非缺陷。）
- 本次维护期间的主要横向修复：库文件导入/删除/打开围栏（M33–M35 + 跨任务收尾）、工作流续跑/重试竞态与启动失败可见性（M28 + AUDIT FIX-4）、IPC 契约零字面量（M36）、词典运行期对账（M37）、AUDIT 六项回访修复（MinerU itemId 越界、`git add --`、MCP 待授权徽章、提问 Deferred 悬空等）。

### 原冻结候选的遗留风险（勘误：原表漏列前两项）
| 项 | 来源 | 需要 |
|---|---|---|
| 通用路径闸仅词法判断，symlink/junction 可指向根外 | M07/M31 | 共享闸对真实路径及未存在子路径的最近祖先作围栏；2026-09-27 接管修复 |
| relay SSH 未核验 VPS 主机密钥 | M15 | 可信 SHA256 指纹固定与旧配置失败关闭；2026-09-27 接管修复 |
| McpPanel 编辑时 headers/env（可能含密钥）明文回显 | M26 | 主进程读取脱敏与保留密钥编辑协议；2026-09-27 接管修复 |
| 工作流跨写者覆盖（无版本闸） | OBS-M30-02 | `library.ts` 权威版本闸 + UI 冲突提示；2026-09-27 接管修复 |
| AppearancePanel 主题切换失败无提示 | OBS-M25-01 | M25 域组件 + 新词条 |
| 目录条目内子 PDF 外部打开需 `relPath` 契约 | M33/M35 收尾 | `LibraryOpenFileSchema` 契约变更 |
| `ipc/dialog.ts` 仍以字面量注册 `dialog:pickFolder`（值一致，功能正常） | M36 | 改用 `IPC.DIALOG_PICK_FOLDER` |
| `settings.skills.groupDeleteKeepPlugin` 为死键 | M37 | 域所有者决定删或接线 |

## 4. 明确未验证
- 真实模型 / 收费 API；真实用户数据库与数据根；正式安装包、签名与自动更新；主应用 Electron 实机全面板与真实 FileTree/WebContentsView；真实三引擎；手机端真机。
- 所有结论仅基于仓库内无头/隔离 Electron 自动化套件与静态检查。

## 5. Git 状态
- 本计划期间提交：`cb799ce`（A 组复验）、`dd8acea`（P2 收尾 + M22 + C 组）、`5937eaf`（M28/M31）以及其他对话的 `2dd1726`、`ed824fd`、`c4a3e6f`。
- 当前候选中的未提交改动（M36/M37/M38 + AUDIT）**未提交、未推送**，等待用户指令。

## 6. 接管后的验收（2026-09-27）
- 四项新套件修复前红灯中，路径闸为行为断言失败，另外三项为新模块尚不存在的构建失败（不能称旧逻辑行为红灯）。新定向运行：`node apps/desktop/scripts/run-smokes.mjs maint-p1-path-smoke maint-p1-relay-smoke maint-p1-mcp-smoke maint-p1-workflow-smoke`，exit 0、4/4，日志 `smoke-runs/1790523606669-46196-SFr8f7`。双包 tsc 0、`git diff --check` 0。
- 原有七套定向初跑 5/7：`maint-m07/m15/m26/m30` 与 `workflow-ui-smoke` 通过；`path-guard-smoke` 的虚拟离线 UNC 可通行旧断言与失败关闭策略冲突；`mcp-ipc-smoke` 发送旧版无 origin 的导入入参而与主进程重新解析来源的新协议冲突。未修改旧断言，不能称全绿。
- 用户随后额外授权仅更新上述两套过时断言／夹具：UNC 不可达应拒绝；MCP 扫描不得向 renderer 发送密钥，主进程导入按来源查真配置。显式提交 config 的旧导入兼容保留（与 `mcp.save` 相同的写入能力），不恢复扫描明文。重新定向 11/11、exit 0，`smoke-runs/1790524225214-32224-q6mkcO`。此条取代上条的当前状态；上条仅是首轮红灯证据。
- workflow MCP 写者也须携带 `workflow_get` 返回的完整文档版本才能覆盖已有图；后台自动化内部保存同样携带版本，避免其旧快照晚到。新候选在 `apps/desktop/.tmp/p1-candidate-20260927/` 冻结源码／契约／脚本 1543 文件 SHA256 清单，待全量完成复核漂移。
- **边界声明**：路径闸以真实路径／最近存在祖先作操作前检查，防止静态 symlink/junction 越界；同权限本地进程在检查与文件操作之间替换链接的 TOCTOU 竞态尚未以目录句柄 API 消除。MCP 此轮专门脱敏 env/header 值；若用户把密钥嵌入 URL、命令行参数或自定义 passthrough 字段，仍可能进入面板配置／摘要，需后续另设计通用敏感字段协议。真实 VPS 指纹核验、真实系统权限竞争与 Electron 实机 UI 未测试。
- **修复后首轮全量为 152/155、exit 1**（`smoke-runs/1790524610716-24696-NGfaxi`）：M31、relay、orchestration IPC 三套旧预期不兼容。经用户追加授权，M31 将 symlink→私有数据改为通用闸拒绝；relay 使用假 VPS 真 host public key 生成指纹并验证缺失／错误 pin 被拒绝，同时主进程坏输入不再假报成功；orchestration IPC 带保存版本并补测陈旧覆盖拒绝。适配后定向 9/9、exit 0，`smoke-runs/1790526416461-33540-luYhsa`。第二轮全量以重新冻结的候选运行中，**未完成前不能称 155/155**。

## 7. 修复后最终门禁（新候选）
| 门禁 | 结果 |
|---|---|
| `node apps/desktop/scripts/run-smokes.mjs --all` | **exit 0，155/155**，`smoke-runs/1790526470536-43036-2Dpv4W` |
| 双包 `tsc --noEmit` | contracts 0；desktop 0 |
| `node --test apps/desktop/scripts/run-smokes.test.mjs` | exit 0，10/10 |
| `git diff --check` | exit 0（CRLF 提示不构成失败） |
| 源码／契约／脚本冻结校验 | 1543 文件 SHA256 manifest 前后漂移 **0**；status 漂移 0；暂存区 0 |

证据目录：`apps/desktop/.tmp/p1-candidate-20260927/`；基线 HEAD 仍为 `5937eaf05fd3a91a8bc12d590f69e213e8666b64`。本次未用真实用户数据、真实模型或真实 VPS，亦未对打包签名／实机面板做验收。**未提交、未推送**；原有 AUDIT / M36 / M37 等他人未提交改动保持原样，不暗中清理或归功。
- M36 旧套件断言核查：`ipc-wiring-smoke` 从允许 1 条裸 invoke 收紧为 0；`dialog-shell-smoke`/`memory-codex-smoke` 从要求裸 `dialog:pickFolder` 改为要求契约常量且通道值不变/无裸通道。改动属 M36 原对话所为且不在编号写集；本轮仅复核，不回退、不冒充原写集内改动。
- 后续全量回归仍需根据新候选结果据实填入；在这之前，§2 的 151/151 严格只代表历史候选。没有真实 VPS/用户数据库/生产模型测试；未提交、未推送。
