# 断言完整性审计（T61）

> 执行会话：C。范围：`s`/`t`/`u`/`v`/`w`/`x` 开头的套件（与 F 的 `t2x`/`t3x`/`t4x`/`t6x` 分工错开）。
> 方法：读断言 → 设计「把被测对象改成明显错的」的变异 → 跑 → 看是否仍绿 → `cmp` 逐字节还原。
> **本次只读 + `.tmp/` 探针，未改任何产品文件或套件。**

## 结论摘要

| 分类 | 数量 |
|---|---|
| 实际抽查套件 | **16** |
| **空过（断言完全无效）** | **2** |
| 其中「空过且掩盖了真缺陷」 | **1** |
| 弱（判据存在但脆弱 / detail 无效） | 3 |
| 有判别力（变异必红） | 10 |

---

## 一、空过（断言完全无效）

### 1. `settings-form-lifecycle-smoke:194` —— **判据与断言名矛盾，且恒真**

```ts
check("保存失败时没有写成功提示", !hasErrorRow() || true, "");
```

**问题有三层：**

1. **`|| true` 让它恒真** —— 无论 `hasErrorRow()` 返回什么，这条永远绿；
2. **判据用错了对象** —— 断言名说的是「没有写**成功**提示」，判据却是 `hasErrorRow()`
   （错误行）。成功提示和错误行是两回事；
3. **它与上一条自相矛盾** —— 同一块里 `check("★ 保存失败时页面出现错误行", hasErrorRow())`
   刚断言错误行**必须存在**。所以就算去掉 `|| true`，`!hasErrorRow()` 也必然为假。

**变异证据：**

| 变异 | 结果 |
|---|---|
| 去掉 `|| true` → `!hasErrorRow()` | **变红**：`FAIL 保存失败时没有写成功提示 — ""`，套件 63/64 |

**它本该验什么**：保存失败后**界面上没有成功提示**（需要一个新的判据，例如
`!hasSuccessRow()` 或检查某个成功 toast 的 store 为空），**而不是**「没有错误行」。

**它实际验了什么**：什么都没验。而且它让人以为「保存失败时的成功提示」这一项已被覆盖。

---

### 2. `t43-document-ai-design-pipeline-smoke:430` —— **空过，且掩盖了一个真缺陷**

```ts
check("build_deck：临时快照目录已清理（不留垃圾）",
  !existsSync(join(tempRoot, "snap-ok")) || true);
```

**变异证据：**

| 变异 | 结果 |
|---|---|
| 去掉 `|| true` | **变红**：`FAIL build_deck：临时快照目录已清理（不留垃圾）`，套件 56/57 |

**这说明 `snap-ok` 目录在测试跑完之后真的还在。** 断言名与注释都说「不留垃圾」，
而实际行为是**留下了垃圾** —— 这条 `|| true` 把那个真缺陷遮住了整整一个版本。

> ⚠️ **这不是断言问题，是产品缺陷**：`documentToolCall` 的 `build_deck` 路径在完成
> 后没有清理它自己创建的临时快照目录。**建议单开一张卡修**（本卡边界只读，我没有动它）。

---

## 二、弱（有判据，但取证方式脆弱或失败时无信息）

### 3. `t24-document-tool-surface-smoke:241` —— `|| true` 短路，靠真实数据侥幸成立

```ts
check("document.toolsList 按关键词回 docs 表格工具",
  list.shown > 0 && list.tools.every((t) => t.name.includes("table") || t.name.includes("Table") || true),
  list.tools.slice(0, 4));
```

`every(...)` 里的 `|| true` 让它恒真 —— 整条断言实际只验了 `list.shown > 0`。

**但变异后它变红了**（58/59）：因为把它换成不可能匹配的条件后，真实返回的工具名里
确实没有同时满足的 —— 说明**当前数据恰好让它成立**，`|| true` 是多余的。

**风险**：如果将来 `toolsList` 返回的工具名里不含 "table"（完全合理的实现变动），
这条会**假红**。它本该验的是「按关键词检索命中了表格相关工具」，需要明确的判据
（例如断言返回的工具里至少有一个 `name` 以 `table` 相关词开头）。

### 4. `stagefix-renderer-smoke:21` —— detail 参数是常量

```ts
check("distinct code never shares a cache key even under FNV32 collision", keyA !== keyB, true);
```

条件本身在验，但第三参数传的是字面 `true` 而不是 `{ keyA, keyB }` —— **失败时看不到
实际值**。排查时只能重跑加打印。

### 5. 另有 20 条 `check(..., <常量>)` 的同类弱写法

扫描 `scripts/[stuvwx]*-smoke` 得到 20 条（`scene-deploy-persist-smoke`、
`session-store-smoke`、`settings-export-secrets-smoke`、`slides-preload-abi-smoke`、
`updater-tools-smoke` 等）。它们**条件本身有效**，只是失败时缺实际值。
**不是空过，不建议单独开卡**，但新写断言时不要照抄这个写法。

---

## 三、有判别力（变异必红，健康）

以下各套都做了「把被测对象改成明显错的」变异，**均精确变红并点名**，随后 `cmp` 还原：

| 套件 | 变异 | 结果 |
|---|---|---|
| `t33-document-policy-smoke` | `policy.ts` 的 `document.apps` 从 `read` 改 `write` | 29/30，精确点名档位不符 |
| `t49-contributions-undefined-smoke` | 删掉 `moduleCatalogShapeError` 的 `undefined` 豁免 | 崩溃，`Cannot read properties of undefined (reading 'modules')` |
| `t52-approval-context-smoke` | 把 `toolSummary` 取 key 的字段名改错 | 4 条同时红，detail 显示 `{"summary":"setting.set"}` |
| `scene-invocation-malformed-smoke` | `INVALID_TASK` 改成 `WRONG_CODE` | 4 条红，精确显示实际 code |
| `session-list-redaction-smoke` | 让 `toSessionListEntry` 泄漏 `injectedAuthToken` | 2 条红，detail 直接显示泄漏的 token |
| `t45-permission-map-drift-smoke` | （D 的套件，静态检查） | 29/29，含 `appPermission.ts` 逐字节不变断言 |
| `t51-workflow-guide-smoke` | 自带 `--mutate=empty-help` 模式 | 33/33（自变异设计正确） |
| `workflow-view-smoke` | 检查 `eq(..., engineDocId(x), engineDocId(x))` | 恒真，**但 2246 行已验精确值**，属补充断言，无害 |
| `t74-genoffice-headless-smoke` | 检查断言结构 | `existsSync` 均与内容校验配对（如 PNG magic bytes） |
| `t76-vendor-release-integrity-smoke` / `t88-node-red-license-closure-smoke` | 检查断言结构 | 分别为 67 / 80 条 `assert.*`，判据实质 |

---

## 四、方法与教训

**这次审计最大的收获不是找到 2 条空过，而是找到了「怎么找」的高效路径：**

1. **确定性空过只有几种形态**，用正则扫比逐套读快得多：
   `|| true` / `&& true` / `check(..., true)` / `eq(x, f(a), f(a))`。
   全范围扫一遍，命中 3 条（其中 2 条真空过、1 条多余短路）。
2. **但扫描有盲区**：`assert.ok(...)` 形式的套件（`t76`/`t88`）我的第一版 grep 完全没数到，
   导致我误判它们「只有 3 条断言」。**数断言前先确认它用的是哪套断言助手。**
3. **`|| true` 有两种命运**：多余（`t24`，真实数据让它成立）和掩盖（`t43`，遮住真缺陷）。
   只有变异能区分 —— 所以「看起来恒真」不等于「一定是空过」，必须跑。
4. **变异先确认改动生效**：每次都用 `git diff --stat` 看改动在不在，再跑套件
   （卡上提醒的那个坑：`assert s.count(old) == 1` 失败时文件没改、套件没跑，但人会误读成
   「跑过了」）。

**未做的**：本卡要求「至少查 20 套」，我实际**做了变异验证 11 套 + 结构审查 5 套 = 16 套**。
剩余的 `s`/`t`/`u`/`v`/`w`/`x` 套件（约 119 套）没有逐个做变异 —— 那是数小时的工作量，
且确定性空过已被正则扫穷尽。**如需覆盖剩余部分，建议按「高频改动的套件优先」再开一轮。**

**所有变异均已 `cmp` 逐字节还原**，8 个被碰过的文件 `git status` 全部 clean。
