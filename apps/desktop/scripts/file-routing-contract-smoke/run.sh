#!/usr/bin/env bash
# 【T17】文件类型路由统一回归网。
#
# 被测（**生产源码**，不抄一份）：
#   - `packages/contracts/src/documentKind.ts` —— 种类判据 + 后缀判据 + Office 家族
#   - `apps/desktop/src/renderer/stores/sessionStoreHelpers.ts` —— 三个薄封装
#   - `apps/desktop/src/renderer/lib/contentTag.ts` —— isImageFilePath 薄封装
#   - `apps/desktop/src/renderer/lib/libraryPreview.ts` —— md 判据委派
#   - `apps/desktop/src/renderer/components/customUi/CustomTabView.tsx`（源码断言）
#
# sessionStoreHelpers 在顶层 import 了会话 store 的**真模块图**（api / i18n /
# zustand stores）。本套只验分类判据，不验 store —— 所以把这些一律换成直通桩。
# 这与 `session-store-smoke` 的 prelude 是同一思路，但更窄：不执行 store 逻辑。
#
# 不起服务、不碰磁盘、无数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-file-routing.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

mkdir -p "$OUT/stubs"
cat > "$OUT/stubs/noop.ts" <<'TS'
export const noop = (): void => {};
export default noop;
TS
cat > "$OUT/stubs/store.ts" <<'TS'
export const useSessionStore = { getState: () => ({}), setState: () => {} };
export const useFileViewStore = { getState: () => ({ target: null }) };
export const useToastStore = { getState: () => ({ push: () => {} }) };
export const useBrowserStore = { getState: () => ({}) };
export const useLibraryStore = { getState: () => ({}) };
export default useSessionStore;
TS
cat > "$OUT/stubs/api.ts" <<'TS'
const never = () => Promise.resolve(undefined);
export const api = new Proxy({}, { get: () => new Proxy(never, { get: () => never }) });
TS

# 库预览那两个 store 换成**带审计的**桩（本套要读它们的副作用）；
# 其余 store 只需"存在且不炸"。
MCODE_SMOKE_DESKTOP_ROOT="$PWD" "$ESBUILD" \
  scripts/file-routing-contract-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@renderer/stores/sessionStore.js=./scripts/file-routing-contract-smoke/stubs.ts \
  --alias:@renderer/stores/libraryStore.js=./scripts/file-routing-contract-smoke/stubs.ts \
  --alias:@renderer/stores/fileViewStore.js="$OUT/stubs/store.ts" \
  --alias:@renderer/stores/toastStore.js="$OUT/stubs/store.ts" \
  --alias:@renderer/stores/browserStore.js="$OUT/stubs/store.ts" \
  --alias:@renderer/lib/api.js="$OUT/stubs/api.ts" \
  --alias:@renderer/lib/monacoSetup.js="$OUT/stubs/noop.ts" \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DESKTOP_ROOT="$PWD" node "$OUT/smoke.mjs"
