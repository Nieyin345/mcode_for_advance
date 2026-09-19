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

# python 不在 PATH 上的机器(仓库里记过这个坑):退回 py 启动器。
if command -v python >/dev/null 2>&1; then PY=python; else PY=py; fi
"$PY" "$HERE/smokes-for.py" "$@"
