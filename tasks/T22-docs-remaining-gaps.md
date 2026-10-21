# T22｜补完 T05b 的三处遗留（exportPdf / lazy-media / files:read）

| 项目 | 值 |
|---|---|
| 编号 | T22 |
| 类型 | ARC-007（T05b 遗留） |
| 优先级 | **高** —— T05c 的 AI 面板依赖它 |
| 建议并发 | 不要与 T05c 同时派（同改 `genoffice/` 与 `document/`） |
| 预计规模 | 中 |

---

## 为什么必须先做

T05b 的回写里自己列了三处未达成（我核对过，属实）：

1. **图片整条导出链缺 `exportPdf`**：`take-export-pdf` / `write-export-image` 已接线，
   但它们依赖的 `exportPdf`（PDF → 图片拆页的入口）还在 preload 未迁。
2. **`save-image-as` 只处理已内嵌 `data:image`**：原厂的 lazy-media / 网络源被明确拒绝。
3. **`files:read` 不在 T05b 的服务范围**：原厂附件文本读取仍未迁。

**T05c 的 AI 面板需要读文档上下文**（选区文本、附件、当前页内容），
`files:read` 与 lazy-media 正是它的输入来源。不补这三处，T05c 做出来会是半残的。

---

## 开工前必读

1. `tasks/T05b-docs-privileged-operations.md` 的**回写区**，特别是「明确未达成」那段。
2. `docs/planning/arc007-genoffice-native-integration-map.md` 的 T05b 表。
3. `apps/desktop/src/main/document/docsVendorIpc.ts` 与
   `genoffice/apps/docs/src/main/mcode-ipc.ts`（T05a/T05b 扩展后的版本）。
4. `genoffice/apps/docs/src/main/docs-main.ts` 里 `exportPdf` 与 lazy-media 的实现。
5. T05b 的 `mcode:docs:privileged-*` 通道设计 —— **新通道照同一套**（sender 验证 +
   `findContainingWorkspaceRoot` 围栏 + fail-closed）。

---

## 执行内容

### 1. `exportPdf`

- 它是 PDF → 图片拆页的入口。阅读原厂实现，判断它是纯本地渲染还是依赖外部工具。
- 迁移时：**输出路径**必须过 Mcode 的围栏；**临时文件**必须落在 Mcode 数据根下。
- 接上 `take-export-pdf` / `write-export-image` 后，**整条导出链要能端到端跑通**
  （不是只验证单个 handler）。

### 2. lazy-media / 网络源

- 原厂会从网络或懒加载源拉图片。**默认拒绝**是对的（不能让它任意联网）。
- 正确做法：
  - **本地文件源**：走围栏后放行（用户选的图、文档内嵌的图）。
  - **`data:` / `blob:`**：直接放行（已在内存里）。
  - **`http(s)` 网络源**：**默认拒绝**，但给出可读原因；如果用户显式批准，
    走 Mcode 的受控下载（已有 `api.fetch` 之类的通路就复用）。
- 判据：不允许 GenOffice 自己发网络请求。

### 3. `files:read`

- 原厂读附件文本。迁的时候：路径围栏 + 大小上限 + 文本编码安全
  （仓库已有 `safeErrorMessage`、`readBudget` 之类的现成件，复用）。
- 读出来的内容要给 T05c 的 AI 面板用，所以**返回形状要稳定**。

---

## 边界（不要碰）

- 不要碰 T05b 已经接好的 10 条路由（只补它们依赖的东西）。
- 不要碰 `ai:*`（那是 T05c）。
- 不要碰 sheets / slides / pdf / markdown / html 五个 app。
- 不要碰 `genoffice/ee/`。
- 所有 `genoffice/` 改动同步产出 patch 到 `patches/genoffice/`。

---

## 验收判据

1. `exportPdf` 迁移完成，**整条导出链端到端跑通**（有真 Electron 断言：
   打开文档 → 导出 → 检查产物字节）。
2. lazy-media 三类源各有断言：本地放行、`data:` 放行、`http(s)` 拒绝且有可读原因。
3. `files:read` 有围栏与大小上限断言。
4. 现有 `document-view-*` 五套 + T05a/T05b 的回归全绿。
5. 三包 tsc（desktop / contracts / genoffice docs）干净。
6. **变异验证**：撤掉 `exportPdf` 的围栏 → 越界断言红；撤掉 `http(s)` 拒绝 →
   网络断言红。

---

## 回写区要回答

- `exportPdf` 是纯本地还是依赖外部工具？
- lazy-media 的 `http(s)` 拒绝后，用户能不能手动放行？怎么放行？
- `files:read` 返回什么形状？T05c 能直接用吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
