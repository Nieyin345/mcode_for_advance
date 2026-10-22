# 已安装的 Skill（本机 `.claude/skills/`）

> **为什么这份清单在版本库里，而 skill 本身不在：** `.gitignore:55` 整个忽略 `.claude/`，里面可能含本机路径和个人配置。但「这个仓库的工作流依赖哪些 skill」这件事必须可追溯——否则换机器后无法复原，也无法判断某个流程产出为什么长成那样。
>
> 本文件只记**名字、来源、用途、是否由模型自行调用**，不复制 skill 正文。正文以本机 `.claude/skills/<name>/SKILL.md` 为准。
>
> 采集时间：2026-10-23。skill 集合变动时更新本表，不要改成自动生成——变更应当有意识。

## 本仓库自有

| Skill | 调用方 | 用途 |
|---|---|---|
| `mcode-smoke` | 模型 | Mcode 无头 smoke 的写法：esbuild 打包 + `--alias` 换桩 + `fakeIpc`；隔离会动磁盘/数据的代码；变异验证。也回答「改这个文件该跑哪几套」。**这个仓库改主进程代码必读。** |

## 领域补充（2026-10-23 新增）

按六条主线的实际缺口装的，每个都直接服务具体任务卡。

| Skill | 许可 | 服务哪张卡 | 用途 |
|---|---|---|---|
| `playwright-skill` | MIT（testdino.com, v2.8.0） | **T16**、T7、T8 | 79 份 Playwright 1.64 参考：locator、断言、fixture、视觉回归、CI 分片、trace 分析。**Electron 测试的评估基准。** |
| `dependency-license-audit` | Apache-2.0 | **T10**、T11 | 只读依赖许可审计，按策略（ASF A/B/X 或 allowlist）分类。**不修改 manifest/lockfile**，与本仓库的 release gate 不冲突。 |

**还没装的缺口**（按价值排序）：VS Code 扩展 API 兼容、Node-RED 节点开发。前者可由 `docs/planning/extension-vscode-compat.md` 的 19KB 分级表部分顶替；后者目前靠读 `node-red/` 上游源码。

## Matt Pocock 工程技能（第三方）

来源：`setup-matt-pocock-skills` 安装的一整套。分两组，区别是能否由模型自行触发。

**模型可自行调用（20 个）**

| Skill | 用途 |
|---|---|
| `code-review` | 从固定点起的双轴审查（Standards / Spec），两个子代理并行 |
| `codebase-design` | 深模块设计词汇：接口、接缝、可测试性 |
| `diagnosing-bugs` | 难 bug 与性能回归的诊断循环 |
| `domain-modeling` | 领域模型、`GLOSSARY.md`、ADR |
| `frontend-design` | 有辨识度的视觉设计方向 |
| `git-guardrails-claude-code` | 配 hook 拦危险 git 命令 |
| `grilling` | 设计树式追问，按轮推进 frontier |
| `mcp-builder` | 建高质量 MCP server |
| `migrate-to-shoehorn` | 测试里的 `as` 断言迁到 shoehorn |
| `pr` | 写 PR 正文 |
| `prototype` | 一次性原型回答设计问题 |
| `research` | 高可信一手来源调研，产出 Markdown |
| `scaffold-exercises` | 造练习目录结构 |
| `security-best-practices` | 语言/框架级安全审查 |
| `setup-pre-commit` | Husky + lint-staged + 类型检查 + 测试 |
| `skill-creator` | 建/改/评测 skill |
| `tdd` | 测试先行；红-绿-重构；集成测试 |
| `wizard` | 生成交互式 bash 向导（只人做得了的步骤） |
| `writing-for-agents` | 写给 agent 的文档（skill、AGENTS.md、CLAUDE.md） |
| `claude-api` | Claude API / Anthropic SDK 参考（模型 id、价格、缓存、工具、MCP） |

**仅用户 `/` 触发（23 个）**

| Skill | 用途 | 本仓库用在哪 |
|---|---|---|
| `setup-matt-pocock-skills` | 初始化 issue tracker / triage 标签 / 领域文档 | ✅ 产出 `docs/agents/` 三份 |
| `grill-me` | 只调用 `grilling` 的入口 | ✅ 产出 Q1–Q51 决策 |
| `grill-with-docs` | 追问同时产出 ADR + 术语表 | 未用（本仓库无 `docs/adr/`） |
| `to-spec` | 把对话整理成 spec 并发布 | ✅ 产出 `.scratch/mcode-product-roadmap/spec.md` |
| `to-tickets` | 把 spec 拆成带阻塞边的票 | ✅ 产出 `issues/12-15` + `tasks/T12-T15` |
| `wayfinder` | 跨会话大工程的决策地图 | ✅ 产出 `map.md` |
| `triage` | 议题状态机、分类、验证 | — |
| `ask-matt` | 路由到合适的 skill | — |
| `chief-of-staff` | 单会话长目标，协调子代理 | — |
| `handoff` | 压缩对话成交接文档 | — |
| `claude-handoff` | 移交给后台代理继续 | — |
| `implement` | 按 spec 或票实现 | — |
| `implement-spec` | 实现 `/to-spec` + `/to-tickets` 的产物 | — |
| `improve-codebase-architecture` | 扫深模块机会，出 HTML 报告再追问 | — |
| `loop-me` | 追问出 `workflows/*.md` 工作流规格 | — |
| `retro` | 编码会话复盘 | — |
| `setup-ts-deep-modules` | dependency-cruiser 配深模块边界 | — |
| `teach` | 教学 | — |
| `to-questionnaire` | 答不了的决策转成问卷 | — |
| `wait-what` | 「刚才没听懂，重讲」 | — |
| `writing-beats` | 写作：把素材组装成段落旅程 | — |
| `writing-fragments` | 写作：挖掘原始碎片，先不定结构 | — |
| `writing-shape` | 写作：把素材塑形成文章，逐段推进 | — |

## 与本仓库治理的关系

- **`.scratch/` 的票格式由 `docs/agents/issue-tracker.md` 规定**，那份文档由 `setup-matt-pocock-skills` 产出。
- **`tasks/T*.md` 的 Required Skills 只从上面这些名字里选**，不许写不存在或未安装的 skill。
- **skill 不授权扩大范围**：`code-review`、`research` 等会在自己的流程里开子代理，但任务卡的独占写入边界仍然有效，skill 不得越过。
- 换机器后：先装回 `mcode-smoke`（本仓库自有），再按本表补第三方集合；`docs/agents/` 三份文档在版本库里，不需要重跑 `setup-matt-pocock-skills`，除非要换 issue tracker。
