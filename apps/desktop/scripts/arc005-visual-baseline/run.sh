#!/usr/bin/env bash
# T01 ARC-005 U1; real Electron capture + provenance-preserving comparison.
set -euo pipefail
cd "$(dirname "$0")/../.."
# 【T141】`set -e` 在「命令是 if 条件的一部分」时**不生效**，而这条 `node build.mjs`
# 是裸命令 —— 它一非 0 就整脚本退出，后面的 token 比对一次都轮不到。
# 所以这里显式收它的码并转述，而不是依赖 set -e 的隐式行为。
build_rc=0
node scripts/arc005-visual-baseline/build.mjs || build_rc=$?
if [[ "$build_rc" -ne 0 ]]; then
  echo "arc005 visual build FAILED (exit=$build_rc) — token comparison skipped; see the message above"
  exit "$build_rc"
fi
# Exit code 2 means real, unregistered differences were FOUND, not that the
# screenshots/JSON are invalid. Keep evidence instead of suppressing the diff.
if node scripts/arc005-visual-baseline/compare.mjs; then
  echo 'arc005 visual compare: no unregistered differences'
else
  rc=$?
  if [[ "$rc" -ne 2 ]]; then exit "$rc"; fi
  echo 'arc005 visual compare: unregistered differences detected (see .tmp/arc005-visual/diff.md)'
fi
