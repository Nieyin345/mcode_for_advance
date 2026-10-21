# T68｜smoke 基线复查：四套旧红例

| 项目 | 值 |
|---|---|
| 编号 | T68 |
| 类型 | **测试基础设施** |
| 优先级 | 中 —— 四套已坏，说明那四块的验证是假的 |
| 建议并发 | 只改 `apps/desktop/scripts/`；**与 T61/T67 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T61 已完成**：它在跑 116 套时发现了这四条。
- **T67 可以先做**（它修的是其中一条的根因）。

---

## 四条红（T61 实测，不是转述）

| 套件 | 现象 | 判断 |
|---|---|---|
| `app-control-smoke` | 569/570，catalog 缺 `workflowEngine.load` | **→ T67 已覆盖** |
| `automation-smoke` | 旧 `--alias:node:fs` 连带破坏 `node:fs/promises` 的解析 | 构建配置 |
| `event-vertical-smoke` | sherpa 平台 `.node` 原生模块未外置 | 构建配置 |
| `orchestration-ipc-smoke` | 既有工作流字段/出厂更新标记断言红（430/433） | **待定性** |

**T67 修第一条。本卡修后三条。**

---

## 为什么这四条值得单独一张卡

T61 说得很清楚：

> 这些套件没有引用新共享 `electron.ts`，未越界替其它任务修它们。

**它们不是 T61 造成的，是早就坏的。**

而 T52 当时跑出「481/503 PASS」，说明**这四套当时可能也是红的**，
只是没人逐个看。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**。
3. `apps/desktop/scripts/automation-smoke/run.sh` —— `--alias:node:fs` 那条。
4. `apps/desktop/scripts/event-vertical-smoke/run.sh` —— sherpa 那条。
5. `apps/desktop/scripts/orchestration-ipc-smoke/` —— 430/433 那三条断言。
6. `apps/desktop/scripts/genoffice-native-view-smoke/run.sh` ——
   **T28/T42 之后建的套件怎么处理 GenOffice 依赖**，照它。
7. `apps/desktop/scripts/run-store-smoke/stubs/electron.ts` —— T61 新建的那个。

---

## 执行内容

### 第 1 步：三条逐一实跑，先看真实错误

```bash
bash apps/desktop/scripts/automation-smoke/run.sh 2>&1 | head -40
bash apps/desktop/scripts/event-vertical-smoke/run.sh 2>&1 | head -40
bash apps/desktop/scripts/orchestration-ipc-smoke/run.sh 2>&1 | head -40
```

**不要相信卡里的描述，以实测为准。**

### 第 2 步：`automation-smoke` 的 alias 问题

T61 说：

> 旧 `--alias:node:fs` 连带破坏 `node:fs/promises` 的解析

**这是 `mcode-smoke` skill 里写的那个坑的变种**：

> `--alias` 只认包名，相对 import 换不掉

`node:fs` 和 `node:fs/promises` 是**两个不同的模块说明符**。
alias 了前者，后者还是真模块 —— 两边行为不一致。

**要查**：

- 为什么 alias `node:fs`？（谁需要桩？）
- 能不能改成 alias 更精确的东西？

### 第 3 步：`event-vertical-smoke` 的 sherpa

原生 `.node` 模块 esbuild 打不进去。

**照 `genoffice-native-view-smoke` 的做法**：加 `--external:sherpa-onnx-node`。

**但要确认**：这个套件的断言路径**真的不调用 sherpa** 吗？
如果调用了，`--external` 会让它在运行时失败。

### 第 4 步：`orchestration-ipc-smoke` 的三条断言

430/433，**三条红**。

T61 说是「既有工作流字段/出厂更新标记断言红」。

**要判断**：

- 产品真的退化了？（那要修产品）
- 还是断言过时了？（那要修断言）

**这是本卡唯一需要判断「产品 vs 断言」的一条。**

### 第 5 步：确认没有第五套

```bash
node apps/desktop/scripts/run-smokes.mjs --all 2>&1 | grep "^FAIL"
```

**跑全量**，看现在到底有几套红。

**注意**：跑之前确认没有任务在跑 Electron 探针
（`tasks/README.md` 里记了这条规则）。

---

## 边界（不要碰）

- **只改 `apps/desktop/scripts/`**（除非第 4 步确认是产品退化）。
- 不改断言的语义（改形状让它匹配新实现可以，删断言不行）。
- 不改 `packages/contracts/`。
- 不改 T67 的 catalog。

---

## 验收判据

1. `automation-smoke` 全绿。
2. `event-vertical-smoke` 全绿。
3. `orchestration-ipc-smoke` 全绿，**或**有明确的「这是产品退化」的结论 + 记录。
4. 全量跑一次，**失败套件数写进回写区**（不是「应该全绿」，是实际数字）。
5. 双包 tsc 干净。
6. **变异验证**：对每条修好的，撤掉修复 → 该套件重新红。

---

## 回写区要回答

- 三条的真实错误分别是什么？
- `automation-smoke` 的 `--alias:node:fs` 是谁加的？为什么？
- `event-vertical-smoke` 外置 sherpa 后，断言路径真的不调用它吗？
- `orchestration-ipc-smoke` 那三条是产品退化还是断言过时？
- 全量跑的结果是多少套红？除这四条还有别的吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
