# T75｜GenOffice 六编辑器原厂 AgentSkill 与 Mcode AI 的真实调用链审计

| 项目 | 值 |
|---|---|
| 编号 | T75（为路线图 T31/T32/T33 降低重复开发） |
| 工作包 | ARC-007 FULL-3 AI 互通能力 |
| 优先级 | P0：先证明六个原生 AI 面板能调用编辑器本机技能 |
| 路线 | L1 保留 GenOffice renderer `AgentSkill.executeTool` + L2 Mcode `ai:stream`/会话授权桥 |
| 可派 | **立即，只读**；与所有业务开发卡兼容 |
| 写边界 | 仅本卡结果回写和 `.tmp/t75-*` 只读分析输出；不可改 `genoffice/*`、`main/document/*`、`main/appControl/*` 或 tests |


## 背景
`tasks/GENOFFICE-ROADMAP.md` 阶段 2 明确：原厂 `AgentSkill` 存在渲染端并直接操作编辑器对象；**不要搬入 Mcode 主进程重写**。T05c/T28/T29/T53 已有 Docs 和多格式 `ai:stream` 宿主测试，但目前没有可靠证据表明六个原厂编辑器“选区→原生编辑指令→原生工具执行→用户可见修改→撤销”都可用。此卡找真正断点，不先扩充新代理 API。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md` 阶段 2、T05c/T28/T29/T53/T54 的回写。
2. 六个上游编辑器 `genoffice/apps/{docs,sheets,slides,pdf,markdown,html}` 中 AI transport、AgentSkill、`executeTool` 实际路径及工具列表（用搜索找到，不能想当然）。
3. Mcode 的 `src/main/document/docsAiPorts.ts`、`genofficeViewFactories.ts`、`genofficeViewAiVendor.ts`、`documentViewHost.ts`，以及 `genoffice-ai-ask-smoke`、`genoffice-native-view-smoke`。
4. 对应原厂 `packages/agent-core`，辨别 renderer 工具和 Host 工具分别在哪运行。

## 执行内容
1. 输出 6 app × `ai:stream` 接线/消息 schema/发送方身份/取消/选区/AgentSkill 工具列表/原生编辑回写/撤销/只读限制 的矩阵，每格注明 E2/E1/U1 或未知。
2. 逐个追踪一次“用户选区提问→Mcode 三 SDK/provider→工具调用→原厂编辑器 apply→持久化”调用链；无 U1 就标 U1 未验，不在分析中把 mock 工具调用替代编辑器执行。
3. 查是否有第二份工具执行器、绕过宿主授权、用户所选 session 被 vendor payload 假冒、跨 pane 的状态泄漏。只记录可定位调用链与真实测试证据，不改代码。
4. 明确 T31（共用 AI transport）、T32（保持 renderer AgentSkill）、T33（Agent 反向利用编辑器选区上下文）**哪些实际上已经有、哪些缺生产调用、哪些欠 U1**。
5. 按“最小文件边界+前置+红例+功能”建议 2–4 张开发卡给总控；不要在本卡擅自改编辑器内核、直连原厂云模型或换新 Agent loop。

## 验收判据
1. 六格式每个至少一条原始源码地址与当前能力结论，完整矩阵无空格，未知如实标记。
2. 拟称可用的功能必须有调用链到实际原厂 `executeTool` 或证实无需该工具；仅 `ai:stream` 事件抵达不代表可编辑。
3. 来源清单和安全域归属明确，能识别面板伪 session/缺取消/跨文档写权限等风险。
4. 后续建议卡相互不抢文件，且不与 T49/T64/T65 或 T30 在飞范围重叠。
5. 纯静态 E2 不宣称真三 SDK 与 Electron U1，未新增断言则变异 N/A；回写版本/证据/remaining。

## 不做
不运行在线模型、不向真实资料发写命令、不切换生产 provider、不新写工具/重写 skill、不改任何业务文件。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->
