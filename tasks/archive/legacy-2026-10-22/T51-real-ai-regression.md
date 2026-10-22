# T51｜真 AI 从零编写扩展 U1 回归卡（待人工实跑）

> 本文仅定义真 AI 回归动作与取证标准；不把 E1 无头测试冒充真实 AI 交互。

## 前提
- 桌面主程序处于已运行状态，三引擎之一（Claude / Codex / Pi）已能对话；Mcode 项目/扩展安装入口可用。
- Windows 上要运行可执行扩展，需用户此前在设置页明确选择允许 JS-only 网络守卫风险降级；未经选择应按预期拒绝，不能由 AI 自行改变设置。
- 使用临时测试工作区和无敏感内容的 .md 文件；不得改生产项目资料。

## 一次真实交互
用户只发一句：「帮我写一个扩展，在文件右键加一个统计行数的操作，安装后实际验证它能跑。」

## 必须按真实 AI 消息及工具调用日志取证
1. AI 调 `app_guide({topic:"extensions"})`，得到清单形状、权限、API、可运行示例、常见错误五项。
2. AI 调 `app_api_list` / `app_api_describe` 核实安装 API 及参数，不盲猜。
3. AI **自行生成** `manifest.json`（及需要时的 `program.js`），不是人工复制模板再声称 AI 写的。
4. AI 用 `extension_validate({manifest})` 校验；失败要读回诊断、修改，并在成功前不安装。
5. AI 调 `app_api_call({method:"modules.install",input:{manifest,confirmReadAccess:true,confirmExecutableCode:true,grantedPermissions:[...]}})`；须真实弹出安装审批卡，展示 module id / 请求权限 / 可识别的 API 调用。用户点击取消时安装不得发生；重试点击批准才允许安装。
6. AI 调实际模块能力（通过目录定位 module.<slug>.<short> 的注册 ID 和真实 invoke API），目标临时 .md 文件内容三行；断言返回 `{lines:3}`，且重启后模块仍可见、可调用。
7. 留存完整工具调用轨迹、审批卡截图/录屏、最终结果、代码/清单、工作区路径（先脱敏）及源码 commit SHA。

## 判定与回写
- 只有步骤 1–7 由**真 AI 会话**连续完成，才算 T51 验收判据 #4（U1）通过。
- 单纯使用 `extension-authoring-smoke` 中的受控子进程、模拟宿主 RPC，属于 E1，**不能**记为 U1 通过。
- 实跑须回答：第一次成功了吗、失败在哪、文档是否足够、静态权限诊断的盲区、哪个模板最有用、AI 写扩展相比直接一次调用的用户偏好。
- **当前记录：未执行真 AI 会话；U1 待验。**
