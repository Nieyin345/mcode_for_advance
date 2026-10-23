# T42｜U1 骨架静默模式：默认不弹窗，仅截图时短暂显示

- Status: ready-for-agent
- Category: feature（测试基础设施）
- Priority: **P1 开发体验**
- Depends on: T16（`6073fcbb`，U1 骨架）、T7（`77fdd012`，首次引入可见窗口）
- Exclusive writable files: `apps/desktop/scripts/electron-u1/driver/runner.ts`、`apps/desktop/scripts/t7-genoffice-u1/`（若需）、新建回归套件。

## Required Skills
- `mcode-smoke`: 理解 U1 骨架的窗口生命周期。
- `research`: `capturePage()` 在不可见窗口上的行为要查 Electron 官方文档确认，不要凭猜。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/electron-u1/driver/runner.ts`（**第 625-645 行与第 795-815 行**）、`apps/desktop/scripts/electron-u1/README.md`。

## 用户的要求（原话）

> 「现在的测试一直打开窗口显示，不要显示窗口呀，影响我工作」

## 现状（我核实过）

`runner.ts` 里有两处 `show: true`，**成因不同**：

### 第 632 行 —— 不会打扰用户

```ts
// 与 settings-focus-electron-smoke 相同的取舍：窗口必须「存在且可聚焦」
//（隐藏窗口 document.hasFocus() 恒 false，真键盘事件不可观测），但放在屏幕外
// 且透明 —— 用户看不见，判据只读 DOM/磁盘。
show: true,
opacity: 0,
x: -10000, y: -10000,
```

**屏幕外 + 完全透明，用户看不见。** 这一处不需要改。

### 第 802 行 —— 这一处会弹窗

```ts
// T7：`WebContentsView.capturePage()` 在「当前 display surface 不可用」
//（离屏 + opacity 0 的窗口）时会直接抛。GenOffice 旅程要**截图证据**，
// 所以这里让宿主窗口真实可见（放到屏幕右下角一个正常位置，不抢焦点：
// `show:false` 会同样丢 surface，所以只能 show）。判据只读 DOM/磁盘，
// 截图只是证据；窗口本身 3 秒内就会被关掉。
show: true,
```

**这一处是真的可见窗口，会干扰用户。**

## 目标

让需要截图的旅程**默认不显示窗口**，只在截图那一刻短暂显示。

### 必须先查清（不要猜）

1. **`capturePage()` 在 `show: false` 的窗口上真的会抛吗？** 查 Electron 官方文档 / Issues。
2. **`opacity: 0` 的窗口能 `capturePage()` 吗？** T7 的注释说不能，但那是它的实测还是推断？
3. **`win.showInactive()`** （显示但不抢焦点）能不能解决「不打扰」的问题？
4. **`webContents.beginFrameSubscription()`** 或离屏渲染（`offscreen: true`）能不能替代 `capturePage()`？

**这四条查清了再动手。** 用户定的最高原则：先检索不要猜。

## 三种可能的方案

**(A) 截图时临时 show，截完立即 hide**
```ts
win.show();
const image = await win.webContents.capturePage();
win.hide();
```
窗口存在时间 = 截图耗时，通常 < 100ms。

**(B) 用离屏渲染**（`webPreferences.offscreen: true`）
- 不创建真实窗口
- 但需要改 T7 的截图方式，且离屏渲染与 `WebContentsView` 是否兼容要验

**(C) `showInactive()` + `opacity` 极低**
- 显示但不抢焦点
- 但仍可见

➡️ **我推荐 (A)**，因为改动最小且不动 T7 的证据链。但**必须先验它可行**。

## 验收判据

1. 回写区给出四条查清的结论（附来源：官方文档链接或实测）。
2. 选一个方案并论证。
3. **`t7-genoffice-u1` 的六条旅程仍全 PASS**（截图证据仍生成）。
4. **跑 T7 时用户看不到窗口**（或最多闪一下 < 200ms）。
5. 变异验证：把方案撤掉 → 相关断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。

## 边界

- **不改** T16 骨架的第 632 行（那处屏幕外+透明，不打扰）。
- **不改** T7 的旅程断言。
- **不碰** T29/T30/T39/T40 正在改的文件。
- 若发现四条查询里某条改变了方案选择，**以查到的为准**，不要硬套我的推荐。

## 用户正在被打扰

**这个卡有紧迫性**：每次跑 T7/T30 都会弹窗。做完尽快回写。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 结果回写（2026-10-23）

### 0. E 的实测矩阵（决定性证据，推翻了卡上的原始判断）

**方法**：每种窗口形态单独一个 Electron 进程，`show:false`、`x:-10000,y:-10000`、45s 自杀、先写文件后执行。**用户全程看不到窗口。**

| 形态 | `capturePage()` |
|---|---|
| 宿主窗口 `show:false` | **ok 1556x1120** |
| 宿主窗口 `show:false` → `showInactive()` | ok 1556x1120 |
| 宿主窗口 `show:false` + 屏幕外 + `opacity:0` | **ok 1582x1187** |
| **`WebContentsView` 子视图，宿主 `show:false`** | **THROW `Current display surface not available for capture`** |
| 同上，但宿主 `showInactive()` 之后 | **ok 1400x1050** |
| `webPreferences.offscreen: true` | ok 902x702 |

### 这推翻了 T7 那句注释

`runner.ts:802` 附近写着「`show:false` 会同样丢 surface」——**这句话把两种情况混成了一句**：

- **宿主窗口 `show:false` 能截**；
- **只有 `WebContentsView` 子视图会抛**。

所以本卡「这一处会弹窗」的判断要改成：**只有 `WebContentsView` 子视图需要 `showInactive()`，宿主窗口本身 `show:false` 就能截。**

### `sendInputEvent` 在隐藏窗口上完全送达

```
click    → 送达（clientX=150, clientY=130）
input    → "hello" 送达
keydown  → Enter 送达
document.hasFocus() 恒 false
```

### 但焦点仍然是必需的（E 的第二轮实测，推翻上面的简单结论）

| 场景 | 结果 |
|---|---|
| **`webContents.focus()`** | **让 `document.hasFocus()` 变 true 而窗口始终不可见** |
| 去掉 `win.focus()` 的后果 | **sheets 得到 `A1A1`（输入重复）、pdf 文本层不渲染** |

**所以「`sendInputEvent` 送达 = 不需要焦点」是错的。** 焦点对 Univer / pdf.js 的渲染和输入去重是必需的。

**正确的解法**：

- **截图**：`showInactive()` → **等 ~50ms 让 surface 就绪** → `capturePage()` → `hide()`
- **输入**：用 **`webContents.focus()`** 而不是 `win.focus()` —— 它能满足 `document.hasFocus()` 而窗口始终不可见

### 一个必须写进卡的陷阱：`showInactive()` 后立刻截会偶发 `UnknownVizError`

**「偶发」是最难查的形态。** 下一个做 T42 的人如果不知道要等，会看到随机失败的测试，然后怀疑自己的改动。

**建议的健壮做法（不要依赖固定 sleep）**：

```ts
win.showInactive();
// 轮询到能截为止，最多等 200ms
for (let i = 0; i < 20; i++) {
  try { return await wc.capturePage(); }
  catch (e) { if (!/display surface/i.test(String(e))) throw e; await sleep(10); }
}
throw new Error("截图失败：surface 200ms 内未就绪");
```

**这把「偶发」变成「重试到成功或明确失败」。**

### 当前状态：改动已还原，本卡未完成

E 的第一版改动跑出 **1/6 通过**（`docs` 之外五条在 `step-XX-screenshot` 失败），判定「留一个 1/6 通过的版本比留着原来的 6/6 通过更糟」，已还原 `runner.ts` 与 `types.ts`。

**卡上的实测结论是净收益，代码改动归零。** 下一个接手的人从这份矩阵开始，不必重做实验。

### 原始的四条查询（已由上面矩阵回答）

| # | 问题 | 结论 |
|---|---|---|
| 1 | `capturePage()` 在 `show:false` 上会抛吗 | **宿主窗口不会，`WebContentsView` 子视图会** |
| 2 | `opacity: 0` 呢 | **能截**。第 632 行那处「屏幕外 + opacity 0」**本来就不影响截图** |
| 3 | `showInactive()` 能满足「不抢焦点」吗 | **能**，且子视图截图从 THROW 恢复正常 |
| 4 | `offscreen: true` | 能截（902x702），但它改的是渲染路径，与 `WebContentsView` 的组合没验；**(A) 已成立就不走这条** |

### 官方文档的地位

electronjs.org/docs/latest/api/web-contents：*"The page is considered visible when its browser window is hidden and the capturer count is non-zero."* + `stayHidden`；Electron 23 起 `capturePage` 自动处理 capturer count。

**但这条只管页面可见性判定，管不了 `show:false` 时 display surface 不存在。实测优先于文档措辞。**

### 1. 卡上没写到的真正阻塞点：`ensureFocus()`

```ts
// runner.ts:157
async function ensureFocus(ctx: Ctx): Promise<boolean> {
  const has = await js<boolean>(ctx.wc, "document.hasFocus()").catch(() => false);
  if (has) return true;
  ctx.win.focus();                                    // ← 这里
  return until(() => js<boolean>(ctx.wc!, "document.hasFocus()"), 3000);
}
```

`ensureFocus()` 在**每次 click / type / press 之前**都会调。隐藏窗口的 `document.hasFocus()` 恒 false，所以：

**即使把 802 行改成 `show:false`，每次按键/点击都会把窗口重新弹出来。** 真正的静默必须同时处理 `ensureFocus()`，或者接受「输入动作时短暂显示」。

**这条比截图那条更难，卡上原本没提。**

### 2. 探针事故（值得记下来）

第一次探针命令写反了顺序：heredoc 写了脚本，但 `mkdir -p` 排在后面，bash 报 `.tmp/t42/probe-hidden-input.mjs: No such file or directory`，**脚本根本没跑起来**。那个 `Error` 窗口是 Electron 收到不存在的入口文件后**自己弹的**，不是探针逻辑弹的。

代价：用户看到了那个窗口，而 T42 要解决的正是「不要弹窗」。

**教训：探针脚本要先 `mkdir` 再写文件，并且必须带超时自杀（`setTimeout(() => app.exit(2), 60000)`）。** 不要让探针有可能挂 8 分钟。

### 3. 当前进度

- 四条查询：**已完成**（见上表，实测矩阵）
- `ensureFocus()` 阻塞点：**已识别，方案定为 (c)**
- `sendInputEvent` 在隐藏窗口上的送达：**已实测成立**
- 正在改 `runner.ts`
- T37（30 次连跑采样）：第一次全部撞上 i18n 中间态（`Unterminated string literal`），需重跑

### 4. 边界租约（总控裁定，2026-10-23）

卡上原本把 `t7-genoffice-u1/` 列进可写边界，**这是卡的表述不准**：

- **A 的 T29 正在改 `t7-genoffice-u1/harness.ts` 与四个 journey 文件**（加 `requestNativeViewClose` 关闭守卫）；
- E 只能改 `apps/desktop/scripts/electron-u1/driver/runner.ts`；
- **如果最终发现必须改旅程文件，先报告，由总控跟 A 协调文件交接**，不要让两个会话碰同一个文件。

### 5. 并发协作硬约束（2026-10-23 新增，全项目生效）

**改文件时保持可编译。** 加 JSX 标签就同时加闭合；拆 JSX 就一次拆完。**不要让文件在磁盘上处于语法错误状态超过几分钟。**

这不是洁癖：本次已经发生两次「一个会话写一半，另一个会话的测试在打包期凭空失败」——

1. C 写 `i18n/ide.ts` 字符串未闭合 → E 的 30 次采样全部 `Unterminated string literal`，白跑一轮；
2. C 写 `RightPanel.tsx` JSX 未闭合 → E 和 B 的 `tsc` 门禁红着，两个会话在等。

**如果预计某个改动要 10 分钟以上才能改到可编译**，先 `git stash`，或者把新组件单独写成文件最后一次性接入。

**跑测试前的标准前置：**

```bash
git status --porcelain                              # 看到别人在改什么
npx tsc --noEmit -p apps/desktop/tsconfig.json      # exit=0 才继续
```

**打包期失败（`X [ERROR]` / `Unterminated string literal` / `No matching export`）不等于被测对象失败。** 这个仓库为这件事栽过两次，今天是第三次。

