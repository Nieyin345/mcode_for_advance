# UI 模块平台：第一阶段

> 更新（2026-09-27）：能力目录与受控工作流节点已在第二阶段接入。当前用法、授权差异与验证边界见 [第二阶段说明](ui-module-platform-phase2.md)；本页保留第一阶段的菜单/清单及历史验证记录。

总体架构、外部库策略、性能与分阶段路线见 [统一 UI 模块平台设计方案](ui-module-platform-design.md)。

## 状态与范围

这是一个最小的原生 UI 扩展闭环，不是完整低代码平台，也不是任意代码沙箱。

本轮接入：文件面板的「UI 扩展」管理入口 → 严格 JSON 模块清单 → 文件右键菜单 → 统一能力宿主 → 原生结果对话框 / 本工作区任务历史。内置模块和用户导入模块使用同一个清单、注册中心、能力实现和结果渲染器。

当前不提供：任意 React/HTML 页面、DOM 注入、Python/Node 外部模块执行、npm/pip 安装、写入/命令能力、完整应用数据 CRUD、详情页常驻标签、移动端执行、任务跨应用重启恢复。这些必须在相同契约上继续实现，不能把本阶段描述成全部完成。

## 如何使用

1. 重启开发应用的主进程 / preload，打开一个已登记的本地项目。
2. 打开右侧「文件」面板，右键一个文件，选择内置文件检查项。
3. 结果面板显示任务状态、进度、字节数和 SHA-256；关闭面板不会取消任务。
4. 点文件面板标题栏的「UI 扩展」，编辑预置 JSON 示例。可改模块 ID、标题、菜单文字、文件后缀筛选，以及结果字段和标签。
5. 明确勾选只读访问确认，再导入。相同模块 ID 会替换清单；无需执行模块脚本。
6. 再次右键符合后缀条件的文件，可以看到自定义菜单。
7. 在扩展管理窗口的任务历史中重新打开结果，或移除用户模块。内置模块不能移除。

示例见 `examples/ui-modules/file-report.json`。第一阶段的展示方式是原生结果对话框，不是已经实现了可嵌套的任意网页。

## 文件与调用路径

- `packages/contracts/src/modules.ts`：清单、资源引用、结果、任务、请求结构与示例。
- `packages/contracts/src/moduleClient.ts`：与传输无关的绑定客户端。绑定 ID 只是便捷 API，不是身份认证。
- `packages/contracts/src/ipc/modules.ts`、RpcMap、preload：七个明确的 RPC 通道。
- `main/modules/ModuleHost.ts`：能力注册、清单验证、安装事务、调用、任务快照、取消和幂等。
- `main/modules/fileCapabilities.ts`：内置文件能力和真实路径校验，独立于 Electron / 用户数据库，可用临时目录测试。
- `main/modules/service.ts`：懒加载宿主，以及数据根下的模块清单持久化。
- `renderer/components/modules/ModuleSurface.tsx`：原生菜单贡献、管理入口、声明式字段渲染、任务轮询。
- `FilesPanel` 提供项目作用域；`FileTree` 的文件菜单挂载 `ModuleMenuItems`，不是操作 DOM 插入按钮。

```text
FilesPanel / FileTree
        ↓
ModuleSurface + createModuleClient
        ↓
api.modules → preload → modules IPC
        ↓
ModuleHost → 已注册能力
        ↓
任务快照 / 标量结果 → 原生结果面板
```

第一阶段没有新增工作流 runner；第二阶段现已通过 `module-capability` 接入同一个宿主，且仅开放真实登记的只读内置贡献。用户模块菜单授权不等于自动化授权。既有 code/command 节点执行方式没有改造。

## 已公开的能力

| ID | 类别 | 输入 | 输出 |
|---|---|---|---|
| `core.file.inspect` | task | `{ projectPath, path }` | `{ bytes, sha256 }` |
| `core.file.info` | query | 同上 | `{ bytes, modifiedAt }` |

用户清单引用既有能力，不能用清单自行注册可执行函数。类型层预留 action 类别，但 v1 清单验证明确拒绝 action，未开放写权限。

客户端用法（桌面宿主可信组件）：

```ts
const client = createModuleClient(api.modules, moduleId);
const reply = await client.invoke(contributionId, resource, requestId);
// reply.type === "task"：保存任务 ID，通过 client.task(id) 读取快照。
// 必要时 await client.cancel(id)。重试同一次请求时沿用 requestId。
```

同一个请求 ID 只能对应同一个清单定义、贡献及资源；任务在保留窗口内去重。不承诺跨应用重启或已淘汰任务的 exactly-once。

## 安全与资源边界

- 外部清单必须使用 `user.` 命名空间；`core.` 保留给宿主。严格 schema 拒绝脚本、未知权限与未知扩展点。
- 只有 `resource.read`；安装 RPC 要求显式确认。用户模块不会自动运行，只由可信宿主菜单触发。
- 后端重新检查已登记工作区、真实路径及符号链接目标；拒绝越界和非普通文件。扩展后缀条件也在后端复核。
- 文件检查最多 32 MiB，64 KiB 分块读取；读取前后检查文件是否变化。最多同时 4 个任务，保留最近最多 64 个任务，任务超时 30 秒。
- 取消/超时之后的迟到进度和结果不能将任务改回成功。移除模块会取消它仍在运行的任务。
- 清单数量、文本大小、结果大小受限；安装写盘成功后才更新内存目录，失败保留旧定义。
- 清单保存在 `<dataRoot>/ui-modules/manifests.json`，临时文件写入、文件 fsync 后同目录 rename。损坏的清单显式报错，不静默清空。没有承诺所有文件系统的断电持久性。
- 任务与结果仅在主进程内存中；面板关闭/重挂载后可恢复，但应用退出后不可恢复。
- 前端按文本渲染标签和结果，不使用 HTML 注入、eval、任意 import。
- 模块 RPC 当前仅桌面可用；webApi 有明确的不可用实现，没有扩大手机端白名单。
- 这不是不受信任代码的安全沙箱：外部可执行代码尚未开放。未来若引入隔离网页/进程，调用主体必须来自宿主连接，不能信任请求里的 moduleId。
- 前端用快照轮询（打开任务面板时约 500 ms），并非已经实现跨进程通用事件订阅协议。

## 验证

```sh
node apps/desktop/scripts/module-platform-smoke/build.mjs
node apps/desktop/scripts/module-ui-smoke/build.mjs
```

- 后端专项：清单边界、保留命名空间、能力白名单、授权、保存失败、幂等、任务隔离、取消竞态、内置/外部共用、SDK、真实临时文件、越界、symlink/junction、查询、IPC 路由及安装确认。
- 初始缺失宿主时用例失败；临时测试 bundle 去掉授权后，路径越界断言失败。撤销仅发生在测试 bundle，不修改生产文件。
- 浏览器专项：真实 ModuleSurface、ContextMenu、Dialog、CSS，借助测试传输适配连接真实 ModuleHost 与文件能力，计算临时文件的真实 SHA-256；不是预制结果。覆盖内置菜单、外部 JSON 导入、结果字段、UI 卸载、任务历史和移除。
- 浏览器仅运行独立 profile，不连接用户浏览器；不调用真实模型、用户数据库或真实数据根。原生 WebContentsView 遮挡 hook 在浏览器测试中替身，Electron 安装包及实机遮挡仍需验证。
- 浏览器 fixture 直接组合扩展组件；生产 FileTree/FilesPanel 的小范围挂载改动需结合类型、接线测试和实机验收，不把 fixture 当作完整桌面验收。

门禁结果（2026-09-27，全量启动时 HEAD 为 `fd97e61`）：

| 检查 | 结果 |
|---|---|
| `node apps/desktop/scripts/run-smokes.mjs --all` | **106 套通过，0 失败，退出码 0** |
| 本阶段后端 / IPC / SDK 专项（已包含在全量中） | **33 / 33 通过** |
| 本阶段真实浏览器专项（已包含在全量中） | **8 / 8 通过** |
| desktop TypeScript `--noEmit` | **退出码 0** |
| contracts TypeScript `--noEmit` | **退出码 0** |
| 并行改动后的关联补跑 | **6 套通过，0 失败，退出码 0** |

双包检查分别使用各自已安装的 `typescript/bin/tsc`，传入 `--noEmit -p apps/desktop/tsconfig.json` / `--noEmit -p packages/contracts/tsconfig.json`。本轮没有安装新依赖。

本次完整运行的逐套日志位于 `apps/desktop/.tmp/smoke-runs/1790473084211-30352-ubQYD8/`；总日志与最终退出状态另存 `.tmp/module-verification-all-ZgffSJ/output.log` 和 `result.json`。这些是本地临时验证产物，不是模块运行依赖，也不随源码提交。以上自动验证不替代前述 Electron 实机验收。

共享工作区在全量运行期间有其他对话的提交及未提交改动，未冻结为独立快照；因此以上是一次实际运行记录，而不是对某个固定提交的完整认证。收尾发现共享 `RpcMap` 新增工作流保存 `warnings` 字段后，保留该改动，并重新通过 desktop / contracts 类型检查及 `module-platform-smoke`、`module-ui-smoke`、`ipc-parity-smoke`、`ipc-wiring-smoke`、`engine-regressions-smoke`、`mcp-ipc-smoke` 六套检查。补跑记录为 `.tmp/module-verification-focused-165tNR/`。

## 后续阶段

1. **已接入第二阶段：** 能力 metadata/输入输出结构、宿主工作流目标、原生目录与受控能力调用节点。正式候选验证见 `parallel-ui-modules/integration.md`，不是用下文第一阶段历史的 106 套结果替代。
2. 增加详情标签、工具栏和独立页面扩展点，以及生命周期 / 清单版本兼容机制。
3. 增加应用独立数据存储、任务持久化、事件订阅与重连。
4. 再做受管理 Node/Python 环境、锁文件与依赖安装；把可信本地代码和受限第三方代码的安全模型明确分开。
5. 自由前端在隔离容器中使用同一能力协议，AI / 可视化编辑器作为模块生产工具接入。
