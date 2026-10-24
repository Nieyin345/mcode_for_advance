/**
 * 【T115】新建 docx 必须写 `w:eastAsia`。
 *
 * ## 这条链在修之前是什么样
 *
 * `genoffice create --type docx` 有两条路（按源文件后缀分）：
 *   - `.html` → `packages/cli/src/formats/docx.ts` 的 `blankDocument()`；
 *   - `.md`   → `packages/cli/src/formats/markdown.ts` 的 `markdownToDocx()`
 *               → 渲染端 `apps/markdown/.../docxExport.ts` 的 `exportDocxBytes()`。
 *
 * **两条都调 `buildBlankDocx()` 且都不传 options。** 而上游 `docx-engine` 的能力一直在：
 *
 * ```ts
 * export interface BlankDocxOptions { eastAsiaFont?: string; ... }
 * ```
 *
 * 不传的后果不是「缺字」，是 **`w:ascii="Calibri"` 而没有 `w:eastAsia`** —— 中文字形
 * 来自系统默认（Windows 上通常宋体）、西文来自 Calibri，**一段里混两种字体、行高按
 * 西文度量算、字重不一致**。这就是用户说的「又烂又丑」最直接的一条。
 *
 * ## 为什么断言必须读产物字节
 *
 * 「函数被调了」「参数传了」都不等于「产物里有」。这条链上已经有过一次同类教训
 * （T73：判据算了但模型看不到）。所以这里**解开 .docx 读 `word/styles.xml`**。
 *
 * ## 为什么不断言写死的字体名
 *
 * 字体**按平台选**（`east-asia-font.ts` 的论证）：Windows 雅黑 / macOS 苹方 /
 * Linux Noto。套件跑在哪个平台，就只该期望那个平台的字体 —— **断言写死
 * `Microsoft YaHei` 会让这个套件在 CI 的 Linux 上假红。**
 *
 * 所以断言的是「有一个非空的 `w:eastAsia`」，另外**单独一条**验平台选择函数本身
 * 返回了该平台的字体。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const REPO = resolve(process.cwd(), '../..');
const CLI = join(REPO, 'genoffice/packages/cli/dist/genoffice.cjs');
const WORK = mkdtempSync(join(tmpdir(), 't115-eastasia-'));

/** 跑一次 CLI，返回 stdout（失败即抛）。 */
function cli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: WORK, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 从 .docx 里读出 `word/styles.xml`。
 *
 * .docx 是 ZIP。这里用 `unzip -p`（Git Bash 自带）而不是引一个 zip 库 ——
 * 套件只为读一个 XML 条目，加依赖不值得。
 */
function stylesXmlOf(docx: string): string {
  return execFileSync('unzip', ['-p', docx, 'word/styles.xml'], { encoding: 'utf8', timeout: 60_000 });
}

function documentXmlOf(docx: string): string {
  return execFileSync('unzip', ['-p', docx, 'word/document.xml'], { encoding: 'utf8', timeout: 60_000 });
}

/** `w:eastAsia="..."` 的值，没有则 null。 */
function eastAsiaIn(xml: string): string | null {
  const m = /w:eastAsia="([^"]*)"/.exec(xml);
  return m?.[1] ?? null;
}

try {
  /* ── ① HTML 路径（`blankDocument()`） ── */
  console.log('\n[1] HTML → docx');
  {
    const src = join(WORK, 'cn.html');
    writeFileSync(src, '<html><body><h1>标题</h1><p>这是一段中文正文。</p></body></html>', 'utf8');
    const out = join(WORK, 'cn-html.docx');
    cli(['create', '--type', 'docx', '--from', src, '--out', out, '--force']);

    const ea = eastAsiaIn(stylesXmlOf(out));
    check('★ 中文 HTML 产出的 styles.xml 里 docDefaults 有 w:eastAsia', ea !== null && ea.length > 0, { eastAsia: ea });
  }

  /* ── ② Markdown 路径（`markdownToDocx` → `exportDocxBytes`） ── */
  console.log('\n[2] Markdown → docx');
  {
    const src = join(WORK, 'cn.md');
    writeFileSync(src, '# 标题\n\n这是一段中文正文。\n', 'utf8');
    const out = join(WORK, 'cn-md.docx');
    cli(['create', '--type', 'docx', '--from', src, '--out', out, '--force']);

    const ea = eastAsiaIn(stylesXmlOf(out));
    check('★ 中文 Markdown 产出的 styles.xml 里 docDefaults 有 w:eastAsia', ea !== null && ea.length > 0, { eastAsia: ea });
  }

  /* ── ③ 正控：纯英文仍然能生成 ──
   *
   * 加字体不能把英文文档弄坏。注意：**英文文档的 styles.xml 里也会有 eastAsia** ——
   * 那是 docDefaults，与内容语言无关（一份文档可能中英混排）。所以这条断言**不断言
   * eastAsia 的有无**，只断言「文件生成了、结构是完整的」。 */
  console.log('\n[3] 正控：纯英文');
  {
    const src = join(WORK, 'en.html');
    writeFileSync(src, '<html><body><h1>Title</h1><p>English body text only.</p></body></html>', 'utf8');
    const out = join(WORK, 'en.docx');
    cli(['create', '--type', 'docx', '--from', src, '--out', out, '--force']);

    const styles = stylesXmlOf(out);
    const doc = documentXmlOf(out);
    check('★ 纯英文 HTML 仍能生成（styles.xml 可读且有 docDefaults）',
      styles.includes('<w:docDefaults>') || styles.includes('w:docDefaults'), { len: styles.length });
    check('★ 纯英文正文确实在文档里', doc.includes('English body text only'), { len: doc.length });
  }

  /* ── ④ docDefaults 的字体在**后续编辑**后仍然生效 ──
   *
   * 这正是 B（docDefaults 级）相对 A（run 级 `setFont`）的关键优势 —— 实测过：
   * A 路径下 `insert_content` 插的新段落**没有** `w:eastAsia`；B 路径下它在
   * docDefaults 里，新段落自动继承。 */
  console.log('\n[4] 后续编辑后仍是 docDefaults 级');
  {
    const src = join(WORK, 'edit.html');
    writeFileSync(src, '<html><body><p>第一段中文。</p></body></html>', 'utf8');
    const base = join(WORK, 'edit-base.docx');
    cli(['create', '--type', 'docx', '--from', src, '--out', base, '--force']);

    const ops = join(WORK, 'insert.json');
    writeFileSync(ops, JSON.stringify([
      { op: 'insert_content', afterBlockIndex: 0, html: '<p>插入的第二段中文。</p>' },
    ]), 'utf8');
    const after = join(WORK, 'edit-after.docx');
    cli(['docs', 'apply', base, '--ops', ops, '--out', after]);

    const ea = eastAsiaIn(stylesXmlOf(after));
    check('★ 插入新段落后 docDefaults 的 w:eastAsia 仍在（不依赖每个 run 各写一遍）',
      ea !== null && ea.length > 0, { eastAsia: ea });
    check('★ 插入的中文段落真的进了文档', documentXmlOf(after).includes('插入的第二段中文'), {});
  }

  /* ── ⑤ 平台选择函数本身 ──
   *
   * 上面前四条都只说「有一个非空 eastAsia」，这条验「选的是这个平台该有的那个」。
   * 分开写是因为前者跨平台通用，后者绑定当前平台。 */
  console.log('\n[5] 平台字体选择');
  {
    const expected = process.platform === 'win32' ? 'Microsoft YaHei'
      : process.platform === 'darwin' ? 'PingFang SC'
        : process.platform === 'linux' ? 'Noto Sans CJK SC'
          : null;
    if (expected === null) {
      console.log(`  （跳过：${process.platform} 没有担保存在的 CJK 字体）`);
    } else {
      const src = join(WORK, 'plat.html');
      writeFileSync(src, '<html><body><p>中文</p></body></html>', 'utf8');
      const out = join(WORK, 'plat.docx');
      cli(['create', '--type', 'docx', '--from', src, '--out', out, '--force']);
      const ea = eastAsiaIn(stylesXmlOf(out));
      check(`★ ${process.platform} 上写的是 ${expected}`, ea === expected, { actual: ea, expected });
    }
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\nt115-docx-eastasia-font-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
