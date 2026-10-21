# T26｜修好三套自坏的 smoke 脚手架（maint-m22 / maint-m35-pickers / updater-tools）

| 项目 | 值 |
|---|---|
| 编号 | T26 |
| 类型 | 测试基础设施 |
| 优先级 | 中 —— 这三套红着，等于三块地方没有网 |
| 建议并发 | 只改 `apps/desktop/scripts/` 下的 stub 与 prelude，**不碰产品源码** |
| 预计规模 | 小 |

---

## 现状（实测，2026-10-21）

### 1. `updater-tools-smoke` —— 构建期就断，产品代码零覆盖

```
X [ERROR] No matching export in "scripts/updater-tools-smoke/stubs/fs.ts"
          for import "accessSync"
X [ERROR] ... for import "constants"
X [ERROR] ... for import "lstatSync"
```

`src/main/env/managedToolRoots.ts:18` 现在同时 import 这四项，stub 只导出了 `readdirSync` 之类。
产品代码本身没问题，是**桩没跟上**。这条最省事，先做完。

### 2. `maint-m22-smoke` —— 15/16，一条假红

```
FAIL control: library picker toggles + confirms on real Space/Enter
     — "[{\"kind\":\"close:library\"}]"
```

断言期望「Space/Enter 之后既有 toggle 又有 confirm」，实际只有 `close:library`。
**先判断是哪边对**：是产品真的丢了 toggle，还是断言把 `close` 也算进去了却没预期到它。
不要为了让套件变绿而删断言 —— 如果产品确实丢了 toggle，那是产品 bug，写进回写区单独记录，
本卡只修脚手架。

> 注意：`maint-m35-smoke` 里也有一份 `pickers-prelude.ts`，它已经被改过（加
> `setTimeout`/`clearTimeout` 桩）。这两套的 picker 桩可能是同源的两份副本 ——
> 如果能证明是同源，**合并成一份**（仓库硬规矩：共享实现只有一份）。
> 合并前先确认两边产品诉求一致；不一致就各自保留并在回写区说明。

### 3. `maint-m35-smoke` 的 pickers 子集

主套件已 8/8（总控刚修了它的一条误判断言），但它内部还有一个 `pickers:all`
子部分。如果这次要把三套统一成同一份 prelude，这个子集也要一起跑绿。

---

## 开工前必读

1. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**。
   特别是「`--alias` 只认包名」「相对 import 换不掉」「`--banner` 非有不可」三节。
2. `apps/desktop/scripts/updater-tools-smoke/stubs/fs.ts` 与 `run.sh`。
3. `apps/desktop/scripts/maint-m22-smoke/` 与 `maint-m35-smoke/pickers-prelude.ts`。
4. `apps/desktop/scripts/run-store-smoke/stubs/` —— 通用桩的范本（`dataRoot.ts` / `logger.ts`）。
5. `CLAUDE.md` 的环境事实：**无头验证时 `dataRoot` 必须指向 `mcode.db` 的副本**。

---

## 执行内容

### 第 1 步：`updater-tools-smoke` 的 fs 桩补齐

- 补齐 `accessSync`、`constants`、`lstatSync`（以及运行后可能冒出的其它项）。
- **桩要真代理到 node:fs，不要手写返回值** —— 手写桩会让「产品代码是不是真的在用这个东西」
  变成不可判定。范本：`run-store-smoke/stubs/`。
- 判据：`bash apps/desktop/scripts/updater-tools-smoke/run.sh` 能跑到断言阶段
  （不管红绿，至少不再构建失败）。

### 第 2 步：`maint-m22-smoke` 那条 control 断言

- 先读断言与产品实现，判定谁对。在回写区写清判据。
- 如果是断言的问题：修断言，让它判**用户看到的行为**而不是内部事件序列。
- 如果是产品的问题：**不要改产品**（超出本卡边界），保留红，
  在 `tasks/README.md` 的「已知未修」里加一条，并在回写区点名。
- 判据：`maint-m22-smoke` 16/16 **或** 15/16 + 回写区有明确定性。

### 第 3 步（可选，只在能证明同源时）：合并 picker prelude

- 两份 prelude 如果只有「加了 setTimeout 桩」这种差异，合并成
  `apps/desktop/scripts/lib/pickers-prelude.ts`，两边 `--alias` 指过去。
- **不能合并就明说为什么**，别硬合。

---

## 边界（不要碰）

- **只改 `apps/desktop/scripts/` 下的 stub / prelude / run.sh**。
- 不改任何 `src/main/` 或 `src/renderer/` 的产品源码。
- 不改断言的**语义**（改断言形状让它匹配新实现可以，删断言不行）。
- 不新建 smoke 套件。
- 不改 `maint-m35-smoke/main.ts`（总控刚改过它的 revealFile 判据）。

---

## 验收判据

1. `updater-tools-smoke` 能跑完并给出明确结果（红绿都行，但不再构建失败）。
2. `maint-m22-smoke` 达到 16/16，或 15/16 且回写区有「这是产品 bug」的明确定性。
3. `maint-m35-smoke` 仍 8/8。
4. 三套跑完，**没有一套是因为删断言而变绿的**。
5. 双包 tsc 干净。
6. **变异验证**：删掉 fs 桩里新补的 `lstatSync` → `updater-tools-smoke` 构建必须重新失败
   （证明桩真的是必需的，不是顺手加的）。

---

## 回写区要回答

- `updater-tools` 的桩为什么落后了？有没有别的套件共用同一份桩、也会一起坏？
- `maint-m22` 那条到底是产品 bug 还是断言 bug？判据是什么？
- 两份 picker prelude 能合并吗？如果不能，差异是什么？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
