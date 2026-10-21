# T32｜mcode 节点包：表单本地化、图标、分类与调色板

| 项目 | 值 |
|---|---|
| 编号 | T32 |
| 类型 | ARC-006（Node-RED 节点包的外观） |
| 优先级 | 中 |
| 建议并发 | 改 `workflowEngines/mcodeNode*.ts`；**先完成 T30** |
| 预计规模 | 小 |

---

## 现状

6 个节点的 HTML 已经有完整形状（`agentNodeHtml():354` 是范本）：

- `<script type="text/javascript">` → `RED.nodes.registerType(...)` + `defaults` + `icon`
- `<script type="text/html" data-template-name="...">` → 编辑表单
- `<script type="text/html" data-help-name="...">` → 帮助文本

**缺的是**：

1. 表单标签**硬编码英文**（`Name` / `Instruction` / `Capability`），没有 `data-i18n`
2. 只有 `mcode-agent` 有完整 HTML，另外 5 个的 HTML 要确认
3. 图标是 `font-awesome/fa-user`，6 个节点都一样
4. `category` 是否 6 个都是 `mcode`

---

## 实读证据：Node-RED 的 i18n 机制

**节点包自己的 locale 文件**，与节点 `.html` 同目录：

```json
// locales/zh-CN/messages.json
{
  "mcode-agent": {
    "label": { "name": "名称", "instruction": "指令", "capability": "能力", "outputVar": "输出变量" },
    "help": "通过宿主签发的端口运行一步 Mcode agent。输出 msg.payload = { text, artifacts }。"
  }
}
```

HTML 里用属性引用：

```html
<label for="node-input-instruction"><i class="fa fa-pencil"></i>
  <span data-i18n="mcode-agent.label.instruction"></span></label>
```

官方节点的写法就是这个（`node-red/packages/node_modules/@node-red/nodes/locales/`
下有 10 种语言），照抄即可。

**注意**：Node-RED 的 i18n 用的是 `data-i18n` 属性 + `locales/<lang>/messages.json`，
**不是** Mcode 的 `useI18n` / `MessageId`。这是两个世界，不要混：
节点包是**独立分发的资源**，它不知道 Mcode 的 i18n 体系。

Mcode 侧只需要在**生成**这些文件时读一下当前语言，或者在节点包里同时放
`en-US` 与 `zh-CN` 两份，由 Node-RED 自己按它的语言设置选。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts` 的 `agentNodeHtml()`
   —— 完整范本。
3. `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts` —— 另外 5 个的 HTML。
4. `node-red/packages/node_modules/@node-red/nodes/locales/en-US/messages.json`
   与 `zh-CN/messages.json` —— 官方格式。
5. `node-red/packages/node_modules/@node-red/nodes/core/function/10-switch.html`
   —— `data-i18n` 的实际用法。
6. `node-red/packages/node_modules/@node-red/nodes/core/function/10-switch.js`
   —— `icon` / `category` / `color` 的实际写法。

---

## 执行内容

### 1. 六个节点的图标与分类

- 统一 `category: "mcode"`。
- 每个节点一个**有辨识度**的图标（Font Awesome，Node-RED 自带）：
  - `mcode-agent` → `fa-user`（保留）
  - `mcode-conversation` → `fa-comments`
  - `mcode-branch` → `fa-code-branch`
  - `mcode-trigger` → `fa-bolt`
  - `mcode-module-capability` → `fa-puzzle-piece`
  - `mcode-node-red-call` → `fa-retweet`
- `color` 与 Mcode 的 accent 一致（当前的 `#8ea6b8` 可以，或统一成一组）。

### 2. 表单标签全部走 `data-i18n`

- 每个 `<label>` / `<option>` / `placeholder` 都改成 `data-i18n` 或
  `data-i18n="[placeholder]key"`。
- 产出 `locales/en-US/messages.json` 与 `locales/zh-CN/messages.json`。
- **不要**在生成时按用户当前语言只写一份 —— 用户可能中途切语言，
  Node-RED 自己会重读。两份都放。

### 3. 帮助文本

每个节点的 `data-help-name` 写清楚：
- 它做什么
- 输入 `msg.payload` 是什么
- 输出什么
- **会不会弹审批**（对 `mcode-agent` / `mcode-branch` / `mcode-module-capability` 要写明）

这一条重要：用户在调色板里拖节点时，帮助文本是唯一的说明。

### 4. 确认 5 个节点的 HTML 完整性

`mcodeNodeTypes.ts` 头注说"与 `mcodeNodePack.ts` 的 agent 同一个形状"，
但**要逐个核**：`registerType` / 表单 / 帮助三段是否都齐。

缺哪个补哪个，补的时候照 `agentNodeHtml()` 的结构。

### 5. `mcode-branch` 的表单要能表达「决策者」

它有两个参数（`decider: "model" | "user"`、分支数）。表单里要有：

```html
<select id="node-input-decider">
  <option value="model">模型决定</option>
  <option value="user">等人工选择</option>
</select>
```

**输出端口数由 `defaults.outputs` 决定**，但 Node-RED 的 `switch` 节点做了
「运行时改端口数」（`oneditprepare` 里改 `outputs`）。`mcode-branch` 要不要照做，
取决于 T31 里 branch 的语义定稿 —— **先读 T31 的回写区**。

---

## 边界（不要碰）

- **不改 Node-RED 的 CSS / 主题**。只用它已有的 `form-row` / `fa` 图标体系。
- 不改 `core/` 下的任何原生节点。
- 不改 Mcode 的 `useI18n` / `lib/i18n/`（那是渲染端的，与节点包无关）。
- 不改 `mcodeNodePack.ts` 的执行逻辑（只改 HTML 与 locale 文件）。

---

## 验收判据

1. 编辑器调色板里有 "mcode" 分组，6 个节点各有不同图标。
2. 切到中文，节点表单显示中文标签；切回英文恢复。
3. 每个节点拖进画布后，右键「帮助」有可读说明。
4. 6 个节点的 HTML 都有 `registerType` + 表单 + 帮助三段。
5. 现有 `mcode-node-pack-smoke` 全绿（它断言 HTML 的关键片段）。
6. 双包 tsc 干净。
7. **变异验证**：删掉一个节点的 `data-help-name` → 帮助断言红；
   把 `category` 改成不同值 → 分组断言红。

---

## 回写区要回答

- 6 个节点的 HTML 里有几个是完整的三段式？缺的补了什么？
- Node-RED 的 `data-i18n` 与 Mcode 的 `useI18n` 有没有需要协调的地方？
- `mcode-branch` 的端口数要不要像原生 `switch` 那样动态改？
- 帮助文本里"会弹审批"这条，用户实际看到的是什么？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
