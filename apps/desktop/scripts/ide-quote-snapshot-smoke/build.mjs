import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * ide-quote-snapshot-smoke —— 打包。
 *
 * 换 `react` 为极小 hooks 运行时(组件源码原样跑),换掉全部重量级子件
 * (monaco / milkdown / pdf.js / iconify / base-ui / api),让**真** `EditPane`
 * 能在 node 下挂载、被驱动。见 main.ts 文件头。
 */
const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, '../..');
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp', 'ide-quote-snapshot-'));
const pnpm = join(desktop, '../../node_modules/.pnpm');
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw new Error('Missing installed dependency: ' + prefix);
  return join(pnpm, n, 'node_modules', sub);
};
const esbuild = await import(pathToFileURL(pkg('esbuild@', 'esbuild/lib/main.js')).href);

const stub = (p) => join(desktop, 'scripts/ide-quote-snapshot-smoke', p);
// 空壳子件:只导出被测分支**不会渲染**的重组件。fakeReact 惰性物化
// `{type, props}`,子组件从不被调用 —— 只要 import 能解析。
const EMPTY_CHILDREN = {
  'chunked': 'export const ChunkedMarkdown = (p) => p.children;',
  'pdf': 'export const PdfPreview = (p) => p.children;',
  'mdeditor': 'export const MarkdownEditorPane = (p) => p.children;',
  'onlyoffice': 'export const OnlyOfficeEditorPane = (p) => p.children;',
  'fileicon': 'export const FileTypeIcon = () => null; export const fileIconIdForPath = () => null; export const hasFileIcon = () => false;',
};

await esbuild.build({
  entryPoints: [join(source, 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  tsconfig: join(desktop, 'tsconfig.json'),
  absWorkingDir: desktop,
  outfile: join(dir, 'smoke.mjs'),
  logLevel: 'error',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl', '.css': 'empty' },
  plugins: [{
    name: 'isolate-quote-snapshot',
    setup(b) {
      // 极小 hooks 运行时 + 直通/空壳桩。react 必须 alias 到**本套目录**那份 ——
      // main.ts 也 import 同一份,`__mount` / `__nodes` 才看得见组件写的状态。
      b.onResolve({ filter: /^react$/ }, () => ({ path: stub('fakeReact.ts') }));
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: stub('jsxRuntime.ts') }));
      b.onResolve({ filter: /^react-dom$/ }, () => ({ path: stub('portal-stub.ts') }));
      b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: stub('portal-stub.ts') }));
      b.onResolve({ filter: /^@tabler\/icons-react$/ }, () => ({ path: stub('iconsStub.cjs') }));
      b.onResolve({ filter: /^react-icons\// }, () => ({ path: stub('iconsStub.cjs') }));
      b.onResolve({ filter: /^@monaco-editor\/react$/ }, () => ({ path: stub('monaco-react-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/lib\/api\.js$/ }, () => ({ path: stub('api-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/lib\/lspProviders\.js$/ }, () => ({ path: stub('lsp-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/components\/customUi\/CustomSlotHosts\.js$/ }, () => ({ path: stub('customSlots-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/lib\/markdownFileWrites\.js$/ }, () => ({ path: stub('writeStub.ts') }));
      // monaco 装配是纯副作用 import(注册 worker)—— 空掉。
      b.onResolve({ filter: /^@renderer\/lib\/monacoSetup\.js$/ }, () => ({ path: 'empty', namespace: 'stub' }));
      // 重子件(相对路径,FileEditor 里用的就是这些)。
      b.onResolve({ filter: /\.\/MarkdownEditorPane\.js$/ }, () => ({ path: 'mdeditor', namespace: 'stub' }));
      b.onResolve({ filter: /\.\/OnlyOfficeEditorPane\.js$/ }, () => ({ path: 'onlyoffice', namespace: 'stub' }));
      b.onResolve({ filter: /\.\.\/library\/PdfPreview\.js$/ }, () => ({ path: 'pdf', namespace: 'stub' }));
      b.onResolve({ filter: /\.\.\/chat\/ChunkedMarkdown\.js$/ }, () => ({ path: 'chunked', namespace: 'stub' }));
      b.onResolve({ filter: /^@renderer\/lib\/fileIcon\.js$/ }, () => ({ path: 'fileicon', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path === 'empty' ? '' : (EMPTY_CHILDREN[a.path] ?? ''),
        loader: 'tsx',
      }));
    },
  }],
});

const unit = spawnSync(process.execPath, [join(dir, 'smoke.mjs')], { cwd: desktop, stdio: 'inherit', timeout: 60000 });
if (unit.status !== 0) process.exit(unit.status ?? 1);
