# T51｜让 Mcode 的 AI 会写扩展：文档、模板、校验闭环

| 项目 | 值 |
|---|---|
| 编号 | T51 |
| 类型 | **扩展系统主线**（用户：我可以让 mcode 里面的 ai 帮我写插件） |
| 优先级 | **最高** —— 这是用户要求里最关键的一条 |
| 建议并发 | 改 `main/appControl/` + `contracts/`；**先完成 T48、T49** |
| 预计规模 | 中 |

---

## 用户的要求（原话）

> 「我可以让mcode里面的ai帮我写插件，明白吗，而且尽可能的自定义，
> 就是像vscode的扩展系统一个几乎无所不能」

**这不是「让扩展系统更强」，是「让 AI 能自己造扩展」。**

两者差别很大：前者是能力问题，后者是**AI 能不能获得足够的上下文与工具**。

---

## 现在的 AI 能做什么、不能做什么

### 能做的

Mcode 的 agent 已经有：
- `read_file` / `write_file` / `edit_file`（读写工作区文件）
- `app_guide`（读文档）
- `app_api_list` / `app_api_describe`（查 438 个 RPC）
- `app_api_call`（调 RPC）
- 三引擎（Claude / Pi / Codex）

### 不能做的

1. **不知道扩展该长什么样** —— `app_guide` 里没有 `extensions` topic
2. **不知道有哪些权限可用** —— T48 之前只有 3 个
3. **写完了不知道怎么装** —— `modules.install` 是 `danger` 档，每次弹卡
4. **装完不知道对不对** —— 没有校验工具

---

## 目标：一个完整的闭环

```
用户：「帮我写一个扩展，能在文件右键加一个『统计行数』」
  ↓
AI 读 app_guide { topic: "extensions" }  ← 知道扩展长什么样
  ↓
AI 读 app_api_list 查有哪些方法可用
  ↓
AI 写 manifest.json + program.js 到工作区
  ↓
AI 调 extension_validate 检查（新增工具）    ← 在安装前就能知道对不对
  ↓
AI 调 modules.install 安装（用户看一眼权限卡）
  ↓
AI 调能力验证能跑
  ↓
AI 告诉用户「装好了，右键文件就能用」
```

**每一步现在都有对应的工具，除了第 4 步（`extension_validate`）。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/appControl/appApiTutorials.ts` —— **现有 tutorial 的写法**，
   本卡要照它的结构加一个 `extensions` topic。
3. `apps/desktop/src/main/appControl/tools.ts` 的 `app_guide` / `app_api_list` /
   `app_api_describe` / `app_api_call`。
4. `packages/contracts/src/modules.ts` 的 `ModuleManifestSchema`。
5. `apps/desktop/src/main/modules/ModuleHost.ts` 的 `validate` / `install` /
   `verifyProgram` —— **校验逻辑已经存在**，本卡要把它的「试装」暴露给 AI。
6. T48 的权限清单、T49 的 `core.app.call`、T50 的贡献点。
7. `apps/desktop/src/main/mcp/mcodeServer.ts` —— Mcode 自己的 MCP server，
   AI 是通过它拿到这些工具的。

---

## 执行内容

### 1. `app_guide { topic: "extensions" }`

在 `appApiTutorials.ts` 加一个 topic，内容**必须**包括：

**a) 扩展的清单形状**

```json
{
  "apiVersion": 1,
  "id": "user.line-counter",
  "version": "1.0.0",
  "title": { "zh": "行数统计", "en": "Line counter" },
  "permissions": ["files.read", "session.send"],
  "contributions": [{
    "id": "count",
    "slot": "files.context",
    "title": { "zh": "统计行数", "en": "Count lines" },
    "extensions": [".ts", ".js", ".md"],
    "capability": "module.count"
  }],
  "program": {
    "source": "exports.count = async (resource) => { ... }",
    "timeoutMs": 10000
  }
}
```

**b) 可用的权限清单**（T48 的，带说明）

**c) 扩展能调哪些方法**

不是列 438 个（太长），是给**常用方法表 + 怎么查其余**：

| 常用方法 | 用途 |
|---|---|
| `file.readFile` / `file.writeFile` | 读写文件 |
| `session.send` | 让 AI 干活 |
| `workflow.run` | 跑工作流 |
| `library.search` | 搜资料库 |
| `extensionStore.get` / `set` | 存自己的数据 |
| `document.read` | 读文档 |
| … | `app_api_list` 查全部 |

**d) 一个完整可跑的最小示例**

```js
// program.source —— 一个真的能用的扩展
exports.count = async (resource) => {
  const text = await mcode.api.call("file.readFile", {
    projectPath: resource.projectPath,
    path: resource.path,
  });
  const lines = text.content.split("\n").length;
  return { ok: true, fields: { lines } };
};
```

**e) 常见错误**

- 忘记声明 `permissions` → 调 API 被拒
- 用 `require("http")` → 子进程拦截，失败
- 返回值不符合 `ModuleResult` 形状 → 安装校验失败

### 2. 新工具：`extension_validate`

**这是本卡最实的一块。**

```ts
{
  name: "extension_validate",
  description: "在安装之前检查一份扩展清单与程序是否能工作。不落盘、不执行到世界，"
             + "只做形状校验与受控求值。返回可以安装 / 不可安装 + 每条问题的具体原因。",
  inputSchema: {
    manifest: z.unknown(),      // 或 manifestPath: string
    programSource: z.string().optional(),
  }
}
```

实现：

- **形状校验**：`ModuleManifestSchema.parse()`
- **程序核验**：调 `ModuleHost` 已有的 `verifyProgram`（受控子进程求值工厂）
- **权限校验**：每一条 `permissions` 是不是 T48 清单里的
- **贡献点校验**：`slot` / `icon` / `command` 是否合法
- **试调用（可选）**：给一个假的 `resource`（临时目录里的测试文件），
  在受控子进程里跑一次，看返回值是否符合 `ModuleResult`

**判据（T48/T49 的前提）**：这个工具**不写盘、不安装**，只报告。

### 3. 把 `modules.install` 变成 AI 可用的

现在它是 `danger` 档 —— **每次弹卡**。

T48 之后，`modules.install` 应该是一个**可授权**的权限（`modules.install`）。
但安装**别的扩展**这件事，即使扩展自己有权限，**用户仍然要看一眼**。

**建议**：`modules.install` 保持 `danger` 档，但**调用者如果是 AI 且用户在场**，
审批卡上要显示：
- 这个扩展要哪些权限（T48 的清单）
- 它会调哪些 API（从 manifest 静态推）
- 「安装」/「取消」

**这不是要给 AI 开绿灯，是让它装的每一步用户都能看懂。**

### 4. 模板

在 `apps/desktop/resources/presets/` 或新目录下放 2–3 个**能直接跑的模板**：

- `hello-world`：文件右键显示文件名
- `line-counter`：统计行数（用 `file.readFile`）
- `ai-summarizer`：对文件内容调 `session.send` 让 AI 总结（用 T49 的核心能力）

**模板要能被 `extension_validate` 判为「可安装」，也要能真的装上跑通。**

### 5. 闭环验证

写一张**回归卡**（不是本卡实现）：让真 AI 从零写一个扩展，
用 `app_guide` + `extension_validate` + `modules.install`，
验证它能成功。这一步的结论写进回写区。

---

## 边界（不要碰）

- 不改 `ModuleHost` 的权限判定（T48 负责）。
- 不改 `blocked` 表。
- 不放松子进程隔离。
- 不改文档 / 工作流 / Node-RED 相关代码。
- **不在本卡实现 T48/T49/T50 的内容** —— 它们是前置。

---

## 验收判据

1. `app_guide { topic: "extensions" }` 返回完整文档，包含上面 a–e 五项（有断言）。
2. `extension_validate` 能正确判定：
   - 合法清单 → 「可以安装」
   - 非法权限名 → 「权限 X 不存在」
   - 程序语法错 → 「求值失败：<原因>」
   - 未声明的 API 调用 → 能静态提示（如果实现得出来）
   （每类一条断言）
3. 三个模板都能通过 `extension_validate`，且能真的装上跑通（有断言）。
4. 真 AI 从零写扩展的闭环验证（至少一条完整记录：用户一句话 → AI 写出 → 装上 → 能用）。
5. `modules.install` 的审批卡会列出扩展要的权限（有断言或截图）。
6. 现有 `module-*` 套件全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 `extension_validate` 的权限校验 → 判据 2 的第二类红；
   撤掉 `app_guide` 的 `extensions` topic → 判据 1 红。

---

## 回写区要回答

- 真 AI 从零写扩展，第一次成功了吗？失败在哪里？
- `app_guide` 的 `extensions` topic 够不够让 AI 一次写对？缺什么？
- `extension_validate` 能静态发现「调了未声明权限的 API」吗？如果不能，为什么？
- 三个模板里哪个最有用？AI 会不会照抄模板而不理解？
- 「AI 写扩展」和「AI 直接调 `app_api_call`」相比，哪个用户更想要？
  前者复杂但可复用，后者简单但只做一次。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T51 执行记录（E1；U1 待验）

- 范围：main/appControl 的 `app_guide extensions`（五段文档，实际 ModuleManifest 工厂形状）、`extension_validate`（Schema + T48 权限映射 + JS 语法 + T49 受控程序工厂核验 + 字面量 API 权限提示）、`modules.install` 的 danger 审批详情、三个可安装模板、专项 smoke、回归卡 `tasks/T51-real-ai-regression.md`。未放松隔离，不改 ModuleHost 授权/blocked 表。
- E1：`node apps/desktop/scripts/run-smokes.mjs extension-authoring-smoke agent-guide-smoke` 两套通过（日志：`apps/desktop/.tmp/smoke-runs/1792572397681-26256-pa5he5`）；合法/非法权限/程序语法/未声明 API 静态提醒/贡献非法/审批权限详情均有断言。
- 模板：`hello-world`、`line-counter`、`ai-summarizer` 三个均通过真实受控核验、真实 `ModuleHost.install` 与隔离 `ModuleHost.invoke`；`ai-summarizer` 借 T49 桥接向模拟宿主 RPC 依次调用 `project.list` / `claude.startSession` / `claude.sendTurn`，**未调用真实在线模型**，不能冒充 U1。
- 变异：`node apps/desktop/scripts/extension-authoring-smoke/mutate.cjs` 两处真实源码变异均变红（权限 X 提示 / 扩展主题消失），完成后原 SHA 自动恢复；结果 2/2。
- TSC：`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` 与 `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 均通过。
- 模块回归：14 个 `module-*-smoke` 曾为 12/14；复测 `module-catalog-smoke` 已通过，目前可确认为 **13/14**；**`module-phase2-e2e-smoke`** 仍失败在独立的原生窗口流程（`FULL native persistence/UI plus real scheduler and browser negative states completed: native-window, 1 !== 0`，证据 `apps/desktop/.tmp/p2-06-e2e-ElcPTJ`），不属本卡允许修改的 ModuleHost/原生 UI 实现。
- 真 AI 从零写扩展第一次是否成功：**没有执行真实 Agent U1 对话，无法判定**；回归卡已写明一句话到审批、调用的取证步骤。扩展文档是否使 AI 一次写对、AI 是否照抄模板、用户更喜欢扩展还是一次性 app_api_call：均需 U1/用户反馈，当前不伪造结论。
- 静态权限校验能力：能识别字面量 `mcode.api.call("method")` 的缺失权限并提示；动态拼接方法名、别名、间接调用无法静态证明，真实执行必须由 T49 宿主逐次拦截。
- 模板工程价值：`line-counter` 对文件右键功能的最小闭环最直观；`ai-summarizer` 覆盖 T49 的 RPC 通道，但真实在线模型的 U1 尚未覆盖。
- 验收判据：#1/#2/#3(E1)/#5(E1)/#7/#8 已有证据；**#4 未达（真实 AI U1 未执行）；#6 未达（module-phase2-e2e-smoke 原生窗口失败）**。
