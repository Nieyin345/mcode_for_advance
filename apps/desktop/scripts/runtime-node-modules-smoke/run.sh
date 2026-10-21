#!/usr/bin/env bash
# Isolated proof of ESM and CJS resolution through the runtime-only link.
# Also proves cleanup cannot delete the source installation (fixture only).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-runtime-modules-out.XXXXXX)
FIXTURE=$(mktemp -d /tmp/mcode-runtime-modules-src.XXXXXX)
trap 'rm -rf "$OUT" "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/node_modules/runtime-modules-probe"
printf 'guard\n' > "$FIXTURE/node_modules/guard"
printf '{"name":"runtime-modules-probe","type":"module","exports":"./index.mjs"}\n' > "$FIXTURE/node_modules/runtime-modules-probe/package.json"
printf 'export const value = 731;\n' > "$FIXTURE/node_modules/runtime-modules-probe/index.mjs"

source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$FIXTURE/node_modules"
cat > "$OUT/probe.mjs" <<'PROBE'
import { value } from 'runtime-modules-probe';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
assert.equal(value, 731, 'real ESM package import');
assert.match(require.resolve('runtime-modules-probe'), /runtime-modules-probe[\\/]index\.mjs$/, 'real CJS require.resolve');
assert.throws(() => require.resolve('runtime-modules-missing'), {code: 'MODULE_NOT_FOUND'});
let missing = false;
try { await import('runtime-modules-missing'); } catch (e) { missing = e.code === 'ERR_MODULE_NOT_FOUND'; }
assert.ok(missing, 'missing ESM package must not silently resolve');
console.log('runtime-node-modules-smoke: ESM import, CJS resolve, both missing-package failures PASS');
PROBE
node "$OUT/probe.mjs"
if mcode_link_runtime_node_modules "$OUT" "$FIXTURE/node_modules" > /dev/null 2>&1; then
  echo 'runtime-node-modules-smoke: duplicate link was accepted' >&2
  exit 1
fi
rm -rf "$OUT"
if [[ ! -f "$FIXTURE/node_modules/guard" ]]; then
  echo 'runtime-node-modules-smoke: deleting bundle removed source tree!' >&2
  exit 1
fi
echo 'runtime-node-modules-smoke: duplicate rejected, source survived cleanup PASS'
