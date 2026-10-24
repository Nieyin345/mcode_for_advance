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
