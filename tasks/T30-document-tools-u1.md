# T30｜文档工具面缺真实 Electron U1 —— 只有 fake 端口验证过

- Status: **ready-for-agent（2026-10-23 解除阻塞）** —— T40 已交付（`9487eaa4`，13/13，含对照组证明装配路径），本卡的真 Electron 部分可以执行。**但 U1 套件需要独占 Electron，须等 E 的 T42 收工。**
- Category: **test（证据缺口）**
- Priority: P1
- Depends on: T24（`ce2913f8`）、T7（`77fdd012`）、**T40（`tasks/T40-renderer-tool-registry-unwired.md`）**
- Exclusive writable files: 新建 `apps/desktop/scripts/t30-document-tools-u1/`、复用 `apps/desktop/scripts/electron-u1/driver/`。**不改**产品代码。

## Required Skills
- `mcode-smoke`: 理解 E1 与 U1 的边界，知道 fake 端口能证明什么、不能证明什么。
- `code-review`: 确认断言测的是真实路径，不是桩。

Read before work: `CLAUDE.md`、`tasks/T24-document-tool-surface-redesign.md`（**§九 遗留与移交**）、`tasks/T7-genoffice-native-editors-u1.md`、`apps/desktop/scripts/electron-u1/driver/`、`apps/desktop/scripts/t7-genoffice-u1/`。

## T24 自己承认的遗留（原话）

> **真实 Electron U1 与三引擎在线回合未做**（T7 排期）：本卡的渲染端路线由 **fake 端口**驱动验证了「绑定身份/原始定义/拒绝路径」，**没有在真窗口里让真模型经 `document_tool_call` 调一次原生工具**。

## 这意味着什么

T24 交付的工具面（139 个工具 → 2,595 B，降 98.1%）**只在 fake 端口上验过**。真实链路是：

```
真 Electron 窗口 → 真 GenOffice 渲染端 → 真 AgentSkill.executeTool
→ document_tool_call → 结果回到同一 SDK turn
```

**这条链路从没在真窗口里跑通过。**

## 目标

用 `electron-u1` 骨架，在真 Electron 里验证 `document_tool_call` 的完整往返。

### 必须覆盖

1. **发现链路**：`document_apps()` → `document_tools_list({app})` → `document_tool_describe({tool})` 在真窗口里返回正确结果。
2. **调用链路**：`document_tool_call({tool, input})` 真的让渲染端执行了工具。
3. **结果回传**：工具结果带着 requestId / callId 回到宿主。
4. **负控**：
   - 未打开的文件调渲染端工具 → 拒绝
   - 未知工具 → 拒绝
   - 错误的 docId → 拒绝
5. **至少两个真实编辑器**（建议 Docs + Sheets，它们有成熟的工具面）。

### 不用做的

- **不需要真模型**。用 fake SDK 触发调用即可，但要**真 Electron + 真渲染端**。
- 不需要覆盖全部 139 个工具——验证链路，不是验工具质量。

## 验收判据

1. 真 Electron 起窗口，真 GenOffice 渲染端加载。
2. `document_apps()` / `tools_list` / `describe` 返回正确。
3. `document_tool_call` 让渲染端**真的执行**了一个工具（有可观测证据：DOM 变了 / 文件变了）。
4. 结果带回 requestId / callId。
5. 三条负控全部拒绝。
6. 至少两个编辑器的链路都通。
7. **变异验证**：把断言改成无条件通过 → 应红的必须红 → `cmp` 还原。
8. **不得**宣称 T7 或 T24 的验收被本卡取代。

## 边界

- **不改产品代码**。发现缺陷列出，另开卡。
- **独占 Electron**：开工前 `ps` 确认。
- **不改** `apps/desktop/scripts/electron-u1/driver/`（T16 交付的骨架）。

## 结果回写（2026-10-23）

### 0. 一句话结论

**静态部分交付完成；真 Electron 部分未执行，卡标 `blocked-on-T40`（不是 FAIL）。**

原因是先查清了链路本身：`document_tool_call` 的渲染端路线要求「有一个活跃的
受信文档 AI 请求」，而**生产代码从来没有把那个登记簿接上**。所以「T30 的 Electron
旅程现在跑起来会失败」不是环境问题、不是断言写错，而是产品缺口 —— 已开成
**T40（P0）**。T30 的断言按原意写好，T40 修好之前它会红，那正是它该做的事。

### 1. 发现的缺陷（本卡最重要的产出）

**【P0，产品缺陷，已开 T40】渲染端工具登记簿从未接上生产。**

- `documentToolRendererBinding.ts:58` 导出 `withRendererToolRegistry`，把
  `DocsAiPorts.run` 的进入/退出登记进 `active` 表；`activeRendererBindingFor()`
  只读这张表。
- 但 `apps/desktop/src/main/ipc/index.ts:227` 装的是**未包装**的 `docsAiPorts`。
- 逐处核对 `active` 的**全部 8 处引用**：唯一写入点是 L73–75（`withRendererToolRegistry`
  的 `run` 进入段），唯一清除点是同函数 `finally` 的 L79–82；其余四处
  （L107 / L124 / L144 / L160）全是只读，L160 的 `clearRendererToolRegistry`
  注释写明「测试用，生产不调用」。
- `git log -S "withRendererToolRegistry(" --all` 只有 `ce2913f8`（T24 引入）一个提交。
  **结论：从引入起就没接，不是接错地方、也不是后来被改坏。**
- 后果：`activeRendererBindingFor()` 永远返回「没有活跃绑定」→
  `document.tool_call` 的 `rendererOpen()` 恒 false → 渲染端路线**永远走不到**，
  所有工具一律落到 CLI（或对 renderer-only 工具显式拒绝）。
- 最小修复（T40 的实施者直接可用）：
  ```ts
  // apps/desktop/src/main/ipc/index.ts:227
  documentViewHost.setDocsAiPorts(withRendererToolRegistry(docsAiPorts));
  ```
  `withRendererToolRegistry` 是纯包装，`run` 的四个参数原样转发；包装后
  `document.tool_call` 用 `activeRendererBindingFor(filePath)`（按文件精确匹配，
  比 agent 侧的 `soleActiveRendererBinding()` 更严）。

**【P2，事实澄清，不是缺陷】Sheets 没有受信渲染端工具通道。**
六个编辑器里只有 Docs 有 T98 的请求级 ACK（`mcode:docs:ai-*` + `ai:tool-result`）。
Sheets 的原厂主进程是 standalone 全量注册，Mcode 不复用它的 AI 通道；
`createSheetsView({includeAiHandlers:false})` 也显式关掉了它。所以 sheets 的工具面
只有 CLI 路线。这不是 T30 发现的 bug，是当前产品面的事实 —— 本卡如实断言它，
没有用「也跑一遍」来掩盖。要给 sheets 同等能力，需要另开卡（与 Docs 同形接一条
请求级通道）。

### 2. 交付物

新增（独占目录，**未改产品代码**）：

```
apps/desktop/scripts/t30-document-tools-u1/
  journeys/index.ts                        注册表（惰性 require + beforeReady/afterReady）
  journeys/lib.ts                          生产 handler 装载 / 假 SDK 端口 / 取证助手
  journeys/docs-tool-roundtrip-production.ts  生产装配原样：断言 renderer-only 被拒（T40 证据）
  journeys/docs-tool-roundtrip-wired.ts   探针里补上 T40 的最小修复，走完整往返
  journeys/sheets-tool-call.ts             Sheets 的 CLI 路线 + 门禁 + 边界说明
  journeys/deliberate-failure.ts          故意失败自检（变异验证的判据来源）
  fixtures.ts                              夹具（CLI 造 docx、拷 vendor blank.xlsx）+ 独立读取器
  vendor-esbuild.mjs                       复用 T7 的 vendor 解析，只追加本套件别名
  window-holder.ts                         `@main/window.js` 替身（补两个 T7 版本缺的导出）
  run.mjs                                  入口（调 electron-u1/build.mjs，不复制执行器）
  verify-contract.mjs                      **不需要 Electron** 的判定契约自检
  verify-contract.driver-shim.ts           自检专用 driver 入口（避开 runner 的 electron）
```

复用而未复制：`electron-u1/driver/`（执行器）、`t7-genoffice-u1/harness.ts`
（生产 Host 单例 + vendor 视图装配）、`t7-genoffice-u1/editor-flow.ts`（打开链）、
`t7-genoffice-u1/prebuild.mjs`（生产 `documentViewPreload.ts` 产物）、
`t7-genoffice-u1/vendor-esbuild.mjs`（vendor 解析规则）。

### 3. 旅程设计与各自断言的形态

| 旅程 | 装配 | 期望 | 断言的都是什么 |
|---|---|---|---|
| `docs-tool-roundtrip-production` | **与生产一字不差**（未包装 ports） | **红**（T40 未修时）/ T40 修后形态变化 | `document_apps` 139；`toolsList`/`toolDescribe` 正确；`read_blocks` 走 CLI 成功；**renderer-only 工具被显式拒绝且原因点名「受信渲染端」**；未知工具/界外路径拒绝 |
| `docs-tool-roundtrip-wired` | 仅把 T40 的一行修复装进探针 | 绿（链路本身通） | 页面桥完整 → **真页面 AI 面板**（composer 输入 + 真 Enter）发起请求 → fake SDK 进入 `run` 并等 gate → 登记簿看到绑定 → `document.tool_call` 走 `route:"renderer"` → **DOM 真的变了** → 放行 → 同一 requestId 收尾 → 伪造 ACK 被 T98 拒绝 |
| `sheets-tool-call` | 同 T7（生产 Host） | 绿 | sheets 目录/描述；`propose_operations` 写 A1 → **独立 CLI 读回同值**；编辑后 `qa.gate==="check"` 且 `issues` 是数组；renderer-only 工具（`web_search`）显式拒绝；A1 后续不变 |
| `deliberate-failure` | 无窗口 | **必须红**（`expect:"fail"`） | 用于「变异跑必须由红转绿」；`failBecause` 要求失败恰在断言步骤、且前置动作步骤 PASS |

`docs-tool-roundtrip-wired` 的**唯一替身是模型**：`DocsAiPorts.run` 换成 fake 端口
（不联网、不调 SDK）。其余全生产 —— 页面、preload、AgentLoop、T98 注册器与
请求/ACK 校验、`createNativeEditorToolBridge`、渲染端 `AgentSkill.executeTool`、
宿主 handler、磁盘写入。

### 4. 本卡实际跑过的验证（全部不需要 Electron）

```
node scripts/t30-document-tools-u1/verify-contract.mjs   → 13/13
```

`verify-contract.mjs` 打**真** `electron-u1/driver/verdict.ts` 与**真**旅程对象
（`deliberate-failure.ts`），断言：

- 注册表形状（恰好一条 `expect:"fail"`、产品旅程全 `pass`）；
- 正常跑：`deliberate-failure` 的字面 FAIL 被判为 `expected-failure`；
- 变异跑：同一份证据改成全 PASS 后判为 `all-pass`（这就是 `--mutation=unconditional-pass`
  的判据来源）；
- 退出码：正常 1 / 变异 0 / **产品旅程红 → 2（不被预期红掩盖）**；
- `failBecause` 三条反例都不得算「预期红」：失败在别的步骤、缺前置动作 PASS、
  动作步骤先红。

**变异验证（本卡自己的断言也在判）：**

1. `verdict.literalStatus` 改成恒 `"PASS"` → **6/11 红**（5 条变红）；`cmp` 逐字节还原。
2. `deliberate-failure.failBecause` 去掉步骤检查 → **12/13 红**（「失败落在别的步骤」
   这条变红）；`cmp` 逐字节还原。

⚠️ **第 2 条第一次是假绿**：脚本里原本复制了一份 `failBecause`，改坏真文件它也全绿
——正是「断言测的是别人的职责」。改成打包并读取**真旅程对象**后，才真的变红。
这个坑已写进 `verify-contract.mjs` 的注释。

**回归（提交后复跑）：**

```
t24-document-tool-surface-smoke           PASS
t0-genoffice-native-tool-roundtrip-smoke  PASS
genoffice-cli-smoke                       PASS
```

**双包 typecheck：** `packages/contracts` 与 `apps/desktop` 均通过（提交前实测）。

**构建自检：** 用与 `run.mjs` 相同的 `--esbuild=` 选项把 `journeys/index.ts`
打了一次包（`esbuild` 直接调用，产物落 `.tmp/`，验完删除）—— 通过。它只证明
「旅程能构建」，不证明任何运行时行为。

### 5. 未做的部分（如实）

1. **真 Electron 旅程一次都没跑。** 原因两条：
   a. Electron 被另一张卡（T29）独占，且用户反馈弹窗影响工作，总控明确要求暂停；
   b. 即使跑，`docs-tool-roundtrip-production` 在 T40 修复前会红 —— 那是设计中的红。
   三份旅程里预计会有若干**运行时细节**需要按真机反馈调整（例如页面 AI 面板是否
   默认展开、composer 的 React 受控输入是否吃 `insertText`、sheets 首帧等待时间）。
   这些是「第一次上真机」的正常成本，不是已知缺陷。
2. **`docs-tool-roundtrip-wired` 里 `pageTools` 的旧写法已被替换**为「页面自己发起
   请求、工具表由 AgentLoop 提供」的思路；文件里不再有 `window.__t30SkillTools`
   这类探针注入（初稿有，已删）。
3. **没有宣称 T7 或 T24 的验收被本卡取代。** 本卡只补「工具面在真窗口里的往返」
   这一段证据，且目前连这段都还没跑。

### 6. 提交

- 静态部分：`deacf188`（`test(T30): static U1 suite for the document tool surface,
  blocked on T40`），13 文件。
- 产品代码、`genoffice/`、`electron-u1/driver/`、`t7-genoffice-u1/` 均未改动；
  他人未提交修改原样保留（工作树里 T29/T40 相关的改动不是本卡的）。

### 7. 恢复条件（T40 修好后怎么接着做）

```bash
cd apps/desktop
node scripts/t30-document-tools-u1/run.mjs                      # 全量（正常 + 变异对照）
node scripts/t30-document-tools-u1/run.mjs --only=docs-tool-roundtrip-wired
node scripts/t30-document-tools-u1/verify-contract.mjs          # 静态契约（随时可跑）
```

T40 修复后预期变化：
- `docs-tool-roundtrip-production` 里 `renderer-route-refused-without-registry`
  这一步的**成功条件会变**：拒绝理由不再是「没有受信绑定」，而应变成
  「该工具不在当前请求声明的工具表里」（因为登记簿存在但该请求没声明它）。
  这一步需要按新行为重写断言 —— 已在步骤注释里标出。
- `docs-tool-roundtrip-wired` 可以改成**不装**探针的那一行修复（直接用产品装配），
  届时它与 production 旅程合并为一条即可。


---

## T30 静态核实（2026-10-23，E 会话，未跑 Electron）

总控要求核实三件事，结论如下。

### 1. 静态部分到哪一步了 —— **已完成，且质量高**

- 目录 `apps/desktop/scripts/t30-document-tools-u1/` 齐备（8 个文件 + `journeys/`）；
- **`verify-contract.mjs` 本轮实跑 13/13 通过**（不启 Electron，纯判据自检）：
  注册表形状、正常跑/变异跑的退出码、`failBecause` 三条反例全部判对；
- 提交 `deacf188`，未改产品代码；
- 写回区已经把 T24 遗留的 P0 缺陷（登记簿未接）开成 T40 并复现已修（`9487eaa4`）。

**这条路已经做到头了 —— 再往前必须跑真 Electron。**

### 2. 真 Electron 部分具体要验什么

按卡的验收判据，共 5 组、最少 2 个编辑器：

| 组 | 内容 | 为什么静态验不了 |
|---|---|---|
| A | `document_apps` / `tools_list` / `tool_describe` 在真窗口返回正确 | 要真渲染端加载后的工具目录 |
| B | `document_tool_call` 让渲染端**真的执行**工具（DOM/文件可观测变化） | 要真 vendor 页面 |
| C | 结果带回 requestId / callId | 要真 T98 ACK 通道 |
| D | 三条负控（未打开文件 / 未知工具 / 错误 docId） | 要真宿主状态 |
| E | Docs + Sheets 两条链路都通 | 同上 |

**关键**：`docs-tool-roundtrip-wired` 的**唯一替身是模型**（fake `DocsAiPorts.run`），
页面、preload、T98 注册器、`createNativeEditorToolBridge`、渲染端 `AgentSkill.executeTool`
全是生产代码。所以它验的是真链路。

### 3. 能不能用已有 `.tmp/electron-u1/` 证据回答 —— **不能**

核过了：

```
.tmp/electron-u1/ 下 8 次运行的证据目录，journey 全部是
  docs/sheets/slides/pdf/markdown/html-open-edit-save-reopen   ← T7 的六个编辑器旅程
find .tmp/electron-u1 -name "*t30*" -o -name "docs-tool*"  → 零命中
```

**没有一条是 T30 的旅程。** 那些证据属于 T7（打开/编辑/保存/重开），
与「工具面往返」是不同的断言对象 —— 它们证明不了 A–E 任一组。

### 4. 结论：**T30 的真 Electron 部分也必须挂起**

理由：

1. **必须新跑**，没有可复用的既有证据；
2. 每一次跑都**真的开窗口**（与 T42 同一个问题），用户已明确说过影响他使用电脑；
3. T30 是 **P1（证据缺口）**，不是功能不可用 —— 产品面本身没坏，缺的是「这条链路
   在真窗口里跑通过」的证据。

**建议**：与 T42 一起标 `blocked-on-user-environment`，等用户给出可占用电脑的时间窗。

### 5. 一件事现在就能做（不需要 Electron）

`docs-tool-roundtrip-production` 里那一步
`renderer-route-refused-without-registry` 的断言，在 T40（`9487eaa4`）修好之后**已经过期**：
拒绝理由不再是「没有受信绑定」，而应该是「该工具不在当前请求声明的工具表里」。
旅程注释里标了要改，但**代码没改**。

这是纯粹的断言文本修改，不跑也能做——但它属于 T30 的独占目录，且改完仍要真 Electron
才能验。**本轮没动**，留给出下一棒的人，避免改出一份"看起来对了但从没跑过"的断言。
