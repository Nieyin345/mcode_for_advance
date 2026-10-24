# O11｜`slides:save-as` 是同一个静默覆盖漏洞的第二个入口

- Status: **ready-for-agent**
- Category: **Office / 数据丢失 —— O10 修了 `slides:save`，但 `slides:save-as` 没修**
- Priority: **P0**（与 O9 同级：用户丢数据且没有任何提示）
- 发现于: O10 交付回写 §14.4（执行会话如实报告「未做」）
- 独占写入边界：`genoffice/apps/slides/src/main/slides-main.ts`（`slides:save-as` handler 一处）
  + O2 套件加一条旅程

## 一、缺口（O10 明确留着，不是漏报）

`slides-main.ts` 的 `slides:save` 现在有守卫：

```ts
await guardedDocumentSave({
  target: session.path,
  format: 'slides',
  write: async () => { await stagedAtomicWrite({ ... }) },
})
```

**`slides:save-as` 没有**：

```ts
ipcMain.handle('slides:save-as', async (e, defaultName: string) => {
  ...
  const r = await showSaveDialogWithMemory(...)
  if (r.canceled || !r.filePath) return { ok: false }
  await savePptxToFile(session.opened, r.filePath)   // ← 直写，无守卫、无原子写
  session.path = r.filePath                          // ← 还改了会话的目标
```

**两个问题，而且我（写卡人）第一版把第一个说错了 —— 见 §一之一。**

1. ~~无版本比较 —— 另存为到一个已存在的文件，直接覆盖，不提示~~
   **← 错。原生保存对话框自己会问覆盖确认（§一之一实测）。**
2. **无原子写** —— `savePptxToFile` 用 `createWriteStream` 直写目标，
   中途失败留**截断的 .pptx**（O10 §10.2 记录过的形态）。**这条是真的。**

### 一之一、写卡人的错，以及它为什么值得留在这里

**我写卡时断言「另存为到已存在文件会静默覆盖」。查过之后是错的。**

**证据（写卡人自己跑过）**：

```ts
// genoffice/packages/electron-utils/src/dialog-memory.ts:75
export async function showSaveDialogWithMemory(dialog, parent, options, fallbackDir) {
  const withDir = withRememberedDirectory(dialog, options, fallbackDir)
  const result = parent ? await dialog.showSaveDialog(parent, withDir) : await dialog.showSaveDialog(withDir)
  ...
}
// withRememberedDirectory 只改 defaultPath，**不动 properties**
// slides 传的 options 里有 `filters` / `defaultPath`，没有 `properties`
// → Electron 的 showSaveDialog 默认 `showOverwriteConfirmation: true`
```

**所以用户在对话框里已经确认过「要覆盖这个文件」。** 「静默覆盖」这个说法不成立。

**但这个错本身有价值**：**它是「我把一个看起来成立的推断写成了事实」的又一次**
（今晚第四次）。**如果我没有先查就派活，执行者会去修一个不存在的问题。**

## 二、为什么它和 `slides:save` 语义不同（不是「照着抄一遍」）

| | `slides:save` | `slides:save-as` |
|---|---|---|
| 目标 | `session.path`（打开的那个文件） | 对话框返回的**另一个**路径 |
| 「打开时版本」 | 在 `documentViewHost` 的会话表里 | **没有** —— 那个文件从没被这个视图打开过 |
| 覆盖已有文件时 | 比版本 → 冲突则拒 | **直接覆盖** |
| 成功后 | 推进版本 | `session.path = r.filePath`（**会话改指向新文件**） |

**所以不能直接复用 `guardedDocumentSave` 的语义** —— 它对「没有打开会话的路径」
是**不拦、直接写**（见 `documentSaveGuard.ts` 的 `if (opened === null) { await ctx.write(); return }`）。

**对 `save-as` 来说，那个「不拦」恰好是错的行为**：另存为到一个已存在的文件，
用户没有理由期待「静默覆盖」。

## 三、产品行为：**已经问过覆盖了，所以本卡不改交互**

**写卡人实测的答案**（§一之一）：原生对话框已经弹过覆盖确认。
**所以本卡接近那个三选项里的 C —— 不拦（用户已确认），但必须补原子写。**

**⚠️ 所以本卡的范围比你看到的第一版小得多：**
**只缺原子写，不缺确认。**

**⚠️ 但有一件事仍然要判断**：**「另存为」之后 `session.path` 改了**（`session.path = r.filePath`）。
**如果目标文件此刻正被另一个视图打开**（`documentViewHost` 的会话表里有它），
**这个视图会不知道它刚被覆盖了。**

**查这个**：

```bash
grep -n "session.path = r.filePath" -A 4 genoffice/apps/slides/src/main/slides-main.ts
grep -n "claimOpenedPath\|冲突\|conflict" genoffice/apps/slides/src/main/slides-main.ts | head
```

**如果 slides 的 save-as 不通知 `documentViewHost`，那另一个打开着同一文件的视图
会在下一次保存时撞上守卫的冲突判据**（它拿的打开版本是旧的，而盘上已被覆盖）——
**那其实是正确的行为**（守卫会拦住它），**但用户会看到一个他不理解的「文档已被别处改动」。**

**这一条写进回写区，不需要修。**

## 四、无论哪个答案，**原子写必须补**

**因为它不需要产品决定**：

```ts
await stagedAtomicWrite({
  target: r.filePath,
  staging: join(dirname(r.filePath), `.${basename(r.filePath)}.${randomUUID()}.mcode-saving`),
  writeTo: (path) => savePptxToFile(session.opened, path),
})
```

**和 `slides:save` 走同一份共享实现。** 这是硬规矩 2。

**⚠️ 而且它对「目标文件之前不存在」的情形也是必要的** ——
`createWriteStream` 写到一半失败，会在用户选的位置留一个**半截文件**，
而用户以为「保存失败，什么都没发生」。

## 五、判据

### 5.1 硬判据

| # | 断言 | 怎么验 |
|---|---|---|
| **1** | **另存为失败时不留半截文件** | 让 `writeTo`（`savePptxToFile`）在写一半时失败，断言**目标路径不存在**（新文件）**或被原样保留**（已有文件） |
| **2** | **另存为成功时，`session.path` 指向新文件** | 保存后再按 Ctrl+S，写的是**新**路径而不是旧路径 |
| **3** | **另存为成功后，原来的目标文件内容正确** | 读回磁盘，比对字节数/内容（不是只看返回 `ok:true`） |
| 4 | **另存为到已存在文件时，对话框会问覆盖** | **不需要写断言** —— Electron 默认行为。**但要在注释里记一句「确认由对话框负责，本卡不改」**，否则下一个人会重新问一遍同一个问题（写卡人就问过） |

**第 1 条是本卡的全部价值**：`stagedAtomicWrite` 的暂存在**同目录**写，失败时
目标位置上一个字节都不会出现。**这和 `createWriteStream` 直写是本质差别——
后者写一半失败会留一个打不开的 .pptx，而用户以为「保存失败，什么都没发生」。**

**第 1 条怎么让它红**（不依赖真 Electron）：

`stagedAtomicWrite` 有 `replace` / `remove` / `writeTo` 三个可注入依赖
（`O10` 的 `staged-write.test.ts` 就是靠这个做纯 Node 断言的）。
**本卡要在 `slides:save-as` 的调用点上做同一件事**：让 `writeTo` 抛错，断言目标未被触碰。

### 5.2 变异

| 变异 | 预期 |
|---|---|
| 把 `stagedAtomicWrite` 换成 `savePptxToFile(session.opened, r.filePath)` 直写 | **判据 1 红**（留半截文件） |
| 另存为成功后**不改** `session.path` | **判据 2 红** |
| 让 `savePptxToFile` 写完但内容截断（模拟部分写） | **判据 3 红** |

**⚠️ 变异表里没有「去掉覆盖确认」那一条** —— 因为那个确认由**原生对话框**负责，
不在我们的代码里。**写一条验不到它的变异，就是写一条永远绿的断言。**

## 六、边界

- 改 `genoffice/apps/slides/src/main/slides-main.ts` 的 `slides:save-as` handler（一处）
- 加 O2 套件的一条旅程 + `expectations.ts` 一条
- 可能需要改 `stagedAtomicWrite` 的调用签名（如果它要求 target 一定是「打开的那个文件」——
  现在看它不要求，只是 `target` + `staging` + `writeTo`）

**不改**：`slides:save`（O10 已正确）、`guardedDocumentSave` 的语义、任何 renderer

## 七、不要做的事

- **不要直接把 `guardedDocumentSave` 套在 `save-as` 上** —— 它「没有打开会话就不拦」的语义
  对 `save-as` 恰好是错的（§二的表）。
- **不要在没确认产品行为之前改覆盖逻辑** —— §三那个问题必须先答。
- **不要假设对话框已经问过覆盖** —— 去读 `showSaveDialogWithMemory`。

## 八、结果回写区

（执行会话追加：§三那个问题的答案、判据 1/2/3 的红绿、三个变异、提交 SHA、补丁文件名）

---

## 三之一、同一张卡上的第二件事：`String(err)` 把内部类名漏进了用户文案

**O10 执行会话核账时发现的（不在它的任务里，`59fa71d9`）：**

### 现象

```ts
// slides-main.ts 的 slides:save catch（vendor 原有写法，HEAD^ 里就在）
} catch (err) {
  return { ok: false, error: String(err) }
}
```

**而渲染端把 `error` 原样拼进状态栏和 toast：`appStatusSaveFailed: '保存失败：{error}'`。**

**所以用户看到：**

```
保存失败：DocumentSaveConflictError: 文档已被别处改动（另一个窗口、Agent 或外部编辑器）…请重新打开后再改。
```

### 为什么它之前没显形

**`String(err)` 一直在，但它从来没接过一个 `name` 会被带出来的对象** ——
vendor 自己的保存错误都是普通 `Error`（`name` 默认 `"Error"`，`String(err)` 得到
`"Error: <message>"`，用户看到的是 `保存失败：Error: …`，那也不算好看，但**没人抱怨过**）。

**O10 的守卫是第一个从这条 catch 抛出的自定义 `Error` 子类**，而它设了
`this.name = "DocumentSaveConflictError"`。**所以「类名漏进文案」是冷路径被加热才显形的。**

**⚠️ 这和 CLAUDE.md 第八条第 8 种形态是同一族**：那条 catch 一直存在，但**从未进过一个
会暴露这个缺陷的错误类型**。

### 影响范围

| 格式 | catch 写法 | 用户看到 |
|---|---|---|
| slides | `String(err)` | `保存失败：DocumentSaveConflictError: …` |
| pdf / markdown / html | `err.message` | `保存失败：文档已被别处改动…` |

**四家里只有 slides 不一样。**

### 两个选项（执行者选一个并写明理由）

**A. 改 `String(err)` → `err.message`**

- 优点：和另外三家一致；
- **风险**：那条 catch 同时兜住 **vendor 自己的全部保存错误**（不止守卫抛的）。
  **改它会改变那些错误的用户文案。**
- **必须先做**：`grep -n "throw new Error\|throw err" slides-main.ts`，
  看这条 catch 能接到哪些错误，**逐个判断 `String(err)` 和 `err.message` 差在哪**。

**B. 只给守卫抛的错误做特殊处理**

```ts
} catch (err) {
  const message = err instanceof Error && err.name === 'DocumentSaveConflictError'
    ? err.message                      // ← 只对守卫的冲突错误去掉类名
    : String(err)                      // ← 其余保持原样
  return { ok: false, error: message }
}
```

- 优点：**零波及**；
- 缺点：多一个 `instanceof`/`name` 判断，**而那个判断本身就是「按名字认错误」** ——
  如果将来有人改了类名，它会静默失效。

**写卡人倾向 B**，因为它的波及面是零，而 A 的波及面需要逐个错误类型核一遍。

### 判据（★ 这条是关键）

| # | 断言 |
|---|---|
| **A1** | 改完之后，**pdf / markdown / html 三家的用户文案逐字节不变** |
| **A2** | slides 的冲突提示**不含** `DocumentSaveConflictError` |
| **A3** | slides 的其他保存错误文案**逐字节不变**（不是冲突的那一类） |

**A1 和 A3 是这条改动最容易伤到的地方** —— 它们防的是「为了修 slides，把别处改了」。
**怎么做**：改前先跑一次，把三家 + slides 非冲突路径的实际 `error` 字符串存下来，
改后逐字节比对。

---

## 三之二、`pickHostWindowPlacement` 的坐标（写卡人在 O10 卡上写错过，这里记正确的）

**跑 sheets 那一格时会撞到它，所以坐标要写对：**

```
apps/desktop/scripts/electron-u1/driver/runner.ts:661
  x: wa.x + wa.width + 80,   y: wa.y + wa.height + 80     ← 主屏工作区右下之外
  note: "offscreen right-below primary work area 1463x775 (no secondary display)"
```

**`-20000, -20000` 是另一处**：`o6-reshell-*/probe.cjs` 与 `o8-docs-theme-gate-smoke/probe.cjs`
里的「没副屏就挪远」分支。**两个不同的机制，别混。**

**后果相同（都无 display surface → `capturePage` 失败），但按错的坐标去读代码会找错地方。**
