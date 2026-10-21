# T49｜扩展调用面：把 438 个 RPC 暴露给扩展

| 项目 | 值 |
|---|---|
| 编号 | T49 |
| 类型 | **扩展系统主线**（用户：扩展要能操作所有的软件内容，都要有接口） |
| 优先级 | **最高** |
| 建议并发 | 改 `main/modules/`；**必须先完成 T48**（权限模型是它的地基） |
| 预计规模 | 中 |

---

## 一句话

T48 让扩展**有权限**调这些 API，T49 让扩展**真能调到**。

现在 `ModuleHost` 只有 **2 个内置能力**：

```ts
export const BUILTIN_CAPABILITY_CATALOGUE = [
  { id: "core.file.inspect", kind: "task",  source: "host" },  // 文件大小 + SHA-256
  { id: "core.file.info",    kind: "query", source: "host" },  // 字节数 + 修改时间
];
```

**扩展能做的事：看文件的哈希。**

---

## 关键发现：面板已经能调全部 RPC

```ts
// renderer/components/customUi/panelBridge.ts:216
case "api.call": {
  // 面板的 `mcode.api.call(method, input)` —— 调**任意**主进程方法。
  // 权限分类在**主进程**（`panelApiCall` 复用 agent `app_api_call` 那一套）
  const first = await api.customUi.panelApiCall({ method, input, panelLabel: label });
  if (!first.ok) {
    if (!first.needsApproval) throw new PanelCallError(...);
    // 弹确认框 → 用户点头 → 带 approved:true 重调
  }
}
```

**这条通路已经存在，而且走的是 `policy.ts` 的完整五档判定。**

但它只对有**面板 UI**的扩展开放。独立脚本（`ModuleHost`）调不到。

**所以 T49 的核心不是「造一条新通路」，是「把这条已有的通路接到 ModuleHost 上」。**

这是仓库硬规矩 2 的直接应用：**共享实现只有一份。**

---

## 目标

扩展能像面板一样调用任意 RPC：

```js
// 扩展的 program.source
export const run = async (resource) => {
  // 读文件
  const content = await mcode.api.call("file.readFile", { projectPath, path });

  // 让 AI 干活
  const session = await mcode.api.call("session.send", { sessionId, prompt: "..." });

  // 跑工作流
  await mcode.api.call("workflow.run", { workflowId });

  // 写结果
  await mcode.api.call("file.writeFile", { projectPath, path, content });

  return { ok: true, bytes: content.length };
};
```

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/appControl/tools.ts` 的 `app_api_call` / `panelApiCall` ——
   **这是要复用的那条实现**。
3. `apps/desktop/src/renderer/components/customUi/panelBridge.ts:216-240` 的
   `api.call` 分支 —— 面板侧怎么调的。
4. `apps/desktop/src/main/appControl/policy.ts` 的 `policyFor` 与五档判定。
5. `apps/desktop/src/main/modules/ModuleHost.ts` 的 `invoke` 与 `Capability` 接口。
6. `apps/desktop/src/main/modules/permissionedProcessRunner.ts` ——
   扩展跑在独立子进程，**不能直接调主进程函数**。
7. `apps/desktop/src/main/modules/vscodeL1Bridge.ts` ——
   现在怎么在子进程里注入 `vscode` 对象（`childL2Snippet`）。
8. T48 的产出 —— 授权表与权限映射。
9. `packages/contracts/src/modules.ts` 的 `ModuleResult` 形状。

---

## 执行内容

### 第 1 步：新的内置能力 `core.app.call`

在 `BUILTIN_CAPABILITY_CATALOGUE` 加一条：

```ts
{ id: "core.app.call", kind: "action", source: "host" }
```

**为什么是 `action` 而不是 `query`**：它能改东西。但注意——这个能力本身
**不代表任何具体权限**，真正的判定在 `policy.ts`（按被调用的方法名）。

它的输入：

```ts
{ method: string, input?: unknown }
```

输出：

```ts
ModuleResult  // 与 app_api_call 同形状
```

**实现必须复用 `invokeAppTool`**，不能另写一份判定。

### 第 2 步：跨进程的调用通路

扩展在**独立子进程**里（`permissionedProcessRunner`），不能直接 import 主进程函数。

现有的通信方式（实读 `permissionedProcessRunner.ts`）：
- 扩展源码与入参经 **stdin** 送入
- 结果经 **stdout** 单行协议回传

**这是一个一次性的请求/响应，不是双向通道。**

要做 `mcode.api.call`，需要扩展在运行期间**多次**向主进程请求。

两条路：

- **A：扩展程序改成可多次调用**
  现在 `program.source` 求值出一个 `{ [短名]: async (resource) => result }`，
  每次 invoke 调一次就结束。改成扩展能在一个运行里多次 call。

- **B：主进程预取**
  一次性把所有需要的数据喂给扩展，扩展算完一次性返回。
  但这样扩展**不能主动让 AI 干活**（`session.send` 是长任务）。

**必须走 A。**

实现方式：把 `stdout` 单行协议扩成 **NDJSON 双向通道** —— 扩展发一行
`{"__mcode_call": 1, "id": 1, "method": "...", "input": {...}}`，
主进程回一行 `{"__mcode_reply": 1, "id": 1, "ok": true, "result": ...}`。

**注意**：现有的 `NETWORK_GUARD`、`--permission` 限制不能因此松动。
扩展仍然不能 `require("http")`。它只能经这条通道请求。

### 第 3 步：`vscode` 对象的扩展（可选，取决于 T50）

如果同时做 VS Code 兼容，`vscode.*` 的每个 API 也要走同一条通道。
但**本卡只做 `mcode.api.call`**，`vscode.*` 是 T50 的事。

### 第 4 步：权限判定的接线

`core.app.call` 的一次调用要经过：

```
1. 扩展有没有 core.app.call 这个能力？（ModuleHost 的既有判定）
2. 被调用的方法 M 需要哪个权限？（T48 的映射）
3. 扩展的授权表里有没有那个权限？（T48 的授权表）
4. M 是不是 blocked？（policy.ts 的 BLOCKED 表）
5. M 是否需要额外的资源授权？（authorize(resource)）
```

**第 2/3/4 步全部复用 T48 与 `policy.ts`，不另写。**

### 第 5 步：给 AI 写插件用的文档

**这是用户明确要的**：「我可以让 mcode 里面的 ai 帮我写插件」。

在 `app_guide` 里加一个 topic：`extensions`。内容包括：
- 扩展清单的形状（`ModuleManifestSchema`）
- 可用的权限清单（T48 的）
- `mcode.api.call` 的用法 + 常用的 10 个方法示例
- 一个最小可用的扩展模板

**AI 写插件时先读这个 topic，就能知道怎么写。**

---

## 边界（不要碰）

- **不新建第二套权限判定**（复用 `policy.ts` + T48 的映射）。
- 不放松 `NETWORK_GUARD` 与 `--permission`。
- 不改 `blocked` 表。
- 不改面板桥（`panelBridge.ts`）—— 它是另一条通路，两边共用判定即可。
- 不改文档 / 工作流 / Node-RED 相关代码。

---

## 验收判据

1. 一个扩展能调用 `file.readFile` 读到真实文件内容（有断言）。
2. 一个扩展能调用 `session.send` 让 AI 回一句话（有断言，可用假 provider）。
3. 调用**未授权**的方法 → 拒绝，且错误消息点名缺哪个权限（有断言）。
4. 调用 `blocked` 的方法 → 拒绝（有断言）。
5. 扩展**不能** `require("http")` / `require("child_process")`（既有断言不回归）。
6. 长任务（如 `session.send`）期间，取消信号能传到扩展（有断言）。
7. `app_guide` 的 `extensions` topic 能被 `app_guide { topic: "extensions" }` 读到。
8. 现有 `module-*` 套件全绿。
9. 双包 tsc 干净。
10. **变异验证**：撤掉权限检查 → 判据 3 红；撤掉 `blocked` 判定 → 判据 4 红；
    撤掉取消传播 → 判据 6 红。

---

## 回写区要回答

- 双向 NDJSON 通道对现有的一次性协议有没有破坏？（`isolated_timeout` /
  `isolated_cancelled` 这些失败码还成立吗）
- 扩展在一个运行里能发多少次 `api.call`？有没有上限？
- `session.send` 这种长任务，扩展怎么知道进度？
- 扩展能不能调 `mcode.api.call` 访问**别的扩展**的 storage？
- AI 用 `app_guide` 的 `extensions` topic 能不能真的写出一个能跑的扩展？
  （让 AI 试一次，把结果写进回写区）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
