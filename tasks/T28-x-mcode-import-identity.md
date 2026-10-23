# T28｜经编辑器 Import 进画布的图丢失 `x-mcode` 身份，Mcode 节点包未声明 defaults

- Status: ready-for-agent
- Category: **bug（P0 功能不可用）**
- Priority: **P0**
- Depends on: T8（`d58a0b1e`，发现这个缺陷）
- Exclusive writable files: Mcode 节点包的定义文件（`workflowEngines/` 下 node pack 相关）、新建回归套件。**开工前先确认精确路径**，写进回写区。

## Required Skills
- `research`: 需要读 Node-RED 上游的 `_def.defaults` 导出规则，确认正确的声明方式。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T8-node-red-electron-u1.md`（缺陷 2 的原话）、`docs/planning/node-red-vendor-integration-map.md`、`apps/desktop/src/main/workflowEngines/` 下的 node pack 与 `nodeTypes.ts`。

## T8 实测出的缺陷（原话）

> **P0**：经编辑器 Import 进入画布的图**丢失全部 `x-mcode` 身份**（上游只导出 `_def.defaults`，Mcode 节点包未声明）——「用户在原生编辑器手工导入 Mcode 图」这条路径结构性不可用。

## 背景

Node-RED 的节点在 `runtime.nodes.registerType(name, { defaults: {...} })` 里声明哪些字段属于该节点。**导出/导入时只序列化 `defaults` 里声明过的字段。**

Mcode 的节点在 tab 上挂了 `x-mcode: { docId, ... }` 这种元数据，**但这些字段没有在节点包的 `defaults` 里声明**，所以：

- **导出**（用户点「导出」拿到 JSON）→ `x-mcode` 被丢掉
- **导入**（用户把这份 JSON 导回来）→ 图还在，但 Mcode 不知道它对应库里哪份文档

**后果**：「手工导入 Mcode 图」这条路走不通——导进去的图是「孤儿」，无法关联回库。

## 目标

让 `x-mcode` 在导出/导入往返中保留。

### 必须做的事

**第一步：确认现状。**

1. 找到 Mcode 的节点包定义（`registerType` 的调用点）
2. 看 `defaults` 里声明了什么
3. 确认 `x-mcode` 现在挂在哪（tab 节点？）

**第二步：理解 Node-RED 上游规则。**

读 `node-red/` 上游源码，确认：
- `defaults` 里怎么声明一个对象字段
- 导出时哪些字段会被保留
- 有没有「自定义字段」的官方机制（不要 hack）

**第三步：实施。**

在节点包的 `defaults` 里声明 `x-mcode`，让它在导出/导入中保留。

**注意**：`x-mcode` 是挂在 `tab` 节点上的，而 tab 类型由 Node-RED 上游定义。**要确认能不能给 tab 加 defaults**，不能的话需要别的方案。

**第四步：验证往返。**

```
建一个含 x-mcode 的图 → 导出 JSON → 确认 x-mcode 在
→ 清空画布 → 导入那份 JSON → 确认 x-mcode 还在 → 确认能关联回库文档
```

**第五步：变异验证。**

把 `defaults` 里的声明去掉 → 往返断言必须变红 → 逐字节还原（`cmp`）。

## 边界

- **不改** Node-RED 上游源码（`node-red/`）。
- **不改** `patches/`。
- **不改** T2/T3/T4/T21/T27 的文件。
- 若发现必须改上游才能做到，**停下报告**，说明为什么，另开方案。
- **不宣称 ARC-006 完成**。

## 验收判据

1. 回写区给出：Mcode 节点包的 `registerType` 位置、`defaults` 现状、`x-mcode` 挂在哪。
2. 导出 JSON 里**含** `x-mcode`。
3. 导入后**仍含** `x-mcode`，且能关联回原库文档。
4. 往返前后 `docId` 一致。
5. 变异验证：撤掉 `defaults` 声明 → 断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. 既有 Node-RED 相关套件不回归。

## 结果回写（2026-10-23）

（执行者在此追加：现状调查、上游规则、实现方案与取舍、往返证据、变异证据、提交 SHA、未覆盖项）
