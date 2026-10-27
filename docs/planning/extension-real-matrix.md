# 真实扩展矩阵：本机 33 个扩展在 Theia 宿主上的激活结果

- 日期：2026-10-27
- 脚本：`apps/desktop/scripts/ext-real-matrix/`（`bash run.sh --out=<path>` 可重跑）
- 语料：`C:\Users\Nieyin\.vscode\extensions`（本机现成的 33 个目录）
- Theia：`vendor/theia` @ `d8106d7`（v1.76.0）

## 〇、结论

**有代码的 30 个扩展，30 个激活成功，0 个失败。**

| 类别 | 数量 |
|---|---:|
| 有代码、激活成功 | **30** |
| 有代码、激活失败 | **0** |
| 纯声明（主题 / 语言包，不执行代码） | 3 |
| 无 `package.json`（UUID 目录，不是扩展） | 1 |

**这推翻了仓库里所有旧的「能装/能跑」数据。** `docs/planning/extension-vscode-compat.md` §3
写的「本机 24 个扩展里 12 个能过限制、其中 9 个仍会崩」是 **L1 迷你 VSIX 路径**的测量
（恰好 2 个 ZIP 条目、`main` ≤24 KiB、`require` 白名单只有 3 个模块）。那条路径已于
2026-10-27 整体删除。**Theia 路径没有那些限制，结论完全不同。**

## 一、逐条结果

| 扩展 | 命令数 | 激活耗时 |
|---|---:|---:|
| `James-Yu.latex-workshop` | 71 | 1.2 s |
| `ms-azuretools.vscode-azureresourcegroups` | 70 | 0.9 s |
| `ms-python.vscode-python-envs` | 35 | 0.7 s |
| `mechatroner.rainbow-csv` | 25 | 1.6 s |
| `ms-python.vscode-pylance` | 25 | 0.8 s |
| `ms-azuretools.azure-dev` | 23 | 0.7 s |
| `Anthropic.claude-code` | 20 | 0.8 s |
| `ms-python.python` | 14 | 0.8 s |
| `ms-vscode.remote-explorer` | 14 | 0.7 s |
| `Minko.image-manager` | 5 | 0.8 s |
| `Siesta.vscode-pdf-translate` | 3 | 0.6 s |
| `ms-vscode-remote.remote-ssh` | 1 | 0.7 s |
| `ms-vscode-remote.remote-wsl` | 1 | 0.8 s |
| `MarsCode.marscode-extension` | 0 | 3.7 s |
| 其余 16 个 | 0 | 0.5–0.9 s |

**纯声明（3 个，不执行代码）**：`MS-CEINTL.vscode-language-pack-zh-hans`、
`ms-vscode.vscode-node-azure-pack`，以及一个无清单的 UUID 目录。

## 二、「0 命令」不表示坏了

16 个扩展激活成功但注册 0 条命令。它们靠 **`contributes.commands` 之外的路径**贡献功能：

- 语言服务（`pylance`、`debugpy` 走 `registerXxxProvider`，命令由宿主侧提供）；
- 主题 / 语言包 / 文件关联（纯声明贡献）；
- 延迟注册（命令在某个激活事件之后才 `registerCommand`，而矩阵只跑 `activate()`）。

**矩阵验的是「能不能激活」，不是「功能对不对」。** 见下一节。

## 三、NOT-COVERED（这套证明不了什么）

- **不验命令能否执行**：激活成功 ≠ 点下去有反应。命令执行有一条独立的端到端
  （`ext-real-run-smoke`），覆盖「真 vsix → 激活 → 调 `mcode.*` 并拿到返回值」。
- **不验 UI 贡献渲染**：菜单、视图、Webview、状态栏是否真的出现在 Mcode 界面上 ——
  那要真 Electron 窗口（`theia-native-u1` 只覆盖了语言 provider 到 Monaco 的那一段）。
- **不验扩展之间互相依赖**：`extensionDependencies` / `extensionPack` 本宿主不处理。
  装了 A 但 A 依赖的 B 没装时，A 可能在用到 B 的 API 时才崩 —— 激活阶段发现不了。
- **不改任何扩展目录**：矩阵只读；宿主存储在临时目录，跑完删除。

## 四、这份矩阵的保质期

矩阵是**观测**，不是门禁：它记录的是「2026-10-27 这一天、这台机器、这批扩展版本」。
换机器、升级扩展、升级 Theia，结果都可能变。

**重跑方式**：

```bash
cd apps/desktop
bash scripts/ext-real-matrix/run.sh --out=/tmp/matrix.json
```

`--source=<dir>` 可以指向别的扩展目录。
