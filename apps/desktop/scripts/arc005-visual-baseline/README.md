# ARC-005 V4 · 真 Electron 截图与 computed styles

从仓库根执行：

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
```

不使用新依赖：基于 `settings-focus-electron-smoke` 的真 App + Zustand
+ 打包 Tailwind + 独立 Electron 用户数据目录实现（仅四处既有 stub：
lib/api、monacoSetup、LeftBar、StreamSidebar），Electron 自带的
`webContents.capturePage()` 生成真正 PNG。未改渲染端和主进程产品代码。

39 格（13 个矩阵行 × 浅/深/1024×640）逐格写入
`../../../../.tmp/arc005-visual/<screen>-<condition>-<width>.json`；
对应场景真实渲染且 `capturePage()` 有像素才生成同名 PNG，
否则 JSON 必须含 `data-missing` 和失败理由，并写入 `manifest.json`。
不把空白图、其它场景图冒充缺失状态。截图时使用独立的虚构项目/会话，
不读取用户项目；需要真实文件、PTY/浏览器宿主时无法安全夹具化则显式缺失。

每格 JSON：`snapshot.measured` 有 15 个固定选择器的真实元素
getComputedStyle（不存在的条目标 `present:false`），含 fontSize /
lineHeight / color / backgroundColor / borderRadius / padding / bounds；
`snapshot.tokens` 记录根 CSS 变量原始计算结果；
`environment.json` 记录 Electron、Windows、devicePixelRatio、缺图计数。

`compare.mjs` 只比较参考矩阵第二节登记的 surface/content/edge，
第四节圆角与第五节动效。引用
`open-claude-ui/code-examples/cds-theme.css` 值；对矩阵已登记的故意差异
只标「已知差异（矩阵已登记，理由见矩阵）」。
超出矩阵登记实测值的变动标「未登记差异」，以退出码 2 失败。
可传 `--out path` 输出隔离的变异报告。默认输出
`.tmp/arc005-visual/diff.md`，不把逆向参考当成用户安装版 Claude 实机。

变异操作仅限 .tmp 中的 JSON：备份目标 JSON → 将其中
`snapshot.tokens["--surface"]` 改成 `255 0 255` →
`node .../compare.mjs --out ...` 期望非零且出现「未登记差异」 →
还原并逐字节 `cmp` 验证。**不要改产品 CSS**。

注意：原矩阵 §十一已记录 workspace 下 composer radius 14px；
此比较器比对 root token 而非给 workspace UI 强加旧 20px。
V4 只能验证本机 Mcode 截图；没有用户 Claude 安装版对照截图时，
不将视觉相似度标记成通过。
