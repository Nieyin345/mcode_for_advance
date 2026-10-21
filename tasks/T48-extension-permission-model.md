# T48｜扩展权限模型：安装时一次性授权，之后直接执行

| 项目 | 值 |
|---|---|
| 编号 | T48 |
| 类型 | **扩展系统主线**（用户：像手机应用一样，装的时候弹权限卡，同意后不再问） |
| 优先级 | **最高** —— 这是「扩展几乎无所不能」的地基 |
| 建议并发 | 改 `packages/contracts/src/modules.ts` + `main/appControl/` + `main/modules/`；**不要与改权限判定的任务并行** |
| 预计规模 | 大 |

---

## 用户的要求（原话）

> 「不是分级，就是装的时候会弹出来的卡片，要的权限，然后用户同意，比如同意一次，比如始终同意，
> 就像是手机的软件一样」

> 「放进去呀，这个扩展也是基本能操作所有的软件内容，都要有接口」

即：
1. **安装时**一次性列出这个扩展要的所有权限
2. 用户**逐项勾选**同意
3. 同意后，扩展调用这些权限覆盖的 API **直接执行，不再弹卡**
4. **连 `danger` 档也包含在内**（删项目、改密钥这类）
5. 扩展要能操作 Mcode 的**所有**内容

---

## 现状（实读，2026-10-21）

### 1. 权限模型只有 3 个值

```ts
// packages/contracts/src/modules.ts:95
export const ModulePermissionListSchema = z
  .array(z.enum(["resource.read", "resource.write", "network"]))
  .min(1).max(3)
```

**这与「能操作所有软件内容」差了三个数量级。**

### 2. RPC 方法有 438 个，分 40+ 个域

实测（`apiCatalog.generated.ts`）：

| 域 | 方法数 | 域 | 方法数 |
|---|---|---|---|
| `library` | 48 | `plugins` | 13 |
| `git` | 25 | `mobile` | 13 |
| `browser` | 21 | `claude` | 12 |
| `workflow` | 20 | `voice` | 11 |
| `skills` | 19 | `file` | 11 |
| `mcp` | 19 | `publicMcp` | 10 |
| `session` | 17 | `automation` | 10 |
| `lsp` | 14 | …其它 25 个域 | … |

### 3. 权限判定的五档

```ts
// main/appControl/policy.ts:15
export type AppPolicyLevel = "read" | "ui" | "write" | "danger" | "blocked";
```

- `read` / `ui` → 自动放行
- `write` → 弹卡（可勾「始终允许」，按**方法**记）
- `danger` → **每次都弹，不给「始终允许」**
- `blocked` → 不开放

**判定顺序**：`BLOCKED` → 凭据本体 → `DANGER` → 显式表 → 按动词猜 → 兜底 `write`。

### 4. 安装 UI 只有两个复选框

```tsx
// renderer/components/modules/ModuleSurface.tsx:74
const result = await api.modules.install({
  manifest, confirmReadAccess: true,
  ...(manifest.program !== undefined ? { confirmExecutableCode: true } : {}),
});
```

`confirmReadAccess` 恒为 `true`（**不是勾选出来的**），`confirmExecutableCode` 只在有可执行程序时才要求。

### 5. 两套权限模型没打通

| | 权限单位 | 收在哪 |
|---|---|---|
| `ModuleHost` | `resource.read` / `resource.write` / `network` | `modules.ts` |
| `panelApiCall` / `app_api_call` | 438 个方法各自五档 | `policy.ts` |

**扩展（ModuleHost）和面板（panelApiCall）走的是两套判定。**

---

## 目标设计

### 权限清单（新的 `ModulePermission`）

从 3 个值扩成**按能力域分组**的清单。每个权限覆盖一组 RPC 方法。

```ts
export const ModulePermissionListSchema = z.array(z.enum([
  // ── 文件与工作区 ──
  "files.read",        // file.* 的读方法、fileSystem.*、workspace 读
  "files.write",       // file.writeFile / 删除 / 重命名
  "files.watch",       // 文件监听（未来）

  // ── 会话与对话 ──
  "session.read",      // session.list / get / messages
  "session.send",      // session.send（让 AI 干活 —— 核心能力）
  "session.control",   // session.interrupt / delete / fork

  // ── 文档（GenOffice）──
  "document.read",     // document.read / capabilities
  "document.edit",     // document.edit / convert / 打开视图

  // ── 资料库 ──
  "library.read",      // library.* 的读方法
  "library.write",     // library 导入 / 删除 / 改分类

  // ── 工作流与自动化 ──
  "workflow.read",
  "workflow.run",      // workflow.run / automation.run
  "workflow.write",    // 改图 / 发布 / 导入

  // ── 项目与 Git ──
  "project.read",
  "project.write",     // 建项目 / 删项目 / 改配置
  "git.read",
  "git.write",         // commit / checkout / push

  // ── 设置与模型 ──
  "setting.read",
  "setting.write",

  // ── 扩展互相调用 ──
  "modules.read",
  "modules.install",   // 装别的扩展 —— 这是最危险的一项

  // ── 系统 ──
  "network",
  "code.execute",      // 可执行程序
  "terminal.run",      // 终端命令
  "browser.control",   // 内嵌浏览器
  "mcp.manage",        // 增删 MCP 服务器
  "hooks.manage",      // 增删钩子
])).min(1)
```

**这是一份起点，不是终稿。** 实现时要对着 438 个方法逐域核对，
确保**每个方法至少能归到一个权限**（不能有「没有权限能覆盖它」的方法）。

### 运行时判定

```
扩展调用方法 M
  ↓
查 M 需要的权限 P（policy.ts 的新映射）
  ↓
查扩展的授权表（安装时用户勾的）
  ↓
P ∈ 授权表 → 直接执行
P ∉ 授权表 → 拒绝，错误消息说「这个扩展没有 P 权限」
```

**注意**：`blocked` 档仍然拒（`claude.approve` 这类「替用户批自己」的方法，
即使扩展声明了也不会授权 —— 见下）。

### `blocked` 的那些怎么办

`policy.ts` 的 `BLOCKED` 表里有一批是**结构性**不允许的：

```ts
"claude.approve": "不能替用户批准工具调用(那等于自己批自己)",
"claude.respondQuestion": "不能替用户回答提问卡",
"workflow.approve": "自动化/导入工作流的执行授权只能由用户本人给",
"hooks.issueHostHookGrant": "插件 hook 的执行授权只能由用户本人在插件面板签发",
"modules.issueWorkflowGrant": "用户模块的工作流运行授权只能由用户在模块设置里授权",
"customModel.getToken": "API Key / 令牌不给模型",
```

**这些是「不能委托」的，不是「权限不够」。** 扩展即使声明了也不给。

理由不是安全洁癖：
- `claude.approve` 授权给它 → 它自己批自己的工具调用 → 审批系统失效
- `workflow.approve` 授权给它 → 它自己给自己发布工作流 → 同样的循环
- `customModel.getToken` → API Key 泄露给第三方代码

**判据**：凡是「代表用户做决定」或「返回凭据本体」的方法，一律不给扩展。
其余全部可授权。

### 安装 UI

```
┌─ 安装「XX 扩展」────────────────────────┐
│                                          │
│  📄 文件                                 │
│    ☑ 读取文件         ☑ 写入文件         │
│                                          │
│  💬 会话                                 │
│    ☑ 读取会话         ☑ 发送消息         │
│                                          │
│  📚 资料库                               │
│    ☑ 读取             ☐ 写入             │
│                                          │
│  ⚙️ 设置                                 │
│    ☐ 读取             ☐ 写入             │
│                                          │
│  ⚠️ 高风险（默认不勾）                    │
│    ☐ 安装其他扩展     ☐ 执行代码         │
│    ☐ 运行终端命令     ☐ 访问网络         │
│                                          │
│  ⛔ 不可授权（灰显）                      │
│    替用户批准审批 / 读取 API Key          │
│                                          │
│  [取消]  [安装]                           │
└──────────────────────────────────────────┘
```

**默认值规则**：
- 只读权限：默认勾选
- 写权限：默认勾选（用户改需求了——「放进去」）
- **高风险（`code.execute` / `terminal.run` / `network` / `modules.install`）：默认不勾**
- `blocked` 的那批：灰显，不可勾

### 安装后

- 授权表落盘（与模块清单同目录）
- 设置页能看到「这个扩展有哪些权限」，能改
- 改权限**不需要重装**（但需要即时生效）

---

## 前置条件（不满足就不要开工）

- **无前置**。可以直接派。
- 但要知道**会有并行任务同时改 `appControl/` 或 `workflowEngines/`**：
  T52 改 `scripts/`，T42/T47 改 `workflowEngines/`，T29 改 `document/`。
  本卡主要改 `packages/contracts/src/modules.ts` + `main/appControl/policy.ts`，
  与它们不重叠；但 `main/appControl/tools.ts` 如果被别的卡改了，
  合入时要以当前内容为准。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/appControl/policy.ts` **全文** ——
   438 个方法的五档判定、`BLOCKED` / `DANGER` / `CREDENTIAL_BEARING` 三张表。
3. `packages/contracts/src/modules.ts` 的 `ModulePermissionListSchema` 与 `ModuleManifestSchema`。
4. `packages/contracts/src/ipc/modules.ts` 的 `ModuleInstallSchema`。
5. `apps/desktop/src/main/modules/ModuleHost.ts` 的
   `validate` / `prepareCapability` / `invoke` / `missingCapabilityPermission`。
6. `apps/desktop/src/main/appControl/tools.ts` 的 `app_api_call` 与 `panelApiCall`。
7. `apps/desktop/src/renderer/components/customUi/panelBridge.ts` 的 `api.call` 分支。
8. `apps/desktop/src/renderer/components/modules/ModuleSurface.tsx` 的安装流程。
9. `apps/desktop/src/main/appControl/apiCatalog.generated.ts` —— **438 个方法的清单**，
   这是权限映射的输入。
10. `apps/desktop/src/main/appControl/apiCatalog.generated.ts` 是生成的，
    要找到生成脚本，看它从哪读的。

---

## 执行内容

### 第 1 步：定义权限清单并建立映射

- 在 `packages/contracts/src/modules.ts` 扩展 `ModulePermissionListSchema`。
- **新建一份映射表**：`方法名 → 权限`。建议放在
  `packages/contracts/src/appPermission.ts`（纯模块，无 electron）。
- **映射规则**：
  - 优先按**域**（`library.*` → `library.read` / `library.write`）
  - 域内再按**动词**分读写（`get` / `list` / `read` → read；`set` / `save` / `remove` → write）
  - **显式表覆盖**：`DANGER` 表里的方法必须映射到「高风险权限」，
    `BLOCKED` 表里的方法映射到 `null`（不可授权）
- **完整性断言**：遍历 438 个方法，每个都必须有映射结果（不能漏）。

### 第 2 步：授权表落盘

- 位置：与模块清单同目录，建议 `module-permissions.json`。
- 形状：

```json
{
  "version": 1,
  "modules": {
    "user.foo": {
      "granted": ["files.read", "files.write", "session.send"],
      "grantedAt": "2026-10-21T...",
      "manifestVersion": "1.0.0"
    }
  }
}
```

- **升级时**：manifest 的 `permissions` 变了 → 旧授权失效，要求重新同意
  （与现有 `executionChanged` 的逻辑同一套）。
- 写盘要原子（照 `service.ts` 现有的 tmp+rename 模式）。

### 第 3 步：运行时判定

改 `ModuleHost.invoke` 与 `panelApiCall`：

```
现在：action 能力 → 每次 requestApproval
改成：查授权表 → 有 → 直接执行
                → 没有 → 拒绝
```

**保留 `blocked` 判定**（结构性不可委托的那批）。

**保留一个例外**：如果扩展**没有**对应权限，且用户在场，可以给「临时授权」
（弹一次卡）。但这要**明确标记**为「这个扩展没声明这个权限，是否临时允许？」

——这条是可选的，先不做也行。

### 第 4 步：安装 UI

`ModuleSurface.tsx` 的安装流程改成：

1. 解析 manifest
2. 读 `manifest.permissions`
3. 渲染权限页（分组、勾选框、默认值）
4. 用户确认 → `api.modules.install({ manifest, grantedPermissions: [...] })`
5. 契约 `ModuleInstallSchema` 增加 `grantedPermissions` 字段

**保留现有的 `confirmExecutableCode`** —— 它是「执行代码」这条权限的显式同意，
与新的权限清单可以合并，但要保持向后兼容。

### 第 5 步：设置页的权限管理

扩展列表里每一项要显示：
- 它声明了哪些权限
- 用户授予了哪些
- 能撤销（撤销后立即生效）

---

## 边界（不要碰）

- **不改 `BLOCKED` 表的内容**（那批是「不可委托」，不是权限问题）。
- 不改 `policy.ts` 的五档语义（新增的是「扩展授权」这一层，不是替换五档）。
- 不改 `ModuleHost` 的子进程隔离与 OS 权限（那是执行层，不是授权层）。
- 不改 `extensionStore`（扩展的私有存储）。
- 不改文档 / 工作流 / Node-RED 相关代码。

---

## 验收判据

1. **438 个方法全部有权限映射**，完整性断言通过（有方法漏了 → 红）。
2. 安装一个声明 3 个权限的扩展，UI 列出 3 项，勾选后安装成功。
3. 扩展调用**已授权**的方法 → 直接执行，**不弹卡**（有断言）。
4. 扩展调用**未授权**的方法 → 拒绝，错误消息点名缺哪个权限（有断言）。
5. `blocked` 的方法 → 即使声明了也拒绝（有断言，至少覆盖
   `claude.approve` / `customModel.getToken` 两个）。
6. 升级扩展且权限变化 → 旧授权失效，要求重新同意（有断言）。
7. 设置页能显示与撤销权限，撤销后立即生效（有断言）。
8. 现有 `module-*` 套件全绿。
9. 双包 tsc 干净。
10. **变异验证**：
    - 撤掉授权检查 → 判据 4 红
    - 撤掉 `blocked` 判定 → 判据 5 红
    - 撤掉升级时的授权失效 → 判据 6 红

---

## 回写区要回答

- 438 个方法分成了多少个权限？有没有归不进去的？
- `BLOCKED` 表里哪些确实是「不可委托」，哪些其实是「权限不够」？
- 授权表落盘的形状与现有 `workflow-grants.json` 能不能统一？
- 升级时权限变化，UI 怎么提示用户？
- 有没有哪个方法**同时需要**两个权限（比如 `document.convert` 既要读又要写）？
- 撤销权限时，正在运行的扩展任务怎么办？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
