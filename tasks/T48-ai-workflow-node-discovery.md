# T48｜AI 看不见 Node-RED 节点：能跑工作流，但不知道能搭什么

- Status: ready-for-agent
- Category: **feature（P0 产品能力）**
- Priority: **P0 —— 这是「AI 能做工作流」和「AI 现在只能跑别人搭好的」之间的差距**
- Depends on: T8（Node-RED U1）、T21（适配器接线）、T28（x-mcode 往返）
- Exclusive writable files: `apps/desktop/src/main/appControl/tools.ts`（新增工具族）、`apps/desktop/src/main/workflowEngines/engineNodeRegistry.ts`（若需暴露查询）、新建回归套件。

## Required Skills
- `codebase-design`: 判断工具粒度（一个大工具 vs 一族小工具）。
- `mcode-smoke`: 无头回归 + 变异验证。

Read before work: `CLAUDE.md`、`docs/planning/node-red-vendor-integration-map.md`（**第三节「Mcode 能力 ↔ 原厂扩展点」**）、`apps/desktop/src/main/orchestration/nodeTypes.ts`（`BUILTIN_NODE_TYPES`，`nodeTypes.ts:612`）、`apps/desktop/src/main/workflowEngines/engineNodeRegistry.ts`、`apps/desktop/src/main/appControl/tools.ts`（现有 `app_workflow_*` 三个工具）。

## 现状（总控实测，不是推断）

### Node-RED 核心链路已经通了

```
node-red-e2e-smoke                    PASS（vendor runtime/editor 验证）
node-red-deploy-reconciliation-smoke  75/75
workflow-native-load-smoke            18/18
t21-orphaned-adapters-wired-smoke     33/33
mcode-node-pack-smoke                 390/390
```

**原生编辑器入口已接**：`WorkflowNativeEditorEntry.tsx` 有装载确认、脏状态保护、引擎路由（`if (result.ok) dispatchEvent("mcode:native-canvas-loaded")`）。

### 但 AI 侧只有三个工具

```ts
app_workflow_run       运行一个工作流
app_workflow_publish   把工作流发布为派生工具
app_workflow_unpublish 撤销发布
```

**模型能跑工作流、能发布工作流，但完全看不见节点。**

`grep -n "node-red\|nodeRed\|node_red" tools.ts` → **零命中**。
`grep -n "engineNode\|nodeTypes\|node-types" tools.ts` → **零命中**。

### 后果

**用户说「帮我做个每天抓新闻然后总结的工作流」，模型做不了**——它不知道有 `inject` / `http request` / `function` 这些节点，不知道参数，不知道能怎么连。

**它能做的只有「跑用户已经搭好的」和「发布用户已经搭好的」。**

## 目标

**让 AI 能发现、理解、并配置 Node-RED 节点。**

### 必须做到

1. **节点发现**：列出可用节点类型（内置 10 类 + 已批准的第三方 + `mcode-agent` 等 Mcode 原生节点），每个带：
   - 类型名（`inject` / `http request` / `mcode-agent`）；
   - 一句话说明；
   - 属于哪个包（内置 / 第三方 / Mcode）。

2. **节点参数**：给出某个节点的参数表（字段名、类型、默认值、是否必填），并说明**怎么取**（从注册表还是从节点 HTML 解析）。

3. **工作流骨架**：能让模型**创建一个新工作流**的骨架（节点 + 连线），而不是只能改已有的。这一步如果超出本卡边界，**明确标出来另开卡**，不要假装做了。

4. **工具粒度**（要论证）：一个大工具（`workflow_nodes({action:"list"|"describe"|"create"})`）还是三个小工具？参考现有 `document_apps` → `document_tools_list` → `document_tool_describe` → `document_tool_call` 的四层发现模式。

### 明确不做

- **不改** Node-RED vendor 源码。
- **不改** 现有的 `app_workflow_run/publish/unpublish`。
- **不碰** 画布 UI（那条线已经通了）。

## 安全边界（硬要求）

**「AI 能发现和配置节点」不等于「能绕过审批」。**

- 列节点 / 看参数 = **只读**，可以直接给；
- **创建工作流写库 = 要审批**（与 `workflow.save` 同档）；
- **不能**让 AI 自行安装第三方节点（那是 `engineNodeRegistry` 的批准流程，`tools.ts` 的注释里写明「未经批准的 `node-red-contrib-*`」要被拦下）。

**参考现有分档**：`app_api_list` 是只读、`app_api_call` 按方法分档。新工具照这个来。

## 验收判据

1. **回写区先给出「模型现在看不见什么」的实测**（贴 grep 结果，不要推断）。
2. **节点列表能返回内置 10 类**（与 `nodeTypes.ts:612` 的 `BUILTIN_NODE_TYPES` 对齐，有断言）。
3. **某个节点的参数表能取到**（挑一个真实的，比如 `inject`，断言返回里有 `payload` / `topic` 这类字段）。
4. **只读工具在 `APP_READONLY_TOOLS` 里**（有断言）。
5. **写操作走审批档**（有断言，参考 T19/T33 的判据）。
6. **变异验证**：把节点列表改成返回空 → 断言必须红 → `cmp` 还原。
7. 现有 `app_workflow_*` 三个工具不回归；双包 typecheck 通过。

## 边界

- 改 `apps/desktop/src/main/appControl/tools.ts`、`engineNodeRegistry.ts`（若需暴露查询入口）、新建套件。
- **不碰** `documentToolRuntime.ts`（B 的 T47）、`policy.ts`（E 的 T33）、`renderer/`（C）、`electron-u1/`（E 的 T42 挂起中）。
- **不起 Electron**（用户要求）。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**
动手前**必须**先看 `nodeTypes.ts:612` 的 `BUILTIN_NODE_TYPES` 和 `engineNodeRegistry.ts` 实际暴露了什么。

## 提交

`git add <明确路径>` 后**立刻** `git commit -m "<信息>" -- <明确路径>`。**`-m` 必须在 `--` 前面。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T48-ai-workflow-node-discovery.md` 末尾追加 `## 结果回写（2026-10-23）`：现状实测、工具设计论证、断言做法、变异证据、未做的事、提交 SHA。
