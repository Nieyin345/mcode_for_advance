# F022｜Theia 二开第一步：把源码拿进来，并且能改能验

- Status: ready-for-agent
- Category: **P0 扩展主线（用户已裁决：Theia 二开，改源码适配 Mcode）**
- Depends on: F017（PoC：宿主零 UI 依赖，596 包 / 307 MB 实测）、用户裁决 2026-10-24
  「用 Theia 二开，我想直接改他的源码来适配我们的场景」
- Exclusive writable files:
  - **新建** `vendor/theia/`（git submodule 或 vendored copy，见任务一）
  - **新建** `apps/desktop/scripts/theia-vendor-smoke/`
  - `build/` 下的 vendoring 脚本（新建，若需要）
  - `.gitignore`（只加 vendor 相关忽略）
  - 本卡回写
- **不碰**：`apps/desktop/src/**`、`packages/vscode-compat/**`（**这张卡不接产品**）、
  `packages/contracts/**`、`.tmp/theia-poc/`（保留作对照）

---

## 为什么这张卡不接产品

用户要的是「改 Theia 源码适配我们的场景」。**在能改之前，得先有三件事成立：**

1. **源码在仓库里**，而且**是我们能改的那一份**（不是 `node_modules` 里的只读副本）；
2. **改完之后能重新构建**，并且**构建产物是我们跑的那一份**；
3. **许可证义务被履行**（EPL-2.0 / GPL-2.0+CE 都要求分发时提供源码与通知）。

**这三件任何一件不成立，后面的「改源码」都是在沙子上盖楼。**

**所以这张卡只做「拿进来 + 能改 + 能验」，一行 Mcode 适配代码都不写。**

---

## ⚠️ 不要用 npm 包，要 git 源码仓库

我实测过 npm 包（`.tmp/theia-poc/node_modules/@theia/plugin-ext`）：

| | npm 包 | git 仓库 |
|---|---|---|
| `src/` 里的 TS 源码 | **有**（367 个 `.ts`，74,337 行；`src/plugin/` 32,519 行） | 有，且**含完整目录、测试、示例** |
| `LICENSE` 文件 | **❌ 没有**（只有 `package.json` 的 `license` 字段） | 有 |
| 构建配置 | **❌ 没有**（无 `tsconfig` 的构建目标、无 `package.json` 的 scripts） | 有 |
| 能否 `pnpm build` | **不能** | 能 |
| 依赖版本 | 已解析的嵌套树 | **`yarn.lock`，可复现** |

**所以必须拿 `https://github.com/eclipse-theia/theia` 的源码。** 具体版本由任务一决定。

---

## 任务一：决定 vendoring 方式（**先做这个，做完停下来报告**）

两条路，各有代价，**你要选一条并写清理由**：

### A. git submodule

```bash
git submodule add https://github.com/eclipse-theia/theia.git vendor/theia
```

| 优点 | 缺点 |
|---|---|
| 上游历史完整，`git log` / `git blame` 能用 | 克隆要拉**完整体积**（Theia 主仓很大） |
| 升级就是 `git submodule update` | 新人 clone 要 `--recursive`，否则目录是空的 |
| 「我们改了什么」= `git diff`，一目了然 | **改完的提交不在我们的仓库里**，要另外维护 `patches/` |

### B. vendored copy（拷进来，删掉 `.git`）

| 优点 | 缺点 |
|---|---|
| 我们仓库自带全部源码，clone 即可用 | **失去上游历史**（blame 断了） |
| 改源码 = 直接改，提交在我们的历史里 | 升级要手工重新拷贝 + 重放改动 |
| 不需要 submodule 的操作习惯 | 仓库体积变大 |

**我的倾向：A（submodule）+ `patches/theia/` 系列。**

> ## ⚠️ 但我查了仓库先例，它不是 submodule —— 你按实际情况判断
>
> 我原以为 `genoffice/` 是 submodule，**查完发现不是**：
>
> ```
> .gitignore:70:/genoffice/          ← 它在 gitignore 里
> git ls-files genoffice/            → 空（未追踪）
> genoffice/.git/                    ← 是独立 checkout
> ```
>
> **它的模式是**：上游源码**不进我们的仓库**，是开发机上的一份独立克隆；
> 我们的改动**以 patch 文件的形式**进仓库（`patches/genoffice/0001…0015.patch`）；
> `build/verify-genoffice-upstream.cjs` 校验上游没被偷偷改动。
>
> **这个模式的好处**：仓库不背上游体积，改动可审计（每个 patch 是一段 diff）。
> **坏处**：新环境要重新克隆上游 + 打 patch，才能构建。
>
> **所以三条路，你选：**
>
> | | 仓库体积 | 改源码的手感 | 可复现性 |
> |---|---|---|---|
> | **A. submodule** | 中等（指针 + .gitmodules） | `git diff` 直接看 | `--recursive` 即可 |
> | **A′. 独立 checkout + patches**（genoffice 模式） | **最小** | 直接改文件，改完 `git format-patch` | 要脚本 |
> | **B. vendored copy** | **最大**（全部源码） | 最直接 | clone 即可 |
>
> **用户说「想直接改他的源码」，A 和 A′ 都能直接改。** 区别只在改动怎么记。
>
> **我倾向 A′（沿用 genoffice 先例）** —— 同一个仓库里两种 vendoring 模式会让下一个人困惑。
> **但如果你实测发现 Theia 比 genoffice 大得多、重新克隆代价高，选 A 并写清数字。**

### 如果选 A′，**照抄 genoffice 的格式，不要新造**

`apps/desktop/build/verify-genoffice-upstream.cjs` 已经有一套成熟的做法，我读了，它是：

```js
const FORMAT = "mcode.genoffice.upstream-lock.v2";
const REPOSITORY = "https://github.com/genspark-ai/genoffice";
const BASE_REVISION = "cbec600...";
const FINAL_REVISION  = "3cb99ab...";
const FINAL_TREE      = "5ba6f37...";
const PATCHES = Object.freeze([
  { file: "patches/genoffice/0001-....patch",
    revision: "8d379b1...", parentRevision: APPROVED_PATCH_REVISION,
    sha256: "0fdb71b..." },
  ...
]);
```

**每一条 patch 记三样**：`revision`（打完这个 patch 后的 commit）、`parentRevision`（前一个）、
`sha256`（patch 文件自身的哈希）。**这三个合起来能证明「patch 顺序不可调换、内容不可篡改」。**

**再加一个 `FINAL_TREE`**，校验打完所有 patch 后的目录树哈希。

**`theia.lock.json` 至少要有**：`FORMAT` / `REPOSITORY` / `BASE_REVISION` / `PATCHES[]`（本卡先空数组）。

**⚠️ 别把 genoffice 的常量抄错。** 上面那些 SHA 是 genoffice 的，抄进 theia 的 lock 文件
会得到一个永远校验失败的配置。**照字段结构抄，不照值抄。**

### 版本锁定

**必须锁到一个明确的 commit，不是 `main`。** 我已经查到确切的：

```bash
git ls-remote --tags https://github.com/eclipse-theia/theia.git | grep v1.76.0
# 12f62a6bdafe275e87507d6b4984dd5e99fc61a0   refs/tags/v1.76.0        ← tag 对象
# d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649   refs/tags/v1.76.0^{}     ← 真正的 commit
```

**锁定 `d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649`（tag `v1.76.0` 解引用后的 commit）。**

> **⚠️ 注意用解引用后那个（带 `^{}` 的）。** `12f62a6b` 是**tag 对象**，不是 commit；
> 锁错会得到一个指向 tag 的引用，而不是一个可复现的代码状态。

**理由**：F017 实测的 `@theia/plugin-ext@1.76.0` 就是这个版本，
**这样「PoC 测过的」和「我们二开改的」是同一份代码。**

**写进 `vendor/theia.lock.json`（或沿用仓库已有的 lock 格式）：**

```json
{
  "upstream": "https://github.com/eclipse-theia/theia.git",
  "tag": "v1.76.0",
  "commit": "d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649",
  "lockedAt": "<你执行的日期>"
}
```

---

## 任务二：许可证义务（**不能省**）

`@theia/plugin-ext` 的 license 字段是：

```
EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
```

**我们选 EPL-2.0 那支**（GPL 那支会传染整个产品）。EPL-2.0 的义务是：

1. **分发时提供源码**（我们 vendored，天然满足）；
2. **保留版权声明与许可声明**（`LICENSE` 文件要留，不能删）；
3. **改变的文件要注明改了**（EPL-2.0 §3.2）；
4. **不能把 EPL 代码和我们的代码混成一个文件后只按我们的许可分发**。

**要做的事：**

- `vendor/theia/LICENSE` **原样保留**，不删不改；
- `vendor/theia/NOTICE`（如果上游有）原样保留；
- **新建 `vendor/README.md`**，写清：
  - 上游地址、锁定 commit、日期；
  - 「本目录内的文件若被 Mcode 修改，修改处标注 `// [MCODE] 原因` 并记入 `patches/theia/`」；
  - 分发时的义务说明。

**⚠️ 我不是律师，这不是法律意见。** 但「源码进来、LICENSE 留着、改动可追溯」
这三条是最低限度的工程诚实，缺了任何一条，将来打包分发都会有麻烦。

---

## 任务三：能构建

**这一步是这张卡的核心验证。**

```
1. `cd vendor/theia`（或等价路径）
2. 按上游的方式装依赖（Theia 用 yarn，看它的 package.json / CONTRIBUTING）
3. 只构建 `@theia/plugin-ext`（不要构建整个 Theia —— 那是几十分钟）
4. 产出应当是一个可 require 的 `lib/`
```

**如果构建不起来，这张卡就停在「卡在哪」，不要为了让它绿而绕过。**

**要报的数字**：构建耗时、产物体积、依赖包数、有没有原生模块编译失败。

> **⚠️ 提前警告：本机没有 Visual Studio C++ 工具链**（F017 实测：
> `node-gyp rebuild` 报 `Could not find any Visual Studio installation to use`）。
> Theia 的 `node-pty` 靠 **N-API 预构建**才能用。
> **如果你在构建时撞上要本地编译的原生模块，停下来报告，不要试图装 VS 工具链。**

---

## 任务四：验证「改源码真的生效」

**这是这张卡最重要的断言，也是最容易做成假的一条。**

做一次**最小、可观测、可回滚的源码改动**，证明「改源码 → 重新构建 → 行为变化」这条链是通的。

**建议的改动**（选一个，别多）：

- 在 `src/plugin/plugin-context.js`（或 `.ts`）里给 `vscode.env.appName` 改一个可辨识的值；
- 或者在一个常量上改一个字符串。

**验证方法**：

1. `grep` 改动前的构建产物，确认是旧值；
2. 改源码；
3. 重新构建；
4. `grep` 新的构建产物，确认是新值；
5. **还原源码，重新构建，确认回到旧值**（证明可逆）。

**⚠️ 这条的坑**：`grep` 构建产物时，**如果源码和产物里都能匹配到那个字符串，你分不出改的是哪个**。
所以：
- 改动要选**只出现在产物里、或者产物里有明确变换**的位置；
- 或者**直接 `require()` 产物并读那个值**，比 `grep` 硬。

**优先用 `require()` 读运行时值，不要只用 `grep`。**

---

## 任务五：套件

`theia-vendor-smoke`：

1. **`vendor/theia` 存在，且 `LICENSE` 文件在**（不是空的、不是我们的）；
2. **锁定 commit 与 `vendor/theia.lock.json` 一致**（`git -C vendor/theia rev-parse HEAD`）；
3. **构建产物存在**，且能 `require` 到 `@theia/plugin-ext` 的入口；
4. **「改源码 → 构建 → 行为变化 → 还原 → 行为复原」全链**（任务四那五步）；
5. **`patches/theia/`（如果选了方案 A）与源码的实际 diff 一致** ——
   如果 submodule 有未提交改动，要么它就是 patches 里记的，要么就是漏记了。

**每条先写预期红几条，再跑。**

**变异（至少两条）**：
- 把 `LICENSE` 删掉 → 第 1 条红；
- 把 lock 文件的 commit 改成别的 → 第 2 条红。

---

## 验收判据

1. **源码在仓库里**，且是 git 源码不是 npm 包（能构建是判据）；
2. **版本锁定**到一个明确 commit，可复现；
3. **LICENSE / NOTICE 原样保留**；
4. **`@theia/plugin-ext` 能单独构建**，产出可 `require`；
5. **「改源码 → 构建 → 行为变化 → 还原」全链验证通过**，且用的是**运行时读值**不是只有 grep；
6. **套件跑绿**，且两条变异各自红在预期位置；
7. **不碰 `apps/desktop/src/**`**（本卡不接产品）；
8. 不跑全量、不起 Electron。

---

## 回写

1. **选了 A 还是 B**，为什么，实测代价是多少（体积、clone 时间）；
2. **锁定到哪个 commit**，对应哪个 tag；
3. **构建耗时 / 产物体积 / 依赖包数**；
4. **任务四那次改动具体是什么**（改哪个文件、改什么值），以及五步验证的**实际输出**；
5. **有没有撞上要本地编译的原生模块**；
6. **仓库体积增加了多少**（`du -sh vendor/theia`）；
7. 有没有你做到一半发现「这个前提是错的」的；
8. 提交 SHA。

---

## ⚠️ 如果这条路根本走不通

**允许得出「不可行」的结论，而且那比硬做出来有价值。**

判断标准：如果 **任务三（构建）** 就过不去，或者构建产物体积/依赖数远超 PoC 的 307 MB
（比如因为要从源码构建整个依赖树而爆炸），**停下来，把数字写清楚**。

**用户已经决定走 Theia 二开，但决定的前提是「可行」。如果实测证明代价和 PoC 报的不一样，
那是一个必须让用户知道的坏消息，不是我们绕过去的问题。**
