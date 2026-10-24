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
