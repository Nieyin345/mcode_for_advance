#!/usr/bin/env bash
# skills-nodes-ui-smoke — 「节点技能总览」读取完整度的**组件级**回归网。
#
# 钉的是用户的体验:某份工作流读不回来时,面板必须**说出来**(逐条点名),而不是
# 把它引用的技能悄悄算进"没被任何节点用到"。真 `SkillNodesView` 挂极小 React
# 运行时上跑,`api` 换成可编程替身。不起浏览器、不写盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-skills-nodes-ui.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/skills-nodes-ui-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/skills-nodes-ui-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/skills-nodes-ui-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/skills-nodes-ui-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/skills-nodes-ui-smoke/api-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
