# T140｜`cn()` 丢掉全部 CDS 字号档 —— T121 七档在运行时从未生效

- Status: `ready-for-agent`
- Category: **P0 基础设施（UI）** —— 它让 T121/T130/T133 的字号体系大面积失效
- Priority: **P0**
- 发现于：T138 执行时（我引入了 3 行筛选条回归，查根因时发现）
- **写卡时间**：2026-10-24 21:00。**本卡所有数字都带取证命令，读卡时先重跑一遍。**

> **⚠️ 本卡的计数我改了三次才对。** 第一次写「29 处，2 处误报」，第二次写「28 处，两处被我误判」，第三次（`verify-v2-final.mjs`，跳过字符串+行注释+块注释）才得到可信的 **27 真 / 1 假**。
> **每改一次都是因为取证工具本身有 bug。** 下面附了判定方法，执行时请重跑，不要采信我的数字。

## 一、症状（可复现）

**T138 把 `FilterChip` 的 `text-[11px]` 改成 `text-caption`，筛选条从两行变成三行。**

字号 11px → 11px，本不该有任何变化。实际渲染却明显变大。

根因不是那次改动，是 `cn()`：

```ts
// apps/desktop/src/renderer/lib/cn.ts:11-17   （git log: 只有「首次提交」，从未改过）
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

`twMerge` **不认识** `tailwind.config.js` 里扩展的档位名（`caption`/`footnote`/`code`/`body`/`prose`/`heading`/`title`）。它把 `text-caption` 归进**文字颜色**那一组，于是：

```js
twMerge("text-caption text-content")
// → "text-content"        ← 字号被删掉了
```

**实测**（`tailwind-merge@3.6.0`，仓库内真实版本）：

| 输入 | `twMerge` 输出 | 说明 |
|---|---|---|
| `text-caption text-content` | **`text-content`** | 字号丢失 |
| `text-xs text-content-muted` | `text-xs text-content-muted` | 内置档位存活 ✓ |
| `text-caption`（单独） | `text-caption` | 只有它一个时不冲突 |
| `text-caption text-body` | `text-body` | 档位之间互相覆盖正常 |

**这是「判据测中间量」的又一例**：T121/T133 的套件断言源码里「有 `text-caption`」——**那是绿的**。真正决定渲染的 `cn()` 把它丢了，没有一条套件看得到。

## 二、影响面（数出来的，不是估的）

扫描器：`.tmp/scan-cn-precise.mjs`（括号配对抠 `cn(...)` 实参）→ `.tmp/verify-v2-final.mjs`（跳过字符串/行注释/块注释后逐个重判）

```bash
node .tmp/scan-cn-precise.mjs   # 候选 28 处
node .tmp/verify-v2-final.mjs   # 真实问题 27 / 误报 1 / 无法判定 0
# 按档位: {"code":24,"body":3,"caption":1}
```

**丢掉的字号回落到多少？** `styles.css:762` 的 `html, body, #root` 只设了 `font-family`，**没有 `font-size`** → 浏览器默认 **16px**。

所以这 27 处的实际字号是 **16px**，而它们想写的是 12px（`code`）/14px（`body`）/11px（`caption`）。

**受影响最重的是 `text-code`（24 处）**：`ui/input.tsx`、`ui/textarea.tsx`、`ui/select.tsx`、`ui/dialog.tsx`、`ui/native-controls.tsx` —— **全部共享控件**。它们的文字比设计值大 4px。

**这 27 处的完整清单**（行号以写卡时为准，执行前请重跑上面两条命令）：

```
browser/BrowserToolbar.tsx:309                      [code]
customUi/CustomSlotHosts.tsx:152                    [code]
ide/TaskListPanel.tsx:494                           [caption]
ide/TerminalCommandsMenu.tsx:231                    [code]
library/CollectionContextMenu.tsx:133               [code]
library/ItemDetail.tsx:324                          [code]
library/LibraryItemContextMenu.tsx:124              [code]
library/LibrarySection.tsx:138                      [code]
mobile/MobileGitScreenParts.tsx:309                 [code]
mobile/MobileSessionDrawer.tsx:648                  [body]
mobile/MobileSettingsSheet.tsx:125                  [code]
mobile/MobileSettingsSheet.tsx:156                  [code]
settings/AppearanceExtras.tsx:231                   [code]
settings/CustomUiPanel.tsx:650                      [code]
settings/CustomUiPanel.tsx:677                      [code]
settings/CustomUiPanelParts.tsx:304                 [code]
settings/EngineToolsPanel.tsx:119                   [code]
settings/SettingsTerminalPanel.tsx:320              [code]
sidebar/Sidebar.tsx:429                             [code]
sidebar/Sidebar.tsx:456                             [code]
ui/dialog.tsx:107                                   [body]
ui/dialog.tsx:121                                   [code]
ui/input.tsx:27                                     [code]
ui/native-controls.tsx:37                           [code]
ui/select.tsx:56                                    [code]
ui/select.tsx:179                                   [code]
ui/textarea.tsx:22                                  [code]
```

**唯一误报**：`ide/GitDiffDialog.tsx:191` —— 档位只在那段注释里。

⚠️ **扫描器把注释也算进去了。逐个读到 `)` 之后，28 处的真实分布是：**

| | 数量 |
|---|---|
| **真问题**（档位在实参里，会被丢掉） | **27** |
| **误报**（档位只在注释里） | **1** —— `ide/GitDiffDialog.tsx:191` |

**唯一那处误报**：`GitDiffDialog.tsx:191` 的 `cn()` 实参是 `"flex flex-col bg-surface-muted p-0"`，`text-body` 出现在它下面的注释里，属于下一个组件。

**判定方法（我自己踩了三次才做对）**：必须**同时跳过字符串、模板字符串、行注释、块注释**再做括号配对。

> **⚠️ 我第一次只跳过了字符串和 `//`，漏了 `/* */`。** 块注释里的 `(...)` 让配对永远不归零，`slice` 一路返回到文件末尾，把后面组件的 `text-body` 算了进来 —— **于是「GitDiffDialog:191 有 text-body」这个结论是工具造出来的，不是代码里有的。**
>
> 这就是 CLAUDE.md 第八条的第 3 种变异失效形态：**改坏了取证工具，却以为改坏了被测对象。**
>
> 可靠版本：`.tmp/t140-evidence/verify-v2-final.mjs`（跳过四种状态，配对失败时返回 `null` 而不是垃圾）。
取证脚本都在 `.tmp/t140-evidence/`：`scan-cn-precise.mjs`（候选）、`verify-v2-final.mjs`（判真假）、`tm-fix-probe.mjs`（验证修法）。

## 三、修法

`tailwind-merge` v3 提供 `extendTailwindMerge`：

```ts
// apps/desktop/src/renderer/lib/cn.ts
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import type { ClassValue } from "clsx";

/**
 * 【T140】把 CDS 七档登记给 twMerge。
 *
 * 不登记时 twMerge 把 `text-caption` 当成**颜色**类 —— 与同一次 cn() 里的
 * `text-content` 同组冲突，先出现的被丢掉，字号静默回落到根继承值（16px）。
 *
 * ⚠️ 这个列表必须与 tailwind.config.js 的 fontSize.extend 保持同步。
 * 新增档位时两处一起改 —— `t140-cn-tier-smoke` 会守这条。
 */
const CDS_TIERS = ["caption", "footnote", "code", "body", "prose", "heading", "title"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": CDS_TIERS.map((t) => `text-${t}`),
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**已验证**（`.tmp-tm-fix-probe.mjs`，仓库内真实 `tailwind-merge@3.6.0`）：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| `text-caption` + `text-content` | 只剩 `text-content` | **两个都在** ✓ |
| `text-code` + `text-content` | 只剩 `text-content` | **两个都在** ✓ |
| `text-caption` + `text-xs`（覆盖） | 两个都在（错） | **只剩 `text-xs`** ✓ |
| `text-xs` + `text-caption`（覆盖） | 两个都在（错） | **只剩 `text-caption`** ✓ |
| `text-content-muted` + `text-danger` | 只剩 `text-danger` | **只剩 `text-danger`** ✓ 没破坏颜色覆盖 |
| `bg-surface` + `bg-surface-muted` | 只剩后者 | **只剩后者** ✓ 没破坏背景覆盖 |

**最后一列是关键负控** —— 修复不能把颜色/背景的覆盖行为弄坏。

## 四、任务

### 第一步：改 `cn.ts`

**只改这一个文件**，然后跑全套确认没有回归。

⚠️ **这一步会让 28 处控件同时变小 4px**（`text-code` 从 16px 回到 12px）。这是**期望行为**，但**视觉上变化很大，必须逐屏核对**。

### 第二步：套件 `t140-cn-tier-smoke`

**判据必须落在 `cn()` 的真实输出上，不是源码文本。**

```ts
// ✅ 对
import { cn } from "../../src/renderer/lib/cn.js";
check("text-caption 与 text-content 共存", cn("text-caption", "text-content").includes("text-caption"));

// ❌ 错（就是 T121/T133 犯的错）
check("源码里有 text-caption", src.includes("text-caption"));
```

**必备断言**：

| # | 断言 | 为什么 |
|---|---|---|
| 1 | 七个档位逐个 + `text-content` 共存 | 主判据 |
| 2 | `text-caption` + `text-xs` → 只剩 `text-xs` | 档位覆盖仍生效（负控） |
| 3 | `text-content-muted` + `text-danger` → 只剩后者 | 颜色覆盖没被破坏（负控） |
| 4 | `bg-surface` + `bg-surface-muted` → 只剩后者 | 背景覆盖没被破坏（负控） |
| 5 | **`tailwind.config.js` 的档位名集合 === `CDS_TIERS`** | 防止加档位时两处不同步 |

**第 5 条是「判据依赖两件事一致时，要断言它们确实一致」**（CLAUDE.md 那条）。

### 第三步：视觉基线前后对比

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
```

**至少对比 `files-pane` / `git-pane` / `taskcenter` / `settings` 四个场景** —— 它们含 `ui/input.tsx` 等共享控件，字号会变。

⚠️ `compare.mjs` 当前跑不起来（T141 在修），所以**看图，别看比对输出**。

## 五、变异

| # | 变异 | 预期红 | 说明 |
|---|---|---|---|
| 1 | `cn.ts` 改回裸 `twMerge` | 7（七档全部） | 正控 |
| 2 | `CDS_TIERS` 删掉 `"code"` | 至少 2 | 主判据 + 第 5 条 |
| 3 | 把 `text-content-muted` 也登记进 `font-size` 组 | 1（第 3 条负控） | 证明负控有效 |

**变异 3 最容易漏** —— 它验的是「修复没有过度扩张」。没有它，把一切都塞进同一个组也能让第 1 条全绿。

## 六、边界

**可以改**：
- `apps/desktop/src/renderer/lib/cn.ts`（**只有这一个生产文件**）
- 新建 `apps/desktop/scripts/t140-cn-tier-smoke/`

**不许碰**：
- 那 28 处调用点（**修复后在下一张卡里逐个核对**，不要在这张卡里改）
- `tailwind.config.js` 的档位**值**（只允许核对名字是否同步）
- `styles.css`

## 七、验收

1. `cn.ts` 用 `extendTailwindMerge`，七档全部登记。
2. `t140-cn-tier-smoke` 全绿，且**三个变异都按预期红**（尤其变异 3）。
3. 全套回归 0 失败。
4. 视觉基线四个场景前后对比，**变化是「变小 4px」而不是「更乱」**。
5. 回写：修了几个文件、套件数字、变异结果、**四个场景的截图对比**。

## 八、和 T138 的关系

T138 已经把 `FilterChip` 那一处改成内联 `fontSize` 作为**局部规避**（`TaskCenterPanel.tsx:445` 附近的注释写了原因）。

**这张卡做完后，那一处应该改回 `text-caption`，并删掉那段注释。** 局部规避不该长期留着。

## 九、回写

1. `cn.ts` 最终写法
2. 套件数字 + 三个变异的结果（**红了几条、红在哪几条**）
3. 四个场景的视觉前后对比
4. 那 28 处里实际有几处是真问题（剔除误报）
5. 你觉得不对但没改的
