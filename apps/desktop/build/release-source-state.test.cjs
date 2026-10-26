"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const {inspectMcodeSource}=require("./release-source-state.cjs");

function repoFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-release-source-state-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pkgDir=path.join(root,"apps","desktop");
  fs.mkdirSync(pkgDir,{recursive:true});
  fs.writeFileSync(path.join(pkgDir,"package.json"),JSON.stringify({name:"@mcode/desktop",version:"0.1.0",private:true},null,2)+"\n");
  const git=(...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git("init");
  git("config","user.name","Mcode Test");
  git("config","user.email","mcode-test@example.invalid");
  git("add","apps/desktop/package.json");
  git("commit","-m","baseline");
  return {root,pkgPath:path.join(pkgDir,"package.json"),git};
}
test("clean source records the current package version",t=>{
  const f=repoFixture(t);
  const result=inspectMcodeSource({repoRoot:f.root});
  assert.equal(result.clean,true);
  assert.equal(result.versionOverrideOnly,false);
  assert.equal(result.releaseVersion,"0.1.0");
});
test("permits only the explicitly declared package.json release-version stamp",t=>{
  const f=repoFixture(t);
  const pkg=JSON.parse(fs.readFileSync(f.pkgPath,"utf8"));
  pkg.version="1.2.3";
  fs.writeFileSync(f.pkgPath,JSON.stringify(pkg,null,2)+"\n");
  const result=inspectMcodeSource({repoRoot:f.root,releaseVersion:"1.2.3"});
  assert.equal(result.clean,true,result.reason);
  assert.equal(result.versionOverrideOnly,true);
  assert.equal(result.releaseVersion,"1.2.3");
});
test("does not treat unrelated source edits as a clean release version stamp",t=>{
  const f=repoFixture(t);
  const pkg=JSON.parse(fs.readFileSync(f.pkgPath,"utf8"));
  pkg.version="1.2.3";
  fs.writeFileSync(f.pkgPath,JSON.stringify(pkg,null,2)+"\n");
  fs.writeFileSync(path.join(f.root,"source.ts"),"export const changed = true;\n");
  const result=inspectMcodeSource({repoRoot:f.root,releaseVersion:"1.2.3"});
  assert.equal(result.clean,false);
  assert.equal(result.versionOverrideOnly,false);
});
test("does not allow package.json fields other than version to change",t=>{
  const f=repoFixture(t);
  const pkg=JSON.parse(fs.readFileSync(f.pkgPath,"utf8"));
  pkg.version="1.2.3";pkg.private=false;
  fs.writeFileSync(f.pkgPath,JSON.stringify(pkg,null,2)+"\n");
  const result=inspectMcodeSource({repoRoot:f.root,releaseVersion:"1.2.3"});
  assert.equal(result.clean,false);
});
