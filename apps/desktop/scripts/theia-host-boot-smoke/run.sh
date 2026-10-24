#!/usr/bin/env bash
set -euo pipefail
# F023: the Theia extension host boots on Windows, a real extension runs end to
# end, and the install-time permission report is not a constant.
#
# Slow by design: it forks a real Node child process, completes a MessagePack
# handshake over stdio[4], loads an extension and invokes a command in it.
# Budget ~15 s cold (the handshake itself has a 15 s cap).
#
# `THEIA_SMOKE_REAL_EXT=<dir>` additionally reports how far a real extension gets.
# ── run.sh 的路径用法（T145 的教训）────────────────────────────────
# `$0` 在 `cd` 之后**仍然持有调用者给的相对路径**，所以先把它固化成绝对路径。
HERE="$(cd "$(dirname "$0")" && pwd)"
# $HERE = <repo>/apps/desktop/scripts/theia-host-boot-smoke → 仓库根是 4 层之上
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT/apps/desktop"

OUT=$(mktemp -d /tmp/mcode-theia-host-boot.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find "$ROOT/node_modules/.pnpm" -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "${ESBUILD:-}" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 的 createRequire 非有不可：sql.js 那条理由之外，本套件自己的
# `host.ts` 也用 `createRequire` 去 require vendor/theia 的构建产物。
"$ESBUILD" "$HERE/main.ts" \
  --bundle --platform=node --format=esm \
  --tsconfig="$ROOT/apps/desktop/tsconfig.json" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/modules/theiaHost/host.js="$ROOT/apps/desktop/src/main/modules/theiaHost/host.ts" \
  --alias:@main/modules/theiaHost/installConsent.js="$ROOT/apps/desktop/src/main/modules/theiaHost/installConsent.ts" \
  --alias:@main/modules/theiaPermissionReport.js="$ROOT/apps/desktop/src/main/modules/theiaPermissionReport.ts" \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_REPO_ROOT="$ROOT" MCODE_SMOKE_SUITE_DIR="$HERE" node "$OUT/smoke.mjs"
