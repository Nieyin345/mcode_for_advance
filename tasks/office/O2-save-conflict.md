# O2｜六格式真 Electron 下的保存冲突：用户和 Agent 同时改同一份文件

- Status: **done**（2026-10-24，见 §八 执行回写）
- Category: **Office / E2E-4 后半 —— 数据丢失类**
- Priority: **P0 —— 旧结果覆盖新内容是数据丢失，比任何 UI 问题严重**
- Depends on: `document-view-host-smoke` §11（host 层冲突检测已实现且有覆盖）、`t7-genoffice-u1`（六格式 U1 骨架）
- 独占写入边界：
  - `apps/desktop/scripts/o2-conflict-u1-smoke/**`（新建；**实际目录名以 `ls` 为准，见我这次踩的坑**）
  - **不得改** `apps/desktop/src/main/document/documentViewHost.ts`（冲突逻辑已实现，本卡是取证）

## Required Skills

- `mcode-smoke`：真 Electron + CDP
- `systematic-debugging`：六格式的保存链路各不相同，失败形态会不一样


## 零点五、目录名（我写错过，这里留证）

**卡初稿写的是 `o2-conflict-u1/`，执行会话建的是 `o2-conflict-u1-smoke/`。**
仓库里其他套件都叫 `*-smoke`，**执行会话按惯例命名是对的，卡写错了。**

```
$ ls -d apps/desktop/scripts/o2-conflict-u1-smoke
apps/desktop/scripts/o2-conflict-u1-smoke/
```

**代价**：我去查进度时看的是卡里那个名字，目录是空的，于是误判「4 小时无产出」——
而它当时正写着 726 行的 `journeys.ts`。

**这段留着，是因为写卡的人该记住：卡上写的路径，要附一条 `ls` 输出。**

## 一、已经有的（不要重做）

`document-view-host-smoke` §11「保存冲突检测」已实现且覆盖**很扎实**：

| 断言 | 状态 |
|---|---|
| 没人动过 → 保存成功（**不误报**的负控） | ✅ |
| 成功保存回传新 revision | ✅ |
| 基于自己上一次保存的连续保存不被误判冲突 | ✅ |
| 外部改过 → `reason === "conflict"` | ✅ |
| 冲突回包带盘上当前 revision | ✅ |
| 冲突回包带人话说明 | ✅ |
| **冲突时盘上是外部内容，页面字节一个都没写进去** | ✅ |
| 冲突记进 `list()` 快照（面板可见） | ✅ |

**实现位置**：`documentViewHost.ts:1594` 的 `document view save conflict` 分支。

## 二、缺的是什么

上面全是 **host 层单元测试**（fake view、直接调 `saveOpenedFile`）。缺的是：

**六格式各自在真 Electron 里，走完自己的保存链路，冲突还拦得住吗？**

六格式的保存入口并不相同：

| 格式 | 保存怎么走 |
|---|---|
| docs | vendor `saveDocx(path, data, auto)` → host |
| slides | `slidesBridge.saveDeck` → host `slides-save` 分支 |
| sheets | vendor preload + Rust sidecar |
| pdf / markdown / html | vendor preload |

**`documentViewHost.ts:1161` 的注释说得很清楚：slides 走的是一个独立分支。**
独立分支意味着**它可能没走同一套 revision 校验**。这是本卡要验的核心。

## 三、判据

六格式各跑一次完整旅程：

```
1. 打开文件（记录打开时版本）
2. 外部进程改写这个文件（模拟 Agent 或另一个编辑器）
3. 页面发起保存
4. 断言：
   a. 保存被拒，reason === "conflict"
   b. 盘上仍是外部内容（逐字节）
   c. 页面能看到冲突提示（DOM 层，不是只有 host 返回）
5. 负控：没被外部改过时，保存必须成功（证明不是永远拒绝）
```

### 3.1 第 4c 是重点，别省

**host 返回 conflict 不等于用户看得见。** 需要验：
- 页面 DOM 里真的有冲突提示（或状态栏变成「保存失败/冲突」）；
- **不是只有 console 一条日志**。

判据：`assertDom` 找到那个提示元素，并且**在负控（正常保存）时不出现**。

### 3.2 六格式逐一，不许抽样

理由：slides 走独立分支，sheets 走 sidecar，pdf/markdown/html 各有自己的 preload。
**其中任何一条没接 revision 校验，就是一条静默覆盖数据的路。**

## 四、★ 旧红 → 新绿

- 旧：冲突检测只在 host 层验过，六格式的真实保存链路无证据。
- 新：六格式 × （冲突被拒 + 盘上不变 + 用户看得见 + 正常时不误报）。

**如果某个格式发现没走 revision 校验，记录 + 另开卡修**（本卡不改产品代码）。

**交付结论**：六格式里哪几个真的拦得住，哪几个会静默覆盖。

## 五、变异要求

1. **把某个格式的 revision 校验去掉**（或让它恒通过）→ 该格式的 4a/4b 必须红；
2. **把冲突提示的 DOM 元素删掉** → 4c 必须红，而 4a/4b 仍绿
   （**这条是关键**：证明 4c 验的是「用户看得见」，不是「host 返回了」）；
3. **把负控（没改过）也改成冲突** → 第 5 条必须红（证明不误报）。

**第 2 条设计意图**：4a/4b/4c 三条如果写成一件事，删掉 DOM 时三条一起红，就分不清
「是拦住了但没提示」还是「根本没拦住」。**必须让它们能各自独立地红。**

## 六、不要做的事

- **不要改 `documentViewHost.ts`**。冲突逻辑已经实现且单元测试扎实，本卡是验它在六条真实链路上是否都生效。
- **不要只验 docs**。docs 是最成熟的，它通过不说明另外五个。
- **不要用 `list()` 快照代替 DOM 断言**。用户看的是界面，不是内部快照。

## 七、如何运行

```bash
pnpm test:smoke <你的套件名>
cd apps/desktop && node scripts/t7-genoffice-u1/run.mjs   # 基线
```

## 八、结果回写区

（执行会话在此追加：六格式各自的红绿、哪几个会静默覆盖、变异记录、套件结果、提交 SHA）

### 2026-10-24｜O2 执行回写

**套件**：`apps/desktop/scripts/o2-conflict-u1-smoke/`（新建；真 Electron + U1 执行器）。
**运行**：`pnpm test:smoke o2-conflict-u1-smoke`（~85–120s）。退出码 0 = 与
`expectations.ts` 的结论一致（不是「六格全绿」，见下）。

#### 一、六格式 × 四条判据（实测）

| 格式 | 4a 冲突被拒 | 4b 盘上保住外部内容 | 4c 用户看得见 | #5 正常保存不误报 |
|---|---|---|---|---|
| docs | ✅ `reason:"conflict"` + `currentRevision` | ✅ 逐字节仍是外部内容 | ✅ 状态栏「保存失败：文档已被别处改动…」 | ✅ |
| sheets | ✅ 抛「工作簿在打开后被磁盘上的改动覆盖——请改用另存为」 | ✅ | ✅ 错误 toast + 状态栏 | ✅ |
| slides | ❌ **保存成功 `{ok:true}`** | ❌ **外部内容被覆盖** | ❌ 显示「已保存」 | ✅ |
| pdf | ❌ 同上 | ❌ | ❌ | ✅ |
| markdown | ❌ 同上 | ❌ | ❌ 显示「已保存」 | ✅ |
| html | ❌ 同上 | ❌ | ❌ 显示「已保存」 | ✅ |

#### 二、哪几个会静默覆盖数据

**slides / pdf / markdown / html 四个。** 生产保存链上没有「打开时版本 vs 盘上版本」的比较：

- slides：原生视图的 `slidesApi.save()` 走 vendor `slides-main.ts` 的 `slides:save` →
  `savePptxToFile` 直写；`slidesExecutor.ts` 的 CAS 只在 Mcode `SlidesBridge` 路线上生效，
  **原生视图不经它**（T13 台账已记录「生产 native 路线保存走 vendor 直写、无 Mcode CAS」）。
  这是卡 §二 点名的「独立分支」——**确认它没走同一套 revision 校验**。
- pdf：`pdf-main.ts` 的 `PDF_CHANNELS.save` 只校验路径授权，然后 `savePdfToPath` 读源→
  应用编辑→原子写；没有版本比较。
- markdown / html：`resolveSaveTarget` 直接返回本会话路径，随后 `writeTextAtomic`；没有版本比较。

**另开卡修**（本卡不改产品代码，卡 §四）。修法方向不是本卡结论的一部分，但源码位置已在上表。

#### 三、变异记录（`mutation.mjs`，三条全部 CAUGHT）

1. **`strip-revision`**（改 `documentViewHost.ts` 的 `if (current !== expected)` 为恒假，
   跑完逐字节还原、`git status` 确认干净）→ docs 4a/4b/4c 全红，docs 负控与 sheets 4a 仍绿。
2. **`hide-notice`**（页面注入 CSS 让提示元素不可见，不改 vendor 源码）→ **docs/sheets 的
   4a、4b 仍绿，只有 4c 红**。这条正是卡 §五 变异 2 要的：4c 验的是「用户看得见」，
   不是「host 返回了」。
3. **`negative-conflict`**（负控保存前改盘）→ docs/sheets 的 #5 都红。

> 4a/4b/4c 放在**同一个步骤**里各出一个 ok 标志（`4-conflict-criteria`），不是拆成三步：
> runner 遇 FAIL 立即结束旅程，拆开时 4a 一红，4b/4c 就没执行过（变异 1 第一次跑
> 得到 `docs4b=MISSING`，就是被这条咬到的）。

#### 四、套件结果与提交

- 全量连跑 3 次：`PASS`（docs/sheets all-pass；slides/pdf/markdown/html expected-failure），
  墙钟 84–119s。
- 双包 typecheck：`npx tsc --noEmit -p apps/desktop/tsconfig.json` 对
  `scripts/o2-conflict-u1-smoke/**` 零错误。
- 提交 SHA：见本卡提交 `test(O2): …`（`apps/desktop/scripts/o2-conflict-u1-smoke/` +
  本段回写）。

#### 五、未做的事 / 我觉得不对但没改的

1. **修那四个格式**不在本卡（卡 §四明确「记录 + 另开卡修」）。修好后把
   `expectations.ts` 的 `expectConflict` 翻成 `true`，`run.mjs --variant=expect-green`
   就是六格全绿的回归门禁。
2. **sheets 的编辑编排仍有残余不稳定**：保存后 vendor 重开工作簿 + Univer 重建 DOM
   与键入竞争。已修掉三个确定性根因（第二轮不能选 `A2`——夹具只有 1 行，惰性会话会夹回
   `B1`；「保存按钮 disabled」不等于工作簿已开，现在要求工作表标签 + 真实单元格引用；
   画布点击会改选区且坐标随滚动漂移）。提交版 `o2-conflict-sheets` 连跑 6 次全绿、
   全量 3 次全绿。**但历史上仍观察到约 1/6~1/8 的偶发红**（`stage:"select"` 或
   `type`）——证据里会写清卡在哪一步与当时的选择框/状态栏。见到偶发红先单跑复核，
   不要读成「冲突判据失效」；这一条建议另开卡把 sheets 的编辑编排改成页面内稳定的
   驱动方式（出货构建里 `import.meta.env.DEV` 为假，`__univerAPI` 等 e2e 钩子**不存在**，
   无法直接调 Univer API）。
3. **`electron-u1` 宿主的 150s 进程级超时会掩盖 pdf 的慢首帧**：pdf 就绪预算已压到
   40s + 45s reload（最坏 ~90s），留 ~60s 给编辑/保存。若哪天 pdf.js 更慢，会明确报
   「没渲染出页面」而不是撞全局超时——但**那个全局超时本身是硬编码**
   （`electron-host.cjs:57` 的 `150000`），多编辑器旅程迟早会撞到，值得另开卡。
4. **4c 的探针认识六个 vendor 页面各自的失败反馈位**（`.status-msg` / `.app-toast.error` /
   `.tb-save-error` / `.pdf-toast-notice` / `.status-save.status-failed`）。vendor 改文案或
   改结构时这只会**红**（不会静默假绿），需跟着改。
5. 本卡只验「保存被拒」；**没有**验「用户重新打开后是不是拿到外部那一版」（另一个决定）。
6. 并行会话提醒：执行期间 `apps/desktop/scripts/electron-u1/driver/runner.ts` 被另一个会话
   改动两次（`5ec95339` 放副屏、`a1efc42e` 22:59 把 `win.focus()` 改成 `showInactive()`）。
   **本卡的全部验证都在 `a1efc42e` 之前**（提交 `8c27ab9d` 22:21）。`showInactive` 之后未复核 ——
   sheets 的键入编排依赖页面收到键盘事件，焦点语义变了**可能**影响那一格。受影响的只是
   **稳定性**，不是**结论**（结论来自主进程回包与磁盘字节，不依赖焦点）。
   待 O5 批三让渲染端重新可构建后，重跑一次全套（约 2 分钟）即可回答。
7. **没有写「已验证」的地方**：`a1efc42e` 之后的 sheets 稳定性、以及 `hide-notice` 变异在
   新焦点语义下的行为。若这两项被当作交付前提，请在批三之后重跑 `mutation.mjs`。

### 补记（同日）：保存路径**静态归类**，回答「修复卡多大」

`save-paths.ts`（套件内，`--classify-only` 可单独跑，~4s，不启动 Electron）读源码给出三类：

| 类 | 格式 | 含义 | 修复方向 |
|---|---|---|---|
| `host-cas` | docs | 走 host `saveOpenedFile` 的乐观锁 | — |
| `vendor-own-guard` | sheets | vendor handler 自己比 `session.sha256` | — |
| `bypass` | **slides / pdf / markdown / html** | **vendor 主进程自己注册 handler、自己写盘；Mcode 侧零拦截** | 在 Mcode 侧接管这四条通道 |

**关键区分（总控问的那个）**：这四条**不是**「传了 `expectedRevision` 但没校验」——
**它们的请求类型里根本没有版本字段**：

- `SavePdfRequest`（`genoffice/apps/pdf/src/shared/ipc.ts`）：无 revision/version/sha；
- `SaveMarkdownRequest`、`SaveHtmlRequest`：同上；
- slides：preload `save: () => ipcRenderer.invoke('slides:save')` —— **连参数都没有**。

**所以修复卡是 C 类（最大）**：这四条 handler 都由 vendor 自己的 `register*Ipc` 注册
（`registerPdfIpc` / `registerMarkdownIpc` / `registerHtmlIpc` / `registerSlidesIpc`），
Mcode 的 `ipc/documentView.ts`、`genofficeNativeVendor.ts`、`ipc/index.ts` 里没有任何
拦截点。给页面加参数不够，必须**在 Mcode 侧接管这四条通道的写盘**（类比 docs 的
`saveOpenedFile`：同一份 `withOsFileLease` + `fileContentVersion`）。

**归类的机器化**：这条结论现在是套件的静态断言（`save-paths.ts`），源码漂移会自己红；
用 `mutation.mjs` 同款纪律验证过它会红（把 `wrappedByMcode` 改成恒真 → 四条全部报
「归类可能已从 bypass 改变」），验证后逐字节还原。
