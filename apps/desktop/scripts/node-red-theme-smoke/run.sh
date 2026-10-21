#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/node-red-theme-smoke/main.mjs

# Mutation verification on an isolated COPY, not on the shared source tree:
# removing editorTheme.page.css MUST turn the appearance assertion red.
mkdir -p .tmp
DIR=$(mktemp -d ".tmp/t47-theme-mutation.XXXXXX")
trap 'rm -rf "$DIR"' EXIT
cp src/main/workflowEngines/registry.ts "$DIR/registry.ts"
node scripts/node-red-theme-smoke/mutate.mjs "$DIR/registry.ts"
if MCODE_THEME_REGISTRY_SOURCE="$DIR/registry.ts" node scripts/node-red-theme-smoke/main.mjs > "$DIR/mutation.log" 2>&1; then
  echo "FAIL: T47 theme mutation did not turn smoke red"
  exit 1
fi
if ! grep -q "FAIL T47 bootstrap actively mounts" "$DIR/mutation.log"; then
  cat "$DIR/mutation.log"
  echo "FAIL: mutation red was unrelated to the expected appearance check"
  exit 1
fi
echo "MUTATION PASS: removing editorTheme.page.css makes editor theme check red (isolated copy)"
