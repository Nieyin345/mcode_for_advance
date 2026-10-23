#!/usr/bin/env bash
# 【T45】新 RPC 不许静默进入扩展委托面。
#
# ⚠️ 本套会在**变异段**临时改写 `apiCatalog.generated.ts` —— 与 `genoffice-source-smoke`
# 同一风险等级。为此:备份 → 精确插入一条 → 跑生成器 → `finally` 逐字节还原,
# 并在还原后用 `git status --porcelain` 断言目录文件干净。**不碰真实 vendor 树。**
#
# ⚠️ 生成器会写 `packages/contracts/src/appPermission.ts`。套件在**现状**段只读不写
# (生成器的正常路径输出与现有文件逐字节相同,断言会证明这一点);若某天真的产生了
# diff,那是**仓库漂移**,应让套件红,而不是默默覆盖 —— 所以下面把「运行前的字节」
# 记录下来做断言,而不是回滚。
set -euo pipefail
cd "$(dirname "$0")/../.."        # → apps/desktop
source scripts/lib/esbuild-path.sh

OUT=$(mktemp -d /tmp/mcode-t45-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t45-permission-map-drift-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
