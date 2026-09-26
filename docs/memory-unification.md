# MCode 统一记忆：实现与维护约定

## 事实源与作用域

- `<dataRoot>/memory/global/<category>/<file>.md`：用户明确指定的跨项目共享记录。
- `<dataRoot>/memory/projects/<projectId>/<category>/<file>.md`：指定项目的记录。
- 原 `<category>/<file>.md`：未分类旧记录，管理界面保留可见；不会自动注入模型，必须由用户确认归属后导入。
- `<dataRoot>/context/instructions.md`：三引擎共用的全局指令事实源。
- 类目保持 rules / project / preferences / experiences / failures / decisions。

## 引擎接线

`memoryMcpTools` 是五个工具的唯一描述/实现表；`engineTools.ts` 生成中立描述并完成 zod 校验及写入审批。Claude 的 SDK MCP handler、Codex dynamic tools、Pi extension 都经过同一个调用入口。写/删必须有审批桥且获得允许；读操作仍要求有效的宿主会话。

作用域从 `SessionRepo` 取得，模型传入 `projectId` 不能授权。读/写/删均限制为本项目或显式全局，不向模型开放历史和迁移管理接口。

- 主聊天逐轮按项目和当前请求检索；子对话继续遵守创建时的“带记忆”选择与一次性快照；工作流通过绑定宿主会话的 `RunPorts.memorySnapshot` 取值，未提供回调时不注入。
- 快照组合置顶、相关与最近记录，去重并受总长度限制，带来源路径和 revision。
- 项目指令由宿主在已知项目根到 cwd 范围编译；每目录优先 `AGENTS.md`，没有时回退 `CLAUDE.md`。不解析外部导入，不扫描父目录/home，不跟随符号链接。越界 cwd 仅使用项目根，不猜测外部 worktree 归属。
- Claude 保留 `settingSources=["user"]` 并设置官方 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`；每轮修复全局指令托管输出。
- Pi 使用 0.83.0 已支持的 `noContextFiles: true`，避免第二套上下文发现。
- Codex 设置 `project_doc_max_bytes=0`，将原有宿主 identity、全局指令与本轮上下文一起放入 developerInstructions；start/resume 都携带共享工具描述。

这些接线不等于操作系统沙箱。拥有普通文件/命令工具权限的模型，仍受各引擎既有文件权限控制。

## 并发、留档和恢复

- revision 为完整原始 Markdown 的 SHA256。
- 新建不能覆盖已有文件；更新/删除必须匹配读到的版本。
- 更新/删除前写 `.history` 私有 JSON 归档，归档失败则不修改当前文件。
- 恢复保留归档原始字节，只能恢复到不存在的原路径，不覆盖当前记录。
- 历史面板显示最近 200 条；当前不自动清理旧归档。
- 这是同一宿主进程内的冲突保护，不宣称跨进程 CAS、fsync 或停电原子性；外部编辑器在检查与发布之间仍存在竞争窗口。

## 迁移管理

`memory.manage` 通过共享契约、IPC、preload 接到管理界面，不是模型工具。

- 来源仅扫描未分类 MCode 记录及 `~/.mcode/projects/*/memory/*.md`、`~/.claude/projects/*/memory/*.md` 的安全普通文件。
- 原生目录扫描设数量及单文件 512 KiB 上限，不递归进入链接；不推断 slug 的项目归属。
- 用户预览完整原文与摘要，选择项目或显式全局，再次确认。
- 提交重验来源摘要；重复导入拒绝覆盖，永不删除/移动来源；导入正文记录来源、摘要、时间。
- 历史恢复也重验预览摘要。
- 原生 `MEMORY.md` 旧编辑区改为只读；统一库提供作用域选择、置顶和恢复。
- Codex/Pi 非标准私有目录、原生全局指令文件不被猜测性批量迁移。项目 AGENTS.md/CLAUDE.md 是只读兼容输入，不会被搬走或改写。

## 验证命令

从 `apps/desktop` 运行：

```text
node scripts/run-smokes.mjs memory-smoke memory-review-smoke memory-codex-smoke session-subchat-smoke provider-context-smoke ipc-parity-smoke ipc-wiring-smoke mcode-admin-smoke context-files-smoke
```

从仓库根运行 contracts 与 desktop 的 `tsc --noEmit --incremental false`。使用隔离临时数据/测试桩，无真实模型调用。真实 SDK MCP 工具表与 handler 通过无模型会话的测试连接验证；桌面点击、真实 Codex/Pi 会话及旧会话恢复仍需单独端到端验收，不能用无头测试代替。

## 原生配置依据

- Claude 官方 memory 文档：https://code.claude.com/docs/en/memory
- Codex AGENTS 发现与 byte budget：https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Pi 0.83.0 ResourceLoader 类型：https://unpkg.com/@earendil-works/pi-coding-agent@0.83.0/dist/core/resource-loader.d.ts

## 本轮无头验收结果

9 个套件通过，合计 813/813：memory 167、review 26、memory-codex 160、session-subchat 66、provider-context 35、ipc-parity 13、ipc-wiring 38、mcode-admin 248、context-files 60。contracts 与 desktop 类型检查均退出 0；相关路径的 git diff --check 退出 0。此结果不包含真实模型/桌面点击端到端验收。


## 分层与工作流整合

在上述统一服务基础上，后续新增了工作流注入所有权、可撤销的子对话启动快照、宿主写入来源，以及三个手动记忆工作流。分层职责、使用入口、限制与本轮验证见 [分层记忆与手动工作流](memory-layer-workflows.md)。上文 813 项为前一阶段验收，不能代替后续改动的验证。


主页面一键整理及临时对话交接的当前使用方式，见 [记忆助手与临时交接](memory-assistant-handoff.md)。长期库与临时包分离；临时包成功接续后不再投递。
