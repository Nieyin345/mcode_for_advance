/** Execute the actual three production composer handlers, not a copied router. */
const {readFileSync}=require('node:fs');const {resolve,join}=require('node:path');const {createRequire}=require('node:module');const assert=require('node:assert/strict');
const app=resolve(__dirname,'../..');const req=createRequire(join(app,'package.json'));const ts=req('typescript');
const parse=path=>ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const source=parse(join(app,'src/renderer/components/chat/ChatPane.tsx'));
const found=new Map();const visit=node=>{if(ts.isVariableDeclaration(node)&&['handleSend','handleEnqueue','handleInject'].includes(node.name.getText(source)))found.set(node.name.getText(source),node.initializer);ts.forEachChild(node,visit);};visit(source);
(async()=>{
 let n=0;
 for(const name of ['handleSend','handleEnqueue','handleInject']){
  assert.ok(found.has(name));const code=ts.transpileModule(`const handler=${found.get(name).getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for(const text of ['/init-学术','/init-missing','/init-学术 extra'])for(const attachments of [false,true]){
   let intercepted=0;const controller={intercept(value,attached){assert.equal(value,text);assert.equal(attached,attachments);intercepted++;return true;}};
   const handler=new Function('editorRef','value','tags','pendingImages','projectInitializer',code+';return handler;')({current:{serialize:()=>({text,skillNames:[]})}},text,attachments?[{}]:[],[],controller);
   await handler();assert.equal(intercepted,1);n++;
  }
 }
 // Preload transport is likewise the production object literal, using the real
 // shared constants, rather than six handwritten facsimiles of invoke calls.
 const preload=parse(join(app,'src/preload/index.ts'));let property;
 const walk=node=>{if(ts.isPropertyAssignment(node)&&node.name.getText(preload)==='projectInit')property=node.initializer;ts.forEachChild(node,walk);};walk(preload);assert.ok(property);
 const code=ts.transpileModule(`const bridge=${property.getText(preload)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const channels=Object.fromEntries(['list','get','save','delete','preview','apply'].map(k=>['PROJECT_INIT_'+k.toUpperCase(),'projectInit:'+k]));const calls=[];
 const bridge=new Function('ipcRenderer','IPC',code+';return bridge;')({invoke:async(...args)=>{calls.push(args);return 'ok';}},channels);
 for(const method of ['list','get','save','delete','preview','apply']){const input={probe:method};assert.equal(await bridge[method](input),'ok');assert.equal(calls.at(-1)[0],'projectInit:'+method);if(method!=='list')assert.equal(calls.at(-1)[1],input);n++;}
 console.log(`Project init production composer/preload routes: ${n}/${n}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
