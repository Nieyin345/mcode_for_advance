# T05b｜GenOffice Docs 迁移（二）：需要权限的操作

| 项目 | 值 |
|---|---|
| 编号 | T05b |
| 类型 | ARC-007 |
| 优先级 | 中高 |
| 建议并发 | 等 T05a 完成后再开（同一批文件） |
| 预计规模 | 中（10 个 handler，但每个都要审批链） |

---

## 本卡范围：10 个需要新权限的 handler

全部是原生 OS 交互或文件写入，**每个都必须默认拒绝 + 用户显式批准**：

| handler | 风险 | 判据 |
|---|---|---|
| `docs:pick-image` | 读任意图片 | 走 Mcode 的文件选择（已有 `api.pickFiles`），不新开对话框 |
| `docs:save-image-as` | **写任意路径** | 默认拒绝；必须走 Mcode 的保存对话框与路径围栏 |
| `docs:pick-export-images-target` | **选写入目录** | 同上 |
| `docs:take-export-pdf` | **写 PDF** | 同上 |
| `docs:printers` | 枚举打印机 | 只读；但要确认不泄漏用户环境信息到日志 |
| `docs:print` | **触发打印** | 每次都要用户确认；不能静默打印 |
| `files:pick` | 读任意文件 | 复用 `api.pickFiles` |
| `files:add` | 加入文档资源 | 路径围栏 |
| `files:read-image` | 读图片字节 | 限工作区内 |

---

## 开工前必读

1. T05a 的任务文件与它的回写区 —— 你会复用同一套边界层。
2. `apps/desktop/src/main/document/docsVendorIpc.ts` —— T05a 扩展后的版本。
3. Mcode 现有的**审批链**：`ModuleHost` 的逐次审批、`appControl` 的
   `app_api_call` 授权。**不要新造一套审批**。
4. `apps/desktop/src/main/document/documentViewCredentialBroker.ts` ——
   已有的凭据中间层，看它怎么把"权限"表达成短期令牌。

---

## 核心原则

**这 10 个 handler 一个都不能「迁移完就放行」。** 正确形态是：

```
GenOffice 页面发起请求
  → mcode-ipc.ts 收到
    → 检查 Mcode 是否已有等价能力（api.pickFiles / 保存对话框 / 路径围栏）
      → 有：转调 Mcode 的，不自己实现
      → 没有：默认拒绝，并返回可读原因
    → 需要用户确认的：走既有审批 UI，**不要新开一个**
```

### 三个必须守住的不变量

1. **不新开 OS 对话框**：所有文件选择走 `api.pickFiles`（已有），
   否则用户会看到两个不同的选择器。
2. **写入必须过围栏**：`save-image-as` / `take-export-pdf` 的目标路径
   必须过 Mcode 的 `pathGuard`，不能直接 `fs.writeFile`。
3. **打印必须显式**：`docs:print` 每次都要确认，不能因为"用户刚才点过"就跳过。

---

## 边界（不要碰）

- 不要碰 T05a 已迁移的 6 组 handler。
- 不要碰 `genoffice/ee/`、其它五个 app、Mcode renderer。
- 不要新造审批机制。
- 所有 `genoffice/` 改动同步产出 patch。

---

## 验收判据

1. 10 个 handler **逐个**有迁移状态与验证方式。
2. 每个「需要权限」的 handler 都有**拒绝路径**断言：
   未授权时收到可读原因，且**没有实际文件被读写**。
3. `save-image-as` / `take-export-pdf` 的路径围栏有断言（越界路径必拒）。
4. 打印有「未确认则不打印」断言。
5. 现有 `document-view-*` 四套 + T05a 新增的 smoke 全绿。
6. 双包 tsc + GenOffice Docs tsc 全绿。
7. **变异验证**：撤掉围栏 → 越界断言必红；撤掉打印确认 → 断言必红。

---

## 你要在回写区回答的问题

- 10 个里哪些是「转调 Mcode 已有能力」、哪些是「新写」？
- 有没有出现两个文件选择器/两套权限判据？
- 打印的确认 UI 用的是哪一个？复用还是新开？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
