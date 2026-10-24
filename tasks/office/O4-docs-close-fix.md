# O4｜docs 关闭恒被拒：包装层只实现了 handle，`on` 静默不注册

- Status: **ready-for-agent**
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
