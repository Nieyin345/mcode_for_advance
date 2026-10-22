#!/usr/bin/env bash
# `smokes-for.py` 自身回归：扫描入口必须认 `.tsx` / `.jsx`，且不能把 `.cjs` 的
# alias 字符串误当成 import（两个方向都要对）。断言与理由见 main.py 文件头。
#
# 为什么不走 esbuild：被测的是 Python 脚本，断言只需起子进程看它打印什么；
# 打包一层反而会把「脚本本身能不能跑」这件事藏起来。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 找 Python。**不能只看 `command -v`** —— Windows 上 `python.exe` 常是 Microsoft Store
# 的占位别名：找得到，真跑起来却弹「去商店装 Python」然后失败（smokes-for.sh 同款判断）。
PY=""
for cand in python python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "" >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [[ -z "$PY" ]]; then
  echo "找不到可用的 Python（试过 python / python3 / py）。tsx-coverage-smoke 需要 Python 3。" >&2
  exit 127
fi

# ⚠️ Git Bash / MSYS 下 `$PWD` 是 `/d/...`，Windows 版 python.exe 解不了 —— 先转。
SCRIPT="scripts/tsx-coverage-smoke/main.py"
if command -v cygpath >/dev/null 2>&1; then SCRIPT="$(cygpath -w "$SCRIPT")"; fi
"$PY" -I "$SCRIPT"
