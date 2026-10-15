# `sessionStore.ts` 领域划界（2026-10-15）

> **这是设计判断，不是实施。** 交付物是「该不该拆、拆什么、代价多少」的结论，
> 以及一份可复用的域清单。**没有改任何代码。**
>
> 所有数字来自 TypeScript 编译器 API 与全仓扫描，不是估计。

---

## 一、先纠正两个流传的数字

| 说法 | 实测 | 说明 |
|---|---|---|
| 「789 个 state 字段」 | **164 个 state + 211 个 action** | 789 那个数是把 action 也算进了 `SessionState` 的成员总数。AST 按「值是不是函数」分开数：**state 164、action 211**。 |
| 「9379 行，该按域拆 store」 | **state 只占 164 行（1.7%）** | 见下节的构成。**按域拆 store 是错的方向**。 |

## 二、9379 行的真实构成（AST 实测）

| 行数 | 占比 | 是什么 |
|---|---|---|
| **6061** | **64.6%** | **action 实现** |
| 2064 | 22.0% | 接口 / 类型（`SessionState` 及周边） |
| 496 | 5.3% | store 的包裹外壳（`create(...)` 闭包） |
| 321 | 3.4% | 模块级函数 |
| **164** | **1.7%** | **state 字面量** |
| 273 | 2.9% | imports / 常量 / 空行 |

**文件大的原因不是 state 多，是 action 多（6061 行）。** 所以"把 state 按域分成几个 store"
这个方向，收益上限是 164 行，代价却是下面那条。

## 三、为什么"拆成多个 store"不可行（实测）

扫描渲染端全部 `.ts/.tsx`，统计每个 state 字段被**多少个外部文件**引用：

| 字段 | 外部引用它的文件数 |
|---|---|
| `model` | **87** |
| `locale` | **70** |
| `sessions` | 57 |
| `projects` | 56 |
| `activeSessionId` | 40 |
| `activeProjectId` | 32 |
| … | |
| **164 个 state 字段** | **全部被外部引用**（没有一个只被 store 自己用） |

**拆成 N 个 store 意味着每个消费者要 import N 个 store。** 今天 87 个文件读 `model`，
它们现在只需要 `useSessionStore`；拆完要么逐个改 import，要么在 barrel 上再聚一次
（那就等于没拆）。

这与 `repositories.ts` 的情形**根本不同**：那里 90 个消费方 import 的是**离散的 Repo 对象**
（`SessionRepo` / `LibraryRepo`…），边界天然清晰；这里 164 个字段是**一个共享状态空间**，
被 UI 各处交叉读写。

## 四、action 不是"纠缠"，是"没地方住"

AST 统计每个 action 引用了多少个**其它 store 成员**：

| 引用成员数 | action 个数 |
|---|---|
| 0–2 | **140**（66%） |
| 3–5 | 32 |
| 6–10 | 23 |
| 11–20 | 12 |
| 20+ | 4 |

**平均 3.5 个。** 140 个 action 只碰 ≤2 个成员 —— 它们是**薄函数**，不是逻辑纠缠。
按域聚类也印证这点：落在「≤3 个域且 ≥40 行」的 action 只有 19 个，
而且它们**不成族**（`openFileInIde` 归编辑器、`moveSession` 归会话骨架、
`adoptAgentBrowserTab` 归浏览器 —— 只是各自凑巧）。

**所以真正的问题不是"耦合太紧"，而是"没有归档机制"**：任何新功能的第一直觉是
"往 store 加个方法"，因为 store 是唯一一个所有组件都 import 的东西。

## 五、结论与建议

### 不该做的

- ❌ **按域拆成多个 store。** state 只占 1.7%，而 164 个字段全被外部引用 ——
  代价（N 个 store 的 import 网）远大于收益。
- ❌ **硬拆那 6061 行 action。** 平均只碰 3.5 个成员，但它们**共享 `set`/`get` 闭包**。
  搬走要么传一整套 accessor（等于把 `set`/`get` 重新发明一遍），要么改成
  "独立模块 + 在 store 里注入" —— 那是**改架构**，不是拆文件。

### 该做的（按性价比排序）

**① 把 45 个设置镜像从 store 里挪出去（最高性价比）**

store 里 import 了 **45 个 `*_SETTING_KEY`**，对应 K 域（25 个字段）与 J/L 域的一部分。
它们与"会话状态"无关 —— 是**持久化偏好的本地镜像**，而且每个都带一对
`setXxx` / 持久化逻辑。

做法：`settings` 已经是 `SettingRepo`（main 侧落库）+ `IPC.SETTING_CHANGED` 广播
（store 里已有 `reduceSettingChanged`）。把「读设置」收敛成一个 `useSetting(key)`
（`useRpc` 那一路），组件不再从 store 读 `chatFontSize` / `voiceLang` / `commitGenModel`。

**收益**：K 域 25 个字段 + 约 50 个 `setXxx` action（约 600–900 行）可移出。
**风险**：低 —— 这些都是**读多写少**的偏好，路径已经存在（`reduceSettingChanged`）。

**② 给 action 一个归档机制，而不是继续往 store 加**

140 个 action 只碰 ≤2 个成员，说明多数 `setXxx` 其实是**一行 `set({...})`**。
在 store 上加一个明确的**分区注释**（`// ── IDE ──` / `// ── Git ──` / …），
并规定「新 action 必须落在某个分区里」，先把**增长**刹住 —— 这比搬家便宜，
而且立刻可执行。分区就等于本文档第一节那 13 个域。

**③ 把 2064 行类型定义搬去 `types.ts`**

`SessionState` 及其周边接口占 22%，是**纯类型、零运行时**。搬到
`renderer/stores/sessionStoreTypes.ts` 再 re-export，`sessionStore.ts` 立刻少 2000 行，
**且没有任何行为风险**（类型只在编译期存在）。

> 这条最像 `fileIcon` 那次：纯数据、零耦合、机械搬迁。2064 行里 `SessionState`
> 一个接口就是 1764 行 —— 它自己就该是独立文件。

**③ ✅ 已实施（2026-10-15）—— 2052 行类型搬去 `sessionStoreTypes.ts`**

用 AST 定行范围、逐块切片（类型之间夹着 import/export 与常量，不能整段切），
搬完 `sessionStore.ts` 用 `export type { ... } from "./sessionStoreTypes.js"` 转发，
**144 个消费者一行未改**。

| | 搬前 | 搬后 |
|---|---|---|
| `sessionStore.ts` | 9379 行 | **7279 行**（−2100） |
| `sessionStoreTypes.ts` | — | 2150 行（`SessionState` 自己 1688 行） |

新增 `scripts/session-store-types-smoke/`（7 条）：把搬家前的 15 个类型写死成契约，
断言 store 仍全部转发、且类型文件里定义的都转发了（**两个方向**：漏转发 / 定义了取不到）。
变异验证：从 re-export 去掉 `SessionState` → 2 条真红。

⛔ **未搬**：`DeltaSeg`/`DeltaEntry`(L2231-2243) 与 delta 缓冲函数绑在一起、
`IngestCtx`(L2386) 与 reducer 绑在一起 —— 它们不是纯类型，单独搬会把逻辑一起拖走。

**④ （不推荐，仅记录）** 真要动那 6061 行，正确路径是**先有 ① 和 ②** ——
把设置镜像挪走、给 action 分区之后，再看还剩多少是"会话本体"的 action。
那时才可能谈"拆"，而且大概率会发现**剩下的不值得拆**。

## 六、为什么这份文档值得存在

`sessionStore.ts` 被反复提起"太大了"，但**没有人量化过"大在哪"**。
这份文档给出的三个数字 —— **state 1.7% / action 64.6% / 类型 22%** ——
把"太大"拆成了三个完全不同的结论：

- state 小 → **按域拆 store 是错的**（这也是最初的直觉，实测推翻了它）；
- action 大但薄（平均 3.5 个成员引用）→ **不是纠缠，是缺归档**；
- 类型占 22% → **有 2064 行是可以零风险搬走的**（建议 ③）。


---

## 附二、`ChatPane.tsx` 的诊断（2026-10-15，同一次调研）

既然在查"哪些大文件该拆"，顺手把**渲染端最大的组件**也量了。结论与
`sessionStore` 不同，方法也不同。

| 指标 | 实测 |
|---|---|
| 文件总行数 | 3767 |
| 顶层声明 | **1 个**（`ChatPaneForSession`，L396-3763，**3367 行**） |
| 该函数体内的顶层语句 | **201 条** |
| 其中最大的一块 | `return <JSX>` **806 行** |
| 第二大 | `renderListItem` 246 行 |
| 第三 | `wrapLiveSpine` 150 行 |
| 其余 | 一堆 handler（`jumpToMessage` 99 / `handleSend` 54 / `handlePasteFiles` 50 …） |

**这不是"多个独立单元挤一个文件"，是"一个巨型组件函数"。** AST 探针给出
**0 个独立单元** —— 因为整份文件只有一个顶层块。

### 为什么不拆

`renderListItem` 引用 **91 个标识符**（绝大多数是外层闭包里的 state / handler）。
提取它要传一打 props，而且**任何一次漏传都是静默的行为变化**（React 不会报错，
只是渲染出少了东西）。这类重构的风险远高于收益。

### 该做什么（不是拆分）

`ChatPaneForSession` 的问题本质是**在一个函数里同时做了四件事**：
1. 一批 DOM/交互 handler（`jumpToMessage` / `pauseBottomAnchor` / `handleStreamMouseUp`…）
2. 数据准备（`listItems` / `recomputedPicker` / `beforeMap`…）
3. 纯渲染片段（`renderListItem` / `wrapLiveSpine`）
4. 806 行的 JSX 编排

正确路径是**提 hook，不是提组件**：
- 把 ①② 收进几个自定义 hook（`useChatScroll` / `useChatHandlers` / `usePickerState`）——
  hook 与组件共享闭包是**正常且惯用**的，不需要传 props；
- ③ 那两块（`renderListItem` / `wrapLiveSpine`）在 hook 化之后，需要的输入会收敛，
  那时再提成真组件才有意义。

> ⚠️ **顺序不能反**：先提组件（把 91 个标识符传进去）会把耦合**固化**成 props 契约，
> 之后再提 hook 就更难了。

### 为什么先不做

这需要**按功能重新划分 hooks**，是设计工作，而且 `ChatPane` 是消息流主视图 ——
改错的影响面大。**当前没有回归网**（0 套覆盖它），所以第一步应该是
**先建网再动刀**（仓库硬规矩 7）。本轮不排。

## 附：13 个域（可复用为分区名）

| 域 | 字段数 | 说明 |
|---|---|---|
| A 会话与项目骨架 | 22 | 会话/项目实体、列表分页、当前选中 |
| B 会话内容（消息/回合） | 22 | 消息流、回合状态、上下文、用量 |
| C 待决交互（问答/审批/计划） | 10 | 等着用户点头的卡片 |
| D 撰写区（composer） | 7 | 输入框、队列、草稿、附件 |
| E 侧聊/子聊 | 3 | side chat |
| F 编辑器 / IDE | 19 | 打开的文件、目录展开、导航历史 |
| G Git | 11 | 仓库状态、diff 对话框 |
| H 浏览器面板 | 6 | 内嵌浏览器标签 |
| I 布局（纯 UI） | 12 | 面板开合与宽度 |
| J 应用级 UI 外壳 | 10 | 设置/命令面板开闭、窗口聚焦 |
| K 设置镜像（落库偏好） | 25 | **建议 ① 的对象** |
| L 引擎与模型 | 15 | provider / model / 可用模型 |
| M 项目级自定义命令 | 1 | 每项目的斜杠命令 |

（另 `leftBarMode` 未归类，实为 J 域。）
