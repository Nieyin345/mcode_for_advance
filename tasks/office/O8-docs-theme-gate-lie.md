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

## 四、▲ 2026-10-24 补充：这行**不能整体替换**（附实测数字）

`genoffice/apps/docs/src/renderer/main.tsx` 里 `window.desktop` 有 **13 处**
（**其中 1 处是第 22 行的注释，代码里 12 处**）：
`convertAltChunkHtml` / `getLanguage` / `getTheme` / `getDocumentTheme` /
`onThemeChanged` / `onDocumentThemeChanged` / `onAiPanelPrefsChanged` /
`onAuthorNameChanged` …

**而整个 `docs/src/renderer/` 有 127 处、17 个文件**（实测，命令见 §四.1）：

```
38  App.tsx                          8  ai/tools.ts
23  ai/AiPanel.tsx                   6  components/ContextMenu.tsx
18  file-actions.ts                  5  ai/transport.ts
13  main.tsx                         4  components/ribbon-tabs.tsx
 3  ui-theme.ts                     …其余 8 个文件各 1-2 处
```

**那些都是对的** —— 它们问的是「这个命名空间有没有某个能力」，答案在独立 docs 里也是「有」。
`AiPanel.tsx:411` 还专门写了 `if (typeof window.desktop?.kbList !== 'function')` ——
**那是在探测能力存不存在，正是 `window.desktop` 该干的事。**

**只有 `main.tsx:26` 那个 `import('./mcode-theme.css')` 问错了问题。**

**所以修法是「把那一个 if 的条件换掉」，不是「把 window.desktop 全换掉」。**
如果有人把 127 处一起改了，那是另一个 bug（docs 的 AI 面板、主题、作者名、右键菜单、
打印、审阅操作会全部失效）。

### 4.1 ★ 这个数字是怎么数的（写卡人自己跑过）

```bash
grep -rn "window\.desktop" genoffice/apps/docs/src/renderer/ --include=*.tsx --include=*.ts | wc -l
# → 127
grep -rln "window\.desktop" genoffice/apps/docs/src/renderer/ --include=*.tsx --include=*.ts \
  | while read f; do echo "$(grep -c 'window\.desktop' "$f")  $f"; done | sort -rn
```

**为什么要写这两个命令**：我第一版卡里写的是「10 处」，**实测是 13 处（main.tsx）、127 处（整个 renderer）**。
**一个数量级都没对。** 如果执行者按「10 处」去估工作量，会以为这是个局部改动；
按 127 处去估，会知道**只能改一行**。

**这正是 CLAUDE.md 那条**：「卡里凡是出现①代码示例②数字③『文件里有 X / 没有 Y』，
写卡人必须自己跑一遍。」**我这次没跑，写错了，事后补的。**

## 五、判据

### 5.1 硬判据（必须真 Electron）

| # | 断言 | 防的是什么 |
|---|---|---|
| 1 | **宿主里**打开 docs → `document.styleSheets` 里**有** `mcode-theme` | **「恒 false」** —— 一个从不换壳的实现也能过判据 2 |
| 2 | **独立 GenOffice 里**打开 docs（app 名非 Mcode）→ **没有** `mcode-theme` | **本卡要修的缺陷** |
| **1b** | **宿主里 `window.desktop` 的那些能力仍然工作**（至少验 `getTheme` 与 `onAiPanelPrefsChanged` 各一次） | **「把 127 处一起改了」** —— 见 §四 |
| 3 | 三条都在**真 Electron** 里跑，**不是读源码** | **「形状 ≠ 行为」** —— 0014 就栽在这 |

**⚠️ 判据 1 和 2 缺一不可。**

**只有 2** → 把开关改成恒 `false` 就能过，**那不是一个修复，是换了一个 bug**
（用户永远看不到 Mcode 的配色，而套件全绿）。

**只有 1** → 现在的缺陷照样存在（独立运行时也换壳）。

**判据 2 是这张卡存在的理由。** 没有它，就只是把开关换了个说法。

**1b 是 2026-10-24 新加的** —— 它防的是「改对了一处、改坏了另外 126 处」。

### 5.2 换什么开关

**O6 的执行会话实测的 UA 判据**（同一份产物）：

| app 名 | UA |
|---|---|
| `GenOffice HTML` | `GenOfficeHTML/44.4.5` |
| `Mcode` | `Mcode/44.4.5` |

**`apps/desktop/src/main/index.ts:101` 有 `app.setName("Mcode")`**（我核过）。

```ts
// docs/src/renderer/main.tsx:26
if (/\bMcode\//.test(navigator.userAgent)) import('./mcode-theme.css')
```

**理由**：UA 问的是「谁在跑我」。`window.desktop` 问的是「我是谁」，而那个答案在独立运行时也是「是」。

**⚠️ 换开关不等于修好了** —— 必须用 5.1 的判据 2 验。**否则就是从「一个坏开关」换成「一个没人验过的好开关」。**

## 六、变异

1. **把开关改回 `if (window.desktop)`** → 判据 2 必须红（证明判据真的在验区分）；
2. **把开关改成恒 `true`** → 判据 2 必须红；
3. **把开关改成恒 `false`** → 判据 1 必须红（证明它没变成「永远不换壳」）；
4. **把 `getTheme` 那处也改成 UA 判断**（模拟「改多了」）→ **判据 1b 必须红**。

**四个都要，因为**：
- 只有 1 → 证明不了「UA 比 desktop 强」；
- 没有 3 → 「恒 false」会让判据 2 绿着，而功能全没了；
- **没有 4 → 判据 1b 是一条从没红过的断言**（而它保护的正是本次改动最可能伤到的东西）。

## 七、写给执行者的一条

**这条改动的风险不是「做错」，是「做得看起来对」**：

- 代码改一行，看起来显然对；
- 套件可以断言源码里有那行，全绿；
- **而唯一能证明它的是「真的开两个 app 看 styleSheets」。**

**所以如果你只做了「改一行 + 断言源码形状」，请如实说「我只改了开关，没验区分」。**
**那比做一个假验好。**

## 八、边界

- 改 `genoffice/apps/docs/src/renderer/main.tsx`（**只有第 26 行**）+ 新建套件
- **不改** `mcode-theme.css` 的内容（它没问题）
- **不改** 其余 **126 处** `window.desktop`（12 处在 `main.tsx`、115 处在另外 16 个文件）
- **不动** `apps/desktop/**`（除 vendor 账本：新补丁要进 `build/genoffice-upstream.lock.json`
  与 `verify-genoffice-upstream.cjs`，T39/T115/O6 先例）

**⚠️ 与 O6 批二的边界**：O6 正在改 `genoffice/apps/{pdf,slides,sheets}/src/**`。
**本卡只碰 `genoffice/apps/docs/src/renderer/main.tsx`，不重叠** —— 但两边都要
改 vendor 账本，**提交时只 `git add` 自己的补丁文件，不要 `git add -A`**。

## 九、套件怎么建（照 O6 批一，它已经证明可行）

`apps/desktop/scripts/o6-reshell-html-smoke/` 的三个文件可以直接复制改：
- `build.mjs` —— 构建产物；
- `probe.cjs` —— **在 require vendor 入口之前用 Proxy 替换 `BrowserWindow`**，强制
  `show:false` + `skipTaskbar:true`（**套件窗口不会弹到用户屏幕上**）；
- `run.sh` —— `HERE=$(cd "$(dirname "$0")" && pwd)` 再 `cd "$HERE/../.."`。

**两次运行只改 `app.setName()`** —— 差异只可能来自开关。

**目录名必须以 `-smoke` 结尾**，否则 `smokes-for.py:331-332` 的发现器不认它。

## 十、结果回写区

（执行会话追加：改的那一行、真 Electron 两个 app 的 styleSheets 结果、1b 的验证方式、四个变异、提交 SHA、补丁文件名）
