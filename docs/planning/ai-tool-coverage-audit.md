# AI 工具覆盖审计（T50）

> 日期：2026-10-23 ｜ 只读审计，不改代码 ｜ 全程未启动 Electron
>
> **一句话结论：没有覆盖缺口。** 模型能调到的 RPC 方法集**严格包含**主进程提供的全部方法。
> 真正的问题不是「AI 做不到用户能做的事」，而是**反过来**——它能做的事远多于用户以为它该做的。

## 一、方法面：452 / 452

用 `apiEntries()`（`app_api_call` 的**真实**枚举函数，不是文本搜索）对比
`RpcMap` 接口体：

```
RpcMap 真实方法                                  452
app_api_call 可见                                453
RpcMap 有、但 app_api_call 看不到                    0
```

- `apiEntries()` 的来源是 `API_CATALOG`（生成的说明清单）**并上**
  `registeredRpcChannels()`（运行时实际注册的 IPC 通道）。所以它比 `RpcMap` 还可能多
  ——那个多出来的 1 个就是这么来的。
- **结论成立的前提**：`registeredRpcChannels()` 在真机里返回全部注册通道。本审计用的是
  无头桩（Electron 被替换），所以桩里返回空集合。**但这不影响上面的差值**：
  `API_CATALOG` 本身已经覆盖 452 个方法中的全部。

**方法：** 我一开始用正则扫 `packages/contracts/src/ipc/*.ts`，得到 542 个「方法名」，
其中 90 个是**假的**（从注释、常量名、`AGENTS.md` 这类字符串里误抓的，例如
`ui.accentColor`、`tokens.txt`）。改用 `RpcMap` 接口体的行首模式后是 452 个。
**这个坑值得记：文本扫描会被注释和常量骗，要扫结构。**

## 二、档位：模型能调 ≠ 模型能随便调

453 个方法按 `policyFor()` 的实际档位：

| 档位 | 数量 | 含义 |
|---|---|---|
| `read` | **138** | 自动放行，不弹卡 |
| `write` | **143** | 弹卡，用户可「始终允许」 |
| `danger` | **94** | 每次都要问，不可记住 |
| `blocked` | **74** | 模型拿不到（连用户也不能通过 AI 走） |
| `ui` | 4 | 界面动作（打开面板等） |

**74 个 blocked 是刻意的闸门**，不是缺口。抽样核对过其中几条的理由：

- `setting.importFromFile` / `setting.exportToFile` —— 整库导入导出，误操作代价大；
- `unattended.approve` / `unattended.run` —— 批准无人值守计划等于自己给自己授权建会话；
- `workflow.approve` —— 审批工作流修订是「用户点头」这件事本身；
- `session.saveMessages` / `session.truncateAndInsertMessages` / `session.upsertMessages`
  —— 直接改对话存储，破坏证据链；
- `file.pickImages`、`dialog.*`、`documentView.*` 的 6 条 —— 需要真人操作系统对话框/窗口。

**这些是设计，不是遗漏。**

## 三、对照表：用户能做的事 vs 模型能不能做

| 用户在界面上能做的事 | 模型能做吗 | 通过什么 |
|---|---|---|
| 建/改/归档/删除项目 | ✅ | `project.create` / `.rename` / `.archive` / `.delete`(danger) |
| 改设置 | ✅ | `setting.set`（danger，**每次问**） |
| 管理技能、装市场技能 | ✅ | `skills.list` / `.import` / `.marketInstall` / `.delete`(danger) |
| 管理插件 | ✅ | `plugins.list` / `.installLocal`(danger) / `.remove`(danger) |
| 看运行历史、用量 | ✅ | `runs.list` / `usage.stats` / `monitoring.status` |
| 工作流建/改/跑 | ✅ | `workflow.list` / `.save` / `.import` / `.run` |
| 资料库全部操作 | ✅ | `library.*` 48 个方法 |
| 看项目最近的提交 | ✅ | `git.log` / `git.status` / `git.diff` / `git.show`（全部 read） |
| 整理文件 | ✅ | `file.listDir` / `.readFile` / `.writeFile` / `.rename` / `.copy` / `.delete`(danger) |
| 浏览器（标签、书签、历史、截图） | ✅ | `browser.*` 21 个方法 |
| 终端 | ✅ | `terminal.create` / `.kill` / `.list` |
| **改快捷键** | ⚠️ **绕道可达** | 无专用方法，走 `setting.set({key:"ui.shortcuts"})`（danger） |
| **改鼠标手势** | ⚠️ **绕道可达** | 无专用方法，走 `setting.set({key:"ui.gestures"})`（danger） |
| **改标题生成开关/模型** | ⚠️ **绕道可达** | 无专用方法，走 `setting.set({key:"ui.titleGenEnabled"|"ui.titleGenModel"})`（danger） |

**「绕道可达」不是缺失。** 这三个是**低频、结构化的 UI 偏好**，做成专用工具反而增加
工具面（模型要为此多读一份 schema），而 `setting.set` 已经能到、且是 danger 档（每次问）。
**判断：不需要开卡。**

## 四、⚠️ 反向问题：模型能做的事**远多于**用户以为的

这才是这次审计真正的产出。

**用户说「帮我把这个设置改成 X」时，他大概不知道自己同时授权了什么。**
`setting.set` 是 danger 档，会弹卡 —— 但卡上写的是「设置 X 为 Y」，而
**同一个方法可以改 452 个方法里任何一条设置**，包括：

- `ui.shortcuts`（快捷键）、`ui.gestures`（手势）—— 改掉用户的操作习惯；
- `mobile.pairedDevices`（已配对设备）—— 配对是明文存储的（`MOBILE` 域 13 个方法）；
- 各引擎的 API 地址/密钥（`customModel` / `codexModels` / `piModels` 的 set 方法）；
- `plugins.*` 的投递策略。

**卡上写「改设置」不告诉用户改的是哪一条，是审批卡的信息缺口。**
这不是「AI 能力过强」，是**审批呈现的粒度与能力粒度不匹配**。

**建议（需产品决策，本次未改）**：审批卡上把具体的 setting key 与「这条设置控制什么」
一起显示。`app_api_describe` 里已经有针对单条 key 的专文先例
（`tools.ts:210-211` 对 `CUSTOM_UI_SETTING_KEY` 的特判），说明「按 key 给出说明」
这条路是通的，缺的只是把它接到审批卡上。

## 五、最痛的三个问题（重新排序）

原任务书假设的方向是「AI 做不到用户能做的事」。**实测下来这个方向不成立**，
所以按实际证据重排：

### 1. 审批卡不告诉用户「改的是哪条设置」

- **用户会怎么说**：「帮我把自动归档关掉」
- **现状**：模型调 `setting.set`，卡上显示「设置」。用户不知道它写的是哪一条、
  以及那条控制什么。
- **为什么是问题**：`setting.set` 能写全部设置 —— 一张写着「设置」的卡，
  授权范围覆盖 452 个方法能触碰的一切配置。

### 2. 模型能改自己的运行参数，且没有单独的闸

- **先更正一个措辞**：`runtime.turnBudget`（`settings.ts:145`）与
  `workflow.maxParallel`（`settings.ts:454`）是**设置键**，不是 RPC 方法 ——
  它们通过 `setting.set` 到达，不是独立方法。我第一版报告把这两类混写了。
- **路径**：`setting.set`（danger 档，每次问）可以写这两条键。
- **用户会怎么说**：「让它别老是用这么贵的模型」——听起来是**限制**它，
  实际是**让它改自己的成本/并行参数**。
- **现状**：有条档位（danger），但**审批卡上不会显示「这是 AI 在配置 AI 自己」**。

### 3. 三个「绕道可达」的 UI 偏好（快捷键/手势/标题生成）

- **用户会怎么说**：「帮我把截图快捷键改成 Ctrl+Shift+S」
- **现状**：做得到，但要模型知道 `ui.shortcuts` 这个键的 JSON 结构 ——
  没有专用 schema，模型得先 `setting.get` 猜结构。
- **为什么算「痛」而不是「缺陷」**：不是做不到，是**容易做错**（结构化 JSON 盲写）。

## 六、刻意不给的（确认是设计）

| 能力 | 为什么不给 |
|---|---|
| `unattended.approve` / `unattended.run` | 批准计划 = 自己给自己授权建会话 |
| `workflow.approve` | 审批修订是「用户点头」这件事本身 |
| `setting.importFromFile` / `exportToFile` | 整库吞吐，误操作不可逆 |
| `session.saveMessages` / `truncateAndInsertMessages` / `upsertMessages` | 直接改对话存储，破坏证据 |
| `dialog.*` / `file.pickImages` / `documentView.*`(6 条) | 需要真人操作系统对话框或窗口 |
| `plugins.install*` / `skills.import*` 等 | **给得起，但都是 danger 档**（每次问），不是不给 |

## 七、方法说明（可复现）

```bash
# 真实枚举（不是文本扫描）
cat > .tmp/probe.ts <<'TS'
import { apiEntries } from "@main/appControl/tools.js";
console.log(apiEntries().length);
TS
# esbuild 打包时需要 electron/dataRoot/logger/vendor 的桩 —— 见任何一套 smoke 的 run.sh
```

**关键教训**：`grep` 方法名会被注释和常量骗（我第一次数出 542，真值是 452）。
要对比「模型能看到什么」，必须打**真函数**。
