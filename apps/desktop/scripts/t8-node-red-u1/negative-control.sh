#!/usr/bin/env bash
# T8 —— **负控**：故意改坏一个断言条件，证明旅程真的会红。
#
# 做法（不改产品代码、不改套件源码）：设置 `T8_U1_NEGATIVE_CONTROL=1`，正式旅程把
# 「Deploy 后原生 flows.json 里节点名应等于 X」的期望值换成一个**画布与磁盘都不可能
# 出现的哨兵名**。改名步骤仍把节点改成真实名字（`T8-已改名-DEPLOYED`），于是：
#
#   - 若断言真的在判 → `deploy-wrote-native-flows` 必红（name 不符），T16 退出码 2；
#   - 若断言被旁路（假绿）→ 正式旅程仍全绿，run.mjs 退出码 0/1 —— 那才是要抓的情况。
#
# 负控成立还要求：证据里**红的正是** `deploy-wrote-native-flows`，而不是骨架崩溃或
# 别的步骤（脚本会去最新的证据目录里核对 journey-result.json）。
#
# 脚本不修改任何源码，因此无需还原。
#
# 用法（在 apps/desktop 下）：bash scripts/t8-node-red-u1/negative-control.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

echo "== T8 负控：期望正式旅程在 deploy-wrote-native-flows 变红 =="
LOG=$(mktemp /tmp/t8-negative-control.XXXXXX.log)
trap 'rm -f "$LOG"' EXIT

T8_U1_NEGATIVE_CONTROL=1 node scripts/t8-node-red-u1/run.mjs 2>&1 | tee "$LOG"
code=${PIPESTATUS[0]}
echo ""

if [[ $code -eq 0 ]]; then
  echo "T8 负控: FAIL（退出码 0 = 正式旅程仍是绿的）—— 断言没有在判" >&2
  exit 1
fi

# 证据目录由 build.mjs 打印（`U1 evidence: <path>`）；取最后一行。
EVIDENCE=$(grep -oE 'U1 evidence: .*$' "$LOG" | tail -1 | sed 's/^U1 evidence: //' | tr -d '\r')
RESULT="$EVIDENCE/node-red-canvas-load-edit-deploy-reopen/journey-result.json"
if [[ ! -f "$RESULT" ]]; then
  echo "T8 负控: FAIL（找不到证据 ${RESULT}，无法核对失败步骤）" >&2
  exit 1
fi

# 用 node 读 JSON（与仓库其它脚本同一取向：不写内联 python）。
STEP=$(node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const failed = (result.steps || []).filter((s) => s.status === "FAIL").map((s) => s.step);
  process.stdout.write(failed.join(","));
' "$RESULT")

echo "负控证据: $EVIDENCE"
echo "红的步骤: ${STEP:-（无）}"
if [[ "$STEP" == "deploy-wrote-native-flows" ]]; then
  echo "T8 负控: PASS（正式旅程在 deploy-wrote-native-flows 按预期变红，run.mjs 退出码 ${code}）"
  exit 0
fi
echo "T8 负控: FAIL（红的步骤是「${STEP}」，不是 deploy-wrote-native-flows）" >&2
exit 1
