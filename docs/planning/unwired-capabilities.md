# 零调用方能力清单

- 日期：2026-10-24
- 用途：列出「造好了、有套件、但生产路径不调用」的能力。
- **为什么重要**：接上三个零调用方的能力，比新造三个能力更值钱 —— 前者是已经付过成本的。

## 怎么算「零调用方」

**三档要分开标，因为处置完全不同**：

| 档 | 判据 | 意味着 | 处置 |
|---|---|---|---|
| **A. 真零** | `grep` 整个 `apps/desktop/src/`，**除自身外零引用** | 没有任何东西用它 | **接上，或删掉** |
| **B. 只在注释里** | 有引用，但全部在注释 / 文档字符串里 | **和 A 等价** —— 注释不算调用 | 同上 |
| **C. 只有套件在调** | 生产代码零引用，`scripts/` 里有 | **套件是它唯一的消费者** | **要么待接线，要么它本来就只是套件的辅助函数（该挪进套件）** |

**C 档是最需要判断的**：它看起来「有测试覆盖」，但那覆盖证明的是「函数算得对」，不是「产品用得上」。

**方法**：

```bash
# A/B：全 src 扫（排除自身文件）
grep -rn "<符号>" apps/desktop/src/ --include=*.ts | grep -v "<自身文件>:"

# C：套件侧
grep -rn "<符号>" apps/desktop/scripts/ --include=*.ts --include=*.cjs --include=*.mjs
```

⚠️ **`grep` 的局限**：动态 `import()`、字符串拼的模块名、`require` 变量，都会漏。**所以「grep 到 0」是必要条件，不是充分条件** —— 这条对 A 档同样成立。

---

## 清单

### 1. `vscodeL1Bridge` —— **A 档：真零调用方**

| 项 | 内容 |
|---|---|
| 文件 | `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（376 行） |
| 造它的卡 | T80（`ecb5035a`，四层实测） |
| 套件 | `vscode-l1-smoke` |
| 生产调用方 | **零** —— `grep -rn "vscodeL1Bridge" apps/desktop/src/ --include=*.ts` 除自身外无结果 |
| 判断 | **待定** —— 见 `extension-a-plus-coverage.md`：A+ 范围实测覆盖不到真实扩展，**接上它之前要先定「做不做」** |

**它做了的事**：VSIX 解析（只认 STORE + 恰好 2 entry）、清单校验、`vscode` API 的 scoped shim（15 个成员）、权限闸。

**它没做的事**：**没有任何 IPC 入口**（`RpcMap` 里 `modules.install` 收的是 `ModuleManifest`，不是 VSIX）。

**所以它不是「差一次装配」，是「差一个产品决定 + 一次装配」。**

---

### 2. ~~`withRendererToolRegistry`（T40）~~ —— **已接上，从清单移除**

| 项 | 内容 |
|---|---|
| 文件 | `apps/desktop/src/main/document/documentToolRendererBinding.ts:58` |
| 生产调用方 | ✅ **`apps/desktop/src/main/ipc/index.ts:177`**：`const registryWrappedDocsAiPorts = withRendererToolRegistry(docsAiPorts);` |
| 判断 | **已经在装配路径上** |

**这条是「盘点结论有保质期」的实例**：T40 卡上写「零调用点」，但 A 的 T104 盘点已经指出前提不成立，**本次复核确认**：`ipc/index.ts` 里两处引用（`:20` import、`:177` 调用）。

**保留这条记录本身**，因为它证明：**「零调用方」这个判断必须当场 `grep`，不能照抄卡。**

---

### 3. ~~`origin.kind`（任务来源）~~ —— **已接上，从清单移除**

| 项 | 内容 |
|---|---|
| 契约 | `packages/contracts/src/ipc/task.ts:91` `TaskOriginSchema`，`:105` 五个值 |
| 消费者 | ✅ **`apps/desktop/src/renderer/components/ide/TaskCenterPanel.tsx:93-102`**：五种 kind 各自映射到图标 + i18n key |
| 判断 | **已接上**（E 做的，写这段时已存在） |

**契约注释说它存在的理由**：

> 合成一个 `user` 会让「这条任务能不能跳回原对话」变成一个靠猜的问题。

**面板现在显示图标（+ i18n 文案），但不显示具体的 session id / agent 名** —— 那是**「接了但只显示了一部分」**，不是「没接」。**不列入本清单**，但如果将来要「点任务跳回原对话」，那是下一步。

---

### 4. `checkDeckPatterns` —— **已接上，从清单移除**

| 项 | 内容 |
|---|---|
| 文件 | `apps/desktop/src/main/document/deckPatternCheck.ts` |
| 生产调用方 | ✅ **`documentToolRuntime.ts:81` import、`:823` 调用**（T73 接的） |
| 判断 | **已接上**，且 `t73-pattern-wiring-smoke` 40/40 盯着「模型真的看得到」 |

**保留这条**：它是「零调用方 → 接上」的**成功案例**，说明这个清单不是只记坏的。

---

## 结论

**当前真零调用方（A 档）：1 个 —— `vscodeL1Bridge`。**

**但它不是「装一下就能用」的那种**：它的产品前提（A+ 范围是否能覆盖真实扩展）实测为**否**，所以**接它之前要先做产品决定**，不是先做技术工作。

**这份清单的诚实边界**：

- 我只查了 **3 个符号**（`vscodeL1Bridge` / `withRendererToolRegistry` / `checkDeckPatterns` + `origin.kind`），**不是全仓扫描**；
- **全仓扫描需要「列出所有导出符号 → 逐个 grep 引用 → 排除套件」**，那是另一个量级的工作；
- **所以这份清单是「已知项」，不是「完整清单」** —— 标题里的「清单」指的是**已确认的这些**，不是「所有零调用方」。

**如果要完整版**，建议的做法是：写一个脚本，扫 `apps/desktop/src/main/**/*.ts` 的 `export function` / `export const`，逐个 grep `apps/desktop/src/` 的引用（排除自身文件），输出零引用且被 `scripts/` 引用的 —— 那才是 C 档的完整名单。
