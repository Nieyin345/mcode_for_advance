import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { addSkillMarket, listSkillMarkets, refreshSkillMarket, installSkillsFromMarket, removeSkillMarket, skillMarketsRoot } from "@main/lib/skillMarket.js";
import { defaultSkillsRoot } from "@main/lib/skillEngines.js";

async function main() {
  assert.ok(process.env.SKILL_LAZY_TEST_HOME, "Isolated HOME required");
  assert.equal(path.resolve(homedir()), path.resolve(process.env.SKILL_LAZY_TEST_HOME!));
  let count=0;
  const check=(message:string, value:unknown)=>{assert.ok(value,message);console.log('PASS '+message);count++;};
  const blobs=new Map<string,Buffer>(), tree:any[]=[];
  const add=(file:string,text:string|Buffer,mode='100644')=>{const b=Buffer.from(text);blobs.set(file,b);tree.push({path:file,type:'blob',mode,size:b.length,sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')});};
  for(let i=0;i<180;i++)add(`skills/skill${String(i).padStart(3,'0')}/SKILL.md`,`---\nname: skill${i}\ndescription: Skill number ${i}\n---\nFull instructions`);
  // Server may ignore Range: even a large SKILL.md must not enter the cache as content.
  const largePath='skills/skill179/SKILL.md';
  blobs.delete(largePath);tree.splice(tree.findIndex(f=>f.path===largePath),1);
  add(largePath,'---\nname: skill179\ndescription: Large metadata fixture\n---\n'+'x'.repeat(1_000_000));
  add('skills/skill000/examples/nested/SKILL.md','---\nname: nested-example\n---\nNot a separate catalog skill');
  add('skills/skill000/scripts/run.py','print("selected")','100755');
  add('skills/skill000/references/pixel.bin',Buffer.from([0,255,128,13,10]));
  add('skills/skill001/references/other.txt','unselected resource');
  add('skills/linked/SKILL.md','---\nname: linked\n---\nLink fixture');
  add('skills/linked/escape','../../outside','120000');
  add('skills/lfs/SKILL.md','---\nname: lfs\n---\nLFS fixture');
  add('skills/lfs/large.bin','version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 100000');
  tree.push({path:'unrelated/huge.bin',type:'blob',mode:'100644',size:500_000_000,sha:'f'.repeat(40)});
  const first='a'.repeat(40);let head=first, failTree=0, truncated=false, failFile='', corruptFile='';
  const calls:Array<{url:string;range:string|null}>=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input:any,init?:RequestInit)=>{
    const url=String(input),u=new URL(url),h=new Headers(init?.headers);calls.push({url,range:h.get('range')});
    assert.equal(h.has('authorization'),false,'No credential discovery');
    if(u.hostname==='api.github.com'){
      if(u.pathname.includes('/commits/')){assert.equal(h.get('accept'),'application/vnd.github.sha','Do not fetch commit diffs');return new Response(head,{status:200});}
      if(u.pathname.includes('/git/trees/'))return new Response(JSON.stringify({tree,truncated}),{status:failTree||200});
    }
    if(u.hostname==='raw.githubusercontent.com'){
      const pieces=u.pathname.split('/').slice(4).map(decodeURIComponent),file=pieces.join('/');
      if(file===failFile)return new Response('Unavailable',{status:503});
      const b=blobs.get(file);assert.ok(b,`Unexpected data download: ${file}`);
      return new Response(new Uint8Array(file===corruptFile?Buffer.from('corrupt'):b),{status:200,headers:{'Content-Length':String(file===corruptFile?7:b.length)}});
    }
    throw new Error('Unexpected network host/path '+url);
  };
  try {
    let progress=0;
    const added=await addSkillMarket({kind:'git',ref:'K-Dense-AI/scientific-agent-skills'},()=>progress++);
    check('adding a GitHub collection succeeds without invoking Git',added.ok);
    const name=added.name!;
    check('browse fetches two metadata API requests only',calls.filter(c=>c.url.includes('api.github.com')).length===2);
    check('browse only reads SKILL.md headers',calls.filter(c=>c.url.includes('raw.githubusercontent')).every(c=>c.url.endsWith('/SKILL.md')&&!!c.range));
    check('browse never requests a repository archive or unrelated resource',calls.every(c=>!/(huge.bin|other.txt|run.py|codeload|zipball)/.test(c.url)));
    const cacheDir=path.join(skillMarketsRoot(),name),cacheFiles=await fs.readdir(cacheDir);
    check('cache contains index only, not hundreds of skill directories',cacheFiles.length===1&&cacheFiles[0]==='.github-skill-index.json');
    const indexPath=path.join(cacheDir,cacheFiles[0]),snapshot=await fs.readFile(indexPath);
    check('large SKILL.md body is not stored in index',snapshot.length<128*1024);
    check('metadata progress is emitted',progress>1);
    const before=calls.length,markets=await listSkillMarkets();
    check('list/search use cached metadata without network',calls.length===before);
    check('all 182 skills and descriptions are indexed',markets.find(m=>m.name===name)?.skills.length===182&&markets.find(m=>m.name===name)?.skills.find(s=>s.name==='skill000')?.description==='Skill number 0');
    calls.length=0;check('unchanged refresh reuses cached descriptions',(await refreshSkillMarket(name)).ok&&calls.length===1);
    head='b'.repeat(40);calls.length=0;
    const installed=await installSkillsFromMarket(name,['skill000']);
    check('only selected skill installed',installed.imported.join(',')==='skill000');
    check('installation fetches only selected folder',calls.length===4&&calls.every(c=>c.url.includes('/skills/skill000/')));
    check('installation stays on indexed commit after branch changes',calls.every(c=>c.url.includes('/'+first+'/')));
    check('binary companion file is preserved',(await fs.readFile(path.join(defaultSkillsRoot(),'skill000/references/pixel.bin'))).equals(Buffer.from([0,255,128,13,10])));
    check('unselected skill is not installed',!existsSync(path.join(defaultSkillsRoot(),'skill001')));
    calls.length=0;const skipped=await installSkillsFromMarket(name,['skill000']);
    check('existing names skip without network',skipped.skipped.includes('skill000')&&calls.length===0);
    failTree=403;const failed=await refreshSkillMarket(name);
    check('rate limit is clear and never invokes clone fallback',!failed.ok&&failed.error?.includes('403'));
    check('failed refresh preserves previous index',(await fs.readFile(indexPath)).equals(snapshot));failTree=0;
    truncated=true;const partial=await refreshSkillMarket(name);
    check('truncated index cannot replace complete cache',!partial.ok&&(await fs.readFile(indexPath)).equals(snapshot));truncated=false;
    failFile='skills/skill001/references/other.txt';const broken=await installSkillsFromMarket(name,['skill001']);
    check('failed download leaves no partially installed skill',broken.errors.length===1&&!existsSync(path.join(defaultSkillsRoot(),'skill001')));failFile='';
    corruptFile='skills/skill001/references/other.txt';const corrupt=await installSkillsFromMarket(name,['skill001']);
    check('blob integrity mismatch rolls back installation',corrupt.errors.length===1&&!existsSync(path.join(defaultSkillsRoot(),'skill001')));corruptFile='';
    const unsafe=await installSkillsFromMarket(name,['linked']);
    check('symlinks are refused, not followed',unsafe.errors.length===1&&!existsSync(path.join(defaultSkillsRoot(),'linked')));
    const lfs=await installSkillsFromMarket(name,['lfs']);
    check('LFS pointers are not silently installed as content',lfs.errors.length===1&&!existsSync(path.join(defaultSkillsRoot(),'lfs')));
    const badIndex=JSON.parse(snapshot.toString());badIndex.files.push({path:'skills/skill001/../../outside',type:'blob',mode:'100644',sha:'d'.repeat(40),size:1});
    await fs.writeFile(indexPath,JSON.stringify(badIndex));calls.length=0;
    const traversal=await installSkillsFromMarket(name,['skill001']);
    check('path traversal refused before requests/writes',traversal.errors.length===1&&calls.length===0&&!existsSync(path.join(defaultSkillsRoot(),'skill001')));
    const caseIndex=JSON.parse(snapshot.toString());caseIndex.files.push({path:'skills/skill001/References/extra.txt',type:'blob',mode:'100644',sha:'e'.repeat(40),size:1});
    await fs.writeFile(indexPath,JSON.stringify(caseIndex));calls.length=0;
    const conflict=await installSkillsFromMarket(name,['skill001']);
    check('directory case conflicts fail before requests',conflict.errors.length===1&&calls.length===0);
    await fs.writeFile(indexPath,snapshot);
    calls.length=0;const branch=await addSkillMarket({kind:'git',ref:'https://github.com/example/collection/tree/feature%2Findex'});
    check('explicit encoded branch resolves without subtree ambiguity',branch.ok&&calls.some(c=>c.url.endsWith('/commits/feature%2Findex')));
    if(branch.name)await removeSkillMarket(branch.name);
    calls.length=0;const ambiguous=await addSkillMarket({kind:'git',ref:'https://github.com/example/collection/tree/main/subdirectory'});
    check('ambiguous branch/subdirectory rejected without requests',!ambiguous.ok&&calls.length===0);
    const local=path.join(homedir(),'fixture-local');await fs.mkdir(path.join(local,'local-demo/scripts'),{recursive:true});
    await fs.writeFile(path.join(local,'local-demo/SKILL.md'),'---\nname: local-demo\ndescription: Local fixture\n---\nOffline skill');
    await fs.writeFile(path.join(local,'local-demo/scripts/tool.py'),'print("local")');
    const localAdded=await addSkillMarket({kind:'local',ref:local});
    check('local-folder market stays offline',localAdded.ok&&calls.length===0);
    check('local-folder installation includes companions',(await installSkillsFromMarket(localAdded.name!,['local-demo'])).imported.includes('local-demo')&&existsSync(path.join(defaultSkillsRoot(),'local-demo/scripts/tool.py'))&&calls.length===0);
    check('local-folder refresh stays offline',(await refreshSkillMarket(localAdded.name!)).ok&&calls.length===0);
    await removeSkillMarket(localAdded.name!);
    check('removing local source preserves original and installed files',existsSync(path.join(local,'local-demo/SKILL.md'))&&existsSync(path.join(defaultSkillsRoot(),'local-demo/SKILL.md')));
    check('unsupported Git host fails instead of silently cloning',!(await addSkillMarket({kind:'git',ref:'https://example.invalid/repo.git'})).ok);
    check('GitHub SSH spelling uses same lazy index',!(await addSkillMarket({kind:'git',ref:'git@github.com:K-Dense-AI/scientific-agent-skills.git'})).ok);
    calls.length=0;
    check('Anthropic built-in uses lazy metadata refresh',(await refreshSkillMarket('anthropic-skills')).ok);
    check('OpenAI built-in uses lazy metadata refresh',(await refreshSkillMarket('openai-skills')).ok);
    check('built-ins never download non-metadata files',calls.filter(c=>c.url.includes('raw.githubusercontent')).every(c=>c.range&&c.url.endsWith('/SKILL.md')));
    const old=path.join(skillMarketsRoot(),'openai-skills');await fs.rm(old,{recursive:true,force:true});await fs.mkdir(path.join(old,'legacy'),{recursive:true});await fs.writeFile(path.join(old,'legacy/SKILL.md'),'---\nname: legacy\n---\nOld cache');calls.length=0;
    check('legacy checkout cache remains usable offline',(await installSkillsFromMarket('openai-skills',['legacy'])).imported.includes('legacy')&&calls.length===0);
    check('refresh migrates old checkout to metadata index',(await refreshSkillMarket('openai-skills')).ok&&!existsSync(path.join(old,'legacy')));
    check('migration leaves already installed skills intact',existsSync(path.join(defaultSkillsRoot(),'legacy/SKILL.md')));
    await removeSkillMarket(name);
    check('removing source preserves installed skill',!existsSync(cacheDir)&&existsSync(path.join(defaultSkillsRoot(),'skill000/SKILL.md')));
    check('failed operations leave no staging folders',(await fs.readdir(path.dirname(defaultSkillsRoot()))).every(n=>!n.startsWith('.skill-install-')));
    console.log(`skill-lazy-smoke: ${count}/${count} passed`);
  } finally { globalThis.fetch=originalFetch; }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
