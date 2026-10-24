# O10｜四个格式的写盘接缝：把「谁的版本」和「写」放进同一份租约

- Status: **done**（2026-10-25，见 §九 执行回写；sheets 一格被环境阻塞，见 §九「未做」）
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

### 2026-10-25｜O10 执行回写

#### §4.4 的检查结论：`savePptxToFile` **连原子写都没有**

`genoffice/packages/pptx-engine/src/index.ts:729`：

```ts
await pipeline(source, createWriteStream(filePath))   // 直接写目标，无临时文件、无 rename
```

`catch` 只 `saveSnapshot.delete(opened)`，**不清理半截文件**。所以 slides 是三个问题叠加：
无版本比较（O9 已证）+ 无租约 + **无原子性**（断电/磁盘满留下截断的 .pptx）。
→ 在 `slides:save` 调用点挂接缝，且 `write` 自己补原子写（`stagedAtomicWrite`）。
**不要指望 `atomicWriteFile` 那层覆盖它 —— 它不经过那一层。**

#### §七 的三个问题

1. **`openedRevisionFor` 从哪来？** `DocumentViewHost` 的打开会话表。
   `open()` 的 **kind 分支**（`documentViewHost.ts:686-690`）对 slides/pdf/markdown/html 同样调
   `claimOpenedPath`，它把 `fileContentVersion(filePath)` 记进 `session.revision`。
   **实测**（slides 日志）：`document save committed (slides) … revision=3d8fa150…` 与
   `save conflict (slides) expected=9fe4086c… current=c202dc8a…` —— 拿得到、且是对的。
   为此给宿主加了两个只读/推进访问器（`revisionForPath` / `advanceRevisionForPath`），
   **与 docs 的 `saveOpenedFile` 同一份数据源**，不另记一份。
2. **冲突怎么让渲染端看得见？** 守卫抛 `DocumentSaveConflictError`；四个 vendor handler 的
   `catch` 都折成 `{ ok:false, error: <message> }`（pdf/markdown/html 逐字相同，slides 是
   `String(err)`）；四个渲染端都读 `error` 并显示。**不需要改任何渲染端**（实测四格 4c 全绿）。
3. **`slides:save` 冲突时返回 `{ok:false}` 会不会停在旧画面？** 不会 ——
   `file-actions.save` 的失败分支 `setStatus` + `showToast`，`adoptSavedSlides` 只在 `r.ok` 时跑。
   实测 slides 4c 绿（页面上出现了「保存失败：文档已被别处改动…」）。

#### 每个格式的翻转前后（`expectations.ts` 的 `expectConflict`）

| 格式 | 翻转前 | 翻转后 | 4a/4b/4c/#5 实测 |
|---|---|---|---|
| html | false | **true** | 全绿（日志有 committed + conflict 两条） |
| markdown | false | **true** | 全绿 |
| pdf | false | **true** | 全绿 |
| slides | false | **true** | 全绿 |

`provenance` 四格全部同步改成「修好后的出口」（守卫生效的那条路径）。

#### 变异与负控

- **`stagedAtomicWrite` 的失败路径**（`staged-write.test.ts`，纯 Node，5 条）：
  替换失败 + 原地写也失败 → 抛错且**暂存没被删**；写暂存失败 → 暂存**应当**被删（对照组）；
  错误信息点名暂存路径。**变异验证过**：把 `rm` 放回 `finally` 式 → 测试红在
  「暂存被删了 —— 用户的新内容丢了」；还原后 5/5 复绿。这条已接进 `run.sh`。
- **守卫调用点静态断言**（`save-paths.ts`）：四个 `format: '<kind>'` 锚点各出现 1 次 +
  文件里有 `guardedDocumentSave(`。**变异验证过**：把 pdf 的 `format: 'pdf'` 改名 →
  归类红（「锚点出现 0 次」），还原后复绿。
- **`expectations.ts` 自洽断言**：`expectConflict=true` 而 `provenance` 还说「没有版本比较」→ 红。
  **变异验证过**（改回旧 provenance → 红）。

#### 我犯的一个错（已修，记下来给下一个改 paths 的人）

第一版 slides 的 `write` 把 `rm(staging)` 写在 **`finally`** 里。正常路径看不出问题；
**`rename` 因 Windows EBUSY/EPERM 失败时，`finally` 会删掉唯一一份完整的新内容** ——
用户看到「保存失败」而编辑全没了，**比改动前更坏**（那时至少盘上还有被截断的文件可捞）。
**失败路径没有任何正常路径的断言能覆盖它**（O2 只跑「能成」的世界、默认透传只验「没装守卫」、
真并发只验「两个保存同时跑」）。修法：照抄 `atomic-write.ts` 的三段结构，并抽成
`stagedAtomicWrite` 让它能被假 `replace`/`remove` 单独喂。

#### 提交

- vendor：`genoffice` 分支 `mcode/integration`，`a290398`；
  patch `patches/genoffice/0022-feat-save-a-host-installed-guard-at-the-four-save-c.patch`
  （sha256 `14da8b1cd2d26bb17ebd02ca14c68f76f8502d096018b36a0f10a14b49f2605d`）；
  账本 `genoffice-upstream.lock.json` 与 `verify-genoffice-upstream.cjs` 已同步
  （22 patches，`FINAL_REVISION`/`FINAL_TREE` 已改；`MCODE_INCLUDE_GENOFFICE_CLI=1
  MCODE_INCLUDE_GENOFFICE_BUNDLE=1 node apps/desktop/build/verify-genoffice-upstream.cjs` 通过）。
- Mcode：见本卡所属提交。

#### 未做 / 未验证（如实）

1. **sheets 那一格在本次环境跑不过**：`negative-edit` 卡在 `.workbook-opening-screen`
   90–120s 不消失。**已做对照**：不装守卫（`O2_NO_GUARD=1`）时**同样卡** → 与 O10 无关。
   根因指向**显示器配置变化**（现在只有一块 1463×823；早先跑绿时是 1463 + 副屏 1920×1080）：
   `pickHostWindowPlacement` 在无副屏时把窗口放到主屏**右下之外**，`capturePage` 报
   "Current display surface not available"。**T7 自己的 docs/sheets 旅程现在同样红**
   （`step-07-screenshot` / `step-06-screenshot`），是同一原因。**这是环境问题，不是代码**；
   副屏接回来或改 `runner.ts` 的摆放后需重跑。
2. **`slides:save-as` 没挂守卫/原子写**：它写到对话框新选的目标（不是被并发编辑的打开文件），
   且会改 `session.path`。**不在本卡范围**，如实记在这里。
3. **`--variant=expect-green` 在本次环境跑不到全绿**（sheets 环境阻塞），但**其余五格全绿**。
   环境恢复后重跑即可。
4. O2 的 `save-paths.ts` 仍是 `bypass` 分类（总控决定：保留 + 报告 blind spots），
   本卡只加了「调用点接线还在」的静态断言。

---

## 十四、交付回写（2026-10-25）

**`0919d5b0`（Mcode）+ vendor `a290398` + patch `0022`。**

### 14.1 四格实测

| 格式 | 4a 拒 | 4b 盘上保住 | 4c 用户看得见 | #5 不误报 |
|---|---|---|---|---|
| html / markdown / pdf / slides | ✅ | ✅ | ✅ | ✅ |

**slides 的硬证据**：`document save committed (slides) revision=3d8fa150…`
与 `save conflict (slides) expected=9fe4086c… current=c202dc8a…` —— 打开时版本拿到了、且不同。

### 14.2 ★ 写卡人对 slides 的判断是错的（本节留作反面样本）

**我（写卡人）曾断言**：

> slides 的会话在 vendor 自己的 `sessions` map 里，不在 `documentViewHost` 里 →
> `revisionForPath` 返回 `null` → 守卫判断「没有会话」→ 不拦。

**执行会话的日志推翻了它**：`expected` 和 `current` 是两个不同的值 —— 说明版本拿到了。

**真实原因**：`slides-main.ts` 的 `catch` 用 `String(err)`，而
`DocumentSaveConflictError` 的 `name` 被设成类名 → 错误文本是
`"DocumentSaveConflictError: 文档已被别处改动…"`。**判据不认那个前缀。**

**这是我今晚第二次「按名字搜、看到某个缺失就下因果」**（第一次是 `claimOpenedPath`）。
**两次都是「我在某个时间点读了一段代码，把它报成了机制」。**

### 14.3 我自己跑过的验证（不只是读报告）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0，0 条错误 |
| `--classify-only` | 通过；失败路径断言 `pass=5 fail=0` |
| **变异：把 staging 的「两次都失败时保留」改成「删掉」** | **`pass=4 fail=1`，EXIT=1** |
| 还原 | `sha256 99f9fb24…` 逐字节一致，5/0 复绿 |
| `verify-genoffice-upstream.cjs` | exit 0，22 patches，tree `8894ca67` |
| **变异：给 `0022` 补丁追加一个字节** | **EXIT=1，`byte count mismatch`** |
| 还原后 verify | exit 0，与之前一致 |

**最后一条最有价值**：`verify` 的 sha256/字节数判据是**真的会红的**，
不只是打印了一句话。**「22 条补丁都核过」这句话现在有变异背书的证据。**

### 14.4 未做（执行会话如实报告，写卡人认可）

1. **`slides:save-as` 没挂守卫/原子写** —— 它写对话框新目标、会改 `session.path`，语义不同。
   **⚠️ 这是同一个静默覆盖漏洞的第二个入口：用户「另存为」到已有文件时完全不经过守卫。另开卡。**
2. `--variant=expect-green` 本次跑不到六格（**sheets 环境阻塞，不是代码**）。
3. `save-paths.ts` 的 `blindSpots` 字段未做 —— **写卡人决定现在不做**：
   它不阻塞任何东西（分类器说 `bypass` 是过期但不出错的结论），
   而**它该由「下一次有人要读这个分类器」的时候做**。

### 14.5 ★ sheets 那一格是环境，而根因是我们自己的约束

**执行会话的对照实验**：`O2_NO_GUARD=1`（不装守卫）**同样卡** —— 证明不是守卫引起的。
**T7 自己的 docs / sheets 旅程也红在同一类位置。**

**根因**：显示器从「1463 + 副屏 1920」变成只有一块 1463×823 →
`pickHostWindowPlacement` 无副屏时把窗口放到**主屏工作区右下之外** →
`capturePage` 报 `Current display surface not available`。

**⚠️ 写卡人第一版把坐标写成了 `-20000, -20000` —— 那是错的。** 实测日志是：

```
offscreen right-below primary work area 1463x775 (x=1543, y=855)
```

**`-20000` 是另一处**：`o6-reshell-*/probe.cjs` 与 `o8-docs-theme-gate-smoke/probe.cjs`
里的「没副屏就挪远」分支。**两个机制，我把它们混成了一个。**

**为什么这个错值得记**：`-20000` 和 `1543,855` 的行为后果相同（都无 surface），
**所以结论对，坐标错** —— 而**按 `-20000` 去读代码的人会找错地方**
（`runner.ts:661` 是 `wa.x + wa.width + 80`，`probe.cjs:191` 才是 `-20000`）。

**而那条「无副屏就放到屏幕外」是 Office 线为了「测试窗口不弹到用户主屏」加的约束。**
**它的代价今晚第一次显形**：**没有副屏时，需要截图的套件会失败。**

**记进仓库**：需要 `capturePage` 的套件应当
（a）先检查副屏是否存在并如实 skip，或（b）用 offscreen 渲染而不是 `capturePage`。
**不要用「把窗口挪回主屏」解决** —— 那违反用户明确的要求。

#### 补记（总控核账后）：`slides:save` 的用户可见文案带类名前缀

`slides-main.ts` 的保存 catch 是 vendor 原有写法 `return { ok: false, error: String(err) }`
（`HEAD^` 里就在，不是本次引入），而页面的 `appStatusSaveFailed: '保存失败：{error}'`
把它原样拼进状态栏与错误 toast。

所以用户实际看到的是：

```
保存失败：DocumentSaveConflictError: 文档已被别处改动（另一个窗口、Agent 或外部编辑器）…请重新打开后再改。
```

**我的守卫是第一个会从这条 catch 抛出的对象**，于是「`name` 会进用户文案」这件事
在本次之前没有机会显形。三个属性里 `String(err)` 取 `name: message`，
而我在 `documentSaveGuard.ts` 里把 `this.name` 设成了类名。

- **不影响 4c**（提示确实可见，判据绿）；
- **但用户文案多一个内部类名**，与 pdf/markdown/html 三家（`err.message`）不一致。

**不改的原因**：改 `String(err)` → `err.message` 会动 vendor 的 catch，
而它同时兜住 vendor 自己的全部保存错误（不止守卫抛的）；本卡的范围是接缝，不是文案。
**记在这里，另开卡处理**（与 `slides:save-as` 同一张卡即可，两者都在 `slides-main.ts` 的保存路径上）。

#### 收尾（2026-10-25 01:15）：sheets 那一格仍无法复核

**显示器检查（`[System.Windows.Forms.Screen]::AllScreens`）：**

```
\.\DISPLAY1 {X=0,Y=0,Width=1463,Height=823}      ← 只有一块，副屏没回来
```

**所以 `o2-conflict-sheets` 的 `negative-edit` 仍会在 `.workbook-opening-screen` 卡住**，
**本次不重跑**（重跑只会得到同一个环境结论，且会占用共享工作树）。

**已确认这是环境的依据**（三条，本节前文已记）：
1. `O2_NO_GUARD=1`（不装守卫）**同样卡** —— 不是 O10 引入；
2. 根因是显示器配置变化 → 窗口落在主屏外 → `capturePage` 无 display surface；
3. T7 自己的 `docs-open-edit-save-reopen` / `sheets-open-edit-save-reopen` **同位置红**
   （`step-07-screenshot` / `step-06-screenshot`），而我未改 T7。

**副屏接回后要跑的行（一次即可覆盖两件事）：**

```bash
cd apps/desktop
bash scripts/o2-conflict-u1-smoke/run.sh            # 期望：六格全绿 + 失败路径 5/5
node scripts/t7-genoffice-u1/run.mjs --only=docs-open-edit-save-reopen
```

**如果 sheets 仍红而 T7 已绿**，那就不是环境 —— 届时应查 `negative-edit` 的 `observed`
（`stage` 是 `select` 还是 `type`、`status` 是不是「正在打开工作簿…」），而不是先怀疑守卫。

---

## 十五、sheets 那一格的独立复核（2026-10-25，用户决定不接副屏，直接跑）

### 15.1 结果

```
o2-conflict-docs:     literal=PASS  expectation=all-pass
o2-conflict-slides:   literal=PASS  expectation=all-pass
o2-conflict-pdf:      literal=PASS  expectation=all-pass
o2-conflict-markdown: literal=PASS  expectation=all-pass
o2-conflict-html:     literal=PASS  expectation=all-pass
o2-conflict-sheets:   literal=FAIL  expectation=unexpected-failure (failed at negative-edit)
```

**5/6 全绿。四个被修的格式（slides/pdf/markdown/html）全部通过。只有 sheets 红。**

**而 sheets 不是被修的四个之一** —— 它是 `vendor-own-guard` 类，本来就有 `session.sha256` 版本判据。

### 15.2 sheets 的失败形态，与「环境阻塞」那个说法**不一致**

执行会话先前记为「显示器配置变化 → 窗口在屏外 → `capturePage` 无 surface」。
**而实测的 `negative-edit` 失败是另一回事：**

```json
{
  "step": "negative-edit",
  "status": "FAIL",
  "detail": "90s 内工作簿没有落到就绪态（工作簿已开且无待保存改动）",
  "observed": { "saveDisabled": true, "status": "正在打开工作簿…", "box": "A1" },
  "domSnapshot": { "nodes": 614, "url": ".../index.html?mode=tab&openingWorkbook=1" }
}
```

**`nodes: 614` + `observed.box === "A1"` —— 页面**完全渲染出来了**（ribbon、AI 面板、Sheet1 标签都在）。**
**卡住的是「正在打开工作簿…」这个数据态，不是截图。**

**⚠️ 所以「环境阻塞」这个定性，对 `capturePage` 的同伴证据（T7 的 `step-06-screenshot`）成立，对 O2 的 `negative-edit` 不成立。**

### 15.3 哪些是环境、哪些不是（分开记账）

| 现象 | 是不是环境 | 证据 |
|---|---|---|
| **T7 `step-06-screenshot` 失败** | ✅ **是** | `detail: "capturePage 返回空图"` —— 窗口在屏外，无 display surface |
| **O2 `negative-edit` 失败** | ❌ **不是截图问题** | `nodes: 614` 页面已渲染；`detail` 是「工作簿没有落到就绪态」 |

**两条都被记为「显示器」造成的，而只有第一条是。**

### 15.4 已经排除的（各自独立验证过）

| 假设 | 怎么排除的 |
|---|---|
| sidecar 二进制缺失/损坏 | `xlsx-sidecar.exe --help` → **EXIT=0**，8.9 MB |
| sidecar 不能打开 fixture | **我直接起 sidecar，发一条 `open` 请求** → **12ms 返回 `ok:true`**，`sheets` 数组有内容 |
| fixture 缺失 | `genoffice/apps/shell/build/shell-new/blank.xlsx` 存在（4009 B），且 sidecar 能开它 |
| 守卫引起的 | 执行会话的对照：`O2_NO_GUARD=1` 同样卡 |
| O10 改动引起的 | 五格同一次运行全绿；sheets 不在 O10 的四个格式里 |

**所以剩下的可能性在 `workbook:select` → `prepareWorkbookForOpen` → `openWorkbookSession` 这条链上，
且只在这个 harness 里成立。**

### 15.5 一个具体的可疑点（未验证，留作下一张卡的起点）

`prepareWorkbookForOpen` 里有这段：

```ts
const recovery = options?.skipRecoveryPrompt ? undefined : pendingRecoveryFor(path)
if (recovery) {
  const choice = await promptRecoveryRestore(contents, path, recovery)   // ← 弹窗，等用户点
```

**如果 `userData/sheets-autosave/` 里有该路径的崩溃恢复副本，会弹一个模态框并**无限等待**。**
**而测试窗口在屏外，没人能点。**

**⚠️ 这只是「可疑」，我没有验证过。** 验证方法：在那次 run 的 userData 里找
`sheets-autosave/*.xlsx`（目录已被 prune 清掉，需要在一次不清理的运行里抓）。

**下一张卡的第一个动作就应该是这个检查**，而不是继续猜。

### 15.6 给「环境 vs 代码」的判据（通用）

**这次暴露的形态**：**同一个 root cause（显示器没了）产生了两种失败，而它们长得很像。**

| 失败 | 依赖 display surface 吗 |
|---|---|
| `capturePage` | ✅ 是 |
| 页面数据没到位 | ❌ 否 |

**所以判据是**：**「无副屏」只能解释依赖 display surface 的那一类**。
**任何「DOM 已经渲染、但某个状态没到」的失败，都不该被归到显示器上。**

**⚠️ 而执行会话当时给的三条依据里，第二条是这个推理的产物**：
> 根因是显示器配置变化 → 窗口落在主屏外 → `capturePage` 无 display surface

**它对 T7 成立，对 O2 不成立 —— 而当时它把两条并成了一条。**

**这不是它的疏忽导致的**：两条现象**确实同时出现**，而且都是「以前绿、现在红」。
**区分它们需要看 `detail` 说的是什么，而不是看「什么时候开始红的」。**
