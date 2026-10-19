import {previewLibraryItem} from "../../src/renderer/lib/libraryPreview.js";
import {events as lib} from "./stubLibrary.js";
import {events as session} from "./stubSession.js";
let good=0,bad=0;
function eq(name:string,a:unknown,b:unknown){const yes=a===b;console.log((yes?"PASS ":"FAIL ")+name+" got="+String(a));yes?good++:bad++;}
previewLibraryItem({id:"fixture-upper",mdPath:"C:/docs/README.MD",filePath:undefined});
eq("uppercase .MD opens edit tab",lib.at(-1),"tab:edit");
eq("opening uppercase markdown also opens right panel",session.at(-1),"right:true");
previewLibraryItem({id:"fixture-ordinary",mdPath:undefined,filePath:"C:/docs/fixture.pdf"});
eq("PDF metadata preview stays in metadata tab",lib.at(-1),"tab:meta");
previewLibraryItem({id:"fixture-low",mdPath:undefined,filePath:"C:/docs/other.md"});
eq("lowercase markdown existing behavior stays",lib.at(-1),"tab:edit");
console.log(`library-preview-extension-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
