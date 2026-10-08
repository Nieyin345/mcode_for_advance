import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, '../..');
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp', 'ide-diff-dialog-'));
const pnpm = join(desktop, '../../node_modules/.pnpm');
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw new Error('Missing installed dependency: ' + prefix);
  return join(pnpm, n, 'node_modules', sub);
};
const esbuild = await import(pathToFileURL(pkg('esbuild@', 'esbuild/lib/main.js')).href);

const stub = (p) => join(desktop, 'scripts/ide-diff-dialog-smoke', p);
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
  // katex 字体(经由 ChunkedMarkdown 的依赖链)在 node 打包下无 loader;内联成 dataurl。
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl', '.css': 'empty' },
  plugins: [{
    name: 'isolate-diff-dialog',
    setup(b) {
      // 极小 hooks 运行时 + 空壳 barrel + 内存 api 桩。
      // ⚠️ `react` 必须 alias 到**本套目录**的 fakeReact —— main.ts 也 import 这一份,
      //    两边解析到同一个模块实例,`__mount`/`__nodes` 才看得见组件写的状态。
      b.onResolve({ filter: /^react$/ }, () => ({ path: stub('fakeReact.ts') }));
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: stub('jsxRuntime.ts') }));
      b.onResolve({ filter: /^@tabler\/icons-react$/ }, () => ({ path: stub('iconsStub.cjs') }));
      b.onResolve({ filter: /^@renderer\/lib\/api\.js$/ }, () => ({ path: stub('api-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/components\/ui\/index\.js$/ }, () => ({ path: stub('ui-stub.ts') }));
      // 重量级子件:monaco 装配与 DiffPane(真实现要装 @monaco-editor/react),
      // 与本次判据无关 —— 空壳。
      b.onResolve({ filter: /^@renderer\/lib\/monacoSetup\.js$/ }, () => ({ path: 'empty', namespace: 'stub' }));
      b.onResolve({ filter: /^\.\/FileEditor\.js$/ }, () => ({ path: 'diffPaneStub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path === 'diffPaneStub' ? 'export const DiffPane = (p) => p.children;' : '',
        loader: 'tsx',
      }));
    },
  }],
});

const unit = spawnSync(process.execPath, [join(dir, 'smoke.mjs')], { cwd: desktop, stdio: 'inherit', timeout: 60000 });
if (unit.status !== 0) process.exit(unit.status ?? 1);
