# Mcode

![GitHub release](https://img.shields.io/github/v/release/Nieyin345/mcode_for_advance?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

面向科研与写代码的 AI 桌面工作台：在一个窗口里和 AI 对话、管文献、写论文、改代码、跑流程。支持 Windows 与 macOS。

![Mcode 主界面](docs/images/首页.png)

## 下载

到 [Releases](https://github.com/Nieyin345/mcode_for_advance/releases) 下载安装包：

- **Windows**：`Mcode-<版本>-x64.exe`（按用户安装，不需要管理员权限）
- **macOS**：`.dmg`（Apple 芯片 arm64 / Intel x64）

安装包没有付费代码签名，第一次打开会被系统拦一下，属正常现象：

- **Windows**：弹出「Windows 已保护你的电脑」时，点「更多信息」→「仍要运行」。
- **macOS**：右键应用 →「打开」；macOS 26 起要到「系统设置 → 隐私与安全性」里点「仍要打开」。也可以在终端执行：
  ```bash
  xattr -dr com.apple.quarantine /Applications/Mcode.app
  ```

装好之后应用会自动检查更新，也可以在「设置 → 关于」里手动检查。

## 功能

### AI 对话

- **三种 AI 引擎**：Claude、Codex、Pi，开新会话前任选；可以接 OpenAI 兼容接口，用自己的模型和 Key。
- **六种工作模式**：默认、文献检索、文献精读、文献写作、文献评审、代码编辑，在输入框左下角切换；每种模式的提示词都可以在设置里修改。
- 回复实时流式显示；工具调用要你批准（允许 / 总是允许 / 拒绝）；有计划模式（先出方案、你点头再动手）。
- 每一轮改了哪些文件都有记录，可以一键回退到这一轮之前。
- 多会话、子会话（另开一条旁支提问，不打断主对话）、会话分叉、自动归档。
- 输入框支持附件、粘贴图片、斜杠命令和**语音输入**（使用本地识别模型）。

### 文献与资料

- **资料库**：管理论文、教材、笔记，支持分类、单条笔记和引用信息（卷 / 期 / 页码 / 出版社），按 DOI 和 arXiv 号自动去重。
- **文献下载**：依次尝试 arXiv、OpenAlex、Unpaywall、Europe PMC、Semantic Scholar 等开放获取来源，还可以借用内置浏览器里已登录的机构账号下载，下载结果会校验是否真的是 PDF。
- **转 Markdown**：把 PDF 转成 Markdown，方便 AI 精读和引用。
- **检索脚本**：内置 Crossref、OpenAlex、PubMed、bioRxiv 等检索与引用核对脚本，供 AI 调用。
- **机构访问**：为内置浏览器配置学校 / 机构的登录入口和代理前缀；账号密码只存在浏览器里，不写进数据库。
- **模版库**：LaTeX、Word、PPT、代码、图片模版统一管理。

### 工作流与自动化

- **工作流**：用节点图把多步任务串起来，可以插入人工确认的分支；运行中断后能从停下的地方接着跑。
- **自动化**：给工作流挂触发器，支持手动、定时、文件变化、事件和 Webhook 五种方式，例如「新文献入库后自动转 Markdown」。
- **钩子**：某件事发生时（发消息、调用工具、一轮结束……）运行你自己的命令，每次执行都有记录。
- **技能**：管理 AI 的技能（SKILL.md），自带编辑器。
- **记忆**：跨会话记住规则、偏好、经验和决定，分全局和项目两级；可以查看、编辑，以及清理过期或重复的条目。

### 写代码

- **文件与编辑器**：文件树上标出 AI 本轮新建 / 修改的文件；Monaco 编辑器支持 30 多种语言，有编辑、对比、预览三种视图（Markdown、公式、图片）。
- **Office 文档**：Word / Excel / PPT 可以直接在应用里编辑（基于 OnlyOffice，Windows 上可在设置里一键安装）。
- **Git**：自动识别项目里的多个仓库，支持暂存、提交、推送、切换分支、查看历史；AI 可以写提交信息，也可以帮忙解决合并冲突。
- **终端**：多标签终端，切换项目时后台终端不会被关掉；每个项目可以存常用命令，一键执行。
- **语言服务（LSP）**：TypeScript、Python、Go、Java，在设置里一键安装，提供跳转定义、查找引用和实时报错。
- **内置浏览器**：多标签，可切换桌面 / iPhone / Android 尺寸；可以点选网页元素发给 AI，AI 也能自己操作浏览器（打开网页、点击、截图）。

### 远程与扩展

- **手机远程控制**：局域网内扫码配对，或通过自己的 VPS 走 SSH 隧道从外网连接；在手机上看对话、发消息、批准操作、看文件和 Git。
- **MCP**：管理 MCP 服务器；也可以开一个公网 MCP 端点，让 ChatGPT 网页版调用 Mcode 的工具。
- **插件与自定义界面**：安装插件；在设置里给右键菜单、右栏、工具栏添加自己的入口。
- **运行监控与用量统计**：查看后台任务状态和模型用量。
- **统一数据目录**：会话、资料库、模版、工作流都放在同一个数据目录下，可以整体迁移。

## 开发

需要 Node.js ≥ 22.13 和 pnpm ≥ 9。

```bash
pnpm install     # 安装依赖
pnpm dev         # 开发模式启动
pnpm typecheck   # 类型检查
pnpm test        # 关键回归测试
pnpm package     # 打安装包，输出到 apps/desktop/release/
```

在国内或公司代理网络下打包，如果遇到证书或下载失败，可以先设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

更多技术细节见 [docs/tech-stack.md](docs/tech-stack.md)。

## 许可证

MIT。本项目基于 [Mcode](https://github.com/huangbh2020/mcode) 二次开发。
