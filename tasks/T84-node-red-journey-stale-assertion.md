# T84｜一条会掩盖回归的 journey 断言：它查的字符串已经不存在了

- Status: ready-for-agent
- Category: **测试有效性（真缺口，D 在 T81 发现）**
- Priority: **P1** —— 它会让「装载入口坏回原样」这条回归静默通过
- Depends on: T81（`5d2d01f9`）、T27（已修）
- Exclusive writable files: `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`

## Required Skills
- `mcode-smoke`：变异验证。

## 背景：D 在 T81 里发现的

`apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts:158-163`：

```ts
// 生产 T59 装载入口的**真实行为**：对任何有节点的可保存图都拒绝（见 editor-flow 头）。
// 这里把它作为**事实**落证据；两种结局都接受，但必须说清是哪一种。
const result = await rt.harness.loadWorkflow(FIXTURE_WORKFLOW_ID, true);
const knownRefusal = result.ok === false && typeof result.reason === "string" && result.reason.includes("无法无损装载");
const succeeded = result.ok === true;
```

**但那个字符串已经不存在了**：

```bash
$ grep -rn "无法无损装载" apps/desktop/src/main/
（零命中）
```

**T27 已经修了「对任何有节点的可保存图都拒绝」这个行为。**

### 后果

`knownRefusal` **恒为 false**（那个字符串永远不会出现在 `reason` 里）。

所以这步现在只有两种可能：

- `result.ok === true` → `succeeded` 分支；
- `result.ok === false` → **两个分支都不成立**，进入「说清是哪一种」的错误处理。

**如果装载入口坏回 T27 之前的样子**（对可保存图全部拒绝），`result.ok === false`，`knownRefusal` 仍然是 false —— **这步会走到「两种都不是」的分支**。

**那一步会不会红，取决于那个分支怎么写的。** 你要去确认。

### 更严重的一种可能

**如果那步的写法是「两种结局都接受」，那它会绿。** 这正是 D 说的：

> **如果它坏回原样，那步仍会绿。**

## 任务

### 第一步：先确认现状

```bash
grep -n "无法无损装载" apps/desktop/src/main/ -r
git log --oneline -5 -- apps/desktop/src/main/ | head
```

**确认那个字符串确实不存在了，T27 确实修了。**

### 第二步：读那步的完整实现

**不只看 `knownRefusal` / `succeeded` 两个变量**，看它们之后怎么用：

- 有没有 `step.assert(...)`？
- 断言的条件是什么？
- 「两种结局都接受」具体是什么写法？

### 第三步：判断这条断言当前有没有判别力

**三种情况**：

| 情况 | 判断 |
|---|---|
| 有断言要求 `succeeded === true` | **有判别力**（但注释说「两种都接受」是过期的） |
| 只断言「两种之一」 | **无判别力**（永远绿） |
| 没断言，只记录 | **不是断言**，是日志 |

### 第四步：修

按判断结果：

**如果无判别力**：
- 删掉 `knownRefusal` 分支（那个行为已经不存在了）；
- 改成断言 `succeeded === true`，失败时把 `result.reason` 带出来；
- **注释同步改**（现在那条注释描述的是 T27 之前的行为）。

**如果有判别力但注释过期**：
- **只改注释**，把「两种结局都接受」改成「要求成功」。

**如果没断言**：
- 补一条。

### 第五步：变异验证（**本卡的核心**）

**证明修好之后，它能抓到回归。**

方法：**临时**把 `loadWorkflow` 改成「对可保存图一律拒绝」（模拟 T27 之前的行为），看这步红不红。

```ts
// 变异：在 harness 的 loadWorkflow 里加
return { ok: false, reason: "无法无损装载（MUTATION）" };
```

**必须红** → `cmp` 逐字节还原。

⚠️ **这条变异不能跑**（需要真 Electron）。**所以你要用另一种方式证明**：

- 把那步的断言条件**在同一个文件里**改成一个必然为假的条件，跑一次（还是需要 Electron）；
- **或者**：把断言逻辑抽成一个纯函数，在 `.tmp/` 里对三种输入（成功 / T27 前行为 / 其他失败）各跑一次，证明**三种输入给出三种不同结论**。

**推荐第二种** —— 不需要 Electron，而且它证明的是**判据能区分三种情况**，比「改坏了会红」更强。

## 验收判据

1. **现状确认**（字符串确实不存在、T27 确实修了）。
2. **那步当前有没有判别力的判断**（三种情况之一，有证据）。
3. **修好后的实现**。
4. **判据能区分三种输入的证据**（成功 / T27 前行为 / 其他失败）。
5. **注释与行为一致**（不再描述已不存在的拒绝行为）。
6. 不跑全量、**不起 Electron**。

## 边界

- **只改那一个 journey 文件**；
- 不改产品代码（`loadWorkflow` 的实现）；
- 不碰 `apps/desktop/src/main/` 下任何文件；
- 不跑全量、不起 Electron。

## 遇到问题先检索

`step.run` / `step.assert` 的既有写法先读同一个 journey 里的其他步，**不要另造一套**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T84-node-red-journey-stale-assertion.md` 末尾追加 `## 结果回写（2026-10-23）`：
现状确认、当前判别力判断、改前/改后、三输入区分证据、提交 SHA。
