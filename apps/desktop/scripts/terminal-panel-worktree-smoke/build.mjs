import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, '../..');
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp', 'terminal-panel-worktree-'));
const pnpm = join(desktop, '../../node_modules/.pnpm');
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw new Error('Missing installed dependency: ' + prefix);
  return join(pnpm, n, 'node_modules', sub);
};
const esbuild = await import(pathToFileURL(pkg('esbuild@', 'esbuild/lib/main.js')).href);

const stub = (p) => join(desktop, 'scripts/terminal-panel-worktree-smoke', p);
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
  // 经 sessionStore 的传递依赖链进来的 CSS/字体资产(monacoSetup 的惰性 import)。
  // 那段代码本套永不执行,只是打包期需要个 loader。
  loader: { '.css': 'empty', '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty', '.eot': 'empty' },
  plugins: [{
    name: 'isolate-terminal-panel',
    setup(b) {
      // 极小 hooks 运行时 + 直通 barrel + 记事 api 桩。
      // ⚠️ `react` 必须 alias 到**本套目录**的 fakeReact —— main.ts 也 import 这一份,
      //    两边解析到同一个模块实例,`__mount`/`__nodes` 才看得见组件写的状态。
      b.onResolve({ filter: /^react$/ }, () => ({ path: stub('fakeReact.ts') }));
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: stub('jsxRuntime.ts') }));
      b.onResolve({ filter: /^react-icons\// }, () => ({ path: stub('iconsStub.cjs') }));
      b.onResolve({ filter: /^@tabler\/icons-react$/ }, () => ({ path: stub('iconsStub.cjs') }));
      b.onResolve({ filter: /^@renderer\/lib\/icons\.js$/ }, () => ({ path: stub('icons-lib-stub.cjs') }));
      b.onResolve({ filter: /^@renderer\/lib\/api\.js$/ }, () => ({ path: stub('api-stub.ts') }));
      b.onResolve({ filter: /^@renderer\/components\/ui\/index\.js$/ }, () => ({ path: stub('ui-stub.ts') }));
      b.onResolve({ filter: /^@base-ui\/react\/menu$/ }, () => ({ path: stub('menu-stub.ts') }));
      b.onResolve({ filter: /^@base-ui\/react\/context-menu$/ }, () => ({ path: stub('menu-stub.ts') }));
      // 重量级子件:TerminalView 要装 @xterm/xterm + 它的 CSS,与本次判据无关
      // —— 空壳。组件里那句 `lazy(() => import("./TerminalView.js")...)` 在 fakeReact
      // 下**根本不会被求值**(只渲染根组件),这里只要能解析即可。
      b.onResolve({ filter: /(^|\/)TerminalView\.js$/ }, () => ({ path: 'terminalViewStub', namespace: 'stub' }));
      // sessionStore 的传递依赖会拖进 monacoSetup(它 `import …?worker` 与 monaco 的
      // 字体 CSS)—— 那段本套永不执行,整块换空壳。
      b.onResolve({ filter: /^@renderer\/lib\/monacoSetup\.js$/ }, () => ({ path: 'empty', namespace: 'stub' }));
      b.onResolve({ filter: /^monaco-editor/ }, () => ({ path: 'empty', namespace: 'stub' }));
      b.onResolve({ filter: /\?worker$/ }, () => ({ path: 'workerStub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents:
          a.path === 'terminalViewStub'
            ? 'export const TerminalView = () => null;'
            : a.path === 'workerStub'
              ? 'export default class {};'
              : '',
        loader: 'tsx',
      }));
    },
  }],
});

const unit = spawnSync(process.execPath, [join(dir, 'smoke.mjs')], { cwd: desktop, stdio: 'inherit', timeout: 60000 });
if (unit.status !== 0) process.exit(unit.status ?? 1);
