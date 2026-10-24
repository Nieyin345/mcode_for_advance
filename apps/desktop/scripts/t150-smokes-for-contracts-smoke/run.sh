#!/usr/bin/env bash
# 【T150】`smokes-for.py` 对 `packages/contracts/` 的答复必须能用。
#
# 两个症状、两条断言：
#   B —— 查询 contracts 下的文件不再 Python traceback，且「经由 X」仍然给出
#        可读的路径（相对仓库根），不是被 try/except 吞掉。
#   A —— `app-control-smoke` 用 readFileSync 读 rpcMap.ts（不是 import），
#        显式声明之后它必须出现在「必跑」里。
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
  echo "找不到可用的 Python（试过 python / python3 / py）。t150-smokes-for-contracts-smoke 需要 Python 3。" >&2
  exit 127
fi

# ⚠️ Git Bash / MSYS 下 `$PWD` 是 `/d/...`，Windows 版 python.exe 解不了 —— 先转。
SCRIPT="scripts/t150-smokes-for-contracts-smoke/main.py"
if command -v cygpath >/dev/null 2>&1; then SCRIPT="$(cygpath -w "$SCRIPT")"; fi
"$PY" -I "$SCRIPT"
