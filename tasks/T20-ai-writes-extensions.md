# T20｜AI 写扩展的闭环（生成 → 校验 → 装机 → 可回滚）

- Status: ready-for-agent
- Category: feature
- Priority: P1
- Depends on **T18**（安装权限卡片）与 **T19**（扩展 API 面）。**不得先于两者开工。**
- Exclusive writable files: 新建的扩展工坊模块（主进程 + 渲染端）、其 IPC 契约、新建回归套件。逐个确认后写进回写区。**不改** T18/T19 的文件、`workflowEngines/`、`orchestration/automationRunner.ts`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`lib/worktreeOps.ts`、`arc005-visual-baseline/`。

## Required Skills
- `security-best-practices`: AI 生成的代码要被装进宿主执行，是整个项目最高风险的一环。
- `codebase-design`: 决定闭环的边界——哪些步骤 AI 做、哪些必须用户确认。
- `mcode-smoke`: 建「AI 生成恶意扩展」的负控回归。
- `code-review`: 确认没有任何一步让 AI 绕过用户授权。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/extension-vscode-compat.md`、`docs/planning/mcode-product-roadmap.md`、`tasks/T18-extension-install-permission-card.md`、`tasks/T19-extension-api-surface.md`。

## 产品要求（用户原话）

> 「我想要的是这个扩展可以自己写，把 mcode 的能力都暴露出去……我可以让 mcode 里面的 ai 帮我写插件」

产品路线：

> AI 可以根据用户的自然语言描述**创建、测试、修复并安装扩展**，用户也能自行开发和管理扩展。

## 目标

把「用户说一句 → AI 写出扩展 → 装进 Mcode」做成**有闸门**的闭环，而不是一键装任意代码。

### 闭环必须有的步骤

1. **需求理解 → 清单草案**：AI 产出 `ModuleManifest`（含能力声明与所需权限）。**清单是声明式的，不含可执行代码**。
2. **代码生成**：在受控目录写扩展文件（`permissionedProcessRunner` 管辖的安装位）。
3. **静态校验**（不执行）：清单 schema、权限都在 `MODULE_PERMISSION_NAMES` 内、入口文件存在、没有 `blocked` 档能力的声明。
4. **沙箱冒烟**：用 `permissionedProcessRunner` 真跑一次最小调用，验证扩展能启动、能调一个 `read` 档方法。**沙箱内失败不装机。**
5. **用户确认**：走 T18 的权限卡片。**用户看到的是「这个扩展要干什么 + 要什么权限」，不是源码 diff。**
6. **安装与回滚**：装完记录可回滚点；用户能一键卸载并恢复。

### 安全硬要求

- **AI 不能自己批准安装**。生成的扩展必须经过 T18 的用户确认，AI 无权代签。
- **AI 不能在扩展里声明 `blocked` 档能力**——静态校验必须拒。
- **生成的代码要在隔离进程里跑**，不能进主进程、不能进渲染端主线程。
- **失败可回滚**：装着装着失败，必须回到装之前的状态，不能留半个扩展。
- **不得自动修复后自动重试无限循环**：修复重试要有次数上限，超限交还用户。

### 明确不做

- 不做扩展市场/分发。
- 不做自动签名与可信链。
- 不做 VS Code 扩展的直接生成（那是兼容层，另一条线）。

## 验收判据

1. 用户描述「每次保存文档时备份一份」→ AI 产出清单 + 代码 + **权限需求列表**，停下来等确认。**不经确认不写盘。**
2. AI 生成的清单里写 `blocked` 档能力 → 静态校验拒绝，给出明确错误。
3. 沙箱冒烟失败 → 不装机，回滚干净，无残留目录。
4. 用户拒绝权限 → 不装机。
5. 装机成功后扩展能被 T19 的 API 面调用；卸载后无残留。
6. 修复循环超过上限 → 停下并报告，不无限重试。
7. 变异验证：把「AI 不能自己批准」改成自动批准 → 对应断言必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。

## 结果回写（2026-10-23）

（执行者在此追加：闭环步骤实现、哪些步骤强制人工、沙箱与回滚证据、恶意生成负控、变异证据、提交 SHA、未覆盖项）
