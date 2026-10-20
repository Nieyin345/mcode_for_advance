#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-panelask.XXXXXX")
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcode-panelask-home.XXXXXX")
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/panel-ask-resilience-smoke/main.ts \
 --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
 --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
 --alias:@main/store/repositories.js=./scripts/vision-relay-heavy-smoke/stubs/repositories.ts \
 --alias:@main/ipc/git.js=./scripts/vision-relay-heavy-smoke/stubs/git.ts \
 --alias:@main/providers/claude-sdk/customEnv.js=./scripts/vision-relay-heavy-smoke/stubs/customEnv.ts \
 --alias:@main/providers/claude-sdk/sdkBinaryPath.js=./scripts/vision-relay-heavy-smoke/stubs/sdkBinaryPath.ts \
 --alias:@anthropic-ai/claude-agent-sdk=./scripts/vision-relay-heavy-smoke/stubs/sdk.ts \
 --outfile="$OUT/main.mjs" --log-level=error
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" MCODE_SMOKE_DATA_ROOT="$HOME_DIR/data" node "$OUT/main.mjs"
