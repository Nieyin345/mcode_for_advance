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
