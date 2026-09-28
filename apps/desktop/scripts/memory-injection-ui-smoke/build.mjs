// Real memory UI, hooks, UI primitives, translations and CSS. Only the
// IPC transport, session fixture and browser-view suppression are isolated.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const source = dirname(fileURLToPath(import.meta.url)), desktop = resolve(source, '../..');
const root = join(desktop, 'src/renderer'), pnpm = resolve(desktop, '../../node_modules/.pnpm');
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter(n => n.startsWith(prefix)).sort().at(-1);
  if (!n) throw Error('Missing installed dependency ' + prefix);
  return join(pnpm, n, 'node_modules', sub);
};
const esbuild = await import(pathToFileURL(pkg('esbuild@', 'esbuild/lib/main.js')).href);
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/memory-injection-ui-'));
console.log('Memory injection UI artifacts: ' + dir);
for (const file of ['verify.mjs']) copyFileSync(join(source, file), join(dir, file));
copyFileSync(join(desktop, 'scripts/ui-interaction-smoke/browser.mjs'), join(dir, 'browser.mjs'));
const stubs = {
  '@renderer/lib/monacoSetup.js': '',
  '@renderer/components/ide/FileEditor.js': 'export const useMonacoTheme=()=>"vs";',
  '@monaco-editor/react': 'import React from "react";export default function Editor(p){return <textarea data-testid="memory-editor" value={p.value??""} onChange={e=>p.onChange?.(e.target.value)} style={{width:"100%",height:260}}/>}',
  '@renderer/lib/api.js': 'export const api=window.labApi;',
  '@renderer/hooks/useSuppressBrowserView.js': 'export const useSuppressBrowserView=()=>{};',
  '@renderer/stores/sessionStore.js': "import {useSyncExternalStore} from 'react';export const useSessionStore=fn=>fn(useSyncExternalStore(window.labSubscribe,()=>window.labState));useSessionStore.getState=()=>window.labState;useSessionStore.setState=fn=>window.labPatchState(typeof fn==='function'?fn(window.labState):fn);",
  '@renderer/stores/toastStore.js': 'export const useToastStore={getState:()=>({push:message=>window.labToasts.push(message)})};',
  '@renderer/components/ui/index.js': ['button', 'dialog', 'empty-state', 'error-note', 'field', 'spinner', 'confirm-dialog', 'select', 'input', 'switch', 'tooltip', 'card'].map(n => `export * from ${JSON.stringify(join(root, 'components/ui', n + '.tsx'))};`).join('\n'),
};
await esbuild.build({
  entryPoints: [join(source, 'main.jsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: join(desktop, 'tsconfig.json'), absWorkingDir: desktop,
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dir, 'bundle.js'), logLevel: 'error',
  plugins: [{ name: 'isolated-ipc-and-session', setup(b) {
    b.onResolve({ filter: /.*/ }, a => a.path in stubs ? { path: a.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: stubs[a.path], loader: 'tsx', resolveDir: desktop }));
  } }],
});
const configPath = join(dir, 'tailwind.config.cjs');
writeFileSync(configPath, readFileSync(join(desktop, 'tailwind.config.js'), 'utf8').replace('export default', 'module.exports =').replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]', 'content: ' + JSON.stringify([root.replaceAll('\\', '/') + '/**/*.{ts,tsx,html}', join(source, 'main.jsx').replaceAll('\\', '/')])));
const css = spawnSync(process.execPath, [pkg('tailwindcss@', 'tailwindcss/lib/cli.js'), '-c', configPath, '-i', 'src/renderer/styles.css', '-o', join(dir, 'app.css')], { cwd: desktop, encoding: 'utf8' });
if (css.status !== 0) throw Error(css.stderr);
const paths = ['src/renderer/components/chat/MemoryAssistantButton.tsx', 'src/renderer/components/chat/NewSubChatPicker.tsx', 'src/renderer/components/memory/MemoryExplorerPanel.tsx', 'src/renderer/components/settings/workflows/ParamField.tsx', 'src/renderer/hooks/useRpc.ts', 'scripts/ui-interaction-smoke/browser.mjs'];
writeFileSync(join(dir, 'sources.json'), JSON.stringify(Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(join(desktop, p))).digest('hex')])), null, 2));
writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Isolated memory injection regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>' + readFileSync(join(source, 'mocks.js'), 'utf8') + '</script><script src="/bundle.js"></script></body></html>');
await import(pathToFileURL(join(dir, 'verify.mjs')).href);
