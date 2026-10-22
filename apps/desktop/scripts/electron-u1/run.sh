#!/usr/bin/env bash
# T16 —— 真 Electron U1 旅程骨架：三条示例旅程（纯 UI / 文件副作用重开 / 故意失败）。
#
# 两趟：
#   1. 正常跑 —— 期望退出码 **1**（唯一"失败"的是故意失败旅程，且形态符合预期）；
#      旅程 1/2 必须 all-pass；
#   2. 变异跑 —— 把断言执行（assertionStatus）换成无条件通过，同样的旅程必须
#      **不再**出现预期失败：退出码从 1 变 0，deliberate-failure 的 literalStatus
#      由 FAIL 翻成 PASS。这证明第一条的"红"真的来自断言判定，而不是骨架自己崩了。
#
# 本脚本退出码：0 = 两趟都符合预期且 verify.mjs 全部判据通过；非 0 = 判据不成立。
# 证据（截图 / DOM / 每步记录 / suite-summary.json）留在仓库 .tmp/electron-u1/ 下，
# 永不自动清理 —— 失败现场必须保留。
set -euo pipefail
cd "$(dirname "$0")/../.."

LOG_DIR=$(mktemp -d /tmp/mcode-electron-u1.XXXXXX)
trap 'rm -rf "$LOG_DIR"' EXIT

echo '── 1/2 正常跑：三条旅程 ──'
set +e
node scripts/electron-u1/build.mjs 2>&1 | tee "$LOG_DIR/normal.log"
NORMAL_RC=${PIPESTATUS[0]}
set -e
echo "normal run exit code: $NORMAL_RC（期望 1）"

NORMAL_EVIDENCE=$(sed -n 's/^U1 evidence: //p' "$LOG_DIR/normal.log" | head -1)

echo
echo '── 2/2 变异跑：assertionStatus 无条件 PASS ──'
set +e
node scripts/electron-u1/build.mjs --mutation=unconditional-pass 2>&1 | tee "$LOG_DIR/mutation.log"
MUT_RC=${PIPESTATUS[0]}
set -e
echo "mutation run exit code: $MUT_RC（期望 0）"

MUT_EVIDENCE=$(sed -n 's/^U1 evidence: //p' "$LOG_DIR/mutation.log" | head -1)

node scripts/electron-u1/verify.mjs \
  --normal-summary "$NORMAL_EVIDENCE/suite-summary.json" \
  --mutation-summary "$MUT_EVIDENCE/suite-summary.json" \
  --normal-rc "$NORMAL_RC" \
  --mutation-rc "$MUT_RC" \
  --mutation-flag "$(grep -c 'U1 MUTATION ACTIVE' "$LOG_DIR/mutation.log" || true)" \
  --out "$LOG_DIR/verify.json"
VERIFY_RC=$?

if [[ -n "$NORMAL_EVIDENCE" ]]; then echo "normal evidence:   $NORMAL_EVIDENCE"; fi
if [[ -n "$MUT_EVIDENCE" ]]; then echo "mutation evidence: $MUT_EVIDENCE"; fi

if [[ "$VERIFY_RC" -ne 0 ]]; then
  echo 'electron-u1: FAIL'
  exit 1
fi
echo 'electron-u1: PASS —— 正常跑按预期红（exit 1）、变异跑全绿（exit 0）、deliberate-failure 由 FAIL 翻 PASS'
