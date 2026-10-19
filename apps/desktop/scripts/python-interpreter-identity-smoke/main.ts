import {bundledInterpreterOwner,pickPreferredPython} from "../../src/main/lib/pythonResolve.js";
let pass=0,fail=0;
const check=(name:string,ok:boolean,actual?:unknown)=>{
 if(ok)pass++;else fail++;
 console.log(`${ok?"  ok  ":"  FAIL"} ${name}${ok?"":` — ${JSON.stringify(actual)}`}`);
};
const builtWin="C:/Program Files/LibreOffice/program/python.exe";
const builtLinux="/usr/lib/libreoffice/program/python3";
const userWin="C:/Users/alice/work/libreoffice/.venv/Scripts/python.exe";
const userLinux="/home/alice/research/libreoffice/.venv/bin/python";
check("Windows real LibreOffice installed Python is bundled",bundledInterpreterOwner(builtWin)==="LibreOffice");
check("Linux real LibreOffice installed Python is bundled",bundledInterpreterOwner(builtLinux)==="LibreOffice");
check("macOS LibreOffice.app Contents interpreter is bundled",bundledInterpreterOwner("/Applications/LibreOffice.app/Contents/Resources/python3")==="LibreOffice");
check("★ user's Windows project libreoffice/.venv is NOT an installed application",bundledInterpreterOwner(userWin)===null,bundledInterpreterOwner(userWin));
check("★ user's Linux project libreoffice/.venv is NOT an installed application",bundledInterpreterOwner(userLinux)===null,bundledInterpreterOwner(userLinux));
check("★ a user virtualenv after LibreOffice on PATH must be selected on Windows",
 pickPreferredPython([builtWin,userWin])===userWin,pickPreferredPython([builtWin,userWin]));
check("★ a user virtualenv after LibreOffice on PATH must be selected on Linux",
 pickPreferredPython([builtLinux,userLinux])===userLinux,pickPreferredPython([builtLinux,userLinux]));
check("installed bundled interpreter remains fallback if it is the only one",pickPreferredPython([builtLinux])===builtLinux);
check("empty candidates yield null",pickPreferredPython([])===null);
console.log(`python-interpreter-identity-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
