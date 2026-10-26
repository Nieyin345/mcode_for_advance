/** Bundle actual monaco-editor and Mcode's production language adapter into isolated Electron U1. */
import {writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
export async function prepare({buildDir,desktop,esbuild}){
  const script=join(buildDir,"theia-u1.js");
  const source=resolve(desktop,"scripts/theia-native-u1/entry.ts");
  const transport=resolve(desktop,"scripts/theia-native-u1/transport.ts");
  await esbuild({
    entryPoints:[source],bundle:true,platform:"browser",format:"iife",
    absWorkingDir:desktop,tsconfig:join(desktop,"tsconfig.json"),
    define:{"process.env.NODE_ENV":'"production"'},
    outfile:script,logLevel:"error",
    loader:{".woff":"dataurl",".woff2":"dataurl",".ttf":"dataurl",".png":"dataurl",".svg":"dataurl"},
    plugins:[{name:"theia-u1-boundaries",setup(b){
      b.onResolve({filter:/^@renderer\/lib\/api\.js$/},()=>({path:transport}));
      b.onResolve({filter:/^\.\/lspProviders\.js$/},()=>({path:"native-navigation",namespace:"u1"}));
      b.onLoad({filter:/.*/,namespace:"u1"},()=>({contents:"export function gotoLocation(){};",loader:"js"}));
    }}],
  });
  writeFileSync(join(buildDir,"theia-native.html"),
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" '+
    'content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; '+
    'font-src \'self\' data:; img-src \'self\' data:; connect-src \'none\'; worker-src \'self\' blob:">'+
    '<link rel="stylesheet" href="./theia-u1.css"/>'+
    '<style>html,body{height:100%;margin:0}#editor{height:500px;width:960px;border:1px solid #aaa}</style>'+
    '</head><body><div id="ready">starting</div><div id="editor"></div><script src="./theia-u1.js"></script></body></html>');
}
