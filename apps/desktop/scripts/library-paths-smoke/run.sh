#!/usr/bin/env bash
# Headless smoke for 文献库的**越界守卫**(`main/library/paths.ts`)。
#
# 为什么单独一套:那两处守卫(`notesImport.writeNote` 写、`ipc/library.dropAbs` 删)
# 一个会覆盖用户磁盘上的文件、一个会删掉用户的文件,而它们早先用的判据恒假 ——
# 库外路径一个都没拦住。这条路径没有别的套件覆盖(那两个调用点都要起整个 app 才走得到),
# 而它的失效是**静默**的:界面上一切正常,直到某天一条记录被写坏。
#
# 换成临时数据根(见 stubs/dataRoot.ts 里那句"没设就抛"):这套会真的建库、写行、
# 删文件,指错地方就是拿空库盖掉用户的聊天记录。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-library-paths-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-library-paths-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 数据根与日志换桩 —— 真的那两个都 import 了 electron。被测的代码一行都没改。
#
# `--banner` 那一行是给 **sql.js** 的(这套会真的建库),理由同 db-migrate-smoke:
# 它内部有 `require("node:fs")`,而定死的 ESM 输出没有 `require`。
#
# `paths.ts` 自己**不用换桩**:它原先 import 了 electron 的 `app` 但一行都没用到,
# 已经删掉 —— 所以它能原样打进无头包。这是这套脚本成立的前提。
"$ESBUILD" scripts/library-paths-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
