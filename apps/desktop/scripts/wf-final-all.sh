#!/usr/bin/env bash
# 工作流线全量回归（交付前的最终验证）
cd "$(dirname "$0")/.."
OUT=.tmp/wf-final
mkdir -p "$OUT"
: > "$OUT/summary.txt"

SUITES=(
  engine-autostart-smoke
  workflow-engine-runtime-smoke
  workflow-engine-selection-smoke
  workflow-engine-bridge-smoke
  workflow-engine-view-owner-smoke
  workflow-executor-registry-order-smoke
  workflow-native-load-smoke
  workflow-reload-async-smoke
  workflow-validation-smoke
  workflow-repo-integrity-smoke
  workflow-save-version-integrity-smoke
  workflow-seed-smoke
  workflow-extension-seams-smoke
  workflow-ui-smoke
  workflow-view-smoke
  workflow-node-select-smoke
  workflow-live-smoke
  node-session-smoke
  node-live-smoke
  node-red-e2e-smoke
  node-red-theme-smoke
  node-red-deploy-reconciliation-smoke
  mcode-node-pack-smoke
  mcode-node-pack-ports-smoke
  t42-node-pack-smoke
  host-mcp-server-smoke
  host-mcp-stdio-smoke
  orchestration-ipc-smoke
  automation-smoke
  flow-migration-smoke
  flow-migration-identity-smoke
  t85-workflow-migration-preflight-smoke
  t51-workflow-guide-smoke
  t54-workflow-tools-discoverability-smoke
  engine-node-readiness-smoke
  engine-bootstrap-integrity-smoke
  engine-capability-matrix-smoke
  mcode-admin-smoke
  maint-m28-smoke
  maint-p1-workflow-smoke
  app-control-smoke
  arc005-workflow-card-ui-smoke
  t3-engine-trigger-gate-smoke
  t10-node-red-pause-license-smoke
  t88-node-red-license-closure-smoke
)

for s in "${SUITES[@]}"; do
  if [ ! -f "scripts/$s/run.sh" ]; then
    echo "$s MISSING" >> "$OUT/summary.txt"
    continue
  fi
  bash "scripts/$s/run.sh" > "$OUT/$s.log" 2>&1
  rc=$?
  n=$(grep -aoE '[0-9]+/[0-9]+ 通过' "$OUT/$s.log" | tail -1)
  if [ "$rc" = "0" ]; then
    echo "$s PASS ${n:-?}" >> "$OUT/summary.txt"
  else
    echo "$s FAIL rc=$rc ${n:-?}" >> "$OUT/summary.txt"
  fi
done

echo "=== SUMMARY ===" >> "$OUT/summary.txt"
grep -c PASS "$OUT/summary.txt" >> "$OUT/summary.txt"
cat "$OUT/summary.txt"
