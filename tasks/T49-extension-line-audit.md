# T49｜扩展线核实 —— **撞出主界面首帧白屏的真缺陷**

- Status: **done（2026-10-23 验收通过：7/7，提交 `fde4195b`）**
- Category: bug（P0 产品缺陷）+ 核实
- Depends on: T41（`db4415f7` 修了「回包存在但 modules 缺失」，漏了「回包还没到」）

## 总控给的三个假设，两条错一条对

派活时我列了扩展线回写里说的三条「没做」：

| # | 我说 | A 的实测判定 |
|---|---|---|
| ① | `storageModule` 注入 | **串了线** —— 全仓 `grep storageModule` → 生产/契约代码 **0 处**，只在 T14/T21 的**文字**里，且指的是 **Node-RED** 的 storage 注入点 |
| ② | 无工坊状态面板 | **部分成立，不阻塞** —— 已有 `ModuleSettingsPanel` / `CapabilityCatalogPanel` / `ModuleViewDock`；缺的是「已装扩展列表 + 健康/权限/最近调用」的管理汇总 |
| ③ | 真 Electron U1 | **可接受的取舍** —— 扩展 UI 不依赖 OS 焦点/多窗口/原生弹窗（与 T46 审批卡不同），E1 够用 |

**①是总控串了线**：把 Node-RED 的 `storageModule` 当成了扩展线的缺口。

## 真正撞出来的缺陷：主界面首帧白屏

A 跑了 29 个 extension/module 套件，**28 绿 / 1 红**。红的 `module-contributions-smoke`（exit=1）**不是套件自己的问题**：

```
TypeError: Cannot read properties of undefined (reading 'modules')
    at contributionsOf (moduleCatalogShape.tsx:52)
```

### 根因

- `useRpc` 的 `data` 在**首次请求成功前恒为 `undefined`**（契约写明）；
- 四个生产调用点直接把它传进去：`RightPanel:123`（**主界面右栏，常驻、渲染期调用、无错误边界**）、`CommandPalette:208`、`ModuleContributions:35`、`:145`；
- `contributionsOf` 注释承诺「形状不对时返回空而不是抛」，但它问的 `moduleCatalogShapeError` 把 `undefined` 判成**「加载态」**返回 `null`，紧接着 `catalog!.modules` 直接解引用 → 抛。

**后果：主界面首帧白屏。**

**T41 当初就为这个场景写了「不炸」的承诺，只挡住了「回包存在但 `modules` 缺失」，漏了「回包还没到」。**

### 修法

```ts
if (catalog === undefined || moduleCatalogShapeError(catalog) !== null) return [];
return catalog.modules.flatMap(...);   // 去掉 catalog!
```

**没改 `moduleCatalogShapeError` 的语义**（`undefined → null` 是对的，`ModuleCatalogNotice` 靠它区分加载态与坏数据）。

## 验证

**新套件 `t49-contributions-undefined-smoke`：7/7。**

- **不手抄实现** —— 按源码结构从生产文件切出两个纯函数，交给 esbuild 转译后 import 真产物；
- 含**正向对照**（正常目录仍返回 1 条贡献，防止修成「永远返回空」）。

**修前同一套件：6/7**，红的正是首帧那条，`threw: "TypeError: ... reading 'modules'"`。

**变异**：撤掉 `catalog === undefined` → 1 红（缺陷原文）→ `cmp` 逐字节还原 → 7/7。

**回归**：`module-contributions-smoke` **由红转绿**（exit=1 → exit=0），另五个模块套件全绿；双包 `tsc` exit 0。

## 未做的

- **没硬造状态面板** —— 按总控的判据（用户能不能用），它不阻塞，而真正阻塞的白屏已经撞出来了；
- **没做真 Electron U1** —— 新套件只在无头 node 里跑。缺陷的**存在**由 `module-contributions-smoke` 的真实 UI 树崩溃证明，修复的**充分性**由同一套件转绿佐证。

## 总控的教训

**三条假设里，一条串线（①）、一条被判定为不阻塞（②）、一条被判定为可接受取舍（③）。**

**A 没有硬造面板，而是跑了 29 个套件，撞出了一个我完全没预料到的缺陷。**

**这是今天最好的一次任务理解**：给的是「核实扩展线」，做的是「跑全部套件找真红」，而不是按我的三条假设逐条交差。
