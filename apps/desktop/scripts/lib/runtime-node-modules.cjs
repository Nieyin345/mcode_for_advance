// Native Windows-only junction creation for temporary smoke bundles.
// Never mutate, copy or delete the installed source node_modules tree.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [sourceArg, linkArg] = process.argv.slice(2);
if (!sourceArg || !linkArg) {
  console.error('runtime-node-modules: expected source and link');
  process.exit(1);
}
const source = path.resolve(sourceArg);
const link = path.resolve(linkArg);
if (path.basename(link) !== 'node_modules' || !fs.statSync(source).isDirectory()) {
  console.error('runtime-node-modules: invalid node_modules source or destination');
  process.exit(1);
}
if (fs.existsSync(link)) {
  console.error('runtime-node-modules: refusing to replace existing link');
  process.exit(1);
}
try {
  try {
    fs.symlinkSync(source, link, 'junction');
  } catch (junctionError) {
    // Developer Mode / elevated accounts may permit standard directory symlinks.
    try {
      fs.symlinkSync(source, link, 'dir');
    } catch (symlinkError) {
      throw new AggregateError([junctionError, symlinkError],
        'Windows junction and directory symlink both failed');
    }
  }
  const actual = fs.realpathSync.native(link);
  const expected = fs.realpathSync.native(source);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('runtime-node-modules: link resolves to unexpected directory');
  }
} catch (error) {
  console.error('runtime-node-modules:', error.message);
  process.exitCode = 1;
}
