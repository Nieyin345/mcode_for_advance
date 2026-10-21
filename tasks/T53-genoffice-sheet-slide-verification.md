# T53｜T29 续篇：用真实 sidecar 验完 xlsx / pptx

| 项目 | 值 |
|---|---|
| 编号 | T53 |
| 类型 | **ARC-007 主线**（T29 的验收补齐） |
| 优先级 | **高** —— T29 只做完接线，真实编辑没验过 |
| 建议并发 | 改 `apps/desktop/scripts/`（新增测试）；**不改产品代码**，除非发现真缺陷 |
| 预计规模 | 中 |

---

## 前置条件（不满足就不要开工）

- **T29 已提交**：`dc974b2c feat(T29): connect upstream Sheets and Slides native views`
- **xlsx sidecar 二进制已就位**：总控已从上游 `v0.11.0` 安装包提取，
  落在 `genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe`
  （8,890,488 字节，SHA-256 `9e455b569179359d3b85768bac2619cb2628caf1ef1f44771b3652ef738925a5`）
  来源见同目录的 `PROVENANCE.md`。
- 开工前先验证：`echo '{"version":1,"requestId":"t","command":"open","path":"<真实xlsx>"}' | <sidecar>`
  必须回 `ok:true`。**不通就停**，在回写区写清。

---

## 现状：T29 验了什么、没验什么

T29 的回写区自己列得很清楚：

| 判据 | 状态 |
|---|---|
| 6. 资源缺失时报告 false 并降级 | ✅ |
| 7. 五套 `document-view-*` + 七套 `arc005-pane-*` | ✅ |
| **1. xlsx 打开 → 看到数据 → 改一格 → 保存 → 独立回读一致** | ❌ **未验** |
| **2. xlsx 打开 → 不改 → 关闭，字节不变** | ❌ **未验** |
| **3. pptx 打开 → 加一页 → 保存 → 重开可见** | ❌ **未验** |
| **4. pptx 打开 → 不改 → 保存，字节不变** | ❌ **未验** |
| **5. 两个 app 的 AI 都走 Mcode session** | ❌ **未验** |
| **8. 三包 tsc** | ⚠️ 当时被 T48 的中间态阻塞 |
| **9. 三项变异验证** | ❌ **未做** |

**根因是 sidecar 缺失。现在补上了，可以继续。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `tasks/T29-genoffice-sheets-slides.md` 的**回写区全文** —— 里面写了
   接线方式、两种 sidecar 路径、以及「12 类越出 Pane 的 IPC」的清单。
3. `apps/desktop/src/main/document/genofficeViewFactories.ts` ——
   sidecar 路径解析（`regularFile()` 判据）。
4. `apps/desktop/scripts/genoffice-native-view-smoke/` —— T28/T29 建的套件，
   看它的 fake host 怎么构造、怎么断言「打开→不改→关闭字节一致」。
5. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` ——
   无头 smoke 的写法、`--banner`、`--alias`、变异验证的三个坑。
6. `apps/desktop/src/main/document/slidesExecutor.ts` —— 现有 slides 保存路径。
7. `genoffice/apps/sheets/native/xlsx-engine/target/release/PROVENANCE.md`
   —— sidecar 的来源与校验方法。

---

## 执行内容

### 第 1 步：先做 xlsx 的端到端（判据 1、2）

**这是本卡最重要的一步。**

在现有 `genoffice-native-view-smoke` 里（**不新建套件**）加断言：

**1a. 打开 → 不改 → 关闭 → 字节不变**

```
取一份真实 xlsx（`genoffice/apps/shell/build/shell-new/blank.xlsx` 可以，
  但更稳的是在 test fixture 目录复制一份可控的）
记为 before = sha256(文件)
走真实的 open → close 路径（fake host + 真实 sidecar）
after = sha256(文件)
断言 before === after
```

**1b. 打开 → 改一格 → 保存 → 独立回读一致**

```
用 sidecar 自己的 `read_range` 或 `open` 拿到某格的当前值
调原厂编辑路径写一个新值
保存
用**另一条**路（`genofficeCli` 的 `sheet read`，纯 Node，不走 sidecar）回读
断言读到的就是新值
```

**1b 的关键**：回读必须用**独立实现**。用 sidecar 读自己写的东西，证明不了什么。
`genofficeCli.ts` 的 `sheetRead()` 是现成的独立读取器。

### 第 2 步：pptx（判据 3、4）

同上，用 `slidesExecutor` 的路径。

**3. 打开已有 pptx → 加一页 → 保存 → 重开可见**
**4. 打开 → 不改 → 保存 → 字节不变**

**如果找不到真实 pptx 样本**，用 `genoffice/packages/cli` 的
`create --type pptx` 生成一个。

### 第 3 步：AI 桥（判据 5）

T28 已经验过 pdf 的 AI（`genoffice-native-view-smoke` 里的 `ai.ts`）。
本卡要确认 sheets / slides 的 AI 也走了同一条链。

- **不需要真的连模型** —— 用假 provider 就够，断言的是
  「调用确实落到了 Mcode session，而不是被原厂自己吃了」。
- 如果有人力，再补一条真模型回复（可选）。

### 第 4 步：三包 tsc（判据 8）

```bash
npx tsc --noEmit -p packages/contracts/tsconfig.json
npx tsc --noEmit -p apps/desktop/tsconfig.json
cd genoffice && npx tsc --noEmit -p apps/sheets/tsconfig.json
```

**注意**：T42 回写报告 `apps/desktop` tsc 被
`scripts/document-view-renderer-smoke/main.ts:564` 的 `slidesNative` 类型错误阻断。
那是**另一个任务的**问题，本卡遇到时：

- 能顺手修就修（一行类型问题）
- 修不了就在回写区写清楚「卡在哪个文件的哪一行，不是本卡引入的」

### 第 5 步：变异验证（判据 9）

三条：

1. 撤掉 xlsx 的**工作区围栏** → 越界打开断言红
2. 撤掉 **CAS / 版本检查** → 并发覆盖断言红
3. 撤掉 sheets 执行器的 **fail-closed** → 未装配断言红

照 `mcode-smoke` skill 的做法：原地改 + 逐字节还原 + `cmp` 确认。

---

## 边界（不要碰）

- **不改 `genoffice/` 上游源码**。
- 不改 `slidesBridge` / `slidesExecutor` / `slidesVendorModules`
  （T29 判定它们要留作 fallback）。
- 不改 `documentViewHost.ts` 的既有语义（T28 已经改过了）。
- 不改 T47 的主题（`node-red-e2e-smoke` 的那条红是 T47 的账，本卡不碰）。
- 不改 `components/settings/`（T24 在飞）。

---

## 验收判据

1. xlsx：打开 → 不改 → 关闭，字节不变（有断言）。
2. xlsx：改一格 → 保存 → **独立读取器**（`genofficeCli.sheetRead`）回读一致（有断言）。
3. pptx：打开 → 加一页 → 保存 → 重开可见（有断言）。
4. pptx：打开 → 不改 → 保存，字节不变（有断言）。
5. sheets / slides 的 AI 调用落到 Mcode session（假 provider 即可，有断言）。
6. 三包 tsc 干净，或有明确记录「卡在别的任务的文件」。
7. 三条变异验证都做了，且逐字节还原。
8. 现有 `genoffice-native-view-smoke` / `document-view-*` 五套 / `arc005-pane-*` 七套全绿。
9. **不许只验证「调用成功」** —— 每条都要验到**文件字节**或**独立回读**。

---

## 回写区要回答

- sidecar 真的能打开真实 xlsx 吗？第一次成功了吗？
- 保存后独立回读，值对上了吗？如果对不上，差在哪？
- pptx 的「加一页」走的是哪条路径？`slidesExecutor` 还是原厂？
- 「打开→不改→关闭字节不变」这条，xlsx 和 pptx 哪个更容易破？为什么？
- 三包 tsc 的阻断是哪个文件哪一行？是谁引入的？
- 原厂 sheets/slides 那 12 类越出 Pane 的 IPC，本卡有没有发现新的？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
