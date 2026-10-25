#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-custom-ui-native.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
mcode_esbuild scripts/mcode-custom-ui-native-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/workflowEngines/registry.js=./scripts/mcode-custom-ui-native-smoke/stubs/registry.ts \
  --alias:@main/orchestration/library.js=./scripts/mcode-custom-ui-native-smoke/stubs/library.ts \
  --alias:@main/orchestration/automationRunner.js=./scripts/mcode-custom-ui-native-smoke/stubs/runner.ts \
  --alias:@main/store/repositories.js=./scripts/mcode-custom-ui-native-smoke/stubs/repositories.ts \
  --alias:@main/library/trash.js=./scripts/mcode-custom-ui-native-smoke/stubs/trash.ts \
  --alias:@main/library/groupRegistry.js=./scripts/mcode-custom-ui-native-smoke/stubs/groups.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
