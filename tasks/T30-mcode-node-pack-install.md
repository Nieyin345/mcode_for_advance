# T30｜把 Mcode 节点包装进 Node-RED（补上唯一的断点）

| 项目 | 值 |
|---|---|
| 编号 | T30 |
| 类型 | **ARC-006 主线**（用户：Node-RED 也是直接搬，二开加节点） |
| 优先级 | **高** —— 这是 Node-RED 线上唯一的断点 |
| 建议并发 | 改 `src/main/workflowEngines/`；与 T28/T29 不冲突（那两张改 `document/`） |
| 预计规模 | 中 |

---

## 现状（实读，2026-10-21）

### 已经做对的（不要重做）

| 层 | 状态 |
|---|---|
| Node-RED 5.0.8 源码 vendor | ✅ `node-red/`，独立 Git，Apache-2.0，`mcode/integration` 分支 |
| 运行时拉起 | ✅ `registry.ts` 的 `BOOTSTRAP` 常量用官方 `RED.init()` embedding 形状 |
| 编辑器嵌入 | ✅ `editor-client` 的 `red.min.js` 作为 `WebContentsView`（T07 刚完成） |
| 认证 | ✅ 宿主令牌，无令牌 401 |
| 部署审批 | ✅ `POST /flows` 走 `process.send` 握手，其余写操作 423 |
| safeMode | ✅ 默认开，只有宿主写可信标记才放开 |
| 引导脚本完整性 | ✅ `bootstrapManifest.ts` 版本 + sha256 + 篡改检测 |

**这一层比 GenOffice 那条线更彻底**：没有重造宿主，就是 `RED.init()`。

### 唯一的断点

`apps/desktop/src/main/workflowEngines/` 下有两个文件，共 **1,380 行**：

- `mcodeNodePack.ts` —— `mcode-agent` 节点（纯逻辑 + 注册外壳 + HTML）
- `mcodeNodeTypes.ts` —— 另外 5 个节点（`mcode-conversation` / `mcode-branch` /
  `mcode-trigger` / `mcode-module-capability` / `mcode-node-red-call`）

**它们没有接进生产。** 全仓 grep 证实：

```
$ grep -rn "registerMcodeAgentNodes" apps/desktop/src/main/ 
（无输出 —— 生产零调用）
$ grep -rn "registerMcodeAgentNodes" apps/desktop/scripts/
apps/desktop/scripts/mcode-node-pack-smoke/main.ts:445,463,503,535,557
（只有测试在调）
```

同时 `McodeAgentPort` 只有测试替身，没有生产实现。

**所以：节点写好了，但没有装进 Node-RED，也没有东西执行它们。**

---

## Node-RED 的节点扩展方式（实读，零上游改动）

一个节点 = 同目录下同名的一对文件：

```js
// <type>.js —— 运行时
module.exports = function (RED) {
  function Ctor(config) { RED.nodes.createNode(this, config); /* ... */ }
  RED.nodes.registerType("mcode-agent", Ctor);
};
```

```html
<!-- <type>.html —— 编辑器（red.min.js 加载） -->
<script type="text/javascript">
RED.nodes.registerType("mcode-agent", { category, color, defaults, inputs, outputs, icon });
</script>
<script type="text/html" data-template-name="mcode-agent"> 表单 </script>
<script type="text/html" data-help-name="mcode-agent"> 帮助 </script>
```

**发现机制**：Node-RED 启动时扫 `nodesDir`（`node-red/settings.js:58-63`），
有同名 `.js` + `.html` 就被认作一个节点。

`mcodeNodePack.ts:354` 的 `agentNodeHtml()` **已经产出这个形状的 HTML**
（含 `registerType`、编辑表单、帮助文本），不是空壳。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts` **全文**（约 450 行）——
   尤其 `McodeAgentPort` 接口、`registerMcodeAgentNodes`、`agentNodeHtml`。
3. `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts` **全文**（约 930 行）——
   5 个节点各自的 port 形状。
4. `apps/desktop/src/main/workflowEngines/registry.ts:85-260` 的 `BOOTSTRAP` ——
   **重点**：`RED.init(server, { userDir, ... })` 里没有传 `nodesDir`。
5. `apps/desktop/src/main/workflowEngines/runtimeSupervisor.ts:800-850` 的
   `createEngineLaunchSpec` —— 引擎以独立进程 spawn，env 完全替换。
6. `node-red/packages/node_modules/@node-red/registry/lib/index.js` 的
   `getNodeFiles` —— 确认扫描规则（是否只认 `<userDir>/nodes/`）。
7. `apps/desktop/scripts/mcode-node-pack-smoke/main.ts` —— 现有测试怎么调它。

---

## 执行内容

### 第 1 步：把节点包装进 `nodesDir`

在 `bootstrapManifest.ts` 的同一层（受管、可校验、可升级）增加一个**节点包清单**：

- 位置：引擎 `dataDir` 下（与 `bootstrap.cjs` 同目录），建议 `mcode-node-pack/`。
- 每个节点产出**两个文件**：`<type>.js` + `<type>.html`。
- **`<type>.js` 怎么来**：`mcodeNodePack.ts` 现在是 TypeScript 源码，Node-RED 只能
  `require` 运行时代码。两条路：
  - **A（推荐）**：构建期把 `mcodeNodePack.ts` / `mcodeNodeTypes.ts` esbuild 打包成
    一个 CJS bundle，作为资源随应用发布；
  - **B**：写一个极薄的 `<type>.js`，它 `require` 宿主注入的模块路径。
    依赖 `NODE_PATH`，脆弱，**不推荐**。

  选 A。产出的 bundle 与 `bootstrap.cjs` 一样进完整性清单（版本 + sha256）。

- 清单形状照抄 `bootstrapManifest.ts` 的 `mcode.workflow-engine.bootstrap/v1`，
  改为 `mcode.workflow-engine.node-pack/v1`。

### 第 2 步：让引导脚本扫它

`registry.ts` 的 `BOOTSTRAP` 里 `RED.init(server, {...})` 增加：

```js
nodesDir: [ path.join(__dirname, "mcode-node-pack") ],
```

**注意**：`BOOTSTRAP` 是内联字符串常量，改动必须**同步 +1 `version`**
（`bootstrapManifest.ts` 的头注写死了这条规则），否则盘上的旧脚本不会被替换。

### 第 3 步：`McodeAgentPort` 的生产实现

这是本卡最实质的一块。6 个节点各自的 port 要接到真实能力上：

| 节点 | port | 接到哪 |
|---|---|---|
| `mcode-agent` | `run(payload) → {text, artifacts}` | Mcode 三引擎 + 审批 + `appControl` |
| `mcode-conversation` | 同上 | 主对话（用户可见） |
| `mcode-branch` | `decide(msg) → port` | 模型决策；`decider:"user"` 时挂起等真人 |
| `mcode-trigger` | `subscribe(emit) → dispose` | Mcode 应用事件 |
| `mcode-module-capability` | `invoke(moduleId, contributionId, path)` | `ModuleHost` |
| `mcode-node-red-call` | `call(enginePath, method, body)` | 引擎自己的 HTTP API |

**端口怎么进子进程**：引擎是独立 spawn 的（`runtimeSupervisor.ts`，env 完全替换）。
所以 port **不能**是进程内对象。两条路：

- **A（推荐）**：节点在子进程里，经 `process.send` 向宿主发请求，宿主在主进程执行
  后回包 —— **与现有的部署审批握手同一套**（`registry.ts:120-200` 已有完整实现）。
- **B**：走 HTTP 到宿主。多一个端口要守，**不推荐**。

选 A，复用已有的 IPC 握手管道。

### 第 4 步：节点表单的 i18n 与视觉

`agentNodeHtml()` 现在的表单是硬编码英文（"Name" / "Instruction" / "Capability"）。

- 照 Node-RED 官方节点的做法用 `data-i18n` 属性 + 节点包自己的 `locales/<lang>/<type>.json`。
- **不要**改 Node-RED 的 CSS 或主题。
- 视觉上只要 `category: "mcode"` 与 `color` 能与原生节点区分即可，不追求与 Mcode 设置页一致。

### 第 5 步：确认 `category` 分组

现在 `agentNodeHtml()` 写的是 `category: "mcode"`。Node-RED 会在调色板里
建一个叫 "mcode" 的分组。确认另外 5 个节点用同一分组，且给出图标。

---

## 边界（不要碰）

- **不改 `node-red/` 上游源码**。本卡全部是「往 `nodesDir` 放文件」+ 宿主侧引导脚本，
  两者都不在上游树里。
- 不改 Node-RED 的核心节点（`function` / `switch` / `exec` / `inject` / `watch`）。
  迁移器把 `condition`/`command`/`code` 映射到原生节点，这个方向是对的。
- 不改 `document/`（T28/T29 的领域）。
- 不改 `bootstrap.cjs` 的认证、safeMode、部署握手逻辑 —— 只加 `nodesDir` 一项。
- 不引入任何 Node-RED 社区包。

---

## 验收判据

1. 启动引擎后，`GET /nodes`（带宿主令牌）**包含 6 个 `mcode-*` 类型**。
2. 编辑器调色板里有 "mcode" 分组，6 个节点都能拖进画布、能配置、能保存。
3. `mcode-agent` 节点真跑一次：拖一个 `inject → mcode-agent → debug`，
   点 deploy，`debug` 面板能看到 `{text, artifacts}`。
4. port 走的是宿主 IPC，**不是**进程内对象 —— 有断言证明子进程里没有三引擎的 import。
5. 引擎崩溃/重启后，节点包仍在且版本正确（清单校验生效）。
6. 现有 `mcode-node-pack-smoke` / `node-red-e2e-smoke` /
   `workflow-engine-runtime-smoke` 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 `nodesDir` → 判据 1 红；撤掉 port 的宿主 IPC →
   判据 3 红（节点报错而不是静默成功）；撤掉清单校验 → 判据 5 红。

---

## 回写区要回答

- `getNodeFiles` 的扫描规则是什么？只认 `<userDir>/nodes/` 还是也认 `nodesDir`？
  （这决定第 1 步放哪）
- 节点包的 bundle 多大？能不能与 `bootstrap.cjs` 共用一次 esbuild？
- 部署握手那套 `process.send` 管道能不能直接复用给节点 port？有没有冲突风险？
- 6 个节点的 HTML 里有几个已经能直接用？有几个需要补图标/帮助/本地化？
- 真跑一次 `mcode-agent` 时，三引擎的审批卡会不会正常弹出来？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
