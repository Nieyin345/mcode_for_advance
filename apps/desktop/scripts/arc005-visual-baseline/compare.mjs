/**
 * T01 ARC-005 V4: compare computed tokens (not guessed screenshots) only
 * for families explicitly described in reference matrix §二/§四/§五.
 * Supports optional --out for isolated mutation verification.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const evidence = join(repo, ".tmp/arc005-visual");
const args = process.argv.slice(2);
const output = args.includes("--out") ? resolve(args[args.indexOf("--out")+1] ?? "") : join(evidence, "diff.md");
const upstreamPath = join(repo,"open-claude-ui/code-examples/cds-theme.css");
const matrixPath = join(repo,"docs/design/claude-code-reference-matrix.md");
const upstreamCss = readFileSync(upstreamPath,"utf8");
const matrix = readFileSync(matrixPath,"utf8");
if (!matrix.includes("## 二、token 对照表") || !matrix.includes("## 五、动效")) throw Error("Reference matrix shape changed; refuse guessing");
const darkStart = upstreamCss.indexOf('[data-mode="dark"], .dark');
if (darkStart < 0) throw Error("upstream dark vars missing");
const rootCss = upstreamCss.slice(0,darkStart);
const darkCss = upstreamCss.slice(darkStart);
const getVar = (css,k) => {
  const lines = css.match(new RegExp("(?:^|\\n)\\s*"+k.replaceAll("-","\\-")+"\\s*:\\s*([^;]+);","m"));
  return lines?.[1]?.trim() ?? null;
};
const fromUpstream = (key,theme,depth=0) => {
  if (depth>8) return "CYCLE";
  const raw = (theme==="dark" ? getVar(darkCss,key) : null) ?? getVar(rootCss,key);
  if (raw == null) return "(上游未定义)";
  return raw.replace(/var\((--[a-z0-9-]+)(?:,[^)]*)?\)/g, (_m, dep) => fromUpstream(dep,theme,depth+1)).trim();
};
const normalizeColor = v => {
  const s=String(v??"").trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) {
    return s.length===4 ? '#'+[...s.slice(1)].map(c=>c+c).join('') : s;
  }
  let p = s.match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/) ?? s.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if(p) return '#'+[1,2,3].map(i=>Math.round(Number(p[i])).toString(16).padStart(2,'0')).join('');
  return s.replace(/\s+/g,'').replace(/^0ms$/,'0s');
};
const expected = {
  light: {
    "--surface": ["#fcfcfb","--cds-surface-1","一致"],
    "--surface-muted": ["#f9f9f7","--cds-surface-0","一致"],
    "--surface-hover": ["#f0efec","--cds-fill-ghost-hover","已知差异（矩阵已登记，理由见矩阵）"],
    "--content": ["#151515","--cds-text-primary","一致"],
    "--content-muted": ["#52514e","--cds-text-secondary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-subtle": ["#6d6b67","--cds-text-muted","已知差异（矩阵已登记，理由见矩阵）"],
    // 【T141】`--edge` 的登记值是 **R G B 三元组**（`styles.css:181` 存的就是 `217 217 216`），
    // 不是十六进制 —— 所以这里也写成三元组，让 `normalized` 两边同一形态比较。
    //
    // 【为什么以前是 `#c3c2b7`】那是 T121（`b736c814`，2026-10-24 14:58）之前的值。
    // 那次提交按「既要在画布上看得见、又要和 `--surface-hover` 分得开」重定了这一档，
    // 但没有同步更新本题和参考矩阵的登记值 —— 于是 51 格（17 场景 × 亮/暗/窄）全部
    // 报「未登记差异」。**51 条其实是同一个根因在两个明度上的重复计数，不是 51 个问题。**
    "--edge": ["217 217 216","--cds-border","已知差异（矩阵已登记，理由见矩阵）"],
  },
  dark: {
    "--surface": ["#151515","--cds-surface-1","一致"],
    "--surface-muted": ["#20201f","--cds-surface-0","已知差异（矩阵已登记，理由见矩阵）"],
    "--surface-hover": ["#2c2c2a","--cds-fill-ghost-hover","已知差异（矩阵已登记，理由见矩阵）"],
    "--content": ["#f9f9f7","--cds-text-primary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-muted": ["#b4b3a8","--cds-text-secondary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-subtle": ["#97958d","--cds-text-muted","已知差异（矩阵已登记，理由见矩阵）"],
    "--edge": ["63 63 63","--cds-border","已知差异（矩阵已登记，理由见矩阵）"],
  },
};
const geometry = {
  "--radius-panel":["10px","--cds-panel-radius","一致"],
  "--composer-radius":["20px","--cds-radius-composer","一致"],
  "--radius-bubble":["12px","--cds-message-bubble-radius","已知差异（矩阵已登记，理由见矩阵）"],
  "--radius-control":["4px","--radius-sm","一致"],
  "--radius-btn-xs":["6px","--cds-radius-btn-xs","一致"],
  "--radius-btn-md":["8px","--cds-radius-btn-md","一致"],
  "--radius-dialog":["16px","--cds-radius-dialog","一致"],
  "--radius-code":["12px","--cds-radius-code","一致"],
};
const motion = {
  "--dur-fast":["60ms","60ms","一致"],
  "--dur-snap":["120ms","120ms","一致"],
  "--dur-base":["200ms","200ms","一致"],
  "--dur-sheet":["300ms","300ms","一致"],
  "--dur-slow":["450ms","450ms","一致"],
  "--ease-out":["cubic-bezier(0,0,.2,1)","--cds-ease-out","已知差异（矩阵已登记，理由见矩阵）"],
  "--ease-snap":["cubic-bezier(.32,.72,0,1)","--cds-ease-snap","一致"],
  "--ease-overshoot":["cubic-bezier(.34,1.3,.64,1)","--cds-ease-overshoot","一致"],
};
function normalized(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  const rem = s.match(/^([\d.]+)rem$/);
  if (rem) return (Number(rem[1]) * 16) + "px";
  if (/^calc\(8px\+calc\(\.25rem\*1\)\)$/.test(s)) return "12px";
  return normalizeColor(v).replace(/0\.(\d+)/g,'.$1').replace(/\s+/g,'').toLowerCase();
}
const manifest = JSON.parse(readFileSync(join(evidence,"manifest.json"),"utf8"));
// 【T141】期望格数从 probe.ts 写的 expected.json 读，不在这里写死。
// 以前是 `!== 39`，而场景加到 51 之后它必然抛错 —— 门禁从此一次都没跑成。
const expectedCells = JSON.parse(readFileSync(join(evidence,"expected.json"),"utf8")).cells;
if (!Number.isInteger(expectedCells)) throw Error("expected.json is missing a numeric cells field");
if (manifest.length !== expectedCells) throw Error(`${expectedCells} grid cells required; got ${manifest.length}`);
const fileRows=[];
let unknown=0, known=0, equal=0, missing=0;
const seen=new Set();
for(const row of manifest) {
  if(seen.has(row.file)) throw Error("Duplicate snapshot "+row.file);
  seen.add(row.file);
  const path=join(evidence,row.file+".json");
  if(!existsSync(path)) throw Error("Missing JSON / data-missing marker: "+row.file);
  const sample=JSON.parse(readFileSync(path,"utf8"));
  const mode=row.condition==="dark"?"dark":"light";
  const state=row.status==="CAPTURED"?"实拍":"data-missing: "+(sample["data-missing"]||row.reason||"未说明");
  if (row.status==="DATA_MISSING") missing++;
  fileRows.push(`| ${row.title} | ${row.condition} | ${state.replaceAll("|","/")} | ${sample.snapshot?.viewport?.width ?? "无"}×${sample.snapshot?.viewport?.height ?? "无"} |`);
  for(const [key,[reference,upstreamVar,judgment]] of Object.entries({...expected[mode],...geometry,...motion})) {
    // Geometry: the workspace shell can intentionally override composer radius
    // (documented in §十一). Only the token at root is checked here.
    const actual=sample.snapshot?.tokens?.[key];
    if (!actual) {
      // Matrix marks missing roles as known gaps. Report the absence, do not
      // invent a "computed" value or a comparison from an absent variable.
      fileRows.push(`| ↳ ${key} | ${row.condition} | data-missing: 未定义计算样式 | — |`);
      continue;
    }
    const upstreamValue=upstreamVar.startsWith("--")?fromUpstream(upstreamVar,mode):upstreamVar;
    const agree=normalized(actual)===normalized(reference);
    const verdict=agree?judgment:"未登记差异";
    if(!agree)unknown++;else if(judgment.startsWith("已知"))known++;else equal++;
    fileRows.push(`| ↳ ${key} | Mcode=${actual.replaceAll("|","/")} | 上游=${upstreamValue.replaceAll("|","/")}；矩阵判定=${judgment}；实测=${agree?"与矩阵登记相符":"偏离矩阵登记 "+reference} | ${verdict} |`);
  }
}
const lines=[
 "# ARC-005 V4：Electron 计算样式逐项比对",
 "",
 "参考：docs/design/claude-code-reference-matrix.md §二/四/五；上游为 open-claude-ui/code-examples/cds-theme.css（第三方逆向产物，非用户安装 Claude 版）。",
 "仅判上述已经登记的 surface/content/edge、圆角、动效；差异按矩阵原有判断，不以像素等值代替语义关系。",
 "root token 与窗口实际可见元素的 getComputedStyle 分别存于同名 JSON：snapshot.tokens 和 snapshot.measured（含尺寸、字号、行高、背景、颜色、圆角、padding）。",
 "",
 `总格数：${expectedCells}；有图：${manifest.length-missing}；data-missing：${missing}。比较条目：一致 ${equal}、已知差异 ${known}、未登记差异 ${unknown}。`,
 "",
 "| 屏幕 / token | 条件或 Mcode 实测 | 上游值 / 矩阵判定 / 本次实测 | 结论 |",
 "|---|---|---|---|",
 ...fileRows,
 "",
 "### 取证限制",
 "",
 "- 只表示 Mcode 隔离真 Electron 中的计算样式。Claude Desktop 用户安装版本没有对应截图，不能宣称视觉逐屏一致。",
 "- data-missing 行未拍图；该格仅保留采样、探针原因与未覆盖条件。不会以其他状态截图替代。",
 "- 暗色 edge 若后续 token 表登记值变更，必须先复核矩阵，再修改比较器的登记期望。",
];
writeFileSync(output,lines.join("\n")+"\n");
console.log(JSON.stringify({output,grid:manifest.length,expected:expectedCells,captured:manifest.length-missing,missing,equal,known,unregistered:unknown}));
if(unknown) process.exitCode=2;
