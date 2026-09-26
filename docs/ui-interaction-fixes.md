# UI 交互修复与回归（2026-09-27）

本轮只修改 renderer 交互及其回归，不改变 provider、主进程权限或 IPC 契约。没有启动用户应用/真实模型，没有操作真实数据根，修复阶段没有提交已有工作区改动。

## 行为变化

- 工具审批与提问的键盘处理限定在当前卡片，后台会话不再监听 document 的 Enter/Escape。ChatPane 传递当前可交互状态；设置覆盖时不自动抢焦点或执行审批。组词中的 Enter 不提交回答/批准计划。
- 命令面板有搜索词时保留左右方向键的文本编辑功能；空输入才使用方向键切换范围。补齐对话框可访问名称。
- **运行预算、回退模型链改为显式“保存”**。草稿/进行中的保存不随设置分类切换销毁，失败可见、可重试，晚到读取或保存不覆盖新输入。保存成功才更新基线。
- 预算字段保留原始文本；非法值不能写入，轮数和 token 必须是正的安全整数。只有明确留空表示取消该项上限。
- 记忆正文按路径保留草稿及原始 revision，重复点击、换文件、关闭/重开设置均不会悄悄丢失正文。增加“放弃改动”；继续使用原有 revision 冲突检测，不强行覆盖磁盘文件。
- 手机文件读取使用 useRpc，并绑定项目/目录身份。旧请求不能覆盖新项目列表，失败有错误和重试，不再冒充空目录。
- Button 增加键盘焦点环；默认主按钮和提问卡小字使用 accent-strong。Dialog.Close 默认有本地化名称。
- Divider 使用 Pointer Events/capture，pointercancel、lostcapture、blur、卸载均释放拖动；支持方向键、Shift 加大步长、Enter/Home 重置，并提供可访问位置百分比。

**草稿边界**：这里保留的是 renderer 生命周期内的内存草稿，不承诺崩溃、强制退出、重启应用后的恢复。重要配置仍需点击保存；预算界面已提示退出前保存。

## 新增回归

```sh
node apps/desktop/scripts/ui-interaction-smoke/build.mjs
# 或直接执行本套件（Git Bash）：
bash apps/desktop/scripts/ui-interaction-smoke/run.sh
```

需要项目已安装依赖，以及 Chrome/Edge。不会安装或连接用户正在使用的浏览器。本套件自带独立 CDP 驱动（源自 workflow UI 审查驱动的快照），不依赖另一套件是否已提交：临时 profile、独立端口、页面禁止网络访问，仅清理自己创建的浏览器进程。

产物：`apps/desktop/.tmp/ui-interaction-<唯一后缀>/results.json` 和各场景截图。

- 被测组件、useRpc、Button/Input/Dialog/Select 等共享控件、CSS 和中文词典使用真实源码。
- RPC 与 store 使用内存桩。Monaco 仅在“父组件草稿生命周期”测试中换成受控 textarea，不把这项当成 Monaco 自身验收。
- 提供 45 条断言，包括：后台审批、提问焦点范围、IME 提交、计划审批、搜索光标、预算非法值/保存失败/导航/保存与读取竞态、模型链草稿、手机异步/错误重试、记忆正文换文件与重挂载、焦点、按钮对比度、弹窗名称和分隔条生命周期。
- 在独立副本撤去修复后，相关回归出现 24 条失败，确认不是只测桩或空跑。远端旧代码首轮失败 17 条；补充记忆/计划/拖动断言后，在沙箱完成更完整的撤修复检查。
- IME 用例是组词 KeyboardEvent 层测试；真实 Windows/macOS 输入法、iOS 软键盘、原生 WebContentsView 遮挡与正式安装包仍需实机回归。

## 修复阶段门禁（此前完整工作区）

- renderer/desktop 类型检查与 contracts 类型检查：通过。
- 新增 UI 浏览器回归：45 条断言通过（Windows 独立浏览器与 Linux 沙箱均执行）。
- smoke runner 自测：10/10 通过。
- 全量 smoke：**102 套执行完毕，98 通过、4 失败，退出码 1；项目全量门禁未通过**。其中新增 ui-interaction-smoke、settings-panel-smoke、dialog-shell-smoke、frontend-smoke、workflow-ui-smoke 均通过。
- 本轮目标文件的 `git diff --check` 未报告空白错误；设置词典有 CRLF/LF 提示，未全库格式化。远端 16 个生产文件和 5 个测试文件与本地验证副本内容一致（两个设置词典仅换行符不同）。

### 全量阻塞项（未在本轮越界修改）

| 套件 | 本次日志中的失败 |
| --- | --- |
| library-adopt-smoke | 默认转换子进程退出码 1，后续对 undefined 的 md_path 调用 includes 导致异常。 |
| library-mcp-smoke | 97/103 断言通过；转换子进程退出码 1，以及无源文件时返回文案与断言不一致。 |
| node-live-smoke | 构建失败：providerRegistry 测试桩缺少主进程 runner 导入的 probeProviderHealth 导出。 |
| theme-ipc-smoke | APP_GET_DATA_ROOT 返回 root/dbPath/libraryPath，测试仍要求 templatesPath，随后对 undefined 调用 path.resolve。 |

这些失败位于本轮未修改的主进程/资料库及其测试链路；不能仅凭这一轮日志判定它们何时引入，也没有通过回滚其他并行改动来做基线比较。为尊重并行任务，本轮没有改动这些模块或放宽断言。它们仍然阻塞全项目验收。

全量日志：`apps/desktop/.tmp/smoke-runs/1790454526174-1928-U5tCNe/`，其中四个同名 `.log` 保留具体错误。

独立 UI 回归产物：`apps/desktop/.tmp/ui-interaction-BzzzG4/`。以上是本次运行结果，不代表对并行工作区后续变化的保证。


## 提交前复核

- 按改动块隔离提交，不整文件带入 ChatPane / ApprovalPrompt / QuestionPrompt 的 provider、模板清理等并行改动，也不带入设置词典中的 Office / 工作流改动。
- 中英 common 词典的六个新键已随并行提交进入 HEAD，不重复提交或撤销。
- 补齐本套件自带的 `browser.mjs`，消除对尚未提交的 `workflow-ui-smoke` 文件的依赖；统一 runner / package scripts 不在本次提交范围内，以上直接入口可独立使用。
- 本次只提交可归属本轮的 UI 修复、专项测试和本说明；不推送远端、不重置其他暂存/未暂存改动。


### 本次提交验证结果

- 自包含 UI 套件：共享工作区 **45/45** 通过，隔离的拟提交树 **45/45** 通过；后者未复制其他对话的未提交源码或兄弟 smoke 套件，仅借用已安装依赖。
- 共享工作区：desktop / contracts 类型检查均退出 0。
- **隔离树全包类型检查并未通过**：父提交 `92478dd` 与拟提交树均报告 187 条诊断；按文件、错误码和错误内容对照（忽略行号、临时目录名及联合类型省略计数）完全一致，本轮未新增类型错误。现有已提交的资料库 / Office 重构仍依赖工作区里的配套改动；这些改动按用户要求没有混入本次 UI 提交。
- 本次没有重复执行耗时的全量 smoke；上节 98/102 是此前修复阶段那次全量运行，不能当成本次隔离树的全量结果。
- 本次提交只含 21 个文件的相关改动，`git diff --check` 通过。共享工作区与隔离树的通过范围不可互相替代。

本次 UI 产物：工作区 `apps/desktop/.tmp/ui-interaction-oxTGO0/`；隔离树 `.tmp/ui-commit-verify-HD4WIW/apps/desktop/.tmp/ui-interaction-2FYORz/`。提交拆分、父提交对照及事务记录在 `.tmp/ui-commit-review-20260927/`。
