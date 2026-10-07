#!/usr/bin/env bash
# Claude 轮预算 token 口径(turnProcessedTokens)回归,只用真实适配器。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-claude-budget-usage.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "Existing esbuild dependency not found; refusing network fallback." >&2
  exit 127
fi

"$ESBUILD" scripts/claude-budget-usage-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
