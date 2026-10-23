# T29｜`documentView:close` 对四个编辑器永远拒绝 —— 用户关不掉标签

- Status: ready-for-agent
- Category: **bug（P1，产品缺陷）**
- Priority: P1
- Depends on: T7（`77fdd012`，发现）、T23（`239eb863`，preload 构建）
- Exclusive writable files: `genoffice/apps/*/src/preload/`（或 Mcode 侧 preload）、`apps/desktop/src/main/document/documentViewHost.ts` 的关闭路径、新建回归套件。逐个确认后写进回写区。

## Required Skills
- `research`: 确认 Node-RED... 不，确认 GenOffice 上游四个 app 的 preload 结构，判断该怎么补。
- `mcode-smoke`: 建回归并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T7-genoffice-native-editors-u1.md` 的缺陷段、`apps/desktop/src/main/document/documentViewHost.ts`、`patches/genoffice/` 下与 preload 相关的补丁（尤其 0010）、`genoffice/apps/pdf/src/preload/`、`genoffice/apps/markdown/src/preload/`、`genoffice/apps/html/src/preload/`、`genoffice/apps/sheets/src/preload/`。

## T7 实测出的缺陷（原话）

> **P1，产品缺陷，建议单开卡**：`documentView:close` 对 pdf/markdown/html/sheets 永远拒绝
> —— 宿主发 `mcode:document-view:close-check`，但只有 Docs 的 preload 监听它；四家 vendor preload 零命中。
> 实测：各自返回 …

## 症状

用户打开 PDF / Markdown / HTML / Sheets，想关闭标签时**关不掉**。宿主发 `close-check` 等回应，2 秒超时后拒绝关闭。

T7 的旅程里绕过了这个：先断言拒绝行为，再用 `host.close` 强制关闭。**但真实用户没有这个后门。**

## 必须先查清的事

**这四个 app 的 preload 是谁的？**

- Docs 用的是 **Mcode 自己的 preload**（`documentViewPreload.ts`，T23 确保它进生产构建）
- pdf/markdown/html/sheets 用的是 **vendor 主进程提供的 preload**（`genoffice/apps/<app>/src/preload/index.ts`）

**关键判断**：这四个 app 的关闭语义是什么？

- PDF 的「关闭」是关页面还是关文档？
- Sheets 有未保存状态要检查吗？
- 它们有没有 `beforeunload` 或等价机制？

**先读源码搞清楚，再决定是补 preload 还是改宿主侧逻辑。**

## 两种可能的修法

**(A) 补四个 vendor preload** —— 让它们监听 `mcode:document-view:close-check` 并回应。
- 优点：语义一致
- 缺点：要改四个上游 app 的 preload（走 `patches/`），每个都可能有自己的关闭语义

**(B) 宿主侧不向这四家发 close-check** —— 因为它们本来就没有「关闭前确认」的概念。
- 优点：不改上游
- 缺点：如果它们确实有未保存状态，就绕过了检查

**选一个并论证。** 若选 A，走 `patches/` 追加补丁；若选 B，说明为什么这四家不需要关闭确认。

## 验收判据

1. 回写区给出：四个 app 各自的关闭语义（读源码得到，不是猜）。
2. 明确修法（A 或 B）与论证。
3. **用户能关闭** pdf/markdown/html/sheets 的标签（真 Electron 验证，复用 `apps/desktop/scripts/electron-u1/` 或 `t7-genoffice-u1/` 的骨架）。
4. 若有未保存状态，关闭前**确实**有确认（不静默丢改动）。
5. 变异验证：撤掉修复 → 关闭断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. T7 的六编辑器 U1 套件**不回归**。

## 边界

- 若走 A：**只加补丁，不改 `genoffice/` 源码直接编辑**（走 `patches/genoffice/`）。
- **不改** `documentViewPreload.ts`（T23 刚确保它进构建）。
- **不改** T2/T3/T4/T27/T28 的工作流文件。
- **不宣称 ARC-007 完成**。

## 结果回写（2026-10-23）

（执行者在此追加：四个 app 的关闭语义、修法与论证、真 Electron 验证证据、变异证据、提交 SHA）
