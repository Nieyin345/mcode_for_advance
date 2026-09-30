const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '../..');
const req = createRequire(path.join(app, 'package.json'));
const ts = req('typescript');
const source = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); } }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-release-check-'));
function put(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function assetPlugins() {
 const fixture = fs.mkdtempSync(path.join(base, 'assets-')); const dir = path.join(fixture, 'apps/desktop');
 const pdf = path.join(dir, 'node_modules/pdfjs-dist');
 put(path.join(pdf, 'package.json'), JSON.stringify({version:'1.0.0'}));
 put(path.join(pdf, 'cmaps/chinese.bcmap'), 'cmap-data'); put(path.join(pdf, 'standard_fonts/Font.pfb'), 'font-data');
 const wasm = path.join(fixture,'node_modules/.pnpm/@embedpdf+pdfium@1.0.0/node_modules/@embedpdf/pdfium');
 put(path.join(wasm,'package.json'),JSON.stringify({version:'1.0.0'}));put(path.join(wasm,'dist/pdfium.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
 const sf = source(path.join(app, 'electron.vite.config.ts'));
 // Execute actual production functions and their Node imports, not a copied plugin.
 const statements = sf.statements.filter(n => ts.isFunctionDeclaration(n) ||
  (ts.isImportDeclaration(n) && n.moduleSpecifier.text.startsWith('node:')) ||
  (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(sf)==='pdfjsPkgDir')));
 const exports = {}; new Function('require','exports','__dirname',compile(statements.map(n=>n.getText(sf)).join('\n')+'\nexports.plugins={copyPdfiumWasm,copyPdfjsAssets};'))(req,exports,dir);
 return {dir, plugins:exports.plugins};
}
function navigation() {
 const windowSource=source(path.join(app,'src/main/window.ts')); const opened=[]; const handlers=new Map();
 const shell={openExternal:async url=>{opened.push(url);}}; const log={warn:()=>{}};
 const web={on:(name,cb)=>{handlers.set(name,cb);return web;},setWindowOpenHandler:cb=>handlers.set('open',cb)};
 const helper=path.join(app,'src/main/lib/windowNavigation.ts');
 let wired=false, callback;
 const visit=n=>{if(ts.isCallExpression(n)){
  if(n.expression.getText(windowSource)==='installMainWindowNavigation')wired=true;
  if(n.expression.getText(windowSource).endsWith('.setWindowOpenHandler'))callback=n.arguments[0];
 }ts.forEachChild(n,visit);};visit(windowSource);
 if(wired) {
  const exports={};new Function('require','exports',compile(fs.readFileSync(helper,'utf8')))(req,exports);
  exports.installMainWindowNavigation(web,'file:///C:/app/out/renderer/index.html',shell.openExternal,log.warn);
 } else {
  assert.ok(callback,'Production window-open callback missing');
  web.setWindowOpenHandler(new Function('shell','log','return '+compile('const cb='+callback.getText(windowSource)+';').replace(/^const cb\s*=\s*/, '').replace(/;\s*$/, '') )(shell,log));
 }
 return {opened,handlers};
}
function dereferenceFixture(failure) {
 const fixture=fs.mkdtempSync(path.join(base,'workspace-'));const dir=path.join(fixture,'apps/desktop');
 const target=path.join(fixture,'packages/contracts');const full=path.join(dir,'node_modules/@mcode/contracts');
 put(path.join(target,'package.json'),JSON.stringify({name:'@mcode/contracts'}));fs.mkdirSync(path.dirname(full),{recursive:true});
 fs.symlinkSync(target,full,process.platform==='win32'?'junction':'dir');
 let exit=0;
 const injected={...fs,cpSync:(...args)=>{if(failure==='copy')throw Error('injected copy failure');return fs.cpSync(...args);},renameSync:(from,to)=>{
  if(failure==='publish'&&to===full&&from.includes('.deref-tmp'))throw Error('injected publish failure');return fs.renameSync(from,to);
 }};
 try{new Function('require','__dirname','process','console',fs.readFileSync(path.join(app,'build/dereference-workspace-symlinks.cjs'),'utf8'))(
  name=>name==='node:fs'?injected:req(name),path.join(dir,'build'),{exit(code){exit=code;throw Object.assign(Error('exit'),{isExit:true});}},{log(){},error(){}});
 }catch(e){if(!e.isExit)throw e;}
 return {exit,full,target};
}
function permissions() {
 const sf=source(path.join(app,'src/main/window.ts'));
 const setup=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='setupSessionPermissions');assert.ok(setup);
 const handlers={};const session={defaultSession:{setPermissionRequestHandler:fn=>handlers.request=fn,setPermissionCheckHandler:fn=>handlers.check=fn}};
 new Function('session','getMainWindow',compile('let sessionPermissionsReady=false;'+setup.getText(sf)+';setupSessionPermissions();'))(session,()=>({isDestroyed:()=>false,webContents:{id:7}}));
 return handlers;
}
function browserPopup(spawnSucceeds=false) {
 const sf=source(path.join(app,'src/main/browser/BrowserManager.ts'));
 const klass=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BrowserManagerImpl');
 const method=klass.members.find(n=>n.name?.getText(sf)==='handleWindowOpen');assert.ok(method);
 const helper={};new Function('require','exports',compile(fs.readFileSync(path.join(app,'src/main/lib/windowNavigation.ts'),'utf8')))(req,helper);
 const opened=[],loaded=[],messages=[];const log={info:s=>messages.push(s),warn:s=>messages.push(s)};
 const Fixture=new Function('shell','log','externalWindowUrl','sendToRenderer','IPC',compile('class Fixture {'+method.getText(sf)+'};')+';return Fixture;')({openExternal:async url=>opened.push(url)},log,helper.externalWindowUrl,()=>{}, {BROWSER_EVENT:'browser:event'});
 const instance=new Fixture();instance.spawnView=()=>spawnSucceeds?{live:{id:'child'}}:{error:'injected capacity limit'};instance.loadUrl=(id,url)=>loaded.push(url);
 return {open:url=>instance.handleWindowOpen({id:'parent',projectPath:'/fixture'},url,'foreground-tab'),opened,loaded,messages};
}
function browserLoad(mode) {
 const sf=source(path.join(app,'src/main/browser/BrowserManager.ts'));
 const klass=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BrowserManagerImpl');
 const method=klass.members.find(n=>n.name?.getText(sf)==='loadUrl');assert.ok(method);
 const messages=[];let calls=0;
 const Fixture=new Function('log',compile('class Fixture {'+method.getText(sf)+'};')+';return Fixture;')({warn:s=>messages.push(s)});
 const instance=new Fixture();instance.get=()=>({ready:mode==='restore'?Promise.reject(Error('restore failed')):Promise.resolve(),view:{webContents:{isDestroyed:()=>mode==='destroyed',loadURL:async()=>{calls++;if(mode==='load')throw Error('load failed with private token');}}}});
 return {run:()=>instance.loadUrl('fixture','https://example.org'),messages,calls:()=>calls};
}
async function bundledSchemaPeers() {
 const fixture=fs.mkdtempSync(path.join(base,'schema-peers-'));
 put(path.join(fixture,'package.json'),JSON.stringify({type:'module',dependencies:{zod:'3.24.0'}}));
 put(path.join(fixture,'node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'3.24.0',type:'module',exports:{'.':'./index.js'}}));
 put(path.join(fixture,'node_modules/zod/index.js'),'export const z = "fixture-zod-three";');
 put(path.join(fixture,'node_modules/schema-peer/package.json'),JSON.stringify({name:'schema-peer',type:'module'}));
 put(path.join(fixture,'node_modules/schema-peer/index.js'),'export {z} from "zod/v4";');
 put(path.join(fixture,'node_modules/schema-peer/node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.4.3',type:'module',exports:{'./v4':'./v4.js'}}));
 put(path.join(fixture,'node_modules/schema-peer/node_modules/zod/v4.js'),'export const z = "fixture-zod-four";');
 const entry=path.join(fixture,'entry.js');put(entry,'import {z as root} from "zod";import {z as peer} from "./node_modules/schema-peer/index.js";export const versions=[root,peer];');
 const sf=source(path.join(app,'electron.vite.config.ts'));
 const exported=sf.statements.find(ts.isExportAssignment);const object=exported.expression.arguments[0];
 const main=object.properties.find(n=>n.name?.getText(sf)==='main').initializer;
 const exports={};new Function('exports','externalizeDepsPlugin','resolve',compile('exports.config='+main.getText(sf)+';'))(exports,req('electron-vite').externalizeDepsPlugin,path.resolve);
 const config=exports.config;
 const result=await req('vite').build({configFile:false,root:fixture,logLevel:'silent',plugins:config.plugins,resolve:config.resolve,build:{...config.build,write:false,minify:false,lib:{entry,formats:['es']},rollupOptions:{...config.build.rollupOptions,output:{}}}});
 const chunks=(Array.isArray(result)?result:[result]).flatMap(r=>r.output).filter(n=>n.type==='chunk');
 assert.ok(chunks.every(c=>c.imports.every(name=>!/^zod(?:\/|$)/.test(name))),'Schema peers escaped into the flat runtime package');
 const code=chunks.map(c=>c.code).join('\n');assert.ok(code.includes('fixture-zod-three')&&code.includes('fixture-zod-four'),'Both resolved schema peer versions must be preserved');
}
(async()=>{try{
 await test('main bundling preserves incompatible schema peers instead of flattening zod',bundledSchemaPeers);
 for(const mode of ['restore','load'])await test('browser navigation contains asynchronous '+mode+' rejection',async()=>{const errors=[];const listener=e=>errors.push(e);process.on('unhandledRejection',listener);try{const b=browserLoad(mode);b.run();await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(errors,[]);assert.ok(b.messages.every(s=>!s.includes('private token')));}finally{process.removeListener('unhandledRejection',listener);}});
 await test('closing a browser before cookie restoration skips the stale navigation',async()=>{const b=browserLoad('destroyed');b.run();await Promise.resolve();assert.equal(b.calls(),0);});
 for(const url of ['ms-settings:privacy','vscode://file/C:/private','javascript:alert(1)','data:text/html,hello','file:///C:/private.txt','not-a-url'])await test('browser popup fallback refuses OS dispatch: '+url,async()=>{const p=browserPopup();p.open(url);await Promise.resolve();assert.deepEqual(p.opened,[]);});
 for(const url of ['https://example.org','mailto:author@example.org'])await test('browser approved system fallback remains available: '+url,async()=>{const p=browserPopup();p.open(url);await Promise.resolve();assert.equal(p.opened.length,1);});
 await test('browser web popups retain in-panel tabs without leaking URL tokens to logs',()=>{const p=browserPopup(true);p.open('https://example.org/?token=do-not-log');assert.equal(p.loaded.length,1);assert.deepEqual(p.opened,[]);assert.ok(p.messages.every(s=>!s.includes('do-not-log')));});
 await test('default-session microphone permission refuses foreign and missing contents',()=>{const p=permissions();assert.equal(p.check(null,'media','',{}),false);assert.equal(p.check({id:8},'media','',{}),false);});
 await test('main renderer retains microphone and clipboard permissions',()=>{const p=permissions();assert.equal(p.check({id:7},'media','',{isMainFrame:true,mediaType:'audio'}),true);assert.equal(p.check({id:7},'clipboard-read','',{}),true);});
 await test('untrusted subframes cannot obtain media permissions',()=>{const p=permissions();let allowed;p.request({id:7},'media',value=>{allowed=value;},{isMainFrame:false,mediaTypes:['audio']});assert.equal(allowed,false);});
 await test('voice input does not implicitly grant camera permission',()=>{const p=permissions();let allowed;p.request({id:7},'media',value=>{allowed=value;},{isMainFrame:true,mediaTypes:['video']});assert.equal(allowed,false);});
 await test('workspace packaging prepares a real copy without editing source',()=>{const f=dereferenceFixture();assert.equal(f.exit,0);assert.equal(fs.lstatSync(f.full).isSymbolicLink(),false);assert.ok(fs.existsSync(path.join(f.target,'package.json')));});
 await test('failed workspace copy retains original link',()=>{const f=dereferenceFixture('copy');assert.equal(f.exit,1);assert.equal(fs.lstatSync(f.full).isSymbolicLink(),true);});
 await test('failed workspace publication restores original link',()=>{const f=dereferenceFixture('publish');assert.equal(f.exit,1);assert.equal(fs.lstatSync(f.full).isSymbolicLink(),true);assert.equal(fs.realpathSync(f.full),fs.realpathSync(f.target));});
 await test('initial PDF assets are copied from the installed packages',()=>{const f=assetPlugins();f.plugins.copyPdfjsAssets().buildStart();f.plugins.copyPdfiumWasm().buildStart();assert.ok(fs.existsSync(path.join(f.dir,'src/renderer/public/embedpdf/pdfium.wasm')));assert.ok(fs.existsSync(path.join(f.dir,'src/renderer/public/pdfjs/cmaps/chinese.bcmap')));});
 await test('matching version marker cannot hide a missing PDFium WASM',()=>{const f=assetPlugins();const plugin=f.plugins.copyPdfiumWasm();plugin.buildStart();const file=path.join(f.dir,'src/renderer/public/embedpdf/pdfium.wasm');fs.unlinkSync(file);plugin.buildStart();assert.ok(fs.existsSync(file),'WASM was not repaired');});
 await test('matching version marker cannot hide a missing CMap',()=>{const f=assetPlugins();const plugin=f.plugins.copyPdfjsAssets();plugin.buildStart();const file=path.join(f.dir,'src/renderer/public/pdfjs/cmaps/chinese.bcmap');fs.unlinkSync(file);plugin.buildStart();assert.equal(fs.readFileSync(file,'utf8'),'cmap-data');});
 await test('truncated PDF font is repaired despite unchanged version',()=>{const f=assetPlugins();const plugin=f.plugins.copyPdfjsAssets();plugin.buildStart();const file=path.join(f.dir,'src/renderer/public/pdfjs/standard_fonts/Font.pfb');fs.writeFileSync(file,'');plugin.buildStart();assert.equal(fs.readFileSync(file,'utf8'),'font-data');});
 for(const url of ['file:///C:/Windows/System32/calc.exe','javascript:alert(1)','data:text/html,hello','ms-settings:privacy','vscode://file/C:/private','not-a-url'])await test('untrusted popup never reaches OS handler: '+url,async()=>{const n=navigation();assert.deepEqual(n.handlers.get('open')({url}),{action:'deny'});await Promise.resolve();assert.deepEqual(n.opened,[]);});
 for(const url of ['https://example.org/paper','http://localhost:8000/docs','mailto:author@example.org'])await test('approved external link opens once: '+url,async()=>{const n=navigation();n.handlers.get('open')({url});await Promise.resolve();assert.equal(n.opened.length,1);});
 await test('top-level remote navigation cannot inherit privileged preload',()=>{const n=navigation();let stopped=0;assert.ok(n.handlers.has('will-navigate'),'Navigation guard is absent');n.handlers.get('will-navigate')({preventDefault(){stopped++;}},'https://example.org/untrusted');assert.equal(stopped,1);});
 await test('redirect to untrusted content is blocked',()=>{const n=navigation();let stopped=0;assert.ok(n.handlers.has('will-redirect'),'Redirect guard is absent');n.handlers.get('will-redirect')({preventDefault(){stopped++;}},'https://example.org/untrusted',false,true);assert.equal(stopped,1);});
 await test('subframe redirects stay with their own sandbox policy',()=>{const n=navigation();let stopped=0;n.handlers.get('will-redirect')({preventDefault(){stopped++;}},'https://office.example.org/frame',false,false);assert.equal(stopped,0);});
 await test('same entry hash navigation stays inside the app',()=>{const n=navigation();let stopped=0;assert.ok(n.handlers.has('will-navigate'));n.handlers.get('will-navigate')({preventDefault(){stopped++;}},'file:///C:/app/out/renderer/index.html#settings');assert.equal(stopped,0);});
}finally{fs.rmSync(base,{recursive:true,force:true});}console.log(`Release readiness smoke: ${pass}/${pass+fail}`);process.exitCode=fail?1:0;})().catch(e=>{console.error(e);process.exitCode=1;});
