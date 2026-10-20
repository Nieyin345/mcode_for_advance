# ARC-005 / T12 V4 — 真 Electron 视觉基线（含明确标注的夹具）

从仓库根目录运行：

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
node apps/desktop/scripts/arc005-visual-baseline/compare.mjs
npx tsc --noEmit -p apps/desktop/tsconfig.json
```

仅使用现成 Electron/esbuild/Tailwind/React 依赖。根组件始终是**真实 App**
和真实 Zustand store，LeftBar / StreamSidebar **不再用占位组件替换**；
只为 `lib/api` 和 `monacoSetup` 保留已有构建桩。项目、会话、Git worktree、
文件树等 API 使用 `api-stub.js` 的独立虚构数据响应；无真实数据目录访问，
无真实 PTY/Monaco worker 创建。

## 39 格的证据属性

每格按 `<screen>-<condition>-<nominal-width>.json/.png` 输出到
`.tmp/arc005-visual/`。截图均由真实 Electron `capturePage()` 生成，
但 **capturePage 是真的，并不意味着面板的每个内部功能也是真的**。
每个 JSON 都有顶层 `fixture`，实际渲染 DOM 的 `data-arc-fixture` 也有对应类型：

| 场景 | fixture | 取证边界 |
|---|---|---|
| empty/messages/tools/approval/settings | `real-app` | 真 App + store，内容是虚构的 |
| parallel | `real-StreamSidebar` | 真实侧栏组件，三条假会话及运行状态 |
| projects | `real-LeftBar` | 真实项目树，两个假项目 |
| diff | `real-lineDiff-DiffView` | `.tmp` 下 v1.ts、v2.ts 两版，真实 `lineDiff` 计算与 `DiffView` 渲染；不是 Monaco 编辑器 |
| preview | `real-markdown-renderer` | 真生产 `Markdown` 渲染；尚未验证 PDF/图片 |
| terminal | `static-terminal` | 只验证 token/排版；**没有 PTY** |
| editor | `stub-editor` | 假只读源码面板；**不是 Monaco** |
| sidechat | `sidechat-partial` | 真 `WorkflowBoardPanel` 尝试渲染；数据/订阅来自空 stub，无真实 workflow IPC/运行，错误边界保留框架 |
| narrow-window | `stub-editor+real-layout` | 强制实际窗口 1024×640，打开左栏/右栏并覆盖只读编辑器桩；light/dark 也在 1024 实拍 |

**特别注意：** 文件名中的 `light-1280` / `dark-1280` 对 `narrow-window`
代表**主题条件**，不是实际 viewport；实际 window size 见 JSON
`requested`、`snapshot.viewport`。其他行按命名窗口尺寸拍摄。

每张 JSON 都写入 `snapshot.measured`（固定 16 个选择器的
`getComputedStyle`，不出现标 `present:false`），
`snapshot.tokens`（根令牌原值），`probe`（DOM 验证）
和 `deviceScaleFactor`。没有安全场景或渲染失败仍写
`data-missing` 及原因；不会用其它截图顶替。

## compare 和变异验证

`compare.mjs` 仅比对参考矩阵 §二/四/五已经登记的
surface/content/edge、圆角及动效；生成 `.tmp/arc005-visual/diff.md`。
目前保留 **13 次暗色 --edge 的旧矩阵偏差**（单一根因），
因此比较器退出码 **2 代表发现真实未登记差异**，不是截图失败。
`run.sh` 会保留该证据而不会吞掉其它类型错误。

T12 的 token 变异验证保存在
`.tmp/arc005-visual/mutation-t12.json`；
暂时把 `empty-light-1280.json` 的
`snapshot.tokens["--surface"]` 改为 `255 0 255` 后，
未登记差异应从 13 增为 14；还原后回到 13，原/还原
文件 SHA-256 与字节比较相同。

## 仍未覆盖的功能

- 侧聊的 live WorkflowBoard IPC 和真实异步运行未被夹具提供；
  如要验业务互动，需产品级真 preload/主进程工作流订阅环境，
  仅在本测试目录添 stub 不等价。
- 编辑器真实 Monaco worker、PTY 的会话生命周期、PDF 和图片预览
  不是本批视觉夹具的证据。后续验收不能拿静态桩代替 U1 功能结论。
- 仅代表本机 Mcode 的真实 Electron 画面；未取得用户安装版 Claude
  Desktop 的逐屏参照图，不据此宣称 ARC-005 视觉整体一致。
