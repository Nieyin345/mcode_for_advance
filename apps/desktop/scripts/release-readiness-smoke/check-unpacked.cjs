/** Explicit post-pack gate, NOT part of --all (requires an already-built Windows directory).
 * node apps/desktop/scripts/release-readiness-smoke/check-unpacked.cjs <win-unpacked>
 * Never launches Mcode.exe or imports its main entry. Native checks use an isolated
 * installed Electron fixture, package-only resolution, in-memory SQL and a cmd echo.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire, builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const appDir = path.resolve(__dirname, '../..');
const appRequire = createRequire(path.join(appDir, 'package.json'));
const builtin = value => value === 'electron' || value === 'original-fs' || value.startsWith('node:') || builtinModules.includes(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const hash = value => createHash('sha256').update(value).digest('hex');

async function nativeHost() {
  assert.ok(process.versions.electron, 'The native host must be the installed Electron, not Mcode.exe');
  const { app, BrowserWindow } = require('electron');
  const [unpacked, fixture, references] = process.argv.slice(3);
  assert.ok(unpacked && fixture && references);
  const resources = path.join(unpacked, 'resources');
  const archive = path.join(resources, 'app.asar');
  app.setPath('userData', path.join(fixture, 'user-data'));
  app.setPath('sessionData', path.join(fixture, 'session-data'));
  app.setAppLogsPath(path.join(fixture, 'logs'));
  app.on('window-all-closed', () => {});
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disk-cache-dir', path.join(fixture, 'cache'));
  await app.whenReady();
  const Module = require('node:module');
  const originalResolve = Module._resolveFilename;
  // An unpacked directory under the repo must never silently borrow dev dependencies.
  Module._resolveFilename = function (request, ...args) {
    const resolved = originalResolve.call(this, request, ...args);
    if (!builtin(request) && typeof resolved === 'string' && path.isAbsolute(resolved)) {
      assert.ok(inside(archive, resolved) || inside(archive + '.unpacked', resolved), 'Dependency escaped the package: ' + request + ' -> ' + resolved);
    }
    return resolved;
  };
  const req = createRequire(path.join(archive, 'out/main/index.js'));
  const resolved = {};
  for (const { file, specifier } of JSON.parse(fs.readFileSync(references, 'utf8'))) {
    const at = createRequire(path.join(archive, file));
    at.resolve(specifier);
  }
  for (const name of ['sql.js/dist/sql-asm.js', 'node-pty', 'sherpa-onnx-node', 'electron-updater', '@anthropic-ai/claude-agent-sdk']) resolved[name] = req.resolve(name);
  const sdkPath=req.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkReq=createRequire(sdkPath);
  resolved.sdkZodV4=sdkReq.resolve('zod/v4');
  assert.match(sdkReq('zod/package.json').version,/^4\./,'SDK must ship its declared Zod 4 runtime, not an incompatible app peer');
  const sdkZod=sdkReq('zod/v4');
  assert.equal(sdkZod.object({value:sdkZod.string()}).parse({value:'isolated'}).value,'isolated');
  const sdk=await import(require('node:url').pathToFileURL(sdkPath).href);
  assert.equal(typeof sdk.query,'function'); // Import only: never query a model or launch a CLI.
  const SQL = await req('sql.js/dist/sql-asm.js')();
  const db = new SQL.Database();
  assert.equal(db.exec('SELECT 42 AS answer')[0].values[0][0], 42);
  db.close();
  req('ssh2');
  req('simple-git');
  req('electron-updater');
  req('sherpa-onnx-node'); // Load the shipped N-API/DLL binding, never a model or microphone.
  const pty = req('node-pty');
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo mcode-release-pty'], { name: 'xterm-color', cols: 80, rows: 24, cwd: fixture, env: { ...process.env } });
    let output = '';
    const timer = setTimeout(() => { try { terminal.kill(); } catch {} reject(Error('Packaged ConPTY echo timed out')); }, 20000);
    terminal.onData(chunk => { output += chunk; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try { assert.equal(exitCode, 0); assert.ok(output.includes('mcode-release-pty')); resolve(); } catch (error) { reject(error); }
    });
  });
  // Load only the shipped preload, never the product main or renderer app.
  const html=path.join(fixture,'preload.html');fs.writeFileSync(html,'<!doctype html><body>Isolated preload check</body>');
  const window=new BrowserWindow({show:false,webPreferences:{preload:path.join(archive,'out/preload/index.mjs'),sandbox:false,contextIsolation:true,nodeIntegration:false}});
  try {
    await window.loadFile(html);
    const bridge=await window.webContents.executeJavaScript("({imageWriter:typeof window.api?.clipboardFile?.writeImage,nodeRequire:typeof require})");
    assert.equal(bridge.imageWriter,'function');assert.equal(bridge.nodeRequire,'undefined');
  } finally { window.destroy(); }
  const result = { electron: process.versions.electron, preload: 'packaged context bridge loaded with Node isolation', sdk: 'module and its Zod v4 peer loaded without a model query', resolved, sql: 'memory query passed', sherpa: 'native binding loaded without model', pty: 'packaged ConPTY echo passed' };
  fs.writeFileSync(path.join(fixture, 'native-result.json'), JSON.stringify(result, null, 2));
  console.log('PASS package-only runtime resolution, SQL, sherpa binding, and ConPTY');
  app.exit(0);
}

function main() {
  assert.equal(process.platform, 'win32', 'This post-pack gate currently validates Windows x64 only');
  const unpacked = path.resolve(process.argv[2] || '');
  assert.ok(process.argv[2], 'Pass the win-unpacked directory explicitly');
  const archive = path.join(unpacked, 'resources/app.asar');
  assert.ok(fs.existsSync(path.join(unpacked, 'Mcode.exe')), 'Unpacked executable is missing');
  const builderRequire = createRequire(appRequire.resolve('electron-builder'));
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const asar = libRequire('@electron/asar');
  const ts = appRequire('typescript');
  const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''));
  const files = new Set(entries);
  const nativePath = file => file.split("/").join(path.sep);
  const extract = file => asar.extractFile(archive, nativePath(file));
  for (const file of ['package.json', 'out/main/index.js', 'out/preload/index.mjs', 'out/preload/browserPicker.mjs', 'out/renderer/index.html', 'out/renderer/pair.html', 'out/renderer/embedpdf/pdfium.wasm']) assert.ok(files.has(file), 'Missing package asset: ' + file);
  assert.equal(JSON.parse(extract('package.json').toString()).main.replace(/^\.\//, ''), 'out/main/index.js');
  assert.ok(!entries.some(file => /(?:^|\/)node_modules\/@mcode\//.test(file)), 'Bundled contracts should not ship as a workspace dependency');
  assert.ok(!entries.some(file => /(?:^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//.test(file)), 'On-demand agent platform binaries must not ship');
  let pdfFiles = 0;
  function compareTree(source, dest) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const src = path.join(source, entry.name), target = dest + '/' + entry.name;
      if (entry.isDirectory()) compareTree(src, target);
      else if (entry.isFile()) { assert.ok(files.has(target), 'Missing PDF asset: ' + target); assert.equal(hash(extract(target)), hash(fs.readFileSync(src)), 'PDF asset differs: ' + target); pdfFiles++; }
    }
  }
  const pdfRoot = path.dirname(appRequire.resolve('pdfjs-dist/package.json'));
  for (const part of ['cmaps', 'standard_fonts']) compareTree(path.join(pdfRoot, part), 'out/renderer/pdfjs/' + part);
  const store = path.resolve(appDir, '../../node_modules/.pnpm');
  const candidates = fs.readdirSync(store).filter(name => name.startsWith('@embedpdf+pdfium@'));
  assert.equal(candidates.length, 1, 'Resolve the active PDFium version explicitly before packaging multiple installed versions');
  const wasm = path.join(store, candidates[0], 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  assert.equal(hash(extract('out/renderer/embedpdf/pdfium.wasm')), hash(fs.readFileSync(wasm)));
  let unpackedNative = 0;
  for (const file of entries.filter(file => /\.(node|dll)$/i.test(file))) {
    assert.ok(asar.statFile(archive, nativePath(file)).unpacked, 'Native file is trapped inside ASAR: ' + file);
    assert.ok(fs.statSync(path.join(archive + '.unpacked', file)).size > 0, 'Native file missing from disk: ' + file);
    unpackedNative++;
  }
  assert.ok(unpackedNative > 0);
  const references = [];
  for (const file of entries.filter(file => /^out\/(main|preload)\/.+\.(m?js)$/.test(file))) {
    const source = ts.createSourceFile(file, extract(file).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const node of source.statements) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (!builtin(specifier)) references.push({ file, specifier });
      }
    }
  }
  const fixtureRoot = path.join(appDir, '.tmp'); fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(fixtureRoot, 'release-package-check-'));
  const refsFile = path.join(fixture, 'references.json'); fs.writeFileSync(refsFile, JSON.stringify(references));
  const env = { ...process.env, APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'local-appdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  const child = spawnSync(appRequire('electron'), [__filename, '--host', unpacked, fixture, refsFile], { env, cwd: fixture, encoding: 'utf8', timeout: 120000, windowsHide: true });
  fs.writeFileSync(path.join(fixture, 'host.log'), (child.stdout || '') + (child.stderr || ''));
  console.log('Post-pack artifacts: ' + fixture);
  if (child.stdout) console.log(child.stdout.trim());
  assert.equal(child.status, 0, 'Isolated Electron package check failed: ' + (child.error?.message || child.stderr || 'see host.log'));
  assert.ok(fs.existsSync(path.join(fixture, 'native-result.json')), 'Native host exited without a result');
  const result = { archive, asarBytes: fs.statSync(archive).size, entries: entries.length, pdfFiles, unpackedNative, importReferences: references.length, native: JSON.parse(fs.readFileSync(path.join(fixture, 'native-result.json'), 'utf8')) };
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ asarBytes: result.asarBytes, entries: result.entries, pdfFiles, unpackedNative, importReferences: references.length }));
  console.log('PASS unpacked Windows package resources and isolated runtime gate');
}
if (process.argv[2] === '--host') nativeHost().catch(error => { console.error(error); require('electron').app.exit(1); });
else { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
