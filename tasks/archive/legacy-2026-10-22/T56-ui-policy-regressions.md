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

### 2026-10-21｜T56 执行回写（三套独立定性与变异验证）

- **基线及归因（起点 HEAD `42a40ae83f1ba8cdaad4d78bf4f46108e151cb00`）**：`node apps/desktop/scripts/run-smokes.mjs module-ui-smoke skills-nodes-ui-smoke vscode-l1-smoke` 原始为 0/3。`module-ui` **弹窗已打开**（`[role=dialog]` 存在）；旧测试在 T48 新增的权限勾选列表里点到**第一项权限复选框**，而不是末尾的「我允许此模块…」只读同意，故安装按钮仍禁用、没有 `script` 校验错误，waitFor 超时。这是测试步骤过期、不是安全提示被产品移除。`skills-nodes-ui` 的 `aria-current={selected ? "true" : undefined}` 与选中样式仍在 `SkillNodesView.tsx`，`bfca30c2` 把原生 `<button>` 换成共享 `<Button>`；组件级 fakeReact 只收集根组件 JSX，不执行子组件，所以 `n.type === "button"` 永远找不到高亮。这也是**断言/测试替身过期**，不是 T24 丢了无障碍属性。`vscode-l1` 的默认拒绝来自 T16 `permissionedProcessRunner.ts`，正确 fail-closed；原 smoke 没显式启用风险降级，安装测试期望过时。
- **修复（仅 smoke，不改 T16/T24/T48 产品策略）**：`module-ui` 通过实际 `<label>` 文案定位只读同意框，不再选第一个 input；真实 Chromium 明确断言弹窗打开、非法 `script` 清单的错误告警、真实后端未安装、可执行清单的两条**用户可见原文**「我了解此扩展包含可执行程序：它会在我这台机器上运行…」（`ide.modules.codeConsent`，key 未变）及「本机无 OS 网络沙箱：执行程序需要先在上方明确授权 JS-only 降级…」（`ide.modules.egressInstallNotice`，key 未变）、独立执行同意未勾时安装禁用。浏览器夹具提供 `egressConsentGet()` 的隔离 Windows 未降级状态。`skills-nodes-ui` 在测试构建中将共享 CDS Button 映射为真实 native `button` 形状，保留生产 `SkillNodesView` 的 `aria-current`、className 等 JSX 原始 props，五条原断言未改。`vscode-l1` 使用临时目录下的 `js-only-egress-consent.json` 配置生产读写接口；先在未授权状态真实试装并验证 `egress_isolation_unavailable` 与未持久化，再执行测试等价于**用户在宿主 `modules.egressConsentSet({enabled:true,acknowledgeRisk:true})` 确认风险后的** `setJsOnlyEgressConsent(true)` 持久化，继续跑真实安装与子进程；finally 解除读路径绑定并删除隔离目录，未操作真实用户配置。
- **绿例 E1**：`node apps/desktop/scripts/run-smokes.mjs module-ui-smoke skills-nodes-ui-smoke vscode-l1-smoke` → 3/3 套件 PASS；`module-ui` 10/10（浏览器）；`skills-nodes-ui` 23/23；`vscode-l1` 27/27。最后一次日志：`apps/desktop/.tmp/smoke-runs/1792570194494-30536-915BrI/`。`node_modules/.bin/tsc.cmd --noEmit -p apps/desktop/tsconfig.json` 与 `node_modules/.bin/tsc.cmd --noEmit -p packages/contracts/tsconfig.json` → 均 exit 0，无类型错误。
- **变异 E1（三项全部按预期转红并逐字节恢复源文件）**：`node apps/desktop/.tmp/t56-mutation.cjs` → 修改执行代码提示为普通只读同意提示，`module-ui` ASSERTION FAILED（日志 `apps/desktop/.tmp/smoke-runs/1792570124263-43324-WJk98a/`）；将 `aria-current={selected ? "true" : undefined}` 临时改为 `aria-current={undefined}`，`skills-nodes-ui` 五条高亮断言红（`1792570129763-42248-l48KJo/`）；将 `permissionedProcessRunner` 的 `if (!hasJsOnlyEgressConsent())` 临时变为 `if (false)`，`vscode-l1`「Windows executable extensions fail closed…」报 `Missing expected rejection`（`1792570131110-42396-xjSL6j/`）。每项验证后备份二进制 SHA256 对比恢复一致；修复不涉及这三个产品源码。
- **结果**：本卡五项验收全部达成；三项此前失败均为历史测试与现有正确产品/安全策略不匹配，非需要再修复的产品回归。`E1` 为隔离 Chromium/Node smoke 证据，不冒充完整 Electron U1。此回写与测试修复同一提交，可用 `git log -1 --format=%H -- tasks/T56-ui-policy-regressions.md` 定位源码提交。
