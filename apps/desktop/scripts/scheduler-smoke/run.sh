#!/usr/bin/env bash
# Headless smoke for the workflow scheduler — **core** (batch E).
#
# 调度器三套之一(A5 拆分,2026-10-07):
#   scheduler-smoke(本套)  并发/依赖/失败传播/取消/前置检查/提示词/边界
#   scheduler-data-smoke   上下文继承 / {{...}} 变量 / 产出约束
#   scheduler-flow-smoke   岔路口/回头/流程记录/续跑/运行前先问/自动重试
# 三套共用 scripts/scheduler-smoke/harness.ts(假执行器 + 夹具)。
#
# Bundles main.ts with esbuild (tsconfig paths apply) and runs it in plain node.
# No electron, no DOM, no provider: the scheduler takes its node executor through
# a port, so the smoke injects a fake one that records start/end timestamps and
# can be told to fail or to stall.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scheduler-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ESM, not CJS: the smoke drives the scheduler with top-level await, which the
# cjs output format rejects. Nothing in this bundle is CommonJS-only (no
# react-dom/server here, unlike the workflow-view smoke).
"$ESBUILD" scripts/scheduler-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
