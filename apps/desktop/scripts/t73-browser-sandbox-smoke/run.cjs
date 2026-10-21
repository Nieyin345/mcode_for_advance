// T73: real spawnView constructor + sandboxed preload regressions. No user DB/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'package.json'));
const ts = req('typescript');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let checks = 0;
function test(name, action) {
  try { action(); checks++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
}
const source = read('src/main/browser/BrowserManager.ts');
const tree = ts.createSourceFile('BrowserManager.ts', source, ts.ScriptTarget.Latest, true);
const cls = tree.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BrowserManagerImpl');
const spawn = cls?.members.find(n => n.name?.getText(tree) === 'spawnView');
assert.ok(spawn, 'must test production BrowserManagerImpl.spawnView, not a copied config');
function makeHarness({electronRuntime = false, preloadExists = true} = {}) {
  const constructed = []; const ipc = {};
  const ses = { name: 'persistent-browser' };
  const mockMain = { isDestroyed: () => false, contentView: { addChildView: () => {} } };
  class WebContentsView {
    constructor(options) {
      constructed.push(options);
      this.webContents = {
        id: 42, getUserAgent: () => 'Chrome', setUserAgent: () => {},
        setWindowOpenHandler: () => {}, debugger: {attach: () => {}},
        isDestroyed: () => false,
      };
    }
    setBackgroundColor() {}
    setBounds() {}
  }
  const args = ['WebContentsView', 'getMainWindow', 'browserSession', 'randomUUID', 'join', '__dirname',
    'BROWSER_BACKGROUND', 'HIDDEN_BOUNDS', 'chromeLikeUserAgent', 'log', 'IPC', 'sendToRenderer', 'process', 'existsSync', 'app'];
  const vals = [WebContentsView, () => mockMain, () => ses, () => 'fake-id', path.join,
    path.join(root, 'out/main'), '#fff', {x:-100,y:-100,width:1,height:1},
    v => v, {info: () => {}, error: () => {}, warn: () => {}}, {BROWSER_EVENT:'browser:event'}, () => {},
    {versions:{electron: electronRuntime ? '44.4.5' : undefined},cwd:()=>root}, () => preloadExists, {isPackaged:true}];
  const js = ts.transpileModule('class Harness { ' + spawn.getText(tree) + ' }\nexports.Harness=Harness', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const out = {};
  new Function(...args, 'exports', js)(...vals, out);
  const h = new out.Harness();
  h.browsers = new Map(); h.wcToBrowser = new Map();
  h.restoreCookieVault = () => Promise.resolve(); h.installPickerListener = () => {};
  h.attachNavigationEvents = () => {}; h.ensurePersistTimer = () => {};
  h.installDownloadListener = () => {}; h.installReloadCleanup = () => {};
  h.pinColorScheme = () => Promise.resolve();
  const result = h.spawnView('/isolated/project');
  if (preloadExists || !electronRuntime) assert.ok('live' in result, 'production spawnView returned live');
  return {constructed, ses, h, result};
}
test('production BrowserManager spawnView forces sandbox, isolation, and dedicated session', () => {
  const {constructed, ses} = makeHarness();
  assert.equal(constructed.length, 1);
  const pref = constructed[0].webPreferences;
  assert.equal(pref.sandbox, true);
  assert.equal(pref.nodeIntegration, false);
  assert.equal(pref.contextIsolation, true);
  assert.strictEqual(pref.session, ses);
  assert.equal(path.basename(pref.preload), 'browserPicker.cjs');
  assert.equal(path.resolve(pref.preload), path.resolve(root, 'out/preload/browserPicker.cjs'));
});
test('missing sandboxed preload fails closed before creating any untrusted Electron view', () => {
  const {constructed, result} = makeHarness({electronRuntime:true, preloadExists:false});
  assert.equal(constructed.length,0);
  assert.ok('error' in result);
  assert.ok(result.error.includes('browserPicker.cjs'));
});
test('host picker IPC rejects inactive tabs, unknown webContents and child frames', () => {
  const method = cls.members.find(n => n.name?.getText(tree) === 'installPickerListener');
  assert.ok(method, 'must execute production picker host listener');
  const javascript = ts.transpileModule('class Listener { ' + method.getText(tree) + ' }\nexports.Listener = Listener', {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  const sent=[], listeners=new Map(), exports={};
  new Function('ipcMain','sendToRenderer','IPC','PICK_HTML_CAP','PICK_SELECTOR_CAP','PICK_PREVIEW_CAP','PICK_URL_CAP','exports',javascript)(
    {on:(channel,fn)=>listeners.set(channel,fn)}, (...args)=>sent.push(args),
    {BROWSER_EVENT:'browser:event'},2001,1000,200,4096,exports);
  const h=new exports.Listener();
  h.wcToBrowser=new Map([[42,'b']]); h.browsers=new Map([['b',{pickMode:false}]]);
  h.installPickerListener();
  const fn=listeners.get('__mcode_pick_result__');
  assert.equal(typeof fn,'function');
  const mainFrame={id:1};
  const sender={id:42,getURL:()=> 'https://trusted-browser-url.invalid/',mainFrame};
  fn({sender,senderFrame:mainFrame},{selector:'#pick'});
  assert.equal(sent.length,0,'inactive pick mode accepted IPC');
  h.browsers.get('b').pickMode=true;
  fn({sender:{...sender,id:99},senderFrame:mainFrame},{selector:'#pick'});
  assert.equal(sent.length,0,'unregistered webContents accepted IPC');
  fn({sender,senderFrame:{id:3}},{selector:'#pick'});
  assert.equal(sent.length,0,'child frame stole tab picker authority');
  fn({sender,senderFrame:mainFrame},{selector:'#pick',url:'https://forged.invalid/'});
  assert.equal(sent.length,1,'valid preload pick not forwarded');
  assert.equal(sent[0][1].payload.url,'https://trusted-browser-url.invalid/');
});
test('picker bundle uses CJS require of Electron without other Node imports or additional exports', () => {
  const code = ts.transpileModule(read('src/preload/browserPicker.ts'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}
  }).outputText;
  assert.ok(/require\(["']electron["']\)/.test(code));
  assert.ok(!/\bimport\s+/.test(code));
  assert.ok(!/require\(["'](?:node:)?(?:fs|child_process|module)["']\)/.test(code));
  assert.ok(!/exposeInMainWorld\(["'](?:api|electron|require)["']/.test(code));
  const listeners = new Map(), outgoing = [], exposed = {}, timers = [];
  class Element { constructor(id) { this.id=id; this.outerHTML='<button id="'+id+'">Pick</button>'; this.tagName='BUTTON'; } }
  const item = new Element('pick');
  const document = { addEventListener: (key, cb) => listeners.set(key, cb), querySelector: value => value === '#pick' ? item : null };
  const ipcRenderer = {send: (...args) => outgoing.push(args)};
  const ctx = {require: name => {assert.equal(name,'electron'); return {
    contextBridge: {exposeInMainWorld: (key, api) => {exposed[key]=api;}}, ipcRenderer };},
    document, Element, location:{href:'https://untrusted.invalid/'}, setTimeout: fn => timers.push(fn),
    console, exports: {}
  };
  vm.runInNewContext(code, ctx, {filename:'browserPicker.cjs'});
  assert.deepEqual(Object.keys(exposed), ['mcodeBridge']);
  assert.deepEqual(Object.keys(exposed.mcodeBridge), ['pickElement']);
  assert.equal(typeof exposed.mcodeBridge.pickElement,'function');
  exposed.mcodeBridge.pickElement({selector:'#pick'});
  assert.equal(outgoing.length,0, 'page must not send without trusted click');
  const click = listeners.get('click'); assert.equal(typeof click, 'function');
  click({isTrusted:false,target:item});
  exposed.mcodeBridge.pickElement({selector:'#pick'});
  assert.equal(outgoing.length,0, 'synthetic click must be ignored');
  click({isTrusted:true,target:item});
  exposed.mcodeBridge.pickElement({selector:'#forged',outerHTML:'forged'});
  assert.equal(outgoing.length,0, 'selector must match actual trusted element');
  exposed.mcodeBridge.pickElement({selector:'#pick',outerHTML:'forged',preview:'forged',url:'https://forged.invalid/'});
  assert.equal(outgoing.length,1, 'genuine click must reach IPC once');
  assert.equal(outgoing[0][0],'__mcode_pick_result__');
  assert.equal(outgoing[0][1].selector,'#pick');
  assert.equal(outgoing[0][1].outerHTML,item.outerHTML, 'preload owns DOM, not untrusted data');
  assert.equal(outgoing[0][1].url,'https://untrusted.invalid/');
  exposed.mcodeBridge.pickElement({selector:'#pick'});
  assert.equal(outgoing.length,1, 'bridge cannot replay one gesture');
  click({isTrusted:true,target:item}); timers.forEach(fn => fn());
  exposed.mcodeBridge.pickElement({selector:'#pick'});
  assert.equal(outgoing.length,1, 'expired gesture cannot replay');
});
test('build defines both legacy ESM asset for current release gate and sandboxed CJS asset', () => {
  const config = read('electron.vite.config.ts');
  assert.match(config, /browserPicker:\s*["']src\/preload\/browserPicker\.ts["']/);
  assert.match(config, /name:\s*["']mcode:browser-picker-sandbox-cjs["']/);
  assert.match(config, /fileName:\s*["']browserPicker\.cjs["']/);
  assert.match(config, /browserPicker\.mjs/);
});
console.log('T73 sandbox/preload checks: ' + checks + '/5');
if (process.exitCode) process.exit(process.exitCode);
