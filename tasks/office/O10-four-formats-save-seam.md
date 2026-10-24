# O10｜四个格式的写盘接缝：把「谁的版本」和「写」放进同一份租约

- Status: **ready-for-agent**
- Category: **Office / 数据丢失修复**（O9 诊断的落地）
- Priority: **P0**
- Depends on: **O9**（分类已完成，见下）、O5 批三（已落地，`typecheck` 0 条）
- 独占写入边界：见 §六 —— **vendor 三文件 + Mcode 新模块 + O2 判据翻转**，不碰其他

## 一、要修的是什么（O9 已确诊，不需要再诊断）

| 格式 | 现状 | 保存时 |
|---|---|---|
| docs | `host-cas` | 走 `saveOpenedFile`，`withOsFileLease` 内重算 `fileContentVersion` 比较 |
| sheets | `vendor-own-guard` | vendor handler 自己比 `session.sha256` |
| **slides** | **`bypass`** | `savePptxToFile(session.opened, session.path)` —— 直接写 |
| **pdf** | **`bypass`** | `savePdfToPath` → `writePdfAtomically` —— 直接写 |
| **markdown** | **`bypass`** | `writeTextAtomic` → `atomicWriteFile` —— 直接写 |
| **html** | **`bypass`** | 同上 |

**O2 实测**：这四种格式冲突时 `{ok:true}`、界面显示「已保存」、**对方内容已丢**。

**O2 的 `save-paths.ts` 已经是可重复的分类器**（`apps/desktop/scripts/o2-conflict-u1-smoke/save-paths.ts`），
它在源码漂移时自己会红。**先跑它，确认现在是四种 `bypass`。**

## 二、★★ 上游已经把这件事写进注释了（先读这句）

`genoffice/apps/pdf/src/main/atomic-write.ts` 的文档注释原文：

> **This primitive protects temporary-file ownership.**
> **The caller/Host must still enforce the source version and file lease for concurrent editors.**

**这是 vendor 自己划的责任边界**：原子写只保证「不会写坏」，**版本校验和文件租约是 Host 的责任**。

**所以本卡不是「给 vendor 打补丁」，是「补上 vendor 明说该由 Host 做的那一半」。**
这个定性决定了两件事：
1. **不需要动 vendor 的保存逻辑**（那是它的职责，已经正确）；
2. **不需要改请求类型加字段**（版本不该穿到渲染端再回来，见 §三）。

## 三、★ 为什么不用「请求加 revision 字段」那个方案

`SavePdfRequest` / `SaveMarkdownRequest` / `SaveHtmlRequest` **没有版本字段**，`slides:save` 连参数都没有。

**看起来最自然的修法是「给请求加 `expectedRevision`」—— 不要这么做**，原因有三条：

1. **渲染端不知道版本**：它只知道「我打开时看到的内容」。而用户真正要防的是
   「**盘上内容和这个视图打开时不一样**」—— 这个知识**只有主进程有**
   （打开时 `fileContentVersion`、谁在编辑它、Agent 有没有写过）。
   让渲染端回报版本，等于让它转述一个它拿不到的事实。
2. **四条通道全改 = 碰 vendor 的 shared 契约**，且五个 app 的 preload 都要动。
3. **docs 已经证明主进程侧快照就够了**：`saveOpenedFile` 在
   `expectedRevision === undefined` 时**用打开会话表里记下的版本**
   （`documentViewHost.ts` 的 `const expected = expectedRevision !== undefined ? expectedRevision : await session.revision`）。
   **页面从不传版本，CAS 照样生效** —— 这就是 O9 里说的「乐观锁」。

**所以：版本由主进程自己记、自己比，渲染端一行不改。**

## 四、接缝放在哪（★ 这是本卡最重要的判断）

### 4.1 不能用 `ipcMain.removeHandler` 重注册 —— **拿不到原 handler**

`removeHandler(channel)` 只按名字摘掉，**原 handler 的函数引用不在 Mcode 手里**
（它在 vendor 模块的闭包里）。重写一遍保存逻辑 = 违反硬规矩 2（共享实现只有一份）。

**唯一正确的形状**：在 vendor 的**写盘调用点**加一个「默认就透传」的接缝，
Mcode 装一个守卫进去。**不装时行为逐字节不变**（这条要有断言，见 §五.4）。

### 4.2 三个接缝点（已核实到函数名）

| 格式 | 接缝 | 位置 | 现状 |
|---|---|---|---|
| **html** | `writeTextAtomic(path, text)` | `html-main.ts:1175` | 私有函数，内部 `await atomicWriteFile(...)` |
| **markdown** | `writeTextAtomic(path, text)` | `markdown-main.ts:645` | **同名同签名**，实现逐字相同 |
| **pdf** | `writePdfAtomically(targetPath, bytes)` | `pdf-main.ts` → `./atomic-write` | 已 export，**注释已写明漏了版本+租约** |
| **slides** | `savePptxToFile(deck, path)` | 从 `pptx-engine` 导入 | 见 §4.4 |

**html 与 markdown 的 `writeTextAtomic` 实现逐字节相同** —— 两行函数，
`await atomicWriteFile(path, Buffer.from(text, 'utf8'))`。**这是同一份实现的两个副本，先合并再挂接缝**（见 §4.5）。

### 4.3 ★ 契约形状（一个函数，三条语义）

**新建 `genoffice/packages/electron-utils/src/document-save-guard.ts`**：

```ts
export interface DocumentSaveGuardContext {
  /** 归一化后的真实路径（realpath，文件不存在时 resolve） */
  target: string
  /** 这次保存的格式 */
  format: 'pdf' | 'markdown' | 'html' | 'slides'
  /** 真正执行写盘的函数 —— 由调用点传入，**保证写发生在租约内** */
  write: () => Promise<void>
}

export type DocumentSaveGuard = (ctx: DocumentSaveGuardContext) => Promise<void>

let installed: DocumentSaveGuard | undefined

/** 装守卫。传 undefined 卸载。**默认没有守卫 = 直接写**（独立运行时的行为）。 */
export function setDocumentSaveGuard(guard: DocumentSaveGuard | undefined): void { installed = guard }

/** 写盘唯一出口。没有守卫时与改动前逐字节等价。 */
export async function guardedDocumentSave(ctx: DocumentSaveGuardContext): Promise<void> {
  if (!installed) return ctx.write()
  return installed(ctx)
}
```

**为什么把 `write` 作为回调传进来、而不是让守卫自己写**：
**版本比较和写必须发生在同一份租约内**。如果守卫只做「比较 → 返回 ok」，
然后调用点再写，就是 TOCTOU —— `documentViewHost.ts` 的注释专门记过这个坑：

> 此前"重算 → 比较"与 `atomicReplaceFile` 分属两步，两个保存可以都读到旧版本、
> 都通过比较、再先后 rename —— 后者静默覆盖前者（注释里登记的 TOCTOU）。

**所以 `write` 必须在守卫的租约回调里被调用。**

### 4.4 slides 单列一条：它的写盘不经过上面任何一层

`slides-main.ts:4583` 的 `ipcMain.handle('slides:save', ...)` 里直接
`await savePptxToFile(session.opened, session.path)`，`savePptxToFile` 从 `pptx-engine` 导入。

**要查**：`savePptxToFile` 内部是否最终走 `atomicWriteFile`（大概率不是，pptx-engine 是纯库）。

**如果是 `writeFile` 直写**：在 `slides-main.ts` 的调用点包一层 `guardedDocumentSave({ format: 'slides', target: session.path, write: () => savePptxToFile(...) })`。
**如果它已经走 `atomicWriteFile`**：`atomicWriteFile` 那一层的接缝会覆盖它，**先别重复挂**（见 §4.5 的判据）。

**这条要作为执行时的第一个检查**，结论写进回写区。

### 4.5 不要挂在 `atomicWriteFile` 上 —— 那个粒度太粗

`atomicWriteFile` 被 **docs 的 7 个非保存路径**（导出、恢复、图片落盘、打印）和
sheets 的导出共用。挂在那层会把「导出」也算成「保存」，**给不该拦的东西加锁**。

**所以只在四个保存调用点挂接缝。**

## 五、判据（★ 每条都要能红）

### 5.1 主判据：O2 的套件翻绿（逐个翻，不要一次翻）

`apps/desktop/scripts/o2-conflict-u1-smoke/` 已有判据，`expectations.ts` 里
`expectConflict` 翻成 `true`：

```bash
pnpm test:smoke o2-conflict-u1-smoke --variant=expect-green
```

**⚠️ 一次只翻一个格式**（O9 §四已经写明理由）：一次全翻，红的和本来就红的分不清。

**预期顺序**：html → markdown（同一份实现，先做这两个能一次验两次）→ pdf → slides。

### 5.2 ★ 「默认透传」的负控（这条最容易被漏掉，但它防的是最坏的回归）

**不装守卫时，四个格式的保存行为必须与改动前逐字节相同。**

**怎么做**（复用 O6 那套已经证明可行的方式：跑真实构建产物 + 原厂 preload）：
1. 在**不**调用 `setDocumentSaveGuard` 的 Electron 进程里打开 html，保存；
2. 断言：文件内容正确、**没有 `.mcode-lock` 残留**、`getComputedStyle` 无关但**保存耗时无可观测变化**；
3. **对照**：装了守卫那一轮，必须能看到守卫被调用（计数器 +1）。

**没有这条负控**：「守卫从来没被装上」和「守卫装上了但逻辑正确」在判据 5.1 里**长得一样**。

### 5.3 ★ 租约内写（防 TOCTOU）—— 这条是**真并发**断言

**必须两个保存真的同时跑**，不能串行调用两次。

`documentViewHost.ts` 有现成的接缝可以借用：`this.beforeAtomicReplace(real)`
（注释原文：**「诊断/测试接缝：生产是 no-op；回归网在这里把『胜者持锁窗口』拉长以做真并发断言。」**）。

**断言**：两个并发保存 → **恰好一个 `ok:true`，一个 `conflict`**，且**盘上是赢家的内容**（不是"两个都成功但后写的赢了"）。

### 5.4 四条判据要和 O2 的三条**互相独立**（O9 §五的要求）

O2 证明过：只删提示 DOM → 只有 4c 红，4a/4b 仍绿。**修完后要重新证明一次**，
因为修法可能把三条揉成一条（比如让 4c 直接读 4a 的返回值）。

| 变异 | 预期 |
|---|---|
| 去掉版本比较（守卫恒透传） | 4a / 4b / 4c **都必须红** |
| 只删提示 DOM（保留版本比较） | **只有 4c 红**，4a / 4b 仍绿 |
| 守卫恒定冲突（永远拒绝） | 4a/4c 绿但 **#5 不误报必须红** |

### 5.5 `save-paths.ts` 必须跟着改，而且**改完还要能红**

`save-paths.ts` 现在断言「Mcode 侧没有对这四条通道的引用」——
**本卡一落地，那条断言就会红**。这是**设计好的**：它是「归类可能已变，请重核」的哨兵。

**改法**：把四个格式的 `klass` 从 `bypass` 改成 `host-guarded`，证据换成接缝的原文。
**并且**：给 `save-paths.ts` 加一条新断言 —— **「守卫必须在四个调用点上被调用」**，
用只有那条路径才有的原文去搜（不是搜 `guardedDocumentSave` 这个名字，搜调用点的完整形状）。

**变异**：把某个调用点的守卫撤掉 → `save-paths.ts` 必须红。**不做这条，它就是一句注释。**

## 六、写入边界（精确到文件）

**vendor（`genoffice/`，分支 `mcode/integration`）**
- 新建 `packages/electron-utils/src/document-save-guard.ts`
- `packages/electron-utils/package.json` 的 `exports` 加一条
- `apps/html/src/main/html-main.ts`（`writeTextAtomic` 改走 `guardedDocumentSave`）
- `apps/markdown/src/main/markdown-main.ts`（同）
- `apps/pdf/src/main/atomic-write.ts`（`writePdfAtomically` 挂接缝）**或** `save-pdf.ts` 的调用点 —— 二选一，§4.4 的检查决定
- `apps/slides/src/main/slides-main.ts`（§4.4 的结论决定要不要动）
- **不改**：任何 `renderer/`、任何 `shared/ipc.ts` 的请求类型、`packages/ui/`

**Mcode（`apps/desktop/`）**
- 新建 `src/main/document/documentSaveGuard.ts`（实现 `DocumentSaveGuard`：
  打开会话表 + `withOsFileLease` + `fileContentVersion`）
- `src/main/document/genofficeNativeVendor.ts`（**只在装守卫那一处**加 `setDocumentSaveGuard`）
- `scripts/o2-conflict-u1-smoke/expectations.ts`（逐个翻 `expectConflict`）
- `scripts/o2-conflict-u1-smoke/save-paths.ts`（§5.5）
- `build/genoffice-upstream.lock.json` + `build/verify-genoffice-upstream.cjs`（新补丁要进账本，T39/T115/O6 先例）

**不得改**：`ipc/documentView.ts` 的 docs 通道（它已经是对的）、`packages/contracts/`、任何 renderer

## 七、主进程侧守卫怎么写（给执行者的骨架，**不是让你照抄**）

Mcode 侧的职责是**「打开时版本」+「租约」+「冲突上报」**，三件都要：

```ts
// src/main/document/documentSaveGuard.ts（骨架）
export function makeDocumentSaveGuard(deps): DocumentSaveGuard {
  return async ({ target, format, write }) => {
    const opened = openedRevisionFor(format, target);   // ← 打开时记下的版本
    return withOsFileLease(target, async (real) => {
      const current = await fileContentVersion(real);
      if (opened !== null && current !== opened) {
        throw <冲突错误>;                                // ← 必须让渲染端看得见（4c）
      }
      await write();                                     // ← 租约内写
      recordRevision(format, real, await fileContentVersion(real));  // ← 推进
    });
  };
}
```

**三个必须回答的问题，写进回写区**：
1. **`openedRevisionFor` 从哪来？** —— 三条存储路径各自在什么时候记下打开时的版本？
   `openPathByWc` 是现成的（html/markdown/pdf 都有），**但它记的是路径不是版本**。
2. **冲突怎么变成渲染端看得见的东西？** —— docs 走的是 `{ ok:false, reason:'conflict', message }`。
   四个 vendor 格式的 `SaveXxxResult` 形状不同（pdf 是 `{ok, error}`，md/html 是 `{ok, error|canceled}`），
   **`error` 字段能不能承载一句人话？异常会不会被 vendor 的 try/catch 吞成 `{ok:false}` 而丢掉 message？**
3. **`slides:save` 的返回值里带整个 `slides` 渲染树** —— 冲突时返回 `{ok:false}` 会不会让渲染端停在旧画面？

**这三个问题决定守卫的错误形状，先答再写。**

## 八、不要做的事

- **不要给请求类型加版本字段**（§三）。
- **不要重写保存逻辑**（硬规矩 2；而且会丢掉十个功能：pdf 的 redaction 事务、md/html 的资源搬迁、slides 的 metaRev）。
- **不要把接缝挂在 `atomicWriteFile` 上**（§4.5）。
- **不要一次翻四个 `expectConflict`**（§5.1）。
- **不要为了绿而放宽 O2 的判据** —— 现在四个格式是真的坏，绿只说明改了判据。
- **不要在保存路径上新增一次全文件哈希**（已有 `fileContentVersion`，`documentViewHost.ts:297` 记过它的缓存行为 —— 复用，不要另起一套）。

## 九、结果回写区

（执行会话追加：§4.4 的检查结论、三个问题（§七）的答案、每个格式的翻转前后数字、变异记录、提交 SHA、补丁文件名）

---

## 十、⚠️ 追加：slides 的失败路径（2026-10-24 深夜，实测发现）

### 10.1 第一版的问题

执行会话第一版把 `savePptxToFile` 包成：

```ts
try {
  await savePptxToFile(session.opened, staging)   // 写成功，数据完整
  await rename(staging, session.path)              // 可能失败
} finally {
  await rm(staging, { force: true }).catch(() => {})   // ← 把唯一副本删了
}
```

**实测**（`.tmp/probe-rename-finally.mjs`，用同样的结构和同样的 `finally`）：

```
成功路径后 target = NEW CONTENT
rename 失败后 threw = true , target = ORIGINAL-2
→ staging 里的新内容还在吗？ (finally 已把它删了)
```

**场景**：`savePptxToFile` 花几秒把整个 deck 写进 staging（**数据完整**），
`rename` 因 Windows 的 `EBUSY`/`EPERM`（杀毒、索引器、OneDrive 同步锁住目标）失败，
**`finally` 把那份完整的 deck 删了**。用户看到「保存失败」，编辑全丢。

**比原 bug 更坏**：

| 形态 | 中途失败后 |
|---|---|
| 原来（直写目标） | 目标被截断，**至少文件还在**，部分内容能用恢复工具捞 |
| 第一版（staging + finally 删） | **新内容一个字节都不剩** |

### 10.2 上游已经写对了

`packages/electron-utils/src/atomic-write.ts` 的 `atomicWriteFile`：

```ts
try {
  await writeFile(tmp, data); await syncFileBestEffort(tmp)
} catch (error) {
  await unlink(tmp).catch(() => {})    // ← 只在「tmp 没写成功」时删
  throw error
}
try { await renameWithRetry(tmp, filePath); return } catch { /* fall through */ }
// Keep the completed temp until the fallback lands: if that write fails
// or the process dies, the new bytes still exist somewhere on disk.
await writeFile(filePath, data)        // ← rename 失败 → 退回原地写
await unlink(tmp).catch(() => {})      // ← 写完才删
```

**注释原文就是这条规矩**：
> **Keep the completed temp until the fallback lands: if that write fails
> or the process dies, the new bytes still exist somewhere on disk.**

### 10.3 判据（这条必须能红）

**让 `rename` 失败，然后断言「新内容还在某处」。**

失败做法：把 `session.path` 指向一个**目录**（`rename` 到目录会失败），
或 mock `node:fs/promises` 的 `rename` 抛 `EBUSY`。

**断言两件事**：
1. 保存返回 `{ ok: false }`（用户知道失败了）；
2. **盘上能找到一个包含新内容的文件**（staging 或目标）。

**第 2 条是这条 bug 的核心 —— 没有它，「失败」和「失败且数据全丢」在断言里长得一样。**

### 10.4 为什么三条现有判据都没抓到

| 判据 | 覆盖的世界 |
|---|---|
| O2 套件 | **正常保存**（能写就成功） |
| §5.2 默认透传负控 | **没装守卫时行为不变** |
| §5.3 真并发 | **两个保存同时跑** |

**三条都在「事情能成」的世界里。而 `finally` 的 bug 只在「事情不成」的时候发生。**

**这是本卡自己 §5.3 的反面**：那里我要求「真并发」是因为串行调用验不到 TOCTOU；
**这里要求「真失败」是因为正常路径验不到失败路径。**
两者是同一个道理的两种形态 —— **判据必须经过它要证明的那条分支。**

### 10.5 另三家已核

- `pdf` → `writePdfAtomically`：`catch` 里 `if (owned)` 才删 tmp，且注释写明
  「Cleanup must not replace the actual write/rename error」。**对。**
- `html` / `markdown` → `atomicWriteFile`：见 §10.2。**对。**

**所以四家里只有 slides 需要自己写这段，而且只有它原来连原子写都没有。**

---

## 十一、追加要求（2026-10-24 深夜，来自基线诊断）

### 11.1 `provenance` 必须与 `expectConflict` 同时改

执行会话把 `html.expectConflict` 从 `false` 翻成 `true`，**而 `provenance` 还写着「没有版本比较」**。

**`expectConflict: true` 恰恰意味着「现在有版本比较了」。** 那条 `provenance` 从此在说自己的期望值是错的。

**这个字段今天救过一次**：写卡人从「html 的 provenance 说没有版本比较，却写 `true`」
这个矛盾里，发现了原来的 `false → true` 是数据错误。
**而现在它自己成了矛盾源。**

**要求**：六个格式逐条核。`expectConflict: true` 的 `provenance` 写清**守卫的出处**，不写「已修」：

```
html-main.ts 的 writeTextAtomic 走 guardedDocumentSave
（@genoffice/electron-utils/document-save-guard）；Mcode 装配期 setDocumentSaveGuard
装上守卫后，守卫在 withOsFileLease 内比 fileContentVersion，不一致抛
DocumentSaveConflictError。没装守卫时直接写（独立运行）。
```

**并加一条断言**（这个矛盾的最小可验形式），放在 `run.mjs` 的 `--classify-only` 档（静态、不跑 Electron）：

```js
for (const [kind, e] of Object.entries(EXPECTATIONS)) {
  if (e.expectConflict && /没有版本比较|没有版本判据/.test(e.provenance)) {
    fail(`${kind}: expectConflict=true 但 provenance 说没有版本比较 —— 两处必须同时改`);
  }
}
```

### 11.2 ★ `save-paths.ts` **不要**翻成 `host-guarded`（本卡 §5.5 作废）

**§5.5 写的是「把 `klass` 从 `bypass` 改成 `host-guarded`」。那个方向是错的。**

**实测（O5 会话）**：分类器只读三个文件、只找**通道名字面量**。
它对「守卫是否装配」是盲的 —— `installDocumentSaveGuard()` 的调用点在
`ipc/index.ts:177`，而分类器找的是 `slides:save` 这类通道名。

**所以它现在报 `bypass`，而实际行为已经是「拦住」。**

**翻成 `host-guarded` 会让它以另一种方式说谎**：它仍然不读守卫装配，只是现在假定有人装过了。
**一个靠人手动翻的常量，比一个读源码的分类器更不可靠。**

**正确做法：保留 `klass: "bypass"`，但让它报告自己看不见的那一面。**

```ts
export interface ClassificationReport {
  ok: boolean;
  perFormat: PathClassification[];
  /** ★ 分类器**看不见**的东西。不参与 ok，但必须被打出来。 */
  blindSpots: string[];
  detail?: string;
}
```

`blindSpots` 至少两条：

1. **「守卫是否已装配」不在本分类的输入里** —— 它只读通道注册点与请求类型，
   不读 `setDocumentSaveGuard` 的调用点；
2. **「请求类型里没有版本字段」不等于「这条通道没有版本校验」** ——
   O10 之后版本由主进程侧记，不经渲染端（`SavePdfRequest` 仍然没有版本字段，**那是设计，不是缺陷**）。

**并且 `evidence` 改成描述「源码形状」而不是「运行时行为」**：

```
slides 的 ipcMain.handle('slides:save') 由 vendor 自己的 registerSlidesIpc 注册；
请求不带版本参数。**运行时是否被 Mcode 的守卫拦住，不在本分类的判据内。**
```

**理由**：`klass: "bypass"` 在 O9 卡里指「Mcode 零拦截」。O10 之后那条陈述已经过期 ——
**但改成 `host-guarded` 也是一个未经分类器验证的断言。**
**保留 `bypass` + 显式 `blindSpots`，让它诚实地报告「我只看源码形状」。**

**⚠️ 这是本卡唯一还没定的设计决定。** 如果执行者有更好的理由，先回报再改。

### 11.3 `--variant` 只能直调 `run.mjs`

```bash
# ❌ 实测失败：Unknown smoke suite: --variant=expect-green
pnpm test:smoke o2-conflict-u1-smoke --variant=expect-green

# ✅
node apps/desktop/scripts/o2-conflict-u1-smoke/run.mjs --variant=expect-green
```

`run-smokes.mjs` 的 `selectSuites` 把所有 positional 参数当套件名，且 `runOne` 的 spawn
不转发额外参数。`--classify-only` / `--only=` / `--keep` 同理。

### 11.4 基线诊断的一个关键数字（执行会话报，写卡人未复跑）

**O10 落地过程中跑出的 `accept-red` 中间态：**

```
docs     literal=PASS  expectation=all-pass
sheets   literal=PASS  expectation=all-pass
slides   literal=FAIL  expectation=unexpected-failure
pdf      literal=FAIL  expectation=unexpected-failure
markdown literal=FAIL  expectation=unexpected-failure
html     literal=FAIL  expectation=unexpected-failure
```

**逐格 4a/4b/4c**：`4b = True × 4`（盘上保住了外部内容），`4c = True × 3`，
**`4a = False × 4`，而 4a 的 detail 引用的回包正是冲突拒绝** ——

```
{"ok":false,"error":"文档已被别处改动（另一个窗口、Agent 或外部编辑器）—— …"}
```

**根因**：`lib.ts` 的冲突判据认三种签名（`reason==="conflict"` / `FILE_VERSION_CONFLICT` / `版本冲突`），
**而守卫抛的是「文档已被别处改动」，一个字都不在里面。**

**所以那 4 条红的语义是「拦住了但判据认不出」，不是「没拦住」。**

**⚠️ 这一条是执行会话在中间态跑出来的，写卡人没有复跑。** 它的价值在于
**它说明了「4 红」这个数字本身不携带修复状态** —— 而如果只看计数，会读成「一个都没修好」。

---

## 十二、★ 排查记录：为什么「3 格 all-pass」差点被误读（2026-10-24 深夜）

### 12.1 一个真绿，一个假绿的区分线

执行会话跑出：

```
docs      all-pass   (host-cas，本来就对)
sheets    all-pass   (vendor-own-guard，本来就对)
pdf       all-pass   ← 守卫生效
markdown  all-pass   ← 守卫生效
html      all-pass   ← 守卫生效
slides    unexpected-failure
```

**关键问题：pdf/markdown/html 的 `all-pass`，是「守卫在拦」，还是「守卫没装、但别的什么东西让它绿了」？**

**区分方法（必须有）：** 守卫在「没有打开会话」时**不拦、直接写**：

```ts
const opened = deps.openedRevisionFor(real);
if (opened === null) { await ctx.write(); return; }   // ← 不拦
```

**所以「不拦」也会让 4b（盘上保住外部内容）成立吗？**
**不成立 —— 不拦的话外部内容会被覆盖，4b 必然红。**
**4b 在四格全绿，所以它们真的被拦了。**

**这句话是本节的全部价值：`4b` 才是「守卫生效」的判据，`all-pass` 不是。**
`all-pass` 也可以由「守卫根本没装 + 判据认不出」组合出来（那会让 4a 红而不是绿，所以不是这次的情形，
但**判据组合会骗人这件事，必须在卡上写清哪一条才是真凭据**）。

### 12.2 写卡人自己犯的错（写在这里当反面样本）

**我（写卡人）据以下了结论：**

> `openPath` 只被 `ipc/documentView.ts` 的两条 IPC 通道调用，vendor 原生视图（slides/pdf/md/html）根本不走这条路。
> 所以 `documentViewHost.sessions` 里只有 docs 的会话，`revisionForPath` 对它们是 `null`，守卫走的是「不拦」分支。

**错了。** 三行代码推翻它：

```
documentViewHost.ts:539   kind = ... (input.editor === "slides" && url === "genoffice-app://slides/index.html") ? input.editor : null
documentViewHost.ts:686   if (kind !== null) {
documentViewHost.ts:688     const claim = this.claimOpenedPath(input.docId, input.filePath!, view.webContents);
documentViewHost.ts:1424    revision: fileContentVersion(filePath),       ← 真的记了
```

**`claimOpenedPath` 在 `open()` 的 kind 分支里被调用，kind 包含 slides/pdf/markdown/html/sheets。
供应商视图的会话在表里，`revisionForPath` 对它们有效。**

**错因**：我只 `grep` 了 `openPath` 的**调用者**，看到 `claimOpenedPath` 这个字不在
`openPath` 的实现里，就以为它们无关。**而 `claimOpenedPath` 是 `open()` 自己调的。**

**这是 CLAUDE.md 第十五条（「提到它」不是「守着它」）的反面**：
**我按名字搜了调用者，而正确的做法是读 `open()` 的实现。**
**R 名字没出现，不等于没有关系 —— 它可能被同一条函数链里的另一个函数调了。**

**代价**：我上一条指令要求执行会话「在 `documentViewHost` 里登记 slides 的打开会话」。
**那会重复登记，还可能覆盖已有 session。** 幸好它在读我的消息前没有动手。

### 12.3 slides 的 `unexpected-failure` 仍未定位（本节不做结论）

**已知**：
- `slides:save` 的 handler 第一件事是 `const session = sessions.get(e.sender.id); if (!session) return { ok:false, error:'no file open' }`；
- 那条错误不匹配 `lib.ts` 的冲突签名 → `4a=false` → `unexpected-failure`；
- **守卫在 `session` 存在之前根本不会被调到。**

**所以排查方向是 `sessions.get(sender.id)` 为什么没命中**，
不是「守卫装没装」，也不是「`revisionForPath` 有没有值」。

**⚠️ 这条结论我没有验证过 —— 它来自读代码，不是跑出来的。** 执行会话正在加日志确认。

**如果查出来生产路径也一样（不只是 harness），那用户在真实应用里点开 .pptx 保存会得到
`no file open`** —— 那是一个比 O9 更严重的可用性缺陷，需要判断是不是 O10 引入的
（`slide-lifecycle` 的既有套件应当能回答：它有没有覆盖「打开→保存」）。

---

## 十三、★ 第四个缺口：新 `@genoffice/*` 子路径 import 必须同时加 Rollup 别名（2026-10-24 深夜，UI 线发现）

### 13.1 现象

```
$ pnpm dev
@mcode/desktop:dev: ✗ Build failed in 1.13s
[vite]: Rollup failed to resolve import
  "@genoffice/electron-utils/document-save-guard"
  from "apps/desktop/src/main/document/genofficeNativeVendor.ts"
```

**根因**：`apps/desktop/electron.vite.config.ts` 的 `slidesVendorAliases()` 是一张
**手写的逐子路径别名表**，`electron-utils/document-save-guard` 不在表里。

**源文件存在**（`genoffice/packages/electron-utils/src/document-save-guard.ts`），
**TypeScript 也解析得到**（走 `node_modules` 符号链接），**esbuild 套件也跑得过**
（它们不走 Rollup 那条路）。**只有 Rollup 解析失败。**

### 13.2 为什么本卡的四条判据都抓不到它

| 判据 | 走哪条路径 | 会撞上别名吗 |
|---|---|---|
| `tsc --noEmit` | TS 模块解析（`node_modules` 符号链接） | ❌ |
| `o2-conflict-u1-smoke` | esbuild 打包 | ❌ |
| `o8-docs-theme-gate-smoke` | 直接跑 vendor 产物 | ❌ |
| **`pnpm dev` / 打包** | **Rollup + 别名表** | ✅ |

**四层里只有第四层会撞上，而本卡没有任何一条判据跑第四层。**

### 13.3 那条注释说对了一半

`electron.vite.config.ts` 的注释原文：

> 「新增时要跟着闭包 grep 一遍（**vendor 更新后漏一个，构建会在解析处当场报错，不会静默**）」

**「不会静默」是对的 —— 它确实报错。**
**但它报在 `pnpm dev` / 打包，不在本卡的套件里。**

**所以对「本卡的验收」来说，它**是**静默的**：套件全绿、typecheck 0、然后 dev 起不来。

**这和仓库里那条「打包期失败 ≠ 被测对象失败」是同一族的反面**：
**那条说「别把构建失败读成产品失败」；这条说「别把套件全绿读成能构建」。**

### 13.4 判据（本卡要补的一条）

**凡是新加 `@genoffice/*` 的 import，必须：**

1. **同时在 `electron.vite.config.ts` 的 `slidesVendorAliases()` 里加一条**（子路径别名，
   排在包根别名**之前** —— 注释里写明「顺序即判据」）；
2. **提交前跑一次 `pnpm dev`**（或任何走 Rollup 的入口），确认解析通过。

**本卡这次加的：**

```ts
{ find: "@genoffice/electron-utils/document-save-guard", replacement: pkg("electron-utils", "document-save-guard.ts") },
```

### 13.5 四个缺口的共同形态

| # | 缺口 | 谁发现 | 形态 |
|---|---|---|---|
| 1 | slides 的 `finally` 删掉唯一完整副本 | 写卡人实测 | 失败路径没人测 |
| 2 | `.d.ts` 里「`save-paths.ts` 会盯着」是假承诺 | 写卡人 grep | 注释承诺了不存在的保护 |
| 3 | `expectations.ts` 的 `html.expectConflict` 写反 | 写卡人读 provenance | 两份事实源不一致 |
| **4** | **缺 Rollup 别名 → dev 起不来** | **UI 线** | **验收路径不覆盖构建路径** |

**四个都是「卡里没写、而它会阻塞」的步骤。**
**而 4 是唯一一个**别人发现的** —— 因为它是唯一一个**在别人的工作流上**才会暴露的。

**这条要写进派活模板**：**任何新增跨仓 import 的卡，必须写明「它在哪一层被解析」
（tsc / esbuild / Rollup / 运行时），并指出验收判据覆盖了哪几层。**
