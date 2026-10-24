# W28｜单屏机器上，U1 骨架永远红：无副屏分支把窗口摆到了所有显示器之外

- Status: ready-for-agent
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
