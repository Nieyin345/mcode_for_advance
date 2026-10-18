# 公网 Mcode MCP 与 Remote Desktop Commander 功能对照（2026-10-19）

本页记录**同一台 Windows 用户设备、同一项目、实际工具调用与源码检查**结果。它不是声称某一工具全面优于另一工具；重点是让多个开发会话协作时能明确区分「源码已实现 / 端点已验证 / ChatGPT 适配器已端到端看见」三个层次。

## 读文档和图片能力

| 能力 | Remote Desktop Commander（本次工具描述与实测） | 旧 Mcode 公网 MCP | 本次 Mcode 源码增强 |
|---|---|---|---|
| PDF 文本 | `read_file` 自称 PDF→Markdown + page markers；真实 `sample-paper.pdf` 返回 `Cannot read properties of undefined (reading 'toLowerCase')`（无参数及页参数均复现）；另一个 17 页 stamps.pdf 能列出页但无文字 | `agent_read_document` 基于 pdfjs 抽平面文本，sample-paper.pdf 成功，扫描件明确无文本层 | 保留原文本模式，增加 `page_start` + `max_pages` 翻页与页面编号，不会为了读后部全文而反复读前面 |
| PDF 内嵌书签/页面布局 | 描述支持分页 Markdown；未证明返回文字物理坐标、书签、列位置 | 无结构化坐标／书签模式 | `pdf_mode:"layout"` 返回内嵌 Outline、页面 pt 尺寸、逐行文字坐标、近邻文本分组与图片绘制指令计数（不等于图表数）；每次最多 20 页，可分页 |
| PDF 真图像 | DC 宣称 PDF 里带图像，17 页纯图 stamps.pdf 实测只给空页标记 | 文本抽取无法看扫描页、排版、插图 | `agent_render_pdf_page` 使用本机可选 `pymupdf` 渲染指定页 JPEG 至 MCP `image` 块；单次页、有限像素和字节、无 OCR/无磁盘落盘 |
| PNG/JPEG/WebP/GIF | `read_file` 对 `scripts/ui-probe/selftest.png` 返回 `content_items` 中的真实 `image/png` | `agent_read_image` 源码发送标准 MCP image 块，但**本次 ChatGPT 工具适配包装层对同图暴露给调用代码的仅为 `text`** | 现有 image 工具逻辑不改，PDF 页面也返回标准 image 块。**待真正穿过公网 connector 后确认图片进入模型视觉输入**；不要把显示了图片尺寸当成看懂图片 |
| DOCX / 表格 / 演示文稿 | DOCX 默认提供元素索引/样式/表格 outline，另可 raw XML；Excel sheet/range | DOCX 优先 Pandoc Markdown，raw OOXML 通过独立 `agent_read_docx_xml`；Excel sheet/range + 预算；PPTX 抽文字 | 本轮未改变 DOCX/PPTX/XLSX；待补 DOCX 段落元素索引/样式、图片定位与 PPTX 图层/表格的结构化只读输出 |

### 明确不要误报的边界

- **标准 MCP image block 出现在 Node MCP 协议层≠ ChatGPT 真的获得视觉输入。**Mcode 原有端点烟测已经断言 image block 可从协议传出，而本次连接工具的 JS 返回只有 `text`，与 DC `content_items:image` 不同。后续应在**重新启动 Mcode、刷新 ChatGPT tools/list**之后，用真公网连接测试 `agent_read_image` 和 `agent_render_pdf_page`，记录模型是否实际拿到像素，必要时修工具适配层而不是让模型猜。
- 当前 PDF 布局行合并只按文字位置做近似；多栏同高不应该错误拼在同一行（对应真实红绿回归），但**不能宣称公式、表格、图片语义已被完整解析**。没有可抽取文本不等于已经 OCR。
- 页面渲染依赖**用户本地 Python 环境**的 PyMuPDF；本机已确认可用，其他安装环境未保证包含，不在公网连接中自动安装包。
- 公网 MCP 链接仍是免审批操作能力；新增两项都是**只读**，走现有 `pOfRead` 项目沙箱/只读资料库策略与文档并发预算；不得将原路径校验改弱、不得额外暴露外网临时图片 URL。
- 桌面多个 AI 会话同时在修改 UI / 文档工作流。本次只触及主进程 MCP/PDF、其独立烟测及本文件，不改并行的 Slides/GenOffice/IPC 修复。

## 实测与回归

- `scripts/document-read-smoke/run.sh`：**49/49 PASS**，包括 PDF 文本第 2 页续读、二栏同高坐标拆分、布局限额、非法页报错、实际 PDF 栅格化 image/JPEG 头验证、原有 Office 与 URL 安全预算。
- `scripts/mcp-endpoint-smoke/run.sh`：**778/778 PASS**，公网工具总数从 39→40、旧工具迁移、协议 image 保留及安全策略回归。
- `scripts/engine-tools-smoke/run.sh`：**95/95 PASS**，增加 `agent_render_pdf_page` 到三引擎共用的只读桥。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`：**本轮最终重跑 exit 0（全包 TS 检查干净）**。首次执行时曾出现与本轮无关的 Slides 测试桩 `openDeck` 缺失（并行开发车道），在最终复验时该错误已由其他车道更改而消失；本轮没有编辑 Slides 文件。
- `git diff --check` 针对本轮文件无空白问题；全仓此前 `workflowEngines/engineNodeRegistry.ts` 另有并行 trailing-whitespace 报告。

## 下一阶段建议

优先完成**实际公网 Connector 图片块端到端可见性（最高优先）**：调用同一个 8KB PNG、同一个一页 PDF，并对比两个工具返回给 ChatGPT 模型的多模态块，不以 Node 内部测试代替。然后补扫描件 OCR 的**明确 opt-in、本地执行、边界与错误回执**；DOCX 样式元素索引与 PDF 真实表格/图片位置要提供机器可检验的来源，不建议靠字体启发式冒充可信结构。暂不扩张高权限公网 SSH/bash 或放宽沙箱。
