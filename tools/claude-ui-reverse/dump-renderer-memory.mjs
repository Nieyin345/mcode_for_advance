/**
 * 从**运行中的** Claude 渲染进程内存里捞 DOM 片段。
 *
 * ## 为什么这么做
 *
 * 常规路子都堵死了（实测）：
 *   `--remote-debugging-port` → Claude 自己拒绝启动
 *   `--inspect`               → fuse 关着，且缓存目录被占
 * 所以只能读内存。
 *
 * ## 这不是「解析 DOM」，是「找证据」
 *
 * V8 里字符串是 UTF-16 或单字节（one-byte string），DOM 节点本身是 C++ 对象，
 * 但 React 会保留大量字符串：className、data-*、文本。
 * 我们在这些字符串里找 `data-cds` 之类的标记，再**把邻近的字符串串起来**。
 *
 * ⚠️ 局限（必须写清楚）：
 *   - 拿不到元素的**父子关系**（那在 C++ 对象里）
 *   - 拿不到**计算后的尺寸**（那要调 layout）
 *   - 只能拿到「这个页面上确实出现过哪些类名/属性」
 * **所以它不能替代 CDP，只能佐证静态结论。**
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

/**
 * 真正的读内存放在 PowerShell 里做（Node 没有 Win32 API）。
 * 这里只负责：找到渲染进程 → 调 PowerShell 转储 → 分析结果。
 */
const PS = String.raw`
param([int]$ProcId, [string]$OutFile, [int]$MaxMB = 400)

$sig = @'
using System;
using System.Runtime.InteropServices;
public class Mem {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION64 mbi, int len);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION64 {
    public ulong BaseAddress, AllocationBase;
    public uint AllocationProtect, __alignment1;
    public ulong RegionSize;
    public uint State, Protect, Type, __alignment2;
  }
}
'@
Add-Type -TypeDefinition $sig

$PROCESS_VM_READ = 0x0010
$PROCESS_QUERY_INFORMATION = 0x0400
$MEM_COMMIT = 0x1000
$PAGE_GUARD = 0x100
$PAGE_NOACCESS = 0x01

$h = [Mem]::OpenProcess($PROCESS_VM_READ -bor $PROCESS_QUERY_INFORMATION, $false, $ProcId)
if ($h -eq [IntPtr]::Zero) { Write-Error "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }

$ms = New-Object System.IO.MemoryStream
$addr = [IntPtr]::Zero
$mbi = New-Object Mem+MEMORY_BASIC_INFORMATION64
$limit = $MaxMB * 1MB
$read = [IntPtr]::Zero
$chunk = New-Object byte[] 1048576

while ([Mem]::VirtualQueryEx($h, $addr, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi)) -ne 0) {
  $base = [IntPtr][int64]$mbi.BaseAddress
  $size = [int64]$mbi.RegionSize
  if ($mbi.State -eq $MEM_COMMIT -and ($mbi.Protect -band $PAGE_GUARD) -eq 0 -and ($mbi.Protect -band $PAGE_NOACCESS) -eq 0) {
    $off = [int64]0
    while ($off -lt $size) {
      $want = [int]([Math]::Min($chunk.Length, $size - $off))
      $p = [IntPtr]([int64]$base + $off)
      if ([Mem]::ReadProcessMemory($h, $p, $chunk, $want, [ref]$read)) {
        $got = [int]$read
        $ms.Write($chunk, 0, $got)
        if ($ms.Length -ge $limit) { break }
      }
      $off += $want
    }
  }
  if ($ms.Length -ge $limit) { break }
  $next = [int64]$mbi.BaseAddress + [int64]$mbi.RegionSize
  if ($next -le [int64]$addr) { break }
  $addr = [IntPtr]$next
}
[Mem]::CloseHandle($h) | Out-Null
[System.IO.File]::WriteAllBytes($OutFile, $ms.ToArray())
Write-Output ("dumped " + $ms.Length + " bytes")
`;

/** 找渲染进程。 */
function findRenderer() {
  const ps = `
$p = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
     Where-Object { $_.CommandLine -like '*--type=renderer*' } |
     Select-Object -First 1
if ($p) { $p.ProcessId } else { "" }
`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  return out ? Number(out) : null;
}

const pid = findRenderer();
if (!pid) { console.error("找不到渲染进程"); process.exit(1); }
console.error(`渲染进程 PID=${pid}`);

// 写 PS 脚本到文件（避免命令行转义）
const psPath = R(".tmp/rev/_dump.ps1");
writeFileSync(psPath, PS, "utf8");

const dumpPath = R(".tmp/rev/renderer-mem.bin");
// 已有转储就复用（转储一次要几十秒，且进程内存每次不同，
// 复用可以让「分析脚本的改动」与「数据采集」分开验证）
if (existsSync(dumpPath) && process.env.REDUMP !== "1") {
  console.error("复用已有转储（REDUMP=1 可强制重转）");
} else {
  console.error("转储中…");
  const r = execFileSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath,
    "-ProcId", String(pid), "-OutFile", dumpPath, "-MaxMB", "400",
  ], { encoding: "utf8", maxBuffer: 1 << 28 });
  console.error(r.trim());
}

/* ═══════════════════════════════════════════════════════════════
 * 分析转储：找 UTF-16 / ASCII 的 DOM 标记
 * ═══════════════════════════════════════════════════════════════ */
const buf = readFileSync(dumpPath);
console.error(`读到 ${(buf.length / 1048576).toFixed(0)} MiB`);

/** 在 buf 里找一个 needle 的两种编码，返回命中偏移。 */
function find(haystack, needle) {
  const hits = [];
  for (const enc of ["utf8", "utf16le"]) {
    const nb = Buffer.from(needle, enc);
    let i = 0;
    while ((i = haystack.indexOf(nb, i)) !== -1) {
      hits.push({ at: i, enc, len: nb.length });
      i += nb.length;
      if (hits.length > 5000) return hits;
    }
  }
  return hits;
}

const results = {};
for (const key of ["data-cds", "epitaxy-prompt-input", "epitaxy-transcript-typography",
  "dframe-chrome-bar", "session-rail-w", "--df-row-h", "What can I help you with today",
  "New Chat", "ChatComposerDock"]) {
  const h = find(buf, key);
  results[key] = { count: h.length, egs: h.slice(0, 2).map((x) => x.enc) };
}

/** 抽「看起来像一整串 className」的片段。 */
function classLike() {
  const found = new Map();
  for (const enc of ["utf8", "utf16le"]) {
    const step = enc === "utf16le" ? 2 : 1;
    const re = enc === "utf8"
      ? /[\x20-\x7e]{30,400}/g
      : null;
    if (!re) continue;
    let m;
    // 只在 ASCII 区扫，避免解码整块
    const s = buf.toString("latin1");
    while ((m = re.exec(s)) !== null) {
      const t = m[0];
      if (!/(^|\s)(flex|grid|items-|gap-|px-|py-|w-|h-|rounded|text-|bg-)/.test(t)) continue;
      if (!/\s/.test(t)) continue;                 // 至少两个类
      if (t.length > 300) continue;
      found.set(t, (found.get(t) ?? 0) + 1);
    }
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, 200);
}

const classStrings = classLike();

writeFileSync(R(".tmp/rev/renderer-hits.json"), JSON.stringify({
  pid, bytes: buf.length,
  markerCounts: results,
  classStrings,
}, null, 2));

console.log(`\n=== 标记命中 ===`);
for (const [k, v] of Object.entries(results)) console.log(`  ${String(v.count).padStart(6)}  ${k}  (${v.egs.join(",")})`);
console.log(`\n=== 类名串（top 30 / 共 ${classStrings.length}）===`);
for (const [t, n] of classStrings.slice(0, 30)) console.log(`  ×${n}  ${t.slice(0, 150)}`);
