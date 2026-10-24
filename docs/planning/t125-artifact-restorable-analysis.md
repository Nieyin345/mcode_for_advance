# T125 前置分析：二进制产物能不能进任务中心

> **这份是分析，不是卡。** 卡由总控写。本文只回答三件事：`conflicts` 能不能复用、
> 不能复用的话要改哪些地方、**最小可行版本是什么**。
>
> 全部结论来自读代码与实测，不是推的。探针已清理（`.tmp/t124/`）。

---

## 零、结论先行

| 问题 | 答案 |
|---|---|
| `conflicts` 通道能复用吗？ | **不能。** 它的用户文案是「之后又改过，为避免覆盖新改动没有动它们」，语义**不同**（见 §二） |
| 不用改契约能做吗？ | **能，但只能做一半** —— 见 §四的「最小版本」 |
| 最小可行版本 | **让 `apply_ops` 的产物进任务中心，不进 rewind**，**不改任何契约、不改 `fileSnapshot.ts`** |

**但有一个前提必须先说清：任务中心看得见 ≠ 用户点撤销时知道这个文件还原不了。**
§五 给出这个缺口的实际影响。

---

## 一、`conflicts` 通道：机制可复用，**语义不可复用**

### 机制这一层确实现成

```ts
// fileSnapshot.ts:331-347
export interface RestoreReport {
  restored: string[];   // 真写回/删掉的
  failed: string[];     // 越界被拒 / 写盘失败
  conflicts: string[];  // 本轮之后又被改过，拒绝覆盖
}
```

**返回路径完整**：`restoreFiles` → `RuntimeManager.rewindTurn` → IPC
`claude.rewindTurn`（`rpcMap.ts:237`）→ `TurnFilesCard.tsx:99` → toast + 卡片上的
「部分撤销」提示。**不需要新增任何字段就能把路径送上去。**

### 但用户看到的这句话是错的

```ts
// zh/store.ts:31
"store.toast.rewindConflicts": "{n} 个文件之后又改过,为避免覆盖新改动没有动它们"
// en/store.ts:22
"store.toast.rewindConflicts": "{n} file(s) changed again afterwards — left untouched to avoid overwriting the newer edits"
```

**「之后又改过」是一个事实主张。** 一个二进制 `.docx` 从来没被之后改过 —— 它只是
**不可无损还原**（`capturePre` 主动跳过它，见 T124 §二）。把它塞进 `conflicts`：

- toast 会对用户**撒谎**，说文件后来被改过；
- 而 `TurnFilesCard.tsx:117-122` 的注释明写这一段的设计意图是
  「它们不是『还原失败』，是『再写回去会把后来的改动一起毁掉，所以原样留着』」——
  **和二进制文件的处境正好相反**（我们根本不是怕毁掉后来的改动，是根本没有 `before`）。

**所以「复用 conflicts」省下的是 0 行契约改动，付出的是 UI 层一句假话。** 不划算。

---

## 二、如果要加字段：`restorable` 落在哪几个地方

我把链路走了一遍，**需要动的是四处，不是两处**：

| # | 位置 | 改什么 | 为什么不能省 |
|---|---|---|---|
| 1 | `packages/contracts/src/runtime.ts:532` `TurnFileEntry` | 加 `restorable?: boolean` | 它跨 IPC、进 DB、是唯一的事实载体 |
| 2 | `apps/desktop/src/main/lib/fileSnapshot.ts` `freeze()` | 对「有路径但 `before` 不可得」的条目置 `restorable: false` | 这是**唯一**知道 `before` 是不是真读到了的地方 |
| 3 | 同上 `restoreFiles()` | 遇到 `restorable === false` 直接 `conflicts.push`（**且不读 `before`**） | 否则空 `before` 会走到 `atomicReplaceFile` |
| 4 | `apps/desktop/src/renderer/components/chat/TurnFilesCard.tsx` + i18n | 区分「不可撤销」与「之后又改过」两句 | 复用 `conflicts` 就会说假话（§一） |

**还有第 5 个隐蔽的**：`session.ts:759 updateTurnFiles` 把 `TurnFileEntry[]` 整个
`JSON.stringify` 进 DB（`turn_files TEXT`）。**加字段不用迁移**（JSON 天然可扩展），
但**旧会话读出来的条目没有这个字段** → 必须按 `restorable !== false` 判（即缺省为可还原），
否则历史会话一打开就全部变成「不可撤销」。**这和 `afterHash` 当年的兜底是同一条规矩。**

**所以「加字段」的真实工作量：4 个文件 + 1 条向后兼容判断 + i18n 两条。**
不是不可能，但它明显超出「同病同修」的量级。

---

## 三、★ 一条我之前没说清的事实：**这个缺口不是二进制专属**

T124 里我把根因说成「管道只认文本」。**更准确的是：管道只认「`before` 读得到」的文件。**

| 文件 | `before` 读得到吗 | 后果 |
|---|---|---|
| UTF-8 文本 | ✅ | 正常（`Write`/`Edit` 走这条路） |
| **非 UTF-8（含 .docx/.pdf/图片/GBK 文本）** | ❌ `capturePre` 主动跳过 | 进不了 `originals`，`freeze()` 里根本没有这条 |
| 存在但 `EACCES`/`EISDIR` | ❌ 也跳过 | 同上 |

**`unrestorable` 这个集合本来就是为「读不到 `before`」设计的**，它不是二进制专属 ——
**它同时覆盖了 GBK 编码的 `.txt`**（实测：

```
GBK .txt（D6 D0 CE C4）
  FileSnapshot: skip notes.txt (not valid UTF-8, cannot restore losslessly)
  originals: 0   unrestorable: 1   →  freeze: 0 条
```

）。所以 T124 的标题「`document_md_edit` 的产物」比实际问题窄：
**任何被 `unrestorable` 挡住的文件，产物都看不见。**

**这条改变修法的重心**：不是「给 Office 开个口子」，是「让『看得见但不可撤销』成为一种
一等状态」。**这也解释了为什么 `restorable` 这个字段名是对的** —— 它描述的是状态，
不是文件类型。

---

## 四、最小可行版本（不改契约）

**目标：让 `apply_ops` 改过的 `.docx` 出现在任务中心，而 rewind 完全不知道它的存在。**

### 做法：在 `settleTurn` 加第二个产物来源，绕开 `FileSnapshot`

```ts
// autoCreate.ts 的 settleTurn —— 现在是
const artifacts = artifactsOf(args.files);

// 最小版本：adapter 额外发一个「写盘事件」，settleTurn 把它并进来
const artifacts = [...artifactsOf(args.files), ...args.externalArtifacts ?? []];
```

**adapter 那边**（`SdkMessageAdapter.ts`，T123 已经改过的地方）：

```ts
if (b.name === "document_tool_call") {
  const innerTool = raw?.tool;
  const fp = raw?.filePath;
  if (isWriteRoute(innerTool) && typeof fp === "string" && fp) {
    // 写入路由（create + apply）都记，但**不进 FileSnapshot**
    this.state.officeWrites.push({ path: fp, tool: innerTool });
  }
}
```

`isWriteRoute` 要区分 create / apply / read —— **这正是总控在 §三 指出的那张表**：

| 路由 | 写盘 | 进 turn.files | 进任务中心 |
|---|---|---|---|
| `create_document` / `build_deck` | ✅ 新建 | ✅ 已做（T123） | ✅ |
| **`apply_ops`** | ✅ 原地改 | ❌ **不能**（`before` 读不到） | ✅ **最小版本做这个** |
| `read` / `describe` | ❌ | ❌ | ❌ |

**代价**：

1. **`turn.files` 里不会出现这个 docx** → 「本轮文件」卡片不显示它 → **没有撤销按钮**
   —— 这是**正确**的（撤销不了就不该给按钮），但用户也**看不到这次改了什么**。
2. 需要一个新的事件或状态字段把 `officeWrites` 从 adapter 送到 `settleTurn`
   （`turn.files` 的载荷形状是 `TurnFileEntry[]`，塞不进去 —— **要么扩它，要么加一个新事件**）。

**第 2 点是这个「最小版本」的真成本**：省了 `contracts` 的 `TurnFileEntry` 改动，
但**多了一个事件类型**（`RuntimeEvent` 是联合类型，加一个成员要改
`contracts/runtime.ts` + 三个 adapter + `RuntimeManager` 的分发）。

**这一条我核过了，绕不开**：`autoCreate.ts` 的 `onEvent`（`:212-227`）只认两种事件 ——

```ts
if (e.type === "turn.files") { bufferedFiles.set(e.sessionId, e.files); return; }
if (e.type !== "turn.done") return;
```

它没有任何「另一个产物来源」的入口。**所以最小版本要么扩 `turn.files` 的载荷
（`TurnFileEntry[]` 装不下非 `TurnFileEntry` 的东西），要么加事件。两者都是契约改动。**
**「不改契约」这个说法要打折 —— 它不改 `TurnFileEntry`，但仍然要改 `RuntimeEvent`。**

### 更小的版本（真的零契约改动）

**让 `documentToolCall` 的返回值里带上「我写了哪个文件」，`tools.ts` 的 handler 把
它记到一个进程内的 per-session 列表，`settleTurn` 读那个列表。**

- 零契约改动：`ToolResult` 是文本，不加字段；用模块级 `Map<sessionId, string[]>`
- 代价：**进程内状态**，重启丢；且它是**第三条真相**（`CLI_TOOL_MAP` / `CREATE_DOCUMENT_TOOLS` /
  这个 Map）。
- **我不推荐** —— 这个仓库已经因为「两处真相」吃过一次（T123 的注释就是为它写的）。

### 我的建议

**做 `restorable` 那版（§二，4 个文件），不做最小版本。**

理由：

1. 最小版本省不下多少 —— **它仍要改 `RuntimeEvent`**，而那是契约定制里最难的一部分；
2. 它留下了「`turn.files` 里没有、任务中心里有」的分裂，**用户看到「任务产物」里有个文件，
   点「撤销本轮」却找不到它** —— 这比现在「两个地方都没有」更难解释；
3. `restorable` 同时解决 §三 的整类问题（GBK 文本、图片、PDF），**最小版本只解决 Office**；
4. `restorable` 的第 4 处改动（UI 说清「不可撤销」）**是必须的**，最小版本把这一步跳过了 ——
   而那正是总控在第四节担心的事（「用户会以为还原成功」）。

---

## 五、如果只做最小版本，用户会经历什么

**这是总控第四节那条担心的具体答案：**

| 时刻 | 最小版本 | `restorable` 版 |
|---|---|---|
| 回合结束 | 任务中心有产物 ✅，「本轮文件」卡片**没有**它 | 两处都有 ✅ |
| 点「撤销本轮」 | 卡片上列出的文件被还原；**那份 docx 不在列表里，所以用户根本不知道它没被还原** | 卡片列出它，标「不可撤销 · 含二进制内容」，**用户知道** |
| 事后检查 | 用户以为撤销干净了，**磁盘上 docx 还是改过的样子** | 用户知道那份要手动处理 |

**最小版本在这一点上比现状更差一点**：现状是「两个地方都没有」，用户不会对撤销产生
错误预期；最小版本是「任务中心说有产物 → 用户点撤销 → 撤销只回滚了一部分 →
但卡片上没提那份 docx」——**用户会以为整轮撤销干净了。**

**这是「假门禁」的另一个形态：不是伪装成「检查过了」，是伪装成「撤销完了」。**

---

## 六、给总控写卡的三条建议

1. **卡的范围应该是 `restorable`，不是「Office 产物」** —— §三 证明了缺口是
   「`before` 读不到」这一类，Office 只是其中最常出现的一种。
2. **必须包含 UI 那一步**（`TurnFilesCard` + i18n 两条新文案），否则 §五 的
   「以为撤销干净了」照样存在。
3. **向后兼容要写进卡**：`restorable !== false`（缺省可还原），否则历史会话全部变成
   「不可撤销」。这是 `afterHash` 当年踩过的同一条。
4. **卡的写权限必须包含 `fileSnapshot.ts`** —— T123/T124 都把它列为禁区，那是**当时**
   正确的边界；现在它是**唯一的修法入口**，所以要显式解禁并说明理由。

---

## 七、我实测过的原始数字（供卡引用）

```
已存在 .docx → recordPre:
  FileSnapshot: skip …\existing.docx (not valid UTF-8, cannot restore losslessly)
  originals: 0   unrestorable: 1   →   freeze: 0 条

document_tool_call + apply_ops 改已存在 docx:
  turn.files = 0 条
  classifyTurn = {"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}

countLineDiff 对二进制：不可预测（有时 0/0，有时非 0），
  所以不能用 adds−dels 当过滤依据 —— 见总控 §二 的更正，我接受。
```
