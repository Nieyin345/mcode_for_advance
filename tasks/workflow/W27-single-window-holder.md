# W27｜`window-holder` 有两份：一份是真身，一份是副本

- Status: ready-for-agent
- Category: **技术债（「共享实现只有一份」的反面）**
- Priority: **P2 —— W24 已用权宜之计绕过，但重复还在**
- Depends on: W24（已交付）
- 来源：W24 的补记

## 事实（我核实过）

```
$ ls -l t30/window-holder.ts t7/window-holder.ts
3472  t30-document-tools-u1/window-holder.ts
1743  t7-genoffice-u1/window-holder.ts        ← 不是同一份
```

`t30` 那份多两个 no-op：

```
updateTitleBarOverlay()
createMainWindow()
```

**而两条 import 路径把两份都带进了同一个 bundle：**

| 谁 | 怎么 import | 落到哪份 |
|---|---|---|
| `t7/harness.ts` 的 `setMainWindowForU1(win)` | 相对路径 `./window-holder.js` | **T7 那份** |
| 生产 `documentViewHost.liveWindow()` | esbuild alias `@main/window.js` | **t30 那份** |

**harness 写进一份，生产单例从另一份读 → `getMainWindow()` 永远 null →
「主窗口尚未就绪，无法创建文档视图」。**

**`o0` / `o4` 没有这个问题** —— 它们的 alias 指向 `t7` 那份，和它们 import 的 harness 是同一份。

## W24 做了什么（权宜之计）

让 `t30` 那份**去读 `t7` 那份**，并在 `set` 时两边都写：

```ts
export function getMainWindow(): BrowserWindow | null {
  const fromT7 = t7Holder.getMainWindow?.() ?? null;
  if (fromT7 !== null && !fromT7.isDestroyed()) return fromT7;
  ...
```

**这解决了症状，但两份仍然存在。** 它的理由是「改 `t7` 的交付物超出边界，且 t30 那份多两个方法」。

## 任务：只留一份

### 一、把两个 no-op 补进 `t7-genoffice-u1/window-holder.ts`

**这是 `t30` 那份的原文（我抄自 `t30-document-tools-u1/window-holder.ts:64-72`）——
照它抄，包括抛错文案：**

```ts
/** `lib/theme.ts` 顶层的 import；探针不画标题栏，空实现即可。 */
export function updateTitleBarOverlay(): void {}

/** 探针不起主窗口（窗口由 T16 runner 建）；import 到了这里说明有模块在启动期建窗。 */
export function createMainWindow(): never {
  throw new Error("T30: 探针不创建主窗口（由 U1 runner 负责）");
}
```

**照抄时改一下第一句注释的主语**（它现在在 `t7` 那份里，不再只是 t30 的事）。

### 二、把 `t30` 的 alias 改成指向 `t7` 那份

`t30/vendor-esbuild.mjs:26`：

```ts
"@main/window.js": resolve("scripts/t30-document-tools-u1/window-holder.ts"),
```

改成与 `o0` 同形：

```ts
"@main/window.js": resolve("../desktop/scripts/t7-genoffice-u1/window-holder.ts"),
```

### 三、删掉 `t30/window-holder.ts`

**删之前先确认「没有别的东西 import 它」**：

```bash
grep -rn "t30-document-tools-u1/window-holder" apps/desktop/scripts/
```

### 四、把 W24 那段「先读 T7 那份」的代码也删掉

它是因为「两份并存」才需要的。**只留一份之后它就是多余的**，留着会让下一个人以为还有两份。

## 验收判据

1. **bundle 里只剩一份 `window_holder`**：

   ```bash
   cd apps/desktop
   node scripts/t30-document-tools-u1/run.mjs   # 先让它构建一次
   grep -c "function setMainWindowForU1" <构建产物里的 journeys.cjs>
   ```

   **期望 1**（现在是 2）。

2. **`setMainWindowForU1` 写进去的窗口，`getMainWindow()` 读得到** ——
   一条直接断言，不依赖 Electron；
3. **`t30` 的三条产品旅程不再报「主窗口尚未就绪」**（如果环境允许）；
4. **`o0` / `o4` 不回归**（它们的 alias 本来就指向 `t7`）；
5. `tsc` EXIT=0；
6. **不跑全量**。

## 边界

**可以改：**

- `apps/desktop/scripts/t7-genoffice-u1/window-holder.ts`
- `apps/desktop/scripts/t30-document-tools-u1/vendor-esbuild.mjs`
- `apps/desktop/scripts/t30-document-tools-u1/window-holder.ts`（**删**）
- `apps/desktop/scripts/t30-document-tools-u1/*.ts`（若 import 需要改）

**不许碰：**

- `apps/desktop/src/**`
- 其它套件的 `window-holder` / `windowStub`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

## 回写

`tasks/workflow/W27-single-window-holder.md` 末尾追加 `## 结果回写`：

1. `grep -c` 的实测（改前 2、改后 1）；
2. 那两个 no-op 是从哪抄的（贴 `t30` 原实现）；
3. `o0` / `o4` 的回归结果；
4. **你没能验证的东西**；
5. **卡上写错的地方**。

## 一条判断标准

**「注释说复用，实际复制」比「完全没复用」更危险** ——
因为读注释的人会以为只有一份，**而调试时会发现「我明明设置了它」**。

`t30` 的 `window-holder.ts` 注释原文就写着「直接复用 T7 的」。
