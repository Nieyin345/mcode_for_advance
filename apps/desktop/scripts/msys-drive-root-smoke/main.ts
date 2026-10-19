import { msysToWindowsPath, normalizeBashCommand } from '../../src/main/lib/msysPath.js';
let ok=0, bad=0;
function eq(label:string, actual:string, expected:string){const pass=actual===expected;console.log(`${pass?'PASS':'FAIL'} ${label}${pass?'':` expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`}`);if(pass)ok++;else bad++;}
eq('WSL drive root without slash', msysToWindowsPath('/mnt/d'), 'D:\\');
eq('MSYS drive root without slash', msysToWindowsPath('/d'), 'D:/');
eq('WSL drive root with slash', msysToWindowsPath('/mnt/d/'), 'D:\\');
eq('MSYS drive root with slash', msysToWindowsPath('/d/'), 'D:/');
eq('WSL file preserved', msysToWindowsPath('/mnt/d/research/paper.md'), 'D:\\research\\paper.md');
eq('MSYS file preserved', msysToWindowsPath('/d/research/paper.md'), 'D:/research/paper.md');
eq('native path remains native', msysToWindowsPath('D:\\research\\paper.md'), 'D:\\research\\paper.md');
eq('normal POSIX path not translated', msysToWindowsPath('/mnt/data/paper.md'), '/mnt/data/paper.md');
eq('bash root uses same drive semantics', normalizeBashCommand('cd /d'), 'cd D:/');
console.log(`msys-drive-root-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;
