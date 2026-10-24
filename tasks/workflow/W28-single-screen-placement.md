# W28｜单屏机器上，U1 骨架永远红：无副屏分支把窗口摆到了所有显示器之外

- Status: **delivered（回写已追加；改动未提交，见 `## 结果回写`）**
- Category: **测试基础设施缺陷（影响全部 U1 套件）**
- Priority: **P0 —— 换一台单屏机器、或这台一直单屏，所有 U1 套件就永远是红的**
- Depends on: W24（发现者）
- 来源：W24 的「结果回写补记 2」，带完整对照矩阵

## 缺陷

`apps/desktop/scripts/electron-u1/driver/runner.ts:646-660` 的 `pickHostWindowPlacement()`：

```ts
const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
if (others.length > 0) {
  // 有副屏 → 放副屏
  return { x: target.workArea.x + 60, y: target.workArea.y + 60, note: `secondary display ...` };
}
const wa = primary.workArea;
return {
  x: wa.x + wa.width + 80,      // ← 主屏右边界之外
  y: wa.y + wa.height + 80,     // ← 主屏下边界之外
  note: `offscreen right-below primary work area ${wa.width}x${wa.height} (no secondary display)`,
};
```

**无副屏时，窗口被放到主屏的右下角之外 —— 那不在任何显示器的坐标空间里。**

## W24 的对照矩阵（它做的，我核实了代码位置）

**`BrowserWindow.capturePage()`**：位置和不透明度都无所谓，四种组合全成功。

**`WebContentsView.capturePage()`（U1 套件真正捕获的对象）**：

| 窗口位置 | 结果 |
|---|---|
| **屏外 `(1543,855)`** ← **无副屏分支的逐字坐标** | ❌ **永不成功**，load 完也不行 |
| 屏内 + `opacity: 0` | ✅ +122ms |
| 屏内 + `opacity: 1` | ✅ +93ms |

**⚠️ 这三格全部是「主屏」上的位置。** W24 的探针跑在这台**只剩单屏**的机器上
（探针输出 `displays: 1`），**副屏分支不存在、无法测** ——
**「副屏 + `opacity: 0`」仍然是空白格，谁要往副屏窗口加 `opacity` 得先自己测。**

**所以致命的是「屏外」，不是 `opacity`** —— 这个结论只在主屏上验过，而它正是本卡要修的那个分支。

## 两处注释是错的（代码自己在做注释说不能做的事）

### ① `runner.ts:633-637`

```ts
/**
 * 宿主窗口放哪。
 *
 * `WebContentsView.capturePage()` 需要「当前 display surface 可用」，所以窗口
 * 不能 `show:false`、也不能 `opacity:0`。...
 */
```

**而同一个函数下方 `:688` 就写着 `opacity: 0`。**

**W24 实测：屏内 + `opacity: 0` 完全正常。**

**为什么注释会错**：它把「`BrowserWindow.capturePage`」和「`WebContentsView.capturePage`」
混成了一件。`createWindow` 建的是 `BrowserWindow`，而旅程里 `capturePage` 的是它上面的
`WebContentsView` —— **两者对 `opacity` 的敏感度不同**。

### ② `runner.ts:869-870`

```ts
// ⚠️ 这里**不加 `opacity: 0`**：旧注释说「离屏 + opacity 0 会让 capturePage 抛」，
// 而「副屏 + opacity 0 行不行」**没有实测过**。
```

**它自己承认「没有实测过」。实测补上的只有主屏那三格 —— 「副屏 + opacity 0」仍未测。**

> **⚠️ 2026-10-25 01:30 更正（W24 指出，我是错的）**
>
> 我原先在这行写的是「现在实测过了：**「副屏 + opacity 0」行**，且「屏内 + opacity 0」也行」。
> **前半句是错的 —— W24 从未测过「副屏 + opacity 0」。**
>
> 它的探针全程在这台**只剩单屏**的机器上跑（探针输出 `displays: 1`），**副屏分支根本不存在，无法测**。
> 它实际测过的是**主屏**上的三格：
>
> | 位置 | `WebContentsView.capturePage()` |
> |---|---|
> | 屏外 `(1543,855)` | ❌ 永不成功 |
> | 屏内 + `opacity: 0` | ✅ 122ms |
> | 屏内 + `opacity: 1` | ✅ 93ms |
>
> **「副屏 + opacity 0」仍然空着。** 谁要往副屏窗口加 `opacity`，**得先自己测**。
>
> **为什么这条要写清**：本卡的修法是「**无副屏**分支改屏内 + opacity 0」，
> 而原句读起来像「**副屏**分支的 opacity 也验过」——**那会让下一个人以为可以照抄到副屏分支上。**
> **把未测的记成已测，比没写更危险。**

### ③ 提交 `5ec95339` 的说法

> 「屏外仍被合成器认为有 surface」

**那条只在这台当时有两块屏的机器上验过副屏分支，无副屏分支从没跑过。**

## 任务

### 一、改无副屏分支：放**主屏工作区内** + `opacity: 0`

```ts
const wa = primary.workArea;
return {
  x: wa.x + 20,
  y: wa.y + 20,
  note: `inside primary work area (invisible) ${wa.width}x${wa.height} (no secondary display)`,
};
```

**W24 实测过这个位置**（临时改 + 跑 t30：截图步骤从 FAIL 变 PASS，失败点前移到
`apps-discovery`），**且它已 `sha256sum -c` 逐字节还原。**

**窗口已经有 `opacity: 0`（`:688`），所以用户看不见。** 位置改成屏内不影响「别在主屏弹窗」
这个用户要求 —— **那正是 `opacity: 0` 在负责的**。

### 二、改掉那两处注释的错误因果

**不要写「实测过 X 所以 Y」这种无法复验的话。写：条件 + 出处 + 后果。**

```ts
/**
 * 宿主窗口放哪。
 *
 * `WebContentsView.capturePage()` 要求窗口**落在某个显示器的坐标空间内** ——
 * 屏外的窗口（哪怕 `show:true`）拿不到 display surface，截图返回空图。
 * 位置的这条约束是硬的；`opacity` 不是（见下）。
 *
 * 优先级：
 *   1. 有副屏 → 放副屏（用户偏好，别在主屏弹窗）。
 *   2. 没副屏 → **主屏工作区内**（用户看不见由 `opacity: 0` 保证，不是由位置保证）。
 *   3. 上面都不成立 → 主屏左上角。
 *
 * 【W24 2026-10-25 实测】`WebContentsView.capturePage()`：
 *   屏外 (1543,855) → 永不成功；屏内 + opacity 0 → 122ms 成功；屏内 + opacity 1 → 93ms 成功。
 *   旧注释说「不能 opacity:0」是把 `BrowserWindow.capturePage` 和
 *   `WebContentsView.capturePage` 混成了一件 —— 前者不受位置影响，后者受。
 */
```

### 三、改 `:869-870` 那段

既然屏内 + `opacity: 0` 实测可行，**那里加不加 `opacity` 由你判断**，
但**必须删掉「没有实测过」这句话**（它已经实测过了），并写明依据。

## 验收判据

1. **无副屏分支的坐标落在 `workArea` 内** —— 一条纯函数断言（`pickHostWindowPlacement`
   要导出，或者抽成可测的）；
2. **`note` 文案不再说 "offscreen"**（那会误导下一个读日志的人）；
3. **两处错误注释改掉了**，且新的注释写「条件 + 出处 + 后果」，不写「我实测过所以对」；
4. **变异验证**：把坐标改回 `wa.x + wa.width + 80` → 第 1 条断言必须红；
5. **如果这台机器现在只有一块屏**：跑一次 U1，确认截图步骤不再因为位置失败
   （**如果红在别的地方，照实写**）；
6. `tsc` EXIT=0；
7. **不跑全量**。

### ⚠️ 判据 5 有一个「绿在另一条分支上」的坑（W24 指出）

**如果 W28 执行期间副屏回来了，判据 5 会走「有副屏」分支，变绿 —— 而那是另一条分支，
你实际什么都没验到无副屏那条。**

**所以判据 5 必须同时确认「走的是哪条分支」：**

```bash
grep "U1 host window:" <证据目录>/run-g1.log
```

| 日志内容 | 含义 |
|---|---|
| `inside primary work area ... (no secondary display)` | ✅ **验的正是无副屏分支** |
| `secondary display (id=...)` | ❌ **走的是副屏分支，判据 5 无效** |

**日志里必须是前者。** 如果是后者，**说明副屏回来了，判据 5 这一轮验不到你要验的东西**——
照实写「本轮副屏在位，无副屏分支未验证」，**不要把它当成通过**。

> **这和今晚 `grep -c` 数到 0 那类坑是同族的**：
> **一个看起来在回答你的问题的信号，实际回答的是另一个问题。**

## 边界

**可以改：**

- `apps/desktop/scripts/electron-u1/driver/runner.ts`（**`pickHostWindowPlacement` 与那两处注释**）

**不许碰：**

- `apps/desktop/scripts/electron-u1/build.mjs`（W24 刚改过 `--keep`）
- `apps/desktop/src/**`
- 各套件的 `journeys/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

## 回写

`tasks/workflow/W28-single-screen-placement.md` 末尾追加 `## 结果回写`：

1. 改前改后的坐标（实测值）；
2. 纯函数断言怎么写的；
3. **如果你这台机器只有一块屏**：跑 U1 的结果（截图步骤过没过）；
4. 变异结果；
5. **你没能验证的东西**；
6. **W24 / 这张卡上写错的地方**。

## 一条判断标准

**这条缺陷最贵的地方不是「红」，是「红的原因指向错的方向」。**

日志写 `offscreen right-below primary work area` —— **读的人会以为「屏外是有意的，所以这是正常的」**。
而实际它是**导致截图永远失败的根因**。

**一条自己解释得像「这是设计」的日志，比一条什么都不说的日志更难查。**

---

## 结果回写（W28，2026-10-25 02:40）

> **改动未提交**（总控统一提交）。改动只有 `apps/desktop/scripts/electron-u1/driver/runner.ts`
> 一个文件（+ 新增无头套件 `apps/desktop/scripts/u1-placement-smoke/`）。
> **本机单屏**（Electron 44.4.5 实测 `displays: 1`，主屏 1463×823，workArea 1463×775），
> 所以**每一趟 U1 都走无副屏分支**（每个证据目录的 `run-g*.log` 都核过 `U1 host window:` 那一行）。

### 1. 改前 / 改后的坐标（实测值）

| | 无副屏分支返回 | 日志 `U1 host window:` |
|---|---|---|
| **改前** | `{ x: wa.x + wa.width + 80, y: wa.y + wa.height + 80 }` = **`(1543, 903)`** | `offscreen right-below primary work area 1463x775 (no secondary display) (x=1543, y=903)` |
| **改后** | `{ x: wa.x + 20, y: wa.y + 20 }` = **`(20, 20)`** | `inside primary work area (invisible) 1463x775 (no secondary display) (x=20, y=20)` |

**注**：卡面写的是 `(1543, 855)`（W24 探针时的 workArea 高度 815）；本机现在的 workArea 是
1463×**775**，所以同一个表达式今天算出 **903**。**表达式一致、数值随 workArea 变** ——
这也是判据不能写死数字的原因（见第 2 节）。

**另外改了的两处**：

- `placement` 现在**自带 `opacity`**（无副屏 → 0；副屏 → 1；`screen` 不可用兜底 → 1）。
  这是为了让「屏内必须靠 opacity 隐身」这件事跟位置**同源**，不再由调用方各自决定。
  副屏分支**保持 1**：`副屏 + opacity 0` **没测过**（见第 5 节）。
- 注释：`pickHostWindowPlacement` 的整段文件头（条件 / 优先级 / 出处 / 后果）、
  调用点那段「离屏 + opacity 0 会抛」的错误因果、`createWindow` 上方那句
  「放在屏幕外且透明」（单屏上现在是屏内，这句已经变成假的）—— **三处都写了条件 + 出处 + 后果**，
  没有写「我实测过所以对」。

### 2. 纯函数断言怎么写的

**把算术内核抽成导出的 `chooseHostWindowPlacement(primary, others)`**，`pickHostWindowPlacement`
只负责读 `screen` 和兜底；判定逻辑只有一份。新套件
`apps/desktop/scripts/u1-placement-smoke/`（`main.ts` + `run.sh` + `stubs/electron.ts`）**直接 import 真身**，
不在套件里抄逻辑。

`run.sh` 用 esbuild 打包：`--alias:electron=<全显式抛错的桩>`（`runner.ts` 顶层不碰 electron，
真碰了会当场炸）+ `--external:@main/*`（`runner.ts` 函数体内有几处 `await import("@main/...")`，
esbuild 会把动态 import 也打进 bundle，整套主进程图会被拖进来 —— 本套只要纯算术那一块）。

**9 条断言**，其中两条是**判据自检（正控）**，其余七条分三组：

| 组 | 断言 |
|---|---|
| 自检 | `inside()` 认得出屏内点 **且** 把旧坐标 `(1543,903)` 判为屏外 —— **没有这两条，`return true` 的实现会让主判据恒绿** |
| 无副屏 | ① 原点落在 `workArea` 内；② `note` 不含 `offscreen` 且说明没有副屏；③ `opacity === 0` |
| 无副屏 + 原点非零 | 主屏 workArea 从 `(1920,-200)` 起时坐标**仍在该 workArea 内** —— 防「把 20,20 写死成绝对坐标」 |
| 有副屏 | ① 落在副屏 `workArea` 内且内缩 60；② `note` 带 id；③ `opacity === 1` |

`inside()` 用半开区间 `[x, x+width) × [y, y+height)`，**不是** `<= x+width`
（窗口正好压在右边界上时，那不是「屏内」）。

### 3. 本机单屏 —— U1 实跑结果（**截图步骤过没过**）

**本机只有一块屏**（探针输出 `displays: 1`），所以每趟都走无副屏分支。
每趟都用 `grep "U1 host window:" <证据目录>/run-g*.log` 核过 —— **全部是
`inside primary work area ... (no secondary display)`，没有一条走副屏分支**（判据 5 的坑已避开）。

| 套件 | 结果 | 截图步骤 | 说明 |
|---|---|---|---|
| **`t7-genoffice-u1`** | **`T7: PASS`，EXIT=0，6/6 旅程** | **28 个截图步骤，全部 PASS**（0 条 FAIL） | 六个 GenOffice 编辑器全绿；12 次建窗口全部 `inside primary work area` |
| **`t8-node-red-u1`**（run 4） | **`T8: PASS`，EXIT=0** | 7 个截图步骤全 PASS（3+2+2） | 见下「抖动」 |
| `t8-node-red-u1`（run 1/3/5） | EXIT=2，但**不是截图位置问题** | run1：截图全过，红在 `canvas-label-shows-rename`；run3：`step-09-screenshot` 红（**`Current display surface not available`**）；run5：红在 `canvas-label-shows-rename` | 见下「抖动」 |
| `t30-document-tools-u1` | EXIT=2，**失败点前移到 `apps-discovery`**（`目录总数不是 139`） | `docs-editor-opened` / `docs-fixture-text-visible` 两个截图步骤 **PASS** | **与 W24 临时变异时观察到的失败点完全一致**；`139→140` 是 W24 §4 记过的过期字面量，不在本卡范围 |

**结论：位置这条已经不再是红因。** 换单屏机器后所有 U1 套件不再「永远红在截图」——
`t7` 全绿、`t8` 有一趟全绿、`t30` 的失败点前移到已知的过期断言。

#### ⚠️ 残留抖动（**如实记，未修**）

`t8` 跑了 5 趟（run1–run5，本机单屏、无副屏分支），**只有 1 趟全绿**：

| run | 结果 | 红在哪 |
|---|---|---|
| 1 | EXIT=2 | `canvas-label-shows-rename`（DOM 断言） |
| 2 | EXIT=2 | **GPU 进程崩溃**（`GPU process exited unexpectedly: exit_code=1` → `document view renderer gone`），当趟 `steps: []` |
| 3 | EXIT=2 | `step-09-screenshot`：`Current display surface not available for capture`（**generation 2**，新进程刚起 2ms） |
| 4 | **PASS** | — |
| 5 | EXIT=2 | 同 run1 |

**两条观察，都指向「不是 opacity、也不是位置」：**

1. **`canvas-label-shows-rename` 是判据早了一帧，不是改名失败**：失败步的 DOM 快照
   （`failure-canvas-label-shows-rename-g1.html`，**失败时**抓的）里**已经含有** `T8-已改名-DEPLOYED`；
   `rename-node-via-tray` 的 `committedValue` 也等于目标名（`ok: true`）。同一个旅程单独跑时 PASS。
2. **`step-09-screenshot` 那一格在 W24 的矩阵之外**：W24 测的是「窗口建好后 +93/+122ms」，
   **没测「view 挂上后 2ms」**。这条探针我补了两种（`.tmp/w28-raf-probe.cjs` /
   `.tmp/w28-long-idle-probe.cjs` / `.tmp/w28-order-probe.cjs`）：
   - **rAF 不被 `opacity: 0` 节流**：400ms 内 67 vs 67 帧，DOM 变更 0–1ms 内可见；
   - **capture 不随时间退化**：0.25s / 2s / 8s / 20s / 30s 五个时点，`opacity: 0` 全部成功；
   - **顺序对照**：把「第一个 case」换成 `opacity: 1`，仍然只有它失败 —— 变量是**先后**
     （首建 / 第二个窗口），不是 opacity。

   所以 run3 那一格更像「刚建好的窗口，view 的 surface 还没到位」的**建窗口瞬间竞态**，
   与 W24 记的「`addChildView` 之后约 100–250ms 才拿到 surface」同源。**没修**（不在本卡边界内，
   而且 `runner.ts` 的 `takeScreenshot` 已有窗口兜底 —— 这次连兜底窗口也拿不到，说明是更早的时刻）。

**这是本卡改完后仍然存在的红，下一张卡该查它。**

### 4. 变异结果

**变异**：把无副屏分支的两行改回 `x: wa.x + wa.width + 80, y: wa.y + wa.height + 80`
（`grep` 确认改了、`git diff` 确认落盘，才跑的套件）。

**预期红 2 条**（两条「落在 workArea 内」），**实际红 2 条，正是这两条**：

```
  ok   ★ 正控：inside() 认得出屏内的点（wa.x+20, wa.y+20）
  ok   ★ 正控：inside() 把旧的无副屏坐标（wa 右下再 +80）判为屏外
  FAIL 无副屏：窗口原点落在主屏 workArea 内 {"placement":{"x":1543,"y":903},"workArea":{"x":0,"y":0,"width":1463,"height":823}}
  ok   无副屏：note 不再说 offscreen，且说明没有副屏
  ok   无副屏：opacity 为 0（隐身靠它，不靠屏外位置）
  FAIL 无副屏（workArea 原点非零 1920,-200）：坐标仍落在该 workArea 内 {"placement":{"x":3463,"y":703},...}
  ...（副屏三条仍绿）
u1-placement-smoke:7/9 通过
```
**EXIT=1。正控全绿**（红的不是判据自己坏了）。

**还原**：`.tmp/w28-bak/runner.ts.bak` → `cp` 回，`sha256sum -c` **OK**、`cmp` 逐字节 **0**；
还原后重跑套件 **9/9 通过**，`grep "wa.x + wa.width"` 在文件里 **0 命中**。

**另外两处我主动做的、卡面没要求的验证**：

- **`opacity: 0` 不是「靠位置隐身」的替代品被误用**：正控 `inside()` 两个方向都认
  （屏内 true / 屏外 false），否则主判据在 `inside() === true` 恒真时静默全绿；
- **`tsc` EXIT=0**（`npx tsc --noEmit -p apps/desktop/tsconfig.json`；顺带用
  `grep -cE '(^|/)src/renderer/'` 核过 **0 条** —— O5 不在途）。

### 5. 我没能验证的东西

1. **副屏分支整条没有验证** —— 本机只有一块屏（`displays: 1`），那条分支在本机**不存在**。
   纯函数层面有 3 条断言（位置、note、`opacity === 1`），但**真 Electron 上没跑过一次**。
   特别是**「副屏 + `opacity: 0`」仍然是空白格**（W24 的探针全程单屏，也未测过）——
   所以我把副屏的 `opacity` 保持成 1，并在注释里写明「要改成 0 得先自己测一遍 capturePage 仍然成功」。
2. **`step-09-screenshot` 的 `Current display surface not available`**（run3）**只复现了 1 次**，
   我没有在该次现场抓到「view 是否已 attach / surface 是否已到位」的中间状态；
   上面的三个探针（raf / 长时 / 顺序）**不能证明**它就是「建窗口瞬间竞态」——
   **它们只排除了「opacity」和「时间退化」两个变量**。
3. **`t8` 的 `canvas-label-shows-rename` 抖动**：5 趟里 2 趟红（run1、run5），
   DOM 快照证明**失败时值已经在 DOM 里**，所以判据本身（`some(...includes(...))` 对整个集合求值）
   **大概率早了一帧**；但我**没有**改成 `waitFor`（那在 `journeys/` 里，不在本卡边界）。
4. **`t30` 的 `apps-discovery`（139→140）** 我只确认了「失败点前移到它」，
   **没有判断 140 是不是新的正确值**（W24 §4 说这需要有人决定，不在本卡范围）。
5. **`t7` 只跑了一次**（6/6 全绿），没有像 `t8` 那样连跑 5 趟检验抖动 ——
   所以「t7 是否有同源抖动」**没有数据**。

### 6. W24 / 这张卡上写错的地方

1. **卡面说「W24 实测过这个位置，临时改 + 跑 t30：截图步骤从 FAIL 变 PASS」——这条对，
   但它当时测的是「主屏内 (20,20)」这个**坐标**，不是「`opacity: 0` 跟位置同源」这个**设计**。**
   我按后者做了（`placement.opacity`），这是**超出卡面示例的结构改动**：
   理由是「屏内必须靠 opacity 隐身」这件事如果留在调用点，下一个改位置的人会再次把它们拆开
   （这正是本卡的病因形态）。**如果总控认为应该保留 `{x,y}` 的窄接口，把它改回去只需要删掉
   `opacity` 字段、在调用点写死 `opacity: 0` + 一行注释。**
2. **卡面 §「②」引用的行号 `runner.ts:869-870` 说的是旧文件的行号**；改完之后那段在
   `:899-910` 附近（我改完后整文件 +88/−38，行号会再漂）。**行号是写卡那一刻的坐标**，
   下一次读卡时按内容找（`没有实测过` / `副屏 + opacity 0`）比按行号可靠。
3. **卡面 §一 的示例返回 `{ x, y, note }`，没有 `opacity`**，而 §三 又说「那里加不加 `opacity`
   由你判断」—— 两节对「opacity 归谁管」不一致。我选了**归 `placement` 管**（理由见上），
   并在注释和本节都写清了。**这不是卡写错了，是卡没写清**；写下来是为了下一个人不用猜。
4. **W24 的矩阵少一格**：它的三格都是「窗口建好之后 +93/+122ms」，
   **没有「view 刚 attach、surface 还没到位」的时刻**。run3 的 `step-09-screenshot` 正落在这个缺口里。
   卡面引用矩阵时把它当成「位置 vs opacity 的完整二维表」，**实际上时间这一维是空的**。
5. **`(1543,855)` 这个逐字坐标今天已经不等于 `(1543,903)`**（workArea 高度从 815 变成 775）。
   卡面把它写成「无副屏分支的逐字坐标」—— 表达式是逐字的，**算出来的值不是**。
   任何把它当常量写死进断言的判据，换一台机器（或换一次任务栏高度）就会**假红或假绿**。
   我的断言用的是 `inside(placement, workArea)`，不写死数字。


---

## 附记：另一条同类缺陷（不属于本卡，但下一个读的人该知道）

**`t30/apps-discovery` 断言 `apps.totalTools !== 139` 现在红在 140。**
（`tasks/T30-document-tools-u1.md:52,79` 也写着 139 —— **文档和断言同源、同时过期**。）

**⚠️ 不要把 139 改成 140。** 那是「第四种判据失效」：**数字读对了、抓的也是真变化，
但「139 是对的」这个前提过期了。**

**同一步里已经有两条断言，正好是对照：**

```ts
if (docs.toolCount < 30) return { ok: false, ... };        // ← 守性质（下界）
if (apps.totalTools !== 139) return { ok: false, ... };    // ← 守数字（代理指标）
```

**`totalTools === 139` 真正想守的大概率是「工具目录完整、没丢、没重复」。**
它和今晚另一条 `adds - dels > 0` 判产物是同一族 —— **计数的代理指标**。

**正确的修法（不是本卡范围，归 T30 的 owner）：**

- 断言**目录里包含那批必须有的工具**（按名字 / 按 app 分组），而不是总数；
- 确要守总数，就把「当前快照 + 变更要人审」写进判据，**让 140 成为一个被决定过的值**，
  而不是被顺手改掉的值。

**自检**：「如果明年又多一个目录呢？」
- 断言性质 → 「只要新工具不破坏完整性，它还绿」← **是判据**
- 断言计数 → 「再改一次」← **是提醒**

---

## 总控验收（2026-10-25 02:00）

**结论：通过。而且我做了单文件回滚对照，证明它修的是真问题。**

### 一、我的对照实验（这是本卡的核心证据）

把 `runner.ts` 单独 `git stash` 回 HEAD，跑同一条旅程：

| 版本 | 结果 |
|---|---|
| **HEAD**（W28 之前） | **`EXIT=2`，红在 `canvas-editor-ready`** ← 窗口屏外的老症状 |
| **W28 版** | 截图步骤全 PASS，抖动红在 `canvas-label-shows-rename`（判据早一帧） |

**还原后 `sha256sum` = `cd1d5586...`，与它交付时逐字节一致。**

**所以：位置这条确实修好了，而抖动是另一个既有问题。**

### 二、我跑的验收

| 项 | 结果 |
|---|---|
| 新套件 `u1-placement-smoke` | 我自己跑：**PASS**，EXIT=0 |
| `tsc` | EXIT=0 |
| 改动范围 | 只 `runner.ts` + 新套件；`build.mjs` / `src/**` / `journeys/` 都没碰 |

### 三、它超出卡面的结构改动，我接受

它把 `placement` 加上 `opacity`（无副屏 → 0，副屏/兜底 → 1），**理由写在回写第 6 节且有回退方法**。

**我接受，因为**：卡面没写「opacity 该由谁定」，而实际它必须**随分支变** ——
无副屏要隐身（屏内位置），副屏不用（本来就不在主屏）。
把它放进 `placement` 比在 `createWindow` 里写条件清楚。

### 四、它做对的三处（都是我没要求的）

1. **把注释写成「条件 + 出处 + 后果」**，并且**在代码注释里写明「副屏 + opacity 0 未验证，
   要加得先自己测」** —— 这正是我被 W24 纠正的那条，它落到了代码里而不是只在卡里；
2. **纯函数 `chooseHostWindowPlacement` 导出**，判定逻辑只放一处，套件 import 真身；
3. **变异恰好红 2 条（预期 2 条）**，还原后 `sha256sum -c` + `cmp` + `grep` 三重核对。

### 五、它报的 t8 抖动：我确认不是它引入的

它说「5 趟只有 1 趟全绿」，两种红：`canvas-label-shows-rename` 和
`step-09-screenshot` 抛 `Current display surface not available`（generation 2，view 刚 attach 2ms）。

**它补了三个探针**：rAF 不被 `opacity:0` 节流（67 vs 67 帧）、capture 不随时间退化
（0.25–30s 全成功）、顺序对照证明变量是先后不是 opacity。

**我接受这个结论** —— 而且它自己说了「不是本卡改动的产物，但也没修（不在边界内）」。
**这是正确的边界判断。**

**抖动本身值得另一张卡**（W29）。

### 六、它如实说的「副屏分支完全没验证」

本机无副屏，所以副屏分支的坐标与 `opacity` 都没跑过。
**它在代码注释里写明了「要往副屏窗口加 opacity，得先自己测一遍」** —— 这是对的。
