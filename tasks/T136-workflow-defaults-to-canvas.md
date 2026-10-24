# T136｜工作流页签默认打开 Node-RED 画布，而不是库列表

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— 用户明确要求**
- Priority: **P0**
- Depends on: 无（现状已具备条件）

## 用户原话（2026-10-24）

> **「默认就是 node-red 的编辑页面，不要之前自己写的编辑页面了」**

**配套截图**：当前打开「设置 → 工作流」看到的是「第三方引擎」页签里的报错「编辑器视图没能打开 / 文档视图不存在或已关闭」。

## 零、先说清：自研画布**已经删了**

**这一条我核实过**，`WorkflowLibraryView.tsx:179` 的注释原文：

> **Route to the existing authenticated Node-RED editor; do not create a second canvas.**

**所以「不要之前自己写的编辑页面」这件事已经做了。** 用户看到的不是自研画布，是 **Node-RED 的 `WebContentsView` 打不开**。

**所以这张卡有两件事，别混：**

| # | 问题 | 性质 |
|---|---|---|
| **1** | **默认落在哪个页签** | 用户明确要求：应该直接是 Node-RED 画布 |
| **2** | **截图中那个报错** | 真实的缺陷：视图创建后立刻丢失 |

## 一、任务 1：默认页签

### 现状

```
设置 → 工作流
  ├─ 工作流库（默认）      ← 打开就是这里
  │    └─ 选中工作流 → WorkflowNativeEditorEntry 按钮 → 跳「第三方引擎」页签
  ├─ 节点类型
  ├─ 代理档案
  └─ 第三方引擎            ← Node-RED 画布真正在的地方
```

`WorkflowsPanel.tsx:211`：

```ts
onOpenNativeEditor={() => { setNativeCanvasEpoch(n => n + 1); setView("engines"); }}
```

**用户要的是：打开就是「第三方引擎」那一页。**（或者把那个页签改名成「画布」/「编辑器」）

### 但要先回答：库视图里还有什么必须保留

**`WorkflowLibraryView` 不只是列表**，它还有：

| 内容 | 会不会丢 |
|---|---|
| 工作流列表（新建/删除/重命名） | **需要别处承载** |
| **`NodeInspector`（右侧 300px 参数检查器）** | ⚠️ **这是核心** —— Node-RED 画布里点节点，参数在哪改？ |
| 保存 / 审批 / 评审流程 | **需要别处承载** |
| `WorkflowNativeEditorEntry`（跳转按钮） | 默认就在画布上时不需要了 |

**⚠️ 第二条是这张卡的真正难点。**

**如果 Node-RED 原厂编辑器自带参数面板**，那 `NodeInspector` 可以只留给「Mcode 自己的节点类型」（比如主代理、模块能力），那些 Node-RED 不认识。

**如果它不自带**，那去掉库视图等于**用户没法改节点参数**。

**执行前必须先查清**：

```bash
# Node-RED 原厂编辑器的节点参数在哪配置
grep -rn "editorType\|oneditprepare\|editable" node-red/packages/node_modules/@node-red/editor-client/src/
```

**判断完再动手。**

## 二、任务 2：那个报错

### 报错原文

```
编辑器视图没能打开
文档视图不存在或已关闭
```

**来源**：`documentViewHost.ts:733` 等处的 `if (!live) return { ok: false, reason: "文档视图不存在或已关闭" }`。

### 我的推测（执行时验证，不要当成结论）

**设置页是全屏覆盖层，切换页签会 remount `EngineRuntimePanel`。** 而 `WebContentsView` 是 OS 级子视图，**remount 时 `close` 一次、`open` 一次**，中间有一个窗口期视图不存在。

**如果 `open` 之后立刻有代码去 `bounds` 或 `focus` 那个还没登记完的视图，就会拿到这句。**

**验证方法**：

```bash
# 在 viewError 的 setter 上加临时日志，打印完整的调用栈
grep -n "setViewError" apps/desktop/src/renderer/components/settings/workflows/EngineRuntimePanel.tsx
```

**或者**：先只做任务 1（改默认页签），看报错是不是消失了 —— **如果默认就在 engines 页签，可能根本不会触发 remount**。

## 三、验收判据

1. **打开「设置 → 工作流」直接看到 Node-RED 画布**（不是库列表）。
2. **节点参数仍然能改** —— 如果 `NodeInspector` 被移走，必须有替代；**如果没替代，这条不许通过**。
3. **截图里那个报错不再出现**（或者在真机上确认它能恢复）。
4. **工作流的新建 / 删除 / 重命名仍然可达**。
5. **自动化页签行为不变**（它也共用这个面板）。

## 四、边界

**可以改**：
- `components/settings/workflows/WorkflowsPanel.tsx`（默认 `view`）
- `components/settings/workflows/WorkflowLibraryView.tsx`
- 相关的 i18n

**不许碰**：
- `EngineRuntimePanel.tsx` 的引擎起停逻辑（只改视图挂载时机的话可以，但要说明）
- `documentViewHost.ts`（那是 Office 和 Node-RED 共用的）
- `chat/` / `layout/`（UI 那边已稳定）

## 五、回写

1. **Node-RED 原厂编辑器有没有自带的节点参数面板**（这条决定 `NodeInspector` 的去留）
2. 默认页签改成了什么、用户还能不能新建/删除工作流
3. **那个报错是否消失**，为什么
4. 套件数字、截图路径、提交 SHA
5. 你觉得不对但没改的地方
