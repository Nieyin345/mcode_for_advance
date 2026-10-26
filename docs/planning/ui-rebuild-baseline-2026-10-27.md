# UI 重构现状基线（2026-10-27）

> **这份文件是什么**：接手「UI 重构」前的现状盘点。所有数字都附产生它的命令，
> 按 CLAUDE.md 第 43 条「报结论时把产生它的命令一起报出来」写。
>
> **它不是什么**：不是计划，不是验收，也不关闭 ARC-005。它只回答「现在在哪一步」。
>
> **证据等级**：全部 E2（源码静态读数）+ 少量本机已存在的 E1 产物（视觉基线）。
> 没有一条做过变异验证，没有一条跑过真实用户旅程。

---

## 〇、一句话结论

**Mcode 的 UI 已经有「Claude 风格」的全部零件，缺的不是更多样式，而是三件结构性的东西：**
**① 没有一条「用户会看到的样子」的验收链路**（视觉基线只测 token，不测正文，且 PNG 不是判据）；
**② 工作台的外形（左栏/主列/右栏/底部终端）是固定的，不是可拖放的工作区**；
**③ 主对话 `ChatPane` 3788 行零套件**，任何对它的重排都无回归网。

在这三件之上谈「像不像 Claude」都只能靠人眼看截图。

---

## 一、规模现状（数出来的）

| 事实 | 数字 | 产生它的命令 |
|---|---|---|
| 渲染端 `.ts(x)` 文件 | **531** | `find apps/desktop/src/renderer -name "*.tsx" -o -name "*.ts" \| wc -l` |
| 渲染端总行数 | **56,179** | `find … \| xargs wc -l \| tail -1` |
| `styles.css` | **4,501 行** | `wc -l apps/desktop/src/renderer/styles.css` |
| 组件目录 | 14 个，`chat/` 114 个文件 | `ls apps/desktop/src/renderer/components/*/ \| wc -l` |
| 超过 1000 行的渲染端文件 | **24 个** | `find … \| xargs wc -l \| awk '$1>1000'` |
| 最大单文件 | `stores/sessionStore.ts` **7,452 行** | 同上 |
| 第二大 | `components/chat/ChatPane.tsx` **3,788 行** | 同上 |
| 第三大 | `stores/sessionStoreHelpers.ts` **3,080 行** | 同上 |
| 渲染端 `await api.*` 散装调用 | **397 处**（`components/` 下） | `grep -rn "await api\." …/components \| wc -l` |
| `useRpc` 使用点 | **114 处** | `grep -rn "useRpc" …/renderer` |
| 全套件数 | **662 套** | `ls -d apps/desktop/scripts/*-smoke \| wc -l` |
| ARC-005 专项套件 | **54 套** | `ls -d apps/desktop/scripts/arc005-* \| wc -l` |
| 设置页文件 | **107 个** | `find …/components/settings -type f \| wc -l` |

**判据不是行数，是「独立单元的个数」**（见 `docs/design/mcode-结构性优化清单.md` §七之二）。
上表只用来判断「哪里最有可能藏着重排风险」，不构成拆分的理由。

---

## 二、UI 线目前的实际状态

### 2.1 外壳：已经是「一棵树、两个摆放变体」，但变体覆盖很窄

- `App.tsx:330` 永远渲染同一个 `<ClassicShell variant={shellVariantOf(shellPref)}>`，
  切壳不卸载 PTY/Monaco（这条不变量有注释、smoke 与真 Electron 焦点探针共同背书）。
- `workspace` 变体只改：左栏最小宽 240px、圆角 10px（vs 经典 24px）、隐藏分隔线。
- **`[data-ui-shell-variant="workspace"]` 作用域规则 154 条；`classic` 作用域 0 条**
  —— 差异全部是「workspace 往上加」，classic 是基线。
  命令：`grep -c 'data-ui-shell-variant="workspace"' styles.css`。
- 默认值 `DEFAULT_SHELL_PREF = "workspace"`（`shell/shellPrefs.ts:33`），
  但 `leftBarMode` 默认仍是 `"tree"`（`sessionStore.ts:658`），不是 Claude 的流式会话列表。
- **外壳 + layout 目录内视口断点（`sm:` / `md:` / `lg:`）为 0 处**。
  命令：`grep -rnE "\b(sm|md|lg|xl):" components/shell components/layout | wc -l`。
  全渲染端 18 处，散落在设置/监控/记忆面板里，不影响外壳。

**结论**：workspace 变体是一次「给旧组件加 CSS 覆写」的收敛，**不是重画**。
154 条作用域规则说明这套做法的维护成本已经很高——每加一个面板都要在同一个
`styles.css` 里追加一份 `[data-ui-shell-variant="workspace"] [data-cds="X"]` 覆写。

### 2.2 token：三层体系已经对齐上游，但缺 4 个家族

| 家族 | 状态 |
|---|---|
| 色阶（`--m-gray-*` 等） | ✅ 生成物 `tokens.cds.css` 由 `gen-cds-tokens.mjs` 从上游 E1 抽取 |
| 语义层（surface/content/edge/accent/diff） | ✅ 已接，`--diff-*` 已落地（18 处引用） |
| 圆角角色档 | ✅ btn-xs/btn-md/dialog/code/card 已补（`styles.css:1137-1141`，`sketch` 主题另有覆盖 `:3506-3509`） |
| 动效（5 时长 + 10 曲线 + 弹簧） | ✅ 与逆向报告逐值一致 |
| **`--space-*`** | ❌ **0 处** |
| **`--font-*`** | ❌ **0 处**（字体族是系统栈 + Tailwind `fontMono`） |
| `@property` | 2 处（上游 90 处） |
| `forced-colors` | 4 处（上游 6 处）✅ 接近 |
| `prefers-reduced-motion` | 23 处 + `html[data-reduce-motion]` 属性总闸 |

命令：`grep -cE "^\s*--space-" styles.css` / `--font-` / `@property` / `forced-colors`。

**间距与字体族是这套 token 体系里仅剩的两个大洞。** 上游的 `data-size` 档位
（一条规则翻转整套尺寸）在 Mcode 只是「新组件可以消费的三个变量」，
老组件仍写死 Tailwind 尺寸类——`styles.css:1181-1192` 的注释自己承认了这点。

### 2.3 视觉验收链路：有，但它只能证明 token，不能证明「看起来对」

`apps/desktop/scripts/arc005-visual-baseline/`：

- 真 Electron `capturePage()`，19 场景 × 3 条件 = **57 格**。
- 每格 JSON 带 `snapshot.tokens`（根变量值）+ `snapshot.measured`（16 个选择器的
  `getComputedStyle`）+ `fixture` 类型 + `data-arc-fixture`。
- `compare.mjs` **只比 token 和 measured，不读 PNG**。
- README §3 如实记录：**48 张图两轮连跑只有 12 张逐字节相同** —— PNG 不是判据，是观测。

**已知的判据盲区**（`docs/design/claude-code-reference-matrix.md` §十二/T149 追加）：

- 正文排版（字号/行高/缩进）在 2026-10-24 之前**完全不可见** ——
  探针的 `message` 选择器命中的是外层 `.prose`，不是正文 `.chat-md`。
- 现在补了 `chat-body` 选择器 + `measured` 比对路径，**覆盖 6 格**
  （messages / approval × 亮/暗/窄窗）。其余 45 格显式 `present: false`。
- 变异已验证：`--chat-md-leading` 1.625 → 1.45，`unregistered` 从 0 变 6，
  六条全部精确指向 `chat-body.lineHeight`。

**这不是「有视觉回归网」，是「有 6 个格子的正文排版回归网」。**
其余排版面（工具卡、文件树、设置页、右栏）没有任何机器判据。

### 2.4 真实用户旅程（U1）：骨架刚搭好，还没有一条产品旅程

- `apps/desktop/scripts/electron-u1/` **已存在**（T16 交付）：
  真 Electron + 真鼠标 `sendInputEvent` + 真 `insertText` + 真 OS 进程重开，
  断言分 `dom` / `visual` / `sideEffect` 三档，证据落 `.tmp/electron-u1/<时间戳>/` 永不清理。
- 它的 README 写死了与 `arc005-visual-baseline` 的边界：
  「禁止拿 arc005 的 fixture 截图冒充 U1 旅程证据」。
- 目前跑的是自检旅程（含一条故意 `expect:"fail"` 的旅程），**没有 GenOffice 打开编辑保存重开、
  没有真实多会话并行、没有重启恢复**。

### 2.5 pane 模型：是四个槽位，不是工作区

`components/layout/paneLayout.ts`：

```ts
export type PaneId = "left" | "right" | "bottom" | "editor";
export type DockSide = "left" | "right" | "bottom";
```

- 四个槽位 + 三个停靠边。`LAYOUT_PRESETS` 有 chat / editor / balanced 三套。
- `moveLayoutPane` 的可见效果只对 `right` 有意义（`T12-ui-workbench-baseline.md` §1.4）。
- **`openTabs` 不持久化**（`sessionStore.ts:642-645` 注释、`:1314` 里 `init` 重置为空再填 landing session）。
  命令：`grep -n "openTabs" sessionStore.ts`。
- 没有任意 pane 网格、没有浮窗、没有跨面板拖放。

### 2.6 审批可见性：后台会话在等审批时，侧栏看不出来

`layout/StreamSidebar.tsx:131-158` 的 `statusOf`：

```ts
if (running) return working;
if (pendingQuestionBySession[s.id] != null) return input;   // ← 只认提问
if (turnError) return failed;
if (unread > 0) return done;
return time;
```

**待工具审批、待计划审批不会让一个后台会话显示「等你」。**
这与最高原则「不静默、由用户本人点头」直接相关，也是 T12 列出的 Top 5 阻塞项之一。

---

## 三、把「UI 重构」拆成可执行的四层

按「先有判据、再改形状」的顺序排，不按「哪块看起来最丑」排。

### 第 1 层 · 把判据补齐（不改视觉）

**为什么先做**：现在改任何像素都无法验收。这一层做完，后面每一刀才有红/绿。

| # | 做什么 | 验收判据 | 独占文件 |
|---|---|---|---|
| A1 | 把 `measured` 的 16 个选择器扩到覆盖工具卡、文件树、设置页导航、右栏 tab | 每个新选择器都有 `present:false` 的显式三态；变异：改对应的 token，`unregistered` 必须增加**恰好**对应的条数 | `arc005-visual-baseline/probe-assertions.ts`、`compare.mjs` |
| A2 | 补 `--space-*` / `--font-*` 两族 token（值先与现有硬编码等价，不改变渲染结果） | 改前后 `compare.mjs` 的 `unregistered` 为 0，即「零视觉变化」 | `styles.css`、`gen-cds-tokens.mjs` |
| A3 | 把 `openTabs` 落进契约（新 setting key）并在 `init` 恢复 | 重启旅程：开 3 个 tab → 重启 → 3 个 tab 都在且顺序不变 | `packages/contracts/src/ipc/settings.ts`、`sessionStore.ts` |
| A4 | 审批可见性：`statusOf` 增加 `awaiting` 档，侧栏与 tab 有可读标识 | 隐藏会话收到工具审批 → 侧栏显示「等你」；回答后消失 | `StreamSidebar.tsx`、`SessionTabs.tsx` |

### 第 2 层 · 把「一块」重画成「一个组件」

**目标**：把 154 条 `[data-ui-shell-variant="workspace"] … [data-cds=X]` 覆写，
按面板逐个迁成**组件自身的属性化样式**，而不是在全局 `styles.css` 里追加选择器。

| # | 做什么 | 为什么值得 | 验收 |
|---|---|---|---|
| B1 | 侧栏：`LeftBar` / `StreamSidebar` 的会话行 / 项目行 / 分组标题，迁成组件内 `data-cds` + 作用域 CSS | 现在三种视图各写一套 → 154 条覆写里 40+ 条在维护它们 | 迁完 `styles.css` 的 workspace 规则数必须**下降**，且 A1 的选择器全部保持绿 |
| B2 | 输入框（composer）：把模型/推理/权限/模式四颗药丸从 `ChatPane` 内联 JSX 抽成 `composer/` 下的四个独立组件 | `ChatPane` 3788 行是最大单点；这四颗药丸是它最常改动的部分 | 抽出后 `ChatPane` 行数下降，且 A1 的 composer 选择器断言的**计算样式逐字段不变** |
| B3 | 工具卡：`MessageBlocks.tsx` 2041 行里 Edit/Write/Bash 三类卡与共享 `ToolDetailSection` 拆开 | T14 已经把共享正文面做出来了，但三类卡的折叠行仍是内联 | 三类卡的 `data-cds` 与 A1 新选择器一一对应 |

**⚠️ B 层每一刀都必须先有 A1 的选择器守着**，否则「迁完更好看了」无法证明。

### 第 3 层 · 把「外形」从固定三栏改成工作区

**这是唯一一处真正的结构改动，也是风险最高的一处。**

- 现状：`left | center | right` + 底部终端，`PaneId` 四槽位。
- 目标：任意 pane 可拖放停靠 / 弹出窗口 / 布局持久化恢复。
- **前置**：A3（tab 持久化）已经打完，且 A1 的 `paneGeometry` 断言覆盖了退化场景
  （中心区 ≥240px、右栏 ≥130px、无二维覆盖）——现在 `sidechat` / `files-pane` /
  `git-pane` / `narrow-window` 四格已经有这条断言。

**不建议在没有 A3 与 A1 的情况下动这一层**：布局持久化是它的一半，
没有它，「拖好了」在重启后就没了，而这一点现在无法验收。

### 第 4 层 · 手感与细节（并行，随时可做）

| # | 做什么 | 上游依据 |
|---|---|---|
| D1 | `@property` 注册要参与过渡的变量（滚动渐隐、消息动作栏透明度） | 逆向报告 §3.4，上游 90 处 |
| D2 | 按钮按下「快进慢出」不对称（`--spring-btn` 已存在，但只在少数按钮上生效） | 逆向报告 §2，上游 169 处 `cds-btn-squish` |
| D3 | `[hidden] { display:none }` 守卫：凡给元素写了 `display` 的地方 | 逆向报告 §4.2，false-warning 类 |
| D4 | 轮廓式骨架屏（按上次侧栏布局画 `{top,left,w,h,r}` 方块） | 逆向报告 §3.1；需要「记住上次布局」的数据，依赖 A3 |

---

## 四、明确不要做的事

| 不做 | 理由（有出处） |
|---|---|
| 把 `DEFAULT_SHELL_PREF` 从 `classic` 改成 `workspace` 当完工 | `claude-code-reference-matrix.md` §十：**禁止仅把 default 改成 workspace 当完工**（已于 `shellPrefs.ts:33` 改为 workspace，但外壳仍是固定三栏） |
| 抄 Claude 的 216KB 构建期扫描 CSS | 逆向报告 §5.3：mcode 的 Tailwind 按需产出是对的 |
| 三层 token 重构成 385 色阶 | 逆向报告 §5.2 C10：跟着「用户自定义主题」需求一起做，不单独重构 |
| 用 PNG 哈希证明「零视觉变化」 | `arc005-visual-baseline/README.md` §3：48 张图两轮只有 12 张相同 |
| 为了「看起来更像 Claude」删 Mcode 独有能力 | `claude-code-reference-matrix.md` §十：资料库/自动化/工作流/GenOffice/MCP 必须保留 |
| 复制 Anthropic 专属图标、字体文件、源码 | 同上：只能转通用设计参数与交互语义 |

---

## 五、当前工作区状态（开工前必读）

- **632 个未提交变更**：185 个 `M`、401 个 `D`、46 个 `??`。
  命令：`git status --porcelain | wc -l`。
- 其中 **401 个 `D` 绝大多数是 `tasks/` 与 `audit-ledgers/` 的删除** ——
  这是 CLAUDE.md 「执行卡制度已废止（2026-10-26）」的落实，不是事故。
- 最近提交集中在 Office 原生编辑器（`3490189d` 起 12 个 `office:` 提交）。
- **多会话并行时先做单文件回滚对照**（CLAUDE.md 第二十三条），
  再决定某个红是不是你造成的。

---

## 六、下一步（如果只做一件事）

**做 A1：把 `measured` 的选择器扩到覆盖工具卡与设置页导航。**

理由：它是唯一一件「做完之后所有后续改动都能被证明」的事，
而且它不需要任何产品决策——上游的值已经在 token 里，缺的只是「有人量它」。

它的变异验证很便宜：改一个对应的 CSS 变量，`unregistered` 必须增加
**恰好等于覆盖格数**的条数（T149 的 `chat-body` 就是这么验的：6 格 → 6 条）。
