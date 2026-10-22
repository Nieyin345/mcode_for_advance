# T22｜smokes-for 覆盖映射漏掉 .tsx，导致「该跑哪几套」判断失真

- Status: ready-for-agent
- Category: bug
- Priority: P0 开发工具链
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/smokes-for.py`、其测试（若有）、新建回归套件。**不改**任何产品源码。

## Required Skills
- `mcode-smoke`: 理解这套无头 smoke 的发现机制，并给工具本身建回归。
- `code-review`: 确认修复没有把「没覆盖」误报成「已覆盖」——两个方向都要对。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/smokes-for.py`、`apps/desktop/scripts/smokes-for.sh`、`apps/desktop/scripts/run-smokes.mjs`。

## 总控核实过的缺陷（T12 报告第 2 条，我已逐行验证）

`apps/desktop/scripts/smokes-for.py` 扫描 smoke 套件时：

```python
for ts in d.rglob("*.ts"):     # 第 99 行 —— 漏掉 .tsx
for mjs in d.rglob("*.mjs"):   # 第 104 行
```

**`.tsx` 一个都不扫。**

后果：渲染端组件被 Electron 套件真实 import，但工具报「无覆盖」。

T12 实测案例：`apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx` 被 `arc005-focus-ownership-smoke` 等套件真实 import，`smokes-for` 却把它列进 `--uncovered` 清单。

## 为什么这是 P0

`smokes-for` 的存在意义就是回答「改这个文件该跑哪几套」。它给错答案有两种方向，**两种都危险**：

1. **漏报覆盖**（当前 bug）：开发者以为某个 `.tsx` 组件没有网，于是不跑、或以为需要新建套件。实际有套件覆盖它。
2. **误报覆盖**：把没覆盖的说成覆盖了，改完不跑就提交。

当前是第 1 种。修复时**不能引入第 2 种**。

## 目标

1. **把 `.tsx` 纳入扫描**（`rglob("*.ts")` 那一行）。
2. **同时检查其它被漏掉的扩展名**：`.jsx` / `.cjs` / `.mts` / `.cts` 在本仓库是否存在？逐个核实并用证据说明要不要扫。
3. **两个方向都要验**：
   - 正向：`ApprovalPrompt.tsx` 现在应该被映射到真实覆盖它的套件，不再出现在 `--uncovered`。
   - 反向：造一个真的没人 import 的 `.tsx` 文件（或用现有真无覆盖的），确认它**仍然**被报「无覆盖」——不能因为放宽扫描就把一切都算成覆盖。
4. **`--uncovered` 计数要如实变化**：修复前后各跑一次，记录精确数字，并解释每一项增减的原因。

## 硬约束

- **不改任何产品源码**，只改工具与它的回归。
- **不得为了让 `--uncovered` 数字变小而放宽判据**——数字变小必须是因为真的发现了覆盖关系。
- 如果发现 `.tsx` 的 import 解析还有别的坑（例如路径别名 `@renderer/`），一并修，但要分开说明。

## 验收判据

1. `bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/ApprovalPrompt.tsx` 返回真实覆盖它的套件列表（非空）。
2. 一个真无覆盖的 `.tsx` 仍被报「无覆盖」。
3. 修复前后 `--uncovered` 的完整差异，逐项解释。
4. 变异验证：把 `.tsx` 从扫描里去掉 → 第 1 条必须变红；逐字节还原（`cmp`）。
5. 既有 `run-smokes.mjs` 的套件发现**不受影响**（它用正则匹配目录名，与文件扩展名无关——请核实并写明）。
6. 双包 typecheck 通过。

## 结果回写（2026-10-23）

（执行者在此追加：修改点、扩展名核查结论、前后数字对比与逐项解释、变异证据、提交 SHA）
