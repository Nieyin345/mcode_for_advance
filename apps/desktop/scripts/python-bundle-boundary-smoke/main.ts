import { bundledInterpreterOwner, pickPreferredPython } from "../../src/main/lib/pythonResolve.js";
let pass=0, fail=0;
function check(name:string,ok:boolean){console.log((ok?"PASS ":"FAIL ")+name);if(ok)pass++;else fail++;}
check("actual LibreOffice program Python recognized",bundledInterpreterOwner("C:/Program Files/LibreOffice/program/python.exe")==="LibreOffice");
check("Linux LibreOffice install Python recognized",bundledInterpreterOwner("/usr/lib/libreoffice/program/python3")==="LibreOffice");
for(const path of ["/home/user/libreoffice-project/.venv/bin/python","/opt/libreoffice-backup/bin/python","C:/tools/LibreOfficeExtensions/python.exe","/home/x/notlibreoffice/bin/python"]) {
 check("non-suite similarly named folder must not be mistaken for LibreOffice: "+path,bundledInterpreterOwner(path)===null);
}
const actual="/home/dev/libreoffice-project/.venv/bin/python";
const fake="/usr/lib/libreoffice/program/python";
check("user virtualenv wins over bundled Python even if folder name contains libreoffice",pickPreferredPython([fake,actual])===actual);
check("all bundled fallback still available",pickPreferredPython([fake])===fake);
check("empty candidate set still returns null",pickPreferredPython([])===null);
console.log(`python-bundle-boundary-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
