#!/usr/bin/env bash
# 无头 smoke for **两件会动用户磁盘、却一套测试都没有的模块**:
#   - `src/main/env/toolInstall.ts`(文档工具链的装/卸:真的下载、真的解包、真的
#     往 `<userData>/tools/` 里搬一棵树、装完还往用户的解释器里跑 pip)
#   - `src/main/ipc/updater.ts`(更新器的三个 IPC 出口)
#
# ## ⚠️ 三条安全前提 —— 这一套能跑的全部依据
#
# 1. **绝不出网、绝不真下载。** `fetch` 被整个换掉(见 main.ts 的 fetch 桩):
#    凡是没登记的 URL 一律抛。假的包体在内存里现造,假地址只是让断言读起来像真的。
# 2. **绝不真装东西。** 三个落点全部指向 `mktemp` 出来的目录:
#      - `MCODE_SMOKE_USER_DATA` → `stubs/electron.ts` 的 `app.getPath("userData")`
#        (**没设就抛,不回落**)。rg 的落点与「工具根没注册时会落到哪儿」都从这里派生;
#      - 工具根由 main.ts 显式 `setToolRoot()` 指到 `<USER_DATA>/tools`,而且**先断言
#        钉上了**再往下走 —— 无头脚本下它本来是 null,那时 installer 会落到
#        `app.getPath("userData")`,也就是用户真实的 `%APPDATA%\@mcode\desktop`;
#      - 暂存目录 / 下载临时文件本来就在 `os.tmpdir()` 里,而且 `finally` 清。
#    **不碰数据库**:这两个模块都不 import `db` / `repositories`,所以这里没有
#    `MCODE_SMOKE_DATA_ROOT`。
# 3. **子进程按命令名路由**(`stubs/childProcess.ts`)。`pip` / 自解压 exe / `tlmgr`
#    全部登记成桩;`tar` **故意不登记** —— 让它去跑本机真的 System32\bsdtar 解一个
#    本套现造的真 zip。「解包」这一步因此是真验的,不是模拟的。
#
# ## 为什么要把 `node:child_process` / `node:fs` 也换桩
#
# 被测的三个文件都从**内建模块**拿 `execFile` / `spawn` / `rename`,要拦它们只有
# 换内建模块本身。esbuild 的 `--alias:` **认 `node:` 前缀**(实测:`--alias:node:fs=…`
# 生效),所以一条别名就够 —— 不需要 `--require` 那种运行期钩子(那条路也不好走:
# node 的内建模块表是只读的,`require("fs")` 根本改不动)。
#
# ## ⚠️ 相对 import 换不了桩 —— 三类依赖三种接法
#
# `toolInstall.ts` 里这三条 import 是**相对路径**:
#
#     ./managedToolRoots.js   ./toolchain.js   ./agentEnv.js
#
# 而 esbuild 的 `--alias:` **不收相对名字**(报 `Invalid alias name: "./toolchain.js"`)。
# 三条路,按「桩要不要换掉实现」分:
#
#   1. **`./managedToolRoots.js` —— 不换桩,用真的。** 那个文件只有 `node:fs` /
#      `node:path` 和一个 type-only 的 `@contracts/ipc`,没有 electron、没有子进程、
#      没有副作用,`import` 它就是纯函数。**不换桩就没有"两份实例"可言**:
#      `main.ts` 按 `@main/env/managedToolRoots.js` 引、`toolInstall.ts` 按
#      `./managedToolRoots.js` 引,esbuild 认出是同一个文件 → 一个模块实例,
#      `setToolRoot` 写的 `getToolRoot()` 读得到。(这条踩过坑,见下。)
#   2. **`./toolchain.js` / `./agentEnv.js` —— 整条换掉。** 它们的替身跟真文件毫无
#      关系(真那个会 spawn 一堆 where/which、会改本进程的 PATH、会真的去装 pip 包),
#      所以 `--external:` 把 import 按原样写进产物,再把同名的桩打一份放到
#      **bundle 旁边**。落点必须是 `$OUT/` 而不是 `$OUT/stubs/`:外置路径是相对
#      **bundle 自己** 解析的,放错了报 `ERR_MODULE_NOT_FOUND`,而且看着像"桩打错了"。
#   3. **`@main/...` 那几个(电子/窗口/更新器/logger)—— 别名。** 包名 `--alias:` 认。
#
# ## ⚠️ 两份模块实例 —— 这一套最贵的那个坑
#
# 第 2 条让 `toolchain.js` / `agentEnv.js` **各有一份打进主 bundle、一份在 $OUT**。
# 如果桩里写 `export const counts = {…}`,断言读的是主 bundle 那份、被测代码++
# 的是 $OUT 那份,**两个对象** —— 断言会永远看到 0,而且看起来像"被测代码没调它"。
# 解法是 `stubs/shared.ts`:状态挂在 `globalThis` 上,先求值的那一份建、后求值的
# 那一份取到已有的。
#
# 这条坑**踩过一次,而且踩得很贵**:第一版把 `managedToolRoots` 也外置了,于是
# `setToolRoot` 写进外置那份、主 bundle 里那份 `getToolRoot` 返回 null ——
# installer 报了一句"工具根目录还没注册",批量红。**当时的读数是"桩没生效",真
# 正该担心的是另一头**:`getToolRoot()` 为 null 时 installer 会退到
# `app.getPath("userData")`,也就是用户真实的 `%APPDATA%\@mcode\desktop`。是
# `installPandoc` 里面那条"根没注册就拒装"的防线先拦住,才没在真目录里建树。
# 中间还试过"别名 + 逐字复刻的桩文件",那也需要**同一个文件路径**,比直接用真的
# 更绕。现在这条路(不换桩)是三个里最短的。
#
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-updater-tools-smoke.XXXXXX)
USER_DATA=$(mktemp -d /tmp/mcode-updater-tools-userdata.XXXXXX)
trap 'rm -rf "$OUT" "$USER_DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 被外置的那几个模块要在 `$OUT` 里能被解析到 node 内建以外的依赖;`--platform=node`
# 把内建标成 external,所以只需要一份 node_modules 让 esbuild 自己找得到它的运行时。
ln -s "$PWD/node_modules" "$OUT/node_modules"

BANNER='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'

# ── 第一、二趟:那三个「外置桩」各自的 bundle ──
#
# ⚠️ 落点是 `$OUT/` **不是** `$OUT/stubs/`。esbuild 把外置路径 `./toolchain.js`
# **按原样**写进产物,而它是相对**bundle 自己**解析的 —— 写成 `stubs/` 就会去找
# `$OUT/toolchain.js` 而落空(`ERR_MODULE_NOT_FOUND`),而且报错看起来像"桩打错了"
# 而不是"放错了地方"。
#
# 它们之间还会互相 import(`./shared.js`)—— 也一并外置,于是**所有**桩共享
# `$OUT/shared.js` 这一份,而不是各自被打进去一份。
for name in shared toolchain agentEnv rgSearch; do
  "$ESBUILD" "scripts/updater-tools-smoke/stubs/$name.ts" \
    --bundle --platform=node --format=esm \
    --tsconfig=tsconfig.json \
    --banner:js="$BANNER" \
    --external:./shared.js \
    --outfile="$OUT/$name.js" --log-level=error
done

# ── 第三趟:主体 ──
#
# `--alias:` 是给**包名**的(`@main/…`、`electron`、`node:…`);
# `--external:./x.js` 是给 **toolInstall.ts 里那两条要换掉的相对 import**(见文件头);
# `./managedToolRoots.js` **两边都不写** —— 让 esbuild 把真那份内联进来,一份实例。
"$ESBUILD" scripts/updater-tools-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="$BANNER" \
  --alias:electron=./scripts/updater-tools-smoke/stubs/electron.ts \
  --alias:node:child_process=./scripts/updater-tools-smoke/stubs/childProcess.ts \
  --alias:node:fs=./scripts/updater-tools-smoke/stubs/fs.ts \
  --alias:node:fs/promises=./scripts/updater-tools-smoke/stubs/fs.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/updater-tools-smoke/stubs/window.ts \
  --alias:@main/updater.js=./scripts/updater-tools-smoke/stubs/updater.ts \
  --alias:@main/onlyoffice/localInstall.js=./scripts/updater-tools-smoke/stubs/onlyofficeInstall.ts \
  --external:./toolchain.js \
  --external:./agentEnv.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_USER_DATA="$USER_DATA"

echo "userData = $USER_DATA"
node "$OUT/smoke.mjs"
