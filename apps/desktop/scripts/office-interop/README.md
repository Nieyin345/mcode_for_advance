# Office 真实第三方回读（只读测试工具）

本目录为 Mcode + GenOffice 原生编辑器的**独立验收工具**，不属于产品运行代码，不启动第二套 Office 编辑系统。

## 环境要求

- Windows Python，已安装 `openpyxl`、`python-pptx`、`pywin32`。运行此工具不会安装软件，也不会处理真实用户文档。
- 可选 Microsoft Word / Excel / PowerPoint：通过 `win32com.client.DispatchEx` 启动隔离的只读自动化实例，关闭时调用 `Close(False)` 和 `Quit()`；不使用 Save/SaveAs 或传输文件。
- 只接受来自 Mcode **隔离真实 Electron-U1** 运行根目录下的 DOCX / XLSX / PPTX。拒绝其它用户路径。

## 操作

1. 生成三份真实产品输出（`apps/desktop/scripts/office-perf-u1/run.mjs`，三个任务分别 `--only=docs-ai-tool-native-transaction`、`--only=sheets-formula-native-roundtrip`、`--only=slides-ms-office-interop-isolation`）。
2. `slides-ms-office-interop-isolation` 会在自己的 `.tmp/electron-u1/<运行时间>/slides-ms-office-interop-isolation/` 目录记录七个真实分阶段保存的 PPTX：基础、备注、切换、章节、批注、动画、图表。
3. 调用：`py apps/desktop/scripts/office-interop/ppt_matrix.py --evidence "<七阶段 PPTX 所在目录>"`。每个文件使用独立 PowerPoint COM 的只读打开验证；同时读取备注文本、动画序列数、图表系列数。
4. 调用：
   ```cmd
   py apps/desktop/scripts/office-interop/readback.py --word "<隔离 DOCX>" --excel "<隔离 XLSX>" --powerpoint "<隔离 stage-6-chart.pptx>" --with-office
   ```
   同时读取独立 `openpyxl/python-pptx/zipfile` 结果和 Word/Excel/PowerPoint COM 结果。一个格式失败即退出非零，打印具体对象。

路径示例不能被当成长期稳定夹具：U1 构建目录会定期清理。每次运行应使用本次生成的新产物。

## 本次验收和边界（2026-10-25）

- 修复前 PowerPoint COM 7 阶段测试：**基础 1 PASS，加入备注后的 6 FAIL**；三次结构对照排除了 ZIP CRC、目标关系缺失、压缩差异，最终定位到 `ppt/presentation.xml` 中 notesMasterIdLst 排在 sldIdLst 前。
- 修复 GenOffice `packages/pptx-engine/src/notes.ts` 后，同一台真实 Microsoft PowerPoint：**7/7 全部可打开**；备注文本、动画（1 条）和图表（1 个、1 组数列）在微软 COM 模型可见。
- 使用用户机器已有 Microsoft Office，对真实 Mcode Office-U1 输出做 **Word/Excel/PowerPoint 三家只读回读 3/3 PASS**；独立 Python 解析器 **3/3 PASS**。Excel 单元格 5、7、公式 `=SUM(A1:B1)`，Word 保留 AI 工具写入文本，PPTX 包含图表 2025/2026、数值 4/9。
- WPS、LibreOffice 当前没有发现可用安装。未验证全量任意第三方模板、宏、复杂文档家族，也**不代表正式 NSIS 安装版已更新至本次源码**。
- 当前 `apps/desktop/release/Mcode-0.1.62-x64.exe` 的 Authenticode 状态为 **NotSigned**；此前解压包六格式回归 PASS，但它是旧构建，不包含本轮源码修改。此处不重新打包、不安装、不签名。
