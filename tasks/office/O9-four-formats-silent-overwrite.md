# O9｜四个格式静默覆盖数据：slides / pdf / markdown / html 没有版本比较

- Status: **诊断已完成（§八），修复卡 = `O10-four-formats-save-seam.md`**
- Category: **Office / 数据丢失 —— 今晚发现的最严重问题**
- Priority: **P0**
- 发现于: O2（`8c27ab9d`，22:21，**在 O5 批一之前，结论有效**）
- 独占写入边界：见 §六（**先做诊断，再决定边界**）

## 一、缺陷（O2 实测，六格式 × 四条判据）

| 格式 | 4a 冲突被拒 | 4b 盘上保住外部内容 | 4c 用户看得见 | #5 不误报 |
|---|---|---|---|---|
| docs | ✅ | ✅ | ✅ | ✅ |
| sheets | ✅ | ✅ | ✅ | ✅ |
| **slides** | ❌ | ❌ | ❌ | ✅ |
| **pdf** | ❌ | ❌ | ❌ | ✅ |
| **markdown** | ❌ | ❌ | ❌ | ✅ |
| **html** | ❌ | ❌ | ❌ | ✅ |

**端到端表现**：用户和 Agent 同时改一份文件 → 谁后存谁覆盖 → **保存回 `{ok:true}`，
界面显示「已保存」，而对方的内容已经被覆盖。**

**这是静默数据丢失。** 比任何 UI 问题严重。

## 二、根因（O2 的结论 + 我核过的线索）

`documentViewHost.ts` 有 CAS 校验（`:1594` 的 `save conflict` 分支），**docs/sheets 走它**。

**另四个没走**：

- **slides**：`documentViewHost.ts:1161` 的注释明说它走**独立分支**（`slides-save` →
  `slidesBridge.saveDeck`）—— **绕过了 CAS**。O2 已证实。
- **pdf / markdown / html**：各走自己的 vendor preload 保存路径。

## 三、★ 先诊断，再修 —— 分三类，修法代价差一个数量级

**在动任何代码之前，对**四个格式各**回答一个问题**：

> **它的保存路径里，有没有「打开时版本」这个概念？**

```bash
# 对每个格式，找它的保存入口，看有没有 revision / expected / sha 这类参数
grep -rn "expectedRevision\|expectedSha\|baseRevision\|revision" \
  apps/desktop/src/main/document/ | grep -iE "slides|pdf|markdown|html|saveDeck|saveOpened"
```

| 诊断结果 | 修法 | 代价 |
|---|---|---|
| **A. 压根没传版本** | 在桥上加参数，host 侧已有逻辑 | **小**（改桥） |
| **B. 传了但没校验** | host 的 CAS 分支覆盖它 | **中** |
| **C. vendor 直接写盘，绕过 host** | 要改 vendor | **大**（动 `genoffice/`） |

**三种情况修法完全不同。不要假设是哪一种。**

**⚠️ 特别查 slides**：O2 说它绕过了 `SlidesBridge` 的 CAS ——
**那 `SlidesBridge` 自己有 CAS 吗？** 如果有，是 `saveDeck` 没用它；如果没有，要从头加。

## 四、判据（修完后）

**O2 的套件已经写好了判据，只需把 `expectations.ts` 的 `expectConflict` 翻成 `true`**：

```
pnpm test:smoke o2-conflict-u1-smoke --variant=expect-green
```

**六格全绿。**

**⚠️ 但这不是「修完就能翻」** —— 必须逐个格式修完、逐个翻，**不要一次全翻**。
**一次全翻的话，红的那几个会和本来就红的混在一起，分不清你修好了几个。**

## 五、变异

**对每个修好的格式，做两次变异**：

1. **去掉版本比较** → 该格式的 4a/4b/4c 必须红（证明判据还在验）；
2. **只删提示 DOM**（保留版本比较）→ **只有 4c 红，4a/4b 仍绿**。

**第 2 条是 O2 已经证明过的那条** —— 它证明三条判据互相独立。
**你修完要重新证明一次，因为修法可能把三条揉成一条。**

## 六、边界：诊断阶段只读

**第一阶段（诊断）**：
- **只读**，不改任何代码；
- 产出**四格式 × A/B/C 分类表** + 每类的修复方案与代价。

**第二阶段（修复）**—— **等我看过诊断表再定边界**。因为：
- 如果是 A/B，改 `apps/desktop/src/main/**`；
- 如果是 C，要改 `genoffice/**`（vendor，另一个 git）。

**两种情况的卡不一样大，边界也不同。**

## 七、不要做的事

- **不要为了让判据绿而放宽它。** 四个格式现在就是坏的，**绿了只说明你改了判据**。
- **不要一次翻四个 `expectConflict`**（§四）。
- **不要假设「其他格式怎么做，这个格式也怎么做」** —— O2 已经证明 slides 走的路和 docs 不同。

## 八、结果回写：诊断完成（O2 交付 `0564f0ef`，2026-10-24）

### 8.1 分类：四个全是 **C（bypass）**，而且比 C 更彻底

| 格式 | 类 | 证据 |
|---|---|---|
| docs | `host-cas` | `mcode:document-view:save` → `host.saveOpenedFile`，`withOsFileLease` 内比 `fileContentVersion` |
| sheets | `vendor-own-guard` | vendor handler 自己 `sha256File(session.path)` 与 `session.sha256` 比，不一致抛 `errDiskChanged` |
| **slides** | **bypass** | `slides-main.ts:4583` 的 `ipcMain.handle('slides:save', async (e) => ...)` → 直接 `savePptxToFile(session.opened, session.path)`，**连参数都没有** |
| **pdf** | **bypass** | `pdf-main.ts:1199` → `savePdfToPath` → `writePdfAtomically` |
| **markdown** | **bypass** | `markdown-main.ts:820` → `writeTextAtomic` → `atomicWriteFile` |
| **html** | **bypass** | `html-main.ts:1377` → `writeTextAtomic` → `atomicWriteFile` |

**关键发现（比"没校验"更彻底）**：`SavePdfRequest` / `SaveMarkdownRequest` / `SaveHtmlRequest`
里**根本没有版本字段**，`slides:save` 的 handler **不接受任何参数**。

**所以不是"传了没校验"，是这条路从未有过版本概念。**

### 8.2 ★ 归类被做成了断言，不是一句话

`apps/desktop/scripts/o2-conflict-u1-smoke/save-paths.ts` —— 静态断言，`run.mjs` 在起 Electron 之前跑它，
不成立就红。三个判据：
1. `host.saveOpenedFile` 在 Mcode IPC 层的调用点**恰好 1 个**；
2. 四条 handler 由 **vendor 自己的** `register*Ipc()` 注册（且 Mcode 侧没有引用它们）；
3. 三条请求类型里**没有**版本字段（有就红："归类可能已从 bypass 改变"）。

**变异验证过它会红**（把 `wrappedByMcode` 改成恒真 → 四条全部报"归类可能已从 bypass 改变"）。

**这是本卡留下的最有价值的东西**：将来有人改了 vendor 或 Mcode 接管了，
它会红，而不是让卡上的一句话变成过期信息。

### 8.3 ★★ vendor 自己在注释里写了「这半是 Host 的责任」

`genoffice/apps/pdf/src/main/atomic-write.ts` 的原文：

> **This primitive protects temporary-file ownership.**
> **The caller/Host must still enforce the source version and file lease for concurrent editors.**

**所以修法不是"给 vendor 打补丁"，是"补上 vendor 明说该由 Host 做的那一半"。**

### 8.4 修法方向（已进 O10）

**不通过给请求加版本字段** —— 渲染端拿不到版本（它只知道"打开时看到的内容"），
而"盘上内容和这个视图打开时是否一致"**只有主进程有**。docs 的 `saveOpenedFile`
已经证明主进程侧快照就够了（`expectedRevision === undefined` 时用会话表里的版本）。

**所以：在 vendor 的写盘调用点加一个默认透传的接缝，Mcode 装守卫进去。**
细节、契约形状、§4.4 的 slides 检查、三个必答问题都在 `O10-four-formats-save-seam.md`。

### 8.5 遗留：分类器里有一处会随本卡变红（设计好的）

`save-paths.ts` 的判据 2 断言"Mcode 侧没有对这四条通道的引用"——
**O10 落地时它会红，那是它该做的**（"归类可能已变，请重核"）。O10 §5.5 写了改法。
