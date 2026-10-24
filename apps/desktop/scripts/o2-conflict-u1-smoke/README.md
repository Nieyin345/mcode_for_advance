# O2 —— 六格式保存冲突取证套件

卡：`tasks/office/O2-save-conflict.md`。**这是取证套件，不是「六格必须全绿」的回归网**——
四个格式的「预期红」本身就是本卡的结论（见 `expectations.ts` 的源码出处）。

## 跑

```bash
pnpm test:smoke o2-conflict-u1-smoke                       # 全量六格式（~85–120s）
pnpm test:smoke o2-conflict-u1-smoke --only=o2-conflict-docs  # 单个格式（调试）
node scripts/o2-conflict-u1-smoke/run.mjs --classify-only   # 只跑静态归类（~4s，不启动 Electron）
node scripts/o2-conflict-u1-smoke/mutation.mjs              # 三条变异（~3×90s）
node scripts/o2-conflict-u1-smoke/run.mjs --variant=expect-green  # 修复后的回归门禁（现在必红）
```

退出码：**0 = 结论与 `expectations.ts` 一致**（docs/sheets 拦住；其余四个按预期被静默覆盖）。
**0 不代表六格全绿。** 构建失败同样退出 1，`run.mjs` 读 `suite-summary.json` 判定，
不把「构建崩了」读成「预期红」（第一版踩过，见 `run.mjs` 文件头）。静态归类不成立时
在启动 Electron 之前就红（`--classify-only` 只跑这一段）。

## 保存路径归类（静态，决定修复卡规模）

`save-paths.ts` 在**启动 Electron 之前**读源码，把六个格式归成三类。它是
「下一张修复卡多大」的**机器化结论**，源码漂移时会自己红：

| 类 | 含义 | 格式 | 修复方向 |
|---|---|---|---|
| `host-cas` | 走 Mcode host 的乐观锁 | docs | — |
| `vendor-own-guard` | vendor handler 自己比 sha256 | sheets | — |
| `bypass` | **vendor 主进程自己写盘，Mcode 无拦截** | slides / pdf / markdown / html | 在 Mcode 侧包住那四条通道，或动 vendor |

`bypass` 的四条还有一个共同事实：**请求类型里根本没有版本字段**
（`SavePdfRequest` / `SaveMarkdownRequest` / `SaveHtmlRequest` 无 revision；slides 的
`save()` 连参数都没有）。所以不是「传了没校验」，是**这条路从未有过版本概念** ——
修复需要在 Mcode 侧接管这四条通道（进而在写盘前后比版本），不能靠「给页面加个参数」。

`--classify-only` 的用途：渲染端被别的会话改坏、`electron-u1` 构建失败时，
仍然能回答归类问题（本次就是这样用的）。

## 六格式 × 四条判据（2026-10-24 实测结论）

| 格式 | 保存通道 | 4a 冲突被拒 | 4b 盘上保住外部内容 | 4c 用户看得见 | #5 不误报 |
|---|---|---|---|---|---|
| docs | `mcode:document-view:save` | ✅ 拒绝（`reason:"conflict"`，带 `currentRevision`） | ✅ | ✅ 状态栏「保存失败：文档已被别处改动…」 | ✅ |
| sheets | `workbook:save` | ✅ 拒绝（抛「工作簿在打开后被磁盘上的改动覆盖——请改用另存为」） | ✅ | ✅ 错误 toast + 状态栏 | ✅ |
| slides | `slides:save`（vendor 直写） | ❌ **保存成功**（`{ok:true}`） | ❌ **外部内容被覆盖** | ❌ 显示「已保存」 | ✅ |
| pdf | `pdf:save` | ❌ 同上 | ❌ | ❌ | ✅ |
| markdown | `markdown:save` | ❌ 同上 | ❌ | ❌ 显示「已保存」 | ✅ |
| html | `html:save` | ❌ 同上 | ❌ | ❌ 显示「已保存」 | ✅ |

**结论：slides / pdf / markdown / html 会静默覆盖数据**（用户/Agent 同时改同一份文件 → 后保存的一方无声覆盖）。
源码出处见 `expectations.ts`；修好之后把 `expectConflict` 翻成 `true`，`--variant=expect-green` 就是回归门禁。

## 判据的证据源（不要合并）

- **4a** ← 主进程 IPC 回包（`ipc-recorder.ts` 包 `ipcMain.handle` + `_invokeHandlers`），与 DOM 无关；
- **4b** ← 磁盘 sha256，与回包、DOM 都无关；
- **4c** ← 页面**可见**元素（`getClientRects() > 0` 且文案匹配）。

三条在**同一个步骤**里各出一个 ok 标志（`4-conflict-criteria`）——不是拆成三步：
runner 遇 FAIL 立即结束旅程，拆开时 4a 一红后面就没证据了（变异 1 实测）。

## 变异（卡 §五）

```
MUTATION 1 strip-revision: CAUGHT   docs 4a/4b/4c 全红、负控与 sheets 4a 仍绿
MUTATION 2 hide-notice:    CAUGHT   docs/sheets 4a/4b 仍绿，**只有 4c 红**（卡点名最关键的一条）
MUTATION 3 negative-conflict: CAUGHT  docs/sheets 负控 #5 红
```

## 已知限制（如实）

1. **sheets 的编辑编排仍偶发不稳定**（保存后 vendor 重开工作簿 + Univer 重建 DOM 与键入竞争）。
   已修掉三个确定性根因：第二轮不能选 `A2`（夹具只有 1 行，惰性会话会夹回 `B1`）、
   「保存按钮 disabled」不足以证明工作簿已开（现在要求工作表标签 + 真实单元格引用）、
   画布点击会改选区且坐标随滚动漂移。提交版连跑 6 次、全量 3 次全绿；**历史上仍见到
   约 1/6~1/8 的偶发红**（`stage:"select"` / `"type"`）。若偶发红，证据会写清卡在哪一步
   与当时的选择框/状态栏 —— 先单跑复核，不要读成「冲突判据失效」。出货构建里
   `import.meta.env.DEV` 为假，`__univerAPI` 等 e2e 钩子不存在，不能绕开 DOM 直接调
   Univer API；要根治需另开卡。
2. **pdf 就绪等待受宿主 150s 进程超时约束**：给 40s + 一次 reload 45s，超了会明确报
   「没渲染出页面」而不是撞全局超时丢掉证据。
3. **4c 认的是各格式自己的失败反馈位**：docs/slides 状态栏+toast、sheets 状态栏+错误 toast、
   pdf `.tb-save-error`/`.pdf-toast-notice`、markdown/html `.status-save.status-failed`。
   vendor 改文案或改结构时这里要跟着改 —— 判据会红（不会静默假绿）。
4. **只验「保存被拒」这一条**：不验「用户重新打开后拿到外部内容」（那是另一个决定）。
