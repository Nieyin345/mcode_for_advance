#!/usr/bin/env bash
# Headless smoke for **手机 HTTP 桥的通道对齐**(`renderer/lib/webApi.ts` vs
# preload 的 `window.api` vs 共用组件的实际调用)。
#
# 判据与三张清单见 main.ts 的文件头。本套只读源码 + 调 `createWebApi()` 的桩,
# 不发真 RPC、不起服务、不连网。
#
# `--external:typescript`:`main.ts` 用 TypeScript compiler API 做 AST / import 图
# 对账。打进 bundle 会撞上它内部的 `require("fs")`(ESM 产物没有 require);
# 仓库里 `apps/desktop/node_modules/typescript` 是指向 .pnpm 的符号链接,
# 运行时的 node 从产物所在目录向上解析得到它 —— 所以产物必须落在 apps/desktop/.tmp
# (与 mobile-pairing-smoke 同一个理由:外部化包的解析).
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-mobile-api-surface-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/mobile-api-surface-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:typescript \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
