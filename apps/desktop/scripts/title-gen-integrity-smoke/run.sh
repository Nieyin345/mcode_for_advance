#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-title-integrity.XXXXXX")
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcode-title-home.XXXXXX")
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/title-gen-integrity-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
 --alias:@main/store/repositories.js=./scripts/title-gen-integrity-smoke/stubs/repositories.ts \
 --alias:@main/window.js=./scripts/title-gen-integrity-smoke/stubs/window.ts \
 --alias:@main/lib/sessionSync.js=./scripts/session-fork-smoke/stubs/sessionSync.ts \
 --alias:@main/lib/dialogText.js=./scripts/title-gen-integrity-smoke/stubs/dialogText.ts \
 --alias:@main/ipc/git.js=./scripts/vision-relay-heavy-smoke/stubs/git.ts \
 --alias:@main/providers/claude-sdk/customEnv.js=./scripts/vision-relay-heavy-smoke/stubs/customEnv.ts \
 --alias:@main/providers/claude-sdk/sdkBinaryPath.js=./scripts/vision-relay-heavy-smoke/stubs/sdkBinaryPath.ts \
 --alias:@anthropic-ai/claude-agent-sdk=./scripts/vision-relay-heavy-smoke/stubs/sdk.ts \
 --outfile="$OUT/main.mjs" --log-level=error
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" node "$OUT/main.mjs"
