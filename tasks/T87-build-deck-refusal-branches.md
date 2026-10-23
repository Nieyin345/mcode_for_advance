# T87｜`build_deck` 三个 fail-closed 分支没有断言守着

- Status: delivered（2026-10-23，见末尾回写；57 → 65）
- Category: **测试有效性（真缺口，B 在等全量时发现）**
- Priority: **P1 —— 删掉 `dryRun` 判断，T43 和 T73 都不会红，而模型会真的写出 .pptx**
- Depends on: T43（`0a2aa805`）、T73（`da9484b4`）、T87 的发现者 B
- Exclusive writable files: `apps/desktop/scripts/t43-document-ai-design-pipeline-smoke/main.ts`

## Required Skills
- `mcode-smoke`：给拒绝分支补负控 + 变异验证。

## 背景：B 的链路核查（总控已核实每一条）

`buildDeck` 有 **6 个出口**，只守了 3 个：

| 出口 | 代码位置 | 有断言吗 |
|---|---|---|
| `specDir === null` | — | ✅ T43 `:451`「缺 specDir 时显式拒绝」 |
| `snapshotDeckSpec` 被拒 | `:355-396` | ✅ 六条（未知扩展名 / 界外 / 空目录 / 无页面文件） |
| **`options.dryRun === true`** | **`:716-719`** | ❌ **0 处** |
| **`renderTempRoot()` 为空** | **`:722-724`** | ❌ **0 处** |
| **`outline` 在 specDir 外** | **`:743-746`** | ❌ **0 处** |

**总控核实**：

```bash
grep -rn "没有 dry-run" apps/desktop/scripts/     → 0
grep -rn "outline 必须位于" apps/desktop/scripts/  → 0
grep -rn "受控临时目录" apps/desktop/scripts/      → 只有 ipc-clipboard 的两条无关注释
```

### 为什么这三条特别危险

它们都是 **fail-closed 的拒绝分支** —— 「明确告诉模型该怎么改」的那一类。

**B 的原话**：

> 把 `dryRun` 那个判断删掉，T43 57/57 和 T73 40/40 都不会红，**模型会在 dry-run 时真的写出一个 .pptx**。

**而 `build_deck` 有 5 个套件提到它**（`t24` / `t43` / `t47` / `t63` / `t73`）—— `grep` 出来很热闹，看起来覆盖很好。

**「改坏了也没人发现」的地方，恰好是「出错时告诉你怎么改」的地方。**

## 任务

### 三条负控，各一条

**① `dryRun` 被拒**

> **⚠️ 2026-10-23 更正（B 执行时发现，总控核实）**：本节原来的示例把 `dryRun` 写进了
> `input`，**那是错的**。
>
> `dryRun` 是 `documentToolCall` 的**顶层参数**（`documentToolRuntime.ts:952-960` 的
> `args` 形状），不是 `input` 的字段。**写进 `input` 会被静默忽略**，`dryRun` 根本
> 传不到 `buildDeck` —— **那条负控和它的变异都会失效，而且是「永不红」的失效。**

```ts
const dry = await runtime.documentToolCall(ports, {
  tool: "build_deck", app: "slides", filePath: join(workspace, "dry.pptx"),
  input: { specDir: deck },
  dryRun: true,                                   // ← 顶层，不在 input 里
});
check("★ build_deck dry-run 被显式拒绝，且不写文件",
  dry.ok === false && /没有 dry-run/.test(dry.reason) && !existsSync(join(workspace, "dry.pptx")),
  dry);
```

**注意断言用的是完整短语 `没有 dry-run`，不是 `/dry-run/`** —— 理由见下面「红因要对」。

**关键**：`!existsSync(...)` —— 不只验「拒绝」，要验「**没有真的写出文件**」。

**② 无临时目录被拒**

需要构造一个 `renderTempRoot()` 返回空串的 ports：

```ts
const noTemp = { ...ports, renderTempRoot: () => "" };
const r = await runtime.documentToolCall(noTemp, {...});
check("★ 无受控临时目录时显式拒绝，而不是静默跳过",
  r.ok === false && /临时目录/.test(r.reason), r);
```

**③ outline 越界被拒**

```ts
const outside = join(WORK, "outside-outline.json");   // 在 specDir 外
writeFileSync(outside, JSON.stringify({ pages: [] }), "utf8");
const r = await runtime.documentToolCall(ports, {
  tool: "build_deck", app: "slides", filePath: join(workspace, "o.pptx"),
  input: { specDir: deck, outline: outside },
});
check("★ outline 在 specDir 外时显式拒绝（围栏不因为是 outline 就放宽）",
  r.ok === false && /spec 目录内/.test(r.reason), r);
```

### ⚠️ 每条负控必须带对照组（B 的补充，总控采纳并升为硬要求）

> **一个永远拒绝的实现也能让三条负控全绿。**

所以每条负控配一个**只差一个变量**的正控：

| 负控 | 对照组（只改一个变量） |
|---|---|
| `dryRun:true` → 拒绝 | 同一份 spec、**不带 dryRun** → 成功且真的写出 .pptx |
| `renderTempRoot` 返回 `""` → 拒绝 | 同一次运行**换成真 tempRoot** → 成功 |
| `outline` 在 specDir 外 → 拒绝 | `outline` 在 specDir 内 → 成功 |

**没有对照组，三条负控加起来的证据是「这个函数会拒绝」，不是「这个函数在该拒绝时拒绝」。**

### ⚠️ 变异的正确形态（B 的补充）

**变异 1 不能只注释 `return`，要连 `if` 一起删。**

> 如果把整个 `if` 留着只删 `return`，TS 会把后续当成正常路径——**但那不是断言红，是代码本来就没坏**。正确形态是删掉整个 `if` 块，此时 dry-run 会真的写出 .pptx，负控才红。

**这是变异失效形态 3 的变种**（改坏了程序 ≠ 改坏了被验的东西）。**跑之前先 `git diff` 确认删的是那个 `if` 块。**

### ⚠️ 红因要对：两次变异第一次都红错了地方（B 的实测）

**这是本轮最有价值的记录，比三条断言本身值钱。**

| 变异 | 第一次红了 | 为什么不对 | 改成 |
|---|---|---|---|
| ② 无临时目录 | ✅ 红了 | 断言用 `/临时目录/`，下游 `spec 快照目录 必须是绝对路径` **也命中「目录」二字** | 只认完整短语 `没有受控临时目录` |
| ③ outline 越界 | ✅ 红了 | fixture 放在 `WORK`（**工作区外**），`requireWorkspacePath` 的「不在任何已知工作区」**先拦住了** | 放 **workspace 内、specDir 外** |

**修正后 ③ 的输出才是对的**：

```
{"ok":false,"kind":"failed","reason":"file not found: ...\\controlled-temp\\outside-outline.json"}
```

> **这才是对的**：outline 被映射进快照目录（越界检查失效的直接后果），文件自然不存在。

**两次都是「红得不是同一个原因」——表面上「断言会红」，但红的机制和要证明的事无关。**

**这比「不红」更难发现，因为你会以为验过了。**

### ⚠️ `WORK` vs `workspace`：fixture 放错位置，验的就变成另一道防线

T43 套件里有**两个根**：

- `WORK` —— 临时根（**工作区围栏外**）；
- `workspace` —— **工作区围栏内**，`ports.withinWorkspace` 认它。

**写卡时如果要验「A 检查」，fixture 必须落在「能通过其它所有检查、只被 A 拦住」的位置。**

**B 的话**：

> **fixture 放错一个，验的就变成另一道防线了。**

**这条要进卡模板**：凡是验「某个特定拒绝」，先在卡里写明「这个 fixture 在哪、它会不会先被别的检查拦住」。

## 验收判据

1. **三条负控各一条**，都验「`ok === false` + 拒绝理由 + 没有副作用」。
2. **变异验证**（每条一个）：
   - 删掉 `dryRun` 判断 → 「dry-run 被拒」红（**且要验：变异后真的写出了文件**）→ `cmp` 还原；
   - 把 `renderTempRoot() === ""` 的判断去掉 → 第二条红 → 还原；
   - 把 outline 的 `isAbsolute(rel) || rel.startsWith("..")` 判断去掉 → 第三条红 → 还原。
3. `t43` 数字上升（**实际 57 → 65**：三条负控 + 三条对照 + 副作用断言 + 完整短语）
   ,仍全绿。**不要为了凑「三条」砍掉对照组** —— 砍了它们就排除不了「永远拒绝的实现」。
4. T73 40/40、T65 46/46、T47 27/27 不回归。
5. 双包 typecheck 通过。
6. **不跑全量**、**不起 Electron**。

## 边界

- **只改 `apps/desktop/scripts/t43-document-ai-design-pipeline-smoke/main.ts`**；
- **不改产品代码**（那三个分支的实现是对的，只是没人测）；
- 不碰 `documentToolRuntime.ts`（B 的 T73/T79 边界）；
- 不碰 `deckPatternCheck.ts`。

## 遇到问题先检索

`documentToolCall` 的 `input` 形状先读 `documentToolRuntime.ts:700-750`，**不要凭猜**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T87-build-deck-refusal-branches.md` 末尾追加 `## 结果回写（2026-10-23）`：
三条断言、三次变异、套件数字、提交 SHA。

## 结果回写（2026-10-23）

### 一、三条负控，各配一组对照组

**卡上只写了负控，没写对照组。** 我加了——**一个永远拒绝的实现也能让三条负控全绿**。每条对照组只差一个变量：

| # | 负控 | 对照组（只改一个变量） |
|---|---|---|
| ① `dryRun: true` | 拒绝 + `没有 dry-run` + **磁盘上没有 pptx** | 同一份 spec、**不带 dryRun** → 成功且文件真的落盘 |
| ② `renderTempRoot()` 返回 `""` | 拒绝 + `没有受控临时目录` | **同一个 ports 只把 renderTempRoot 换回真目录** → 成功 |
| ③ `outline` 在 specDir 外 | 拒绝 + `outline 必须位于 spec 目录内` | `outline` 在 specDir 内 → **不因「越界」被拒** |

### 二、卡上一处错误（照抄会写出永不红的断言）

卡上写：

```ts
input: { specDir: deck, dryRun: true },   // ← 错
```

**`dryRun` 是 `documentToolCall` 的顶层参数，不是 `input` 的字段**（见签名 `:952-960`）。写进 `input` 会被静默忽略 —— `dryRun` 根本传不到 `buildDeck`，于是：

- 负控那条断言会**永远绿**（因为 dryRun 没生效，但拒绝理由里也没有 dry-run……实际上会红成别的原因）；
- 更糟：**变异 1（删掉 dryRun 判断）时它也不会红**，因为两条路径都没传 dryRun。

正确写法：

```ts
runtime.documentToolCall(ports, { tool: "build_deck", app: "slides", filePath, input: { specDir: deck }, dryRun: true })
```

### 三、变异验证（三次，两处红因修正）

| 变异 | 第一次结果 | 修正后 |
|---|---|---|
| ① 删掉整个 `if (options.dryRun === true)` 块 | **63/65**，两条红 | — |
| ② 删掉 `if (!root \|\| root.trim() === "")` | **64/65** 红，但**红因不对** | 收紧断言后 **64/65**，红因正确 |
| ③ 把 `rel.startsWith("..") \|\| isAbsolute(rel)` 换成 `false` | **64/65** 红，但**红因不对** | 换 fixture 后 **64/65**，红因正确 |

#### 红因不对的两处（这是本轮最重要的发现）

**变异 ② 第一次**：断言用的是 `/临时目录/`，结果下游 `requireWorkspacePath` 的
`spec 快照目录 必须是绝对路径` 也命中「目录」二字 → 断言红了，但**不是因为我们删的那个判断**。
改成只认 `没有受控临时目录` 这句原话。

**变异 ③ 第一次**：我把 `outside-outline.json` 放在 `WORK` 下（**workspace 外**），
于是 `requireWorkspacePath` 的「不在任何已知工作区」先把它拦住了 ——
**断言红的原因是撞上了另一道围栏，不是越界检查失效。**
改成放在 `workspace` 内、`specDir` 外。修正后变异输出：

```
{"ok":false,"kind":"failed","reason":"file not found: ...\controlled-temp\outside-outline.json"}
```

**这才是正确的红因**：outline 被映射进快照目录（越界检查失效的直接后果），文件自然不存在。

**这两次都是「红得不是同一个原因」**，正是本仓库变异失效形态里最难发现的一种 —— 表面上「断言会红」，但红的机制和要证明的事无关。

### 四、套件数字

| 项 | 结果 |
|---|---|
| `t43-document-ai-design-pipeline-smoke` | **65/65**（57 → 65，+8：三条负控 + 三组对照 + 两条副作用断言） |
| `t73-pattern-wiring-smoke` | **40/40** |
| `t65-deck-pattern-smoke` | **46/46** |
| `t47-design-guide-smoke` | **27/27** |
| `tsc` desktop / contracts | **exit 0 / exit 0** |

卡上写「57 → 60」（三条），实际 **65** —— 因为我按「每条负控必须配对照组」做了，多出的 5 条是对照组与副作用断言。**如果只要 60，我可以砍掉对照组，但那样三条负控就无法排除「永远拒绝的实现」。**

### 五、未做 / 边界

- **只改了 `t43-document-ai-design-pipeline-smoke/main.ts`**，未动产品代码（三个分支的实现是对的）；
- 未碰 `documentToolRuntime.ts`（T73/T79 边界）、未碰 `deckPatternCheck.ts`；
- 未跑全量、未起 Electron；
- 所有变异都 `cmp` 逐字节还原，最终 `grep -c MUTATION` 为 0。

### 六、提交

`5bb50a32` —— `test(T87): guard the three build_deck refusals that nothing was watching`（2 文件，+160/-1）。
