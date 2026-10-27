# O30｜Mcode 整屏 Office 右栏原生视图 U1

- Status: ready-for-agent（P1；O14/O15 的整屏验证尾项）
- Depends on: O14、O15、T7 GenOffice U1
- Goal: 用真实 Electron、真实 Mcode React App、生产 preload、生产 `DocumentViewHost` 与真实 GenOffice 原厂 WebContentsView，验证 Office 右栏停靠与 Mcode ChatPane 草稿交接不是仅靠单元/静态 smoke 成立。
- Required Skills:
  - `desktop-testing-electron`：真实 Electron U1 旅程、截图与副作用证据
  - `mcode-smoke`：复用现有 smoke/证据流程，不另造测试执行器
  - `implement`：仅限本卡测试夹具与断言实现
  - `code-review`：核对测试是否误用 stub、是否会把假能力判为真

## 执行范围

### 允许修改
- `apps/desktop/scripts/o30-office-fullscreen-u1/**`（本卡新建的专用 U1 套件）
- `tasks/office/O30-mcode-office-fullscreen-u1.md`
- `tasks/office/README.md`

### 不允许修改
- 不改生产 UI、Office 编辑器内核、IPC、DocumentViewHost 或 GenOffice vendor 源码。
- 不改现有 `t7-genoffice-u1`、`t29-document-view-close-u1`。
- 不碰当前并行修改中的 `apps/desktop/scripts/document-view-host-smoke/**`。
- 不运行在线模型、不发送真实 AI 请求；「交给 Mcode AI」只验证写入现有 ChatPane 草稿，不自动发送。
- 不把 arc005 视觉 fixture 或直接覆盖整窗的 T7 截图冒充为整屏集成证据。

## 实施步骤

1. 阅读 O14/O15、T7 U1 runner 与其 vendor build/preload 装配方式；核对 Git 状态，保留并行修改。
2. 建立独立 U1 journey：以真实 Mcode `App` / store 为渲染主体，真实生产 preload 和 IPC 驱动 `DocumentViewHost`；仅对与本判据无关的 API 提供最小 stub。
3. 在真实右栏挂载一份合法 PPTX，断言 React 工具栏与 `data-genoffice-view-stage` 可见，实际 WebContentsView bounds 落在 stage 内、未覆盖工具栏或 ChatPane。
4. 调整真实 BrowserWindow 尺寸，验证 native bounds 跟随 React stage 更新，不发生 0×0、整窗覆盖或孤儿视图。
5. 点击真实「交给 Mcode AI」按钮，验证原有草稿 text/html/tags 保留、只追加一次该 PPTX 的 file tag、焦点回到 ChatPane、右栏 Office 仍可见，且没有调用发送/模型接口。
6. 关闭/取消停靠后，确认 `DocumentViewHost.list()` 不遗留该 docId；U1 每一步保留真实截图、DOM 摘要与副作用记录。
7. 运行本卡 U1、现有 `office-mcode-handoff-smoke` 与 T7 Slides 保存/重开旅程；对结果和工作区做最终复核。

## 验收判据

- U1 必须使用 Electron 真窗口、生产 `DocumentViewHost`、真实 GenOffice 原厂 WebContentsView；不接受纯 DOM 假视图。
- 右栏工具栏、宿主 stage 与原生视图几何一致；缩放后仍一致，原生视图不得盖住工具栏/ChatPane。
- 草稿交接保留既有文本和 HTML，文件引用不重复，交接不触发发送；右栏仍保留编辑器。
- 收起/卸载后无遗留原生视图。
- 专项 U1、关联 smoke 与 `git diff --check` 结果全部写入本卡；如发现生产缺陷，先保留失败证据，不越过本卡边界擅自修改产品代码。
- 只提交本卡独占文件，不提交其他对话的工作区修改。

## 结果回写

完成后在本卡追加：
1. U1 旅程名称、各步 PASS/FAIL、截图/日志目录。
2. 实际 native bounds 与 DOM stage rect 的对照数据（含缩放前后）。
3. 草稿交接前后状态、是否触发发送接口、卸载后的 Host 列表。
4. 相关 smoke、T7 Slides U1、类型检查结果与提交 SHA。
5. 未达成判据及阻塞原因。
