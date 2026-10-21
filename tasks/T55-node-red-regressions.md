# T55｜Node-RED 两条回归：主题 manifest 版本 + e2e 断言

| 项目 | 值 |
|---|---|
| 编号 | T55 |
| 类型 | **回归修复**（T42/T47 留下的） |
| 优先级 | **最高** —— 刚做完就红，说明改动有副作用 |
| 建议并发 | 改 `main/workflowEngines/`；与扩展/文档线不冲突 |
| 预计规模 | 小 |

---

## 前置条件

- **无前置**，可直接派。
- 这两条红是 T42（`9d390a7e`）与 T47（`1566a414`）自己留下的。

---

## 两条红

### 1. `node-red-theme-smoke`

T52 的回写原文：

> 主题 bootstrap 更新后 manifest version=2 断言不满足

**根因推测**：`bootstrapManifest.ts` 的头注写死了「改 `BOOTSTRAP` 必须 +1 version」。
T47 加 `editorTheme` 时改了 `BOOTSTRAP`，version 从 1 → 2；T42 又加 `nodesDir`，
从 2 → 3。而 `node-red-theme-smoke` 里的断言还写着 `version === 2`。

**这大概率是断言过时，不是产品缺陷** —— 但要核实。

### 2. `node-red-e2e-smoke` 105/106

T42 的回写原文：

> 仅 T47 编辑器主页注入 CSS 链接断言失败（实际主题 CSS **响应 200**）

**注意**：「CSS 响应 200」说明**主题真的加载了**，只是断言检查的方式不对
（可能查的是一段固定的 HTML 片段，而 T47 换了注入方式）。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/workflowEngines/bootstrapManifest.ts` ——
   **头注写死了版本规则**，先读它。
3. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` 常量
   与 `BOOTSTRAP_VERSION`。
4. `apps/desktop/scripts/node-red-theme-smoke/` —— 那条 `version=2` 断言在哪。
5. `apps/desktop/scripts/node-red-e2e-smoke/` —— 105/106 那条在哪。
6. T42 与 T47 的回写区 —— 它们各自改了什么。

---

## 执行内容

### 第 1 步：先判断，再改

对每一条：

```
断言期望什么？
产品实际是什么？
哪个对？
```

**两条都很可能是「断言过时」**，但必须分别核实，不能想当然。

**核实方式**：

- `node-red-theme-smoke`：直接读 `BOOTSTRAP_VERSION` 常量，看它是几。
  再读断言，看它期望几。**如果常量是 3、断言期望 2 → 断言过时。**
- `node-red-e2e-smoke`：真跑一次引擎，`curl` 它的 `GET /`，
  看 HTML 里到底有没有 `<link rel="stylesheet">`。

### 第 2 步：修

- **断言过时** → 改断言，让它判**行为**而不是**固定字符串**。
  例如：不要断言 `version === 2`，断言 `version >= 2` 且 `manifest 与盘上文件 sha 一致`。
- **产品缺陷** → 修产品，在回写区说明为什么。

### 第 3 步：确认没有第三处同类断言

`bootstrapManifest` 的 version 还会被别的地方读吗？

```bash
grep -rn "BOOTSTRAP_VERSION\|manifest.*version" apps/desktop/src/main/workflowEngines/ apps/desktop/scripts/ | head -20
```

**同类断言一起修**，否则下次再改 BOOTSTRAP 又会红一批。

---

## 边界（不要碰）

- 不改 `BOOTSTRAP` 的**内容**（只修断言或版本常量的一致性）。
- 不改 T47 的主题 CSS。
- 不改 T42 的节点包。
- 不改其它三步的领域（模块 UI / 技能 UI / 扩展隔离）。

---

## 验收判据

1. `node-red-theme-smoke` 全绿。
2. `node-red-e2e-smoke` 106/106。
3. 回写区说清每一条是「断言过时」还是「产品缺陷」，依据是什么。
4. 同类的 version 断言全部检查过，没有漏网的。
5. `mcode-node-pack-smoke` / `workflow-engine-runtime-smoke` 不回归。
6. 双包 tsc 干净。
7. **变异验证**：如果是断言过时，把断言改回旧值 → 应该红（证明新断言仍然有效）。

---

## 回写区要回答

- `BOOTSTRAP_VERSION` 现在是几？断言期望几？
- 主题 CSS 在引擎的 `GET /` 里到底长什么样？
- 这两条红是 T42 引入的还是 T47 引入的，还是两者叠加？
- 还有别的套件在断言 `BOOTSTRAP_VERSION` 吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
