#!/usr/bin/env bash
# vscode-api-census — F019 需求侧普查：扫本机真实 VS Code 扩展，提取 vscode.* 成员。
#
# 纯 Node + 仓库已装的 typescript 做 AST 解析；不打包、不起 Electron、不装依赖。
# 输入默认是 C:\Users\Nieyin\.vscode\extensions；可用 --extensions-dir 指向探针目录。
#
# 用法：
#   bash run.sh                                  # 扫本机扩展 → 更新同目录 result.json
#   bash run.sh --extensions-dir <dir> --out <f> # 扫别的目录（变异/对照）
#   bash run.sh --verbose                        # 打印每个扩展的文件与成员明细
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
exec node "$HERE/main.mjs" "$@"
