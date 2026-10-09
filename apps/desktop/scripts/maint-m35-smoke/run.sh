#!/usr/bin/env bash
# M35: only temporary fixtures; no user library, PDF or real main process touched.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-m35-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Missing local esbuild; no network install' >&2; exit 2; fi

"$ESBUILD" scripts/maint-m35-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@renderer/lib/api.js=./scripts/maint-m35-smoke/stubs/api.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/maint-m35-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/icons.js=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --outfile="$OUT/main.mjs" --log-level=error
status=0
node "$OUT/main.mjs" || status=1

# Render the REAL FilePreview function with deterministic hook state: no Electron,
# DOM, network or PDF engine. Check the actual filePath handed to PdfPreview.
# Only its relative PDF and lazy Markdown imports are rewired in a temporary copy for isolation;
# keep the function body identical and fail if the original import changes.
node - "$OUT/FilePreview.tsx" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const source = readFileSync('src/renderer/components/library/FilePreview.tsx', 'utf8');
const needle = 'from "./PdfPreview.js"';
if (!source.includes(needle)) throw Error('FilePreview PDF import changed: update the isolated test');
const mdNeedle = 'import("./MarkdownPreviewPane.js")';
if (!source.includes(mdNeedle)) throw Error('FilePreview Markdown import changed: update the isolated test');
writeFileSync(process.argv[2], source.replace(needle, 'from "@m35/PdfPreview"').replace(mdNeedle, 'import("@m35/MarkdownPreview")'));
NODE
"$ESBUILD" scripts/maint-m35-smoke/preview.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/maint-m35-smoke/stubs/react \
  --alias:@renderer/components/library/FilePreview.js="$OUT/FilePreview.tsx" \
  --alias:@m35/MarkdownPreview=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@m35/PdfPreview=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/lib/api.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/maint-m35-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/icons.js=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --alias:@renderer/stores/sessionStore.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/stores/toastStore.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/lib/contentTag.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/chat/ChunkedMarkdown.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/chat/SelectionToolbar.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/chat/SelectionQuoteMenu.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/templates/DocxPreview.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/templates/PptxPreview.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/templates/XlsxPreview.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --alias:@renderer/components/ide/OnlyOfficeEditorPane.js=./scripts/maint-m35-smoke/stubs/previewDeps.ts \
  --outfile="$OUT/preview.mjs" --log-level=error
node "$OUT/preview.mjs" || status=1

# Rewire ItemDetail's two relative child components in a temporary copy;
# ItemLinks itself (and its async reload effect) remains unchanged.
node - "$OUT/ItemDetail.tsx" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
let source = readFileSync('src/renderer/components/library/ItemDetail.tsx', 'utf8');
for (const [before, after] of [
  ['from "./ItemList.js"', 'from "@m35/ItemList"'],
  ['from "./ItemNotes.js"', 'from "@m35/ItemNotes"'],
]) {
  if (!source.includes(before)) throw Error(`ItemDetail import changed: ${before}`);
  source = source.replace(before, after);
}
writeFileSync(process.argv[2], source);
NODE
"$ESBUILD" scripts/maint-m35-smoke/links.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/maint-m35-smoke/stubs/reactEffects \
  --alias:@renderer/components/library/ItemDetail.js="$OUT/ItemDetail.tsx" \
  --alias:@m35/ItemList=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@m35/ItemNotes=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@renderer/lib/api.js=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/maint-m35-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/icons.js=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --alias:@renderer/stores/sessionStore.js=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@renderer/stores/toastStore.js=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@renderer/components/ui/dialog.js=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --alias:@renderer/components/chat/LibraryPicker.js=./scripts/maint-m35-smoke/stubs/linksDeps.ts \
  --outfile="$OUT/links.mjs" --log-level=error
node "$OUT/links.mjs" || status=1

# ImportPanel is a released handoff edit: verify rejected IPC remains visible.
"$ESBUILD" scripts/maint-m35-smoke/import.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/maint-m35-smoke/stubs/reactEffects \
  --alias:@renderer/lib/api.js=./scripts/maint-m35-smoke/stubs/importDeps.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/maint-m35-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/icons.js=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --alias:@renderer/components/ui/index.js=./scripts/maint-m35-smoke/stubs/importDeps.ts \
  --alias:@renderer/stores/libraryStore.js=./scripts/maint-m35-smoke/stubs/importDeps.ts \
  --outfile="$OUT/import.mjs" --log-level=error
node "$OUT/import.mjs" || status=1

# LibraryPicker / ItemNotes 两处渲染端回归(见 pickers.ts 头):autoExpandItems 要真拉
# 条目;笔记的改/删在键盘聚焦时要露出来。用有真状态的 fakeReact,其余依赖换桩。
"$ESBUILD" scripts/maint-m35-smoke/pickers.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/maint-m35-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/maint-m35-smoke/stubs/reactEffects/jsx-runtime.ts \
  --alias:@tabler/icons-react=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --alias:@renderer/lib/icons.js=./scripts/maint-m35-smoke/stubs/icons.cjs \
  --alias:@renderer/lib/i18n/index.js=./scripts/maint-m35-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/cn.js=./scripts/maint-m35-smoke/stubs/cn.ts \
  --alias:@renderer/stores/libraryStore.js=./scripts/maint-m35-smoke/stubs/pickerStore.ts \
  --alias:@renderer/lib/api.js=./scripts/maint-m35-smoke/stubs/pickerApi.ts \
  --alias:@renderer/components/ui/dialog.js=./scripts/maint-m35-smoke/stubs/pickerUi.ts \
  --alias:@renderer/components/ui/button.js=./scripts/maint-m35-smoke/stubs/pickerUi.ts \
  --outfile="$OUT/pickers.mjs" --log-level=error
node "$OUT/pickers.mjs" || status=1
exit "$status"
