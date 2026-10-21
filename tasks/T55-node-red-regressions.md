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

### T55 执行回写（2026-10-21）

- **范围/工作树**：开工 HEAD `e34b6eea568ffaba7364f4eebcc9d5db9d27ced9`；只修改 `node-red-theme-smoke/main.mjs`、`node-red-e2e-smoke/main.ts` 两个回归测试及本任务回写；没有修改 BOOTSTRAP、版本常量、主题 CSS、节点包或其他并行任务工作树。
- **回归 1（断言过时，T42 与 T47 先后叠加）**：`bootstrapManifest.ts` 中 `BOOTSTRAP_VERSION = 3`，而 T47 的主题测试仍字面匹配 `BOOTSTRAP_VERSION = 2`，初始真红 `node-red-theme-smoke:10/11`。T47 加 `editorTheme` 升 v2、T42 再加 `nodesDir` 升 v3；版本增长符合头注规则，非产品缺陷。将测试改为版本单调下界（`>=2`）+ 清单生成器、盘上字节 SHA 和版本判定共用 `BOOTSTRAP_VERSION`/预期 SHA 的守卫；盘上真实 `bootstrap.cjs` 与 `manifest` 的 SHA/版本一致性由 `workflow-engine-runtime-smoke` 动态检查（升级后 `sha256(盘上文件) === sha256(NEW) === manifest.bootstrap.sha256` 且清单版本等于当前常量）。
- **回归 2（断言过时，T47 引入）**：生产 Node-RED 5.0.8 的真 `GET /` 返回 200，主题标签的原始 HTML 为 `<link rel="stylesheet" href="theme&#x2F;css&#x2F;mcode-theme-auto.css">`，不是断言期望的连续字面子串 `theme/css/mcode-theme-auto.css`；同时 `GET /theme/css/mcode-theme-auto.css` 真实响应 200，包含深浅色变量。旧断言因此 `105/106` 红，**不是**主题注入缺陷；此处与 T42 增节点包无因果关系。改为从真实 `GET /` 提取 `link[rel=stylesheet]`、解码 HTML 数字字符引用、比较 href URL 路径，再请求提取到的主题路径核验 CSS 响应；新 `106/106`。
- **同类排查**：全 `apps/desktop/scripts/` 搜索 `BOOTSTRAP_VERSION`、`bootstrap.version`、`manifest.bootstrap.version`；除本次修复的 T47 字符串断言外，仅 `workflow-engine-runtime-smoke` 使用导入的动态 `BOOTSTRAP_VERSION` 构造与断言清单，并无其它写死 v2/v3 的引导脚本版本断言。生产 `bootstrapManifest.ts` 的版本与 SHA 比较也使用同一常量，无需改产品。
- **变异验证（E1）**：更改前跑 `node apps/desktop/scripts/run-smokes.mjs node-red-theme-smoke` → `10/11`，旧值断言红；在同目录的**隔离临时副本**将新版本断言还原为 `version === 2` 后重跑 → `10/11`、exit=1，确认旧值必红，副本已删除。e2e 使用原始旧断言的完整真 Node-RED 套件先复现 `105/106`、exit=1，观测到 HTML 转义 `&#x2F;` 与 CSS 200，之后改断言得到 `106/106`。
- **绿例与日志（E1）**：`node apps/desktop/scripts/run-smokes.mjs node-red-theme-smoke node-red-e2e-smoke mcode-node-pack-smoke workflow-engine-runtime-smoke` → **4 PASS / 0 FAIL**，其中主题 **11/11**，Node-RED e2e **106/106**（Node-RED 5.0.8 真子进程），节点包与运行时套件均 PASS；最终日志：`apps/desktop/.tmp/smoke-runs/1792570076790-33732-5vkL8z/`。`npx tsc --noEmit -p packages/contracts/tsconfig.json && npx tsc --noEmit -p apps/desktop/tsconfig.json` → exit=0（双包干净）。变异临时文件已清理。
- **判据**：1～7 全部达到（本卡仅作开发自测，非独立审查）。**remaining：无本卡验收阻断**；真实 Electron 页面视觉切色等 T47 原卡的 U1 问题不在 T55 范围内。
