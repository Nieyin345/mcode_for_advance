#!/usr/bin/env bash
# 【T78】`smokes-for.py` 距离分级的回归（正控 / 负控 / 不漏控）。
#
# 这是唯一一套用 Python 写的 smoke：被测对象本身是 Python，用 node 去测它
# 只能靠解析文本输出 —— 那会在改输出格式时假红，而且拿不到内部判定
# （跳数、上一跳是谁）。直接 import 它，断言打在真实函数上。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PY=""
for cand in python python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "" >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [[ -z "$PY" ]]; then
  echo "找不到可用的 Python(试过 python / python3 / py)。" >&2
  exit 127
fi

"$PY" "$SCRIPT_DIR/main.py"
