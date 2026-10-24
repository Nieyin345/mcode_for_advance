# O4｜docs 关闭恒被拒：包装层只实现了 handle，`on` 静默不注册

- Status: **done**（见文末回写区）
- Category: **Office / 真实缺陷修复**
- Priority: **P0 —— 用户每次关 docs 都等 2 秒然后被拒，且提示词会误导人**
- 发现于: O3（`f383922b`）的卡外 findings
- 独占写入边界：
  - `apps/desktop/src/main/ipc/dbGuardedIpc.ts`（**首选修法**）
  - `apps/desktop/src/main/ipc/documentView.ts`（**仅当需要改静默降级**）
  - `apps/desktop/scripts/o4-docs-close-smoke/**`（新建）
  - **不得改** `apps/desktop/src/renderer/**`（UI 总控的目录）

## Required Skills

- `mcode-smoke`：这套要能同时覆盖「裸 ipcMain」和「包装过的 ipc」两条路径
- `systematic-debugging`：根因链已给出，但要自己复现确认

## 一、缺陷（O3 已用页面侧计数器实证）

**现象**：关 docs 文档，等 2 秒超时，被拒，提示「编辑器未响应关闭检查；为保护未保存内容，拒绝关闭」。
**五家原厂（sheets/slides/pdf/markdown/html）关闭都正常，只有 docs。**

**根因链**（我逐条核实过，属实）：

| # | 事实 | 位置 |
|---|---|---|
| 1 | 宿主推 `mcode:document-view:close-check`，等页面回 | — |
| 2 | docs 页面**确实回了**（O3 实测 `checkEvents: 1`） | — |
| 3 | 生产传的是 `createDbGuardedIpc(ipcMain)` | `ipc/index.ts:209` |
| 4 | 它返回 `Pick<IpcMain, "handle">`，**只有 `handle`，没有 `on`** | `dbGuardedIpc.ts:29, 92` |
| 5 | `if (typeof ipc.on === 'function') ipc.on(...)` 于是**静默不注册** | `documentView.ts:213` |
| 6 | 回答落在无人监听的通道 → 2s 超时 → fail-closed | — |

**两处都要修，而且是两个不同的问题**：

- **A. `createDbGuardedIpc` 丢了 `on`** —— 这是接口欺骗：它声称返回 `IpcMain`（`as unknown as IpcMain`），实际只实现了 `handle`。任何走 `ipc.on` 的调用方都会被静默降级。
- **B. `documentView.ts` 的静默降级** —— `if (typeof ipc.on === 'function')` 在没有 `on` 时**什么都不做、也不报错**。这是「坏东西显式报出来」的反面。

**只修 A 能让 bug 消失，但 B 仍然是一颗雷**：下次有人传一个同样残缺的包装，会再次静默失败，而且症状离原因很远（2 秒超时）。

## 二、判据

### 2.1 主判据（必须真 Electron + 真 docs 页面）

```
打开 docs → 关闭 → 必须在 2s 内成功，不得超时
```

**不许用 fake ipc 代替。** O3 报告说得很清楚：`t7`（源码树）没抓到这个缺陷，
**因为它用裸 `ipcMain` 做 recordingIpc**。所以本卡的套件**必须走生产装配路径**。

### 2.2 A 的判据（包装层）

直接打 `createDbGuardedIpc`：

| # | 断言 |
|---|---|
| 1 | 返回的对象**有** `on` 方法（`typeof wrapped.on === "function"`） |
| 2 | 通过 `wrapped.on` 注册的监听器，在对应通道 emit 时**真的被调用** |
| 3 | `on` 注册的回调**也走 `awaitDb()`**（与 `handle` 一致，否则数据库未就绪时回调会崩） |
| 4 | 返回值**仍然**满足 `IpcMain` 的形状检查（不能修好 `on` 却破坏别的） |

**第 3 条容易漏**：`handle` 里第一行是 `await awaitDb()`。`on` 若直接透传，数据库未就绪时的
`close-check-result` 会以另一种形态失败——**那是把一个 bug 换成另一个**。

### 2.3 B 的判据（不许静默降级）

| # | 断言 |
|---|---|
| 5 | 传入一个**没有 `on`** 的 ipc 桩时，`registerDocumentViewHandlers` **必须抛错或 `log.warn`**，而不是静默跳过 |
| 6 | 该警告/错误消息**点名缺的是 `on`**，不是泛泛的「注册失败」 |

**第 6 条的理由**：这个缺陷的代价就是「症状（2s 超时）离原因（缺 `on`）很远」。
消息必须把距离缩短。

## 三、★ 旧红 → 新绿

| 阶段 | 期望 |
|---|---|
| 修前 | 关闭超时被拒（**必须先在测试里红一次**，否则你不知道自己修的是什么） |
| 修后 | 关闭成功 |

**先在现有代码上跑一次，确认红。** 如果没红，说明你的套件没走生产装配路径 —— 那是套件错了，不是代码好了。

## 四、变异要求

1. **把 `wrapped.on` 删掉** → 2.1 的主判据必须红；
2. **把 `on` 的回调去掉 `awaitDb()`** → 2.2 第 3 条必须红，**而主判据仍绿**
   （关键：证明这两条判据互相独立，不是同一条断言的两个说法）；
3. **把 B 的警告改成静默** → 2.3 第 5 条必须红。

## 五、不要做的事

- **不要为了让它过而把 `documentView.ts:213` 的判断删掉**。那个判断本身是对的（防御残缺 ipc），
  错的是**沉默**。要么补 `on`，要么让它在缺失时喊出来。
- **不要改渲染端**。这是主进程缺陷。
- **不要只修 A 不修 B**。A 让今天的 bug 消失，B 防止下一个同形状的 bug 再静默。

## 六、如何运行

```bash
pnpm test:smoke <你的套件名>
# 生产装配路径的真 Electron 参考：apps/desktop/scripts/o3-packaged-u1/（O3 建的）
```

## 七、结果回写区

（执行会话在此追加：修复前后的复现、A/B 两处的判据红绿、变异记录、套件结果、提交 SHA）

---

### 回写（2026-10-24，执行会话）

**提交 SHA：** `fa6eb9170d232fb8c25be8c6f767d1fbf232ebe8`（fix(O4) 提交；本行自身
是一个后续 docs 提交）

#### 1. 修复前的红（两段都先红过，确认套件指在缺陷上）

**无头段（原代码，`git show HEAD:` 换回的 `dbGuardedIpc.ts`）：7/19，12 条红**，
全部指向缺陷本体：A1（`wrapped.on` undefined）、A1b（`removeHandler`/`removeListener`
也 undefined）、A2/A2b/A2c、A3a/A3b（因缺 on 显式 FAIL，不空过）、A5、A6、
B6/B6b/B8（缺 on 时静默）。正控 A4a–d（handle 不受影响）、B6c（喊出来不罢工）、
B7/B7b（有 on 时**不**误报）全绿 —— 判据不是恒报。

**真 Electron 段（原代码，生产装配 `createDbGuardedIpc(ipcMain)` + 真 docs 页 + 真 preload）：**

```
PASS  open-path-committed
PASS  editor-mounted / shows-unique-text / docs-dom-has-unique-text
FAIL  close-succeeds-within-2s
      "关闭被拒：编辑器未响应关闭检查；为保护未保存内容，拒绝关闭
       （耗时 2003ms；页面回报 1 次，包装层 on=false）"
```

正是 O3 记录的缺陷原文，且 `closeCheckResultEvents: 1` 从主进程侧证实页面确实回了 ——
红的不是"页面没回"，是"主进程没听"。

#### 2. A 的改法（`apps/desktop/src/main/ipc/dbGuardedIpc.ts`）

`createDbGuardedIpc` 不再用 `Pick<IpcMain,"handle">` + `as unknown as IpcMain` 撒谎；
实现完整注册面：`handle` / `handleOnce` / `on` / `addListener` / `once` /
`prependListener` / `prependOnceListener` / `off` / `removeListener` /
`removeAllListeners` / `removeHandler`，以及 EventEmitter 只读面（`emit` /
`listenerCount` / `listeners` / `rawListeners` / `eventNames` / `getMaxListeners` /
`setMaxListeners`）原样转发。

**`on` 与 `handle` 同一道 `awaitDb()` 闸**：监听器在 DB 未就绪时排队、就绪后执行、
init 失败记 `log.error` 不执行（fail-closed，与 handle 同取向）。`once` 触发后同步
摘掉事件账，避免 `removeListener` 映射随 once 累积。`removeListener(原函数)`
能摘掉包装层换进去的那个函数（否则调用方手里的原函数永远摘不掉）。

#### 3. B 的改法（`apps/desktop/src/main/ipc/documentView.ts`）

`if (typeof ipc.on === 'function')` 不再静默跳过：保留 `handle`（invoke 式调用方
仍可用），缺 `on` 时 `log.error` **点名 `on()` 与受影响通道
`mcode:document-view:close-check-result`，并写出后果**（「关闭 docs 文档会等 2 秒
超时后被拒……即使编辑器页面已经回了关闭检查」）。判据不断言"要抛"——喊出来即可，
且不许罢工（B6c）。

#### 4. 修复后的绿

- 无头：**19/19**；真 Electron：`literal=PASS`（1/1 旅程，1 个 OS 进程）。
- 整跑：`o4-docs-close-smoke: PASS`（两段都 exit 0）。

#### 5. 变异记录（`node scripts/o4-docs-close-smoke/run.mjs --mutate`：3/3 通过）

| # | 变异 | 结果 |
|---|---|---|
| M1 | 删掉 `wrapped.on` | 主判据红在 `close-succeeds-within-2s`（exit 2，UNEXPECTED FAILURE，原文「编辑器未响应关闭检查」）；同时 B 的警告在日志里喊出「缺少 on()」 |
| M2 | `on` 回调改 `Promise.resolve()`（去 `awaitDb`） | **A3 红、主判据仍绿（exit 0）** —— 两条断言互相独立；A1/A2/A4… 仍绿 |
| M3 | B 的警告分支改 `else if (false)`（静默） | B6/B6b/B8 红，其余不受影响 |

每个变异：锚点唯一性校验 → 落盘核对 → 跑段 → `finally` 写回 → `cmp` 逐字节还原；
期间若有第三方写者则拒绝覆盖。变异前后 `handleOnce`/`sweepAfterFire` 计数不变，
`else if (false)` 零残留。

#### 6. 双包 tsc

`apps/desktop`：**0 错误**（唯一报错来自另一个会话**未跟踪**的
`scripts/o2-conflict-u1-smoke/journeys.ts:265`，与本卡无关；过滤该路径后 0 行输出）。
`packages/contracts`：**0 错误**。

#### 7. 必跑套件（`smokes-for.sh` 两个目标文件，去重 12 套）

| 套件 | 结果 |
|---|---|
| o4-docs-close-smoke（新） | PASS（无头 19/19 + 真 Electron 1/1） |
| memory-codex-smoke | 234/234 |
| t40-renderer-registry-smoke | 12/12 |
| app-control-smoke | 582/582 |
| scene-deploy-electron-smoke | 14/14 |
| watch-templates-cas-electron-smoke | 21/21 |
| document-view-host-smoke | 538/538 |
| ipc-wiring-smoke | 45/45 |
| ipc-parity-smoke | 13/13 |
| document-view-open-smoke | 39/39 |
| document-view-electron-smoke | 17/17 |
| genoffice-ai-ask-smoke | 20/20 |
| workflow-engine-electron-smoke | **1 红** —— 见下 |
| o0-format-fidelity-smoke | **红** —— 见下 |
| o2-conflict-u1-smoke | **红** —— 见下 |

#### 8. 三处红：都不是本卡改动引起的（有对照证据）

- **workflow-engine-electron-smoke**：红在「面板源码：url 变 null 才 close」——
  是 `src/renderer/components/settings/workflows/EngineRuntimePanel.tsx`（**本卡禁改
  目录**）的源码文本断言。只读诊断：同一条断言对 `HEAD:` 版为 true、对工作区版
  （另一会话在途 W15 改动，`M`，184+/9-，mtime 20:54）为 false；我的两个主进程文件
  不 import 该组件。
- **o2-conflict-u1-smoke**：用 `git stash` 把我的改动全部暂存后重跑，**同样的
  failedStep（sheets `negative-edit`）照旧出现** → 与本卡无关（该套件是另一代理
  未跟踪的新目录，正在开发中）。
- **o0-format-fidelity-smoke**：同一代理在途的套件（目录 mtime = 运行前几分钟），
  失败在 `xl-select-a6` / `source-shows-complex-parts`（样本文件/页面侧），不经过
  `ipc/dbGuardedIpc.ts` / `ipc/documentView.ts` 的任何一行。

#### 9. 改了卡外文件（必须点名）

- `apps/desktop/scripts/memory-codex-smoke/stubs/electron.ts` 与
  `apps/desktop/scripts/t40-renderer-registry-smoke/stubs/electron.ts`：
  两份把 `ipcMain.on` 写成 `notHere(...)` 抛错桩。O4 修好后生产装配**真的**注册
  一条 `on` 监听（`close-check-result`），这两个套件因此在「总注册表能装起来」
  一条上红。桩原先按旧导入图校准（「总注册表里没人调 on」），现在那个前提被本卡
  合法推翻 —— 桩改为**记录式** `registeredListeners`，不再抛。这是我做的决定，
  不是被要求；若总控认为越界，请回退这两行并另开卡。

#### 10. 未做 / 觉得不对但没改

- **`handleOnce` 没登记进 registry**：单次 handler 执行一次就从 Electron 消失，
  把它暴露给 `app_api_call` 是假的。仓库里今天没有调用方；若将来有，需先想清楚
  "可重放的单次"语义。
- **`run.sh` 的 `--headless` / `--electron` 开关**是给变异用的分段的，`pnpm test:smoke`
  默认两段都跑。分段时第二段依赖第一段已跑不是前提（各自独立）。
- 卡说「主判据必须真 Electron + 真 docs 页」—— **vendor 快照缺失时本段如实失败
  （exit 2）而非跳过**，与卡第七节「不拿无头段的绿冒充」一致；这一点在
  `run.mjs` 里有注释。
- 另一个会话在 `src/renderer/**` 的在途改动导致 workflow-engine 套件红（见上），
  我按卡的禁改边界没有碰它。
