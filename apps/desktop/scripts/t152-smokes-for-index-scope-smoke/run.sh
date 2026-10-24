#!/usr/bin/env bash
# 【T152】`smokes-for.py` 必须分清「没有覆盖」和「不在我的问题范围内」。
#
# 三条断言：
#   1. vendor 路径（`genoffice/**`）说「本工具只回答…」，不说「没有套件覆盖」；
#   2. `apps/desktop/src/main` 下真没覆盖的文件，仍然说「没有套件覆盖」（负控）；
#   3. `apps/desktop/src/...` 和 `src/...` 两种写法结果相同（`--uncovered` 的输出
#      从前传回去会拼成 apps/desktop/apps/desktop/...，永远「找不到」）。
#
# 为什么不走 esbuild：被测的是 Python 脚本，断言只需起子进程看它打印什么。
# 理由与变异见 main.py 文件头。
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
  echo "找不到可用的 Python（试过 python / python3 / py）。t152-smokes-for-index-scope-smoke 需要 Python 3。" >&2
  exit 127
fi

# ⚠️ Git Bash / MSYS 下 `$PWD` 是 `/d/...`，Windows 版 python.exe 解不了 —— 先转。
SCRIPT="scripts/t152-smokes-for-index-scope-smoke/main.py"
if command -v cygpath >/dev/null 2>&1; then SCRIPT="$(cygpath -w "$SCRIPT")"; fi
"$PY" -I "$SCRIPT"
