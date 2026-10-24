#!/usr/bin/env bash
# Headless smoke for 每轮文件快照 / 历史回滚（台账 MC-001/002/003/005/006/008）。
#
# 六条全是**用户数据安全**的一类，而且错了都不报错：符号链接越界静默放行、
# 历史回滚抹掉后续改动、大文件 O(n×m) 卡死主进程、只改末尾换行被静默剔掉、
# 合法点文件名被误拒、并发记录捕获到写后内容。所以这里真建文件、真跑
# recordPre/freeze/restoreFiles，而不是断言源码里有某个字符串。
#
# ## 它不碰用户真正的数据
#
# 全部文件都在 main.ts 里 `mkdtemp` 建出来的临时目录（node:os 的 tmpdir 下，
# 带 `mcode-filesnap-` 前缀），跑完在 finally 删。**不碰数据根、不碰 mcode.db。**
#
# ## 换桩的边界
#
#   - `@main/lib/realPathWithin.js` 是真实现（要真跑 realpath/lstat 才验得了越界）；
#   - `@main/lib/msysPath.js` 真实现（normalizeToolFilePath 依赖它做方言翻译）；
#   - `@contracts/runtime` 只是类型，`import type` 整条被编译掉。
# 这套不 import electron、不连数据库，纯 node 文件系统。
#
# Run: scripts/file-snapshot-smoke/run.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

# esbuild 的启动器是 `#!/usr/bin/env node` 脚本，所以 esbuild 和产物都要能解析到 node。
# 本脚本被交互 shell 直接跑时 PATH 里通常有；但被别的进程（如变异脚本的 subprocess）
# 拉起时未必有裸 `node` —— 实测那环境里 node 在 `/d/nvm/nodejs/node`，`/usr/bin/env`
# 找不到它，脚本以 rc=127 **静默失败**（"零条红"看着像断言不起作用，其实是没跑）。
# 这里把 node 所在目录挂到 PATH 前面，消掉这个坑。
if _NODE_BIN="$(command -v node 2>/dev/null)"; then
  PATH="$(dirname "$_NODE_BIN"):$PATH"; export PATH
fi

OUT=$(mktemp -d ./.tmp/file-snapshot-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/file-snapshot-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
