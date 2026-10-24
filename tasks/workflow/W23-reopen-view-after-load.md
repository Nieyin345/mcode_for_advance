# W23｜U1 旅程装载后没重新打开视图 —— 它停在死端口上测部署

- Status: ready-for-agent
- Category: **测试环境保真度（不是产品缺陷）**
- Priority: **P1 —— 它让「部署」这条断言测的是一个连不上的页面**
- Depends on: W5（发现者）
- 来源：W5 的第五节

## 事实（W5 实测，根因链完整）

`production-load-entry` 调 `loadWorkflowIntoNative`，它会**停掉旧引擎、换端口重启**：

```
实测日志：ready 9029 → stopped → ready 8477
```

**而旅程的编辑器视图停在 9029（已关闭）。** 于是：

```
POST flows → xhr.status = 0, responseText = ""
  ↓
node-red/.../ui/deploy.js:684
  } else {
      RED.notify(RED._("deploy.deployFailed", { message: RED._("deploy.errors.noResponse") }), "error");
  }
  ↓
「部署失败: 服务器没有响应」
```

**产品路径没有这个问题**：`EngineRuntimePanel.tsx:197-303` 有那层 effect ——
`status.editorUrl` 变了就 `api.documentView.open` 重新导航。

**所以这是「测试环境的模拟不完整」，不是产品缺陷。** W5 没有改产品代码，是对的。

## 为什么这值得修

**因为「部署」这条断言现在测的是一个连不上的页面。**

W5 已经把 `baseline-deploy` 改成如实红，这是对的。**但一条永远红的断言，和一条永远绿的断言，问题是一样的** —— 都是「它不告诉你今天能不能部署」。

真机上用户点部署**是能成功的**（W2 已经证明了：`click-inject-button` 那步拿到
「部署成功」通知，`successCount: 2`）。**而 U1 套件里部署永远是红的。**

## 任务

### 一、在旅程里补上「装载后重新打开视图」

**照 `EngineRuntimePanel` 那层 effect 的行为做**（只读它，不改它）：

```
apps/desktop/src/renderer/components/settings/workflows/EngineRuntimePanel.tsx:197-303
  status.editorUrl 变了 → api.documentView.open({ docId, url, bounds, visible: true, ... })
```

**要求**：

1. 装载（`production-load-entry`）之后、点部署之前，**重新 open 一次视图**；
2. **新 URL 从哪来**：`workflowEngine.status()` 拿 `editorUrl`（W5 说生产就是这么做的）；
3. **不许硬编码端口** —— 端口是每次启动随机分配的；
4. 如果 `open` 失败，**明确报错**，不要静默继续（否则又变成「测一个连不上的页面」）。

### 二、改完之后 `baseline-deploy` 必须变绿

**这是本卡的验收判据，也是最容易搞错的地方。**

W5 的断言是「三层信号齐全」：

| 层 | 要求 |
|---|---|
| 网络 | `POST */flows` 2xx |
| 事件 | `deploy` 事件出现 |
| DOM | **没有新出现**的失败通知 |

**三层都要绿。** 如果改完之后只绿了一层（比如网络 200 但通知还是失败），
说明还有别的问题，**照实写进回写，不要为了让断言变绿去改断言**。

### 三、W5 留下的一个未解疑点

W5 报：

> P1 下 `library-mirror-reconciliation` 变红（`payloadHasMcodeTabs=true`），
> 加「重开视图」卡前需先弄清。

**先查清它。** 如果它是「装载 → 重开视图 → 再部署」这条新路径引入的新问题，
**在本卡里一起处理**，或者明确说清「它是独立问题，需要另一张卡」。

**不要绕过它。**

## 验收判据

1. **装载后视图真的重开了**（有断言：新 URL ≠ 旧 URL，且 `open` 返回 `ok: true`）；
2. **`baseline-deploy` 三层信号全绿**（网络 2xx + 事件 + 无新失败通知）；
3. **`library-mirror-reconciliation` 的疑点有结论**（解决 / 独立问题 / 为什么不是问题）；
4. **变异验证**：
   - 把「重新打开视图」那一步删掉 → `baseline-deploy` **必须回到红**，且红的原因和 W5 记录的一致（`status 0`）；
   - **这条变异是本卡的核心** —— 它证明「重开视图」真的是让部署成功的原因，不是巧合；
5. **W5 的其它断言不回归**（`rename-node-via-tray` 那条旧红不算）；
6. `tsc` EXIT=0；
7. **不跑全量**；
8. **不改 `apps/desktop/src/**`**。

## 边界

**可以改：**

- `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
- `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（只追加）
- `apps/desktop/scripts/t8-node-red-u1/` 下其它辅助文件

**不许碰：**

- `apps/desktop/scripts/t8-node-red-u1/run.mjs` / `build.mjs`（**W22 正在改**）
- `apps/desktop/src/**`
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 与 W22 的冲突**：W22 改 `run.mjs`，你改 `journeys/`。**不冲突，但如果它先交付，
你跑套件时会用到它改过的包装器 —— 那时候退出码可能不是 1 了，看清输出再判断。**

## 回写

`tasks/workflow/W23-reopen-view-after-load.md` 末尾追加 `## 结果回写`：

1. 重开视图怎么做的（贴关键代码）；
2. `baseline-deploy` 三层信号的实际值；
3. `library-mirror-reconciliation` 的结论；
4. **核心变异的实测**（删掉重开 → 红在哪、`status` 是多少）；
5. **你没能验证的东西**；
6. **W5 / 这张卡上写错的地方**。

## 一条判断标准

**「测试里永远红」和「测试里永远绿」是同一件事：它不再告诉你任何东西。**

W5 让这条断言从「永远绿」变成「永远红」，那是对的一步 —— **但它还不是终点**。
终点是：**真机能部署时它是绿的，真机不能部署时它是红的。**

## 总控补充（2026-10-24）：`library-mirror-reconciliation` 这个疑点，我先查了一半

W5 报「P1 下它变红（`payloadHasMcodeTabs=true`）」。我读了那条断言
（`journeys/node-red-canvas-load-edit-deploy-reopen.ts:443-458`），它的 `ok` 是四个条件的合取：

```ts
ok: ledger.pending.length === 0
  && ledger.lastError === undefined
  && (mirrorState?.pending ?? 0) === 0
  && owners.every((r) => r.owner === "node-red")
  && payloadHasMcodeTabs === false        // ← 这一项
```

`payloadHasMcodeTabs` = 「部署出去的 payload 里，tab 节点带不带 `x-mcode`」。
这一步自己的 `observed.note` 写着：

> 导入手势剥掉 `x-mcode`（上游编辑器只导出 `_def.defaults` 里的键），载荷因此没有
> Mcode 自有 tab —— 账本必须如实为空，库文档不被改写

**所以 W5 那个观察意味着「重开视图 → 部署成功后，payload 里反而带上了 `x-mcode`」。**

### 我的判断：**先别管它**

| 现象 | 属于 |
|---|---|
| `POST flows` 拿到 `status 0`（连死端口） | **本卡** |
| `payloadHasMcodeTabs=true` | **另一件事** —— 跟「视图开没开」无关，是**部署/导出手势**的问题 |

**做法**：先把「重开视图」做好、`POST flows` 拿到 200，**然后再看它红不红**。

- **变绿了** → 说明原来的红是「部署根本没发生」的副产物（payload 是从更早的装载里读的），
  **什么都不用做**；
- **还是红** → 那才是独立问题。**在回写里写清「它是独立问题」，不要在本卡修** ——
  修它要动导出手势，不在你的边界里。

**这条判断我没有实跑验证，是读代码推的。你按你的实测为准。**

---

## 总控补充（2026-10-24 23:30）：`workflow-ui-smoke` 现在红着，**不是你的**

**Office 主线在做 O5（OnlyOffice 全部删掉，走 GenOffice），分三批。**
批一已提交（`bd7c8cd5`，删了 `packages/contracts/src/ipc/onlyoffice.ts` -244 行），
批二/批三还在途 —— **所以 `FileEditor.tsx` 还在 import 已经删掉的契约导出。**
`workflow-ui-smoke` 要打包整个渲染端，因此**构建期就失败**。

**时间预期：2–4 小时**（Office 总控会主动通知批三完成）。

### 判别命令（我实测过，成立）

```bash
cd apps/desktop
node scripts/run-smokes.mjs workflow-ui-smoke > /tmp/o 2>&1; grep -c "isOnlyOffice\|onlyoffice" /tmp/o
```

- **> 0** → 是 Office 的（O5 在途），**别查了，别去做回滚对照**
- **= 0** → 是我们的，正常排查

**我实测：EXIT=1 且命中 2。**

> **⚠️ 取退出码时别用管道。** 官方给的原命令带 `|`，那会让 `$?` 变成 `grep` 的退出码
> （CLAUDE.md 第二十二条）。上面这版先重定向，安全。

**如果 `workflow-ui-smoke` 在你的必跑清单里：**照常跑，红了先用上面的命令判别，
在回写里注明「红在 O5 批一，已按判别命令确认」，**不要花时间做单文件回滚对照。**
