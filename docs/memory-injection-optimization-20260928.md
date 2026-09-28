# 记忆检索与注入可见性优化 / 2026-09-28

## 状态
READY_FOR_INTEGRATION：本任务源码优化与定向无头/浏览器夹具回归完成；安装版与真实模型全量集成未验收。

承接对话：Arena / MEMORY-OPTIMIZE-6d496c。
开始 HEAD：`5bd1a30a3209161c370145c416989a733d5a1bac`。用户已确认由本对话接管记忆相关优化。

## 优化要点与定位

1. **长记忆深处命中保全**
   - 原定位：`scopedMemorySnapshot` 在根据关键词挑选出相关条目后，格式化正文时未传递 `terms`，导致长正文深处的命中在 `bodyPreview` 中退回从头截取，造成“选中了文件却没带关键内容”。
   - 现已修复：`scopedMemorySnapshot` 在读入匹配条目后将查询切词传递给 `bodyPreview(content, terms)`，确保围绕首次命中展开预览窗口。

2. **工作流子代理按自身指令检索**
   - 原定位：工作流运行器的 `memorySnapshot` 回调仅闭包绑定了整个图运行的原始 `prompt`，每个节点构造输入时均以此检索，导致职责不同的子代理拿到的记忆快照千篇一律。
   - 现已修复：`ModelInputScope.memorySnapshot` 接口支持传入当前节点的特定查询。`buildNodeInput` 为开启记忆的节点组合“本步指令 ＋ 当前用户请求”发起检索，依然由宿主严格绑定 `session.projectId`，不开放跨项目读取。

3. **请求时刻真实注入诊断与预览**
   - 新增 `apps/desktop/src/main/memory/injection.ts`，在宿主构造请求向引擎发送前（`traceMemoryTurn`）按会话与节点记录本轮真实附带的记忆节与提交阶段（`preparing` / `submitted` / `start-failed`），保留其所属节点标识。
   - 区分状态：`included`（实际附带）、`off`（步骤关闭）、`empty`（库中无匹配）、`error`（读取异常）与 `not-automatic`（非自动注入会话）。
   - 查看时不重新查询文件系统，防止以当下最新磁盘伪造历史证据；纯文本安全呈现，不解析 HTML 标签。
   - 诊断仅在内存中保留最近有限条数（TTL 24h，上限 128 条），不建立新的持久化数据库，重启自动清空。

4. **节点参数与角色选择器界面说明**
   - 节点表单中的记忆开关标签更新为“本步骤自动附带项目＋全局记忆”，中英文同步；布尔处理兼容 `"on"`、`"true"` 与布尔值。
   - 说明明确指出：关闭自动注入只是本步不主动拼接快照，不剥夺模型调用 `memory_*` 检索工具的权限，也不清除提供方已持有的历史。
   - “新建子对话”选择器明确标明“带记忆（创建快照）”及首轮快照提示，使用户清晰认识到该选项是创建时的单次背景注入，而非持续订阅。
   - 记忆库设置面板新增范围、聊天历史与全局指令的边界说明，明确管理范围下拉框仅用于当前面板的文件浏览与编辑，不改变会话自身的记忆隔离。

## 验证结果

- **双包类型检查**：`packages/contracts` 与 `apps/desktop` 的 `tsc --noEmit` 均 **exit 0**。
- **定向新增回归**：
  - `memory-injection-smoke`：**11/11 PASS**（覆盖长文深处命中、范围边界、长度预算、按节点指令检索、差异化角色选择、诊断回执一致性等）。
  - `memory-injection-ui-smoke`：**11/11 PASS**（覆盖真实组件/样式/中英文案：诊断呈现、节点开关状态、免受磁盘内容伪造、错误重试、会话切换防迟到覆盖等）。
- **定向关联回归（12/12 套件通过）**：
  `memory-injection-smoke`、`memory-injection-ui-smoke`、`memory-smoke`、`memory-review-smoke`、`memory-codex-smoke`、`session-subchat-smoke`、`provider-context-smoke`、`node-session-smoke`、`conversation-queue-smoke`、`run-store-smoke`、`workflow-validation-smoke`、`workflow-view-smoke`。
- **代码格式与差异检查**：`git diff --check` **exit 0**（仅有既有 CRLF/LF 换行提醒，无空白错误）。

## 边界与集成注意事项

- 后端测试使用隔离临时目录与数据根桩，前端测试使用隔离 React 运行容器与 API 夹具；未动用用户真实数据库与记忆文件，未调用真实模型 API。
- 诊断回执显示“已提交到引擎”仅代表主进程已将带记忆的请求交付给 provider，并不等同于远端大模型必定遵循或采纳了该项记忆。
- 本次改动涉及主进程与渲染端源码；已安装运行的应用需要重新构建或重启开发构建方能加载最新代码。本任务未执行自动构建或应用重启。
- 未进行 git 提交或推送，工作区其他未提交成果已完整保留。
