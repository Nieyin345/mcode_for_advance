#!/usr/bin/env bash
# 【T153】`smokes-for.py` 必须收「重型套件」（不带 `-smoke` 后缀但有真实覆盖的那类）。
#
# 四条断言：
#   1. `flow-preview` / `md-preview` 出现在它们覆盖的文件的必跑里（它们是**真套件** ——
#      变异实测：各插一行 throw，分别 EXIT=1 / 0-2、2-10 通过）；
#   2. `electron-u1` 通过 `@smoke-covers` 声明覆盖 `src/preload/index.ts`（0 跳）；
#   3. 排除表里的三个（`preset-scripts-sync` / `o3-packaged-u1` / `vscode-api-census`）
#      不出现在任何文件的覆盖里（负控，防过度收录）；
#   4. 输出里能区分「重型」与普通 smoke（否则读者不知道这一跑要几十秒）。
#
# 为什么不走 esbuild：被测的是 Python 脚本，断言只需起子进程看它打印什么。
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
  echo "找不到可用的 Python（试过 python / python3 / py）。t153-heavy-suite-coverage-smoke 需要 Python 3。" >&2
  exit 127
fi

# ⚠️ Git Bash / MSYS 下 `$PWD` 是 `/d/...`，Windows 版 python.exe 解不了 —— 先转。
SCRIPT="scripts/t153-heavy-suite-coverage-smoke/main.py"
if command -v cygpath >/dev/null 2>&1; then SCRIPT="$(cygpath -w "$SCRIPT")"; fi
"$PY" -I "$SCRIPT"
