#!/usr/bin/env bash
# Headless smoke for the workflow scheduler — data (上下文继承 / {{...}} 变量 / 产出约束).
# 调度器三套之一(A5 拆分,2026-10-07);共用 scripts/scheduler-smoke/harness.ts。
#
# Bundles scripts/scheduler-data-smoke/main.ts with esbuild (tsconfig paths apply) and
# runs it in plain node. No electron, no DOM, no provider: the scheduler takes its
# node executor through a port, so the smoke injects a fake one that records
# start/end timestamps and can be told to fail or to stall. That is the only way
# to assert the four things the plan asked for — real concurrency, strict
# dependency ordering, failure propagation, and that cancel stops dispatch.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scheduler-data-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# ESM, not CJS: the smoke drives the scheduler with top-level await, which the
# cjs output format rejects. Nothing in this bundle is CommonJS-only (no
# react-dom/server here, unlike the workflow-view smoke).
"$ESBUILD" scripts/scheduler-data-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
