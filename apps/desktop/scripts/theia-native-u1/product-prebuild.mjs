/** F040: bundle production Monaco worker entry points and an isolated product U1 page. */
import {copyFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

export async function prepare({buildDir,desktop,repo,esbuild}) {
  const pnpm=join(repo,"node_modules/.pnpm");
  const monacoPackage=readdirSync(pnpm).filter(name=>name.startsWith("monaco-editor@")).sort().at(-1);
  if(!monacoPackage)throw Error("F040 requires the installed monaco-editor package");
  const monacoRoot=join(pnpm,monacoPackage,"node_modules/monaco-editor");
  await esbuild({
    entryPoints:[join(desktop,"scripts/theia-native-u1/product-runtime.ts")],bundle:true,
    platform:"node",format:"esm",target:"node22",absWorkingDir:desktop,
    tsconfig:join(desktop,"tsconfig.json"),external:["electron"],
    outfile:join(buildDir,"theia-installed-runtime.mjs"),logLevel:"error",
  });
  const workers=[
    ["editor.worker","esm/vs/editor/editor.worker.js"],
    ["json.worker","esm/vs/language/json/json.worker.js"],
    ["css.worker","esm/vs/language/css/css.worker.js"],
    ["html.worker","esm/vs/language/html/html.worker.js"],
    ["ts.worker","esm/vs/language/typescript/ts.worker.js"],
  ];
  for(const [name,relative] of workers) {
    await esbuild({
      entryPoints:[join(monacoRoot,relative)],bundle:true,platform:"browser",format:"esm",
      target:"chrome120",outfile:join(buildDir,name+".js"),logLevel:"error",
      loader:{".woff":"dataurl",".woff2":"dataurl",".ttf":"dataurl",".png":"dataurl",".svg":"dataurl"},
    });
  }
  copyFileSync(join(desktop,"scripts/theia-native-u1/product-api-bridge.js"),
    join(buildDir,"product-api-bridge.js"));
  writeFileSync(join(buildDir,"product-page.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '+
    'script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; '+
    'img-src \'self\' data:; font-src \'self\' data:; connect-src \'none\'; '+
    'worker-src \'self\' blob:\">'+
    '<title>Mcode F040 product U1</title><link rel="stylesheet" href="./app.css"></head>'+
    '<body style="margin:0"><div id="root" style="height:100vh"></div>'+
    '<script src="./api-stub.js"></script><script src="./product-api-bridge.js"></script>'+
    '<script src="./bundle.js"></script></body></html>');
}
