# F009｜`main` 字面量 + `publisher` 正则：另外两道拦住所有人的墙

- Status: **done**（`eb6ba1cc` + `343f8803`）
- Category: **P0 扩展主线**
- Depends on: F008（`26907b71`，交付时报出这两条）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（清单 schema + 读取路径）
  - `apps/desktop/scripts/vsix-main-path-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 并行边界

`apps/desktop/src/main/ipc/*`、`packages/contracts/**`、`renderer/components/modules/**` 是 **F006** 的，你不碰。

---

## 我（总控）实测的数字

对本机 29 个真实扩展：

| 检查 | 结果 |
|---|---|
| 声明了 `main` 的扩展 | **27 个** |
| 其中恰好等于 `"./extension.js"` | **0 个** |
| `main` 无 `.js` 后缀 | **8 个** |
| `publisher` 含大写 | **4 个** |

真实 `main` 的形态：

```
./out/src/main.js
./extension          ← 无后缀
./dist/extension.js  ← 有目录
./main.js            ← 不在根
```

而 schema 是：

```ts
// vscodeL1Bridge.ts:60
main: z.literal("./extension.js"),
```

**字面量——连 `./dist/extension.js` 都不收，不只是后缀问题。**

---

## 任务

### 一、`main` 从字面量改成「路径」

VS Code 的真实规则：

- 相对路径，相对于扩展根；
- **可以任意层级**（`./dist/extension.js`、`./out/src/main.js`）；
- **无后缀时补 `.js`**（`./extension` → `./extension.js`）；
- **禁止 `..` 逃逸**（这是安全边界，保留）。

**所以 schema 改成**：

```ts
main: z.string().min(1).max(...).regex(/^\.\/[A-Za-z0-9._\-\/]+$/)   // 必须是 ./ 开头，不许 ..
```

**但真正的难点不在 schema，在读取**：`readMinimalVsix` 现在是**从 ZIP 里按固定名字取两个条目**：

```ts
const manifest = entries.get("extension/package.json");
const main = entries.get("extension/extension.js");     // ← 写死
```

**你要改成**：先解析 `package.json`、读出 `main` 字段、**再按那个路径去 ZIP 里找**。

**这有个顺序问题**：现在 `readMinimalVsix` 返回 `{ packageJson, source }`，两个一起取。
改成「先取 manifest、解析、再取 main」意味着**函数内部要分成两步**。

**这是结构性改动，不是改个常量。** 如果你觉得需要拆函数，**在回写区说明你怎么拆的、为什么**。

### 二、`publisher` 正则放宽大小写

```ts
publisher: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),   // 拒 James-Yu
```

VS Code 官方要求 publisher id **小写**，但**现实中存在大写**（本机 4 个）。

**两种处理**：

- **A. 放宽正则**接受大写（`/^[A-Za-z][A-Za-z0-9-]{1,30}$/`），内部统一小写比较；
- **B. 保持严格**，但对大写 publisher 给**明确的可行动错误**（「publisher id 必须小写，此扩展的 `James-Yu` 请改为 `james-yu`」）。

**我倾向 A** —— 因为用户在装现成扩展，他改不了别人的 manifest。但**你判断，在回写区论证**。

### 三、`moduleId` 的构造要跟着改

现在：`const moduleId = "user." + pkg.publisher + "." + pkg.name;`

**如果 publisher 允许大写、或者两个扩展大小写不同但实际同名**，`moduleId` 会冲突或产生两个条目。

**要求**：`moduleId` 归一化（小写），且**冲突时要报警而不是静默覆盖**。

---

## 验收判据

1. **`./dist/extension.js` 能被读取**（正控：有目录的路径）；
2. **`./extension`（无后缀）能补成 `./extension.js` 并读取**（正控）；
3. **`../escape.js` 被拒**（负控：路径逃逸）；
4. **ZIP 里没有声明的 `main` 时，错误说清「声明的是 X，包里没有」**（负控，且可诊断）；
5. **大写 publisher 按你选的方案处理**，有断言；
6. **`moduleId` 归一化且冲突可检测**，有断言；
7. **`rainbow-csv` 的 `main` 路径这一关过了**（它卡在 `./extension` 还是别的，实测确认）；
8. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 路径逃逸检查去掉（允许 `..`） | 1 条红 |
| 无后缀补 `.js` 去掉 | 1 条红 |
| `main` 改回字面量 | 1 条红（`./dist/...` 那条） |

**⚠️ 变异要先问「我这个改动真的让它变坏了吗」** —— F008 的实测教训：

> M3 想验证「允许裸命令时套件必须红」，把 `"demo."` 改成 `"demo"`，
> 但 **`"hello".startsWith("demo")` 本来就是 false** —— 这个变异什么都没改变，套件当然全绿。
>
> 这不是断言弱，是**变异没模拟 bug 的样子**。

**所以每个变异写完之后，先自己验证它真的改变了行为，再看套件红不红。**

---

## 回写

1. `readMinimalVsix` **怎么改的两步读取**（贴关键代码）；
2. `publisher` 你选了 A 还是 B，**为什么**；
3. `moduleId` 归一化与冲突检测怎么做的；
4. `rainbow-csv` 现在的 `main` 是什么，这一关过了吗；
5. 变异三条结果；
6. **整包还差哪些墙**（F005 说三道、F008 说两道，加上你的）；
7. 提交 SHA。

---

## 结果回写

### 1. `readMinimalVsix` 怎么改的两步读取

**没有真的读两遍 ZIP** —— `scan()` 本来就遍历全部条目。所谓「两遍」是**逻辑上的两阶段**：

```ts
// 阶段 1：走中央目录，把所有条目解出来放进 entries（这一步原来就有）
for (let index = 0; index < 2; index++) { ... entries.set(name, data); ... }

// 阶段 2：【F009 新增】先解析清单 → 读出 main → 按那个路径取源码
const manifest = entries.get("extension/package.json");
if (!manifest) throw Error("VSIX archive has no extension/package.json");
...
let parsed: unknown;
try { parsed = JSON.parse(decoder.decode(manifest)); }
catch (cause) { throw Error("VSIX manifest is not valid JSON: " + String(cause)); }
const mainField = (parsed as { main?: unknown }).main;
if (typeof mainField !== "string") throw Error("VSIX manifest has no string 'main' field");
const mainEntry = mainEntryName(mainField);          // ← 新增：路径 → 条目名
const main = entries.get(mainEntry);
if (!main) {
  throw Error(
    "VSIX declares main '" + mainField + "' (entry '" + mainEntry +
    "') but the archive does not contain it; entries: " + [...entries.keys()].join(", "),
  );
}
```

新增的辅助函数：

```ts
function mainEntryName(mainField: string): string {
  const relative = mainField.replace(/^\.\//, "");
  if (relative.length === 0 || relative.split("/").includes("..")) {
    throw Error("VSIX main escapes the extension root: " + mainField);
  }
  const withSuffix = /\.js$/i.test(relative) ? relative : relative + ".js";
  return "extension/" + withSuffix;
}
```

**为什么没拆成两个导出函数**：`readMinimalVsix` 的签名被 4 个套件直接调用
（`vscode-l1-smoke:112` 还断言 `.source`），改签名会连带改一圈。
**两阶段放在函数内部**，签名不变，调用方零改动。

**白名单也跟着放宽**（从两个固定名字到 `extension/` 下任意路径），
但**「恰好 2 个 entry」没动** —— 多出来的第三个条目仍会被拒。

### 2. `publisher` 选了 **A（放宽）**

理由：**用户装的是别人写的现成扩展，他改不了那个 manifest。**
方案 B 的错误「请改为 james-yu」对他没有可操作性 —— 他能做的只有放弃。

归一化放在 `moduleId` 构造处，不在 schema 里拒绝。

### 3. `moduleId` 归一化与冲突检测

```ts
function normalizeModuleId(publisher: string, name: string): string {
  return ("user." + publisher + "." + name).toLowerCase();
}
```

**冲突检测**（`install()` 里，装盘之前）：

```ts
const existing = host.catalog().modules.find((m) => m.id === moduleId);
if (existing && existing.version !== pkg.version) {
  const sameSource = existing.title?.en === title;
  if (!sameSource) {
    throw Error("VSIX module id collision after normalisation: '" + moduleId +
      "' is already taken by another extension (existing title '" + existing.title?.en +
      "', incoming '" + title + "')");
  }
}
```

**三分支**（都有断言）：
- 同 id + 不同标题 + 不同版本 → **拒**（两个不同扩展归一化后撞车）；
- 同 id + 同标题 + 更高版本 → **允许**（同一扩展的升级）；
- `program.section` 也改用归一化后的值 —— 否则设置项 key 与模块 id 会分叉。

### 4. `rainbow-csv` 的 `main` 这一关：**过了**

```
rainbow-csv 的 main = "./extension"
ok  ★ main='./extension' 现在能被解析出源码（旧的字面量规则会拒）
```

但**整包仍在下一道墙前**：

```
实际拒绝理由：VSIX contributes unsupported section(s): colors, configuration,
submenus, menus, languages, semanticTokenScopes, configurationDefaults, grammars.
This host supports only: commands.
```

**障碍前移了一格**，不是消失了。`vsix-manifest-schema-smoke` 里那条断言
（原来验「死在 main」）已同步更新成「现在卡在贡献点」—— 因为**墙会随每次放宽前移**，
断言必须说清当前卡在哪。

### 5. 变异三条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 路径逃逸检查去掉 | 红 2 条 | **红 1 条**（见下） |
| M2 无后缀补 `.js` 去掉 | 红 2 条 | **红 4 条** |
| M3 `main` 改回字面量 | 红 8 条以上 | **红 0 条 → 修后红 3 条**（见 §6） |

**M1 只红 1 条是正常的**：在 read 层，`extension/../escape.js` 这个**条目名**
先被 ZIP 白名单拒了 —— 两道防线，白名单在前。我只去掉了 schema 那道，
白名单仍在，所以「被拒」那条仍绿，只有「拒绝理由说清是路径规则」那条红了。
**套件里已注明这个顺序**，且 [4] 组另有一个「包里放合规条目、清单写逃逸路径」的包，
专测 schema 那一层。

### 6. ⚠️ M3 红 0 条 —— 一个架构发现

自证显示 `main: z.literal(...)` 确实改回去了，但套件 30/30 全绿。

**原因**：`packageSchema` **只在 `VscodeL1Bridge.install()` 里 parse**（`:570`），
而 `readMinimalVsix` **完全不知道 schema 的存在** —— 它只按 `main` 的**值**去 ZIP 里找条目。

**所以 `main` 的形状规则（字面量 / `./` 开头 / 不许 `..`）只在 install 层生效。**
而我第一版把它全测在 read 层，等于**什么都没测**。

**修法**：加第 [9] 组，每条都走 `install()`。加完之后 M3 红 3 条，全在那一组。

**这是本轮最值的一条**：`readMinimalVsix` 和 `packageSchema` 是**两层**，
测试必须落在**规则实际生效的那一层**。测错层 = 断言绿着但什么都没验。

### 7. 整包还差哪些墙（完整盘点）

按当前状态，一个真实扩展要装进来要过这些：

| # | 墙 | 状态 |
|---|---|---|
| 1 | 总包 ≤ 128 KiB | **仍在**（无依据，未动） |
| 2 | 恰好 2 个 entry | **仍在**（真实扩展有数十个文件） |
| 3 | DEFLATE 读取 | ✅ **F002 已通** |
| 4 | `package.json` ≤ 64 KiB | ✅ **F003 已放宽** |
| 5 | `extension.js` ≤ 24 KiB | **仍在**（rainbow-csv 136 KB，5.6×） |
| 6 | 命令前缀 | ✅ **F008 已通** |
| 7 | `main` 字面量 | ✅ **F009 已通** |
| 8 | `publisher` 大写 | ✅ **F009 已通** |
| 9 | **`contributes` 只支持 commands** | **仍在**（rainbow-csv 有 9 个贡献点） |
| 10 | `require` 白名单只有 `"vscode"` | **仍在**（53 个成员无完整实现） |
| 11 | 单命令（`executeCommand` 硬编码） | **仍在**（F007） |

**当前 rainbow-csv 卡在 #9**（不是 #10 —— 它还没走到运行时）。
**下一道该做的是 #9**：支持更多贡献点，或者明确告诉用户「这些贡献点不会工作」。
但 #9 有个前提问题：**放开了却没实现，用户会看到菜单项但点了没反应** —— 那比装不上更坏。

### 8. 提交

`eb6ba1cc`（5 文件，+539/−39）。`tsc` exit 0，三条变异全部红在正确位置，
还原逐字节 `SAME (4b2a93c0...)`。

**六套全绿**：`vsix-main-path 30/30`、`vsix-command-prefix 14/14`、
`vsix-manifest-schema 17/17`、`vsix-deflate 24/24`、`vsix-size-limits 21/21`、
`vscode-l1 27/27`。
