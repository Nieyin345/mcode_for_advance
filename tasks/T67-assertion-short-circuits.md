# T67｜修掉三处 `|| true` 让断言真正生效

- Status: ready-for-agent
- Category: **bug（测试基础设施 / 断言完整性）**
- Priority: P1
- Depends on: T61（审计报告 `docs/planning/assertion-integrity-audit.md`）
- Exclusive writable files:
  - `apps/desktop/scripts/t43-document-ai-design-pipeline-smoke/main.ts`
  - `apps/desktop/scripts/settings-form-lifecycle-smoke/main.ts`
  - `apps/desktop/scripts/t24-document-tool-surface-smoke/main.ts`

## Required Skills
- `mcode-smoke`：理解这套无头 smoke 的断言写法与变异验证。
- `code-review`：判断「去掉 `|| true` 之后该红还是该绿」，不要把断言改弱。

## 背景

T61 的两轮审计查出 5 个空过，其中 3 处是 `|| true` 短路。本卡只修这 3 处，
**不碰其余两个**（那两个是 `includes(源码文本)` 的取证方法问题，修法完全不同，
由 T68 / T64 处理）。

---

## 零、总控落盘前核实的事实（**动笔前先读这一节**）

> 下面四条是总控在 2026-10-23 落盘本卡时**实测**的，用于纠正卡稿里的三处事实错误。
> 如果你发现代码又变了，以代码为准，并在回写区记下差异。

### 0.1 `insert_table` 不存在 —— 卡稿里的正向断言写错了

卡稿原文要求「至少有一个工具的名字**本身**含 `table`（例如 `insert_table`）」。
**实测：catalog 里 docs 下 40 个工具，没有一个名字含 `table`。**

```
$ node .tmp/t67-probe.cjs        # 探针逻辑见 0.2
总条目: 139
app=docs, query=table 命中: 2
  - read_revisions | name命中: false | doc命中: true
  - define_style   | name命中: false | doc命中: true
docs 下有任何 name 含 table 的工具吗: false
```

**所以那条正向断言会必然失败，不能照抄。** 替代方案见 §三。

### 0.2 `table` 这个查询词的真实命中（这是 §三 的取证基线）

`searchDocumentTools(app, query)` 的真实语义（`documentToolSurface.ts:181-188`）：

```ts
const q = query?.trim().toLowerCase();
return allTools().filter((entry) =>
  (!app || entry.app === app) &&
  (!q || entry.name.toLowerCase().includes(q) || entry.doc.toLowerCase().includes(q)),
);
```

`query="table"` + `app="docs"` → **2 条**，全部经 `doc` 命中。

### 0.3 想验「name 路径」就得换一个 name-only 的查询词

实测「有 name 命中且 doc 零命中」的短 token：

```
"comments" → read_comments        （1 条，全 name 命中）
"media"    → analyze_media        （1 条，全 name 命中）
"mindmap"  → generate_mindmap     （1 条，全 name 命中）
```

**§三 的正向断言用其中之一，不要用 `table`。**

### 0.4 `snap-ok` 在 build_deck 之前就已经存在

`t43` 第 5 块（L353-354）由**套件自己**建的：

```ts
const target = join(tempRoot, "snap-ok");
const snap = await cli.snapshotDeckSpec(ports, deck, target);   // 没有清理
```

`tempRoot` 就是 `controlled-temp`，也是 `build_deck` 的 `renderTempRoot()`。
所以第 6 块里 `existsSync(join(tempRoot, "snap-ok"))` **恒为 true** ——
去掉 `|| true` 这条断言必然红。**这正是「判据指向了错误目录」的证据，不是产品缺陷。**

---

## 一、`t43-document-ai-design-pipeline-smoke:429-430`

```ts
check("build_deck：临时快照目录已清理（不留垃圾）",
  !existsSync(join(tempRoot, "snap-ok")) || true);
```

### 这条为什么错

1. **判据指向了错误的目录** —— 断言名说的是 `build_deck` 的临时快照，
   判据查的却是套件自己在第 5 块建的夹具（见 §0.4，它必然存在）；
2. **`|| true` 让它恒真** —— 即使判据对了也验不出来。

`build_deck` 的清理本身是**对的**：

```ts
// documentToolRuntime.ts:674,703-704
const snapshotRoot = join(root, `t43-deck-${randomUUID().replace(/-/g, "").slice(0, 12)}`);
} finally {
  try { rmSync(snapshotRoot, { recursive: true, force: true }); } catch { /* 清理失败不改变结果 */ }
}
```

> ⚠️ 审计报告最初把这条判成「产品缺陷」，那是错的（报告里已加更正说明）。
> **本卡不要按「修产品」的思路做。**

### 修法（确定走 A）

**(A) 判据改成 `build_deck` 真正创建的目录**：在 `documentToolCall` 前后对
`tempRoot` 做一次 `readdirSync` 快照，断言「调用后没有新增快照目录留下」。

**必须注意的两个细节**（卡稿没写，但会决定这条断言是否真的对准被测对象）：

1. **只匹配快照本体，不要匹配 `-render` 目录。**
   `build_deck` 在 `input.render === true` 时还会建
   `t43-deck-<12hex>-render`（`documentToolRuntime.ts:690`），而且**它不会被清理**
   —— 那是给用户的 PNG 输出，本来就该留下。所以：

   ```ts
   const SNAPSHOT_RE = /^t43-deck-[0-9a-f]{12}$/;   // 不带 -render
   ```

   用 `-render` 去判会得到一个恒假的断言（或者逼着产品去删用户产物）。

2. **前后快照要夹住这一次调用**（不是夹住整块）—— 前面第 5 块已经在
   `tempRoot` 里留了 `snap-ok`，不能把它算进「新增」。

**不要走 (B)**（改名 + 套件自己清理 `snap-ok`）：那只是把一个与产品无关的夹具
改得自洽，对「`build_deck` 是否留垃圾」仍然没有覆盖。

### 变异要求

在 `documentToolRuntime.ts` 的 `finally` 里**临时注释掉 `rmSync`** →
这条断言必须红 → 逐字节还原（`cmp`）→ 复跑绿。

**变异前先确认改动落地**（`git diff` 看得到那一行被注释）。这是 CLAUDE.md 里
记的那个坑：脚本在写文件前就抛错时，人会误读成「跑过了、证据被吞」。

---

## 二、`settings-form-lifecycle-smoke:194`

```ts
check("保存失败时没有写成功提示", !hasErrorRow() || true, "");
```

### 三层问题

1. **`|| true` 恒真**；
2. **断言名与判据不是一回事**：名字说「没有写**成功**提示」，判据查的是
   `hasErrorRow()`（**错误行**）；
3. **它与同块的上一条自相矛盾**：L192 刚 `check("★ 保存失败时页面出现错误行", hasErrorRow())`
   —— 错误行**必须存在**。所以就算去掉 `|| true`，`!hasErrorRow()` 也必然为假。

### 关键事实（已核实）

**这个面板确实有成功提示**，`SettingsTerminalPanel.tsx:109-111` 的 `ShellSection`：

```tsx
{shell.saved && (
  <p className="mt-1 text-[0.7857em] text-accent">{t("settings.terminal.shellSaved")}</p>
)}
```

`shell.saved` 由 `useSettingValue` 提供：`save()` 成功时 `setSaved(true)`，
`setValue()`（用户编辑）时 `setSaved(false)`（`useSettingValue.ts:96-118`）。

文案在 `lib/i18n/zh/settings.ts:1218`：`"settings.terminal.shellSaved": "已保存。新建终端将使用此 Shell。"`

### 修法（确定走这一条）

**① 加一个 `hasSuccessNote()` 判据**，与已有的 `hasErrorRow()` 并列。
套件里**没有** `textOfTree()` 这个函数（卡稿假设有），可照抄 `hasRetryButton()`
的既有做法 —— 扫描 `deepNodes()` 的 props：

```ts
import { translate } from "@renderer/lib/i18n/core.js";

/** 保存成功时的提示段落（SettingsTerminalPanel 的 shell.saved 分支）。
 *  与 hasRetryButton 同路：扫 props 的文本，不依赖节点身份。 */
function hasSuccessNote(): boolean {
  return JSON.stringify(deepNodes().map((n) => n.props)).includes(
    translate("zh", "settings.terminal.shellSaved"),
  );
}
```

**为什么用 `translate("zh", ...)` 而不是硬编码中文**：`useI18n()` 读
`useSessionStore(s => s.locale)`，套件里 locale 未设置时 `translate` 会回落
`zh[key]`（`i18n/core.ts:102-112`）。用同一个函数取同一份字符串，
文案改了套件自动跟上；硬编码中文会在改文案时静默失配。

**② L194 改成**：

```ts
check("保存失败时没有写成功提示", !hasSuccessNote(), { successNote: hasSuccessNote() });
```

**不许**再出现 `|| true`；也**不许**保留 `!hasErrorRow()` 那个错误判据。

**③ 新增一个保存成功的块**（卡稿只把它当一次性变异，总控要求固化成断言）。

理由：只有「失败态断言」的话，一个**恒假**的 `hasSuccessNote()` 也能让它绿 ——
这正是卡稿自己指出的陷阱。要让它有判别力，成功态必须有一条**常驻**断言：

```ts
console.log("\n【MC-047】终端 Shell:保存成功 → 成功提示出现、错误行消失");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "/bin/bash");
  __mount(() => ShellSection());
  await __flush();
  const saveBtn = buttonByText("保存");
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 保存成功后页面出现成功提示", hasSuccessNote(), { successNote: hasSuccessNote() });
  check("保存成功后没有错误行", !hasErrorRow(), hasErrorRow());
  check("保存成功后确实发出了 setting.set", stub.setCalls().length === 1, stub.setCalls());
}
```

（具体挂在第几块之后你自己定，但**两条状态都要覆盖**。）

### 变异要求（两条都要跑）

- **让保存成功一次**（不注入 `failNextSetFor`）→ `hasSuccessNote()` 为真 →
  「保存失败时没有写成功提示」必须红；
- **注入失败**（现状）→ 该断言必须绿；
- **把组件里的 `{shell.saved && ...}` 整段注释掉** → 「保存成功后页面出现成功提示」
  必须红 → 还原。

第三条是**对准被测对象**的变异；前两条是判据的判别力证明。三条都要写进回写区。

---

## 三、`t24-document-tool-surface-smoke:240`

```ts
const list = await call<{ shown: number; tools: Array<{ name: string; route: string }> }>(
  IPC.DOCUMENT_TOOLS_LIST, { app: "docs", query: "table" });
check("document.toolsList 按关键词回 docs 表格工具",
  list.shown > 0 && list.tools.every((t) => t.name.includes("table") || t.name.includes("Table") || true),
  list.tools.slice(0, 4));
```

`every(...)` 末端的 `|| true` 让它恒真 —— **整条断言实际只验了 `list.shown > 0`**。

### 为什么原作者加了 `|| true`（先理解，再改）

检索语义见 §0.2：`q` 同时匹配 `name` 和 `doc`（说明文本）。`query="table"` 的
**两条命中全部来自 `doc`**（§0.1）—— 所以「每个返回的工具 name 都含 table」
这个判据根本不成立。原作者为了让断言通过，在末端加了 `|| true`。

### 修法

**① 判据与检索语义一致**：每个返回的条目，`name` 或 `doc` 至少一个命中 `table`。

```ts
list.tools.every((t) =>
  t.name.toLowerCase().includes("table") || t.doc.toLowerCase().includes("table"))
```

**② 套件 L240 的类型标注写窄了，要补 `doc`。**
`DocumentToolsListEntry` 在 `packages/contracts/src/ipc/document.ts:119-130`，
`doc: string` 是**必填**。改成就地补字段即可（这是**套件内的类型标注**，不是产品改动）：

```ts
const list = await call<{ shown: number; tools: Array<{ name: string; doc: string; route: string }> }>(
  IPC.DOCUMENT_TOOLS_LIST, { app: "docs", query: "table" });
```

用 `DocumentToolsListEntry` 也可以（`@contracts/ipc` 已 `export * from "./ipc/document.js"`，
见 `packages/contracts/src/ipc.ts:174`），但**不要**为了一个类型去动套件的 import 风格。

**③ 正向断言换一个 name-only 的查询词**（防空过）。

卡稿这里的例子 `insert_table` **不存在**（§0.1），照抄必红。用实测出来的
name-only token（§0.3），例如：

```ts
// 防「every 只是被 doc 命中满足」：另起一个 name-only 查询，证明 name 路径真的在搜。
const byName = await call<{ shown: number; tools: Array<{ name: string; doc: string }> }>(
  IPC.DOCUMENT_TOOLS_LIST, { app: "docs", query: "mindmap" });
check("★ 正向控：query=mindmap 按名字命中 generate_mindmap（name 路径可达）",
  byName.shown === 1 && byName.tools[0]?.name === "generate_mindmap", byName.tools);
```

（`comments` / `media` 同样可用，选一个即可。）

**为什么需要这条**：上面那条 `every` 在「全部经 doc 命中」时也成立。
没有 name-only 的对照，就证明不了检索的 name 路径在工作。

### 变异要求

- 把 `searchDocumentTools` 的 `entry.doc.toLowerCase().includes(q)` **去掉**（只按 name 搜）
  → `query=table` 那条必须红（命中数变 0）→ 还原；
- 把 `entry.name.toLowerCase().includes(q)` 去掉（只按 doc 搜）
  → 正向控（`mindmap`）必须红 → 还原。

两条各撤一个证据源，正好证明两条断言分别盯着两条路径。

---

## 硬要求（三处共用）

1. **每处都要有变异证明**：撤掉被测对象 → 断言必须红 → `cmp` 逐字节还原 →
   写进回写区。
2. **如果某处去掉 `|| true` 后「必然红」**（因为前置条件不满足），说明**那处的
   前置断言/夹具写错了**，要一起改 —— 不许用「它本来就是红的」当理由留着 `|| true`。
   （§0.4 就是这种情况：`snap-ok` 是套件自己的夹具。）
3. **不许把断言改弱**。判据要立在「用户/调用方能观察到的结果」上。
4. **不跑全量**（用户规矩：全量由总控执行），只跑这三套 + 它们的直接相关套件。
5. **不起 Electron**。
6. 变异脚本必须**先确认改动生效**再跑（`git diff` 看得到），避免 CLAUDE.md 里
   记的那个坑（`assert s.count(old) == 1` 失败 → 文件没改、套件没跑 → 误读成「跑过了」）。
7. **变异要从 pristine 重置**，不要在上一轮变异态上继续（E 在 T65 踩过：脚本中途失败，
   下一轮从脏状态出发，累积删掉了两条判据的调用行）。

## 验收判据

1. 三处 `|| true` 全部消失，且每处都有说明「改成了什么判据、为什么」。
2. **四处**变异证据（`t43` 一处、`settings` 三处、`t24` 两处；见各节）→ 红 → `cmp` 还原。
3. 三套本身仍全绿（去掉 `|| true` 后不许有「本来就在红」的遗留）。
4. 相关套件不回归：`t43` / `t24` / `settings-form-lifecycle` 的直接邻居
   （用 `bash apps/desktop/scripts/smokes-for.sh` 查，或至少跑同目录的）。
5. 双包 typecheck：`packages/contracts` 0 错误；`apps/desktop` 只允许**他人的在途改动**错误
   （提交前 `git status` 核对，把自己文件的诊断数写进回写）。
6. 回写区给出三处的「改前 / 改后 / 变异结果」对照表。

## 边界

- **只改这三个套件文件**（`t43` / `settings-form-lifecycle` / `t24` 的 `main.ts`）。
- **不改产品源码**。若发现必须改产品才能修好断言，**停下报告**。
  （唯一例外：变异时**临时**改 `documentToolRuntime.ts` 的 `rmSync`，改完必须逐字节还原。）
- **不碰** `documentToolRuntime.ts` 的清理逻辑（它是对的）；
- **不碰** `docs/planning/assertion-integrity-audit.md`（那是 T61 的产物，总控维护）；
- **不改** `run-smokes.mjs`；
- 不碰其他套件。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**
卡上的事实（§零）也可能过期 —— 以代码为准，并把差异写进回写区。

## 提交

`git add <明确路径>` 后**立刻** `git commit -m "<信息>" -- <明确路径>`。
**`-m` 必须在 `--` 前面。**

提交信息末尾加：

```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T67-assertion-short-circuits.md` 末尾追加 `## 结果回写（2026-10-23）`：
三处的改前/改后/变异结果对照表、`t43` 的快照匹配正则与为何排除 `-render`、
`settings-form-lifecycle` 的 `hasSuccessNote()` 实现与成功态断言、
`t24` 用的 name-only 查询词及实测数字、相关套件结果、提交 SHA。

---

## 结果回写（2026-10-23，C 会话）

### 总览：三处 `|| true` 全部消失，五条变异全部变红

| # | 位置 | 改前 | 改后 | 变异 | 结果 |
|---|---|---|---|---|---|
| 1 | `t43:429` | `!existsSync(tempRoot/snap-ok) \|\| true` | 调用前后 `readdirSync` 快照比对，只匹配 `/^t43-deck-[0-9a-f]{12}$/` | 注释掉 `documentToolRuntime.ts` 的 `finally { rmSync(...) }` | **56/57 红**，detail `leftoverSnapshots: ["t43-deck-469f249a8638"]` |
| 2a | `settings-form-lifecycle:209` | `!hasErrorRow() \|\| true` | `!hasSuccessNote()` | 让成功提示在失败时也出现 | **68/69 红**，`successNote: true` |
| 2b | 同上 | — | 新增成功态块 5 条 | 注释掉组件的 `{shell.saved && …}` | **68/69 红**，`successNote: false` |
| 3a | `t24:241` | `every(... \|\| true)` | `name` **或** `doc` 命中 table | 去掉 `documentToolSurface.ts` 的 doc 搜索路径 | **58/60 红**，`toolsList … — []` |
| 3b | 同上 | — | 新增 name-only 正向控（`mindmap`） | 去掉 name 搜索路径 | **59/60 红**，`正向控 … — []` |

五处变异全部 `cmp -s` 逐字节还原，SHA-256 回到原值，`git status` 全 clean。

### 一、`t43`：判据对准 `build_deck` 真正建的目录

**为什么排除 `-render`**（卡上 §一.1 的要求，代码里也写了注释）：`build_deck` 在
`input.render === true` 时还会建 `t43-deck-<12hex>-render`（`documentToolRuntime.ts:690`），
那是**给用户的 PNG 输出、本来就该留下** —— 它不在 `finally` 的 `rmSync` 范围内。
拿 `-render` 去判会得到一个恒假断言，或者逼产品去删用户产物。

```ts
const SNAPSHOT_RE = /^t43-deck-[0-9a-f]{12}$/;   // 不带 -render
const snapshotsBefore = new Set(readdirSync(tempRoot).filter((n) => SNAPSHOT_RE.test(n)));
const result = await runtime.documentToolCall(...);
const leftoverSnapshots = readdirSync(tempRoot)
  .filter((n) => SNAPSHOT_RE.test(n) && !snapshotsBefore.has(n));
```

**前后快照夹住的是 `documentToolCall` 这一次调用**（不是整块）—— 第 5 块已经在
`tempRoot` 里留了 `snap-ok`，不能算进「新增」。这一点由 M1 的 detail 验证：
残留的只有 `t43-deck-469f249a8638`，`snap-ok` 没被误报。

### 二、`settings-form-lifecycle`：`hasSuccessNote()` + 成功态常驻断言

实现照抄 `hasRetryButton()` 的既有做法（扫 `deepNodes()` 的 props），文案**从词典取**：

```ts
import { translate } from "@renderer/lib/i18n/core.js";

function hasSuccessNote(): boolean {
  return JSON.stringify(deepNodes().map((n) => n.props)).includes(
    translate("zh", "settings.terminal.shellSaved"),
  );
}
```

**为什么用 `translate` 而不是硬编码中文**：硬编码会在改文案时静默失配 ——
断言绿着，而它验的那句话已经不存在了。

**新增的成功态块（5 条）**，挂在失败态块之后：

```
【MC-047】终端 Shell:保存成功 → 成功提示出现、错误行消失
  ok   守卫:成功块里也有保存钮
  ok   保存前没有成功提示        ← 证明判据不是恒真
  ok   ★ 保存成功后页面出现成功提示
  ok   ★ 保存成功后没有错误行
  ok   保存成功时确实发出了 setting.set
```

**「保存前没有成功提示」这一条是额外加的**（卡上没要求）：它证明 `hasSuccessNote()`
在保存前为假，与「保存后为真」构成一对，比单点断言更能说明判据分得清前后。

### 三、`t24`：成对覆盖两条检索路径

**用到的 name-only 查询词：`mindmap`**（卡上 §0.3 给的三个之一），实测
`shown === 1` 且 `tools[0].name === "generate_mindmap"` —— 与卡上数据一致。

类型标注补了 `doc: string`（`DocumentToolsListEntry` 里它是必填）。

### 四、过程中我自己踩的两个坑（如实记录）

**① 一次变异把语法改坏了。** 我把 `/* MUTATION */` 注释塞进了表达式中间，
尾部多出一个逗号 → esbuild 打包失败、套件根本没跑起来。这正是 CLAUDE.md 里记的
「打包期失败不等于被测对象失败」。还原后用纯表达式替换重做，并在跑之前先
`tsc --noEmit | grep documentToolSurface` 确认 0 语法错误。

**② 第一次加 `import { translate }` 没生效。** 我的 Edit 匹配到了文件里另一处相似
文本，import 没写进去，`tsc` 报 `Cannot find name 'translate'`。补上后 0 错误。

### 五、验证结果

| 套件 | 结果 |
|---|---|
| `t43-document-ai-design-pipeline-smoke` | **57/57** |
| `settings-form-lifecycle-smoke` | **69/69**（原 64，+5） |
| `t24-document-tool-surface-smoke` | **60/60**（原 59，+1） |
| `settings-panels-electron-smoke`（邻居） | 46/46 真 Electron |
| `genoffice-cli-smoke`（邻居） | 54/54 |
| `t47-design-guide-smoke`（邻居） | 27/27 |
| 双包 typecheck | contracts **0**、desktop **0** |

**未跑全量**（按用户规矩，全量由总控执行）。`smokes-for.sh` 显示
`documentToolSurface.ts` 的连通块有 90+ 套，只挑了直接相关的三个邻居。

### 六、未做的

- **`t43` 第 5 块的 `snap-ok` 仍然没清理** —— 它是套件自己的夹具，留着不影响任何断言
  （新判据只看 `t43-deck-*`）。要不要给它补一句 `rmSync` 属于清理偏好，不在本卡判据内；
- 卡上 §一 提到「(B) 改名 + 套件自己清理 `snap-ok`」被排除 —— 我按卡走了 (A)。
