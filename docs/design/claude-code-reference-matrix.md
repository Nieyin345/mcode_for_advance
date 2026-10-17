# Claude Desktop（Code 工作区）参考矩阵 —— Mcode ARC-005 V0

> **这份文档是什么**：ARC-005 V0「基准冻结」的交付物。它记录**每一个视觉/交互判据的
> 来源**，并明确区分「已取证」「推导」「待测」三档 —— 台账要求「无法从合法样本确认的
> 值标『待测』，不得猜写成官方值」。
>
> **它不是什么**：不是「Mcode 已经高保真复刻」的声明。真实截图逐屏对照（V4）尚未做。

## 一、来源分级

| 档位 | 含义 | 当前有哪些 |
|---|---|---|
| **E1 取证** | 有可复核的字节/代码依据 | CDS 色阶与几何（`open-claude-ui/code-examples/cds-theme.css`，MIT，REA 逆向产物）；Mcode 生成物 `tokens.cds.css` 由 `gen-cds-tokens.mjs --check` 钉住 |
| **E2 推导** | 从取证值或平台事实推导 | 语义层映射（`--surface` → `--m-gray-*`）；圆角/阴影别名；动效时长档位 |
| **D 设计决策** | 用户明确要求或产品取舍 | 「会话优先」壳的目标形态；品牌色是否换陶土橙 |
| **待测** | 没有合法样本可核 | Claude Desktop 实际安装版本的字体族/字重、精确行高、窗口顶栏高度、设置页布局、窄窗断点、动效曲线在实际版本中的观感 |

> ⚠️ **一个诚实的边界**：`open-claude-ui` 的令牌是**上游逆向结论**，不是 Anthropic
> 官方文档。Mcode 采用它的原因是「可核验 + MIT 可再分发」；这不等于「与用户本机
> Claude Desktop 逐像素一致」。后者只能靠 V4 的真机截图对照回答。

## 二、色板（E1）

| 语义 | 亮色 | 暗色 | 来源 |
|---|---|---|---|
| 底层画布 | `--m-gray-10` (`252 252 251`) | `--m-gray-850` | CDS surface 阶梯 |
| 侧栏 / 轨道 | `--surface-muted` → `--m-gray-20` | `--m-gray-800` | 上游 Surface 0–3 |
| 主内容 | `--surface` → `--m-gray-10` | `--m-gray-850` | 同上 |
| 正文 | `--content` → `--m-gray-850` | `--m-gray-20` | 对比度取 AA |
| 发丝边 | `--edge` → gray ramp（**R G B 三元组**） | 同左 | 见下方「三元组约束」 |
| 品牌强调 | `--accent: 5 150 105`（emerald，**未改**） | 同左 | D：换 clay 会让 311 处 `text-accent` 不达 AA，待用户决定 |
| 备选品牌 | `--brand-clay` = `#d97757` | 同左 | E1，已暴露但未接管 `--accent` |
| 用户气泡 | `--m-orange-100`（alpha 0.9） | `--m-orange-850`（alpha 0.55） | E1 + 可读性调整 |

**三元组约束（踩过的坑）**：Mcode 的 `--edge` 等 token 存的是 `"R G B"`（840 处
`bg-edge/50` 这类 alpha 类依赖它）。把它裸写进 `box-shadow` 会在计算值阶段展开成
`195 194 183`，整条声明**静默失效** —— 必须包 `rgb(...)`。生成器的 `VAR_MAP`
已据此修正。

## 三、几何（E1）

| 维度 | 值 | 来源 |
|---|---|---|
| 面板圆角 | `--radius-panel` = 10px | CDS panel-radius |
| 输入框圆角 | `--radius-composer` = 20px | CDS radius-composer |
| 气泡圆角 | `--radius-bubble` = 18px | CDS message-bubble-radius |
| 按钮圆角 | 6 / 8 / 10px 三档 | CDS radius-sm/md/lg |
| 侧栏最小宽度（workspace 变体） | 240px | D：会话标题可读性下限 |
| 经典壳侧栏圆角 | 24px（`rounded-tl-3xl`） | 现状，保持不变 |
| 会话优先壳侧栏圆角 | 10px | E1（CDS 面板圆角） |

## 四、动效（E1 + E2）

| Token | 值 | 来源 |
|---|---|---|
| `--dur-fast` / `--dur-snap` / `--dur-base` / `--dur-sheet` / `--dur-slow` | 5 档 | E1，上游时长词表 |
| `--ease-out` / `--ease-snap` / `--ease-overshoot` | 3 条 | E1 |
| `--ease-swift` / `--ease-expand` / `--ease-enter` / `--ease-pop` / `--ease-pulse` / `--ease-rise` / `--ease-fall` | 7 条 | E1，上游取证曲线 |
| `--spring-btn` | `linear(0, 0.2459, …)` | E1：真弹簧采样；`cubic-bezier` 做不出二次回弹 |
| 减弱动效 | `html[data-reduce-motion="true"]` 总闸 + 9 处 `prefers-reduced-motion` | E2 |

## 五、交互面（逐项状态）

| 交互面 | Mcode 现状 | 与参考的差距 |
|---|---|---|
| 项目/会话侧栏 | 有（LeftBar / StreamSidebar 两视图） | 分组/过滤/状态标记的**视觉**仍是旧样式 |
| 新建会话 / 切换 / 恢复 | 有 | 快捷键与焦点顺序未逐项对照 |
| 聊天流 / 流式输出 / 工具卡 | 有 | 工具卡折叠层级与阅读宽度未按 CDS 重排 |
| 输入框 | 外框圆角/阴影已接 CDS token（V2 切片） | 附件/命令菜单/模型选择器的**视觉**未迁移 |
| 拖拽面板 / 分屏 | 有（Divider + 三栏布局） | 吸附/浮动窗口未做 |
| 内置终端 | 有（PTY 保活） | 顶栏与边框视觉未迁移 |
| 文件编辑 / Diff | 有（Monaco / GenOffice 面板） | 文件卡视觉未迁移 |
| 预览（HTML/PDF） | 有 | 同上 |
| 侧聊 / 并行任务 | 部分（子代理会话） | 交互未对齐 |
| 审批 / 改审阅 | 有（计划审批 / 权限卡） | 卡片视觉未迁移 |
| 设置页 | 有（94 个文件） | 信息架构按台账「常用/引擎/文档/扩展/系统」重组未做 |

## 六、待测清单（V4 前必须补）

1. 用户本机 Claude Desktop 的实际版本号与主题。
2. 字体族、字号阶梯、行高、字重（含 CJK fallback 的实际观感）。
3. 窗口顶栏高度、macOS 交通灯/Windows 控件区的精确占位。
4. 窄窗口断点与侧栏折叠阈值。
5. 动效在实际版本中的时长与曲线（当前用的是上游逆向值，未经真机核对）。
6. 设置页、命令面板、审批卡、工具卡的逐屏截图。

> **状态**：本矩阵是 V0 的部分交付（令牌与几何 E1，交互面现状盘点）。台账 ARC-005
> 的「开发完成 / 独立复核」**仍双空** —— 原因是 V4 真机对照未做，而 V4 是台账
> 写明的通过门槛。
