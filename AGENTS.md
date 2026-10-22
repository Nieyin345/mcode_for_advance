# AGENTS.md

Mcode：本地优先的通用 Agent 桌面客户端（Electron + React 19 + TypeScript），pnpm + turbo monorepo（`apps/desktop` + `packages/contracts`）。它不自己实现 Agent 能力，而是把三家引擎（Claude Code SDK / Pi / Codex）接进来，上面提供工作流编排、自动化触发器、资料库、插件系统。

> **这份文件只做导航。** 2026-10-23 之前它是一份 520 行的逐子系统权威指南；产品路线确认后，其中「当前进度」表（P0–P6 阶段划分）与 AOCI 注入块都与现状脱节。全文已原样归档到 `docs/archive/AGENTS-2026-10-19-full.md`，本文件保留导航与仍然有效的入口。

## 权威文档（动手前按顺序读）

| 文档 | 管什么 |
|---|---|
| `docs/planning/mcode-product-roadmap.md` | **产品方向唯一权威**：产品定义、四条主线、任务/验收/执行环境规则 |
| `CLAUDE.md` | 日常开发入口：常用命令、架构大图、硬规矩、环境坑、任务体系 |
| `docs/testing.md` | 测试入口、日志与 CI 策略 |
| `docs/aoci.md` | AOCI 仓库认知层（工具维护的 `aoci:begin`/`aoci:end` 区块） |
| `docs/archive/Status-and-Plan-2026-09-18.md` | 历史任务书（P0–P6 阶段划分），只作追溯 |

**子系统细节**（三进程架构、目录地图、编码约定、SDK 消息适配、rewind/文件快照、编辑器驻留、Codex 协议、浏览器工具等）在归档全文里仍然有效，需要时查 `docs/archive/AGENTS-2026-10-19-full.md`；不要把它当成当前进度或当前产品方向的来源。

## 仍然有效的关键提醒

1. **改 ClaudeRuntime 前先读 stream-json 文档**。schema 来自真实 dump，字段名不要猜。
2. **不要打包 claude.exe**。License 合规：只调用用户已装的，不内嵌二进制。
3. **新增 IPC 必走 zod 校验**。这是 renderer→Node 的唯一安全边界。
4. **本机的 superpowers 插件 hook 是坏的**（SessionStart 报 ParserError），与本项目无关——claude 会跳过它，日志里看到不要当成我们的 bug。
5. **空白屏调试**：main 进程已把 renderer 的 `console-message` 转发到 stderr，不用开 DevTools 就能从启动日志看渲染层报错。

## 产品方向摘要（详见产品路线）

- 最终效果 = Claude 桌面端的 UI；其余能力一律优先复用上游源码做二开。
- 近期四条主线：UI 工作台 / GenOffice 六原生编辑器 / Node-RED 工作流内核 / 共享底层能力。
- 扩展是长期主线，不是近期主线。
- 执行完成 ≠ 验收通过；执行环境由用户选，AI 不调度；AI 可配置但不可自授权。
