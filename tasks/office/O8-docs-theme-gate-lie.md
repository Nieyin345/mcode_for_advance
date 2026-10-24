# O8｜docs 的换壳开关（0014）在独立运行时也生效 —— 它承诺过不该这样

- Status: **ready-for-agent**
- Category: **Office / 上游承诺未兑现**
- Priority: **P1 —— 它不坏功能，但它让「独立运行的 GenOffice」和「宿主的 GenOffice」看起来一样**
- Depends on: `05da63c`（0014，docs 换壳）、O6（本卡是 O6 的同族，但对象是 docs）

## 一、缺陷（O6 的执行会话实测，我核实过）

**0014 的注释明确承诺**：

> 加载方式 `if (window.desktop) import('./mcode-theme.css')` ——
> **单独跑 GenOffice 时不换壳**
> **Scope is deliberately narrow** … **standalone GenOffice keeps its own Word visual.**

**而实测**：docs 独立运行时（构建产物 + 原厂 preload，app 名非 Mcode），
**`window.desktop === "object"`**，且 `document.styleSheets` 里出现 `mcode-theme-D7J2bBPx.css`。

**所以独立 docs 也被换壳了。**

## 二、根因

`window.desktop` 是 **docs 自己的命名空间**，不是「宿主存在」的标志：

```
genoffice/apps/docs/src/preload/index.ts:284      exposeInMainWorld('desktop', api)     ← 独立运行时也有
genoffice/apps/html/src/preload/index.ts:132      exposeInMainWorld('htmlApi', api)
genoffice/apps/markdown/src/preload/index.ts:164  exposeInMainWorld('markdownApi', api)
```

**`if (window.desktop)` 问的是「我是谁」，不是「谁在跑我」。**

## 三、为什么 0014 的套件没抓到

**它的断言是「源码里有 `if (window.desktop)` 这个形状」，不是「它真的区分了」。**

**源码形状 ≠ 行为。** 这正是今天反复出现的形态：
**断言验的是「代码长什么样」，不是「它做到了什么」。**

## 四、判据

### 4.1 硬判据（必须真 Electron）

| # | 断言 | 防的是什么 |
|---|---|---|
| 1 | **宿主里**打开 docs → `document.styleSheets` 里**有** `mcode-theme` | **「恒 false」** —— 一个从不换壳的实现也能过判据 2 |
| 2 | **独立 GenOffice 里**打开 docs（app 名非 Mcode）→ **没有** `mcode-theme` | **本卡要修的缺陷** |
| 3 | 两条都在**真 Electron** 里跑，**不是读源码** | **「形状 ≠ 行为」** —— 0014 就栽在这 |

**⚠️ 判据 1 和 2 缺一不可。**

**只有 2** → 把开关改成恒 `false` 就能过，**那不是一个修复，是换了一个 bug**
（用户永远看不到 Mcode 的配色，而套件全绿）。

**只有 1** → 现在的缺陷照样存在（独立运行时也换壳）。

**判据 2 是这张卡存在的理由。** 没有它，就只是把开关换了个说法。

### 4.2 换什么开关

**O6 的执行会话实测的 UA 判据**（同一份产物）：

| app 名 | UA |
|---|---|
| `GenOffice HTML` | `GenOfficeHTML/44.4.5` |
| `Mcode` | `Mcode/44.4.5` |

**`apps/desktop/src/main/index.ts:101` 有 `app.setName("Mcode")`**（我核过）。

```ts
// docs/src/renderer/main.tsx
if (/\bMcode\//.test(navigator.userAgent)) import('./mcode-theme.css')
```

**理由**：UA 问的是「谁在跑我」。`window.desktop` 问的是「我是谁」，而那个答案在独立运行时也是「是」。

**⚠️ 换开关不等于修好了** —— 必须用 4.1 的判据 2 验。**否则就是从「一个坏开关」换成「一个没人验过的好开关」。**

## 五、变异

1. **把开关改回 `if (window.desktop)`** → 判据 2 必须红（证明判据真的在验区分）；
2. **把开关改成恒 `true`** → 判据 2 必须红；
3. **把开关改成恒 `false`** → 判据 1 必须红（证明它没变成「永远不换壳」）。

**三个都要，因为**：
- 只有 1 → 证明不了「UA 比 desktop 强」；
- 没有 3 → 「恒 false」会让判据 2 绿着，而功能全没了。

## 六、写给执行者的一条

**这条改动的风险不是「做错」，是「做得看起来对」**：

- 代码改一行，看起来显然对；
- 套件可以断言源码里有那行，全绿；
- **而唯一能证明它的是「真的开两个 app 看 styleSheets」。**

**所以如果你只做了「改一行 + 断言源码形状」，请如实说「我只改了开关，没验区分」。**
**那比做一个假验好。**

## 七、边界

- 改 `genoffice/apps/docs/src/renderer/main.tsx`（一行）+ 新建套件
- **不改** `mcode-theme.css` 的内容（它没问题）
- **不动** `apps/desktop/**`

## 八、结果回写区

（执行会话追加：改的那一行、真 Electron 两个 app 的 styleSheets 结果、三个变异、提交 SHA）
