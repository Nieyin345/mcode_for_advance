# 内置技能:来源与许可

这个目录随应用一起发布（见 `electron-builder.yml` 的 `extraResources`），
由 `main/plugins/builtinPlugins.ts` 在每一轮对话开始时作为一个**本地插件**
交给 agent SDK，所以用户不需要导入、不需要开关，装好就有。

## 内容

`skills/` 下的四个技能来自 **Anthropic 官方 skills 仓库**（`anthropics/skills`
的 `document-skills` 插件）：

| 技能 | 做什么 |
|------|--------|
| `docx` | Word 文档：读、改、生成（走 pandoc 或直接操作 OOXML） |
| `pptx` | PowerPoint：读、改、生成 |
| `xlsx` | Excel：读、写、改公式 |
| `pdf` | PDF：抽文本、拆并、填表单 |

## 许可（**请勿忽略这一节**）

每个技能目录下的 `LICENSE.txt` 写的是：

> © 2025 Anthropic, PBC. All rights reserved.
> 使用受你与 Anthropic 之间协议的约束（Consumer Terms 或 Commercial Terms）。

这**不是**开源许可，是 source-available。它允许你在自己与 Anthropic 的协议
范围内使用这些材料，但**不授予再分发权**。

具体到这个仓库：

- **自己用、内部用、学术自用** —— 没问题，你就是 Anthropic 的用户，协议覆盖了。
- **把 Mcode 打包成公共 Release 分发（本仓库`.github/workflows/release.yml`
  会往 GitHub Releases 传安装包）—— 存在许可风险**，因为你等于在把 Anthropic 的
  材料转发给不特定的人。

如果这个项目以后要公开发布，二选一：

1. 把 `electron-builder.yml` 里的 `extraResources` 那一段去掉 —— 技能就不再随包
   发布，用户仍可在「设置 → 技能 → 导入」里一键导入（`skills.scanSources` 已经会
   扫 `~/.claude/skills`，而 Anthropic 官方用户那里通常就有）。
2. 或者去拿一份明确允许再分发的授权。

顺带一提：`main/workflows/search-scripts/research-clients/` 里的检索客户端是
**CC-BY-NC-4.0**（非商业），和这里是同一类约束，已经带着各自的 LICENSE/NOTICE。
两者合起来的意思是：**这个仓库目前只适合非商业的自用/内部分发。**

## 更新方式

这四个技能是从 `anthropics/skills` 的 `document-skills` 拷来的原样副本，没有改动。
要更新就重新拉那个仓库覆盖 `skills/`，并把 `plugin.json` 的 `version` 往上抬 ——
版本号变了对用户可见（设置 → 插件 里那一条），是"这份内容换过了"的信号。
