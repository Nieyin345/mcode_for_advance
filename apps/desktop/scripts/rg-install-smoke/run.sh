#!/usr/bin/env bash
# Headless smoke 给 **ripgrep 的一键安装**:
#   - `src/main/lib/rgInstall.ts`(228 行,零覆盖)—— 下载 / 解压 / 校验 / 采纳
#   - `src/main/ipc/rg.ts`(36 行,零覆盖)—— `rg.status` / `rg.install` 两条 handler
#
# ## ⚠️ 安全前提(这套脚本能跑的全部理由)
#
# 这条安装**往磁盘写、往磁盘 rename**。目标根是 `rgInstall.doInstall()` 第一行的
# `app.getPath("userData")`,下载临时目录、解压目录、最终那个 `rg.exe` 全挂在它下面。
# 所以:
#
#   1. `MCODE_SMOKE_INSTALL_ROOT` → 本脚本 `mktemp -d` 出来的目录,并且
#      **stubs/electron.ts 只认这一个环境变量**(没设就抛,绝不回落到真 userData);
#   2. `main.ts` 第一个动作就是**断言桩指到的根 == 本脚本给的根**,对不上 exit 1。
#      无头脚本下真的 `app` 本来是不存在的 —— 那条断言就是"别写到用户真目录里去"的
#      唯一一道门,不是装饰。**先断言设上了再往下走。**
#   3. `MCODE_SMOKE_DATA_ROOT` → 另一个 `mktemp -d`(桩里没设就抛)。本套不建库,但
#      `db.ts` 的 `initDb()` 会对不存在的路径**新建一个空库**,而 sql.js 的
#      `db.export()` 是**重写整个 `mcode.db`** —— 指错了就是拿空库盖掉用户的聊天记录。
#
# ## 它不碰网络
#
# 所有下载都打给 `127.0.0.1` 上那台夹具服务器(scripts/rg-install-smoke/fixtures.ts),
# 它按路径决定返回什么字节、并记下每一次命中。三条**真的**下载 URL 由
# `--alias:@main/lib/rgInstall.js` → `stubs/rgInstallStub.ts` 换掉 —— 不是!见下:
#
# ⚠️ `--alias:` **只认包名,换不掉相对 import**,而这个文件里根本没有"下载 URL 表"
# 这个可换的模块:三条 URL 是**同一个文件里的模块级常量**。所以换地址的办法是让被测
# 文件自己提供一个入口(`setDownloadUrls`,见 rgInstall.ts 里那段注释):**只有本套
# 会调它**,产品路径从不调 → 参数为 null 时行为与改动前逐字节相同。
#
# 两个桩(`dataRoot` / `logger`)直接从 `run-store-smoke/stubs/` 复用 —— 那两份是
# "没设就抛 / 故意不静默"的标准取舍,不该各写一份不一样的。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-rg-install-smoke.XXXXXX)
INSTALL_ROOT=$(mktemp -d /tmp/mcode-rg-install-root.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-rg-install-data.XXXXXX)
trap 'rm -rf "$OUT" "$INSTALL_ROOT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(同 run-store-smoke/run.sh 同一段理由)。
#
# 三个 alias:
#   - `electron`  整个包 —— 安装目标根是 `app.getPath("userData")`,见上面的安全前提;
#   - `rgSearch`  真的那个 `resolveRg()` 里有一句 `which("rg")`(会 shell out 到
#     `where.exe`)。本套要断的是"安装出来的那份二进制",不是"这台机器恰好有没有 rg";
#   - `dataRoot` / `logger` —— 从 `run-store-smoke/stubs/` 复用的两个标准桩。
"$ESBUILD" scripts/rg-install-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/rg-install-smoke/stubs/electron.ts \
  --alias:@main/lib/rgSearch.js=./scripts/rg-install-smoke/stubs/rgSearch.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_INSTALL_ROOT="$INSTALL_ROOT"
export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
