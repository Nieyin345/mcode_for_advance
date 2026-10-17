/** 打包本套件：真 `MarkdownPreviewPane` 挂极小 React 运行时。
 *  与 ide-quote-snapshot-smoke 同一套替身策略（重子件空壳、api 可编程）。 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, '../..');
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp', 'md-preview-read-error-'));
const pnpm = join(desktop, '../../node_modules/.pnpm');
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw new Error('Missing installed dependency: ' + prefix);
  return join(pnpm, n, 'node_modules', sub);
};
const esbuild = await import(pathToFileURL(pkg('esbuild@', 'esbuild/lib/main.js')).href);
const stub = (p) => join(source, p);

const EMPTY_CHILDREN = {
  chunked: 'export const ChunkedMarkdown = (p) => p.children;',
  pdf: 'export const PdfPreview = (p) => p.children;',
  mdeditor: 'export const MarkdownEditorPane = (p) => p.children;',
  onlyoffice: 'export const OnlyOfficeEditorPane = (p) => p.children;',
  fileicon: 'export const FileTypeIcon = () => null; export const fileIconIdForPath = () => null; export const hasFileIcon = () => false;',
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
    name: 'md-preview-read-error',
    setup(b) {
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
      b.onResolve({ filter: /^@renderer\/lib\/monacoSetup\.js$/ }, () => ({ path: 'empty', namespace: 'stub' }));
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
