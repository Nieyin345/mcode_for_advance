# UI-MODULES-P2 / 任务 06 独立安全发现

日期：2026-09-27。测试基线 HEAD 最近核对为 `fe62fe35831ab3bec97b6bcc06673c761ea5a91e`，共享活动树，未冻结。冻结契约 P2-01 / 1.0.0。

本文件由第 06 号任务维护；重连后回写到仓库。安全红灯留给所有者修复，06 不修改生产。

## P2-SEC-001 — 未注册能力 kind 会进入模型 fallback
- 状态：OPEN / 激活前阻断。
- 归属：05（executionEngine.ts），01/07 协调 runnable 门禁。
- 复现：`node apps/desktop/scripts/module-phase2-e2e-smoke/build.mjs`。
- 断言：`SECURITY missing capability executor must never reach model fallback`。
- 方法：真实 ExecutionEngine + 空真实 registry；setDefault 安装计数型测试 fallback（不调用模型）；传入契约有效的 module-capability 上下文。
- 实测：fallbackCalls 为 1，预期为 0，exit 1。
- 影响：若在注册不完整时放开 runnable，受控文件能力节点可能落入模型执行而非 fail-closed。当前接口冻结稿有关闭 runnable 的门禁，**未证明正式 UI 已可触发**；这也是冻结稿指出、05 尚待完成的集成风险，不宣称新发现了可利用的已发布漏洞。
- 最小请求：缺少该 kind 执行器时明确 failed，不走模型 fallback，同时不破坏旧 kind 的既有逻辑；两条注册入口都验证后再请 01 激活。
- 证据：`apps/desktop/.tmp/p2-06-e2e-eyrGWL/{output.log,checks.json,result.json,inputs.json}`。
- 复验：待 05 修复；06 未改生产。

## P2-SEC-002 — 默认生产引擎缺能力注册
- 状态：OPEN / 生产 E2E 阻断（集成缺口，不单独定性为可利用安全漏洞）。
- 归属：05。
- 复现：同上。
- 断言：`PRODUCTION exported engine must register module-capability`。
- 方法：直接导入真实 production `executionEngine` 对象，不手工补注册，调用 has。
- 实测：false，预期 true，exit 1。
- 影响：手工组合的 segment 通过不能证明正式工作流可以使用能力；runner 第二注册入口、参数映射、宿主 nonce、循环及续跑尚待验收。
- 最小请求：完成两条生产注册及真实输入构建，确保异步 getModuleHost() 与执行器端口适配，保留懒加载；报告精确接入导出，供 06 增加真实链路断言。
- 证据：同上。
- 复验：待 05 交付。

## P2-SEC-003 — 全链与验收证据缺口
- 状态：BLOCKED / 验收阻断，不是产品漏洞。
- 归属：06/07；依赖 05、01。
- 尚缺：真实 scheduler/runner 参数与变量映射、派发身份循环/失败重试/续跑、配置保存重开、导入不自动启用、独立浏览器交互、IPC/mobile 门面拒绝、Electron 实机。
- E2E main.ts 明确记录 BLOCKED；其 7 个 PASS 只证明手工注册的真实组件片段和生命周期。
- 上轮定向 tsc/UI 请求遇 HTTP 502/530，无结论。恢复后两套定向 tsc 均 exit 0；本轮浏览器复验结果见 task-06.md，不将 harness 启动失败当产品行为失败。
- 复验：MCP 已恢复，HEAD/归属/自有测试文件已核对；05 仍在实施，全链继续等待依赖。

## 已检查且本轮通过的边界
安全正常运行 20 PASS / 0 FAIL：真实菜单与用户模块恢复兼容、内置工作流授权、额外授权字段拒绝、已知根/越界/junction/目录/文件大小、目录快照、危险 schema 与访问器、重复注册、同次去重/新次执行、真实超时/取消终态/淘汰和重启句柄丢失。

有效红灯：`node apps/desktop/scripts/module-phase2-security-smoke/build.mjs --mutation-workflow-auth`，只修改临时 bundle，用户模块工作流断言 `Missing expected rejection`，exit 1。证据目录 `apps/desktop/.tmp/p2-06-security-5ZaN7Z/`。

恢复正常实现：安全 suite exit 0，证据目录 `apps/desktop/.tmp/p2-06-security-L6gzvg/`。

检查范围不包括任意第三方代码沙箱、跨重启 exactly-once、实时文件系统竞态穷举、真实用户数据库或网络模型。没有漏洞发现的边界也仅在上述测试范围内成立。

## 重连复验

通过真实 run-smokes.mjs 调用两套新 suite，安全再次通过；集成探针再次 7 PASS / 2 FAIL / 1 BLOCKED，P2-SEC-001/002 尚未关闭。日志目录：`apps/desktop/.tmp/smoke-runs/1790483335266-39552-qkpRrO/`；集成产物：`apps/desktop/.tmp/p2-06-e2e-mTA6qq/`。

浏览器层：本轮新目录 UI 套件 **21/21 PASS，exit 0**，但使用真实浏览器中的测试 transport/内存 fixture，非生产调度 E2E；产物 `apps/desktop/.tmp/module-catalog-ui-lkM1fQ/`。原菜单 UI 套件因独立 profile 的 DevToolsActivePort 被锁（EBUSY）而 exit 1，未取得行为结论，请 04/07 协调 harness 所有者，不将该错误定性为产品权限漏洞，不以重试掩盖。四套 runner 合计 2 pass / 2 fail，exit 1。
