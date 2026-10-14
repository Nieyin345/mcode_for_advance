#!/usr/bin/env bash
# 改了一个文件之后,看该跑哪几套 smoke。判据与实现见 `smokes-for.py`。
#
#   bash apps/desktop/scripts/smokes-for.sh src/main/library/operations.ts
#   bash apps/desktop/scripts/smokes-for.sh --uncovered
#   bash apps/desktop/scripts/smokes-for.sh --all
set -euo pipefail
# 这个脚本住在 apps/desktop/scripts/ 下,而 `smokes-for.py` 是同目录的兄弟
# —— **不能用 `cd` 之后算相对路径**:那会变成 `apps/scripts/...`。
HERE="$(cd "$(dirname "$0")" && pwd)"

# 找 Python。**不能只看 `command -v`** —— Windows 上 `python.exe` 常是 Microsoft Store
# 的**占位别名**:`command -v python` 找得到,真跑起来却弹"去商店装 Python"然后失败。
# 所以逐个候选**真跑一次** `-c ""`,跑得通才认(仓库里记过这个坑)。
PY=""
for cand in python python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "" >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [[ -z "$PY" ]]; then
  echo "找不到可用的 Python(试过 python / python3 / py)。smokes-for 需要 Python 3 运行 smokes-for.py。" >&2
  exit 127
fi

# ⚠️ 路径形态:**Git Bash / MSYS 下不能用 `$HERE/smokes-for.py` 直接喂给 Windows 版 Python**
# ——`$HERE` 是 `/d/...` 这种 POSIX 路径,Windows 的 python.exe 解不了。若 `cygpath` 在,
# 先转成 Windows 形态;转不了(纯 Linux/macOS)就原样用。
SCRIPT="$HERE/smokes-for.py"
if command -v cygpath >/dev/null 2>&1; then SCRIPT="$(cygpath -w "$SCRIPT")"; fi
"$PY" "$SCRIPT" "$@"
