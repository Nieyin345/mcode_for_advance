#!/usr/bin/env bash
# O4 —— docs 关闭恒被拒：包装层丢了 on（A）+ 注册层静默降级（B）。
#
# 两段：
#   1. 无头：直接打 `createDbGuardedIpc` 与 `registerDocumentViewHandlers`
#      （卡 2.2 / 2.3 的判据；见 main.ts 文件头）。
#   2. 真 Electron：`run.mjs` 走 `electron-u1` 骨架，在**生产装配路径**上
#      （`createDbGuardedIpc(ipcMain)` + 真 docs 页 + 真 preload）打开 docs 并
#      走生产 `documentView:close` —— 卡 2.1 的主判据。修复前这里必须红
#      （关闭 2 秒超时被拒），修后绿。
#
# 用法：
#   bash scripts/o4-docs-close-smoke/run.sh                # 两段
#   bash scripts/o4-docs-close-smoke/run.sh --headless     # 只跑第 1 段
#   bash scripts/o4-docs-close-smoke/run.sh --electron     # 只跑第 2 段
#   node scripts/o4-docs-close-smoke/run.mjs --mutate      # 三个变异（见 mutators.mjs）
#
# `--headless` / `--electron` 是给变异用的：变异 2 要求「无头红、主判据绿」，
# 两段必须能分开取码（整跑会在第一段红时停）。
#
# ## 安全前提
#
# 无头段不碰数据库：`@main/store/db.js` 换成了门闸桩（`stubs/dbGate.ts`），
# 真 initDb/getDb 被调到会立刻炸。真 Electron 段由启动器把数据根指到 mktemp
# 目录（`electron-host.cjs` 的既有纪律）。
#
# ## 一段红了就是这套红
#
# 无头红立即停（真 Electron 段跑不出结论）；真 Electron 红在最后一段，
# 保留它自己的证据目录。
set -euo pipefail
# ⚠️ `cd` 之后**不能**再用 `$0` 算路径：从仓库根调用时 `$0` 是相对路径，`cd` 后
# 再 dirname 会拼成 `apps/desktop/apps/desktop/scripts/...`（rc=127，看起来像套件坏）。
# 所以先落成绝对路径 `$HERE`，之后所有路径都从它出。
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

MODE="both"
for arg in "$@"; do
  case "$arg" in
    --headless) MODE="headless" ;;
    --electron) MODE="electron" ;;
    *) echo "o4: 未知参数 $arg（只认 --headless / --electron）" >&2; exit 2 ;;
  esac
done

# ── 1. 无头：包装层 / 注册层 ──
if [[ "$MODE" != "electron" ]]; then
  source "$HERE/../lib/esbuild-path.sh"
  OUT=$(mktemp -d /tmp/mcode-o4-docs-close.XXXXXX)
  trap 'rm -rf "$OUT"' EXIT

  "$ESBUILD" scripts/o4-docs-close-smoke/main.ts \
    --bundle --platform=node --format=esm \
    --tsconfig=tsconfig.json \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --alias:@main/store/db.js=./scripts/o4-docs-close-smoke/stubs/dbGate.ts \
    --alias:@main/lib/logger.js=./scripts/o4-docs-close-smoke/stubs/logger.ts \
    --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/window.ts \
    --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
    --outfile="$OUT/smoke.mjs" --log-level=error

  # ⚠️ `set -e` 下直接跑 node，失败会在 `$?` 之前退出 —— 用 `set +e` 收码，
  # 让"这一段红了"以一句可读的结论出现，而不是裸的 set -e 退出。
  set +e
  node "$OUT/smoke.mjs" 2>"$OUT/stderr.txt"
  HEADLESS_RC=$?
  set -e
  echo "o4: 无头段退出码 $HEADLESS_RC"
  # 「套件没跑起来」（127 / 命令找不到）与「断言红」是两种形态，分开报。
  # 只在 rc≠0 时才查 stderr —— 绿跑不参与，避免日志正文误伤。
  if [[ "$HEADLESS_RC" -ne 0 ]] && { [[ "$HEADLESS_RC" -eq 127 ]] || grep -q "No such file or directory\|command not found" "$OUT/stderr.txt"; }; then
    echo "o4-docs-close-smoke: 套件自己没跑起来（127 / 命令找不到）—— 不是断言红，先查 PATH/构建" >&2
    cat "$OUT/stderr.txt" >&2
    exit 2
  fi
  if [[ "$HEADLESS_RC" -ne 0 ]]; then
    echo "o4-docs-close-smoke: FAIL（无头段）"
    exit 1
  fi
fi

# ── 2. 真 Electron：生产装配路径上的 docs 关闭 ──
# vendor 产物缺失时 run.mjs **如实失败（exit 2）** —— 主判据没跑，不能拿无头段
# 的绿冒充。卡第七节说得清楚：主判据必须真 Electron + 真 docs 页。
# `--headless` 只跑第 1 段（变异要分开取码）；其余模式都跑本段。
if [[ "$MODE" != "headless" ]]; then
  mkdir -p .tmp
  set +e
  node scripts/o4-docs-close-smoke/run.mjs 2>.tmp/o4-electron-stderr.txt
  RUN_RC=$?
  set -e
  echo "o4: 真 Electron 段退出码 $RUN_RC"
  # 与无头段同一条纪律：127 / 命令找不到 = 套件没跑起来，不是断言红。
  if [[ "$RUN_RC" -ne 0 ]] && { [[ "$RUN_RC" -eq 127 ]] || grep -q "No such file or directory\|command not found" .tmp/o4-electron-stderr.txt 2>/dev/null; }; then
    echo "o4-docs-close-smoke: 真 Electron 段没跑起来（127 / 命令找不到）—— 不是断言红，先查 PATH/Electron 安装" >&2
    cat .tmp/o4-electron-stderr.txt >&2
    exit 2
  fi
  if [[ "$RUN_RC" -ne 0 ]]; then
    echo "o4-docs-close-smoke: FAIL（真 Electron 段）"
    exit 1
  fi
fi

echo "o4-docs-close-smoke: PASS"
