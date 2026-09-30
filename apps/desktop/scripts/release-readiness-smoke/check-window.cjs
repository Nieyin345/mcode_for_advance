/** Real Electron navigation/permission compatibility, with a disposable profile.
 * No product main, user database, external web requests or hardware capture. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const appDir = path.resolve(__dirname, '../..');
const req = createRequire(path.join(appDir, 'package.json'));

async function host() {
  const fixture = process.argv[3];
  const { app, BrowserWindow, session, ClipboardItem, nativeImage } = require('electron');
  app.setPath('userData', path.join(fixture, 'user-data'));
  app.setPath('sessionData', path.join(fixture, 'session-data'));
  app.setAppLogsPath(path.join(fixture, 'logs'));
  // The fixture replaces its HTTP window with a file window; own shutdown explicitly.
  app.on('window-all-closed', () => {});
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  const { installMainWindowNavigation } = require(path.join(fixture, 'navigation.cjs'));
  const installPermissions = require(path.join(fixture, 'permissions.cjs'));
  let win = null;
  installPermissions(session, () => win);
  const opened = [], warnings = [], checks = [];
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/entry' && url.searchParams.has('redirect')) { response.writeHead(302, { Location: '/foreign' }); response.end(); return; }
    if (url.pathname === '/frame-start') { response.writeHead(302, { Location: '/frame-final' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Isolated release fixture</title><body>Fixture</body>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const entry = origin + '/entry';
  function create(entryUrl) {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    installMainWindowNavigation(win.webContents, entryUrl, async url => { opened.push(url); }, message => warnings.push(message));
    return win;
  }
  function nextEvent(wc, name) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wc.removeListener(name, handler); reject(Error('Missing native event: ' + name)); }, 8000);
      const handler = (...args) => { clearTimeout(timer); resolve(args); };
      wc.once(name, handler);
    });
  }
  async function blocked(wc, eventName, target) {
    const event = nextEvent(wc, eventName);
    await wc.executeJavaScript('location.href=' + JSON.stringify(target) + '; true', true).catch(() => {});
    const [nativeEvent] = await event;
    assert.equal(nativeEvent.defaultPrevented, true, eventName + ' was not prevented');
  }
  try {
    create(entry); await win.loadURL(entry);
    const wc = win.webContents;
    await blocked(wc, 'will-navigate', origin + '/foreign');
    assert.equal(wc.getURL(), entry); checks.push('HTTP main navigation blocked');
    await blocked(wc, 'will-redirect', entry + '?redirect=1');
    assert.ok(!wc.getURL().includes('/foreign')); checks.push('main redirect blocked');
    const frameUrl = await wc.executeJavaScript(`new Promise(resolve => { const f=document.createElement('iframe'); f.onload=()=>resolve(f.contentWindow.location.href); f.src=${JSON.stringify(origin + '/frame-start')}; document.body.append(f); })`);
    assert.equal(frameUrl, origin + '/frame-final'); checks.push('subframe redirect preserved');
    const before = warnings.length;
    await wc.executeJavaScript("window.open('ms-settings:privacy'); void 0", true);
    assert.equal(opened.length, 0); assert.ok(warnings.length > before); checks.push('unsafe popup blocked before OS dispatch');
    await wc.executeJavaScript("window.open('https://example.org/release-check'); void 0", true);
    assert.deepEqual(opened, ['https://example.org/release-check']); checks.push('safe popup routed to injected adapter only');
    const camera = await wc.executeJavaScript("navigator.permissions.query({name:'camera'}).then(p=>p.state)");
    assert.equal(camera, 'denied'); checks.push('camera permission denied without opening a device');
    const image=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=');
    assert.equal(image.isEmpty(),false);
    const item=new ClipboardItem({'image/png':new Blob([new Uint8Array(image.toPNG())],{type:'image/png'})});
    const payload=await item.getType('image/png');assert.equal(payload.type,'image/png');assert.ok((await payload.arrayBuffer()).byteLength>8);
    checks.push('native ClipboardItem accepts encoded PNG without writing the OS clipboard');
    win.destroy();
    const file = path.join(fixture, 'entry.html'), foreign = path.join(fixture, 'foreign.html');
    fs.writeFileSync(file, '<!doctype html><body>Trusted fixture</body>'); fs.writeFileSync(foreign, '<!doctype html><body>Untrusted fixture</body>');
    create(pathToFileURL(file).href); await win.loadFile(file);
    await blocked(win.webContents, 'will-navigate', pathToFileURL(foreign).href);
    assert.equal(win.webContents.getURL(), pathToFileURL(file).href); checks.push('file entry cannot navigate to another document');
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify({ versions: process.versions, checks }, null, 2));
    console.log('PASS native Electron window checks: ' + checks.length);
  } finally { if (win && !win.isDestroyed()) win.destroy(); await new Promise(resolve => server.close(resolve)); }
  app.exit(0);
}

function main() {
  const ts = req('typescript');
  const root = path.join(appDir, '.tmp'); fs.mkdirSync(root, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'release-window-'));
  const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  fs.writeFileSync(path.join(fixture, 'navigation.cjs'), compile(fs.readFileSync(path.join(appDir, 'src/main/lib/windowNavigation.ts'), 'utf8')));
  const file = path.join(appDir, 'src/main/window.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const setup = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setupSessionPermissions');
  assert.ok(setup);
  fs.writeFileSync(path.join(fixture, 'permissions.cjs'), compile('module.exports=(session,getMainWindow)=>{let sessionPermissionsReady=false;' + setup.getText(source) + ';setupSessionPermissions();};'));
  const env = { ...process.env, APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'local-appdata') };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];
  const result = spawnSync(req('electron'), [__filename, '--host', fixture], { cwd: fixture, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  fs.writeFileSync(path.join(fixture, 'host.log'), (result.stdout || '') + (result.stderr || ''));
  console.log('Native window artifacts: ' + fixture);
  if (result.stdout) console.log(result.stdout.trim());
  assert.equal(result.status, 0, result.error?.message || result.stderr || 'Native fixture failed');
  assert.ok(fs.existsSync(path.join(fixture, 'result.json')), 'Native fixture did not produce a result');
}
if (process.argv[2] === '--host') host().catch(error => { console.error(error); require('electron').app.exit(1); });
else { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
