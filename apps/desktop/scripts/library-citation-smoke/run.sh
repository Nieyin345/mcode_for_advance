#!/usr/bin/env bash
# Headless smoke for 四个**没有任何套件覆盖**、而用户会照着做事的模块:
# `library/citationExport.ts` / `library/metadata.ts` / `library/journalRank.ts` /
# `library/oaResolvers.ts`。
#
# ## 数据根必须换掉
#
# `journalRank` 会去 `<数据根>/workflows/jcr.db` 找期刊库,`citationExport` 会往
# `<数据根>/library/exports/` **写文件**;而 `db.ts` 的 `initDb()` 在一个不存在的路径上
# 会**新建一个空库** —— 指向真数据根就是拿空库盖掉用户的聊天记录。所以数据根一律
# 换成 `mktemp -d`(复用 db-migrate-smoke 的 dataRoot/logger 桩:那个桩在环境变量没
# 设时直接抛,不回落到默认值),跑完就删。
#
# ## 别名分三档,理由各不相同
#
#   - dataRoot / logger —— 真的那两个 import 了 electron,直接复用 db-migrate-smoke
#     的老桩(不另抄一份:`dataRoot` 那个桩的环境变量检查就是"别指到真数据根"的守卫,
#     抄一份出来等于有两个地方要跟着改);
#   - broadcast —— import 图是 `citationExport → repositories → library/broadcast`,
#     导出这条路一次都不发广播,但静态 import 把 window 与 RuntimeManager 都拖进来。
#     在 broadcast 这一刀切掉(同 library-import-smoke / mcode-admin-smoke);
#   - window / RuntimeManager —— 万一有别的东西走到它们,给的是**显式报错**式的替身,
#     不是空实现(静默返回 undefined 会让断言去猜)。
#
# ## 为什么还要换 `node:child_process`
#
# `metadata.ts` 里有**两套**取数实现:`fetchJson` 走 `./http.js`(上面那条已接管),
# 而 `fetchText` 在本文件里又抄了一遍 curl 策略,唯一的外部动作是 `spawn("curl", …)`
# —— 于是 arXiv(只有 Atom XML,必须走 fetchText)**完全不经过 `http.js`**,套件登记的
# 路由它看不见,会真去连 export.arxiv.org。实测撞到过:断言以为在比夹具里的标题,
# 拿回来的是线上此刻那篇论文,于是既不确定、又不测被测代码。
#
# `child_process` 在本 bundle 里只有两处用(`grep` 过):`library/http.ts`(上面整份换掉,
# 不进产物)与 `library/metadata.ts`(就是这里要拦的);`store/` 与 `lib/` 下没有别的
# 使用者,所以换掉它等价于只换掉 `fetchText` 的 curl。桩在 `stubs/curl.ts`,没登记的
# URL 直接抛(与 `http.ts` 同一个口径)。
#
# ## `./http.js` 为什么是 `--external` 而不是 `--alias`
#
# esbuild 的 `--alias` 只收包名式名字 —— 给相对名字(哪怕就是 `./http.js`)会直接
# `Invalid alias name` 报错;而给 `http.js` 这种包名式名字又匹配不上相对说明符,
# 实测两种情况都不生效。而 `metadata.ts` / `oaResolvers.ts` 对它的引用恰好是相对的。
#
# 所以走另一条机制:让这条 import **原样留在产物里**(`--external:./http.js`),
# 再把套件里那个同名文件(`http.ts`)**改名输出成 `$OUT/http.js`** 与
# `smoke.mjs` 并排。于是 `main.ts`(它是从 `./mainHttpStub.js` 导入同一个实例的)
# 与 `metadata.ts` 在运行期拿到的是**同一个模块实例** —— 两边各拿一份的话,
# `main.ts` 登记的路由在被测代码里根本看不见,而这个套件会用一句
# 「没登记的地址」把这件事喊出来,而不是静默绿着。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-cite-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-cite-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-citation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:./http.js \
  --alias:node:child_process=./scripts/library-citation-smoke/stubs/curl.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-citation-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-citation-smoke/stubs/runtimeManager.ts \
  --alias:@main/library/broadcast.js=./scripts/library-citation-smoke/stubs/broadcast.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# `--external:./http.js` 那条 import 的落点 —— **必须**与 smoke.mjs 并排
# (文件名要正好是 `http.js`,否则运行期解不到)。
"$ESBUILD" scripts/library-citation-smoke/http.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/http.js" --log-level=error

# `http.js` 是 `.js` 后缀的 ESM,而它的作用域里没有 `"type": "module"` —— Node 会
# 先按 CJS 试一次、再打一句 MODULE_TYPELESS 警告并重解析。功能不受影响(实测通过),
# 但那句警告会指向**用户主目录**的 package.json,读日志的人会以为是环境问题。
# 在产物目录放一个最小的 package.json 声明 ESM,警告就没有了。
printf '{"type":"module"}\n' > "$OUT/package.json"

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
