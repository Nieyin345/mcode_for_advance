# O2｜六格式真 Electron 下的保存冲突：用户和 Agent 同时改同一份文件

- Status: **ready-for-agent**
- Category: **Office / E2E-4 后半 —— 数据丢失类**
- Priority: **P0 —— 旧结果覆盖新内容是数据丢失，比任何 UI 问题严重**
- Depends on: `document-view-host-smoke` §11（host 层冲突检测已实现且有覆盖）、`t7-genoffice-u1`（六格式 U1 骨架）
- 独占写入边界：
  - `apps/desktop/scripts/o2-conflict-u1/**`（新建）
  - **不得改** `apps/desktop/src/main/document/documentViewHost.ts`（冲突逻辑已实现，本卡是取证）

## Required Skills

- `mcode-smoke`：真 Electron + CDP
- `systematic-debugging`：六格式的保存链路各不相同，失败形态会不一样

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
