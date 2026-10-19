import {relativePath,isPathWithin} from "../../src/renderer/lib/path.js";
let good=0,bad=0;
function eq(label:string,actual:unknown,expected:unknown){const pass=actual===expected;console.log((pass?"PASS ":"FAIL ")+label+(pass?"":` actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`));if(pass)good++;else bad++;}
eq("Windows project path comparison respects case-insensitive filesystem",relativePath("d:/PROJECT/Docs/README.md","D:/project"),"Docs/README.md");
eq("Windows volume root computes correct relative path",relativePath("C:/code/index.ts","C:/"),"code/index.ts");
eq("Windows volume root itself returns empty relative path",relativePath("c:/","C:/"),"");
eq("POSIX filesystem root computes relative path",relativePath("/home/user/file.txt","/"),"home/user/file.txt");
eq("POSIX filesystem root itself returns empty relative path",relativePath("/","/"),"");
eq("UNC share case insensitive relative path",relativePath("//server/share/dir/file.ts","//SERVER/SHARE"),"dir/file.ts");
eq("wrong drive never matches root",relativePath("D:/repo/file.ts","C:/repo"),"D:/repo/file.ts");
eq("other POSIX root stays case sensitive",relativePath("/A/doc.md","/a"),"/A/doc.md");
eq("Windows drive root contains files",isPathWithin("C:/","c:/code/file.ts"),true);
eq("Windows drive root rejects other drive",isPathWithin("C:/","D:/code/file.ts"),false);
eq("POSIX root contains absolute files",isPathWithin("/","/home/user/file.ts"),true);
eq("POSIX root does not match a relative path",isPathWithin("/","home/user/file.ts"),false);
eq("UNC share root contains same server/share in different case",isPathWithin("//SERVER/SHARE/","//server/share/file.ts"),true);
eq("UNC share root rejects sibling share",isPathWithin("//server/share","//server/share2/file.ts"),false);
console.log(`renderer-path-roots-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
