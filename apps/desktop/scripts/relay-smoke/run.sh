#!/usr/bin/env bash
# Headless smoke for 中继(`main/relay/RelayManager.ts` + `main/ipc/relay.ts`)。
#
# 这两个文件此前零覆盖。中继是"手机在地铁上也能连回桌面"那条路:拿用户填的 VPS 做
# SSH 反向隧道,把桌面的移动端 HTTP 服务挂到公网上。它出错的样子不是报错,是
# **手机连不上而界面显示"已连接"**,或者**断了之后一秒重连一次把对端打爆**。
#
# ## 为什么不连外网、也没有真 sshd
#
# 另一端在用户的 VPS 上。本套要验的是中继**自己**在那条链路上做对没有(退避、
# 清定时器、错误文案、半截状态),这些全在客户端一侧决定。所以假 VPS 是
# `ssh2.Server` 起在**回环 + 随机端口**上(同 mobile-pairing-smoke 把 HTTP 服务绑
# 回环的做法),服务端的每一种反应按需摆出来 —— 见 scripts/relay-smoke/fakeVps.ts。
#
# ## 为什么需要一个真的 sqlite 库
#
# `connect()` 第一句是 `awaitDb()`,`getConfig()` 读 settings 表,而
# `stubs/dataRoot.ts` 那个替身**没设 MCODE_SMOKE_DATA_ROOT 就抛** —— 指错地方等于
# 拿空库盖掉用户的聊天记录(sql.js 的 `db.export()` 整份重写文件)。
#
# ## 别名五档
#
#   - **electron** —— `main/` 下一堆文件直接 import 它(store/db 那条路会拖到)。
#     照 mobile-pairing-smoke 的做法整包换,见 stubs/electron.ts;
#   - dataRoot / logger —— db-migrate-smoke 的老桩;
#   - window —— `RelayManager.setState()` 的 `sendToRenderer`,本套主要的观察面;
#   - mobile/MobileHttpServer —— 真的那个 `startMobileServer()` 是
#     `listen(port, "0.0.0.0")`,直接调等于把跑测试的这台机器挂到局域网上。
#     替身只提供 `isMobileServerRunning` / `getMobileServer().port`,外加一个
#     **真的**绑在 127.0.0.1 上的哨兵 HTTP 服务 —— 中继的 `pipeToLocal` 那段
#     数据通路因此是真跑通的;
#   - forwarder.py?raw —— 见文件末尾那行 `--loader:.py=text`。
#
# ## `--external:ssh2` + bundle 旁边一份 node_modules 软链
#
# ssh2 打包进来会连坐 `cpu-features`(原生 `.node`,esbuild 解析不了)以及它自己
# CJS 里的 `__dirname`(定死的 ESM 输出里没有)。两者报出来的都不是"中继坏了"。
# 所以让这条 import 原样留在产物里,再把 app 的 node_modules 软链到 bundle 旁边
# (照 library-adopt-smoke 给 pdfjs-dist 的那一手;不设 NODE_PATH —— 那条路只管 CJS)。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 本套要拿磁盘上那份真的 `forwarder.py` 与 SFTP 上传的逐字节比。产物在临时目录里跑,
# 从 `import.meta.url` 往上找必然找不着(见 fakeVps.ts 的注释),所以根从这里给。
export MCODE_SMOKE_APP_ROOT="$PWD"

OUT=$(mktemp -d /tmp/mcode-relay-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-relay-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ln -s "$PWD/node_modules" "$OUT/node_modules"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 给 sql.js:它的 asm 构建里有 `require("node:fs")` / `require("node:crypto")`,
# 而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成一句
# `throw new Error('Dynamic require of "node:fs" is not supported')`。
"$ESBUILD" scripts/relay-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --loader:.py=text \
  --external:ssh2 \
  --alias:electron=./scripts/relay-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/relay-smoke/stubs/window.ts \
  --alias:@main/mobile/MobileHttpServer.js=./scripts/relay-smoke/stubs/mobileServer.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
