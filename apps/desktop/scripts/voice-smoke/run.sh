#!/usr/bin/env bash
# Headless smoke for **语音输入那条路**(`main/voice/models.ts` +
# `main/voice/speechRecognizer.ts` + `ipc/voice.ts`)—— 三个文件零覆盖。
#
# ⚠️ **这套跑的时候会起两个 127.0.0.1 上的临时 HTTP 服务**,并且把 catalog 里
#    huggingface.co / hf-mirror.com 那几条 URL 在**内存里**改指向它们
#    (见 main.ts 的 §2)。所以:
#      - 不碰外网;
#      - 不下载真模型、不落真模型文件(夹具是几个空文件);
#      - **不开麦克风**(PCM 是脚本自己造的 Float32Array)。
#
# ⚠️ **真的建一个 sqlite 库**(选中的模型 / 已下载名单住在 settings 表里)。
#    数据根换成本脚本自己的 mktemp 目录(见 stubs/dataRoot.ts 那句"没设就抛":
#    指错地方等于拿空库盖掉用户的聊天记录),跑完就删。
#
# 别名四档,理由各不相同:
#   - **electron 整个包** —— `models.ts` 用 `app.getPath("userData")` 拼默认模型根,
#     `main/store/db.ts` 顶上还挂着一句 `import { app } from "electron"`(死导入,
#     运行期用不到,但 esbuild 不打包它就编不过去)。桩见 stubs/electron.ts;
#   - dataRoot / logger —— 真的那两个 import 了 electron,db-migrate-smoke 的老桩;
#   - window —— `ipc/voice.ts` 的 wirePushes 用它发 `voice:result` /
#     `voice:downloadProgress`。桩按注册顺序记下来,断言断的就是这些帧;
#   - **sherpa-onnx-node** —— ⚠️ **非有不可**:`speechRecognizer.ts` 里那句
#     `require("sherpa-onnx-node")` esbuild 解析不了(`Could not resolve`)。
#     用 `--external:` 会让运行时 `require` 真的去解析这个包、把原生 addon 加载起来
#     ——本套不干这个。所以用 `--alias:` 换成一个桩(见 stubs/sherpaOnnx.ts):
#     它**默认不抛**,于是「模型没选 / 文件不全」那两条 RPC 能验到底;
#     要验"addon 挂了"时由 `__failNextLoad()` 让它在模块体里抛(与真的同形)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-voice-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-voice-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行非有不可:sql.js 的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它
# 换成一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。
"$ESBUILD" scripts/voice-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/voice-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/voice-smoke/stubs/window.ts \
  --alias:sherpa-onnx-node=./scripts/voice-smoke/stubs/sherpaOnnx.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
