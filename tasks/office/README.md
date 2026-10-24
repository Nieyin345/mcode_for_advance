# Office 总控｜缺口总表与卡序

> 2026-10-24 建立。**这份是 Office 线的唯一进度依据**，每交付一张卡就更新一行。
> 本目录（`tasks/office/`）的卡由 Office 总控写，编号从 `O0` 起，与 `tasks/T*.md` 互不干涉。

## 一、验收依据（不是本文件发明，来自三处）

| 来源 | 承载什么 |
|---|---|
| `docs/planning/mcode-product-roadmap.md` §3 | Office/GenOffice 的产品定位与「验收纪律」 |
| `audit-ledgers/Mcode_统一审查台账.md` §四 **E2E-3 / E2E-4** | 六格式编辑的**否决型**判据；AI 交互的否决型判据 |
| `docs/planning/arc007-genoffice-native-integration-map.md` | 每个格式「必须复用哪个上游包」「当前缺口」 |

**验收纪律（原话）**：E1/headless 只能证明覆盖路径，**不等于真实 Electron U1**。
「任何一个独立红例尚在时不得给对应原 ARC 的完整开发/独立复核打勾。」

## 二、E2E-3 / E2E-4 逐条对照（2026-10-24 实测基线）

跑过的东西和结果，**不是读代码猜的**：

| 判据 | 现状 | 证据 |
|---|---|---|
| 六格式**打开→编辑→保存→关闭→重开** | ✅ 全过 | `t7-genoffice-u1` 6 journeys all-pass，真 Electron，2 OS 进程 |
| 六格式**含 DOM + 视觉 + 磁盘副作用**三层断言 | ✅ | journey 里 `assertDom` / `assertVisual` / `assertSideEffect` |
| 六格式**vendor 资源齐全** | ✅ | 六个 `out/renderer` + `out/preload` + sidecar 8.9MB + CLI 14MB |
| **AI 选区交互主链路** | ✅ 全过 | `genoffice-ai-ask-smoke`：chip→气泡→队列→发送→文档改动→落盘→围栏 |
| **AI 用的是真三 SDK** | ❌ **mock 端点** | 该套件 `probe.ts` 用 mock `/chat/completions` |
| **三 SDK 生产接线存在** | ✅（代码层） | `docsAiPorts.ts:59` `SUPPORTED = claude-sdk/pi-sdk/codex-sdk` |
| **公式/图表/批注/动画/未知部件不静默损坏** | ❓ **未验** | 现有 journey 只验「有内容、能保存」，不验复杂部件保真 |
| **用户与 Agent 并发改同一文件冲突提示** | ❓ 部分 | `genoffice-native-view-smoke` 有 PPTX CAS 用例；六格式未逐一验 |
| **兼容软件回读**（Office/WPS 打开我们保存的文件） | ❓ **未验** | 现有断言只到「重开我们自己能读」 |
| **安装版 U1**（离开源码开发机） | ❌ **未验** | 打包链路已通（`--dir`），但没有一次「装完之后打开六格式」的验收 |

## 三、已确认不是缺口的（避免重复开卡）

跑过、绿的，**不要再开卡**：

- `document-router-smoke` 133/133、`genoffice-file-routing-smoke` 52/52
- `genoffice-native-view-smoke` 21/21、`document-view-host-smoke` 18/18
- `document-read-smoke`、`genoffice-format-gates-smoke`、`genoffice-ai-ask-smoke` 各 PASS
- `genoffice-pane-fence-smoke` 含变异、`t11`/`t87` 许可证门禁
- 六格式 U1（`t7`）

**⚠️ 一个调用方式的坑**：`bash apps/desktop/scripts/<name>/run.sh` 从仓库根跑会失败
（脚本内部 `cd` 后 `dirname "$0"` 变成相对路径，`../lib/esbuild-path.sh` 找不到）。
**必须用 `pnpm test:smoke <name>`**，否则会把「调用方式错」误读成「套件红」。
（我第一天就误读了两次。）

## 四、卡序

按「用户能看见什么」排，不按代码整洁度排。

### O0 — 六格式复杂样本保真（E2E-3 的真缺口）

**为什么第一张**：现有 U1 只证明「简单内容能读写」，而用户抱怨的正是「AI 改完文档又烂又丑」。
复杂部件（公式、图表、批注、动画、嵌套表）静默损坏，是这个产品最致命的失败形态——
**它不报错，用户打开才发现文件坏了。**

**判据**：六格式各一份复杂样本，编辑一处无关内容 → 保存 → 重开 → **未触碰的复杂部件逐项仍在且语义等价**。

### O1 — 真实三 SDK 的 AI 交互 U1（E2E-4 的真缺口）

**为什么**：`genoffice-ai-ask-smoke` 用 mock 端点。用户要的是「原版 AI 交互 + Mcode 的三家引擎」，
mock 通过**不能证明**真 SDK 能驱动这条链。三家各自的差异（工具调用格式、流式、错误）没有覆盖。

**判据**：claude-sdk / pi-sdk / codex-sdk 各跑一次真 Agent，选区→AI 改动→落盘；
**失败时不许静默换引擎**。

### O2 — 并发写同一文件的冲突提示（E2E-4 后半）

**为什么**：用户和 Agent 同时在改同一份文档，旧结果覆盖新内容是**数据丢失**，比任何 UI 问题严重。

**判据**：六格式各验一次「打开→外部改动→保存被拒并提示」；PPTX 已有 CAS 用例，其余五个补上。

### O3 — 安装版 Office 验收（E2E-6 的 Office 部分）

**为什么**：`--dir` 打包已通，但**没有任何一次「装完之后打开六格式」的证据**。
源码开发机能跑，不等于用户装上能跑（资源路径、sidecar、字体都可能不同）。

**判据**：从 `release/win-unpacked` 启动，六格式各开一份，编辑保存重开。

## 五、状态

| 卡 | 状态 | 提交 | 子代理 | 独占目录 |
|---|---|---|---|---|
| O0 六格式复杂部件保真 | **✅ 交付** | `de95c45e`（卡）/ `0591acbc`（代码） | 已完成 | 49 项 PASS / 32+1 变异全红 |
| O1 三家引擎驱动 AI 编辑 | **✅ 交付** | `f74f6b52`（卡）/ `e77fe9f1`（代码） | 已完成 | 46/46，6 变异 |
| O2 六格式保存冲突 | **执行中** | `153d6686`（卡） | 已派 | `scripts/o2-conflict-u1/**` |
| O3 安装版 Office | **✅ 交付** | `53413379`（卡）/ `f383922b`（代码） | 已完成 | 16/16 PASS，23/23 变异 |
| O4 docs 关闭缺陷修复 | **执行中** | `2120284e`（卡） | 已派 | `scripts/o4-docs-close-smoke/**` |
| O5 删 OnlyOffice，六格式走 GenOffice | **已写卡，未派** | `b380ced8`（卡） | **等 O2/O4 收工** | 跨四层，见卡 |
| O6 五个编辑器换壳（**B 方案**） | **执行中** | `a655762c`（卡） | 已派（html+markdown） | `genoffice/apps/*/src/renderer/` |

## O3 交付摘要（`f383922b`，16/16 PASS）

**解压态产物六格式全 PASS。** `capabilities.hosts` 六项 true，`cliPath` 指向
`resources/genoffice/cli/genoffice.cjs`（安装版分支，显式断言不含 `/genoffice/packages/cli/`）。
每份夹具由**产物 CLI** 生成，六格式各自断言特征 DOM + 唯一 token。

**三条值得记的**：

1. **卡 §6.2 我写错了**：改 `editorsBundled` 不会让任何断言红 —— 它**运行时零消费方**
   （`grep` 零命中，只被构建期脚本读）。真正被 `genofficeCli.ts:113` 读的是 `bundled`。
   已在卡里改正并划掉原说法。
2. **发现真缺陷 → 开了 O4**：docs 关闭恒被拒（`createDbGuardedIpc` 只有 `handle` 没有 `on`）。
3. **sheets 的断言边界，子代理如实标注了**：生产页面**没有**可读单元格的 DOM/桥面
   （`__univerAPI` 只在 DEV 下挂）。它第一次变异写「六个全红」是错的，改成「五个红 + sheets 绿」
   并注明原因 —— **没有硬拗成红来制造不存在的覆盖**。这是正确做法。

## O0 交付摘要（`0591acbc`，49 项 PASS）

**基线 49 项全 PASS，生产代码零改动。** 覆盖的复杂部件：

| 格式 | 项数 | 覆盖 |
|---|---|---|
| DOCX | 9 | 嵌套表、编号列表、页眉页脚、脚注、`w:eastAsia` 东亚字体 |
| XLSX | 11 | 跨 sheet 公式、条件格式、合并、**图表部件 + 图表锚点** |
| PPTX | 14 | 每页元素清单×3、`p:timing` 动画×3、母版占位符、备注、媒体字节哈希 |
| PDF | 4 | 页数、文本层、书签（标题+层级+**目的地**）、批注 |
| Markdown | 5 | 表格、代码块、图片引用、嵌套列表、部件顺序 |
| HTML | 6 | `style`/`script`/`svg`、body class、img src、部件顺序 |

**每个格式另有独立的「编辑真的落盘」断言**（不经页面）：`docs/sheet/slides read`、PDF `/Rotate 90` 字节、
直读 `.md`/`.html`。这条很重要 —— 否则「部件还在」可能是「文件根本没被写」。

### ★ 我做的独立验证（不只看它自报）

**我不信全绿，所以自己造了一个它没覆盖的坏法**：把 DOCX 里整个 `w:eastAsia` 属性删掉，只留 `w:ascii`
（文案一字不变，但中文会落回西文回退字体）。这是真实编辑器保存时会做的事。

结果：`red=true hit=missing:docx.eastAsia-runs`。**判据抓住了，而且区分了「值变了」（`changed:`）
和「属性没了」（`missing:`）两种形态。** 验证后已逐字节恢复。

### 它自己抓出的三个真问题（都修了）

1. **`textOf` 对所有文本返回空串** —— 脚注/备注比对其实在比两个空串，典型「绿着但什么都没比」；
2. **xlsx 公式变异造出非法工作簿**，引擎报 XML Error 导致**全员假红**——已加「变异体必须能被原厂读取器打开」的门；
3. **`mutate.mjs` 重算时漏传 fingerprint opts**，口径不一致导致误报。

### 如实记录、不放宽判据的一条 vendor 行为

**PPTX 被编辑文本框的 `spAutoFit` 高度会收缩**（`slides:edit-text` 的 `applyAutofitResize`）。
它只对那一个 `(slidePath, name)` 放 box、其余照比，把代价写进 `FingerprintOptions` —— **没有为了全绿去放宽判据**。

### 未做（它主动报的）

1. PDF 旋转**视觉**呈现未验（只验了字节写 `/Rotate 90`）；
2. PPTX 母版占位符是**人工补进 blank 模板**的（vendor blank 布局无 `p:ph`），建议另开卡用真实模板做样本；
3. PPTX 备注「换页」变异退化成「清空备注」（真 relocate 要手建 notesSlide+rels+content-types，代价大于判据本身），已标注 `delete-form`。

## O1 交付摘要（`e77fe9f1`，46/46 PASS）

**三家在流式/工具协议/结果形状/错误信封/取消五点上确实完全不同，现有适配层三家都吃下去了。**

三份替身是**三个不同文件**（`shapes/claude.ts` / `pi.ts` / `codex.ts`），各自 import 该家真实粘合层
喂该家真 `MessageAdapter`；`docsAiPorts`、三个 adapter、工具桥、调度器**全是生产实现**。
`docsAiPorts.ts` 一字未动（已核 `--name-only`），`genoffice-ai-ask-smoke` 20 条未碰。

关键形状差异（读源码得出，不是猜）：

| | 工具结果形状 | 完成信号 | 工具前缀 |
|---|---|---|---|
| claude | 内容块**数组** | `result{subtype}` | `mcode_renderer__` |
| pi | `{content:[...]}` **对象** | `agent_end{willRetry}` | `app_external__` |
| codex | **拼成 string** | `turn/completed` | `mcode_renderer__`（同名不同协议） |

**变异**：撤单家粘合 → 各 4 红且只红在该家组（证明三家真走不同分支）；
让 abort 失效 → **6 红不是 9**，因为落盘有第二道闸（`docsAiPorts.ts:134` `if (!signal.aborted) onChunk`，
`:136` throw）—— **我核过，是纵深防御不是死断言**。

**它自己抓出一个假绿并修了**：第一版渲染端 `save()` 无条件写盘，使「报错→未落盘」在
「save 把原文原样写回」时也成立（**代理指标失效**）。补上 vendor 真实脏检查后，
断言改成「文档未改 **且** save 从未被请求」，并配正常流「save 恰好一次」正控。

**结论**：没有发现哪家形状被错误处理。未做：真调 API（无凭据）、全量（需批准）。

## O5：用户裁决落地（卡已写，未派）

**用户原话**：「OnlyOffice删掉，不要了」「之前的全部都不要了，现在的office还有md全部走genoffice这一条线」
「默认啊，而且要把 office 的 ui 契合现在的 ui」「嵌入到现在的 mcode 里面」「就像是打开 md 文件一样丝滑」

**规模：134 处，21 个文件，跨四层**（契约 → preload → 主进程 → 渲染端）。分三批串行。

### 两处删除时最容易漏的地方（已写进卡）

1. **`documentKind` 的 `"office"` 语义绑定在 OnlyOffice 上**（`:26` 注释原文 + `:65` 对齐 `ONLYOFFICE_EDITABLE`）。
   要么换名、要么改语义并改注释。**不许悄悄改语义。**

2. **`isGenofficeViewAvailableFor` 的入参 `office` 现在传的是 `isOnlyOfficeSupportedPath(filePath)`。**
   删掉那个判定函数而不管入参 → `office` 恒 false → `genofficeViewForOffice` 恒 false →
   **默认模式永远到不了 GenOffice**。这是「构建通过但功能没接上」的典型形态。

### 一处流传的错误依据（已纠正）

有人说「GenOffice 上游认得 `docm/dotx/xltx/pptm/potx`」，依据是 `limits.ts` 的 `FAMILY` 表。
**那个表是解压体积限额分族，不是路由。** 真路由在 `app-routing.ts`，正则与我们**逐字一致**，都不认这五种。
补它们是**我们自己的扩展**，且 `genoffice-file-routing-smoke` 会因比对而红。

### 「丝滑」的拆解

用户说「像 md 一样丝滑」。**md 的丝滑来自它是 React/DOM 组件，GenOffice 是 `WebContentsView` 独立进程。**
但我判断「丝滑」指的是**交互无感**（点一下就开、不用切两次模式），不是**零延迟渲染** —— 按前者做，
如实记录「首次打开 1–2 秒」。

**iframe 方向已排除**：vendor preload 依赖 `contextBridge` + `ipcRenderer` + `webUtils`，
iframe 里没有这些；且 `WebContentsView` 的 sender 校验是安全边界，**为性能拆边界不值得**。

## O6：用户选 B —— 五个编辑器换壳

**用户看着一张截图说**：「你的测试完全是 genoffice 的 ui 啊，不是我们的 mcode 的 ui」。

**截图里是完整的 GenOffice 应用**：自己的 ribbon、File/Edit/View 菜单、Genspark AI 侧栏、品牌。

**根因**：`genofficeViewFactories.ts` 加载的是 `genoffice/apps/<k>/out/renderer/index.html`，
**上游原封不动的产物**；`documentViewHost.ts` / `genofficeViewFactories.ts` 里
**一行 `insertCSS` / `executeJavaScript` 都没有**（我 grep 过）。

**测试一直绿，是因为它们断言的是上游特征 DOM 存在** —— 那是它们被要求做的事。
**不是测试撒谎，是我把「上游应用加载了」读成了「嵌入完成」。**

### 用户选了 B（vendor 二开），不是 A（外部 CSS 硬藏）、不是 C（接受）

### ★ 这件事已经做过一次

`05da63c feat(docs): reshell the chrome in Mcode's design tokens` —— **docs 两天前就换壳了**，
235 行 CSS、2 个文件。做法是**重指 token**，不是改组件：

> GenOffice 的 chrome 颜色全部走 `packages/ui/src/tokens.css` 的语义 token，
> 而且它有自己的 CI（`tools/check-theme-colors.mjs`）强制 renderer CSS 里不许有裸色值。
> 所以换壳是**替换 token 的取值**：组件树、编辑内核、导出/打印路径一行不动。

加载方式 `if (window.desktop) import('./mcode-theme.css')` —— **单独跑 GenOffice 时不换壳**。

**我核实过：六个 app 的 `main.tsx` 全部 import 同一个 `tokens.css`**，所以机制对五个格式都成立。

### 工作量（按 token 数排）

| 格式 | token 数 | 状态 |
|---|---|---|
| docs | 197 | **已完成** |
| slides | 150 | 待做 |
| pdf | 115 | 待做 |
| sheets | 109 | 待做（截图那个） |
| markdown | 95 | 待做（本批） |
| html | 57 | 待做（本批，最小，先验机制） |

### 硬边界（卡里反复强调）

**文档内容色和语义色一律不动**：纸张、单元格、导出、打印、图表调色板、
**公式引用高亮、错误值红、条件格式色**、修订条、查找命中。

> **「宿主里的编辑器和单独跑的 GenOffice 是同一个应用，只是 chrome 换成了 Mcode 的配色。」
> 不是「重新画了一个编辑器」。**

## 下一批

- **O4** 已派（docs 关闭修复）
- **O5** 待开：取决于 O0/O1/O2 的红表

**不要提前开。** O0/O1/O2 是取证，结论决定修什么。

---

## 五之二、★ 派活时必须传达的三条（2026-10-24 下午补）

**这三条都是因为新派生的套件踩过，不是理论。**

### 1. `run.sh` 必须用 `HERE`，且 `cd` 之后不许再用 `$0` 算路径

```bash
# ✅ 唯一推荐写法
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
```

**为什么**：`cd` 之后 `$0` 仍是调用者给的相对路径。从仓库根跑会拼成
`apps/desktop/apps/desktop/scripts/...`，**rc=127，日志只有一行 bash 错误**。

**这条的代价不是「藏了个 bug」，是「任何人照 `smokes-for.sh` 打印的用法跑一遍都会得到假红」。**
我今天上午就因为它在两套上误判成「套件坏了」。

### 2. 别用 `rc` 的某个值当判据

`127`=命令找不到、`124`=超时、`1`=真失败、`2`=用法错。
**`rc != 127` 会把超时当成功。** 判据应是 **stderr 不含 `No such file or directory` / `command not found`**。

### 3. 说「大概率」之前先查

我今天说过「`o0`/`o1` 大概率也是同一形状」——**当时还没查**。实测后三个里两个安全、一个是另一种正确写法。
**「大概率」掩盖了「我还没查」。**

### 4. 回报时要给出「工作目录 + 已创建文件清单」

**起因（2026-10-24，我自己的假警报）**：O2 派出去 4 小时，我去看
`apps/desktop/scripts/o2-conflict-u1/`（我卡里写的名字）——**空的**。
我据此判断「4.5 小时无产出，不正常」。

**实际它用的是 `o2-conflict-u1-smoke/`（多一个 `-smoke`，符合仓库惯例），
726 行的 journeys.ts、565 行的 lib.ts，两分钟前还在改。**

**我的卡写了一个目录名，它用了另一个更符合惯例的名字，而我在监工时用了我卡里那个。**

**所以回报里必须有这两样**：

> **工作目录是什么、已创建了哪些文件。**
> 不要只说「做完了」——我要能自己去看。

**理由**：我能接受「慢」，不能接受「我以为它慢，其实是我看错了地方」。

### 5. 超过 1 小时没进展就回报一次，别闷着做

**起因**：O2（六格式保存冲突 U1）派出去跑了 4 小时没消息，而 O0（49 项断言 + 32 变异，
工作量更大）只用了 2.4 小时。

**可能的原因**：卡在真 Electron、遇到没预料的困难、或在做超范围的事。
**但无论哪种，我都只能等** —— 因为我的卡里没写「卡住了要回报」。

**从下一张卡起，每张卡都要有这一条**：

> **超过 1 小时没有可展示的进展，回报一次现状（做到哪、卡在哪、还需要多久）。
> 不要闷着做到结束才说话。**

理由：我能接受「慢」，不能接受「慢且不知道为什么」。

## 六、已知的设计约束（不自造，从源码读出来的）

### 6.1 `WebContentsView` 会盖住一切 React 浮层

`GenofficeViewHostPane.tsx` 文件头原文：

> `WebContentsView` 是叠在 BrowserWindow 上的 **OS 级子视图**，它不属于 React 的 DOM 树。

**后果**：编辑器区域内**不能**用 React 渲染下拉菜单、tooltip、右键菜单、弹窗 —— 全部会被盖住。
任何「在 Office 编辑器上叠加 UI」的需求，**要么走 GenOffice 自己的渲染，要么改视图 bounds**。

现在不是 bug（没人在编辑器列上加浮层），但是**约束**。

### 6.2 编辑器没有边框，是结构性的，不是漏了

`GenofficeViewHostPane.tsx:545` 的 stage 是空 div，`measureBounds()` 用
**`getBoundingClientRect()` 原样矩形**（`:179-195`，无内缩），所以视图**精确盖满 stage**。

**加 CSS border 是无效的** —— 边框会被视图盖住。
要加边界，只能**让 stage 内缩 1px**，把 border 画在它的父容器上。

**代价**：内缩会让编辑器内容少 2px 宽高。对 slides 画布缩放、表格列宽可能是可见的。
**所以这条必须配「内缩前后编辑器内容渲染一致」的断言，不能只改样式。**

### 6.3 抽屉挤压编辑器列，但不会遮挡

`ThreePaneLayout.tsx:442-449`：drawer 是 `position: "relative"` + flex 流 + `maxWidth: 30%`，
**不是浮层**。它挤压布局，不遮挡。

`editorWidthPct` 默认 50、范围 20–80（`sessionStore.ts:796` / `EDITOR_WIDTH_PCT_MIN/MAX`），
是**相对父容器的百分比**，不是像素。正文 `max-w: 672` 不改变它。

**抽屉开 30% 时编辑器会很窄**，但那是「窄」不是「被盖」，且 `ResizeObserver` 会重算 bounds，不会错位。

### 6.4 面板边框与圆角：现有唯一先例是 6px，不是 10px

UI 总控给的数值我逐条核过：

| token | 存在？ | 谁在用 |
|---|---|---|
| `--panel-edge`（`#e3e3e2` 亮 / `#2c2c2a` 暗 / 另有 sketch、暖色两套） | ✅ `styles.css:195/404/2610/2641` | 结构长线 |
| `border-edge-panel` → `--panel-edge` | ✅ `tailwind.config.js:80` | 三栏分隔、右栏面板 |
| `--radius-panel` = 10px | ✅ `styles.css:1099` | **没有任何大面板在用** |

**UI 说「右栏面板用的就是 --panel-edge」，边框对、圆角错。**

`RightPanel.tsx:345/:357` 实际是 `rounded-md border border-edge-panel`。
Tailwind **没自定义 `borderRadius`**（`tailwind.config.js` 只有 colors），所以 `rounded-md` = 默认 **6px**。

全仓「`rounded-{md,lg,xl}` + `border border-edge-panel`」的组合**只有这两处** —— 这是唯一先例。

**所以 Office 面板若用 10px，会和右栏的 6px 不一致**，而且 4px 差异在小尺度上不明显，
不会被立刻发现。等 UI 总控定夺；定了之后把最终值写在这里。

**这一条的意义不在于 4px**，在于：**「token 存在」不等于「token 在用」**。
UI 给的是「设计意图」，代码里是「实际取值」，两者不一致时以代码为准，并**把这个不一致报出来**。
