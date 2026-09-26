# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

Mcode：本地优先的通用 Agent 桌面客户端（Electron + React 19 + TypeScript），pnpm + turbo monorepo（`apps/desktop` + `packages/contracts`）。它不自己实现 Agent 能力，而是把三家引擎（Claude Code SDK / Pi / Codex）接进来，上面提供工作流编排、自动化触发器、资料库、插件系统。本 fork 定位是学术研究工作台。

两份更深的文档，改代码前值得翻：

- **`AGENTS.md`**（402 行）—— 逐子系统的权威指南：进程架构、SDK 消息适配、rewind/文件快照、编辑器驻留、组件与图标规范、Codex 协议硬事实、浏览器工具、插件系统等。注意其中的开发命令块含一条**过时的绝对路径**（`cd D:\00-huangbh-project\my-claude-gui`，是上游作者的机器），本仓库在当前目录。
- **`MCode-Status-and-Plan.md`** —— 现状与任务书：已完成能力清单、后续工作（A/B/C/D 四档优先级）、本文档第四节的硬规矩。

## 常用命令

```bash
pnpm dev          # 启动开发（turbo，HMR）
pnpm build        # 构建
pnpm typecheck    # 双包 tsc
pnpm test         # 关键回归（真实执行，无 Turbo 测试缓存）
pnpm test:all     # 全量 smoke（动态发现）
```

快速单包类型检查（不等 turbo）：

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.json
npx tsc --noEmit -p packages/contracts/tsconfig.json
```

### 验证（做完一件事的标准）

```bash
pnpm test:all                               # 全量，0 失败是基线（动态发现套件）

# 改一处小东西时**别跑全量** —— 先问哪几套覆盖它：
bash apps/desktop/scripts/smokes-for.sh src/main/<改动的文件>.ts
```

跑单套：

```bash
bash apps/desktop/scripts/<name>-smoke/run.sh
# 例：pnpm test:smoke scheduler-smoke
# Windows 用上面的 pnpm 命令，自动寻找 Git Bash，避免 PATH 中的 WSL bash.exe
```

很多主进程套件走「esbuild 打包 + stubs 换桩」的无头模式——验证主进程逻辑不需要起 Electron。渲染端组件可用 `.tmp/` 下现成的预览台（`ask-preview` / `retry-preview` / `card-preview`）在真浏览器里核对。

**两样都干净才算完：全量 smoke + 双包 typecheck。** 入口、日志和 CI 策略见 `docs/testing.md`。

`pnpm lint` 尚无包级 lint 实现，不能当作有效门禁；本轮只接入真实测试。

⚠️ **别把「跑绿了」当成「验过了」。** 新写的断言要先撤掉修复、看它真的红，再装回去。
这个仓库里已经有过两次「测试绿着而问题还在」：一次是断言测的是**别人的职责**，
一次是套件跑绿但**根本没覆盖到**被改的文件（`smokes-for.sh` 就是为它写的）。

## 架构大图

```
渲染端 (renderer, contextIsolation, 无 nodeIntegration)
   ↕ 唯一桥:window.api
preload (contextBridge + zod 校验)
   ↕ IPC
主进程 (Node.js): 25 个模块目录
   orchestration/ library/ memory/ mobile/ plugins/ browser/ lsp/ terminal/ relay/ …
```

看懂这几条才动得了手：

1. **契约先行**。IPC 方法（`RpcMap` 313 个）的 schema 定义在 `packages/contracts/src/ipc/`（按域拆 22 个模块）→ preload 白名单 → 主进程 handler。加一条 IPC 要走全三层，缺一层调用端就看不到。
2. **AgentProvider 抽象**。每家引擎一个 Provider + 一个 MessageAdapter，把各家事件归一成 provider 中立的 `RuntimeEvent`。行为对齐（预算、回退、结构化输出、子代理、elicitation）在各 Provider 里做。第四个 provider 是网页模型（浏览器扩展桥驱动真实网页 LLM 页面）。
3. **工作流编排**。图模型 + 调度器（就绪即派发、并发上限默认 4）+ 八个内置节点类型（`nodeTypes.ts` 的 `BUILTIN_NODE_TYPES`）。执行分派只有一个入口：`manifest.runner.kind` 查注册表，没有就落兜底（模型轮）。插件可注册自己的节点类型。关键区分：**子 agent 节点跑在隐藏子会话；主代理（`mcode.main`）与对话节点跑在主对话里**，用户看得见。
4. **sql.js 持久化**（纯 WASM SQLite，**没有 FTS5**，全文检索走 ripgrep）。统一数据根。
5. **i18n**：zh/en 双词典在 `lib/i18n/{zh,en}/`，**zh 是 `MessageId` 类型的源**——缺 key 直接 typecheck 失败。用户可见的字符串不许硬编码。

## 硬规矩（来自 MCode-Status-and-Plan.md，实测救过场）

1. **先补测试，再动刀**。大重构前给要改的路径写断言。
2. **共享实现只有一份**。「用户点的」和「AI 调的」必须走同一个函数。
3. **坏东西显式报出来，不静默跳过。**
4. **重构用 AST 定边界，不手抄代码**——这个仓库注释密度很高，手抄必改坏。
5. **临时脚本先写文件再执行**（`.scholar_tmp/` 或 `.tmp/`），不写内联一行命令（PowerShell 多层转义 + 中文路径必炸）。
6. **git 取消暂存用 `git restore --staged`**，永远不要 `git checkout HEAD -- <文件>`（后者连工作区一起覆盖）。
7. **渲染端新代码读数据一律走 `useRpc`**（`src/renderer/hooks/useRpc.ts`），不许再手写
   `await api.*` + 自己的 loading/catch —— 429 处散装调用就是这么攒出来的。写操作（mutation）
   仍在事件处理器里显式 `await api.*`。老代码不强迁：动到哪个面板，顺手迁哪个面板。
   界面的空状态 / 错误提示 / 加载态 / 表单行 / 状态徽标，先看 `components/ui/` 的
   `EmptyState` / `ErrorNote` / `Spinner` / `Skeleton` / `Field` / `Badge`，没有再造。

## 环境事实（踩过的坑）

- **sql.js 的 `db.export()` 会重置连接上的 pragma（含外键）**——导出只有 `exportBytes()` 一个出口，新增导出点必须走它，否则 `ON DELETE CASCADE` 静默失效。
- 主进程里**没有 cookie 的 HTTP 请求做不到**（要走内嵌浏览器那条路）。
- **子代理返回空 ≠ 失败。** 曾经这里写着「API 并发上限 1，绝对不要开子代理 / 并行工具调用」，那是**读错了**：几次子代理立刻返回空被当成"被掐掉"，而同一批里有三个是过了 **20～40 分钟**才带着完整报告回来的 —— 空只是"还没干完"。用户说的实际上限是 **30**。真正要守的是**派活按文件切、不按问题切**（每个代理只给"改哪个文件的哪个函数、改成什么样、别碰别的"），并且**别让两个代理改同一个文件** —— 那才是并行会咬人的地方。
- 手机端（`AppMobile.tsx` + `webApi.ts`）是**独立组件树**，走无 preload 的 HTTP 桥。共用组件里每加一个 RPC 都要在 `webApi.ts` 补一项，漏了会同步抛错、React 19 整棵卸载。
- preload 不热更：改 preload 后「新命名空间 = undefined」说明没真正重启 dev，不是写错了。
- Windows 子进程输出是控制台代码页（中文机器 GBK）：解码先严格试 UTF-8、失败退回 GBK，用原始字节，别数替换字符。
- **无头验证数据时，`dataRoot` 必须指向 `mcode.db` 的副本**——sql.js 重写整个文件，指向真库会毁数据。
