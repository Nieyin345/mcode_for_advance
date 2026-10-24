# F019｜真实扩展的 API 需求普查：26,961 行里我们到底需要多少

- Status: ready-for-agent
- Category: **P0 扩展主线（B 方案的需求侧）**
- Depends on: F017（Theia PoC 结论）；用户裁决「自己做，要做完整的」
- Exclusive writable files:
  - 新建 `apps/desktop/scripts/vscode-api-census/`（普查脚本 + 输出）
  - 新建 `docs/planning/vscode-api-census.md`（结果报告）
  - 本卡回写
- **不碰**：`packages/vscode-compat/**`（F018 在写）、`apps/desktop/src/**`、**根 `package.json` / `pnpm-workspace.yaml`**（F018 要改，别撞）

## Required Skills
- 无特殊。需要会读 `package.json`、会写 AST 或正则扫描、会做变异验证。

---

## 为什么要做这件事

F018 会给出 `@types/vscode` 的**全部**命名空间和方法数。Theia 的 `plugin-ext` 是
**26,961 行**。

**但「全都有」不等于「全都要」。** 如果真实扩展只用到其中 30%，那我们照着
100% 去做，会把工期乘三倍，而且做完之后没人用那 70%。

**这张卡回答的是需求侧**：本机能拿到的真实 VS Code 扩展，**实际调用了哪些
`vscode.*` 成员**，按被调用的扩展数排序。

**这个排序就是实现顺序。** 排第一的十来个成员，决定了「划词翻译能不能跑」。

---

## 数据源（本机现成，不下载任何东西）

```
C:\Users\Nieyin\.vscode\extensions\     ← 30 个目录（含 1 个 extensions.json）
```

**注意**：不是所有目录都是扩展（有 `extensions.json`），也有 `*-win32-x64` 这种
带平台后缀的。**先按 `package.json` 里的 `publisher` + `name` + `main` 三段判断它是不是
一个带代码的扩展**，并把判定结果列出来——哪些是纯语言包/主题（无 `main`），
哪些有代码。**纯主题扩展没有 API 需求，不计入统计，但要报出数量。**

---

## 任务

### 一、枚举扩展，分类

对每个目录读 `package.json`，分三类：

| 类别 | 判据 | 数量 |
|---|---|---|
| **无代码**（主题/语言包/纯声明） | 没有 `main` 字段 | ? |
| **有代码** | 有 `main` | ? |
| **不是扩展** | 无 `package.json` 或结构不对 | ? |

### 二、提取每个扩展的 `vscode.*` 调用

**这是核心技术工作。** 对每个有代码的扩展，扫描它的 JS（`main` 指向的文件
**以及它 require 的其他本地文件**，递归）。

**要提取两样东西：**

1. **命名空间级** —— `vscode.commands`、`vscode.window`、`vscode.workspace`……
2. **成员级** —— `vscode.commands.registerCommand`、`vscode.window.showInformationMessage`……

**提取方法要求**：用**真解析**，不是正则。

- JS 用 `acorn`（仓库的 `apps/desktop/node_modules` 里可能已有；没有就用 esbuild 的
  transform 走一遍 AST，或者用 TypeScript 自带的 parser —— **`typescript` 一定装了**）。
- 为什么不用正则：`vscode.commands.registerCommand` 可能写成
  `const { commands } = vscode; commands.registerCommand(...)`，
  正则抓不到，**会漏报**。而漏报正是这张卡最不能犯的错（见下方判据）。

**如果某些扩展是 webpack 打包过的单文件**（几 MB），照样扫，但要标注
「这是打包产物，成员数是打包后的」。

### 三、按「被多少个扩展调用」排序

产出一张表：

| 成员 | 用到它的扩展数 | 哪些扩展 | 本仓底层 |
|---|---:|---|---|
| `window.showInformationMessage` | ? | a, b, c | 通知服务 |
| `commands.registerCommand` | ? | … | ModuleHost |
| … | | | |

**「本仓底层」这列**：Mcode 已有 Monaco、终端（`terminal/`）、LSP（`lsp/`）、
文件系统、通知。**能直接映射的标 ✅，需要新建的标 ❌，语义对不上的标 ⚠️ 并写一句为什么。**

### 四、算出「够用线」

**回答这个问题**：要覆盖 X% 的有代码扩展，需要实现多少个成员？

```
Top 10 个成员覆盖 ___% 的扩展
Top 30 个成员覆盖 ___% 的扩展
Top 50 个成员覆盖 ___% 的扩展
```

**这条曲线的形状决定了 B 方案是「两个月」还是「两年」。** 如果 Top 20 就覆盖 80%，
那分阶段推进是可行的；如果 Top 50 才覆盖 50%，那说明扩展之间共性低，值得重新考虑
「接 Theia」这个被否掉的选项。

### 五、对「划词翻译」这个具体用例做一次专项核对

用户明确提过要**划词翻译**。本机有 `siesta.vscode-pdf-translate`，但那需要 PDF 编辑器。
**所以另外找一个最小可行形状**：

- `siesta.vscode-pdf-translate` 的 `main` 里调了哪些 API？**逐条列出**；
- 一个典型划词翻译扩展需要什么：`window.activeTextEditor` / `selection` /
  `replace` / `showInformationMessage` / `statusBarItem`…… **这些在普查里排第几？**

**结论要写成一句话**：「要让划词翻译跑起来，必须实现这 N 个成员，它们目前排在第几名。」

---

## 判据（这张卡最容易被做假的地方）

**1. 必须报「扫了几个文件、合计多少行」。**
如果只扫了 `main` 没扫它 require 的子文件，**成员数会显著偏少**，而结果看起来完全正常。

**2. 必须列出「一个成员都没扫到的扩展」。**
一个成员都没有？大概率是扫描失败，不是它真的不用 API。**这种情况要单独报，不能算进 0。**

**3. 必须做一次对照：手工核一个扩展，和脚本结果比对。**
挑一个你可能 20 行左右的扩展，人肉 `grep` 出它用的成员，和脚本输出对一下。
**对不上就是脚本错了，不是「脚本更全」。**

**4. 变异：故意用一个非正则能抓的形状测脚本。**
往 `.tmp/` 丢一个 `.js`：

```js
const { window } = require("vscode");
window.showQuickPick(["a"]);
```

**脚本必须能报出 `window.showQuickPick`。** 报不出来就是正则假装成 AST 了。

**预写预期**：先写「这个探针我预期报出 1 个成员」，再跑。

---

## 边界

- **不安装任何新依赖到根 `package.json`**（F018 在改它）；
- 需要 `acorn` 之类的话，装到 `apps/desktop` 或用已装的 `typescript`；
- **不读用户 `.vscode` 目录以外的任何东西**；
- 不跑全量、不起 Electron。

---

## 回写

1. **三类扩展的数量**（无代码 / 有代码 / 不是扩展）；
2. **扫了多少文件、多少行**；
3. **Top 30 成员表**（含「本仓底层」列）；
4. **覆盖曲线**（Top 10 / 30 / 50 各覆盖多少 % 的有代码扩展）；
5. **一个成员都没扫到的扩展清单**；
6. **手工对照那一个扩展的结果比对**（脚本 vs 人肉）；
7. **划词翻译用例专项结论**（一句 + 成员清单）；
8. **你对「B 方案要多久」的判断**——基于这条曲线，不是感觉；
9. 提交 SHA。
