# T57｜PPTX 无修改保存不该改写文件字节

| 项目 | 值 |
|---|---|
| 编号 | T57 |
| 类型 | **数据安全**（T53 发现的产品缺陷） |
| 优先级 | **高** —— 用户打开看一下就关，文件也会被改写 |
| 建议并发 | 改 `src/main/document/slidesExecutor.ts`；**与 T50 的 contracts 不冲突** |
| 预计规模 | 小 |

---

## 前置条件（不满足就不要开工）

- **T53 已完成**：`genoffice-native-view-smoke` 的 `real.ts` 里已经有一条
  **必红断言**记录这个缺陷 —— 修好之后它会自动转绿。
- **`packages/contracts/src/modules.ts` 可能仍有未提交改动**（T50 在飞）。
  开工前先 `git status --short packages/contracts/`：
  - 干净 → 正常开工
  - 不干净 → **先确认那是不是 T50 的活**，不要动它；本卡不需要改 contracts

---

## 缺陷（T53 实测）

```
openDeck → saveDeck（无任何编辑）
原始 SHA256 ≠ 保存后 SHA256
```

**用户打开一个 pptx 看一眼就关掉，文件也会被完全重新序列化。**

对比 XLSX：它打开→读取→关闭**根本不写盘**，字节保持完美。

---

## 根因（实读 `slidesExecutor.ts:249-300`）

`saveDeck` 的现有流程：

```ts
return await withOsFileLease(filePath, async (real) => {
  // 1. 版本检查（CAS）
  if (await fileContentVersion(real) !== session.revision) return { reason: "VERSION_CONFLICT" };

  // 2. 建 staging 目录
  const stageDir = await mkdtemp(join(dirname(real), ".mcode-slides-stage-"));

  // 3. 让 vendor 序列化到 staging
  await this.engine.savePptxToFile(session.opened, stage);

  // 4. 再查一次版本（防止期间被别的进程改）

  // 5. fsync + rename 发布
```

**问题在第 3 步：它无条件调用 `savePptxToFile`，哪怕 `session.opened` 一个字节都没变。**

`pptx-engine` 的 `savePptxToFile` 会重新序列化整个 ZIP：
- 重新计算压缩
- 重排 entry
- 可能丢掉原始文件里的未知 part 顺序

**所以即使内容没变，字节也一定不同。**

---

## 修法

### 核心思路：没有编辑就不要保存

**先确认 `session` 里有没有「未保存的编辑」。**

`slidesExecutor` 已经有 `session.editEpoch`（保存时用来判断「保存期间有没有新编辑」）。
再看它是怎么被递增的。

**如果 `editEpoch` 只在真正编辑时递增** → 直接用它：

```ts
// 在 saveDeck 开头
if (session.opened && session.editEpoch === session.savedEpoch) {
  return { bytes: session.savedBytes ?? 0 };  // 没编辑，直接返回成功，不写盘
}
```

**如果 `editEpoch` 不能区分** → 加一个 `dirty` 标志，在 `addBlankSlide` / `editText`
等编辑入口置位。

### 具体步骤

1. **读 `slidesExecutor.ts` 全文**，找出：
   - `session.editEpoch` 在哪些地方递增
   - 有没有现成的 `dirty` / `modified` 标志
   - `session.opened` 是什么形状

2. **加「无编辑跳过」分支**，放在 `withOsFileLease` **内部**（要持有锁才能判断）：

```ts
return await withOsFileLease(filePath, async (real) => {
  // 版本检查照旧
  if (await fileContentVersion(real) !== session.revision) { ... }

  // ★ 新增：没有编辑就不写
  if (!sessionHasUnsavedEdits(session)) {
    return { bytes: original.size };   // 或已有的成功形状
  }

  // 原来的 staging + save + rename 流程
});
```

3. **`sessionHasUnsavedEdits` 的判据**：
   - 有 `editEpoch` 且能对比 → 用它
   - 没有 → 在编辑入口（`addBlankSlide` / `editText` / 未来的其它）置 `dirty = true`，
     保存成功后清零

### 注意：`saveAs` / 另存为不受影响

另存为**必须**写盘（目标文件还不存在）。只有「保存到原路径」才该跳过。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/document/slidesExecutor.ts` **全文** ——
   尤其 `session.editEpoch` 的所有读写点、`addBlankSlide` / `editText`。
3. `apps/desktop/scripts/genoffice-native-view-smoke/real.ts` ——
   **那条必红断言在哪**，修好后它会变绿。
4. `apps/desktop/src/main/document/slidesBridge.ts` —— 接口定义。
5. `genoffice/packages/pptx-engine/src/index.ts` 的 `savePptxToFile` ——
   确认它确实无条件重序列化。

---

## 边界（不要碰）

- **不改 `genoffice/` 上游的 `savePptxToFile`** —— 它的重序列化是对的，
  问题在「不该调用它」。
- 不改 `packages/contracts/`（T50 在飞）。
- 不改 `documentViewHost.ts`。
- 不改 xlsx 路径（它已经是对的）。
- **不改** `real.ts` 里那条必红断言 —— 修好产品后它自动转绿，这才是证据。

---

## 验收判据

1. **PPTX 打开 → 不改 → 保存 → 字节完全不变**（SHA256 相同）。
2. PPTX 加一页 → 保存 → 重开可见（T53 已验，不能回归）。
3. PPTX 改文字 → 保存 → 重开能读到新文字。
4. PPTX 另存为 → 目标文件被写出（不受「无编辑跳过」影响）。
5. `genoffice-native-view-smoke` **21/21 全绿**（含 T53 那条原本必红的断言）。
6. 现有 `document-view-*` 五套 / `arc005-pane-*` 七套全绿。
7. 双包 tsc 干净（若被 T50 的 contracts 阻断，在回写区写明）。
8. **变异验证**：撤掉「无编辑跳过」分支 → 判据 1 红。

---

## 回写区要回答

- `session.editEpoch` 是在哪里递增的？能不能直接用来判「有没有编辑」？
- 如果没有现成的 dirty 标志，你在哪几个入口加了置位？
- `savePptxToFile` 对**相同内容**重序列化后的字节差异有多大？
  （是不是只有元数据/压缩参数变了，内容 part 其实一样？）
- 如果内容没变但也不跳过，能不能改成「比较 staging 与原始，
  相同就不 rename」？为什么不选这条路？
- 另存为路径有没有受影响？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

## 2026-10-21 执行与验收回写

- **修改范围**：`apps/desktop/src/main/document/slidesExecutor.ts`；仅同步强化三处相关回归护栏：`scripts/slides-executor-session-epoch-smoke/main.ts`、`scripts/slides-save-add-race-smoke/main.ts`、`scripts/document-view-open-smoke/probe.ts`。未改 `genoffice/`、`packages/contracts/`、`documentViewHost.ts`、XLSX 路径或 T53 的 `real.ts` 断言。
- **根因与判据**：`editEpoch` 仅在 `addBlankSlide`（输入校验后、vendor transaction 前）和 `editText`（vendor transaction 前）递增，可保守表示“可能有未保存编辑”（事务后来拒绝仍保持保守状态，不把部分更改误判为干净）。新增 `savedEpoch`：正常文件打开时为 `0`、每次成功写盘并 `commitSaved` 后更新为当前 `editEpoch`；零字节源文件初始化为 `-1`，保证第一次保存一定物化空白文档。无需给两个编辑入口重复添加 `dirty` 标志。
- **锁与冲突**：`saveDeck` 在原有 `withOsFileLease` 内、`lstat` 合法性及原路径 SHA256 CAS 检查之后才判断 `editEpoch === savedEpoch`；未修改直接返回现存字节数，不创建 staging、不调用 vendor serializer、不 rename。外部修改仍返回 VERSION_CONFLICT；失败或 `commitSaved` 异常仍按原有路径 fail-closed/标记 session tainted。
- **重序列化定量证据（E1）**：用真实 `createBlankPptx → openPptx → savePptxToFile` 在隔离临时目录重现：原件 **5630 B**，重序列化后 **5806 B（+176 B）**，SHA256 不同；两份 ZIP 均有 **11 个非目录 part**，文件名集合一致，逐个解压比较 **11/11 part 字节相同**。差异在 ZIP 容器层（重压缩/头部或布局），不是该样例的 OOXML 内容变化。
- **为何不选 staging 对比后不 rename**：仅比较两个 ZIP 整体 SHA256 仍会因上述 176 B 差异而误判，不能实现无修改字节保持；改为逐个解压比对 part 又增加一次完整序列化、IO/CPU/磁盘暂存与复杂度。保存前直接用宿主维护的会话编辑代数判据，既免重序列化，也保留全部编辑写盘路径。
- **另存为**：仅 `saveDeck` 的“保存回打开原路径”走短路，`savePptxToFile` 原厂写盘接口不变；隔离测试中调用 vendor 写入不同目标 `saved-as.pptx`，文件存在且大小 **5806 B**（E1）。Mcode 此执行器自身没有另存为 API，未扩展接口。
- **原始红例（E1）**：修复前 `node apps/desktop/scripts/run-smokes.mjs genoffice-native-view-smoke`：`PPTX open/no-edit/save is byte-identical` 红、**20/21**。
- **修复后回归（E1）**：同一套 `genoffice-native-view-smoke` 的原始不可修改断言转绿，真实原厂文件测试 **21/21**；`document-view-electron/host/open/renderer/vendor-page-smoke` 五套 + `arc005-pane-dock-keys/docking/electron/first-paint/free-grid/layout-edges/write-race-smoke` 七套，合计 13 套 **13/13 PASS**。额外 `slides-executor-session-epoch-smoke`、`slides-save-add-race-smoke` **2/2 PASS**（相关假执行器现在先做真实意义上的编辑，避免无编辑保存进入不应进入的竞态测试）。`document-view-open-smoke` 现以**不同于原文的新文字**编辑、保存，再通过新视图/新会话确认新文字保留；对应套件 PASS。另补“首次无编辑不调用 serializer／编辑后保存／重复保存不调用 serializer／零字节首存物化”的断言，PASS。
- **变异验证（E1）**：临时将 `if (session.editEpoch === session.savedEpoch)` 条件禁用，重跑未修改的 T53 真实测试，唯一旧红例再次失败、**20/21**；随后按二进制备份恢复，源文件 SHA256 恢复校验通过（`4F1662BFC01FEB6AA99809FE1C265CD88415D7F9D5ED0D2CCBB046F0E7596456`）。
- **类型检查**：`pnpm typecheck`（双包），结果以本次执行终态记录为准。
- **remaining**：本卡所有功能验收以隔离 E1 / 源码 E2 为证；未把这些冒充手工 U1/独立复核。
