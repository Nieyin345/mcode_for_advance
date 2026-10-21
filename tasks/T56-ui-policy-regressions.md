# T56｜三套 UI/策略回归：module-ui / skills-nodes-ui / vscode-l1

| 项目 | 值 |
|---|---|
| 编号 | T56 |
| 类型 | **回归修复**（T52 剩下的三条） |
| 优先级 | 中到高 |
| 建议并发 | 改 `renderer/components/modules/` + `renderer/components/settings/skills/` + `scripts/vscode-l1-smoke/` |
| 预计规模 | 中 |

---

## 前置条件

- **无前置**，可直接派。
- 三者互不重叠，**但如果想拆开派也可以**，见文末。

---

## 三条红（实测，不是转述）

### 1. `module-ui-smoke`

```
Error: UI wait timeout:
  document.querySelector('[role=dialog] [role=alert]').textContent.includes('script')
```

**现象**：打开嵌套授权弹窗后，等待一条 `role=alert` 且文本含 `script` 的元素，**超时**。

**要查**：
- 弹窗里真的渲染了 alert 吗？
- 渲染了，但文本里不含 `script` 这个词？
- 还是弹窗根本没打开？

**注意**：`module-ui` 是**浏览器套件**（`withAuditPage`），跑真实 Chromium。
超时可能是因为 T48 改了模块安装的权限 UI（`ModuleSurface.tsx` 加了权限勾选页），
原来的弹窗流程变了。

### 2. `skills-nodes-ui-smoke`

```
skills-nodes-ui-smoke: 18/23 通过
```

T52 回写说的：**`selectedRef` 五条 `aria-current` / 高亮断言仍红**。

**注意**：T24 的批次 9 改过 `SkillsPanel` 与 `SkillsPanelParts`
（「技能项目 / 节点 / 预设与字体步进器动作」）。很可能是 T24 改动后的回归。

### 3. `vscode-l1-smoke`

```
Error: 扩展程序核验失败,未安装:
  egress_isolation_unavailable: Windows 无 OS 网络沙箱；
  默认拒绝运行所有可执行扩展。
```

**这条不是 bug —— 是正确行为。**

T16 做的：Windows 上没有 OS 级网络沙箱，所以**默认拒绝所有可执行扩展**，
除非用户在设置里明确开启「仅 JS 网络守卫」的风险降级。

**问题是测试没有跟上这个策略**：
- 测试期望「安装可执行扩展 → 能运行」
- 实际是「安装可执行扩展 → **拒绝**」（在 Windows 上，未降级时）

**这不是产品缺陷，是断言过期。** 但也可能测试本来就该覆盖两条路
（降级前拒绝 / 降级后放行），要看的。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/scripts/module-ui-smoke/` —— 尤其 `verify.mjs` 那一带
   （超时报错在 `:186` 的 `waitFor`，调用点 `:10899`）。
3. `apps/desktop/src/renderer/components/modules/ModuleSurface.tsx` ——
   T48 改过这里（权限勾选页）。
4. `apps/desktop/scripts/skills-nodes-ui-smoke/` —— 五条 `selectedRef` 断言在哪。
5. `apps/desktop/src/renderer/components/settings/SkillsPanel.tsx` 与
   `SkillsPanelParts.tsx` —— T24 批次 9 改过。
6. `apps/desktop/scripts/vscode-l1-smoke/` —— 安装断言在哪。
7. `apps/desktop/src/main/modules/egressConsent.ts` 与
   `permissionedProcessRunner.ts` 的 `requireNetworkExtensionSupport` ——
   **这是 T16 的策略落点**。
8. T24 的回写区（批次 9）与 T48 的回写区。

---

## 执行内容

### 第 1 步：三条分别定性

对每一条，先回答：

```
断言期望什么？
产品实际是什么？
哪个对？
```

**不许统一处理**，三条的原因完全不同。

### 第 2 步：`module-ui` 的嵌套授权弹窗

先查弹窗**有没有打开**：

- 如果没打开 → 看 T48 的权限页是不是改变了触发流程
- 如果打开了但文本不含 `script` → 看文案改成了什么（i18n key 变了？）
- 如果 alert 元素整个没了 → 看是不是换成了别的 role

**判据立在用户看到的那行字上**（仓库硬规矩）：

> 用户点「安装」，应该看到「这个扩展会执行代码」这类明确提示。

断言应该判**这句话在不在**，而不是判某个固定词。

### 第 3 步：`skills-nodes-ui` 的五条

T52 说是 `selectedRef` 的 `aria-current` / 高亮断言。

**先看是不是 T24 批次 9 改坏的**：

```bash
git log --oneline -5 -- apps/desktop/src/renderer/components/settings/SkillsPanelParts.tsx
git show <T24 相关提交> -- apps/desktop/src/renderer/components/settings/SkillsPanelParts.tsx
```

- 如果 T24 改动**丢了** `aria-current` → 产品回归，补回去
- 如果 T24 改动**有意换了**高亮方式 → 断言跟着改

**`aria-current` 是无障碍属性，不能因为「视觉上看着对」就删掉。**

### 第 4 步：`vscode-l1`

**这条要分两种情况处理**：

**如果测试本来就该覆盖 Windows 的 fail-closed**：
把断言改成期望「拒绝」，并断言错误消息里点名 `egress_isolation_unavailable`。

**如果测试应该覆盖「降级后能跑」**：
加一个前置步骤：先调 `modules.egressConsentSet({ enabled: true, acknowledgeRisk: true })`，
再跑安装断言。

**建议两条都做**：
- 新增一条断言：「未降级时拒绝安装可执行扩展」
- 保留原断言，但在它前面加降级步骤

这样既证明了 fail-closed 生效，又证明了降级路径可用。

---

## 边界（不要碰）

- 不改 T16 的 egress 策略本身（那是正确的）。
- 不改 T48 的权限模型。
- 不改 T24 的 CDS token。
- 三条互不相关，**改一条不要顺手改另一条**。

---

## 验收判据

1. `module-ui-smoke` 全绿，且回写区说清「弹窗有没有打开、文案是什么」。
2. `skills-nodes-ui-smoke` 23/23，且回写区说清是「产品回归」还是「断言过时」。
3. `vscode-l1-smoke` 全绿，且**同时覆盖**「未降级拒绝」与「降级后放行」两条。
4. 双包 tsc 干净。
5. **变异验证**：
   - `module-ui`：撤掉那句提示文案 → 断言红
   - `skills-nodes-ui`：去掉 `aria-current` → 断言红
   - `vscode-l1`：撤掉 fail-closed 判定 → 「未降级拒绝」断言红

---

## 回写区要回答

- `module-ui` 的弹窗到底打没打开？如果没打开，为什么？
- `module-ui` 的提示文案现在是什么？i18n key 变了吗？
- `skills-nodes-ui` 的五条，是 T24 改坏的吗？`aria-current` 还在不在 DOM 里？
- `vscode-l1` 要求的「降级」在测试里怎么触发的？
- 这三条里有没有哪一条其实不是「回归」，而是「测试本来就写错了」？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
