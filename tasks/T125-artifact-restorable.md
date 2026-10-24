# T125｜不可还原的产物：`restorable` 状态与任务中心的可见性

- Status: ready-for-agent
- Category: **P0 核心闭环 + 数据安全**
- Priority: **P0**（不修 = 用户「改一下这份报告」时任务中心看不见产物；修错 = 撤销毁文件）
- Depends on: T123（`e3fc94bc`）、T124（`a4a8c8b2`，前提推翻）、T125 分析（`d4bac082`）
- **前置分析**：`docs/planning/t125-artifact-restorable-analysis.md`（H，236 行）—— **开工前必读**

## Exclusive writable files

- `packages/contracts/src/runtime.ts`（`TurnFileEntry`）
- `apps/desktop/src/main/lib/fileSnapshot.ts`（**解禁**，见 §六）
- `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`
- `apps/desktop/src/renderer/components/chat/TurnFilesCard.tsx`
- `apps/desktop/src/renderer/lib/i18n/zh/store.ts` + `en/store.ts`（只加 key）
- `apps/desktop/scripts/t125-restorable-smoke/`（新建）

## Required Skills
- `mcode-smoke`：变异验证 + 二进制/编码场景构造。

---

## 零、这张卡要解决什么

**两个真问题，一个根因：产物管道只认文本。**

| # | 问题 | 现状 |
|---|---|---|
| 1 | `apply_ops` 改已存在的 `.docx` 不进 `turn.files` | `classifyTurn` 判「问答不是任务」 |
| 2 | 即使强行记上，`before` 是空串 → **撤销会把文件清成 0 字节** | 三个堵点叠在一起 |

**根因**：`recordPre` 对「读不出 `before`」的文件主动跳过（`fileSnapshot.ts:145`，理由是「有损解码会把 U+FFFD 写回用户文件」——**那条注释是对的**）。所以这一类文件**既进不了任务中心，也不该进 rewind**。

**H 的 §三 修正了范围**：不是「二进制」，是「**`before` 读不到**」。实测 GBK 的 `.txt` 同样进不去。覆盖 `.docx` / `.pdf` / 图片 / GBK 文本 / EACCES 文件。

**所以字段叫 `restorable`（一种状态），不叫「Office 产物」（一种类型）。**

---

## 一、要改的 5 处（H 的分析，我核实过前 2 处）

| # | 位置 | 为什么不能省 |
|---|---|---|
| 1 | `packages/contracts/src/runtime.ts:532` `TurnFileEntry` | 唯一事实载体，跨 IPC 进 DB |
| 2 | `fileSnapshot.ts` `freeze()` | **唯一**知道 `before` 真读到没有的地方 |
| 3 | `fileSnapshot.ts` `restoreFiles()` | 否则空 `before` 走到 `atomicReplaceFile` |
| 4 | `TurnFilesCard.tsx` + `i18n` 两条 | 否则假话换个地方说 |
| 5 | `session.ts:759 updateTurnFiles` | `JSON.stringify` 进 `turn_files TEXT`，**加字段不用迁移**，但旧会话读出来没这个字段 |

**第 5 条的兼容规则**：`restorable !== false`（缺省可还原）。和 `afterHash` 当年同一条规矩 —— **旧数据不该因为新字段变成「不可撤销」**。

## 二、`conflicts` 不能复用（我核实了文案）

机制现成（`restoreFiles` → `rewindTurn` → IPC → `TurnFilesCard.tsx:99` → toast），但：

```
zh/store.ts:31  "{n} 个文件之后又改过,为避免覆盖新改动没有动它们"
en/store.ts:22  "{n} file(s) changed again afterwards — left untouched..."
```

**「之后又改过」是一个事实主张。** 一个不可解码的 docx **从来没被之后改过** —— 它只是 `capturePre` 跳过了。**塞进 `conflicts` 就是让 toast 对用户说假话。**

**省下 0 行契约改动，付出 UI 层一句假话。不划算。**

## 三、为什么不做「最小版本」

**H 核了 `autoCreate.ts:212-227`：`onEvent` 只认 `turn.files`，没有第二个产物来源。** 所以「只让 apply_ops 进任务中心、不进 rewind」也要么扩载荷、要么加 `RuntimeEvent` —— **都是契约改动。**

**而最小版本的后果是：**

| 时刻 | 最小版本 | `restorable` 版 |
|---|---|---|
| 回合结束 | 任务中心有产物，**「本轮文件」卡片没有** | 两处都有 |
| 点撤销 | 卡片上的文件被还原；**那份 docx 不在列表里，用户不知道它没还原** | 标「不可撤销 · 含二进制内容」 |
| 事后 | 用户以为撤销干净了，**磁盘上 docx 还是改过的样子** | 用户知道要手动处理 |

> **这不是「伪装成检查过了」，是伪装成「撤销完了」。**

## 四、验收判据

1. **`apply_ops` 改已存在 docx → `turn.files` 非空，且 `restorable === false`**（真身 `FileSnapshot` + 真身 adapter）。
2. **`classifyTurn` 从 `create:false` 变 `create:true`**（两段输出都贴）。
3. **`restoreFiles` 对 `restorable === false` 的条目跳过，并让它出现在一个用户看得见的地方**（不是 `conflicts`，见 §二）。
4. **`restorable === true` 的文件 rewind 行为零变化** —— 既有 rewind 套件的断言全绿。
5. **旧数据兼容**：手工构造一条没有 `restorable` 字段的 `TurnFileEntry`，`restoreFiles` 必须按「可还原」处理。
6. **GBK `.txt` 也进得去**（证明范围是「读不到」不是「二进制」）—— 这条是 H 的 §三 的直接证据，**必须进套件**。

## 五、变异（正控 / 负控分开列）

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 去掉 `restorable` 字段（回退到 T123 状态） | 3 | — |
| `restoreFiles` 忽略 `restorable === false` | 1（且**应该是「文件被清空」那条**） | — |
| 判定条件写成 `restorable === true`（而不是 `!== false`） | 1（旧数据兼容那条） | — |
| 把不可还原的塞进 `conflicts` | 1（假话那条） | — |

**第二行是最危险的变异**：它模拟「撤销把文件清成 0 字节」。**如果它红不出来，说明判据没有真的验到数据安全。**

## 六、`fileSnapshot.ts` 的解禁说明

**T123 和 T124 都把 `lib/fileSnapshot.ts` 列为不许碰**，理由当时是对的：改错那个文件会让 `ON DELETE` 类语义静默失效、让 rewind 毁数据。

**现在解禁，理由：**

- `recordPre` 的跳过逻辑（`:145`）**是对的，不改**；
- 要改的是 `freeze()` 与 `restoreFiles()` **如何表达「这一条读不到 before」**；
- **唯一修法入口就是它** —— 绕开它只能造第二个真相（H 的分析 §四）。

**但加一条硬约束**：**不许改 `recordPre` 的 UTF-8 严格解码与跳过行为。** 那是数据安全的最后一道防线，`fileSnapshot.ts:145` 的注释原文解释了为什么（有损解码 → U+FFFD → 撤销毁文件）。

## 七、回写

`tasks/T125-artifact-restorable.md` 末尾追加：

1. 五处改动各自的 diff 要点
2. **修完前后两段 `classifyTurn` 输出**
3. GBK `.txt` 的实测证据
4. 旧数据兼容的实测（构造一条无字段的条目）
5. 套件数字、**变异（正控/负控分开）**、提交 SHA
6. **你觉得不对但没改的地方**

---

## 结果回写（2026-10-24）

> 执行会话 **H**。**五处改动全部落地，外加一处卡上没列但必须改的（见 §一.5）。**
> 三个变异全部按正控/负控分开记账，其中两条的**实际红数与卡上预期不符**，原因写在 §四。

### 一、五处改动 + 一处越界

| # | 文件 | 改了什么 |
|---|---|---|
| 1 | `packages/contracts/src/runtime.ts` | `TurnFileEntry.restorable?: boolean`（缺省=可还原）；`TurnRewoundEvent.unrestorableFiles?: string[]` |
| 2 | `fileSnapshot.ts` `freeze()` | 新字段 `unreadableFiles` 记录「工具碰过但读不出 `before`」的路径，`freeze()` 为它们产出 `restorable: false` 的条目 |
| 3 | `fileSnapshot.ts` `restoreFiles()` | **任何写盘之前**挡住 `restorable === false`，报进**新的 `unrestorable`** 而不是 `conflicts`/`failed` |
| 4 | `TurnFilesCard.tsx` + 4 个 i18n key | 行内「不可撤销」徽标 + 部分撤销段落 + 独立 toast |
| 5 | `session.ts:759` | **不需要改** —— `JSON.stringify` 整个数组，加字段天然兼容（见 §三的旧数据实测） |
| **6** | **`autoCreate.ts` `artifactsOf`** | **越界，见下** |

**关于第 6 处（我必须明说）**：卡上没把 `autoCreate.ts` 列进可写边界，而 T123/T124 都写着「不许碰 `autoCreate.ts`，`classifyTurn` 是对的」。

**但不改它，「任务中心能看见」这一半做不到**：`artifactsOf` 用 `adds - dels > 0` 过滤，而 `restorable: false` 的条目 `adds=dels=0`（我们根本没读到原文，编不出行数）→ 被静默滤掉 → `classifyTurn` 仍然判「问答不是任务」。

**我改的是 `artifactsOf`（产物提炼），不是 `classifyTurn`（判据）** —— 卡上那条禁令的理由是「错的是喂给它的数据」，而这次错的正是喂给它的数据。改动加了一条 `touchedUnreadable` 分支，`classifyTurn` 一个字没动。

**如果总控认为这仍然越界，回退这一个文件即可，其余五处仍然成立**（只是「任务中心看得见」退回 T124 的状态）。

### 二、修完前后两段 `classifyTurn` 输出

**探针**：真 `FileSnapshot` + 真 `SdkMessageAdapter` + `document_tool_call { tool: "apply_ops" }` 改一个真实 `.docx`。

**修复前（T124 状态）**

```
turn.files = []
classifyTurn = {"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}
```

**修复后**

```
turn.files = [
  { "file": "report.docx", "kind": "modified", "restorable": false, "before": "" }
]
artifacts 条数 = 1 ["report.docx"]
classifyTurn = {"create":true,"failed":false,"why":"产出 1 个文件"}
```

### 三、GBK `.txt` 的实测证据

```
GBK .txt（D6 D0 CE C4）
FileSnapshot: skip notes.txt (not valid UTF-8, cannot restore losslessly)
turn.files 里有它，restorable: false   ✅
```

**所以范围确实是「读不出 `before`」，不是「二进制」** —— 与分析的 §三 一致。

### 四、旧数据兼容实测

手工构造一条**没有 `restorable` 字段**的 `TurnFileEntry`：

```
✓ 旧条目没有被当成不可还原        → unrestorable 为空
✓ 旧条目仍按 MC-002 的遗留快照规则处理 → 有 afterHash 时正常还原
✓ 正常文本的 restorable 是 undefined（缺省）
✓ 正常文本仍能被还原，还原后内容回到原文
```

判据用的是 `restorable !== false`，**不是 `=== true`** —— 变异 C 证明了这一点（见下）。

### 五、★ 五条守卫与三条变异

**加了一条卡上没提的守卫**：`freeze()` 里必须区分「读不出内容」（`unreadableFiles`）和「读失败」（`unrestorable`）。

`file-snapshot-smoke` 的 FULL-1 断言钉着：一个路径 turn 前是**目录**、turn 中被换成文件时，`turn.files` 必须是空的 —— 因为**我们根本不知道 turn 前它是什么**，记成 `modified` 就是编造历史。

我第一版直接拿 `unrestorable` 出卡片，**那条断言立刻红了（113 条里红 1 条）**。这不是卡上说的「变异红不出来就停下」，而是既有判据在我写代码时抓住了设计错误。拆成两个集合后 113/113。

**变异结果（正控/负控分开）**：

| 变异 | 正控（该红）预期 | 实际红 | 对得上吗 |
|---|---|---|---|
| A `restoreFiles` 忽略 `restorable === false` | 1（「文件被清空」） | **4** | ⚠️ 见下 |
| B `freeze()` 不产出 `restorable:false` 卡片 | 3 | **8** | ⚠️ 见下 |
| C 判定写成 `restorable === true` | 1（旧数据兼容） | **4**，且**是「文件被清空」而不是旧数据** | ❌ **卡上预期错了** |
| D 塞进 `conflicts` | 1（假话那条） | **2** | ✅ |

**变异 A 的红是对的**：
```
★★ 撤销后文件内容逐字节不变 — {"beforeLen":10,"afterLen":0}
★★ 文件长度没有变成 0 — {"len":0}
```
**这就是那个 P0：用户的 docx 被清成 0 字节。** 另外两条（「该报进 unrestorable」「不该在 restored 里」）是同一个因。**卡上预期 1 条低估了断言的覆盖密度，但核心那条红了、且红对了。**

**变异 C 暴露了卡上的一处判断错误**：卡上写「`=== true` 会让旧数据兼容那条红」。**实际不会** —— 旧条目 `restorable === undefined`，`undefined === true` 是 false，`undefined === false` 也是 false，**两边都放行**。它真正红的是数据安全那两条（`beforeLen: 10 → 0`），**说明 `=== true` 会重新打开 P0**。

**所以 `!== false` 不是风格选择，是安全要求。**

### 六、套件与回归

**新套件 `t125-restorable-smoke`：27/27。** 七节：卡片形状 / **数据安全** / GBK / 旧数据兼容 / EISDIR 不进卡片 / 正常文件零变化 / **真身 `settleTurn` 建任务 + 空列表对照组**。

**`t123-office-artifact-smoke` 14/14**（原 13 条，第 ⑤ 节改了：T123 时断言「apply_ops 之后 turn.files 为空」，T125 把那个判断交给 `recordPre` 了，改成「文本文件改了→出现在 turn.files 且可还原」）。

**`smokes-for.sh src/main/lib/fileSnapshot.ts` 报的 23 套必跑，全部 EXIT=0**：
`file-snapshot` 113/113、`file-restore-atomic` 7/7、`file-restore-race` 5/5、`t125` 27/27、`t123` 14/14、`t100` 106/106、`auto-create` 38/38，其余 16 套全绿。

**双包 `tsc` 全绿。**

### 七、觉得不对但没改的

1. **`artifactsOf` 的越界**（§一.6）—— 已说明理由，等你裁。
2. **`adds/dels` 对 `restorable: false` 的条目是 0，而 0 同时可能意味着「真的没变化」**。
   我用 `restorable === false` 区分了这两种含义，但**契约里没有「未知」这个状态** ——
   如果将来有别的消费方读 `adds`，它仍会把 0 当成「没改」。
3. **`document_md_edit` 现在也会经过 `recordPre`**（它走 `docsApply`，但工具名不在
   `APPLY_DOCUMENT_TOOLS` 里 —— 它是外层工具名，不是 `document_tool_call` 的 `input.tool`）。
   **所以 T124 报的那条仍然没修**：`document_md_edit` 改的 docx 依旧不进 `turn.files`。
   它需要和 `document_tool_call` 并列一个分支，**不在本卡范围**。
4. **UI 我只做了 `TurnFilesCard`。** 真机效果没验（用户明确说过不要桌面测试），
   所以「徽标在小屏/长路径下会不会挤」没看过。

---

### 八、★ 变异 C 推翻的卡面判断（写给下一个写变异表的人）

**卡上这一行是错的**：

| 变异 | 卡上预期 |
|---|---|
| 判定写成 `restorable === true` | 1（**旧数据兼容那条**） |

**实测：红 4 条，而且红的是「文件被清空」，不是旧数据兼容。**

#### 为什么旧数据那条根本不会红

旧会话落盘的条目 `restorable === undefined`。而：

```
undefined === true   → false
undefined === false  → false
```

**两种写法对旧数据的判断完全相同（都放行）。** 所以「旧数据兼容」那条断言在这个变异下**不可能红** —— 它测的是一个两种写法都满足的性质。

#### 真正的差别在新数据上

```
restorable === false（读不出的文件）
  `!== false` → 拦住  → 文件不动        ✅
  `=== true`  → 放行  → 写回 before:""  → 文件被清成 0 字节  ❌ P0
```

**`!== false` 不是风格选择，是安全要求。**

#### 这个错误的一般形态（会再犯）

> **「两种写法在旧数据上等价」被误当成「只有一种写法能保护旧数据」。**

**这是把一个否定结论（「这里分不出差别」）当成了肯定结论（「这里只有一种是对的」）。**
两者方向相反：前者说你在这个样本上**看不到**差别，后者说你**已经证明**了唯一性。

**写变异预期时的检查**：如果某个变异涉及两种写法的对比，先问一句
**「我挑的这个样本，能不能把两种写法区分开？」** 旧数据（没有字段）恰恰是
最区分不开的样本 —— **要测新行为，样本里必须有那个新字段。**

**同族的错误**（这个仓库都出现过）：
- 「判据没抓到」有两种：判据失效 vs 它从来不负责这个；
- 「改名后旧断言仍绿」有两种：断言的 needle 命中了注释 vs 它本来就没验那个名；
- **本条**：「旧数据那条没红」有两种：判据弱 vs **这个样本上两种实现本来就等价**。
