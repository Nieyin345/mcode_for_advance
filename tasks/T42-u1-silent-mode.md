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

## 回写

在 `tasks/T42-u1-silent-mode.md` 末尾追加 `## 结果回写（2026-10-23）`：四条查询结果与来源、方案选择、T7 六旅程验证、窗口可见性证据、变异证据、提交 SHA。
