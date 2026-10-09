// Exercise the remaining reviewed production changes without booting product main,
// opening a real database, starting a server, or touching the user's clipboard.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '../..');
const req = createRequire(path.join(app, 'package.json'));
const ts = req('typescript');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const read = rel => fs.readFileSync(path.resolve(app, rel), 'utf8');
function load(rel, bindings = {}) {
  const exports = {};
  new Function('require', 'exports', compile(read(rel)))(name => {
    if (Object.hasOwn(bindings, name)) return bindings[name];
    if (name === 'zod' || name.startsWith('node:')) return req(name);
    throw Error('Unstubbed import: ' + name);
  }, exports);
  return exports;
}
function functions(rel, names, bindings = {}) {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const selected = sf.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
  assert.equal(selected.length, names.length);
  const exports = {};
  new Function(...Object.keys(bindings), 'exports', compile(selected.map(n => n.getText(sf)).join('\n') + '\n' + names.map(n => `exports.${n}=${n};`).join('\n')))(...Object.values(bindings), exports);
  return exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
const tempRoot = path.join(app, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'reviewed-changes-'));
function pairing() {
  const handlers = {}, calls = [];
  const IPC = new Proxy({}, { get: (_, key) => key });
  load('src/main/ipc/mobile.ts', {
    '@contracts/ipc': { IPC, RevokeMobileDeviceSchema: req('zod').z.object({ deviceId: req('zod').z.string() }) },
    '@main/mobile/PairingManager.js': { pairingManager: { startPairing: (endpoint, options) => { calls.push({ endpoint, options }); return { endpoint, qrUrl: endpoint + '/?nonce=fixture' }; } }, detectLanIp: () => '192.168.1.8', detectLanIps: () => [] },
    '@main/mobile/MobileHttpServer.js': { getMobileServer: () => ({ port: 7331 }) },
    '@contracts/mobile': { MOBILE_ACTIVE_WINDOW_MS: 60000, SetMobileLoginSchema: req('zod').z.object({}).passthrough(), SetMobileTunnelSchema: req('zod').z.object({}).passthrough() },
    '@main/mobile/mobileTunnel.js': { mobileTunnelStatus: async () => ({}), setMobileTunnelConfig: async () => ({}), startMobileTunnel: async () => ({}), stopMobileTunnel: async () => ({}) },
    '@main/mobile/mobileLogin.js': { clearMobileLogin: async () => ({}), getMobileLoginStatus: async () => ({}), setMobileLogin: async () => ({}) },
    '@main/lib/logger.js': { log: { info() {} } },
  }).registerMobileHandlers({ handle: (key, fn) => { handlers[key] = fn; } });
  return { invoke: input => handlers.MOBILE_START_PAIRING({}, input), calls };
}
function picker() {
  const rel = 'src/main/browser/BrowserManager.ts';
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
  const cls = sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BrowserManagerImpl');
  const method = cls.members.find(n => n.name?.getText(sf) === 'installPickerListener'); assert.ok(method);
  const constants = sf.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(sf).startsWith('PICK_')));
  // `PICK_HTML_CAP` 现在是 `PICKER_HTML_CAP + 1`(从 pickerScript 导入,防止两处常量漂开),
  // 而本夹具只抽顶层 `PICK_*` 声明 —— 少了这个绑定,顶层那句 `const PICK_HTML_CAP =
  // PICKER_HTML_CAP + 1` 会抛 "PICKER_HTML_CAP is not defined"。按真值从 pickerScript 取。
  const pickerCap = /\bPICKER_HTML_CAP\s*=\s*(\d+)/.exec(read('src/main/browser/pickerScript.ts'))?.[1];
  assert.ok(pickerCap, 'harness must read PICKER_HTML_CAP from pickerScript');
  const sent = []; let listener;
  const Factory = new Function('ipcMain', 'sendToRenderer', 'IPC', 'PICKER_HTML_CAP', compile(constants.map(n => n.getText(sf)).join('\n') + '\nclass Fixture {' + method.getText(sf) + '}\n') + 'return Fixture;')({ on: (_, fn) => { listener = fn; } }, (...args) => sent.push(args), { BROWSER_EVENT: 'browser:event' }, Number(pickerCap));
  const object = new Factory(); object.wcToBrowser = new Map([[7, 'tab']]); object.browsers = new Map([['tab', { pickMode: false }]]); object.installPickerListener();
  return { object, sent, send: (value, id = 7) => listener({ sender: { id, getURL: () => 'https://actual.example/' } }, value) };
}
(async () => { try {
  await test('pairing defaults and valid LAN host preserve force semantics', async () => {
    const p = pairing(); assert.equal((await p.invoke()).pairing.endpoint, 'http://192.168.1.8:7331');
    assert.equal((await p.invoke({ host: ' pc.local ', force: true })).pairing.endpoint, 'http://pc.local:7331'); assert.equal(p.calls[1].options.force, true);
  });
  await test('pairing rejects renderer shapes, URL injection, and wrong field types', async () => {
    const p = pairing(); for (const input of [[], 'text', { host: 'https://bad/' }, { host: 'user@bad' }, { mode: 'typo' }, { force: 'true' }]) await assert.rejects(p.invoke(input)); assert.equal(p.calls.length, 0);
  });
  await test('pairing bare and bracketed IPv6 produce valid URLs', async () => {
    const p = pairing(); for (const host of ['::1', '[::1]', '2001:db8::1']) { const result = await p.invoke({ host }); const url = new URL(result.pairing.endpoint); assert.equal(url.port, '7331'); assert.ok(url.hostname.startsWith('[')); }
  });
  await test('pairing rejects malformed host/port combinations before creating nonce', async () => {
    const p = pairing(); for (const host of ['pc.local:80', '[::1]:80', '[]', '999.999.999.999']) await assert.rejects(p.invoke({ host })); assert.equal(p.calls.length, 0);
  });
  await test('remote pairing rejects non-HTTP URLs, credentials, query, hash, or missing endpoint', async () => {
    const p = pairing(); for (const endpoint of ['javascript:alert(1)', 'file:///tmp/x', 'not-url', 'https://u:p@example.com', 'https://example.com/?x=y', 'https://example.com/#x', 'https://example.com/?', 'https://example.com/#', undefined]) await assert.rejects(p.invoke({ mode: 'remote', endpoint })); assert.equal(p.calls.length, 0);
  });
  await test('remote pairing keeps HTTPS and normalizes trailing slash for nonce URL', async () => {
    const p = pairing(); const result = await p.invoke({ mode: 'remote', endpoint: ' https://relay.example/base/ ', force: true }); assert.equal(result.pairing.mode, 'remote'); assert.equal(result.pairing.qrUrl, 'https://relay.example/base/?nonce=fixture'); assert.equal((await p.invoke({ mode: 'remote', endpoint: 'https:relay.example' })).pairing.endpoint, 'https://relay.example');
  });
  await test('picker ignores unsolicited messages and unknown sender', () => {
    const p = picker(); p.send({ selector: '#x' }); p.object.browsers.get('tab').pickMode = true; p.send({ selector: '#x' }, 99); assert.equal(p.sent.length, 0);
  });
  await test('picker strips foreign fields, caps content, and obtains trusted sender URL', () => {
    const p = picker(); p.object.browsers.get('tab').pickMode = true; p.send({ selector: 'a'.repeat(2000), outerHTML: 'x'.repeat(5000), preview: 'y'.repeat(500), url: 'https://forged.example/', extra: 'discard' });
    const result = p.sent[0][1].payload; assert.deepEqual(Object.keys(result).sort(), ['outerHTML', 'preview', 'selector', 'url']); assert.equal(result.selector.length, 1000); assert.equal(result.outerHTML.length, 2001); assert.equal(result.preview.length, 200); assert.equal(result.url, 'https://actual.example/');
  });
  await test('picker rejects bad selector and normalizes non-text optional fields', () => {
    const p = picker(); p.object.browsers.get('tab').pickMode = true; for (const value of [null, {}, { selector: '' }, { selector: 3 }]) p.send(value); assert.equal(p.sent.length, 0); p.send({ selector: '#ok', outerHTML: {}, preview: false }); assert.equal(p.sent[0][1].payload.outerHTML, ''); assert.equal(p.sent[0][1].payload.preview, '');
  });
  const snapshots = load('src/main/lib/fileSnapshot.ts', { '@main/lib/msysPath.js': load('src/main/lib/msysPath.ts') });
  await test('snapshot preserves UTF-8 BOM and restores exact original bytes', async () => {
    const file = path.join(temp, 'bom.txt'); const original = Buffer.from('\ufeff初始内容\r\n', 'utf8'); fs.writeFileSync(file, original); const snapshot = new snapshots.FileSnapshot(); await snapshot.recordPre(temp, file); fs.writeFileSync(file, 'changed'); const entries = await snapshot.freeze(); assert.equal(entries[0].before.charCodeAt(0), 0xfeff); await snapshots.restoreFiles(temp, entries); assert.deepEqual(fs.readFileSync(file), original);
  });
  await test('snapshot refuses lossy bytes and never captures post-edit state as original', async () => {
    const file = path.join(temp, 'non-utf8.txt'); fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x61])); const snapshot = new snapshots.FileSnapshot(); await snapshot.recordPre(temp, file); fs.writeFileSync(file, 'now utf8'); await snapshot.recordPre(temp, file); assert.equal(snapshot.size, 0); assert.deepEqual(await snapshot.freeze(), []);
  });
  await test('snapshot clear resets excluded paths for a new lifecycle', async () => {
    const file = path.join(temp, 'reset.txt'); fs.writeFileSync(file, Buffer.from([0xff])); const snapshot = new snapshots.FileSnapshot(); await snapshot.recordPre(temp, file); snapshot.clear(); fs.writeFileSync(file, 'valid'); await snapshot.recordPre(temp, file); assert.equal(snapshot.size, 1);
  });
  const git = load('../../packages/contracts/src/ipc/git.ts');
  await test('git ref and branch fields reject leading options', () => {
    for (const [schema, field, base] of [[git.GitLogSchema, 'ref', {}], [git.GitCheckoutSchema, 'branch', {}], [git.GitCheckoutSchema, 'newBranch', { branch: 'main' }], [git.GitDeleteBranchSchema, 'branch', {}], [git.GitMergeSchema, 'source', {}]]) for (const value of ['--help', '-f', '--all']) assert.equal(schema.safeParse({ repoPath: temp, ...base, [field]: value }).success, false);
  });
  await test('git schemas retain valid refs and branch names', () => {
    assert.ok(git.GitLogSchema.safeParse({ repoPath: temp, ref: 'HEAD~2' }).success); assert.ok(git.GitCheckoutSchema.safeParse({ repoPath: temp, branch: 'origin/feature-x', newBranch: 'feature-x' }).success); assert.ok(git.GitMergeSchema.safeParse({ repoPath: temp, source: 'feature-x' }).success);
  });
  const auth = functions('src/main/providers/bridge/extensionBridge.ts', ['presentedToken', 'authorize'], { ensureToken: () => 'fixture-secret', timingSafeEqual: req('node:crypto').timingSafeEqual });
  await test('extension authentication accepts header and EventSource token', () => { assert.equal(auth.authorize({ headers: { authorization: 'Bearer fixture-secret' } }, new URL('http://localhost/')), true); assert.equal(auth.authorize({ headers: {} }, new URL('http://localhost/?token=fixture-secret')), true); });
  await test('extension authentication rejects missing, wrong, and unequal UTF-8 tokens without throw', () => { for (const token of ['', 'wrong', 'fixture-secrex', '密'.repeat(14)]) assert.equal(auth.authorize({ headers: { authorization: 'Bearer ' + token } }, new URL('http://localhost/')), false); });
  const zh = load('src/renderer/lib/i18n/zh/common.ts').zh;
  for (const response of [0, 1]) await test('database open failure dialog response ' + response + ' does not retry unreadable DB', async () => {
    let quit = 0; const dialogs = [];
    const fn = functions('src/main/store/persistenceAlerts.ts', ['showDbOpenError'], { app: { quit: () => quit++ }, dialog: { showMessageBox: async options => { dialogs.push(options); return { response }; } }, log: { error() {} }, zh }).showDbOpenError;
    fn(Error('fixture unreadable database')); await tick(); assert.equal(dialogs.length, 1); assert.equal(dialogs[0].detail, 'fixture unreadable database'); assert.deepEqual(dialogs[0].buttons, [zh['common.quitApp'], zh['common.keepAppOpen']]); assert.equal(quit, response === 0 ? 1 : 0);
  });
  await test('database open-failure dialog catches synchronous native errors', async () => {
    const errors = []; const fn = functions('src/main/store/persistenceAlerts.ts', ['showDbOpenError'], { app: { quit() { throw Error('unexpected quit'); } }, dialog: { showMessageBox() { throw Error('native dialog failed'); } }, log: { error: value => errors.push(value) }, zh }).showDbOpenError; fn('fixture'); await tick(); assert.ok(errors.some(message => message.includes('dialog failed')));
  });
  const { groupForId } = functions('src/renderer/lib/commands.ts', ['groupForId']);
  const { labelForId } = functions('src/renderer/components/settings/ShortcutsPanel.tsx', ['labelForId']);
  await test('filtered browser, sidechat and editor shortcuts retain translated labels and groups', () => {
    for (const locale of ['zh', 'en']) {
      const catalog = { ...load(`src/renderer/lib/i18n/${locale}/lib.ts`)[locale], ...load(`src/renderer/lib/i18n/${locale}/settings.ts`)[locale] };
      for (const id of ['layout.toggle-browser', 'layout.toggle-wide-panel', 'sidechat.open', 'editor.nav-back', 'editor.nav-forward']) { assert.ok(catalog[labelForId(id)], id); assert.equal(groupForId(id), id.startsWith('editor.') ? 'editor' : 'layout'); }
    }
  });
  await test('new bilingual library and failure messages have matching interpolation fields', () => {
    for (const area of ['common', 'library', 'settings']) {
      const zh = load(`src/renderer/lib/i18n/zh/${area}.ts`).zh, en = load(`src/renderer/lib/i18n/en/${area}.ts`).en;
      for (const key of Object.keys(zh).filter(key => /dbOpenFailure|quitApp|library.attach.|library.viewer.unreadable|library.import.allSupported|themeSetFailed/.test(key))) { assert.equal(typeof en[key], 'string', key); assert.deepEqual((zh[key].match(/\{\w+\}/g) || []).sort(), (en[key].match(/\{\w+\}/g) || []).sort(), key); }
    }
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`Reviewed changes smoke: ${passed}/${passed + failed}`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
