#!/usr/bin/env bash
# 场景部署**渲染端**的回归网(MC-058 残余)。
#
# 判据全在 `src/renderer/components/settings/sceneDeployView.ts` 那批**纯函数**上 ——
# 它们只 import type + 契约层的确定性纯函数(validateSceneSpec / compileScenePlan /
# compileSceneCommands),不碰 DOM / store / api,所以 esbuild 打包后直接 node 跑,
# 不需要任何 --alias(与 `scene-spec-smoke` 同款)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scene-deploy-view-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/scene-deploy-view-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
