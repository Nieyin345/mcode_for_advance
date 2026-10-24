# T152 — `smokes-for.sh` 对 vendor 路径给**错误的否定结论**

**Status**：✅ done（`8cf7be3d`，13/13 + 13/25/10 回归；回写见文末）
**Category**：P0 测试基础设施
**发现者**：总控（office）—— 它在 O6（六编辑器换壳）要改 `genoffice/apps/*/src/renderer/` 时撞到
**写卡时间**：2026-10-24 22:05。**下面前提我都实测过。**

## 一、症状

```bash
$ bash apps/desktop/scripts/smokes-for.sh genoffice/apps/docs/src/renderer/App.tsx
genoffice/apps/docs/src/renderer/App.tsx
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。
     要么补一套,要么改完自己写一次性探针验一遍然后删掉。
```

**而 `o0-format-fidelity-smoke` 等 Office 套件确实在覆盖它**（它们 import 了 `genoffice/`）。

**所以这条输出是一个错误的否定结论。**

## 二、为什么这是最坏的一种错

**Office 总控的原话：**

> **「没有套件覆盖」和「不在图上」是两个完全不同的事实。**
>
> - 前者是**结论**（我们查过了，没有）；
> - 后者是**边界**（我们没查，因为这里不在我们的索引范围）。
>
> **把它写成前者，就是我们今天反复说的那个形态：把「没检查」说成「检查过、没问题」。**

**而且它有一个放大效应：**

> **T150 修的是「跳数/覆盖显示」两个 bug。它修好之后，那个「⚠️ 没有套件覆盖」会变得更可信 ——
> 而它在 vendor 路径上恰恰是错的。**
> **修得越好，错得越有说服力。**

## 三、根因（我读过代码）

`smokes-for.py:485-500`：

```python
if arg.startswith("apps/") or arg.startswith("src/"):
    want = (DESKTOP / arg).resolve()
else:
    want = (ROOT / arg).resolve()

if not want.exists():
    print(f"找不到 {arg}")
    sys.exit(1)

hits = sorted(name for name, cov in suites.items() if want in cov)
print(f"{want.relative_to(ROOT).as_posix()}")
if hits:
    ...
else:
    print("⚠️ 没有套件覆盖它 —— 改这里没有回归网。")
```

**`genoffice/` 路径能解析（走 `ROOT` 分支），文件确实存在，然后 `want in cov` 为假 ——
因为依赖图只从 `apps/desktop/src/**` 出发，`genoffice/` 从来没进过图。**

**所以它不是「漏了某个 glob」，是「这张图从来没有包含过 vendor」。**

## 四、任务：改措辞，不改判定

**Office 总控给了两个方向，我选 B：**

| 方向 | 做法 | 问题 |
|---|---|---|
| A. 把 `genoffice/` 加进依赖图 | 扫 vendor 源码里的 import | **vendor 是独立 git 仓库，它的依赖图和我们的不是一回事** —— 强行并进来会产生大量假边 |
| **B. 让工具对「图外路径」说实话** | 不改判定，改措辞 | 便宜、准确、不假装 |

### 具体改法

**在 `hits` 为空的分支里，先判断 `want` 是否在索引范围内：**

```python
else:
    # 判据：这个路径在不在我们的依赖图范围内
    indexed_roots = [MAIN, RENDERER]          # apps/desktop/src/main, src/renderer
    if not any(want.is_relative_to(r) for r in indexed_roots):
        print("⚠️ 不在本索引范围内 —— 本工具只索引 apps/desktop/src/**")
        print("   这条路径在 vendor/子仓库里，依赖图不覆盖它。")
        print("   「不在图上」不等于「没有套件覆盖」—— 覆盖情况见任务卡。")
    else:
        print("⚠️ 没有套件覆盖它 —— 改这里没有回归网。")
        print("   要么补一套,要么改完自己写一次性探针验一遍然后删掉。")
```

**⚠️ 措辞要区分三件事：**

| 情况 | 输出 |
|---|---|
| 文件不存在 | `找不到 <path>`（现状，保持） |
| 在索引范围内、无套件 | `⚠️ 没有套件覆盖它`（**这是结论，可查**） |
| **不在索引范围内** | **`⚠️ 不在本索引范围内`（这是边界，不是结论）** |

## 五、验收

1. **`genoffice/**` 路径输出「不在本索引范围内」，不是「没有套件覆盖」。**
2. **`apps/desktop/src/main/**` 里真的没覆盖的文件，仍然输出「没有套件覆盖」**（不能把真结论也改掉）。
3. **`apps/desktop/src/renderer/**` 同上**（T150 刚让 renderer 也能被索引）；如
   果 renderer 在某些情况下也不在图里，要说清。
4. **命令的建议行也要改** —— 现在那句「要么补一套」对 vendor 路径是错的建议
   （vendor 的覆盖在 Office 套件里，不会有人去补一套）。
5. **不回归**：T150 的两个症状仍然修好（`rpcMap.ts` → 必跑 1 套；`modules.ts` → 不崩）。

## 六、变异

| # | 变异 | 预期红 |
|---|---|---|
| M-1 | 把 `genoffice/` 分支改回「没有套件覆盖」 | 1（措辞那条） |
| M-2 | 把 `apps/desktop/src/main` 下真没覆盖的文件也改成「不在索引范围」 | 1（**防止措辞改过头**） |

**⚠️ M-2 是关键负控** —— 它防止「为了修 vendor 的问题，把真结论也一起改了」。

### M-2 的样本（Office 总控问「有没有」，我找到了 11 个）

```bash
$ bash apps/desktop/scripts/smokes-for.sh --uncovered
  apps/desktop/src/main/document/genofficeEntryTypes.d.ts
  apps/desktop/src/main/document/genofficeExternalTypes.d.ts
  apps/desktop/src/main/document/genofficeNativeVendorStub.ts
  apps/desktop/src/main/document/genofficeViewAiVendorStub.ts
  apps/desktop/src/main/document/slidesVendorModulesStub.ts
  apps/desktop/src/main/document/slidesVendorShims.d.ts
  apps/desktop/src/main/mcp/hostMcpMain.ts
  apps/desktop/src/main/modules/moduleApproval.ts        ← 推荐样本
  apps/desktop/src/main/providers/claude-sdk/index.ts
  apps/desktop/src/main/raw-imports.d.ts
  apps/desktop/src/main/workflowEngines/nodePackChildRuntime.ts
  共 11 个;主进程下覆盖到的 498 个。
```

**推荐样本：`src/main/modules/moduleApproval.ts`**

```bash
$ bash apps/desktop/scripts/smokes-for.sh src/main/modules/moduleApproval.ts
apps/desktop/src/main/modules/moduleApproval.ts
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。      ← M-2 用的就是这条
```

**⚠️ 用 `.ts`，不要用 `.d.ts`** —— 类型声明改成「不在索引范围」也说得通，
**那就验不出 M-2 想验的东西了。**

## 六之二、⚠️ 顺带发现的第三个 bug：`--uncovered` 的输出不能直接传回去

```bash
$ smokes-for.sh apps/desktop/src/main/modules/moduleApproval.ts
找不到 apps/desktop/src/main/modules/moduleApproval.ts        ← 错

$ smokes-for.sh src/main/modules/moduleApproval.ts
apps/desktop/src/main/modules/moduleApproval.ts               ← 对
```

**根因**（`smokes-for.py:485-487`）：

```python
if arg.startswith("apps/"):
    want = (DESKTOP / arg).resolve()      # → apps/desktop/ + apps/desktop/src/... 拼重复
```

**`apps/` 那条分支是死代码** —— 传 `apps/desktop/...` 永远找不到。

**这三种选择：**

| 选项 | 说明 |
|---|---|
| **A（推荐）** | 让 `apps/desktop/...` 也能用：`if arg.startswith("apps/desktop/"): want = (ROOT / arg)` |
| B | 改 `--uncovered` 的输出格式（**先查有没有消费者**，见 §七） |
| C | 只记在卡里 |

**选 A 要加断言：`apps/desktop/src/...` 和 `src/...` 两种写法结果相同。**

## 七、边界

**可以改**：
- `apps/desktop/scripts/smokes-for.py`（只改那个 `else` 分支的措辞与判据）
- 延伸 `t145-runsh-path-smoke` 或新建套件

**不许碰**：
- 依赖图的构建逻辑（`closure()` / `resolve()`）——**T150 刚改过，不要动**
- `apps/desktop/scripts/*/run.sh`
- `genoffice/`（独立仓库，不在本卡范围）

**⚠️ 并行提示**：T150 可能在改 `smokes-for.py`。**开工前先 `git status --porcelain -- apps/desktop/scripts/smokes-for.py`
和 `git log --oneline -3 -- apps/desktop/scripts/smokes-for.py`
确认它的改动已经提交。**

## 八、回写

1. 三种情况（不存在 / 在范围内无覆盖 / 不在范围内）分别输出了什么
2. `apps/desktop/src/renderer/**` 现在在不在索引范围
3. 变异结果（M-1 / M-2 各自红几条，红的对不对）
4. T150 的两个症状有没有回归
5. 提交 SHA
6. **你觉得不对但没改的**

---

## 附：这条和信息传递的关系

**这是「边界 vs 结论」的第一百次实例，但形态最新：**

| 形态 | 例子 |
|---|---|
| 把「没查」说成「查过、没问题」 | `heuristic-scan-is-not-a-guarantee` |
| 把「量了包裹层」说成「量了正文」 | 第三十三条 |
| 把「采集了」说成「比对了」 | 第三十四条 |
| 把「静态判据覆盖一种拼写」说成「覆盖一类 bug」 | 第三十五条 |
| **把「不在图上」说成「没有覆盖」** | **本条** |

**共同点：工具的输出里有一句话，读者会把它当成关于世界的陈述，而它实际是关于工具自身范围的陈述。**

---

# 结果回写（2026-10-24，T152 执行会话）

## 1. 三种情况分别输出了什么

| 情况 | 路径 | 输出 | 判定 |
|---|---|---|---|
| **文件不存在** | `src/main/nope.ts` | `找不到 src/main/nope.ts`（`rc=1`） | ✅ 保持原样 |
| **索引内、无套件** | `src/main/modules/moduleApproval.ts` | `⚠️ 没有套件覆盖它 —— 改这里没有回归网。` + 建议行 | ✅ 保持原样（**结论**） |
| **索引外（vendor）** | `genoffice/apps/docs/src/renderer/App.tsx` | `⚠️ 本工具只回答「有没有套件覆盖 apps/desktop/src/**」。` / `这个路径不在那个问题能回答的范围内（…）。` / `「不在图上」不等于「没有套件覆盖」—— 覆盖情况见对应任务卡。` | ✅ **改口**（**边界**） |

**采用了 Office 总控的第三句而不是卡上的「不在本索引范围内」** —— 它描述工具的**定义域**，
读者拿到的是「这个问题本身问错了」，而不是「这里被特殊对待了」。

**建议行也一起换了**：vendor 上不再出现「要么补一套」（那里的覆盖在 Office 套件里，
不会有人去补一套）。

## 2. `apps/desktop/src/renderer/**` 现在在不在索引范围

**在。** 实测：

```bash
$ bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/Markdown.tsx
apps/desktop/src/renderer/components/chat/Markdown.tsx
  必跑（1–2 跳，4 套；跳数 [1, 2]）:
    markdown-preview-smoke  (1 跳)
    chat-linecount-smoke  (2 跳)
    custom-tab-race-smoke  (2 跳)
```

**所以 `INDEXED_ROOTS = (MAIN, RENDERER)` 两者都在判据里**，S3 那条断言也钉住了这一点
（改口不能波及 renderer 的正常路径）。

## 3. 变异结果

| # | 变异 | 预期红 | 实际红 | 红的对不对 |
|---|---|---|---|---|
| **M-1** | `print_no_coverage` 的 vendor 分支改回「没有套件覆盖」 | 1 | **3** | ✅ 全在 S1 组（不说「没有套件覆盖」/ 说「本工具只回答」/ 不给「要么补一套」）。**我预期只写了 1 条 —— 漏算了同组的两条伴生断言。** |
| **M-2** | `is_indexed` 恒为 `False`（所有路径都当「不在范围」） | 1 | **2** | ✅ 正好是 S2 那一对（仍报「没有套件覆盖」/ 且不说「本工具只回答」）。**这是防过度修正的负控，红的正是目标** |
| **M-3** | `apps/` 分支改回 `(DESKTOP / arg)` | 1 | **3** | ✅ 全在 S4 组（不再「找不到」/ 两种写法逐字相同 / 有覆盖的也相同） |

**三组各自红在不同的组上，互不串扰** —— 这本身就是判据分得开的证据：
修 vendor 措辞不会让路径等价那条红，反之亦然。

**M-1 和 M-2 是一对**：M-1 证明改口生效，M-2 证明改口没有过头。
只有 M-1 会得到一个「对什么都说不认识」的工具 —— 那比说错更坏。

**还原三次都用 `cp 备份 目标` + `sha256sum -c` 逐字节核对（`e2e2d410…`），没有一次 `git checkout`。**

## 4. T150 的两个症状有没有回归

**没有。** 实测：

```bash
$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
  必跑（1–2 跳，1 套；跳数 [0]）:
    app-control-smoke  (0 跳)          ← 仍是 0 跳，没退化

$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/modules.ts
  ⚠️ 可选（≥3 跳，1 套）:
    经由 packages/contracts/src/moduleCapability.ts（1 套）:
      capability-smoke                  ← 仍然不崩，且「经由 X」还在
```

**没有碰 T150 改的部分**：`@smoke-covers` 扫描、`display_path`、`suite_distance` 的声明逻辑
全部原样。

## 5. `--uncovered` 那个死分支修了（分开记录）

**已修**，按卡的选项 A（让 `apps/desktop/...` 也能用），**单独一组 S4 断言钉住**：

```python
if arg.startswith("apps/"):
    want = (ROOT / arg).resolve()        # ← 仓库根基准（--uncovered 的输出形状）
elif arg.startswith("src/"):
    want = (DESKTOP / arg).resolve()     # ← 历史用法
else:
    want = (ROOT / arg).resolve()
```

**S4 断言「两种写法输出逐字相同」**，对有覆盖的文件（`policy.ts`）和无覆盖的文件各验一次。

**没有改 `--uncovered` 的输出格式** —— 那样会动到消费者（`tsx-coverage-smoke` 等断言 stdout）。

## 6. 回归套件

| 套件 | 结果 |
|---|---|
| `t152-smokes-for-index-scope-smoke`（新建，13 条） | **13/13** |
| `t150-smokes-for-contracts-smoke` | 13/13 |
| `smokes-for-ranking-smoke` | 25/25 |
| `tsx-coverage-smoke` | 10/10 |

## 7. 提交

**`8cf7be3d`** —— 4 文件，+365/−4（`smokes-for.py` 一个提交里含两件事：主任务 + `apps/` 死分支，因为它们是同一个函数的两处；套件单独可拆，见 §5）。

## 8. 觉得不对但没改的

### ① `--uncovered` 说「改这里没有回归网」，但对 vendor 文件它是错的话

`--uncovered` 的标题行是 `# 没有任何套件覆盖到的源码文件(改这里没有回归网):`。
**它只扫 `MAIN` 下的 `.ts`**，所以名单里不会有 vendor 文件 —— 这一点目前是对的。

**但它的措辞（「没有回归网」）和本次修的是同一族**：它也是一句**结论**。
现在的口径正确**仅仅因为**它的扫描范围恰好就在索引范围内。**如果将来有人把它扩到
`genoffice/`，同一句话会立刻变成错误结论。** 没改，记在这里。

### ② 文件不存在时 `sys.exit(1)`，而「不在索引范围」是 `exit 0`

这是有意的（一个是错误，一个是正常回答），但**脚本调用方如果只看退出码，
无法区分「查到了边界」和「查到了结论」**。现在靠 stdout 的两句话区分。
**如果将来有脚本要消费这个工具的输出，应该给一个 `--json` 之类的出口**，而不是解析人类可读文本。
没做 —— 目前唯一的程序化消费者（`tsx-coverage-smoke` / `smokes-for-ranking-smoke`）
断言的都在索引范围内，不受影响。

### ③ `INDEXED_ROOTS` 是**新增的常量**，而工具的其它范围判断散在各处

`--uncovered` 用 `MAIN.rglob("*.ts")`，`resolve()` 用 `@main/` / `@renderer/` 前缀判断，
`coverage()` 从 `scripts/*-smoke` 出发。**这三处都在隐式地定义「范围」，而只有新加的
`INDEXED_ROOTS` 是显式的。**

**统一它们是一次真正的重构**（会动 `resolve()` —— T150 刚改过，卡上明确说不要碰），
不在本卡范围。**但下次有人要改「工具管哪些文件」时，先看这四处是否一致。**
