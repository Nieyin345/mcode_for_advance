#!/usr/bin/env bash
# O0: 六格式复杂部件保真 —— 真 Electron + 真 vendor 编辑器 + 语义指纹比对。
# 见 run.mjs / fidelity/fingerprint.ts / mutate.mjs 的文件头。
#
# 两段：
#   1. 六条旅程（打开→改一处无关内容→保存→重开→逐项比对）；
#   2. 判据变异（删部件必须红 / 挪位置也必须红）—— 只在第 1 段全绿后才跑
#      （它读第 1 段落盘的基线；基线不绿就没有可比的样本）。
#
# 两段都过才算这套件绿：第 1 段证明「当前无静默损坏」，第 2 段证明「这份
# 证明不是假的」。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/o0-format-fidelity-smoke/run.mjs
node scripts/o0-format-fidelity-smoke/mutate.mjs
