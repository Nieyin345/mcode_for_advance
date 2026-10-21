// T73 additional fail-closed post-package gate. Invoke alongside check-unpacked.cjs.
// Usage: node scripts/t73-browser-sandbox-smoke/verify-package.cjs <win-unpacked>
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
const unpacked=process.argv[2]&&path.resolve(process.argv[2]);
if(!unpacked)throw Error('Explicit win-unpacked path required');
const archive=path.join(unpacked,'resources','app.asar');
assert.ok(fs.existsSync(archive),'missing app.asar');
const req=createRequire(path.join(root,'package.json'));
const builderReq=createRequire(req.resolve('electron-builder'));
const libReq=createRequire(builderReq.resolve('app-builder-lib'));
const asar=libReq('@electron/asar');
const entries=new Set(asar.listPackage(archive).map(e=>e.replaceAll('\\','/').replace(/^\//,'')));
const contents=file=>asar.extractFile(archive,file.replaceAll('/',path.sep));
const digest=value=>createHash('sha256').update(value).digest('hex');
for(const name of ['index.mjs','browserPicker.mjs','browserPicker.cjs']){
  const rel='out/preload/'+name;
  assert.ok(entries.has(rel),'missing sealed packaged preload: '+rel);
  const packaged=contents(rel);
  const built=fs.readFileSync(path.join(root,rel));
  assert.equal(digest(packaged),digest(built),'packaged preload differs from built source: '+rel);
}
const code=contents('out/preload/browserPicker.cjs').toString('utf8');
assert.ok(/require\(['"]electron['"]\)/.test(code),'picker must use sandbox-compatible CJS');
assert.ok(!/\bimport\s+(?:\{|\*|[\w]+\s+from)/.test(code),'picker cannot carry ESM imports');
assert.ok(!/require\(['"]node:/.test(code),'picker cannot require Node privileged APIs');
console.log('PASS T73 packaged CJS sandbox preload, legacy ESM release manifest, identical artifacts');
