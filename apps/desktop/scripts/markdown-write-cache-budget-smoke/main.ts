import {textFileWrites,FileConflictError} from "../../src/renderer/lib/markdownFileWrites.js";
import {setDisk,getDisk,writes} from "./stubApi.js";
let good=0,bad=0;function check(name:string,yes:boolean){console.log((yes?"PASS ":"FAIL ")+name);yes?good++:bad++;}
const huge="x".repeat(5*1024*1024);
const largePath="/fixture/large-markdown-file.md";
setDisk(largePath,"OLD");
await textFileWrites.enqueue(largePath,huge);
check("large file saved normally",getDisk(largePath)===huge);
let refusedHuge=false;
try {await textFileWrites.enqueue(largePath,"more edits","stale external baseline");}
catch(e){refusedHuge=e instanceof FileConflictError;}
check("very large file content not retained as conflict-suppressing MRU cache",refusedHuge);
check("refused stale large save does not overwrite disk",getDisk(largePath)===huge);
const smallPath="/fixture/small.md";
setDisk(smallPath,"OLD");
await textFileWrites.enqueue(smallPath,"small content");
check("small file normally saved",getDisk(smallPath)==="small content");
await textFileWrites.enqueue(smallPath,"small content 2","stale editor baseline");
check("recent small self-written version still resolves same-file two-pane conflict",getDisk(smallPath)==="small content 2");
check("no duplicate writes after refused conflict",writes.length===3);
console.log(`markdown-write-cache-budget-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
