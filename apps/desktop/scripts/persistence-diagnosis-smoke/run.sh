#!/usr/bin/env bash
# Headless smoke for **存盘失败诊断** —— `main/store/persistenceDiagnosis.ts`(报告 E3)。
# 见 main.ts 文件头:EPERM(被占)→ 说得出来、ENOSPC → 说得出来、认不出 → 不硬套。
#
# 纯模块(零依赖),所以不用换桩。`--banner` 照旧留着与其它套件一致。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-persistence-diagnosis-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/persistence-diagnosis-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
