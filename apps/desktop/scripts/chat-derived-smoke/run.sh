#!/usr/bin/env bash
# Perf backlog #6: ChatPane's whole-history derivations (beforeMap, planBlocks,
# historyTexts) must stay correct AND keep their identity across streaming
# delta flushes. Bundles the real components/chat/chatDerived.ts with esbuild
# (react aliased to a tiny single-component useState stand-in) and runs it.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-chat-derived-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
"$ESBUILD" scripts/chat-derived-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/chat-derived-smoke/react-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
