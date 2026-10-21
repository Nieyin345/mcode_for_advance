# T95｜T78 实证缺口：ARC-005 视觉探针准确性与可观测性修复

| 项目 | 值 |
|---|---|
| 编号 | T95 |
| 工作包 | ARC-005 / T78 后续；验证工具可信度，不重写桌面 UI |
| 优先级 | P1 |
| 可派 | **立即**；与 T89–T94/T96/T97 文件独立；若有 Electron GUI 测试窗口则先执行离线小测试 |
| 独占可写 | `apps/desktop/scripts/arc005-visual-baseline/probe.ts`、`compare.mjs`、`fixture-panels.tsx` 中仅测量/fixture 成功状态相关局部、新增 `apps/desktop/scripts/t95-visual-probe-integrity-smoke/**`、本任务卡 |
| 禁写 | `apps/desktop/src/renderer/**`、`apps/desktop/src/main/**`、`apps/desktop/scripts/arc005-visual-baseline/**` 既有历史截图/矩阵记录、T71/T77 夹具、其他业务 Smoke |


## 已确认证据

T78 对旧 39 场景逐格审计发现：(1) `probe.ts` 的 composer selector 仍为 textarea，但产品实际是 Tiptap contenteditable，导致 0/39；(2) `tool-row` 选择器回退 `[data-testid*='tool']` 错命中右侧 rail；(3) `titlebar` 的兜底 header 命中 Settings 内层；(4) sidechat 只检查永在的 wrapper，组件错误边界也能让 probe.ok=true；(5) JSON 没有焦点、溢出、Pane bounds、DPR/zoom 的可靠区分；(6) dark `--edge` 的 13 项“未登记差异”来自 reference 期望未按主题拆分，**不能擅改产品 token**。

## 开工前必读

`audit-ledgers/README.md`、T78 结果和 `.tmp/t78-arc005-visual-gap-audit.md`，原 `probe.ts/compare.mjs/fixture-panels.tsx`，生产 `ComposerEditor.tsx` / `ThreePaneLayout.tsx`（只读）及历史 `arc005-visual-baseline` smoke。

## 执行

1. 在**独立 synthetic DOM** 创建正常 Composer、错误容器、工具卡、右 rail、Settings header、sidechat 正常/错误等反例，先让旧选择器/健康断言红，不能靠存在性通配符取得绿。
2. 将探针更新为稳定语义选择器/源类型区分（真实产品、fixture、缺内容三态）。sidechat 子面板真实内容不可用时必须 DATA_MISSING/partial，不能 report PASS；Composer、顶栏、tool-row 不接受假阳性。
3. 增加有证据的 activeElement/focus/scrollWidth/clientWidth、pane bounds/collapsed、requested size/real viewport/DPR/zoom/OS scale 读数；字段缺失显示 missing，不造零溢出、无焦点结论。深色 --edge 的主题期望应明确对比引用与产品源，不能为了去掉 13 红修改 styles.css 或悄悄把全部差异归“已知”。
4. **先只跑 Node/DOM 小测试**；真 Electron 39 格重拍是可选窗口，不能与 T71/T77 的正式独占 Electron U1 同时运行，不能覆盖旧 `.tmp/arc005-visual/**` 历史数据。
5. 两组负控（假 composer 与 sidechat child error）必须旧红新绿、反向变异必红、恢复后 hash 相同；对仍使用 static PTY/editor 的格子如实标 fixture，不升级成真编辑器。

## 验收判据

1. fake tool-row/titlebar/composer/sidechat 明确拒绝；真实对应元素能被准确选择且边界不漏。
2. 39 场景的 source/viewport/focus/overflow/panes 探针字段有来源、missing 与 pass 不混淆；无法核实真实 UI 必须未验。
3. 新 Smoke、旧 ARC-005 静态/比较回归通过；两组变异红绿并字节恢复，源码只在独占测试目录。
4. 不修改用户 UI、历史快照、真实外部软件截图或 sessionStore；Electron 用户旅程仍交 T71/T77/后续 U1。

## 不做
不靠改 CSS/token 让基线全绿，不把静态 Monaco/PTY fixture 当真功能，不运行带真实用户文件的 Electron。

## 结果回写区

<!-- 只追加实施提交 SHA、旧红→新绿、测试命令/日志、变异→恢复字节、未验判据和剩余风险。 -->
