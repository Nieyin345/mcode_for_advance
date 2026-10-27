# vendor/：上游源码快照

本目录存放 **Theia 二开** 所用的上游源码。它**不是 git submodule**，也**不是 vendored copy**，
而是沿用本仓库 `genoffice/` 的 **A′ 模式**：

- 上游源码放在一棵**独立的 git 检出**里（`vendor/theia/`，含自己的 `.git/`），
  **不进 Mcode 仓库**（`vendor/.gitignore` 忽略 `theia/`）；
- Mcode 对上游的改动**以 patch 文件形式**进仓库（`patches/theia/*.patch`，目前为空）；
- 身份与可复现性由 `vendor/theia.lock.json` + `theia-vendor-smoke` 套件钉住。

> **为什么不用 submodule**：Theia 主仓约 15 MB（shallow `.git`）+ 55 MB 工作树，
> submodule 会让每次 clone Mcode 都要 `--recursive`；A′ 只在需要构建扩展宿主时
> 才克隆一次。选型实测数字见 `tasks/F/F022-theia-vendor-source.md`。
>
> **为什么不 vendor 进 git**：一是仓库体积（55 MB 源码 + 构建产物），
> 二是「我们改了什么」必须可审计 —— patch 是 diff，vendored copy 是一整份新文件。

## `vendor/theia-runtime/`：随仓库来的运行时（方案一）

**`vendor/theia-runtime/` 入库，`vendor/theia/` 不入库。**

- **`theia-runtime`**（141 MiB，零软链）—— 扩展运行所需的全部文件。
  `git clone` 之后它就在，**不需要 `npm ci`、不需要 `tsc --build`、不需要联网**。
- **`theia`**（A′ 独立检出）—— 只有你要**改 Theia 源码**或**重新生成 runtime** 时才需要。

### 首次 clone 之后

`pnpm install` 的 `postinstall` 会自动跑 `apps/desktop/build/link-theia-runtime.cjs`，
在 `theia-runtime/node_modules/@theia/` 下建 92 个 junction 指向本树 `packages/`。
**本地执行、不联网、约 1 秒。**

漏了这步的症状是「装了扩展但一条命令都没有」——所以 `theiaRoot.ts` 的
`hasLinkedPackages` 会在缺失时明确报错并给出修法，不静默失败。

### ⚠️ 为什么必须用链接，不能用目录副本

试过副本，**不行**。实测对照：

| `node_modules/@theia/core` 的形态 | 结果 |
|---|---|
| junction → 本树 `packages/core` | 扩展正常激活 ✅ |
| **真实目录副本**（内容字节一致） | `COMMANDS: []`，**没有任何报错** ❌ |

Theia 在加载扩展时会做路径一致性判断。副本让同一个包出现在两条不同路径下，
扩展的 `activate()` 就静默不执行 —— 宿主起来了、握手成功、`$activateByEvent`
也 resolve 了，只有命令表是空的。

### 重新生成 runtime

改了 Theia 源码、或升级上游之后：

```bash
cd vendor/theia && npm ci --ignore-scripts && ./node_modules/.bin/tsc --build dev-packages/private-re-exports
(cd packages/core && ../../node_modules/.bin/theia-re-exports generate)
./node_modules/.bin/tsc --build packages/plugin-ext packages/plugin-ext-vscode
cd ../.. && node apps/desktop/build/stage-theia-runtime.cjs
node apps/desktop/build/link-theia-runtime.cjs   # 建链接
bash apps/desktop/scripts/theia-staging-smoke/run.sh   # 验证（会比对两边内容是否一致）
```

`theia-staging-smoke` 第 4 节会比对 runtime 与 `vendor/theia` 的运行期文件；
不一致就红 —— 防生成物静默过期（本仓库为 `apiCatalog.generated.ts` 栽过一次）。

---

## 锁定身份

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/eclipse-theia/theia` |
| tag | `v1.76.0`（**tag 对象** `12f62a6b…`，解引用后的 commit 才是锁） |
| commit | `d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649` |
| 树 | `d368bf66f84e9f8f98472bd0f90b88fdb290ee3f` |
| 锁定日期 | 2026-10-24 |

`vendor/theia.lock.json` 是机器可读的那一份；两边不一致时**以套件 `theia-vendor-smoke` 为准**。

## 引导步骤（新环境重建这棵检出）

```bash
# 在 Mcode 仓库根执行
git clone --depth 1 --branch v1.76.0 --single-branch \
  https://github.com/eclipse-theia/theia.git vendor/theia
git -C vendor/theia rev-parse HEAD   # 必须是 d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649

cd vendor/theia
npm ci --ignore-scripts --no-audit --no-fund   # 2081 包 / 1.1 GB / 约 32 s

# --ignore-scripts 跳过了上游 postinstall；构建只缺两步（顺序不能反）：
# ① re-export 生成器自己的 lib/ 也不在上游 git 里，必须先建它（约 2 s）
./node_modules/.bin/tsc --build dev-packages/private-re-exports
# ② 生成 packages/core/shared 下的路径垫片（@theia/application-package/lib/*）
(cd packages/core && ../../node_modules/.bin/theia-re-exports generate)

# 宿主与 VS Code 初始化桥都必须构建（缺任意一个，F024 起 smoke 硬失败）
./node_modules/.bin/tsc --build packages/plugin-ext   # 冷构建约 44–47 s
./node_modules/.bin/tsc --build packages/plugin-ext-vscode
# 返回 Mcode 仓库根，统一执行：
# node apps/desktop/scripts/run-smokes.mjs theia-host-boot-smoke
```

> ① ② 的顺序是实测出来的：跳过 ① 直接跑 `theia-re-exports generate` 会报
> `Cannot find module '../lib/bin-theia-re-exports.js'`（2026-10-24 实测）。
> 跳过 ② 直接构建会报 9 处 `TS2307: Cannot find module '@theia/core/shared/@theia/application-package/lib/environment'`。

**为什么 `--ignore-scripts`**：本机没有 Visual Studio C++ 工具链（F017 实测），
而上游 `postinstall` 里有 `node-gyp install`、`theia-patch` 等步骤。
其中 **`theia-patch` 会打 `@lumino/widgets` 补丁（影响浏览器 UI 菜单事件）** ——
在真正把 Theia 宿主接进产品之前，那一步必须补做；本卡只验证扩展宿主的构建链，
不涉及 UI，所以先跳过并记录在案。

**注意**：`npm ci` 会提示 `EBADENGINE`（上游要求 node >= 24，本机 22.21.1）。
`tsc --build packages/plugin-ext` 在 22 上实测通过；如果将来出现与运行时版本相关的
构建失败，先看这条警告。

## 修改上游源码的规矩

1. **直接改 `vendor/theia/` 里的文件**。改完的源码**不入本仓库的 git**。
2. 每一处改动都要：
   - 在改动处加注释 `// [MCODE] <原因>`（EPL-2.0 §3.2 要求改变的文件注明改动）；
   - 用 `git -C vendor/theia format-patch` 导出到 `patches/theia/NNNN-*.patch`；
   - 在 `vendor/theia.lock.json` 的 `patchSeries` 追加一条（`revision` / `parentRevision` /
     `sha256` / `bytes` / `subject`，字段结构照 `patches/genoffice/` 的先例）。
3. **不要在 `vendor/theia` 里留未记录的改动** —— `theia-vendor-smoke` 第 4 节会检查
   `git status --porcelain --untracked-files=all` 为空（构建产物与 `node_modules`
   已被上游自己的 `.gitignore` 忽略，不算改动）。

## 许可证义务（EPL-2.0）

`@theia/plugin-ext` 的许可字段是：

```
EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
```

**Mcode 选 EPL-2.0 那一支**（GPL 那支会传染整个产品）。EPL-2.0 对我们的要求：

1. **分发时提供源码** —— 我们保留完整检出，天然满足；但**产品打包时必须把
   `vendor/theia` 的源码（或获取方式）随分发提供**，这一步在真正接入产品时由打包脚本负责，
   本目录现在只保证检出与许可文件在位。
2. **保留版权与许可声明** —— 上游根目录的 `LICENSE-EPL`、`LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION`、
   `LICENSE-MIT.txt`、`LICENSE-vscode.txt`、`NOTICE.md` **原样保留，不删不改**；
   `theia-vendor-smoke` 第 1 节校验它们在位且非空。
3. **改变的文件注明改动** —— 见上一节。
4. **不能把 EPL 代码与我们的代码混成一个文件后只按我们的许可分发** —— 适配层写在
   Mcode 自己的包里（将来），不往 Theia 文件里塞 Mcode 逻辑。

> 以上是工程义务清单，不是法律意见。
